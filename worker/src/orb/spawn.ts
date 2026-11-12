// Spawn op. Order: tombstone → run slot → start (or reuse) → readiness → prepare repo → opencode serve → health.
// A warm workspace reuses its running server: no restart, no password change.
import type { ExecOptions } from "../core/container-port";
import type {
  OpRequest,
  ProjectSnapshotMapping,
  ProviderConfig,
  SpawnEntry,
  WakeSource,
  WorkspaceRecord,
} from "../core/types";
import { DEFAULT_DIRECTORY, OPENCODE_USERNAME, SPAWN_HISTORY } from "../core/types";
import { opencodeConfig } from "./ai";
import type { OrbContext } from "./context";
import { activeRoutes, PLACEHOLDER, providerEnv } from "./egress";
import {
  errText,
  type Handle,
  handleExpiresAt,
  iso,
  loadWorkspace,
  newWorkspaceRecord,
  redactWith,
  saveWorkspace,
  tokenSha,
} from "./journal";
import { HEALTH_SH, PREPARE_SH, SERVE_SH, STATUS_SH, TRUST_CA_SH } from "./scripts";

export type SpawnResult =
  | { ok: true; source: WorkspaceRecord["lastWakeSource"]; wakeMs: number }
  | { ok: false; error: string };

export const NOT_FOUND = /Snapshot ".*" was not found/;
export const READY_CAP_MS = 90_000;
export const HEALTH_CAP_MS = 90_000;
export const SAFETY_MS = 10_000;

/** Env for every script exec. exec does not inherit image env, only PATH and a few shell vars. */
// NODE_EXTRA_CA_CERTS: Bun and Node keep their own CA list; point them at the system store,
// which holds the platform egress CA when provider hosts are intercepted.
export const SCRIPT_ENV = {
  HOME: "/home/user",
  USER: "user",
  LANG: "C.UTF-8",
  NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt",
} as const;

/**
 * Everything in the workspace runs as `user`: opencode serve, the repo clone, the shell and
 * the SSH login. One owner for /home/user means a file the agent wrote is a file the shell can
 * edit. The image runs as root only to trust the egress CA; `user` has passwordless sudo.
 */
export const WORKSPACE_USER = "1000:1000";

export function sh(script: string, env: Record<string, string> = {}): [string[], ExecOptions] {
  return [["bash", "-c", script], { env: { ...SCRIPT_ENV, ...env }, user: WORKSPACE_USER }];
}

export const deadlineError = (workspaceId: string) =>
  `Failed: spawn did not finish in 4 min 30 s — fix: retry; check cf-opencode status ${workspaceId}`;

type Plan =
  | { kind: "image"; imageKey: string; why: string }
  | { kind: "per-workspace"; handle: Handle }
  | { kind: "project"; snapshotId: string; handle: Handle; mapping: ProjectSnapshotMapping };

export type Ready =
  | { kind: "ready"; ms: number }
  | { kind: "not-found"; msg: string }
  | { kind: "timeout"; byDeadline: boolean }
  | { kind: "error"; msg: string };

/** What spawnOnce learned, for the spawn history entry. */
interface SpawnTrace {
  source?: WakeSource;
  ms?: number;
}

export async function runSpawn(ctx: OrbContext, req: OpRequest): Promise<SpawnResult> {
  const t0 = ctx.clock.now();
  const trace: SpawnTrace = {};
  const r = await spawnOnce(ctx, req, trace);
  const entry: SpawnEntry = { at: iso(t0), ms: trace.ms ?? ctx.clock.now() - t0, ok: r.ok };
  const source = r.ok ? r.source : trace.source;
  if (source) entry.source = source;
  if (!r.ok) entry.error = r.error.replace(/\s*\n\s*/g, " ").slice(0, 200);
  await recordSpawn(ctx, entry).catch(() => undefined);
  return r;
}

async function recordSpawn(ctx: OrbContext, entry: SpawnEntry): Promise<void> {
  const rec = await loadWorkspace(ctx.kv);
  if (!rec || rec.deletedAt) return;
  rec.spawns = [...(rec.spawns ?? []), entry].slice(-SPAWN_HISTORY);
  await saveWorkspace(ctx.kv, rec, iso(ctx.clock.now()));
}

async function spawnOnce(ctx: OrbContext, req: OpRequest, trace: SpawnTrace): Promise<SpawnResult> {
  const { container, clock, kv, registry, workspaceId } = ctx;
  const password = req.password ?? "";
  const say = (s: string) => ctx.say(redactWith(password, s));
  const t0 = clock.now();
  const now = () => iso(clock.now());
  const left = () => ctx.deadline - clock.now() - SAFETY_MS;
  let slotHeld = false;

  const fail = (error: string): SpawnResult => ({ ok: false, error: redactWith(password, error) });
  // True once this spawn booted a container from the bare image: its disk holds nothing yet.
  let freshBoot = false;
  // A spawn that fails after such a boot (a clone that needs a token, a server that does not start)
  // would leave an empty container running and billed, in no list. Stop it; the next connect boots again.
  const failStarted = async (error: string): Promise<SpawnResult> => {
    if (freshBoot && rec) {
      try {
        if (container.running) await container.destroy();
        await registry.releaseRunSlot(workspaceId).catch(() => undefined);
        rec.state = "none";
        rec.awakeSince = undefined;
        await saveWorkspace(kv, rec, now());
        say("stopped the new container; its disk held nothing yet");
      } catch (e) {
        say(`could not stop the new container: ${errText(e)}`);
      }
    }
    return fail(error);
  };

  if (!password) {
    return fail(
      "Failed: spawn has no server password — fix: run cf-opencode connect again; it mints a password",
    );
  }

  let rec = await loadWorkspace(kv);
  if (rec?.deletedAt) {
    // A workspace id is the checkout's name, so `connect` after `delete` asks for the same id.
    // Only the control plane reaches a spawn (the password paths answer 410 for a deleted
    // workspace), so this is the user starting again: a new workspace, none of the old record.
    say(`workspace was deleted at ${rec.deletedAt}; starting a new one`);
    rec = undefined;
  }
  rec ??= newWorkspaceRecord(workspaceId, ctx.config, now());
  const directory = req.directory || rec.directory || DEFAULT_DIRECTORY;

  try {
    let source: NonNullable<WorkspaceRecord["lastWakeSource"]>;
    let wakeMs = 0;

    if (container.running && rec.state === "warm") {
      const w = await reuseServer(ctx);
      if (w.ok) {
        say(`warm workspace: opencode still running (pid ${w.pid})`);
        trace.source = "warm";
        await Promise.all([
          container.setInactivityTimeout(ctx.config.inactivityTimeoutMinutes * 60_000),
          beat(ctx),
        ]);
        const ts = now();
        rec.state = "awake";
        rec.warmUntil = undefined;
        rec.awakeSince ??= ts;
        rec.lastWakeSource = "warm";
        rec.directory = directory;
        rec.dirtySince ??= ts;
        rec.lastSpawnMs = clock.now() - t0;
        trace.ms = rec.lastSpawnMs;
        await saveWorkspace(kv, rec, ts);
        say(
          `workspace ready: kept running since the pause; spawn took ${(rec.lastSpawnMs / 1000).toFixed(1)} s`,
        );
        return { ok: true, source: "warm", wakeMs: 0 };
      }
      say(`warm workspace: ${w.reason}; starting opencode again`);
    }

    if (container.running) {
      source = "running";
      say("container already running; reusing it");
      // Registering again replaces the handler, so a container started by an older deploy
      // gets this deploy's egress too.
      await installEgress(ctx);
    } else {
      const slot = await registry.acquireRunSlot(workspaceId);
      if (!slot.ok)
        return fail(
          "error" in slot && slot.error
            ? String(slot.error)
            : "Failed: run slot refused — fix: pause an idle workspace",
        );
      slotHeld = true;
      const plan = await choosePlan(ctx, rec, req);
      say(planLine(plan));
      const started = await startFrom(ctx, rec, plan, say);
      if (!started.ok) return fail(started.error);
      source = started.source;
      wakeMs = started.wakeMs;
      trace.source = source;
      freshBoot = source === "image";
      rec.state = "starting";
      rec.imageKey = started.imageKey;
      rec.imageRef = started.imageRef;
      const deployed = imageRefFromDeploy(ctx, started.imageKey);
      if (source !== "image" && deployed && started.imageRef !== deployed) {
        say(
          `this disk came from ${started.imageRef ? "an older image" : "an image from before rebuild existed"}; cf-opencode rebuild ${workspaceId} moves /home/user onto the new one`,
        );
      }
      rec.lastWakeSource = source;
      rec.directory = directory;
      await saveWorkspace(kv, rec, now());
      const ready = await waitReady(ctx, left());
      if (ready.kind !== "ready") return failStarted(readyError(workspaceId, ready));
      say(`container ready in ${(ready.ms / 1000).toFixed(1)} s`);
    }

    if (activeRoutes(ctx.env).length > 0) say(`egress CA: ${await trustEgressCa(ctx)}`);
    const prepared = await prepareRepo(ctx, req, directory);
    if (!prepared.ok) return failStarted(prepared.error);
    say(`repo: ${prepared.line}`);

    if (req.workerUrl) rec.workerUrl = req.workerUrl;
    const served = await ensureServer(ctx, password, directory, rec.workerUrl);
    if (!served.ok) return failStarted(served.error);
    say(served.line);

    const healthy = await waitHealthy(ctx, password, left());
    if (!healthy.ok) return failStarted(healthy.error);

    const ts = now();
    rec.state = "awake";
    rec.awakeSince ??= ts;
    rec.directory = directory;
    rec.passwordSha = await tokenSha(password);
    rec.lastWakeSource = source;
    rec.lastSpawnMs = clock.now() - t0;
    rec.dirtySince ??= ts;
    trace.ms = rec.lastSpawnMs;
    trace.source = source;
    await saveWorkspace(kv, rec, ts);
    await container.setInactivityTimeout(ctx.config.inactivityTimeoutMinutes * 60_000);
    await beat(ctx);
    say(
      `workspace ready (${source}); opencode on port ${ctx.config.serverPort}; spawn took ${(rec.lastSpawnMs / 1000).toFixed(1)} s`,
    );
    return { ok: true, source, wakeMs };
  } catch (e) {
    if (slotHeld && !container.running) await registry.releaseRunSlot(workspaceId).catch(() => undefined);
    return fail(`Failed: ${errText(e)} — fix: retry; run cf-opencode logs ${workspaceId}`);
  }
}

async function choosePlan(ctx: OrbContext, rec: WorkspaceRecord, req: OpRequest): Promise<Plan> {
  if (rec.handle && ctx.clock.now() < handleExpiresAt(rec.handle)) {
    return { kind: "per-workspace", handle: rec.handle };
  }
  if (req.snapshotId) {
    const m = await ctx.registry.getProjectSnapshot(req.snapshotId).catch(() => undefined);
    if (m && ctx.clock.now() < handleExpiresAt(m.handle) && !m.stale?.forgotten) {
      return { kind: "project", snapshotId: req.snapshotId, handle: m.handle, mapping: m };
    }
  }
  return {
    kind: "image",
    imageKey: req.image || "orb",
    why: rec.handle ? "snapshot expired" : "no snapshot yet",
  };
}

function planLine(plan: Plan): string {
  if (plan.kind === "image") return `booting image ${plan.imageKey} (${plan.why})`;
  if (plan.kind === "per-workspace") return `restoring workspace disk ${plan.handle.id}`;
  return `restoring project snapshot ${plan.snapshotId}`;
}

async function startFrom(
  ctx: OrbContext,
  rec: WorkspaceRecord,
  plan: Plan,
  say: (s: string) => void,
): Promise<
  | { ok: true; source: WakeSource; wakeMs: number; imageKey: string; imageRef?: string }
  | { ok: false; error: string }
> {
  const imageKey = plan.kind === "image" ? plan.imageKey : plan.handle.imageKey;
  // Cloudflare rejects a bare key or a tag. A digest-pinned ref in config.images[key] wins;
  // else the ref wrangler deploy built and pushed for that key in wrangler.jsonc.
  const imageRef = ctx.config.images[imageKey] || imageRefFromDeploy(ctx, imageKey) || imageKey;
  const t = ctx.clock.now();
  // Internet is on unless the install opted into lockdown. Provider hosts are intercepted
  // either way: the container sends a placeholder and the Worker adds the real key, so a
  // snapshot still cannot contain one. Lockdown is the old default, kept as an opt-in.
  const internet = !ctx.config.lockdown;
  try {
    if (plan.kind === "image") {
      ctx.container.start({ source: { image: imageRef }, instance: rec.instance, enableInternet: internet });
    } else {
      ctx.container.start({
        source: { snapshotId: plan.handle.id },
        instance: plan.handle.instance,
        enableInternet: internet,
      });
    }
    await installEgress(ctx);
  } catch (e) {
    return { ok: false, error: `Failed: container start failed: ${errText(e)} — fix: retry the connect` };
  }
  if (plan.kind !== "image") {
    plan.handle.lastRestoredAt = iso(ctx.clock.now());
    await ctx.registry.recordSnapshot(plan.handle, ctx.workspaceId).catch(() => undefined);
    if (plan.kind === "project") {
      await ctx.registry.touchProjectSnapshot(plan.snapshotId, iso(ctx.clock.now())).catch(() => undefined);
    }
  }
  say(`container start returned in ${ctx.clock.now() - t} ms`);
  return {
    ok: true,
    source:
      plan.kind === "image"
        ? "image"
        : plan.kind === "project"
          ? "project-snapshot"
          : "per-workspace-snapshot",
    wakeMs: ctx.clock.now() - t,
    imageKey,
    ...(plan.kind === "image"
      ? { imageRef }
      : plan.handle.imageRef
        ? { imageRef: plan.handle.imageRef }
        : {}),
  };
}

/** git, curl and Python read the system store; NODE_EXTRA_CA_CERTS (SCRIPT_ENV) covers Node and Bun. */
async function trustEgressCa(ctx: OrbContext): Promise<string> {
  try {
    const r = await ctx.container.exec(["bash", "-c", TRUST_CA_SH], { user: "0:0", timeoutMs: 30_000 });
    return r.stdout.trim().split("\n").pop() || r.stderr.trim() || `exit ${r.exitCode}`;
  } catch (e) {
    return `failed: ${errText(e)}`;
  }
}

/** Provider-key routes, and the AI binding route. Called after every start and on reuse. */
async function installEgress(ctx: OrbContext): Promise<void> {
  const routes = activeRoutes(ctx.env);
  if (routes.length > 0 && ctx.container.intercept) await ctx.container.intercept(routes);
  if (ctx.config.ai && ctx.container.interceptAi) await ctx.container.interceptAi(ctx.config.aiGateway);
}

function imageRefFromDeploy(ctx: OrbContext, imageKey: string): string | undefined {
  try {
    return ctx.container.images()[imageKey];
  } catch {
    return undefined;
  }
}

/** First successful exec(["true"]) means the container is up. A missing snapshot rejects monitor(). */
export async function waitReady(ctx: OrbContext, budgetMs: number): Promise<Ready> {
  const cap = Math.min(READY_CAP_MS, Math.max(1_000, budgetMs));
  const t0 = ctx.clock.now();
  const until = t0 + cap;
  let monitor: Promise<unknown> = ctx.container.monitor().then(
    () => ({ kind: "exit" as const }),
    (e: unknown) => ({ kind: "reject" as const, msg: errText(e) }),
  );
  while (ctx.clock.now() < until) {
    const step = ctx.container.exec(["true"], { timeoutMs: 5_000 }).then(
      () => "ok" as const,
      () => "no" as const,
    );
    const won = await Promise.race([step, monitor.then((m) => m)]);
    if (won === "ok") return { kind: "ready", ms: ctx.clock.now() - t0 };
    if (won && typeof won === "object" && "kind" in won && won.kind === "reject" && "msg" in won) {
      const msg = String(won.msg);
      if (NOT_FOUND.test(msg)) return { kind: "not-found", msg };
      return { kind: "error", msg };
    }
    if (won && typeof won === "object" && "kind" in won) return { kind: "error", msg: "container exited" };
    await ctx.clock.sleep(500);
    monitor = ctx.container.monitor().then(
      () => ({ kind: "exit" as const }),
      (e: unknown) => ({ kind: "reject" as const, msg: errText(e) }),
    );
  }
  return { kind: "timeout", byDeadline: budgetMs < READY_CAP_MS };
}

function readyError(workspaceId: string, r: Exclude<Ready, { kind: "ready" }>): string {
  if (r.kind === "not-found") {
    return `Failed: snapshot not found — fix: cf-opencode delete ${workspaceId}, then cf-opencode connect`;
  }
  if (r.kind === "timeout") {
    return `Failed: container was not ready in time — fix: retry; the first start on a new host pulls the image (${workspaceId})`;
  }
  return `Failed: container failed to start: ${r.msg} — fix: cf-opencode logs ${workspaceId}`;
}

async function prepareRepo(
  ctx: OrbContext,
  req: OpRequest,
  directory: string,
): Promise<{ ok: true; line: string } | { ok: false; error: string }> {
  const env: Record<string, string> = { DIRECTORY: directory };
  if (req.repoUrl) env.REPO_URL = req.repoUrl;
  if (req.branch) env.BRANCH = req.branch;
  if (req.gitName) env.GIT_NAME = req.gitName;
  if (req.gitEmail) env.GIT_EMAIL = req.gitEmail;
  try {
    const [cmd, opts] = sh(PREPARE_SH, env);
    const r = await ctx.container.exec(cmd, { ...opts, timeoutMs: 120_000 });
    if (r.exitCode !== 0) {
      return {
        ok: false,
        error: `Failed: repo prepare failed: ${r.stderr.trim() || r.stdout.trim()} — fix: check the git URL; for a private GitHub repo, cf-opencode git-token`,
      };
    }
    return { ok: true, line: r.stdout.trim().split("\n").pop() ?? "present" };
  } catch (e) {
    return { ok: false, error: `Failed: repo prepare failed: ${errText(e)} — fix: retry the connect` };
  }
}

async function ensureServer(
  ctx: OrbContext,
  password: string,
  directory: string,
  workerUrl: string | undefined,
): Promise<{ ok: true; line: string } | { ok: false; error: string }> {
  const sha = await tokenSha(password);
  try {
    const [cmd, opts] = sh(SERVE_SH, {
      PORT: String(ctx.config.serverPort),
      DIRECTORY: directory,
      PASSWORD_SHA: sha,
      OPENCODE_SERVER_PASSWORD: password,
      REDACT_SECRETS: [password, PLACEHOLDER].filter(Boolean).join(","),
      CF_OPENCODE_WORKSPACE: ctx.workspaceId,
      ...(ctx.config.ai ? { OPENCODE_CONFIG_CONTENT: opencodeConfig(ctx.config.model || undefined) } : {}),
      ...(workerUrl ? { CF_OPENCODE_URL: workerUrl } : {}),
      ...providerEnv(ctx.env),
    });
    const r = await ctx.container.exec(cmd, { ...opts, timeoutMs: 30_000 });
    if (r.exitCode !== 0) {
      return {
        ok: false,
        error: `Failed: opencode serve did not start: ${r.stderr.trim() || r.stdout.trim()} — fix: cf-opencode logs ${ctx.workspaceId}`,
      };
    }
    return { ok: true, line: r.stdout.trim().split("\n").pop() ?? "started" };
  } catch (e) {
    return {
      ok: false,
      error: `Failed: opencode serve did not start: ${errText(e)} — fix: retry the connect`,
    };
  }
}

/** Probe the server from inside the container, so a proxy is not required to call spawn done. */
async function waitHealthy(
  ctx: OrbContext,
  password: string,
  budgetMs: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cap = Math.min(HEALTH_CAP_MS, Math.max(1_000, budgetMs));
  const until = ctx.clock.now() + cap;
  // OpenCode 2 serves JSON at /api/info, behind the server password. Probing with the
  // password also proves the running server holds the one the client will send.
  const [cmd, opts] = sh(HEALTH_SH, {
    PORT: String(ctx.config.serverPort),
    OPENCODE_SERVER_PASSWORD: password,
  });
  while (ctx.clock.now() < until) {
    try {
      const r = await ctx.container.exec(cmd, { ...opts, timeoutMs: 8_000 });
      if (r.exitCode === 0) return { ok: true };
    } catch {
      // not up yet
    }
    await ctx.clock.sleep(1_000);
  }
  return {
    ok: false,
    error: `Failed: opencode did not answer /api/info in ${Math.round(cap / 1000)} s — fix: cf-opencode logs ${ctx.workspaceId}`,
  };
}

async function reuseServer(
  ctx: OrbContext,
): Promise<{ ok: true; pid: string } | { ok: false; reason: string }> {
  try {
    const [cmd, opts] = sh(STATUS_SH);
    const r = await ctx.container.exec(cmd, { ...opts, timeoutMs: 15_000 });
    const first = r.stdout.trim().split("\n")[0] ?? "";
    const m = /^alive (\d+)/.exec(first);
    if (m?.[1]) return { ok: true, pid: m[1] };
    return { ok: false, reason: first || "opencode not running" };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
}

export async function beat(ctx: OrbContext): Promise<void> {
  await ctx.registry.heartbeat(ctx.workspaceId).catch(() => undefined);
}

/** Unused export kept so pause/alarm can share the username constant without a second import site. */
export const SERVER_USERNAME = OPENCODE_USERNAME;

export function memoryEnv(_config: ProviderConfig): Record<string, string> {
  return {};
}
