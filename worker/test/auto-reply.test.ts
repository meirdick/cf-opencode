// The automatic reply: one message to a session that ended its turn with work that is not safe.
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config";
import { LAST_USE_KEY } from "../src/orb/alarm";
import {
  autoReplyText,
  foundLine,
  planAutoReplies,
  type ReplyGate,
  TASK_REPLY_SH,
} from "../src/orb/auto-reply";
import { loadOrb, saveOrb } from "../src/orb/journal";
import { runPause } from "../src/orb/pause";
import { runSpawn } from "../src/orb/spawn";
import { deliverDue, type FetchFn, taskTick } from "../src/orb/task-notify";
import { taskResult } from "../src/orb/task-result";
import { TASK_GIT_SH, TASK_START_SH, TASK_STATUS_SH } from "../src/orb/task-scripts";
import {
  applyStatus,
  readTask,
  readTasks,
  START_GRACE_MS,
  startTask,
  TASKS_KEY,
  type TaskRecord,
} from "../src/orb/tasks";
import { makeOrbCtx, type OrbHarness } from "./fake-registry";

const SHA = (c: string) => c.repeat(40);
const RECEIVER = "https://hooks.example.com/cf-opencode";
const SEND: ReplyGate = { on: true, send: true };
type Saved = { tasks: TaskRecord[]; at?: string };

/** OpenCode, git and the reply script in the fake container. */
function workspace(o: Record<string, unknown> & { notifyUrl?: string } = {}) {
  const { notifyUrl, ...config } = o;
  const h = makeOrbCtx({ config });
  h.ctx.env.CONTROL_TOKEN = "control";
  if (notifyUrl) h.ctx.env.NOTIFY_URL = notifyUrl;
  const io = {
    status: { active: [] as string[], sessions: {} as Record<string, unknown> },
    git: { tasks: {} } as Record<string, unknown>,
    replies: [] as Record<string, string>[],
    replyAnswer: '{"ok": true}',
  };
  const inner = h.fake.handler;
  h.fake.handler = (cmd, opts, fake) => {
    const env = opts.env ?? {};
    if (cmd[2] === TASK_START_SH) return JSON.stringify({ id: "ses_1", title: "", base: SHA("a") });
    if (cmd[2] === TASK_STATUS_SH) return JSON.stringify(io.status);
    if (cmd[2] === TASK_GIT_SH) return JSON.stringify(io.git);
    if (cmd[2] === TASK_REPLY_SH) {
      io.replies.push({ ...env });
      return io.replyAnswer;
    }
    return inner(cmd, opts, fake);
  };
  return { h, io };
}

async function started(h: OrbHarness, schema?: unknown) {
  await runSpawn(h.newOp(), { op: "spawn", password: "tok-123456" });
  await startTask(h.ctx, { text: "task", ...(schema ? { schema } : {}) });
}

const saved = async (h: OrbHarness) => (await h.kv.get<Saved>(TASKS_KEY))?.tasks ?? [];
const done = (last = "Result: ok") => ({
  active: [],
  sessions: { ses_1: { found: true, outcome: "succeeded", last } },
});
const running = { active: ["ses_1"], sessions: { ses_1: { found: true } } };
const unpushedGit = (n = 2) => ({ branch: "fix-login", unpushed: n, tasks: { ses_1: { commits: [] } } });

function receiver() {
  const got: string[] = [];
  const fetchFn: FetchFn = async (_url, init) => {
    got.push(String(init.body));
    return new Response("ok", { status: 200 });
  };
  return { got, fetchFn };
}

describe("planAutoReplies", () => {
  const base: TaskRecord = { id: "ses_1", title: "t", started: 0, state: "running" };
  const ended: TaskRecord = {
    ...base,
    state: "done",
    unpushed: 2,
    branch: "b",
    unseen: true,
    notify: { state: "done", tries: 0, next: 5 },
  };
  const fresh = new Set(["ses_1"]);

  it("holds a task that ends with work that is not safe at running, and plans one message", () => {
    const r = planAutoReplies([base], [ended], 5, SEND, fresh);
    expect(r.send).toEqual([{ id: "ses_1", text: autoReplyText(ended) }]);
    expect(r.tasks[0]).toEqual({
      ...base,
      unpushed: 2,
      branch: "b",
      autoReply: { at: 5, found: "2 commits not pushed", status: "pending" },
    });
  });

  it("keeps a delivery that waited from before the change, and takes back the one the change queued", () => {
    const before = {
      ...base,
      state: "waiting" as const,
      notify: { state: "waiting" as const, tries: 1, next: 9 },
    };
    const r = planAutoReplies([before], [ended], 5, SEND, fresh);
    expect(r.tasks[0]?.notify).toEqual(before.notify);
    expect(r.tasks[0]?.unseen).toBeUndefined();
    expect(r.tasks[0]?.state).toBe("running");
  });

  it("plans nothing: no change to done, a reply already marked, facts not read in this read, safe work", () => {
    expect(planAutoReplies([{ ...base, state: "done" }], [ended], 5, SEND, fresh).send).toEqual([]);
    const marked = { ...ended, autoReply: { at: 1, found: "x", status: "sent" as const } };
    expect(planAutoReplies([base], [marked], 5, SEND, fresh).send).toEqual([]);
    expect(planAutoReplies([base], [ended], 5, SEND, new Set()).send).toEqual([]);
    const safe = { ...ended, unpushed: undefined };
    expect(planAutoReplies([base], [safe], 5, SEND, fresh).tasks[0]).toEqual(safe);
  });

  it("is only for done: not for failed, waiting or stopped", () => {
    for (const state of ["failed", "waiting", "stopped"] as const) {
      const t = { ...ended, state };
      expect(planAutoReplies([base], [t], 5, SEND, fresh)).toEqual({ tasks: [t], send: [] });
    }
  });

  it("with the setting off does nothing; a read that may not send records why", () => {
    expect(planAutoReplies([base], [ended], 5, { on: false }, fresh)).toEqual({ tasks: [ended], send: [] });
    const r = planAutoReplies([base], [ended], 5, { on: true, send: false, why: "paused" }, fresh);
    expect(r.send).toEqual([]);
    expect(r.tasks[0]).toEqual({
      ...ended,
      autoReply: { at: 5, found: "2 commits not pushed", status: "not-sent", error: "paused" },
    });
  });

  it("says what it found and what to do", () => {
    expect(foundLine({ unpushed: 1, processes: ["vite", "node server.js"] })).toBe(
      "1 commit not pushed; processes left running: vite, node server.js",
    );
    const text = autoReplyText({ unpushed: 3, branch: "fix-login", processes: ["vite"] });
    expect(text).toContain("3 commits are on branch `fix-login`");
    expect(text).toContain("`git push -u origin fix-login`");
    expect(text).toContain("`vite`");
    expect(text).toContain("Do not end your turn while a process that you need runs");
    expect(text).toContain("This is the only automatic message");
    expect(text).not.toContain("json");
    expect(autoReplyText({ unpushed: 1, schema: { type: "object" } })).toContain(
      "```json result block again",
    );
  });
});

describe("automatic reply in the Durable Object", () => {
  it("the read that sees the change sends one message, holds the task at running, and queues no done", async () => {
    const { h, io } = workspace({ notifyUrl: RECEIVER });
    await started(h);
    io.status = running;
    await readTasks(h.ctx);
    io.status = done();
    io.git = unpushedGit();
    const list = await readTasks(h.ctx);
    expect(io.replies).toHaveLength(1);
    expect(io.replies[0]?.SESSION).toBe("ses_1");
    expect(io.replies[0]?.TEXT).toContain("2 commits are on branch `fix-login`");
    expect(io.replies[0]?.OPENCODE_SERVER_PASSWORD).toBeTruthy();
    expect(list.tasks[0]).toMatchObject({ state: "running", autoReply: { status: "sent" } });
    const [t] = await saved(h);
    expect(t?.notify).toBeUndefined();
    expect(t?.unseen).toBeUndefined();
    expect(Date.parse((await h.kv.get<string>(LAST_USE_KEY)) ?? "")).toBe(h.clock.now());

    // OpenCode has not taken the reply yet: still running, and no second message.
    h.clock.advance(30_000);
    expect((await readTasks(h.ctx)).tasks[0]?.state).toBe("running");
    io.status = running;
    await readTasks(h.ctx);
    // The reply's turn ends, pushed: done now, with the mark in the record. The receiver gets one done.
    io.status = done("Pushed.\nResult: ok");
    io.git = { branch: "fix-login", tasks: { ses_1: { commits: [] } } };
    const r = receiver();
    await taskTick(h.ctx, r.fetchFn);
    const after = (await saved(h))[0] as TaskRecord;
    expect(after).toMatchObject({ state: "done", unseen: true });
    expect(r.got.map((b) => JSON.parse(b).state)).toEqual(["done"]);
    expect(JSON.parse(r.got[0] ?? "{}").autoReply).toEqual({
      at: new Date(after.autoReply?.at ?? 0).toISOString(),
      sent: true,
      found: "2 commits not pushed",
    });

    // Never again for this task: a person's reply, a new turn, the same unsafe facts.
    io.status = running;
    await readTasks(h.ctx);
    io.status = done();
    io.git = unpushedGit(1);
    await readTasks(h.ctx);
    expect((await saved(h))[0]?.state).toBe("done");
    expect(io.replies).toHaveLength(1);
  });

  it("the alarm sends it with the laptop closed", async () => {
    const { h, io } = workspace();
    await started(h);
    io.status = done();
    io.git = { unpushed: 0, processes: ["vite"], tasks: { ses_1: { commits: [] } } };
    await taskTick(h.ctx);
    expect(io.replies).toHaveLength(1);
    expect(io.replies[0]?.TEXT).toContain("`vite`");
    expect(taskResult("ws-test", (await saved(h))[0] as TaskRecord).autoReply).toMatchObject({
      sent: true,
      found: "processes left running: vite",
    });
    // OpenCode never shows the reply's turn: after the grace time the task is done, with no second message.
    h.clock.advance(START_GRACE_MS);
    await taskTick(h.ctx);
    expect((await saved(h))[0]).toMatchObject({ state: "done", unseen: true });
    expect(io.replies).toHaveLength(1);
  });

  it("a failed send lets the task be done, unseen, with a delivery and the cause", async () => {
    const { h, io } = workspace({ notifyUrl: RECEIVER });
    await started(h);
    io.status = done();
    io.git = unpushedGit();
    io.replyAnswer = '{"error": "OpenCode answered HTTP 500"}';
    await readTasks(h.ctx);
    const [t] = await saved(h);
    expect(t).toMatchObject({
      state: "done",
      unseen: true,
      notify: { state: "done" },
      autoReply: { status: "not-sent", error: "OpenCode answered HTTP 500" },
    });
    const r = receiver();
    await deliverDue(h.ctx, r.fetchFn);
    expect(JSON.parse(r.got[0] ?? "{}").autoReply).toMatchObject({ sent: false });
  });

  it("the last read before a pause sends nothing and wakes nothing; it records why", async () => {
    const { h, io } = workspace();
    await started(h);
    io.status = done();
    io.git = unpushedGit();
    await runPause(h.newOp(), { op: "pause" });
    expect(io.replies).toHaveLength(0);
    expect(h.fake.running).toBe(false);
    expect((await saved(h))[0]).toMatchObject({
      state: "done",
      autoReply: { status: "not-sent", error: "the workspace paused before the reply" },
    });
  });

  it("a workspace that is not awake (warm after a pause) gets no message", async () => {
    const { h, io } = workspace();
    await started(h);
    const rec = await loadOrb(h.kv);
    await saveOrb(h.kv, { ...rec!, state: "warm" }, new Date(h.clock.now()).toISOString());
    io.status = done();
    io.git = unpushedGit();
    await readTasks(h.ctx);
    expect(io.replies).toHaveLength(0);
    expect((await saved(h))[0]?.autoReply).toMatchObject({ status: "not-sent" });
  });

  it("is off with autoReply false: the task is done as before", async () => {
    const { h, io } = workspace({ autoReply: false });
    await started(h);
    io.status = done();
    io.git = unpushedGit();
    await readTasks(h.ctx);
    expect(io.replies).toHaveLength(0);
    expect((await saved(h))[0]).toMatchObject({ state: "done", unpushed: 2 });
    expect((await saved(h))[0]?.autoReply).toBeUndefined();
  });

  it("a poll that sees the change sends it too, and only once across reads", async () => {
    const { h, io } = workspace();
    await started(h);
    io.status = done();
    io.git = unpushedGit();
    await Promise.all([readTask(h.ctx, "ses_1"), readTasks(h.ctx), taskTick(h.ctx)]);
    expect(io.replies).toHaveLength(1);
  });

  it("with --schema, keeps the block from before the reply when the answer has none", async () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const { h, io } = workspace();
    await started(h, schema);
    io.status = done('Done.\n```json\n{"ok": true}\n```');
    io.git = unpushedGit();
    await readTasks(h.ctx);
    expect(io.replies[0]?.TEXT).toContain("```json result block again");
    io.status = running;
    await readTasks(h.ctx);
    io.status = done("Pushed the branch.");
    io.git = { tasks: { ses_1: { commits: [] } } };
    const [t] = (await readTasks(h.ctx)).tasks;
    expect(t).toMatchObject({ state: "done", structured: { ok: true } });
    expect(t?.structuredError).toBeUndefined();
    // A new block in the answer wins.
    const [n] = applyStatus(
      [t as TaskRecord],
      done('```json\n{"ok": false}\n```'),
      h.clock.now() + START_GRACE_MS,
    );
    expect(n?.structured).toEqual({ ok: false });
  });

  it("is a setting: true by default, and a boolean", () => {
    expect(parseConfig(undefined).autoReply).toBe(true);
    expect(parseConfig('{"autoReply": false}').autoReply).toBe(false);
    expect(() => parseConfig('{"autoReply": "no"}')).toThrow(/autoReply must be true or false/);
  });
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!hasPython || process.platform === "win32")("TASK_REPLY_SH against a stub OpenCode", () => {
  it("posts the text to the session's prompt call with the password, and reports a refusal", async () => {
    const calls: { url: string; auth: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        calls.push({ url: req.url ?? "", auth: req.headers.authorization ?? "", body });
        res.writeHead(req.url === "/api/session/ses_1/prompt" ? 200 : 404, {
          "content-type": "application/json",
        });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const run = (session: string) =>
      new Promise<string>((ok, fail) =>
        execFile(
          "bash",
          ["-c", TASK_REPLY_SH],
          {
            env: {
              PATH: process.env.PATH ?? "/usr/bin:/bin",
              PORT: String((server.address() as AddressInfo).port),
              OPENCODE_SERVER_PASSWORD: "pw",
              SESSION: session,
              TEXT: "push it",
            },
          },
          (e, stdout) => (e ? fail(e) : ok(stdout)),
        ),
      );
    try {
      expect(JSON.parse(await run("ses_1"))).toEqual({ ok: true });
      expect(calls[0]).toEqual({
        url: "/api/session/ses_1/prompt",
        auth: `Basic ${Buffer.from("opencode:pw").toString("base64")}`,
        body: '{"text": "push it"}',
      });
      expect(JSON.parse(await run("ses_2"))).toEqual({ error: "OpenCode answered HTTP 404" });
    } finally {
      server.close();
    }
  });
});
