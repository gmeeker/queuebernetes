# Queuebernetes: queue for long-running tasks in Kubernetes #

Or q11s, as k8s is an abbreviation for Kubernetes.

Worker queues could be implemented a variety of ways in Kubernetes, or as FaaS with Knative.  Queuebernetes is designed with long-running tasks in mind, where the work load is variable and very resource intensive.  The queue items are persistent to avoid being lost due to container restarts.  Media transcoding is a perfect example.

Queuebernetes is not designed for high volume tasks that complete quickly (e.g. messaging using Redis).

## Design ##

Why doesn't Kubernetes provide this out of the box?  It provides auto-scaling, but that doesn't scale to zero containers.  Jobs can be create single use containers, but if the work load is high, the overhead of container creation and destruction should be avoided.

Instead, we need a controller to watch the queue and create Job containers (which may require more resources than other containers).  These exit after the queue becomes empty.  Kubernetes doesn't scale Jobs so the controller must handle scaling.  If node scaling is enabled for the cluster, we can use minimal resources when the queue is empty.

## The queue ##

For persistent storage of the queue, we use mongodb-queue

https://github.com/chilts/mongodb-queue

## Creating a Worker ##

The class Worker handles sending messages from the queue to handlers that perform the work.  See mongodb-queue.

To create a worker, pass the database connection and a list of arguments to mongodb-queue:

```
const con = 'mongodb://localhost:27017/test';
const client = await mongodb.MongoClient.connect(con, { useNewUrlParser: true });
const db = await client.db();
const worker = new Worker(db, [{ name: 'simple-queue', options: {} }], {});
```

### Options ###

#### timeout ####
Default: `5`
Time in seconds to sleep between polling the database.

#### keepAlive ####
Default: `300`
Time in seconds to keep running after the queue goes empty, to prevent frequent container restarting.

#### maxTasks ####
Default: `1`
The maximum number of queue items to run in parallel.

#### clean ####
Default: `false`
Call clean() on the queues (usually handled by Controller).

#### createIndexes ####
Default: `false`
Call createIndex on the queues (usually handled by Controller).

#### exit ####
Default: `true`
Set to `false` to keep running the when the queue is empty.  When running from a Job, set to `true`.

#### verbose ####
Default: `5`
Logging verbosity, from 0-9.

## Creating a Controller ##

This is the 'master' that creates Kubernetes Jobs.  It takes a list of queue names and k8s manifests (in JSON, but see below for YAML support).

```
const con = process.env.MONGODB || 'mongodb://localhost:27017/test';
const db = await promisify(mongodb.MongoClient.connect)(con, { useNewUrlParser: true });
const options = {
  minReplicas: 0,
  maxReplicas: 3,
  maxTasks: 1,
  namespace: process.env.POD_NAMESPACE,
  gracePeriod: 60,
  clean: true,
  createIndexes: true,
  deleteJobs: true,
  manifest,
  selector: 'app=queuebernetes-controller',
  desiredReplicas: (tasks, options) => tasks / options.maxTasks,
  deleteReplica: (job, controller, options) => options.deleteJobs,
  getMinReplicas: minReplicas => minReplicas,
  getMaxReplicas: maxReplicas => maxReplicas,
};
const workers = [{ queues: ['controller-queue'], options }];
const ctrlOptions = {
  timeout: 5,
  verbose: 5,
};
const controller = new Controller(db, workers, ctrlOptions);
```

See the examples for how to set the process env.

### Options ###

#### timeout ####
Default: `5`
Time in seconds to sleep between polling the database.

#### minReplicas ####
Default: `0`
Minimum numbers of worker Jobs.  The workers are designed to exit, or scale to 0.  To keep workers running, empty messages
will be periodically added to the queue.  This can be forced temporarily with ```controller.wakeup(minReplicas)```

#### maxReplicas ####
Default: `1`
Maximum numbers of worker Jobs.

#### maxTasks ####
Default: `1`
Maximum numbers of concurrent tasks per worker.

#### namespace ####
Default: `default`
Kubernetes namespace.

#### gracePeriod ####
Default: `60`
Period between launching Jobs, to ease into heavy workloads.
If this is too low, Controller may try to deploy again without an accurate container count.

#### clean ####
Default: `true`
Call clean() on the queues.

#### createIndexes ####
Default: `true`
Call createIndex on the queues.

#### deleteJobs ####
Default: `true`
Clean up and delete finished Kubernetes Jobs.

#### manifest ####
Kubernetes Job manifest.

#### selector ####
Kubernetes selector for Jobs.

#### verbose ####
Default: `5`
Logging verbosity, from 0-9.

#### desiredReplicas ###
Optional callback to calculate desired replica count.
Default:
```
(tasks, options) => tasks / options.maxTasks
```

#### deleteReplica ###
Detailed control of when to delete containers,
e.g. only delete successful Job containers.
`job` is a Kubernetes manifest.  In particular `job.status` is useful.
Default:
```
(job, controller, options) => options.deleteJobs
```

#### getMinReplicas ###
Detailed control of minimum required containers,
e.g. don't scale to zero during business hours.
Default:
```
minReplicas => minReplicas
```

#### getMaxReplicas ###
Detailed control of maximum required containers.
Default:
```
maxReplicas => maxReplicas
```

## Optional ##
To use Google Stackdriver:
```
const Logging = require('@google-cloud/logging');
const log = logging.log(logName);
worker.setLogging(msg => log.write(msg));
```
To use YAML instead of JSON:
```
const yaml = require('js-yaml');
const jsonDeploy = require('./deploy.json');
const yamlDeploy = yaml.safeLoad(fs.readFileSync('./deploy.yaml'));
```

## Examples ##
Clone queuebernetes.  Run ```lerna bootstrap``` and cd into packages/examples.  These instructions assume Google Cloud.  Edit the .yaml files, job.json, and test.sh, and replace GCLOUD_PROJECT with the name of your project:

./set_project.sh `MY_PROJECT`

Build:
```
docker build -f ./Dockerfile -t queuebernetes-examples:latest -t us.gcr.io/$GCLOUD_PROJECT/queuebernetes-examples:latest ../..
docker push us.gcr.io/$GCLOUD_PROJECT/queuebernetes-examples:latest
kubectl delete deploy queuebernetes-simple
kubectl apply -f simple/resources/worker.yaml
./simple/test.sh
```

And for controller (the version using Jobs):
```
kubectl delete deploy queuebernetes-controller
kubectl apply -f controller/resources/controller.yaml
./controller/test.sh
```
