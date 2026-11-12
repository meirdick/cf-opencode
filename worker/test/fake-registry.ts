// FakeRegistry: RegistryClient over Maps, for unit tests of any module that talks to the Registry DO.
// Also exports makeOrbCtx(): an OrbContext over FakeContainer/MemoryKV/FakeClock whose exec handler
// simulates the orb scripts (matched by script string identity) so bootstrap alive/connected can be driven.
import type { Clock, ExecOptions } from "../src/core/container-port";
import { projectKeyOf } from "../src/core/registry-core";
import {
  DEFAULT_CONFIG,
  JOB_DEADLINE_MS,
  type ProjectSnapshotMapping,
  type ProviderConfig,
  type RegistryClient,
  type SnapshotHandle,
  STALE_FORGET_INTERVAL_MS,
  type StaleMarkResult,
} from "../src/core/types";
import type { OrbContext } from "../src/orb/context";
import { ACTIVITY_SH, LOGTAIL_SH, QUIESCE_SH, SERVE_SH, STATUS_SH } from "../src/orb/scripts";
import { FakeClock, FakeContainer, MemoryKV } from "./fake-container";

export class FakeRegistry implements RegistryClient {
  projects = new Map<string, ProjectSnapshotMapping>();
  snapshots: { handle: SnapshotHandle; orbId: string }[] = [];
  /** orbId → last heartbeat (epoch ms) */
  slots = new Map<string, number>();
  /** project → last stale forget (ISO); same rate limit as RegistryCore */
  forgets = new Map<string, string>();
  calls: string[] = [];
  constructor(
    public max = 20,
    private clock: Clock = { now: () => Date.now(), sleep: async () => {} },
  ) {}
  async getProjectSnapshot(id: string) {
    this.calls.push(`get ${id}`);
    const m = this.projects.get(id);
    return m && !m.stale?.forgotten ? structuredClone(m) : undefined;
  }
  async markProjectSnapshotStale(id: string, reason: string, at: string): Promise<StaleMarkResult> {
    this.calls.push(`stale ${id}`);
    const m = this.projects.get(id);
    if (!m) return { forgotten: false, note: "no mapping" };
    if (m.stale?.forgotten) return { forgotten: false, note: `already forgotten at ${m.stale.at}` };
    const key = projectKeyOf(id);
    const last = this.forgets.get(key);
    if (last && Date.parse(at) - Date.parse(last) < STALE_FORGET_INTERVAL_MS) {
      m.stale = { reason, at: m.stale?.at ?? at, forgotten: false };
      return { forgotten: false, note: `kept: this project had a forget at ${last}` };
    }
    m.stale = { reason, at: m.stale?.at ?? at, forgotten: true };
    this.forgets.set(key, at);
    return { forgotten: true, note: "forgot the mapping" };
  }
  async projectSnapshotStale(id: string) {
    return this.projects.get(id)?.stale;
  }
  async putProjectSnapshot(m: ProjectSnapshotMapping) {
    this.calls.push(`put ${m.snapshotId}`);
    this.projects.set(m.snapshotId, structuredClone(m));
  }
  async touchProjectSnapshot(id: string, usedAt: string) {
    this.calls.push(`touch ${id}`);
    const m = this.projects.get(id);
    if (m) m.lastUsedAt = usedAt;
  }
  async dropProjectSnapshot(id: string) {
    this.calls.push(`drop ${id}`);
    this.projects.delete(id);
  }
  async recordSnapshot(handle: SnapshotHandle, orbId: string) {
    this.calls.push(`record ${handle.id}`);
    this.snapshots.push({ handle: structuredClone(handle), orbId });
  }
  async workspaceDeleted(orbId: string, at: string) {
    this.calls.push(`deleted ${orbId} ${at}`);
  }
  orbDeleted(orbId: string, at: string) {
    return this.workspaceDeleted(orbId, at);
  }
  async acquireRunSlot(orbId: string) {
    this.calls.push(`acquire ${orbId}`);
    if (this.slots.has(orbId) || this.slots.size < this.max) {
      this.slots.set(orbId, this.clock.now());
      return { ok: true, running: this.slots.size, max: this.max };
    }
    return { ok: false, running: this.slots.size, max: this.max };
  }
  async releaseRunSlot(orbId: string) {
    this.calls.push(`release ${orbId}`);
    this.slots.delete(orbId);
  }
  async heartbeat(orbId: string) {
    this.calls.push(`heartbeat ${orbId}`);
    this.slots.set(orbId, this.clock.now());
  }
}

/** Simulated `opencode serve` inside the fake container. */
export interface BootSim {
  /** bootId of the container where opencode serve is alive; undefined = not running */
  aliveBoot?: string;
  /** pid of the live server */
  pid: number;
  /** number of real (non-reuse) server launches */
  launches: number;
  /** lines LOGTAIL_SH returns (may hold secrets, to test redaction) */
  logLines: string[];
  /** env of every SERVE_SH exec */
  bootEnvs: Record<string, string>[];
  /** STATUS_SH "act" value (log bytes); bump it to simulate agent work */
  activity: number;
  /** STATUS_SH "use" value; bump it to simulate a client using a warm workspace */
  use: number;
  /** ACTIVITY_SH: what opencode reports when it gets this password, and the last pty output (epoch s) */
  agent: "busy" | "waiting" | "idle";
  agentPassword?: string;
  ptyAt: number;
}

export const STATE_FILE = "/home/user/.cf-opencode/server";

export function scriptHandler(sim: BootSim) {
  return (cmd: string[], opts: ExecOptions, fake: FakeContainer) => {
    const script = cmd[0] === "bash" && cmd[1] === "-c" ? cmd[2] : undefined;
    const env = opts.env ?? {};
    const alive = () => sim.aliveBoot === fake.bootId;
    if (script === SERVE_SH) {
      sim.bootEnvs.push({ ...env });
      if (alive()) return `already ${sim.pid}`;
      sim.launches++;
      sim.pid = 1000 + sim.launches;
      sim.aliveBoot = fake.bootId;
      fake.disk[STATE_FILE] = `${sim.pid} ${fake.bootId} ${env.PASSWORD_SHA}`;
      return `started ${sim.pid}`;
    }
    if (script === STATUS_SH)
      return `${alive() ? `alive ${sim.pid}` : "dead"}\nsha x boot current\nact ${sim.activity}\nuse ${sim.use}`;
    if (script === QUIESCE_SH) {
      const was = alive();
      sim.aliveBoot = undefined;
      return `${was ? `stopping opencode pid ${sim.pid}\n` : ""}quiesced; remaining opencode processes: 0`;
    }
    if (script === LOGTAIL_SH) return sim.logLines.join("\n");
    if (script === ACTIVITY_SH) {
      const ok =
        env.OPENCODE_SERVER_PASSWORD !== undefined && env.OPENCODE_SERVER_PASSWORD === sim.agentPassword;
      return `pty ${sim.ptyAt}\nagent ${alive() && ok ? sim.agent : "unknown"}`;
    }
    return { exitCode: 0, stdout: "" };
  };
}

/** MemoryKV that returns copies, like DO storage. A mutation without put() is lost, as in production. */
export class CopyingKV extends MemoryKV {
  override async get<T>(k: string) {
    const v = this.map.get(k);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
}

export interface OrbHarness {
  ctx: OrbContext;
  fake: FakeContainer;
  kv: CopyingKV;
  clock: FakeClock;
  registry: FakeRegistry;
  sim: BootSim;
  /** every say() line, in order (stands in for op progress and the DO log) */
  lines: string[];
  /** reset ctx.deadline to now + 4 min 30 s, as session.ts does per op */
  newOp(): OrbContext;
}

export function makeOrbCtx(
  opts: {
    orbId?: string;
    config?: Partial<ProviderConfig>;
    maxRunning?: number;
    images?: Record<string, string>;
  } = {},
): OrbHarness {
  const clock = new FakeClock();
  const fake = new FakeContainer(clock, opts.images);
  const kv = new CopyingKV();
  const registry = new FakeRegistry(opts.maxRunning ?? 20, clock);
  const sim: BootSim = {
    pid: 0,
    launches: 0,
    logLines: ["opencode server listening", "session started"],
    bootEnvs: [],
    activity: 0,
    use: 0,
    agent: "idle",
    ptyAt: 0,
  };
  fake.handler = scriptHandler(sim);
  const lines: string[] = [];
  const ctx: OrbContext = {
    workspaceId: opts.orbId ?? "ws-test",
    orbId: opts.orbId ?? "ws-test",
    container: fake,
    kv,
    clock,
    // warmMinutes 0: most tests cover the cold pause. Warm tests set it.
    config: { ...DEFAULT_CONFIG, warmMinutes: 0, ...opts.config },
    registry,
    env: {},
    say: (l) => lines.push(l),
    deadline: clock.now() + JOB_DEADLINE_MS,
  };
  return {
    ctx,
    fake,
    kv,
    clock,
    registry,
    sim,
    lines,
    newOp() {
      ctx.deadline = clock.now() + JOB_DEADLINE_MS;
      return ctx;
    },
  };
}
