const express = require('express');
const mongodb = require('mongodb');
const { Worker } = require('@queuebernetes/core');
const { EngineMongoDB } = require('@queuebernetes/mongodb');
const Logging = require('@google-cloud/logging');

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
  };
  const worker = new Worker(new EngineMongoDB(db), [{ name: 'controller-queue' }], options);
  worker.setLogging(msg => log.write(msg));
  worker.addHandler(async (queue, msg, poll) => {
    for (let i = 0; i < 100; i++) {
      console.log(`Running task: ${i}`);
      poll();
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

  const app = express();

  app.get('/healthz', (req, res) => {
    if (worker.isRunning()) {
      res.send('ok');
    } else {
      res.status(500).send('Worker is not running');
    }
  });
  app.listen(3000, () => console.log('Job worker listening on port 3000!'));
};

start();
