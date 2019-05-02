const EventEmitter = require('events');

/*
 * Wrapper around message payload and queue ping() and ack() methods.
 * It also tracks ack() so we can call it multiple times, in the handler
 * and after success.
 * The engine can provide a different implementation.
 */
class Message {
  constructor(queue, message, pinger) {
    this.queue = queue;
    this.message = message;
    this.pinger = pinger;
    this.ackd = false;

    this.ping = this.ping.bind(this);
    this.ack = this.ack.bind(this);
    this.payload = this.payload.bind(this);
    this.add = this.add.bind(this);
  }

  ping() {
    if (!this.ackd && this.pinger) {
      return this.pinger();
    }
    return Promise.resolve();
  }

  ack() {
    if (!this.ackd) {
      this.ackd = true;
      // Don't ping anymore
      this.pinger = () => Promise.resolve();
      return this.queue.ack(this.message.ack);
    }
    return Promise.resolve();
  }

  payload() {
    return this.message.payload;
  }

  add(...args) {
    this.queue.add(...args);
  }
}

/*
 * Worker listens to one or more queues and dispatches tasks to handler functions.
 * In the simplest case, this can be run in a Deployment, which one or more replicas.
 * If the tasks require more resources and scaling to zero instances is desirable,
 * or if the tasks are very long running and shouldn't be killed by Kubernetes,
 * see WorkerSet to run Worker as a k8s Job.
 */

class Worker extends EventEmitter {
  constructor(engine, queues, options = {}) {
    super();
    this.engine = engine;
    this.engine.on('error', (...args) => this.emit('error', ...args));
    this.queues = queues.map(q => this.engine.createQueue(q));
    this.queueMap = {};
    queues.forEach((q, i) => this.queueMap[q.name] = this.queues[i]);
    this.handlers = [];
    this.reapers = [];
    this.tasks = [];
    this.lastPoll = null;
    this.fatal = false;
    this.running = false;
    this.options = {
      timeout: 5,
      keepAlive: 300,
      maxTasks: 1,
      clean: false,
      createIndexes: false,
      exit: true,
      verbose: 5,
      ...options,
    };
    this.options.timeout *= 1000;
    this.options.keepAlive *= 1000;
    this.livenessQueue = options.livenessQueue ? this.engine.createQueue({ name: options.livenessQueue }) : null;
    this.livenessDelay = 10000;
  }

  ifVerbose(verbose, func) {
    return (...args) => {
      if (this.options.verbose >= verbose) {
        func(...args);
      }
    };
  }

  setLogging(cb) {
    this.on('start', this.ifVerbose(5, () => cb('worker started')));
    this.on('end', this.ifVerbose(5, () => cb('worker ended')));
    this.on('poll', this.ifVerbose(9, queue => cb(`worker polling ${queue}`)));
    this.on('ping', this.ifVerbose(9, time => cb(`worker ping at ${time}`)));
    this.on('reap', this.ifVerbose(5, (queue, task) => cb(`task died ${queue} ${JSON.stringify(task)}`)));
    this.on('task', this.ifVerbose(5, (queue, task) => cb(`working task ${queue} ${JSON.stringify(task)}`)));
    this.on('success', this.ifVerbose(1, (queue, task, result) => cb(`task success ${queue} ${JSON.stringify(task)} >> ${result}`)));
    this.on('failure', this.ifVerbose(1, (queue, task, failure) => cb(`task failure ${queue} ${JSON.stringify(task)} >> ${failure}`)));
    this.on('error', this.ifVerbose(1, (error, queue, task) => cb(`error ${queue} ${JSON.stringify(task)} >> ${error}`)));
    this.on('pause', this.ifVerbose(9, () => cb('worker paused')));
    this.on('liveness.start', this.ifVerbose(5, time => cb(`liveness started at ${time}`)));
    this.on('liveness.end', this.ifVerbose(5, (time, failure) => cb(`liveness ended at ${time} >> ${failure}`)));
    this.on('liveness.ping', this.ifVerbose(9, time => cb(`liveness ping at ${time}`)));
    this.on('liveness.poll', this.ifVerbose(9, queue => cb(`liveness polling liveness ${queue}`)));
    this.on('liveness.error', this.ifVerbose(1, (error, queue) => cb(`liveness error ${queue} >> ${error}`)));
  }

  addHandler(handler) {
    this.handlers.push(handler);
  }

  addReaper(reaper) {
    this.reapers.push(reaper);
  }

  reap(q, msg) {
    this.emit('reap', q.name, msg);
    for (let i = 0; i < this.reapers.length; i++) {
      const reaper = this.reapers[i];
      const promise = reaper(msg);
      if (promise) {
        return promise;
      }
    }
    return Promise.resolve(true);
  }

  dispatch(q, msg) {
    this.emit('task', q.name, msg);
    const pinger = () => {
      this.emit('ping', new Date());
      return q.ping(msg.ack).catch(err => {
        this.emit('error', err, q.name, msg.payload);
        return Promise.reject(err);
      });
    };
    let create = this.engine.createMessage;
    if (!create) {
      create = (...args) => new Message(...args);
    }
    const m = create(q, msg, pinger);
    if (m.payload().reserved) {
      this.emit('success', q.name, msg, null);
      m.ack();
      return null;
    }
    for (let i = 0; i < this.handlers.length; i++) {
      const handler = this.handlers[i];
      const promise = handler(m);
      if (promise) {
        const task = promise
          .then(result => {
            this.removeTask(msg.id);
            this.emit('success', q.name, msg, result);
            return m.ack();
          })
          .catch(err => {
            this.removeTask(msg.id);
            this.emit('failure', q.name, msg, err);
          });
        this.addTask(task, msg.id);
        return task;
      }
    }
    this.emit('error', `no handler for ${JSON.stringify(msg)}`, q.name, msg);
    return null;
  }

  pause(emit = false) {
    if (emit) {
      this.emit('pause');
    }
    return this.sleep(this.options.timeout).then(() => null);
  }

  addTask(task, id) {
    this.tasks.push({ task, id });
  }

  removeTask(id) {
    this.tasks = this.tasks.filter(task => task.id !== id);
  }

  keepAlive() {
    return !this.options.exit || (Date.now() - this.lastPoll) <= this.options.keepAlive;
  }

  isRunning() {
    return this.running && !this.fatal;
  }

  shutdown() {
    this.fatal = true;
  }

  async runOnce(gotMsgIn) {
    if (this.fatal || !(this.tasks.length > 0 || gotMsgIn || this.keepAlive())) {
      return null;
    }
    let gotMsg = false;
    for (let i = 0; i < this.queues.length && this.tasks.length < this.options.maxTasks; i++) {
      const q = this.queues[i];
      this.emit('poll', q.name);
      // eslint-disable-next-line no-await-in-loop
      let msg = await q.get().catch(err => {
        this.fatal = true;
        this.emit('error', err, q.name, null);
        return null;
      });
      if (msg) {
        if (q.isDead(msg)) {
          // eslint-disable-next-line no-await-in-loop
          if (await this.reap(q, msg)) {
            q.reap(msg);
            msg = null;
          }
        }
      }
      if (msg) {
        this.lastPoll = Date.now();
        gotMsg = true;
        this.dispatch(q, msg);
      }
    }
    const promises = this.tasks.map(task => task.task);
    if (this.tasks.length < this.options.maxTasks) {
      promises.push(this.pause(this.tasks.length === 0));
    } else {
      // Keep updating this in case of long running tasks.
      this.lastPoll = Date.now();
    }
    await Promise.race(promises).then(id => {
      // When a task finishes, restart 'keepAlive'
      if (id) {
        this.lastPoll = Date.now();
        gotMsg = true;
      }
    });
    return this.runOnce(gotMsg);
  }

  sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  async runLivenessMessage(msg) {
    try {
      this.emit('liveness.ping', new Date());
      await this.livenessQueue.ping(msg.ack);
    } catch (err) {
      return this.runLiveness();
    }
    await this.sleep(this.livenessDelay);
    return this.runLivenessMessage(msg);
  }

  async runLiveness() {
    if (this.livenessQueue && !this.fatal) {
      this.emit('liveness.poll', this.livenessQueue.name);
      const msg = await this.livenessQueue.get();
      if (msg) {
        this.emit('liveness.start', new Date());
        const { permanent, controller } = msg.payload;
        // permanent workers don't exit for empty queues, just ack errors.
        this.options.exit = !permanent;
        // If controller changed then exit.
        if (this.controller && this.controller !== controller) {
          this.emit('liveness.error', `controller changed: ${controller}`);
          this.shutdown();
          return;
        }
        this.controller = controller;
        return this.runLivenessMessage(msg);
      }
      // Allow to timeout and exit...
      this.options.exit = true;
      await this.sleep(this.livenessDelay);
      return this.runLiveness();
    }
  }

  async start() {
    if (this.queues.length === 0) {
      return;
    }
    this.emit('start');
    this.engine.start(this.queues, null, this.options);
    this.lastPoll = Date.now();
    this.fatal = false;
    this.running = true;
    if (this.livenessQueue) {
      this.runLiveness()
        .catch(err => {
          this.emit('liveness.error', err, this.livenessQueue.name);
        })
        .then(() => this.shutdown());
    }
    if (this.engine.runWorker) {
      await this.engine.runWorker(this);
    } else {
      await this.runOnce(true);
    }
    this.emit('end');
    this.running = false;
  }
}

module.exports = { Worker };
