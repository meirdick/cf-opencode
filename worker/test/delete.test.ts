import { describe, expect, it } from "vitest";
import type { OpRequest, OrbRecord } from "../src/core/types";
import { BROWSE_SESSIONS_KEY } from "../src/orb/browse";
import { runDelete } from "../src/orb/delete";
import { runPause } from "../src/orb/pause";
import { PREPARE_SH } from "../src/orb/scripts";
import { runSpawn } from "../src/orb/spawn";
import { SSH_KEYS_KEY } from "../src/orb/ssh-keys";
import { makeOrbCtx, type OrbHarness } from "./fake-registry";

const spawnReq: OpRequest = { op: "spawn", password: "tok-123456" };
const orb = async (h: OrbHarness) => (await h.kv.get<OrbRecord>("orb"))!;

describe("runDelete", () => {
  it("destroys, drops the handle and its own project snapshot, writes a tombstone, releases the slot", async () => {
    const h = makeOrbCtx();
    await runSpawn(h.newOp(), spawnReq);
    await runPause(h.newOp(), { op: "pause", snapshotId: "snap-p" });
    await runSpawn(h.newOp(), spawnReq);
    expect(h.fake.running).toBe(true);
    expect(await runDelete(h.newOp(), { snapshotId: "snap-p" })).toEqual({ ok: true });
    const rec = await orb(h);
    expect(h.fake.running).toBe(false);
    expect(rec.state).toBe("deleted");
    expect(rec.handle).toBeUndefined();
    expect(rec.deletedAt).toBe(new Date(h.clock.now()).toISOString());
    expect(h.registry.projects.has("snap-p")).toBe(false);
    expect(h.registry.slots.size).toBe(0);
    // Nothing of the old disk comes back.
    expect(await runSpawn(h.newOp(), { ...spawnReq, snapshotId: "snap-p" })).toMatchObject({
      ok: true,
      source: "image",
    });
  });

  it("forgets the old workspace's SSH keys and browser sessions", async () => {
    const h = makeOrbCtx();
    await h.kv.put(SSH_KEYS_KEY, { "ssh-ed25519 AAAA": { line: "ssh-ed25519 AAAA x", at: 1 } });
    await h.kv.put(BROWSE_SESSIONS_KEY, ["sess-1"]);
    await runDelete(h.newOp());
    expect(await h.kv.get(SSH_KEYS_KEY)).toBeUndefined();
    expect(await h.kv.get(BROWSE_SESSIONS_KEY)).toBeUndefined();
  });

  it("leaves a project snapshot that another workspace made", async () => {
    const other = makeOrbCtx({ orbId: "other" });
    await runSpawn(other.newOp(), spawnReq);
    await runPause(other.newOp(), { op: "pause", snapshotId: "snap-shared" });
    const m = await other.registry.getProjectSnapshot("snap-shared");
    const h = makeOrbCtx();
    if (m) await h.registry.putProjectSnapshot(m);
    await runSpawn(h.newOp(), spawnReq);
    await runDelete(h.newOp(), { snapshotId: "snap-shared" });
    expect(h.registry.projects.has("snap-shared")).toBe(true);
  });

  it("delete twice is ok and keeps the first tombstone", async () => {
    const h = makeOrbCtx();
    await runSpawn(h.newOp(), spawnReq);
    await runDelete(h.newOp());
    const at = (await orb(h)).deletedAt;
    h.clock.advance(60_000);
    expect(await runDelete(h.newOp())).toEqual({ ok: true });
    expect((await orb(h)).deletedAt).toBe(at);
    expect(h.fake.destroyCount).toBe(1);
  });

  it("spawn after delete starts a new workspace from the image, with none of the old record", async () => {
    const h = makeOrbCtx();
    await runSpawn(h.newOp(), spawnReq);
    await runPause(h.newOp(), { op: "pause", snapshotId: "snap-old" });
    await runDelete(h.newOp());
    expect(await runSpawn(h.newOp(), spawnReq)).toMatchObject({ ok: true, source: "image" });
    const rec = await orb(h);
    expect(rec.deletedAt).toBeUndefined();
    expect(rec.state).not.toBe("deleted");
  });

  it("a first spawn that fails after the boot stops the empty container and frees the slot", async () => {
    const h = makeOrbCtx();
    const inner = h.fake.handler;
    h.fake.handler = (cmd, opts, fake) =>
      cmd[2] === PREPARE_SH
        ? { exitCode: 128, stdout: "", stderr: "fatal: could not read Username for 'https://github.com'" }
        : inner(cmd, opts, fake);
    const r = await runSpawn(h.newOp(), { ...spawnReq, repoUrl: "https://github.com/a/private" });
    expect(!r.ok && r.error).toMatch(/repo prepare failed.*cf-opencode git-token/);
    expect(h.fake.running).toBe(false);
    expect(h.registry.slots.size).toBe(0);
    expect((await orb(h)).state).toBe("none");

    // With the cause fixed, the same connect works.
    h.fake.handler = inner;
    expect(await runSpawn(h.newOp(), spawnReq)).toMatchObject({ ok: true, source: "image" });
  });

  it("pause after delete is a no-op success", async () => {
    const h = makeOrbCtx();
    await runSpawn(h.newOp(), spawnReq);
    await runDelete(h.newOp());
    expect(await runPause(h.newOp(), { op: "pause", snapshotId: "snap-p" })).toEqual({ ok: true });
    expect(h.fake.snapshotCount).toBe(0);
    expect((await orb(h)).state).toBe("deleted");
  });

  it("delete of a partial orb (never spawned) is ok", async () => {
    const h = makeOrbCtx();
    expect(await runDelete(h.ctx)).toEqual({ ok: true });
    expect((await orb(h)).state).toBe("deleted");
  });
});
