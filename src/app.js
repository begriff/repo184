'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const sessions = require('client-sessions');
const configModule = require('./config');
const githubModule = require('./github');
const serviceModule = require('./service');
const storeModule = require('./store');
const util = require('./util');
const views = require('./views');

function randomToken() {
  return util.base64Url(crypto.randomBytes(32));
}

function asyncRoute(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function setFlash(req, type, message) {
  req.repo184Session.flash = { type: type, message: message };
}

function consumeFlash(req) {
  if (!req.repo184Session) {
    return null;
  }
  const flash = req.repo184Session.flash || null;
  delete req.repo184Session.flash;
  return flash;
}

function rotateSession(req, values) {
  req.repo184Session.reset();
  Object.keys(values || {}).forEach(function setValue(key) {
    if (values[key] !== undefined && values[key] !== null) {
      req.repo184Session[key] = values[key];
    }
  });
  req.repo184Session.csrf = randomToken();
}

function createAttemptLimiter() {
  const attempts = Object.create(null);
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 5;
  const maxGlobalAttempts = 100;
  const maxInFlight = 2;
  const maxRecords = 10000;
  let inFlight = 0;
  let recordCount = 0;
  let lastSweep = 0;
  let globalWindow = { attempts: 0, startedAt: Date.now() };
  function sweepExpired(now) {
    Object.keys(attempts).forEach(function removeExpired(key) {
      if (attempts[key].startedAt < now - windowMs) {
        delete attempts[key];
        recordCount -= 1;
      }
    });
    lastSweep = now;
  }
  return {
    reserve: function reserve(key) {
      const now = Date.now();
      if (inFlight >= maxInFlight) {
        return null;
      }
      if (globalWindow.startedAt < now - windowMs) {
        globalWindow = { attempts: 0, startedAt: now };
      }
      if (globalWindow.attempts >= maxGlobalAttempts) {
        return null;
      }
      if (lastSweep < now - 60000 || recordCount >= maxRecords) {
        sweepExpired(now);
      }
      let record = attempts[key];
      if (record && record.startedAt < now - windowMs) {
        delete attempts[key];
        recordCount -= 1;
        record = null;
      }
      if (!record) {
        if (recordCount >= maxRecords) {
          return null;
        }
        record = { attempts: 0, startedAt: now };
        attempts[key] = record;
        recordCount += 1;
      }
      if (record.attempts >= maxAttempts) {
        return null;
      }
      record.attempts += 1;
      globalWindow.attempts += 1;
      inFlight += 1;
      let finished = false;
      return {
        finish: function finish(success) {
          if (finished) {
            return;
          }
          finished = true;
          inFlight -= 1;
          if (success && attempts[key] === record) {
            delete attempts[key];
            recordCount -= 1;
          }
        }
      };
    }
  };
}

function createGithubActionLimiter(globalLimit) {
  const records = Object.create(null);
  const windowMs = 15 * 60 * 1000;
  const maxGlobalActions = globalLimit || 2000;
  const maxRecords = 10000;
  let globalWindow = { actions: 0, startedAt: Date.now() };
  let recordCount = 0;
  let lastSweep = 0;

  function sweepExpired(now) {
    Object.keys(records).forEach(function removeExpired(key) {
      if (records[key].startedAt < now - windowMs) {
        delete records[key];
        recordCount -= 1;
      }
    });
    lastSweep = now;
  }

  return {
    take: function take(entries) {
      const now = Date.now();
      if (globalWindow.startedAt < now - windowMs) {
        globalWindow = { actions: 0, startedAt: now };
      }
      if (globalWindow.actions >= maxGlobalActions) {
        return false;
      }
      if (lastSweep < now - 60000 || recordCount >= maxRecords) {
        sweepExpired(now);
      }
      const unique = {};
      const requested = (entries || []).filter(function valid(entry) {
        if (!entry || !entry.key || unique[entry.key]) {
          return false;
        }
        unique[entry.key] = true;
        return true;
      });
      let newRecords = 0;
      for (let index = 0; index < requested.length; index += 1) {
        const entry = requested[index];
        let record = records[entry.key];
        if (record && record.startedAt < now - windowMs) {
          delete records[entry.key];
          recordCount -= 1;
          record = null;
        }
        if (!record) {
          newRecords += 1;
        } else if (record.actions >= entry.limit) {
          return false;
        }
      }
      if (recordCount + newRecords > maxRecords) {
        return false;
      }
      requested.forEach(function consume(entry) {
        if (!records[entry.key]) {
          records[entry.key] = { actions: 0, startedAt: now };
          recordCount += 1;
        }
        records[entry.key].actions += 1;
      });
      globalWindow.actions += 1;
      return true;
    }
  };
}

function createRouter(overrides) {
  const input = overrides || {};
  const config = input.config || configModule.loadConfig(input);
  configModule.validateBaseConfig(config);
  const store = input.store || new storeModule.JsonStore(config.dataFile);
  const github = input.github || githubModule.createGitHubClient(config);
  const service = input.service || new serviceModule.Repo184Service({
    store: store,
    github: github,
    config: config
  });
  const adminLimiter = createAttemptLimiter();
  const studentActionLimiter = createGithubActionLimiter(2000);
  const adminActionLimiter = createGithubActionLimiter(200);
  const oauthActionLimiter = createGithubActionLimiter(500);
  const router = express.Router();

  router.use('/assets', express.static(path.join(__dirname, '..', 'public'), {
    fallthrough: true,
    maxAge: 0
  }));
  router.get('/health', asyncRoute(async function health(req, res) {
    await store.init();
    const status = store.healthStatus();
    res.setHeader('Cache-Control', 'no-store');
    res.status(status.ok ? 200 : 503).json({ ok: status.ok, service: 'repo184' });
  }));
  router.use(express.urlencoded({ extended: false, limit: '32kb' }));
  router.use(express.json({ limit: '32kb' }));
  router.use(function proxySecurity(req, res, next) {
    if (config.nodeEnv === 'production' && req.headers['x-forwarded-proto'] === 'https') {
      req.connection.proxySecure = true;
    }
    next();
  });
  router.use(sessions({
    cookieName: 'repo184Session',
    requestKey: 'repo184Session',
    secret: config.sessionSecret,
    duration: 12 * 60 * 60 * 1000,
    activeDuration: 30 * 60 * 1000,
    cookie: {
      path: config.basePath,
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production'
    }
  }));
  router.use(function privateResponses(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(function sessionDefaults(req, res, next) {
    if (!req.repo184Session.csrf) {
      req.repo184Session.csrf = randomToken();
    }
    next();
  });
  router.use(asyncRoute(async function initialize(req, res, next) {
    await store.init();
    next();
  }));
  router.use(asyncRoute(async function currentUser(req, res, next) {
    req.currentUser = req.repo184Session.userId
      ? await service.getUser(req.repo184Session.userId)
      : null;
    if (req.repo184Session.userId && !req.currentUser) {
      delete req.repo184Session.userId;
    }
    next();
  }));

  function pageOptions(req) {
    const session = req.repo184Session || {};
    return {
      basePath: config.basePath,
      baseUrl: config.baseUrl,
      githubOrg: config.githubOrg,
      courseHomeworkUrl: config.courseHomeworkUrl,
      csrf: session.csrf,
      user: req.currentUser,
      admin: Boolean(session.admin),
      flash: consumeFlash(req)
    };
  }

  function requireCsrf(req, res, next) {
    if (!util.constantTimeEqual(req.body && req.body.csrf, req.repo184Session.csrf)) {
      return next(new util.AppError('This form expired. Return to the page and try again.', 403, 'csrf_failed'));
    }
    next();
  }

  function requireUser(req, res, next) {
    if (!req.currentUser) {
      setFlash(req, 'error', 'Sign in with GitHub to continue.');
      return res.redirect(config.basePath + '/');
    }
    next();
  }

  function accessReady(workUnit, userId) {
    const member = workUnit && workUnit.members.find(function matchingMember(item) {
      return item.userId === userId;
    });
    return Boolean(workUnit && workUnit.repoStatus === 'ready' && !workUnit.repoError && member && member.accessStatus === 'ready');
  }

  function allAccessReady(workUnit) {
    return Boolean(workUnit && workUnit.repoStatus === 'ready' && !workUnit.repoError && workUnit.members.every(function ready(member) {
      return member.accessStatus === 'ready';
    }));
  }

  function requireAdmin(req, res, next) {
    if (!req.repo184Session.admin) {
      setFlash(req, 'error', 'Staff sign-in is required.');
      return res.redirect(config.basePath + '/admin');
    }
    next();
  }

  function githubActionKeys(req, userId, admin) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    return [
      { key: (admin ? 'admin-ip:' : 'ip:') + ip, limit: admin ? 200 : 1000 },
      { key: (admin ? 'admin:' : 'user:') + String(userId || 'anonymous'), limit: admin ? 100 : 20 }
    ];
  }

  function requireGithubActionAllowance(req, res, next) {
    const isAdmin = Boolean(req.repo184Session.admin);
    const userId = req.currentUser ? req.currentUser.id : 'anonymous';
    const limiter = isAdmin ? adminActionLimiter : studentActionLimiter;
    if (!limiter.take(githubActionKeys(req, userId, isAdmin))) {
      return next(new util.AppError('Too many GitHub actions were requested. Wait 15 minutes and try again.', 429, 'github_action_rate_limited'));
    }
    next();
  }

  async function validAdminPassword(password) {
    if (config.adminPasswordHash) {
      return util.verifyPassword(password, config.adminPasswordHash);
    }
    return config.nodeEnv !== 'production' && Boolean(config.adminPassword) &&
      util.constantTimeEqual(password, config.adminPassword);
  }

  router.get('/', asyncRoute(async function home(req, res) {
    if (!req.currentUser) {
      return res.send(views.loginPage(Object.assign(pageOptions(req), {
        devFakeGithub: config.nodeEnv === 'development' && config.devFakeGithub
      })));
    }
    const dashboard = await service.getDashboard(req.currentUser.id);
    return res.send(views.dashboardPage(Object.assign(pageOptions(req), {
      dashboard: dashboard
    })));
  }));

  router.get('/auth/github', function githubLogin(req, res, next) {
    try {
      if (config.nodeEnv === 'development' && config.devFakeGithub) {
        return res.redirect(config.basePath + '/auth/dev');
      }
      const ip = req.ip || req.connection.remoteAddress || 'unknown';
      if (!oauthActionLimiter.take([
        { key: 'oauth-ip:' + ip, limit: 200 },
        { key: 'oauth-session:' + req.repo184Session.csrf, limit: 2 }
      ])) {
        throw new util.AppError('Too many GitHub sign-ins were requested. Wait 15 minutes and try again.', 429, 'github_action_rate_limited');
      }
      const state = randomToken();
      const verifier = randomToken();
      const challenge = util.base64Url(crypto.createHash('sha256').update(verifier).digest());
      req.repo184Session.oauth = {
        state: state,
        verifier: verifier,
        createdAt: Date.now()
      };
      return res.redirect(github.authorizationUrl(state, challenge));
    } catch (error) {
      return next(error);
    }
  });

  router.get('/auth/github/callback', asyncRoute(async function githubCallback(req, res) {
    const oauth = req.repo184Session.oauth;
    delete req.repo184Session.oauth;
    if (req.query.error) {
      throw new util.AppError('GitHub sign-in was cancelled or denied.', 400, 'oauth_denied');
    }
    if (!oauth || oauth.createdAt < Date.now() - (10 * 60 * 1000) ||
        !util.constantTimeEqual(req.query.state, oauth.state) || !req.query.code) {
      throw new util.AppError('GitHub sign-in expired or could not be verified. Please try again.', 400, 'oauth_state_invalid');
    }
    const userToken = await github.exchangeCode(String(req.query.code), oauth.verifier);
    const profile = await github.getAuthenticatedUser(userToken);
    if (!studentActionLimiter.take(githubActionKeys(req, profile.id, false))) {
      throw new util.AppError('Too many GitHub sign-ins were requested for this account. Wait 15 minutes and try again.', 429, 'github_action_rate_limited');
    }
    const membership = await github.onboardUser(profile, userToken);
    const user = await service.rememberUser(profile, membership);
    const preserveAdmin = Boolean(req.repo184Session.admin);
    rotateSession(req, { userId: user.id, admin: preserveAdmin || undefined });
    setFlash(req, user.membershipState === 'active' ? 'success' : 'info',
      user.membershipState === 'active'
        ? 'GitHub connected and course organization access is active.'
        : 'GitHub connected. Organization membership is still pending; reconnect if it does not activate shortly.');
    return res.redirect(config.basePath + '/');
  }));

  router.get('/auth/dev', asyncRoute(async function devLogin(req, res) {
    if (config.nodeEnv !== 'development' || !config.devFakeGithub || typeof github.getFakeUser !== 'function') {
      return res.status(404).end();
    }
    const login = String(req.query.user || 'student-one').trim();
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) {
      throw new util.AppError('Invalid test username.', 400, 'invalid_username');
    }
    const profile = await github.getFakeUser(login);
    const membership = await github.onboardUser(profile);
    const user = await service.rememberUser(profile, membership);
    const preserveAdmin = Boolean(req.repo184Session.admin);
    rotateSession(req, { userId: user.id, admin: preserveAdmin || undefined });
    return res.redirect(config.basePath + '/');
  }));

  router.post('/logout', requireCsrf, function logout(req, res) {
    const preserveAdmin = Boolean(req.repo184Session.admin);
    rotateSession(req, { admin: preserveAdmin || undefined });
    return res.redirect(config.basePath + '/');
  });

  router.post('/org/retry', requireCsrf, requireUser, requireGithubActionAllowance, asyncRoute(async function retryMembership(req, res) {
    const user = await service.refreshMembership(req.currentUser.id);
    setFlash(req, user.membershipState === 'active' ? 'success' : 'info',
      user.membershipState === 'active'
        ? 'Organization access is active.'
        : 'Membership is still ' + user.membershipState + '. Reconnect GitHub to accept a pending invitation.');
    return res.redirect(config.basePath + '/');
  }));

  router.get('/assignments/:slug', requireUser, asyncRoute(async function assignment(req, res) {
    const model = await service.getAssignmentView(req.params.slug, req.currentUser.id);
    return res.send(views.assignmentPage(Object.assign(pageOptions(req), model)));
  }));

  router.post('/assignments/:slug/teams', requireCsrf, requireUser, requireGithubActionAllowance, asyncRoute(async function createTeam(req, res) {
    const workUnit = await service.createWorkUnit(req.params.slug, req.currentUser.id, req.body.teamName);
    setFlash(req, accessReady(workUnit, req.currentUser.id) ? 'success' : (workUnit.repoStatus === 'ready' ? 'info' : 'error'),
      accessReady(workUnit, req.currentUser.id)
        ? 'Your team and private repository are ready.'
        : (workUnit.repoStatus === 'ready'
          ? 'Your team repository was created, but GitHub access is still pending or needs a retry.'
          : 'Your team was saved, but GitHub setup needs a retry.'));
    return res.redirect(config.basePath + '/assignments/' + encodeURIComponent(req.params.slug) + '/teams/' + encodeURIComponent(workUnit.id));
  }));

  router.get('/assignments/:slug/teams/:workUnitId', requireUser, asyncRoute(async function team(req, res) {
    const model = await service.getTeamView(req.params.slug, req.params.workUnitId, req.currentUser.id);
    return res.send(views.teamPage(Object.assign(pageOptions(req), model)));
  }));

  router.post('/assignments/:slug/teams/:workUnitId/request', requireCsrf, requireUser, requireGithubActionAllowance, asyncRoute(async function requestJoin(req, res) {
    await service.requestToJoin(req.params.slug, req.params.workUnitId, req.currentUser.id);
    setFlash(req, 'success', 'Join request sent. A current team member must approve it.');
    return res.redirect(config.basePath + '/assignments/' + encodeURIComponent(req.params.slug) + '/teams/' + encodeURIComponent(req.params.workUnitId));
  }));

  router.post('/join-requests/:requestId/cancel', requireCsrf, requireUser, asyncRoute(async function cancelRequest(req, res) {
    await service.cancelJoinRequest(req.params.requestId, req.currentUser.id);
    setFlash(req, 'success', 'Join request cancelled.');
    return res.redirect(config.basePath + '/');
  }));

  router.post('/join-requests/:requestId/approve', requireCsrf, requireUser, requireGithubActionAllowance, asyncRoute(async function approveRequest(req, res) {
    const result = await service.resolveJoinRequest(req.params.requestId, req.currentUser.id, 'approve', false);
    setFlash(req, allAccessReady(result) ? 'success' : 'info', allAccessReady(result)
      ? 'Team request approved and repository access synchronized.'
      : 'Team request approved. GitHub access is pending or needs a retry.');
    return res.redirect(config.basePath + '/');
  }));

  router.post('/join-requests/:requestId/reject', requireCsrf, requireUser, requireGithubActionAllowance, asyncRoute(async function rejectRequest(req, res) {
    await service.resolveJoinRequest(req.params.requestId, req.currentUser.id, 'reject', false);
    setFlash(req, 'success', 'Team request rejected.');
    return res.redirect(config.basePath + '/');
  }));

  router.post('/work-units/:workUnitId/retry', requireCsrf, requireUser, requireGithubActionAllowance, asyncRoute(async function retryWorkUnit(req, res) {
    const workUnit = await service.getWorkUnit(req.params.workUnitId);
    if (!workUnit || !workUnit.members.some(function member(item) { return item.userId === req.currentUser.id; })) {
      throw new util.AppError('Repository not found.', 404, 'work_unit_not_found');
    }
    const result = await service.provisionWorkUnit(workUnit.id);
    setFlash(req, accessReady(result, req.currentUser.id) ? 'success' : 'error',
      accessReady(result, req.currentUser.id) ? 'GitHub synchronization completed.' : 'GitHub synchronization still needs staff attention.');
    return res.redirect(config.basePath + '/');
  }));

  router.get('/admin', asyncRoute(async function admin(req, res) {
    if (!req.repo184Session.admin) {
      return res.send(views.adminLoginPage(pageOptions(req)));
    }
    const adminView = await service.getAdminView();
    return res.send(views.adminPage(Object.assign(pageOptions(req), { adminView: adminView, admin: true })));
  }));

  router.post('/admin/login', requireCsrf, asyncRoute(async function adminLogin(req, res) {
    const key = req.ip || req.connection.remoteAddress || 'unknown';
    const attempt = adminLimiter.reserve(key);
    if (!attempt) {
      throw new util.AppError('Too many failed attempts. Try again in 15 minutes.', 429, 'admin_rate_limited');
    }
    let valid = false;
    try {
      valid = await validAdminPassword(req.body.password);
    } finally {
      attempt.finish(valid);
    }
    if (!valid) {
      setFlash(req, 'error', 'Incorrect admin password.');
      return res.redirect(config.basePath + '/admin');
    }
    const preserveUserId = req.currentUser ? req.currentUser.id : undefined;
    rotateSession(req, { userId: preserveUserId, admin: true });
    setFlash(req, 'success', 'Staff access enabled.');
    return res.redirect(config.basePath + '/admin');
  }));

  router.post('/admin/logout', requireCsrf, function adminLogout(req, res) {
    const preserveUserId = req.currentUser ? req.currentUser.id : undefined;
    rotateSession(req, { userId: preserveUserId });
    return res.redirect(config.basePath + '/admin');
  });

  router.post('/admin/assignments', requireCsrf, requireAdmin, requireGithubActionAllowance, asyncRoute(async function addAssignment(req, res) {
    await service.createAssignment(req.body, 'admin');
    setFlash(req, 'success', 'Assignment added.');
    return res.redirect(config.basePath + '/admin');
  }));

  router.post('/admin/assignments/:assignmentId', requireCsrf, requireAdmin, requireGithubActionAllowance, asyncRoute(async function editAssignment(req, res) {
    await service.updateAssignment(req.params.assignmentId, req.body, 'admin');
    setFlash(req, 'success', 'Assignment updated.');
    return res.redirect(config.basePath + '/admin');
  }));

  router.post('/admin/work-units/:workUnitId/retry', requireCsrf, requireAdmin, requireGithubActionAllowance, asyncRoute(async function adminRetry(req, res) {
    const result = await service.provisionWorkUnit(req.params.workUnitId);
    setFlash(req, allAccessReady(result) ? 'success' : 'error',
      allAccessReady(result) ? 'Repository synchronization completed.' : 'Repository or member access synchronization still has an error.');
    return res.redirect(config.basePath + '/admin');
  }));

  router.post('/admin/work-units/:workUnitId/members/:userId/retry', requireCsrf, requireAdmin, requireGithubActionAllowance, asyncRoute(async function adminRetryMember(req, res) {
    await service.syncMemberAccess(req.params.workUnitId, req.params.userId);
    setFlash(req, 'success', 'Member access synchronization attempted.');
    return res.redirect(config.basePath + '/admin');
  }));

  router.post('/admin/work-units/:workUnitId/members/:userId/remove', requireCsrf, requireAdmin, requireGithubActionAllowance, asyncRoute(async function adminRemoveMember(req, res) {
    const result = await service.removeTeamMember(req.params.workUnitId, req.params.userId, 'admin');
    setFlash(req, result.repoError ? 'error' : 'success', result.repoError
      ? 'Team member access was revoked, but the repository needs immediate GitHub attention: ' + result.repoError
      : 'Team member removed and repository access revoked. They may now create or join another repository for this assignment.');
    return res.redirect(config.basePath + '/admin');
  }));

  router.post('/admin/work-units/:workUnitId/release', requireCsrf, requireAdmin, requireGithubActionAllowance, asyncRoute(async function adminReleaseWorkUnit(req, res) {
    if (req.body.confirm !== 'release') {
      throw new util.AppError('Confirm the assignment-claim release before continuing.', 400, 'release_not_confirmed');
    }
    const result = await service.releaseWorkUnit(req.params.workUnitId, 'admin');
    setFlash(req, result.repoError ? 'error' : 'success', result.repoError
      ? 'Assignment claim released and direct access revoked, but the repository needs immediate GitHub attention: ' + result.repoError
      : 'Assignment claim released. The private repository was preserved, its direct student access was revoked, and the students may choose again.');
    return res.redirect(config.basePath + '/admin');
  }));

  router.post('/admin/work-units/:workUnitId/rename', requireCsrf, requireAdmin, asyncRoute(async function adminRename(req, res) {
    await service.renameTeam(req.params.workUnitId, req.body.teamName, 'admin');
    setFlash(req, 'success', 'Team display name updated. The repository name was left unchanged.');
    return res.redirect(config.basePath + '/admin');
  }));

  router.post('/admin/join-requests/:requestId/approve', requireCsrf, requireAdmin, requireGithubActionAllowance, asyncRoute(async function adminApprove(req, res) {
    await service.resolveJoinRequest(req.params.requestId, 'admin', 'approve', true);
    setFlash(req, 'success', 'Join request approved.');
    return res.redirect(config.basePath + '/admin');
  }));

  router.post('/admin/join-requests/:requestId/reject', requireCsrf, requireAdmin, asyncRoute(async function adminReject(req, res) {
    await service.resolveJoinRequest(req.params.requestId, 'admin', 'reject', true);
    setFlash(req, 'success', 'Join request rejected.');
    return res.redirect(config.basePath + '/admin');
  }));

  router.use(function notFound(req, res) {
    return res.status(404).send(views.errorPage(Object.assign(pageOptions(req), {
      status: 404,
      message: 'That Repo184 page does not exist.'
    })));
  });

  router.use(function errorHandler(error, req, res, next) {
    if (res.headersSent) {
      return next(error);
    }
    const status = error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    if (status >= 500) {
      console.error(error);
    }
    const message = status >= 500 && config.nodeEnv === 'production'
      ? 'Repo184 could not complete that request. Staff can inspect the service logs and retry.'
      : error.message;
    let returnPath = config.basePath + '/';
    let returnLabel = 'Return to assignments';
    if (req.originalUrl.indexOf(config.basePath + '/admin') === 0) {
      returnPath = config.basePath + '/admin';
      returnLabel = 'Return to staff console';
    } else {
      const assignmentMatch = req.originalUrl.match(/\/assignments\/([^/?]+)/);
      if (assignmentMatch) {
        try {
          const assignmentSlug = decodeURIComponent(assignmentMatch[1]);
          if (/^[a-z0-9-]{1,32}$/.test(assignmentSlug)) {
            returnPath = config.basePath + '/assignments/' + assignmentSlug;
            returnLabel = 'Return to assignment';
          }
        } catch (decodeError) {}
      }
    }
    return res.status(status).send(views.errorPage(Object.assign(pageOptions(req), {
      status: status,
      message: message,
      returnPath: returnPath,
      returnLabel: returnLabel
    })));
  });

  router.repo184 = { config: config, store: store, github: github, service: service };
  return router;
}

module.exports = createRouter;
module.exports.createAttemptLimiter = createAttemptLimiter;
module.exports.createGithubActionLimiter = createGithubActionLimiter;
