// `cf-opencode tasks`: the tasks `run` handed off, across the workspaces this machine connected to.
// Every read is one short request, so a paused workspace answers from its saved copy and wakes nothing.
import type { ControlClient, RemoteTask, TaskResult, TaskState } from "./api.js";
import { CliError, toFailedLine } from "./errors.js";
import { renderResult, resultOf } from "./task-result.js";
import { fmtAge, table } from "./ui.js";

export interface TaskRow extends RemoteTask {
  workspace: string;
}

export interface TasksResult {
  rows: TaskRow[];
  /** Per workspace: where its list came from. */
  workspaces: { id: string; live: boolean; at?: string; error?: string }[];
}

export interface TaskView {
  workspace: string;
  task: RemoteTask;
  result?: TaskResult;
  live: boolean;
  at?: string;
}

/** Session ids start with ses_. A workspace id that looks like one needs --workspace. */
export const looksLikeSession = (s: string) => /^ses_/.test(s);

const iso = (ms: number) => new Date(ms).toISOString();

/** Ask each workspace for its tasks, and merge them: tasks that ended and nobody read first, then newest first. */
export async function listTasks(client: Pick<ControlClient, "tasks">, ids: string[]): Promise<TasksResult> {
  const answers = await Promise.all(
    ids.map(async (id) => {
      try {
        return { id, ...(await client.tasks(id)) };
      } catch (e) {
        return { id, tasks: [] as RemoteTask[], live: false, error: toFailedLine(e) };
      }
    }),
  );
  const rows = answers
    .flatMap((a) => a.tasks.map((t) => ({ ...t, workspace: a.id })))
    .sort((a, b) => Number(b.unseen === true) - Number(a.unseen === true) || b.started - a.started);
  const workspaces = answers.map((a) => ({
    id: a.id,
    live: a.live,
    ...("at" in a && a.at ? { at: a.at } : {}),
    ...("error" in a && a.error ? { error: a.error } : {}),
  }));
  return { rows, workspaces };
}

const short = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** Only the tasks that ended and nobody read yet: the inbox. */
export function onlyUnseen(r: TasksResult): TasksResult {
  return { ...r, rows: r.rows.filter((t) => t.unseen === true) };
}

export function renderTasks(r: TasksResult, now = Date.now(), o: { unseen?: boolean } = {}): string {
  if (r.workspaces.length === 0) return "No workspaces yet. In a git checkout: cf-opencode connect";
  const lines: string[] = [];
  if (r.rows.length === 0)
    lines.push(o.unseen ? "No unread results." : 'No tasks yet. In a git checkout: cf-opencode run "<task>"');
  else {
    lines.push(
      table(
        ["", "WORKSPACE", "SESSION", "STATE", "AGE", "TITLE"],
        r.rows.map((t) => [
          t.unseen ? "*" : "",
          t.workspace,
          t.id,
          t.state,
          fmtAge(iso(t.started), now),
          short(t.title, 60),
        ]),
      ),
    );
    if (r.rows.some((t) => t.unseen)) lines.push("", "* ended, not read yet. Reading one marks it read.");
    lines.push("", "Show one: cf-opencode tasks <session> --workspace <workspace>");
  }
  const saved = r.workspaces.filter((w) => !w.live && w.at && !w.error);
  if (saved.length > 0)
    lines.push(
      `Not running, states from the last refresh: ${saved.map((w) => `${w.id} (${fmtAge(w.at, now)})`).join(", ")}`,
    );
  for (const w of r.workspaces.filter((x) => x.error)) lines.push(`! ${w.id}: ${w.error}`);
  return lines.join("\n");
}

export function renderTask(v: TaskView, now = Date.now()): string {
  return renderResult(resultOf(v.workspace, v), { live: v.live, ...(v.at ? { at: v.at } : {}), now });
}

/** Which workspace has this task. Reads the saved lists; wakes nothing. */
export async function findTask(
  client: Pick<ControlClient, "tasks">,
  ids: string[],
  sessionId: string,
): Promise<string> {
  const r = await listTasks(client, ids);
  const hits = [...new Set(r.rows.filter((t) => t.id === sessionId).map((t) => t.workspace))];
  if (hits.length === 1) return hits[0] as string;
  if (hits.length === 0)
    throw new CliError(
      `no task ${sessionId} in the workspaces of this machine`,
      "cf-opencode tasks lists them; pass --workspace <id> for another",
    );
  throw new CliError(`task ${sessionId} is in ${hits.join(" and ")}`, `pass --workspace <id>`);
}

/** Exit code of `--wait` and `--follow`: 0 done, 1 failed, 2 waiting, 4 stopped. 3 is a timeout. */
export function exitCodeFor(state: TaskState): number {
  return state === "done" ? 0 : state === "waiting" ? 2 : state === "stopped" ? 4 : 1;
}

/** --wait gave up. Its exit code is 3, so a caller can tell it from a failed task. */
export class WaitTimeout extends CliError {}

export interface WaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  onLine?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const WAIT_INTERVAL_MS = 10_000;
export const WAIT_TIMEOUT_MS = 60 * 60_000;
/** Polls in a row that may fail (network, a deploy, OpenCode busy) before --wait gives up. */
const MAX_MISSES = 3;

/**
 * Poll until the task leaves running. Each poll is one short request; nothing is held open while the
 * agent works. A workspace that stops while the task runs cannot finish it, so that ends the wait too.
 */
export async function waitTask(
  client: Pick<ControlClient, "task">,
  workspace: string,
  sessionId: string,
  o: WaitOptions = {},
): Promise<TaskView> {
  const interval = o.intervalMs ?? WAIT_INTERVAL_MS;
  const timeout = o.timeoutMs ?? WAIT_TIMEOUT_MS;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = now() + timeout;
  let misses = 0;
  let lastError = "";
  o.onLine?.(`waiting for ${sessionId} in ${workspace} (a check every ${Math.round(interval / 1000)} s)`);
  for (;;) {
    try {
      const r = await client.task(workspace, sessionId);
      if (r.task.state !== "running") return { workspace, ...r };
      if (r.live) misses = 0;
      else {
        misses++;
        lastError = `workspace ${workspace} is not running`;
      }
    } catch (e) {
      // A task that is gone stays gone; anything else may pass.
      if (/no task ses/.test(toFailedLine(e))) throw e;
      misses++;
      lastError = toFailedLine(e)
        .replace(/^Failed: /, "")
        .replace(/ — fix: .*$/, "");
    }
    if (misses >= MAX_MISSES)
      throw new CliError(
        `${lastError}, so task ${sessionId} cannot finish`,
        `cf-opencode connect ${workspace} --session ${sessionId}`,
      );
    if (now() + interval > until)
      throw new WaitTimeout(
        `task ${sessionId} still runs after ${Math.round(timeout / 60_000)} min`,
        `wait again: cf-opencode tasks ${sessionId} --workspace ${workspace} --wait`,
      );
    await sleep(interval);
  }
}
