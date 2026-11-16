import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cp, localTarget, parseSide } from "../src/cp.js";

const hasTar = spawnSync("tar", ["--version"]).status === 0;

describe("parseSide", () => {
  it.each([
    ["app:data/x.json", { kind: "workspace", workspace: "app", path: "data/x.json" }],
    ["app:", { kind: "workspace", workspace: "app", path: "" }],
    ["my_app-2:/home/user/x", { kind: "workspace", workspace: "my_app-2", path: "/home/user/x" }],
    ["./app:x", { kind: "local", path: "./app:x" }],
    ["/tmp/a:b", { kind: "local", path: "/tmp/a:b" }],
    ["~/x", { kind: "local", path: "~/x" }],
    ["C:\\data", { kind: "local", path: "C:\\data" }],
    ["export.json", { kind: "local", path: "export.json" }],
  ])("%s", (s, want) => {
    expect(parseSide(s)).toEqual(want);
  });
});

describe("localTarget", () => {
  it("puts the item inside an existing folder or a path with a trailing slash", () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-target-"));
    expect(localTarget(dir, "x")).toBe(join(dir, "x"));
    expect(localTarget(`${dir}/new/`, "x")).toBe(join(dir, "new", "x"));
    expect(localTarget(join(dir, "y"), "x")).toBe(join(dir, "y"));
  });
});

/** A fake Worker: answers by method and path, and keeps the requests. */
function worker(routes: Record<string, (req: Request) => Response | Promise<Response>>) {
  const seen: Request[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push(req.clone());
    const u = new URL(req.url);
    const key = `${req.method} ${u.pathname}${u.searchParams.has("stat") ? "?stat" : ""}`;
    const h = routes[key];
    if (!h) return Response.json({ error: `Failed: no route ${key} — fix: test` }, { status: 404 });
    return h(req);
  }) as typeof fetch;
  return { fetchFn, seen };
}

const awake = () => Response.json({ workspace: { state: "awake" }, containerRunning: true });

describe("cp", () => {
  it("refuses two local sides", async () => {
    await expect(
      cp(parseSide("./a"), parseSide("./b"), { url: "https://w", token: "t", force: false, err: () => {} }),
    ).rejects.toThrow(/both sides are on this machine/);
  });

  it("prints the Worker's progress lines and returns its result, workspace to workspace", async () => {
    const result = {
      from: "a:/home/user/project/f",
      to: "b:/home/user/project/f",
      bytes: 1,
      files: 1,
      dirs: 0,
      links: 0,
      seconds: 0.1,
    };
    const w = worker({
      "POST /v1/copy": () =>
        new Response(
          `${JSON.stringify({ line: "a is paused; waking it" })}\n${JSON.stringify({ ok: true, result })}\n`,
        ),
    });
    const lines: string[] = [];
    const r = await cp(parseSide("a:f"), parseSide("b:"), {
      url: "https://w",
      token: "t",
      force: true,
      err: (l) => lines.push(l),
      fetchFn: w.fetchFn,
    });
    expect(r).toEqual(result);
    expect(lines).toEqual(["a is paused; waking it"]);
    expect(await w.seen[0]?.json()).toEqual({
      from: { workspace: "a", path: "f" },
      to: { workspace: "b", path: "" },
      force: true,
    });
    expect(w.seen[0]?.headers.get("authorization")).toBe("Bearer t");
  });

  it("fails with the Worker's error line, and when the stream ends without a result", async () => {
    const err =
      "Failed: b:/home/user/project/f exists — fix: pass --force to replace it, or pick another target";
    const w = worker({
      "POST /v1/copy": () => new Response(`${JSON.stringify({ ok: false, error: err })}\n`),
    });
    const o = { url: "https://w", token: "t", force: false, err: () => {}, fetchFn: w.fetchFn };
    await expect(cp(parseSide("a:f"), parseSide("b:f"), o)).rejects.toThrow(err);
    const cut = worker({ "POST /v1/copy": () => new Response(`${JSON.stringify({ line: "copying" })}\n`) });
    await expect(cp(parseSide("a:f"), parseSide("b:f"), { ...o, fetchFn: cut.fetchFn })).rejects.toThrow(
      /broke off/,
    );
  });

  it.skipIf(!hasTar)("downloads into a folder, and leaves nothing when the target exists", async () => {
    const src = mkdtempSync(join(tmpdir(), "cp-src-"));
    mkdirSync(join(src, "data"));
    writeFileSync(join(src, "data", "r.csv"), "1,2");
    const tar = spawnSync("tar", ["-cf", "-", "-C", src, "data"]).stdout;
    const w = worker({
      "GET /v1/workspaces/a": awake,
      "GET /v1/workspaces/a/files?stat": () =>
        Response.json({ path: "/home/user/project/out", name: "out", kind: "dir", bytes: 3, entries: 2 }),
      "GET /v1/workspaces/a/files": () => new Response(tar),
    });
    const dest = mkdtempSync(join(tmpdir(), "cp-dest-"));
    const o = { url: "https://w", token: "t", force: false, err: () => {}, fetchFn: w.fetchFn };
    const r = await cp(parseSide("a:out"), parseSide(dest), o);
    expect(r).toMatchObject({ from: "a:/home/user/project/out", to: join(dest, "out"), files: 1, dirs: 1 });
    expect(readFileSync(join(dest, "out", "r.csv"), "utf8")).toBe("1,2");
    await expect(cp(parseSide("a:out"), parseSide(dest), o)).rejects.toThrow(/exists — fix: pass --force/);
    expect(readdirSync(dest)).toEqual(["out"]);
  });

  it.skipIf(!hasTar)("removes the stage when a download breaks off", async () => {
    const w = worker({
      "GET /v1/workspaces/a": awake,
      "GET /v1/workspaces/a/files?stat": () =>
        Response.json({ path: "/home/user/f", name: "f", kind: "file", bytes: 3, entries: 1 }),
      "GET /v1/workspaces/a/files": () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(512));
              c.error(new Error("cut"));
            },
          }),
        ),
    });
    const dest = mkdtempSync(join(tmpdir(), "cp-dest-"));
    await expect(
      cp(parseSide("a:~/f"), parseSide(dest), {
        url: "https://w",
        token: "t",
        force: false,
        err: () => {},
        fetchFn: w.fetchFn,
      }),
    ).rejects.toThrow(/broke off/);
    expect(readdirSync(dest)).toEqual([]);
  });

  it.skipIf(!hasTar)("uploads one archive with its length, the name and the force flag", async () => {
    const src = mkdtempSync(join(tmpdir(), "cp-up-"));
    writeFileSync(join(src, "fixtures.json"), "{}");
    const w = worker({
      "GET /v1/workspaces/b": () =>
        Response.json({ workspace: { state: "paused" }, containerRunning: false }),
      "GET /v1/workspaces/b/files?stat": () =>
        Response.json({ path: "/home/user/project/t", name: "t", kind: "none", bytes: 0, entries: 0 }),
      "PUT /v1/workspaces/b/files": () =>
        Response.json({
          ok: true,
          result: {
            from: "upload",
            to: "b:/home/user/project/t/fixtures.json",
            bytes: 2,
            files: 1,
            dirs: 0,
            links: 0,
            seconds: 0,
          },
        }),
    });
    const lines: string[] = [];
    const r = await cp(parseSide(join(src, "fixtures.json")), parseSide("b:t/"), {
      url: "https://w",
      token: "t",
      force: true,
      err: (l) => lines.push(l),
      fetchFn: w.fetchFn,
    });
    expect(r.to).toBe("b:/home/user/project/t/fixtures.json");
    expect(lines[0]).toMatch(/^b is paused; waking it to write its disk/);
    const put = w.seen.find((q) => q.method === "PUT") as Request;
    const u = new URL(put.url);
    expect(Object.fromEntries(u.searchParams)).toEqual({ path: "t/", name: "fixtures.json", force: "1" });
    const body = new Uint8Array(await put.arrayBuffer());
    expect(put.headers.get("content-length")).toBe(String(body.byteLength));
    const out = mkdtempSync(join(tmpdir(), "cp-check-"));
    expect(spawnSync("tar", ["-xf", "-", "-C", out], { input: body }).status).toBe(0);
    expect(existsSync(join(out, "fixtures.json"))).toBe(true);
  });
});
