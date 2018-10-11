const mongoDbQueue = require('mongodb-queue');
const { promisify } = require('util');

class Queue extends mongoDbQueue {
  constructor(db, name, options) {
    super(db, name, options);
    this.add = promisify(this.add);
    this.get = promisify(this.get);
    this.ack = promisify(this.ack);
    this.ping = promisify(this.ping);
    this.total = promisify(this.total);
    this.size = promisify(this.size);
    this.inFlight = promisify(this.inFlight);
    this.done = promisify(this.done);
    this.clean = promisify(this.clean);
    this.createIndexes = promisify(this.createIndexes);
  }
}

module.exports = { Queue };
