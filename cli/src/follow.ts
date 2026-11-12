// `--follow`: show a task's progress live, until it leaves running.
//
// OpenCode streams its events at GET /api/event (server-sent events; each data line is one V2Event). The CLI
// reads that stream through the Worker's /oc/<workspace>/ proxy with the workspace password. The proxy wakes
// a paused workspace, so the stream is only opened while the task runs in a live workspace. Events only
// show progress: the end is always confirmed with the task API, which also catches an event the stream
// lost. A dropped stream reconnects; a stream that cannot be opened falls back to polling (waitTask).
import type { ControlClient } from "./api.js";
import { CliError, toFailedLine } from "./errors.js";
import { type TaskView, WAIT_TIMEOUT_MS, WaitTimeout, waitTask } from "./tasks.js";

/** One normalized event: what --follow --json prints, one per line. */
export interface FollowEvent {
  type: "text" | "tool" | "tool.failed" | "question" | "retry" | "error" | "turn.started" | "turn.ended";
  /** ISO time from the event's `created`. */
  at: string;
  [key: string]: unknown;
}

/** Incremental parser for text/event-stream. Feed it chunks; it returns the complete events. */
export class SseParser {
  private buf = "";
  private data: string[] = [];
  private event: string | undefined;

  push(chunk: string): { event?: string; data: string }[] {
    this.buf += chunk;
    const out: { event?: string; data: string }[] = [];
    for (let nl = this.buf.search(/\r?\n/); nl >= 0; nl = this.buf.search(/\r?\n/)) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(this.buf[nl] === "\r" ? nl + 2 : nl + 1);
      if (line === "") {
        if (this.data.length)
          out.push({ ...(this.event ? { event: this.event } : {}), data: this.data.join("\n") });
        this.data = [];
        this.event = undefined;
      } else if (line.startsWith(":")) {
        // A comment, sent to keep the connection open.
      } else {
        const i = line.indexOf(":");
        const field = i < 0 ? line : line.slice(0, i);
        const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
        if (field === "data") this.data.push(value);
        else if (field === "event") this.event = value;
      }
    }
    return out;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** A short form of a tool input: the command, path or query when there is one. */
export function inputSummary(input: unknown): string {
  const o = obj(input);
  for (const k of ["command", "filePath", "path", "pattern", "url", "query", "description", "prompt"]) {
    const v = str(o[k]);
    if (v) return oneLine(v, 120);
  }
  const all = JSON.stringify(o);
  return all === "{}" ? "" : oneLine(all, 120);
}

function oneLine(s: string, cap: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > cap ? `${one.slice(0, cap - 1)}…` : one;
}

/**
 * V2Event (OpenCode's /api/event schema) → the events --follow shows, for one session. Text deltas are
 * grouped per assistant message part and come out once, when the part ends. Events of other sessions,
 * and kinds the user does not need, give nothing.
 */
export class EventNormalizer {
  private tools = new Map<string, string>();
  private text = new Map<string, string>();
  constructor(private readonly sessionId: string) {}

  push(raw: unknown): FollowEvent[] {
    const e = obj(raw);
    const type = str(e.type) ?? "";
    const d = obj(e.data);
    const sid = str(d.sessionID) ?? str(obj(d.form).sessionID);
    if (sid !== this.sessionId) return [];
    const at = new Date(typeof e.created === "number" ? e.created : Date.now()).toISOString();
    const part = `${str(d.assistantMessageID) ?? ""}:${String(d.ordinal ?? "")}`;
    switch (type) {
      case "session.text.delta":
        this.text.set(part, (this.text.get(part) ?? "") + (str(d.delta) ?? ""));
        return [];
      case "session.text.ended": {
        const text = (str(d.text) || this.text.get(part) || "").trim();
        this.text.delete(part);
        return text ? [{ type: "text", at, message: str(d.assistantMessageID), text }] : [];
      }
      case "session.tool.input.started":
        if (str(d.id) && str(d.name)) this.tools.set(str(d.id) as string, str(d.name) as string);
        return [];
      case "session.tool.called":
        return [
          {
            type: "tool",
            at,
            call: str(d.id),
            name: this.tools.get(str(d.id) ?? "") ?? "tool",
            input: inputSummary(d.input),
          },
        ];
      case "session.tool.failed":
        return [
          {
            type: "tool.failed",
            at,
            call: str(d.id),
            name: this.tools.get(str(d.id) ?? "") ?? "tool",
            error: oneLine(str(obj(d.error).message) ?? "failed", 300),
          },
        ];
      case "session.step.failed":
        return [{ type: "error", at, error: oneLine(str(obj(d.error).message) ?? "the step failed", 300) }];
      case "session.retry.scheduled":
        return [
          { type: "retry", at, attempt: d.attempt, error: oneLine(str(obj(d.error).message) ?? "", 300) },
        ];
      case "permission.asked": {
        const res = Array.isArray(d.resources) ? d.resources.slice(0, 5).join(", ") : "";
        const text = str(d.message) ?? `allow ${str(d.action) ?? "an action"}${res ? ` on ${res}` : ""}?`;
        return [{ type: "question", at, text: `Permission: ${oneLine(text, 300)}` }];
      }
      case "form.created":
        return [{ type: "question", at, text: oneLine(str(obj(d.form).title) ?? "a question", 300) }];
      case "session.execution.started":
        return [{ type: "turn.started", at }];
      case "session.execution.succeeded":
        return [{ type: "turn.ended", at, outcome: "succeeded" }];
      case "session.execution.failed":
        return [
          { type: "turn.ended", at, outcome: "failed", error: oneLine(str(obj(d.error).message) ?? "", 300) },
        ];
      case "session.execution.interrupted":
        return [{ type: "turn.ended", at, outcome: "interrupted", reason: str(d.reason) }];
      default:
        return [];
    }
  }
}

const MAX_TEXT_LINES = 20;

/** The terminal line(s) for one event, or undefined for an event the terminal skips. */
export function renderEvent(e: FollowEvent): string | undefined {
  switch (e.type) {
    case "text": {
      const lines = String(e.text).split("\n");
      const shown = lines.slice(0, MAX_TEXT_LINES).map((l) => `  ${l}`);
      if (lines.length > MAX_TEXT_LINES) shown.push(`  … (${lines.length - MAX_TEXT_LINES} more lines)`);
      return shown.join("\n");
    }
    case "tool":
      return `→ ${e.name}${e.input ? `: ${e.input}` : ""}`;
    case "tool.failed":
      return `✗ ${e.name}: ${e.error}`;
    case "question":
      return `? ${e.text}`;
    case "retry":
      return `! retry ${e.attempt}: ${e.error}`;
    case "error":
      return `! ${e.error}`;
    case "turn.ended":
      return `· turn ${e.outcome}${e.error ? `: ${e.error}` : ""}`;
    default:
      return undefined;
  }
}

/** Opens the event stream. The real one is a GET on /oc/<workspace>/api/event with the workspace password. */
export type OpenStream = (signal: AbortSignal) => Promise<Response>;

export function openEventStream(url: string, workspace: string, password: string): OpenStream {
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  return (signal) =>
    fetch(`${url.replace(/\/$/, "")}/oc/${encodeURIComponent(workspace)}/api/event`, {
      headers: { authorization: auth, accept: "text/event-stream" },
      signal,
    });
}

export interface FollowOptions {
  onEvent: (e: FollowEvent) => void;
  /** Notes about the stream itself (reconnects, the fallback). stderr. */
  onNote?: (line: string) => void;
  timeoutMs?: number;
  /** How often the task API is asked while the stream is quiet. */
  checkMs?: number;
  /** Reconnects in a row before the fallback to polling. */
  maxReconnects?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Poll options for the fallback. */
  pollIntervalMs?: number;
}

export const FOLLOW_CHECK_MS = 30_000;
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10_000, 20_000];

/**
 * Stream a running task's events until it leaves running, then return it as --wait does. Throws
 * WaitTimeout after timeoutMs.
 */
export async function followTask(
  client: Pick<ControlClient, "task">,
  open: OpenStream,
  workspace: string,
  sessionId: string,
  o: FollowOptions,
): Promise<TaskView> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeout = o.timeoutMs ?? WAIT_TIMEOUT_MS;
  const until = now() + timeout;
  const maxReconnects = o.maxReconnects ?? RECONNECT_BACKOFF_MS.length;
  const note = o.onNote ?? (() => {});
  const norm = new EventNormalizer(sessionId);
  const poll = (why: string) => {
    note(`${why}; checking the task every ${Math.round((o.pollIntervalMs ?? 10_000) / 1000)} s instead`);
    return waitTask(client, workspace, sessionId, {
      timeoutMs: Math.max(1, until - now()),
      sleep,
      now,
      ...(o.pollIntervalMs ? { intervalMs: o.pollIntervalMs } : {}),
    });
  };
  let drops = 0;
  let connected = false;
  for (;;) {
    // The task API decides the end. A workspace that is not running must not be woken by the stream.
    const v = await client.task(workspace, sessionId);
    if (v.task.state !== "running") return { workspace, ...v };
    if (!v.live) return poll(`workspace ${workspace} is not running`);
    if (now() >= until)
      throw new WaitTimeout(
        `task ${sessionId} still runs after ${Math.round(timeout / 60_000)} min`,
        `follow again: cf-opencode tasks ${sessionId} --workspace ${workspace} --follow`,
      );
    const ac = new AbortController();
    let ended: TaskView | undefined;
    let failed: unknown;
    // Ask the task API now and then, and at once when the stream says a turn ended or a question opened.
    let checking = false;
    const check = async () => {
      if (checking || ended) return;
      checking = true;
      try {
        const c = await client.task(workspace, sessionId);
        if (c.task.state !== "running") {
          ended = { workspace, ...c };
          ac.abort();
        }
      } catch {
        // The next check tries again.
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void check(), o.checkMs ?? FOLLOW_CHECK_MS);
    const stop = setTimeout(() => ac.abort(), Math.max(1, until - now()));
    try {
      const res = await open(ac.signal);
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        throw new CliError(`the event stream answered HTTP ${res.status}`, "see the line above");
      }
      if (!connected && drops === 0) note(`following ${sessionId} in ${workspace}`);
      connected = true;
      drops = 0;
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
          let raw: unknown;
          try {
            raw = JSON.parse(ev.data);
          } catch {
            continue;
          }
          for (const e of norm.push(raw)) {
            o.onEvent(e);
            if (e.type === "turn.ended" || e.type === "question") await check();
          }
        }
        if (ended) break;
      }
    } catch (e) {
      failed = e;
    } finally {
      clearInterval(timer);
      clearTimeout(stop);
      ac.abort();
    }
    if (ended) return ended;
    // The time is up: the check at the top of the loop says so.
    if (now() >= until) continue;
    if (!connected) return poll(`the event stream did not open (${reason(failed)})`);
    drops++;
    if (drops > maxReconnects) return poll(`the event stream dropped ${drops} times`);
    note(`the event stream dropped (${reason(failed)}); reconnecting`);
    await sleep(RECONNECT_BACKOFF_MS[Math.min(drops - 1, RECONNECT_BACKOFF_MS.length - 1)] as number);
  }
}

function reason(e: unknown): string {
  if (e === undefined) return "the server closed it";
  return toFailedLine(e)
    .replace(/^Failed: /, "")
    .replace(/ — fix: .*$/, "");
}
