'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const projectRoot = path.join(__dirname, '..');
const roots = ['src', 'scripts', 'test'];
const files = [];

const lockfile = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
if (lockfile.lockfileVersion !== 1) {
  console.error('package-lock.json must remain at lockfileVersion 1 for npm 6 compatibility.');
  process.exit(1);
}

function collect(directory) {
  if (!fs.existsSync(directory)) {
    return;
  }
  fs.readdirSync(directory).forEach(function visit(name) {
    const fullPath = path.join(directory, name);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      collect(fullPath);
    } else if (/\.js$/.test(name)) {
      files.push(fullPath);
    }
  });
}

roots.forEach(function root(name) {
  collect(path.join(projectRoot, name));
});

files.forEach(function check(filePath) {
  const result = childProcess.spawnSync(process.execPath, ['--check', filePath], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
});

console.log('Syntax checked: ' + files.length + ' JavaScript files; npm 6 lockfile verified.');
