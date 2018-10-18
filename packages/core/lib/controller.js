const { Client, config } = require('kubernetes-client');
const JSONStream = require('json-stream');

/* eslint-disable no-await-in-loop */

/*
 * Controller handles more complicated queues:
 * Follow queue lengths and create more Workers as Jobs to allow scaling down
 * to zero replicas.  In this case, Worker must terminate.
 */

class Controller {
  constructor(engine, workers, ctrlOptions = {}) {
    this.engine = engine;
    this.queueMap = {};
    this.workers = [];
    this.options = {
      timeout: 5,
      verbose: 5,
      ...ctrlOptions,
    };
    this.options.timeout *= 1000;
    for (let i = 0; i < workers.length; i++) {
      const worker = workers[i];
      const o = worker.options || {};
      if (!o.manifest) {
        throw new Error('Kubernetes manifest not specified');
      }
      if (!o.selector) {
        throw new Error('Kubernetes selector not specified');
      }
      if (o.minReplicas !== undefined && o.minReplicas < 0) {
        throw new Error('minReplicas must be at least 0');
      }
      if (o.maxReplicas !== undefined && o.maxReplicas < 1) {
        throw new Error('maxReplicas must be at least 1');
      }
      if (!worker.queues || worker.queues.length === 0) {
        throw new Error('No queues specified');
      }
      const desiredReplicas = (tasks, options) => tasks / options.maxTasks;
      const deleteReplica = (job, controller, options) => options.deleteJobs;
      const getMinReplicas = minReplicas => minReplicas;
      const getMaxReplicas = maxReplicas => maxReplicas;
      const options = {
        wakeupMessage: { type: 'wakeup', reserved: true },
        minReplicas: 0,
        maxReplicas: 1,
        maxTasks: 1,
        namespace: 'default',
        gracePeriod: 60,
        clean: true,
        createIndexes: true,
        deleteJobs: true,
        desiredReplicas,
        deleteReplica,
        getMinReplicas,
        getMaxReplicas,
        ...o,
      };
      options.gracePeriod *= 1000;
      this.workers.push({
        queues: worker.queues.map(q => {
          if (this.queueMap[q.name]) {
            return this.queueMap[q.name];
          }
          const queue = this.engine.createQueue(q);
          this.queueMap[q.name] = queue;
          return queue;
        }),
        options,
      });
    }
    this.events = {};
    this.jobs = {};
    this.watchStreams = {};
    this.pendingDeletion = {};
  }

  on(event, cb, options) {
    this.events[event] = { verbose: 1, ...options, cb };
  }

  emit(event, ...args) {
    const e = this.events[event];
    if (e && this.options.verbose >= e.verbose) {
      e.cb(...args);
    }
  }

  async pause(emit = false) {
    if (emit) {
      this.emit('pause');
    }
    return new Promise(resolve => {
      setTimeout(resolve, this.options.timeout);
    });
  }

  isRunning() {
    return true;
  }

  getJobs(worker) {
    const { namespace, selector } = worker.options;
    if (!this.jobs[selector]) {
      this.jobs[selector] = {};
    }
    if (!this.watchStreams[selector]) {
      const stream = this.client.apis.batch.v1.watch.namespaces(namespace).jobs.getStream({
        qs: {
          labelSelector: selector
        }
      });
      this.watchStreams[selector] = stream;
      const jsonStream = new JSONStream();
      stream.pipe(jsonStream);
      jsonStream.on('end', () => {
        // k8s ended the stream.  Restart next time.
        this.watchStreams[selector] = null;
      });
      jsonStream.on('data', object => {
        const job = object.object;
        const { name } = job.metadata;
        if (name) {
          switch (object.type) {
            case 'DELETED':
              delete this.jobs[selector][name];
              delete this.pendingDeletion[name];
              break;
            case 'ADDED':
            case 'UPDATED':
            case 'MODIFIED':
              this.jobs[selector][name] = object.object;
              if (!this.pendingDeletion[name] &&
                  (job.status.completionTime !== undefined || job.status.failed)) {
                this.pendingDeletion[name] = true;
                if (job.status.failed) {
                  this.emit('failure', selector, name, job.status);
                } else {
                  this.emit('success', selector, name, job.status.completionTime);
                }
                if (worker.options.deleteReplica(job, this, worker.options)) {
                  this.emit('delete', job, worker.options);
                  const propagationPolicy = {
                    kind: 'DeleteOptions',
                    apiVersion: 'v1',
                    propagationPolicy: 'Foreground'
                  };
                  this.client.apis.batch.v1.namespaces(namespace).jobs(name).delete({ body: propagationPolicy })
                    .catch(error => {
                      this.emit('error', `while deleting ${name}: ${error.toString()}`);
                    });
                }
              }
              break;
            default:
              break;
          }
        }
      });
    }
  }

  async create(worker, status) {
    const { manifest, namespace } = worker.options;
    this.emit('create', worker.options, status);
    return this.client.apis.batch.v1.namespaces(namespace).jobs.post({ body: manifest })
      .catch(error => {
        // Do NOT exit because Kubernetes will restart this container and we will create too soon.
        this.emit('error', error.toString());
      });
  }

  setLogging(cb) {
    this.on('start', () => { cb('controller started'); }, { verbose: 5 });
    this.on('end', () => { cb('controller ended'); }, { verbose: 5 });
    this.on('check', selector => { cb(`controller checking ${selector}`); }, { verbose: 9 });
    this.on('wakeup', selector => { cb(`controller wakeup ${selector}`); }, { verbose: 7 });
    this.on('poll', queue => { cb(`controller polling ${queue}`); }, { verbose: 9 });
    this.on('success', (selector, job, result) => { cb(`job success ${selector} ${JSON.stringify(job)} >> ${result}`); }, { verbose: 5 });
    this.on('failure', (selector, job, failure) => { cb(`job failure ${selector} ${JSON.stringify(job)} >> ${failure}`); }, { verbose: 1 });
    this.on('error', (error, queue, job) => { cb(`error ${queue} ${JSON.stringify(job)} >> ${error}`); });
    this.on('pause', () => { cb('controller paused'); }, { verbose: 9 });
    this.on('create', (options, status) => { cb(`controller creating job ${options.selector}: ${JSON.stringify(status)}`); }, { verbose: 5 });
    this.on('delete', (job, options) => { cb(`controller deleting job ${job.metadata.name} ${options.selector}`); }, { verbose: 5 });
  }

  async wakeupWorker(minReplicas, worker, tasks) {
    if (minReplicas > 0) {
      const { selector } = worker.options;
      this.emit('wakeup', selector);
      const nextWakeup = (this.lastWakeup[selector] || 0) + worker.options.gracePeriod;
      const required = (minReplicas * worker.options.maxTasks) - tasks;
      if (Date.now() >= nextWakeup && required > 0) {
        this.lastWakeup[selector] = Date.now();
        for (let i = 0; i < required; i++) {
          worker.queues[0].add(worker.options.wakeupMessage);
        }
      }
    }
    return null;
  }

  async wakeup(minReplicas) {
    let expired = false;
    for (let j = 0; j < this.workers.length; j++) {
      const worker = this.workers[j];
      const { selector } = worker.options;
      const nextWakeup = (this.lastWakeup[selector] || 0) + worker.options.gracePeriod;
      if (Date.now() >= nextWakeup) {
        expired = true;
        break;
      }
    }
    if (expired) {
      for (let j = 0; j < this.workers.length; j++) {
        const worker = this.workers[j];
        let tasks = 0;
        for (let i = 0; i < worker.queues.length; i++) {
          const q = worker.queues[i];
          this.emit('poll', q.name);
          tasks += await q.size() + await q.inFlight();
        }
        await this.wakeupWorker(minReplicas, worker, tasks);
      }
    }
    return null;
  }

  async check(worker, tasks) {
    const { options } = worker;
    const { selector } = options;
    this.emit('check', selector);
    const jobs = Object.values(this.jobs[selector] || {});
    const replicas = jobs.reduce((total, job) => total + ((job.status && job.status.active) || 0), 0);
    const desired = options.desiredReplicas(tasks, options);
    const nextCreate = (this.lastCreate[selector] || 0) + options.gracePeriod;
    const minReplicas = options.getMinReplicas(options.minReplicas);
    const maxReplicas = options.getMaxReplicas(options.maxReplicas);
    await this.wakeupWorker(options.getMinReplicas, worker, tasks);
    if (Date.now() >= nextCreate
        && ((replicas + 1 < maxReplicas && replicas < Math.ceil(desired))
            || replicas < minReplicas)) {
      this.lastCreate[selector] = Date.now();
      await this.create(worker, { replicas, desired, nextCreate: new Date(nextCreate) });
    }
    return null;
  }

  async runOnce() {
    if (!this.isRunning()) {
      return null;
    }
    for (let j = 0; j < this.workers.length; j++) {
      this.getJobs(this.workers[j]);
    }
    for (let j = 0; j < this.workers.length; j++) {
      const worker = this.workers[j];
      let tasks = 0;
      for (let i = 0; i < worker.queues.length; i++) {
        const q = worker.queues[i];
        this.emit('poll', q.name);
        tasks += await q.size() + await q.inFlight();
      }
      await this.check(worker, tasks);
    }
    await this.pause();
    return this.runOnce();
  }

  createClient() {
    if (!this.client) {
      this.client = new Client({ config: config.getInCluster() });
      return this.client.loadSpec();
    }
    return Promise.resolve(null);
  }

  async start() {
    if (this.workers.length === 0) {
      return;
    }
    await this.createClient();
    this.emit('start');
    this.engine.start(this, Object.values(this.queueMap), this.workers, this.options);
    this.lastCreate = {};
    this.lastWakeup = {};
    if (this.engine.runController) {
      await this.engine.runController(this);
    } else {
      await this.runOnce();
    }
    this.emit('end');
  }
}

module.exports = { Controller };
