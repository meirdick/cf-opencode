---
name: cf-opencode-handoff
description: Hand a coding or research task to OpenCode in a cf-opencode workspace on Cloudflare, so the work goes on when the laptop is closed. Use when the user asks to run something in the cloud, in the background, in a workspace, overnight, or "while my laptop is off", or for a long task that does not need this machine.
---

# Hand off a task to a cf-opencode workspace

The remote agent works in a clone of the Git remote. It has not seen this conversation and cannot see
local files. It pushes a branch and opens a pull request when it finishes.

## 1. Decide

Hand off when the task is long, can run alone, and needs nothing that only this machine has. Do not
hand off a task that needs local secrets, local services, or files that are not pushed. Do a short task
here.

## 2. Preflight

1. Run `cf-opencode doctor`. Stop if a line starts with `✗`, and tell the user the fix it prints.
2. In the checkout, run `git status --short` and `git status -sb`. Commit and push what the task needs.
   `cf-opencode run` fails on changes that are not committed or pushed. Use `--allow-dirty` only when the
   user agrees that the workspace works without them.

## 3. Write the brief

Write the task as if to a new colleague. Include:

- **Goal**: what must be true when the task is done.
- **Branch**: where to start, and the branch name to use for the work.
- **Constraints**: files or areas not to touch, style rules, things that need no change.
- **Proof**: the commands that show the change works (tests, a build, a script), and what they must print.
- **Context**: facts from this conversation the agent needs. Paths, error messages, decisions.

Keep it in one quoted argument. Put long details in a file in the repository, push it, and name the file.

## 4. Start

```sh
cf-opencode run "<brief>" --title "<short title>" --json
```

Read `session` and `workspace` from the JSON. When the user needs a machine-readable answer, add
`--schema result.json` (a JSON Schema with only `type`, `properties`, `required`, `items`, `enum` and
`additionalProperties: false`). The result record then has `structured`, or `structuredError`.

## 5. Watch

Do not hold one long command. Check in a loop with a short timeout:

```sh
cf-opencode tasks <session> --workspace <workspace> --wait --timeout 5 --json
```

Exit code 3 means it still runs: do other work, then check again. Use `--follow` instead of `--wait` to
show the user the agent's progress live. Both end when this terminal ends; the task does not.

## 6. Read the result

The last JSON object is the result record: `state`, `summary`, `branch`, `commits`, `pullRequest`,
`changedFiles`, `question`, `error`, `structured`. `branch`, `commits` and `pullRequest` come from git,
not from the agent's words.

| Exit | State | Do |
| --- | --- | --- |
| 0 | `done` | Report the summary, the branch and the pull request. `commits: []` is normal for research. |
| 1 | `failed` | Report `error`. Offer to retry with a clearer brief, or to open the session. |
| 2 | `waiting` | The agent asks a question or a permission (`question`). Ask the user. Send the answer to a question with `cf-opencode tasks <session> --workspace <workspace> --reply "<answer>"`. A permission request is answered in OpenCode: `cf-opencode connect <workspace> --session <session>`. Then watch again. |
| 4 | `stopped` | The workspace paused under the task. Tell the user; `cf-opencode connect <workspace> --session <session>` continues it. |

To get the work locally: `git fetch origin <branch>`.

## Rules

- Never print or pass the control token or a workspace password.
- One task at a time in one workspace, unless the user asks for more.
- `cf-opencode tasks --unseen` lists results nobody read yet.
