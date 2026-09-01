'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const createRouter = require('../src/app');
const configModule = require('../src/config');
const githubModule = require('../src/github');
const serviceModule = require('../src/service');
const singleInstance = require('../src/single-instance');
const storeModule = require('../src/store');
const util = require('../src/util');
const views = require('../src/views');

function removeDirectory(directory) {
  if (!fs.existsSync(directory)) {
    return;
  }
  fs.readdirSync(directory).forEach(function remove(name) {
    const fullPath = path.join(directory, name);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      removeDirectory(fullPath);
    } else {
      fs.unlinkSync(fullPath);
    }
  });
  fs.rmdirSync(directory);
}

async function expectError(operation, code) {
  let error = null;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }
  assert(error, 'Expected operation to fail with ' + code);
  assert.strictEqual(error.code, code);
}

async function addUser(service, github, login, membershipState) {
  const profile = await github.getFakeUser(login);
  let membership;
  if (membershipState === 'active') {
    membership = await github.onboardUser(profile);
  } else {
    membership = { state: membershipState, role: 'member' };
  }
  return service.rememberUser(profile, membership);
}

function encodeForm(values) {
  return Object.keys(values).map(function pair(key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(values[key]);
  }).join('&');
}

function httpRequest(server, cookieJar, requestPath, options) {
  const settings = options || {};
  const body = settings.body || '';
  const headers = Object.assign({}, settings.headers || {});
  if (cookieJar.cookie) {
    headers.Cookie = cookieJar.cookie;
  }
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  return new Promise(function execute(resolve, reject) {
    const request = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: requestPath,
      method: settings.method || 'GET',
      headers: headers
    }, function response(incoming) {
      const chunks = [];
      incoming.on('data', function data(chunk) { chunks.push(chunk); });
      incoming.on('end', function end() {
        const setCookie = incoming.headers['set-cookie'];
        if (setCookie && setCookie.length) {
          cookieJar.cookie = setCookie[0].split(';')[0];
          cookieJar.lastSetCookie = setCookie[0];
        }
        resolve({
          status: incoming.statusCode,
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function csrfFrom(html) {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  assert(match, 'Expected a CSRF token in rendered HTML');
  return match[1];
}

async function serviceTests(testDirectory) {
  const config = configModule.loadConfig({
    nodeEnv: 'development',
    basePath: '/repo',
    baseUrl: 'http://127.0.0.1:3000/repo',
    sessionSecret: 'test-session-secret-with-more-than-24-characters',
    adminPassword: 'local-admin',
    dataFile: path.join(testDirectory, 'service.json'),
    devFakeGithub: true
  });
  const store = new storeModule.JsonStore(config.dataFile);
  const github = new githubModule.FakeGitHubClient(config);
  const service = new serviceModule.Repo184Service({ store: store, github: github, config: config });
  await store.init();

  const alice = await addUser(service, github, 'alice-184', 'active');
  const bob = await addUser(service, github, 'bob-184', 'active');
  const carol = await addUser(service, github, 'carol-184', 'active');
  const dave = await addUser(service, github, 'dave-184', 'pending');

  const assignment = await service.createAssignment({
    slug: 'hw1',
    title: 'Homework 1',
    template: 'cal-cs184-student/hw1-template',
    generateWriteupRepo: '1',
    writeupTemplate: 'cal-cs184-student/hw1-writeup-template',
    repoPrefix: 'hw1',
    maxTeamSize: '2',
    status: 'open'
  }, 'admin');
  assert.strictEqual(assignment.maxTeamSize, 2);
  assert.strictEqual(assignment.generateWriteupRepo, true);
  assert.notStrictEqual(assignment.writeupTemplateRepoId, null);

  await expectError(service.createAssignment({
    slug: 'reserved-prefix',
    title: 'Reserved prefix',
    template: 'cal-cs184-student/reserved-template',
    repoPrefix: 'hw-writeup',
    maxTeamSize: '1',
    status: 'closed'
  }, 'admin'), 'reserved_repository_prefix');
  await expectError(service.createAssignment({
    slug: 'missing-writeup-template',
    title: 'Missing write-up template',
    template: 'cal-cs184-student/missing-template',
    generateWriteupRepo: '1',
    repoPrefix: 'missing',
    maxTeamSize: '1',
    status: 'closed'
  }, 'admin'), 'invalid_template');
  await expectError(service.createAssignment({
    slug: 'shared-template',
    title: 'Unsafe shared template',
    template: 'cal-cs184-student/shared-template',
    generateWriteupRepo: '1',
    writeupTemplate: 'CAL-CS184-STUDENT/shared-template',
    repoPrefix: 'shared',
    maxTeamSize: '1',
    status: 'closed'
  }, 'admin'), 'writeup_template_must_be_separate');

  const team = await service.createWorkUnit('hw1', alice.id, 'Ray Tracers');
  assert.strictEqual(team.repoStatus, 'ready');
  assert.strictEqual(team.members.length, 1);
  assert.strictEqual(team.members[0].accessStatus, 'ready');
  assert.strictEqual(github.repositories[team.repoName].private, true);
  assert.strictEqual(team.repoName, 'hw1-ray-tracers');
  assert.strictEqual(team.writeupRepoStatus, 'ready');
  assert.strictEqual(team.writeupRepoName, 'hw1-ray-tracers-writeup');
  assert.strictEqual(github.repositories[team.writeupRepoName].private, false);
  assert.strictEqual(team.writeupPagesStatus, 'ready');
  assert.strictEqual(team.writeupPagesUrl, 'https://cal-cs184-student.github.io/hw1-ray-tracers-writeup/');
  assert.strictEqual(Boolean(github.repositories[team.writeupRepoName].collaborators['alice-184']), true);

  let uncertainGrantCleanupCount = 0;
  const initialRemoveCollaborator = github.removeCollaborator.bind(github);
  github.removeCollaborator = async function countUncertainCleanup(repoName, login) {
    uncertainGrantCleanupCount += 1;
    return initialRemoveCollaborator(repoName, login);
  };
  await store.transaction(function markUncertainGrant(state) {
    const unit = state.workUnits.find(function match(item) { return item.id === team.id; });
    unit.members[0].accessStatus = 'granting';
  });
  await service.syncMemberAccess(team.id, alice.id);
  assert.strictEqual(uncertainGrantCleanupCount, 2,
    'retrying an uncertain grant must revoke code and write-up access before re-granting');
  assert.strictEqual((await service.getWorkUnit(team.id)).members[0].accessStatus, 'ready');
  github.removeCollaborator = initialRemoveCollaborator;

  github.renameFakeUser(alice.numericId, 'alice-renamed');
  const replacementAlice = await github.getFakeUser('alice-184');
  await github.onboardUser(replacementAlice);
  await service.syncMemberAccess(team.id, alice.id);
  const renamedAlice = await service.getUser(alice.id);
  assert.strictEqual(renamedAlice.login, 'alice-renamed', 'current login must be resolved from the immutable account ID');
  assert.strictEqual(Boolean(github.repositories[team.repoName].collaborators['alice-renamed']), true);
  assert.strictEqual(Boolean(github.repositories[team.writeupRepoName].collaborators['alice-renamed']), true);
  assert.strictEqual(Boolean(github.repositories[team.repoName].collaborators['alice-184']), false,
    'access must not be granted to a replacement account that claimed an old username');
  const correctAliceMembership = github.memberships['alice-renamed'];
  github.memberships['alice-renamed'] = Object.assign({}, correctAliceMembership, { numericId: replacementAlice.numericId });
  await expectError(service.refreshMembership(alice.id), 'github_identity_mismatch');
  github.memberships['alice-renamed'] = correctAliceMembership;
  await service.refreshMembership(alice.id);

  const sameTeam = await service.createWorkUnit('hw1', alice.id, 'Ray Tracers');
  assert.strictEqual(sameTeam.id, team.id, 'repeat creation must be idempotent');
  await expectError(service.renameTeam(team.id, 'Writeup Makers', 'admin'), 'reserved_team_name');
  const renamedTeam = await service.renameTeam(team.id, 'Ray Makers', 'admin');
  assert.strictEqual(renamedTeam.teamSlug, 'ray-makers', 'team-name uniqueness must follow staff renames');

  const bobRequest = await service.requestToJoin('hw1', team.id, bob.id);
  await expectError(service.resolveJoinRequest(bobRequest.id, carol.id, 'approve', false), 'not_team_member');
  const paired = await service.resolveJoinRequest(bobRequest.id, alice.id, 'approve', false);
  assert.strictEqual(paired.members.length, 2);
  assert.strictEqual(paired.members[1].accessStatus, 'ready');
  assert.strictEqual(Boolean(github.repositories[team.writeupRepoName].collaborators['bob-184']), true);
  await expectError(service.requestToJoin('hw1', team.id, carol.id), 'team_full');

  await expectError(service.createWorkUnit('hw1', carol.id, 'Writeup Crew'), 'reserved_team_name');
  const carolTeam = await service.createWorkUnit('hw1', carol.id, 'Carol Solo');
  assert.strictEqual(carolTeam.kind, 'team');
  assert.strictEqual(carolTeam.members.length, 1);
  assert.strictEqual(carolTeam.repoStatus, 'ready');
  const carolRepository = github.repositories[carolTeam.repoName];
  const carolRepositoryId = carolRepository.id;
  carolRepository.id = carolRepositoryId + 1000;
  await expectError(service.releaseWorkUnit(carolTeam.id, 'admin'), 'release_failed');
  const pendingCarolRelease = await service.getWorkUnit(carolTeam.id);
  assert.strictEqual(pendingCarolRelease.lifecycle, 'release_pending');
  assert.strictEqual(Boolean(carolRepository.collaborators['carol-184']), true,
    'an ID mismatch must not revoke access on a replacement repository');
  carolRepository.id = carolRepositoryId;
  carolRepository.private = false;
  const releasedCarol = await service.releaseWorkUnit(carolTeam.id, 'admin');
  assert.strictEqual(releasedCarol.lifecycle, 'released');
  assert.strictEqual(Boolean(carolRepository.collaborators['carol-184']), false);
  assert.strictEqual(Boolean(github.repositories[carolTeam.writeupRepoName].collaborators['carol-184']), false);
  assert.strictEqual(releasedCarol.repoStatus, 'error');
  assert(releasedCarol.repoError.indexOf('public') !== -1,
    'release must keep public-visibility drift prominently flagged after revocation');
  carolRepository.private = true;
  github.renameFakeUser(bob.numericId, 'bob-renamed');
  const replacementBob = await github.getFakeUser('bob-184');
  await github.onboardUser(replacementBob);
  github.repositories[team.repoName].private = false;
  const reducedTeam = await service.removeTeamMember(team.id, bob.id, 'admin');
  assert.strictEqual(reducedTeam.members.length, 1);
  assert.strictEqual(reducedTeam.repoStatus, 'error');
  assert(reducedTeam.repoError.indexOf('public') !== -1,
    'member removal must keep public-visibility drift prominently flagged after revocation');
  assert.strictEqual(Boolean(github.repositories[team.repoName].collaborators['bob-renamed']), false,
    'member removal must revoke the current account after a username change');
  assert.strictEqual(Boolean(github.repositories[team.repoName].collaborators['bob-184']), false,
    'member removal must not target the replacement owner of an old username');
  assert.strictEqual(Boolean(github.repositories[team.writeupRepoName].collaborators['bob-renamed']), false,
    'member removal must also revoke write-up repository access');
  github.repositories[team.repoName].private = true;
  const repairedTeam = await service.provisionWorkUnit(team.id);
  assert.strictEqual(repairedTeam.repoStatus, 'ready');
  assert.strictEqual(repairedTeam.repoError, '');
  const requestCountBeforeReuse = reducedTeam.requests.length;
  const reusedBobRequest = await service.requestToJoin('hw1', team.id, bob.id);
  assert.strictEqual(reusedBobRequest.id, bobRequest.id, 'resolved request records should be reused instead of growing without bound');
  await service.cancelJoinRequest(reusedBobRequest.id, bob.id);
  const teamAfterRequestReuse = await service.getWorkUnit(team.id);
  assert.strictEqual(teamAfterRequestReuse.requests.length, requestCountBeforeReuse);
  await expectError(service.removeTeamMember(team.id, alice.id, 'admin'), 'last_member');
  const bobSoloTeam = await service.createWorkUnit('hw1', bob.id, 'Bob Solo');
  assert.strictEqual(bobSoloTeam.kind, 'team');
  assert.strictEqual(bobSoloTeam.members.length, 1);
  const released = await service.releaseWorkUnit(bobSoloTeam.id, 'admin');
  assert.strictEqual(released.lifecycle, 'released');
  assert.strictEqual(Boolean(github.repositories[bobSoloTeam.writeupRepoName].collaborators['bob-renamed']), false);
  await expectError(service.createWorkUnit('hw1', bob.id, 'Bob Solo'), 'repository_name_taken');
  const bobReplacement = await service.createWorkUnit('hw1', bob.id, 'Bob Replacement');
  assert.notStrictEqual(bobReplacement.id, bobSoloTeam.id);
  assert.notStrictEqual(bobReplacement.repoName, bobSoloTeam.repoName);
  assert.strictEqual(github.repositories[bobSoloTeam.repoName].private, true, 'released repositories are preserved');
  const replacementRepository = github.repositories[bobReplacement.repoName];
  const replacementRepositoryId = replacementRepository.id;
  delete github.repositories[bobReplacement.repoName];
  const missingRepositoryRetry = await service.provisionWorkUnit(bobReplacement.id);
  assert.strictEqual(missingRepositoryRetry.repoStatus, 'error');
  assert(missingRepositoryRetry.repoError.indexOf('no longer exists') !== -1);
  assert.strictEqual(github.repositories[bobReplacement.repoName], undefined,
    'a missing established repository must never be silently recreated');
  github.repositories[bobReplacement.repoName] = replacementRepository;
  replacementRepository.id = replacementRepositoryId + 1000;
  const identityMismatchRetry = await service.provisionWorkUnit(bobReplacement.id);
  assert.strictEqual(identityMismatchRetry.repoStatus, 'error');
  assert(identityMismatchRetry.repoError.indexOf('different GitHub repository') !== -1,
    'a known repository name must not be adopted when its immutable ID changes');
  replacementRepository.id = replacementRepositoryId;
  const identityRestored = await service.provisionWorkUnit(bobReplacement.id);
  assert.strictEqual(identityRestored.repoError, '');
  const originalGetRepository = github.getRepository.bind(github);
  github.getRepository = async function transientFailure() {
    throw new Error('temporary GitHub lookup failure');
  };
  const retryAfterFailure = await service.provisionWorkUnit(bobReplacement.id);
  assert.strictEqual(retryAfterFailure.repoStatus, 'ready', 'a transient retry must not erase known repository identity');
  assert(retryAfterFailure.repoError.indexOf('temporary GitHub lookup failure') !== -1);
  const bobDashboardWithError = await service.getDashboard(bob.id);
  const bobDashboardHtml = views.dashboardPage({
    basePath: '/repo',
    baseUrl: 'http://127.0.0.1/repo',
    githubOrg: config.githubOrg,
    courseHomeworkUrl: '/fa26/hw/',
    csrf: 'test-csrf',
    user: bobDashboardWithError.user,
    dashboard: bobDashboardWithError
  });
  assert(bobDashboardHtml.indexOf('verification error') !== -1);
  assert.strictEqual(bobDashboardHtml.indexOf(assignment.templateFullName), -1,
    'student assignment cards must not expose the code template repository');
  assert.strictEqual(bobDashboardHtml.indexOf(assignment.writeupTemplateFullName), -1,
    'student assignment cards must not expose the write-up template repository');
  assert(bobDashboardHtml.indexOf('Team size: up to 2 students') !== -1);
  assert.strictEqual(bobDashboardHtml.indexOf(bobReplacement.repoHtmlUrl), -1,
    'a repository with a verification error must not be presented as ready to open');
  const pendingDashboard = util.clone(bobDashboardWithError);
  pendingDashboard.user.membershipState = 'pending';
  const pendingDashboardHtml = views.dashboardPage({
    basePath: '/repo',
    baseUrl: 'http://127.0.0.1/repo',
    githubOrg: config.githubOrg,
    courseHomeworkUrl: '/fa26/hw/',
    csrf: 'test-csrf',
    user: pendingDashboard.user,
    dashboard: pendingDashboard
  });
  assert(pendingDashboardHtml.indexOf('Accept invitation on GitHub') !== -1);
  assert(pendingDashboardHtml.indexOf('https://github.com/orgs/cal-cs184-student/invitation') !== -1);
  assert.strictEqual(pendingDashboardHtml.indexOf('/org/invite'), -1,
    'a pending invitation must be accepted rather than cancelled and recreated');
  const absentDashboard = util.clone(pendingDashboard);
  absentDashboard.user.membershipState = 'absent';
  const absentDashboardHtml = views.dashboardPage({
    basePath: '/repo',
    baseUrl: 'http://127.0.0.1/repo',
    githubOrg: config.githubOrg,
    courseHomeworkUrl: '/fa26/hw/',
    csrf: 'test-csrf',
    user: absentDashboard.user,
    dashboard: absentDashboard
  });
  assert(absentDashboardHtml.indexOf('/org/invite') !== -1);
  assert(absentDashboardHtml.indexOf('Send a new invitation') !== -1);
  github.getRepository = originalGetRepository;
  await store.transaction(function simulateLegacyErrorState(state) {
    const unit = state.workUnits.find(function match(item) { return item.id === bobReplacement.id; });
    unit.repoStatus = 'error';
  });
  const releasedReplacement = await service.releaseWorkUnit(bobReplacement.id, 'admin');
  assert.strictEqual(releasedReplacement.lifecycle, 'released');
  assert.strictEqual(Boolean(github.repositories[bobReplacement.repoName].collaborators['bob-renamed']), false,
    'release must revoke access whenever a repository ID is known, even if status is error');
  await expectError(service.createWorkUnit('hw1', dave.id, 'Dave Solo'), 'membership_inactive');

  await expectError(service.updateAssignment(assignment.id, {
    slug: 'hw1',
    title: 'Homework 1',
    template: 'cal-cs184-student/hw1-template',
    generateWriteupRepo: '1',
    writeupTemplate: 'cal-cs184-student/hw1-writeup-template',
    repoPrefix: 'hw1',
    maxTeamSize: '1',
    status: 'open'
  }, 'admin'), 'assignment_locked');

  await service.createAssignment({
    slug: 'hw2',
    title: 'Homework 2',
    template: 'cal-cs184-student/hw2-template',
    repoPrefix: 'hw2',
    maxTeamSize: '2',
    status: 'open'
  }, 'admin');
  const secondTeam = await service.createWorkUnit('hw2', alice.id, 'Normals');
  const requestBob = await service.requestToJoin('hw2', secondTeam.id, bob.id);
  const requestCarol = await service.requestToJoin('hw2', secondTeam.id, carol.id);
  const approvals = await Promise.all([
    service.resolveJoinRequest(requestBob.id, alice.id, 'approve', false).then(function success(value) {
      return { ok: true, value: value };
    }, function failure(error) {
      return { ok: false, error: error };
    }),
    service.resolveJoinRequest(requestCarol.id, alice.id, 'approve', false).then(function success(value) {
      return { ok: true, value: value };
    }, function failure(error) {
      return { ok: false, error: error };
    })
  ]);
  assert.strictEqual(approvals.filter(function success(item) { return item.ok; }).length, 1,
    'only one concurrent approval may take the final team place');
  const finalTeam = await service.getWorkUnit(secondTeam.id);
  assert.strictEqual(finalTeam.members.length, 2);
  const losingUser = finalTeam.members.some(function member(item) { return item.userId === bob.id; }) ? carol : bob;
  const losingDashboard = await service.getDashboard(losingUser.id);
  const hw2Dashboard = losingDashboard.assignments.find(function row(item) { return item.assignment.slug === 'hw2'; });
  assert(hw2Dashboard.resolvedRequest, 'the student whose request lost the final-place race should see the outcome');
  assert.strictEqual(hw2Dashboard.resolvedRequest.status, 'rejected');

  const originalRemoveCollaborator = github.removeCollaborator.bind(github);
  let releaseRemovalCount = 0;
  github.removeCollaborator = async function failSecondRemoval(repoName, login) {
    releaseRemovalCount += 1;
    if (releaseRemovalCount === 2) {
      throw new Error('temporary collaborator removal failure');
    }
    return originalRemoveCollaborator(repoName, login);
  };
  await expectError(service.releaseWorkUnit(secondTeam.id, 'admin'), 'release_failed');
  const partiallyReleasedTeam = await service.getWorkUnit(secondTeam.id);
  const confirmedRevoked = partiallyReleasedTeam.members.find(function revoked(item) { return item.accessStatus === 'revoked'; });
  const failedRevocation = partiallyReleasedTeam.members.find(function failed(item) { return item.accessStatus === 'revocation_error'; });
  assert(confirmedRevoked && failedRevocation, 'partial revocation progress must be saved for retry');
  const confirmedRevokedUser = await service.getUser(confirmedRevoked.userId);
  github.removeCollaborator = originalRemoveCollaborator;
  const originalGetUserById = github.getUserById.bind(github);
  github.getUserById = async function rejectAlreadyRevokedLookup(accountId) {
    if (String(accountId) === String(confirmedRevokedUser.numericId)) {
      throw new githubModule.GitHubError('account no longer exists', 404);
    }
    return originalGetUserById(accountId);
  };
  const fullyReleasedTeam = await service.releaseWorkUnit(secondTeam.id, 'admin');
  assert.strictEqual(fullyReleasedTeam.lifecycle, 'released',
    'release retry must skip members whose revocation was already confirmed');
  github.getUserById = originalGetUserById;

  const gina = await addUser(service, github, 'gina-184', 'active');
  const metadataGenerateRepository = github.generateRepository.bind(github);
  const metadataGenerateWriteupRepository = github.generateWriteupRepository.bind(github);
  github.generateRepository = async function reportDifferentTemplate(assignmentValue, repoName, marker) {
    const repository = await metadataGenerateRepository(assignmentValue, repoName, marker);
    repository.template_repository = { id: assignmentValue.templateRepoId + 1000 };
    return repository;
  };
  github.generateWriteupRepository = async function omitTemplateMetadata(assignmentValue, repoName, marker) {
    const repository = await metadataGenerateWriteupRepository(assignmentValue, repoName, marker);
    delete repository.template_repository;
    return repository;
  };
  const metadataTeam = await service.createWorkUnit('hw1', gina.id, 'Metadata Test');
  assert.strictEqual(metadataTeam.repoStatus, 'ready',
    'unexpected response metadata must not override the verified template endpoint');
  assert.strictEqual(metadataTeam.writeupRepoStatus, 'ready');
  assert.strictEqual(metadataTeam.templateSourceRepoId, assignment.templateRepoId);
  assert.strictEqual(metadataTeam.templateReportedRepoId, assignment.templateRepoId + 1000);
  assert.strictEqual(metadataTeam.writeupTemplateSourceRepoId, assignment.writeupTemplateRepoId);
  assert.strictEqual(metadataTeam.writeupTemplateReportedRepoId, null);
  github.generateRepository = metadataGenerateRepository;
  github.generateWriteupRepository = metadataGenerateWriteupRepository;

  await store.transaction(function simulateOldFalseMismatch(state) {
    const unit = state.workUnits.find(function match(item) { return item.id === metadataTeam.id; });
    unit.templateProvenance = 'mismatch';
    unit.repoStatus = 'error';
    unit.repoError = 'GitHub reported that this repository was generated from a different template.';
    unit.writeupTemplateProvenance = 'mismatch';
    unit.writeupRepoStatus = 'error';
    unit.writeupRepoError = 'GitHub reported that this write-up repository was generated from a different template.';
  });
  const recoveredMetadataTeam = await service.provisionWorkUnit(metadataTeam.id);
  assert.strictEqual(recoveredMetadataTeam.templateProvenance, 'verified',
    'a repository ID recorded by the old response-metadata check must recover on retry');
  assert.strictEqual(recoveredMetadataTeam.writeupTemplateProvenance, 'verified');
  assert.strictEqual(recoveredMetadataTeam.repoError, '');
  assert.strictEqual(recoveredMetadataTeam.writeupRepoError, '');

  const erin = await addUser(service, github, 'erin-184', 'active');
  const templateKey = 'cal-cs184-student/hw1-template';
  const originalTemplate = Object.assign({}, github.templates[templateKey]);
  github.replaceFakeTemplate('cal-cs184-student', 'hw1-template');
  const templateBlocked = await service.createWorkUnit('hw1', erin.id, 'Erin Solo');
  assert.strictEqual(templateBlocked.repoStatus, 'error');
  assert(templateBlocked.repoError.indexOf('different GitHub repository') !== -1,
    'a template name reclaimed by a different repository must not be provisioned');
  assert.strictEqual(github.repositories[templateBlocked.repoName], undefined);
  github.templates[templateKey] = originalTemplate;

  const frank = await addUser(service, github, 'frank-184', 'active');
  const originalGenerateRepository = github.generateRepository.bind(github);
  github.generateRepository = async function swapTemplateDuringGeneration(assignmentValue, repoName, marker) {
    github.replaceFakeTemplate('cal-cs184-student', 'hw1-template');
    return originalGenerateRepository(assignmentValue, repoName, marker);
  };
  const provenanceBlocked = await service.createWorkUnit('hw1', frank.id, 'Frank Solo');
  assert.strictEqual(provenanceBlocked.repoStatus, 'error');
  assert.strictEqual(provenanceBlocked.templateProvenance, 'identity_mismatch');
  assert.notStrictEqual(provenanceBlocked.repoId, null,
    'an untrusted generated repository must retain its immutable ID for staff cleanup');
  assert.strictEqual(Boolean(github.repositories[provenanceBlocked.repoName].collaborators), false,
    'template provenance failure must happen before any student collaborator is granted');
  github.generateRepository = originalGenerateRepository;
  github.templates[templateKey] = originalTemplate;
  const provenanceRetry = await service.provisionWorkUnit(provenanceBlocked.id);
  assert.strictEqual(provenanceRetry.templateProvenance, 'identity_mismatch',
    'a terminal template provenance failure must not be adopted on retry');

  const staleTemporary = config.dataFile + '.999999.1.tmp';
  fs.writeFileSync(staleTemporary, 'stale');
  const reloaded = new storeModule.JsonStore(config.dataFile);
  const snapshot = await reloaded.snapshot();
  assert.strictEqual(fs.existsSync(staleTemporary), false, 'startup must remove stale atomic-write files');
  assert.strictEqual(snapshot.assignments.length, 2);
  assert.strictEqual(snapshot.workUnits.length, 8);

  const legacyState = util.clone(snapshot);
  legacyState.assignments.forEach(function removeWriteupAssignmentFields(item) {
    delete item.archived;
    delete item.generateWriteupRepo;
    delete item.writeupTemplateOwner;
    delete item.writeupTemplateRepo;
    delete item.writeupTemplateFullName;
    delete item.writeupTemplateRepoId;
  });
  legacyState.workUnits.forEach(function removeWriteupWorkUnitFields(item) {
    delete item.deletionError;
    delete item.codeDeletedAt;
    delete item.writeupDeletedAt;
    delete item.deletionClaimsAssignment;
    delete item.templateReportedRepoId;
    Object.keys(item).filter(function writeupField(key) {
      return key.indexOf('writeup') === 0;
    }).forEach(function remove(key) {
      delete item[key];
    });
  });
  const legacyUnit = legacyState.workUnits.find(function oneMember(item) { return item.members.length === 1; });
  const legacyUser = legacyState.users[legacyUnit.members[0].userId];
  legacyUnit.kind = 'individual';
  legacyUnit.displayName = '@' + legacyUser.login;
  legacyUnit.teamSlug = '';
  legacyUnit.joinCode = '';
  const migrationFile = path.join(testDirectory, 'legacy-individual.json');
  fs.writeFileSync(migrationFile, JSON.stringify(legacyState, null, 2) + '\n');
  const migratedStore = new storeModule.JsonStore(migrationFile);
  const migratedSnapshot = await migratedStore.snapshot();
  const migratedUnit = migratedSnapshot.workUnits.find(function sameUnit(item) { return item.id === legacyUnit.id; });
  assert.strictEqual(migratedUnit.kind, 'team', 'legacy individual repositories must become one-person teams');
  assert.strictEqual(migratedUnit.displayName, legacyUser.login);
  assert(migratedUnit.teamSlug);
  assert(migratedUnit.joinCode);
  assert.strictEqual(migratedSnapshot.assignments[0].generateWriteupRepo, false);
  assert.strictEqual(migratedSnapshot.assignments[0].archived, false);
  assert.strictEqual(migratedUnit.writeupRepoStatus, 'disabled');
  assert.strictEqual(migratedUnit.deletionError, '');
  assert.strictEqual(migratedUnit.deletionClaimsAssignment, false);
}

async function adminControlServiceTests(testDirectory) {
  const config = configModule.loadConfig({
    nodeEnv: 'development',
    basePath: '/repo',
    baseUrl: 'http://127.0.0.1:3000/repo',
    sessionSecret: 'admin-control-test-session-secret-123456',
    adminPassword: 'local-admin',
    dataFile: path.join(testDirectory, 'admin-controls.json'),
    devFakeGithub: true
  });
  const store = new storeModule.JsonStore(config.dataFile);
  const github = new githubModule.FakeGitHubClient(config);
  const service = new serviceModule.Repo184Service({ store: store, github: github, config: config });
  await store.init();
  const student = await addUser(service, github, 'admin-tools-student', 'active');
  const secondStudent = await addUser(service, github, 'admin-tools-second', 'active');
  const assignment = await service.createAssignment({
    slug: 'admin-hw',
    title: 'Admin Homework',
    template: 'cal-cs184-student/admin-hw-template',
    generateWriteupRepo: '1',
    writeupTemplate: 'cal-cs184-student/admin-hw-writeup-template',
    repoPrefix: 'admin-hw',
    maxTeamSize: '2',
    status: 'open'
  }, 'admin');
  const emptyAssignment = await service.createAssignment({
    slug: 'empty-hw',
    title: 'Empty Homework',
    template: 'cal-cs184-student/empty-hw-template',
    repoPrefix: 'empty-hw',
    maxTeamSize: '1',
    status: 'closed'
  }, 'admin');

  await service.setAssignmentArchived(assignment.id, true, 'admin');
  assert.strictEqual((await service.getDashboard(student.id)).assignments.length, 1,
    'archived assignments must be hidden from the student dashboard');
  await expectError(service.getAssignmentView('admin-hw', student.id), 'assignment_not_found');
  await expectError(service.createWorkUnit('admin-hw', student.id, 'Hidden Team'), 'assignment_not_found');
  await service.setAssignmentArchived(assignment.id, false, 'admin');
  assert((await service.getDashboard(student.id)).assignments.some(function visible(row) {
    return row.assignment.slug === 'admin-hw';
  }));

  await expectError(service.deleteEmptyAssignment(emptyAssignment.id, 'wrong', 'admin'), 'assignment_deletion_not_confirmed');
  await service.deleteEmptyAssignment(emptyAssignment.id, 'empty-hw', 'admin');
  assert.strictEqual((await service.getAdminView()).assignments.some(function present(item) {
    return item.id === emptyAssignment.id;
  }), false);

  const team = await service.createWorkUnit('admin-hw', student.id, 'Delete Test');
  await service.setAssignmentArchived(assignment.id, true, 'admin');
  assert.strictEqual(await service.getStudentWorkUnit(team.id, student.id), null);
  await service.setAssignmentArchived(assignment.id, false, 'admin');
  await expectError(service.deleteEmptyAssignment(assignment.id, 'admin-hw', 'admin'), 'assignment_not_empty');
  await store.transaction(function makeRetryable(state) {
    const unit = state.workUnits.find(function match(item) { return item.id === team.id; });
    unit.repoError = 'temporary setup failure';
  });
  const retryResult = await service.retryAssignmentWorkUnits(assignment.id, 'admin');
  assert.deepStrictEqual(retryResult, { attempted: 1, ready: 1, stillNeedsAttention: 0 });
  assert.strictEqual((await service.getWorkUnit(team.id)).repoError, '');

  await expectError(service.deleteWorkUnit(team.id, 'wrong-name', 'admin'), 'repository_deletion_not_confirmed');
  const writeupRepository = github.repositories[team.writeupRepoName];
  const writeupRepositoryId = writeupRepository.id;
  writeupRepository.id = writeupRepositoryId + 1000;
  await expectError(service.deleteWorkUnit(team.id, team.repoName, 'admin'), 'work_unit_deletion_failed');
  let deletionPending = await service.getWorkUnit(team.id);
  assert.strictEqual(deletionPending.lifecycle, 'deletion_pending');
  assert.strictEqual(Boolean(github.repositories[team.repoName]), true,
    'an identity mismatch must not delete the code repository');
  assert.strictEqual(Boolean(github.repositories[team.writeupRepoName]), true,
    'an identity mismatch must not delete the replacement write-up repository');
  writeupRepository.id = writeupRepositoryId;

  const originalDeleteRepository = github.deleteRepository.bind(github);
  github.deleteRepository = async function failCodeDeletion(repoName) {
    if (repoName === team.repoName) {
      throw new Error('temporary repository deletion failure');
    }
    return originalDeleteRepository(repoName);
  };
  await expectError(service.deleteWorkUnit(team.id, team.repoName, 'admin'), 'work_unit_deletion_failed');
  deletionPending = await service.getWorkUnit(team.id);
  assert(deletionPending.writeupDeletedAt, 'completed write-up deletion must be saved before a later failure');
  assert.strictEqual(deletionPending.codeDeletedAt, '');
  assert.strictEqual(github.repositories[team.writeupRepoName], undefined);
  assert.strictEqual(Boolean(github.repositories[team.repoName]), true);
  github.deleteRepository = originalDeleteRepository;

  const deleted = await service.deleteWorkUnit(team.id, team.repoName, 'admin');
  assert.strictEqual(deleted.repoName, team.repoName);
  assert.strictEqual(await service.getWorkUnit(team.id), null);
  assert.strictEqual(github.repositories[team.repoName], undefined);
  const deletionAudit = (await store.snapshot()).audit.find(function deletedEvent(item) {
    return item.action === 'work_unit.deleted' && item.details.workUnitId === team.id;
  });
  assert(deletionAudit);
  assert.strictEqual(deletionAudit.details.assignmentSlug, 'admin-hw');
  assert.deepStrictEqual(deletionAudit.details.memberLogins, ['admin-tools-student']);

  const reusedName = await service.createWorkUnit('admin-hw', student.id, 'Delete Test');
  assert.strictEqual(reusedName.repoName, team.repoName,
    'a fully deleted record and repository name must be reusable');

  const releasedTeam = await service.createWorkUnit('admin-hw', secondStudent.id, 'Released Delete');
  await service.releaseWorkUnit(releasedTeam.id, 'admin');
  const replacementTeam = await service.createWorkUnit('admin-hw', secondStudent.id, 'Replacement Active');
  assert.strictEqual(replacementTeam.lifecycle, 'active');
  await service.deleteWorkUnit(releasedTeam.id, releasedTeam.repoName, 'admin');
  assert.strictEqual((await service.getWorkUnit(replacementTeam.id)).lifecycle, 'active',
    'deleting a released record must not reclaim or disturb the student\'s current assignment');

  await store.transaction(function addPaginationFixtures(state) {
    for (let index = 0; index < 60; index += 1) {
      state.audit.push({
        id: 'audit-pagination-' + index,
        actor: 'fixture-actor',
        action: 'fixture.audit',
        details: { repoName: 'pagination-repo-' + index },
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
      });
    }
  });
  const firstAuditPage = await service.getAdminView({ query: 'fixture.audit', page: 1 });
  assert.strictEqual(firstAuditPage.audit.length, 25);
  assert.strictEqual(firstAuditPage.auditPagination.total, 60);
  assert.strictEqual(firstAuditPage.auditPagination.pageCount, 3);
  assert.strictEqual(firstAuditPage.audit[0].details.repoName, 'pagination-repo-59');
  const secondAuditPage = await service.getAdminView({ query: 'fixture.audit', page: 2 });
  assert.strictEqual(secondAuditPage.audit.length, 25);
  assert.strictEqual(secondAuditPage.auditPagination.from, 26);
  const clampedAuditPage = await service.getAdminView({ query: 'fixture.audit', page: 99 });
  assert.strictEqual(clampedAuditPage.auditPagination.page, 3);
  assert.strictEqual(clampedAuditPage.audit.length, 10);
  const searchedAudit = await service.getAdminView({ query: 'fixture.audit pagination-repo-37', page: 1 });
  assert.strictEqual(searchedAudit.auditPagination.total, 1,
    'audit search must require every search term across action and details');
  assert.strictEqual(searchedAudit.audit[0].details.repoName, 'pagination-repo-37');
}

function singleInstanceTests(testDirectory) {
  const dataFile = path.join(testDirectory, 'locked.json');
  const release = singleInstance.acquire(dataFile);
  assert.throws(function secondProcess() {
    singleInstance.acquire(dataFile);
  }, /already using/);
  release();
  const releaseAgain = singleInstance.acquire(dataFile);
  releaseAgain();

  fs.writeFileSync(dataFile + '.lock', JSON.stringify({ pid: 99999999 }) + '\n');
  const releaseStale = singleInstance.acquire(dataFile);
  releaseStale();
}

function attemptLimiterTests() {
  const limiter = createRouter.createAttemptLimiter();
  const reservations = [limiter.reserve('same-address'), limiter.reserve('same-address')];
  assert(reservations.every(Boolean), 'two password attempts may run concurrently');
  assert.strictEqual(limiter.reserve('another-address'), null,
    'the global in-flight cap must bound simultaneous password attempts');
  reservations.forEach(function finish(reservation) { reservation.finish(false); });
  for (let index = 0; index < 3; index += 1) {
    const attempt = limiter.reserve('same-address');
    assert(attempt);
    attempt.finish(false);
  }
  assert.strictEqual(limiter.reserve('same-address'), null,
    'failed attempts remain limited for the full window');
  const successful = limiter.reserve('fresh-address');
  assert(successful);
  successful.finish(true);
  const afterSuccess = limiter.reserve('fresh-address');
  assert(afterSuccess, 'a successful login clears that address record');
  afterSuccess.finish(false);

  const globalLimiter = createRouter.createAttemptLimiter();
  for (let index = 0; index < 100; index += 1) {
    const globalAttempt = globalLimiter.reserve('distributed-' + index);
    assert(globalAttempt);
    globalAttempt.finish(false);
  }
  assert.strictEqual(globalLimiter.reserve('distributed-over-budget'), null,
    'distributed sources must share a bounded time-window password-attempt budget');
}

function githubActionLimiterTests() {
  const limiter = createRouter.createGithubActionLimiter();
  for (let index = 0; index < 20; index += 1) {
    assert.strictEqual(limiter.take([
      { key: 'user:student', limit: 20 },
      { key: 'ip:shared', limit: 100 }
    ]), true);
  }
  assert.strictEqual(limiter.take([
    { key: 'user:student', limit: 20 },
    { key: 'ip:shared', limit: 100 }
  ]), false, 'one signed-in account must not consume GitHub actions indefinitely');

  const globalLimiter = createRouter.createGithubActionLimiter();
  for (let index = 0; index < 2000; index += 1) {
    assert.strictEqual(globalLimiter.take([{ key: 'distributed:' + index, limit: 1 }]), true);
  }
  assert.strictEqual(globalLimiter.take([{ key: 'distributed:over-budget', limit: 1 }]), false,
    'distributed accounts must share a bounded GitHub-action window');

  const isolatedSmallLimiter = createRouter.createGithubActionLimiter(3);
  for (let index = 0; index < 3; index += 1) {
    assert.strictEqual(isolatedSmallLimiter.take([{ key: 'small:' + index, limit: 1 }]), true);
  }
  assert.strictEqual(isolatedSmallLimiter.take([{ key: 'small:over-budget', limit: 1 }]), false,
    'separate student, OAuth, and admin limiter instances must honor independent global caps');
}

async function githubTransportTests() {
  const server = http.createServer(function partialResponse(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"partial":');
    setImmediate(function abortResponse() { res.destroy(); });
  });
  await new Promise(function listen(resolve) { server.listen(0, '127.0.0.1', resolve); });
  try {
    let rejected = false;
    try {
      await githubModule.requestJson({
        hostname: '127.0.0.1',
        port: server.address().port,
        path: '/',
        transport: http,
        timeout: 2000
      });
    } catch (error) {
      rejected = true;
    }
    assert.strictEqual(rejected, true, 'an aborted GitHub response must reject instead of hanging');
  } finally {
    await new Promise(function close(resolve) { server.close(resolve); });
  }

  const client = new githubModule.GitHubClient({
    githubAppId: '1',
    githubClientId: 'client',
    githubClientSecret: 'secret',
    githubInstallationId: '2',
    githubPrivateKey: 'test-key'
  });
  let fetchCount = 0;
  let finishFetch;
  client.fetchInstallationToken = function delayedToken() {
    fetchCount += 1;
    return new Promise(function wait(resolve) { finishFetch = resolve; });
  };
  const tokenRequests = [client.installationToken(), client.installationToken(), client.installationToken()];
  assert.strictEqual(fetchCount, 1, 'simultaneous token requests must share one refresh');
  finishFetch({ token: 'shared-token', expiresAt: Date.now() + (10 * 60 * 1000) });
  assert.deepStrictEqual(await Promise.all(tokenRequests), ['shared-token', 'shared-token', 'shared-token']);

  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const scheduled = [];
  for (let index = 0; index < 30; index += 1) {
    scheduled.push(client.withApiRequestSlot(function boundedRequest() {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      return new Promise(function finishOnNextTurn(resolve) {
        setImmediate(function finish() {
          activeRequests -= 1;
          resolve();
        });
      });
    }));
  }
  await Promise.all(scheduled);
  assert(maximumActiveRequests <= 8, 'GitHub API requests must use a bounded concurrency queue');

  const priorityClient = new githubModule.GitHubClient({});
  priorityClient.activeApiRequests = 8;
  const dispatchOrder = [];
  const normalQueued = priorityClient.withApiRequestSlot(function normalOperation() {
    dispatchOrder.push('normal');
  });
  const priorityQueued = priorityClient.withApiRequestSlot(function priorityOperation() {
    dispatchOrder.push('priority');
  }, { priority: true });
  priorityClient.activeApiRequests = 7;
  priorityClient.dispatchApiQueue();
  await Promise.all([normalQueued, priorityQueued]);
  assert.deepStrictEqual(dispatchOrder, ['priority', 'normal'],
    'revocation prerequisites must dispatch before ordinary queued GitHub requests');

  const minuteBudgetClient = new githubModule.GitHubClient({});
  const budgetTime = Date.now();
  for (let index = 0; index < 50; index += 1) {
    assert.strictEqual(minuteBudgetClient.takeWriteRequestBudget(budgetTime), true);
  }
  assert.strictEqual(minuteBudgetClient.takeWriteRequestBudget(budgetTime), false,
    'ordinary GitHub writes must leave a per-minute reserve for revocations');
  for (let index = 0; index < 10; index += 1) {
    assert.strictEqual(minuteBudgetClient.takeWriteRequestBudget(budgetTime, true), true);
  }
  assert.strictEqual(minuteBudgetClient.takeWriteRequestBudget(budgetTime, true), false,
    'revocations must still stay below the overall per-minute safety budget');

  const hourBudgetClient = new githubModule.GitHubClient({});
  hourBudgetClient.writeRequestTimes = Array(320).fill(budgetTime - (2 * 60 * 1000));
  assert.strictEqual(hourBudgetClient.takeWriteRequestBudget(budgetTime), false,
    'ordinary GitHub writes must leave an hourly reserve for revocations');
  assert.strictEqual(hourBudgetClient.takeWriteRequestBudget(budgetTime, true), true,
    'a collaborator revocation must remain available after ordinary writes exhaust their pool');
  hourBudgetClient.writeRequestTimes = Array(400).fill(budgetTime - (2 * 60 * 1000));
  assert.strictEqual(hourBudgetClient.takeWriteRequestBudget(budgetTime, true), false,
    'revocations must still stay below the overall hourly safety budget');

  const cooldownClient = new githubModule.GitHubClient({});
  await expectError(cooldownClient.withApiRequestSlot(function limitedResponse() {
    return Promise.resolve({
      status: 429,
      headers: { 'retry-after': '60' },
      body: { message: 'You have exceeded a secondary rate limit.' }
    });
  }), 'github_rate_limited');
  let requestRanDuringCooldown = false;
  await expectError(cooldownClient.withApiRequestSlot(function shouldNotRun() {
    requestRanDuringCooldown = true;
  }), 'github_rate_limited');
  assert.strictEqual(requestRanDuringCooldown, false,
    'new GitHub requests must fail fast while GitHub has asked the service to pause');

  const queuedCooldownClient = new githubModule.GitHubClient({});
  queuedCooldownClient.activeApiRequests = 8;
  const queuedRequest = queuedCooldownClient.withApiRequestSlot(function queuedOperation() {
    throw new Error('A queued operation must not start during a rate-limit cooldown');
  });
  queuedCooldownClient.noteRateLimit({
    status: 403,
    headers: {},
    body: { message: 'You have exceeded a secondary rate limit.' }
  });
  await expectError(queuedRequest, 'github_rate_limited');

  const invitationClient = new githubModule.GitHubClient({ githubOrg: 'cal-cs184-student' });
  invitationClient.appRequest = async function invitationLimitResponse(requestPath) {
    if (requestPath.indexOf('/memberships/') !== -1) {
      return { status: 404, body: { message: 'Not Found' } };
    }
    return { status: 422, body: { message: 'Validation Failed' } };
  };
  await expectError(invitationClient.onboardUser({ login: 'limited-user', numericId: 42 }),
    'organization_invitation_limited');

  const inviteOnlyClient = new githubModule.GitHubClient({ githubOrg: 'cal-cs184-student' });
  const inviteOnlyCalls = [];
  inviteOnlyClient.appRequest = async function inviteOnlyRequest(requestPath, method) {
    inviteOnlyCalls.push({ path: requestPath, method: method });
    if (method === 'GET') {
      return { status: 404, body: { message: 'Not Found' } };
    }
    return { status: 201, body: { id: 123 } };
  };
  const pendingMembership = await inviteOnlyClient.onboardUser(
    { login: 'invite-only-user', numericId: 43 },
    'a-user-token-that-must-not-be-used'
  );
  assert.strictEqual(pendingMembership.state, 'pending');
  assert.deepStrictEqual(inviteOnlyCalls.map(function method(call) { return call.method; }), ['GET', 'POST'],
    'onboarding must invite with the installation token and never accept membership as the student');

  const sendClient = new githubModule.GitHubClient({ githubOrg: 'cal-cs184-student' });
  const sendCalls = [];
  sendClient.appRequest = async function sendRequest(requestPath, method) {
    sendCalls.push({ path: requestPath, method: method });
    if (method === 'GET') {
      return { status: 404, body: { message: 'Not Found' } };
    }
    return { status: 201, body: { id: 124 } };
  };
  const sentMembership = await sendClient.sendInvitation({ login: 'send-user', numericId: 44 });
  assert.strictEqual(sentMembership.state, 'pending');
  assert.deepStrictEqual(sendCalls.map(function method(call) { return call.method; }), ['GET', 'GET', 'POST']);

  const pagesClient = new githubModule.GitHubClient({ githubOrg: 'cal-cs184-student' });
  const pagesCalls = [];
  pagesClient.appRequest = async function pagesRequest(requestPath, method, body) {
    pagesCalls.push({ path: requestPath, method: method, body: body });
    if (method === 'GET') {
      return { status: 404, body: { message: 'Not Found' } };
    }
    return { status: 201, body: { html_url: 'https://cal-cs184-student.github.io/hw1-team-writeup/' } };
  };
  const pages = await pagesClient.ensurePages('hw1-team-writeup', 'main');
  assert.strictEqual(pages.htmlUrl, 'https://cal-cs184-student.github.io/hw1-team-writeup/');
  assert.deepStrictEqual(pagesCalls.map(function method(call) { return call.method; }), ['GET', 'POST']);
  assert.deepStrictEqual(pagesCalls[1].body, { source: { branch: 'main', path: '/' } });

  const delayedPagesClient = new githubModule.GitHubClient({ githubOrg: 'cal-cs184-student' });
  delayedPagesClient.pagesBranchRetryDelays = [0, 0];
  const delayedPagesCalls = [];
  let branchReads = 0;
  let pagesWrites = 0;
  delayedPagesClient.appRequest = async function delayedPagesRequest(requestPath, method, body) {
    delayedPagesCalls.push({ path: requestPath, method: method, body: body });
    if (requestPath.indexOf('/branches/main') !== -1) {
      branchReads += 1;
      return branchReads === 1
        ? { status: 404, body: { message: 'Not Found' } }
        : { status: 200, body: { name: 'main' } };
    }
    if (method === 'GET') {
      return { status: 404, body: { message: 'Not Found' } };
    }
    pagesWrites += 1;
    return pagesWrites === 1
      ? { status: 422, body: { message: 'The main branch must exist before GitHub Pages can be built.' } }
      : { status: 201, body: { html_url: 'https://cal-cs184-student.github.io/delayed-writeup/' } };
  };
  const delayedPages = await delayedPagesClient.ensurePages('delayed-writeup', 'main');
  assert.strictEqual(delayedPages.htmlUrl, 'https://cal-cs184-student.github.io/delayed-writeup/');
  assert.deepStrictEqual(delayedPagesCalls.map(function method(call) { return call.method; }),
    ['GET', 'POST', 'GET', 'GET', 'POST']);
  assert.strictEqual(delayedPagesCalls[2].path,
    '/repos/cal-cs184-student/delayed-writeup/branches/main');
  assert.deepStrictEqual(delayedPagesCalls[4].body, { source: { branch: 'main', path: '/' } });

  const deletionClient = new githubModule.GitHubClient({ githubOrg: 'cal-cs184-student' });
  const deletionCalls = [];
  deletionClient.appRequest = async function deletionRequest(requestPath, method, body, options) {
    deletionCalls.push({ path: requestPath, method: method, body: body, options: options });
    return { status: 204, body: null };
  };
  await deletionClient.deleteRepository('hw1-team');
  assert.strictEqual(deletionCalls[0].path, '/repos/cal-cs184-student/hw1-team');
  assert.strictEqual(deletionCalls[0].method, 'DELETE');
  assert.strictEqual(deletionCalls[0].options.priority, true);
}

async function httpTests(testDirectory) {
  const config = configModule.loadConfig({
    nodeEnv: 'development',
    basePath: '/repo',
    baseUrl: 'http://127.0.0.1/repo',
    sessionSecret: 'http-test-session-secret-with-more-than-24-characters',
    adminPassword: 'local-admin',
    dataFile: path.join(testDirectory, 'http.json'),
    devFakeGithub: true
  });
  const store = new storeModule.JsonStore(config.dataFile);
  const github = new githubModule.FakeGitHubClient(config);
  const service = new serviceModule.Repo184Service({ store: store, github: github, config: config });
  await store.init();
  const httpAssignment = await service.createAssignment({
    slug: 'hw0',
    title: 'Homework 0',
    template: 'cal-cs184-student/hw0-template',
    repoPrefix: 'hw0',
    maxTeamSize: '1',
    status: 'open'
  }, 'admin');

  const app = express();
  app.set('trust proxy', 1);
  app.use('/repo', createRouter({ config: config, store: store, github: github, service: service }));
  const server = await new Promise(function listen(resolve) {
    const started = app.listen(0, '127.0.0.1', function ready() { resolve(started); });
  });
  const jar = {};
  try {
    let response = await httpRequest(server, jar, '/repo/');
    assert.strictEqual(response.status, 200);
    assert(response.body.indexOf('Sign in with GitHub') !== -1);

    response = await httpRequest(server, jar, '/repo/auth/dev?user=http-student');
    assert.strictEqual(response.status, 302);
    assert(jar.lastSetCookie.toLowerCase().indexOf('httponly') !== -1);
    assert(jar.lastSetCookie.toLowerCase().indexOf('samesite=lax') !== -1);

    response = await httpRequest(server, jar, '/repo/');
    assert.strictEqual(response.status, 200);
    assert(response.body.indexOf('Homework 0') !== -1);
    assert.strictEqual(response.body.indexOf('href="/repo/admin"'), -1);

    response = await httpRequest(server, jar, '/repo/assignments/hw0');
    assert.strictEqual(response.status, 200);
    assert(response.body.indexOf('Create a team') !== -1);
    assert.strictEqual(response.body.indexOf('Work individually'), -1);
    assert.strictEqual(response.body.indexOf('/individual'), -1);
    assert.strictEqual(response.body.indexOf('name="confirm"'), -1);
    assert.strictEqual(response.body.indexOf('Your team starts with you'), -1);
    assert.strictEqual(response.body.indexOf('Open a team and send a request'), -1);
    assert.strictEqual(response.body.indexOf('Repository template:'), -1);
    const csrf = csrfFrom(response.body);

    response = await httpRequest(server, jar, '/repo/assignments/hw0/teams', {
      method: 'POST',
      body: encodeForm({ csrf: 'wrong-token', teamName: 'HTTP Solo' })
    });
    assert.strictEqual(response.status, 403);

    response = await httpRequest(server, jar, '/repo/assignments/hw0/teams', {
      method: 'POST',
      body: encodeForm({ csrf: csrf, teamName: 'HTTP Solo' })
    });
    assert.strictEqual(response.status, 302);

    response = await httpRequest(server, jar, '/repo/');
    assert(response.body.indexOf('Open code repository') !== -1);

    response = await httpRequest(server, jar, '/repo/admin');
    assert.strictEqual(response.status, 200);
    const adminCsrf = csrfFrom(response.body);
    response = await httpRequest(server, jar, '/repo/admin/login', {
      method: 'POST',
      body: encodeForm({ csrf: adminCsrf, password: 'local-admin' })
    });
    assert.strictEqual(response.status, 302);
    response = await httpRequest(server, jar, '/repo/admin');
    assert.strictEqual(response.status, 200);
    assert(response.body.indexOf('Add assignment') !== -1);
    assert(response.body.indexOf('Generate a public write-up repository') !== -1);
    assert(response.body.indexOf('Archive assignment') !== -1);
    assert(response.body.indexOf('Delete team and repositories') !== -1);
    assert(response.body.indexOf('name="auditQuery"') !== -1);
    const staffCsrf = csrfFrom(response.body);

    response = await httpRequest(server, jar, '/repo/admin?auditQuery=assignment.created');
    assert.strictEqual(response.status, 200);
    assert(response.body.indexOf('value="assignment.created"') !== -1);
    assert(response.body.indexOf('matching entries') !== -1);

    response = await httpRequest(server, jar, '/repo/admin/assignments/' + httpAssignment.id + '/archive', {
      method: 'POST',
      body: encodeForm({ csrf: staffCsrf })
    });
    assert.strictEqual(response.status, 302);
    response = await httpRequest(server, jar, '/repo/');
    assert.strictEqual(response.body.indexOf('Homework 0'), -1,
      'the archive route must hide the assignment from a signed-in student');
    response = await httpRequest(server, jar, '/repo/admin/assignments/' + httpAssignment.id + '/unarchive', {
      method: 'POST',
      body: encodeForm({ csrf: staffCsrf })
    });
    assert.strictEqual(response.status, 302);

    response = await httpRequest(server, jar, '/repo/health');
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { ok: true, service: 'repo184' });
    const originalSnapshot = store.snapshot.bind(store);
    store.snapshot = function healthMustNotCloneState() {
      throw new Error('health route attempted to clone the full data store');
    };
    response = await httpRequest(server, jar, '/repo/health');
    assert.strictEqual(response.status, 200, 'health checks must use constant-size readiness state');
    store.snapshot = originalSnapshot;

    const httpWorkUnit = (await store.snapshot()).workUnits[0];
    response = await httpRequest(server, jar, '/repo/admin/work-units/' + httpWorkUnit.id + '/delete', {
      method: 'POST',
      body: encodeForm({ csrf: staffCsrf, confirm: 'wrong-name' })
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(Boolean(github.repositories[httpWorkUnit.repoName]), true);
    response = await httpRequest(server, jar, '/repo/admin/work-units/' + httpWorkUnit.id + '/delete', {
      method: 'POST',
      body: encodeForm({ csrf: staffCsrf, confirm: httpWorkUnit.repoName })
    });
    assert.strictEqual(response.status, 302);
    assert.strictEqual(github.repositories[httpWorkUnit.repoName], undefined);
  } finally {
    await new Promise(function close(resolve) { server.close(resolve); });
  }
}

async function oauthRetryHttpTests(testDirectory) {
  const config = configModule.loadConfig({
    nodeEnv: 'development',
    basePath: '/repo',
    baseUrl: 'http://127.0.0.1/repo',
    sessionSecret: 'oauth-retry-test-session-secret-more-than-32-characters',
    adminPassword: 'local-admin',
    dataFile: path.join(testDirectory, 'oauth-retry-http.json'),
    devFakeGithub: false
  });
  const store = new storeModule.JsonStore(config.dataFile);
  const github = new githubModule.FakeGitHubClient(config);
  const service = new serviceModule.Repo184Service({ store: store, github: github, config: config });
  const attempts = [];
  const exchanges = [];
  github.authorizationUrl = function authorizationUrl(state, challenge) {
    attempts.push({ state: state, challenge: challenge });
    return '/github/authorize/' + encodeURIComponent(state);
  };
  github.exchangeCode = async function exchangeCode(code, verifier) {
    exchanges.push({ code: code, verifier: verifier });
    return String(code);
  };
  github.getAuthenticatedUser = async function authenticatedUser(token) {
    return github.getFakeUser(String(token));
  };

  const app = express();
  app.set('trust proxy', 1);
  app.use('/repo', createRouter({ config: config, store: store, github: github, service: service }));
  const server = await new Promise(function listen(resolve) {
    const started = app.listen(0, '127.0.0.1', function ready() { resolve(started); });
  });
  try {
    const retryJar = {};
    for (let index = 0; index < 3; index += 1) {
      const response = await httpRequest(server, retryJar, '/repo/auth/github');
      assert.strictEqual(response.status, 302, 'ordinary OAuth retries must not be rate limited');
    }
    let response = await httpRequest(server, retryJar,
      '/repo/auth/github/callback?state=' + encodeURIComponent(attempts[0].state) + '&code=oauth-retry-one');
    assert.strictEqual(response.status, 302, 'an earlier pending OAuth tab must remain valid');
    assert.strictEqual(exchanges[0].code, 'oauth-retry-one');
    assert(exchanges[0].verifier, 'the matching PKCE verifier must be retained');

    const cancelJar = {};
    const cancelAttemptOffset = attempts.length;
    response = await httpRequest(server, cancelJar, '/repo/auth/github');
    assert.strictEqual(response.status, 302);
    response = await httpRequest(server, cancelJar, '/repo/auth/github');
    assert.strictEqual(response.status, 302);
    const cancelledState = attempts[cancelAttemptOffset].state;
    const survivingState = attempts[cancelAttemptOffset + 1].state;
    response = await httpRequest(server, cancelJar,
      '/repo/auth/github/callback?state=' + encodeURIComponent(cancelledState) + '&error=access_denied');
    assert.strictEqual(response.status, 400);
    assert(response.body.indexOf('cancelled or denied') !== -1);
    response = await httpRequest(server, cancelJar,
      '/repo/auth/github/callback?state=' + encodeURIComponent(survivingState) + '&code=oauth-retry-two');
    assert.strictEqual(response.status, 302, 'cancelling one OAuth tab must not invalidate another');

    const boundedJar = {};
    const boundedAttemptOffset = attempts.length;
    for (let index = 0; index < 6; index += 1) {
      response = await httpRequest(server, boundedJar, '/repo/auth/github');
      assert.strictEqual(response.status, 302);
    }
    response = await httpRequest(server, boundedJar,
      '/repo/auth/github/callback?state=' + encodeURIComponent(attempts[boundedAttemptOffset].state) + '&code=evicted-attempt');
    assert.strictEqual(response.status, 400, 'only the five newest OAuth attempts should remain pending');
    response = await httpRequest(server, boundedJar,
      '/repo/auth/github/callback?state=' + encodeURIComponent(attempts[boundedAttemptOffset + 1].state) + '&code=oauth-retry-three');
    assert.strictEqual(response.status, 302, 'evicting the oldest OAuth attempt must preserve newer attempts');
  } finally {
    await new Promise(function close(resolve) { server.close(resolve); });
  }
}

async function productionBoundaryTests(testDirectory) {
  assert.throws(function invalidEnvironment() {
    configModule.validateBaseConfig(configModule.loadConfig({ nodeEnv: 'prod' }));
  }, /NODE_ENV must be exactly/);
  assert.throws(function missingProductionAdminPassword() {
    configModule.validateBaseConfig(configModule.loadConfig({
      nodeEnv: 'production',
      basePath: '/repo',
      baseUrl: 'https://cs184.eecs.berkeley.edu/repo',
      sessionSecret: 'production-boundary-test-session-secret-123456789'
    }));
  }, /ADMIN_PASSWORD is required/);
  const keyPair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const config = configModule.loadConfig({
    nodeEnv: 'production',
    basePath: '/repo',
    baseUrl: 'https://cs184.eecs.berkeley.edu/repo',
    sessionSecret: 'production-boundary-test-session-secret-123456789',
    adminPassword: 'local-admin',
    githubAppId: '1234',
    githubClientId: 'Iv1.test',
    githubClientSecret: 'test-client-secret',
    githubInstallationId: '5678',
    githubPrivateKey: keyPair.privateKey,
    dataFile: path.join(testDirectory, 'production-http.json'),
    devFakeGithub: false
  });
  configModule.validateBaseConfig(config);
  const store = new storeModule.JsonStore(config.dataFile);
  const github = new githubModule.FakeGitHubClient(config);
  const service = new serviceModule.Repo184Service({ store: store, github: github, config: config });
  const app = express();
  app.set('trust proxy', 1);
  app.use('/repo', createRouter({ config: config, store: store, github: github, service: service }));
  const server = await new Promise(function listen(resolve) {
    const started = app.listen(0, '127.0.0.1', function ready() { resolve(started); });
  });
  const jar = {};
  try {
    let response = await httpRequest(server, jar, '/repo/health');
    assert.strictEqual(response.status, 200, 'direct Unix-socket-style health checks must not require TLS headers');
    assert.strictEqual(response.headers['set-cookie'], undefined, 'health checks should not create sessions');

    response = await httpRequest(server, jar, '/repo/', {
      headers: { 'X-Forwarded-Proto': 'https' }
    });
    assert.strictEqual(response.status, 200);
    assert(jar.lastSetCookie.toLowerCase().indexOf('secure') !== -1,
      'proxied production sessions must set Secure cookies');

    response = await httpRequest(server, jar, '/repo/admin', {
      headers: { 'X-Forwarded-Proto': 'https' }
    });
    const adminCsrf = csrfFrom(response.body);
    response = await httpRequest(server, jar, '/repo/admin/login', {
      method: 'POST',
      headers: { 'X-Forwarded-Proto': 'https' },
      body: encodeForm({ csrf: adminCsrf, password: 'local-admin' })
    });
    assert.strictEqual(response.status, 302, 'production must accept ADMIN_PASSWORD');
    response = await httpRequest(server, jar, '/repo/admin', {
      headers: { 'X-Forwarded-Proto': 'https' }
    });
    assert(response.body.indexOf('Add assignment') !== -1,
      'successful production admin login must open the admin page');
  } finally {
    await new Promise(function close(resolve) { server.close(resolve); });
  }
}

async function run() {
  const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'repo184-test-'));
  try {
    await serviceTests(testDirectory);
    await adminControlServiceTests(testDirectory);
    singleInstanceTests(testDirectory);
    attemptLimiterTests();
    githubActionLimiterTests();
    await githubTransportTests();
    await httpTests(testDirectory);
    await oauthRetryHttpTests(testDirectory);
    await productionBoundaryTests(testDirectory);
    console.log('Repo184 tests passed.');
  } finally {
    removeDirectory(testDirectory);
  }
}

run().catch(function failed(error) {
  console.error(error.stack || error);
  process.exitCode = 1;
});
