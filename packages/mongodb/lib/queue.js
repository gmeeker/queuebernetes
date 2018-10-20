const mongoDbQueue = require('mongodb-queue');
const { promisify } = require('util');

function now() {
  return (new Date()).toISOString();
}

class Queue extends mongoDbQueue {
  constructor(db, name, options) {
    let o = options;
    if (o && typeof o.deadQueue === 'string') {
      const deadQueue = mongoDbQueue(db, o.deadQueue);
      o = Object.assign({}, o, { deadQueue });
    }
    super(db, name, o);
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

  newCount(query, callback) {
    this.col.countDocuments(query, function (err, count) {
      if (err) return callback(err);
      callback(null, count);
    });
  }

  // Avoid deprecated mongodb commands
  total(callback) {
    this.newCount({}, callback);
  }

  size(callback) {
    const query = {
      deleted: null,
      visible: { $lte: now() },
    };
    this.newCount(query, callback);
  }

  inFlight(callback) {
    const query = {
      ack: { $exists: true },
      visible: { $gt: now() },
      deleted: null,
    };
    this.newCount(query, callback);
  }

  done(callback) {
    const query = {
      deleted: { $exists: true },
    };
    this.newCount(query, callback);
  }
}

module.exports = { Queue };
