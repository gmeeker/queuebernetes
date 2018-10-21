const EventEmitter = require('events');
const { PubsubManager } = require('redis-messaging-manager');
const { URL } = require('url');
const uuidv4 = require('uuid/v4');

/**
 * Example:
 * const { PubSub } = require('@queuebernetes/pubsub');
 * const pubsub = new PubSub({ host: 'localhost' }, 'channel');
 * pubsub.watch({ event: 'test', id: 'foo' })
 *   .set(() => { bar: 1 })
 *   .wait(msg => msg.bar === 10);
 * const publisher = pubsub.publisher();
 * publisher.publish({ bar: 10 });
 */

/**
 * Helper for watching pub/sub messages.
*/
class Watcher extends EventEmitter {
  /**
   * Watch constructor
   *
   * @param {Watch} [watch] Watch instance
   * @param {Object} [query] Fields for filtering messages
   * @param {Object} [options] Options for merging incoming data
   *   - `merge` merge data from message or overwrite, default is true
   */
  constructor(watch, query, options = {}) {
    super();
    this.watch = watch;
    this.channel = watch.channel;
    this.query = query;
    this.options = Object.assign({}, { merge: true }, options);
    this.id = uuidv4();
    this.data = {};
    this.initialize = [];
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
    this.emit('end', this.data);
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
    this.log(`subscribe ${this.channel} ${JSON.stringify(data)}`);
    // Modify in place
    if (this.options.merge) {
      Object.assign(this.data, data);
    } else {
      this.data = data;
    }
    try {
      this.emit('message', this.data);
      if (this.test && this.test(this.data)) {
        if (this.resolve) {
          this.resolve(this.data);
        }
        this.end();
      }
    } catch (err) {
      this.log(`ERROR subscribe ${this.channel} ${err.toString()}`);
      this.emit('error', err);
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
   *   - `client` Messaging client
   *   - `channel` channel name
   */
  constructor(options) {
    this.client = options.client;
    this.channel = options.channel;
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
    const json = JSON.stringify(message);
    return this.client.publish(this.channel, json)
      .then(() => this.log(`publish ${this.channel} ${json}`));
  }
}

/**
 * Pub/sub messages without creating additional consumers.
 * This was useful for mubsub but maybe less of a concern for Redis.
 */
class PubSub {
  /**
   * PubSub constructor
   *
   * @param {Object|String} [uri] Redis URI or object
   * @param {String} [channel] channel name
   * @api public
   */
  constructor(uri, channel) {
    if (!uri) {
      throw new Error('Redis URI is not specified');
    } else if (typeof uri === 'object') {
      this.uri = uri;
    } else if (uri[0] === '/') {
      // Local socket
      this.uri = { path: uri };
    } else {
      // redis-messaging-manager doesn't support URI format like ioredis
      const {
        hostname, protocol, port, password, pathname
      } = new URL(uri);
      if (protocol !== 'redis:' || !hostname) {
        throw new Error(`Invalid Redis URI ${uri}`);
      }
      this.uri = {
        host: hostname,
      };
      if (port !== undefined) {
        this.uri.port = port;
      }
      if (password !== undefined) {
        this.uri.password = password;
      }
      if (pathname && pathname.length > 1) {
        this.uri.db = pathname.slice(1);
      }
    }
    this.channel = channel;
    this.watchers = {};
    this.publishers = {};
    this.callback = this.callback.bind(this);

    this.client = new PubsubManager(this.uri);
    this.client.getServerEventStream('error')
      .subscribe(() => {
        this.log('Pubsub error event');
      });
    this.client.getServerEventStream('connect')
      .subscribe(() => {
        this.log('Pubsub redis connect event');
      });
    this.client.getServerEventStream('reconnecting')
      .subscribe(() => {
        this.log('Pubsub redis reconnecting event');
      });
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
  callback(messageString) {
    const message = JSON.parse(messageString);
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
      this.consumer = null;
    }
  }

  /**
   * Create a Watcher instance.
   *
   * @param {Object} [query] Fields for filtering messages
   * @param {Object} [options] Options for merging incoming data
   *   - `merge` merge data from message or overwrite, default is true
   * @api public
   */
  watch(query, options = {}) {
    const watcher = new Watcher(this, query, options);
    watcher.setLogging(this.writeLog);
    this.watchers[watcher.id] = watcher;
    if (!this.consumer) {
      this.consumer = this.client.consume(this.channel);
    }
    if (!this.subscription) {
      this.subscription = this.consumer.subscribe(this.callback);
    }
    return watcher;
  }

  /**
   * Create a Publisher instance.
   *
   * @api public
   */
  publisher() {
    const { client, channel } = this;
    const publisher = new Publisher({ client, channel });
    publisher.setLogging(this.writeLog);
    return publisher;
  }
}

module.exports = { Watcher, Publisher, PubSub };
