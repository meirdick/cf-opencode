import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteTask } from "../src/api.js";
import type { ConnectInput } from "../src/connect.js";
import { CliError } from "../src/errors.js";
import { main } from "../src/index.js";
import { LEGACY_VERSIONS, McpServer, MODERN_VERSION, SUPPORTED_VERSIONS, serveStdio } from "../src/mcp.js";
import {
  abortableSleep,
  localBackend,
  type StartArgs,
  type TaskBackend,
  TOOL_DEFS,
  taskTools,
  WAIT_DEFAULT_SECONDS,
  WAIT_MAX_SECONDS,
} from "../src/mcp-tools.js";

const rec = (over: Partial<RemoteTask> & Record<string, unknown> = {}): RemoteTask =>
  ({
    id: "ses_1",
    title: "Fix login",
    started: Date.parse("2026-11-12T11:00:00Z"),
    state: "running",
    ...over,
  }) as RemoteTask;

function fakeBackend(over: Partial<TaskBackend> = {}): TaskBackend & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    start: async (a) => {
      calls.push(["start", a]);
      return { workspace: "app", task: rec() };
    },
    get: async (s, w) => {
      calls.push(["get", s, w]);
      return {
        workspace: w ?? "app",
        task: rec({ state: "done", summary: "Result: ok", branch: "fix" }),
        live: true,
      };
    },
    wait: async (s, w, ms) => {
      calls.push(["wait", s, w, ms]);
      return { workspace: "app", task: rec(), live: true, timedOut: true };
    },
    list: async (w) => {
      calls.push(["list", w]);
      return { rows: [{ ...rec(), workspace: "app" }], workspaces: [{ id: "app", live: true }] };
    },
    ...over,
  };
}

const INFO = { name: "cf-opencode", version: "0.2.0" };
const server = (b: TaskBackend = fakeBackend()) => new McpServer(taskTools(b), INFO);
const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
};
const req = (method: string, params?: Record<string, unknown>, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params ? { params } : {}),
});
const modern = (method: string, params: Record<string, unknown> = {}, id: number | string = 1) =>
  req(method, { ...params, _meta: modernMeta }, id);

async function legacy(s: McpServer, version = "2025-11-25") {
  const r = (await s.handle(
    req("initialize", {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    }),
  )) as any;
  await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  return r;
}

describe("MCP lifecycle", () => {
  it("answers initialize with the asked legacy version, or the newest one it has", async () => {
    expect((await legacy(server(), "2025-11-25")).result).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: INFO,
      instructions: expect.stringContaining("Commit and push"),
    });
    expect((await legacy(server(), "2025-06-18")).result.protocolVersion).toBe("2025-06-18");
    expect((await legacy(server(), "2024-11-05")).result.protocolVersion).toBe(LEGACY_VERSIONS[0]);
  });

  it("serves tools after initialize, and asks for _meta or initialize before it", async () => {
    const s = server();
    const before = (await s.handle(req("tools/list"))) as any;
    expect(before.error.code).toBe(-32602);
    expect(before.error.data.supported).toEqual(SUPPORTED_VERSIONS);
    expect(await s.handle(req("ping"))).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    await legacy(s);
    const list = (await s.handle(req("tools/list", undefined, 2))) as any;
    expect(list.result.tools.map((t: any) => t.name)).toEqual([
      "handoff_task",
      "get_task",
      "wait_task",
      "list_tasks",
    ]);
    // An old client gets no 2026-07-28 fields.
    expect(list.result.resultType).toBeUndefined();
  });

  it("serves 2026-07-28 requests with no handshake: discover, list, call", async () => {
    const s = server();
    const d = (await s.handle(modern("server/discover"))) as any;
    expect(d.result).toMatchObject({
      resultType: "complete",
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      ttlMs: expect.any(Number),
      cacheScope: "public",
      _meta: { "io.modelcontextprotocol/serverInfo": INFO },
    });
    const list = (await s.handle(modern("tools/list"))) as any;
    expect(list.result).toMatchObject({ resultType: "complete", cacheScope: "public" });
    expect(list.result.tools).toHaveLength(4);
    const call = (await s.handle(modern("tools/call", { name: "list_tasks", arguments: {} }))) as any;
    expect(call.result).toMatchObject({ resultType: "complete", isError: false });
    expect(s.legacyVersion).toBeUndefined();
  });

  it("answers an unsupported version with -32022 and the versions it has", async () => {
    const r = (await server().handle(
      req("tools/list", {
        _meta: { ...modernMeta, "io.modelcontextprotocol/protocolVersion": "1900-01-01" },
      }),
    )) as any;
    expect(r.error).toEqual({
      code: -32022,
      message: "Unsupported protocol version",
      data: { supported: SUPPORTED_VERSIONS, requested: "1900-01-01" },
    });
  });

  it("refuses a 2026-07-28 request without client capabilities, and unknown methods", async () => {
    const s = server();
    const noCaps = (await s.handle(
      req("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION } }),
    )) as any;
    expect(noCaps.error.code).toBe(-32602);
    expect(((await s.handle(modern("initialize"))) as any).error.code).toBe(-32601);
    expect(((await s.handle(modern("resources/list"))) as any).error.code).toBe(-32601);
    expect(((await s.handle(modern("<x>"))) as any).error.message).toBe("Method not found: (unreadable)");
  });

  it("answers bad messages and stays silent on notifications and client responses", async () => {
    const s = server();
    expect(((await s.handle([req("ping")])) as any).error.code).toBe(-32600);
    expect(((await s.handle({ jsonrpc: "1.0", id: 1, method: "ping" })) as any).error.code).toBe(-32600);
    expect(((await s.handle({ jsonrpc: "2.0", id: null, method: "ping" })) as any).error.code).toBe(-32600);
    expect(((await s.handle({ jsonrpc: "2.0", id: 1, method: "ping", params: [] })) as any).error.code).toBe(
      -32602,
    );
    expect(await s.handle({ jsonrpc: "2.0", method: "notifications/whatever" })).toBeUndefined();
    expect(await s.handle({ jsonrpc: "2.0", id: 5, result: {} })).toBeUndefined();
  });
});

describe("MCP tools", () => {
  it("declares input and output schemas, and says what the workspace cannot see", () => {
    for (const d of TOOL_DEFS) {
      expect(d.inputSchema.type).toBe("object");
      expect(d.outputSchema.type).toBe("object");
      expect(d.description.length).toBeGreaterThan(80);
      expect(d.name).toMatch(/^[a-z_]{1,64}$/);
    }
    const handoff = TOOL_DEFS.find((d) => d.name === "handoff_task");
    expect(handoff?.description).toMatch(/not committed, commits that are not pushed/);
    expect(TOOL_DEFS.find((d) => d.name === "wait_task")?.description).toMatch(/5-minute tool timeout/);
  });

  it("returns structured content and the same as text", async () => {
    const s = server();
    await legacy(s);
    const r = (await s.handle(
      req("tools/call", { name: "get_task", arguments: { session: "ses_1" } }, 3),
    )) as any;
    expect(r.result.isError).toBe(false);
    expect(r.result.structuredContent).toMatchObject({
      workspace: "app",
      live: true,
      task: { id: "ses_1", state: "done", summary: "Result: ok", branch: "fix" },
    });
    const text = r.result.content.map((c: any) => c.text).join("\n");
    expect(text).toContain("Task       ses_1");
    expect(text).toContain(JSON.stringify(r.result.structuredContent));
  });

  it("passes handoff arguments on and returns the session", async () => {
    const b = fakeBackend();
    const s = server(b);
    await legacy(s);
    const r = (await s.handle(
      req("tools/call", {
        name: "handoff_task",
        arguments: { task: "Add a test", directory: "/tmp/x", title: "Test", model: "a/b", allowDirty: true },
      }),
    )) as any;
    expect(r.result.structuredContent).toMatchObject({
      workspace: "app",
      session: "ses_1",
      task: { id: "ses_1" },
    });
    expect(b.calls[0]).toEqual([
      "start",
      {
        task: "Add a test",
        directory: "/tmp/x",
        title: "Test",
        model: "a/b",
        allowDirty: true,
      } satisfies StartArgs,
    ]);
  });

  it("reports a bad argument or a failure as isError with one Failed line", async () => {
    const s = server(
      fakeBackend({
        start: async () => {
          throw new CliError("no Worker URL", "run cf-opencode init on this machine");
        },
      }),
    );
    await legacy(s);
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await s.handle(req("tools/call", { name, arguments: args }))) as any).result;
    const failed = await call("handoff_task", { task: "x" });
    expect(failed).toEqual({
      content: [{ type: "text", text: "Failed: no Worker URL — fix: run cf-opencode init on this machine" }],
      isError: true,
    });
    for (const [name, args] of [
      ["handoff_task", { task: "  " }],
      ["handoff_task", { task: "x", allowDirty: "yes" }],
      ["handoff_task", { task: "x", workspace: "../etc" }],
      ["get_task", { session: "not-a-session" }],
      ["wait_task", { session: "ses_1", timeoutSeconds: 0 }],
      ["wait_task", { session: "ses_1", timeoutSeconds: WAIT_MAX_SECONDS + 1 }],
      ["wait_task", { session: "ses_1", timeoutSeconds: 1.5 }],
    ] as const) {
      const r = await call(name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(r.content[0].text).toMatch(/^Failed: .+ — fix: .+$/);
    }
  });

  it("an unknown tool or bad arguments is a protocol error", async () => {
    const s = server();
    await legacy(s);
    expect(((await s.handle(req("tools/call", { name: "nope" }))) as any).error).toMatchObject({
      code: -32602,
    });
    expect(((await s.handle(req("tools/call", { name: "get_task", arguments: [] }))) as any).error.code).toBe(
      -32602,
    );
  });

  it("wait_task waits 240 s by default and says when it timed out", async () => {
    const b = fakeBackend();
    const s = server(b);
    await legacy(s);
    const r = (await s.handle(
      req("tools/call", { name: "wait_task", arguments: { session: "ses_1" } }),
    )) as any;
    expect(b.calls[0]).toEqual(["wait", "ses_1", undefined, WAIT_DEFAULT_SECONDS * 1000]);
    expect(r.result.structuredContent.timedOut).toBe(true);
    expect(r.result.content[0].text).toMatch(/^Still running after 240 s/);
  });
});

describe("stdio transport", () => {
  function pipe(b: TaskBackend = fakeBackend()) {
    const input = new PassThrough();
    const output = new PassThrough();
    const out: string[] = [];
    let buf = "";
    output.on("data", (c) => {
      buf += c;
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      out.push(...parts);
    });
    const logs: string[] = [];
    const done = serveStdio(server(b), { input, output, log: (l) => logs.push(l) });
    const send = (m: unknown) => input.write(`${typeof m === "string" ? m : JSON.stringify(m)}\n`);
    const until = async (n: number) => {
      for (let i = 0; i < 200 && out.length < n; i++) await new Promise((r) => setTimeout(r, 5));
      return out.map((l) => JSON.parse(l));
    };
    return { input, out, send, until, done, logs };
  }

  it("writes one JSON-RPC message per line and nothing else", async () => {
    const p = pipe();
    p.send(req("initialize", { protocolVersion: "2025-11-25", capabilities: {} }, 1));
    p.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    p.send("");
    p.send("{not json");
    p.send(req("tools/list", undefined, 2));
    const msgs = await p.until(3);
    p.input.end();
    await p.done;
    expect(msgs.map((m) => m.id)).toEqual([1, null, 2]);
    expect(msgs[1].error.code).toBe(-32700);
    for (const line of p.out) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("runs requests side by side, and drops the answer of a cancelled one", async () => {
    let release: () => void = () => {};
    let aborted = false;
    const b = fakeBackend({
      wait: (_s, _w, _ms, signal) =>
        new Promise((ok, fail) => {
          release = () => ok({ workspace: "app", task: rec(), live: true, timedOut: false });
          signal.addEventListener("abort", () => {
            aborted = true;
            fail(new Error("cancelled"));
          });
        }),
    });
    const p = pipe(b);
    p.send(modern("tools/call", { name: "wait_task", arguments: { session: "ses_1" } }, "w1"));
    p.send(modern("tools/list", {}, "l1"));
    const first = await p.until(1);
    expect(first[0].id).toBe("l1");
    p.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "w1", reason: "user" },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(aborted).toBe(true);
    release();
    p.input.end();
    await p.done;
    expect(p.out.map((l) => JSON.parse(l).id)).toEqual(["l1"]);
  });

  it("stops waits when stdin closes", async () => {
    let aborted = false;
    const b = fakeBackend({
      wait: (_s, _w, _ms, signal) =>
        new Promise((_ok, fail) =>
          signal.addEventListener("abort", () => {
            aborted = true;
            fail(new Error("cancelled"));
          }),
        ),
    });
    const p = pipe(b);
    p.send(modern("tools/call", { name: "wait_task", arguments: { session: "ses_1" } }, 9));
    await new Promise((r) => setTimeout(r, 20));
    p.input.end();
    await p.done;
    expect(aborted).toBe(true);
    expect(p.out).toEqual([]);
  });
});

describe("abortableSleep", () => {
  it("ends early when the signal aborts", async () => {
    const ac = new AbortController();
    const s = abortableSleep(60_000, ac.signal);
    ac.abort();
    await expect(s).rejects.toThrow("cancelled");
    await expect(abortableSleep(1, ac.signal)).rejects.toThrow("cancelled");
  });
});

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

describe.skipIf(process.platform === "win32")("local backend", () => {
  // The backend reads ~/.cf-opencode; point HOME at an empty directory so the real one is never read.
  beforeEach(() => {
    vi.stubEnv("HOME", mkdtempSync(join(tmpdir(), "cfoc-mcp-home-")));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const install = () => ({ url: "https://cf-opencode.example.workers.dev", token: "t" });

  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), "cfoc-mcp-"));
    const origin = join(root, "origin.git");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    const work = join(root, "My App");
    mkdirSync(work);
    git(work, "init", "-q", "-b", "main");
    writeFileSync(join(work, "a.txt"), "a\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "first");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "-u", "origin", "main");
    return work;
  }

  it("starts in the workspace of the named checkout, with its remote and branch", async () => {
    const work = repo();
    const seen: ConnectInput[] = [];
    let sent: unknown;
    const b = localBackend({
      cwd: "/",
      log: () => {},
      install,
      connect: async (ci) => {
        seen.push(ci);
        return { workspace: { id: ci.id ?? "?" } } as never;
      },
      client: () =>
        ({
          startTask: async (_id: string, body: unknown) => {
            sent = body;
            return { task: rec() };
          },
        }) as never,
    });
    const r = await b.start({ task: "Add a test", directory: work, allowDirty: false });
    expect(r.workspace).toBe("my-app");
    expect(seen[0]).toMatchObject({ id: "my-app", attach: false, branch: "main" });
    expect(seen[0]?.repoUrl).toBeUndefined(); // a file remote has no https form
    expect((sent as { text: string }).text).toContain("Add a test");
    expect((sent as { text: string }).text).toContain("Start from branch `main`");
  });

  it("names allowDirty, not the CLI flag, when the checkout has changes", async () => {
    const work = repo();
    writeFileSync(join(work, "a.txt"), "changed\n");
    const b = localBackend({ cwd: work, log: () => {}, install, connect: async () => ({}) as never });
    await expect(b.start({ task: "x", allowDirty: false })).rejects.toThrow(
      /^Failed: 1 file with changes not committed; .* — fix: commit and git push, or set allowDirty to true$/,
    );
  });

  it("needs a checkout or a workspace", async () => {
    const b = localBackend({ cwd: mkdtempSync(join(tmpdir(), "cfoc-plain-")), log: () => {}, install });
    await expect(b.start({ task: "x", allowDirty: false })).rejects.toThrow(
      /is not a git checkout — fix: pass directory/,
    );
  });

  it("wait returns the last record and timedOut when the time is up", async () => {
    let reads = 0;
    const b = localBackend({
      cwd: "/",
      log: () => {},
      install,
      workspaceIds: () => ["app"],
      sleep: async () => {},
      client: () =>
        ({
          tasks: async () => ({ tasks: [rec()], live: true }),
          task: async () => {
            reads++;
            return { task: rec({ last: `poll ${reads}` }), live: true };
          },
        }) as never,
    });
    const v = await b.wait("ses_1", undefined, 1, new AbortController().signal);
    expect(v).toMatchObject({ workspace: "app", timedOut: true, task: { state: "running" } });
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("wait returns as soon as the task leaves running", async () => {
    const b = localBackend({
      cwd: "/",
      log: () => {},
      install,
      sleep: async () => {},
      client: () => ({ task: async () => ({ task: rec({ state: "waiting" }), live: true }) }) as never,
    });
    expect(await b.wait("ses_1", "app", 240_000, new AbortController().signal)).toMatchObject({
      timedOut: false,
      task: { state: "waiting" },
    });
  });
});

describe("cf-opencode mcp --help", () => {
  it("prints the setup for Claude Code and OpenCode", async () => {
    let text = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      text += String(c);
      return true;
    });
    try {
      expect(await main(["mcp", "--help"])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(text).toContain("claude mcp add cf-opencode -- cf-opencode mcp");
    expect(text).toContain(
      '"mcp": { "servers": { "cf-opencode": { "type": "local", "command": ["cf-opencode", "mcp"] } } }',
    );
  });
});
