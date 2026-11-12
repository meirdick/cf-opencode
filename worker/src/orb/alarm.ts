// OrbSession alarm. Awake: keep-alive, Registry heartbeat, bootstrap watchdog, maxAwakeHours,
// opt-in checkpoint. Warm: keep-alive and heartbeat until warmUntil, then stop the container.
// Paused: one wake at handle expiry + 1 d to drop the dead handle. Else: no alarm.
import type { OrbRecord } from "../core/types";
import type { OrbContext } from "./context";
import {
  ACTIVITY_KEY,
  errText,
  type Handle,
  handleExpiresAt,
  iso,
  loadOrb,
  parseStatus,
  saveOrb,
  WARM_USE_KEY,
} from "./journal";
import { runPause } from "./pause";
import { ACTIVITY_SH, STATUS_SH } from "./scripts";
import { sh, waitReady } from "./spawn";
import { stopTasks } from "./tasks";

export const WATCHDOG_KEY = "watchdog";
/**
 * Last use of the workspace, ISO: a proxied request, a terminal frame, an agent seen working, a pane
 * printing. The stored name predates the wider meaning.
 */
export const LAST_USE_KEY = "lastProxyAt";
export { ACTIVITY_KEY };
/** Self-pause failures in the current awake window. */
export const SELF_PAUSE_KEY = "selfPause";
export const BOOTSTRAP_DEAD_MS = 10 * 60_000;
/** After this many failed self-pauses the container is stopped without a snapshot (cost guard). */
export const MAX_SELF_PAUSE_FAILURES = 3;
const DAY_MS = 24 * 3600_000;

interface SelfPauseFailures {
  awakeSince?: string;
  count: number;
}

interface Watchdog {
  /** First alarm that found the bootstrap not running; cleared when it is alive again. */
  deadSince?: string;
}

export async function runAlarm(ctx: OrbContext): Promise<{ rearmInMs: number | null }> {
  const { container, clock, kv, registry, orbId } = ctx;
  const rec = await loadOrb(kv);
  if (!rec || rec.state === "none" || rec.state === "deleted" || rec.deletedAt) {
    // Nothing should run here (for example a destroy that failed after delete). Stop it and free the slot.
    if (container.running) {
      ctx.say(
        `container running while state is ${rec?.deletedAt ? "deleted" : (rec?.state ?? "none")}; stopping it`,
      );
      await container.destroy();
      await registry.releaseRunSlot(orbId);
    }
    return { rearmInMs: null };
  }

  const live =
    rec.state === "awake" || rec.state === "starting" || rec.state === "pausing" || rec.state === "warm";
  if (rec.state === "warm" && rec.handle && !container.running) {
    // The disk was saved when the orb went warm: nothing is lost.
    const at = iso(clock.now());
    rec.state = "paused";
    rec.lastStop = { at, reason: "container stopped while warm" };
    clearAwake(rec);
    await saveOrb(kv, rec, at);
    await kv.delete(WATCHDOG_KEY);
    await registry.releaseRunSlot(orbId);
    ctx.say(`warm container stopped; next wake restores the disk from ${rec.handle.createdAt}`);
    return { rearmInMs: await expiryRearm(ctx, rec) };
  }
  if (live && !container.running) {
    const at = iso(clock.now());
    rec.state = "lost";
    rec.lastStop = { at, reason: "container stopped (platform or exit)" };
    // Nothing can be read any more; a task saved as running is stopped.
    await stopTasks(ctx).catch(() => undefined);
    clearAwake(rec);
    await saveOrb(kv, rec, at);
    await kv.delete(WATCHDOG_KEY);
    await registry.releaseRunSlot(orbId);
    ctx.say(
      `container stopped without a pause; ${rec.handle ? `next wake restores the disk from ${rec.handle.createdAt}` : "next wake boots the image"}`,
    );
    return { rearmInMs: null };
  }
  if (!live && container.running) {
    // Running but recorded as stopped (for example a pause that failed after the record was written).
    ctx.say(`container running while state is ${rec.state}; treating the orb as awake`);
    rec.state = "awake";
    rec.awakeSince ??= iso(clock.now());
    await saveOrb(kv, rec, iso(clock.now()));
  }
  if (container.running) return rec.state === "warm" ? warmTick(ctx, rec) : awakeTick(ctx, rec);
  return { rearmInMs: await expiryRearm(ctx, rec) };
}

function clearAwake(rec: OrbRecord): void {
  rec.awakeSince = undefined;
  rec.warmUntil = undefined;
  rec.bootstrapTokenSha = undefined;
}

/** Warm workspace (paused, kept running): keep-alive and heartbeat until warmUntil, then stop it. */
async function warmTick(ctx: OrbContext, rec: OrbRecord): Promise<{ rearmInMs: number | null }> {
  const { container, clock, config, registry, orbId } = ctx;
  const nowMs = clock.now();
  await container.setInactivityTimeout(config.inactivityTimeoutMinutes * 60_000);
  try {
    await registry.heartbeat(orbId);
  } catch (e) {
    ctx.say(`registry heartbeat failed: ${errText(e)}`);
  }
  // Status first: a new message in the last minute must win over the expiry below.
  let alive = true;
  try {
    const [cmd, opts] = sh(STATUS_SH);
    const r = await container.exec(cmd, { ...opts, timeoutMs: 20_000 });
    const st = parseStatus(r.stdout);
    alive = st.alive;
    const atPause = await ctx.kv.get<string>(WARM_USE_KEY);
    if (alive && st.use !== undefined && atPause !== undefined && st.use !== atPause) {
      // A client can use a warm workspace without a spawn. It is awake again.
      const at = iso(nowMs);
      rec.state = "awake";
      rec.warmUntil = undefined;
      rec.lastWakeSource = "warm";
      rec.dirtySince ??= at;
      await saveOrb(ctx.kv, rec, at);
      await ctx.kv.delete(WARM_USE_KEY);
      ctx.say("a client used the warm workspace (no spawn); the workspace is awake again");
      return { rearmInMs: config.alarmSeconds * 1000 };
    }
  } catch (e) {
    ctx.say(`bootstrap status check failed: ${errText(e)}`);
  }
  const until = Date.parse(rec.warmUntil ?? "");
  if (!Number.isFinite(until) || nowMs >= until)
    return coolDown(ctx, rec, `warm for ${config.warmMinutes} min with no new message`);
  if (rec.awakeSince && nowMs - Date.parse(rec.awakeSince) >= config.maxAwakeHours * 3600_000)
    return coolDown(ctx, rec, `awake longer than maxAwakeHours (${config.maxAwakeHours} h)`);
  // Nothing to keep warm without opencode: the next wake starts it again anyway.
  if (!alive) return coolDown(ctx, rec, "opencode stopped while warm");
  return { rearmInMs: Math.min(config.alarmSeconds * 1000, until - nowMs) };
}

/**
 * End of a warm period. The disk was saved at the pause and the thread got no new message since (else the orb
 * is awake again): stop the container. Log growth alone is not work. No handle → pause cold (snapshot, stop).
 */
async function coolDown(
  ctx: OrbContext,
  rec: OrbRecord,
  reason: string,
): Promise<{ rearmInMs: number | null }> {
  const { container, clock, kv, registry, orbId } = ctx;
  if (!rec.handle) {
    ctx.say(`${reason}; no disk snapshot, so pause cold`);
    const r = await selfPause(ctx, reason);
    // A failed snapshot leaves the workspace running as awake. The client thinks it is paused: stay warm, retry.
    const after = await loadOrb(kv);
    if (after?.state === "awake" && container.running) {
      after.state = "warm";
      await saveOrb(kv, after, iso(clock.now()));
    }
    return r;
  }
  // opencode stops with the container: a task still running is saved as stopped.
  await stopTasks(ctx).catch(() => undefined);
  await container.destroy();
  await registry.releaseRunSlot(orbId);
  const at = iso(clock.now());
  rec.state = "paused";
  rec.lastStop = { at, reason };
  clearAwake(rec);
  await saveOrb(kv, rec, at);
  await kv.delete(WATCHDOG_KEY);
  ctx.say(`stopped warm orb (${reason}); next wake restores the disk from ${rec.handle.createdAt}`);
  return { rearmInMs: await expiryRearm(ctx, rec) };
}

async function awakeTick(ctx: OrbContext, rec: OrbRecord): Promise<{ rearmInMs: number | null }> {
  const { container, clock, kv, config, registry, orbId } = ctx;
  const nowMs = clock.now();
  const every = config.alarmSeconds * 1000;

  await container.setInactivityTimeout(config.inactivityTimeoutMinutes * 60_000);
  try {
    await registry.heartbeat(orbId);
  } catch (e) {
    ctx.say(`registry heartbeat failed: ${errText(e)}`);
  }

  const maxMs = config.maxAwakeHours * 3600_000;
  if (rec.awakeSince && nowMs - Date.parse(rec.awakeSince) >= maxMs) {
    return selfPause(ctx, `awake longer than maxAwakeHours (${config.maxAwakeHours} h)`);
  }

  // Bootstrap watchdog. An exec error is not evidence either way; try again next tick.
  const wd = (await kv.get<Watchdog>(WATCHDOG_KEY)) ?? {};
  try {
    const [cmd, opts] = sh(STATUS_SH);
    const r = await container.exec(cmd, { ...opts, timeoutMs: 20_000 });
    const first = r.stdout.trim().split("\n")[0] ?? "";
    await noteActivity(ctx, rec, /^act (\d+)$/m.exec(r.stdout)?.[1]);
    if (first.startsWith("alive")) {
      if (wd.deadSince) await kv.delete(WATCHDOG_KEY);
    } else {
      const since = wd.deadSince ?? iso(nowMs);
      if (!wd.deadSince) await kv.put<Watchdog>(WATCHDOG_KEY, { deadSince: since });
      if (nowMs - Date.parse(since) >= BOOTSTRAP_DEAD_MS) {
        return selfPause(
          ctx,
          `opencode not running for ${Math.round((nowMs - Date.parse(since)) / 60_000)} min`,
        );
      }
    }
  } catch (e) {
    ctx.say(`bootstrap status check failed: ${errText(e)}`);
  }

  // Opt-in checkpoint: snapshot without stopping, once per dirty window.
  if (
    config.checkpointMinutes > 0 &&
    rec.dirtySince &&
    nowMs - Date.parse(rec.dirtySince) >= config.checkpointMinutes * 60_000
  ) {
    await checkpoint(ctx, rec);
  }
  return { rearmInMs: every };
}

/** A grown log means the agent did work since the last tick: open a dirty window if none is open (FR8). */
async function noteActivity(ctx: OrbContext, rec: OrbRecord, act: string | undefined): Promise<void> {
  if (act === undefined) return;
  const prev = await ctx.kv.get<string>(ACTIVITY_KEY);
  if (prev === act) return;
  await ctx.kv.put(ACTIVITY_KEY, act);
  if (prev !== undefined && !rec.dirtySince) {
    const at = iso(ctx.clock.now());
    rec.dirtySince = at;
    await saveOrb(ctx.kv, rec, at);
  }
}

async function checkpoint(ctx: OrbContext, rec: OrbRecord): Promise<void> {
  const { container, clock, kv, registry, orbId } = ctx;
  const t = clock.now();
  try {
    await container.exec(["sync"], { timeoutMs: 60_000 });
    const snap = await container.snapshot(`checkpoint-${orbId}-${t}`);
    const handle: Handle = {
      id: snap.id,
      size: snap.size,
      imageKey: rec.imageKey,
      instance: rec.instance,
      createdAt: iso(clock.now()),
      name: `checkpoint-${orbId}`,
      ...(rec.imageRef ? { imageRef: rec.imageRef } : {}),
    };
    rec.handle = handle;
    rec.dirtySince = undefined;
    await saveOrb(kv, rec, iso(clock.now()));
    await registry.recordSnapshot(handle, orbId).catch(() => undefined);
    ctx.say(
      `checkpoint ${snap.id}: ${Math.round(snap.size / 1e6)} MB in ${((clock.now() - t) / 1000).toFixed(1)} s`,
    );
  } catch (e) {
    ctx.say(`checkpoint failed (will retry next alarm): ${errText(e)}`);
  }
}

async function selfPause(ctx: OrbContext, reason: string): Promise<{ rearmInMs: number | null }> {
  const { kv, container, clock, registry, orbId } = ctx;
  ctx.say(`self-pause: ${reason}`);
  const awakeSince = (await loadOrb(kv))?.awakeSince;
  const r = await runPause(ctx, { op: "pause" }, reason, { cold: true });
  if (r.ok) {
    await kv.delete(WATCHDOG_KEY);
    await kv.delete(SELF_PAUSE_KEY);
    const rec = await loadOrb(kv);
    return { rearmInMs: rec ? await expiryRearm(ctx, rec) : null };
  }
  const prev = await kv.get<SelfPauseFailures>(SELF_PAUSE_KEY);
  const count = (prev && prev.awakeSince === awakeSince ? prev.count : 0) + 1;
  const rec = await loadOrb(kv);
  if (!container.running || !rec) {
    await kv.delete(SELF_PAUSE_KEY);
    return { rearmInMs: rec ? await expiryRearm(ctx, rec) : null };
  }
  if (count < MAX_SELF_PAUSE_FAILURES) {
    await kv.put<SelfPauseFailures>(SELF_PAUSE_KEY, { awakeSince, count });
    ctx.say(
      `self-pause failed (${count} of ${MAX_SELF_PAUSE_FAILURES}): ${r.error ?? "unknown"}; trying again next alarm`,
    );
    return { rearmInMs: ctx.config.alarmSeconds * 1000 };
  }
  // Cost guard: a snapshot that keeps failing must not keep the container billed forever.
  const at = iso(clock.now());
  ctx.say(
    `self-pause failed ${count} times; stopping the container without a snapshot (${rec.handle ? `next wake restores the disk from ${rec.handle.createdAt}` : "next wake boots the image"})`,
  );
  await stopTasks(ctx).catch(() => undefined);
  await container.destroy();
  await registry.releaseRunSlot(orbId);
  rec.state = rec.handle ? "paused-stale" : "lost";
  rec.lastStop = { at, reason: `${reason}; snapshot failed ${count} times, stopped without a snapshot` };
  clearAwake(rec);
  await saveOrb(kv, rec, at);
  await kv.delete(WATCHDOG_KEY);
  await kv.delete(SELF_PAUSE_KEY);
  return { rearmInMs: await expiryRearm(ctx, rec) };
}

export interface Activity {
  /** Epoch ms of the last output on any terminal in the workspace; 0 when none. */
  ptyAt: number;
  agent: "busy" | "waiting" | "idle" | "unknown";
}

export function parseActivity(stdout: string): Activity {
  const pty = Number(/^pty (\d+)$/m.exec(stdout)?.[1] ?? 0);
  const agent = /^agent (busy|waiting|idle|unknown)$/m.exec(stdout)?.[1] as Activity["agent"] | undefined;
  return { ptyAt: Number.isFinite(pty) ? pty * 1000 : 0, agent: agent ?? "unknown" };
}

/**
 * The idle pause. An awake workspace pauses after idlePauseMinutes without use, where use is any of: a
 * request through the Worker, a terminal frame, an OpenCode session running (the agent works on with the
 * laptop closed), or output on a terminal (tmux and herdr panes, ssh sessions). The idle time counts from the
 * last of those, so a long task pauses idlePauseMinutes after it finishes, not when it finishes. A session
 * waiting on a permission or a question is not work. `password` is the workspace password, which lets the
 * probe ask opencode; without it, only the other signals count. Returns true when it paused.
 */
export async function idleTick(ctx: OrbContext, password: string | undefined): Promise<boolean> {
  const { container, clock, kv, config } = ctx;
  const rec = await loadOrb(kv);
  if (rec?.state !== "awake" || !container.running) return false;
  const nowMs = clock.now();
  const idleMs = config.idlePauseMinutes * 60_000;
  const stored = Date.parse((await kv.get<string>(LAST_USE_KEY)) ?? "");
  // Count from the wake at the earliest: a use stored before the last pause must not pause a fresh wake, and
  // a workspace woken by the control API and never used through the Worker still pauses.
  const woke = Date.parse(rec.awakeSince ?? "");
  let last = Math.max(Number.isFinite(stored) ? stored : 0, Number.isFinite(woke) ? woke : 0) || nowMs;
  let seen: Activity = { ptyAt: 0, agent: "unknown" };
  try {
    const [cmd, opts] = sh(ACTIVITY_SH, {
      PORT: String(config.serverPort),
      ...(password ? { OPENCODE_SERVER_PASSWORD: password } : {}),
    });
    seen = parseActivity((await container.exec(cmd, { ...opts, timeoutMs: 30_000 })).stdout);
  } catch (e) {
    ctx.say(`activity probe failed: ${errText(e)}`);
  }
  if (seen.agent === "busy") last = nowMs;
  if (seen.ptyAt > last) last = Math.min(seen.ptyAt, nowMs);
  if (last !== stored) await kv.put(LAST_USE_KEY, iso(last));
  if (nowMs - last < idleMs) return false;
  const why =
    seen.agent === "waiting"
      ? `the agent waited ${config.idlePauseMinutes} min for an answer`
      : `idle for ${config.idlePauseMinutes} min (no client, no agent work, no terminal output)`;
  ctx.say(`${why}; pausing`);
  await runPause(ctx, { op: "pause" }, why);
  return true;
}

/** Retry a refresh that could not run (no run slot, the container did not come up) after this long. */
export const REFRESH_RETRY_MS = 3600_000;

/**
 * Stopped workspace with a snapshot. snapshotRefreshDays before the snapshot expires, restore it briefly: a
 * restore starts a new 30 days, so a workspace nobody opens for months keeps its disk. Without refresh (0, or a
 * refresh that keeps failing until the end), wake at expiry + 1 d and drop the dead handle.
 */
async function expiryRearm(ctx: OrbContext, rec: OrbRecord): Promise<number | null> {
  const h = rec.handle as Handle | undefined;
  if (!h) return null;
  const nowMs = ctx.clock.now();
  const expires = handleExpiresAt(h);
  const lead = ctx.config.snapshotRefreshDays * DAY_MS;
  if (lead > 0 && nowMs < expires && !rec.deletedAt) {
    if (nowMs < expires - lead) return expires - lead - nowMs;
    const refreshed = await refreshSnapshot(ctx, rec, h);
    if (refreshed === "gone") return null;
    if (refreshed === "ok") return handleExpiresAt(h) - lead - ctx.clock.now();
    return Math.min(REFRESH_RETRY_MS, Math.max(60_000, expires - ctx.clock.now()));
  }
  const at = expires + DAY_MS;
  if (nowMs < at) return at - nowMs;
  ctx.say(`orb disk snapshot ${h.id} expired (saved ${h.createdAt}); dropping it, next wake boots the image`);
  rec.handle = undefined;
  if (rec.state === "paused") rec.state = "paused-stale";
  await saveOrb(ctx.kv, rec, iso(nowMs));
  return null;
}

/** Restore the snapshot with nothing running in it, wait until the container answers, stop it. */
async function refreshSnapshot(ctx: OrbContext, rec: OrbRecord, h: Handle): Promise<"ok" | "retry" | "gone"> {
  const { container, registry, orbId, clock } = ctx;
  const slot = await registry.acquireRunSlot(orbId);
  if (!slot.ok) {
    ctx.say(`snapshot refresh waits for a run slot (${slot.running}/${slot.max} running); retrying in 1 h`);
    return "retry";
  }
  const t0 = clock.now();
  let ready: Awaited<ReturnType<typeof waitReady>>;
  try {
    container.start({ source: { snapshotId: h.id }, instance: h.instance, enableInternet: false });
    ready = await waitReady(ctx, 120_000);
  } catch (e) {
    ready = { kind: "error", msg: errText(e) };
  } finally {
    if (container.running) await container.destroy().catch(() => undefined);
    await registry.releaseRunSlot(orbId);
  }
  const at = iso(clock.now());
  if (ready.kind === "ready") {
    h.lastRestoredAt = at;
    rec.handle = h;
    await saveOrb(ctx.kv, rec, at);
    await registry.recordSnapshot(h, orbId).catch(() => undefined);
    ctx.say(
      `refreshed disk snapshot ${h.id} in ${((clock.now() - t0) / 1000).toFixed(1)} s; it now expires ${iso(handleExpiresAt(h))}`,
    );
    return "ok";
  }
  if (ready.kind === "not-found") {
    ctx.say(`disk snapshot ${h.id} is gone (${ready.msg}); next wake boots the image`);
    rec.handle = undefined;
    if (rec.state === "paused") rec.state = "paused-stale";
    await saveOrb(ctx.kv, rec, at);
    return "gone";
  }
  ctx.say(
    `snapshot refresh failed (${ready.kind === "error" ? ready.msg : "not ready in time"}); retrying in 1 h`,
  );
  return "retry";
}
