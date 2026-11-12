import { describe, expect, it } from "vitest";
import type { ControlClient, RemoteSessions } from "../src/api.js";
import { listSessions, renderSessions } from "../src/sessions.js";

const now = Date.parse("2026-11-12T12:00:00Z");
const ses = (id: string, minutesAgo: number, title = id) => ({
  id,
  title,
  created: now - minutesAgo * 60_000,
  updated: now - minutesAgo * 60_000,
});

function client(byWorkspace: Record<string, RemoteSessions | Error>): ControlClient {
  return {
    sessions: async (id: string) => {
      const v = byWorkspace[id];
      if (!v || v instanceof Error) throw v ?? new Error("Failed: unknown — fix: none");
      return v;
    },
  } as unknown as ControlClient;
}

describe("sessions", () => {
  it("merges every workspace into one list, newest first, and says where each list came from", async () => {
    const r = await listSessions(
      client({
        app: {
          live: true,
          at: "2026-11-12T12:00:00Z",
          sessions: [ses("ses_a1", 30), ses("ses_a2", 5, "Fix login")],
        },
        api: { live: false, at: "2026-11-12T10:00:00Z", sessions: [ses("ses_b1", 10)] },
        old: { live: false, sessions: [] },
        gone: new Error("Failed: cannot reach the Worker — fix: cf-opencode doctor"),
      }),
      ["app", "api", "old", "gone"],
    );
    expect(r.rows.map((s) => `${s.workspace}/${s.id}`)).toEqual(["app/ses_a2", "api/ses_b1", "app/ses_a1"]);

    const text = renderSessions(r, now);
    expect(text).toMatch(/^WORKSPACE\s+UPDATED\s+SESSION\s+TITLE/);
    expect(text).toMatch(/app\s+5m ago\s+ses_a2\s+Fix login/);
    expect(text).toContain("cf-opencode connect <workspace> --session <session>");
    expect(text).toContain("list from the last pause: api (2h ago)");
    expect(text).toContain("No list saved yet (it is saved on each pause): old");
    expect(text).toContain("! gone: Failed: cannot reach the Worker");
  });

  it("says so when there is nothing to show", async () => {
    expect(renderSessions({ rows: [], workspaces: [] })).toMatch(/No workspaces yet/);
    const r = await listSessions(client({ app: { live: true, sessions: [] } }), ["app"]);
    expect(renderSessions(r, now)).toMatch(/^No sessions yet\./);
  });
});
