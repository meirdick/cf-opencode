// `cf-opencode sessions`: the OpenCode sessions of every workspace this machine connected to, in one list.
// OpenCode itself lists one server at a time, so this is the view across workspaces.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ControlClient, RemoteSession } from "./api.js";
import { readWorkspace, stateDir } from "./config.js";
import { toFailedLine } from "./errors.js";
import { fmtAge, table } from "./ui.js";

export interface SessionRow extends RemoteSession {
  workspace: string;
}

export interface SessionsResult {
  rows: SessionRow[];
  /** Per workspace: where its list came from. */
  workspaces: { id: string; live: boolean; at?: string; error?: string }[];
}

export function localWorkspaceIds(): string[] {
  try {
    return readdirSync(join(stateDir(), "workspaces"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter((id) => Boolean(readWorkspace(id)));
  } catch {
    return [];
  }
}

/** Ask each workspace for its sessions. Nothing is woken: a paused workspace answers from its last pause. */
export async function listSessions(client: ControlClient, ids: string[]): Promise<SessionsResult> {
  const answers = await Promise.all(
    ids.map(async (id) => {
      try {
        return { id, ...(await client.sessions(id)) };
      } catch (e) {
        return { id, sessions: [] as RemoteSession[], live: false, error: toFailedLine(e) };
      }
    }),
  );
  const rows = answers
    .flatMap((a) => a.sessions.map((s) => ({ ...s, workspace: a.id })))
    .sort((a, b) => b.updated - a.updated);
  const workspaces = answers.map((a) => ({
    id: a.id,
    live: a.live,
    ...("at" in a && a.at ? { at: a.at } : {}),
    ...("error" in a && a.error ? { error: a.error } : {}),
  }));
  return { rows, workspaces };
}

export function renderSessions(r: SessionsResult, now = Date.now()): string {
  if (r.workspaces.length === 0) return "No workspaces yet. In a git checkout: cf-opencode connect";
  const lines: string[] = [];
  if (r.rows.length === 0) lines.push("No sessions yet.");
  else {
    lines.push(
      table(
        ["WORKSPACE", "UPDATED", "SESSION", "TITLE"],
        r.rows.map((s) => [
          s.workspace,
          fmtAge(new Date(s.updated).toISOString(), now),
          s.id,
          s.title.length > 60 ? `${s.title.slice(0, 59)}…` : s.title,
        ]),
      ),
    );
    lines.push("", "Open one: cf-opencode connect <workspace> --session <session>");
  }
  const saved = r.workspaces.filter((w) => !w.live && w.at && !w.error);
  if (saved.length > 0)
    lines.push(
      `Not running, list from the last pause: ${saved.map((w) => `${w.id} (${fmtAge(w.at, now)})`).join(", ")}`,
    );
  const none = r.workspaces.filter((w) => !w.live && !w.at && !w.error);
  if (none.length > 0)
    lines.push(`No list saved yet (it is saved on each pause): ${none.map((w) => w.id).join(", ")}`);
  for (const w of r.workspaces.filter((x) => x.error)) lines.push(`! ${w.id}: ${w.error}`);
  return lines.join("\n");
}
