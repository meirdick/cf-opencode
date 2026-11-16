// Two stand-in workspaces for cp tests: the real scripts and GNU tar run against temp folders that stand in for
// each workspace's /home/user. Only the container is replaced.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { CopyStub } from "../src/copy-api";
import type { ContainerPort, ExecOptions } from "../src/core/container-port";
import type { OrbRecord } from "../src/core/types";
import {
  type CopyDeps,
  copyAbort,
  copyCommit,
  copyIn,
  copyOut,
  copyPrepare,
  copyStat,
  HOME,
  type PendingCopy,
} from "../src/orb/copy";
import { FakeClock, MemoryKV } from "./fake-container";

export const linux =
  process.platform === "linux" && spawnSync("tar", ["--version"]).stdout?.toString().includes("GNU");

/** Runs commands on this machine, with /home/user mapped to a temp folder. */
export class LocalContainer {
  running = true;
  constructor(readonly root: string) {}
  private map = (cmd: string[]) => cmd.map((a, i) => (i < 3 ? a : a.replaceAll(HOME, this.root)));
  private back = (s: string) => s.replaceAll(this.root, HOME);
  async exec(cmd: string[], _o: ExecOptions = {}) {
    const [bin, ...args] = this.map(cmd);
    const r = spawnSync(bin as string, args, { maxBuffer: 1e8 });
    return {
      exitCode: r.status ?? -1,
      stdout: this.back(r.stdout.toString("latin1")),
      stderr: r.stderr.toString(),
      pid: 1,
      durationMs: 1,
    };
  }
  async execStream(cmd: string[], o: { user?: string; stdin?: ReadableStream<Uint8Array> } = {}) {
    const [bin, ...args] = this.map(cmd);
    const p = spawn(bin as string, args, { stdio: [o.stdin ? "pipe" : "ignore", "pipe", "ignore"] });
    if (o.stdin && p.stdin) void o.stdin.pipeTo(Writable.toWeb(p.stdin)).catch(() => p.stdin?.destroy());
    const exitCode = new Promise<number>((r) => p.on("close", (code) => r(code ?? -1)));
    return { stdout: Readable.toWeb(p.stdout) as unknown as ReadableStream<Uint8Array>, exitCode };
  }
}

/** One workspace: a temp /home/user with a checkout, wired as session.ts wires the Durable Object. */
export function workspace(id: string) {
  const root = mkdtempSync(join(tmpdir(), `cp-${id}-`));
  mkdirSync(join(root, "project"), { recursive: true });
  const kv = new MemoryKV();
  const d: CopyDeps = {
    workspaceId: id,
    container: new LocalContainer(root) as unknown as ContainerPort,
    kv,
    clock: new FakeClock(),
    record: async () => ({ directory: `${HOME}/project`, state: "awake" }) as OrbRecord,
    wake: async () => undefined,
  };
  const copies = new Map<string, PendingCopy>();
  const stub: CopyStub = {
    status: async () => ({ workspace: { state: "awake" } as OrbRecord, containerRunning: true }) as never,
    copyStat: (p) => copyStat(d, p),
    copyOut: (p) => copyOut(d, p),
    copyPrepare: async (o) => {
      const r = await copyPrepare(d, o);
      if (!r.ok) return r;
      const token = crypto.randomUUID();
      copies.set(token, r.pending);
      return { ok: true, token, target: r.target };
    },
    copyIn: (t, tar) => copyIn(d, copies.get(t) as PendingCopy, tar),
    copyCommit: (t) => copyCommit(d, copies.get(t) as PendingCopy),
    copyAbort: (t) => copyAbort(d, copies.get(t) as PendingCopy),
  };
  return { id, root, stub, kv, file: (p: string) => join(root, p) };
}

export function pair() {
  const a = workspace("a");
  const b = workspace("b");
  const stubOf = (id: string) => (id === "a" ? a.stub : b.stub);
  return { a, b, stubOf };
}

export const stages = (w: { root: string }) => {
  const dir = join(w.root, ".cache/cf-opencode/cp");
  return existsSync(dir) ? readdirSync(dir) : [];
};
