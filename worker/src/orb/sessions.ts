// The OpenCode sessions of a workspace, for `cf-opencode sessions`.
//
// OpenCode keeps sessions in the server that ran them, so a client lists one workspace at a time. This
// reads the list from a running workspace and keeps a copy in the Durable Object. The copy is refreshed
// before each pause, so a paused workspace answers from it and nothing is woken to list sessions.
import { workspacePassword } from "../auth";
import type { OrbContext } from "./context";
import { SESSIONS_SH } from "./scripts";
import { sh } from "./spawn";

export interface SessionSummary {
  id: string;
  title: string;
  /** Epoch ms. */
  created: number;
  updated: number;
  model?: string;
  directory?: string;
}

export interface SessionList {
  sessions: SessionSummary[];
  /** When the list was read from OpenCode. Absent when it never was. */
  at?: string;
  /** True when read from the running workspace for this answer. */
  live: boolean;
}

export const SESSIONS_KEY = "sessions";
export const MAX_SESSIONS = 50;
type Ctx = Pick<OrbContext, "container" | "kv" | "clock" | "config" | "env" | "workspaceId">;

/** The script prints OpenCode's `data` array from GET /api/session. Anything else is undefined. */
export function parseSessions(stdout: string): SessionSummary[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  const out: SessionSummary[] = [];
  for (const s of raw as Record<string, unknown>[]) {
    if (!s || typeof s.id !== "string") continue;
    const time = (s.time ?? {}) as Record<string, unknown>;
    const model = (s.model ?? {}) as Record<string, unknown>;
    const location = (s.location ?? {}) as Record<string, unknown>;
    const created = typeof time.created === "number" ? time.created : 0;
    out.push({
      id: s.id,
      title: typeof s.title === "string" && s.title ? s.title.slice(0, 200) : "(no title)",
      created,
      updated: typeof time.updated === "number" ? time.updated : created,
      ...(typeof model.id === "string" ? { model: model.id } : {}),
      ...(typeof location.directory === "string" ? { directory: location.directory } : {}),
    });
  }
  return out.sort((a, b) => b.updated - a.updated).slice(0, MAX_SESSIONS);
}

/** Read the list from the running workspace and keep it. undefined when OpenCode did not answer. */
export async function captureSessions(ctx: Ctx): Promise<SessionList | undefined> {
  if (!ctx.container.running || !ctx.env.CONTROL_TOKEN) return undefined;
  try {
    const [cmd, opts] = sh(SESSIONS_SH, {
      PORT: String(ctx.config.serverPort),
      LIMIT: String(MAX_SESSIONS),
      OPENCODE_SERVER_PASSWORD: await workspacePassword(ctx.env.CONTROL_TOKEN, ctx.workspaceId),
    });
    const r = await ctx.container.exec(cmd, { ...opts, timeoutMs: 15_000 });
    const sessions = r.exitCode === 0 ? parseSessions(r.stdout) : undefined;
    if (!sessions) return undefined;
    const at = new Date(ctx.clock.now()).toISOString();
    await ctx.kv.put(SESSIONS_KEY, { sessions, at });
    return { sessions, at, live: true };
  } catch {
    return undefined;
  }
}

/** The live list when the workspace runs, else the copy from its last pause. Wakes nothing. */
export async function readSessions(ctx: Ctx): Promise<SessionList> {
  const live = await captureSessions(ctx);
  if (live) return live;
  const saved = await ctx.kv.get<{ sessions: SessionSummary[]; at: string }>(SESSIONS_KEY);
  return saved ? { ...saved, live: false } : { sessions: [], live: false };
}
