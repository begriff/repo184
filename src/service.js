'use strict';

const util = require('./util');

function findAssignment(state, idOrSlug) {
  return state.assignments.find(function match(assignment) {
    return assignment.id === idOrSlug || assignment.slug === idOrSlug;
  });
}

function findWorkUnit(state, id) {
  return state.workUnits.find(function match(workUnit) {
    return workUnit.id === id;
  });
}

function findRequest(state, requestId) {
  let found = null;
  state.workUnits.some(function scan(workUnit) {
    const request = workUnit.requests.find(function match(item) {
      return item.id === requestId;
    });
    if (request) {
      found = { workUnit: workUnit, request: request };
      return true;
    }
    return false;
  });
  return found;
}

function isActiveWorkUnit(workUnit) {
  return !workUnit.lifecycle || workUnit.lifecycle === 'active';
}

function claimsAssignment(workUnit) {
  return workUnit.lifecycle !== 'released';
}

function addAudit(state, actor, action, details) {
  state.audit.push({
    id: util.randomId('audit'),
    actor: actor || 'system',
    action: action,
    details: details || {},
    createdAt: util.nowIso()
  });
  if (state.audit.length > 5000) {
    state.audit = state.audit.slice(state.audit.length - 5000);
  }
}

function cleanError(error) {
  return String(error && error.message ? error.message : error || 'Unknown error').slice(0, 600);
}

function isNotFoundError(error) {
  return Boolean(error && error.statusCode === 404);
}

function repositoryVerificationFailed(error) {
  return Boolean(error && [
    'repository_collision',
    'repository_identity_mismatch',
    'repository_missing',
    'repository_not_private',
    'template_identity_mismatch',
    'template_provenance_mismatch'
  ].indexOf(error.code) !== -1);
}

function repoFields(repository) {
  return {
    repoId: repository.id,
    repoHtmlUrl: repository.html_url,
    repoCloneUrl: repository.clone_url,
    repoSshUrl: repository.ssh_url
  };
}

function enrichWorkUnit(state, workUnit) {
  const result = util.clone(workUnit);
  result.members = result.members.map(function addUser(member) {
    member.user = util.clone(state.users[member.userId] || { id: member.userId, login: 'unknown' });
    return member;
  });
  result.requests = result.requests.map(function addRequester(request) {
    request.user = util.clone(state.users[request.userId] || { id: request.userId, login: 'unknown' });
    return request;
  });
  return result;
}

function recentResolvedRequest(state, assignmentId, userId) {
  const matches = [];
  state.workUnits.forEach(function scan(workUnit) {
    if (workUnit.assignmentId !== assignmentId) {
      return;
    }
    workUnit.requests.forEach(function request(item) {
      if (item.userId === userId && (item.status === 'rejected' || item.status === 'removed')) {
        matches.push(Object.assign(util.clone(item), {
          workUnitId: workUnit.id,
          teamName: workUnit.displayName
        }));
      }
    });
  });
  matches.sort(function newest(left, right) {
    return String(right.resolvedAt).localeCompare(String(left.resolvedAt));
  });
  return matches[0] || null;
}

function makeRoomForJoinRequest(workUnit) {
  while (workUnit.requests.length >= 500) {
    const removableIndex = workUnit.requests.findIndex(function resolved(item) {
      return item.status !== 'pending' && item.status !== 'approved';
    });
    if (removableIndex === -1) {
      throw new util.AppError('This team has too many active join requests. Ask staff for help.', 409, 'join_request_limit');
    }
    workUnit.requests.splice(removableIndex, 1);
  }
}

class Repo184Service {
  constructor(options) {
    this.store = options.store;
    this.github = options.github;
    this.config = options.config;
    this.provisioning = {};
    this.workUnitLocks = {};
  }

  withWorkUnitLock(workUnitId, operation) {
    const service = this;
    const previous = this.workUnitLocks[workUnitId] || Promise.resolve();
    const queued = previous.catch(function ignorePreviousFailure() {}).then(operation);
    this.workUnitLocks[workUnitId] = queued;
    return queued.then(function success(value) {
      if (service.workUnitLocks[workUnitId] === queued) {
        delete service.workUnitLocks[workUnitId];
      }
      return value;
    }, function failure(error) {
      if (service.workUnitLocks[workUnitId] === queued) {
        delete service.workUnitLocks[workUnitId];
      }
      throw error;
    });
  }

  async rememberUser(profile, membership) {
    const user = {
      id: String(profile.id),
      numericId: profile.numericId,
      login: profile.login,
      avatarUrl: profile.avatarUrl || '',
      profileUrl: profile.profileUrl || ('https://github.com/' + profile.login),
      membershipState: membership && membership.state ? membership.state : 'absent',
      membershipRole: membership && membership.role ? membership.role : '',
      membershipCheckedAt: util.nowIso()
    };
    await this.store.transaction(function save(state) {
      const existing = state.users[user.id];
      user.createdAt = existing ? existing.createdAt : util.nowIso();
      user.updatedAt = util.nowIso();
      state.users[user.id] = user;
      addAudit(state, user.login, existing ? 'user.signed_in' : 'user.created', {
        userId: user.id,
        membershipState: user.membershipState
      });
    });
    return user;
  }

  async getUser(userId) {
    const state = await this.store.snapshot();
    return state.users[userId] ? util.clone(state.users[userId]) : null;
  }

  async refreshGitHubIdentity(userId, priority) {
    const state = await this.store.snapshot();
    const user = state.users[userId];
    if (!user) {
      throw new util.AppError('Your session is no longer valid. Please sign in again.', 401, 'login_required');
    }
    const profile = await this.github.getUserById(user.numericId, priority);
    if (!profile || String(profile.numericId) !== String(user.numericId)) {
      throw new util.AppError('GitHub returned a different account for the saved user ID. Sign in again before changing repository access.', 409, 'github_identity_mismatch');
    }
    await this.store.transaction(function updateIdentity(draft) {
      const current = draft.users[userId];
      if (!current) {
        return;
      }
      const previousLogin = current.login;
      current.login = profile.login;
      current.avatarUrl = profile.avatarUrl || '';
      current.profileUrl = profile.profileUrl || ('https://github.com/' + profile.login);
      current.updatedAt = util.nowIso();
      if (previousLogin !== current.login) {
        addAudit(draft, current.login, 'user.login_updated', {
          userId: userId,
          previousLogin: previousLogin,
          login: current.login
        });
      }
    });
    return this.getUser(userId);
  }

  async refreshMembership(userId) {
    const user = await this.refreshGitHubIdentity(userId);
    const membership = await this.github.getMembership(user.login);
    const membershipId = membership && membership.user ? membership.user.id : null;
    const identityMatches = !membership || (membershipId !== null && String(membershipId) === String(user.numericId));
    const nextState = identityMatches && membership && membership.state ? membership.state : (identityMatches ? 'absent' : 'identity_mismatch');
    await this.store.transaction(function update(draft) {
      if (!draft.users[userId]) {
        return;
      }
      draft.users[userId].membershipState = nextState;
      draft.users[userId].membershipRole = identityMatches && membership && membership.role ? membership.role : '';
      draft.users[userId].membershipCheckedAt = util.nowIso();
      draft.users[userId].updatedAt = util.nowIso();
      addAudit(draft, user.login, 'organization.membership_checked', {
        state: nextState,
        identityMatches: identityMatches
      });
    });
    if (!identityMatches) {
      throw new util.AppError('GitHub returned organization membership for a different account. Sign out and sign in with GitHub again.', 409, 'github_identity_mismatch');
    }
    return this.getUser(userId);
  }

  async sendMembershipInvitation(userId) {
    const user = await this.refreshGitHubIdentity(userId);
    const membership = await this.github.sendInvitation(user);
    const membershipId = membership && membership.user ? membership.user.id : null;
    if (membershipId !== null && String(membershipId) !== String(user.numericId)) {
      throw new util.AppError('GitHub returned organization membership for a different account. Sign out and sign in with GitHub again.', 409, 'github_identity_mismatch');
    }
    const nextState = membership && membership.state ? membership.state : 'absent';
    await this.store.transaction(function updateInvitationState(state) {
      if (!state.users[userId]) {
        return;
      }
      state.users[userId].membershipState = nextState;
      state.users[userId].membershipRole = membership && membership.role ? membership.role : '';
      state.users[userId].membershipCheckedAt = util.nowIso();
      state.users[userId].updatedAt = util.nowIso();
      addAudit(state, user.login, 'organization.invitation_sent', {
        state: nextState
      });
    });
    return this.getUser(userId);
  }

  async ensureActiveMembership(userId) {
    const user = await this.refreshMembership(userId);
    if (!user || user.membershipState !== 'active') {
      throw new util.AppError('Your course organization membership must be active before changing repository access.', 409, 'membership_inactive');
    }
    return user;
  }

  requireActiveUser(state, userId) {
    const user = state.users[userId];
    if (!user) {
      throw new util.AppError('Please sign in with GitHub.', 401, 'login_required');
    }
    if (user.membershipState !== 'active') {
      throw new util.AppError('Your course organization membership must be active before creating or joining a repository.', 409, 'membership_inactive');
    }
    return user;
  }

  async verifyManagedRepository(workUnit, requirePrivate, priority) {
    const repository = await this.github.getRepository(workUnit.repoName, priority);
    if (!repository) {
      throw new util.AppError('The managed GitHub repository no longer exists. Staff must investigate before changing access.', 409, 'repository_missing');
    }
    if (workUnit.repoId !== null && String(repository.id) !== String(workUnit.repoId)) {
      throw new util.AppError('A different GitHub repository now uses this managed name. Access was not changed.', 409, 'repository_identity_mismatch');
    }
    if (workUnit.repoId === null && (!repository.private || repository.description !== workUnit.repoMarker)) {
      throw new util.AppError('A repository with this name was not created by this Repo184 record. Access was not changed.', 409, 'repository_collision');
    }
    if (requirePrivate && !repository.private) {
      throw new util.AppError('The managed repository is not private. Staff intervention is required.', 409, 'repository_not_private');
    }
    return repository;
  }

  async verifyAssignmentTemplate(assignment) {
    const template = await this.github.validateTemplate(
      assignment.templateOwner,
      assignment.templateRepo
    );
    if (!template || String(template.id) !== String(assignment.templateRepoId)) {
      throw new util.AppError(
        'The assignment template name now points to a different GitHub repository. Staff must restore or reconfigure the template before provisioning.',
        409,
        'template_identity_mismatch'
      );
    }
    return template;
  }

  async createAssignment(input, actor) {
    const assignmentInput = util.validateAssignmentInput(input);
    const template = await this.github.validateTemplate(assignmentInput.templateOwner, assignmentInput.templateRepo);
    assignmentInput.templateRepoId = template.id;
    return this.store.transaction(function create(state) {
      if (findAssignment(state, assignmentInput.slug)) {
        throw new util.AppError('An assignment with that slug already exists.', 409, 'assignment_exists');
      }
      if (state.assignments.some(function duplicatePrefix(item) {
        return item.repoPrefix === assignmentInput.repoPrefix;
      })) {
        throw new util.AppError('Repository prefixes must be unique across assignments.', 409, 'prefix_exists');
      }
      const now = util.nowIso();
      const assignment = Object.assign({
        id: util.randomId('assignment'),
        createdAt: now,
        updatedAt: now
      }, assignmentInput);
      state.assignments.push(assignment);
      addAudit(state, actor, 'assignment.created', {
        assignmentId: assignment.id,
        slug: assignment.slug,
        template: assignment.templateFullName
      });
      return util.clone(assignment);
    });
  }

  async updateAssignment(assignmentId, input, actor) {
    const assignmentInput = util.validateAssignmentInput(input);
    const before = await this.store.snapshot();
    const beforeAssignment = findAssignment(before, assignmentId);
    if (!beforeAssignment) {
      throw new util.AppError('Assignment not found.', 404, 'assignment_not_found');
    }
    const assignmentLocked = before.workUnits.some(function forAssignment(workUnit) {
      return workUnit.assignmentId === beforeAssignment.id &&
        (claimsAssignment(workUnit) || workUnit.repoId !== null);
    });
    const immutableChanged = beforeAssignment.slug !== assignmentInput.slug ||
      beforeAssignment.templateFullName !== assignmentInput.templateFullName ||
      beforeAssignment.repoPrefix !== assignmentInput.repoPrefix ||
      beforeAssignment.maxTeamSize !== assignmentInput.maxTeamSize;
    if (assignmentLocked && immutableChanged) {
      throw new util.AppError('Slug, template, repository prefix, and team size are locked while an active claim or managed repository exists. Title and open/closed status can still be changed.', 409, 'assignment_locked');
    }
    assignmentInput.templateRepoId = beforeAssignment.templateRepoId;
    if (beforeAssignment.templateFullName !== assignmentInput.templateFullName ||
        beforeAssignment.templateRepoId === undefined || beforeAssignment.templateRepoId === null) {
      const template = await this.github.validateTemplate(assignmentInput.templateOwner, assignmentInput.templateRepo);
      assignmentInput.templateRepoId = template.id;
    }
    return this.store.transaction(function update(state) {
      const assignment = findAssignment(state, assignmentId);
      if (!assignment) {
        throw new util.AppError('Assignment not found.', 404, 'assignment_not_found');
      }
      if (state.assignments.some(function duplicateSlug(item) {
        return item.id !== assignment.id && item.slug === assignmentInput.slug;
      })) {
        throw new util.AppError('An assignment with that slug already exists.', 409, 'assignment_exists');
      }
      if (state.assignments.some(function duplicatePrefix(item) {
        return item.id !== assignment.id && item.repoPrefix === assignmentInput.repoPrefix;
      })) {
        throw new util.AppError('Repository prefixes must be unique across assignments.', 409, 'prefix_exists');
      }
      const locksIdentity = state.workUnits.some(function forAssignment(workUnit) {
        return workUnit.assignmentId === assignment.id &&
          (claimsAssignment(workUnit) || workUnit.repoId !== null);
      });
      if (locksIdentity && (assignment.slug !== assignmentInput.slug ||
          assignment.templateFullName !== assignmentInput.templateFullName ||
          assignment.repoPrefix !== assignmentInput.repoPrefix ||
          assignment.maxTeamSize !== assignmentInput.maxTeamSize)) {
        throw new util.AppError('Slug, template, repository prefix, and team size are locked while an active claim or managed repository exists.', 409, 'assignment_locked');
      }
      Object.assign(assignment, assignmentInput, { updatedAt: util.nowIso() });
      addAudit(state, actor, 'assignment.updated', {
        assignmentId: assignment.id,
        slug: assignment.slug,
        status: assignment.status
      });
      return util.clone(assignment);
    });
  }

  async createWorkUnit(assignmentSlug, userId, teamName) {
    await this.ensureActiveMembership(userId);
    const service = this;
    const workUnitId = await this.store.transaction(function reserve(state) {
      const user = service.requireActiveUser(state, userId);
      const assignment = findAssignment(state, assignmentSlug);
      if (!assignment) {
        throw new util.AppError('Assignment not found.', 404, 'assignment_not_found');
      }
      const existing = state.workUnits.find(function membership(workUnit) {
        return claimsAssignment(workUnit) && workUnit.assignmentId === assignment.id && workUnit.members.some(function member(item) {
          return item.userId === userId;
        });
      });
      if (existing) {
        return existing.id;
      }
      if (assignment.status !== 'open') {
        throw new util.AppError('This assignment is closed.', 409, 'assignment_closed');
      }
      const hasPendingRequest = state.workUnits.some(function pending(workUnit) {
        return isActiveWorkUnit(workUnit) && workUnit.assignmentId === assignment.id && workUnit.requests.some(function request(item) {
          return item.userId === userId && item.status === 'pending';
        });
      });
      if (hasPendingRequest) {
        throw new util.AppError('Cancel your pending team request before creating a repository.', 409, 'request_pending');
      }

      const displayName = String(teamName || '').trim();
      const nameSlug = util.slugify(displayName);
      if (displayName.length < 2 || displayName.length > 40 || !nameSlug) {
        throw new util.AppError('Team name must be between 2 and 40 characters.', 400, 'invalid_team_name');
      }
      const nameTaken = state.workUnits.some(function duplicateTeam(workUnit) {
        return isActiveWorkUnit(workUnit) && workUnit.assignmentId === assignment.id &&
          workUnit.kind === 'team' && workUnit.teamSlug === nameSlug;
      });
      if (nameTaken) {
        throw new util.AppError('That team name is already in use for this assignment.', 409, 'team_name_taken');
      }

      const id = util.randomId('work');
      const repoName = assignment.repoPrefix + '-' + nameSlug;
      if (state.workUnits.some(function duplicateRepo(workUnit) { return workUnit.repoName === repoName; })) {
        throw new util.AppError(
          'That repository name is already managed. Choose a different team name.',
          409,
          'repository_name_taken'
        );
      }
      const now = util.nowIso();
      const workUnit = {
        id: id,
        lifecycle: 'active',
        assignmentId: assignment.id,
        kind: 'team',
        displayName: displayName,
        teamSlug: nameSlug,
        joinCode: util.randomId('join'),
        repoName: repoName,
        repoMarker: 'Managed by Repo184; assignment=' + assignment.id + '; work-unit=' + id,
        repoId: null,
        repoHtmlUrl: '',
        repoCloneUrl: '',
        repoSshUrl: '',
        templateProvenance: 'not_generated',
        templateSourceRepoId: null,
        repoStatus: 'provisioning',
        repoError: '',
        members: [{
          userId: userId,
          role: 'owner',
          accessStatus: 'pending',
          accessError: '',
          joinedAt: now
        }],
        requests: [],
        createdAt: now,
        updatedAt: now
      };
      state.workUnits.push(workUnit);
      addAudit(state, user.login, 'work_unit.created', {
        workUnitId: id,
        assignmentId: assignment.id,
        kind: 'team',
        repoName: repoName
      });
      return id;
    });

    await this.provisionWorkUnit(workUnitId);
    return this.getWorkUnit(workUnitId);
  }

  provisionWorkUnit(workUnitId) {
    const service = this;
    if (this.provisioning[workUnitId]) {
      return this.provisioning[workUnitId];
    }
    const operation = this.withWorkUnitLock(workUnitId, function provisionLocked() {
      return service.performProvision(workUnitId);
    }).then(function done(value) {
      delete service.provisioning[workUnitId];
      return value;
    }, function failed(error) {
      delete service.provisioning[workUnitId];
      throw error;
    });
    this.provisioning[workUnitId] = operation;
    return operation;
  }

  async performProvision(workUnitId) {
    const state = await this.store.snapshot();
    const workUnit = findWorkUnit(state, workUnitId);
    if (!workUnit) {
      throw new util.AppError('Repository record not found.', 404, 'work_unit_not_found');
    }
    if (!isActiveWorkUnit(workUnit)) {
      throw new util.AppError('This repository record is not active.', 409, 'work_unit_inactive');
    }
    const assignment = findAssignment(state, workUnit.assignmentId);
    try {
      if (workUnit.templateProvenance === 'mismatch') {
        throw new util.AppError('GitHub reported that this repository was generated from a different template. Staff must release this claim and inspect the repository.', 409, 'template_provenance_mismatch');
      }
      let repository = await this.github.getRepository(workUnit.repoName);
      if (repository) {
        if (workUnit.repoId !== null && String(repository.id) !== String(workUnit.repoId)) {
          throw new util.AppError('A different GitHub repository now uses this managed name. Staff must resolve the collision.', 409, 'repository_identity_mismatch');
        }
        if (!repository.private || repository.description !== workUnit.repoMarker) {
          throw new util.AppError('A repository with this name already exists and was not created by this Repo184 record. Staff must resolve the collision.', 409, 'repository_collision');
        }
        if (workUnit.repoId === null || workUnit.templateProvenance !== 'verified') {
          const existingSourceId = repository.template_repository && repository.template_repository.id;
          if (existingSourceId === undefined || existingSourceId === null ||
              String(existingSourceId) !== String(assignment.templateRepoId)) {
            throw new util.AppError('The existing repository cannot be proven to come from the configured immutable template. Staff must inspect it before any access is granted.', 409, 'template_provenance_mismatch');
          }
        }
      } else {
        if (workUnit.repoId !== null) {
          throw new util.AppError('The managed GitHub repository no longer exists. Repo184 will not create a replacement under the same record.', 409, 'repository_missing');
        }
        await this.verifyAssignmentTemplate(assignment);
        repository = await this.github.generateRepository(assignment, workUnit.repoName, workUnit.repoMarker);
        const generatedSourceId = repository.template_repository && repository.template_repository.id;
        const provenanceMatches = generatedSourceId !== undefined && generatedSourceId !== null &&
          String(generatedSourceId) === String(assignment.templateRepoId);
        const generatedFields = repoFields(repository);
        await this.store.transaction(function recordGeneratedRepository(draft) {
          const unit = findWorkUnit(draft, workUnitId);
          if (!unit) {
            return;
          }
          Object.assign(unit, generatedFields, {
            templateProvenance: provenanceMatches ? 'verified' : 'mismatch',
            templateSourceRepoId: generatedSourceId === undefined ? null : generatedSourceId,
            repoStatus: provenanceMatches ? 'provisioning' : 'error',
            repoError: provenanceMatches ? '' : 'GitHub reported a different source template for the generated repository.',
            updatedAt: util.nowIso()
          });
          addAudit(draft, 'system', 'repository.generated', {
            workUnitId: unit.id,
            repoName: unit.repoName,
            repoId: generatedFields.repoId,
            templateSourceRepoId: unit.templateSourceRepoId,
            templateProvenance: unit.templateProvenance
          });
        });
        if (!provenanceMatches) {
          throw new util.AppError('GitHub reported that the generated repository came from a different template. No student access was granted.', 409, 'template_provenance_mismatch');
        }
      }
      if (!repository.private) {
        throw new util.AppError('GitHub did not create a private repository. Staff intervention is required.', 502, 'repository_not_private');
      }
      const fields = repoFields(repository);
      await this.store.transaction(function ready(draft) {
        const unit = findWorkUnit(draft, workUnitId);
        if (!unit) {
          return;
        }
        Object.assign(unit, fields, {
          templateProvenance: 'verified',
          templateSourceRepoId: assignment.templateRepoId,
          repoStatus: 'ready',
          repoError: '',
          updatedAt: util.nowIso()
        });
        addAudit(draft, 'system', 'repository.ready', {
          workUnitId: unit.id,
          repoName: unit.repoName,
          repoId: fields.repoId
        });
      });

      const refreshed = await this.store.snapshot();
      const current = findWorkUnit(refreshed, workUnitId);
      for (let index = 0; index < current.members.length; index += 1) {
        if (!current.members[index].removalPending) {
          await this.performSyncMemberAccess(workUnitId, current.members[index].userId);
        }
      }
      return this.getWorkUnit(workUnitId);
    } catch (error) {
      await this.store.transaction(function markError(draft) {
        const unit = findWorkUnit(draft, workUnitId);
        if (!unit) {
          return;
        }
        unit.repoStatus = unit.repoId !== null && !repositoryVerificationFailed(error) ? 'ready' : 'error';
        unit.repoError = cleanError(error);
        unit.updatedAt = util.nowIso();
        addAudit(draft, 'system', 'repository.error', {
          workUnitId: unit.id,
          repoName: unit.repoName,
          error: unit.repoError
        });
      });
      return this.getWorkUnit(workUnitId);
    }
  }

  syncMemberAccess(workUnitId, userId) {
    const service = this;
    return this.withWorkUnitLock(workUnitId, function syncLocked() {
      return service.performSyncMemberAccess(workUnitId, userId);
    });
  }

  async performSyncMemberAccess(workUnitId, userId) {
    const state = await this.store.snapshot();
    const workUnit = findWorkUnit(state, workUnitId);
    const user = state.users[userId];
    const memberRecord = workUnit && workUnit.members.find(function member(item) {
      return item.userId === userId && !item.removalPending;
    });
    if (!workUnit || !isActiveWorkUnit(workUnit) || !user || !memberRecord) {
      throw new util.AppError('Team member not found.', 404, 'member_not_found');
    }
    let grantStarted = memberRecord.accessStatus === 'granting';
    try {
      if (grantStarted) {
        await this.verifyManagedRepository(workUnit, false, true);
        const cleanupUser = await this.refreshGitHubIdentity(userId, true);
        await this.github.removeCollaborator(workUnit.repoName, cleanupUser.login);
        await this.store.transaction(function cleanupUncertainGrant(draft) {
          const unit = findWorkUnit(draft, workUnitId);
          const member = unit && unit.members.find(function match(item) { return item.userId === userId; });
          if (!member) {
            return;
          }
          member.accessStatus = 'pending';
          member.accessError = '';
          unit.updatedAt = util.nowIso();
          addAudit(draft, 'system', 'repository.uncertain_access_revoked', {
            workUnitId: workUnitId,
            userId: userId
          });
        });
        grantStarted = false;
      }
      if (workUnit.repoStatus !== 'ready') {
        return;
      }
      const activeUser = await this.ensureActiveMembership(userId);
      await this.verifyManagedRepository(workUnit, true);
      await this.store.transaction(function reserveGrant(draft) {
        const unit = findWorkUnit(draft, workUnitId);
        const member = unit && unit.members.find(function match(item) { return item.userId === userId; });
        if (!member || member.removalPending) {
          throw new util.AppError('Team member not found.', 404, 'member_not_found');
        }
        member.accessStatus = 'granting';
        member.accessError = '';
        unit.updatedAt = util.nowIso();
        addAudit(draft, 'system', 'repository.access_grant_started', {
          workUnitId: workUnitId,
          userId: userId
        });
      });
      grantStarted = true;
      const accessStatus = await this.github.addCollaborator(workUnit.repoName, activeUser.login);
      await this.store.transaction(function synced(draft) {
        const unit = findWorkUnit(draft, workUnitId);
        if (!unit) {
          return;
        }
        const member = unit.members.find(function match(item) { return item.userId === userId; });
        if (!member) {
          return;
        }
        member.accessStatus = accessStatus;
        member.accessError = '';
        unit.updatedAt = util.nowIso();
        addAudit(draft, 'system', 'repository.access_synced', {
          workUnitId: workUnitId,
          userId: userId,
          status: accessStatus
        });
      });
    } catch (error) {
      await this.store.transaction(function accessError(draft) {
        const unit = findWorkUnit(draft, workUnitId);
        if (!unit) {
          return;
        }
        const member = unit.members.find(function match(item) { return item.userId === userId; });
        if (!member) {
          return;
        }
        member.accessStatus = grantStarted ? 'granting' : 'error';
        member.accessError = cleanError(error);
        unit.updatedAt = util.nowIso();
        addAudit(draft, 'system', 'repository.access_error', {
          workUnitId: workUnitId,
          userId: userId,
          error: member.accessError
        });
      });
    }
  }

  async requestToJoin(assignmentSlug, workUnitId, userId) {
    await this.ensureActiveMembership(userId);
    const service = this;
    return this.store.transaction(function request(state) {
      const user = service.requireActiveUser(state, userId);
      const assignment = findAssignment(state, assignmentSlug);
      const workUnit = findWorkUnit(state, workUnitId);
      if (!assignment || !workUnit || !isActiveWorkUnit(workUnit) || workUnit.assignmentId !== assignment.id) {
        throw new util.AppError('Team not found.', 404, 'team_not_found');
      }
      if (assignment.status !== 'open') {
        throw new util.AppError('This assignment is closed.', 409, 'assignment_closed');
      }
      if (workUnit.kind !== 'team') {
        throw new util.AppError('This repository is not managed as a team.', 409, 'not_a_team');
      }
      if (workUnit.members.length >= assignment.maxTeamSize) {
        throw new util.AppError('This team is full.', 409, 'team_full');
      }
      const alreadyClaimed = state.workUnits.some(function membership(unit) {
        return claimsAssignment(unit) && unit.assignmentId === assignment.id && unit.members.some(function member(item) {
          return item.userId === userId;
        });
      });
      if (alreadyClaimed) {
        throw new util.AppError('You already have a repository for this assignment.', 409, 'already_assigned');
      }
      const pendingElsewhere = state.workUnits.some(function pending(unit) {
        return isActiveWorkUnit(unit) && unit.assignmentId === assignment.id && unit.requests.some(function item(requestItem) {
          return requestItem.userId === userId && requestItem.status === 'pending';
        });
      });
      if (pendingElsewhere) {
        throw new util.AppError('You already have a pending team request for this assignment.', 409, 'request_pending');
      }
      let joinRequest = workUnit.requests.find(function reusable(item) {
        return item.userId === userId && item.status !== 'approved' && item.status !== 'pending';
      });
      if (!joinRequest) {
        makeRoomForJoinRequest(workUnit);
        joinRequest = { id: util.randomId('request'), userId: userId };
        workUnit.requests.push(joinRequest);
      }
      Object.assign(joinRequest, {
        status: 'pending',
        createdAt: util.nowIso(),
        resolvedAt: '',
        resolvedBy: ''
      });
      workUnit.updatedAt = util.nowIso();
      addAudit(state, user.login, 'team.join_requested', {
        workUnitId: workUnit.id,
        requestId: joinRequest.id
      });
      return util.clone(joinRequest);
    });
  }

  async cancelJoinRequest(requestId, userId) {
    return this.store.transaction(function cancel(state) {
      const found = findRequest(state, requestId);
      if (!found || found.request.userId !== userId || found.request.status !== 'pending') {
        throw new util.AppError('Pending join request not found.', 404, 'request_not_found');
      }
      found.request.status = 'cancelled';
      found.request.resolvedAt = util.nowIso();
      found.request.resolvedBy = userId;
      found.workUnit.updatedAt = util.nowIso();
      const user = state.users[userId];
      addAudit(state, user ? user.login : userId, 'team.join_cancelled', {
        workUnitId: found.workUnit.id,
        requestId: requestId
      });
    });
  }

  async resolveJoinRequest(requestId, actorId, decision, isAdmin) {
    const before = await this.store.snapshot();
    const beforeRequest = findRequest(before, requestId);
    if (!beforeRequest || beforeRequest.request.status !== 'pending') {
      throw new util.AppError('Pending join request not found.', 404, 'request_not_found');
    }
    if (!isAdmin) {
      await this.ensureActiveMembership(actorId);
    }
    if (decision === 'approve') {
      await this.ensureActiveMembership(beforeRequest.request.userId);
    }
    const service = this;
    return this.withWorkUnitLock(beforeRequest.workUnit.id, function resolveLocked() {
      return service.performResolveJoinRequest(requestId, actorId, decision, isAdmin);
    });
  }

  async performResolveJoinRequest(requestId, actorId, decision, isAdmin) {
    const service = this;
    let approvedMember = null;
    const workUnitId = await this.store.transaction(function resolve(state) {
      const found = findRequest(state, requestId);
      if (!found || found.request.status !== 'pending') {
        throw new util.AppError('Pending join request not found.', 404, 'request_not_found');
      }
      const workUnit = found.workUnit;
      const request = found.request;
      const assignment = findAssignment(state, workUnit.assignmentId);
      if (!isActiveWorkUnit(workUnit)) {
        throw new util.AppError('This team is no longer active.', 409, 'team_inactive');
      }
      const actorIsMember = workUnit.members.some(function member(item) {
        return item.userId === actorId;
      });
      if (!isAdmin && !actorIsMember) {
        throw new util.AppError('Only a current team member can resolve this request.', 403, 'not_team_member');
      }
      if (!isAdmin && assignment.status !== 'open') {
        throw new util.AppError('This assignment is closed.', 409, 'assignment_closed');
      }
      const actor = isAdmin ? 'admin' : (state.users[actorId] ? state.users[actorId].login : actorId);
      if (decision !== 'approve') {
        request.status = 'rejected';
        request.resolvedAt = util.nowIso();
        request.resolvedBy = actor;
        workUnit.updatedAt = util.nowIso();
        addAudit(state, actor, 'team.join_rejected', {
          workUnitId: workUnit.id,
          requestId: request.id,
          userId: request.userId
        });
        return workUnit.id;
      }

      if (workUnit.members.length >= assignment.maxTeamSize) {
        throw new util.AppError('This team is already full.', 409, 'team_full');
      }
      const alreadyClaimed = state.workUnits.some(function membership(unit) {
        return claimsAssignment(unit) && unit.assignmentId === assignment.id && unit.members.some(function member(item) {
          return item.userId === request.userId;
        });
      });
      if (alreadyClaimed) {
        throw new util.AppError('This student already has a repository for the assignment.', 409, 'already_assigned');
      }
      service.requireActiveUser(state, request.userId);
      const now = util.nowIso();
      workUnit.members.push({
        userId: request.userId,
        role: 'member',
        accessStatus: 'pending',
        accessError: '',
        joinedAt: now
      });
      approvedMember = request.userId;
      request.status = 'approved';
      request.resolvedAt = now;
      request.resolvedBy = actor;
      state.workUnits.forEach(function closeOtherRequests(unit) {
        if (!isActiveWorkUnit(unit) || unit.assignmentId !== assignment.id) {
          return;
        }
        unit.requests.forEach(function close(item) {
          if (item.userId === request.userId && item.status === 'pending') {
            item.status = item.id === request.id ? 'approved' : 'cancelled';
            item.resolvedAt = now;
            item.resolvedBy = actor;
          }
        });
      });
      if (workUnit.members.length >= assignment.maxTeamSize) {
        workUnit.requests.forEach(function rejectRemaining(item) {
          if (item.status === 'pending') {
            item.status = 'rejected';
            item.resolvedAt = now;
            item.resolvedBy = 'team-full';
          }
        });
      }
      workUnit.updatedAt = now;
      addAudit(state, actor, 'team.join_approved', {
        workUnitId: workUnit.id,
        requestId: request.id,
        userId: request.userId
      });
      return workUnit.id;
    });
    if (approvedMember) {
      await this.performSyncMemberAccess(workUnitId, approvedMember);
    }
    return this.getWorkUnit(workUnitId);
  }

  async renameTeam(workUnitId, name, actor) {
    const displayName = String(name || '').trim();
    const normalizedName = util.slugify(displayName);
    if (displayName.length < 2 || displayName.length > 40 || !normalizedName) {
      throw new util.AppError('Team name must be between 2 and 40 characters.', 400, 'invalid_team_name');
    }
    return this.store.transaction(function rename(state) {
      const workUnit = findWorkUnit(state, workUnitId);
      if (!workUnit || workUnit.kind !== 'team') {
        throw new util.AppError('Team not found.', 404, 'team_not_found');
      }
      if (!isActiveWorkUnit(workUnit)) {
        throw new util.AppError('Team is not active.', 409, 'team_inactive');
      }
      const duplicate = state.workUnits.some(function duplicateName(item) {
        return isActiveWorkUnit(item) && item.id !== workUnit.id && item.assignmentId === workUnit.assignmentId &&
          item.kind === 'team' && util.slugify(item.displayName) === normalizedName;
      });
      if (duplicate) {
        throw new util.AppError('That team display name is already in use for this assignment.', 409, 'team_name_taken');
      }
      workUnit.displayName = displayName;
      workUnit.teamSlug = normalizedName;
      workUnit.updatedAt = util.nowIso();
      addAudit(state, actor, 'team.renamed', { workUnitId: workUnit.id, name: displayName });
      return util.clone(workUnit);
    });
  }

  removeTeamMember(workUnitId, userId, actor) {
    const service = this;
    return this.withWorkUnitLock(workUnitId, function removeLocked() {
      return service.performRemoveTeamMember(workUnitId, userId, actor);
    });
  }

  async performRemoveTeamMember(workUnitId, userId, actor) {
    const before = await this.store.snapshot();
    const existingUnit = findWorkUnit(before, workUnitId);
    const existingUser = before.users[userId];
    if (!existingUnit || !isActiveWorkUnit(existingUnit) || existingUnit.kind !== 'team') {
      throw new util.AppError('Team not found.', 404, 'team_not_found');
    }
    const existingMember = existingUnit.members.find(function member(item) { return item.userId === userId; });
    if (!existingUser || !existingMember) {
      throw new util.AppError('Team member not found.', 404, 'member_not_found');
    }
    if (existingUnit.members.some(function otherRemoval(item) {
      return item.userId !== userId && item.removalPending;
    })) {
      throw new util.AppError('Finish the other pending member removal before starting another.', 409, 'removal_pending');
    }
    if (existingUnit.members.length < 2 && !existingMember.removalPending) {
      throw new util.AppError('The last member cannot be removed because it would leave an ownerless repository.', 409, 'last_member');
    }
    await this.store.transaction(function reserveRemoval(state) {
      const workUnit = findWorkUnit(state, workUnitId);
      if (!workUnit || !isActiveWorkUnit(workUnit) || workUnit.kind !== 'team') {
        throw new util.AppError('Team not found.', 404, 'team_not_found');
      }
      const index = workUnit.members.findIndex(function member(item) { return item.userId === userId; });
      if (index === -1) {
        throw new util.AppError('Team member not found.', 404, 'member_not_found');
      }
      if (workUnit.members.some(function otherRemoval(item) {
        return item.userId !== userId && item.removalPending;
      })) {
        throw new util.AppError('Finish the other pending member removal before starting another.', 409, 'removal_pending');
      }
      if (workUnit.members.length < 2 && !workUnit.members[index].removalPending) {
        throw new util.AppError('The last member cannot be removed because it would leave an ownerless repository.', 409, 'last_member');
      }
      workUnit.members[index].removalPending = true;
      workUnit.members[index].removalError = '';
      workUnit.members[index].accessStatus = 'removal_pending';
      workUnit.updatedAt = util.nowIso();
      addAudit(state, actor, 'team.member_removal_started', {
        workUnitId: workUnit.id,
        userId: userId,
        login: existingUser.login
      });
    });

    let visibilityError = '';
    try {
      if (existingUnit.repoId !== null) {
        const repository = await this.verifyManagedRepository(existingUnit, false, true);
        if (!repository.private) {
          visibilityError = 'The managed repository is public. Restore private visibility in GitHub immediately.';
          await this.store.transaction(function markPublic(state) {
            const workUnit = findWorkUnit(state, workUnitId);
            if (workUnit) {
              workUnit.repoStatus = 'error';
              workUnit.repoError = visibilityError;
              workUnit.updatedAt = util.nowIso();
              addAudit(state, actor, 'repository.visibility_error', {
                workUnitId: workUnit.id,
                visibility: 'public'
              });
            }
          });
        }
        let currentUser = null;
        try {
          currentUser = await this.refreshGitHubIdentity(userId, true);
        } catch (identityError) {
          if (!isNotFoundError(identityError)) {
            throw identityError;
          }
        }
        if (currentUser) {
          await this.github.removeCollaborator(existingUnit.repoName, currentUser.login);
        }
      }
    } catch (error) {
      await this.store.transaction(function removalFailed(state) {
        const workUnit = findWorkUnit(state, workUnitId);
        if (!workUnit) {
          return;
        }
        const member = workUnit.members.find(function matchingMember(item) { return item.userId === userId; });
        if (member) {
          member.removalPending = true;
          member.removalError = cleanError(error);
          member.accessStatus = 'removal_pending';
          member.accessError = cleanError(error);
        }
        workUnit.updatedAt = util.nowIso();
        addAudit(state, actor, 'team.member_removal_error', {
          workUnitId: workUnit.id,
          userId: userId,
          error: cleanError(error)
        });
      });
      throw new util.AppError('GitHub access could not be revoked. The removal is saved as pending and can be retried.', 502, 'member_removal_failed');
    }

    return this.store.transaction(function finalizeRemoval(state) {
      const workUnit = findWorkUnit(state, workUnitId);
      if (!workUnit || workUnit.kind !== 'team') {
        throw new util.AppError('Team not found.', 404, 'team_not_found');
      }
      const index = workUnit.members.findIndex(function member(item) { return item.userId === userId; });
      if (index === -1) {
        throw new util.AppError('Team member not found.', 404, 'member_not_found');
      }
      const removed = workUnit.members.splice(index, 1)[0];
      if (removed.role === 'owner' && workUnit.members.length) {
        workUnit.members[0].role = 'owner';
      }
      const now = util.nowIso();
      workUnit.requests.forEach(function closeApproved(request) {
        if (request.userId === userId && request.status === 'approved') {
          request.status = 'removed';
          request.resolvedAt = now;
          request.resolvedBy = actor;
        }
      });
      workUnit.updatedAt = now;
      if (workUnit.repoId !== null) {
        workUnit.repoStatus = visibilityError ? 'error' : 'ready';
        workUnit.repoError = visibilityError;
      }
      addAudit(state, actor, 'team.member_removed', {
        workUnitId: workUnit.id,
        userId: userId,
        login: existingUser.login
      });
      return enrichWorkUnit(state, workUnit);
    });
  }

  releaseWorkUnit(workUnitId, actor) {
    const service = this;
    return this.withWorkUnitLock(workUnitId, function releaseLocked() {
      return service.performReleaseWorkUnit(workUnitId, actor);
    });
  }

  async performReleaseWorkUnit(workUnitId, actor) {
    const reservation = await this.store.transaction(function reserveRelease(state) {
      const workUnit = findWorkUnit(state, workUnitId);
      if (!workUnit) {
        throw new util.AppError('Repository record not found.', 404, 'work_unit_not_found');
      }
      if (workUnit.lifecycle === 'released') {
        return { alreadyReleased: true, workUnit: enrichWorkUnit(state, workUnit), members: [] };
      }
      if (workUnit.lifecycle !== 'release_pending') {
        workUnit.lifecycle = 'release_pending';
        workUnit.releaseError = '';
        workUnit.updatedAt = util.nowIso();
        addAudit(state, actor, 'work_unit.release_started', {
          workUnitId: workUnit.id,
          repoName: workUnit.repoName
        });
      }
      return {
        alreadyReleased: false,
        workUnit: util.clone(workUnit),
        members: workUnit.members.map(function releaseMember(member) {
          return {
            userId: member.userId,
            accessStatus: member.accessStatus
          };
        })
      };
    });
    if (reservation.alreadyReleased) {
      return reservation.workUnit;
    }

    let visibilityError = '';
    try {
      if (reservation.workUnit.repoId !== null) {
        const repository = await this.verifyManagedRepository(reservation.workUnit, false, true);
        if (!repository.private) {
          visibilityError = 'The managed repository is public. Restore private visibility in GitHub immediately.';
          await this.store.transaction(function markPublic(state) {
            const workUnit = findWorkUnit(state, workUnitId);
            if (workUnit) {
              workUnit.repoStatus = 'error';
              workUnit.repoError = visibilityError;
              workUnit.updatedAt = util.nowIso();
              addAudit(state, actor, 'repository.visibility_error', {
                workUnitId: workUnit.id,
                visibility: 'public'
              });
            }
          });
        }
        const revocationErrors = [];
        for (let index = 0; index < reservation.members.length; index += 1) {
          const releaseMember = reservation.members[index];
          if (releaseMember.accessStatus === 'revoked') {
            continue;
          }
          let revocationError = null;
          let reason = 'access_removed';
          try {
            let currentUser = null;
            try {
              currentUser = await this.refreshGitHubIdentity(releaseMember.userId, true);
            } catch (identityError) {
              if (isNotFoundError(identityError)) {
                reason = 'account_missing';
              } else {
                throw identityError;
              }
            }
            if (currentUser) {
              await this.github.removeCollaborator(reservation.workUnit.repoName, currentUser.login);
            }
          } catch (memberError) {
            revocationError = memberError;
          }
          await this.store.transaction(function recordRevocation(state) {
            const workUnit = findWorkUnit(state, workUnitId);
            if (!workUnit) {
              return;
            }
            const member = workUnit.members.find(function matchingMember(item) {
              return item.userId === releaseMember.userId;
            });
            if (!member) {
              return;
            }
            member.accessStatus = revocationError ? 'revocation_error' : 'revoked';
            member.accessError = revocationError ? cleanError(revocationError) : '';
            workUnit.updatedAt = util.nowIso();
            addAudit(state, actor, revocationError ? 'repository.access_revocation_error' : 'repository.access_revoked', {
              workUnitId: workUnit.id,
              userId: releaseMember.userId,
              reason: revocationError ? cleanError(revocationError) : reason
            });
          });
          if (revocationError) {
            revocationErrors.push(releaseMember.userId + ': ' + cleanError(revocationError));
          }
        }
        if (revocationErrors.length) {
          throw new Error(revocationErrors.join('; '));
        }
      }
    } catch (error) {
      await this.store.transaction(function releaseFailed(state) {
        const workUnit = findWorkUnit(state, workUnitId);
        if (!workUnit) {
          return;
        }
        workUnit.lifecycle = 'release_pending';
        workUnit.releaseError = cleanError(error);
        workUnit.updatedAt = util.nowIso();
        addAudit(state, actor, 'work_unit.release_error', {
          workUnitId: workUnit.id,
          error: workUnit.releaseError
        });
      });
      throw new util.AppError('The assignment claim is pending release because GitHub access could not be fully revoked. Retry from the staff console.', 502, 'release_failed');
    }

    return this.store.transaction(function finalizeRelease(state) {
      const workUnit = findWorkUnit(state, workUnitId);
      if (!workUnit) {
        throw new util.AppError('Repository record not found.', 404, 'work_unit_not_found');
      }
      const now = util.nowIso();
      workUnit.lifecycle = 'released';
      workUnit.releasedAt = now;
      workUnit.releasedBy = actor;
      workUnit.releaseError = '';
      if (workUnit.repoId !== null) {
        workUnit.repoStatus = visibilityError ? 'error' : 'ready';
        workUnit.repoError = visibilityError;
      }
      workUnit.members.forEach(function revoke(member) {
        member.accessStatus = 'revoked';
        member.accessError = '';
        member.removalPending = false;
        member.removalError = '';
      });
      workUnit.requests.forEach(function closePending(request) {
        if (request.status === 'pending') {
          request.status = 'cancelled';
          request.resolvedAt = now;
          request.resolvedBy = actor;
        }
      });
      workUnit.updatedAt = now;
      addAudit(state, actor, 'work_unit.released', {
        workUnitId: workUnit.id,
        repoName: workUnit.repoName,
        preserved: true
      });
      return enrichWorkUnit(state, workUnit);
    });
  }

  async getWorkUnit(workUnitId) {
    const state = await this.store.snapshot();
    const workUnit = findWorkUnit(state, workUnitId);
    return workUnit ? enrichWorkUnit(state, workUnit) : null;
  }

  async getDashboard(userId) {
    const state = await this.store.snapshot();
    const user = state.users[userId];
    if (!user) {
      throw new util.AppError('Please sign in again.', 401, 'login_required');
    }
    const assignments = state.assignments.slice().sort(function byCreated(left, right) {
      return left.createdAt.localeCompare(right.createdAt);
    }).map(function summarize(assignment) {
      const own = state.workUnits.find(function membership(workUnit) {
        return claimsAssignment(workUnit) && workUnit.assignmentId === assignment.id && workUnit.members.some(function member(item) {
          return item.userId === userId;
        });
      });
      let outgoing = null;
      state.workUnits.some(function findPending(workUnit) {
        if (!isActiveWorkUnit(workUnit) || workUnit.assignmentId !== assignment.id) {
          return false;
        }
        const request = workUnit.requests.find(function pending(item) {
          return item.userId === userId && item.status === 'pending';
        });
        if (request) {
          outgoing = Object.assign(util.clone(request), {
            workUnitId: workUnit.id,
            teamName: workUnit.displayName
          });
          return true;
        }
        return false;
      });
      return {
        assignment: util.clone(assignment),
        workUnit: own ? enrichWorkUnit(state, own) : null,
        outgoingRequest: outgoing,
        resolvedRequest: recentResolvedRequest(state, assignment.id, userId)
      };
    });
    return { user: util.clone(user), assignments: assignments };
  }

  async getAssignmentView(assignmentSlug, userId) {
    const state = await this.store.snapshot();
    const assignment = findAssignment(state, assignmentSlug);
    if (!assignment) {
      throw new util.AppError('Assignment not found.', 404, 'assignment_not_found');
    }
    const own = state.workUnits.find(function membership(workUnit) {
      return claimsAssignment(workUnit) && workUnit.assignmentId === assignment.id && workUnit.members.some(function member(item) {
        return item.userId === userId;
      });
    });
    let outgoing = null;
    const teams = state.workUnits.filter(function teamsForAssignment(workUnit) {
      return isActiveWorkUnit(workUnit) && workUnit.assignmentId === assignment.id && workUnit.kind === 'team';
    }).map(function summarizeTeam(workUnit) {
      const enriched = enrichWorkUnit(state, workUnit);
      const pending = enriched.requests.find(function request(item) {
        return item.userId === userId && item.status === 'pending';
      });
      if (pending) {
        outgoing = Object.assign(util.clone(pending), {
          workUnitId: workUnit.id,
          teamName: workUnit.displayName
        });
      }
      delete enriched.joinCode;
      return enriched;
    });
    return {
      user: util.clone(state.users[userId]),
      assignment: util.clone(assignment),
      workUnit: own ? enrichWorkUnit(state, own) : null,
      outgoingRequest: outgoing,
      resolvedRequest: recentResolvedRequest(state, assignment.id, userId),
      teams: teams
    };
  }

  async getTeamView(assignmentSlug, workUnitId, userId) {
    const state = await this.store.snapshot();
    const assignment = findAssignment(state, assignmentSlug);
    const workUnit = findWorkUnit(state, workUnitId);
    if (!assignment || !workUnit || !isActiveWorkUnit(workUnit) || workUnit.assignmentId !== assignment.id || workUnit.kind !== 'team') {
      throw new util.AppError('Team not found.', 404, 'team_not_found');
    }
    const enriched = enrichWorkUnit(state, workUnit);
    const isMember = workUnit.members.some(function member(item) { return item.userId === userId; });
    const pendingRequest = enriched.requests.find(function pending(item) {
      return item.userId === userId && item.status === 'pending';
    }) || null;
    const existingWorkUnit = state.workUnits.find(function membership(unit) {
      return claimsAssignment(unit) && unit.assignmentId === assignment.id && unit.members.some(function member(item) {
        return item.userId === userId;
      });
    });
    const pendingElsewhere = state.workUnits.some(function pending(unit) {
      return isActiveWorkUnit(unit) && unit.assignmentId === assignment.id && unit.id !== workUnit.id && unit.requests.some(function request(item) {
        return item.userId === userId && item.status === 'pending';
      });
    });
    let requestBlockReason = '';
    if (!isMember && !pendingRequest) {
      if (!state.users[userId] || state.users[userId].membershipState !== 'active') {
        requestBlockReason = 'Your course organization membership must be active before joining a team.';
      } else if (assignment.status !== 'open') {
        requestBlockReason = 'This assignment is closed.';
      } else if (existingWorkUnit) {
        requestBlockReason = 'You already have a repository for this assignment.';
      } else if (pendingElsewhere) {
        requestBlockReason = 'You already have a pending request to join another team for this assignment.';
      } else if (workUnit.members.length >= assignment.maxTeamSize) {
        requestBlockReason = 'This team is full.';
      }
    }
    if (!isMember) {
      delete enriched.joinCode;
    }
    return {
      user: util.clone(state.users[userId]),
      assignment: util.clone(assignment),
      workUnit: enriched,
      isMember: isMember,
      pendingRequest: pendingRequest,
      canRequest: !isMember && !pendingRequest && !requestBlockReason,
      requestBlockReason: requestBlockReason
    };
  }

  async getAdminView() {
    const state = await this.store.snapshot();
    return {
      assignments: state.assignments.slice().sort(function sort(left, right) {
        return left.createdAt.localeCompare(right.createdAt);
      }).map(function assignmentWithState(assignment) {
        const result = util.clone(assignment);
        result.locked = state.workUnits.some(function hasWorkUnit(workUnit) {
          return workUnit.assignmentId === assignment.id &&
            (claimsAssignment(workUnit) || workUnit.repoId !== null);
        });
        return result;
      }),
      workUnits: state.workUnits.slice().sort(function sort(left, right) {
        return right.createdAt.localeCompare(left.createdAt);
      }).map(function enrich(workUnit) {
        const result = enrichWorkUnit(state, workUnit);
        result.assignment = util.clone(findAssignment(state, workUnit.assignmentId));
        return result;
      }),
      users: util.clone(state.users),
      audit: state.audit.slice(-50).reverse()
    };
  }
}

module.exports = {
  Repo184Service: Repo184Service,
  enrichWorkUnit: enrichWorkUnit,
  findAssignment: findAssignment,
  findRequest: findRequest,
  findWorkUnit: findWorkUnit
};
