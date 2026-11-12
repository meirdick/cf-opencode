// Rebuild: move a workspace onto the deployed image and keep its files.
//
// A snapshot is the whole disk, so a restore keeps the tools of the image it first booted from, and Cloudflare
// snapshots cannot be carried to another image. Rebuild copies what is the user's (/home/user, plus the SSH
// host keys so ssh does not warn) out of the old disk into a container booted from the current image, in a
// second Durable Object, and snapshots that. Packages installed outside /home/user (apt) are not carried.
//
// Source side (runRebuild): restore or reuse the old disk, stop opencode, stream `tar c` out over RPC.
// Target side (receiveRebuild): boot the image with no internet, `tar x` the stream, snapshot, stop.
import type { InstanceSpec, SnapshotHandle } from "../core/types";
import type { OrbContext } from "./context";
import { errText, type Handle, iso, loadOrb, saveOrb } from "./journal";
import { QUIESCE_SH } from "./scripts";
import { beat, sh, waitReady } from "./spawn";

/** Paths carried, relative to /. The host keys keep the workspace's SSH identity. */
export const CARRY_SH = "cd / && exec tar -czf - home/user $(ls etc/ssh/ssh_host_* 2>/dev/null)";
export const UNPACK = ["tar", "-C", "/", "-xzf", "-"];

export interface RebuildTarget {
  receive(
    tar: ReadableStream<Uint8Array>,
    o: { workspaceId: string; instance: InstanceSpec },
  ): Promise<{ ok: true; handle: SnapshotHandle } | { ok: false; error: string }>;
}

export async function runRebuild(
  ctx: OrbContext,
  target: RebuildTarget,
): Promise<{ ok: boolean; error?: string }> {
  const { container, registry, kv, clock, workspaceId } = ctx;
  const rec = await loadOrb(kv);
  if (!rec || rec.deletedAt)
    return { ok: false, error: "Failed: no such workspace — fix: cf-opencode connect" };
  if (!container.running && !rec.handle) {
    return {
      ok: false,
      error: "Failed: this workspace has no disk to carry — fix: cf-opencode connect boots the new image",
    };
  }
  const wasRunning = container.running;
  let ok = false;
  try {
    if (!wasRunning) {
      const h = rec.handle as Handle;
      const slot = await registry.acquireRunSlot(workspaceId);
      if (!slot.ok) {
        return {
          ok: false,
          error: `Failed: ${slot.running}/${slot.max} workspaces running — fix: pause one, then retry`,
        };
      }
      ctx.say(`restoring the disk from ${h.createdAt} to copy it`);
      container.start({ source: { snapshotId: h.id }, instance: h.instance, enableInternet: false });
      const ready = await waitReady(ctx, 120_000);
      if (ready.kind !== "ready")
        return { ok: false, error: `Failed: the old disk did not start (${ready.kind}) — fix: retry` };
    } else {
      ctx.say("stopping opencode so the files hold still while they are copied");
      const [cmd, opts] = sh(QUIESCE_SH);
      await container.exec(cmd, { ...opts, timeoutMs: 60_000 });
    }
    await beat(ctx);
    const t0 = clock.now();
    const out = await container.execStream(["bash", "-c", CARRY_SH], { user: "0:0" });
    ctx.say("copying /home/user into a container on the current image");
    const got = await target.receive(out.stdout, { workspaceId, instance: rec.instance });
    const code = await out.exitCode.catch(() => -1);
    if (!got.ok) return { ok: false, error: got.error };
    if (code !== 0)
      return {
        ok: false,
        error: `Failed: tar on the old disk exited ${code} — fix: retry; the old disk is unchanged`,
      };
    await container.destroy();
    const at = iso(clock.now());
    const old = rec.handle?.id;
    // The target reports the image it booted. Not this Durable Object's own map: an instance from before the
    // deploy can still see the previous one for a few seconds (seen live).
    rec.handle = got.handle;
    rec.imageRef = got.handle.imageRef;
    rec.state = "paused";
    rec.lastStop = { at, reason: "rebuilt on the current image" };
    rec.awakeSince = undefined;
    rec.warmUntil = undefined;
    rec.bootstrapTokenSha = undefined;
    await saveOrb(kv, rec, at);
    await registry.recordSnapshot(rec.handle, workspaceId).catch(() => undefined);
    ok = true;
    ctx.say(
      `rebuilt in ${((clock.now() - t0) / 1000).toFixed(1)} s: ${Math.round(got.handle.size / 1e6)} MB${old ? `, replacing ${old}` : ""}; the next connect starts on the current image`,
    );
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: `Failed: rebuild failed: ${errText(e)} — fix: retry; the old disk is unchanged`,
    };
  } finally {
    // A disk restored only to copy it stops again; a running workspace that failed stays up (opencode starts
    // again on the next connect). The slot goes back whenever no container is left.
    if (!wasRunning && container.running) await container.destroy().catch(() => undefined);
    if (ok || !wasRunning) await registry.releaseRunSlot(workspaceId).catch(() => undefined);
  }
}

/** Target side, in its own Durable Object: boot the image, unpack the stream, snapshot, stop. */
export async function receiveRebuild(
  ctx: OrbContext,
  tar: ReadableStream<Uint8Array>,
  instance: InstanceSpec,
): Promise<{ ok: true; handle: SnapshotHandle } | { ok: false; error: string }> {
  const { container, registry, clock, workspaceId } = ctx;
  const image = safeImages(ctx).orb;
  if (!image) return { ok: false, error: "Failed: no image in this deploy — fix: cf-opencode upgrade" };
  const slot = await registry.acquireRunSlot(workspaceId);
  if (!slot.ok) {
    await tar.cancel().catch(() => undefined);
    return {
      ok: false,
      error: `Failed: ${slot.running}/${slot.max} workspaces running — fix: pause one, then retry`,
    };
  }
  try {
    if (container.running) await container.destroy();
    container.start({ source: { image }, instance, enableInternet: false });
    const ready = await waitReady(ctx, 120_000);
    if (ready.kind !== "ready") {
      await tar.cancel().catch(() => undefined);
      return { ok: false, error: `Failed: the new image did not start (${ready.kind}) — fix: retry` };
    }
    const p = await container.execStream(UNPACK, { user: "0:0", stdin: tar });
    await p.stdout.cancel().catch(() => undefined);
    const code = await p.exitCode;
    if (code !== 0)
      return { ok: false, error: `Failed: unpacking on the new image exited ${code} — fix: retry` };
    await container.exec(["sync"], { timeoutMs: 60_000 });
    const snap = await container.snapshot(`rebuild-${workspaceId}-${clock.now()}`);
    return {
      ok: true,
      handle: {
        id: snap.id,
        size: snap.size,
        imageKey: "orb",
        instance,
        createdAt: iso(clock.now()),
        name: `rebuild-${workspaceId}`,
        imageRef: image,
      },
    };
  } catch (e) {
    return { ok: false, error: `Failed: rebuild failed on the new image: ${errText(e)} — fix: retry` };
  } finally {
    if (container.running) await container.destroy().catch(() => undefined);
    await registry.releaseRunSlot(workspaceId).catch(() => undefined);
  }
}

function safeImages(ctx: OrbContext): Record<string, string> {
  try {
    return { ...ctx.container.images(), ...ctx.config.images };
  } catch {
    return {};
  }
}
