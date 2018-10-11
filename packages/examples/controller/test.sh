#!/bin/sh
kubectl run -i q11s-job --image=appropriate/curl --restart=Never --rm=true -- curl -X POST -H 'Content-Type: application/json' --data '{"queue": "controller-queue", "msg": "test", "options": {} }' http://queuebernetes-controller-service.default.svc.cluster.local:3000/create
