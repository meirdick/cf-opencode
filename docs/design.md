# Design notes

Why cf-opencode works the way it does. User documentation is in the README and
on the docs site; this file is for people who change the code.

The CLI is part of the product, not a wrapper around it. A
release is not ready while any of the rules below fail.

## The one command

`cf-opencode connect` from a git checkout is the whole happy path. It must:

- pick the workspace id from the directory name, so the user types no id
- reuse the workspace and its password on the second run, so a reconnect is not a new setup
- print progress lines while it waits, and one error line when it fails
- open the local OpenCode client without the user copying a URL or a password
- never print the password, the control token, or a model key

`--no-attach` and `--json` are the escape hatches, not the default.

## Errors

Every error the user can hit is one line, `Failed: <cause> — fix: <action>`.
The action is a command or a single thing to change, not a paragraph. A retry
of the same command must be safe.

## Secrets

- The control token and the server password live in mode-600 files under
  `~/.cf-opencode`. They are never command arguments.
- Logs are redacted before they leave the container. A log line that contains a
  password is a bug, not a warning.
- `doctor` checks the install and starts nothing.

## Time

- A reconnect of a paused workspace should be a restore, not a rebuild. The
  user should not re-clone or reinstall.
- Idle time costs nothing. The default pause is 20 minutes after the last
  request, and the user can pause sooner with `cf-opencode pause`.
- The first start on a fresh host pulls the image and is slow. The progress
  line says so. Later starts do not.

## Init

`cf-opencode init` is the install, and it works from an npm install as well as
a checkout: the CLI package carries the Worker source and the image
(`cli/templates`, copied at build), and init deploys a copy under
`~/.cf-opencode/deploy`.

- Preflight changes nothing and reports every blocker at once, one `Failed: … —
  fix: …` line each: Node 22, Docker, buildx (wrangler builds with `--load`; a
  Docker without buildx otherwise fails with a bare exit 125), the login and
  account, Workers Paid, and an existing Worker of that name.
- On a terminal it offers `wrangler login` and asks which account. Without one,
  it never prompts; `--json` makes stdout one document and keeps progress on
  stderr.
- It will not overwrite a Worker this machine did not deploy without `--adopt`.
  A first run that failed after creating the Worker leaves
  `~/.cf-opencode/deploying.json`, so the rerun finishes it without `--adopt`.
- The Worker name goes into the copied `wrangler.jsonc`, not `--name`: with
  `--name` the container app keeps `cf-opencode-workspacesession` and a second
  install collides with the first.
- Deploy retries what wrangler says is transient (registry push flakes, "container
  application settings were not fully applied") twice, and never retries a plan,
  Docker or auth error. The full wrangler output goes to
  `~/.cf-opencode/deploy.log`.
- It is done when the Worker accepts the control token, not when wrangler exits.

`upgrade` is init for the recorded install. `uninstall` is a dry run without
`--yes`; it decides whether the Worker is gone by looking it up, because
`wrangler delete` can delete it and still exit 1.

## Deferred: owning the prompt

The control plane journals spawn, pause, and delete. It does not journal a
prompt. Cloudflare's Agents SDK ContainerHarness does: each prompt is an
operation with a cursor, a Durable Object eviction replays missed frames
instead of re-running the turn, and a container death settles the in-flight
prompt instead of losing it. That is worth adopting when cf-opencode owns the
session rather than proxying `opencode serve`. Not before: the SDK is
experimental, and copying it now would fork a wire that changes between
releases.

Not adopted, and not planned: the SDK's client event stream, which has no
resume cursor; `@cloudflare/computer`'s FUSE mirror, whose container copy is
in memory and loses unpulled writes, and which must be PID 1; and
OpenCodeHarness, which runs OpenCode inside a Durable Object with no shell and
no filesystem. The disk snapshot already does what the mirror cannot.

## Internet

A workspace has general internet. Provider hosts stay intercepted, so a model
key still never enters the container. `lockdown: true` in the config turns
general internet off; it is not the default.

## Shell and SSH

- `cf-opencode shell <id>` is the terminal. It is tmux, so a dropped connection is
  a detach, never a kill, and the same command reattaches. It prints one line on
  the way out saying which of the two happened.
- `cf-opencode ssh-config <id>` is the whole herdr setup: one Host block, no keys
  to copy, no port to open. `ssh cf-opencode-<id>` must work with no other step.
- Both take the workspace password from the mode-600 file; neither prompts.
- A wrong password is a 401 that wakes nothing.

## Cloudflare primitives first

When Cloudflare has a binding for something, the install uses it instead of a key
the user has to make: the AI binding for models (Workers AI, and third-party
models through AI Gateway with Unified Billing), the Browser Run binding for
browsing. A secret is the fallback for what has no binding, never the default.

## Web search

`cf-opencode-search` in the workspace posts to the same intercepted host as the models. The Worker runs
`env.AI.websearch()` through the install's AI Gateway. It follows the binding rule: no key, billed to the
account. The default provider is `exa`: for a technical query, `exa` and `linkup` returned the documentation
pages and `ceramic` did not (checked 2026-11-12).

`cf-opencode-fetch` is the second half: it posts a URL to the same host, and the Worker runs a Browser Run
Quick Action (`markdown`, `content`, `links`, `screenshot`, `pdf`). Search finds a page; fetch reads it.

## Browsing

`cf-opencode browse <workspace>` opens a Browser Run session and prints its
address, a websocket on the Worker that relays to the Browser Run binding. It
says, on stderr, that the session is billed per browser hour and closes after 10
minutes idle. A workspace with no local password tells the user to connect first.

## Preview a dev server

A preview exposes a port of a machine that holds the user's code, so it is
private by default. Every credential is checked twice: in the Worker without
state (`previewGate` in `preview-ingress.ts`), so an anonymous or forged request
creates no Durable Object, as `gate.ts` does for `/oc`; then in the workspace's
Durable Object (`worker/src/orb/preview.ts`), which keeps the state: the stored
password hash, spent tickets, and which public shares exist now.

- Credentials. `/preview/<id>/<port>/` takes the workspace password (Basic),
  the same check as `/oc`, in constant time. A browser cannot send it, so the
  Worker gives a cookie: `HMAC(key, "cookie", id, port, expiry)`, where key =
  `HMAC(control token, "cf-opencode/preview/v1")`. No state, no password in
  it, and a cookie for another workspace or port does not verify. HttpOnly,
  Secure, SameSite=Lax, Path `/preview/<id>/<port>/`, 8 hours. Rotating the
  control token signs every browser out.
- Sign-in without the password in a URL. The CLI posts the password in a
  header to `/preview/<id>/link` and gets a ticket: `HMAC(key, "ticket", id,
  port, expiry, nonce)`, 2 minutes. The Durable Object keeps spent nonces until
  they expire, so a ticket works once. The redirect after it is a path on the
  same origin, built from the prefix, never from input: no open redirect.
- The dev server never sees the password, the cookie or our routing header.
  The Worker drops every client `x-cf-opencode-*` header before it sets its own.
  The browser never gets the dev server's `Service-Worker-Allowed` or
  `Clear-Site-Data`: both act on the whole origin, not on the preview's path.
- Ports: 1024-65535, not OpenCode's port, not 22.
- No wake. A dev server does not survive a pause, so waking would only start
  OpenCode. A paused workspace answers a page that says to connect. A request
  through an awake preview counts as use, rate-limited like the terminals.
- Path prefix. Previews share the Worker's origin under a path, because
  `workers.dev` has no wildcard hostnames. Two costs: absolute paths leave the
  prefix (a same-origin Referer sends them back; hot reload's websocket has no
  Referer), and a preview page can read other previews the same browser is
  signed in to. A hostname for each preview fixes both and needs a custom
  domain with wildcard DNS; it is the next step if users have one.
- Public is explicit. `/public/<id>/<token>/` exists only after `preview
  --public`, which needs the control token: the agent has the workspace
  password, and must not be able to publish a port. The token is a 16-byte
  nonce and an HMAC over the workspace and the nonce (192 bits), so the Worker
  refuses a forged one alone; the Durable Object keeps the tokens that exist
  and compares in constant time, so `--stop` ends one. Cloudflare's own
  preview URLs need a custom domain, so this is our mechanism, shaped like the
  token links in the Sandbox previews docs.
- The agent's browser. Browser Run's `acquire({ outboundByHost })` sends a
  hostname's requests to a Worker Fetcher. `p<port>.preview.internal` goes to
  `PreviewEgress`, whose props (workspace, port) only this Worker sets, and on
  to the port. No public URL, no password in the browser. HTTP only.

## Close the laptop, the work goes on

The core promise: start a task from the laptop, close it, the task finishes, the
workspace sleeps, and the next client wakes it where it left off.

- OpenCode keeps a session running with no client attached (verified live: a
  client killed mid-task, the session finished "succeeded"). A client that exits
  on a signal interrupts its session on purpose; a closed laptop sends none.
- The idle pause counts work, not only clients: a running OpenCode session
  (asked over its API with the derived password), output on any pty (tmux and
  herdr panes, ssh sessions), and requests through the Worker. The idle time
  runs from the last of those, so a two-hour task pauses `idlePauseMinutes`
  after it ends. A session waiting on a permission or question does not count.
- Use stored before a pause never pauses a fresh wake: the idle clock starts no
  earlier than the wake.
- `maxAwakeHours` still pauses a working agent. It is the cost guard.

## Passwords are derived

The workspace password is HMAC-SHA256(control token, label + workspace id).
Every machine with the control token gets the same one, so a second laptop (or
a later app) joins the same session instead of minting a new password, which
restarted opencode serve and locked the first one out. The Worker computes it
too, which is how the alarm asks the workspace whether an agent is busy. It is
still never stored.

## The Worker checks the password first

Because passwords are derived, the Worker computes the expected one for the id in
the path and compares in constant time before it calls the workspace's Durable
Object (`worker/src/gate.ts`). An anonymous request, or one with a wrong password,
is one uniform 401 and never creates a Durable Object. The Durable Object still
checks the stored hash, and only it wakes. The control API refuses a spawn with a
password that is not derived, since no client could reach that workspace.

No lockout and no rate limit on failures. The password is 256 bits, so guessing
is not the threat; a hold keyed on the workspace id (a checkout's name) would let
anyone lock the owner out, and it would need a state write per failure, the cost
this check removes. Volume is Cloudflare's DDoS protection's job.

`/shell`, `/ssh` and `/browse` refuse a request with an `Origin` other than the
Worker's own, and any request with `Sec-Fetch-Site`, which every current browser
sends and a page cannot remove: a browser can attach cached Basic credentials to
a websocket, and a preview page is on the Worker's own origin. `Origin` alone
cannot tell: Python's websocket client sends the Worker's origin. `/oc` checks
neither, because OpenCode's web and desktop clients may call it from a browser.

## The agent is root in its container

`user` has passwordless `sudo`, so a prompt-injected agent is root on its own
disk. Restricting `sudo` to `apt-get` would not change that: package scripts run
as root, and the agent can add any package source. The agent also has the
workspace password in `OPENCODE_SERVER_PASSWORD`. The design does not rely on the
container being clean. It relies on these:

- No secret enters the container. Models use the AI binding; provider keys and
  the GitHub token are added by the Worker on egress; the control token stays on
  the user's machines and in the Worker.
- The GitHub token's scope is the workspace's reach, so it should be fine-grained.
- `lockdown: true` turns general internet off, `/page` included.
- A workspace is disposable. `delete` drops the disk; `connect` clones again.

Root-run scripts never write in `/home/user`, which the agent owns: a symlink
there could point a root write at a system file. `authorized_keys` is written as
`user`.

## SSH keys

Each machine's CLI key goes to the Durable Object on every SSH connect, with the
time. The connect rewrites one marked block in `authorized_keys` with the keys
seen in the last 30 days, so two machines both work and an old one drops out.
This is hygiene, not the gate: sshd listens nowhere, and `/ssh` needs the
password. Changing the control token changes every password; that is what shuts
out a former holder.

## GitHub through egress

Private repositories are the normal case, so `init` sets GitHub up once: it
uses the machine's `gh` login, or asks for a token, and `--no-github` skips.
`doctor` reports the token, and `connect` warns before a clone that will fail
without it.

Git credentials follow the model-key rule: the GitHub token is a Worker secret
(`cf-opencode git-token`), the platform intercepts github.com and
api.github.com, and the Worker adds the token on the way out. Clone, push and
`gh` work; the disk, env and snapshots hold a placeholder. SSH remotes become
HTTPS URLs, since the workspace has no SSH key. The egress CA is trusted after
interception is installed, not only at boot, because it can appear after the
entrypoint ran.

## Delete means gone

`cf-opencode delete` destroys the container, forgets the workspace's disk, and
forgets the project snapshot that workspace made. The next `connect` boots the
image and clones again. A workspace id is the checkout's name, so `connect`
after `delete` must work at once; only the control plane can start a deleted
workspace, and the password paths answer 410.

A first `connect` that fails after the boot (a clone that needs a token) stops
its container. An empty container must not stay running where no list shows it.

## Sessions

OpenCode keeps sessions in the server that ran them, so its client lists one
workspace at a time. `cf-opencode sessions` is the list across workspaces. The
Durable Object reads the list from a running workspace and keeps a copy, which
it refreshes before each pause. A paused workspace answers from the copy, so
listing sessions wakes nothing. `connect --continue` and `--session` open a
session in the workspace; OpenCode's own exit hint (`opencode -s …`) would start
a local one.

## Handed-off tasks

`cf-opencode run` starts a session through the Worker, not through a local
client: the Durable Object execs a script in the container that calls
`POST /api/session`, then `POST /api/session/{id}/prompt`, on 127.0.0.1 with
the derived password. The prompt call admits the input and returns, so the
session runs in `opencode serve` and outlives the command. The preflight runs
before any wake, because the workspace clones from the remote and never gets
local files. A dirty tree fails the preflight; `--allow-dirty` starts anyway
and says what the workspace will not see. Carrying uncommitted work into the
workspace is deferred, not rejected: a git-native WIP push (`run --wip`) and an
opt-in tar upload (`--wip --upload`), recorded in the delegation plan, step 8.

The Durable Object keeps the task list (`tasks`), as it keeps `sessions`, and
saves the states before each pause, so `tasks` wakes nothing. The state is a
pure function of what OpenCode says (`taskState` in `worker/src/orb/tasks.ts`):
an open permission or form is `waiting`, an active session is `running`, then
the session outcome decides `done` or `failed`. `--wait` polls one short GET; it
never holds a request open while an agent works.

`stopped` is the fifth state, and only a stop sets it: a cold pause, the end of
a warm period, or a lost container, with the task still `running`. The pause
reads the tasks and their git facts one last time before it stops opencode, so
the saved copy says `stopped`, not `running`. After the wake, OpenCode reports
the session as interrupted; that keeps `stopped`, since it is the same stop.
Continuing the session makes it `running` again.

### The result record

`task-result.ts` builds one record from the saved task, so a paused workspace
answers it and every client (the CLI, the notify URL, an MCP or A2A layer) gets
the same object. `branch`, `commits`, `changedFiles` and `pullRequest` are
facts: `TASK_GIT_SH` reads them with git (and `gh pr view`) in the checkout,
never from the agent's text. `run` records `HEAD` when it starts the session;
the task's commits are `base..HEAD` with a commit time at or after the start, so
commits a branch checkout brings from origin are not counted. For a running
task, git runs only on the read that shows it (`tasks <ses_…>`, not a `--wait`
poll); it runs once more, with `gh`, when the task ends.
A task that ends with no commit is `done`: many tasks are research.

`run --schema` keeps the schema with the task in the Durable Object, so
validation does not depend on the machine that started it. The subset
(`core/json-subset.ts`) is small on purpose and refuses every other keyword,
so a check is never silently skipped. The CLI keeps a copy of the keyword check
only to fail before the wake.

### Push

`--follow` reads OpenCode's own event stream (`GET /api/event`) through the
`/oc` proxy. The proxy wakes a paused workspace, so the stream opens only while
the task API says the task runs in a live workspace, and the end is always
confirmed with the task API, not inferred from an event.

The notify URL is driven by the Durable Object alarm, not by a watcher in the
workspace. The alarm runs with the laptop closed and outlives the container; a
watcher would die with each pause and need its own start, restart and auth.
Any read that sees a task change to an end state (the alarm's refresh, a
client's read, the pause's last read) queues a delivery on the task in the same
storage write. The alarm sends what is due, retries after 1, 5 and 30 minutes,
and stays armed while a delivery waits, also for a paused workspace. A newer
change replaces a waiting delivery, so a receiver never gets an old state
after a new one. The body is signed with a key derived from the control token,
like the workspace password, so it is never stored.

The URL itself is the Worker secret `NOTIFY_URL` (`cf-opencode notify-url`), not a
setting: a webhook URL often holds its own secret, and the settings are a plain
variable that the dashboard and `/v1/status` show. The Worker reads it at each
send, so a change needs no redeploy, and checks it again there: https, no user
or password, a public host name.

The inbox is one flag: a task that ends is `unseen` until a read of that one
task with `seen=1` (`tasks <ses_…>`, or the last read of `--wait` and
`--follow`). Lists and polls do not clear it.

## MCP and A2A

Both are thin layers over the same task API; neither adds state.

`cf-opencode mcp` has no SDK. The JSON-RPC core (`McpServer.handle` in
`cli/src/mcp.ts`) takes one message and returns one answer, so tests feed it
objects; `serveStdio` only frames lines. MCP 2026-07-28 dropped the
`initialize` handshake: each request carries its version in `_meta`. Clients
from before still send `initialize`, so the server is "dual-era": a request with
`_meta` is served as 2026-07-28, and `initialize` picks 2025-11-25 or 2025-06-18
for the process. A tool failure is a result with `isError` and the usual
`Failed:` line, so the model can act on the fix. `wait_task` stops at 280 s,
under the 5-minute tool timeout most clients have; the task goes on.

The A2A endpoint (`worker/src/a2a.ts`) is off unless `a2a` is set, because it is
one more way to run code in a workspace. The card is public, as the spec asks,
and says nothing about the user. `/a2a` sits behind the same bearer check as
`/v1`, before the body is read. An A2A task id is `<workspace>:<session>`, so
`GetTask` and `CancelTask` need no index; `contextId` is the workspace. The
Worker has no checkout, so it cannot make a workspace: `SendMessage` targets one
that was connected before, and wakes it with the derived password and the
stored directory, as a wake through `/oc` does (`task-wake.ts`). `CancelTask`
execs a script that calls OpenCode's `POST /api/session/{id}/interrupt`
(`task-cancel.ts`). Streaming and push notifications are declared off in the
card and answer the spec's errors. A blocking `SendMessage` polls the saved
state, like `tasks --wait`, for at most 5 minutes, then returns the task as it is:
one Worker request is not held open for a coding task. `GetTask` and the end of a
blocking wait build the A2A task from the result record when the Durable Object
has one.

## The agent knows the machine

The serve script writes `~/.config/opencode/AGENTS.md` on each wake: `sudo
apt-get` works, GitHub works without a login, and the browser is
`cf-opencode-browse`. It carries a marker line and never replaces a file the
user wrote. An `opencode` wrapper gives OpenCode started in a shell or over SSH
the same model config that `opencode serve` gets.

## Snapshots do not silently expire

Three days before a paused workspace's snapshot would expire, the alarm restores
it for a few seconds (no internet, nothing started), which starts a new 30
days. `list` and `status` flag a snapshot under two days out, which only happens
when refresh is failing or off.

## Rebuild, not in-place upgrades

Cloudflare snapshots are tied to the image they came from, so an upgrade never
reaches an existing disk by itself. `cf-opencode rebuild <id>` streams
`/home/user` and the SSH host keys (tar over Workers RPC) from the old disk into
a container on the current image in a second Durable Object, snapshots it, and
makes that the workspace's disk. Disks record the image they came from, so
`status` can say when one is out of date. System packages are not carried; that
is the line between "your files" and "the image".
