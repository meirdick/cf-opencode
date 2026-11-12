# cf-opencode

OpenCode workspaces on Cloudflare Containers, in your own account. A workspace
scales to zero: idle time snapshots the disk and stops the container, and the
next connect restores it. Nothing here is a hosted service. Model keys and code
stay in the container and its snapshots, in the account you deploy to.

```
cf-opencode connect
```

That wakes a workspace, starts `opencode serve` inside it, and opens your local
OpenCode against it.

## What you need

- Node 22 or newer.
- Docker running, with the buildx plugin (Docker Desktop has it; on Linux,
  `apt install docker-buildx-plugin`). Wrangler builds the workspace image
  locally on each deploy.
- A Cloudflare account on the Workers Paid plan. Containers require it.
- OpenCode 2 locally: `curl -fsSL https://opencode.ai/v2/install | bash`.

No model key and no Browser Run token: models and browsing use the account's
AI and Browser Run bindings (see [Models](#models)).

## Install

The CLI carries the Worker source and the image, so it deploys from anywhere:

```sh
npm install -g cf-opencode
cf-opencode init
```

Without a global install, put `npx` before each command: `npx cf-opencode init`.
Docs: <https://cf-opencode-site.mdick85.workers.dev/docs/>.

From a checkout:

```sh
git clone https://github.com/meirdick/cf-opencode && cd cf-opencode
npm ci && npm pack -w cli
npm install -g ./cf-opencode-0.1.0.tgz
```

`init` checks everything before it changes anything, and prints every problem
at once as `Failed: … — fix: …`: Node, Docker and buildx, the Cloudflare login
and account, Workers Paid, and whether a Worker of that name already exists
that this machine did not deploy (`--adopt` takes it over, `--name` makes a
second install). On a terminal with no login it offers `wrangler login` in the
browser, and with several accounts it asks which one. Then it deploys, stores
the control token, waits until the Worker accepts it, sets up GitHub, and
prints the next command:

```
✓ Node v22.11.0
✓ Docker 27.3.1 with buildx
✓ Cloudflare account Example's Account (5759…), you@example.com
✓ Containers available (Workers Paid)
… deploying Worker cf-opencode and building the workspace image (the first build takes a few minutes)
✓ Deployed https://cf-opencode.example.workers.dev in 190s (log: ~/.cf-opencode/deploy.log)
✓ Control token stored in ~/.cf-opencode/control-token and on the Worker
✓ Worker healthy (API 0.1.0)
✓ GITHUB_TOKEN stored on cf-opencode (GitHub user you)

Ready: https://cf-opencode.example.workers.dev

Next, from any git checkout:
  cf-opencode connect
```

GitHub is set up once, here. If `gh` is logged in on this machine, `init` gives
workspaces that login (it asks first on a terminal; `--yes` takes it). If not,
it asks for a token. From then on every workspace clones private repositories,
pushes, and runs `gh`. `--no-github` leaves it for later. See
[Git and GitHub](#git-and-github) for where the token lives and how to narrow it.

Without a terminal (CI, an agent), set `CLOUDFLARE_API_TOKEN` (Workers Scripts
Write and Workers Containers Write) and pass `--account <id>` if the token sees
more than one account; `--json` prints one JSON result. [AGENTS.md](AGENTS.md)
is the walkthrough for an agent doing the install.

The control token is a bearer secret for the control API, mode 600 in
`~/.cf-opencode/control-token`. A rerun keeps it, so a redeploy never
invalidates it. The API token, if you use one instead of `wrangler login`, comes
from the environment or `--token-file`, never from an argument.

`cf-opencode upgrade` redeploys from the installed CLI's version.
`cf-opencode uninstall` lists what it would delete (the Worker, its container
app and image tags); `--yes` deletes them. On a second machine, copy the control
token file and run `cf-opencode init --url <worker url>`.

## Use

From a git checkout:

```sh
npx cf-opencode connect
```

The first connect for a repository clones it into the workspace and starts
OpenCode. Later connects restore the snapshot, so installed dependencies and
uncommitted work are still there.

### Close the laptop; the agent keeps working

The agent runs in the workspace, not on your laptop. Give it a task, close the
lid, and it carries on: OpenCode keeps the session going with no client
attached, and the workspace stays awake while any of these hold:

- an OpenCode session is running (the Worker asks the workspace's OpenCode),
- a terminal in the workspace printed: a tmux pane, a herdr pane, an SSH
  session, OpenCode's own terminals,
- a request came through the Worker: the OpenCode client, `shell`, `ssh`.

`idlePauseMinutes` (default 20) after the last of those, the workspace
snapshots. The container stays warm for `warmMinutes` (default 10), so a quick
return is instant, and then it stops; compute billing stops with it. A session that waits
on a permission or a question is your turn, not work, so it does not keep the
workspace up. When you come back, `cf-opencode connect` (or the OpenCode client
reconnecting, or `ssh`) wakes it in a few seconds with the session, its history,
and the disk as the agent left them. Processes do not survive the pause: a dev
server the agent started is gone, the work it finished is not.

`maxAwakeHours` (default 12) is a cost guard: a workspace awake that long
pauses even while it works.

When you quit OpenCode it prints `Continue  opencode -s ses_…`. That command
starts a local session. The session lives in the workspace, so continue it with
`cf-opencode connect --continue`, or `cf-opencode connect --session ses_…`.

OpenCode keeps sessions in the server that ran them, so `/sessions` in the
client lists one workspace, and local sessions are a separate list.
`cf-opencode sessions` is the list across workspaces. A running workspace
answers live; a paused one answers with the list saved at its last pause, so
nothing is woken.

Other commands:

| Command | What it does |
| --- | --- |
| `cf-opencode connect [id]` | Wake or create, then open local OpenCode |
| `cf-opencode connect [id] --continue` | Same, and open the workspace's last session |
| `cf-opencode connect [id] --session <ses_…>` | Same, and open that session |
| `cf-opencode sessions [id]` | OpenCode sessions across your workspaces, newest first. Wakes nothing |
| `cf-opencode list` | Workspaces this machine connected to, with state and snapshot expiry |
| `cf-opencode connect --no-attach` | Same, but print the server URL instead |
| `cf-opencode status [id]` | Workspace state, or the install |
| `cf-opencode logs <id>` | Redacted `opencode serve` log |
| `cf-opencode delete <id>` | Destroy the workspace and forget its disk. The next connect starts from the image |
| `cf-opencode pause <id>` | Snapshot the disk and stop the container now |
| `cf-opencode rebuild <id>` | Move a workspace onto the deployed image, keeping `/home/user` |
| `cf-opencode shell <id>` | Terminal in the workspace, inside tmux |
| `cf-opencode ssh <id> [-- cmd]` | SSH into the workspace as `user` |
| `cf-opencode ssh-config <id>` | Print a `~/.ssh/config` block for ssh, scp and herdr |
| `cf-opencode browse <id>` | Open a Browser Run session for the workspace |
| `cf-opencode git-token` | Let workspaces use GitHub; the token stays in the Worker |
| `cf-opencode doctor` | Check Node, OpenCode, ssh, the token, the Worker and its bindings. Starts nothing |
| `cf-opencode upgrade` | Redeploy the Worker and image from this CLI version |
| `cf-opencode uninstall [--yes]` | List, then delete, the Worker, container app and images |

`--json` prints one JSON document. `--url` overrides the saved Worker URL.

Each workspace has its own server password, derived from the control token
and the workspace id (HMAC-SHA256), and written to
`~/.cf-opencode/workspaces/<id>.password` with mode 600. OpenCode reads it from
`OPENCODE_SERVER_PASSWORD`; the username is always `opencode`. Because it is
derived, every machine with the control token gets the same password: on a
second laptop, copy `~/.cf-opencode/control-token`, run `cf-opencode init --url
<worker url>`, then `cf-opencode connect <id>`, and both machines work on the
same workspace and session at once. A workspace made before derivation moves to
it on its next connect; OpenCode restarts once then.

## Git and GitHub

`connect` clones the checkout's `origin` into the workspace over HTTPS (an SSH
remote such as `git@github.com:you/app.git` becomes its HTTPS URL), and copies
your git `user.name` and `user.email` there for commits. It checks out the
branch you are on. A branch that is not pushed yet starts in the workspace from
the default branch; push it first to bring your commits.

Private repositories, `git push` and `gh` need a GitHub token. `cf-opencode
init` sets it up once (see [Install](#install)). To set it later, or to replace
it with a narrower one:

```sh
gh auth token | cf-opencode git-token   # or run it alone and paste the token
```

`cf-opencode doctor` says if the Worker has a token. Without one, public
repositories still clone, and `connect` says so before the clone.

The token becomes the Worker secret `GITHUB_TOKEN`. Like a model key, it never
enters the workspace: requests to `github.com` and `api.github.com` are
intercepted, and the Worker adds the token on the way out, so `git clone`,
`pull`, `push` and `gh` work while the disk, the env and every snapshot hold
only a placeholder. Every GitHub request from a workspace carries it. The `gh`
login is the easy start and reaches everything you can reach. To give the agent
less, replace it with a fine-grained token with Contents read
and write on the repositories you work on (add Pull requests read and write for
`gh pr`). `cf-opencode git-token --remove` deletes it. A running workspace picks
up a change on its next `connect`.

## Shell and SSH

`cf-opencode shell <id>` attaches your terminal to tmux session `main` in the
workspace (`--session <name>` for another). The tmux server runs in the
container, so closing the laptop or losing the network only detaches you: the
agent and anything else in the session keep running. Run the same command to
reattach. Detach on purpose with `ctrl-b d`. While a tmux pane prints, the idle
pause treats the workspace as in use, even with nobody attached.

`cf-opencode ssh <id>` is ordinary SSH. The bytes travel over a websocket
through the Worker to `sshd -i` in the container; no port is open and nothing
listens. For tools that expect a machine name, such as herdr:

```sh
npx cf-opencode ssh-config my-repo >> ~/.ssh/config
ssh cf-opencode-my-repo
herdr machine add cf-opencode-my-repo   # then run herdr; the workspace is a machine
```

herdr installs itself in the workspace's `~/.local/bin` on the first `machine
add`, and its server, panes, and agents keep running there when your client
disconnects. A pane that prints keeps the workspace awake, so an agent working
in herdr is not paused under it; once every pane is quiet for
`idlePauseMinutes`, the workspace pauses. Connecting wakes it.

The CLI makes one key, `~/.cf-opencode/ssh/id_ed25519`, and installs its public
half in the workspace on each connect. The host key is made on the workspace's
first SSH connect and kept on its disk; a workspace that boots fresh from the
image gets a new one, so remove the old line from
`~/.cf-opencode/ssh/known_hosts` then.

Shell, SSH, OpenCode, and the clone all run as `user` (uid 1000), so one owner
holds every file in `/home/user`. `user` has passwordless `sudo` for
`apt-get install`.

The image is small on purpose: Debian with git, `gh`, python3, curl, ripgrep,
jq and tmux. It has no Node, compiler or other language toolchain. The agent
installs what a project needs with `apt-get`, and the snapshot keeps it.

## How it is put together

```
local OpenCode  --basic auth-->  Worker /oc/<id>/...  -->  container :4096 (opencode serve)
cf-opencode     --bearer------>  Worker /v1/...       -->  WorkspaceSession DO
```

One Durable Object per workspace owns the container, the snapshot handle, and
an alarm. The alarm pauses an idle workspace. Cloudflare has no snapshot list
API, so a Registry object keeps the index. This control plane is a fork of
[cf-orbs](https://github.com/meirdick/cf-orbs).

## Models

Models come from your Cloudflare account, with no API key anywhere. The Worker has
an AI binding. OpenCode in the workspace uses its built-in Cloudflare providers,
pointed at a host the platform intercepts and hands to the Worker, which runs the
request with `env.AI.run()` through your AI Gateway:

| OpenCode provider | Models | Billed to |
| --- | --- | --- |
| `cloudflare-workers-ai` | Workers AI (`@cf/...`), default `@cf/zai-org/glm-5.3` | Workers Paid usage |
| `cloudflare-ai-gateway` | Anthropic, OpenAI, Google and others | AI Gateway credits (Unified Billing) |

Pick a model with `/models` in OpenCode, or set `model` in the settings file.

Settings are a JSON object in `~/.cf-opencode/config.json`. `cf-opencode
upgrade` applies them to the Worker. For example:

```json
{ "model": "cloudflare-workers-ai/@cf/zai-org/glm-5.3", "idlePauseMinutes": 30, "instance": { "memoryMib": 8192 } }
```
OpenCode started in the workspace by hand (`cf-opencode shell`, `ssh`, a tmux or herdr pane) uses
the same providers: `opencode run -m cloudflare-workers-ai/@cf/zai-org/glm-5.3 "..."`.
Third-party models need credits on the account (dashboard: AI → AI Gateway →
Credits). The gateway is `default` unless `aiGateway` names another; Cloudflare
makes `default` on first use, and its logs, caching and rate limits apply.
Verified live: chat with tools and streaming on Workers AI, Claude, GPT and Gemini.

## Trust

No model key exists to leak: the AI binding needs none. If you also want to use
your own provider account, set its key as a Worker secret. The container calls
the provider with a placeholder, the platform intercepts that host, and the
Worker swaps in the real key, so neither the disk nor a snapshot holds it:

```sh
npx wrangler secret put ANTHROPIC_API_KEY --config worker/wrangler.jsonc
npx wrangler secret put OPENAI_API_KEY --config worker/wrangler.jsonc
```

A provider logged in from inside the workspace (OpenCode's `/connect`) is
different: its credential is written to the workspace disk and is in every
snapshot after. Use the Cloudflare providers or a Worker secret instead.

The container has general internet, so a workspace can clone and install.
Provider hosts are still intercepted, so that internet does not let a key leak.

`lockdown: true` in the config is the old behaviour: no general internet, only
the provider hosts whose secret is set. It is off unless you set it.

The Worker URL is on the internet. Two secrets protect it: the control token
for `/v1`, and a per-workspace password for `/oc/<id>`, `/shell/<id>`,
`/ssh/<id>` and `/browse/<id>`. Neither is logged. The password is not in the
URL.

The workspace's Durable Object checks that password itself, in constant time,
against the hash the last `connect` stored, before it wakes anything. Only the
control plane, with its bearer token, can set a password. Before this check, the
Worker passed any password through: a request to a paused workspace with a made-up
password woke it and started OpenCode with that password, which handed the
workspace to whoever sent it, and `/browse` opened billed sessions for anyone.

## Browsing

A workspace browses through [Browser Run](https://developers.cloudflare.com/browser-run/),
through the Worker's Browser Run binding. There is no token to create: sessions
bill to the account that owns the Worker.

`cf-opencode browse <workspace>` opens a session and prints its address: a
websocket URL on your Worker. Connect a CDP client to it with the workspace
password as Basic auth (`opencode:<password>`); the Worker relays every frame to
the session. Inside the workspace, `cf-opencode-browse` does the same with the
password OpenCode's tools already have in `OPENCODE_SERVER_PASSWORD`, so the agent
can open a browser from its shell tool.

On the Workers Paid plan a session costs $0.09 per browser hour after 10 hours
a month, plus $2.00 per concurrent browser above a monthly average of 10. A
session closes after 10 minutes without activity.

## Limits

- A paused workspace keeps its disk, not its processes. `opencode serve` starts
  again on resume. A dev server or a tmux session you started does not.
- A snapshot is the whole disk, tools included, so a restore keeps the tools of
  the image it first booted, even after `cf-opencode upgrade`. `cf-opencode
  status <id>` says when that image is older than the deployed one, and
  `cf-opencode rebuild <id>` moves the workspace over: it copies `/home/user`
  (the project, dotfiles, caches, `~/.local`) and the SSH host keys into a
  container on the current image and saves that as the workspace's disk.
  Packages installed outside `/home/user` (apt) are not carried. Rebuild stops
  a running agent. Disks saved before this release report their image as
  unknown; rebuild them once after an upgrade.
- A redeploy reaches a running workspace's control code after its container next
  stops. Pause it to move it over sooner.
- One container size per install. The default is 2 vCPU, 6 GiB, 20 GB disk.
- Cloudflare drops a snapshot 30 days after its creation or last restore. Three
  days before that (`snapshotRefreshDays`), the Worker restores a paused
  workspace's snapshot for a few seconds, with no internet and nothing started,
  which begins a new 30 days, so a workspace you leave for months keeps its
  disk. `cf-opencode list` marks a snapshot under two days from expiry with `!`;
  that means refresh is failing or off, and a `connect` saves it. Set
  `snapshotRefreshDays: 0` to let unused workspaces expire.
- A live deploy needs Workers Paid. Tests run locally and do not.

## Develop

```sh
npm install
npm test
npm run typecheck
```

Worker tests use vitest with a fake container. Snapshots do not run under
`wrangler dev`, so the container port is an interface and the tests use a fake.
