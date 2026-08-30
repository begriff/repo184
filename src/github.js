'use strict';

const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');
const util = require('./util');

const API_VERSION = '2026-03-10';
const MAX_CONCURRENT_API_REQUESTS = 8;
const MAX_QUEUED_API_REQUESTS = 128;
const MAX_PRIORITY_QUEUED_API_REQUESTS = 32;
const API_QUEUE_TIMEOUT_MS = 25000;
const MAX_WRITE_REQUESTS_PER_MINUTE = 60;
const MAX_WRITE_REQUESTS_PER_HOUR = 400;
const MAX_NORMAL_WRITE_REQUESTS_PER_MINUTE = 50;
const MAX_NORMAL_WRITE_REQUESTS_PER_HOUR = 320;

class GitHubError extends Error {
  constructor(message, statusCode, responseBody) {
    super(message);
    this.name = 'GitHubError';
    this.statusCode = statusCode || 502;
    this.responseBody = responseBody || null;
  }
}

function requestJson(options) {
  return new Promise(function execute(resolve, reject) {
    let settled = false;
    const maxResponseBytes = options.maxResponseBytes || (2 * 1024 * 1024);
    function resolveOnce(value) {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    }
    function rejectOnce(error) {
      if (!settled) {
        settled = true;
        reject(error);
      }
    }
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const headers = Object.assign({
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Repo184',
      'X-GitHub-Api-Version': API_VERSION
    }, options.headers || {});
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const transport = options.transport || https;
    const request = transport.request({
      hostname: options.hostname || 'api.github.com',
      port: options.port,
      path: options.path,
      method: options.method || 'GET',
      headers: headers,
      timeout: options.timeout || 15000
    }, function onResponse(response) {
      const chunks = [];
      let responseBytes = 0;
      response.on('data', function onData(chunk) {
        responseBytes += chunk.length;
        if (responseBytes > maxResponseBytes) {
          rejectOnce(new Error('GitHub response exceeded the size limit'));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', function onEnd() {
        if (settled) {
          return;
        }
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch (error) {
            parsed = { message: text };
          }
        }
        resolveOnce({
          status: response.statusCode,
          headers: response.headers,
          body: parsed
        });
      });
      response.on('aborted', function onAborted() {
        rejectOnce(new Error('GitHub response was aborted'));
      });
      response.on('error', rejectOnce);
    });

    request.on('timeout', function onTimeout() {
      request.destroy(new Error('GitHub request timed out'));
    });
    request.on('error', rejectOnce);
    if (body !== null) {
      request.write(body);
    }
    request.end();
  });
}

function requireSuccess(response, expected, action) {
  const accepted = Array.isArray(expected) ? expected : [expected];
  if (accepted.indexOf(response.status) !== -1) {
    return response;
  }
  const detail = response.body && response.body.message ? response.body.message : 'Unexpected response';
  throw new GitHubError('GitHub could not ' + action + ' (' + response.status + '): ' + detail, response.status, response.body);
}

class GitHubClient {
  constructor(config) {
    this.config = config;
    this.cachedInstallationToken = null;
    this.installationTokenPromise = null;
    this.activeApiRequests = 0;
    this.apiRequestQueue = [];
    this.priorityApiRequestQueue = [];
    this.apiBackoffUntil = 0;
    this.writeRequestTimes = [];
  }

  rateLimitError() {
    const seconds = Math.max(1, Math.ceil((this.apiBackoffUntil - Date.now()) / 1000));
    return new util.AppError(
      'GitHub asked Repo184 to pause API requests. Wait about ' + seconds + ' seconds and try again.',
      429,
      'github_rate_limited'
    );
  }

  rejectQueuedForBackoff() {
    const client = this;
    [this.priorityApiRequestQueue, this.apiRequestQueue].forEach(function rejectQueue(queue) {
      while (queue.length) {
        const entry = queue.shift();
        clearTimeout(entry.timeout);
        entry.reject(client.rateLimitError());
      }
    });
  }

  noteRateLimit(response) {
    if (!response || typeof response.status !== 'number') {
      return false;
    }
    const headers = response.headers || {};
    const retryAfter = headers['retry-after'] || headers['Retry-After'];
    const remaining = headers['x-ratelimit-remaining'] || headers['X-RateLimit-Remaining'];
    const reset = headers['x-ratelimit-reset'] || headers['X-RateLimit-Reset'];
    const message = response.body && response.body.message
      ? String(response.body.message).toLowerCase()
      : '';
    const rateMessage =
      message.indexOf('secondary rate limit') !== -1 ||
      message.indexOf('rate limit exceeded') !== -1 ||
      message.indexOf('abuse detection') !== -1;
    const failedForRateLimit =
      response.status === 429 ||
      (response.status === 403 && (String(remaining) === '0' || Boolean(retryAfter) || rateMessage));
    const exhaustedPrimaryLimit = String(remaining) === '0';

    if (!failedForRateLimit && !exhaustedPrimaryLimit) {
      return false;
    }

    const now = Date.now();
    let until = 0;
    if (retryAfter) {
      const retrySeconds = Number(retryAfter);
      if (Number.isFinite(retrySeconds)) {
        until = now + (Math.max(0, retrySeconds) * 1000);
      } else {
        const retryDate = new Date(retryAfter).getTime();
        if (Number.isFinite(retryDate)) {
          until = retryDate;
        }
      }
    }
    if (exhaustedPrimaryLimit && Number.isFinite(Number(reset))) {
      until = Math.max(until, Number(reset) * 1000);
    }
    if (until <= now) {
      until = now + (failedForRateLimit ? 60000 : 1000);
    }
    this.apiBackoffUntil = Math.max(this.apiBackoffUntil, until + 1000);
    this.rejectQueuedForBackoff();
    return failedForRateLimit;
  }

  dispatchApiQueue() {
    if (Date.now() < this.apiBackoffUntil) {
      this.rejectQueuedForBackoff();
      return;
    }
    while (
      this.activeApiRequests < MAX_CONCURRENT_API_REQUESTS &&
      (this.priorityApiRequestQueue.length || this.apiRequestQueue.length)
    ) {
      const entry = this.priorityApiRequestQueue.length
        ? this.priorityApiRequestQueue.shift()
        : this.apiRequestQueue.shift();
      clearTimeout(entry.timeout);
      entry.run();
    }
  }

  withApiRequestSlot(operation, options) {
    const client = this;
    const settings = options || {};
    return new Promise(function schedule(resolve, reject) {
      if (Date.now() < client.apiBackoffUntil) {
        reject(client.rateLimitError());
        return;
      }
      function run() {
        client.activeApiRequests += 1;
        Promise.resolve().then(operation).then(function success(value) {
          const failedForRateLimit = client.noteRateLimit(value);
          client.activeApiRequests -= 1;
          if (failedForRateLimit) {
            reject(client.rateLimitError());
          } else {
            resolve(value);
          }
          client.dispatchApiQueue();
        }, function failure(error) {
          client.activeApiRequests -= 1;
          reject(error);
          client.dispatchApiQueue();
        });
      }
      const entry = { run: run, reject: reject, timeout: null };
      if (client.activeApiRequests < MAX_CONCURRENT_API_REQUESTS) {
        run();
      } else {
        const priority = Boolean(settings.priority);
        const queue = priority ? client.priorityApiRequestQueue : client.apiRequestQueue;
        const queueLimit = priority ? MAX_PRIORITY_QUEUED_API_REQUESTS : MAX_QUEUED_API_REQUESTS;
        if (queue.length >= queueLimit) {
          reject(new util.AppError('GitHub is temporarily busy with course requests. Wait a moment and try again.', 503, 'github_request_queue_full'));
          return;
        }
        queue.push(entry);
        entry.timeout = setTimeout(function expireQueuedRequest() {
          const index = queue.indexOf(entry);
          if (index === -1) {
            return;
          }
          queue.splice(index, 1);
          reject(new util.AppError('GitHub did not become available in time. Wait a moment and try again.', 503, 'github_request_queue_timeout'));
        }, API_QUEUE_TIMEOUT_MS);
        if (entry.timeout.unref) {
          entry.timeout.unref();
        }
      }
    });
  }

  takeWriteRequestBudget(nowValue, useRevocationReserve) {
    const now = nowValue || Date.now();
    const hourAgo = now - (60 * 60 * 1000);
    const minuteAgo = now - (60 * 1000);
    this.writeRequestTimes = this.writeRequestTimes.filter(function withinHour(timestamp) {
      return timestamp > hourAgo;
    });
    let minuteCount = 0;
    this.writeRequestTimes.forEach(function countRecent(timestamp) {
      if (timestamp > minuteAgo) {
        minuteCount += 1;
      }
    });
    if (
      minuteCount >= MAX_WRITE_REQUESTS_PER_MINUTE ||
      this.writeRequestTimes.length >= MAX_WRITE_REQUESTS_PER_HOUR ||
      (!useRevocationReserve && minuteCount >= MAX_NORMAL_WRITE_REQUESTS_PER_MINUTE) ||
      (!useRevocationReserve && this.writeRequestTimes.length >= MAX_NORMAL_WRITE_REQUESTS_PER_HOUR)
    ) {
      return false;
    }
    this.writeRequestTimes.push(now);
    return true;
  }

  reserveWriteRequest(method) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    if (['POST', 'PATCH', 'PUT', 'DELETE'].indexOf(normalizedMethod) === -1) {
      return null;
    }
    if (Date.now() < this.apiBackoffUntil) {
      return this.rateLimitError();
    }
    if (!this.takeWriteRequestBudget(undefined, normalizedMethod === 'DELETE')) {
      return new util.AppError(
        'Repo184 is pacing GitHub changes to stay within GitHub limits. Wait a minute and try again.',
        429,
        'github_rate_limited'
      );
    }
    return null;
  }

  assertConfigured() {
    const required = [
      ['GITHUB_APP_ID', this.config.githubAppId],
      ['GITHUB_CLIENT_ID', this.config.githubClientId],
      ['GITHUB_CLIENT_SECRET', this.config.githubClientSecret],
      ['GITHUB_INSTALLATION_ID', this.config.githubInstallationId],
      ['GITHUB_PRIVATE_KEY', this.config.githubPrivateKey]
    ];
    const missing = required.filter(function missingValue(entry) { return !entry[1]; });
    if (missing.length) {
      throw new util.AppError('GitHub App configuration is incomplete: ' + missing.map(function name(entry) { return entry[0]; }).join(', '), 503, 'github_not_configured');
    }
  }

  authorizationUrl(state, codeChallenge) {
    this.assertConfigured();
    return 'https://github.com/login/oauth/authorize?' + querystring.stringify({
      client_id: this.config.githubClientId,
      redirect_uri: this.config.baseUrl + '/auth/github/callback',
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      allow_signup: 'true'
    });
  }

  async exchangeCode(code, codeVerifier) {
    this.assertConfigured();
    const client = this;
    const response = await this.withApiRequestSlot(function exchangeRequest() {
      return requestJson({
        hostname: 'github.com',
        path: '/login/oauth/access_token',
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: {
          client_id: client.config.githubClientId,
          client_secret: client.config.githubClientSecret,
          code: code,
          redirect_uri: client.config.baseUrl + '/auth/github/callback',
          code_verifier: codeVerifier
        }
      });
    });
    requireSuccess(response, 200, 'complete sign-in');
    if (!response.body || !response.body.access_token) {
      throw new GitHubError('GitHub sign-in did not return an access token', 502, response.body);
    }
    return response.body.access_token;
  }

  async getAuthenticatedUser(userToken) {
    const response = await this.withApiRequestSlot(function authenticatedUserRequest() {
      return requestJson({
        path: '/user',
        headers: { Authorization: 'Bearer ' + userToken }
      });
    });
    requireSuccess(response, 200, 'identify the signed-in user');
    return {
      id: String(response.body.id),
      numericId: response.body.id,
      login: response.body.login,
      avatarUrl: response.body.avatar_url || '',
      profileUrl: response.body.html_url || ('https://github.com/' + response.body.login)
    };
  }

  async getUserById(accountId, priority) {
    const response = await this.appRequest(
      '/user/' + encodeURIComponent(accountId),
      'GET',
      undefined,
      { priority: Boolean(priority) }
    );
    requireSuccess(response, 200, 'resolve the current GitHub username');
    if (!response.body || String(response.body.id) !== String(accountId)) {
      throw new GitHubError('GitHub returned a different account for the stored user ID', 502, response.body);
    }
    return {
      id: String(response.body.id),
      numericId: response.body.id,
      login: response.body.login,
      avatarUrl: response.body.avatar_url || '',
      profileUrl: response.body.html_url || ('https://github.com/' + response.body.login)
    };
  }

  createAppJwt() {
    const now = Math.floor(Date.now() / 1000);
    const header = util.base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = util.base64Url(JSON.stringify({
      iat: now - 60,
      exp: now + (9 * 60),
      iss: String(this.config.githubAppId)
    }));
    const unsigned = header + '.' + payload;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    return unsigned + '.' + util.base64Url(signer.sign(this.config.githubPrivateKey));
  }

  async fetchInstallationToken() {
    const response = await requestJson({
      path: '/app/installations/' + encodeURIComponent(this.config.githubInstallationId) + '/access_tokens',
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.createAppJwt() },
      body: {}
    });
    if (this.noteRateLimit(response)) {
      throw this.rateLimitError();
    }
    requireSuccess(response, 201, 'create an installation token');
    return {
      token: response.body.token,
      expiresAt: new Date(response.body.expires_at).getTime()
    };
  }

  async installationToken() {
    this.assertConfigured();
    if (this.cachedInstallationToken && this.cachedInstallationToken.expiresAt > Date.now() + 60000) {
      return this.cachedInstallationToken.token;
    }
    if (!this.installationTokenPromise) {
      const client = this;
      this.installationTokenPromise = this.fetchInstallationToken().then(function cache(record) {
        client.cachedInstallationToken = record;
        return record.token;
      });
    }
    try {
      return await this.installationTokenPromise;
    } finally {
      this.installationTokenPromise = null;
    }
  }

  async performAppRequest(path, method, body) {
    let token = await this.installationToken();
    if (Date.now() < this.apiBackoffUntil) {
      throw this.rateLimitError();
    }
    let response = await requestJson({
      path: path,
      method: method,
      body: body,
      headers: { Authorization: 'Bearer ' + token }
    });
    if (response.status === 401) {
      if (this.cachedInstallationToken && this.cachedInstallationToken.token === token) {
        this.cachedInstallationToken = null;
      }
      token = await this.installationToken();
      if (Date.now() < this.apiBackoffUntil) {
        throw this.rateLimitError();
      }
      response = await requestJson({
        path: path,
        method: method,
        body: body,
        headers: { Authorization: 'Bearer ' + token }
      });
    }
    return response;
  }

  appRequest(path, method, body, options) {
    const reservationError = this.reserveWriteRequest(method);
    if (reservationError) {
      return Promise.reject(reservationError);
    }
    const client = this;
    return this.withApiRequestSlot(function installationRequest() {
      return client.performAppRequest(path, method, body);
    }, options);
  }

  async getMembership(login, priority) {
    const response = await this.appRequest(
      '/orgs/' + encodeURIComponent(this.config.githubOrg) + '/memberships/' + encodeURIComponent(login),
      'GET',
      undefined,
      { priority: Boolean(priority) }
    );
    if (response.status === 404) {
      return null;
    }
    requireSuccess(response, 200, 'check organization membership');
    return response.body;
  }

  async onboardUser(user) {
    let membership = await this.getMembership(user.login);
    if (!membership) {
      const invitation = await this.appRequest(
        '/orgs/' + encodeURIComponent(this.config.githubOrg) + '/invitations',
        'POST',
        { invitee_id: user.numericId, role: 'direct_member' }
      );
      if (invitation.status === 422) {
        membership = await this.getMembership(user.login);
        if (!membership) {
          throw new util.AppError('GitHub could not send another organization invitation. The organization may have reached its 24-hour invitation limit; wait and try again or ask course staff.', 429, 'organization_invitation_limited');
        }
      } else {
        requireSuccess(invitation, 201, 'invite the user to the course organization');
        membership = {
          state: 'pending',
          role: 'member',
          user: { id: user.numericId, login: user.login }
        };
      }
    }
    return membership;
  }

  async sendInvitation(user) {
    const membership = await this.getMembership(user.login);
    if (membership) {
      return membership;
    }
    return this.onboardUser(user);
  }

  async validateTemplate(owner, repo) {
    const response = await this.appRequest(
      '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo),
      'GET'
    );
    requireSuccess(response, 200, 'read the template repository');
    if (!response.body.is_template) {
      throw new util.AppError(owner + '/' + repo + ' is not marked as a GitHub template repository', 400, 'not_a_template');
    }
    if (response.body.id === undefined || response.body.id === null) {
      throw new GitHubError('GitHub did not return an immutable ID for the template repository', 502, response.body);
    }
    return response.body;
  }

  async getRepository(repoName, priority) {
    const response = await this.appRequest(
      '/repos/' + encodeURIComponent(this.config.githubOrg) + '/' + encodeURIComponent(repoName),
      'GET',
      undefined,
      { priority: Boolean(priority) }
    );
    if (response.status === 404) {
      return null;
    }
    requireSuccess(response, 200, 'read an assignment repository');
    return response.body;
  }

  async generateRepository(assignment, repoName, marker) {
    const response = await this.appRequest(
      '/repos/' + encodeURIComponent(assignment.templateOwner) + '/' + encodeURIComponent(assignment.templateRepo) + '/generate',
      'POST',
      {
        owner: this.config.githubOrg,
        name: repoName,
        description: marker,
        include_all_branches: false,
        private: true
      }
    );
    requireSuccess(response, 201, 'create the private assignment repository');
    if (!response.body.private) {
      throw new GitHubError('GitHub returned a repository that is not private', 502, response.body);
    }
    return response.body;
  }

  async generateWriteupRepository(assignment, repoName, marker) {
    const response = await this.appRequest(
      '/repos/' + encodeURIComponent(assignment.writeupTemplateOwner) + '/' + encodeURIComponent(assignment.writeupTemplateRepo) + '/generate',
      'POST',
      {
        owner: this.config.githubOrg,
        name: repoName,
        description: marker,
        include_all_branches: false,
        private: false
      }
    );
    requireSuccess(response, 201, 'create the public write-up repository');
    if (response.body.private) {
      throw new GitHubError('GitHub returned a write-up repository that is not public', 502, response.body);
    }
    return response.body;
  }

  async ensurePages(repoName, branch) {
    const endpoint = '/repos/' + encodeURIComponent(this.config.githubOrg) + '/' + encodeURIComponent(repoName) + '/pages';
    let response = await this.appRequest(endpoint, 'GET');
    if (response.status === 404) {
      response = await this.appRequest(endpoint, 'POST', {
        source: {
          branch: branch || 'main',
          path: '/docs'
        }
      });
      requireSuccess(response, [201, 409], 'enable GitHub Pages for the write-up repository');
      if (response.status === 409) {
        response = await this.appRequest(endpoint, 'GET');
        requireSuccess(response, 200, 'read GitHub Pages configuration');
      }
    } else {
      requireSuccess(response, 200, 'read GitHub Pages configuration');
    }
    return {
      htmlUrl: response.body && response.body.html_url
        ? response.body.html_url
        : 'https://' + this.config.githubOrg.toLowerCase() + '.github.io/' + repoName + '/',
      source: response.body && response.body.source ? response.body.source : { branch: branch || 'main', path: '/docs' }
    };
  }

  async addCollaborator(repoName, login) {
    const response = await this.appRequest(
      '/repos/' + encodeURIComponent(this.config.githubOrg) + '/' + encodeURIComponent(repoName) + '/collaborators/' + encodeURIComponent(login),
      'PUT',
      { permission: 'push' }
    );
    requireSuccess(response, [201, 204], 'grant repository access');
    if (response.status === 201) {
      try {
        await this.removeCollaborator(repoName, login);
      } catch (error) {
        throw new util.AppError(
          'GitHub created an unexpected outside-collaborator invitation and Repo184 could not finish revoking it. Staff must retry access cleanup.',
          502,
          'outside_collaborator_cleanup_pending'
        );
      }
      throw new util.AppError('GitHub tried to create an outside-collaborator invitation. The user must be an active organization member before access can be granted.', 409, 'membership_inactive');
    }
    return 'ready';
  }

  async removeCollaborator(repoName, login) {
    const response = await this.appRequest(
      '/repos/' + encodeURIComponent(this.config.githubOrg) + '/' + encodeURIComponent(repoName) + '/collaborators/' + encodeURIComponent(login),
      'DELETE',
      undefined,
      { priority: true }
    );
    requireSuccess(response, 204, 'remove repository access');
  }
}

class FakeGitHubClient {
  constructor(config) {
    this.config = config;
    this.memberships = {};
    this.repositories = {};
    this.usersByLogin = {};
    this.usersByNumericId = {};
    this.nextUserId = 1000;
    this.templates = {};
    this.nextTemplateId = 5000;
  }

  authorizationUrl() {
    return this.config.basePath + '/auth/dev';
  }

  async getFakeUser(login) {
    const clean = String(login || '').trim();
    const key = clean.toLowerCase();
    if (this.usersByLogin[key]) {
      return Object.assign({}, this.usersByLogin[key]);
    }
    this.nextUserId += 1;
    const user = {
      id: 'fake-' + this.nextUserId,
      numericId: this.nextUserId,
      login: clean,
      avatarUrl: '',
      profileUrl: 'https://github.com/' + clean
    };
    this.usersByLogin[key] = user;
    this.usersByNumericId[String(user.numericId)] = user;
    return Object.assign({}, user);
  }

  async getUserById(accountId) {
    const user = this.usersByNumericId[String(accountId)];
    if (!user) {
      throw new GitHubError('Fake GitHub user not found', 404);
    }
    return Object.assign({}, user);
  }

  renameFakeUser(accountId, nextLogin) {
    const user = this.usersByNumericId[String(accountId)];
    if (!user) {
      throw new Error('Fake GitHub user not found');
    }
    const previousKey = user.login.toLowerCase();
    const nextKey = String(nextLogin).toLowerCase();
    if (this.usersByLogin[nextKey]) {
      throw new Error('Fake GitHub username already exists');
    }
    const membership = this.memberships[previousKey];
    delete this.usersByLogin[previousKey];
    delete this.memberships[previousKey];
    user.login = String(nextLogin);
    user.profileUrl = 'https://github.com/' + user.login;
    this.usersByLogin[nextKey] = user;
    if (membership) {
      this.memberships[nextKey] = membership;
    }
    Object.keys(this.repositories).forEach(function migrateCollaborator(repoName) {
      const repository = this.repositories[repoName];
      if (repository.collaborators && repository.collaborators[previousKey]) {
        delete repository.collaborators[previousKey];
        repository.collaborators[nextKey] = true;
      }
    }, this);
    return Object.assign({}, user);
  }

  async onboardUser(user) {
    this.memberships[user.login.toLowerCase()] = {
      state: 'active',
      role: 'member',
      numericId: user.numericId
    };
    return { state: 'active', role: 'member', user: { id: user.numericId, login: user.login } };
  }

  async sendInvitation(user) {
    const key = user.login.toLowerCase();
    const existing = this.memberships[key];
    if (existing) {
      return { state: existing.state, role: existing.role, user: { id: existing.numericId, login: user.login } };
    }
    this.memberships[key] = {
      state: 'pending',
      role: 'member',
      numericId: user.numericId
    };
    return { state: 'pending', role: 'member', user: { id: user.numericId, login: user.login } };
  }

  async getMembership(login) {
    const membership = this.memberships[String(login).toLowerCase()];
    return membership ? {
      state: membership.state,
      role: membership.role,
      user: { id: membership.numericId, login: login }
    } : null;
  }

  async validateTemplate(owner, repo) {
    const key = String(owner + '/' + repo).toLowerCase();
    if (!this.templates[key]) {
      this.nextTemplateId += 1;
      this.templates[key] = {
        id: this.nextTemplateId,
        full_name: owner + '/' + repo,
        is_template: true,
        private: true,
        default_branch: 'main'
      };
    }
    return Object.assign({}, this.templates[key]);
  }

  replaceFakeTemplate(owner, repo) {
    const key = String(owner + '/' + repo).toLowerCase();
    this.nextTemplateId += 1;
    this.templates[key] = {
      id: this.nextTemplateId,
      full_name: owner + '/' + repo,
      is_template: true,
      private: true,
      default_branch: 'main'
    };
    return Object.assign({}, this.templates[key]);
  }

  async getRepository(repoName) {
    return this.repositories[repoName] || null;
  }

  async generateRepository(assignment, repoName, marker) {
    if (this.repositories[repoName]) {
      throw new GitHubError('Repository already exists', 422);
    }
    const templateKey = String(assignment.templateOwner + '/' + assignment.templateRepo).toLowerCase();
    const template = this.templates[templateKey];
    const repository = {
      id: Object.keys(this.repositories).length + 1,
      name: repoName,
      full_name: this.config.githubOrg + '/' + repoName,
      private: true,
      description: marker,
      default_branch: 'main',
      html_url: 'https://github.com/' + this.config.githubOrg + '/' + repoName,
      clone_url: 'https://github.com/' + this.config.githubOrg + '/' + repoName + '.git',
      ssh_url: 'git@github.com:' + this.config.githubOrg + '/' + repoName + '.git'
    };
    if (template) {
      repository.template_repository = { id: template.id, full_name: template.full_name };
    }
    this.repositories[repoName] = repository;
    return repository;
  }

  async generateWriteupRepository(assignment, repoName, marker) {
    if (this.repositories[repoName]) {
      throw new GitHubError('Repository already exists', 422);
    }
    const templateKey = String(assignment.writeupTemplateOwner + '/' + assignment.writeupTemplateRepo).toLowerCase();
    const template = this.templates[templateKey];
    const repository = {
      id: Object.keys(this.repositories).length + 1,
      name: repoName,
      full_name: this.config.githubOrg + '/' + repoName,
      private: false,
      description: marker,
      default_branch: 'main',
      html_url: 'https://github.com/' + this.config.githubOrg + '/' + repoName,
      clone_url: 'https://github.com/' + this.config.githubOrg + '/' + repoName + '.git',
      ssh_url: 'git@github.com:' + this.config.githubOrg + '/' + repoName + '.git'
    };
    if (template) {
      repository.template_repository = { id: template.id, full_name: template.full_name };
    }
    this.repositories[repoName] = repository;
    return repository;
  }

  async ensurePages(repoName, branch) {
    const repository = this.repositories[repoName];
    if (!repository) {
      throw new GitHubError('Fake repository not found', 404);
    }
    repository.pages = {
      htmlUrl: 'https://' + this.config.githubOrg.toLowerCase() + '.github.io/' + repoName + '/',
      source: { branch: branch || 'main', path: '/docs' }
    };
    return Object.assign({}, repository.pages);
  }

  async addCollaborator(repoName, login) {
    const repository = this.repositories[repoName];
    if (!repository) {
      throw new GitHubError('Fake repository not found', 404);
    }
    repository.collaborators = repository.collaborators || {};
    repository.collaborators[String(login).toLowerCase()] = true;
    return 'ready';
  }

  async removeCollaborator(repoName, login) {
    const repository = this.repositories[repoName];
    if (!repository) {
      throw new GitHubError('Fake repository not found', 404);
    }
    repository.collaborators = repository.collaborators || {};
    delete repository.collaborators[String(login).toLowerCase()];
  }
}

function createGitHubClient(config) {
  if (config.nodeEnv === 'development' && config.devFakeGithub) {
    return new FakeGitHubClient(config);
  }
  return new GitHubClient(config);
}

module.exports = {
  FakeGitHubClient: FakeGitHubClient,
  GitHubClient: GitHubClient,
  GitHubError: GitHubError,
  createGitHubClient: createGitHubClient,
  requestJson: requestJson
};
