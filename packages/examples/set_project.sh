#!/bin/bash
cd "`dirname \"$0\"`"
if test -z "$1"; then
  echo "Usage: $0 GCLOUD_PROJECT_NAME"
  exit 1
fi
for i in ./controller/resources/job.yaml \
  ./controller/resources/job.json \
  ./controller/resources/controller.yaml \
  ./simple/resources/worker.yaml; do \
  sed "s/GCLOUD_PROJECT/$1/g" < "$i" > tmp && mv tmp "$i"; \
  done
