import { describe, expect, it } from "vitest";
import type { RemoteTaskOne, TaskState } from "../src/api.js";
import {
  EventNormalizer,
  type FollowEvent,
  followTask,
  inputSummary,
  renderEvent,
  SseParser,
} from "../src/follow.js";

// Events shaped as OpenCode's V2Event schema (GET /api/event): { id, created, type, data }.
const ev = (type: string, data: Record<string, unknown>, created = Date.parse("2026-11-12T12:00:00Z")) => ({
  id: `evt_${type}`,
  created,
  type,
  data: { sessionID: "ses_1", ...data },
});
const sse = (e: unknown) => `event: message\ndata: ${JSON.stringify(e)}\n\n`;

describe("SseParser", () => {
  it("joins chunks, keeps multi-line data, skips comments", () => {
    const p = new SseParser();
    expect(p.push(": keep-alive\n\nevent: a\nda")).toEqual([]);
    expect(p.push('ta: {"x":\r\ndata: 1}\r\n\r\nid: 2\n')).toEqual([{ event: "a", data: '{"x":\n1}' }]);
    expect(p.push("data: z\n\n")).toEqual([{ data: "z" }]);
  });
});

describe("EventNormalizer", () => {
  it("turns OpenCode events of the session into short events; others give nothing", () => {
    const n = new EventNormalizer("ses_1");
    const msg = { assistantMessageID: "msg_1", ordinal: 0 };
    const out = [
      ev("server.connected", {}),
      ev("session.execution.started", {}),
      ev("session.tool.input.started", { ...msg, id: "call_1", name: "bash" }),
      ev("session.tool.called", { ...msg, id: "call_1", input: { command: "npm   test" }, executed: true }),
      ev("session.tool.failed", {
        ...msg,
        id: "call_1",
        error: { type: "x", message: "exit 1" },
        executed: true,
      }),
      ev("session.text.delta", { ...msg, delta: "All " }),
      ev("session.text.delta", { ...msg, delta: "green." }),
      ev("session.text.ended", { ...msg, text: "" }),
      ev("session.text.delta", { sessionID: "ses_other", ...msg, delta: "not mine" }),
      ev("permission.asked", { id: "per_1", action: "bash", resources: ["rm -rf build"] }),
      {
        id: "e",
        created: 0,
        type: "form.created",
        data: { form: { id: "f", sessionID: "ses_1", title: "Which DB?", fields: [] } },
      },
      ev("session.retry.scheduled", {
        ...msg,
        attempt: 2,
        at: 0,
        error: { type: "x", message: "rate limited" },
      }),
      ev("session.execution.failed", { error: { type: "x", message: "boom" } }),
      ev("session.execution.interrupted", { reason: "shutdown" }),
    ].flatMap((e) => n.push(e));
    expect(out.map((e) => [e.type, renderEvent(e)])).toEqual([
      ["turn.started", undefined],
      ["tool", "→ bash: npm test"],
      ["tool.failed", "✗ bash: exit 1"],
      ["text", "  All green."],
      ["question", "? Permission: allow bash on rm -rf build?"],
      ["question", "? Which DB?"],
      ["retry", "! retry 2: rate limited"],
      ["turn.ended", "· turn failed: boom"],
      ["turn.ended", "· turn interrupted"],
    ]);
    expect(out[0]?.at).toBe("2026-11-12T12:00:00.000Z");
    expect(out[3]).toMatchObject({ type: "text", message: "msg_1", text: "All green." });
  });

  it("summarizes a tool input by its main field", () => {
    expect(inputSummary({ filePath: "/a/b.ts", content: "..." })).toBe("/a/b.ts");
    expect(inputSummary({ x: 1 })).toBe('{"x":1}');
    expect(inputSummary(undefined)).toBe("");
  });

  it("shows long text cut to 20 lines", () => {
    const line = renderEvent({
      type: "text",
      at: "",
      text: Array.from({ length: 25 }, (_, i) => `l${i}`).join("\n"),
    });
    expect(line?.split("\n")).toHaveLength(21);
    expect(line).toMatch(/… \(5 more lines\)$/);
  });
});

/** A stream that sends these chunks and then stays open, like a live event stream. */
function openStream(chunks: string[], close = false): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        if (close) c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function client(states: (TaskState | { state: TaskState; live: boolean })[]) {
  let i = 0;
  return {
    calls: () => i,
    task: async (_ws: string, sid: string): Promise<RemoteTaskOne> => {
      const s = states[Math.min(i++, states.length - 1)];
      const { state, live } =
        typeof s === "string" ? { state: s, live: true } : (s as { state: TaskState; live: boolean });
      return { task: { id: sid, title: "t", started: 0, state }, live };
    },
  };
}

const quick = { checkMs: 1_000_000, sleep: async () => {}, pollIntervalMs: 1000 };

describe("followTask", () => {
  it("streams events until the task API says the task ended", async () => {
    const c = client(["running", "done"]);
    const events: FollowEvent[] = [];
    let opened = 0;
    const v = await followTask(
      c,
      async () => {
        opened++;
        return openStream([
          sse(ev("session.tool.input.started", { assistantMessageID: "m", id: "c1", name: "edit" })),
          sse(ev("session.tool.called", { assistantMessageID: "m", id: "c1", input: { filePath: "a.ts" } })),
          sse(ev("session.execution.succeeded", {})),
        ]);
      },
      "app",
      "ses_1",
      { ...quick, onEvent: (e) => events.push(e) },
    );
    expect(v.task.state).toBe("done");
    expect(opened).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["tool", "turn.ended"]);
  });

  it("reconnects a dropped stream", async () => {
    const c = client(["running", "running", "done"]);
    const notes: string[] = [];
    let opened = 0;
    const v = await followTask(
      c,
      async () => {
        opened++;
        return opened === 1
          ? openStream([sse(ev("session.execution.started", {}))], true)
          : openStream([sse(ev("session.execution.succeeded", {}))]);
      },
      "app",
      "ses_1",
      { ...quick, onEvent: () => {}, onNote: (l) => notes.push(l) },
    );
    expect(v.task.state).toBe("done");
    expect(opened).toBe(2);
    expect(notes).toContain("the event stream dropped (the server closed it); reconnecting");
  });

  it("falls back to polling, with a note, when the stream cannot be opened", async () => {
    const c = client(["running", "running", "waiting"]);
    const notes: string[] = [];
    const v = await followTask(c, async () => new Response("no", { status: 401 }), "app", "ses_1", {
      ...quick,
      onEvent: () => {},
      onNote: (l) => notes.push(l),
    });
    expect(v.task.state).toBe("waiting");
    expect(notes[0]).toBe(
      "the event stream did not open (the event stream answered HTTP 401); checking the task every 1 s instead",
    );
  });

  it("opens no stream for a task that ended, or a workspace that is not running", async () => {
    let opened = 0;
    const open = async () => {
      opened++;
      return openStream([]);
    };
    expect(
      (await followTask(client(["failed"]), open, "app", "ses_1", { ...quick, onEvent: () => {} })).task
        .state,
    ).toBe("failed");
    const notes: string[] = [];
    const paused = client([
      { state: "running", live: false },
      { state: "stopped", live: false },
    ]);
    const v = await followTask(paused, open, "app", "ses_1", {
      ...quick,
      onEvent: () => {},
      onNote: (l) => notes.push(l),
    });
    expect(v.task.state).toBe("stopped");
    expect(opened).toBe(0);
    expect(notes[0]).toMatch(/^workspace app is not running; checking the task/);
  });
});
