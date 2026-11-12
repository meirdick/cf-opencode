// Shared types. Every module imports from here; nothing here imports runtime APIs.
//
// Forked from cf-orbs (Apache-2.0, Copyright 2026 Meir Dick) and narrowed to OpenCode
// workspaces.

/** Control-plane operations. The CLI and the plugin send these; OpenCode itself sends none. */
export type WorkspaceOp = "spawn" | "pause" | "delete" | "rebuild";

/**
 * Body of POST /v1/workspaces/:id/ops.
 * `password` is the OpenCode server password. It is never persisted; only its sha256 prefix is stored.
 */
export interface OpRequest {
  op: WorkspaceOp;
  /** Project snapshot id to boot from (spawn) or to save (pause). cf-opencode mints this; OpenCode has none. */
  snapshotId?: string;
  /** Image key (spawn only). Default "orb". */
  image?: string;
  /** OpenCode server password (spawn only). Never logged, never written to disk. */
  password?: string;
  /** Same value as password. Copied modules read token. */
  token?: string;
  /** Absolute project path inside the orb. Default /home/user/project. */
  directory?: string;
  /** Git remote to clone when no snapshot has the repo yet. */
  repoUrl?: string;
  /** Branch to check out after clone. */
  branch?: string;
  /** git user.name and user.email for commits in the workspace, from the client's own git config. */
  gitName?: string;
  gitEmail?: string;
  /** This Worker's origin. Set by the Worker from the request, never by the caller. */
  workerUrl?: string;
}

export type OpPhase = "queued" | "running" | "succeeded" | "failed";

/** Persisted op journal entry. Progress lines are what the CLI prints. */
export interface OpRecord {
  /** Schema version. Old and new Worker code share storage; a missing v reads as 1. */
  v?: 1;
  opId: string; // `${workspaceId}:${uuid}`
  workspaceId: string;
  /** Same value as workspaceId. Copied modules read orbId. */
  orbId: string;
  op: WorkspaceOp;
  inputsHash: string; // journal.hashInputs: sha256 of the op inputs, password by its sha → identical in-flight inputs share an op
  phase: OpPhase;
  startedAt: string; // ISO
  finishedAt?: string;
  progress: string[]; // human lines, redacted, max ~200
  error?: string; // one line: "<cause> — fix: <command>" when known
  result?: Record<string, unknown>;
}

/** @deprecated Use WorkspaceRecord. Kept so modules copied from cf-orbs compile. */
export type OrbRecord = WorkspaceRecord;
export type OrbState = WorkspaceState;

export type WorkspaceState =
  | "none" // never started
  | "starting"
  | "awake"
  | "pausing"
  | "warm" // paused: disk saved, container and opencode kept running until warmUntil
  | "paused" // snapshot handle valid
  | "paused-stale" // container stopped without a fresh snapshot; handle may be old
  | "lost" // container found not running while we thought it was awake
  | "deleted";

export interface SnapshotHandle {
  id: string; // Cloudflare snapshot id
  size: number; // bytes reported by snapshotContainer
  imageKey: string;
  instance: InstanceSpec;
  createdAt: string; // ISO
  lastRestoredAt?: string; // ISO; set on every successful restore. Expiry = max(createdAt, lastRestoredAt) + 30 d
  name?: string;
  /** Image ref the disk was first booted from. A restore keeps that image's tools; see rebuild. */
  imageRef?: string;
}

/** Where a spawn got its disk from. */
export type WakeSource = "warm" | "running" | "per-workspace-snapshot" | "project-snapshot" | "image";

/** One spawn op, kept in WorkspaceRecord.spawns. No secrets. */
export interface SpawnEntry {
  at: string; // ISO, when the spawn op started
  source?: WakeSource;
  ms: number;
  ok: boolean;
  error?: string;
}

/** WorkspaceRecord.spawns keeps this many entries, oldest first. */
export const SPAWN_HISTORY = 10;

/** Any Cloudflare Containers instance size. */
export type InstanceSpec =
  | "lite"
  | "standard-1"
  | "standard-2"
  | "standard-3"
  | "standard-4"
  | { vcpu: number; memoryMib: number; diskMb: number };

/** Per-workspace record in WorkspaceSession storage under key "workspace". */
export interface WorkspaceRecord {
  v?: 1;
  workspaceId: string;
  /** Same value as workspaceId. Copied modules read orbId; the stored key is "orb". */
  orbId: string;
  state: WorkspaceState;
  imageKey: string;
  instance: InstanceSpec;
  handle?: SnapshotHandle;
  /** First 16 hex of sha256(server password) for the running server. The password itself is never stored. */
  passwordSha?: string;
  /** Same value as passwordSha. Copied modules read bootstrapTokenSha. */
  bootstrapTokenSha?: string;
  /** Project path inside the orb. */
  directory?: string;
  /** Worker origin, written into the workspace so tools there (browse) can call back. */
  workerUrl?: string;
  awakeSince?: string;
  /** Image ref the running disk came from: the image it booted, or the restored snapshot's imageRef. */
  imageRef?: string;
  /** State warm: the alarm stops the container at this time (ISO). */
  warmUntil?: string;
  lastStop?: { at: string; reason: string };
  lastSpawnMs?: number;
  lastWakeSource?: WakeSource;
  spawns?: SpawnEntry[];
  deletedAt?: string;
  dirtySince?: string;
  updatedAt: string;
}

/** Why a project snapshot is out of date. */
export interface ProjectSnapshotStale {
  reason: string;
  at: string;
  /** true: spawn ignores the mapping. false: kept, because a forget for this project ran < 24 h ago. */
  forgotten: boolean;
}

/** Project snapshot mapping kept in the Registry DO. */
export interface ProjectSnapshotMapping {
  snapshotId: string;
  handle: SnapshotHandle;
  sourceWorkspaceId: string;
  createdAt: string;
  lastUsedAt: string;
  /** Deployed image ref the disk came from, at pause time. */
  imageRef?: string;
  /** `opencode --version` in the orb at pause time. */
  opencodeVersion?: string;
  stale?: ProjectSnapshotStale;
}

export interface StaleMarkResult {
  forgotten: boolean;
  note: string;
}

export type ProjectSnapshotRefresh = "off" | "on-change";

/** Install configuration, passed as the CF_OPENCODE_CONFIG Worker var. */
export interface ProviderConfig {
  instance: InstanceSpec;
  maxRunning: number;
  maxAwakeHours: number;
  checkpointMinutes: number;
  /** After a pause, keep the container and opencode running this long (disk saved first). 0 = stop at once. */
  warmMinutes: number;
  inactivityTimeoutMinutes: number;
  alarmSeconds: number;
  /** Extra image refs → image keys. The default image maps to "orb". */
  images: Record<string, string>;
  /** Port opencode serve listens on inside the container. */
  serverPort: number;
  /** Idle time with no proxied request before the alarm pauses the workspace. */
  idlePauseMinutes: number;
  projectSnapshotRefresh: ProjectSnapshotRefresh;
  /**
   * When true, the container has no general internet: only provider hosts whose
   * secret is set resolve. Default false, so a workspace can clone and install.
   * Provider-host interception is on either way, and is not configurable.
   */
  lockdown: boolean;
  /**
   * Models through the Worker's AI binding: Workers AI, and third-party models billed to the
   * account through AI Gateway. Off: OpenCode keeps only its own providers.
   */
  ai: boolean;
  /** AI Gateway the binding routes through. "default" is made on first use. */
  aiGateway: string;
  /** OpenCode's default model, provider/model. Empty: OpenCode chooses. */
  model: string;
  /** Web Search API provider for cf-opencode-search: exa, linkup or ceramic. */
  searchProvider: string;
  /**
   * A stopped workspace's snapshot expires 30 days after its creation or last restore. This many days before
   * that, the alarm restores it briefly (no opencode, no internet) to start a new 30 days. 0: let it expire.
   */
  snapshotRefreshDays: number;
  /** Serve the A2A Agent Card and JSON-RPC endpoint. Off by default: it is one more way to run code. */
  a2a: boolean;
  /**
   * https URL the Worker POSTs a handed-off task's result to when the task leaves running, and the notes of
   * cf-opencode-notify. Signed with a key derived from CONTROL_TOKEN. Empty: no push.
   */
  notifyUrl: string;
}

export const DEFAULT_CONFIG: ProviderConfig = {
  instance: { vcpu: 2, memoryMib: 6144, diskMb: 20000 },
  maxRunning: 10,
  maxAwakeHours: 12,
  checkpointMinutes: 0,
  warmMinutes: 10,
  inactivityTimeoutMinutes: 15,
  alarmSeconds: 60,
  images: {},
  serverPort: 4096,
  idlePauseMinutes: 20,
  projectSnapshotRefresh: "off",
  lockdown: false,
  ai: true,
  aiGateway: "default",
  // exa and linkup found the documentation pages for a technical query; ceramic did not (checked 2026-11-12).
  searchProvider: "exa",
  model: "cloudflare-workers-ai/@cf/zai-org/glm-5.3",
  snapshotRefreshDays: 3,
  a2a: false,
  notifyUrl: "",
};

export const SNAPSHOT_TTL_MS = 30 * 24 * 3600_000;
export const PROJECT_MAP_TTL_MS = 72 * 3600_000;
export const STALE_FORGET_INTERVAL_MS = 24 * 3600_000;
/** A spawn must finish inside this. The CLI's long poll gives up a little later. */
export const JOB_DEADLINE_MS = 4.5 * 60_000;

/** OpenCode server username. OpenCode 2 accepts only this username; the password is the secret. */
export const OPENCODE_USERNAME = "opencode";

/** Default project path inside the orb. The host path is not mirrored: Cloudflare orbs are Linux. */
export const DEFAULT_DIRECTORY = "/home/user/project";

/** Status returned by GET /v1/workspaces/:id. No secrets. */
export interface WorkspaceStatus {
  workspace: WorkspaceRecord;
  containerRunning: boolean;
  server?: { alive: boolean; pid?: number };
  inFlightOp?: Pick<OpRecord, "opId" | "op" | "phase" | "startedAt">;
  snapshotExpiresAt?: string;
  /** False when the disk came from an older image than the one deployed; rebuild moves it. Absent: unknown. */
  imageCurrent?: boolean;
}

/** What a session needs from the Registry DO. */
export interface RegistryClient {
  getProjectSnapshot(snapshotId: string): Promise<ProjectSnapshotMapping | undefined>;
  putProjectSnapshot(m: ProjectSnapshotMapping): Promise<void>;
  touchProjectSnapshot(snapshotId: string, usedAt: string): Promise<void>;
  dropProjectSnapshot(snapshotId: string): Promise<void>;
  markProjectSnapshotStale(snapshotId: string, reason: string, at: string): Promise<StaleMarkResult>;
  projectSnapshotStale(snapshotId: string): Promise<ProjectSnapshotStale | undefined>;
  recordSnapshot(handle: SnapshotHandle, workspaceId: string): Promise<void>;
  workspaceDeleted(workspaceId: string, at: string): Promise<void>;
  /** @deprecated Use workspaceDeleted. */
  orbDeleted(workspaceId: string, at: string): Promise<void>;
  acquireRunSlot(workspaceId: string): Promise<{ ok: boolean; running: number; max: number }>;
  releaseRunSlot(workspaceId: string): Promise<void>;
  heartbeat(workspaceId: string): Promise<void>;
}
