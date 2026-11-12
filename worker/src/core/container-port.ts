// Narrow interface over ctx.container so core logic is unit-testable with a fake.
// Semantics (verified 2026-10-30 against the live API):
// - start() is synchronous and returns before the container is ready; it throws Error if already running,
//   TypeError if both image and snapshot are given, or neither.
// - a missing snapshot surfaces asynchronously: monitor() rejects with `Snapshot "<id>" was not found.` and
//   running becomes false. Readiness = first successful exec(["true"]).
// - exec does not inherit start() env or image env; only PATH, HOME and a few shell vars exist. Default user
//   is the image user (uid 1000). user must be numeric "uid:gid".
// - snapshot() throws if the container is not running. size is the delta since the previous snapshot.
import type { InstanceSpec } from "./types";

export interface StartOptions {
  source: { image: string } | { snapshotId: string };
  instance: InstanceSpec;
  enableInternet: boolean;
  labels?: Record<string, string>;
}

/**
 * One outbound host whose requests the Worker rewrites. The container sees a placeholder
 * credential; the Worker swaps in the real one. Other hosts are unaffected unless the
 * install set lockdown, which disables general internet.
 */
export interface EgressRoute {
  /** Hostname the container calls, such as api.anthropic.com. */
  host: string;
  /** Header the Worker sets. The container's copy of this header is dropped. */
  header: string;
  /** Name of the Worker secret holding the real value. */
  secret: string;
  /** Send `Basic base64(<basicUser>:<secret>)` instead of a bearer token. Git over HTTPS wants this. */
  basicUser?: string;
  /**
   * Container env var that gets the placeholder, so a client sends some credential for the Worker to replace.
   * Default: the secret's name. "" sets none.
   */
  env?: string;
}

export interface ExecOptions {
  env?: Record<string, string>;
  /** numeric "uid:gid" */
  user?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  pid: number;
  durationMs: number;
}

/** A process whose stdin and stdout are streams, for moving a disk's files between containers. */
export interface StreamProcess {
  stdout: ReadableStream<Uint8Array>;
  exitCode: Promise<number>;
}

export interface ContainerPort {
  readonly running: boolean;
  images(): Record<string, string>;
  start(opts: StartOptions): void;
  /** Resolves when the container exits normally; rejects on failure (including snapshot not found) or destroy(reason). */
  monitor(): Promise<void>;
  /** Run to completion, output decoded. stdout/stderr truncated to 1 MiB each. */
  exec(cmd: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** Start and return without waiting; stdout/stderr ignored. */
  execDetached(cmd: string[], opts?: ExecOptions): Promise<{ pid: number }>;
  /** Run with stdout as a stream, and stdin fed from `stdin` when given. */
  execStream(
    cmd: string[],
    opts?: { user?: string; stdin?: ReadableStream<Uint8Array> },
  ): Promise<StreamProcess>;
  snapshot(name: string): Promise<{ id: string; size: number }>;
  destroy(): Promise<void>;
  inspect(): Promise<{ image: string; labels: Record<string, string> } | null>;
  setInactivityTimeout(ms: number): Promise<void>;
  /**
   * Route outbound HTTPS for these hosts through the Worker. Other hosts keep whatever
   * enableInternet allowed. Called after start(), before the first exec.
   */
  intercept?(routes: EgressRoute[]): Promise<void>;
  /** Route AI_HOST to the Worker's AI binding through this gateway. Safe to call again. */
  interceptAi?(gateway: string): Promise<void>;
}

/** Minimal KV over DurableObjectStorage so tests can use a Map. */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(prefix: string): Promise<Map<string, T>>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Wrap the real DO container. Kept tiny; all logic lives behind the interface. */
export function wrapContainer(c: Container): ContainerPort {
  const td = new TextDecoder();
  const cap = (s: string) => (s.length > 1_048_576 ? `${s.slice(0, 1_048_576)}\n[truncated]` : s);
  return {
    get running() {
      return c.running;
    },
    images: () => c.images,
    start(o) {
      const base: any = { enableInternet: o.enableInternet, instance: o.instance, labels: o.labels };
      if ("image" in o.source) base.image = o.source.image;
      else base.containerSnapshot = { id: o.source.snapshotId };
      c.start(base);
    },
    monitor: () => c.monitor(),
    async exec(cmd, o = {}) {
      const t0 = Date.now();
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), o.timeoutMs ?? 120_000);
      try {
        const p = await c.exec(cmd, {
          env: o.env,
          user: o.user,
          cwd: o.cwd,
          signal: ac.signal,
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = await p.output();
        return {
          exitCode: out.exitCode,
          stdout: cap(td.decode(out.stdout)),
          stderr: cap(td.decode(out.stderr)),
          pid: p.pid,
          durationMs: Date.now() - t0,
        };
      } finally {
        clearTimeout(t);
      }
    },
    async execDetached(cmd, o = {}) {
      const p = await c.exec(cmd, {
        env: o.env,
        user: o.user,
        cwd: o.cwd,
        stdout: "ignore",
        stderr: "ignore",
      });
      return { pid: p.pid };
    },
    async execStream(cmd, o = {}) {
      const p = (await c.exec(cmd, {
        user: o.user,
        stdin: o.stdin ? "pipe" : undefined,
        stdout: "pipe",
        stderr: "ignore",
      } as never)) as unknown as {
        stdin: WritableStream<Uint8Array> | null;
        stdout: ReadableStream<Uint8Array>;
        exitCode: Promise<number>;
        output?: unknown;
      };
      if (o.stdin && p.stdin) void o.stdin.pipeTo(p.stdin).catch(() => undefined);
      return { stdout: p.stdout, exitCode: p.exitCode };
    },
    async snapshot(name) {
      const s = await c.snapshotContainer({ name });
      return { id: s.id, size: s.size };
    },
    destroy: () => c.destroy(),
    inspect: () => c.inspect() as Promise<{ image: string; labels: Record<string, string> } | null>,
    setInactivityTimeout: (ms) => c.setInactivityTimeout(ms),
  };
}

/**
 * Install egress on the real container. `binding` is the WorkerEntrypoint the platform
 * calls for each intercepted request; it reads the routes from its own props.
 */
export async function interceptEgress(c: Container, routes: EgressRoute[], binding: Fetcher): Promise<void> {
  for (const route of routes) {
    await c.interceptOutboundHttps(route.host, binding);
  }
}

export function wrapStorage(s: DurableObjectStorage): KV {
  return {
    get: (k) => s.get(k) as any,
    put: (k, v) => s.put(k, v),
    delete: (k) => s.delete(k),
    list: async (prefix) => (await s.list({ prefix })) as any,
  };
}
