# Plan: hand a task to a workspace (0.2.0)

Status: in progress. Items marked (done) are on the v0.2 branch.

## Goal

From a local agent session (OpenCode, Claude Code, or a shell), hand a task to
OpenCode in a cf-opencode workspace. The task runs with the laptop closed. The
result comes back as a branch or a pull request. The local agent can start
several tasks, watch them, and collect the results.

## How other tools do it

Five parts recur in tools that hand work to a remote agent (Amp orbs, Cursor
background agents, Codex cloud tasks, Claude Code on the web, Copilot coding
agent). This list is from knowledge of those tools, not from a new survey.

| Part | What it is | cf-opencode today |
| --- | --- | --- |
| Start command | One non-interactive command that starts the task and returns an id | Missing |
| Handoff instructions | A skill or rule that tells the local agent when and how to hand off | Missing |
| Isolation | One machine or one git worktree for each task | One workspace for each checkout |
| Status | List, watch, wait, and a clear end state | `sessions` lists; no end state |
| Result | A branch or pull request, plus a way to pull the changes | GitHub push works in a workspace |

## Rules

- The CLI is the interface. An agent hands off through its shell tool. No plugin is needed.
- The workspace clones from the Git remote. A handoff never sends local files.
- A task ends in one of four states: `done`, `failed`, `waiting` (a question or a permission), `stopped` (the workspace paused under it).
- A handoff never waits by default. `--wait` is opt in.
- Every command has `--json`, so an agent can read the result.

## Steps

### 1. `cf-opencode run`

1. `cf-opencode run "<task>"` wakes the workspace of the checkout, starts a new OpenCode session there with the task, prints the session id, and returns.
2. Send the task through the OpenCode server API (`POST /api/session`, then `/api/session/{id}/prompt`), so the session outlives the command.
3. Preflight on the local checkout: fail when the branch is not pushed or the tree has changes that are not committed. `--allow-dirty` skips the check and says what the workspace will not see.
4. Flags: `--branch`, `--model`, `--title`, `--wait`, `--json`, `--auto`.
5. `--auto` lets the remote agent run without permission prompts. Default: off. Without it, a prompt puts the task in `waiting`.
6. Add a fixed closing instruction to each task: commit, push the branch, open a pull request if `gh` works, and end with a short result.

### 2. Isolation

1. `cf-opencode run --new` starts the task in its own workspace, named `<checkout>-<short id>`.
2. `--worktree` starts the task in a new git worktree in the existing workspace (`opencode run --worktree` exists).
3. Default: the existing workspace, one task at a time. A second task while one runs fails with the two fixes: `--new` or `--worktree`.
4. `maxRunning` stays the cost guard. The error names it.

### 3. Status

1. (done) `cf-opencode tasks` lists handed-off tasks: workspace, session, state, age, title. Unread results first, marked `*`; `--unseen` lists only those.
2. (done) `cf-opencode tasks <id>` shows one task: state, summary, branch, commits, pull request, changed files.
3. (done) `cf-opencode tasks <id> --wait` returns when the task leaves the running state. Exit code: 0 done, 1 failed, 2 waiting, 3 timed out, 4 stopped. `--follow` does the same and streams the agent's progress.
4. (done) The Durable Object keeps the task list, as it does for sessions, so a paused workspace answers without a wake.
5. (done) State comes from the OpenCode API: active sessions, open permissions and forms, and the session outcome.
6. `cf-opencode tasks <id> --reply "<text>"` answers a waiting task.

### 4. Result

1. (done) The closing instruction makes the agent push a branch and open a pull request.
2. `cf-opencode tasks <id> --pull` fetches the task's branch into the local checkout.
3. (changed) A task that made no commit is `done`, with `commits: []`: many tasks are research. The result record carries the git facts (branch, commits since the start, changed files, pull request), read by the Worker with git, not from the agent's text.

### 5. Handoff instructions for agents

1. (done) Ship a skill file in the package (`cli/skill/cf-opencode-handoff/SKILL.md`): when to hand off, the preflight, how to write the task prompt, how to check status.
2. (done, except init) `cf-opencode skill` prints where the file is. `cf-opencode skill --install --claude | --opencode | --dir` copies it into the agent's skills folder. `init` does not print it yet.
3. (done) The task prompt rule, from the orb skill: goal, branch, constraints, and how to prove the change works. The remote agent has not seen the local conversation.
4. The agent notes in the workspace (`AGENTS.md`) get a section for handed-off tasks: finish with commit, push, pull request, and a result line.

### 6. Checks before release

1. Unit tests for the preflight, the state mapping, and the task list.
2. Live tests: one task to a pull request; two tasks with `--new`; a task that asks a question, then `--reply`; laptop closed during a task; a task on a private repository.
3. Docs: a guide "Hand off a task", the CLI reference, and the skill.

### 6b. Result and push (done)

1. One result record for `tasks <id> --json`, `run --wait --json` and `notifyUrl`.
2. `run --schema <file.json>`: a JSON Schema subset for a final `json` block; `structured` or `structuredError`.
3. `--follow` on `run` and `tasks <id>`: OpenCode's event stream through `/oc`, with reconnect and a polling fallback.
4. `notifyUrl`: the Durable Object alarm POSTs the signed result record when a task leaves `running`, with retries after 1, 5 and 30 minutes. `cf-opencode-notify` in the workspace sends a note.
5. A `stopped` state for a task the workspace paused under.
6. Live tests still to run: `--follow` against OpenCode 2.2.7, a notification to a real receiver, a pause under a running task, `gh pr view` through egress.

### 7. Preview a dev server

1. `cf-opencode preview <workspace> <port>` prints a URL on the Worker that proxies to that port in the workspace, behind the workspace password. No public URL.
2. `cf-opencode-preview <port>` in the workspace prints the same URL, so the agent can give it to the user.
3. `--public` makes a URL that needs no password, with Cloudflare's own feature for that. It is off by default and says what it exposes. `--stop` removes it.
4. The remote browser (`cf-opencode-browse`, `cf-opencode-fetch`) can open the dev server by an internal hostname, with no public URL, so the agent can check its own frontend work.
5. A request to a preview counts as use for the idle pause.

## Open questions

1. Does the OpenCode 2 server API accept `--auto` for a session started over HTTP? If not, `run` starts the session with `opencode run --auto` in the workspace, detached.
2. Can an OpenCode 2 plugin register a tool? If yes, a later release adds a `delegate` tool, so the local agent hands off without the shell.
3. Should `--new` workspaces delete themselves after the pull request merges?
4. What is the default model for a handed-off task: the workspace default, or a stronger one?

## Order of work

1. Step 1 without `--wait` and `--auto`.
2. Step 3, items 1 to 5.
3. `--wait`, `--auto`, `--reply`.
4. Step 2.
5. Steps 4 and 5.
6. Step 6.
