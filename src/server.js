'use strict';

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const net = require('net');
const createRouter = require('./app');
const configModule = require('./config');
const singleInstance = require('./single-instance');

const config = configModule.loadConfig();
configModule.validateBaseConfig(config);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'"
  );
  if (config.nodeEnv === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
});

app.get('/', function root(req, res) {
  res.redirect(config.basePath + '/');
});
app.use(config.basePath, createRouter(config));

app.use(function notFound(req, res) {
  res.status(404).send('Not found');
});

let server = null;
let releaseInstance = null;
let shuttingDown = false;
let ownsSocket = false;

function socketIsLive(socketPath) {
  return new Promise(function probe(resolve) {
    const connection = net.createConnection({ path: socketPath });
    let settled = false;
    function finish(live) {
      if (settled) {
        return;
      }
      settled = true;
      connection.destroy();
      resolve(live);
    }
    connection.setTimeout(750, function timedOut() { finish(true); });
    connection.once('connect', function connected() { finish(true); });
    connection.once('error', function failed(error) {
      finish(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT');
    });
  });
}

function removeOwnSocket() {
  if (!config.socketPath || !ownsSocket) {
    return;
  }
  try {
    const existing = fs.statSync(config.socketPath);
    if (existing.isSocket()) {
      fs.unlinkSync(config.socketPath);
      ownsSocket = false;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(error);
    }
  }
}

function releaseResources(exitCode) {
  removeOwnSocket();
  if (releaseInstance) {
    releaseInstance();
    releaseInstance = null;
  }
  process.exit(exitCode);
}

async function start() {
  releaseInstance = singleInstance.acquire(config.dataFile);

  if (config.socketPath) {
    try {
      const existing = fs.statSync(config.socketPath);
      if (!existing.isSocket()) {
        throw new Error('SOCKET_PATH exists and is not a socket: ' + config.socketPath);
      }
      if (await socketIsLive(config.socketPath)) {
        throw new Error('SOCKET_PATH is already accepting connections: ' + config.socketPath);
      }
      fs.unlinkSync(config.socketPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  await new Promise(function listen(resolve, reject) {
    server = config.socketPath
      ? app.listen(config.socketPath)
      : app.listen(config.port, '127.0.0.1');
    server.once('listening', function listening() {
      ownsSocket = Boolean(config.socketPath);
      resolve();
    });
    server.once('error', reject);
  });

  if (config.socketPath) {
    fs.chmodSync(config.socketPath, 0o660);
    console.log('Repo184 listening on ' + config.socketPath + ' for ' + config.baseUrl);
  } else {
    console.log('Repo184 listening at ' + config.baseUrl);
  }
}

function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (!server) {
    return releaseResources(0);
  }
  if (server.listening) {
    server.close(function closed() { releaseResources(0); });
  } else {
    releaseResources(0);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch(function startupFailed(error) {
  console.error(error);
  if (server && server.listening) {
    server.close(function closedAfterFailure() { releaseResources(1); });
  } else {
    releaseResources(1);
  }
});
