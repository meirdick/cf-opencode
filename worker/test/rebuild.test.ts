import { describe, expect, it } from "vitest";
import type { OpRequest, OrbRecord } from "../src/core/types";
import { runPause } from "../src/orb/pause";
import { receiveRebuild, runRebuild } from "../src/orb/rebuild";
import { runSpawn } from "../src/orb/spawn";
import { makeOrbCtx } from "./fake-registry";

const OLD = "registry.cloudflare.com/acct/cf-opencode-orb@sha256:old";
const NEW = "registry.cloudflare.com/acct/cf-opencode-orb@sha256:new";
const spawnReq: OpRequest = { op: "spawn", password: "tok-123456" };

/** A workspace made on the old image, paused, then the install upgraded to the new image. */
async function oldWorkspace() {
  const h = makeOrbCtx({ images: { orb: OLD } });
  expect(await runSpawn(h.newOp(), spawnReq)).toMatchObject({ ok: true });
  h.fake.disk["/home/user/project/notes.md"] = "work in progress";
  await runPause(h.newOp(), { op: "pause" });
  const target = makeOrbCtx({ orbId: "ws-test~rebuild", images: { orb: NEW } });
  (h.fake as unknown as { imageMap: Record<string, string> }).imageMap = { orb: NEW };
  return { h, target };
}

describe("rebuild", () => {
  it("carries the files onto the deployed image and makes that the workspace's disk", async () => {
    const { h, target } = await oldWorkspace();
    const before = (await h.kv.get<OrbRecord>("orb"))!;
    expect(before.handle?.imageRef).toBe(OLD);

    const r = await runRebuild(h.newOp(), {
      receive: (tar, o) => receiveRebuild(target.newOp(), tar, o.instance),
    });
    expect(r).toEqual({ ok: true });
    expect(target.fake.startedWith?.source).toEqual({ image: NEW });
    expect(target.fake.startedWith?.enableInternet).toBe(false);
    expect(target.fake.running).toBe(false);
    expect(h.fake.running).toBe(false);
    expect(h.registry.slots.size + target.registry.slots.size).toBe(0);

    const rec = (await h.kv.get<OrbRecord>("orb"))!;
    expect(rec.state).toBe("paused");
    expect(rec.handle?.imageRef).toBe(NEW);
    expect(rec.handle?.id).not.toBe(before.handle?.id);
    expect(target.fake.knownSnapshots.has(rec.handle!.id)).toBe(true);

    // The next wake restores the new disk: the file came along, and the disk now reports the new image.
    h.fake.knownSnapshots = target.fake.knownSnapshots;
    (h.fake as unknown as { diskBySnapshot: unknown }).diskBySnapshot = (
      target.fake as unknown as { diskBySnapshot: unknown }
    ).diskBySnapshot;
    expect(await runSpawn(h.newOp(), spawnReq)).toMatchObject({ ok: true });
    expect(h.fake.disk["/home/user/project/notes.md"]).toBe("work in progress");
    expect((await h.kv.get<OrbRecord>("orb"))!.imageRef).toBe(NEW);
  });

  it("leaves the old disk in place when the new image side fails", async () => {
    const { h } = await oldWorkspace();
    const before = (await h.kv.get<OrbRecord>("orb"))!;
    const r = await runRebuild(h.newOp(), {
      receive: async (tar) => {
        await tar.cancel();
        return { ok: false, error: "Failed: the new image did not start (timeout) — fix: retry" };
      },
    });
    expect(r.ok).toBe(false);
    const rec = (await h.kv.get<OrbRecord>("orb"))!;
    expect(rec.handle).toEqual(before.handle);
    expect(rec.state).toBe("paused");
    expect(h.fake.running).toBe(false);
    expect(h.registry.slots.size).toBe(0);
  });
});
