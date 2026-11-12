# Changelog

## Unreleased

- `cf-opencode mcp`: an MCP server over stdio with the tools `handoff_task`, `get_task`, `wait_task` and
  `list_tasks`. A local agent (Claude Code, OpenCode, any MCP client) hands off a task and gets the task record as
  structured content: `get_task` and `wait_task` return the result record in `result`. It speaks MCP 2026-07-28 and answers `initialize` for 2025-11-25 and 2025-06-18 clients.
- A2A endpoint on the Worker, off by default (setting `a2a`). The Agent Card is at
  `/.well-known/agent-card.json`; the JSON-RPC endpoint `/a2a` takes the control token as a bearer token. It
  speaks A2A 1.0: `SendMessage` starts a task in the workspace that `message.metadata.workspace` names, and wakes
  it when it is paused; `GetTask`, `CancelTask` and `ListTasks` read and stop tasks. A blocking `SendMessage`
  waits 5 minutes at most. `GetTask` builds the task from the result record. Streaming and push notifications
  are not supported.
- `cf-opencode-search` in the workspace: web search through the account's AI binding and AI Gateway, with no
  key. Setting `searchProvider` (default `exa`).
- `cf-opencode-fetch` in the workspace: a page as Markdown, links, HTML, a screenshot or a PDF, through the
  Browser Run binding.
- The image has the Python `websocket` module, for the browser session's Chrome DevTools Protocol.
- `cf-opencode run "<task>"`: hand a task to OpenCode in the workspace of the checkout, and return. The task
  runs as a new session in the workspace. A preflight fails on changes that are not committed or pushed
  (`--allow-dirty` skips it). Flags: `--title`, `--model`, `--wait`, `--json`.
- `cf-opencode tasks`: handed-off tasks across workspaces, with state `running`, `done`, `failed` or
  `waiting`. `tasks <ses_…>` shows one task and its last message; `--wait` waits for it. Wakes nothing.
- `cf-opencode tasks <ses_…> --json` and `run --wait --json` print one result record: state, summary, and
  the branch, the commits since the task started, the changed files and the pull request, which the Worker
  reads with `git` and `gh pr view` in the workspace. A task with no commit is `done`, not `failed`. A waiting
  task carries the open question; a failed one its error.
- `run --schema <file.json>`: the agent ends with a `json` block that matches a JSON Schema subset (`type`,
  `properties`, `required`, `items`, `enum`, `additionalProperties: false`). The Worker checks it and puts it
  in `structured`, or says why not in `structuredError`. Other keywords fail before the wake.
- `--follow` on `run` and `tasks <ses_…>`: the agent's tool calls and messages live, from OpenCode's event
  stream through the Worker. It reconnects, and falls back to polling when the stream does not open. With
  `--json`, one normalized event per line, then the result record.
- A fifth task state, `stopped`: the workspace paused while the task ran. Its facts are read before the pause.
  Exit code 4 with `--wait` and `--follow`.
- `tasks` marks a task that ended with `*` until one `tasks <ses_…>` reads it; `tasks --unseen` lists only those.
- `cf-opencode notify-url`: when a task leaves `running`, the Worker's alarm POSTs its result record to this
  URL, signed with `x-cf-opencode-signature: sha256=<HMAC>`; the key is `cf-opencode notify-key`. Retries after
  1, 5 and 30 minutes, also while the workspace is paused. `tasks <ses_…>` shows the outcome. The URL is the
  Worker secret `NOTIFY_URL`, read from stdin or a hidden prompt, never an argument; `--remove` deletes it.
- `cf-opencode-notify "<text>"` in the workspace posts a note to the notify URL through the Worker.
- `cf-opencode init` installs the handoff skill for Claude Code and OpenCode when their config folder exists
  on the machine. It asks first on a terminal; `--no-skill` skips it. A file that differs is left alone.
- `cf-opencode skill` prints the handoff skill for agents; `--install --claude`, `--opencode` or `--dir` copies
  it into a skills folder, and never replaces a file that differs without `--force`.
- `cf-opencode preview [workspace] <port...>` opens a dev server that runs in the workspace at
  `http://localhost:<port>` on your machine, through an SSH port forward. Nothing is public, and the app is at
  the root, so hot reload works.
- `cf-opencode skills push <name...>` copies skills from this machine (`~/.config/opencode/skills`,
  `~/.claude/skills`) into a workspace, so the remote agent has them; `skills remove` deletes them and `skills`
  lists both sides. Nothing is copied unless you ask: `connect --skills a,b` (or `all`) copies in the same step.
  `skills default a b` saves a list on this machine; a workspace that starts from the image gets those skills on
  its first connect. The list is empty until you set it.
  `.git`, `node_modules`, `.env` and key files are left out, and links inside a skill are not followed.
- `cf-opencode completion <bash|zsh|fish>`: tab completion for commands, flags and workspace ids.
- `cf-opencode preview … --web` opens the dev server on a Worker URL instead, behind
  the workspace password. A one-time sign-in link gives the browser a cookie for that workspace and port; the
  password is never in a URL. A preview does not wake a paused workspace, and it counts as use for the idle pause.
- `cf-opencode preview … --public` makes a public URL with an unguessable token, off until you ask; `--stop`
  removes it and `--list` lists them. Only the control token can make one.
- `cf-opencode-preview <port>` in the workspace prints the preview URL and checks that the port listens on 0.0.0.0.
- The workspace's remote browser opens a dev server as `http://p<port>.preview.internal/`, with no public URL:
  `cf-opencode-fetch` reads it, and `cf-opencode-browse --preview <port>` opens a session that can reach it.

### Security

- The Worker checks the workspace password itself before it calls a workspace's Durable Object. A request
  to `/oc`, `/browse`, `/shell` or `/ssh` with no password or a wrong one is a 401 that costs one Worker
  request; before, it created a Durable Object for any id it named. Passwords are derived from the control
  token, so the check needs no state. The control API refuses a spawn with any other password.
- Every refused password gets the same 401 body, from the Worker and from the Durable Object. It names no
  workspace, and a deleted workspace answers 410 only to the holder of its password.
- `/shell`, `/ssh` and `/browse` refuse a request whose `Origin` is another site, so a web page cannot use
  Basic credentials a browser cached for the Worker. Clients that send no `Origin` (the CLI, ssh, curl) and
  the Worker's own origin still work.
- The browser relay `/browse/<workspace>/<session>` serves only sessions that workspace opened. Before, any
  workspace's password reached any browser session on the account.
- `authorized_keys` in a workspace is no longer append-only. A cf-opencode block holds the CLI keys that
  connected in the last 30 days; each SSH connect rewrites it, as the workspace user, not root. Keys an
  earlier release appended (comment `cf-opencode`) are removed; lines you wrote stay.
- `ssh` and `ssh-config` accept only an https Worker origin for `--url` (http only for localhost), and quote
  every part of the ssh `ProxyCommand`. Before, a `--url` with a `"` ran shell on this machine.
- The image no longer pipes the OpenCode installer script to bash. It downloads the linux x64 release asset
  the installer uses and checks it against a pinned SHA-256 (`OPENCODE_SHA256`); a mismatch fails the build.
- README "Trust" and the security page say what the agent account can do (it is root in its container, and
  holds the workspace password) and what protects you instead. `sudo` is unchanged.
- With `lockdown: true`, `cf-opencode-fetch` is refused. It loaded any URL through Browser Run, which got
  around lockdown's "no general internet".

- Previews: the Worker checks the workspace password, the preview cookie, the sign-in ticket and the public
  token itself before it calls a Durable Object. Before, an anonymous request to `/preview/<id>/…`,
  `/preview/<id>/link` or `/public/<id>/…` created a Durable Object for any id it named. A public token now
  carries its own HMAC over the workspace.
- A dev server's `Service-Worker-Allowed` and `Clear-Site-Data` no longer reach the browser. With the first, a
  service worker from one preview could control every page of the Worker's origin.
- `/shell`, `/ssh` and `/browse` also refuse a browser request from the Worker's own origin (any request with
  `Sec-Fetch-Site`). A preview page is on that origin.
- The notify URL is a Worker secret (`cf-opencode notify-url`), not the `notifyUrl` setting: a webhook URL
  often holds its own secret, and the setting was readable in the dashboard and in `status --json`. `status`
  and `doctor` say only whether it is set. It must be https to a public host name, not an IP address,
  `localhost` or an internal name. A `notifyUrl` key left in `~/.cf-opencode/config.json` fails with the fix.
- A blocking A2A `SendMessage` holds a Worker request for 5 minutes at most, not 60.
- Egress that adds a secret (a provider key, the GitHub token) no longer follows a redirect with the secret
  on it. The redirect goes back to the container.
- The CLI prints terminal control characters in text from a workspace (task titles and summaries, branch
  names, commit subjects, file names, `--follow` events, session titles, logs, errors) as `?`. An escape
  sequence there could write the clipboard or rewrite the terminal. The `--follow` stream buffers are bounded.
- Tab completion offers only plain words. A file named `$(cmd).json` in `~/.cf-opencode/workspaces` put shell
  on the bash command line.
- `preview --web` opens only a link on the Worker's preview path with plain characters; on Windows the opener
  is `cmd /c start`.
- The `run --schema` check uses own keys only (a required `constructor` passed before), and a json block
  nested deep enough to throw is a `structuredError` instead of stopping every task read of the workspace.
  The Worker cuts the failure reason, the summary and each changed file name, since the agent can answer for
  the scripts that read them.
- Two `connect`s in flight with different inputs no longer share one op. The op journal hashed a field the
  API never sends, so the second caller could attach to the first one's spawn and get its password.

## 0.1.0 (2026-11-12)

First release. One package, `cf-opencode`: the CLI. It carries the Worker source and the workspace image,
and deploys them to your Cloudflare account with `cf-opencode init`.

What works:

- Workspaces on Cloudflare Containers that pause to a snapshot when idle and restore on connect.
- Models through the account's AI binding and AI Gateway. Browsing through the Browser Run binding. No keys.
- `shell`, `ssh` and `ssh-config` over the Worker. No open port.
- GitHub access with a token that stays in the Worker. `init` sets it up once from the machine's `gh` login.
- `connect --continue` and `--session` open a session in the workspace. `sessions` lists them across workspaces.
- `rebuild` moves a workspace to the deployed image. Snapshots refresh before they expire.

Known limits are in the README, section Limits.
