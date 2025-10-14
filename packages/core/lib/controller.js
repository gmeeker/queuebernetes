const k8s = require('@kubernetes/client-node');
const EventEmitter = require('events');

/* eslint-disable no-await-in-loop */

/*
 * Controller handles more complicated queues:
 * Follow queue lengths and create more Workers as Jobs to allow scaling down
 * to zero replicas.  In this case, Worker must terminate.
 */

class Controller extends EventEmitter {
  constructor(engine, workers, ctrlOptions = {}) {
    super();
    this.engine = engine;
    this.engine.on('error', (...args) => this.emit('error', ...args));
    this.fatal = false;
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
      const deleteReplica = (job, controller, options) => options.deleteJobs && !job.status.failed;
      const getMinReplicas = options => options.minReplicas;
      const getMaxReplicas = options => options.maxReplicas;
      const options = {
        wakeupMessage: { type: 'wakeup', reserved: true },
        minReplicas: 0,
        maxReplicas: 1,
        maxTasks: 1,
        namespace: 'default',
        gracePeriod: 120,
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
        weights: worker.queues.map(q => q.weight || 1),
        livenessQueue: o.livenessQueue ? this.engine.createQueue({ name: o.livenessQueue }) : null,
        permanentCount: 0,
        options,
      });
    }
    this.jobs = {};
    this.watchStreams = {};
    this.pendingDeletion = {};
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
    return !this.fatal;
  }

  shutdown() {
    this.fatal = true;
    for (let j = 0; j < this.workers.length; j++) {
      const { livenessQueue } = this.workers[j];
      if (livenessQueue) {
        this.emit('liveness.reset', livenessQueue.name);
        livenessQueue.reset();
      }
    }
  }

  updateJob(job, worker) {
    const { namespace, selector } = worker.options;
    const { name } = job.metadata;
    if (name) {
      this.jobs[selector][name] = job;
      if (!this.pendingDeletion[name]
          && (job.status.completionTime !== undefined || job.status.failed)) {
        this.pendingDeletion[name] = true;
        if (job.status.failed) {
          this.emit('failure', selector, name, job.status);
        } else {
          this.emit('success', selector, name, job.status.completionTime);
        }
        if (worker.options.deleteReplica(job, this, worker.options)) {
          this.emit('delete', job, worker.options);
          this.client.deleteNamespacedJob({ name, namespace, propagationPolicy: 'Foreground' })
            .catch(error => {
              this.emit('error', `while deleting ${name}: ${error.toString()}`);
            });
        }
      }
    }
  }

  async getJobs(worker) {
    const { namespace, selector } = worker.options;
    if (!this.jobs[selector]) {
      this.jobs[selector] = {};
    }
    if (!this.watchStreams[selector]) {
      const listFn = () => this.client.listNamespacedJob({
        namespace,
        labelSelector: selector,
      });

      const informer = k8s.makeInformer(this.kc, `/apis/batch/v1/namespaces/${namespace}/jobs`, listFn, selector);

      informer.on('add', job => {
        this.updateJob(job, worker);
      });
      informer.on('change', job => {
        this.updateJob(job, worker);
      });
      informer.on('update', job => {
        this.updateJob(job, worker);
      });
      informer.on('delete', job => {
        const { name } = job.metadata;
        if (name) {
          delete this.jobs[selector][name];
          delete this.pendingDeletion[name];
        }
      });
      informer.on('error', err => {
        console.error(err);
        // Restart informer after 5sec
        setTimeout(() => {
          informer.start();
        }, 5000);
        // k8s ended the stream.  Restart next time.
        // this.watchStreams[selector] = null;
      });
      this.watchStreams[selector] = informer;
      await informer.start();
    }
  }

  async create(worker, status) {
    const { manifest, namespace } = worker.options;
    if (this.options.name) {
      manifest.spec.template.metadata.annotations['queuebernetes.io/controller'] = this.options.name;
    }
    this.emit('create', worker.options, status);
    const { livenessQueue } = worker;
    if (livenessQueue) {
      const { replicas, minReplicas } = status;
      const { name } = this.options;
      const size = await livenessQueue.size() + await livenessQueue.inFlight();
      if (size < replicas + 1) {
        const permanent = worker.permanentCount < minReplicas;
        if (permanent) {
          worker.permanentCount++;
        }
        const msg = await livenessQueue.get();
        if (msg) {
          const { controller } = msg.payload;
          if (controller !== name) {
            // Is another controller running?  Use Strategy: Recreate!
            // Exit and we will clear the queue when restarted.
            this.emit('error', `${controller} is still in the liveness queue`);
            this.fatal = true;
            throw new Error(`${controller} is still in the liveness queue`);
          }
        }
        const live = { type: 'worker', controller: name, permanent };
        this.emit('liveness.create', livenessQueue.name, live);
        livenessQueue.add(live);
        livenessQueue.clean();
      }
    }
    return this.client.createNamespacedJob({ namespace, body: manifest })
      .catch(error => {
        // Do NOT exit because Kubernetes will restart this container
        // and we will create another job too soon.
        this.emit('error', error.toString());
      });
  }

  ifVerbose(verbose, func) {
    return (...args) => {
      if (this.options.verbose >= verbose) {
        func(...args);
      }
    };
  }

  setLogging(cb) {
    this.on('start', this.ifVerbose(5, () => cb('controller started')));
    this.on('end', this.ifVerbose(5, () => cb('controller ended')));
    this.on('check', this.ifVerbose(9, selector => cb(`controller checking ${selector}`)));
    this.on('wakeup', this.ifVerbose(7, selector => cb(`controller wakeup ${selector}`)));
    this.on('poll', this.ifVerbose(9, queue => cb(`controller polling ${queue}`)));
    this.on('success', this.ifVerbose(1, (selector, job, result) => cb(`job success ${selector} ${JSON.stringify(job)} >> ${result}`)));
    this.on('failure', this.ifVerbose(1, (selector, job, failure) => cb(`job failure ${selector} ${JSON.stringify(job)} >> ${failure}`)));
    this.on('error', this.ifVerbose(1, (error, queue, job) => cb(`error ${queue} ${JSON.stringify(job)} >> ${error}`)));
    this.on('pause', this.ifVerbose(9, () => cb('controller paused')));
    this.on('create', this.ifVerbose(5, (options, status) => cb(`controller creating job ${options.selector}: ${JSON.stringify(status)}`)));
    this.on('delete', this.ifVerbose(5, (job, options) => cb(`controller deleting job ${job.metadata.name} ${options.selector}`)));
    this.on('liveness.create', this.ifVerbose(5, (q, status) => cb(`controller liveness task: ${q} ${JSON.stringify(status)}`)));
    this.on('liveness.reset', this.ifVerbose(5, q => cb(`controller liveness reset: ${q}`)));
  }

  async wakeupWorker(minReplicas, worker, tasks) {
    if (minReplicas > 0) {
      const { selector } = worker.options;
      const nextWakeup = (this.lastWakeup[selector] || 0) + worker.options.gracePeriod;
      const required = (minReplicas * worker.options.maxTasks) - tasks;
      if (Date.now() >= nextWakeup && required > 0) {
        this.emit('wakeup', selector);
        this.lastWakeup[selector] = Date.now();
        for (let i = 0; i < required; i++) {
          worker.queues[0].add(worker.options.wakeupMessage);
        }
      }
    }
    return null;
  }

  /**
   * Wake up a minimum number of workers
   *
   * @param {Number} [minReplicas] Required number of replicas
   * @param {Object} [options] Options for affecting only some workers (default is all)
   *   - `selector` Find worker by k8s label selector
   *   - `worker` Worker object or index
   *   - `queue` Find worker by queue name
   */
  async wakeup(minReplicas, options = {}) {
    let expired = false;
    for (let j = 0; j < this.workers.length; j++) {
      const worker = this.workers[j];
      const { selector } = worker.options;
      if ((options.selector && options.selector !== selector)
          || (options.worker && options.worker !== worker && options.worker !== j)
          || (options.queue && !worker.queues.find(q => q.name === options.queue))) {
        continue;
      }
      const nextWakeup = (this.lastWakeup[selector] || 0) + worker.options.gracePeriod;
      if (Date.now() >= nextWakeup) {
        expired = true;
        break;
      }
    }
    if (expired) {
      for (let j = 0; j < this.workers.length; j++) {
        const worker = this.workers[j];
        const { selector } = worker.options;
        if ((options.selector && options.selector !== selector)
            || (options.worker && options.worker !== worker && options.worker !== j)
            || (options.queue && !worker.queues.find(q => q.name === options.queue))) {
          continue;
        }
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

  getReplicas(selector) {
    const jobs = Object.values(this.jobs[selector] || {});
    const replicas = jobs.reduce((total, job) => total + ((job.status && job.status.active) || 0), 0);
    return replicas;
  }

  async check(worker, tasks, opts = {}) {
    const { options } = worker;
    const { selector } = options;
    this.emit('check', selector);
    const replicas = opts.replicas || this.getReplicas(selector);
    const desired = options.desiredReplicas(tasks, options);
    const nextCreate = (this.lastCreate[selector] || 0) + options.gracePeriod;
    const minReplicas = options.getMinReplicas(options);
    const maxReplicas = options.getMaxReplicas(options);
    const permanent = replicas < minReplicas;
    if (Date.now() >= nextCreate
        && ((replicas < maxReplicas && replicas < Math.ceil(desired))
            || permanent)) {
      this.lastCreate[selector] = Date.now();
      await this.create(worker, {
        replicas,
        desired,
        minReplicas,
        maxReplicas,
        nextCreate: new Date(nextCreate),
      });
    }
    return null;
  }

  async getQueueReplicas() {
    const queueTasks = {};
    // First get all queue sizes...
    for (let j = 0; j < this.workers.length; j++) {
      const worker = this.workers[j];
      for (let i = 0; i < worker.queues.length; i++) {
        const q = worker.queues[i];
        if (!queueTasks[q.name]) {
          const tasks = await q.size() + await q.inFlight();
          queueTasks[q.name] = { tasks, replicas: 0 };
        }
      }
    }
    // Now push weighted replica counts to all queues...
    for (let j = 0; j < this.workers.length; j++) {
      const worker = this.workers[j];
      const replicas = this.getReplicas(worker.options.selector);
      if (replicas > 0) {
        let total = 0; // normalizing factor
        for (let i = 0; i < worker.queues.length; i++) {
          const q = worker.queues[i];
          total += queueTasks[q.name].tasks * worker.weights[i];
        }
        if (total > 0) {
          for (let i = 0; i < worker.queues.length; i++) {
            const q = worker.queues[i];
            const queueWeight = queueTasks[q.name].tasks * worker.weights[i] / total;
            queueTasks[q.name].replicas += replicas * queueWeight;
          }
        }
      }
    }
    return queueTasks;
  }

  async runOnce() {
    if (!this.isRunning()) {
      return null;
    }
    for (let j = 0; j < this.workers.length; j++) {
      this.getJobs(this.workers[j]);
    }
    // Get the weighted per-queue replica counts
    // Only launch the first worker
    const queueTasks = await this.getQueueReplicas();
    for (let j = 0; j < this.workers.length; j++) {
      const worker = this.workers[j];
      for (let i = 0; i < worker.queues.length; i++) {
        const q = worker.queues[i];
        if (!queueTasks[q.name].handled) {
          queueTasks[q.name].handled = true;
          this.emit('poll', q.name);
          const tasks = await q.size() + await q.inFlight();
          const { replicas } = queueTasks[q.name];
          await this.check(worker, tasks, { replicas });
        }
      }
    }
    await this.pause();
    return this.runOnce();
  }

  createClient() {
    if (!this.client) {
      const kc = new k8s.KubeConfig();
      kc.loadFromCluster();
      this.kc = kc;
      this.client = kc.makeApiClient(k8s.BatchV1Api);
      this.appsClient = kc.makeApiClient(k8s.AppsV1Api);
    }
  }

  async start() {
    if (this.workers.length === 0) {
      return;
    }
    for (let j = 0; j < this.workers.length; j++) {
      const { livenessQueue } = this.workers[j];
      if (livenessQueue) {
        this.emit('liveness.reset', livenessQueue.name);
        livenessQueue.createIndexes();
        livenessQueue.reset();
      }
    }
    this.createClient();
    this.emit('start');
    this.fatal = false;
    this.engine.start(Object.values(this.queueMap), this.workers, this.options);
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
