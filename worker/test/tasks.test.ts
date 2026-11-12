import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkspaceSessionApi } from "../src/api";
import { handleApi } from "../src/api";
import type { Env } from "../src/env";
import { LAST_USE_KEY } from "../src/orb/alarm";
import { runDelete } from "../src/orb/delete";
import { runPause } from "../src/orb/pause";
import { runSpawn } from "../src/orb/spawn";
import { taskResult } from "../src/orb/task-result";
import { TASK_START_SH, TASK_STATUS_SH } from "../src/orb/task-scripts";
import {
  applyStatus,
  modelRef,
  parseTaskInput,
  readTasks,
  type SessionFacts,
  START_GRACE_MS,
  startTask,
  TASKS_KEY,
  type TaskRecord,
  taskState,
} from "../src/orb/tasks";
import { makeOrbCtx, type OrbHarness } from "./fake-registry";

const facts = (f: Partial<SessionFacts> = {}): SessionFacts => ({
  found: true,
  active: false,
  permissions: 0,
  forms: 0,
  ...f,
});

describe("taskState", () => {
  const t0 = 1_000_000;
  it("maps OpenCode's answers to running, done, failed and waiting", () => {
    expect(taskState(facts({ active: true }), t0, t0 + 1).state).toBe("running");
    expect(taskState(facts({ outcome: "succeeded" }), t0, t0 + 1).state).toBe("done");
    expect(taskState(facts({ outcome: "failed", reason: "rate limited" }), t0, t0 + 1)).toEqual({
      state: "failed",
      reason: "rate limited",
    });
    expect(taskState(facts({ outcome: "interrupted" }), t0, t0 + 1)).toEqual({
      state: "failed",
      reason: "the session was interrupted",
    });
    expect(taskState(facts({ found: false }), t0, t0 + 1).state).toBe("failed");
  });

  it("an open permission or form is waiting, even while the session is active", () => {
    expect(taskState(facts({ active: true, permissions: 1 }), t0, t0).state).toBe("waiting");
    expect(taskState(facts({ forms: 2, outcome: "succeeded" }), t0, t0).state).toBe("waiting");
  });

  it("a later turn that runs again is running, not the old outcome", () => {
    expect(taskState(facts({ active: true, outcome: "succeeded" }), t0, t0).state).toBe("running");
  });

  it("a prompt not picked up yet is running, and failed once the grace time is over", () => {
    expect(taskState(facts(), t0, t0 + START_GRACE_MS - 1).state).toBe("running");
    expect(taskState(facts(), t0, t0 + START_GRACE_MS)).toEqual({
      state: "failed",
      reason: "the session did not start",
    });
  });
});

describe("task input", () => {
  it("splits provider/model at the first slash", () => {
    expect(modelRef("cloudflare-workers-ai/@cf/zai-org/glm-5.3")).toEqual({
      providerID: "cloudflare-workers-ai",
      id: "@cf/zai-org/glm-5.3",
    });
    expect(modelRef("no-slash")).toBeUndefined();
    expect(modelRef("/x")).toBeUndefined();
    expect(modelRef("p/")).toBeUndefined();
    expect(modelRef("p q/x")).toBeUndefined();
  });

  it("checks text, title and model", () => {
    expect(parseTaskInput({ text: "fix it", title: " Fix ", model: "a/b" })).toEqual({
      input: { text: "fix it", title: "Fix", model: "a/b" },
    });
    expect(parseTaskInput({ text: "  " })).toMatchObject({ error: "text is empty" });
    expect(parseTaskInput({ text: "x".repeat(32_001) })).toMatchObject({
      error: expect.stringMatching(/32000/),
    });
    expect(parseTaskInput({ text: "x", title: "a\nb" })).toMatchObject({ error: "bad title" });
    expect(parseTaskInput({ text: "x", model: "nope" })).toMatchObject({
      error: expect.stringMatching(/bad model/),
    });
  });
});

/** OpenCode in the fake container answers the task scripts. */
function withOpenCode(
  h: OrbHarness,
  answers: { start?: (spec: unknown) => unknown; status?: (ids: string[]) => unknown },
) {
  h.ctx.env.CONTROL_TOKEN = "control";
  const inner = h.fake.handler;
  const seen: Record<string, string>[] = [];
  h.fake.handler = (cmd, opts, fake) => {
    const env = opts.env ?? {};
    if (cmd[2] === TASK_START_SH && answers.start) {
      seen.push({ ...env });
      return JSON.stringify(answers.start(JSON.parse(env.TASK ?? "{}")));
    }
    if (cmd[2] === TASK_STATUS_SH && answers.status) {
      seen.push({ ...env });
      return JSON.stringify(answers.status((env.IDS ?? "").split(" ").filter(Boolean)));
    }
    return inner(cmd, opts, fake);
  };
  return seen;
}

const spawnReq = { op: "spawn" as const, password: "tok-123456" };

describe("startTask", () => {
  it("creates a session at the workspace directory with the prompt, and keeps it in the list", async () => {
    const h = makeOrbCtx();
    let spec: any;
    const seen = withOpenCode(h, {
      start: (s) => {
        spec = s;
        return { id: "ses_new1", title: "" };
      },
    });
    await runSpawn(h.newOp(), spawnReq);
    const r = await startTask(h.ctx, {
      text: "Fix the login form",
      title: "Fix login",
      model: "cloudflare-workers-ai/@cf/zai-org/glm-5.3",
    });
    expect(r).toMatchObject({ ok: true, task: { id: "ses_new1", title: "Fix login", state: "running" } });
    expect(spec).toEqual({
      create: {
        location: { directory: "/home/user/project" },
        title: "Fix login",
        model: { providerID: "cloudflare-workers-ai", id: "@cf/zai-org/glm-5.3" },
      },
      prompt: { text: "Fix the login form" },
    });
    // The password reaches the script in env, never in argv.
    expect(seen[0]?.OPENCODE_SERVER_PASSWORD).toMatch(/.{20,}/);
    expect(h.fake.execLog.flat().join(" ")).not.toContain(seen[0]?.OPENCODE_SERVER_PASSWORD);
    expect((await h.kv.get<{ tasks: TaskRecord[] }>(TASKS_KEY))?.tasks.map((t) => t.id)).toEqual([
      "ses_new1",
    ]);
    expect(await h.kv.get(LAST_USE_KEY)).toBeDefined();
  });

  it("titles a task without --title from its first line, and keeps the newest first", async () => {
    const h = makeOrbCtx();
    let n = 0;
    withOpenCode(h, { start: () => ({ id: `ses_${++n}`, title: "" }) });
    await runSpawn(h.newOp(), spawnReq);
    await startTask(h.ctx, { text: "first\nmore detail" });
    const r = await startTask(h.ctx, { text: "second" });
    expect(r).toMatchObject({ ok: true, task: { title: "second" } });
    const list = (await h.kv.get<{ tasks: TaskRecord[] }>(TASKS_KEY))?.tasks;
    expect(list?.map((t) => `${t.id} ${t.title}`)).toEqual(["ses_2 second", "ses_1 first more detail"]);
  });

  it("refuses a paused workspace and wakes nothing", async () => {
    const h = makeOrbCtx();
    withOpenCode(h, { start: () => ({ id: "ses_x" }) });
    const r = await startTask(h.ctx, { text: "x" });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(!r.ok && r.error).toMatch(/^Failed: workspace ws-test is not running — fix: cf-opencode connect/);
    expect(h.fake.running).toBe(false);
  });

  it("says what OpenCode refused, and records no task", async () => {
    const h = makeOrbCtx();
    let answer: unknown = { error: "session.create: HTTP 400 bad model" };
    withOpenCode(h, { start: () => answer });
    await runSpawn(h.newOp(), spawnReq);
    const r1 = await startTask(h.ctx, { text: "x" });
    expect(!r1.ok && r1.error).toMatch(
      /^Failed: OpenCode refused the task: session.create: HTTP 400 bad model — fix:/,
    );

    answer = { id: "ses_half", title: "", error: "session.prompt: HTTP 409 busy" };
    const r2 = await startTask(h.ctx, { text: "x" });
    expect(!r2.ok && r2.error).toContain("(session ses_half has no task)");
    expect(await h.kv.get(TASKS_KEY)).toBeUndefined();
  });
});

describe("readTasks", () => {
  const status = (sessions: Record<string, unknown>, active: string[] = []) => ({ active, sessions });

  it("refreshes the states from a running workspace", async () => {
    const h = makeOrbCtx();
    let n = 0;
    let answer = status({});
    withOpenCode(h, { start: () => ({ id: `ses_${++n}`, title: "" }), status: () => answer });
    await runSpawn(h.newOp(), spawnReq);
    await startTask(h.ctx, { text: "one" });
    await startTask(h.ctx, { text: "two" });
    await startTask(h.ctx, { text: "three" });
    answer = status(
      {
        ses_1: {
          found: true,
          title: "One, by OpenCode",
          outcome: "succeeded",
          last: "Result: done",
          time: { updated: 5 },
        },
        ses_2: { found: true, outcome: null, permissions: 1, forms: 0 },
        ses_3: { error: "timed out" },
      },
      ["ses_2"],
    );
    const r = await readTasks(h.ctx);
    expect(r.live).toBe(true);
    const by = Object.fromEntries(r.tasks.map((t) => [t.id, t]));
    expect(by.ses_1).toMatchObject({
      state: "done",
      title: "One, by OpenCode",
      last: "Result: done",
      updated: 5,
    });
    expect(by.ses_2?.state).toBe("waiting");
    // Not readable this time: the last state stays.
    expect(by.ses_3).toMatchObject({ state: "running", title: "three" });
  });

  it("a paused workspace answers from the copy made at its pause, and nothing starts", async () => {
    const h = makeOrbCtx();
    let answer: unknown = { active: ["ses_1"], sessions: { ses_1: { found: true } } };
    withOpenCode(h, { start: () => ({ id: "ses_1", title: "" }), status: () => answer });
    await runSpawn(h.newOp(), spawnReq);
    await startTask(h.ctx, { text: "one" });
    answer = { active: [], sessions: { ses_1: { found: true, permissions: 0, forms: 1 } } };
    await runPause(h.newOp(), { op: "pause" });
    expect(h.fake.running).toBe(false);

    const r = await readTasks(h.ctx);
    expect(r.live).toBe(false);
    expect(r.at).toBeDefined();
    expect(r.tasks.map((t) => `${t.id} ${t.state}`)).toEqual(["ses_1 waiting"]);
    expect(h.fake.running).toBe(false);
  });

  it("is empty for a workspace that never ran a task, and delete forgets the list", async () => {
    const fresh = makeOrbCtx();
    expect(await readTasks(fresh.ctx)).toEqual({ tasks: [], live: false });

    const h = makeOrbCtx();
    withOpenCode(h, { start: () => ({ id: "ses_1", title: "" }), status: () => "not json" });
    await runSpawn(h.newOp(), spawnReq);
    await startTask(h.ctx, { text: "one" });
    // OpenCode did not answer: the saved copy, not live.
    expect((await readTasks(h.ctx)).live).toBe(false);
    await runDelete(h.newOp());
    expect(await h.kv.get(TASKS_KEY)).toBeUndefined();
  });

  it("applyStatus keeps a task started while the status was read", () => {
    const t = (id: string): TaskRecord => ({ id, title: id, started: 0, state: "running" });
    const out = applyStatus(
      [t("ses_new"), t("ses_old")],
      { active: [], sessions: { ses_old: { found: false } } },
      1,
    );
    expect(out.map((x) => `${x.id} ${x.state}`)).toEqual(["ses_new running", "ses_old failed"]);
  });
});

describe("tasks routes", () => {
  const auth = { authorization: "Bearer control-secret" };
  function env(stub: Partial<WorkspaceSessionApi>) {
    const names: string[] = [];
    return {
      env: {
        CONTROL_TOKEN: "control-secret",
        WORKSPACE: {
          getByName: (n: string) => {
            names.push(n);
            return stub;
          },
        },
      } as unknown as Env,
      names,
    };
  }
  const task: TaskRecord = { id: "ses_1", title: "t", started: 1, state: "done", last: "Result: ok" };

  it("POST starts a task; a bad body is one Failed line", async () => {
    let got: unknown;
    const { env: e } = env({
      startTask: async (input) => {
        got = input;
        return { ok: true, task };
      },
    });
    const post = (body: string) =>
      handleApi(new Request("https://w/v1/workspaces/app/tasks", { method: "POST", headers: auth, body }), e);
    const ok = await post(JSON.stringify({ text: "do it", model: "a/b" }));
    expect(ok.status).toBe(201);
    expect(got).toEqual({ text: "do it", model: "a/b" });
    const bad = await post("{}");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/^Failed: text is empty — fix: /);
  });

  it("GET lists, and GET one finds a task or answers 404", async () => {
    const seenArgs: unknown[] = [];
    const { env: e, names } = env({
      tasks: async () => ({ tasks: [task], live: false, at: "2026-11-12T10:00:00Z" }),
      task: async (sid, seen) => {
        seenArgs.push(seen);
        return sid === "ses_1"
          ? { task, result: taskResult("app", task), live: false, at: "2026-11-12T10:00:00Z" }
          : undefined;
      },
    });
    const get = (p: string) =>
      handleApi(new Request(`https://w/v1/workspaces/app/tasks${p}`, { headers: auth }), e);
    expect(((await (await get("")).json()) as { tasks: unknown[] }).tasks).toHaveLength(1);
    const one = await get("/ses_1");
    expect(await one.json()).toEqual({
      task,
      result: taskResult("app", task),
      live: false,
      at: "2026-11-12T10:00:00Z",
    });
    await get("/ses_1?seen=1");
    expect(seenArgs).toEqual([false, true]);
    expect((await get("/ses_2")).status).toBe(404);
    expect((await get("/not-a-session")).status).toBe(400);
    expect(names.every((n) => n === "ws:app")).toBe(true);
  });

  it("needs the bearer", async () => {
    const { env: e } = env({});
    expect((await handleApi(new Request("https://w/v1/workspaces/app/tasks"), e)).status).toBe(401);
  });
});

// The real scripts, in python3, against a stub OpenCode server. Checks the paths, the auth and the parsing.
const hasPython = spawnSync("python3", ["--version"]).status === 0;

function stubOpenCode(password: string) {
  const calls: { method: string; url: string; body: string }[] = [];
  const wantAuth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      calls.push({ method: req.method ?? "", url: req.url ?? "", body });
      if (req.headers.authorization !== wantAuth) return send(res, 401, { _tag: "UnauthorizedError" });
      const u = new URL(req.url ?? "/", "http://x");
      const p = u.pathname;
      if (req.method === "POST" && p === "/api/session")
        return send(res, 200, { data: { id: "ses_new", title: "" } });
      if (req.method === "POST" && p === "/api/session/ses_new/prompt")
        return send(res, 200, { data: { id: "msg_1" } });
      // An OpenCode that has the synthetic call (password pw-syn), and one that does not.
      if (req.method === "POST" && p === "/api/session/ses_new/synthetic")
        return password === "pw-syn"
          ? send(res, 200, { data: { id: "msg_0" } })
          : send(res, 404, { _tag: "NotFound" });
      if (p === "/api/session/active") return send(res, 200, { data: { ses_run: { type: "running" } } });
      const m = /^\/api\/session\/(ses_\w+)(\/\w+)?$/.exec(p);
      if (!m) return send(res, 404, { _tag: "NotFound" });
      const [, sid, sub] = m;
      if (sid === "ses_gone") return send(res, 404, { _tag: "SessionNotFoundError" });
      if (!sub)
        return send(res, 200, {
          data: {
            id: sid,
            title: `title ${sid}`,
            outcome: sid === "ses_bad" ? "failed" : "succeeded",
            time: { created: 1, updated: 2 },
          },
        });
      if (sub === "/permission")
        return send(res, 200, {
          data:
            sid === "ses_ask"
              ? [{ id: "per_1", sessionID: sid, action: "bash", resources: ["rm -rf build"] }]
              : [],
        });
      if (sub === "/form")
        return send(res, 200, {
          data:
            sid === "ses_form"
              ? [
                  {
                    id: "frm_1",
                    sessionID: sid,
                    title: "Which database?",
                    fields: [
                      {
                        key: "db",
                        type: "string",
                        title: "Database",
                        options: [
                          { value: "pg", label: "Postgres" },
                          { value: "d1", label: "D1" },
                        ],
                      },
                    ],
                  },
                ]
              : [],
        });
      if (sub === "/message" && u.searchParams.get("type") === "assistant")
        return send(res, 200, {
          data: [
            { type: "assistant", content: [{ type: "tool", name: "bash" }] },
            {
              type: "assistant",
              content: [
                { type: "reasoning", text: "hmm" },
                { type: "text", text: "Result: fixed" },
              ],
            },
          ],
          cursor: {},
        });
      if (sub === "/message" && u.searchParams.get("type") === "idle")
        return send(res, 200, {
          data: [{ type: "idle", outcome: "failed", error: { type: "x", message: "rate limited" } }],
          cursor: {},
        });
      return send(res, 404, {});
    });
  });
  return { server, calls };
}

function runScript(script: string, env: Record<string, string>): Promise<string> {
  return new Promise((ok, fail) => {
    execFile(
      "bash",
      ["-c", script],
      { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } },
      (e, stdout, stderr) => (e ? fail(new Error(`${e.message}\n${stderr}`)) : ok(stdout)),
    );
  });
}

describe.skipIf(!hasPython || process.platform === "win32")("task scripts against a stub OpenCode", () => {
  it("TASK_START_SH adds the handoff context as its own message, or in front of the task when it cannot", async () => {
    for (const [password, how] of [
      ["pw-syn", "message"],
      ["pw-123", "inline"],
    ] as const) {
      const { server, calls } = stubOpenCode(password);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      try {
        const spec = {
          create: { location: { directory: "/home/user/project" } },
          prompt: { text: "do it" },
          context: { text: "# Handoff\n\nNobody is attached.", resume: false },
        };
        const out = await runScript(TASK_START_SH, {
          PORT: String((server.address() as AddressInfo).port),
          OPENCODE_SERVER_PASSWORD: password,
          TASK: JSON.stringify(spec),
        });
        expect(JSON.parse(out)).toEqual({ id: "ses_new", title: "", context: how });
        const prompt = calls.find((c) => c.url.endsWith("/prompt"));
        const synthetic = calls.find((c) => c.url.endsWith("/synthetic"));
        // The context is sent first and must not start the agent: resume false.
        expect(JSON.parse(synthetic?.body ?? "")).toEqual(spec.context);
        expect(calls.indexOf(synthetic as (typeof calls)[0])).toBeLessThan(
          calls.indexOf(prompt as (typeof calls)[0]),
        );
        expect(JSON.parse(prompt?.body ?? "").text).toBe(
          how === "message" ? "do it" : "# Handoff\n\nNobody is attached.\n\n---\n\ndo it",
        );
      } finally {
        await new Promise((r) => server.close(r));
      }
    }
  });

  it("TASK_START_SH creates the session, then sends the prompt", async () => {
    const { server, calls } = stubOpenCode("pw-123");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = String((server.address() as AddressInfo).port);
      const spec = { create: { location: { directory: "/home/user/project" } }, prompt: { text: "do it" } };
      const out = await runScript(TASK_START_SH, {
        PORT: port,
        OPENCODE_SERVER_PASSWORD: "pw-123",
        TASK: JSON.stringify(spec),
      });
      expect(JSON.parse(out)).toEqual({ id: "ses_new", title: "" });
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        "POST /api/session",
        "POST /api/session/ses_new/prompt",
      ]);
      expect(JSON.parse(calls[0]?.body ?? "")).toEqual(spec.create);
      expect(JSON.parse(calls[1]?.body ?? "")).toEqual(spec.prompt);

      const denied = await runScript(TASK_START_SH, {
        PORT: port,
        OPENCODE_SERVER_PASSWORD: "wrong",
        TASK: JSON.stringify(spec),
      });
      expect(JSON.parse(denied)).toEqual({ error: "session.create: HTTP 401 UnauthorizedError" });

      // With the checkout's directory, HEAD before the prompt is the task's base.
      const repo = mkdtempSync(join(tmpdir(), "cfoc-start-"));
      const git = (...a: string[]) =>
        spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
          encoding: "utf8",
        }).stdout.trim();
      git("init", "-q", "-b", "main");
      git("commit", "-q", "--allow-empty", "-m", "first");
      const withBase = await runScript(TASK_START_SH, {
        PORT: port,
        OPENCODE_SERVER_PASSWORD: "pw-123",
        TASK: JSON.stringify(spec),
        DIRECTORY: repo,
      });
      expect(JSON.parse(withBase)).toEqual({ id: "ses_new", title: "", base: git("rev-parse", "HEAD") });
    } finally {
      server.close();
    }
  });

  it("TASK_STATUS_SH reads active, permissions, forms, outcome and the last text", async () => {
    const { server } = stubOpenCode("pw-123");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = String((server.address() as AddressInfo).port);
      const out = await runScript(TASK_STATUS_SH, {
        PORT: port,
        OPENCODE_SERVER_PASSWORD: "pw-123",
        IDS: "ses_run ses_ask ses_bad ses_gone ses_form",
      });
      const s = JSON.parse(out);
      expect(s.active).toEqual(["ses_run"]);
      expect(s.sessions.ses_run).toMatchObject({
        found: true,
        outcome: "succeeded",
        permissions: 0,
        forms: 0,
        last: "Result: fixed",
      });
      expect(s.sessions.ses_ask.permissions).toBe(1);
      expect(s.sessions.ses_ask.question).toBe("Permission: allow bash on rm -rf build?");
      expect(s.sessions.ses_form.question).toBe("Which database?; Database (Postgres, D1)");
      expect(s.sessions.ses_run.question).toBeUndefined();
      expect(s.sessions.ses_bad).toMatchObject({ outcome: "failed", reason: "rate limited" });
      expect(s.sessions.ses_gone).toEqual({ found: false });

      const states = applyStatus(
        ["ses_run", "ses_ask", "ses_bad", "ses_gone"].map((id) => ({
          id,
          title: id,
          started: 0,
          state: "running" as const,
        })),
        s,
        10 * START_GRACE_MS,
      ).map((t) => `${t.id} ${t.state}`);
      expect(states).toEqual(["ses_run running", "ses_ask waiting", "ses_bad failed", "ses_gone failed"]);
    } finally {
      server.close();
    }
  });
});

describe("handoff context", () => {
  it("tells the session who started it, where it starts, and how to behave alone", async () => {
    const { handoffBlock, parseHandoff } = await import("../src/orb/task-context");
    const block = handoffBlock({
      origin: "cli",
      branch: "feat/x",
      commit: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(block.startsWith("# Handoff\n")).toBe(true);
    expect(block).toContain("cf-opencode run");
    expect(block).toContain("Nobody is attached");
    expect(block).toContain("branch `feat/x` at commit `0123456789ab`");
    expect(block).toContain("had nothing that is not pushed");
    expect(handoffBlock({ origin: "mcp", dirty: true })).toMatch(
      /MCP tools[\s\S]*default branch[\s\S]*cannot see them/,
    );
    expect(handoffBlock({ origin: "a2a" })).toContain("A2A endpoint");
    // No host, user or path: the block is built from checked values only.
    expect(parseHandoff({ origin: "cli", branch: "a b" })).toEqual({
      error: "handoff.branch is not a branch name",
    });
    expect(parseHandoff({ origin: "cli", commit: "$(id)" })).toEqual({
      error: "handoff.commit is not a commit id",
    });
    expect(parseHandoff({ origin: "root" })).toEqual({ error: "handoff.origin must be cli, mcp or a2a" });
    expect(parseHandoff({ origin: "cli", host: "laptop" })).toEqual({
      error: "handoff has an unknown key host",
    });
    expect(parseHandoff({ origin: "mcp", branch: "main", dirty: false })).toEqual({
      handoff: { origin: "mcp", branch: "main", dirty: false },
    });
  });

  it("is checked with the task input, and a task without it is unchanged", async () => {
    const { parseTaskInput } = await import("../src/orb/tasks");
    expect(parseTaskInput({ text: "do it" })).toEqual({ input: { text: "do it" } });
    expect(parseTaskInput({ text: "do it", handoff: { origin: "cli", branch: "main" } })).toEqual({
      input: { text: "do it", handoff: { origin: "cli", branch: "main" } },
    });
    const bad = parseTaskInput({ text: "do it", handoff: { origin: "x" } });
    expect("error" in bad && bad.error).toMatch(/handoff.origin/);
  });
});
