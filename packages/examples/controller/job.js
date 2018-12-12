const express = require('express');
const http = require('http');
const mongodb = require('mongodb');
const { Worker } = require('@queuebernetes/core');
const { EngineMongoDB } = require('@queuebernetes/mongodb');
const { Logging } = require('@google-cloud/logging');
const { createTerminus } = require('@godaddy/terminus');

/* eslint-disable no-await-in-loop */

const logging = new Logging();
const log = logging.log('queuebernetes-job');

const start = async () => {
  const con = process.env.MONGODB || 'mongodb://localhost:27017/test';
  const client = await mongodb.MongoClient.connect(con, { useNewUrlParser: true });
  const db = await client.db();
  const options = {
    maxTasks: Number(process.env.MAX_TASKS || 1),
    timeout: Number(process.env.TIMEOUT || 5),
    keepAlive: Number(process.env.KEEP_ALIVE || 5),
    clean: false,
    verbose: 9,
    livenessQueue: 'queuebernetes-controller',
  };
  const queue = {
    name: 'controller-queue',
    options: {
      maxRetries: 5,
      deadQueue: 'controller-dead-queue',
    }
  };
  const worker = new Worker(new EngineMongoDB(db), [queue], options);
  worker.setLogging(msg => log.write(msg));
  worker.addHandler(async msg => {
    for (let i = 0; i < 100; i++) {
      console.log(`Running task: ${i}`);
      msg.ping();
      await new Promise(resolve => {
        setTimeout(resolve, 1000);
      });
    }
  });
  worker.start().catch(err => {
    console.error(err);
    console.log('Job worker terminating...');
    process.exit(1);
  }).then(() => {
    console.log('Job worker finished...');
    process.exit(0);
  });

  const onSignal = () => {
    worker.shutdown();
    log.write('server is starting cleanup');
  };

  const healthCheck = () => {
    if (worker.isRunning()) {
      return Promise.resolve('ok');
    }
    return Promise.reject(new Error('Worker is not running'));
  };

  const app = express();
  app.get('/', (req, res) => {
    res.send('ok');
  });
  const server = http.createServer(app);
  createTerminus(server, {
    healthChecks: {
      '/healthz': healthCheck
    },
    onSignal,
    logger: log.write,
  });
  server.listen(3000, () => console.log('Job worker listening on port 3000!'));
};

start();
