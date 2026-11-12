// The Durable Object's preview path: a preview never wakes a paused workspace, even with the right password.
import { describe, expect, it, vi } from "vitest";
import { tokenSha } from "../src/orb/journal";
import { TARGET_HEADER } from "../src/orb/preview";
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

async function session(state: string, running: boolean) {
  const { WorkspaceSession } = await import("../src/orb/session");
  const kv = new MemoryKV();
  await kv.put("orb", {
    v: 1,
    workspaceId: "demo",
    orbId: "demo",
    state,
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
  const ports: number[] = [];
  const container = {
    running,
    start: vi.fn(),
    setInactivityTimeout: async () => {},
    getTcpPort: (p: number) => ({
      fetch: async () => {
        ports.push(p);
        return new Response("dev server");
      },
    }),
  };
  const ctx = {
    storage,
    container,
    id: { name: "ws:demo" },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
    waitUntil: () => {},
  };
  const env = {
    CF_OPENCODE_CONFIG: "{}",
    CONTROL_TOKEN: "control-token-0123456789abcdef",
    REGISTRY: { getByName: () => ({}) },
  };
  return { s: new WorkspaceSession(ctx as never, env as never), container, ports, kv };
}

const req = () =>
  new Request("https://workspace/preview", {
    headers: {
      authorization: `Basic ${btoa(`opencode:${RIGHT}`)}`,
      [TARGET_HEADER]: JSON.stringify({
        kind: "private",
        workspaceId: "demo",
        port: 3000,
        path: "/",
        search: "",
        origin: "https://cf-opencode.example.workers.dev",
      }),
    },
  });

describe("preview in the Durable Object", () => {
  it("a paused workspace answers a page and starts nothing", async () => {
    const { s, container, ports } = await session("paused", false);
    const res = await s.fetch(req());
    expect(res.status).toBe(503);
    expect(container.start).not.toHaveBeenCalled();
    expect(ports).toEqual([]);
  });

  it("an awake workspace proxies to the port and records use", async () => {
    const { s, ports, kv } = await session("awake", true);
    const res = await s.fetch(req());
    expect(await res.text()).toBe("dev server");
    expect(ports).toEqual([3000]);
    await new Promise((r) => setTimeout(r, 0));
    expect(await kv.get("lastProxyAt")).toBeDefined();
  });

  it("public shares are listed, made and removed over RPC", async () => {
    const { s } = await session("awake", true);
    expect(await s.previewShares()).toEqual([]);
    const made = await s.sharePreview(3000);
    expect(made.ok).toBe(true);
    expect(await s.sharePreview(4096)).toMatchObject({ ok: false, status: 400 });
    expect((await s.previewShares()).map((x) => x.port)).toEqual([3000]);
    expect(await s.unsharePreview()).toEqual([3000]);
  });
});
