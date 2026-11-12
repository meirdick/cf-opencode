// Regression: a wrong password must never wake a paused workspace. Before the Durable Object
// checked the password, any password woke it and became the new server password (takeover).
import { describe, expect, it, vi } from "vitest";
import { tokenSha } from "../src/orb/journal";
import { MemoryKV } from "./fake-container";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const RIGHT = "right-password-0123456789abcdef";
const WRONG = "wrong-password-0123456789abcdef";

async function pausedSession() {
  const { WorkspaceSession } = await import("../src/orb/session");
  const kv = new MemoryKV();
  await kv.put("orb", {
    v: 1,
    workspaceId: "demo",
    orbId: "demo",
    state: "paused",
    imageKey: "orb",
    instance: "standard-1",
    passwordSha: await tokenSha(RIGHT),
    updatedAt: new Date().toISOString(),
  });
  const storage = {
    get: (k: string) => kv.get(k),
    put: (k: string, v: unknown) => kv.put(k, v),
    delete: (k: string) => kv.delete(k),
    list: ({ prefix }: { prefix: string }) => kv.list(prefix),
    setAlarm: async () => {},
  };
  const container = {
    running: false,
    start: vi.fn(() => {
      throw new Error("no capacity in test");
    }),
  };
  const registry = {
    acquireRunSlot: async () => ({ ok: true }),
    releaseRunSlot: async () => {},
    recordSnapshot: async () => {},
  };
  const ctx = {
    storage,
    container,
    id: { name: "ws:demo" },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
    waitUntil: () => {},
  };
  const env = { CF_OPENCODE_CONFIG: "{}", REGISTRY: { getByName: () => registry } };
  const session = new WorkspaceSession(ctx as never, env as never);
  return { session, container, kv };
}

const opencodeReq = (password: string) =>
  new Request("http://container/api/info", { headers: { "x-cf-opencode-password": password } });

describe("workspace password check", () => {
  it("a wrong password gets a JSON 401 and starts nothing", async () => {
    const { session, container, kv } = await pausedSession();
    const res = await session.proxy(opencodeReq(WRONG));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(container.start).not.toHaveBeenCalled();
    expect((await kv.get<{ passwordSha: string }>("orb"))?.passwordSha).toBe(await tokenSha(RIGHT));
  });

  it("the right password wakes the paused workspace", async () => {
    const { session, container } = await pausedSession();
    const res = await session.proxy(opencodeReq(RIGHT));
    expect(container.start).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503); // the fake container refuses to start
  });

  it("browse and the terminals refuse a wrong password before doing anything", async () => {
    const { session, container } = await pausedSession();
    expect(await session.browse(WRONG)).toMatchObject({ ok: false, status: 401 });
    for (const path of ["/shell", "/ssh"]) {
      const res = await session.fetch(
        new Request(`https://workspace${path}`, {
          headers: { upgrade: "websocket", "x-cf-opencode-password": WRONG },
        }),
      );
      expect(res.status).toBe(401);
    }
    expect(container.start).not.toHaveBeenCalled();
  });
});
