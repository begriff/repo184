'use strict';

const crypto = require('crypto');

class AppError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode || 400;
    this.code = code || 'application_error';
  }
}

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function parseTemplate(value) {
  const clean = String(value || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const pieces = clean.split('/');
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) {
    throw new AppError('Template repository must look like owner/repository', 400, 'invalid_template');
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(pieces[0]) || !/^[A-Za-z0-9_.-]+$/.test(pieces[1])) {
    throw new AppError('Template repository contains unsupported characters', 400, 'invalid_template');
  }
  return { owner: pieces[0], repo: pieces[1], fullName: pieces[0] + '/' + pieces[1] };
}

function validateAssignmentInput(input) {
  const slug = slugify(input.slug);
  const title = String(input.title || '').trim();
  const template = parseTemplate(input.template);
  const repoPrefix = slugify(input.repoPrefix || slug);
  const maxTeamSize = Number(input.maxTeamSize);
  const status = input.status === 'open' ? 'open' : 'closed';

  if (!slug || slug.length > 32) {
    throw new AppError('Assignment slug must contain letters or numbers and be at most 32 characters', 400);
  }
  if (!title || title.length > 80) {
    throw new AppError('Assignment title is required and must be at most 80 characters', 400);
  }
  if (!repoPrefix || repoPrefix.length > 48) {
    throw new AppError('Repository prefix is required and must be at most 48 characters', 400);
  }
  if (maxTeamSize !== 1 && maxTeamSize !== 2) {
    throw new AppError('Maximum team size must be 1 or 2', 400);
  }

  return {
    slug: slug,
    title: title,
    templateOwner: template.owner,
    templateRepo: template.repo,
    templateFullName: template.fullName,
    repoPrefix: repoPrefix,
    maxTeamSize: maxTeamSize,
    status: status
  };
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  if (leftBuffer.length !== rightBuffer.length) {
    crypto.timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function scrypt(password, salt, length) {
  return new Promise(function derive(resolve, reject) {
    crypto.scrypt(password, salt, length, function onScrypt(error, key) {
      if (error) {
        return reject(error);
      }
      return resolve(key);
    });
  });
}

async function hashPassword(password) {
  const value = String(password || '');
  if (!value) {
    throw new AppError('Password cannot be empty', 400, 'empty_password');
  }
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(value, salt, 64);
  return 'scrypt$' + salt.toString('base64') + '$' + derived.toString('base64');
}

async function verifyPassword(password, encoded) {
  const pieces = String(encoded || '').split('$');
  if (pieces.length !== 3 || pieces[0] !== 'scrypt') {
    return false;
  }

  let salt;
  let expected;
  try {
    salt = Buffer.from(pieces[1], 'base64');
    expected = Buffer.from(pieces[2], 'base64');
  } catch (error) {
    return false;
  }
  if (!salt.length || !expected.length) {
    return false;
  }
  const actual = await scrypt(String(password || ''), salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  AppError: AppError,
  base64Url: base64Url,
  clone: clone,
  constantTimeEqual: constantTimeEqual,
  hashPassword: hashPassword,
  nowIso: nowIso,
  parseTemplate: parseTemplate,
  randomId: randomId,
  slugify: slugify,
  validateAssignmentInput: validateAssignmentInput,
  verifyPassword: verifyPassword
};
