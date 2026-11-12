// Handed-off tasks, for `cf-opencode run` and `cf-opencode tasks`.
//
// A task is an OpenCode session that `run` started with a first prompt. The session runs in opencode serve,
// so it outlives the command that started it. The Durable Object keeps the list of these sessions and the
// state it last read. A running workspace refreshes the list; a paused one answers from the copy, which
// is refreshed before each pause, so nothing is woken to show a task.
import { workspacePassword } from "../auth";
import { LAST_USE_KEY } from "./alarm";
import type { OrbContext } from "./context";
import { iso, loadOrb, redactWith } from "./journal";
import { sh } from "./spawn";
import { TASK_START_SH, TASK_STATUS_SH } from "./task-scripts";

export type TaskState = "running" | "done" | "failed" | "waiting";

export interface TaskRecord {
  /** The OpenCode session id. */
  id: string;
  title: string;
  /** Epoch ms, when `run` started it. */
  started: number;
  /** provider/model, when `run` chose one. */
  model?: string;
  state: TaskState;
  /** Why a failed task failed, when that is known. */
  reason?: string;
  /** The end of the last assistant message with text. */
  last?: string;
  /** Epoch ms of the session's last change, from OpenCode. */
  updated?: number;
}

export interface TaskList {
  tasks: TaskRecord[];
  /** When the states were read from OpenCode. Absent when they never were. */
  at?: string;
  /** True when read from the running workspace for this answer. */
  live: boolean;
}

export interface TaskInput {
  text: string;
  title?: string;
  /** provider/model, for example cloudflare-workers-ai/@cf/zai-org/glm-5.3. */
  model?: string;
}

export type StartResult = { ok: true; task: TaskRecord } | { ok: false; status: number; error: string };

export const TASKS_KEY = "tasks";
export const MAX_TASKS = 30;
/** A new session is not active until the agent loop picks up the prompt. Until then it counts as running. */
export const START_GRACE_MS = 2 * 60_000;
export const MAX_TASK_CHARS = 32_000;
const SESSION_ID_RE = /^ses[A-Za-z0-9_-]{1,100}$/;

type Ctx = Pick<OrbContext, "container" | "kv" | "clock" | "config" | "env" | "workspaceId">;

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
 * not picked up yet; after START_GRACE_MS it never started.
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
  const { text, title, model } = body;
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
  return { input };
}

function oneLine(s: string, cap: number): string {
  return s
    .replace(/\s*\n\s*/g, " ")
    .trim()
    .slice(0, cap);
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
  const directory = (await loadOrb(ctx.kv))?.directory ?? "/home/user/project";
  const model = input.model ? modelRef(input.model) : undefined;
  const spec = {
    create: {
      location: { directory },
      ...(input.title ? { title: input.title } : {}),
      ...(model ? { model } : {}),
    },
    prompt: { text: input.text },
  };
  let out: { id?: unknown; title?: unknown; error?: unknown } | undefined;
  try {
    const [cmd, opts] = sh(TASK_START_SH, {
      PORT: String(ctx.config.serverPort),
      OPENCODE_SERVER_PASSWORD: password,
      TASK: JSON.stringify(spec),
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
  };
  const saved = (await ctx.kv.get<{ tasks: TaskRecord[]; at?: string }>(TASKS_KEY)) ?? { tasks: [] };
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

/** Apply one status read to the saved tasks. A session that could not be read keeps its last state. */
export function applyStatus(tasks: TaskRecord[], status: StatusOut, now: number): TaskRecord[] {
  const active = new Set(status.active);
  return tasks.map((t) => {
    const s = status.sessions[t.id];
    if (!s || typeof s.error === "string") return t;
    const found = s.found === true;
    const time = (s.time ?? {}) as Record<string, unknown>;
    const { state, reason } = taskState(
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
    const next: TaskRecord = { ...t, state };
    if (reason) next.reason = reason;
    else delete next.reason;
    if (found && typeof s.title === "string" && s.title) next.title = s.title.slice(0, 200);
    if (typeof s.last === "string" && s.last) next.last = s.last.slice(-4000);
    if (typeof time.updated === "number") next.updated = time.updated;
    return next;
  });
}

/** Read the states from the running workspace and keep them. undefined when OpenCode did not answer. */
export async function captureTasks(ctx: Ctx): Promise<TaskList | undefined> {
  if (!ctx.container.running || !ctx.env.CONTROL_TOKEN) return undefined;
  const before = await ctx.kv.get<{ tasks: TaskRecord[]; at?: string }>(TASKS_KEY);
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
    // Read again: a task started while the script ran must not be lost.
    const current = (await ctx.kv.get<{ tasks: TaskRecord[] }>(TASKS_KEY)) ?? before;
    const tasks = applyStatus(current.tasks, status, ctx.clock.now());
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
  const saved = await ctx.kv.get<{ tasks: TaskRecord[]; at?: string }>(TASKS_KEY);
  return saved ? { ...saved, live: false } : { tasks: [], live: false };
}
