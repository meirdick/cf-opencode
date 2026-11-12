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

### Hand off a task

`cf-opencode run` gives a task to OpenCode in the workspace and returns. You
do not attach a client, and the task goes on with the laptop closed:

```sh
cf-opencode run "Add a health check route with a test" --title "Health check"
```

```
Started ses_4f2a… in my-app: Health check
Status: cf-opencode tasks ses_4f2a… --workspace my-app
Wait:   cf-opencode tasks ses_4f2a… --workspace my-app --wait
Follow: cf-opencode tasks ses_4f2a… --workspace my-app --follow
Open:   cf-opencode connect my-app --session ses_4f2a…
```

The workspace clones from the Git remote, so `run` first checks the checkout:
it fails when the branch is not pushed, or when files have changes that are
not committed. `--allow-dirty` starts anyway and says what the workspace will
not see. `run` adds a fixed instruction to each task: commit, push the branch,
open a pull request when `gh` works, and end with a `Result:` line.
`--schema <file.json>` also asks for a final `json` block that matches a JSON
Schema (a small subset); the result then carries it as `structured`.

`cf-opencode tasks` lists the tasks across workspaces, with their state:
`running`, `done`, `failed`, `waiting` (the agent asks a question or a
permission; answer it with `cf-opencode connect <id> --session <ses_…>`), or
`stopped` (the workspace paused under the task; `connect` continues it). A
task that ended is marked `*` until you read it; `--unseen` lists only those.
`cf-opencode tasks <ses_…>` shows the result: state, summary, then the branch,
the commits since the start and the pull request, which the Worker reads with
`git` and `gh`, not from the agent's words. `--wait` returns when the task
stops running, with exit code 0 done, 1 failed, 2 waiting, 3 timed out
(`--timeout`, default 60 minutes), 4 stopped. `--follow` does the same and
shows the agent's tool calls and messages live. `--json` prints the result
record. Like `sessions`, it wakes nothing: a paused workspace answers with the
states saved at its pause.

With a notify URL set, the Worker POSTs the result record, signed
(`cf-opencode notify-key`), when a task leaves `running`, and retries after 1,
5 and 30 minutes. The Worker sends it, so it works with the laptop closed; the
receiver must be on (a chat webhook, a push service). In the workspace,
`cf-opencode-notify "<text>"` sends a note there. The URL is a Worker secret,
because a webhook URL often holds its own secret; it is never an argument:

```sh
printf %s "$WEBHOOK_URL" | cf-opencode notify-url   # or run it alone and paste; --remove deletes it
```

`cf-opencode skill --install --claude` (or `--opencode`) installs a skill that
tells a local agent when and how to hand off a task.

### Hand off from an agent: MCP and A2A

`cf-opencode mcp` is an MCP server over stdio. A local agent gets the tools
`handoff_task`, `get_task`, `wait_task` and `list_tasks`, and reads the task
record as structured data instead of shell output:

```sh
claude mcp add cf-opencode -- cf-opencode mcp
```

In OpenCode, add it to `opencode.json`:

```json
{ "mcp": { "servers": { "cf-opencode": { "type": "local", "command": ["cf-opencode", "mcp"] } } } }
```

The Worker can also serve the Agent2Agent protocol (A2A 1.0), so an agent on
another machine starts and follows tasks. It is off by default; set `"a2a":
true` in `~/.cf-opencode/config.json` and run `cf-opencode upgrade`. The Agent
Card is at `/.well-known/agent-card.json`; the JSON-RPC endpoint `/a2a` takes
the control token as a bearer token. A message names its workspace in
`metadata.workspace`, and the workspace must have been connected once. A
blocking `SendMessage` waits 5 minutes at most, then returns the task as it is;
send `returnImmediately` and poll `GetTask`.

The MCP server acts with your control token for the agent that runs it. Its
`directory` argument can name any git checkout on the machine, and the CLI runs
`git` there, which reads that checkout's `.git/config`. Give it only to an agent
you would let run `cf-opencode run`.

Other commands:

| Command | What it does |
| --- | --- |
| `cf-opencode connect [id]` | Wake or create, then open local OpenCode |
| `cf-opencode connect [id] --continue` | Same, and open the workspace's last session |
| `cf-opencode connect [id] --session <ses_…>` | Same, and open that session |
| `cf-opencode sessions [id]` | OpenCode sessions across your workspaces, newest first. Wakes nothing |
| `cf-opencode run "<task>" [id]` | Hand a task to OpenCode in the workspace and return. It runs with the laptop closed |
| `cf-opencode tasks [id \| ses_…]` | Handed-off tasks and their state, or one task's result. `--wait` or `--follow` waits for one. Wakes nothing |
| `cf-opencode mcp` | Serve `run` and `tasks` to an agent as MCP tools over stdio |
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
| `cf-opencode preview <id> <port>` | Open a dev server in the workspace in your browser, behind the workspace password |
| `cf-opencode preview <id> <port> --public` | Make a public URL for that port; `--stop` removes it, `--list` lists them |
| `cf-opencode git-token` | Let workspaces use GitHub; the token stays in the Worker |
| `cf-opencode completion <shell>` | Tab completion for bash, zsh or fish: commands, flags, workspace ids |
| `cf-opencode skill [--install]` | Print the handoff skill for agents, or install it |
| `cf-opencode notify-url [--remove]` | Set where the Worker POSTs task results and notes; a Worker secret |
| `cf-opencode notify-key` | Print the key that signs the POSTs to the notify URL |
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

The CLI makes one key per machine, `~/.cf-opencode/ssh/id_ed25519`, and sends
its public half on each SSH connect. The workspace's `~/.ssh/authorized_keys`
has a cf-opencode block with the keys that connected in the last 30 days, so two
laptops both work and a machine that stopped connecting drops out. Lines you add
outside the block stay. The host key is made on the workspace's
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
your browser    --cookie------>  Worker /preview/<id>/<port>/...  -->  container :<port> (dev server)
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
the provider hosts whose secret is set. It is off unless you set it. With it on,
`cf-opencode-fetch` is refused, because Browser Run would load any URL for the
workspace. Models and `cf-opencode-search` still work, and a search query
leaves the account for the search provider.

The Worker URL is on the internet. Two secrets protect it: the control token
for `/v1` and `/a2a`, and a per-workspace password for `/oc/<id>`, `/shell/<id>`,
`/ssh/<id>`, `/browse/<id>` and `/preview/<id>`. Neither is logged. The password is not in the
URL. A preview cookie is an HMAC under a key derived from the control token,
bound to one workspace and port, never the password. A public preview URL
exists only after `cf-opencode preview --public`, and its token carries its own
HMAC.

The password is derived from the control token, so the Worker checks it first,
in constant time and with no state: no password or a wrong one is a 401 that
reaches no Durable Object, so an anonymous request costs one Worker request and
names no workspace. The workspace's Durable Object then checks it again against
the hash the last `connect` stored, before it wakes anything. Only the control
plane, with its bearer token, can set a password, and it accepts only the
derived one. The same goes for previews: the Worker checks the password, the
preview cookie, the sign-in ticket or the public token before it calls a Durable
Object. There is no lockout: the password is 256 bits, and a lockout keyed
on a guessable workspace name would let anyone lock you out. `/shell`, `/ssh`
and `/browse` also refuse a request from a web page, on another site or on the
Worker's own origin, where previews are. A browser session is served only to the
workspace that opened it.

Text from a workspace (task titles and summaries, branch names, commit
subjects, file names, `--follow` events, logs) is the agent's. The Worker cuts
it to a fixed size, and the CLI prints terminal control characters in it as
`?`. A note from `cf-opencode-notify` is the agent's text too, signed with your
key: the agent can send any text there, as often as it wants. The Worker does
not follow a redirect while it holds a secret (a provider key, the GitHub token,
the notify URL).

Models, search, `cf-opencode-fetch` and browser sessions need no credential in
the workspace, so the agent can use them as much as it wants, billed to your
account. There is no budget for each workspace; use AI Gateway's rate limits
and credits to cap it.

The agent in the workspace runs as `user`, which has passwordless `sudo`, so a
prompt-injected agent is root in its container and can change anything on its
disk and in its snapshots. That is on purpose: the agent installs what a
project needs with `apt-get`, and a narrower rule such as "sudo apt-get only"
is not a boundary, because package scripts run as root and a package can come
from any source the agent adds. The agent also holds the workspace password
(`OPENCODE_SERVER_PASSWORD`, which `cf-opencode-browse` uses), so it can reach
its own workspace's routes from outside. What protects you is elsewhere: no
model key, GitHub token or control token ever enters the container (the Worker
adds them on egress), so there is none to steal; the GitHub token reaches only
the repositories you gave it; `lockdown: true` turns general internet off; and a
workspace is disposable: `cf-opencode delete` throws the disk away, and the next
`connect` clones again. Treat the workspace disk like a CI runner's: review what
the agent pushes, and do not put secrets on it.

## Web search

A workspace searches the web with Cloudflare's
[Web Search API](https://developers.cloudflare.com/web-search/), through the
Worker's AI binding and your AI Gateway. There is no key. Inside the workspace:

```sh
cf-opencode-search "cloudflare containers snapshots"   # -n 10 for more, --json for the raw answer
```

The agent's notes tell it to use this command. Searches bill to your AI Gateway
credits at the provider's price. The provider is `exa` unless `searchProvider`
in the settings file names another (`linkup`, `ceramic`). OpenCode's own web
search tool still exists and goes to OpenCode's provider, not to your account.

## Read a page

`cf-opencode-fetch <url>` in the workspace prints a page as Markdown. The
Worker loads the page in a real browser with Browser Run Quick Actions, so pages
that need JavaScript work. `--links` lists the links, `--html` prints the
rendered HTML, and `--screenshot <file>` and `--pdf <file>` save a file. It
bills to your account's Browser Run usage.

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

## Preview a dev server

The agent starts a dev server in the workspace. You open it on your machine:

```sh
cf-opencode preview 3000            # the workspace of this directory
cf-opencode preview my-repo 3000 5173   # a named workspace, two ports
```

The command forwards the port over the workspace's SSH and opens
`http://localhost:3000`. Nothing is public and no URL exists: only your machine
can open it, for as long as the command runs (Ctrl-C stops it). The app is at the
root of `localhost`, so asset paths and hot reload work as on your own machine,
and a dev server that listens on `127.0.0.1` only is reached too. When the port
is in use on your machine, the command takes the next free one and says so.

`--web` gives a URL on the Worker instead, for a machine with no `ssh` client or
for another device of yours. It prints `https://<worker>/preview/my-repo/3000/`
and opens it in your browser, signed in. Nothing is public: the Worker asks for the workspace
password, as for `/oc`. The password is not in the URL. The CLI gets a one-time
sign-in link from the Worker (it works once, for 2 minutes), and the browser
trades it for a cookie. The cookie works for that workspace and that port only,
for 8 hours. `--no-open` prints the link instead of opening it.

Inside the workspace, `cf-opencode-preview 3000` prints the same URL and checks
that something listens on the port. The agent's notes tell it to run that and
give you the line.

- The dev server must listen on `0.0.0.0`, not `127.0.0.1`. For Vite:
  `--host 0.0.0.0`.
- A preview does not wake a paused workspace, because a dev server does not
  survive a pause. The page says to run `cf-opencode connect`; then start the
  dev server again.
- A request through a preview counts as use, like the OpenCode client, so a
  preview tab that loads pages keeps the workspace awake.
- The preview lives under the path `/preview/<id>/<port>/`. A page that loads
  `/assets/app.js` asks for a path outside it. The Worker sends that request
  back under the prefix when its Referer is a preview page, which covers most
  dev servers. Hot reload opens a websocket with no Referer, so it may not
  connect: reload by hand, or give the dev server its base path (Vite:
  `--base /preview/<id>/<port>/`). A hostname for each preview would avoid
  this, but needs a custom domain with a wildcard DNS record.
- Every preview shares the Worker's origin. A page in one preview can read
  another preview that the same browser is signed in to, and `/oc` if the
  browser has a workspace password cached (only after you type one into a
  browser prompt). It cannot open `/shell`, `/ssh` or `/browse`, and the Worker
  drops `Service-Worker-Allowed` and `Clear-Site-Data` from its responses. Do
  not preview code you do not trust in that browser profile.

### Public URL

```sh
cf-opencode preview my-repo 3000 --public   # prints https://<worker>/public/my-repo/<token>/
cf-opencode preview my-repo --list
cf-opencode preview my-repo 3000 --stop     # --stop with no port removes all
```

Anyone with a public URL opens that port, with no password, while the
workspace is awake. There is none until you run `--public`. Only the control
token makes or removes one, so the agent in the workspace cannot. The token is
a random nonce and an HMAC under a key derived from the control token, so the
Worker refuses a forged one before it reaches the workspace; the workspace's
Durable Object keeps the ones that exist, so `--stop` ends one. This is cf-opencode's
own mechanism: Cloudflare's preview URLs (Sandbox SDK `exposePort`, or a
hostname for each preview) need a custom domain with a wildcard DNS record, and
a `workers.dev` install has none.

### The agent's own browser

The workspace's remote browser opens the dev server with no public URL, as
`http://p<port>.preview.internal/`:

```sh
cf-opencode-fetch http://p3000.preview.internal/     # Markdown; --screenshot f.png, --html, --links, --pdf
cf-opencode-browse --preview 3000                  # a CDP session that can open that address
```

Browser Run sends the browser's requests for that hostname to the Worker
([outbound Workers](https://developers.cloudflare.com/browser-run/features/outbound-workers/)),
and the Worker passes them to the port. `cf-opencode-fetch
http://localhost:3000/` works the same. It is HTTP only, with no websockets, so
hot reload does not connect there.

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
