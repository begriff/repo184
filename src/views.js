'use strict';

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function csrfField(token) {
  return '<input type="hidden" name="csrf" value="' + escapeHtml(token || '') + '">';
}

function statusLabel(status) {
  const clean = String(status || 'unknown').replace(/_/g, ' ');
  return '<span class="status status-' + escapeHtml(status || 'unknown') + '">' + escapeHtml(clean) + '</span>';
}

function flashHtml(flash) {
  if (!flash || !flash.message) {
    return '';
  }
  const type = flash.type === 'error' ? 'error' : (flash.type === 'success' ? 'success' : 'info');
  return '<div class="notice notice-' + type + '" role="status">' + escapeHtml(flash.message) + '</div>';
}

function page(options) {
  const title = options.title || 'Repo184';
  const basePath = options.basePath || '/repo';
  const baseUrl = options.baseUrl || '';
  const user = options.user;
  let navigation = '<nav aria-label="Site"><a href="' + basePath + '/">Assignments</a>';
  if (options.admin) {
    navigation += '<a href="' + basePath + '/admin">Staff</a>' +
      '<form method="post" action="' + basePath + '/admin/logout" class="inline-form">' +
      csrfField(options.csrf) + '<button class="link-button" type="submit">Staff sign out</button></form>';
  }
  if (user) {
    navigation += '<span class="nav-user">@' + escapeHtml(user.login) + '</span>' +
      '<form method="post" action="' + basePath + '/logout" class="inline-form">' +
      csrfField(options.csrf) + '<button class="link-button" type="submit">Sign out</button></form>';
  }
  navigation += '</nav>';

  return '<!doctype html>' +
    '<html lang="en"><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeHtml(title) + ' · Repo184</title>' +
    '<meta name="description" content="Create private CS 184/284A assignment repositories.">' +
    '<link rel="stylesheet" href="' + basePath + '/assets/styles.css">' +
    '</head><body>' +
    '<header class="site-header"><div class="shell header-row">' +
    '<a class="wordmark" href="' + basePath + '/">Repo184</a>' + navigation +
    '</div></header>' +
    '<main class="shell">' + flashHtml(options.flash) + (options.body || '') + '</main>' +
    '<footer class="shell site-footer">CS 184/284A · UC Berkeley</footer>' +
    '</body></html>';
}

function loginPage(options) {
  const basePath = options.basePath;
  const devLogin = options.devFakeGithub
    ? '<details class="dev-panel"><summary>Development login</summary>' +
      '<form method="get" action="' + basePath + '/auth/dev" class="stack compact">' +
      '<label for="dev-user">GitHub username</label>' +
      '<input id="dev-user" name="user" value="student-one" required pattern="[A-Za-z0-9-]{1,39}">' +
      '<button type="submit" class="button secondary">Continue as test user</button>' +
      '</form></details>'
    : '';

  return page(Object.assign({}, options, {
    title: 'Assignment repositories',
    body:
      '<section class="intro">' +
      '<a class="button github-button" href="' + basePath + '/auth/github">' +
      '<span aria-hidden="true">GH</span> Sign in with GitHub</a>' +
      '</section>' + devLogin,
    user: null
  }));
}

function membershipNotice(options) {
  const user = options.user;
  if (user.membershipState === 'active') {
    return '<div class="notice notice-success"><strong>Organization access is active.</strong> Your GitHub account belongs to ' +
      escapeHtml(options.githubOrg) + '.</div>';
  }
  const invitationUrl = 'https://github.com/orgs/' + encodeURIComponent(options.githubOrg) + '/invitation';
  if (user.membershipState === 'pending') {
    return '<div class="notice notice-info"><strong>Your invitation to ' + escapeHtml(options.githubOrg) + ' is pending.</strong> ' +
      'Accept it on GitHub before creating or joining a repository.' +
      '<div class="button-row"><a class="button small" href="' + escapeHtml(invitationUrl) + '">Accept invitation on GitHub</a>' +
      '<form method="post" action="' + options.basePath + '/org/retry">' + csrfField(options.csrf) +
      '<button type="submit" class="button secondary small">Check again</button></form></div></div>';
  }
  if (user.membershipState === 'absent') {
    return '<div class="notice notice-error"><strong>No current invitation to ' + escapeHtml(options.githubOrg) + ' was found.</strong> ' +
      '<form method="post" action="' + options.basePath + '/org/invite" class="inline-form">' + csrfField(options.csrf) +
      '<button type="submit" class="link-button">Send a new invitation</button></form></div>';
  }
  return '<div class="notice notice-error"><strong>Organization access is ' + escapeHtml(user.membershipState) + '.</strong> ' +
    'Repository creation is paused until GitHub reports an active membership. ' +
    '<form method="post" action="' + options.basePath + '/org/retry" class="inline-form">' + csrfField(options.csrf) +
    '<button type="submit" class="link-button">Check again</button></form> or ' +
    '<a href="' + options.basePath + '/auth/github">reconnect GitHub</a>.</div>';
}

function memberList(workUnit) {
  return '<ul class="plain-list">' + workUnit.members.map(function member(item) {
    return '<li><a href="' + escapeHtml(item.user.profileUrl) + '">@' + escapeHtml(item.user.login) + '</a> ' +
      statusLabel(item.accessStatus) + (item.accessError ? '<div class="field-error">' + escapeHtml(item.accessError) + '</div>' : '') + '</li>';
  }).join('') + '</ul>';
}

function currentMember(workUnit, user) {
  if (!user) {
    return null;
  }
  return workUnit.members.find(function matchingMember(member) {
    return member.userId === user.id;
  }) || null;
}

function homeworkUrl(options) {
  if (!options.courseHomeworkUrl || !options.assignment) {
    return '';
  }
  return String(options.courseHomeworkUrl).replace(/\/?$/, '/') + encodeURIComponent(options.assignment.slug) + '/';
}

function joinRequests(options, workUnit, canResolve, adminMode) {
  const pending = workUnit.requests.filter(function pendingRequest(request) {
    return request.status === 'pending';
  });
  if (!pending.length) {
    return '';
  }
  const prefix = adminMode ? options.basePath + '/admin/join-requests/' : options.basePath + '/join-requests/';
  return '<div class="request-box"><h4>Pending join requests</h4>' + pending.map(function request(item) {
    const controls = canResolve
      ? '<div class="button-row"><form method="post" action="' + prefix + escapeHtml(item.id) + '/approve">' +
        csrfField(options.csrf) + '<button class="button small" type="submit">Approve</button></form>' +
        '<form method="post" action="' + prefix + escapeHtml(item.id) + '/reject">' + csrfField(options.csrf) +
        '<button class="button secondary small" type="submit">Reject</button></form></div>'
      : '';
    return '<div class="request-row"><span><strong>@' + escapeHtml(item.user.login) + '</strong> requested to join</span>' + controls + '</div>';
  }).join('') + '</div>';
}

function repositoryPanel(options, workUnit, allowRetry, adminMode) {
  let content;
  const viewingMember = currentMember(workUnit, options.user);
  const accessReady = adminMode || !viewingMember || viewingMember.accessStatus === 'ready';
  if (workUnit.repoError) {
    content = '<div class="notice notice-error"><strong>GitHub verification failed.</strong> ' +
      escapeHtml(workUnit.repoError) + '</div>';
  } else if (workUnit.repoStatus === 'ready' && accessReady) {
    content = '<p><a class="button" href="' + escapeHtml(workUnit.repoHtmlUrl) + '">Open private repository</a></p>' +
      '<dl class="repo-details"><dt>HTTPS clone</dt><dd><code>' + escapeHtml(workUnit.repoCloneUrl) + '</code></dd>' +
      '<dt>SSH clone</dt><dd><code>' + escapeHtml(workUnit.repoSshUrl) + '</code></dd></dl>';
  } else if (workUnit.repoStatus === 'ready') {
    content = '<div class="notice notice-error"><strong>The private repository exists, but your access is ' +
      escapeHtml(viewingMember.accessStatus.replace(/_/g, ' ')) + '.</strong> ' +
      (viewingMember.accessError ? escapeHtml(viewingMember.accessError) : 'Retry the GitHub sync or ask staff for help.') + '</div>';
  } else if (workUnit.repoStatus === 'error') {
    content = '<p class="field-error"><strong>GitHub setup failed:</strong> ' + escapeHtml(workUnit.repoError) + '</p>';
  } else {
    content = '<p>GitHub is creating this repository. Refresh this page shortly.</p>';
  }
  content = '<div class="repository-entry"><div class="section-heading"><h4>Private code repository</h4>' +
    statusLabel(workUnit.repoError ? 'verification_error' : workUnit.repoStatus) + '</div>' + content + '</div>';
  if (workUnit.writeupEnabled) {
    let writeupContent;
    if (workUnit.writeupRepoError) {
      writeupContent = '<div class="notice notice-error"><strong>Write-up repository verification failed.</strong> ' +
        escapeHtml(workUnit.writeupRepoError) + '</div>';
    } else if (workUnit.writeupRepoStatus === 'ready') {
      writeupContent = '<div class="button-row"><a class="button secondary small" href="' +
        escapeHtml(workUnit.writeupRepoHtmlUrl) + '">Open public write-up repository</a>' +
        (workUnit.writeupPagesStatus === 'ready' && workUnit.writeupPagesUrl
          ? '<a class="button secondary small" href="' + escapeHtml(workUnit.writeupPagesUrl) + '">View published write-up</a>'
          : '') + '</div>';
      if (!accessReady) {
        writeupContent += '<p class="field-error">Your push access is ' +
          escapeHtml(viewingMember.accessStatus.replace(/_/g, ' ')) + '.</p>';
      }
      if (workUnit.writeupPagesError) {
        writeupContent += '<p class="field-error"><strong>GitHub Pages setup failed:</strong> ' +
          escapeHtml(workUnit.writeupPagesError) + '</p>';
      } else if (workUnit.writeupPagesStatus !== 'ready') {
        writeupContent += '<p>GitHub Pages is being enabled from the repository root.</p>';
      }
    } else {
      writeupContent = '<p>GitHub is creating the public write-up repository. Refresh this page shortly.</p>';
    }
    content += '<div class="repository-entry"><div class="section-heading"><h4>Public write-up repository</h4>' +
      statusLabel(workUnit.writeupRepoError ? 'verification_error' : workUnit.writeupRepoStatus) +
      '</div>' + writeupContent + '</div>';
  }
  const needsRetry = Boolean(workUnit.repoError) || workUnit.repoStatus !== 'ready' ||
    (workUnit.writeupEnabled && (Boolean(workUnit.writeupRepoError) || workUnit.writeupRepoStatus !== 'ready' ||
      workUnit.writeupPagesStatus !== 'ready')) || workUnit.members.some(function accessPending(member) {
    return member.accessStatus !== 'ready';
  });
  if (allowRetry && needsRetry) {
    const retryPath = adminMode
      ? options.basePath + '/admin/work-units/' + workUnit.id + '/retry'
      : options.basePath + '/work-units/' + workUnit.id + '/retry';
    content += '<form method="post" action="' + retryPath + '">' + csrfField(options.csrf) +
      '<button type="submit" class="button secondary small">Retry GitHub sync</button></form>';
  }
  const instructions = !adminMode && homeworkUrl(options)
    ? '<p class="muted workflow-note">Repo184 only creates the repository. Follow the <a href="' + escapeHtml(homeworkUrl(options)) +
      '">homework instructions</a> for Gradescope submission and write-up requirements.</p>' : '';
  return '<section class="repo-panel"><h3>Repositories</h3>' + content + instructions + '</section>';
}

function workUnitPanel(options, workUnit, canResolve, adminMode) {
  const assignment = options.assignment;
  const teamLink = options.basePath + '/assignments/' + assignment.slug + '/teams/' + workUnit.id;
  const releaseNotice = workUnit.lifecycle === 'release_pending'
    ? '<div class="notice notice-info">Staff are releasing this assignment claim. Repository actions are paused until that finishes.</div>' : '';
  return '<section class="panel">' + releaseNotice +
    '<div class="section-heading"><div><p class="eyebrow">Team</p><h2>' +
    '<a href="' + teamLink + '">' + escapeHtml(workUnit.displayName) + '</a>' +
    '</h2></div><code>' + escapeHtml(workUnit.repoName) + '</code></div>' +
    '<h3>Members</h3>' + memberList(workUnit) +
    joinRequests(options, workUnit, canResolve, adminMode) +
    (workUnit.lifecycle === 'release_pending' ? '' : repositoryPanel(options, workUnit, true, adminMode)) +
    '</section>';
}

function outgoingRequest(options, request) {
  return '<div class="notice notice-info">Your request to join <strong>' + escapeHtml(request.teamName) + '</strong> is waiting for approval. ' +
    '<form method="post" action="' + options.basePath + '/join-requests/' + escapeHtml(request.id) + '/cancel" class="inline-form">' +
    csrfField(options.csrf) + '<button type="submit" class="link-button">Cancel request</button></form></div>';
}

function resolvedRequestNotice(request) {
  if (!request) {
    return '';
  }
  let message = 'Your request to join <strong>' + escapeHtml(request.teamName) + '</strong> was not approved. You may choose another team or create your own.';
  if (request.status === 'removed') {
    message = 'Staff removed you from <strong>' + escapeHtml(request.teamName) + '</strong>. You may choose another team or create your own.';
  } else if (request.resolvedBy === 'team-full') {
    message = 'Your request to join <strong>' + escapeHtml(request.teamName) + '</strong> closed because the team filled. You may choose another team or create your own.';
  }
  return '<div class="notice notice-info">' + message + '</div>';
}

function dashboardPage(options) {
  const items = options.dashboard.assignments.map(function assignmentRow(row) {
    const assignment = row.assignment;
    let detail;
    if (row.workUnit) {
      const member = currentMember(row.workUnit, options.user);
      const writeupReady = !row.workUnit.writeupEnabled ||
        (row.workUnit.writeupRepoStatus === 'ready' && !row.workUnit.writeupRepoError &&
          row.workUnit.writeupPagesStatus === 'ready' && !row.workUnit.writeupPagesError);
      const repositoryError = row.workUnit.repoError || row.workUnit.writeupRepoError || row.workUnit.writeupPagesError;
      const repositoryStatus = repositoryError
        ? 'verification_error'
        : (row.workUnit.writeupEnabled && !writeupReady ? 'provisioning' : row.workUnit.repoStatus);
      const ready = row.workUnit.repoStatus === 'ready' && !row.workUnit.repoError && writeupReady && member && member.accessStatus === 'ready';
      detail = '<p><strong>' + escapeHtml(row.workUnit.displayName) + '</strong> · ' +
        statusLabel(row.workUnit.lifecycle === 'release_pending' ? 'release_pending' :
          repositoryStatus) +
        (member && member.accessStatus !== 'ready' ? ' ' + statusLabel('access_' + member.accessStatus) : '') + '</p>' +
        (ready && row.workUnit.lifecycle !== 'release_pending' ? '<p><a href="' + escapeHtml(row.workUnit.repoHtmlUrl) + '">Open code repository</a>' +
          (row.workUnit.writeupEnabled ? ' · <a href="' + escapeHtml(row.workUnit.writeupRepoHtmlUrl) + '">Open write-up repository</a>' : '') + '</p>' :
          '<p><a href="' + options.basePath + '/assignments/' + assignment.slug + '">View setup status</a></p>') +
        joinRequests(Object.assign({}, options, { assignment: assignment }), row.workUnit, true, false);
    } else if (row.outgoingRequest) {
      detail = outgoingRequest(options, row.outgoingRequest);
    } else if (assignment.status === 'open' && options.user.membershipState === 'active') {
      detail = resolvedRequestNotice(row.resolvedRequest) +
        '<p><a class="button small" href="' + options.basePath + '/assignments/' + assignment.slug + '">Set up repository</a></p>';
    } else {
      detail = resolvedRequestNotice(row.resolvedRequest) + '<p class="muted">No repository assigned.</p>';
    }
    return '<article class="assignment-row"><div class="assignment-title"><h2><a href="' + options.basePath + '/assignments/' + assignment.slug + '">' +
      escapeHtml(assignment.title) + '</a></h2>' + statusLabel(assignment.status) + '</div>' +
      '<p class="muted">' + (assignment.maxTeamSize === 1 ? 'Team size: 1 student' : 'Team size: up to 2 students') +
      '</p>' + detail + '</article>';
  }).join('');

  return page(Object.assign({}, options, {
    title: 'Assignments',
    body: '<section class="page-heading"><p class="eyebrow">CS 184/284A</p><h1>Assignments</h1>' +
      '<p class="lede">Signed in as @' + escapeHtml(options.user.login) + '.</p></section>' +
      membershipNotice(options) +
      '<section class="assignment-list">' + (items || '<div class="empty-state"><h2>No assignments yet</h2><p>Staff have not opened any assignments.</p></div>') + '</section>'
  }));
}

function assignmentPage(options) {
  const assignment = options.assignment;
  const organizationNotice = options.user.membershipState === 'active' ? '' : membershipNotice(options);
  let content;
  if (options.workUnit) {
    content = workUnitPanel(options, options.workUnit, true, false);
  } else {
    const blocked = options.outgoingRequest
      ? outgoingRequest(options, options.outgoingRequest)
      : resolvedRequestNotice(options.resolvedRequest);
    let create = '';
    if (assignment.status === 'open' && options.user.membershipState === 'active' && !options.outgoingRequest) {
      create = '<section class="panel"><h2>Create a team</h2>' +
        (assignment.maxTeamSize === 1 ? '<p>Create a one-student team and its private repository.</p>' : '') +
        '<form method="post" action="' + options.basePath + '/assignments/' + assignment.slug + '/teams" class="stack">' +
        csrfField(options.csrf) + '<label for="team-name">Team name</label>' +
        '<input id="team-name" name="teamName" minlength="2" maxlength="40" required placeholder="e.g. ray-tracers">' +
        '<button class="button" type="submit">Create team repository</button></form></section>';
    } else if (assignment.status !== 'open') {
      create = '<div class="notice notice-info">This assignment is closed.</div>';
    }

    let teams = '';
    if (assignment.maxTeamSize === 2) {
      const rows = options.teams.map(function teamRow(team) {
        const members = team.members.map(function login(member) { return '@' + member.user.login; }).join(', ');
        return '<li><div><strong><a href="' + options.basePath + '/assignments/' + assignment.slug + '/teams/' + team.id + '">' +
          escapeHtml(team.displayName) + '</a></strong><br><span class="muted">' + escapeHtml(members) + ' · ' + team.members.length + '/2</span></div>' +
          (team.members.length < 2 ? '<a href="' + options.basePath + '/assignments/' + assignment.slug + '/teams/' + team.id + '">View team</a>' : statusLabel('full')) + '</li>';
      }).join('');
      teams = '<section class="panel"><h2>Join an existing team</h2>' +
        (rows ? '<ul class="team-list">' + rows + '</ul>' : '<p class="muted">No teams have been created yet.</p>') + '</section>';
    }
    content = blocked + create + teams;
  }

  return page(Object.assign({}, options, {
    title: assignment.title,
    body: '<p class="back-link"><a href="' + options.basePath + '/">← All assignments</a></p>' +
      '<section class="page-heading"><div class="section-heading"><div><p class="eyebrow">' + statusLabel(assignment.status) + '</p>' +
      '<h1>' + escapeHtml(assignment.title) + '</h1></div></div></section>' + organizationNotice + content
  }));
}

function teamPage(options) {
  const team = options.workUnit;
  const organizationNotice = options.user.membershipState === 'active' ? '' : membershipNotice(options);
  let action = '';
  if (!options.isMember) {
    if (options.pendingRequest) {
      action = outgoingRequest(options, Object.assign({}, options.pendingRequest, { teamName: team.displayName }));
    } else if (options.canRequest) {
      action = '<form method="post" action="' + options.basePath + '/assignments/' + options.assignment.slug + '/teams/' + team.id + '/request">' +
        csrfField(options.csrf) + '<button class="button" type="submit">Request to join this team</button></form>';
    } else if (options.requestBlockReason && options.user.membershipState === 'active') {
      action = '<div class="notice notice-info">' + escapeHtml(options.requestBlockReason) + '</div>';
    }
  } else {
    action = '<div class="notice notice-info"><strong>Share this team page with your partner:</strong><br><code>' +
      escapeHtml(options.baseUrl + '/assignments/' + options.assignment.slug + '/teams/' + team.id) + '</code></div>';
  }
  return page(Object.assign({}, options, {
    title: team.displayName,
    body: '<p class="back-link"><a href="' + options.basePath + '/assignments/' + options.assignment.slug + '">← ' + escapeHtml(options.assignment.title) + '</a></p>' +
      '<section class="page-heading"><p class="eyebrow">Team</p><h1>' + escapeHtml(team.displayName) + '</h1>' +
      '<p class="lede">' + team.members.length + ' of ' + options.assignment.maxTeamSize + ' places filled.</p></section>' + organizationNotice + action +
      '<section class="panel"><h2>Members</h2>' + memberList(team) +
      joinRequests(options, team, options.isMember, false) + '</section>' +
      (options.isMember ? repositoryPanel(options, team, true, false) : '')
  }));
}

function adminLoginPage(options) {
  return page(Object.assign({}, options, {
    title: 'Staff sign in',
    body: '<section class="narrow"><p class="eyebrow">Staff</p><h1>Repo184 administration</h1>' +
      '<form method="post" action="' + options.basePath + '/admin/login" class="stack panel">' + csrfField(options.csrf) +
      '<label for="password">Admin password</label><input id="password" name="password" type="password" autocomplete="current-password" required>' +
      '<button class="button" type="submit">Sign in</button></form></section>'
  }));
}

function assignmentForm(options, assignment) {
  const isNew = !assignment;
  const value = assignment || { slug: '', title: '', templateFullName: '', generateWriteupRepo: false, writeupTemplateFullName: '', repoPrefix: '', maxTeamSize: 2, status: 'closed' };
  const locked = Boolean(assignment && assignment.locked);
  const readOnly = locked ? ' readonly' : '';
  const action = isNew ? options.basePath + '/admin/assignments' : options.basePath + '/admin/assignments/' + assignment.id;
  return '<form method="post" action="' + action + '" class="admin-form">' + csrfField(options.csrf) +
    (locked ? '<p class="form-note">Slug, templates, write-up repository setting, repository prefix, and team size are locked because an active claim or managed repository exists.</p>' : '') +
    '<div><label>Slug</label><input name="slug" value="' + escapeHtml(value.slug) + '" required maxlength="32" placeholder="hw1"' + readOnly + '></div>' +
    '<div><label>Title</label><input name="title" value="' + escapeHtml(value.title) + '" required maxlength="80" placeholder="Homework 1"></div>' +
    '<div><label>Template repository</label><input name="template" value="' + escapeHtml(value.templateFullName) + '" required placeholder="organization/hw1-template"' + readOnly + '></div>' +
    '<div><label class="check-row"><input type="checkbox" value="1"' +
      (locked ? ' disabled' : ' name="generateWriteupRepo"') + (value.generateWriteupRepo ? ' checked' : '') +
      '> Generate a public write-up repository</label>' +
      (locked ? '<input type="hidden" name="generateWriteupRepo" value="' + (value.generateWriteupRepo ? '1' : '0') + '">' : '') + '</div>' +
    '<div><label>Write-up template repository</label><input name="writeupTemplate" value="' +
      escapeHtml(value.writeupTemplateFullName) + '" placeholder="organization/hw1-writeup-template"' + readOnly +
      '><span class="muted">Required when public write-up repositories are enabled.</span></div>' +
    '<div><label>Repository prefix</label><input name="repoPrefix" value="' + escapeHtml(value.repoPrefix) + '" required maxlength="48" placeholder="hw1"' + readOnly + '></div>' +
    '<div><label>Maximum team size</label><select' + (locked ? ' disabled' : ' name="maxTeamSize"') + '><option value="1"' + (value.maxTeamSize === 1 ? ' selected' : '') + '>1 student</option><option value="2"' + (value.maxTeamSize === 2 ? ' selected' : '') + '>2 students</option></select>' +
    (locked ? '<input type="hidden" name="maxTeamSize" value="' + escapeHtml(value.maxTeamSize) + '">' : '') + '</div>' +
    '<div><label>Status</label><select name="status"><option value="closed"' + (value.status === 'closed' ? ' selected' : '') + '>Closed</option><option value="open"' + (value.status === 'open' ? ' selected' : '') + '>Open</option></select></div>' +
    '<div class="form-submit"><button class="button small" type="submit">' + (isNew ? 'Add assignment' : 'Save changes') + '</button></div></form>';
}

function adminWorkUnit(options, workUnit) {
  const pending = joinRequests(options, workUnit, true, true);
  const active = !workUnit.lifecycle || workUnit.lifecycle === 'active';
  const deleting = workUnit.lifecycle === 'deletion_pending';
  const rename = active && workUnit.kind === 'team'
    ? '<form method="post" action="' + options.basePath + '/admin/work-units/' + workUnit.id + '/rename" class="inline-controls">' +
      csrfField(options.csrf) + '<input name="teamName" value="' + escapeHtml(workUnit.displayName) + '" required minlength="2" maxlength="40" aria-label="Team name">' +
      '<button class="button secondary small" type="submit">Rename</button></form>'
    : '';
  const members = '<ul class="plain-list">' + workUnit.members.map(function member(item) {
    const retry = active && item.accessStatus !== 'ready' && !item.removalPending
      ? '<form method="post" action="' + options.basePath + '/admin/work-units/' + workUnit.id + '/members/' + item.userId + '/retry" class="inline-form">' +
        csrfField(options.csrf) + '<button type="submit" class="link-button">Retry access</button></form>' : '';
    const remove = active && workUnit.kind === 'team' && (workUnit.members.length > 1 || item.removalPending)
      ? '<form method="post" action="' + options.basePath + '/admin/work-units/' + workUnit.id + '/members/' + item.userId + '/remove" class="inline-form">' +
        csrfField(options.csrf) + '<button type="submit" class="link-button danger-link">' +
        (item.removalPending ? 'Finish removal' : 'Remove from team') + '</button></form>' : '';
    return '<li>@' + escapeHtml(item.user.login) + ' ' + statusLabel(item.accessStatus) + ' ' + retry + ' ' + remove +
      (item.accessError ? '<div class="field-error">' + escapeHtml(item.accessError) + '</div>' : '') + '</li>';
  }).join('') + '</ul>';
  const addMember = active && workUnit.kind === 'team' && workUnit.members.length < workUnit.assignment.maxTeamSize
    ? '<section><h4>Add existing Repo184 student</h4>' +
      '<p class="form-note">The student must have signed in to Repo184 and accepted the organization invitation.</p>' +
      '<form method="post" action="' + options.basePath + '/admin/work-units/' + workUnit.id + '/members" class="stack compact">' +
      csrfField(options.csrf) + '<label>GitHub username</label>' +
      '<input name="githubLogin" list="repo184-users" required maxlength="39" pattern="[A-Za-z0-9-]{1,39}" placeholder="student-login" autocomplete="off">' +
      '<label class="check-row"><input type="checkbox" name="confirm" value="add" required> Grant this student push access to this team’s repositories.</label>' +
      '<button type="submit" class="button secondary small">Add member</button></form></section>'
    : '';
  const release = deleting ? '' : (workUnit.lifecycle !== 'released'
    ? '<form method="post" action="' + options.basePath + '/admin/work-units/' + workUnit.id + '/release" class="release-form">' +
      csrfField(options.csrf) + '<label class="check-row"><input type="checkbox" name="confirm" value="release" required> Preserve the repositories, revoke direct student access, and let all members choose again.</label>' +
      '<button type="submit" class="button secondary small">' + (workUnit.lifecycle === 'release_pending' ? 'Finish releasing claim' : 'Release assignment claim') + '</button></form>'
    : '<p class="muted">This claim was released. Its repositories are preserved for staff.</p>');
  const deletionProgress = deleting
    ? '<p class="muted">Private code repository: ' + (workUnit.codeDeletedAt ? 'deleted' : 'not yet deleted') +
      (workUnit.writeupEnabled ? ' · Public write-up repository: ' + (workUnit.writeupDeletedAt ? 'deleted' : 'not yet deleted') : '') + '</p>' +
      (workUnit.deletionError ? '<div class="notice notice-error"><strong>Deletion needs a retry.</strong> ' + escapeHtml(workUnit.deletionError) + '</div>' : '')
    : '<p>This permanently deletes the GitHub repositories and removes the team record. This cannot be undone.</p>';
  const deletion = '<section class="danger-zone"><h4>Permanent deletion</h4>' + deletionProgress +
    '<form method="post" action="' + options.basePath + '/admin/work-units/' + workUnit.id + '/delete" class="stack compact">' +
    csrfField(options.csrf) + '<label>Type <code>' + escapeHtml(workUnit.repoName) + '</code> to confirm</label>' +
    '<input name="confirm" required autocomplete="off" aria-label="Repository name confirmation">' +
    '<button type="submit" class="button danger small">' + (deleting ? 'Finish permanent deletion' : 'Delete team and repositories') + '</button></form></section>';
  const writeupError = workUnit.writeupEnabled && (workUnit.writeupRepoError || workUnit.writeupPagesError);
  const writeupPending = workUnit.writeupEnabled &&
    (workUnit.writeupRepoStatus !== 'ready' || workUnit.writeupPagesStatus !== 'ready');
  const summaryStatus = workUnit.lifecycle && workUnit.lifecycle !== 'active'
    ? workUnit.lifecycle
    : (workUnit.repoError || writeupError ? 'verification_error' : (writeupPending ? 'provisioning' : workUnit.repoStatus));
  return '<details class="admin-unit"' + (workUnit.repoStatus === 'error' || writeupError || workUnit.lifecycle === 'release_pending' || deleting || pending ? ' open' : '') + '><summary>' +
    '<strong>' + escapeHtml(workUnit.assignment.slug) + ' · ' + escapeHtml(workUnit.displayName) + '</strong> ' + statusLabel(summaryStatus) +
    ' <span class="muted">' + escapeHtml(workUnit.repoName) + '</span></summary><div class="admin-unit-body">' + rename +
    '<h4>Members</h4>' + members + addMember + (active ? pending : '') + (deleting ? '' : repositoryPanel(options, workUnit, active, true)) + release + deletion + '</div></details>';
}

function adminPage(options) {
  const knownUsers = Object.keys(options.adminView.users || {}).map(function userById(userId) {
    return options.adminView.users[userId];
  }).filter(function activeUser(user) {
    return user && user.membershipState === 'active';
  }).sort(function byLogin(left, right) {
    return left.login.localeCompare(right.login);
  }).map(function userOption(user) {
    return '<option value="' + escapeHtml(user.login) + '"></option>';
  }).join('');
  const userSuggestions = '<datalist id="repo184-users">' + knownUsers + '</datalist>';
  const assignments = options.adminView.assignments.map(function assignment(item) {
    const archiveAction = item.archived ? 'unarchive' : 'archive';
    const archiveLabel = item.archived ? 'Unarchive assignment' : 'Archive assignment';
    const retry = item.retryableCount
      ? '<form method="post" action="' + options.basePath + '/admin/assignments/' + item.id + '/retry-failed">' + csrfField(options.csrf) +
        '<button class="button secondary small" type="submit">Retry ' + escapeHtml(item.retryableCount) + ' failed/pending setup(s)</button></form>'
      : '';
    const deletion = item.workUnitCount === 0
      ? '<section class="danger-zone"><h4>Delete empty assignment</h4><p>This removes only the assignment configuration. Type its slug to confirm.</p>' +
        '<form method="post" action="' + options.basePath + '/admin/assignments/' + item.id + '/delete" class="stack compact">' + csrfField(options.csrf) +
        '<label>Type <code>' + escapeHtml(item.slug) + '</code> to confirm</label><input name="confirm" required autocomplete="off">' +
        '<button class="button danger small" type="submit">Delete assignment</button></form></section>'
      : '<p class="form-note">Delete its ' + escapeHtml(item.workUnitCount) + ' team/repository record(s) before deleting this assignment.</p>';
    return '<details class="admin-assignment"><summary><strong>' + escapeHtml(item.title) + '</strong> ' + statusLabel(item.archived ? 'archived' : item.status) +
      ' <code>' + escapeHtml(item.templateFullName) + '</code>' +
      (item.generateWriteupRepo ? ' + <code>' + escapeHtml(item.writeupTemplateFullName) + '</code>' : '') +
      '</summary>' + assignmentForm(options, item) + '<div class="admin-assignment-controls"><div class="button-row">' +
      '<form method="post" action="' + options.basePath + '/admin/assignments/' + item.id + '/' + archiveAction + '">' + csrfField(options.csrf) +
      '<button class="button secondary small" type="submit">' + archiveLabel + '</button></form>' + retry + '</div>' + deletion + '</div></details>';
  }).join('');
  const units = options.adminView.workUnits.map(function unit(item) { return adminWorkUnit(options, item); }).join('');
  const audit = options.adminView.audit.map(function event(item) {
    const details = item.details || {};
    const detailValues = [details.assignmentSlug || details.slug, details.teamName, details.login, details.repoName, details.writeupRepoName].filter(function present(value, index, values) {
      return value && values.indexOf(value) === index;
    });
    return '<tr><td><time>' + escapeHtml(new Date(item.createdAt).toLocaleString('en-US')) + '</time></td><td>' + escapeHtml(item.actor) + '</td><td><code>' + escapeHtml(item.action) + '</code></td><td>' + escapeHtml(detailValues.join(' · ')) + '</td></tr>';
  }).join('');
  const auditPagination = options.adminView.auditPagination;
  function auditPageUrl(pageNumber) {
    const parameters = [];
    if (auditPagination.query) {
      parameters.push('auditQuery=' + encodeURIComponent(auditPagination.query));
    }
    parameters.push('auditPage=' + encodeURIComponent(pageNumber));
    return options.basePath + '/admin?' + parameters.join('&') + '#activity-log';
  }
  const auditSearch = '<form method="get" action="' + options.basePath + '/admin#activity-log" class="audit-search">' +
    '<label for="audit-query">Search activity</label><div class="inline-controls"><input id="audit-query" type="search" name="auditQuery" maxlength="100" value="' +
    escapeHtml(auditPagination.query) + '" placeholder="Actor, action, assignment, team, or repository">' +
    '<button class="button secondary small" type="submit">Search</button>' +
    (auditPagination.query ? '<a href="' + options.basePath + '/admin#activity-log">Clear</a>' : '') + '</div></form>';
  const auditSummary = auditPagination.total
    ? '<p class="muted">Showing ' + escapeHtml(auditPagination.from) + '–' + escapeHtml(auditPagination.to) + ' of ' + escapeHtml(auditPagination.total) +
      (auditPagination.query ? ' matching entries.' : ' entries.') + '</p>'
    : '<p class="muted">' + (auditPagination.query ? 'No activity entries match this search.' : 'No activity has been recorded yet.') + '</p>';
  const auditPages = auditPagination.pageCount > 1
    ? '<nav class="pagination" aria-label="Activity log pages">' +
      (auditPagination.page > 1 ? '<a href="' + escapeHtml(auditPageUrl(auditPagination.page - 1)) + '">← Previous</a>' : '<span class="muted">← Previous</span>') +
      '<span>Page ' + escapeHtml(auditPagination.page) + ' of ' + escapeHtml(auditPagination.pageCount) + '</span>' +
      (auditPagination.page < auditPagination.pageCount ? '<a href="' + escapeHtml(auditPageUrl(auditPagination.page + 1)) + '">Next →</a>' : '<span class="muted">Next →</span>') +
      '</nav>'
    : '';
  return page(Object.assign({}, options, {
    title: 'Administration',
    admin: true,
    body: '<section class="page-heading"><p class="eyebrow">Staff</p><h1>Repo184 administration</h1>' +
      '<p class="lede">Configure assignment templates and inspect repository/team state.</p></section>' +
      '<section class="panel"><h2>Add assignment</h2>' + assignmentForm(options, null) + '</section>' +
      '<section class="admin-section"><h2>Assignments</h2>' + (assignments || '<p class="muted">No assignments configured.</p>') + '</section>' +
      '<section class="admin-section"><h2>Teams and repositories</h2>' + userSuggestions + (units || '<p class="muted">No repositories created.</p>') + '</section>' +
      '<section class="admin-section" id="activity-log"><h2>Recent activity</h2>' + auditSearch + auditSummary +
      '<div class="table-scroll"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead><tbody>' +
      (audit || '<tr><td colspan="4">No matching activity.</td></tr>') + '</tbody></table></div>' + auditPages + '</section>'
  }));
}

function errorPage(options) {
  const status = options.status || 500;
  const title = status === 404 ? 'Not found' : (status === 403 ? 'Not allowed' : 'Something went wrong');
  return page(Object.assign({}, options, {
    title: title,
    body: '<section class="narrow"><p class="eyebrow">Error ' + escapeHtml(status) + '</p><h1>' + title + '</h1>' +
      '<p class="lede">' + escapeHtml(options.message || 'Please try again.') + '</p>' +
      '<p><a class="button secondary" href="' + escapeHtml(options.returnPath || (options.basePath + '/')) + '">' +
      escapeHtml(options.returnLabel || 'Return to assignments') + '</a></p></section>'
  }));
}

module.exports = {
  adminLoginPage: adminLoginPage,
  adminPage: adminPage,
  assignmentPage: assignmentPage,
  dashboardPage: dashboardPage,
  errorPage: errorPage,
  escapeHtml: escapeHtml,
  loginPage: loginPage,
  page: page,
  teamPage: teamPage
};
