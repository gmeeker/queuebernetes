const { Queue } = require('./queue');

/* eslint-disable no-await-in-loop */

class EngineMongoDB {
  constructor(db) {
    this.db = db;
  }

  async clean(emitter, queues) {
    for (let i = 0; i < queues.length; i++) {
      const q = queues[i];
      // eslint-disable-next-line no-await-in-loop
      await q.clean()
        .catch(error => {
          emitter.emit('error', error.toString(), q.name);
        });
    }
    await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
    return this.clean(emitter, queues);
  }

  async cleanWorkers(emitter, workers) {
    for (let i = 0; i < workers.length; i++) {
      const worker = workers[i];
      if (worker.options.createIndexes) {
        for (let j = 0; j < worker.queues.length; j++) {
          const q = worker.queues[j];
          await q.clean()
            .catch(error => {
              emitter.emit('error', error.toString(), q.name);
            });
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
    return this.cleanWorkers(emitter, workers);
  }

  start(emitter, queues, workers, options) {
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
        this.cleanWorkers(emitter, workers);
      }
    } else {
      if (options.createIndexes) {
        for (let i = 0; i < queues.length; i++) {
          queues[i].createIndexes();
        }
      }
      if (options.clean) {
        this.clean(emitter, queues);
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
