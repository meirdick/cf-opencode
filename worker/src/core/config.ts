// Parse CF_OPENCODE_CONFIG. Missing fields take defaults. A bad value fails the install, not a workspace.
import { DEFAULT_CONFIG, type InstanceSpec, type ProviderConfig } from "./types";

const VCPU = [1, 2, 3, 4] as const;

export function parseConfig(raw: string | undefined): ProviderConfig {
  if (!raw || raw.trim() === "") return structuredClone(DEFAULT_CONFIG);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "Failed: CF_OPENCODE_CONFIG is not JSON — fix: set it in ~/.cf-opencode/config.json, then cf-opencode upgrade",
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      "Failed: CF_OPENCODE_CONFIG must be an object — fix: set it in ~/.cf-opencode/config.json, then cf-opencode upgrade",
    );
  }
  const o = parsed as Record<string, unknown>;
  const cfg: ProviderConfig = { ...structuredClone(DEFAULT_CONFIG), ...pick(o) };
  cfg.instance = parseInstance(o.instance) ?? cfg.instance;
  checkRange(cfg, "maxRunning", 1, 100);
  checkRange(cfg, "maxAwakeHours", 1, 168);
  checkRange(cfg, "warmMinutes", 0, 24 * 60);
  checkRange(cfg, "inactivityTimeoutMinutes", 1, 24 * 60);
  checkRange(cfg, "alarmSeconds", 10, 3600);
  checkRange(cfg, "serverPort", 1, 65535);
  checkRange(cfg, "idlePauseMinutes", 1, 24 * 60);
  checkRange(cfg, "checkpointMinutes", 0, 24 * 60);
  checkRange(cfg, "snapshotRefreshDays", 0, 29);
  // The alarm is the keep-alive. A longer interval than the platform's inactivity timeout
  // lets the platform stop an awake container between two alarms.
  if (cfg.alarmSeconds >= cfg.inactivityTimeoutMinutes * 60) {
    throw new Error(
      `Failed: alarmSeconds ${cfg.alarmSeconds} must be shorter than inactivityTimeoutMinutes — fix: set it in ~/.cf-opencode/config.json, then cf-opencode upgrade`,
    );
  }
  if (cfg.projectSnapshotRefresh !== "off" && cfg.projectSnapshotRefresh !== "on-change") {
    throw new Error(
      "Failed: projectSnapshotRefresh must be off or on-change — fix: set it in ~/.cf-opencode/config.json, then cf-opencode upgrade",
    );
  }
  if (typeof cfg.ai !== "boolean") {
    throw new Error(
      "Failed: ai must be true or false — fix: set it in ~/.cf-opencode/config.json, then cf-opencode upgrade",
    );
  }
  if (typeof cfg.searchProvider !== "string" || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(cfg.searchProvider)) {
    throw new Error(
      "Failed: searchProvider must be a provider name such as exa — fix: set it in ~/.cf-opencode/config.json, then cf-opencode upgrade",
    );
  }
  if (typeof cfg.aiGateway !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(cfg.aiGateway)) {
    throw new Error(
      "Failed: aiGateway must be a gateway name such as default — fix: set it in ~/.cf-opencode/config.json, then cf-opencode upgrade",
    );
  }
  if (typeof cfg.model !== "string" || (cfg.model !== "" && !cfg.model.includes("/"))) {
    throw new Error(
      "Failed: model must be provider/model, or empty — fix: set it in ~/.cf-opencode/config.json, then cf-opencode upgrade",
    );
  }
  if (typeof cfg.lockdown !== "boolean") {
    throw new Error(
      "Failed: lockdown must be true or false — fix: set it in ~/.cf-opencode/config.json, then cf-opencode upgrade",
    );
  }
  return cfg;
}

function pick(o: Record<string, unknown>): Partial<ProviderConfig> {
  const out: Partial<ProviderConfig> = {};
  for (const key of [
    "maxRunning",
    "maxAwakeHours",
    "checkpointMinutes",
    "warmMinutes",
    "inactivityTimeoutMinutes",
    "alarmSeconds",
    "serverPort",
    "idlePauseMinutes",
    "snapshotRefreshDays",
  ] as const) {
    if (o[key] !== undefined) out[key] = num(key, o[key]);
  }
  if (typeof o.projectSnapshotRefresh === "string")
    out.projectSnapshotRefresh = o.projectSnapshotRefresh as never;
  if (o.images && typeof o.images === "object") out.images = o.images as Record<string, string>;
  if (o.lockdown !== undefined) out.lockdown = o.lockdown as boolean;
  if (o.ai !== undefined) out.ai = o.ai as boolean;
  if (o.aiGateway !== undefined) out.aiGateway = o.aiGateway as string;
  if (o.model !== undefined) out.model = o.model as string;
  if (o.searchProvider !== undefined) out.searchProvider = o.searchProvider as string;
  return out;
}

function parseInstance(v: unknown): InstanceSpec | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") {
    if (v === "lite" || /^standard-[1-4]$/.test(v)) return v as InstanceSpec;
    throw new Error(
      `Failed: instance ${JSON.stringify(v)} is not a container size — fix: use standard-1, standard-2, standard-3 or standard-4`,
    );
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const vcpu = num("instance.vcpu", o.vcpu);
    if (!(VCPU as readonly number[]).includes(vcpu)) {
      throw new Error(
        "Failed: instance.vcpu must be 1, 2, 3 or 4 — fix: set it in ~/.cf-opencode/config.json, then cf-opencode upgrade",
      );
    }
    return {
      vcpu,
      memoryMib: num("instance.memoryMib", o.memoryMib),
      diskMb: num("instance.diskMb", o.diskMb),
    };
  }
  throw new Error("Failed: instance must be a size name or { vcpu, memoryMib, diskMb }");
}

function num(name: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(
      `Failed: ${name} must be a number — fix: set it in ~/.cf-opencode/config.json, then cf-opencode upgrade`,
    );
  }
  return v;
}

function checkRange(cfg: ProviderConfig, key: keyof ProviderConfig, min: number, max: number): void {
  const v = cfg[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(
      `Failed: ${key} must be an integer from ${min} to ${max} — fix: set it in ~/.cf-opencode/config.json, then cf-opencode upgrade`,
    );
  }
}
