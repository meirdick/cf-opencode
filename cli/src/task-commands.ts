// The `run` and `tasks` commands: argument handling and output. The logic is in handoff.ts and tasks.ts.
import { ControlClient } from "./api.js";
import { flagBool, flagString, type ParsedArgs } from "./args.js";
import { connect } from "./connect.js";
import { CliError, toFailedLine } from "./errors.js";
import { renderStarted, runTask } from "./handoff.js";
import { localWorkspaceIds } from "./sessions.js";
import {
  exitCodeFor,
  findTask,
  listTasks,
  looksLikeSession,
  renderTask,
  renderTasks,
  WAIT_TIMEOUT_MS,
  WaitTimeout,
  waitTask,
} from "./tasks.js";

type Install = { url: string; token: string };

const err = (line: string) => process.stderr.write(`${line}\n`);
const out = (line: string) => process.stdout.write(`${line}\n`);

function timeoutMs(args: ParsedArgs): number {
  const raw = flagString(args, "timeout");
  if (raw === undefined) return WAIT_TIMEOUT_MS;
  const min = Number(raw);
  if (!Number.isFinite(min) || min <= 0)
    throw new CliError(`bad --timeout ${raw}`, "pass minutes, for example --timeout 90");
  return min * 60_000;
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
  const wait = flagBool(args, "wait");
  const limit = wait ? timeoutMs(args) : 0;
  const title = flagString(args, "title");
  const model = flagString(args, "model");
  const r = await runTask(
    {
      ...install,
      task,
      ...(id ? { id } : {}),
      ...(title ? { title } : {}),
      ...(model ? { model } : {}),
      allowDirty: flagBool(args, "allow-dirty"),
      onLine: err,
    },
    { connect, client: (url, token) => new ControlClient(url, token) },
  );
  if (!wait) {
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
  if (!json) out(renderStarted(r));
  return finishWait(new ControlClient(install.url, install.token), r.workspace, r.task.id, limit, json);
}

export async function tasksCommand(args: ParsedArgs, install: Install): Promise<number> {
  const json = flagBool(args, "json");
  const client = new ControlClient(install.url, install.token);
  const pos = args.positionals[0];
  const ws = flagString(args, "workspace");
  if (pos && looksLikeSession(pos)) {
    const limit = flagBool(args, "wait") ? timeoutMs(args) : 0;
    const workspace = ws ?? (await findTask(client, localWorkspaceIds(), pos));
    if (limit > 0) return finishWait(client, workspace, pos, limit, json);
    const r = await client.task(workspace, pos);
    if (json) out(JSON.stringify({ ok: true, workspace, ...r }, null, 2));
    else out(renderTask({ workspace, ...r }));
    return 0;
  }
  if (flagBool(args, "wait"))
    throw new CliError("--wait needs one task", "cf-opencode tasks <session> --wait");
  const ids = pos ? [pos] : ws ? [ws] : localWorkspaceIds();
  const result = await listTasks(client, ids);
  if (json) out(JSON.stringify(result, null, 2));
  else out(renderTasks(result));
  return 0;
}

/** Wait, print the task, and exit 0 done, 1 failed, 2 waiting, 3 timed out. */
async function finishWait(
  client: ControlClient,
  workspace: string,
  sessionId: string,
  limit: number,
  json: boolean,
): Promise<number> {
  try {
    const v = await waitTask(client, workspace, sessionId, { timeoutMs: limit, onLine: err });
    if (json) out(JSON.stringify({ ok: true, ...v }, null, 2));
    else out(renderTask(v));
    return exitCodeFor(v.task.state);
  } catch (e) {
    if (!(e instanceof WaitTimeout)) throw e;
    if (json) out(JSON.stringify({ ok: false, timedOut: true, error: toFailedLine(e) }));
    else err(toFailedLine(e));
    return 3;
  }
}
