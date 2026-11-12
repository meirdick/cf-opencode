// The `run`, `tasks`, `skill` and `notify-key` commands: argument handling and output. The logic is in
// handoff.ts, tasks.ts, follow.ts, skill.ts and notify-key.ts.

import { readFileSync } from "node:fs";
import { ControlClient } from "./api.js";
import { flagBool, flagString, type ParsedArgs } from "./args.js";
import { derivePassword } from "./config.js";
import { connect } from "./connect.js";
import { CliError, toFailedLine } from "./errors.js";
import { followTask, openEventStream, renderEvent } from "./follow.js";
import { renderStarted, runTask } from "./handoff.js";
import { notifyKey } from "./notify-key.js";
import { replyTask } from "./reply.js";
import { readSchema } from "./schema.js";
import { localWorkspaceIds } from "./sessions.js";
import { installSkill, skillFile, skillTarget } from "./skill.js";
import { skillsHook } from "./skills-sync.js";
import { resultOf } from "./task-result.js";
import {
  exitCodeFor,
  findTask,
  listTasks,
  looksLikeSession,
  onlyUnseen,
  renderTask,
  renderTasks,
  type TaskView,
  WAIT_TIMEOUT_MS,
  WaitTimeout,
  waitTask,
} from "./tasks.js";
import { target } from "./terminal.js";
import { terminalSafe } from "./ui.js";

type Install = { url: string; token: string };

// Progress and notes can quote the workspace; results are made safe where they are rendered.
const err = (line: string) => process.stderr.write(`${terminalSafe(line)}\n`);
const out = (line: string) => process.stdout.write(`${line}\n`);

function timeoutMs(args: ParsedArgs): number {
  const raw = flagString(args, "timeout");
  if (raw === undefined) return WAIT_TIMEOUT_MS;
  const min = Number(raw);
  if (!Number.isFinite(min) || min <= 0)
    throw new CliError(`bad --timeout ${raw}`, "pass minutes, for example --timeout 90");
  return min * 60_000;
}

/** --wait or --follow, not both. */
function watchMode(args: ParsedArgs): "wait" | "follow" | undefined {
  const wait = flagBool(args, "wait");
  const follow = flagBool(args, "follow");
  if (wait && follow) throw new CliError("--wait and --follow do the same wait", "pass one of them");
  return follow ? "follow" : wait ? "wait" : undefined;
}

export async function runCommand(args: ParsedArgs, install: Install): Promise<number> {
  const [task, id, ...extra] = args.positionals;
  if (!task) throw new CliError("run needs a task", 'cf-opencode run "<task>" [workspace]');
  if (extra.length > 0)
    throw new CliError(
      "run takes the task as one argument",
      'put the task in quotes: cf-opencode run "<task>"',
    );
  const json = flagBool(args, "json");
  const mode = watchMode(args);
  const limit = mode ? timeoutMs(args) : 0;
  const title = flagString(args, "title");
  const model = flagString(args, "model");
  const schemaFile = flagString(args, "schema");
  // Before the wake: a bad schema must not cost a workspace start.
  const schema = schemaFile === undefined ? undefined : readSchema(schemaFile);
  const r = await runTask(
    {
      ...install,
      task,
      ...(id ? { id } : {}),
      ...(title ? { title } : {}),
      ...(model ? { model } : {}),
      ...(schema !== undefined ? { schema } : {}),
      allowDirty: flagBool(args, "allow-dirty"),
      beforeAttach: skillsHook(flagString(args, "skills"), flagString(args, "url"), err),
      onLine: err,
    },
    { connect, client: (url, token) => new ControlClient(url, token) },
  );
  if (!mode) {
    if (json)
      out(
        JSON.stringify({
          ok: true,
          workspace: r.workspace,
          session: r.task.id,
          title: r.task.title,
          state: r.task.state,
          ...(r.warning ? { warning: r.warning } : {}),
        }),
      );
    else out(renderStarted(r));
    return 0;
  }
  if (json) err(`started ${r.task.id} in ${r.workspace}`);
  else out(renderStarted(r));
  return finishWatch(install, r.workspace, r.task.id, mode, limit, json);
}

export async function tasksCommand(args: ParsedArgs, install: Install): Promise<number> {
  const json = flagBool(args, "json");
  const client = new ControlClient(install.url, install.token);
  const pos = args.positionals[0];
  const ws = flagString(args, "workspace");
  const mode = watchMode(args);
  if (pos && looksLikeSession(pos)) {
    const limit = mode ? timeoutMs(args) : 0;
    const workspace = ws ?? (await findTask(client, localWorkspaceIds(), pos));
    const reply = flagString(args, "reply");
    if (reply !== undefined) {
      await replyTask(target(install.url, workspace), pos, reply);
      if (!mode) {
        if (json) out(JSON.stringify({ ok: true, workspace, session: pos, replied: true }));
        else err(`Sent to ${pos}. Watch: cf-opencode tasks ${pos} --workspace ${workspace} --follow`);
        return 0;
      }
    }
    if (mode) return finishWatch(install, workspace, pos, mode, limit, json);
    // This read shows the result: it marks the task seen.
    const r = await client.task(workspace, pos, true);
    if (json) out(JSON.stringify(resultOf(workspace, r), null, 2));
    else out(renderTask({ workspace, ...r }));
    return 0;
  }
  if (flagString(args, "reply") !== undefined)
    throw new CliError("--reply needs one task", 'cf-opencode tasks <session> --reply "<text>"');
  if (mode) throw new CliError(`--${mode} needs one task`, `cf-opencode tasks <session> --${mode}`);
  const ids = pos ? [pos] : ws ? [ws] : localWorkspaceIds();
  const all = await listTasks(client, ids);
  const unseen = flagBool(args, "unseen");
  const result = unseen ? onlyUnseen(all) : all;
  if (json) out(JSON.stringify(result, null, 2));
  else out(renderTasks(result, Date.now(), { unseen }));
  return 0;
}

/**
 * Wait or follow, print the result record, and exit 0 done, 1 failed, 2 waiting, 3 timed out, 4 stopped.
 * The last read marks the task seen: this command showed its result.
 */
async function finishWatch(
  install: Install,
  workspace: string,
  sessionId: string,
  mode: "wait" | "follow",
  limit: number,
  json: boolean,
): Promise<number> {
  const client = new ControlClient(install.url, install.token);
  let v: TaskView;
  try {
    v =
      mode === "wait"
        ? await waitTask(client, workspace, sessionId, { timeoutMs: limit, onLine: err })
        : await followTask(
            client,
            openEventStream(install.url, workspace, derivePassword(install.token, workspace)),
            workspace,
            sessionId,
            {
              timeoutMs: limit,
              onNote: err,
              onEvent: (e) => {
                if (json) out(JSON.stringify(e));
                else {
                  const line = renderEvent(e);
                  if (line) out(line);
                }
              },
            },
          );
  } catch (e) {
    if (!(e instanceof WaitTimeout)) throw e;
    if (json) out(JSON.stringify({ ok: false, timedOut: true, error: toFailedLine(e) }));
    else err(toFailedLine(e));
    return 3;
  }
  const last = await client.task(workspace, sessionId, true).catch(() => v);
  const view: TaskView = { ...last, workspace };
  if (json) out(JSON.stringify(resultOf(workspace, view), null, mode === "follow" ? 0 : 2));
  else out(`${mode === "follow" ? "\n" : ""}${renderTask(view)}`);
  return exitCodeFor(view.task.state);
}

export async function skillCommand(args: ParsedArgs): Promise<number> {
  const json = flagBool(args, "json");
  if (!flagBool(args, "install")) {
    if (flagBool(args, "claude") || flagBool(args, "opencode") || flagString(args, "dir") !== undefined)
      throw new CliError(
        "--claude, --opencode and --dir go with --install",
        "cf-opencode skill --install --claude",
      );
    const path = skillFile();
    const content = readFileSync(path, "utf8");
    if (json) out(JSON.stringify({ ok: true, path, content }));
    else out(`${path}\n\n${content.trimEnd()}`);
    return 0;
  }
  const dir = flagString(args, "dir");
  const r = installSkill(
    skillTarget({
      claude: flagBool(args, "claude"),
      opencode: flagBool(args, "opencode"),
      ...(dir !== undefined ? { dir } : {}),
    }),
    { force: flagBool(args, "force") },
  );
  if (json) out(JSON.stringify({ ok: true, ...r }));
  else
    out(
      `${r.action === "unchanged" ? "Already installed" : r.action === "replaced" ? "Replaced" : "Installed"}: ${r.path}`,
    );
  return 0;
}

export async function notifyKeyCommand(args: ParsedArgs, install: Install): Promise<number> {
  const key = notifyKey(install.token);
  if (flagBool(args, "json")) out(JSON.stringify({ ok: true, key }));
  else {
    out(key);
    err(
      'Secret: give it only to the receiver of the notify URL. It checks x-cf-opencode-signature: sha256=<hex HMAC-SHA256 of "<x-cf-opencode-timestamp>.<body>">, and refuses a timestamp older than 5 minutes.',
    );
  }
  return 0;
}
