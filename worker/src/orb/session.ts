// WorkspaceSession DO: one per workspace, named `ws:<id>`.
// RPC surface = WorkspaceSessionApi. Ops run in one ExclusiveQueue; callers long-poll getOp.
// Copied in shape from cf-orbs OrbSession (Apache-2.0) and narrowed to OpenCode workspaces.

import { DurableObject } from "cloudflare:workers";
import type { WorkspaceSessionApi } from "../api";
import { passwordMatches, workspacePassword } from "../auth";
import { parseConfig } from "../core/config";
import {
  type Clock,
  type ContainerPort,
  type EgressRoute,
  interceptEgress,
  type KV,
  realClock,
  wrapContainer,
  wrapStorage,
} from "../core/container-port";
import {
  DEFAULT_CONFIG,
  type InstanceSpec,
  JOB_DEADLINE_MS,
  type OpRecord,
  type OpRequest,
  type ProviderConfig,
  type RegistryClient,
  type WorkspaceRecord,
  type WorkspaceStatus,
} from "../core/types";
import type { Env } from "../env";
import { REGISTRY_DO_NAME, workspaceDoName } from "../env";
import { AI_HOST } from "./ai";
import { idleTick, LAST_USE_KEY, runAlarm } from "./alarm";
import { type BrowserSession, openBrowserSession } from "./browse";
import type { OrbContext } from "./context";
import { runDelete } from "./delete";
import { ExclusiveQueue } from "./exclusive";
import {
  appendProgress,
  errText,
  finishOp,
  type Handle,
  handleExpiresAt,
  iso,
  loadOrb,
  markRunning,
  openOp,
  pruneOps,
  getOp as readOp,
  recoverInflight,
  redactLine,
  redactWith,
} from "./journal";
import { runPause } from "./pause";
import { type RebuildTarget, receiveRebuild, runRebuild } from "./rebuild";
import { LOGTAIL_SH, SSH_PREP_SH } from "./scripts";
import { readSessions, type SessionList } from "./sessions";
import { runSpawn, SCRIPT_ENV, sh, WORKSPACE_USER } from "./spawn";
import { bridge, isPublicKey, type StdioProcess, shellParams } from "./terminal";

export interface OpRunners {
  runSpawn(
    ctx: OrbContext,
    req: OpRequest,
  ): Promise<{ ok: boolean; error?: string; source?: unknown; wakeMs?: number }>;
  runPause(ctx: OrbContext, req: OpRequest): Promise<{ ok: boolean; error?: string; handle?: unknown }>;
  runDelete(ctx: OrbContext, req?: OpRequest): Promise<unknown>;
  runRebuild?(ctx: OrbContext): Promise<{ ok: boolean; error?: string }>;
}

export const REAL_OPS: OpRunners = { runSpawn, runPause, runDelete };

export type OrbBase = Omit<OrbContext, "say" | "deadline">;

/** Wakes long-polls when an op changes. In-memory; a restart only costs one poll interval. */
export class OpNotifier {
  private waiters = new Map<string, Set<() => void>>();
  notify(opId: string): void {
    const set = this.waiters.get(opId);
    if (!set) return;
    this.waiters.delete(opId);
    for (const f of set) f();
  }
  next(opId: string): { promise: Promise<void>; cancel: () => void } {
    let f: () => void = () => {};
    const promise = new Promise<void>((r) => {
      f = r;
    });
    let set = this.waiters.get(opId);
    if (!set) {
      set = new Set();
      this.waiters.set(opId, set);
    }
    set.add(f);
    return {
      promise,
      cancel: () => {
        this.waiters.get(opId)?.delete(f);
      },
    };
  }
}

export interface OpRuntime {
  queue: ExclusiveQueue;
  openLock: ExclusiveQueue;
  notifier: OpNotifier;
  log: (line: string) => void;
}

export function newRuntime(log: (line: string) => void = () => {}): OpRuntime {
  return { queue: new ExclusiveQueue(), openLock: new ExclusiveQueue(), notifier: new OpNotifier(), log };
}

const TERMINAL = new Set(["succeeded", "failed"]);
export const isTerminal = (r: OpRecord) => TERMINAL.has(r.phase);

function asFailed(err: string, workspaceId: string): string {
  const line = err.replace(/\s*\n\s*/g, " ").trim() || "unknown error";
  return line.startsWith("Failed:")
    ? line
    : `Failed: ${line} — fix: retry; run cf-opencode logs ${workspaceId}`;
}

export async function runOpWithJournal(
  base: OrbBase,
  kv: KV,
  req: OpRequest,
  ops: OpRunners,
  rt: OpRuntime = newRuntime(),
): Promise<{ opId: string; attached: boolean; done: Promise<OpRecord | undefined> }> {
  const { record, attached } = await rt.openLock.run(() =>
    openOp(kv, base.workspaceId, req, iso(base.clock.now())),
  );
  const opId = record.opId;
  if (attached) {
    rt.log(`${req.op} ${opId}: attached to in-flight op`);
    return { opId, attached, done: Promise.resolve(record) };
  }
  rt.log(`${req.op} ${opId}: queued`);
  rt.notifier.notify(opId);
  const startedMs = Date.parse(record.startedAt);
  const deadline = startedMs + JOB_DEADLINE_MS;

  let chain: Promise<void> = Promise.resolve();
  const append = (line: string, wake: boolean) => {
    const secs = ((base.clock.now() - startedMs) / 1000).toFixed(1);
    const clean = redactWith(req.password, `${secs}s ${line}`);
    rt.log(`${req.op} ${opId}: ${clean}`);
    chain = chain
      .then(() => appendProgress(kv, opId, clean))
      .then(() => {
        if (wake) rt.notifier.notify(opId);
      })
      .catch(() => {});
  };
  const say = (line: string) => append(line, true);
  const ctx: OrbContext = { ...base, say, deadline };

  const work = async (): Promise<OpRecord | undefined> => {
    let phase: "succeeded" | "failed" = "failed";
    let patch: Partial<OpRecord> = {};
    try {
      await markRunning(kv, opId);
      rt.notifier.notify(opId);
      if (req.op === "spawn") {
        const r = await ops.runSpawn(ctx, req);
        if (r.ok) {
          phase = "succeeded";
          patch = { result: { source: r.source, wakeMs: r.wakeMs } };
        } else patch = { error: asFailed(r.error ?? "spawn failed", base.workspaceId) };
      } else if (req.op === "pause") {
        const r = await ops.runPause(ctx, req);
        if (r.ok) {
          phase = "succeeded";
          patch = r.handle === undefined ? {} : { result: { handle: r.handle } };
        } else patch = { error: asFailed(r.error ?? "pause failed", base.workspaceId) };
      } else if (req.op === "rebuild") {
        const r = ops.runRebuild
          ? await ops.runRebuild(ctx)
          : { ok: false, error: "rebuild is not available here" };
        if (r.ok) phase = "succeeded";
        else patch = { error: asFailed(r.error ?? "rebuild failed", base.workspaceId) };
      } else {
        await ops.runDelete(ctx, req);
        phase = "succeeded";
      }
    } catch (e) {
      patch = { error: asFailed(errText(e), base.workspaceId) };
    }
    if (phase === "succeeded") append(`${req.op} done`, false);
    await chain;
    if (patch.error) patch.error = redactWith(req.password, patch.error);
    try {
      await finishOp(kv, opId, phase, { ...patch, finishedAt: iso(base.clock.now()) });
    } catch (e) {
      rt.log(`${req.op} ${opId}: could not record result: ${redactLine(errText(e))}`);
    }
    rt.log(`${req.op} ${opId}: ${phase}${patch.error ? ` ${patch.error}` : ""}`);
    rt.notifier.notify(opId);
    return readOp(kv, opId).catch(() => undefined);
  };

  const done = rt.queue.run(work).catch((e: unknown) => {
    rt.log(`${req.op} ${opId}: runner crashed: ${redactLine(errText(e))}`);
    return undefined;
  });
  return { opId, attached: false, done };
}

export async function waitForOp(
  kv: KV,
  opId: string,
  waitMs: number,
  since: number | undefined,
  clock: Clock,
  notifier: OpNotifier,
): Promise<OpRecord | undefined> {
  let w = notifier.next(opId);
  try {
    let rec = await readOp(kv, opId);
    if (!rec) return undefined;
    const base = since ?? rec.progress.length;
    const until = clock.now() + Math.max(0, Math.min(waitMs, 25_000));
    while (!isTerminal(rec) && rec.progress.length <= base && clock.now() < until) {
      await Promise.race([w.promise, clock.sleep(Math.min(1000, until - clock.now()))]);
      w.cancel();
      w = notifier.next(opId);
      rec = (await readOp(kv, opId)) ?? rec;
    }
    return rec;
  } finally {
    w.cancel();
  }
}

const LOG_RING = 200;
const OP_RETENTION_MS = 24 * 3600_000;

export class WorkspaceSession extends DurableObject<Env> implements WorkspaceSessionApi {
  private readonly kv: KV;
  private config: ProviderConfig = structuredClone(DEFAULT_CONFIG);
  private readonly ring: string[] = [];
  private readonly rt: OpRuntime;
  private workspaceIdCache?: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.kv = wrapStorage(ctx.storage);
    this.rt = newRuntime((line) => this.note(line));
    try {
      this.config = parseConfig(env.CF_OPENCODE_CONFIG);
    } catch (e) {
      this.note(errText(e));
    }
    void ctx.blockConcurrencyWhile(async () => {
      if (ctx.container?.running) {
        await ctx.container
          .setInactivityTimeout(this.config.inactivityTimeoutMinutes * 60_000)
          .catch((e: unknown) => this.note(`setInactivityTimeout failed: ${errText(e)}`));
      }
      const failed = await recoverInflight(this.kv, iso(Date.now()));
      for (const op of failed) this.note(`recovered ${op.op} ${op.opId}: failed after restart`);
      const st = (await loadOrb(this.kv))?.state;
      const live = st === "starting" || st === "awake" || st === "pausing" || st === "warm";
      if (live || ctx.container?.running) await this.arm(this.config.alarmSeconds * 1000);
    });
  }

  private note(line: string): void {
    const clean = redactLine(line);
    this.ring.push(`${iso(Date.now())} ${clean}`);
    if (this.ring.length > LOG_RING) this.ring.shift();
    console.log(clean);
  }

  private async workspaceId(): Promise<string> {
    if (this.workspaceIdCache) return this.workspaceIdCache;
    const rec = await loadOrb(this.kv);
    this.workspaceIdCache = rec?.orbId ?? this.ctx.id.name ?? "unknown";
    if (!this.workspaceIdCache) this.workspaceIdCache = "unknown";
    return this.workspaceIdCache;
  }

  private registry(): RegistryClient {
    return this.env.REGISTRY.getByName(REGISTRY_DO_NAME) as unknown as RegistryClient;
  }

  private base(workspaceId: string): OrbBase {
    const container = this.ctx.container;
    if (!container) {
      throw new Error("Failed: this Durable Object has no container — fix: redeploy with cf-opencode init");
    }
    return {
      workspaceId,
      orbId: workspaceId,
      container: withEgress(this, container),
      kv: this.kv,
      clock: realClock,
      config: this.config,
      registry: this.registry(),
      env: this.env as unknown as Record<string, string | undefined>,
    };
  }

  private async arm(ms: number): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + ms);
  }

  async submitOp(req: OpRequest): Promise<{ opId: string; attached: boolean }> {
    const workspaceId = await this.workspaceIdFrom(req);
    const { opId, attached, done } = await runOpWithJournal(
      this.base(workspaceId),
      this.kv,
      req,
      { ...REAL_OPS, runRebuild: (ctx) => runRebuild(ctx, this.rebuildTarget(workspaceId)) },
      this.rt,
    );
    this.ctx.waitUntil(done.then(() => this.arm(this.config.alarmSeconds * 1000)));
    return { opId, attached };
  }

  /** A spawn of a brand-new workspace has no record yet; the id travels in the op id prefix after open. */
  private async workspaceIdFrom(req: OpRequest): Promise<string> {
    const existing = await loadOrb(this.kv);
    if (existing?.orbId) {
      this.workspaceIdCache = existing.orbId;
      return existing.orbId;
    }
    const name = this.ctx.id.name;
    if (name) {
      this.workspaceIdCache = name.replace(/^ws:/, "");
      return this.workspaceIdCache;
    }
    return req.snapshotId ?? "unknown";
  }

  async getOp(opId: string, waitMs: number, since?: number): Promise<OpRecord | null> {
    const rec = await waitForOp(this.kv, opId, waitMs, since, realClock, this.rt.notifier);
    return rec ?? null;
  }

  async status(): Promise<WorkspaceStatus> {
    const rec = await loadOrb(this.kv);
    const workspace =
      rec ??
      ({
        v: 1,
        workspaceId: await this.workspaceId(),
        orbId: await this.workspaceId(),
        state: "none",
        imageKey: "orb",
        instance: this.config.instance,
        updatedAt: iso(Date.now()),
      } as const);
    const inflight = await this.kv.list<OpRecord>("op:");
    let inFlightOp: WorkspaceStatus["inFlightOp"];
    for (const op of inflight.values()) {
      if (op.phase === "queued" || op.phase === "running") {
        inFlightOp = { opId: op.opId, op: op.op, phase: op.phase, startedAt: op.startedAt };
        break;
      }
    }
    return {
      workspace: { ...workspace, workspaceId: workspace.orbId },
      containerRunning: Boolean(this.ctx.container?.running),
      ...(inFlightOp ? { inFlightOp } : {}),
      ...(rec?.handle ? { snapshotExpiresAt: iso(handleExpiresAt(rec.handle as Handle)) } : {}),
      ...imageCurrent(rec, this.ctx.container),
    };
  }

  /** OpenCode sessions: live from a running workspace, else the list kept at the last pause. Wakes nothing. */
  async sessions(): Promise<SessionList> {
    return readSessions(this.base(await this.workspaceId()));
  }

  async logs(lines: number): Promise<{ containerRunning: boolean; log: string }> {
    const running = Boolean(this.ctx.container?.running);
    const head = this.ring.slice(-lines).join("\n");
    if (!running || !this.ctx.container) return { containerRunning: running, log: head };
    try {
      const port = wrapContainer(this.ctx.container);
      const [cmd, opts] = sh(LOGTAIL_SH, { LINES: String(lines) });
      const r = await port.exec(cmd, { ...opts, timeoutMs: 15_000 });
      return { containerRunning: true, log: [head, r.stdout].filter(Boolean).join("\n") };
    } catch (e) {
      return { containerRunning: true, log: `${head}\n(log tail failed: ${errText(e)})` };
    }
  }

  /**
   * The one password check for /oc, /browse, /shell and /ssh. Constant time, against the
   * hash the last control-plane spawn stored. A wrong password never wakes a paused
   * workspace: before this check, any password could wake one and become its password.
   * Then wakes a stopped workspace with the (now verified) password.
   */
  private async admit(password: string | null): Promise<Response | null> {
    const rec = await loadOrb(this.kv);
    if (rec?.deletedAt)
      return jsonError(410, "workspace deleted", "start a new workspace with cf-opencode connect");
    if (!(await passwordMatches(rec?.passwordSha, password))) {
      // JSON: OpenCode 2's client reads a plain-text 401 as "not a compatible server".
      return new Response(JSON.stringify({ _tag: "UnauthorizedError", message: "Authentication required" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": `Basic realm="cf-opencode ${await this.workspaceId()}"`,
        },
      });
    }
    if (this.ctx.container?.running) return null;
    const { done } = await runOpWithJournal(
      this.base(await this.workspaceId()),
      this.kv,
      { op: "spawn", password: password as string, directory: rec?.directory },
      REAL_OPS,
      this.rt,
    );
    const result = await done;
    this.ctx.waitUntil(this.arm(this.config.alarmSeconds * 1000));
    if (result?.phase !== "succeeded") {
      return jsonError(
        503,
        (result?.error ?? "wake failed").replace(/^Failed: /, "").replace(/ — fix: .*$/, ""),
        `cf-opencode logs ${await this.workspaceId()}`,
      );
    }
    return null;
  }

  /** Record use for the idle pause. At most one storage write per 30 s from a busy terminal. */
  private lastTouch = 0;
  private touch(): void {
    const now = Date.now();
    if (now - this.lastTouch < 30_000) return;
    this.lastTouch = now;
    this.ctx.waitUntil(this.kv.put(LAST_USE_KEY, iso(now)).catch(() => undefined));
  }

  /** Proxy one request to opencode serve, after the password check. Wakes a paused workspace first. */
  async proxy(req: Request): Promise<Response> {
    const password = req.headers.get("x-cf-opencode-password");
    const denied = await this.admit(password);
    if (denied) return denied;
    await this.kv.put(LAST_USE_KEY, iso(Date.now()));
    const container = this.ctx.container;
    if (!container) return new Response("no container\n", { status: 503 });
    const headers = new Headers(req.headers);
    headers.delete("x-cf-opencode-password");
    headers.delete("host");
    const forwarded = new Request(req.url, {
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
    });
    return wrapContainer(container).running
      ? containerFetch(this, forwarded)
      : new Response("container stopped during wake\n", { status: 503 });
  }

  /** The Durable Object that boots the current image for a rebuild of this workspace. */
  private rebuildTarget(workspaceId: string): RebuildTarget {
    const stub = this.env.WORKSPACE.getByName(`${workspaceDoName(workspaceId)}~rebuild`) as unknown as {
      rebuildReceive: RebuildTarget["receive"];
    };
    return { receive: (tar, o) => stub.rebuildReceive(tar, o) };
  }

  /** Rebuild target side. Only the workspace's own Durable Object calls this, over RPC. */
  async rebuildReceive(
    tar: ReadableStream<Uint8Array>,
    o: { workspaceId: string; instance: InstanceSpec },
  ): ReturnType<RebuildTarget["receive"]> {
    const id = `${o.workspaceId}~rebuild`;
    const ctx: OrbContext = {
      ...this.base(id),
      say: (l) => this.note(l),
      deadline: Date.now() + JOB_DEADLINE_MS,
    };
    return this.rt.queue.run(() => receiveRebuild(ctx, tar, o.instance));
  }

  async authorize(password: string): Promise<boolean> {
    const rec = await loadOrb(this.kv);
    return !rec?.deletedAt && (await passwordMatches(rec?.passwordSha, password));
  }

  /**
   * Open a browser session on the account's Browser Run. The password is checked
   * by the Worker before this runs. The binding needs no token.
   */
  async browse(
    password: string,
    keepAliveMs?: number,
  ): Promise<{ ok: true; session: BrowserSession } | { ok: false; error: string; status: number }> {
    const rec = await loadOrb(this.kv);
    if (rec?.deletedAt || !(await passwordMatches(rec?.passwordSha, password))) {
      return {
        ok: false,
        error: "Failed: wrong workspace password — fix: cf-opencode connect, then retry",
        status: 401,
      };
    }
    const opened = await openBrowserSession(this.env.BROWSER, keepAliveMs);
    if ("error" in opened) return { ok: false, error: opened.error, status: opened.status };
    return { ok: true, session: opened };
  }

  /**
   * Websocket terminals. /shell runs tmux on a PTY as the workspace user; /ssh runs `sshd -i`
   * as root, which logs the user in with a key from authorized_keys. The Worker routes here
   * with the password in x-cf-opencode-password; admit() checks it.
   */
  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const kind = url.pathname === "/shell" ? "shell" : url.pathname === "/ssh" ? "ssh" : undefined;
    if (!kind) return jsonError(404, `no route ${url.pathname}`, "use /shell or /ssh");
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonError(
        426,
        `${kind} needs a websocket upgrade`,
        `use cf-opencode ${kind === "ssh" ? "ssh" : "shell"}`,
      );
    }
    const params = kind === "shell" ? shellParams(url) : undefined;
    if (params && "error" in params) return jsonError(400, params.error, "check the query string");
    const key = req.headers.get("x-cf-opencode-ssh-key");
    if (kind === "ssh" && key !== null && !isPublicKey(key)) {
      return jsonError(
        400,
        "x-cf-opencode-ssh-key is not one OpenSSH public key line",
        "send the .pub file's single line",
      );
    }
    const denied = await this.admit(req.headers.get("x-cf-opencode-password"));
    if (denied) return denied;
    const container = this.ctx.container;
    if (!container?.running) return jsonError(503, "container stopped during wake", "retry");
    const directory = (await loadOrb(this.kv))?.directory ?? "/home/user/project";

    let proc: StdioProcess;
    try {
      if (params && !("error" in params)) {
        // -A attaches when the session exists. The tmux server forks away from this exec,
        // so killing the client on disconnect leaves the session and its programs running.
        proc = await container.exec(["tmux", "new-session", "-A", "-s", params.session], {
          user: WORKSPACE_USER,
          cwd: directory,
          env: { ...SCRIPT_ENV, SHELL: "/bin/bash", TERM: "xterm-256color" },
          pty: { cols: params.cols, rows: params.rows },
          stdin: "pipe",
          stdout: "pipe",
        });
      } else {
        const [cmd, opts] = sh(SSH_PREP_SH, key ? { AUTHORIZED_KEY: key } : {});
        const prep = await wrapContainer(container).exec(cmd, { ...opts, user: "0:0", timeoutMs: 30_000 });
        if (prep.exitCode !== 0) {
          return jsonError(
            500,
            `sshd setup failed: ${redactLine(prep.stderr.trim() || prep.stdout.trim()).slice(0, 200)}`,
            "rebuild the image with cf-opencode init",
          );
        }
        proc = await container.exec(["/usr/sbin/sshd", "-i", "-e"], {
          user: "0:0",
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        });
      }
    } catch (e) {
      return jsonError(
        500,
        `${kind} did not start: ${errText(e)}`,
        `cf-opencode logs ${await this.workspaceId()}`,
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.touch();
    this.note(`${kind} opened`);
    this.ctx.waitUntil(
      bridge(server, proc, { control: kind === "shell", onActivity: () => this.touch() }).then(() =>
        this.note(`${kind} closed`),
      ),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    const workspaceId = await this.workspaceId();
    const ctx: OrbContext = {
      ...this.base(workspaceId),
      say: (l) => this.note(l),
      deadline: Date.now() + 60_000,
    };
    await this.rt.queue.run(async () => {
      // The Worker derives the password, so it can ask opencode whether an agent is working. A workspace
      // started with a password from before derivation answers "unknown" until its next connect.
      const password = this.env.CONTROL_TOKEN
        ? await workspacePassword(this.env.CONTROL_TOKEN, workspaceId)
        : undefined;
      await idleTick(ctx, password);
      const { rearmInMs } = await runAlarm(ctx);
      if (rearmInMs !== null) await this.arm(rearmInMs);
    });
    await pruneOps(this.kv, iso(Date.now() - OP_RETENTION_MS)).catch(() => undefined);
  }
}

/** Whether the workspace's disk came from the deployed image. Unknown (omitted) for disks from before imageRef. */
function imageCurrent(
  rec: WorkspaceRecord | undefined,
  container: Container | undefined,
): { imageCurrent?: boolean } {
  const ref = container?.running ? rec?.imageRef : (rec?.handle?.imageRef ?? rec?.imageRef);
  if (!rec || !ref) return {};
  try {
    const deployed = container?.images?.[rec.imageKey || "orb"];
    return deployed ? { imageCurrent: deployed === ref } : {};
  } catch {
    return {};
  }
}

function jsonError(status: number, cause: string, fix: string): Response {
  return new Response(JSON.stringify({ error: `Failed: ${cause} — fix: ${fix}` }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The real container plus egress. Tests use the wrapper alone; they never call intercept. */
function withEgress(session: WorkspaceSession, container: Container): ContainerPort {
  // Assign rather than spread: a spread would freeze the `running` getter at its current value.
  const port = wrapContainer(container);
  port.intercept = (routes: EgressRoute[]) => {
    const exports = (
      session as unknown as {
        ctx: { exports: { ProviderEgress(opts: { props: { routes: EgressRoute[] } }): Fetcher } };
      }
    ).ctx.exports;
    return interceptEgress(container, routes, exports.ProviderEgress({ props: { routes } }));
  };
  port.interceptAi = (gateway: string) => {
    const exports = (
      session as unknown as {
        ctx: { exports: { AiEgress(opts: { props: { gateway: string } }): Fetcher } };
      }
    ).ctx.exports;
    return container.interceptOutboundHttp(AI_HOST, exports.AiEgress({ props: { gateway } }));
  };
  return port;
}

/** container.fetch lives on the raw Container, which wrapContainer does not expose. */
function containerFetch(session: WorkspaceSession, req: Request): Promise<Response> {
  const container = (session as unknown as { ctx: DurableObjectState }).ctx.container;
  if (!container) return Promise.resolve(new Response("no container\n", { status: 503 }));
  const port = (
    container as unknown as { getTcpPort(p: number): { fetch(r: Request): Promise<Response> } }
  ).getTcpPort(4096);
  return port.fetch(req);
}
