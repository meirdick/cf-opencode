// Registry logic: project-snapshot map, index of every snapshot we created, running-workspace cap.
// Pure: storage and time are injected. registry.ts wraps it in the Registry DO.
// Keys:
//   "proj:<snapshotId>" → ProjectSnapshotMapping (project snapshot id → handle)
//   "snap:<id>"         → SnapshotIndexEntry (Cloudflare has no list/delete API; this is the only index)
//   "run:<workspaceId>"       → RunSlot (heartbeat set for maxRunning)
//   "gone:<workspaceId>"      → ISO time of the workspace's last delete (prune: its snapshots before that are not its disk)
//   "refresh:<project>" → StaleForget (last projectSnapshotRefresh forget of that project; rate limit)
import type { Clock, KV } from "./container-port";
import {
  PROJECT_MAP_TTL_MS,
  type ProjectSnapshotMapping,
  type ProjectSnapshotStale,
  type ProviderConfig,
  type RegistryClient,
  SNAPSHOT_TTL_MS,
  type SnapshotHandle,
  STALE_FORGET_INTERVAL_MS,
  type StaleMarkResult,
} from "./types";

/** Last stale forget of one project (rate limit for projectSnapshotRefresh). */
export interface StaleForget {
  at: string; // ISO
  snapshotId: string;
}

/** One project snapshot as `cf-opencode status` shows it. */
export interface ProjectSnapshotStatus {
  snapshotId: string;
  createdAt: string;
  lastUsedAt: string;
  opencodeVersion?: string;
  imageRef?: string;
  stale?: ProjectSnapshotStale;
  expired: boolean;
}

export interface SnapshotIndexEntry {
  handle: SnapshotHandle;
  workspaceId: string;
  createdAt: string; // ISO, from handle.createdAt
  /** Last successful restore we know of. Each restore refreshes Cloudflare's 30-day TTL. */
  lastRestoredAt?: string;
}

export interface RunSlot {
  since: string; // ISO
  lastBeat: string; // ISO
}

export interface RunSlotResult {
  ok: boolean;
  running: number;
  max: number;
  /** Set when ok is false. One line, safe to print in the setup log. */
  error?: string;
}

export interface RegistrySummary {
  /** Mappings that a spawn can use: used in the last 72 h and not forgotten as stale. */
  projectSnapshots: number;
  /** Every stored mapping (stale ones too), most recently used first. */
  projects: ProjectSnapshotStatus[];
  /** Snapshots in the index that have not passed their 30-day TTL. */
  retainedSnapshots: number;
  /** Sum of reported sizes. Each size is the delta of that snapshot, so this is what Cloudflare stores. */
  retainedSnapshotBytes: number;
  running: string[];
  max: number;
  /** Earliest expiry among retained snapshots (ISO), or null when none are retained. */
  nextExpiry: string | null;
  /** Snapshots `cf-opencode snapshots prune` would delete with the default age (PRUNE_DEFAULT_AGE_MS). */
  prunableSnapshots: number;
  prunableSnapshotBytes: number;
}

/** A snapshot that `cf-opencode snapshots prune` may delete. */
export interface PruneCandidate {
  id: string;
  workspaceId: string;
  imageKey: string;
  bytes: number;
  createdAt: string;
  lastRestoredAt?: string;
  /** max(createdAt, lastRestoredAt): the age gate counts from here. */
  lastUsedAt: string;
}

export interface PruneResult {
  olderThanMs: number;
  candidates: PruneCandidate[];
  totalBytes: number;
  /** Retained snapshots that are not candidates, by reason. */
  kept: { mapped: number; current: number; young: number };
}

export interface ForgetResult {
  forgotten: string[];
  /** Ids a live project mapping still uses. Never forgotten. */
  mapped: string[];
}

/** A project mapping as `cf-opencode snapshots list` shows it. */
export interface ProjectSnapshotRow extends ProjectSnapshotMapping {
  /** When the mapping stops being used: min(lastUsedAt + 72 h, handle expiry). */
  expiresAt: string;
  /** True when spawn would ignore it (GC drops it on the next daily run). */
  expired: boolean;
}

export interface GcResult {
  projects: number;
  snapshots: number;
  running: number;
}

export const PROJ = "proj:";
export const SNAP = "snap:";
export const RUN = "run:";
export const GONE = "gone:";

/** `cf-opencode snapshots prune` default: a snapshot unused for 7 days. */
export const PRUNE_DEFAULT_AGE_MS = 7 * 24 * 3600_000;

export const REFRESH = "refresh:";

/**
 * Project part of an project snapshot id. Callers name them `snap-<project>-<hash>` (M0: snap-f3851194-…-5479269c)
 * and names a new one every 72 h, so the rate limit keys on the project. Other shapes: the whole id.
 */
export function projectKeyOf(snapshotId: string): string {
  return /^snap-(.+)-[0-9a-f]{6,}$/.exec(snapshotId)?.[1] ?? snapshotId;
}

export function runCapMessage(running: number, max: number): string {
  return `Failed: ${running}/${max} workspaces already running — fix: pause an idle workspace, or raise maxRunning in ~/.cf-opencode/config.json and run cf-opencode upgrade`;
}

/** Expiry of a snapshot: 30 days after max(createdAt, lastRestoredAt). */
export function snapshotExpiresAt(createdAt: string, lastRestoredAt?: string): number {
  const c = Date.parse(createdAt);
  const r = lastRestoredAt ? Date.parse(lastRestoredAt) : Number.NaN;
  return Math.max(c, Number.isNaN(r) ? c : r) + SNAPSHOT_TTL_MS;
}

/** Same rule as getProjectSnapshot: a mapping spawn would still use. */
function mappingLive(m: ProjectSnapshotMapping, idx: SnapshotIndexEntry | undefined, now: number): boolean {
  if (m.stale?.forgotten) return false; // projectSnapshotRefresh forgot it: spawn no longer uses it
  if (now - Date.parse(m.lastUsedAt) > PROJECT_MAP_TTL_MS) return false;
  return now < snapshotExpiresAt(m.handle.createdAt, idx?.lastRestoredAt);
}

/**
 * Pure prune selection. A retained snapshot is a candidate unless:
 * - a live project mapping uses it (mapped);
 * - it is the newest snapshot of its workspace and the workspace was not deleted after it (current). A workspace's handle is
 *   always its own newest snapshot: pause and checkpoint save the handle before they add it to the index,
 *   and a restore keeps the same handle. So an older snapshot of the same workspace is never its disk again;
 * - it was used less than olderThanMs ago (young).
 */
export function selectPruneCandidates(
  snaps: Iterable<SnapshotIndexEntry>,
  projs: Iterable<ProjectSnapshotMapping>,
  gone: ReadonlyMap<string, string>,
  now: number,
  olderThanMs: number,
): PruneResult {
  const all = [...snaps];
  const byId = new Map(all.map((e) => [e.handle.id, e]));
  const mapped = new Set<string>();
  for (const m of projs) if (mappingLive(m, byId.get(m.handle.id), now)) mapped.add(m.handle.id);
  const newest = new Map<string, number>();
  for (const e of all)
    newest.set(e.workspaceId, Math.max(newest.get(e.workspaceId) ?? -Infinity, Date.parse(e.createdAt)));
  const res: PruneResult = {
    olderThanMs,
    candidates: [],
    totalBytes: 0,
    kept: { mapped: 0, current: 0, young: 0 },
  };
  for (const e of all) {
    if (now >= snapshotExpiresAt(e.createdAt, e.lastRestoredAt)) continue; // Cloudflare dropped it already
    const id = e.handle.id;
    if (mapped.has(id)) {
      res.kept.mapped++;
      continue;
    }
    const created = Date.parse(e.createdAt);
    const goneAt = gone.get(e.workspaceId);
    const deletedAfter = goneAt !== undefined && Date.parse(goneAt) >= created;
    if (created >= (newest.get(e.workspaceId) ?? -Infinity) && !deletedAfter) {
      res.kept.current++;
      continue;
    }
    const lastUsedAt = laterIso(e.createdAt, e.lastRestoredAt) ?? e.createdAt;
    if (now - Date.parse(lastUsedAt) < olderThanMs) {
      res.kept.young++;
      continue;
    }
    const bytes = e.handle.size || 0;
    res.candidates.push({
      id,
      workspaceId: e.workspaceId,
      imageKey: e.handle.imageKey,
      bytes,
      createdAt: e.createdAt,
      ...(e.lastRestoredAt ? { lastRestoredAt: e.lastRestoredAt } : {}),
      lastUsedAt,
    });
    res.totalBytes += bytes;
  }
  res.candidates.sort((a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt));
  return res;
}

function laterIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

export class RegistryCore implements RegistryClient {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private kv: KV,
    private clock: Clock,
    private config: Pick<ProviderConfig, "maxRunning" | "alarmSeconds">,
  ) {}

  /** Serialize mutations; DO storage gates do not cover read-modify-write across several awaits in all cases. */
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private staleMs(): number {
    return 3 * this.config.alarmSeconds * 1000;
  }

  private isStale(slot: RunSlot, now: number): boolean {
    return now - Date.parse(slot.lastBeat) > this.staleMs();
  }

  // ---- project snapshots ----

  async getProjectSnapshot(snapshotId: string): Promise<ProjectSnapshotMapping | undefined> {
    const m = await this.kv.get<ProjectSnapshotMapping>(PROJ + snapshotId);
    if (!m || m.stale?.forgotten) return undefined;
    const now = this.clock.now();
    if (now - Date.parse(m.lastUsedAt) > PROJECT_MAP_TTL_MS) return undefined;
    const idx = await this.kv.get<SnapshotIndexEntry>(SNAP + m.handle.id);
    if (now >= snapshotExpiresAt(m.handle.createdAt, idx?.lastRestoredAt)) return undefined;
    return m;
  }

  putProjectSnapshot(m: ProjectSnapshotMapping): Promise<void> {
    return this.lock(async () => {
      await this.kv.put(PROJ + m.snapshotId, m);
      await this.upsertIndex(m.handle, m.sourceWorkspaceId);
    });
  }

  /** Called after a successful restore from a project snapshot. Also refreshes the handle's TTL in the index. */
  touchProjectSnapshot(snapshotId: string, usedAt: string): Promise<void> {
    return this.lock(async () => {
      const m = await this.kv.get<ProjectSnapshotMapping>(PROJ + snapshotId);
      if (!m) return;
      m.lastUsedAt = laterIso(m.lastUsedAt, usedAt) ?? usedAt;
      await this.kv.put(PROJ + snapshotId, m);
      const idx = await this.kv.get<SnapshotIndexEntry>(SNAP + m.handle.id);
      if (idx) {
        idx.lastRestoredAt = laterIso(idx.lastRestoredAt, usedAt);
        await this.kv.put(SNAP + m.handle.id, idx);
      }
    });
  }

  /** Forget the mapping. The snapshot stays in the index: Cloudflare keeps the data until its TTL. */
  dropProjectSnapshot(snapshotId: string): Promise<void> {
    return this.lock(async () => {
      await this.kv.delete(PROJ + snapshotId);
    });
  }

  /**
   * projectSnapshotRefresh: mark a mapping stale. Forget it (spawn ignores it from now on) unless a forget for the
   * same project ran less than 24 h ago; then keep it usable and say so. The mapping record stays for status and
   * GC drops it as usual (72 h unused). A new pause with this id writes a fresh mapping and clears the mark.
   */
  markProjectSnapshotStale(snapshotId: string, reason: string, at: string): Promise<StaleMarkResult> {
    return this.lock(async () => {
      const m = await this.kv.get<ProjectSnapshotMapping>(PROJ + snapshotId);
      if (!m) return { forgotten: false, note: "no mapping (forgotten or dropped already)" };
      if (m.stale?.forgotten) return { forgotten: false, note: `already forgotten at ${m.stale.at}` };
      const key = REFRESH + projectKeyOf(snapshotId);
      const last = await this.kv.get<StaleForget>(key);
      const now = Date.parse(at);
      if (last && now - Date.parse(last.at) < STALE_FORGET_INTERVAL_MS) {
        m.stale = { reason, at: m.stale?.at ?? at, forgotten: false };
        await this.kv.put(PROJ + snapshotId, m);
        const next = new Date(Date.parse(last.at) + STALE_FORGET_INTERVAL_MS).toISOString();
        return {
          forgotten: false,
          note: `kept: this project had a forget at ${last.at} (at most one per 24 h; next after ${next})`,
        };
      }
      m.stale = { reason, at: m.stale?.at ?? at, forgotten: true };
      await this.kv.put(PROJ + snapshotId, m);
      await this.kv.put<StaleForget>(key, { at, snapshotId });
      return { forgotten: true, note: "forgot the mapping; Cloudflare keeps the data until its TTL" };
    });
  }

  async projectSnapshotStale(snapshotId: string): Promise<ProjectSnapshotStale | undefined> {
    return (await this.kv.get<ProjectSnapshotMapping>(PROJ + snapshotId))?.stale;
  }

  /** Every stored mapping, expired ones too (GC has not run yet), most recently used first. */
  async listProjectSnapshots(): Promise<ProjectSnapshotRow[]> {
    const now = this.clock.now();
    const [projs, snaps] = await Promise.all([
      this.kv.list<ProjectSnapshotMapping>(PROJ),
      this.kv.list<SnapshotIndexEntry>(SNAP),
    ]);
    return [...projs.values()]
      .map((m) => {
        const idx = snaps.get(SNAP + m.handle.id);
        const unusedAt = Date.parse(m.lastUsedAt) + PROJECT_MAP_TTL_MS;
        const handleAt = snapshotExpiresAt(m.handle.createdAt, idx?.lastRestoredAt);
        // Same rule as getProjectSnapshot.
        const expired = now > unusedAt || now >= handleAt;
        return { ...m, expiresAt: new Date(Math.min(unusedAt, handleAt)).toISOString(), expired };
      })
      .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
  }

  /**
   * Operator forget (`cf-opencode snapshots forget`). Same as dropProjectSnapshot, but says whether a mapping
   * was there. The next spawn with this id boots the image and clones the repo again.
   */
  forgetProjectSnapshot(snapshotId: string): Promise<boolean> {
    return this.lock(async () => {
      const had = (await this.kv.get<ProjectSnapshotMapping>(PROJ + snapshotId)) !== undefined;
      if (had) await this.kv.delete(PROJ + snapshotId);
      return had;
    });
  }

  // ---- snapshot index ----

  /**
   * Upsert. A second call with the same id keeps the first createdAt and workspaceId and takes a later
   * `lastRestoredAt` from the handle when present (session modules pass the handle after a restore).
   */
  recordSnapshot(handle: SnapshotHandle, workspaceId: string): Promise<void> {
    return this.lock(() => this.upsertIndex(handle, workspaceId));
  }

  private async upsertIndex(handle: SnapshotHandle, workspaceId: string): Promise<void> {
    const restored = handle.lastRestoredAt;
    const prev = await this.kv.get<SnapshotIndexEntry>(SNAP + handle.id);
    const entry: SnapshotIndexEntry = prev
      ? { ...prev, lastRestoredAt: laterIso(prev.lastRestoredAt, restored) }
      : {
          handle,
          workspaceId,
          createdAt: handle.createdAt,
          ...(restored ? { lastRestoredAt: restored } : {}),
        };
    if (entry.lastRestoredAt === undefined) delete entry.lastRestoredAt;
    await this.kv.put(SNAP + handle.id, entry);
  }

  /** Index entries with their expiry, oldest expiry first. */
  async listSnapshots(): Promise<Array<SnapshotIndexEntry & { expiresAt: string; expired: boolean }>> {
    const now = this.clock.now();
    const all = await this.kv.list<SnapshotIndexEntry>(SNAP);
    return [...all.values()]
      .map((e) => {
        const exp = snapshotExpiresAt(e.createdAt, e.lastRestoredAt);
        return { ...e, expiresAt: new Date(exp).toISOString(), expired: now >= exp };
      })
      .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
  }

  // ---- prune (`cf-opencode snapshots prune`) ----

  async pruneCandidates(olderThanMs: number = PRUNE_DEFAULT_AGE_MS): Promise<PruneResult> {
    const [snaps, projs, gone] = await Promise.all([
      this.kv.list<SnapshotIndexEntry>(SNAP),
      this.kv.list<ProjectSnapshotMapping>(PROJ),
      this.kv.list<string>(GONE),
    ]);
    const goneByOrb = new Map([...gone].map(([k, v]) => [k.slice(GONE.length), v]));
    return selectPruneCandidates(snaps.values(), projs.values(), goneByOrb, this.clock.now(), olderThanMs);
  }

  /**
   * Drop index entries after `cf-opencode snapshots prune` deleted their data. An id that a live project
   * mapping uses is never dropped (returned in `mapped`). Unknown ids are skipped.
   */
  forgetSnapshots(ids: string[]): Promise<ForgetResult> {
    return this.lock(async () => {
      const now = this.clock.now();
      const projs = await this.kv.list<ProjectSnapshotMapping>(PROJ);
      const res: ForgetResult = { forgotten: [], mapped: [] };
      const live = new Set<string>();
      for (const m of projs.values()) {
        const idx = await this.kv.get<SnapshotIndexEntry>(SNAP + m.handle.id);
        if (mappingLive(m, idx, now)) live.add(m.handle.id);
      }
      for (const id of new Set(ids)) {
        if (live.has(id)) res.mapped.push(id);
        else if ((await this.kv.get<SnapshotIndexEntry>(SNAP + id)) !== undefined) {
          await this.kv.delete(SNAP + id);
          res.forgotten.push(id);
        }
      }
      return res;
    });
  }

  /** Delete op: the workspace has no disk from `at` on. Its snapshots created before `at` can be pruned. */
  /** @deprecated Use workspaceDeleted. */
  orbDeleted(workspaceId: string, at: string): Promise<void> {
    return this.workspaceDeleted(workspaceId, at);
  }

  workspaceDeleted(workspaceId: string, at: string): Promise<void> {
    return this.lock(async () => {
      const prev = await this.kv.get<string>(GONE + workspaceId);
      await this.kv.put(GONE + workspaceId, laterIso(prev, at) ?? at);
    });
  }

  // ---- running cap ----

  acquireRunSlot(workspaceId: string): Promise<RunSlotResult> {
    return this.lock(async () => {
      const now = this.clock.now();
      const live = await this.liveSlots(now);
      const max = this.config.maxRunning;
      const mine = live.get(workspaceId);
      if (mine) {
        mine.lastBeat = new Date(now).toISOString();
        await this.kv.put(RUN + workspaceId, mine);
        return { ok: true, running: live.size, max };
      }
      if (live.size >= max)
        return { ok: false, running: live.size, max, error: runCapMessage(live.size, max) };
      const iso = new Date(now).toISOString();
      await this.kv.put<RunSlot>(RUN + workspaceId, { since: iso, lastBeat: iso });
      return { ok: true, running: live.size + 1, max };
    });
  }

  releaseRunSlot(workspaceId: string): Promise<void> {
    return this.lock(async () => {
      await this.kv.delete(RUN + workspaceId);
    });
  }

  /** Refresh the slot. An awake workspace whose slot was dropped (stale) gets it back, even over the cap. */
  heartbeat(workspaceId: string): Promise<void> {
    return this.lock(async () => {
      const iso = this.nowIso();
      const slot = await this.kv.get<RunSlot>(RUN + workspaceId);
      await this.kv.put<RunSlot>(
        RUN + workspaceId,
        slot ? { ...slot, lastBeat: iso } : { since: iso, lastBeat: iso },
      );
    });
  }

  /** Live slots; stale ones are deleted. */
  private async liveSlots(now: number): Promise<Map<string, RunSlot>> {
    const all = await this.kv.list<RunSlot>(RUN);
    const live = new Map<string, RunSlot>();
    for (const [k, slot] of all) {
      if (this.isStale(slot, now)) await this.kv.delete(k);
      else live.set(k.slice(RUN.length), slot);
    }
    return live;
  }

  // ---- maintenance ----

  /** Drop project maps unused > 72 h (or whose handle expired), snapshots past their TTL, stale run slots. */
  gc(nowIso: string): Promise<GcResult> {
    return this.lock(async () => {
      const now = Date.parse(nowIso);
      const res: GcResult = { projects: 0, snapshots: 0, running: 0 };
      const snaps = await this.kv.list<SnapshotIndexEntry>(SNAP);
      const projs = await this.kv.list<ProjectSnapshotMapping>(PROJ);
      for (const [k, m] of projs) {
        const idx = snaps.get(SNAP + m.handle.id);
        const handleExpired = now >= snapshotExpiresAt(m.handle.createdAt, idx?.lastRestoredAt);
        if (now - Date.parse(m.lastUsedAt) > PROJECT_MAP_TTL_MS || handleExpired) {
          await this.kv.delete(k);
          res.projects++;
        }
      }
      for (const [k, e] of snaps) {
        if (now >= snapshotExpiresAt(e.createdAt, e.lastRestoredAt)) {
          await this.kv.delete(k);
          res.snapshots++;
        }
      }
      const runs = await this.kv.list<RunSlot>(RUN);
      for (const [k, slot] of runs) {
        if (this.isStale(slot, now)) {
          await this.kv.delete(k);
          res.running++;
        }
      }
      // A delete marker matters only while snapshots from before it can be retained (30 d, longer if restored).
      const gone = await this.kv.list<string>(GONE);
      const left = await this.kv.list<SnapshotIndexEntry>(SNAP);
      const workspacesWithSnaps = new Set([...left.values()].map((e) => e.workspaceId));
      for (const [k, at] of gone) {
        if (now - Date.parse(at) > SNAPSHOT_TTL_MS && !workspacesWithSnaps.has(k.slice(GONE.length)))
          await this.kv.delete(k);
      }
      const refresh = await this.kv.list<StaleForget>(REFRESH);
      for (const [k, f] of refresh) {
        if (now - Date.parse(f.at) >= STALE_FORGET_INTERVAL_MS) await this.kv.delete(k);
      }
      return res;
    });
  }

  async summary(): Promise<RegistrySummary> {
    const now = this.clock.now();
    const [projs, snaps, runs, prune] = await Promise.all([
      this.kv.list<ProjectSnapshotMapping>(PROJ),
      this.listSnapshots(),
      this.kv.list<RunSlot>(RUN),
      this.pruneCandidates(PRUNE_DEFAULT_AGE_MS),
    ]);
    const retained = snaps.filter((s) => !s.expired);
    const projectSnapshots = [...projs.values()].filter(
      (m) => now - Date.parse(m.lastUsedAt) <= PROJECT_MAP_TTL_MS && !m.stale?.forgotten,
    ).length;
    const projects: ProjectSnapshotStatus[] = [...projs.values()]
      .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))
      .map((m) => ({
        snapshotId: m.snapshotId,
        createdAt: m.createdAt,
        lastUsedAt: m.lastUsedAt,
        ...(m.opencodeVersion ? { opencodeVersion: m.opencodeVersion } : {}),
        ...(m.imageRef ? { imageRef: m.imageRef } : {}),
        ...(m.stale ? { stale: m.stale } : {}),
        expired: now - Date.parse(m.lastUsedAt) > PROJECT_MAP_TTL_MS,
      }));
    return {
      projectSnapshots,
      projects,
      retainedSnapshots: retained.length,
      retainedSnapshotBytes: retained.reduce((n, s) => n + (s.handle.size || 0), 0),
      running: [...runs]
        .filter(([, s]) => !this.isStale(s, now))
        .map(([k]) => k.slice(RUN.length))
        .sort(),
      max: this.config.maxRunning,
      nextExpiry: retained[0]?.expiresAt ?? null,
      prunableSnapshots: prune.candidates.length,
      prunableSnapshotBytes: prune.totalBytes,
    };
  }
}
