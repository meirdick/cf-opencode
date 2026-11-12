# Changelog

## Unreleased

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
- Setting `notifyUrl` (https, empty by default): when a task leaves `running`, the Worker's alarm POSTs its
  result record there, signed with `x-cf-opencode-signature: sha256=<HMAC>`; the key is `cf-opencode
  notify-key`. Retries after 1, 5 and 30 minutes, also while the workspace is paused. `tasks <ses_…>` shows
  the outcome.
- `cf-opencode-notify "<text>"` in the workspace posts a note to `notifyUrl` through the Worker.
- `cf-opencode skill` prints the handoff skill for agents; `--install --claude`, `--opencode` or `--dir` copies
  it into a skills folder, and never replaces a file that differs without `--force`.
- `cf-opencode preview <workspace> <port>` opens a dev server that runs in the workspace, in your browser, behind
  the workspace password. A one-time sign-in link gives the browser a cookie for that workspace and port; the
  password is never in a URL. A preview does not wake a paused workspace, and it counts as use for the idle pause.
- `cf-opencode preview … --public` makes a public URL with an unguessable token, off until you ask; `--stop`
  removes it and `--list` lists them. Only the control token can make one.
- `cf-opencode-preview <port>` in the workspace prints the preview URL and checks that the port listens on 0.0.0.0.
- The workspace's remote browser opens a dev server as `http://p<port>.preview.internal/`, with no public URL:
  `cf-opencode-fetch` reads it, and `cf-opencode-browse --preview <port>` opens a session that can reach it.

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
