#!/bin/sh
kubectl run -i q11s-job --image=appropriate/curl --restart=Never --rm=true -- curl -X POST -H 'Content-Type: application/json' --data '{"queue": "simple-queue", "msg": "test", "options": {} }' http://queuebernetes-simple-service.default.svc.cluster.local:3000/create
