const mubsub = require('mubsub-nbb');
const uuidv4 = require('uuid/v4');

/**
 * Example:
 * const { PubSub } = require('@queuebernetes/pubsub');
 * const pubsub = new PubSub('mongodb://localhost:27017/test', 'mongoCollection', 'eventName');
 * pubsub.watch({ event: 'test', id: 'foo' })
 *   .set(() => { bar: 1 })
 *   .wait(msg => msg.bar === 10);
 * const publisher = pubsub.publisher();
 * publisher.publish({ bar: 10 });
 */

/**
 * Helper for watching pub/sub messages.
*/
class Watcher {
  /**
   * Watch constructor
   *
   * @param {Watch} [watch] Watch instance
   * @param {Object} [query] Fields for filtering messages
   *   - `merge` merge data from message or overwrite, default is true
   */
  constructor(watch, query, options = {}) {
    this.watch = watch;
    this.collection = watch.collection;
    this.event = watch.event;
    this.query = query;
    this.options = Object.assign({}, { merge: true }, options);
    this.id = uuidv4();
    this.data = {};
    this.initialize = [];
    this.events = [];
    this.errors = [];
    this.ends = [];
    this.timer = setTimeout(() => console.error('Watcher run() or wait() must be called'), 1000);
  }

  /**
   * Log message
   *
   * @param {String} [msg] Message
   * @api public
   */
  log(msg) {
    if (this.writeLog) {
      this.writeLog(msg);
    }
  }

  /**
   * Set logging function
   *
   * @param {Function} [cb] Callback
   * @api public
   */
  setLogging(cb) {
    this.writeLog = cb;
  }

  /**
   * Stop watching.
   *
   * @api public
   */
  end() {
    this.ends.forEach(cb => cb(this.data));
    this.watch.end(this);
    this.watch = null;
  }

  /**
   * Set initial data.
   *
   * @param {Object|Function} [cb] Object or function returning promise.
   * @api public
   */
  set(cb) {
    this.initialize.push(cb);
    return this;
  }

  /**
   * On message or error event.
   *
   * @param {String} [what] 'message' or 'error' or 'end'
   * @param {Function} [cb] Callback
   * @api public
   */
  on(what, cb) {
    switch (what) {
      case 'message':
        this.events.push(cb);
        break;
      case 'error':
        this.errors.push(cb);
        break;
      case 'end':
        this.ends.push(cb);
        break;
      default:
        break;
    }
    this.resolve = null;
    this.reject = null;
    return this;
  }

  /**
   * Start watching.
   *
   * @api public
   */
  run() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.initialize.forEach(cb => {
      if (typeof cb === 'function') {
        cb().then(data => this.receive(data));
      } else {
        this.receive(cb);
      }
    });
  }

  /**
   * Wait for data to pass a test.
   *
   * @param {Function} [cb] Callback
   * @api public
   */
  wait(cb) {
    this.test = cb;
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.run();
    });
  }

  /**
   * Internal callback from Watch.
   *
   * @param {Object} [data] Message data.
   * @api public
   */
  receive(data) {
    this.log(`subscribe ${this.collection} ${this.event} ${JSON.stringify(data)}`);
    // Modify in place
    if (this.options.merge) {
      Object.assign(this.data, data);
    } else {
      this.data = data;
    }
    try {
      this.events.forEach(cb => cb(this.data));
      if (this.test && this.test(this.data)) {
        if (this.resolve) {
          this.resolve(this.data);
        }
        this.end();
      }
    } catch (err) {
      this.log(`ERROR subscribe ${this.collection} ${this.event} ${err.toString()}`);
      this.errors.forEach(cb => cb(err));
      if (this.reject) {
        this.reject(err);
      }
      this.end();
    }
  }
}

/**
 * Helper for publishing pub/sub messages.
*/
class Publisher {
  /**
   * Publisher constructor
   *
   * @param {Object} [options] Options
   *   - `channel` mubsub channel
   *   - `collection` collection name
   *   - `event` event name
   */
  constructor(options) {
    this.channel = options.channel;
    this.collection = options.collection;
    this.event = options.event;
  }

  /**
   * Log message
   *
   * @param {String} [msg] Message
   * @api public
   */
  log(msg) {
    if (this.writeLog) {
      this.writeLog(msg);
    }
  }

  /**
   * Set logging function
   *
   * @param {Function} [cb] Callback
   * @api public
   */
  setLogging(cb) {
    this.writeLog = cb;
  }

  /**
   * Publish a message
   *
   * @param {Object|String} [message] Message
   * @api public
   */
  publish(message) {
    return new Promise((resolve, reject) => {
      try {
        this.log(`publish ${this.collection} ${this.event} ${JSON.stringify(message)}`);
        this.channel.publish(this.event, message, resolve);
      } catch (err) {
        console.error('ERROR: publish', err);
        reject(err);
      }
    });
  }
}

/**
 * Pub/sub messages without creating additional channels.  Create sparingly.
 * From Mubsub:
 * WARNING: You should not create lots of channels because Mubsub will poll from the cursor position.
 */
class PubSub {
  /**
   * PubSub constructor
   *
   * @param {String|Db} [mongo] uri string or Db instance
   * @param {String} [collection] collection name
   * @param {String} [event] channel name
   * @param {Object} [options] mongo driver options
   * @param {Object} [dbOptions] mongo driver options
   * @api public
   */
  constructor(mongo, collection, event, options, dbOptions) {
    this.mongo = mongo;
    this.collection = collection;
    this.event = event;
    this.options = options;
    this.watchers = {};
    this.publishers = {};
    this.callback = this.callback.bind(this);

    this.client = mubsub(mongo, dbOptions || { useNewUrlParser: true });
    this.client.on('error', console.error);
  }

  /**
   * Log message
   *
   * @param {String} [msg] Message
   * @api public
   */
  log(msg) {
    if (this.writeLog) {
      this.writeLog(msg);
    }
  }

  /**
   * Set logging function
   *
   * @param {Function} [cb] Callback
   * @api public
   */
  setLogging(cb) {
    this.writeLog = cb;
  }

  /**
   * Direct callback for mubsub
   *
   * @param {Object} message
   * @api private
   */
  callback(message) {
    const keys = Object.getOwnPropertyNames(this.watchers);
    keys.forEach(key => {
      const watcher = this.watchers[key];
      const { query } = watcher;
      const queries = Object.getOwnPropertyNames(query);
      for (let i = 0; i < queries.length; i++) {
        if (query[i] !== message[i]) {
          return;
        }
      }
      watcher.receive(message);
    });
  }

  /**
   * End a Watcher or Publisher instance.
   *
   * @param {Watcher|Publisher} [watcher] Previous result of watch() or publisher().
   * @api public
   */
  end(watcher) {
    if (this.watchers[watcher.id]) {
      delete this.watchers[watcher.id];
    }
    if (this.publishers[watcher.id]) {
      delete this.publishers[watcher.id];
    }
    if (Object.getOwnPropertyNames(this.watchers).length === 0
        && Object.getOwnPropertyNames(this.publishers).length === 0) {
      if (this.subscription) {
        this.subscription.unsubscribe();
        this.subscription = null;
      }
      this.channel = null;
    }
  }

  /**
   * Create a Watcher instance.
   *
   * @param {Object} [query] Fields for filtering messages
   * @api public
   */
  watch(query) {
    const watcher = new Watcher(this, query, this.options);
    watcher.setLogging(this.writeLog);
    this.watchers[watcher.id] = watcher;
    if (!this.channel) {
      this.channel = this.client.channel(this.collection);
      this.channel.on('error', console.error);
    }
    if (!this.subscription) {
      this.subscription = this.channel.subscribe(this.event, this.callback);
    }
    return watcher;
  }

  /**
   * Create a Publisher instance.
   *
   * @api public
   */
  publisher() {
    if (!this.channel) {
      this.channel = this.client.channel(this.collection);
      this.channel.on('error', console.error);
    }
    const { channel, collection, event } = this;
    const publisher = new Publisher({ channel, collection, event });
    publisher.setLogging(this.writeLog);
    return publisher;
  }
}

module.exports = { Watcher, Publisher, PubSub };
