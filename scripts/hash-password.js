'use strict';

const util = require('../src/util');

if (process.stdin.isTTY) {
  console.error('Read the password from standard input, for example: printf %s "$PASSWORD" | npm run --silent hash-password');
  process.exitCode = 1;
} else {
  const chunks = [];
  process.stdin.on('data', function data(chunk) { chunks.push(Buffer.from(chunk)); });
  process.stdin.on('end', function end() {
    const password = Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '');
    util.hashPassword(password).then(function print(hash) {
      console.log(hash);
    }).catch(function failed(error) {
      console.error(error.message);
      process.exitCode = 1;
    });
  });
}
