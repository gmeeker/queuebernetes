const express = require('express');
const bodyParser = require('body-parser');
const mongodb = require('mongodb');
const { Worker } = require('@queuebernetes/core');
const { EngineMongoDB } = require('@queuebernetes/mongodb');
const Logging = require('@google-cloud/logging');

/* eslint-disable no-await-in-loop */

const logging = new Logging();
const log = logging.log('queuebernetes-worker');

const start = async () => {
  const con = process.env.MONGODB || 'mongodb://localhost:27017/test';
  const client = await mongodb.MongoClient.connect(con, { useNewUrlParser: true });
  const db = await client.db();
  const options = { exit: false, verbose: 9, createIndexes: true };
  const worker = new Worker(new EngineMongoDB(db), [{ name: 'simple-queue' }], options);
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
  worker.start().catch(err => console.error(err)).then(() => {
    console.log('Example app terminating...');
    process.exit(1);
  });

  const app = express();
  const jsonParser = bodyParser.json();

  app.get('/healthz', (req, res) => {
    if (worker.isRunning()) {
      res.send('ok');
    } else {
      res.status(500).send('Worker is not running');
    }
  });
  app.post('/create', jsonParser, (req, res) => {
    if (!req.body) {
      res.status(500).send('Invalid body');
      return;
    }
    if (req.body.queue !== 'simple-queue') {
      res.status(500).send('Invalid queue');
      return;
    }
    if (!req.body.msg) {
      res.status(500).send('Invalid message');
      return;
    }
    worker.queueMap[req.body.queue].add(req.body.msg, req.body.options || {}).then(() => {
      res.send('ok');
    });
  });
  app.use((err, req, res, next) => {
    console.error(err.stack);
    if (res.headersSend) {
      return next(err);
    }
    res.status(500).send('Something broke');
  });

  app.listen(3000, () => console.log('Example app listening on port 3000!'));
};

start().catch(err => console.error(err));
