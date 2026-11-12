// The remote browser and cf-opencode-fetch reach the workspace's dev server by p<port>.preview.internal, through
// Browser Run's outboundByHost. These tests use a fake binding and a fake CDP socket.
import { describe, expect, it } from "vitest";
import { handleAi } from "../src/orb/ai";
import { openBrowserSession } from "../src/orb/browse";
import { type CdpSocket, type PreviewBrowser, readPreviewPage } from "../src/orb/preview-browser";
import { previewHost, previewOutbound, previewPortOf } from "../src/orb/preview-hosts";

class FakeCdp implements CdpSocket {
  sent: { id: number; method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  closed = false;
  private handlers: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
  constructor(private readonly answer: (method: string, params: Record<string, unknown>) => unknown) {}
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void) {
    const list = this.handlers[type] ?? [];
    list.push(fn);
    this.handlers[type] = list;
  }
  private emit(data: unknown) {
    for (const fn of this.handlers.message ?? []) fn({ data: JSON.stringify(data) });
  }
  send(data: string) {
    const m = JSON.parse(data) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
      sessionId?: string;
    };
    this.sent.push(m);
    queueMicrotask(() => {
      this.emit({ id: m.id, result: this.answer(m.method, m.params) });
      if (m.method === "Page.navigate")
        this.emit({ method: "Page.loadEventFired", sessionId: m.sessionId, params: {} });
    });
  }
  close() {
    this.closed = true;
  }
}

function fakeBrowser(cdp: FakeCdp) {
  const acquired: Record<string, unknown>[] = [];
  const closed: string[] = [];
  const quick: { action: string; options: Record<string, unknown> }[] = [];
  const browser: PreviewBrowser = {
    acquire: async (o) => {
      acquired.push(o as Record<string, unknown>);
      return { sessionId: "sess-1" };
    },
    connectSession: async () => ({
      webSocket: {
        fetch: async () => ({ status: 101, webSocket: cdp }) as unknown as Response,
      } as unknown as Fetcher,
    }),
    getLiveView: async () => null,
    closeSession: async (id) => {
      closed.push(id);
    },
    quickAction: async (action, options) => {
      quick.push({ action, options });
      return Response.json({ success: true, result: "# Hello" });
    },
  };
  return { browser, acquired, closed, quick };
}

const answers = (method: string): unknown => {
  if (method === "Target.createTarget") return { targetId: "t1" };
  if (method === "Target.attachToTarget") return { sessionId: "page-1" };
  if (method === "Page.navigate") return { frameId: "f" };
  if (method === "Runtime.evaluate") return { result: { value: "<html><body><h1>Hello</h1></body></html>" } };
  if (method === "Page.captureScreenshot") return { data: btoa("PNG!") };
  return {};
};

describe("preview hostnames", () => {
  it("name the port, and localhost URLs map to the same port", () => {
    expect(previewHost(3000)).toBe("p3000.preview.internal");
    expect(previewPortOf(new URL("http://p5173.preview.internal/x"))).toBe(5173);
    expect(previewPortOf(new URL("http://localhost:3000/"))).toBe(3000);
    expect(previewPortOf(new URL("http://127.0.0.1:8080/"))).toBe(8080);
    expect(previewPortOf(new URL("http://localhost/"))).toBeUndefined();
    expect(previewPortOf(new URL("https://example.com:3000/"))).toBeUndefined();
    expect(previewPortOf(new URL("http://p3000.preview.internal.evil.example/"))).toBeUndefined();
  });

  it("route each port to PreviewEgress with this workspace and that port in its props", () => {
    const made: unknown[] = [];
    const out = previewOutbound(
      (o) => {
        made.push(o.props);
        return {} as Fetcher;
      },
      "demo",
      [3000, 5173],
    );
    expect(Object.keys(out)).toEqual(["p3000.preview.internal", "p5173.preview.internal"]);
    expect(made).toEqual([
      { workspaceId: "demo", port: 3000 },
      { workspaceId: "demo", port: 5173 },
    ]);
  });

  it("a browse session passes outboundByHost to acquire only when ports are asked for", async () => {
    const seen: unknown[] = [];
    const binding = {
      acquire: async (o?: unknown) => {
        seen.push(o);
        return { sessionId: "s" };
      },
      connectSession: async () => ({ webSocket: {} as Fetcher }),
      getLiveView: async () => null,
    };
    const outbound = { "p3000.preview.internal": {} as Fetcher };
    await openBrowserSession(binding, 60_000);
    await openBrowserSession(binding, 60_000, outbound);
    expect(seen).toEqual([{ keepAlive: 60_000 }, { keepAlive: 60_000, outboundByHost: outbound }]);
  });
});

describe("readPreviewPage", () => {
  it("loads the page in a routed session, reads the rendered HTML as Markdown, and closes the session", async () => {
    const cdp = new FakeCdp(answers);
    const { browser, acquired, closed, quick } = fakeBrowser(cdp);
    const outbound = { "p3000.preview.internal": {} as Fetcher };
    const out = await readPreviewPage(browser, outbound, 3000, "/about?x=1", "markdown", 0);
    expect(out).toEqual({ body: "# Hello", type: "text/markdown; charset=utf-8" });
    expect(acquired[0]).toMatchObject({ outboundByHost: outbound });
    const nav = cdp.sent.find((m) => m.method === "Page.navigate");
    expect(nav?.params.url).toBe("http://p3000.preview.internal/about?x=1");
    expect(nav?.sessionId).toBe("page-1");
    expect(quick[0]?.options.html).toContain("<h1>Hello</h1>");
    expect(cdp.closed).toBe(true);
    expect(closed).toEqual(["sess-1"]);
  });

  it("saves a screenshot as bytes", async () => {
    const { browser } = fakeBrowser(new FakeCdp(answers));
    const out = await readPreviewPage(browser, {}, 3000, "/", "screenshot", 0);
    expect(out.type).toBe("image/png");
    expect(new TextDecoder().decode(out.body as Uint8Array)).toBe("PNG!");
  });

  it("a navigation error closes the session and says why", async () => {
    const cdp = new FakeCdp((m) =>
      m === "Page.navigate" ? { errorText: "net::ERR_CONNECTION_REFUSED" } : answers(m),
    );
    const { browser, closed } = fakeBrowser(cdp);
    await expect(readPreviewPage(browser, {}, 3000, "/", "html", 0)).rejects.toThrow(/CONNECTION_REFUSED/);
    expect(closed).toEqual(["sess-1"]);
  });
});

describe("cf-opencode-fetch of a dev server", () => {
  const page = (url: string) =>
    new Request("http://ai.cf-opencode.internal/page", {
      method: "POST",
      body: JSON.stringify({ url, format: "markdown" }),
    });
  const quickOnly = { quickAction: async () => Response.json({ success: true, result: "public page" }) };

  it("goes to the preview reader for a preview host or localhost, and to Quick Actions otherwise", async () => {
    const asked: unknown[] = [];
    const reader = async (port: number, path: string, format: string) => {
      asked.push([port, path, format]);
      return { body: "# dev", type: "text/markdown; charset=utf-8" };
    };
    const a = await handleAi(
      page("http://p3000.preview.internal/x?y=1"),
      undefined,
      "default",
      undefined,
      quickOnly,
      reader,
    );
    expect(await a.text()).toBe("# dev");
    await handleAi(page("http://localhost:5173/"), undefined, "default", undefined, quickOnly, reader);
    expect(asked).toEqual([
      [3000, "/x?y=1", "markdown"],
      [5173, "/", "markdown"],
    ]);
    const b = await handleAi(
      page("https://example.com/"),
      undefined,
      "default",
      undefined,
      quickOnly,
      reader,
    );
    expect(await b.text()).toBe("public page");
  });

  it("without a reader (an old container), a preview host fails with the fix", async () => {
    const res = await handleAi(
      page("http://p3000.preview.internal/"),
      undefined,
      "default",
      undefined,
      quickOnly,
    );
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain("cf-opencode upgrade");
  });
});
