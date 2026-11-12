import { describe, expect, it } from "vitest";
import { type OpRequest, type OrbRecord, type ProviderConfig, SNAPSHOT_TTL_MS } from "../src/core/types";
import { idleTick, LAST_USE_KEY, runAlarm, WATCHDOG_KEY } from "../src/orb/alarm";
import { runDelete } from "../src/orb/delete";
import { handleExpiresAt } from "../src/orb/journal";
import { runPause } from "../src/orb/pause";
import { runSpawn } from "../src/orb/spawn";
import { makeOrbCtx, type OrbHarness } from "./fake-registry";

const spawnReq: OpRequest = { op: "spawn", password: "tok-123456" };
const orb = async (h: OrbHarness) => (await h.kv.get<OrbRecord>("orb"))!;
const MIN = 60_000;
const DAY = 24 * 3600_000;

async function awake(config: Partial<ProviderConfig> = {}) {
  const h = makeOrbCtx({ config: { alarmSeconds: 60, ...config } });
  expect(await runSpawn(h.newOp(), spawnReq)).toMatchObject({ ok: true });
  return h;
}

describe("runAlarm", () => {
  it("awake + running → keep-alive, heartbeat, re-arm every alarmSeconds", async () => {
    const h = await awake({ inactivityTimeoutMinutes: 20 });
    h.fake.inactivityTimeoutMs = undefined;
    expect(await runAlarm(h.newOp())).toEqual({ rearmInMs: 60_000 });
    expect(h.fake.inactivityTimeoutMs).toBe(20 * MIN);
    expect(h.registry.calls).toContain("heartbeat ws-test");
  });

  it("not running while awake → lost, no re-arm, slot released", async () => {
    const h = await awake();
    h.fake.platformStop();
    expect(await runAlarm(h.newOp())).toEqual({ rearmInMs: null });
    const rec = await orb(h);
    expect(rec.state).toBe("lost");
    expect(rec.lastStop).toEqual({
      at: new Date(h.clock.now()).toISOString(),
      reason: "container stopped (platform or exit)",
    });
    expect(h.registry.slots.size).toBe(0);
  });

  it("bootstrap dead 10 min → self-pause", async () => {
    const h = await awake({ snapshotRefreshDays: 0 });
    h.sim.aliveBoot = undefined;
    expect(await runAlarm(h.newOp())).toEqual({ rearmInMs: 60_000 });
    expect(await h.kv.get(WATCHDOG_KEY)).toBeDefined();
    h.clock.advance(9 * MIN);
    expect(await runAlarm(h.newOp())).toEqual({ rearmInMs: 60_000 });
    expect((await orb(h)).state).toBe("awake");
    h.clock.advance(MIN);
    const r = await runAlarm(h.newOp());
    const rec = await orb(h);
    expect(rec.state).toBe("paused");
    expect(rec.lastStop?.reason).toBe("opencode not running for 10 min");
    expect(h.fake.running).toBe(false);
    expect(r.rearmInMs).toBe(handleExpiresAt(rec.handle!) + DAY - h.clock.now());
    expect(await h.kv.get(WATCHDOG_KEY)).toBeUndefined();
  });

  it("bootstrap alive again clears the watchdog", async () => {
    const h = await awake();
    const saved = h.sim.aliveBoot;
    h.sim.aliveBoot = undefined;
    await runAlarm(h.newOp());
    h.sim.aliveBoot = saved;
    h.clock.advance(5 * MIN);
    await runAlarm(h.newOp());
    expect(await h.kv.get(WATCHDOG_KEY)).toBeUndefined();
    h.sim.aliveBoot = undefined;
    h.clock.advance(6 * MIN);
    await runAlarm(h.newOp());
    expect((await orb(h)).state).toBe("awake"); // dead window restarted
  });

  it("awake longer than maxAwakeHours → self-pause", async () => {
    const h = await awake({ maxAwakeHours: 12 });
    h.clock.advance(11 * 3600_000);
    expect(await runAlarm(h.newOp())).toEqual({ rearmInMs: 60_000 });
    h.clock.advance(3600_000);
    await runAlarm(h.newOp());
    const rec = await orb(h);
    expect(rec.state).toBe("paused");
    expect(rec.lastStop?.reason).toBe("awake longer than maxAwakeHours (12 h)");
  });

  it("checkpoint only when enabled and dirty long enough; once per dirty window; instance keeps running", async () => {
    const h = await awake({ checkpointMinutes: 15 });
    h.clock.advance(10 * MIN);
    await runAlarm(h.newOp());
    expect(h.fake.snapshotCount).toBe(0);
    h.clock.advance(6 * MIN);
    await runAlarm(h.newOp());
    expect(h.fake.snapshotCount).toBe(1);
    expect(h.fake.running).toBe(true);
    const rec = await orb(h);
    expect(rec.state).toBe("awake");
    expect(rec.handle?.name).toBe("checkpoint-ws-test");
    expect(rec.dirtySince).toBeUndefined();
    expect(h.registry.snapshots).toHaveLength(1);
    expect(h.fake.execLog.some((c) => c[0] === "sync")).toBe(true);
    h.clock.advance(20 * MIN);
    await runAlarm(h.newOp());
    expect(h.fake.snapshotCount).toBe(1); // idle: no new dirty window
  });

  it("checkpoint again after new work: two dirty windows → two snapshots", async () => {
    const h = await awake({ checkpointMinutes: 15 });
    h.clock.advance(16 * MIN);
    await runAlarm(h.newOp());
    expect(h.fake.snapshotCount).toBe(1);
    expect((await orb(h)).dirtySince).toBeUndefined();
    h.sim.activity += 4096; // agent wrote logs
    h.clock.advance(MIN);
    await runAlarm(h.newOp());
    expect((await orb(h)).dirtySince).toBe(new Date(h.clock.now()).toISOString());
    h.clock.advance(14 * MIN);
    await runAlarm(h.newOp());
    expect(h.fake.snapshotCount).toBe(1); // window not old enough yet
    h.clock.advance(MIN);
    await runAlarm(h.newOp());
    expect(h.fake.snapshotCount).toBe(2);
  });

  it("self-pause that keeps failing stops the container after 3 tries; no endless re-arm", async () => {
    const h = await awake({ maxAwakeHours: 1 });
    h.fake.snapshot = async () => {
      throw new Error("snapshot quota exceeded");
    };
    h.clock.advance(3600_000);
    expect(await runAlarm(h.newOp())).toEqual({ rearmInMs: 60_000 });
    expect(h.fake.running).toBe(true);
    h.clock.advance(MIN);
    expect(await runAlarm(h.newOp())).toEqual({ rearmInMs: 60_000 });
    h.clock.advance(MIN);
    expect(await runAlarm(h.newOp())).toEqual({ rearmInMs: null });
    expect(h.fake.running).toBe(false);
    const rec = await orb(h);
    expect(rec.state).toBe("lost");
    expect(rec.lastStop?.reason).toMatch(/snapshot failed 3 times, stopped without a snapshot$/);
    expect(h.registry.slots.size).toBe(0);
    expect(await runAlarm(h.newOp())).toEqual({ rearmInMs: null });
  });

  it("self-pause give-up keeps an older handle: paused-stale, re-armed for expiry", async () => {
    const h = await awake({ maxAwakeHours: 1 });
    await runPause(h.newOp(), { op: "pause" });
    expect(await runSpawn(h.newOp(), spawnReq)).toMatchObject({ ok: true });
    h.fake.snapshot = async () => {
      throw new Error("snapshot quota exceeded");
    };
    h.clock.advance(3600_000);
    for (let i = 0; i < 3; i++) {
      await runAlarm(h.newOp());
      h.clock.advance(MIN);
    }
    const rec = await orb(h);
    expect(h.fake.running).toBe(false);
    expect(rec.state).toBe("paused-stale");
    expect(rec.handle).toBeDefined();
  });

  it("running container with no orb record state → stopped, slot released", async () => {
    const h = await awake();
    const rec = structuredClone(await orb(h));
    rec.state = "none";
    await h.kv.put("orb", rec);
    expect(await runAlarm(h.newOp())).toEqual({ rearmInMs: null });
    expect(h.fake.running).toBe(false);
    expect(h.registry.slots.size).toBe(0);
  });

  it("no checkpoint when checkpointMinutes is 0", async () => {
    const h = await awake({ checkpointMinutes: 0 });
    for (let i = 0; i < 60; i++) {
      h.clock.advance(MIN);
      await runAlarm(h.newOp());
    }
    expect(h.fake.snapshotCount).toBe(0);
  });

  it("paused, refresh off → re-arm at handle expiry + 1 d, then drop the expired handle", async () => {
    const h = await awake({ snapshotRefreshDays: 0 });
    await runPause(h.newOp(), { op: "pause" });
    expect((await orb(h)).handle).toBeDefined();
    const r = await runAlarm(h.newOp());
    expect(r.rearmInMs).toBe(SNAPSHOT_TTL_MS + DAY);
    h.clock.advance(r.rearmInMs!);
    expect(await runAlarm(h.newOp())).toEqual({ rearmInMs: null });
    const after = await orb(h);
    expect(after.handle).toBeUndefined();
    expect(after.state).toBe("paused-stale");
  });

  it("paused → restores the snapshot 3 days before it expires, so an unopened workspace keeps its disk", async () => {
    const h = await awake();
    await runPause(h.newOp(), { op: "pause" });
    const id = (await orb(h)).handle!.id;
    const r = await runAlarm(h.newOp());
    expect(r.rearmInMs).toBe(SNAPSHOT_TTL_MS - 3 * DAY);
    for (let month = 0; month < 4; month++) {
      const before = h.fake.startCount;
      h.clock.advance((await runAlarm(h.newOp())).rearmInMs!);
      const next = await runAlarm(h.newOp());
      expect(h.fake.startCount).toBe(before + 1);
      expect(h.fake.startedWith).toMatchObject({ source: { snapshotId: id }, enableInternet: false });
      expect(h.fake.running).toBe(false);
      expect(h.registry.slots.size).toBe(0);
      const rec = await orb(h);
      expect(rec.state).toBe("paused");
      expect(handleExpiresAt(rec.handle!)).toBe(h.clock.now() + SNAPSHOT_TTL_MS);
      expect(next.rearmInMs).toBe(SNAPSHOT_TTL_MS - 3 * DAY);
    }
    expect(h.sim.launches).toBe(1);
  });

  it("refresh with no free run slot retries in an hour, then runs", async () => {
    const h = await awake();
    await runPause(h.newOp(), { op: "pause" });
    h.clock.advance(SNAPSHOT_TTL_MS - 3 * DAY);
    h.registry.max = 0;
    expect((await runAlarm(h.newOp())).rearmInMs).toBe(3600_000);
    expect(h.fake.startCount).toBe(1);
    h.registry.max = 20;
    h.clock.advance(3600_000);
    expect((await runAlarm(h.newOp())).rearmInMs).toBe(SNAPSHOT_TTL_MS - 3 * DAY);
    expect(h.fake.startCount).toBe(2);
    expect(h.registry.slots.size).toBe(0);
  });

  it("lost orb without a handle → no re-arm on later alarms", async () => {
    const h = await awake();
    h.fake.platformStop();
    await runAlarm(h.newOp());
    expect(await runAlarm(h.newOp())).toEqual({ rearmInMs: null });
  });

  it("container running while recorded as paused → treated as awake", async () => {
    const h = await awake();
    const rec = structuredClone(await orb(h));
    rec.state = "paused";
    await h.kv.put("orb", rec);
    expect(await runAlarm(h.newOp())).toEqual({ rearmInMs: 60_000 });
    expect((await orb(h)).state).toBe("awake");
  });

  it("none or deleted → no alarm", async () => {
    const h = makeOrbCtx();
    expect(await runAlarm(h.ctx)).toEqual({ rearmInMs: null });
    await runSpawn(h.newOp(), spawnReq);
    await runDelete(h.newOp());
    expect(await runAlarm(h.newOp())).toEqual({ rearmInMs: null });
  });
});

describe("idleTick: the idle pause counts work, not only clients", () => {
  const PW = "derived-password";
  async function idle() {
    const h = await awake({ idlePauseMinutes: 20 });
    h.sim.agentPassword = PW;
    return h;
  }

  it("keeps a busy agent awake with no client, then pauses 20 min after it finishes", async () => {
    const h = await idle();
    h.sim.agent = "busy";
    for (let i = 0; i < 90; i++) {
      h.clock.advance(MIN);
      expect(await idleTick(h.newOp(), PW)).toBe(false);
    }
    const doneAt = h.clock.now();
    h.sim.agent = "idle";
    h.clock.advance(19 * MIN);
    expect(await idleTick(h.newOp(), PW)).toBe(false);
    expect((await orb(h)).state).toBe("awake");
    h.clock.advance(2 * MIN);
    expect(await idleTick(h.newOp(), PW)).toBe(true);
    const rec = await orb(h);
    expect(rec.state).toBe("paused");
    expect(rec.lastStop?.reason).toMatch(/^idle for 20 min/);
    expect(Date.parse((await h.kv.get<string>(LAST_USE_KEY))!)).toBe(doneAt);
  });

  it("pauses a busy agent it cannot ask: without the right password the agent does not count", async () => {
    const h = await idle();
    h.sim.agent = "busy";
    h.clock.advance(21 * MIN);
    expect(await idleTick(h.newOp(), "an older random password")).toBe(true);
  });

  it("treats a session waiting on a permission or question as a person's turn, not work", async () => {
    const h = await idle();
    h.sim.agent = "waiting";
    h.clock.advance(21 * MIN);
    expect(await idleTick(h.newOp(), PW)).toBe(true);
    expect((await orb(h)).lastStop?.reason).toMatch(/waited 20 min for an answer/);
  });

  it("keeps a workspace awake while a terminal pane prints (herdr, tmux), nobody attached", async () => {
    const h = await idle();
    for (let i = 0; i < 60; i++) {
      h.clock.advance(MIN);
      h.sim.ptyAt = Math.floor((h.clock.now() - 30_000) / 1000);
      expect(await idleTick(h.newOp(), PW)).toBe(false);
    }
    h.clock.advance(21 * MIN);
    expect(await idleTick(h.newOp(), PW)).toBe(true);
  });

  it("counts from the wake, not from a use stored before the last pause", async () => {
    const h = await idle();
    await h.kv.put(LAST_USE_KEY, new Date(h.clock.now() - 3 * DAY).toISOString());
    await runPause(h.newOp(), { op: "pause" });
    h.clock.advance(DAY);
    expect(await runSpawn(h.newOp(), spawnReq)).toMatchObject({ ok: true });
    h.clock.advance(MIN);
    expect(await idleTick(h.newOp(), PW)).toBe(false);
    h.clock.advance(20 * MIN);
    expect(await idleTick(h.newOp(), PW)).toBe(true);
  });
});
