// Handed-off tasks, for `cf-opencode run` and `cf-opencode tasks`.
//
// A task is an OpenCode session that `run` started with a first prompt. The session runs in opencode serve,
// so it outlives the command that started it. The Durable Object keeps the list of these sessions and the
// state it last read. A running workspace refreshes the list; a paused one answers from the copy, which
// is refreshed before each pause, so nothing is woken to show a task.
import { workspacePassword } from "../auth";
import { checkSchema, MAX_SCHEMA_CHARS, structuredResult } from "../core/json-subset";
import { LAST_USE_KEY } from "./alarm";
import type { OrbContext } from "./context";
import { iso, loadOrb, redactWith } from "./journal";
import { sh } from "./spawn";
import type { TaskResult } from "./task-result";
import { TASK_GIT_SH, TASK_START_SH, TASK_STATUS_SH } from "./task-scripts";

/** stopped: the workspace paused while the task ran. The session goes on after a connect. */
export type TaskState = "running" | "done" | "failed" | "waiting" | "stopped";

export interface Commit {
  sha: string;
  subject: string;
}

/** A delivery to the notify URL that has not succeeded yet (task-notify.ts). */
export interface PendingNotify {
  /** The state the delivery reports. */
  state: TaskState;
  /** Tries made so far. */
  tries: number;
  /** Epoch ms of the next try. */
  next: number;
}

export interface TaskRecord {
  /** The OpenCode session id. */
  id: string;
  title: string;
  /** Epoch ms, when `run` started it. */
  started: number;
  /** provider/model, when `run` chose one. */
  model?: string;
  state: TaskState;
  /** Why a failed task failed, or why a task stopped, when that is known. */
  reason?: string;
  /** The end of the last assistant message with text. */
  last?: string;
  /** Epoch ms of the session's last change, from OpenCode. */
  updated?: number;
  /** HEAD of the checkout when the task started. Commits after it are the task's. */
  base?: string;
  /** The JSON Schema (json-subset.ts) the last message must end with, from `run --schema`. */
  schema?: unknown;
  /** The open permission request or form, while waiting. */
  question?: string;
  /** Facts read with git in the workspace (TASK_GIT_SH). Absent until they were read once. */
  branch?: string;
  commits?: Commit[];
  pullRequest?: string;
  changedFiles?: string[];
  structured?: unknown;
  structuredError?: string;
  /** Set when the task leaves running; cleared when a client reads this one task. */
  unseen?: boolean;
  notify?: PendingNotify;
  notified?: { at: string; status: number; state: TaskState };
  notifyError?: string;
}

export interface TaskList {
  tasks: TaskRecord[];
  /** When the states were read from OpenCode. Absent when they never were. */
  at?: string;
  /** True when read from the running workspace for this answer. */
  live: boolean;
}

/** One task for GET /tasks/<id>: the saved record and its result record (task-result.ts). */
export interface TaskOne {
  task: TaskRecord;
  result: TaskResult;
  live: boolean;
  at?: string;
}

export interface TaskInput {
  text: string;
  title?: string;
  /** provider/model, for example cloudflare-workers-ai/@cf/zai-org/glm-5.3. */
  model?: string;
  /** JSON Schema subset for the result block. The CLI already put it in the text. */
  schema?: unknown;
}

export type StartResult = { ok: true; task: TaskRecord } | { ok: false; status: number; error: string };

export const TASKS_KEY = "tasks";
export const MAX_TASKS = 30;
/** A new session is not active until the agent loop picks up the prompt. Until then it counts as running. */
export const START_GRACE_MS = 2 * 60_000;
export const MAX_TASK_CHARS = 32_000;
export const SUMMARY_CHARS = 4000;
const SESSION_ID_RE = /^ses[A-Za-z0-9_-]{1,100}$/;

type Ctx = Pick<OrbContext, "container" | "kv" | "clock" | "config" | "env" | "workspaceId">;
type Saved = { tasks: TaskRecord[]; at?: string };

/** What OpenCode says about one session. */
export interface SessionFacts {
  /** False when OpenCode does not know the session. */
  found: boolean;
  /** In GET /api/session/active. */
  active: boolean;
  /** Open permission requests and forms: the agent waits for a person. */
  permissions: number;
  forms: number;
  /** Session.Info outcome of the last turn: succeeded, failed or interrupted. */
  outcome?: string;
  /** The failure message of the last turn, when OpenCode gave one. */
  reason?: string;
}

/**
 * The task state from what OpenCode says. A question waits even while the session is active, because the
 * agent cannot go on without an answer. A session with no outcome and no activity is a prompt the loop has
 * not picked up yet; after START_GRACE_MS it never started. A task that made no commit is still done: many
 * tasks are research. `stopped` is not here: only a pause sets it (stopTasks).
 */
export function taskState(
  f: SessionFacts,
  started: number,
  now: number,
): { state: TaskState; reason?: string } {
  if (!f.found) return { state: "failed", reason: "OpenCode no longer has this session" };
  if (f.permissions > 0 || f.forms > 0) return { state: "waiting" };
  if (f.active) return { state: "running" };
  if (f.outcome === "succeeded") return { state: "done" };
  if (f.outcome === "failed")
    return { state: "failed", reason: f.reason || "the agent stopped with an error" };
  if (f.outcome === "interrupted")
    return { state: "failed", reason: f.reason || "the session was interrupted" };
  if (now - started < START_GRACE_MS) return { state: "running" };
  return { state: "failed", reason: "the session did not start" };
}

/** provider/model → OpenCode's Model.Ref. The model id may itself hold slashes (@cf/zai-org/glm-5.3). */
export function modelRef(model: string): { providerID: string; id: string } | undefined {
  const i = model.indexOf("/");
  if (i < 1 || i === model.length - 1) return undefined;
  const providerID = model.slice(0, i);
  const id = model.slice(i + 1);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(providerID) || id.length > 200 || /[\s\0]/.test(id)) return undefined;
  return { providerID, id };
}

/** Check a POST body. The CLI adds the closing instruction; this only bounds what it sends. */
export function parseTaskInput(
  body: Record<string, unknown>,
): { input: TaskInput } | { error: string; fix: string } {
  const { text, title, model, schema } = body;
  if (typeof text !== "string" || !text.trim())
    return { error: "text is empty", fix: 'send { text: "<task>" }' };
  if (text.length > MAX_TASK_CHARS)
    return {
      error: `the task is over ${MAX_TASK_CHARS} characters`,
      fix: "shorten it; put details in a file in the repository",
    };
  const input: TaskInput = { text };
  if (title !== undefined) {
    if (typeof title !== "string" || title.length > 200 || [...title].some((c) => c.charCodeAt(0) < 32))
      return { error: "bad title", fix: "one line, up to 200 characters" };
    if (title.trim()) input.title = title.trim();
  }
  if (model !== undefined) {
    if (typeof model !== "string" || !modelRef(model))
      return {
        error: `bad model ${String(model).slice(0, 80)}`,
        fix: "use provider/model, for example cloudflare-workers-ai/@cf/zai-org/glm-5.3",
      };
    input.model = model;
  }
  if (schema !== undefined) {
    if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS)
      return { error: `the schema is over ${MAX_SCHEMA_CHARS} characters`, fix: "make the schema smaller" };
    const why = checkSchema(schema);
    if (why)
      return {
        error: `the schema is outside the supported subset (${why})`,
        fix: "use type, properties, required, items, enum and additionalProperties false only",
      };
    input.schema = schema;
  }
  return { input };
}

function oneLine(s: string, cap: number): string {
  return s
    .replace(/\s*\n\s*/g, " ")
    .trim()
    .slice(0, cap);
}

async function directoryOf(ctx: Ctx): Promise<string> {
  return (await loadOrb(ctx.kv))?.directory ?? "/home/user/project";
}

/** Start a session with the task as its first prompt, and keep it in the task list. Wakes nothing. */
export async function startTask(ctx: Ctx, input: TaskInput): Promise<StartResult> {
  const id = ctx.workspaceId;
  if (!ctx.container.running)
    return {
      ok: false,
      status: 409,
      error: `Failed: workspace ${id} is not running — fix: cf-opencode connect ${id} --no-attach, then retry`,
    };
  if (!ctx.env.CONTROL_TOKEN)
    return {
      ok: false,
      status: 500,
      error: "Failed: the Worker has no CONTROL_TOKEN — fix: cf-opencode upgrade",
    };
  const password = await workspacePassword(ctx.env.CONTROL_TOKEN, id);
  const directory = await directoryOf(ctx);
  const model = input.model ? modelRef(input.model) : undefined;
  const spec = {
    create: {
      location: { directory },
      ...(input.title ? { title: input.title } : {}),
      ...(model ? { model } : {}),
    },
    prompt: { text: input.text },
  };
  let out: { id?: unknown; title?: unknown; base?: unknown; error?: unknown } | undefined;
  try {
    const [cmd, opts] = sh(TASK_START_SH, {
      PORT: String(ctx.config.serverPort),
      OPENCODE_SERVER_PASSWORD: password,
      TASK: JSON.stringify(spec),
      DIRECTORY: directory,
    });
    const r = await ctx.container.exec(cmd, { ...opts, timeoutMs: 45_000 });
    out = r.exitCode === 0 ? (JSON.parse(r.stdout.trim()) as typeof out) : undefined;
    if (!out) throw new Error(oneLine(r.stderr || `exit ${r.exitCode}`, 200));
  } catch (e) {
    const why = redactWith(password, oneLine(e instanceof Error ? e.message : String(e), 200));
    return {
      ok: false,
      status: 502,
      error: `Failed: OpenCode in ${id} did not answer (${why}) — fix: cf-opencode logs ${id}`,
    };
  }
  if (typeof out.id !== "string" || !SESSION_ID_RE.test(out.id) || out.error) {
    const why = redactWith(password, oneLine(String(out.error ?? "no session id"), 300));
    const made = typeof out.id === "string" ? ` (session ${out.id} has no task)` : "";
    return {
      ok: false,
      status: 502,
      error: `Failed: OpenCode refused the task: ${why}${made} — fix: check --model, then retry`,
    };
  }
  const now = ctx.clock.now();
  const task: TaskRecord = {
    id: out.id,
    title: input.title ?? (typeof out.title === "string" && out.title ? out.title : oneLine(input.text, 80)),
    started: now,
    ...(input.model ? { model: input.model } : {}),
    state: "running",
    ...(typeof out.base === "string" && /^[0-9a-f]{40}$/.test(out.base) ? { base: out.base } : {}),
    ...(input.schema !== undefined ? { schema: input.schema } : {}),
  };
  const saved = (await ctx.kv.get<Saved>(TASKS_KEY)) ?? { tasks: [] };
  await ctx.kv.put(TASKS_KEY, {
    ...saved,
    tasks: [task, ...saved.tasks.filter((t) => t.id !== task.id)].slice(0, MAX_TASKS),
  });
  // The agent is about to work. Count it as use, so the idle pause does not fall in the gap before it starts.
  await ctx.kv.put(LAST_USE_KEY, iso(now));
  return { ok: true, task };
}

interface StatusOut {
  active: string[];
  sessions: Record<string, Record<string, unknown>>;
}

/** The status script's output, or undefined when it is not that. */
export function parseTaskStatus(stdout: string): StatusOut | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  const r = raw as Partial<StatusOut> | null;
  if (!r || !Array.isArray(r.active) || !r.sessions || typeof r.sessions !== "object") return undefined;
  return { active: r.active.filter((x): x is string => typeof x === "string"), sessions: r.sessions };
}

/**
 * The task left running, or moved between two end states. Mark it unseen for the inbox, and queue one
 * delivery to the notify URL (NOTIFY_URL) when one is set. A newer change replaces a delivery still waiting for a retry.
 */
export function markEnded(t: TaskRecord, now: number, notify: boolean): TaskRecord {
  const next: TaskRecord = { ...t, unseen: true };
  delete next.notified;
  delete next.notifyError;
  if (notify) next.notify = { state: t.state, tries: 0, next: now };
  else delete next.notify;
  return next;
}

/**
 * Apply one status read to the saved tasks. A session that could not be read keeps its last state. With
 * `notify`, a task that changes to an end state queues a delivery (markEnded).
 */
export function applyStatus(
  tasks: TaskRecord[],
  status: StatusOut,
  now: number,
  opts: { notify?: boolean } = {},
): TaskRecord[] {
  const active = new Set(status.active);
  return tasks.map((t) => {
    const s = status.sessions[t.id];
    if (!s || typeof s.error === "string") return t;
    const found = s.found === true;
    const time = (s.time ?? {}) as Record<string, unknown>;
    let { state, reason } = taskState(
      {
        found,
        active: active.has(t.id),
        permissions: typeof s.permissions === "number" ? s.permissions : 0,
        forms: typeof s.forms === "number" ? s.forms : 0,
        ...(typeof s.outcome === "string" ? { outcome: s.outcome } : {}),
        ...(typeof s.reason === "string" && s.reason ? { reason: s.reason } : {}),
      },
      t.started,
      now,
    );
    // The pause interrupted the session. That is the stop already recorded, not a failure of the task.
    if (t.state === "stopped" && state === "failed" && s.outcome === "interrupted") {
      state = "stopped";
      reason = t.reason;
    }
    let next: TaskRecord = { ...t, state };
    if (reason) next.reason = reason;
    else delete next.reason;
    if (found && typeof s.title === "string" && s.title) next.title = s.title.slice(0, 200);
    const last = typeof s.last === "string" && s.last ? s.last : undefined;
    if (last) next.last = last.slice(-SUMMARY_CHARS);
    if (typeof time.updated === "number") next.updated = time.updated;
    if (state === "waiting" && typeof s.question === "string" && s.question)
      next.question = s.question.slice(0, 1000);
    else delete next.question;
    delete next.structured;
    delete next.structuredError;
    // Read the result block from the whole last message: the summary keeps only its end.
    if (t.schema !== undefined && state !== "running")
      Object.assign(next, structuredResult(last ?? t.last, t.schema));
    if (state !== t.state && state !== "running") next = markEnded(next, now, opts.notify === true);
    return next;
  });
}

interface GitOut {
  branch?: string;
  pullRequest?: string;
  tasks: Record<string, { commits?: unknown; changedFiles?: unknown }>;
}

/** The git script's output, or undefined when it is not that. */
export function parseGitFacts(stdout: string): GitOut | undefined {
  try {
    const r = JSON.parse(stdout.trim()) as Partial<GitOut> | null;
    if (!r?.tasks || typeof r.tasks !== "object") return undefined;
    return { tasks: r.tasks, ...r } as GitOut;
  } catch {
    return undefined;
  }
}

/** Put the git facts on the tasks they are for. A task with no entry keeps what it had. */
export function applyFacts(tasks: TaskRecord[], facts: GitOut, ids: Set<string>): TaskRecord[] {
  return tasks.map((t) => {
    const f = facts.tasks[t.id];
    if (!ids.has(t.id) || !f) return t;
    const commits = Array.isArray(f.commits)
      ? f.commits
          .filter(
            (c): c is Commit =>
              !!c &&
              typeof c.sha === "string" &&
              /^[0-9a-f]{40}$/.test(c.sha) &&
              typeof c.subject === "string",
          )
          .slice(0, 30)
          .map((c) => ({ sha: c.sha, subject: c.subject.slice(0, 200) }))
      : [];
    const files = Array.isArray(f.changedFiles)
      ? f.changedFiles.filter((x): x is string => typeof x === "string").slice(0, 100)
      : [];
    const next: TaskRecord = { ...t, commits, changedFiles: files };
    if (typeof facts.branch === "string" && facts.branch) next.branch = facts.branch.slice(0, 200);
    if (typeof facts.pullRequest === "string" && /^https:\/\//.test(facts.pullRequest))
      next.pullRequest = facts.pullRequest.slice(0, 500);
    return next;
  });
}

/** Run TASK_GIT_SH for these tasks. undefined when it did not answer; facts are a nice to have. */
async function readFacts(ctx: Ctx, tasks: TaskRecord[], gh: boolean): Promise<GitOut | undefined> {
  const want = tasks.filter((t) => t.base);
  if (want.length === 0) return undefined;
  try {
    const [cmd, opts] = sh(TASK_GIT_SH, {
      DIRECTORY: await directoryOf(ctx),
      TASKS: JSON.stringify(
        want.map((t) => ({ id: t.id, base: t.base, since: Math.floor(t.started / 1000) })),
      ),
      GH: gh ? "1" : "0",
      GH_TOKEN: "cf-opencode-egress",
    });
    // Bounded: a pause runs this before its snapshot.
    const r = await ctx.container.exec(cmd, { ...opts, timeoutMs: 30_000 });
    return r.exitCode === 0 ? parseGitFacts(r.stdout) : undefined;
  } catch {
    return undefined;
  }
}

export interface CaptureOptions {
  /** Read git facts for these tasks too. Tasks that leave running get them anyway. */
  facts?: string[];
  /** Ask gh for the pull request. On by itself when a task leaves running. */
  gh?: boolean;
}

/** Read the states from the running workspace and keep them. undefined when OpenCode did not answer. */
export async function captureTasks(ctx: Ctx, o: CaptureOptions = {}): Promise<TaskList | undefined> {
  if (!ctx.container.running || !ctx.env.CONTROL_TOKEN) return undefined;
  const before = await ctx.kv.get<Saved>(TASKS_KEY);
  if (!before || before.tasks.length === 0) return { tasks: [], live: true };
  try {
    const ids = before.tasks.map((t) => t.id).filter((id) => SESSION_ID_RE.test(id));
    const [cmd, opts] = sh(TASK_STATUS_SH, {
      PORT: String(ctx.config.serverPort),
      IDS: ids.join(" "),
      OPENCODE_SERVER_PASSWORD: await workspacePassword(ctx.env.CONTROL_TOKEN, ctx.workspaceId),
    });
    const r = await ctx.container.exec(cmd, { ...opts, timeoutMs: 20_000 });
    const status = r.exitCode === 0 ? parseTaskStatus(r.stdout) : undefined;
    if (!status) return undefined;
    // Facts for the tasks that end with this read, so the result and the notification carry them.
    const preview = applyStatus(before.tasks, status, ctx.clock.now());
    const ending = preview.filter((t, i) => t.state !== before.tasks[i]?.state && t.state !== "running");
    const factIds = new Set([...(o.facts ?? []), ...ending.map((t) => t.id)]);
    const facts = factIds.size
      ? await readFacts(
          ctx,
          preview.filter((t) => factIds.has(t.id)),
          o.gh === true || ending.length > 0,
        )
      : undefined;
    // Read again: a task started while the scripts ran must not be lost. No await from here to the put, so
    // a concurrent read cannot mark the same change twice.
    const current = (await ctx.kv.get<Saved>(TASKS_KEY)) ?? before;
    let tasks = applyStatus(current.tasks, status, ctx.clock.now(), {
      notify: Boolean(ctx.env.NOTIFY_URL),
    });
    if (facts) tasks = applyFacts(tasks, facts, factIds);
    const at = iso(ctx.clock.now());
    await ctx.kv.put(TASKS_KEY, { tasks, at });
    return { tasks, at, live: true };
  } catch {
    return undefined;
  }
}

/** The live states when the workspace runs, else the copy from its last refresh. Wakes nothing. */
export async function readTasks(ctx: Ctx): Promise<TaskList> {
  const live = await captureTasks(ctx);
  if (live) return live;
  const saved = await ctx.kv.get<Saved>(TASKS_KEY);
  return saved ? { ...saved, live: false } : { tasks: [], live: false };
}

/**
 * One task. `seen` marks the read that shows the result to someone: it clears the unseen mark, and reads
 * live git facts for a running task. A poll (no `seen`) reads git only for an ended task that has no facts
 * yet, so `--wait` does not run git every 10 s. An ended task's facts are read once, with the pull request.
 */
export async function readTask(
  ctx: Ctx,
  id: string,
  o: { seen?: boolean } = {},
): Promise<{ task: TaskRecord; live: boolean; at?: string } | undefined> {
  const saved = await ctx.kv.get<Saved>(TASKS_KEY);
  const t = saved?.tasks.find((x) => x.id === id);
  if (!t) return undefined;
  const ended = t.state !== "running";
  const needFacts = ended ? t.commits === undefined : o.seen === true;
  const live = await captureTasks(ctx, needFacts ? { facts: [id], gh: ended } : {});
  const list = live ?? { ...(saved as Saved), live: false };
  let task = list.tasks.find((x) => x.id === id) ?? t;
  if (o.seen && task.unseen) {
    // Read again and write at once, so a refresh that ran meanwhile is kept.
    const now = (await ctx.kv.get<Saved>(TASKS_KEY)) ?? { tasks: [] };
    const tasks = now.tasks.map((x) => (x.id === id ? { ...x, unseen: false } : x));
    await ctx.kv.put(TASKS_KEY, { ...now, tasks });
    task = tasks.find((x) => x.id === id) ?? { ...task, unseen: false };
  }
  return { task, live: list.live, ...(list.at ? { at: list.at } : {}) };
}

/**
 * The workspace stops under its running tasks (a cold pause, the end of a warm period). Read them one last
 * time, with their git facts, then save the ones still running as stopped, so `tasks` on the paused
 * workspace says so instead of running. The session goes on after a connect.
 */
export async function stopTasks(ctx: Ctx): Promise<void> {
  const saved = await ctx.kv.get<Saved>(TASKS_KEY);
  const running = saved?.tasks.filter((t) => t.state === "running").map((t) => t.id) ?? [];
  if (running.length === 0) return;
  await captureTasks(ctx, { facts: running, gh: true }).catch(() => undefined);
  const after = await ctx.kv.get<Saved>(TASKS_KEY);
  if (!after?.tasks.some((t) => t.state === "running")) return;
  const now = ctx.clock.now();
  const notify = Boolean(ctx.env.NOTIFY_URL);
  const tasks = after.tasks.map((t) =>
    t.state !== "running"
      ? t
      : markEnded(
          {
            ...t,
            state: "stopped",
            reason: `the workspace paused while the task ran; continue it with cf-opencode connect ${ctx.workspaceId} --session ${t.id}`,
          },
          now,
          notify,
        ),
  );
  await ctx.kv.put(TASKS_KEY, { ...after, tasks });
}
