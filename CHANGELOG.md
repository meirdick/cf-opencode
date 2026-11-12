# Changelog

## 0.2.2 (2026-11-12)

- Just after a deploy, Cloudflare can answer for some seconds with its own page. The CLI now tries a read or
  an op submit again (after 1, 2 and 4 seconds), and when it gives up it prints one line with the HTTP status.
  Before, `connect` could stop with `Failed: <!DOCTYPE html>` while the workspace started anyway.

## 0.2.1 (2026-11-12)

- A workspace that was running when `cf-opencode notify-url` set the notify URL now sends task results to it.
  Before, it sent them only after its next restart.
- `changedFiles` in a task's result lists the files of the task's own commits and its uncommitted changes. It
  no longer lists files that changed upstream when the workspace first caught up with the remote.
- `init` and `upgrade` wait for the deployed version before they print "Worker healthy", so the line shows
  the new version.

## 0.2.0 (2026-11-12)

Everything in 0.1.1, and:

- `cf-opencode mcp`: an MCP server over stdio with the tools `handoff_task`, `get_task`, `wait_task` and
  `list_tasks`. A local agent (Claude Code, OpenCode, any MCP client) hands off a task and gets the task record as
  structured content: `get_task` and `wait_task` return the result record in `result`. It speaks MCP 2026-07-28 and answers `initialize` for 2025-11-25 and 2025-06-18 clients.
- A2A endpoint on the Worker, off by default (setting `a2a`). The Agent Card is at
  `/.well-known/agent-card.json`; the JSON-RPC endpoint `/a2a` takes the control token as a bearer token. It
  speaks A2A 1.0: `SendMessage` starts a task in the workspace that `message.metadata.workspace` names, and wakes
  it when it is paused; `GetTask`, `CancelTask` and `ListTasks` read and stop tasks. A blocking `SendMessage`
  waits 5 minutes at most. `GetTask` builds the task from the result record. Streaming and push notifications
  are not supported.
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
- `cf-opencode tasks <ses_…> --reply "<text>"` sends one more message to a handed-off session, for example the
  answer to its question. `run --skills a,b` copies skills before the task starts.
- A session knows where it is. The workspace notes say it is a clone of the remote with no local files, and how
  to tell an attended session from a handoff. A handed-off session gets a Handoff block before the task: who
  started it, the start branch and commit, to work alone, and that its last message is the result.
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

This release was audited before it shipped. It hardens these areas:

- Access checks on the new preview, task and agent-protocol routes.
- How text from a workspace is shown in your terminal and in tab completion.
- The signing of notifications, and limits on what a workspace can send.
- Outbound requests that carry a credential.
- The notify URL is stored as a secret.

## 0.1.1 (2026-11-12)

- `cf-opencode-search` in the workspace: web search through the account's AI binding and AI Gateway, with no
  key. Setting `searchProvider` (default `exa`).
- `cf-opencode-fetch` in the workspace: a page as Markdown, links, HTML, a screenshot or a PDF, through the
  Browser Run binding.
- The image has the Python `websocket` module, for the browser session's Chrome DevTools Protocol.

### Security

This release hardens the install. If you run 0.1.0, upgrade.

- Authentication is checked earlier, and a request without valid credentials gets one uniform answer.
- The workspace image build verifies what it downloads.
- Browser sessions and SSH keys are tied to their workspace.
- Requests from other websites are refused on the terminal and browser routes.
- `lockdown` also covers page reads.

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
