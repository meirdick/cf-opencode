// Handed-off tasks, for `cf-opencode run` and `cf-opencode tasks`.
//
// A task is an OpenCode session that `run` started with a first prompt. The session runs in opencode serve,
// so it outlives the command that started it. The Durable Object keeps the list of these sessions and the
// state it last read. A running workspace refreshes the list; a paused one answers from the copy, which
// is refreshed before each pause, so nothing is woken to show a task.

import { workspacePassword } from "../auth";
import { checkSchema, MAX_SCHEMA_CHARS, structuredResult } from "../core/json-subset";
import { LAST_USE_KEY } from "./alarm";
import { type AutoReply, planAutoReplies, replyGate, sendAutoReplies } from "./auto-reply";
import type { OrbContext } from "./context";
import { holdingJobs, type JobFact, jobsOf, parseJobs, stopJobs } from "./jobs";
import { iso, loadOrb, redactWith } from "./journal";
import { sh } from "./spawn";
import { type Handoff, handoffBlock, parseHandoff } from "./task-context";
import { currentNotifyUrl } from "./task-notify";
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
  /** Commits on HEAD that no remote branch has, when the facts were read. */
  unpushed?: number;
  /** Processes left running in the checkout that nothing watches, when the facts were read. A pause stops them. */
  processes?: string[];
  structured?: unknown;
  structuredError?: string;
  /** Set when the task leaves running; cleared when a client reads this one task. */
  unseen?: boolean;
  notify?: PendingNotify;
  notified?: { at: string; status: number; state: TaskState };
  notifyError?: string;
  /** `run --auto`: the session has no permission prompts (TASK_START_SH), and a read answers any left. */
  auto?: boolean;
  /** `run --worktree`: the git worktree the task works in. Absent: the workspace checkout. */
  worktree?: string;
  /** The long jobs (jobs.ts) tied to this session, as the last status read saw them. */
  jobs?: JobFact[];
  /** The automatic reply (auto-reply.ts). Set once, and never cleared, so it is sent at most once. */
  autoReply?: AutoReply;
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
  /** Where the task came from. With it, the session gets a Handoff block before the task (task-context.ts). */
  handoff?: Handoff;
  /** Start the session with no permission prompts. */
  auto?: boolean;
  /** Start the session in a new git worktree, from handoff.branch on origin. */
  worktree?: boolean;
}

export type StartResult = { ok: true; task: TaskRecord } | { ok: false; status: number; error: string };

export const TASKS_KEY = "tasks";
export const MAX_TASKS = 30;
/** A new session is not active until the agent loop picks up the prompt. Until then it counts as running. */
export const START_GRACE_MS = 2 * 60_000;
export const MAX_TASK_CHARS = 32_000;
export const SUMMARY_CHARS = 4000;
/** What the Worker keeps of the workspace's answers. The status script cuts the same; the Worker does not trust it. */
const MAX_LAST_CHARS = 16_000;
const MAX_REASON_CHARS = 1000;
const SESSION_ID_RE = /^ses[A-Za-z0-9_-]{1,100}$/;

type Ctx = Pick<OrbContext, "container" | "kv" | "clock" | "config" | "env" | "workspaceId" | "notifyUrl">;
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
  /** Long jobs of this session that run, or whose end message has not reached it yet (jobs.ts holdingJobs). */
  jobs?: number;
}

/**
 * The task state from what OpenCode says. A question waits even while the session is active, because the
 * agent cannot go on without an answer. A session with no outcome and no activity is a prompt the loop has
 * not picked up yet; after START_GRACE_MS it never started. A task that made no commit is still done: many
 * tasks are research. A turn that succeeded with a long job of the session still working is running: the
 * agent ended its turn on purpose, and the job's end message starts the next one. `stopped` is not here:
 * only a pause sets it (stopTasks).
 */
export function taskState(
  f: SessionFacts,
  started: number,
  now: number,
): { state: TaskState; reason?: string } {
  if (!f.found) return { state: "failed", reason: "OpenCode no longer has this session" };
  if (f.permissions > 0 || f.forms > 0) return { state: "waiting" };
  if (f.active) return { state: "running" };
  if (f.outcome === "succeeded") return { state: (f.jobs ?? 0) > 0 ? "running" : "done" };
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
  const { text, title, model, schema, handoff, auto, worktree } = body;
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
  if (handoff !== undefined) {
    const h = parseHandoff(handoff);
    if ("error" in h) return { error: h.error, fix: "send handoff: { origin, branch?, commit?, dirty? }" };
    input.handoff = h.handoff;
  }
  for (const [key, v] of [
    ["auto", auto],
    ["worktree", worktree],
  ] as const) {
    if (v === undefined) continue;
    if (typeof v !== "boolean") return { error: `${key} must be true or false`, fix: `send ${key}: true` };
    if (v) input[key] = true;
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

/** Where `run --worktree` makes its worktrees in the workspace. Outside the checkout, on the saved disk. */
export const WORKTREE_PARENT = "/home/user/worktrees";

/**
 * The task that holds the workspace checkout, if any: one in the checkout (not in its own worktree) that runs
 * or waits for an answer. A waiting task counts: its work is in the checkout, and it goes on after the answer.
 * A stopped task does not: the workspace paused under it, and only a connect continues it.
 */
export function checkoutHolder(tasks: TaskRecord[]): TaskRecord | undefined {
  return tasks.find((t) => !t.worktree && (t.state === "running" || t.state === "waiting"));
}

/** The one-line refusal for a second task in the checkout. The fix names the caller's own options. */
export function busyError(id: string, t: TaskRecord, origin: Handoff["origin"] | undefined): string {
  const how =
    origin === "mcp"
      ? "set newWorkspace or worktree to true"
      : origin === "a2a"
        ? "set metadata.worktree to true"
        : "pass --new (a new workspace) or --worktree (a new git worktree in this workspace)";
  const answer =
    t.state === "waiting"
      ? `, or answer it: cf-opencode tasks ${t.id} --workspace ${id} --reply "<text>"`
      : "";
  return `Failed: task ${t.id} is ${t.state} in the checkout of workspace ${id}; two tasks in one checkout change the same files — fix: ${how}${answer}`;
}

/**
 * Start a session with the task as its first prompt, and keep it in the task list. Wakes nothing. The
 * caller runs this in one queue for each workspace (session.ts), so the check for a task in the checkout
 * and the start are one step: two clients cannot both pass the check.
 */
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
  if (!input.worktree) {
    // The saved states first. They can be old, so a live read decides when they say the checkout is in use.
    const saved = (await ctx.kv.get<Saved>(TASKS_KEY))?.tasks ?? [];
    if (checkoutHolder(saved)) {
      const live = (await captureTasks(ctx)) ?? { tasks: saved };
      const holder = checkoutHolder(live.tasks);
      if (holder) return { ok: false, status: 409, error: busyError(id, holder, input.handoff?.origin) };
    }
  }
  const password = await workspacePassword(ctx.env.CONTROL_TOKEN, id);
  const directory = await directoryOf(ctx);
  const model = input.model ? modelRef(input.model) : undefined;
  const spec = {
    create: {
      location: { directory },
      ...(input.title ? { title: input.title } : {}),
      ...(model ? { model } : {}),
      ...(input.handoff ? { metadata: { "cf-opencode": { handoff: input.handoff } } } : {}),
    },
    prompt: { text: input.text },
    // Added before the task as a message that does not start the agent. See TASK_START_SH.
    ...(input.handoff
      ? {
          context: {
            text: handoffBlock(input.handoff, undefined, { worktree: input.worktree === true }),
            resume: false,
          },
        }
      : {}),
    ...(input.auto ? { auto: true } : {}),
    ...(input.worktree
      ? {
          worktree: {
            parent: WORKTREE_PARENT,
            ...(input.handoff?.branch ? { branch: input.handoff.branch } : {}),
          },
        }
      : {}),
  };
  let out: { id?: unknown; title?: unknown; base?: unknown; error?: unknown; worktree?: unknown } | undefined;
  try {
    const [cmd, opts] = sh(TASK_START_SH, {
      PORT: String(ctx.config.serverPort),
      OPENCODE_SERVER_PASSWORD: password,
      TASK: JSON.stringify(spec),
      DIRECTORY: directory,
    });
    // A worktree fetches from origin first.
    const r = await ctx.container.exec(cmd, { ...opts, timeoutMs: input.worktree ? 120_000 : 45_000 });
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
    if (/^worktree: /.test(why))
      return {
        ok: false,
        status: 502,
        error: `Failed: no worktree for the task: ${why.slice(10)} — fix: push the branch to origin, or run without --worktree`,
      };
    return {
      ok: false,
      status: 502,
      error: `Failed: OpenCode refused the task: ${why}${made} — fix: check --model, then retry`,
    };
  }
  // OpenCode may put the worktree in its own folder; any absolute path that is not the checkout is the task's.
  const worktree =
    input.worktree &&
    typeof out.worktree === "string" &&
    /^\/[^\0\n]{1,299}$/.test(out.worktree) &&
    out.worktree !== directory
      ? out.worktree
      : undefined;
  if (input.worktree && !worktree)
    return {
      ok: false,
      status: 502,
      error: `Failed: the start script made no worktree (session ${out.id} has no task) — fix: cf-opencode logs ${id}`,
    };
  const now = ctx.clock.now();
  const task: TaskRecord = {
    id: out.id,
    title: input.title ?? (typeof out.title === "string" && out.title ? out.title : oneLine(input.text, 80)),
    started: now,
    ...(input.model ? { model: input.model } : {}),
    state: "running",
    ...(typeof out.base === "string" && /^[0-9a-f]{40}$/.test(out.base) ? { base: out.base } : {}),
    ...(input.schema !== undefined ? { schema: input.schema } : {}),
    ...(input.auto ? { auto: true } : {}),
    ...(worktree ? { worktree } : {}),
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
  /** Absent from a workspace whose status script does not read jobs. */
  jobs?: JobFact[];
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
  return {
    active: r.active.filter((x): x is string => typeof x === "string"),
    sessions: r.sessions,
    ...(Array.isArray(r.jobs) ? { jobs: parseJobs(r.jobs) } : {}),
  };
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
    const jobs = status.jobs ? jobsOf(status.jobs, t.id) : undefined;
    let { state, reason } = taskState(
      {
        found,
        active: active.has(t.id),
        permissions: typeof s.permissions === "number" ? s.permissions : 0,
        forms: typeof s.forms === "number" ? s.forms : 0,
        ...(typeof s.outcome === "string" ? { outcome: s.outcome } : {}),
        ...(typeof s.reason === "string" && s.reason ? { reason: s.reason.slice(0, MAX_REASON_CHARS) } : {}),
        jobs: jobs ? holdingJobs(jobs, now, START_GRACE_MS) : 0,
      },
      t.started,
      now,
    );
    // The pause interrupted the session. That is the stop already recorded, not a failure of the task.
    if (t.state === "stopped" && state === "failed" && s.outcome === "interrupted") {
      state = "stopped";
      reason = t.reason;
    }
    // The pause stopped a long job of the task, after the agent ended its turn: the same stop.
    if (t.state === "stopped" && state === "done" && jobs?.some((j) => j.stoppedBy === "pause")) {
      state = "stopped";
      reason = t.reason;
    }
    // The automatic reply went out. OpenCode shows the turn before it until its loop takes the reply.
    const waitsForReply =
      t.autoReply?.status === "sent" && !t.autoReply.taken && now - t.autoReply.at < START_GRACE_MS;
    if (state === "done" && t.state === "running" && waitsForReply && !active.has(t.id)) state = "running";
    let next: TaskRecord = { ...t, state };
    if (waitsForReply && active.has(t.id) && t.autoReply) next.autoReply = { ...t.autoReply, taken: true };
    if (reason) next.reason = reason;
    else delete next.reason;
    if (jobs?.length) next.jobs = jobs;
    else if (jobs) delete next.jobs;
    if (found && typeof s.title === "string" && s.title) next.title = s.title.slice(0, 200);
    // The script keeps 16 000 characters, but the agent is root and can answer for the script: bound it here.
    const last = typeof s.last === "string" && s.last ? s.last.slice(-MAX_LAST_CHARS) : undefined;
    if (last) next.last = last.slice(-SUMMARY_CHARS);
    if (typeof time.updated === "number") next.updated = time.updated;
    if (state === "waiting" && typeof s.question === "string" && s.question)
      next.question = s.question.slice(0, 1000);
    else delete next.question;
    delete next.structured;
    delete next.structuredError;
    // Read the result block from the whole last message: the summary keeps only its end.
    if (t.schema !== undefined && state !== "running") {
      const r = structuredResult(last ?? t.last, t.schema);
      // The answer to the automatic reply can lack the block. The block from before the reply still holds.
      if ("structuredError" in r && t.autoReply?.structured !== undefined)
        next.structured = t.autoReply.structured;
      else Object.assign(next, r);
    }
    if (state !== t.state && state !== "running") next = markEnded(next, now, opts.notify === true);
    return next;
  });
}

interface GitOut {
  branch?: string;
  pullRequest?: string;
  unpushed?: unknown;
  processes?: unknown;
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
      ? f.changedFiles
          .filter((x): x is string => typeof x === "string")
          .slice(0, 100)
          .map((x) => x.slice(0, 300))
      : [];
    const next: TaskRecord = { ...t, commits, changedFiles: files };
    if (typeof facts.branch === "string" && facts.branch) next.branch = facts.branch.slice(0, 200);
    if (typeof facts.pullRequest === "string" && /^https:\/\//.test(facts.pullRequest))
      next.pullRequest = facts.pullRequest.slice(0, 500);
    // Facts of the checkout at this read, so a later read replaces them: a push or an ended process clears them.
    delete next.unpushed;
    delete next.processes;
    if (typeof facts.unpushed === "number" && Number.isInteger(facts.unpushed) && facts.unpushed > 0)
      next.unpushed = Math.min(facts.unpushed, 100_000);
    if (Array.isArray(facts.processes)) {
      const ps = facts.processes
        .filter((x): x is string => typeof x === "string" && x.length > 0)
        .slice(0, 5)
        .map((x) => x.slice(0, 60));
      if (ps.length > 0) next.processes = ps;
    }
    return next;
  });
}

/**
 * Run TASK_GIT_SH for these tasks, once for each checkout: the workspace checkout, and the worktree of each
 * `run --worktree` task. The branch, unpushed commits and processes are facts of one checkout, so each task
 * gets those of its own. undefined when no run answered; facts are a nice to have.
 */
async function readFacts(ctx: Ctx, tasks: TaskRecord[], gh: boolean): Promise<GitOut[] | undefined> {
  const want = tasks.filter((t) => t.base);
  if (want.length === 0) return undefined;
  const main = await directoryOf(ctx);
  const groups = new Map<string, TaskRecord[]>();
  for (const t of want) groups.set(t.worktree ?? main, [...(groups.get(t.worktree ?? main) ?? []), t]);
  const outs: GitOut[] = [];
  for (const [directory, group] of groups) {
    try {
      const [cmd, opts] = sh(TASK_GIT_SH, {
        DIRECTORY: directory,
        TASKS: JSON.stringify(
          group.map((t) => ({ id: t.id, base: t.base, since: Math.floor(t.started / 1000) })),
        ),
        GH: gh ? "1" : "0",
        GH_TOKEN: "cf-opencode-egress",
      });
      // Bounded: a pause runs this before its snapshot.
      const r = await ctx.container.exec(cmd, { ...opts, timeoutMs: 30_000 });
      const facts = r.exitCode === 0 ? parseGitFacts(r.stdout) : undefined;
      // Only the tasks of this checkout take its facts.
      if (facts) {
        const mine: GitOut["tasks"] = {};
        for (const t of group) {
          const f = facts.tasks[t.id];
          if (f) mine[t.id] = f;
        }
        outs.push({ ...facts, tasks: mine });
      }
    } catch {}
  }
  return outs.length ? outs : undefined;
}

export interface CaptureOptions {
  /** Read git facts for these tasks too. Tasks that leave running get them anyway. */
  facts?: string[];
  /** Ask gh for the pull request. On by itself when a task leaves running. */
  gh?: boolean;
  /** False for the last read before a pause: it records the automatic reply as not sent (auto-reply.ts). */
  reply?: boolean;
}

/** Read the states from the running workspace and keep them. undefined when OpenCode did not answer. */
export async function captureTasks(ctx: Ctx, o: CaptureOptions = {}): Promise<TaskList | undefined> {
  if (!ctx.container.running || !ctx.env.CONTROL_TOKEN) return undefined;
  const before = await ctx.kv.get<Saved>(TASKS_KEY);
  if (!before || before.tasks.length === 0) return { tasks: [], live: true };
  try {
    const ids = before.tasks.map((t) => t.id).filter((id) => SESSION_ID_RE.test(id));
    // run --auto tasks that may still ask: the status read answers their permission requests.
    const auto = before.tasks
      .filter((t) => t.auto && (t.state === "running" || t.state === "waiting") && SESSION_ID_RE.test(t.id))
      .map((t) => t.id);
    const [cmd, opts] = sh(TASK_STATUS_SH, {
      PORT: String(ctx.config.serverPort),
      IDS: ids.join(" "),
      AUTO: auto.join(" "),
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
    // Asked before the read below, which must have no await after it.
    const notify = Boolean(await currentNotifyUrl(ctx));
    const gate = await replyGate(ctx, o.reply !== false);
    // Read again: a task started while the scripts ran must not be lost. No await from here to the put, so
    // a concurrent read cannot mark the same change twice, or send the automatic reply twice.
    const current = (await ctx.kv.get<Saved>(TASKS_KEY)) ?? before;
    let tasks = applyStatus(current.tasks, status, ctx.clock.now(), { notify });
    for (const f of facts ?? []) tasks = applyFacts(tasks, f, factIds);
    // Only a task whose own checkout answered has facts from this read.
    const fresh = new Set((facts ?? []).flatMap((f) => Object.keys(f.tasks)).filter((id) => factIds.has(id)));
    const plan = planAutoReplies(current.tasks, tasks, ctx.clock.now(), gate, fresh);
    tasks = plan.tasks;
    const at = iso(ctx.clock.now());
    await ctx.kv.put(TASKS_KEY, { tasks, at });
    tasks = (await sendAutoReplies(ctx, plan.send)) ?? tasks;
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
  await captureTasks(ctx, { facts: running, gh: true, reply: false }).catch(() => undefined);
  const notify = Boolean(await currentNotifyUrl(ctx));
  const after = await ctx.kv.get<Saved>(TASKS_KEY);
  if (!after?.tasks.some((t) => t.state === "running")) return;
  const now = ctx.clock.now();
  const tasks = after.tasks.map((t) =>
    t.state !== "running"
      ? t
      : markEnded(
          {
            ...t,
            ...(t.jobs ? { jobs: stopJobs(t.jobs) } : {}),
            state: "stopped",
            reason: `the workspace paused while the task ran; continue it with cf-opencode connect ${ctx.workspaceId} --session ${t.id}`,
          },
          now,
          notify,
        ),
  );
  await ctx.kv.put(TASKS_KEY, { ...after, tasks });
}
