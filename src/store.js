'use strict';

const fs = require('fs');
const path = require('path');
const util = require('./util');

const promises = fs.promises;

function initialState() {
  return {
    version: 1,
    assignments: [],
    users: {},
    workUnits: [],
    audit: []
  };
}

function migrateIndividualWorkUnits(state) {
  if (!state || !Array.isArray(state.workUnits) || !state.users) {
    return false;
  }
  let changed = false;
  state.workUnits.forEach(function migrateWorkUnit(workUnit) {
    if (workUnit.kind !== 'individual') {
      return;
    }
    const member = Array.isArray(workUnit.members) && workUnit.members[0];
    const user = member && state.users[member.userId];
    const fallbackName = user && user.login ? user.login : String(workUnit.displayName || '').replace(/^@/, '');
    workUnit.kind = 'team';
    workUnit.displayName = fallbackName || 'One-person team';
    workUnit.teamSlug = util.slugify(workUnit.displayName) || util.slugify(workUnit.id);
    workUnit.joinCode = workUnit.joinCode || util.randomId('join');
    changed = true;
  });
  return changed;
}

function migrateWriteupRepositories(state) {
  if (!state || !Array.isArray(state.assignments) || !Array.isArray(state.workUnits)) {
    return false;
  }
  let changed = false;
  state.assignments.forEach(function migrateAssignment(assignment) {
    if (assignment.generateWriteupRepo === undefined) {
      assignment.generateWriteupRepo = false;
      assignment.writeupTemplateOwner = '';
      assignment.writeupTemplateRepo = '';
      assignment.writeupTemplateFullName = '';
      assignment.writeupTemplateRepoId = null;
      changed = true;
    }
  });
  state.workUnits.forEach(function migrateWorkUnit(workUnit) {
    if (workUnit.templateReportedRepoId === undefined) {
      workUnit.templateReportedRepoId = null;
      changed = true;
    }
    if (workUnit.writeupEnabled === undefined) {
      workUnit.writeupEnabled = false;
      workUnit.writeupRepoName = '';
      workUnit.writeupRepoMarker = '';
      workUnit.writeupRepoId = null;
      workUnit.writeupRepoHtmlUrl = '';
      workUnit.writeupRepoCloneUrl = '';
      workUnit.writeupRepoSshUrl = '';
      workUnit.writeupTemplateProvenance = 'disabled';
      workUnit.writeupTemplateSourceRepoId = null;
      workUnit.writeupRepoStatus = 'disabled';
      workUnit.writeupRepoError = '';
      workUnit.writeupPagesUrl = '';
      workUnit.writeupPagesStatus = 'disabled';
      workUnit.writeupPagesError = '';
      changed = true;
    }
    if (workUnit.writeupTemplateReportedRepoId === undefined) {
      workUnit.writeupTemplateReportedRepoId = null;
      changed = true;
    }
  });
  return changed;
}

function validateState(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.assignments) ||
      !state.users || !Array.isArray(state.workUnits) || !Array.isArray(state.audit)) {
    throw new Error('Repo184 data file has an unsupported shape or version');
  }
  const assignmentIds = {};
  const assignmentSlugs = {};
  const repoPrefixes = {};
  state.assignments.forEach(function eachAssignment(assignment) {
    if (assignment.templateRepoId === undefined || assignment.templateRepoId === null) {
      throw new Error('Assignment is missing its immutable template repository ID');
    }
    if (assignment.generateWriteupRepo &&
        (!assignment.writeupTemplateFullName || assignment.writeupTemplateRepoId === undefined || assignment.writeupTemplateRepoId === null)) {
      throw new Error('Assignment is missing its immutable write-up template repository ID');
    }
    if (assignmentIds[assignment.id] || assignmentSlugs[assignment.slug] || repoPrefixes[assignment.repoPrefix]) {
      throw new Error('Duplicate assignment id, slug, or repository prefix in data store');
    }
    assignmentIds[assignment.id] = true;
    assignmentSlugs[assignment.slug] = true;
    repoPrefixes[assignment.repoPrefix] = true;
  });

  const memberClaims = {};
  const pendingClaims = {};
  const repoNames = {};
  const requestIds = {};
  state.workUnits.forEach(function eachWorkUnit(workUnit) {
    if (workUnit.lifecycle && ['active', 'release_pending', 'released'].indexOf(workUnit.lifecycle) === -1) {
      throw new Error('Work unit has an unsupported lifecycle state');
    }
    if (['not_generated', 'verified', 'mismatch', 'identity_mismatch'].indexOf(workUnit.templateProvenance) === -1) {
      throw new Error('Work unit has an unsupported template provenance state');
    }
    const assignment = state.assignments.find(function matchingAssignment(item) {
      return item.id === workUnit.assignmentId;
    });
    if (!assignment) {
      throw new Error('Work unit references an unknown assignment');
    }
    if (repoNames[workUnit.repoName]) {
      throw new Error('Duplicate repository name in data store');
    }
    repoNames[workUnit.repoName] = true;
    if (workUnit.writeupEnabled) {
      if (!assignment.generateWriteupRepo || !workUnit.writeupRepoName || !workUnit.writeupRepoMarker) {
        throw new Error('Work unit has invalid write-up repository configuration');
      }
      if (repoNames[workUnit.writeupRepoName]) {
        throw new Error('Duplicate repository name in data store');
      }
      repoNames[workUnit.writeupRepoName] = true;
      if (['not_generated', 'verified', 'mismatch', 'identity_mismatch'].indexOf(workUnit.writeupTemplateProvenance) === -1 ||
          ['provisioning', 'ready', 'error'].indexOf(workUnit.writeupRepoStatus) === -1 ||
          ['pending', 'ready', 'error'].indexOf(workUnit.writeupPagesStatus) === -1) {
        throw new Error('Work unit has an unsupported write-up repository state');
      }
    } else if (workUnit.writeupRepoStatus !== 'disabled' || workUnit.writeupPagesStatus !== 'disabled' ||
        workUnit.writeupTemplateProvenance !== 'disabled') {
      throw new Error('Disabled write-up repository has an unsupported state');
    }

    if (!Array.isArray(workUnit.members) || !workUnit.members.length || !Array.isArray(workUnit.requests) || workUnit.requests.length > 500) {
      throw new Error('Work unit has invalid members or requests');
    }
    if (workUnit.kind !== 'team') {
      throw new Error('Work unit has an unsupported kind');
    }
    if (workUnit.lifecycle !== 'released' && workUnit.members.length > assignment.maxTeamSize) {
      throw new Error('Work unit exceeds its assignment team-size rule');
    }

    const claimsAssignment = workUnit.lifecycle !== 'released';
    const membersInUnit = {};
    workUnit.members.forEach(function eachMember(member) {
      const claim = workUnit.assignmentId + ':' + member.userId;
      if (membersInUnit[member.userId] || (claimsAssignment && (memberClaims[claim] || pendingClaims[claim]))) {
        throw new Error('A student is assigned more than once for an assignment');
      }
      if (!state.users[member.userId]) {
        throw new Error('Work unit member references an unknown user');
      }
      membersInUnit[member.userId] = true;
      if (claimsAssignment) {
        memberClaims[claim] = true;
      }
    });

    workUnit.requests.forEach(function eachRequest(request) {
      if (requestIds[request.id]) {
        throw new Error('Duplicate join request id in data store');
      }
      requestIds[request.id] = true;
      if (!state.users[request.userId]) {
        throw new Error('Join request references an unknown user');
      }
      if (request.status === 'pending' && claimsAssignment) {
        const pendingClaim = workUnit.assignmentId + ':' + request.userId;
        if (pendingClaims[pendingClaim] || memberClaims[pendingClaim]) {
          throw new Error('A student has conflicting assignment membership or pending requests');
        }
        pendingClaims[pendingClaim] = true;
      }
      if (request.status === 'approved' && !membersInUnit[request.userId]) {
        throw new Error('Approved join request does not match a team member');
      }
    });
  });
}

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = null;
    this.readyPromise = null;
    this.writeQueue = Promise.resolve();
    this.initialized = false;
    this.lastWriteError = null;
    this.fatalWriteError = null;
  }

  async init() {
    if (!this.readyPromise) {
      this.readyPromise = this.load();
    }
    await this.readyPromise;
    return this;
  }

  async load() {
    const directory = path.dirname(this.filePath);
    const temporaryPrefix = path.basename(this.filePath) + '.';
    await promises.mkdir(directory, { recursive: true });
    const directoryEntries = await promises.readdir(directory);
    await Promise.all(directoryEntries.filter(function staleTemporary(name) {
      return name.indexOf(temporaryPrefix) === 0 && /\.tmp$/.test(name);
    }).map(function removeTemporary(name) {
      return promises.unlink(path.join(directory, name)).catch(function ignoreMissing(error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }));
    try {
      const contents = await promises.readFile(this.filePath, 'utf8');
      this.state = JSON.parse(contents);
      const migratedIndividuals = migrateIndividualWorkUnits(this.state);
      const migratedWriteups = migrateWriteupRepositories(this.state);
      const migrated = migratedIndividuals || migratedWriteups;
      validateState(this.state);
      if (migrated) {
        await this.writeState(this.state);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      this.state = initialState();
      await this.writeState(this.state);
    }
    this.initialized = true;
  }

  healthStatus() {
    return {
      ok: Boolean(this.initialized && this.state && !this.lastWriteError),
      initialized: this.initialized,
      lastWriteError: this.lastWriteError ? String(this.lastWriteError.message || this.lastWriteError) : ''
    };
  }

  async snapshot() {
    await this.init();
    await this.writeQueue;
    if (this.fatalWriteError) {
      throw this.fatalWriteError;
    }
    return util.clone(this.state);
  }

  transaction(mutator) {
    const self = this;
    const operation = this.writeQueue.then(async function runTransaction() {
      await self.init();
      if (self.fatalWriteError) {
        throw self.fatalWriteError;
      }
      const draft = util.clone(self.state);
      const result = await mutator(draft);
      validateState(draft);
      await self.writeState(draft);
      self.state = draft;
      return result;
    });
    this.writeQueue = operation.catch(function preserveQueue() {});
    return operation;
  }

  async writeState(state) {
    const temporary = this.filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
    let renamed = false;
    try {
      await promises.writeFile(temporary, JSON.stringify(state, null, 2) + '\n', {
        encoding: 'utf8',
        mode: 0o600
      });
      const temporaryHandle = await promises.open(temporary, 'r+');
      try {
        await temporaryHandle.sync();
      } finally {
        await temporaryHandle.close();
      }
      await promises.rename(temporary, this.filePath);
      renamed = true;

      const directoryHandle = await promises.open(path.dirname(this.filePath), 'r');
      try {
        await directoryHandle.sync();
      } catch (error) {
        if (['EINVAL', 'ENOTSUP', 'EBADF'].indexOf(error.code) === -1) {
          throw error;
        }
      } finally {
        await directoryHandle.close();
      }
      this.lastWriteError = null;
    } catch (error) {
      this.lastWriteError = error;
      if (renamed) {
        this.fatalWriteError = new Error(
          'Repo184 data was renamed but its directory could not be synchronized. Restart the service before handling more requests.'
        );
      }
      throw error;
    } finally {
      if (!renamed) {
        await promises.unlink(temporary).catch(function ignoreMissing(error) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        });
      }
    }
  }
}

module.exports = {
  JsonStore: JsonStore,
  initialState: initialState,
  validateState: validateState
};
