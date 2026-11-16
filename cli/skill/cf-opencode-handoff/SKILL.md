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
- **Long jobs**: `run` already tells the agent to run a job longer than a few minutes (a build, an import)
  with `cf-opencode-job start -- <command>` and end its turn; a message wakes the agent when the job ends.
  For a job of hours, also say: make it able to continue from a checkpoint, and commit and push at each
  checkpoint. A job ends at its `--max-minutes` (default 120), and `maxAwakeHours` stops it too.

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

Exit code 3 means it still runs, or this machine could not reach the Worker: do other work, then check again.
A line with `cannot reach` is about this machine's network. The task is not lost; do not start it again. Use `--follow` instead of `--wait` to
show the user the agent's progress live. Both end when this terminal ends; the task does not.

## 6. Read the result

The last JSON object is the result record: `state`, `summary`, `branch`, `commits`, `pullRequest`,
`changedFiles`, `unpushed`, `processes`, `jobs`, `question`, `error`, `structured`. `branch`, `commits`,
`pullRequest`, `unpushed` and `processes` are facts the Worker read in the workspace, not the agent's words.

Check `unpushed` and `processes` before you report a `done` task. `unpushed` is the count of commits that are
only on the workspace disk. `processes` are jobs the agent left running; the next pause stops them. When one
of them is present, the work is not safe. The Worker already sends the agent one automatic reply about it
(`autoReply` in the record), and the task stays `running` until that turn ends. If the task is still `done`
with one of them after that, send
`cf-opencode tasks <session> --workspace <workspace> --reply "Wait for your process to end, then commit and push."`
and watch again. Tell the user what you did.

| Exit | State | Do |
| --- | --- | --- |
| 0 | `done` | First check `unpushed` and `processes` (above). Then report the summary, the branch and the pull request. `commits: []` is normal for research. |
| 1 | `failed` | Report `error`. Offer to retry with a clearer brief, or to open the session. |
| 2 | `waiting` | The agent asks a question or a permission (`question`). Ask the user. Send the answer to a question with `cf-opencode tasks <session> --workspace <workspace> --reply "<answer>"`. A permission request is answered in OpenCode: `cf-opencode connect <workspace> --session <session>`. Then watch again. |
| 3 | timed out | The task still runs. A task whose agent waits for a long job (one of `jobs` is `running`) is `running` too, and can take long. Check again later. |
| 4 | `stopped` | The workspace paused under the task. Tell the user; `cf-opencode connect <workspace> --session <session>` continues it. |

To get the work locally: `git fetch origin <branch>`.

## Rules

- Never print or pass the control token or a workspace password.
- One task at a time in one workspace, unless the user asks for more.
- `cf-opencode tasks --unseen` lists results nobody read yet.
