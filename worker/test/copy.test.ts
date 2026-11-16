// cp end to end on this machine: the real scripts and GNU tar run against temp folders that stand in for two
// workspaces' /home/user. Only the container is replaced; copy.ts, the guard and the route are the real code.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type CopyStub, copyRoute, runBetween } from "../src/copy-api";
import type { OrbRecord } from "../src/core/types";
import { resolvePath, wakeForCopy } from "../src/orb/copy";
import { FakeClock } from "./fake-container";
import { linux, pair, stages } from "./local-workspace";

describe("resolvePath", () => {
  it.each([
    ["export.json", "/home/user/project/export.json", false],
    ["", "/home/user/project", true],
    ["data/", "/home/user/project/data", true],
    ["../notes.md", "/home/user/notes.md", false],
    ["~/x", "/home/user/x", false],
    ["~", "/home/user", false],
    ["/home/user/a/./b//c", "/home/user/a/b/c", false],
  ])("%s", (raw, path, slash) => {
    expect(resolvePath(raw, "/home/user/project")).toEqual({ ok: true, path, slash });
  });

  it.each(["../../etc/passwd", "/etc", "/home/userx", "~root/x", "a\nb", "/home/user/../../tmp"])(
    "refuses %j",
    (raw) => {
      const r = resolvePath(raw, "/home/user/project");
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/^Failed: .* — fix: /);
    },
  );
});

describe("wakeForCopy", () => {
  const base = {
    workspaceId: "w",
    controlToken: "t".repeat(40),
    password: async () => "derived",
  };
  it("wakes nothing when the workspace is awake", async () => {
    const spawnFn = vi.fn();
    const r = await wakeForCopy({
      ...base,
      running: () => true,
      record: async () => ({ state: "awake" }) as OrbRecord,
      spawn: spawnFn,
    });
    expect(r).toBeUndefined();
    expect(spawnFn).not.toHaveBeenCalled();
  });
  it("wakes a paused or warm workspace with the derived password and its directory", async () => {
    for (const state of ["paused", "warm"] as const) {
      const spawnFn = vi.fn(async () => ({ phase: "succeeded" }) as never);
      const r = await wakeForCopy({
        ...base,
        running: () => state === "warm",
        record: async () => ({ state, directory: "/home/user/app" }) as OrbRecord,
        spawn: spawnFn,
      });
      expect(r).toBeUndefined();
      expect(spawnFn).toHaveBeenCalledWith("derived", "/home/user/app");
    }
  });
  it("refuses a workspace that was never connected, and says why a wake failed", async () => {
    expect(
      await wakeForCopy({ ...base, running: () => false, record: async () => undefined, spawn: vi.fn() }),
    ).toMatch(/never connected/);
    const r = await wakeForCopy({
      ...base,
      running: () => false,
      record: async () => ({ state: "paused" }) as OrbRecord,
      spawn: async () =>
        ({ phase: "failed", error: "Failed: 10/10 workspaces running — fix: pause one" }) as never,
    });
    expect(r).toMatch(/^Failed: workspace w did not wake \(10\/10 workspaces running\) — fix: /);
  });
});

describe.skipIf(!linux)("cp between two workspaces", () => {
  it("copies a file into the other checkout", async () => {
    const { a, b, stubOf } = pair();
    writeFileSync(a.file("project/export.json"), '{"rows":3}');
    const lines: string[] = [];
    const r = await runBetween(
      stubOf,
      { workspace: "a", path: "export.json" },
      { workspace: "b", path: "" },
      false,
      (l) => lines.push(l),
    );
    expect(r).toMatchObject({
      ok: true,
      result: { from: "a:/home/user/project/export.json", to: "b:/home/user/project/export.json", files: 1 },
    });
    expect(readFileSync(b.file("project/export.json"), "utf8")).toBe('{"rows":3}');
    expect(lines.some((l) => l.startsWith("copying a:/home/user/project/export.json"))).toBe(true);
    expect(stages(b)).toEqual([]);
  });

  it("copies a tree with its inner symlink, under a new name and into a new folder", async () => {
    const { a, b, stubOf } = pair();
    mkdirSync(a.file("project/data/sub"), { recursive: true });
    writeFileSync(a.file("project/data/sub/x.txt"), "x");
    symlinkSync("sub/x.txt", a.file("project/data/link"));
    const r = await runBetween(
      stubOf,
      { workspace: "a", path: "data" },
      { workspace: "b", path: "~/in/" },
      false,
      () => {},
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(b.file("in/data/sub/x.txt"), "utf8")).toBe("x");
    expect(readlinkSync(b.file("in/data/link"))).toBe("sub/x.txt");
    const named = await runBetween(
      stubOf,
      { workspace: "a", path: "data" },
      { workspace: "b", path: "copy" },
      false,
      () => {},
    );
    expect(named.ok).toBe(true);
    expect(readFileSync(b.file("project/copy/sub/x.txt"), "utf8")).toBe("x");
  });

  it("refuses to replace a target without --force, and replaces it with --force", async () => {
    const { a, b, stubOf } = pair();
    writeFileSync(a.file("project/f"), "new");
    writeFileSync(b.file("project/f"), "old");
    const r = await runBetween(
      stubOf,
      { workspace: "a", path: "f" },
      { workspace: "b", path: "f" },
      false,
      () => {},
    );
    expect(r).toEqual({
      ok: false,
      error:
        "Failed: b:/home/user/project/f exists — fix: pass --force to replace it, or pick another target",
    });
    expect(readFileSync(b.file("project/f"), "utf8")).toBe("old");
    const f = await runBetween(
      stubOf,
      { workspace: "a", path: "f" },
      { workspace: "b", path: "f" },
      true,
      () => {},
    );
    expect(f.ok).toBe(true);
    expect(readFileSync(b.file("project/f"), "utf8")).toBe("new");
  });

  it("refuses a missing source, a path outside /home/user, and a symlink that leads out", async () => {
    const { a, stubOf } = pair();
    const to = { workspace: "b", path: "" };
    const missing = await runBetween(stubOf, { workspace: "a", path: "nope" }, to, false, () => {});
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/does not exist/) });
    const outside = await runBetween(
      stubOf,
      { workspace: "a", path: "../../etc/passwd" },
      to,
      false,
      () => {},
    );
    expect(outside).toMatchObject({ ok: false, error: expect.stringMatching(/outside \/home\/user/) });
    symlinkSync("/etc", a.file("project/etc"));
    const viaLink = await runBetween(stubOf, { workspace: "a", path: "etc" }, to, false, () => {});
    expect(viaLink).toMatchObject({ ok: false, error: expect.stringMatching(/symlink to a place outside/) });
  });

  it("leaves the target unchanged when the source sends a hostile archive", async () => {
    const { a, b } = pair();
    writeFileSync(a.file("project/f"), "x");
    // The source agent replaced tar: its stream names a file outside the tree.
    const hostile = spawnSync("tar", [
      "-cf",
      "-",
      "-P",
      "--transform",
      "s,^.*project/f,f/../../../evil,",
      a.file("project/f"),
    ]);
    const evil: CopyStub = {
      ...a.stub,
      copyOut: async () => ({
        ok: true,
        stream: new Response(hostile.stdout).body as ReadableStream<Uint8Array>,
      }),
    };
    const r = await runBetween(
      (id) => (id === "a" ? evil : b.stub),
      { workspace: "a", path: "f" },
      { workspace: "b", path: "" },
      false,
      () => {},
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/leaves the copied tree/) });
    expect(existsSync(b.file("project/f"))).toBe(false);
    expect(existsSync(join(b.root, "..", "evil"))).toBe(false);
    expect(stages(b)).toEqual([]);
  });

  it("counts the copy as use while it runs, and as ended after", async () => {
    const { a, stubOf } = pair();
    writeFileSync(a.file("project/f"), "x");
    await runBetween(stubOf, { workspace: "a", path: "f" }, { workspace: "b", path: "g" }, false, () => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(await a.kv.get("lastProxyAt")).toBe(new Date(new FakeClock().now()).toISOString());
  });
});

describe.skipIf(!linux)("cp with this machine", () => {
  const route = (stub: CopyStub, req: Request) => {
    const parts = new URL(req.url).pathname.split("/").filter(Boolean);
    return copyRoute(req, () => stub, parts) as Promise<Response>;
  };

  it("downloads a checked archive and uploads one", async () => {
    const { a, b } = pair();
    mkdirSync(a.file("project/out"));
    writeFileSync(a.file("project/out/r.csv"), "1,2");
    const res = await route(a.stub, new Request("https://w/v1/workspaces/a/files?path=out"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-cf-opencode-kind")).toBe("dir");
    const tar = new Uint8Array(await res.arrayBuffer());
    const local = mkdtempSync(join(tmpdir(), "cp-local-"));
    expect(spawnSync("tar", ["-xf", "-", "-C", local], { input: tar }).status).toBe(0);
    expect(readFileSync(join(local, "data/r.csv"), "utf8")).toBe("1,2");

    const up = await route(
      b.stub,
      new Request("https://w/v1/workspaces/b/files?path=&name=out", {
        method: "PUT",
        body: tar,
        headers: { "content-length": String(tar.byteLength) },
      }),
    );
    expect(await up.json()).toMatchObject({ ok: true, result: { to: "b:/home/user/project/out", files: 1 } });
    expect(readFileSync(b.file("project/out/r.csv"), "utf8")).toBe("1,2");
  });

  it("refuses an upload over 100 MB before it reads the body", async () => {
    const { b } = pair();
    const res = await route(
      b.stub,
      new Request("https://w/v1/workspaces/b/files?path=&name=x", {
        method: "PUT",
        body: "x",
        headers: { "content-length": String(100_000_001) },
      }),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/at most 100.0 MB/);
  });

  it("streams progress lines and one result line for POST /v1/copy", async () => {
    const { a, stubOf } = pair();
    writeFileSync(a.file("project/f"), "x");
    const req = new Request("https://w/v1/copy", {
      method: "POST",
      body: JSON.stringify({ from: { workspace: "a", path: "f" }, to: { workspace: "b", path: "" } }),
    });
    const res = await (copyRoute(req, stubOf, ["v1", "copy"]) as Promise<Response>);
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ ok: true, result: { files: 1 } });
    expect(lines[0]).toHaveProperty("line");
  });
});
