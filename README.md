# Repo184

Repo184 is the small, standalone service behind
`https://cs184.eecs.berkeley.edu/repo/`. It replaces the repository-provisioning
part of GitHub Classroom for CS 184/284A:

- students sign in with GitHub and are added to `cal-cs184-student`;
- an open assignment can create one private team repository; teams start with one student and may grow to the assignment's configured maximum of one or two;
- students can request to join an assignment-specific team, and an existing
  member approves the request;
- staff configure assignments, repair access, remove a mistaken partner, or
  release an assignment claim from `/repo/admin`. Releasing preserves the
  private repository for staff while revoking direct student access.

Repo184 does not replace Gradescope. Students still submit the required commit
or repository information to Gradescope, and public writeups remain separate
from the private assignment repository.

## Trust boundary: GitHub login is not a roster check

There is deliberately no CalNet or course-roster gate. GitHub authorization
only proves control of a GitHub account; it does **not** prove Berkeley identity
or enrollment. Consequently, any GitHub user who discovers the public URL can
attempt to join `cal-cs184-student` and provision repositories while an
assignment is open.

Staff should treat this as an explicit operational risk:

- keep assignments closed except during their intended provisioning window;
- review Repo184's admin page and the organization's member/repository lists;
- remove unknown accounts and repositories promptly;
- watch GitHub organization-invitation limits and unusual bursts of activity;
- add a roster allowlist or place the route behind campus authentication later
  if abuse becomes material.

The admin password protects staff actions only. It does not gate student login.

GitHub limits organization owners to 50 invitations in a rolling 24-hour
period. The limit rises to 500 when the organization is more than one month old
or is on a paid plan. Existing organization members do not need a new
invitation, but a course with more than 500 new GitHub accounts must stagger
onboarding across days or pre-add students. Once the cap is reached, Repo184
shows students a retry-later message; it cannot override GitHub's limit. See
[GitHub's organization invitation limits](https://docs.github.com/en/organizations/managing-membership-in-your-organization/inviting-users-to-join-your-organization#about-organization-invitations).

GitHub also applies secondary limits to content-generating API requests. In
general, GitHub documents limits of 80 writes per minute and 500 per hour.
Repo184 stays below those ceilings by allowing at most 60 writes per minute and
400 per hour, limits concurrent API calls, and stops dispatching queued work
when GitHub returns a `Retry-After` or rate-limit reset. Staff should still
stagger both first-time onboarding and the initial assignment-repository rush.
Ordinary writes stop at 50 per minute and 320 per hour, reserving the remaining
capacity for urgent collaborator revocations. Admin actions use a separate
local allowance, and revocation calls use a small priority queue. Ordinary
queued calls expire after 25 seconds instead of continuing behind an outage.
See [GitHub's REST API rate-limit
documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

## Local development

The service is intentionally compatible with Node.js 11.4 and newer because of
the current instructional-server environment. The test suite has been run with
the exact Node.js 11.4 runtime, and the committed version-1 lockfile installs
with npm 6. Production should still use a supported Node.js LTS release because
Node.js 11 is end-of-life and no longer receives security updates.

```sh
cp .env.example .env
npm ci
npm run dev
```

Then open `http://127.0.0.1:3000/repo/`. Development mode uses fake GitHub
accounts when `DEV_FAKE_GITHUB=1`; never enable that setting in production.

Before deploying, run:

```sh
npm test
npm run check
```

## Production shape

Run Repo184 as its own process, separate from the legacy CS 184 website:

```text
browser -> nginx /repo/ -> /srv/appsockets/cs184/repo184/app.sock
        -> Repo184 -> GitHub API
                    -> data/repo184.json
```

The JSON data file is the service's durable record of users, assignments,
teams, requests, and provisioned repositories. Writes flush a temporary file,
rename it atomically, and synchronize the parent directory before a mutation is
acknowledged. If persistence becomes uncertain after a rename, the process
stops serving data operations until it is restarted. Run exactly one Repo184
process against a data file; the store is safe for one process, not multiple
workers or hosts.

## 1. Register the two GitHub Apps

Repo184 deliberately separates student sign-in from privileged provisioning.
This lets GitHub present the Login App as identity-only without the **Act on
your behalf** warning. An owner of
[`cal-cs184-student`](https://github.com/cal-cs184-student) should open
**Organization settings -> Developer settings -> GitHub Apps** and configure
both Apps below.

### Login App

Create an identity-only App such as `Repo184 Login`:

| GitHub setting | Value |
| --- | --- |
| Homepage URL | `https://cs184.eecs.berkeley.edu/repo/` |
| Callback URL | `https://cs184.eecs.berkeley.edu/repo/auth/github/callback` |
| Expire user authorization tokens | Enabled |
| Request authorization during installation | Disabled |
| Setup URL | Blank |
| Webhook | Inactive; no webhook URL or secret |
| Where can this GitHub App be installed? | Only on this account |

Leave every repository, organization, enterprise, and account permission unset,
and subscribe to no events. The implicit read-only public profile access is
enough for Repo184 to verify the student's immutable GitHub account ID. Generate
one client secret, but do not install this App. Record its **Client ID** and
**Client secret** as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

### Provisioning App

The separately installed App never receives a student user token. Give it only:

| Permission group | Permission | Access | Why |
| --- | --- | --- | --- |
| Repository | Administration | Read and write | Create private repositories and manage collaborators |
| Repository | Contents | Read-only | Read and generate from template repositories |
| Repository | Pages | Read and write | Enable Pages for generated public write-up repositories |
| Organization | Members | Read and write | Check membership and send organization invitations |

Leave account and enterprise permissions and subscribed events unset. Disable
user authorization callbacks and webhooks. Generate and download a private key,
then open **Install App**, install it on `cal-cs184-student`, and choose repository
access. The provisioning App does not need a client secret for Repo184.

Choose **Only select repositories** and select every private code and write-up template
repository. GitHub automatically grants the creating app access to repositories
it later creates, but staff must add each new private template to the
installation before using it in Repo184. This is preferable here because every
student member can create organization repositories under the required free-org
policy; the App should not receive Administration access to those unrelated
repositories.

**All repositories** also works and avoids revisiting the installation for new
templates, but gives the App high-impact Administration access to every current
and future repository in the organization. Use it only if staff explicitly
accept that wider scope in this dedicated student organization.

Record its **App ID**, the **Installation ID** from the numeric suffix of its
installation settings URL, and the downloaded private-key PEM as
`GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, and `GITHUB_PRIVATE_KEY`.

On first sign-in, the Provisioning App sends the student an organization
invitation. The student accepts it on GitHub and returns to Repo184 to check
membership. Repo184 never accepts organization membership using the Login App's
temporary user token, and it does not store that token.

Useful GitHub references: [registering a GitHub
App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app),
[choosing app permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app),
and [installing your own GitHub
App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).

### Organization settings

In `cal-cs184-student` under **Settings -> Member privileges**:

- set base repository permissions to **No permission**;
- disable member repository deletion, transfer, and visibility changes unless
  the course has a separate reason to allow them.

There is an unavoidable free-organization limitation here: GitHub uses one
**Repository creation** policy for both members and GitHub Apps. Disabling
repository creation also prevents Repo184's installed App from generating an
assignment repository. Enabling it lets both the App and student members create
public or private organization repositories. Restricting members to
private-only creation requires GitHub Enterprise Cloud. See [GitHub's repository
creation policy](https://docs.github.com/en/organizations/managing-organization-settings/restricting-repository-creation-in-your-organization).

This build follows the requested active-member model, so enable creation of
both public and private repositories. Repo184 itself always requests a private
repository and refuses to grant or display access if GitHub reports it as
public, but it cannot stop a member from manually creating a different public
repository in the organization. Base permissions of **No permission** still
prevent an ordinary member from seeing unrelated private repositories.

If arbitrary public repositories in the course organization are unacceptable,
do not deploy this membership model as-is. The practical alternatives are
GitHub Enterprise Cloud's private-only policy, or redesigning Repo184 to keep
students outside the organization and manage outside-collaborator invitations.
The latter changes the student workflow and is deliberately not implemented in
this version.

Under **Settings -> Actions -> General**, disable GitHub Actions for this
student organization unless an assignment explicitly needs it. Removing
workflows from a template is not sufficient because students with push access
can add new workflow files. If Actions are required, restrict the allowed
actions, organization secrets, and self-hosted runner groups so generated
student repositories cannot use shared secrets or runners by default.

Under **Settings -> Member privileges -> Pages creation**, allow **Public**
Pages sites. This is required for the optional public write-up repositories.

## 2. Prepare assignment templates

For each homework template:

1. Prefer a private repository in `cal-cs184-student`, or use a public template
   in another organization. A private template must be accessible to the app
   installation.
2. On the template repository's **Settings -> General** page, enable **Template
   repository**.
3. Make the default branch contain exactly what students should receive. Remove
   solutions, credentials, staff-only branches, and sensitive Git history.
4. Decide whether GitHub Actions should be allowed. Disable unnecessary
   workflows to avoid untrusted code execution or Actions usage charges.
5. Keep the repository name stable after adding it to Repo184.

Repo184 records the template's immutable GitHub repository ID. It checks that
ID before generation and also verifies the source-template ID in GitHub's
generated-repository response before granting student access. If a template is
deleted, renamed, or replaced under the same name, provisioning stops for staff
review. Generated repository names use `<repository-prefix>-<team-name>`. If
that name is already managed by Repo184 or already exists on GitHub,
provisioning stops with an error instead of choosing a different name.

An assignment can optionally use a second, sanitized write-up template. When
enabled, Repo184 also creates a public `<repository-prefix>-<team-name>-writeup`
repository, grants the same students push access, and enables GitHub Pages from
the `docs` directory on the generated repository's default branch. Put an
`index.html` in that directory. If Actions are disabled for the organization,
also put a `.nojekyll` file in `docs` so Pages can deploy the static files without
the built-in Jekyll workflow. Never place solutions, starter code that should
remain private, credentials, or other restricted course material in the write-up
template because every generated write-up repository is public.

The substring `writeup` is reserved: assignment repository prefixes and team
names containing it are rejected so the companion suffix remains unambiguous.

After deployment, sign in to `/repo/admin` and add the assignment's display
name, slug, template `owner/repository`, destination repository prefix, maximum
team size (`1` or `2`), and open/closed status. To generate write-up repositories,
enable the checkbox and provide the separate write-up template. Create a test
team and verify both repositories and the published Pages URL before publishing
the assignment link.

## 3. Configure production secrets

Create `/home/ff/cs184/repo184/.env` on the server and set mode `0600`. Do not
commit it. A production configuration has this shape:

```dotenv
NODE_ENV=production
BASE_PATH=/repo
BASE_URL=https://cs184.eecs.berkeley.edu/repo
COURSE_HOMEWORK_URL=/fa26/hw/
SOCKET_PATH=/srv/appsockets/cs184/repo184/app.sock
SESSION_SECRET=<at-least-32-random-bytes>
ADMIN_PASSWORD=<staff-password>

GITHUB_ORG=cal-cs184-student
GITHUB_CLIENT_ID=<login-app-client-id>
GITHUB_CLIENT_SECRET=<login-app-client-secret>
GITHUB_APP_ID=<provisioning-app-id>
GITHUB_INSTALLATION_ID=<installation-id>
GITHUB_PRIVATE_KEY="<PEM-with-newlines-written-as-literal-backslash-n>"

DATA_FILE=/home/ff/cs184/repo184/data/repo184.json
DEV_FAKE_GITHUB=0
```

Generate a session secret locally with `openssl rand -hex 32` and copy only the
result into `.env`.

Set `ADMIN_PASSWORD` directly in `.env`. The private key must be one quoted
line with each PEM newline represented by the two literal characters `\n`.
Restrict both `.env` and the data directory:

```sh
chmod 600 /home/ff/cs184/repo184/.env
chmod 700 /home/ff/cs184/repo184/data
```

Rotate the admin password, session secret, GitHub client secret, and GitHub App
private key when staff ownership changes or whenever exposure is suspected.
Changing `SESSION_SECRET` signs out existing sessions.

## 4. Install the service

The included [`deploy/repo184.service`](deploy/repo184.service) is a systemd
**user** service matching the existing `ff` instructional-server layout. It
uses Node.js 24.20.0 LTS. Install that version through the account's existing
nvm setup, or update `ExecStart` to another currently supported LTS binary.
The application remains compatible with the existing Node.js 11.4 binary as a
short-term fallback, but that runtime should not be the production default.

Create the socket directory once so both the `ff` service and nginx can access
it. Replace `www-data` if nginx uses another group:

```sh
sudo install -d -o ff -g www-data -m 2770 /srv/appsockets/cs184/repo184
install -d -m 700 /home/ff/cs184/repo184/data
. /home/ff/cs184/.nvm/nvm.sh
nvm install 24.20.0
npm ci --only=production
install -d -m 700 /home/ff/.config/systemd/user
install -m 644 deploy/repo184.service /home/ff/.config/systemd/user/repo184.service
systemctl --user daemon-reload
systemctl --user enable --now repo184.service
```

If the account's user services must survive logout, an administrator should run
`sudo loginctl enable-linger ff` once.

Inspect service state and logs with:

```sh
systemctl --user status repo184.service
journalctl --user -u repo184.service -n 100 --no-pager
curl --fail --unix-socket /srv/appsockets/cs184/repo184/app.sock http://localhost/repo/health
```

Do not start a second copy of the service against the same `DATA_FILE`.
Repo184 also enforces this with a small adjacent `.lock` file and refuses to
unlink a Unix socket that is still accepting connections.

## 5. Add the nginx route

Place the contents of
[`deploy/nginx-repo184.conf`](deploy/nginx-repo184.conf) inside the HTTPS
`server` block for `cs184.eecs.berkeley.edu`. It preserves the `/repo` prefix,
which Repo184 expects, and uses the site's existing
`/etc/nginx/app_proxy_params` forwarded headers.

Then validate and reload nginx:

```sh
sudo nginx -t
sudo systemctl reload nginx
curl --fail https://cs184.eecs.berkeley.edu/repo/health
```

Production OAuth must use HTTPS even if an old course link starts with `http`.
Keep the GitHub callback URL and `BASE_URL` exactly aligned with the public HTTPS
URL.

## Operations and backups

### Routine operations

```sh
systemctl --user restart repo184.service
systemctl --user stop repo184.service
systemctl --user start repo184.service
journalctl --user -u repo184.service --since today
```

For an update: back up the data file, deploy a reviewed commit, run
`npm ci --only=production`, run the checks, and restart the service. Verify both
the Unix-socket and public health URLs after every restart.

### Back up and restore

The store writes by a flushed atomic rename, so copying the current JSON file
produces a complete old or new snapshot. Keep timestamped copies outside the
checkout and include that directory in the host's normal backup system:

```sh
install -d -m 700 /home/ff/cs184/backups/repo184
install -m 600 /home/ff/cs184/repo184/data/repo184.json \
  /home/ff/cs184/backups/repo184/repo184-YYYY-MM-DDTHHMMSSZ.json
```

Back up before every deploy and at least daily while assignments are open. Test
restoration once before the semester starts. To restore, stop Repo184, preserve
the current file under a different name, install the chosen snapshot as
`data/repo184.json` with mode `0600`, then start the service and inspect the
admin page. A data-file restore does not delete or roll back repositories on
GitHub; reconcile any repositories created after the snapshot manually.

Keep `.env` and the GitHub private key in an approved secrets backup, separately
from the operational JSON snapshots.

## Deployment checklist

- [ ] A reviewed commit passes `npm test` and `npm run check`.
- [ ] A supported Node.js runtime is used if the host offers one; otherwise the
      Node.js 11 compatibility path is understood as temporary technical debt.
- [ ] The Login App callback is the exact HTTPS `/repo/auth/github/callback`
      URL; it has no repository, organization, or enterprise permissions and is
      not installed.
- [ ] The Provisioning App has Repository Administration (write), Repository
      Contents (read), Repository Pages (write), and Organization Members
      (write), with no extras or user authorization flow.
- [ ] The Provisioning App is installed on `cal-cs184-student` and can access
      every private template.
- [ ] Organization base permissions are none; repository creation is enabled
      for both members and GitHub Apps so the App can generate private repos.
- [ ] Public Pages creation is allowed under organization member privileges.
- [ ] Staff explicitly accept that a free organization cannot restrict active
      members to private-only repository creation, or have chosen Enterprise
      Cloud/redesigned outside-collaborator access instead.
- [ ] GitHub Actions are disabled for the student organization, or allowed
      actions, secrets, and runner groups are narrowly scoped and tested.
- [ ] Staff have checked how many students still need organization invitations
      and have a stagger plan for invitation and API-write limits.
- [ ] Each template is sanitized, marked as a template, and tested.
- [ ] Each enabled write-up template contains `docs/index.html` and, when Actions
      are disabled, `docs/.nojekyll`.
- [ ] Staff understand that Repo184 pins each template's immutable repository
      ID; a renamed or replaced template must be deliberately reconfigured.
- [ ] `.env` contains only production values, `DEV_FAKE_GITHUB=0`, an
      `ADMIN_PASSWORD`, and file mode `0600`.
- [ ] The data file has a fresh off-checkout backup.
- [ ] Only one Repo184 process uses the data file.
- [ ] The service passes its Unix-socket health check.
- [ ] `nginx -t` passes and the public HTTPS health check succeeds.
- [ ] A disposable GitHub account can sign in, become an active organization
      member, and receive push access to a newly generated **private** repo.
- [ ] For an assignment with write-ups enabled, a test team receives access to
      the public companion repo and its Pages URL publishes successfully.
- [ ] A two-person test verifies request, approval, duplicate-membership
      prevention, and the configured team-size limit.
- [ ] Staff acknowledge that GitHub login is not enrollment verification and
      know how to remove an unknown account.
