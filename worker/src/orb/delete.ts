// Delete op: destroy the container, forget the workspace's disk and its project snapshot, mark it deleted.
// After a delete, the next connect boots the image and clones again: nothing of the old disk comes back.
// Cloudflare has no snapshot delete API, so the data stays until its 30-day TTL; nothing points at it.
import type { OpRequest } from "../core/types";
import { BROWSE_SESSIONS_KEY } from "./browse";
import type { OrbContext } from "./context";
import { iso, loadOrb, newOrbRecord, saveOrb } from "./journal";
import { SESSIONS_KEY } from "./sessions";
import { SSH_KEYS_KEY } from "./ssh-keys";

export async function runDelete(ctx: OrbContext, req?: Pick<OpRequest, "snapshotId">): Promise<{ ok: true }> {
  const { container, clock, kv, registry, orbId } = ctx;
  const now = () => iso(clock.now());
  const rec = (await loadOrb(kv)) ?? newOrbRecord(orbId, ctx.config, now());

  if (container.running) {
    await container.destroy();
    ctx.say("container destroyed");
  }
  if (rec.handle) ctx.say(`forgot orb disk snapshot ${rec.handle.id} (Cloudflare drops it after 30 d)`);
  rec.handle = undefined;
  rec.state = "deleted";
  rec.awakeSince = undefined;
  rec.warmUntil = undefined;
  rec.dirtySince = undefined;
  rec.bootstrapTokenSha = undefined;
  if (rec.deletedAt) ctx.say(`orb already deleted at ${rec.deletedAt}`);
  else {
    rec.deletedAt = now();
    rec.lastStop = { at: rec.deletedAt, reason: "deleted" };
  }
  await saveOrb(kv, rec, now());
  await kv.delete(SESSIONS_KEY);
  // A new workspace under this id starts with no SSH keys and no browser sessions of the old one.
  await kv.delete(SSH_KEYS_KEY);
  await kv.delete(BROWSE_SESSIONS_KEY);
  // The project snapshot is this workspace's disk under the checkout's name. Drop it only when this
  // workspace made it. The CLI names it snap-<workspace>.
  const snapshotId = req?.snapshotId ?? `snap-${orbId}`;
  try {
    const m = await registry.getProjectSnapshot(snapshotId);
    if (m && m.sourceWorkspaceId === orbId) {
      await registry.dropProjectSnapshot(snapshotId);
      ctx.say(`forgot project snapshot ${snapshotId}; the next connect starts from the image`);
    }
  } catch {
    // Not fatal: the workspace is deleted. A later connect may restore that snapshot.
  }
  // Not fatal: without the marker, prune keeps the orb's newest snapshot until its TTL.
  await registry.workspaceDeleted(orbId, now()).catch(() => undefined);
  await registry.releaseRunSlot(orbId);
  return { ok: true };
}
