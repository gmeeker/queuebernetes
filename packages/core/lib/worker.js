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
    if (!this.ackd) {
      return this.pinger();
    }
    return Promise.resolve();
  }

  ack() {
    if (!this.ackd) {
      this.ackd = true;
      // Don't ping anymore
      this.pinger = () => null;
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

class Worker {
  constructor(engine, queues, options = {}) {
    this.engine = engine;
    this.queues = queues.map(q => this.engine.createQueue(q));
    this.queueMap = {};
    queues.forEach((q, i) => this.queueMap[q.name] = this.queues[i]);
    this.events = {};
    this.handlers = [];
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
    this.interval = null;
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

  setLogging(cb) {
    this.on('start', () => { cb('worker started'); }, { verbose: 5 });
    this.on('end', () => { cb('worker ended'); }, { verbose: 5 });
    this.on('poll', queue => { cb(`worker polling ${queue}`); }, { verbose: 9 });
    this.on('ping', time => { cb(`worker ping at ${time}`); }, { verbose: 9 });
    this.on('task', (queue, task) => { cb(`working task ${queue} ${JSON.stringify(task)}`); }, { verbose: 5 });
    this.on('success', (queue, task, result) => { cb(`task success ${queue} ${JSON.stringify(task)} >> ${result}`); }, { verbose: 5 });
    this.on('failure', (queue, task, failure) => { cb(`task failure ${queue} ${JSON.stringify(task)} >> ${failure}`); }, { verbose: 1 });
    this.on('error', (error, queue, task) => { cb(`error ${queue} ${JSON.stringify(task)} >> ${error}`); }, { verbose: 1 });
    this.on('pause', () => { cb('worker paused'); }, { verbose: 9 });
  }

  addHandler(handler) {
    this.handlers.push(handler);
  }

  dispatch(q, msg) {
    this.emit('task', q.name, msg);
    const pinger = () => {
      this.emit('ping', new Date());
      return q.ping(msg.ack).catch(err => {
        this.emit('error', err, q.name, msg.payload);
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
    return new Promise(resolve => {
      setTimeout(resolve, this.options.timeout);
    });
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

  async runOnce(gotMsgIn) {
    if (this.fatal || !(this.tasks.length > 0 || gotMsgIn || this.keepAlive())) {
      return null;
    }
    let gotMsg = false;
    for (let i = 0; i < this.queues.length && this.tasks.length < this.options.maxTasks; i++) {
      const q = this.queues[i];
      this.emit('poll', q.name);
      // eslint-disable-next-line no-await-in-loop
      const msg = await q.get().catch(err => {
        this.fatal = true;
        this.emit('error', err, q.name, null);
        return null;
      });
      if (msg) {
        this.lastPoll = Date.now();
        gotMsg = true;
        this.dispatch(q, msg);
      }
    }
    const promises = this.tasks.map(task => task.task);
    if (this.tasks.length < this.options.maxTasks) {
      promises.push(this.pause(this.tasks.length === 0));
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

  async start() {
    if (this.queues.length === 0) {
      return;
    }
    this.emit('start');
    this.engine.start(this, this.queues, null, this.options);
    this.lastPoll = Date.now();
    this.fatal = false;
    this.running = true;
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
