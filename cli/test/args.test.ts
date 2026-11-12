import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("reads long flags, shorts, and positionals", () => {
    const spec = { dir: { type: "string" as const }, help: { type: "boolean" as const, short: "h" } };
    const args = parseArgs(["connect", "--dir", "/tmp/x", "-h", "workspace"], spec);
    expect(args.positionals).toEqual(["connect", "workspace"]);
    expect(args.flags.dir).toBe("/tmp/x");
    expect(args.flags.help).toBe(true);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--nope"], {})).toThrow(/unknown flag/);
  });
});

describe("ControlClient errors", () => {
  it("keeps a Worker error line whole, with one fix", async () => {
    const { ControlClient } = await import("../src/api.js");
    const line = "Failed: internal error: reset — fix: retry";
    const f = (async () => new Response(JSON.stringify({ error: line }), { status: 500 })) as typeof fetch;
    await expect(new ControlClient("https://w.example", "t", f).health()).rejects.toThrow(line);
    const e = await new ControlClient("https://w.example", "t", f).health().catch((x: Error) => x.message);
    expect(String(e).match(/— fix:/g)).toHaveLength(1);
  });
});

describe("ControlClient and answers that are not the Worker's", () => {
  const page = () =>
    new Response("<!DOCTYPE html><html><body>error code: 1042</body></html>", {
      status: 404,
      headers: { "content-type": "text/html" },
    });
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };

  it("tries a read again, and never prints the page", async () => {
    const { ControlClient } = await import("../src/api.js");
    waits.length = 0;
    let n = 0;
    const f = (async () =>
      ++n < 3 ? page() : new Response(JSON.stringify({ ok: true, version: "0.2.1" }))) as typeof fetch;
    expect(await new ControlClient("https://w.example", "t", f, sleep).health()).toEqual({
      ok: true,
      version: "0.2.1",
    });
    expect(waits).toEqual([1000, 2000]);

    const always = (async () => page()) as typeof fetch;
    const e = await new ControlClient("https://w.example", "t", always, sleep)
      .health()
      .catch((x: Error) => x.message);
    expect(e).toMatch(
      /^Failed: https:\/\/w\.example answered HTTP 404 \(Cloudflare error 1042\) with a page/,
    );
    expect(e).toMatch(/fix: wait a few seconds/);
    expect(e).not.toContain("<");
  });

  it("tries an op submit again, but not a request that would run twice", async () => {
    const { ControlClient } = await import("../src/api.js");
    let ops = 0;
    const f = (async (url: string) => {
      if (String(url).endsWith("/ops"))
        return ++ops < 2 ? page() : new Response(JSON.stringify({ opId: "a:b", attached: false }));
      return page();
    }) as unknown as typeof fetch;
    const c = new ControlClient("https://w.example", "t", f, sleep);
    expect(await c.submit("app", { op: "spawn" })).toEqual({ opId: "a:b", attached: false });
    expect(ops).toBe(2);
    let posts = 0;
    const g = (async () => {
      posts++;
      return page();
    }) as typeof fetch;
    await expect(
      new ControlClient("https://w.example", "t", g, sleep).startTask("app", { text: "x" }),
    ).rejects.toThrow(/with a page/);
    expect(posts).toBe(1);
  });

  it("does not try again for an answer that is the Worker's own", async () => {
    const { ControlClient } = await import("../src/api.js");
    let n = 0;
    const f = (async () => {
      n++;
      return new Response(JSON.stringify({ error: "Failed: no such workspace — fix: cf-opencode list" }), {
        status: 404,
      });
    }) as typeof fetch;
    await expect(new ControlClient("https://w.example", "t", f, sleep).status("x")).rejects.toThrow(
      /no such workspace/,
    );
    expect(n).toBe(1);
  });
});
