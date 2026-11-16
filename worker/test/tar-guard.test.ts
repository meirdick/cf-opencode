import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CopyRefused, FAILED_MARK, guardTar, ROOT_NAME } from "../src/core/tar-guard";

const hasTar = spawnSync("tar", ["--version"]).status === 0;

function streamOf(...parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) if (p.byteLength) c.enqueue(p);
      c.close();
    },
  });
}

/** Split into small chunks, to test reads across chunk edges. */
function chunked(b: Uint8Array, size = 77): ReadableStream<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < b.length; i += size) parts.push(b.slice(i, i + size));
  return streamOf(...parts);
}

async function bytes(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** A hand-made ustar entry, for archives a real tar would not write. */
function entry(name: string, type: string, data = "", link = ""): Uint8Array {
  const h = new Uint8Array(512);
  const enc = new TextEncoder();
  const put = (s: string, at: number) => h.set(enc.encode(s), at);
  put(name, 0);
  put("0000644", 100);
  put("0001750", 108);
  put("0001750", 116);
  put(data.length.toString(8).padStart(11, "0"), 124);
  put("00000000000", 136);
  put("        ", 148);
  put(type, 156);
  put(link, 157);
  put("ustar\u000000", 257);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const body = new Uint8Array(Math.ceil(data.length / 512) * 512);
  body.set(enc.encode(data));
  return concat(h, body);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const END = new Uint8Array(1024);

async function refusal(archive: Uint8Array, maxBytes = 1e9): Promise<string> {
  const g = guardTar(chunked(archive), { maxBytes });
  await expect(bytes(g.stream)).rejects.toBeInstanceOf(CopyRefused);
  const e = await g.done.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(CopyRefused);
  return (e as Error).message;
}

describe("guardTar", () => {
  it("renames the root and keeps files, directories and inner links", async () => {
    const archive = concat(
      entry("export/", "5"),
      entry("export/a.txt", "0", "hello"),
      entry("export/sub/", "5"),
      entry("export/sub/b.txt", "0", "x".repeat(1500)),
      entry("export/sub/link", "2", "", "b.txt"),
      entry("export/hard", "1", "", "export/a.txt"),
      END,
    );
    const g = guardTar(chunked(archive), { maxBytes: 1e6 });
    const out = await bytes(g.stream);
    expect(await g.done).toEqual({ bytes: 1505, files: 2, dirs: 2, links: 2 });
    expect(out.length % 512).toBe(0);
    const text = new TextDecoder("latin1").decode(out);
    expect(text).toContain(`${ROOT_NAME}/sub/b.txt`);
    expect(text).not.toContain("export");
  });

  it.each([
    ["an absolute name", entry("/etc/passwd", "0", "x")],
    ["a .. name", entry("export/../../.bashrc", "0", "x")],
    ["a second root", concat(entry("export/", "5"), entry("other/x", "0", "x"))],
    ["a symlink that climbs", concat(entry("export/", "5"), entry("export/l", "2", "", "../../etc"))],
    ["an absolute symlink", concat(entry("export/", "5"), entry("export/l", "2", "", "/etc"))],
    ["a root that is a symlink", entry("export", "2", "", "real")],
    ["a hard link out of the tree", concat(entry("export/", "5"), entry("export/h", "1", "", "etc/passwd"))],
    ["a device", concat(entry("export/", "5"), entry("export/null", "3"))],
    ["a fifo", concat(entry("export/", "5"), entry("export/p", "6"))],
  ])("refuses %s", async (_what, archive) => {
    expect(await refusal(concat(archive, END))).toBeTruthy();
  });

  it("refuses a pax path that leaves the tree, even when the ustar name is fine", async () => {
    const rec = " path=export/../../x\n";
    const len = rec.length + 2;
    const archive = concat(
      entry("export/", "5"),
      entry("PaxHeader", "x", `${len}${rec}`),
      entry("export/fine", "0", "x"),
      END,
    );
    expect(await refusal(archive)).toMatch(/leaves the copied tree/);
  });

  it("stops at the size limit", async () => {
    const archive = concat(entry("big", "0", "y".repeat(3000)), END);
    expect(await refusal(archive, 2000)).toMatch(/larger than/);
  });

  it("fails on a bad checksum, an early end and an empty stream", async () => {
    const bad = entry("export", "0", "x");
    bad[0] = 0x45;
    expect(await refusal(concat(bad, END))).toMatch(/checksum/);
    expect(await refusal(entry("export", "0", "x".repeat(2000)).slice(0, 1024))).toMatch(/ended early/);
    expect(await refusal(new Uint8Array(0))).toMatch(/no archive/);
  });

  it("fails when the source tar reported an error after the archive", async () => {
    const mark = new TextEncoder().encode(`${FAILED_MARK} 2\n`);
    const archive = concat(entry("export", "0", "x"), END, new Uint8Array(8192), mark);
    expect(await refusal(archive)).toMatch(/exited 2/);
    expect(await refusal(mark)).toMatch(/exited 2/);
  });

  it.skipIf(!hasTar)("passes a real GNU tar archive that tar extracts again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-"));
    const src = join(dir, "src", "export");
    mkdirSync(join(src, "deep", "er"), { recursive: true });
    const long = `${"n".repeat(120)}.txt`;
    writeFileSync(join(src, "deep", "er", long), "long name");
    writeFileSync(join(src, "run.sh"), "#!/bin/sh\n", { mode: 0o4755 });
    writeFileSync(join(src, "blob"), Buffer.alloc(200_000, 7));
    symlinkSync("deep/er", join(src, "short"));
    for (const format of ["gnu", "posix"]) {
      const tar = spawnSync("tar", [`--format=${format}`, "-cf", "-", "-C", join(dir, "src"), "export"], {
        maxBuffer: 1e8,
      });
      expect(tar.status).toBe(0);
      const g = guardTar(chunked(new Uint8Array(tar.stdout), 4096), { maxBytes: 1e9 });
      const out = await bytes(g.stream);
      const stats = await g.done;
      expect(stats.files).toBe(3);
      const dest = join(dir, `out-${format}`);
      mkdirSync(dest);
      const x = spawnSync("tar", ["-xf", "-", "-C", dest], { input: out });
      expect(x.status, x.stderr.toString()).toBe(0);
      expect(readFileSync(join(dest, ROOT_NAME, "deep", "er", long), "utf8")).toBe("long name");
      expect(readFileSync(join(dest, ROOT_NAME, "blob")).length).toBe(200_000);
      expect(readlinkSync(join(dest, ROOT_NAME, "short"))).toBe("deep/er");
      // setuid is gone; the execute bit stays.
      expect(statSync(join(dest, ROOT_NAME, "run.sh")).mode & 0o7777).toBe(0o755);
    }
  });
});
