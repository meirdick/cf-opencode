import { execFile, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  A2A_VERSION,
  type A2aDeps,
  a2aState,
  type agentCard,
  BLOCKING_WAIT_MS,
  closingInstruction,
  handleRpc,
  MAX_A2A_BODY,
  toA2aTask,
} from "../src/a2a";
import type { WorkspaceSessionApi } from "../src/api";
import { API_VERSION, handleApi } from "../src/api";
import { parseConfig } from "../src/core/config";
import type { OpRecord, WorkspaceRecord } from "../src/core/types";
import type { Env } from "../src/env";
import { runSpawn } from "../src/orb/spawn";
import { cancelTask, TASK_INTERRUPT_SH } from "../src/orb/task-cancel";
import type { TaskResult } from "../src/orb/task-result";
import { type WakeDeps, wakeAndStart } from "../src/orb/task-wake";
import type { TaskInput, TaskRecord } from "../src/orb/tasks";
import { makeOrbCtx } from "./fake-registry";

const ORIGIN = "https://cf-opencode.example.workers.dev";
const TOKEN = "control-secret";
const auth = { authorization: `Bearer ${TOKEN}`, "a2a-version": "1.0", "content-type": "application/json" };
const task = (over: Partial<TaskRecord> & Record<string, unknown> = {}): TaskRecord =>
  ({ id: "ses_1", title: "Fix login", started: 1_700_000_000_000, state: "running", ...over }) as TaskRecord;

type Stub = Partial<Pick<WorkspaceSessionApi, "startTaskAwake" | "tasks" | "cancelTask" | "task">>;

function env(stub: Stub, a2a = true): { env: Env; names: string[] } {
  const names: string[] = [];
  return {
    env: {
      CONTROL_TOKEN: TOKEN,
      CF_OPENCODE_CONFIG: JSON.stringify({ a2a }),
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

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

const post = (e: Env, body: unknown, headers: Record<string, string> = auth) =>
  handleApi(
    new Request(`${ORIGIN}/a2a`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    e,
  );

const message = (
  meta: Record<string, unknown> = { workspace: "app" },
  parts: unknown[] = [{ text: "Fix it" }],
) => ({
  role: "ROLE_USER",
  messageId: "msg-1",
  parts,
  metadata: meta,
});

/** handleRpc with a fake Durable Object and a clock that moves when it sleeps. */
function deps(stub: Stub): A2aDeps & { slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    sessionOf: () => stub as never,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

describe("a2a setting", () => {
  it("is off by default and must be a boolean", () => {
    expect(parseConfig(undefined).a2a).toBe(false);
    expect(parseConfig('{"a2a":true}').a2a).toBe(true);
    expect(() => parseConfig('{"a2a":"yes"}')).toThrow(/^Failed: a2a must be true or false/);
  });
});

describe("A2A off", () => {
  it("answers every A2A path like an unknown path", async () => {
    const { env: e } = env({}, false);
    const unknownAuthed = await handleApi(new Request(`${ORIGIN}/nothing-here`, { headers: auth }), e);
    const cardAuthed = await handleApi(
      new Request(`${ORIGIN}/.well-known/agent-card.json`, { headers: auth }),
      e,
    );
    const rpcAuthed = await post(e, rpc("GetTask", { id: "app:ses_1" }));
    expect([unknownAuthed.status, cardAuthed.status, rpcAuthed.status]).toEqual([404, 404, 404]);
    // Without the token an unknown path is 401, and so are the A2A paths.
    const card = await handleApi(new Request(`${ORIGIN}/.well-known/agent-card.json`), e);
    const unknown = await handleApi(new Request(`${ORIGIN}/nothing-here`), e);
    expect(card.status).toBe(401);
    expect(await card.text()).toBe(await unknown.text());
  });

  it("is off when the config does not parse", async () => {
    const { env: e } = env({});
    (e as { CF_OPENCODE_CONFIG?: string }).CF_OPENCODE_CONFIG = "{not json";
    expect((await handleApi(new Request(`${ORIGIN}/.well-known/agent-card.json`), e)).status).toBe(401);
  });
});

describe("Agent Card", () => {
  it("is public, points at this origin and declares bearer auth and no streaming", async () => {
    const { env: e, names } = env({});
    const res = await handleApi(new Request(`${ORIGIN}/.well-known/agent-card.json`), e);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age");
    const card = (await res.json()) as ReturnType<typeof agentCard> & Record<string, any>;
    expect(card.supportedInterfaces).toEqual([
      { url: `${ORIGIN}/a2a`, protocolBinding: "JSONRPC", protocolVersion: A2A_VERSION },
    ]);
    expect(card.version).toBe(API_VERSION);
    expect(card.capabilities).toEqual({
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    });
    expect(card.securitySchemes).toEqual({
      bearer: { httpAuthSecurityScheme: { scheme: "Bearer", description: expect.any(String) } },
    });
    expect(card.securityRequirements).toEqual([{ schemes: { bearer: { list: [] } } }]);
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].description).toContain("metadata.workspace");
    // The card names no workspace and touches none.
    expect(names).toEqual([]);
    expect(JSON.stringify(card)).not.toContain(TOKEN);
  });

  it("answers only GET and HEAD", async () => {
    const { env: e } = env({});
    const res = await handleApi(new Request(`${ORIGIN}/.well-known/agent-card.json`, { method: "POST" }), e);
    expect(res.status).toBe(405);
  });
});

describe("JSON-RPC endpoint", () => {
  it("needs the control token, and answers a wrong one like a missing one", async () => {
    const { env: e, names } = env({ tasks: async () => ({ tasks: [task()], live: true }) });
    const none = await post(e, rpc("GetTask", { id: "app:ses_1" }), { "a2a-version": "1.0" });
    const wrong = await post(e, rpc("GetTask", { id: "app:ses_1" }), {
      authorization: "Bearer not-the-token",
      "a2a-version": "1.0",
    });
    expect([none.status, wrong.status]).toEqual([401, 401]);
    expect(await none.text()).toBe(await wrong.text());
    expect(names).toEqual([]);
  });

  it("refuses an oversized body before it parses it", async () => {
    const { env: e, names } = env({});
    const big = JSON.stringify(
      rpc("SendMessage", { message: message({ workspace: "app" }, [{ text: "x".repeat(MAX_A2A_BODY) }]) }),
    );
    const res = await post(e, big);
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error.code).toBe(-32600);
    const declared = await handleApi(
      new Request(`${ORIGIN}/a2a`, {
        method: "POST",
        headers: { ...auth, "content-length": String(MAX_A2A_BODY + 1) },
        body: "{}",
      }),
      e,
    );
    expect(declared.status).toBe(413);
    expect(names).toEqual([]);
  });

  it("answers bad JSON, a bad request and an unknown method with JSON-RPC errors", async () => {
    const { env: e } = env({});
    const parse = (await (await post(e, "{nope")).json()) as any;
    expect(parse.error.code).toBe(-32700);
    const bad = (await (await post(e, { jsonrpc: "1.0", id: 1, method: "GetTask" })).json()) as any;
    expect(bad.error.code).toBe(-32600);
    const noId = (await (await post(e, { jsonrpc: "2.0", method: "GetTask" })).json()) as any;
    expect(noId.error.code).toBe(-32600);
    const batch = (await (await post(e, [rpc("GetTask")])).json()) as any;
    expect(batch.error.code).toBe(-32600);
    const unknown = (await (await post(e, rpc("tasks/get", { id: "x" }))).json()) as any;
    expect(unknown).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32601 } });
    // A method name that is not plain letters is not echoed back.
    const odd = (await (await post(e, rpc("<script>", {}))).json()) as any;
    expect(odd.error.message).toBe("Method not found");
  });

  it("needs A2A-Version 1.0; no header means 0.3", async () => {
    const { env: e } = env({});
    const { "a2a-version": _, ...noVersion } = auth;
    const none = (await (await post(e, rpc("GetTask", { id: "app:ses_1" }), noVersion)).json()) as any;
    expect(none.error.code).toBe(-32009);
    expect(none.error.data[0]).toMatchObject({ reason: "VERSION_NOT_SUPPORTED", domain: "a2a-protocol.org" });
    const old = (await (
      await post(e, rpc("GetTask", { id: "app:ses_1" }), { ...auth, "a2a-version": "0.3" })
    ).json()) as any;
    expect(old.error.code).toBe(-32009);
    const patch = (await (
      await post(e, rpc("GetTask", { id: "app:ses_9" }), { ...auth, "a2a-version": "1.0.1" })
    ).json()) as any;
    expect(patch.error?.code).not.toBe(-32009);
  });
});

describe("SendMessage", () => {
  it("refuses a message without metadata.workspace with invalid params", async () => {
    let called = false;
    const d = deps({
      startTaskAwake: async () => {
        called = true;
        return { ok: true, task: task() };
      },
    });
    const r = (await handleRpc(rpc("SendMessage", { message: message({}) }), "1.0", d)) as any;
    expect(r.error.code).toBe(-32602);
    expect(r.error.message).toMatch(/^Failed: invalid message.metadata.workspace — fix: /);
    const bad = (await handleRpc(
      rpc("SendMessage", { message: message({ workspace: "../x" }) }),
      "1.0",
      d,
    )) as any;
    expect(bad.error.code).toBe(-32602);
    expect(called).toBe(false);
  });

  it("starts the task with the closing instruction and returns it at once with returnImmediately", async () => {
    let got: TaskInput | undefined;
    const d = deps({
      startTaskAwake: async (input) => {
        got = input;
        return { ok: true, task: task({ title: "Login" }) };
      },
    });
    const r = (await handleRpc(
      rpc("SendMessage", {
        message: message({ workspace: "app", title: "Login", model: "a/b", branch: "feat/x" }, [
          { text: "Fix the login form." },
          { text: "Keep the API.", mediaType: "text/plain" },
        ]),
        configuration: { returnImmediately: true },
      }),
      "1.0",
      d,
    )) as any;
    expect(r.result.task).toMatchObject({
      id: "app:ses_1",
      contextId: "app",
      status: { state: "TASK_STATE_WORKING" },
      metadata: { workspace: "app" },
    });
    expect(got?.title).toBe("Login");
    expect(got?.model).toBe("a/b");
    expect(got?.text).toBe(closingInstruction("Fix the login form.\n\nKeep the API.", "feat/x"));
    expect(got?.text).toContain("Start from branch `feat/x`");
    expect(d.slept).toEqual([]);
  });

  it("blocks by default until the task leaves working", async () => {
    let reads = 0;
    const d = deps({
      startTaskAwake: async () => ({ ok: true, task: task() }),
      tasks: async () => {
        reads++;
        return {
          tasks: [
            reads < 3
              ? task()
              : task({ state: "done", summary: "Result: fixed; branch fix-login", branch: "fix-login" }),
          ],
          live: true,
        };
      },
    });
    const r = (await handleRpc(rpc("SendMessage", { message: message() }), "1.0", d)) as any;
    expect(reads).toBe(3);
    expect(r.result.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(r.result.task.artifacts).toEqual([
      {
        artifactId: "result",
        name: "Result",
        parts: [{ text: "Result: fixed; branch fix-login", mediaType: "text/plain" }],
      },
      expect.objectContaining({
        artifactId: "changes",
        parts: [{ data: { branch: "fix-login" }, mediaType: "application/json" }],
      }),
    ]);
  });

  it("stops a blocking wait at its limit and returns the working task", async () => {
    const d = deps({
      startTaskAwake: async () => ({ ok: true, task: task() }),
      tasks: async () => ({ tasks: [task()], live: true }),
    });
    const r = (await handleRpc(rpc("SendMessage", { message: message() }), "1.0", d)) as any;
    expect(r.result.task.status.state).toBe("TASK_STATE_WORKING");
    expect(d.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(BLOCKING_WAIT_MS);
    // A blocking SendMessage holds one Worker request open: at most 5 minutes, then GetTask polls.
    expect(BLOCKING_WAIT_MS).toBe(5 * 60_000);
  });

  it("GetTask and the end of a blocking SendMessage build from the result record when there is one", async () => {
    const record = task({ state: "done", last: "old text", updated: 1_700_000_100_000 });
    const resultRecord: TaskResult = {
      id: "ses_1",
      workspace: "app",
      state: "done",
      title: "Fix login",
      summary: "Result: fixed; branch fix-login; pull request none",
      branch: "fix-login",
      commits: [{ sha: "b".repeat(40), subject: "Fix login" }],
      structured: { ok: true },
      started: "2023-11-14T22:13:20.000Z",
      updated: "2023-11-14T22:15:00.000Z",
    };
    const stub = {
      startTaskAwake: async () => ({ ok: true as const, task: task() }),
      tasks: async () => ({ tasks: [record], live: true }),
      task: async () => ({ task: record, result: resultRecord, live: true }),
    };
    const got = (await handleRpc(rpc("GetTask", { id: "app:ses_1" }), "1.0", deps(stub))) as any;
    const sent = (await handleRpc(rpc("SendMessage", { message: message() }), "1.0", deps(stub))) as any;
    for (const t of [got.result, sent.result.task]) {
      expect(t.status.state).toBe("TASK_STATE_COMPLETED");
      expect(t.status.timestamp).toBe("2023-11-14T22:15:00.000Z");
      expect(t.artifacts[0].parts[0].text).toBe(resultRecord.summary);
      expect(t.artifacts.map((a: { artifactId: string }) => a.artifactId)).toEqual([
        "result",
        "changes",
        "structured",
      ]);
      expect(t.metadata.task).toEqual(resultRecord);
    }
    // A Durable Object from before the result record: the saved task record, as before.
    const old = (await handleRpc(
      rpc("GetTask", { id: "app:ses_1" }),
      "1.0",
      deps({ ...stub, task: undefined } as never),
    )) as any;
    expect(old.result.artifacts[0].parts[0].text).toBe("old text");
    expect(old.result.status.timestamp).toBe(new Date(1_700_000_100_000).toISOString());
  });

  it("refuses parts that are not text, follow-ups, push config and a foreign contextId", async () => {
    const d = deps({
      startTaskAwake: async () => ({ ok: true, task: task() }),
      tasks: async () => ({ tasks: [task()], live: true }),
    });
    const send = async (params: unknown) =>
      ((await handleRpc(rpc("SendMessage", params), "1.0", d)) as any).error;
    expect((await send({ message: message({ workspace: "app" }, [{ url: "https://x/y.png" }]) })).code).toBe(
      -32005,
    );
    expect(
      (await send({ message: message({ workspace: "app" }, [{ text: "x", mediaType: "image/png" }]) })).code,
    ).toBe(-32005);
    expect((await send({ message: message({ workspace: "app" }, [{ text: "x", data: {} }]) })).code).toBe(
      -32602,
    );
    expect((await send({ message: { ...message(), taskId: "app:ses_1" } })).code).toBe(-32004);
    expect((await send({ message: { ...message(), taskId: "app:ses_404" } })).code).toBe(-32001);
    expect(
      (
        await send({
          message: message(),
          configuration: { taskPushNotificationConfig: { url: "https://x" } },
        })
      ).code,
    ).toBe(-32003);
    expect((await send({ message: { ...message(), contextId: "other" } })).code).toBe(-32602);
    expect((await send({ message: { ...message(), role: "ROLE_AGENT" } })).code).toBe(-32602);
    expect((await send({ message: message({ workspace: "app", model: "no-slash" }) })).code).toBe(-32602);
    expect((await send({ message: message({ workspace: "app" }, [{ text: "  " }]) })).code).toBe(-32602);
  });

  it("passes on why the workspace cannot take the task", async () => {
    const never = deps({
      startTaskAwake: async () => ({
        ok: false,
        status: 404,
        error: "Failed: workspace app was never connected — fix: run cf-opencode connect app once",
      }),
    });
    const r = (await handleRpc(rpc("SendMessage", { message: message() }), "1.0", never)) as any;
    expect(r.error).toMatchObject({
      code: -32602,
      message: expect.stringMatching(/^Failed: workspace app was never connected/),
    });
    const down = deps({
      startTaskAwake: async () => ({ ok: false, status: 503, error: "Failed: did not wake — fix: x" }),
    });
    expect(
      ((await handleRpc(rpc("SendMessage", { message: message() }), "1.0", down)) as any).error.code,
    ).toBe(-32603);
  });

  it("runs over HTTP: the route reaches the workspace's Durable Object", async () => {
    const { env: e, names } = env({ startTaskAwake: async () => ({ ok: true, task: task() }) });
    const res = await post(
      e,
      rpc("SendMessage", { message: message(), configuration: { returnImmediately: true } }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).result.task.id).toBe("app:ses_1");
    expect(names).toEqual(["ws:app"]);
  });
});

describe("GetTask, CancelTask, ListTasks", () => {
  it("GetTask finds a task by <workspace>:<session>", async () => {
    const d = deps({
      tasks: async () => ({ tasks: [task({ state: "waiting", question: "Which database?" })], live: true }),
    });
    const r = (await handleRpc(rpc("GetTask", { id: "app:ses_1", historyLength: 0 }), "1.0", d)) as any;
    expect(r.result.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(r.result.status.message).toMatchObject({
      role: "ROLE_AGENT",
      parts: [{ text: "Which database?" }],
      taskId: "app:ses_1",
    });
    expect(((await handleRpc(rpc("GetTask", { id: "app:ses_2" }), "1.0", d)) as any).error.code).toBe(-32001);
    expect(((await handleRpc(rpc("GetTask", { id: "ses_1" }), "1.0", d)) as any).error.code).toBe(-32602);
    expect(((await handleRpc(rpc("GetTask", { id: "a/b:ses_1" }), "1.0", d)) as any).error.code).toBe(-32602);
  });

  it("CancelTask interrupts a running task, and refuses a finished one", async () => {
    const cancelled: string[] = [];
    let state = "running";
    const d = deps({
      tasks: async () => ({ tasks: [task({ state: state as TaskRecord["state"] })], live: true }),
      cancelTask: async (sid) => {
        cancelled.push(sid);
        return { ok: true };
      },
    });
    const r = (await handleRpc(rpc("CancelTask", { id: "app:ses_1" }), "1.0", d)) as any;
    expect(r.result.status.state).toBe("TASK_STATE_CANCELED");
    expect(cancelled).toEqual(["ses_1"]);
    state = "done";
    const done = (await handleRpc(rpc("CancelTask", { id: "app:ses_1" }), "1.0", d)) as any;
    expect(done.error).toMatchObject({
      code: -32002,
      data: [expect.objectContaining({ reason: "TASK_NOT_CANCELABLE" })],
    });
    expect(cancelled).toEqual(["ses_1"]);
  });

  it("CancelTask on a paused workspace says the task cannot be canceled now", async () => {
    const d = deps({
      tasks: async () => ({ tasks: [task({ state: "waiting" })], live: false }),
      cancelTask: async () => ({
        ok: false,
        status: 409,
        error: "Failed: workspace app is not running — fix: x",
      }),
    });
    const r = (await handleRpc(rpc("CancelTask", { id: "app:ses_1" }), "1.0", d)) as any;
    expect(r.error.code).toBe(-32002);
    expect(r.error.message).toContain("workspace app is not running");
  });

  it("ListTasks lists one workspace, newest first, filtered and paged", async () => {
    const list = [
      task({ id: "ses_a", state: "done", updated: 3000, summary: "ok" }),
      task({ id: "ses_b", state: "running", updated: 5000 }),
      task({ id: "ses_c", state: "failed", updated: 4000, reason: "boom" }),
    ];
    const d = deps({ tasks: async () => ({ tasks: list, live: true }) });
    const all = (await handleRpc(rpc("ListTasks", { contextId: "app", pageSize: 2 }), "1.0", d)) as any;
    expect(all.result.tasks.map((t: any) => t.id)).toEqual(["app:ses_b", "app:ses_c"]);
    expect(all.result).toMatchObject({ nextPageToken: "2", pageSize: 2, totalSize: 3 });
    expect(all.result.tasks.every((t: any) => !("artifacts" in t))).toBe(true);
    const next = (await handleRpc(
      rpc("ListTasks", { contextId: "app", pageSize: 2, pageToken: "2", includeArtifacts: true }),
      "1.0",
      d,
    )) as any;
    expect(next.result.tasks.map((t: any) => t.id)).toEqual(["app:ses_a"]);
    expect(next.result.tasks[0].artifacts[0].artifactId).toBe("result");
    expect(next.result.nextPageToken).toBe("");
    const failed = (await handleRpc(
      rpc("ListTasks", { contextId: "app", status: "TASK_STATE_FAILED" }),
      "1.0",
      d,
    )) as any;
    expect(failed.result.tasks.map((t: any) => t.id)).toEqual(["app:ses_c"]);
    expect(((await handleRpc(rpc("ListTasks", {}), "1.0", d)) as any).error.code).toBe(-32602);
    expect(
      ((await handleRpc(rpc("ListTasks", { contextId: "app", pageSize: 500 }), "1.0", d)) as any).error.code,
    ).toBe(-32602);
  });

  it("declares streaming, push notifications and the extended card unsupported", async () => {
    const d = deps({});
    for (const m of ["SendStreamingMessage", "SubscribeToTask", "GetExtendedAgentCard"])
      expect(((await handleRpc(rpc(m, { id: "app:ses_1" }), "1.0", d)) as any).error.code).toBe(-32004);
    for (const m of [
      "CreateTaskPushNotificationConfig",
      "GetTaskPushNotificationConfig",
      "ListTaskPushNotificationConfigs",
      "DeleteTaskPushNotificationConfig",
    ])
      expect(((await handleRpc(rpc(m, { taskId: "app:ses_1" }), "1.0", d)) as any).error.code).toBe(-32003);
  });
});

describe("task mapping", () => {
  it("maps each cf-opencode state to an A2A TaskState", () => {
    expect(["running", "waiting", "done", "failed", "stopped", "paused-forever"].map(a2aState)).toEqual([
      "TASK_STATE_WORKING",
      "TASK_STATE_INPUT_REQUIRED",
      "TASK_STATE_COMPLETED",
      "TASK_STATE_FAILED",
      "TASK_STATE_CANCELED",
      "TASK_STATE_UNSPECIFIED",
    ]);
  });

  it("reads summary or last, error or reason, and passes the record through", () => {
    const old = toA2aTask("app", task({ state: "failed", reason: "rate limited", last: "partial" }));
    expect(old.status.message?.parts).toEqual([{ text: "rate limited" }]);
    const rich = toA2aTask(
      "app",
      task({
        state: "done",
        summary: "Result: added the test",
        last: "older text",
        branch: "add-test",
        commits: [{ sha: "abc123", subject: "Add test" }],
        pullRequest: "https://github.example/pull/1",
        changedFiles: ["src/a.ts"],
        structured: { ok: true },
        futureField: 7,
        updated: 1_700_000_100_000,
      }),
    );
    expect(rich.status).toEqual({
      state: "TASK_STATE_COMPLETED",
      timestamp: new Date(1_700_000_100_000).toISOString(),
    });
    expect(rich.artifacts?.map((a) => a.artifactId)).toEqual(["result", "changes", "structured"]);
    expect(rich.artifacts?.[0]?.parts).toEqual([{ text: "Result: added the test", mediaType: "text/plain" }]);
    expect((rich.artifacts?.[1]?.parts as any[] | undefined)?.[0]?.data).toEqual({
      branch: "add-test",
      commits: [{ sha: "abc123", subject: "Add test" }],
      pullRequest: "https://github.example/pull/1",
      changedFiles: ["src/a.ts"],
    });
    expect((rich.metadata.task as any).futureField).toBe(7);
    const stopped = toA2aTask("app", task({ state: "stopped" as never, error: "stopped by the user" }));
    expect(stopped.status.state).toBe("TASK_STATE_CANCELED");
    expect(stopped.status.message?.parts).toEqual([{ text: "stopped by the user" }]);
  });
});

describe("wakeAndStart", () => {
  const rec = (over: Partial<WorkspaceRecord> = {}): WorkspaceRecord =>
    ({
      v: 1,
      workspaceId: "app",
      orbId: "app",
      state: "paused",
      imageKey: "orb",
      instance: "lite",
      updatedAt: "x",
      ...over,
    }) as WorkspaceRecord;
  function wake(over: Partial<WakeDeps> = {}) {
    const calls: string[] = [];
    const d: WakeDeps = {
      workspaceId: "app",
      running: () => false,
      record: async () => rec({ directory: "/home/user/app" }),
      controlToken: TOKEN,
      password: async (t, id) => `pw(${t},${id})`,
      spawn: async (pw, dir) => {
        calls.push(`spawn ${pw} ${dir}`);
        return { phase: "succeeded" } as OpRecord;
      },
      start: async () => {
        calls.push("start");
        return { ok: true, task: task() };
      },
      ...over,
    };
    return { d, calls };
  }

  it("wakes a paused workspace with the derived password and its directory, then starts", async () => {
    const { d, calls } = wake();
    expect((await wakeAndStart(d, { text: "x" })).ok).toBe(true);
    expect(calls).toEqual([`spawn pw(${TOKEN},app) /home/user/app`, "start"]);
  });

  it("starts at once in a running workspace", async () => {
    const { d, calls } = wake({ running: () => true });
    await wakeAndStart(d, { text: "x" });
    expect(calls).toEqual(["start"]);
  });

  it("refuses a workspace that was never connected or is deleted, and wakes nothing", async () => {
    for (const [r, status] of [
      [undefined, 404],
      [rec({ state: "none" }), 404],
      [rec({ deletedAt: "2026-01-01T00:00:00Z" }), 410],
    ] as const) {
      const { d, calls } = wake({ record: async () => r });
      const out = await wakeAndStart(d, { text: "x" });
      expect(out).toMatchObject({ ok: false, status });
      expect(calls).toEqual([]);
    }
  });

  it("says when the wake fails, without the fix of the spawn", async () => {
    const { d, calls } = wake({
      spawn: async () => ({ phase: "failed", error: "Failed: no run slot — fix: pause one" }) as OpRecord,
    });
    const out = await wakeAndStart(d, { text: "x" });
    expect(out).toMatchObject({ ok: false, status: 503 });
    expect(!out.ok && out.error).toBe(
      "Failed: workspace app did not wake (no run slot) — fix: cf-opencode logs app",
    );
    expect(calls).toEqual([]);
  });
});

describe("cancelTask in the workspace", () => {
  it("runs the interrupt script with the password in env, and wakes nothing", async () => {
    const h = makeOrbCtx();
    h.ctx.env.CONTROL_TOKEN = "control";
    const seen: Record<string, string>[] = [];
    let answer: unknown = { ok: true };
    const inner = h.fake.handler;
    h.fake.handler = (cmd, opts, fake) => {
      if (cmd[2] === TASK_INTERRUPT_SH) {
        seen.push({ ...(opts.env ?? {}) });
        return JSON.stringify(answer);
      }
      return inner(cmd, opts, fake);
    };
    expect(await cancelTask(h.ctx, "ses_1")).toMatchObject({ ok: false, status: 409 });
    expect(h.fake.running).toBe(false);
    await runSpawn(h.newOp(), { op: "spawn", password: "tok-123456" });
    expect(await cancelTask(h.ctx, "ses_1")).toEqual({ ok: true });
    expect(seen[0]?.SESSION).toBe("ses_1");
    expect(h.fake.execLog.flat().join(" ")).not.toContain(seen[0]?.OPENCODE_SERVER_PASSWORD);
    answer = { found: false };
    expect(await cancelTask(h.ctx, "ses_1")).toMatchObject({ ok: false, status: 404 });
    answer = { error: "HTTP 500" };
    expect(await cancelTask(h.ctx, "ses_1")).toMatchObject({ ok: false, status: 502 });
    expect(await cancelTask(h.ctx, "ses_1; rm -rf /")).toMatchObject({ ok: false, status: 400 });
  });
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!hasPython || process.platform === "win32")(
  "TASK_INTERRUPT_SH against a stub OpenCode",
  () => {
    it("posts to /api/session/<id>/interrupt with basic auth", async () => {
      const calls: string[] = [];
      const want = `Basic ${Buffer.from("opencode:pw-1").toString("base64")}`;
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        calls.push(`${req.method} ${req.url}`);
        req.resume();
        req.on("end", () => {
          const status =
            req.headers.authorization !== want
              ? 401
              : req.url === "/api/session/ses_ok/interrupt"
                ? 200
                : 404;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(status === 200 ? { data: true } : {}));
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      try {
        const port = String((server.address() as AddressInfo).port);
        const run = (session: string, password = "pw-1") =>
          new Promise<string>((ok, fail) =>
            execFile(
              "bash",
              ["-c", TASK_INTERRUPT_SH],
              {
                env: {
                  PATH: process.env.PATH ?? "/usr/bin:/bin",
                  PORT: port,
                  OPENCODE_SERVER_PASSWORD: password,
                  SESSION: session,
                },
              },
              (e, out) => (e ? fail(e) : ok(out)),
            ),
          );
        expect(JSON.parse(await run("ses_ok"))).toEqual({ ok: true });
        expect(JSON.parse(await run("ses_gone"))).toEqual({ found: false });
        expect(JSON.parse(await run("ses_ok", "wrong"))).toEqual({ error: "HTTP 401" });
        expect(calls[0]).toBe("POST /api/session/ses_ok/interrupt");
      } finally {
        server.close();
      }
    });
  },
);
