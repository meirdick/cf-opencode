import { describe, expect, it } from "vitest";
import type { ControlClient } from "../src/api.js";
import { type PreviewOptions, parsePort, preview } from "../src/preview.js";

const WORKER = "https://cf-opencode.example.workers.dev";
const PASSWORD = "derived-password-0123456789abcdef";

function run(over: Partial<PreviewOptions>, answer: Record<string, unknown> & { status?: number } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  const opened: string[] = [];
  const calls: string[] = [];
  const o: PreviewOptions = {
    id: "demo",
    port: "3000",
    public: false,
    stop: false,
    list: false,
    open: true,
    json: false,
    target: () => ({ url: WORKER, id: "demo", password: PASSWORD }),
    control: () =>
      ({
        previews: async () => ({ public: [] }),
        sharePreview: async (_id: string, port: number) => {
          calls.push(`share ${port}`);
          return { port, url: `${WORKER}/public/demo/${"t".repeat(43)}/`, createdAt: "x" };
        },
        unsharePreview: async (_id: string, port?: number) => {
          calls.push(`unshare ${port}`);
          return { removed: port ? [port] : [] };
        },
      }) as unknown as ControlClient,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    fetchFn: async (url, init) => {
      requests.push({ url: String(url), init });
      const { status = 200, ...body } = answer;
      return Response.json(
        {
          url: `${WORKER}/preview/demo/3000/`,
          link: `${WORKER}/preview/demo/3000/?cf_opencode_ticket=1.n.m`,
          expiresAt: "2026-11-12T10:02:00Z",
          awake: true,
          listening: true,
          ...body,
        },
        { status },
      );
    },
    opener: async (url) => {
      opened.push(url);
      return true;
    },
    ...over,
  };
  return { done: preview(o), out, err, requests, opened, calls };
}

describe("cf-opencode preview", () => {
  it("prints the URL, opens the one-time link, and sends the password only in a header", async () => {
    const r = run({});
    expect(await r.done).toBe(0);
    expect(r.out).toEqual([`${WORKER}/preview/demo/3000/`]);
    expect(r.opened[0]).toContain("cf_opencode_ticket=");
    const req = r.requests[0]!;
    expect(req.url).toBe(`${WORKER}/preview/demo/link`);
    expect(req.url).not.toContain(PASSWORD);
    expect(String((req.init!.headers as Record<string, string>).authorization)).toMatch(/^Basic /);
    expect(r.opened[0]).not.toContain(PASSWORD);
  });

  it("--no-open prints the sign-in link instead of opening it", async () => {
    const r = run({ open: false });
    await r.done;
    expect(r.opened).toEqual([]);
    expect(r.err.join("\n")).toContain("sign-in link (one use, 2 minutes)");
  });

  it("a paused workspace fails with one line that says to connect", async () => {
    const r = run({}, { awake: false, listening: false });
    await expect(r.done).rejects.toThrow(/^Failed: demo is paused.* — fix: cf-opencode connect demo/);
  });

  it("a Worker error is passed on as its own Failed line", async () => {
    const r = run(
      {},
      { status: 401, error: "Failed: the workspace refused the password — fix: cf-opencode connect demo" },
    );
    await expect(r.done).rejects.toThrow(
      "Failed: the workspace refused the password — fix: cf-opencode connect demo",
    );
  });

  it("warns when nothing listens yet", async () => {
    const r = run({}, { listening: false });
    await r.done;
    expect(r.err[0]).toContain("0.0.0.0");
  });

  it("refuses a bad port before any request", async () => {
    expect(() => parsePort("80", "demo")).toThrow(/^Failed: bad port 80 — fix: /);
    expect(() => parsePort(undefined, "demo")).toThrow(/needs a port/);
    expect(parsePort("5173", "demo")).toBe(5173);
  });

  it("--public uses the control client and says what it exposes; --stop removes it", async () => {
    const pub = run({ public: true });
    await pub.done;
    expect(pub.calls).toEqual(["share 3000"]);
    expect(pub.requests).toEqual([]);
    expect(pub.out[0]).toContain("/public/demo/");
    expect(pub.err.join("\n")).toMatch(/no password/);
    const stop = run({ stop: true });
    await stop.done;
    expect(stop.calls).toEqual(["unshare 3000"]);
    const all = run({ stop: true, port: undefined });
    await all.done;
    expect(all.calls).toEqual(["unshare undefined"]);
  });

  it("--public with --stop is refused", async () => {
    await expect(run({ public: true, stop: true }).done).rejects.toThrow(/do not go together/);
  });
});
