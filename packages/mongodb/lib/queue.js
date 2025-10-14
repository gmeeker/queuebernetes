const mongoDbQueue = require('mongodb-queue-up');
const { promisify } = require('util');

class Queue {
  constructor(db, name, options) {
    let o = options;
    if (o && typeof o.deadQueue === 'string') {
      const deadQueue = mongoDbQueue(db, o.deadQueue);
      o = { ...o, deadQueue };
    }
    if (o && o.deadQueue) {
      this.deadQueue = o.deadQueue;
      delete o.deadQueue;
      this.maxRetries = o.maxRetries || 5;
    }
    this.queue = mongoDbQueue(db, name, o);
    this.name = name;
    this.add = promisify(this.queue.add.bind(this.queue));
    this.get = promisify(this.queue.get.bind(this.queue));
    this.ack = promisify(this.queue.ack.bind(this.queue));
    this.ping = promisify(this.queue.ping.bind(this.queue));
    this.clean = promisify(this.queue.clean.bind(this.queue));
    this.createIndexes = promisify(this.queue.createIndexes.bind(this.queue));
    this.total = promisify(this.queue.total.bind(this.queue));
    this.size = promisify(this.queue.size.bind(this.queue));
    this.inFlight = promisify(this.queue.inFlight.bind(this.queue));
    this.done = promisify(this.queue.done.bind(this.queue));
  }

  isDead(msg) {
    // if we have a deadQueue, then check the tries, else don't
    return !!this.deadQueue && msg.tries > this.maxRetries;
  }

  reap(msg) {
    if (this.isDead(msg)) {
      // 1) add this message to the deadQueue
      // 2) ack this message from the regular queue
      return promisify(this.deadQueue.add.bind(this.deadQueue))(msg)
        .then(() => {
          return this.ack(msg.ack);
        });
    }
    return Promise.resolve();
  }

  reset() {
    // delete ALL documents
    return this.queue.col.deleteMany({});
  }

  newCount(query, callback) {
    this.queue.col.countDocuments(query, function (err, count) {
      if (err) return callback(err);
      callback(null, count);
    });
  }
}

module.exports = { Queue };
