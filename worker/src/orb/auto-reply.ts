// The automatic reply: one message to a handed-off session that ended its turn with work that is not safe.
//
// `done` is what OpenCode says about the session, not a statement that the work is safe. When a read sees a
// task change to done and its git facts show commits that are not pushed or processes left running, the
// Worker sends the session one message, with the same OpenCode prompt call that `tasks --reply` uses. The
// message says what the read found and what to do.
//
// Exactly one read sends it: the read that sees the change, in the same storage write that records it
// (tasks.ts captureTasks). The mark is on the task and is never cleared, so a later read, a later turn or a
// person's own reply does not send it again. The read holds the task at running in that write, so `--wait`,
// the inbox and the notify URL do not see a done that the reply is about to change. Only a read of an awake
// workspace sends: a pause read (the pause stops opencode next), and a read of a warm workspace, record the
// reply as not sent and wake nothing.
import { workspacePassword } from "../auth";
import { LAST_USE_KEY } from "./alarm";
import type { OrbContext } from "./context";
import { iso, loadOrb, redactWith } from "./journal";
import { sh } from "./spawn";
import { currentNotifyUrl } from "./task-notify";
import { markEnded, TASKS_KEY, type TaskRecord } from "./tasks";

export interface AutoReply {
  /** Epoch ms of the read that found the work not safe. */
  at: number;
  /** What the read found, one line. */
  found: string;
  /** pending: the send runs now. sent: OpenCode took the message. not-sent: see error. */
  status: "pending" | "sent" | "not-sent";
  error?: string;
  /** OpenCode was seen working on the reply. Until then, and for at most START_GRACE_MS, done is not trusted. */
  taken?: boolean;
  /** The json block that matched the task's schema before the reply. Kept when the answer has none. */
  structured?: unknown;
}

/** Whether a read may send, and why not. */
export type ReplyGate = { on: false } | { on: true; send: true } | { on: true; send: false; why: string };

type Ctx = Pick<OrbContext, "container" | "kv" | "clock" | "config" | "env" | "workspaceId" | "notifyUrl">;
type Saved = { tasks: TaskRecord[]; at?: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** True when the facts show commits that are not pushed, or processes left running. */
export const leftWork = (t: Pick<TaskRecord, "unpushed" | "processes">): boolean =>
  (t.unpushed ?? 0) > 0 || (t.processes?.length ?? 0) > 0;

/** What the facts show, one line, for the record. */
export function foundLine(t: Pick<TaskRecord, "unpushed" | "processes">): string {
  const parts: string[] = [];
  if (t.unpushed) parts.push(`${plural(t.unpushed, "commit", "commits")} not pushed`);
  if (t.processes?.length) parts.push(`processes left running: ${t.processes.join(", ")}`);
  return parts.join("; ");
}

/** The message to the session. It says what the read found and what to do. */
export function autoReplyText(t: Pick<TaskRecord, "unpushed" | "processes" | "branch" | "schema">): string {
  const lines = ["Automatic message from cf-opencode. You ended your turn, but the work is not safe yet:"];
  if (t.unpushed) {
    const what = plural(t.unpushed, "commit is", "commits are");
    lines.push(
      t.branch
        ? `- ${what} on branch \`${t.branch}\` and on no remote branch. They are only on the disk of this machine. Push the branch now: \`git push -u origin ${t.branch}\`.`
        : `- ${what} on no remote branch. They are only on the disk of this machine. Put them on a branch and push it now.`,
    );
  }
  if (t.processes?.length)
    lines.push(
      `- These processes still run in the checkout: ${t.processes.map((p) => `\`${p}\``).join(", ")}. This machine pauses some minutes after your last message, and the pause stops them. Do not end your turn while a process that you need runs: wait for it in your turn, or stop it. For a job longer than a few minutes, run it with \`cf-opencode-job start -- <command>\` and end your turn: you get a message when it ends.`,
    );
  lines.push(
    t.schema === undefined
      ? "Then end your last message as the task asked."
      : "Then end your last message as the task asked, with the ```json result block again.",
    "This is the only automatic message for this task.",
  );
  return lines.join("\n");
}

/**
 * Decide the automatic replies of one read. `before` is the saved list, `after` the same list with this read
 * applied. A task gets a reply when this read changes it to done, its facts were read in this read
 * (`fresh`), they show work that is not safe, and it never had one. With `send`, the task is held at running
 * and the delivery that the change queued is taken back; the caller sends the messages after the write.
 * Without it, the task stays done and records why no reply went out. Pure, so it is easy to test.
 */
export function planAutoReplies(
  before: TaskRecord[],
  after: TaskRecord[],
  now: number,
  gate: ReplyGate,
  fresh: Set<string>,
): { tasks: TaskRecord[]; send: { id: string; text: string }[] } {
  const send: { id: string; text: string }[] = [];
  if (!gate.on) return { tasks: after, send };
  const prev = new Map(before.map((t) => [t.id, t]));
  const tasks = after.map((t) => {
    const p = prev.get(t.id);
    if (!p || p.state === "done" || t.state !== "done" || t.autoReply || !fresh.has(t.id) || !leftWork(t))
      return t;
    const reply: AutoReply = { at: now, found: foundLine(t), status: "pending" };
    if (!gate.send) return { ...t, autoReply: { ...reply, status: "not-sent" as const, error: gate.why } };
    if (t.structured !== undefined) reply.structured = t.structured;
    send.push({ id: t.id, text: autoReplyText(t) });
    // Held: as the saved task was before this read, plus the new facts and the mark.
    const held: TaskRecord = { ...t, state: "running", autoReply: reply };
    for (const k of ["unseen", "notify", "notified", "notifyError"] as const) {
      if (p[k] === undefined) delete held[k];
      else (held as unknown as Record<string, unknown>)[k] = p[k];
    }
    // The structured result stays: a reply that does not go out lets the task be done with it.
    delete held.reason;
    delete held.question;
    return held;
  });
  return { tasks, send };
}

/** May this read send? `allowed` is false for the last read before a pause. */
export async function replyGate(ctx: Pick<Ctx, "config" | "kv">, allowed: boolean): Promise<ReplyGate> {
  if (ctx.config.autoReply === false) return { on: false };
  if (!allowed) return { on: true, send: false, why: "the workspace paused before the reply" };
  if ((await loadOrb(ctx.kv))?.state !== "awake")
    return { on: true, send: false, why: "the workspace was not awake" };
  return { on: true, send: true };
}

/**
 * Send one message to a session with OpenCode's prompt call, as `tasks --reply` does through /oc. Env: PORT,
 * OPENCODE_SERVER_PASSWORD, SESSION, TEXT. Prints {"ok": true} or {"error": "..."}.
 */
export const TASK_REPLY_SH = `
exec python3 - <<'PY'
import base64, json, os, urllib.error, urllib.request
base = "http://127.0.0.1:%s" % os.environ.get("PORT", "4096")
auth = "Basic " + base64.b64encode(("opencode:" + os.environ["OPENCODE_SERVER_PASSWORD"]).encode()).decode()
req = urllib.request.Request(base + "/api/session/%s/prompt" % os.environ["SESSION"],
                             data=json.dumps({"text": os.environ["TEXT"]}).encode(), method="POST",
                             headers={"authorization": auth, "content-type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        r.read()
    print(json.dumps({"ok": True}))
except urllib.error.HTTPError as e:
    print(json.dumps({"error": "OpenCode answered HTTP %s" % e.code}))
except Exception as e:
    print(json.dumps({"error": "OpenCode did not answer (%s)" % str(e)[:200]}))
PY
`;

async function sendOne(ctx: Ctx, password: string, id: string, text: string): Promise<string | undefined> {
  try {
    const [cmd, opts] = sh(TASK_REPLY_SH, {
      PORT: String(ctx.config.serverPort),
      OPENCODE_SERVER_PASSWORD: password,
      SESSION: id,
      TEXT: text,
    });
    const r = await ctx.container.exec(cmd, { ...opts, timeoutMs: 30_000 });
    const out = JSON.parse(r.stdout.trim() || "{}") as { ok?: unknown; error?: unknown };
    if (out.ok === true) return undefined;
    return redactWith(password, String(out.error ?? `exit ${r.exitCode}`).slice(0, 300));
  } catch (e) {
    return redactWith(password, (e instanceof Error ? e.message : String(e)).slice(0, 300));
  }
}

/**
 * Send the planned replies, then record each outcome. A reply that did not go out lets the task be done
 * after all: the change is marked as it would have been (unseen, a delivery to the notify URL).
 * Returns the saved list after the write.
 */
export async function sendAutoReplies(
  ctx: Ctx,
  send: { id: string; text: string }[],
): Promise<TaskRecord[] | undefined> {
  if (send.length === 0) return undefined;
  const token = ctx.env.CONTROL_TOKEN;
  const password = token ? await workspacePassword(token, ctx.workspaceId) : undefined;
  const failed = new Map<string, string>();
  for (const s of send) {
    const why = password ? await sendOne(ctx, password, s.id, s.text) : "the Worker has no CONTROL_TOKEN";
    if (why) failed.set(s.id, why);
  }
  // The agent works again. Count it as use, so the idle pause does not fall in the gap before it starts.
  if (failed.size < send.length) await ctx.kv.put(LAST_USE_KEY, iso(ctx.clock.now()));
  const notify = Boolean(await currentNotifyUrl(ctx));
  // Read again and write at once, so a read that ran meanwhile is kept.
  const current = (await ctx.kv.get<Saved>(TASKS_KEY)) ?? { tasks: [] };
  const ids = new Set(send.map((s) => s.id));
  const now = ctx.clock.now();
  const tasks = current.tasks.map((t) => {
    if (!ids.has(t.id) || t.autoReply?.status !== "pending") return t;
    const why = failed.get(t.id);
    if (why === undefined) return { ...t, autoReply: { ...t.autoReply, status: "sent" as const } };
    const next: TaskRecord = { ...t, autoReply: { ...t.autoReply, status: "not-sent", error: why } };
    if (t.state !== "running") return next;
    return markEnded({ ...next, state: "done" }, now, notify);
  });
  await ctx.kv.put(TASKS_KEY, { ...current, tasks });
  return tasks;
}
