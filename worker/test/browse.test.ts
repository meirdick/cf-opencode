import { describe, expect, it } from "vitest";
import { handleApi } from "../src/api";
import type { Env } from "../src/env";
import { type BrowserBinding, KEEP_ALIVE_MS, openBrowserSession } from "../src/orb/browse";

function fakeBrowser(
  acquire: (o?: { keepAlive?: number }) => Promise<{ sessionId: string }>,
): BrowserBinding & { seen: number[] } {
  const seen: number[] = [];
  return {
    seen,
    acquire: async (o) => {
      seen.push(o?.keepAlive ?? -1);
      return acquire(o);
    },
    connectSession: async () => ({ webSocket: {} as Fetcher }),
    getLiveView: async () => ({ devtoolsFrontendUrl: "https://live.browser.run/ui/x" }),
  };
}

describe("openBrowserSession", () => {
  it("refuses without a Browser Run binding, and names the fix", async () => {
    const out = await openBrowserSession(undefined);
    expect(out).toMatchObject({ status: 503 });
    if ("error" in out) expect(out.error).toMatch(/cf-opencode init/);
  });

  it("returns the session and its live view", async () => {
    const out = await openBrowserSession(fakeBrowser(async () => ({ sessionId: "sess-1" })));
    expect(out).toEqual({ sessionId: "sess-1", liveUrl: "https://live.browser.run/ui/x" });
  });

  it("clamps keepAlive into the documented range", async () => {
    const b = fakeBrowser(async () => ({ sessionId: "s" }));
    await openBrowserSession(b, 1);
    await openBrowserSession(b, 9_999_999);
    await openBrowserSession(b);
    expect(b.seen).toEqual([10_000, 1_200_000, KEEP_ALIVE_MS]);
  });

  it("reports a refused session as one line", async () => {
    const out = await openBrowserSession(
      fakeBrowser(async () => {
        throw new Error("limit reached");
      }),
    );
    expect(out).toMatchObject({ status: 502 });
    if ("error" in out) expect(out.error).toMatch(/^Failed: .*limit reached.* — fix: /);
  });
});

describe("/browse routes", () => {
  const auth = { authorization: `Basic ${btoa("opencode:pw-0123456789abcdef")}` };
  function env(authorized: boolean) {
    const calls: string[] = [];
    const stub = {
      authorize: async () => {
        calls.push("authorize");
        return authorized;
      },
      browse: async () => ({
        ok: true,
        session: { sessionId: "sess-1", liveUrl: "https://live.browser.run/x" },
      }),
    };
    return { env: { WORKSPACE: { getByName: () => stub } } as unknown as Env, calls };
  }

  it("hands out a websocket on this Worker, the only CDP endpoint the container gets", async () => {
    const res = await handleApi(
      new Request("https://w.example/browse/demo", { method: "POST", headers: auth, body: "{}" }),
      env(true).env,
    );
    const body = (await res.json()) as { websocketUrl: string; sessionId: string };
    expect(body.websocketUrl).toBe("wss://w.example/browse/demo/sess-1");
    expect(JSON.stringify(body)).not.toContain("api.cloudflare.com");
  });

  it("refuses the relay for a wrong password before it opens anything", async () => {
    const { env: e, calls } = env(false);
    const res = await handleApi(
      new Request("https://w.example/browse/demo/sess-1", { headers: { ...auth, upgrade: "websocket" } }),
      e,
    );
    expect(res.status).toBe(401);
    expect(calls).toEqual(["authorize"]);
  });
});
