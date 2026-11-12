// Push for handed-off tasks: when a task leaves running, the Worker POSTs its result record to notifyUrl.
//
// The Durable Object alarm drives it, not a client and not a process in the workspace: the alarm runs while
// the laptop is closed, and it outlives the container. A change of state queues a delivery on the task
// (tasks.ts markEnded); the alarm sends due deliveries and stays armed while one waits, also when the
// workspace is paused. A failed try is retried after 1, 5 and 30 minutes, then given up and recorded.
//
// Every POST carries x-cf-opencode-signature: sha256=<hex HMAC-SHA256 of the body>. The key is
// notifyKey(CONTROL_TOKEN), which `cf-opencode notify-key` prints for the receiver.
import { parseConfig } from "../core/config";
import type { OrbContext } from "./context";
import { iso } from "./journal";
import { taskResult } from "./task-result";
import { captureTasks, type PendingNotify, TASKS_KEY, type TaskRecord } from "./tasks";

/** Wait before try 2, 3 and 4. After try 4 fails, the delivery is given up. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
export const NOTIFY_TIMEOUT_MS = 10_000;
/** The label the key derives from. The CLI (notify-key) must match. */
export const NOTIFY_KEY_LABEL = "cf-opencode/notify-key/v1";
export const MAX_NOTE_CHARS = 4000;
/** POST on the intercepted AI host (ai.ts AI_HOST): `cf-opencode-notify` in the image calls it. */
export const NOTE_PATH = "/notify";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
type Ctx = Pick<OrbContext, "container" | "kv" | "clock" | "config" | "env" | "workspaceId">;
type Saved = { tasks: TaskRecord[]; at?: string };

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function hmac(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/** The signing key: hex HMAC-SHA256(control token, NOTIFY_KEY_LABEL). The receiver uses it as a UTF-8 secret. */
export function notifyKey(controlToken: string): Promise<string> {
  return hmac(controlToken, NOTIFY_KEY_LABEL);
}

/** The x-cf-opencode-signature value for a body. */
export async function signature(key: string, body: string): Promise<string> {
  return `sha256=${await hmac(key, body)}`;
}

/** The pending delivery after a failed try, or undefined when that was the last try. */
export function afterFailure(p: PendingNotify, now: number): PendingNotify | undefined {
  const wait = RETRY_DELAYS_MS[p.tries - 1];
  return wait === undefined ? undefined : { ...p, next: now + wait };
}

/** One signed POST. Redirects are not followed: the URL in the settings is the receiver. */
export async function post(
  url: string,
  key: string,
  event: "task" | "note",
  body: string,
  fetchFn: FetchFn = (u, i) => fetch(u, i),
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const res = await fetchFn(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "user-agent": "cf-opencode",
        "x-cf-opencode-event": event,
        "x-cf-opencode-signature": await signature(key, body),
      },
      body,
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: `notifyUrl answered HTTP ${res.status}` };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: `notifyUrl did not answer (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

/**
 * Send each delivery that is due, once, and record the outcome on its task. Returns the ms until the next
 * delivery that waits for a retry, or null when none waits. The alarm arms itself for that.
 */
export async function deliverDue(ctx: Ctx, fetchFn?: FetchFn): Promise<number | null> {
  const saved = await ctx.kv.get<Saved>(TASKS_KEY);
  const now = ctx.clock.now();
  const due = saved?.tasks.filter((t) => t.notify && t.notify.next <= now) ?? [];
  const url = ctx.config.notifyUrl;
  const token = ctx.env.CONTROL_TOKEN;
  const outcomes = new Map<string, { sent: PendingNotify; patch: Partial<TaskRecord> }>();
  for (const t of due) {
    const p = t.notify as PendingNotify;
    if (!url || !token) {
      outcomes.set(t.id, { sent: p, patch: { notifyError: "notifyUrl is empty; the delivery was dropped" } });
      continue;
    }
    const body = JSON.stringify(taskResult(ctx.workspaceId, t));
    const r = await post(url, await notifyKey(token), "task", body, fetchFn);
    const tries = p.tries + 1;
    const at = iso(ctx.clock.now());
    if (r.ok) outcomes.set(t.id, { sent: p, patch: { notified: { at, status: r.status, state: p.state } } });
    else {
      const retry = afterFailure({ ...p, tries }, ctx.clock.now());
      outcomes.set(t.id, {
        sent: p,
        patch: retry
          ? { notify: retry }
          : { notifyError: `${r.error ?? "failed"}; gave up after ${tries} tries` },
      });
    }
  }
  // Read again and write at once: a refresh may have changed the tasks while the POSTs ran. A delivery a
  // newer change replaced is left alone, so it is neither lost nor sent twice.
  const current = (await ctx.kv.get<Saved>(TASKS_KEY)) ?? { tasks: [] };
  if (outcomes.size > 0) {
    const tasks = current.tasks.map((t) => {
      const o = outcomes.get(t.id);
      if (!o || !t.notify || t.notify.state !== o.sent.state || t.notify.tries !== o.sent.tries) return t;
      const next: TaskRecord = { ...t, ...o.patch };
      if (!o.patch.notify) delete next.notify;
      return next;
    });
    await ctx.kv.put(TASKS_KEY, { ...current, tasks });
    current.tasks = tasks;
  }
  const waits = current.tasks.flatMap((t) =>
    t.notify ? [Math.max(0, t.notify.next - ctx.clock.now())] : [],
  );
  return waits.length ? Math.min(...waits) : null;
}

/**
 * Each alarm: refresh the tasks of a running workspace while one runs (that read notices the end), then send
 * what is due. Returns when the alarm must run again for a retry, or null.
 */
export async function taskTick(ctx: Ctx, fetchFn?: FetchFn): Promise<number | null> {
  if (ctx.container.running) {
    const saved = await ctx.kv.get<Saved>(TASKS_KEY);
    if (saved?.tasks.some((t) => t.state === "running")) await captureTasks(ctx).catch(() => undefined);
  }
  return deliverDue(ctx, fetchFn);
}

/**
 * POST /notify on the intercepted AI host, from `cf-opencode-notify "<text>"` in the workspace. The platform
 * routes only this workspace's requests here, so no token is needed. One try: the caller sees the answer
 * and can try again.
 */
export async function handleNote(
  req: Request,
  o: {
    workspaceId?: string;
    controlToken?: string;
    rawConfig?: string;
    fetchFn?: FetchFn;
    now?: () => number;
  },
): Promise<Response> {
  let url = "";
  try {
    url = parseConfig(o.rawConfig).notifyUrl;
  } catch {
    // A bad config fails every control request with its own message; here it reads as no notifyUrl.
  }
  if (!url)
    return noteError(
      400,
      "notifyUrl is not set",
      "set notifyUrl in ~/.cf-opencode/config.json, then cf-opencode upgrade",
    );
  if (!o.workspaceId || !o.controlToken)
    return noteError(503, "this workspace cannot send notes yet", "reconnect with cf-opencode connect");
  let text = "";
  try {
    const b = (await req.json()) as { text?: unknown };
    text = typeof b.text === "string" ? b.text.trim() : "";
  } catch {
    return noteError(400, "the request body is not JSON", 'cf-opencode-notify "<text>"');
  }
  if (!text) return noteError(400, "the note is empty", 'cf-opencode-notify "<text>"');
  if (text.length > MAX_NOTE_CHARS)
    return noteError(400, `the note is over ${MAX_NOTE_CHARS} characters`, "shorten it");
  const at = iso((o.now ?? Date.now)());
  const body = JSON.stringify({ type: "note", workspace: o.workspaceId, text, at });
  const r = await post(url, await notifyKey(o.controlToken), "note", body, o.fetchFn);
  if (!r.ok) return noteError(502, r.error ?? "the note was not sent", "check the receiver, then try again");
  return Response.json({ ok: true, status: r.status, at });
}

function noteError(status: number, cause: string, fix: string): Response {
  return Response.json({ ok: false, error: `Failed: ${cause} — fix: ${fix}` }, { status });
}
