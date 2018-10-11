FROM node:alpine

EXPOSE 3000

RUN apk --no-cache add git

RUN mkdir -p /app/queuebernetes/packages/core
RUN mkdir -p /app/queuebernetes/packages/examples
RUN mkdir -p /app/queuebernetes/packages/mongodb

# Support for git but remove from the image
RUN apk --no-cache add --virtual native-deps \
  git

WORKDIR /app/queuebernetes/
ADD lerna.json package.json /app/queuebernetes/
WORKDIR /app/queuebernetes/packages/core
ADD packages/core/package.json /app/queuebernetes/packages/core/
WORKDIR /app/queuebernetes/packages/examples
ADD packages/examples/package.json /app/queuebernetes/packages/examples/
WORKDIR /app/queuebernetes/packages/mongodb
ADD packages/mongodb/package.json /app/queuebernetes/packages/mongodb/
WORKDIR /app/queuebernetes
RUN npx lerna bootstrap

RUN apk del native-deps

ADD . /app/queuebernetes
RUN yarn lint
RUN ln -s queuebernetes/packages/examples /app/

CMD ["node", "/app/examples/simple/worker.js"]
