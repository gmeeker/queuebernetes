const bodyParser = require('body-parser');
const express = require('express');
const http = require('http');
const mongodb = require('mongodb');
const { Controller } = require('@queuebernetes/core');
const { EngineMongoDB } = require('@queuebernetes/mongodb');
const { Logging } = require('@google-cloud/logging');
const { createTerminus } = require('@godaddy/terminus');
const manifest = require('./resources/job.json');
/* or use yaml:
const yaml = require('js-yaml');
const manifest = yaml.safeLoad(fs.readFileSync('./job.yaml'));
 */

/* eslint-disable no-await-in-loop */

const logging = new Logging();
const log = logging.log('queuebernetes-controller');

const start = async () => {
  const con = process.env.MONGODB || 'mongodb://localhost:27017/test';
  const client = await mongodb.MongoClient.connect(con, { useNewUrlParser: true });
  const db = await client.db();
  const options = {
    minReplicas: Number(process.env.MIN_REPLICAS || 0),
    maxReplicas: Number(process.env.MAX_REPLICAS || 3),
    maxTasks: Number(process.env.MAX_TASKS || 1),
    namespace: process.env.POD_NAMESPACE,
    gracePeriod: Number(process.env.GRACE_PERIOD || 120),
    clean: true,
    createIndexes: true,
    deleteJobs: true,
    manifest,
    selector: 'app=queuebernetes-controller',
    livenessQueue: 'queuebernetes-controller',
  };
  const workers = [{ queues: [{ name: 'controller-queue' }], options }];
  const ctrlOptions = {
    timeout: Number(process.env.TIMEOUT || 5),
    name: process.env.POD_NAME,
    verbose: 9,
  };
  const controller = new Controller(new EngineMongoDB(db), workers, ctrlOptions);
  controller.setLogging(msg => log.write(msg));

  const onSignal = () => {
    controller.shutdown();
    log.write('server is starting cleanup');
  };

  const healthCheck = () => {
    if (controller.isRunning()) {
      return Promise.resolve('ok');
    }
    return Promise.reject(new Error('Controller is not running'));
  };

  // Optional code to get Kubernetes image from the current container and set the manifest.
  // createClient() is only necessary to get controller.client in advance.
  await controller.createClient();
  const d = await controller.client.apis.apps.v1.namespaces(process.env.POD_NAMESPACE).deployments('queuebernetes-controller').get();
  if (d && d.body) {
    const { image } = d.body.spec.template.spec.containers[0];
    console.log('Current image', image);
    manifest.spec.template.spec.containers[0].image = image;
  }

  controller.start().catch(err => console.error(err)).then(() => {
    console.log('Example app terminating...');
    process.exit(1);
  });

  const app = express();
  const jsonParser = bodyParser.json();

  app.get('/', (req, res) => {
    res.send('ok');
  });
  app.post('/create', jsonParser, (req, res) => {
    if (!req.body) {
      res.status(500).send('Invalid body');
      return;
    }
    if (req.body.queue !== 'controller-queue') {
      res.status(500).send('Invalid queue');
      return;
    }
    if (!req.body.msg) {
      res.status(500).send('Invalid message');
      return;
    }
    controller.queueMap[req.body.queue].add(req.body.msg, req.body.options || {}).then(() => {
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
  const server = http.createServer(app);
  createTerminus(server, {
    healthChecks: {
      '/healthz': healthCheck
    },
    onSignal,
    logger: log.write,
  });
  server.listen(3000, () => console.log('Example app listening on port 3000!'));
};

start().catch(err => console.error(err));
