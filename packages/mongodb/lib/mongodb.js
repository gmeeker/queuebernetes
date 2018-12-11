const EventEmitter = require('events');
const { Queue } = require('./queue');

/* eslint-disable no-await-in-loop */

class EngineMongoDB extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
  }

  async clean(queues) {
    for (let i = 0; i < queues.length; i++) {
      const q = queues[i];
      // eslint-disable-next-line no-await-in-loop
      await q.clean()
        .catch(error => {
          this.emit('error', error.toString(), q.name);
        });
    }
    await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
    return this.clean(queues);
  }

  async cleanWorkers(workers) {
    for (let i = 0; i < workers.length; i++) {
      const worker = workers[i];
      if (worker.options.clean) {
        for (let j = 0; j < worker.queues.length; j++) {
          const q = worker.queues[j];
          await q.clean()
            .catch(error => {
              this.emit('error', error.toString(), q.name);
            });
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
    return this.cleanWorkers(workers);
  }

  start(queues, workers, options) {
    if (workers) {
      for (let i = 0; i < workers.length; i++) {
        const worker = workers[i];
        if (worker.options.createIndexes) {
          for (let j = 0; j < worker.queues.length; j++) {
            worker.queues[j].createIndexes();
          }
        }
      }
      if (workers.find(w => w.options.clean)) {
        this.cleanWorkers(workers);
      }
    } else {
      if (options.createIndexes) {
        for (let i = 0; i < queues.length; i++) {
          queues[i].createIndexes();
        }
      }
      if (options.clean) {
        this.clean(queues);
      }
    }
  }

  createQueue(settings) {
    return new Queue(this.db, settings.name, settings.options);
  }

  // Define this to avoid a polling based design
  // runController(controller) {
  // }
  //
  // Define this to avoid a polling based design
  // runWorker(controller) {
  // }
  //
  // createMessage(queue, msg, ping) {
  // }
}

module.exports = { EngineMongoDB };
