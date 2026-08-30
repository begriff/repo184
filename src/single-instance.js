'use strict';

const fs = require('fs');
const path = require('path');

function processIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function acquire(dataFile) {
  const lockPath = dataFile + '.lock';
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  let descriptor;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      let record;
      try {
        record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch (readError) {
        throw new Error('Repo184 lock exists but cannot be validated: ' + lockPath);
      }
      if (record.pid && processIsLive(Number(record.pid))) {
        throw new Error('Another Repo184 process is already using ' + dataFile + ' (PID ' + record.pid + ')');
      }
      fs.unlinkSync(lockPath);
    }
  }

  if (descriptor === undefined) {
    throw new Error('Could not acquire the Repo184 data lock: ' + lockPath);
  }

  let released = false;
  return function release() {
    if (released) {
      return;
    }
    released = true;
    fs.closeSync(descriptor);
    try {
      const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (Number(record.pid) === process.pid) {
        fs.unlinkSync(lockPath);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(error);
      }
    }
  };
}

module.exports = {
  acquire: acquire,
  processIsLive: processIsLive
};
