import { describe, expect, it } from "vitest";
import type { OpRequest } from "../src/core/types";
import { runPause } from "../src/orb/pause";
import { SESSIONS_SH } from "../src/orb/scripts";
import { parseSessions, readSessions } from "../src/orb/sessions";
import { runSpawn } from "../src/orb/spawn";
import { makeOrbCtx, type OrbHarness } from "./fake-registry";

const spawnReq: OpRequest = { op: "spawn", password: "tok-123456" };
const raw = (id: string, updated: number, title = `title ${id}`) => ({
  id,
  title,
  time: { created: updated - 10, updated },
  model: { id: "@cf/zai-org/glm-5.3", providerID: "cloudflare-workers-ai" },
  location: { directory: "/home/user/project" },
});

/** OpenCode in the fake container answers the session script with these. */
function withSessions(h: OrbHarness, list: () => unknown) {
  h.ctx.env.CONTROL_TOKEN = "control";
  const inner = h.fake.handler;
  const seen: Record<string, string>[] = [];
  h.fake.handler = (cmd, opts, fake) => {
    if (cmd[2] !== SESSIONS_SH) return inner(cmd, opts, fake);
    seen.push({ ...(opts.env ?? {}) });
    return JSON.stringify(list());
  };
  return seen;
}

describe("parseSessions", () => {
  it("keeps id, title, times, model and directory, newest first", () => {
    const out = parseSessions(JSON.stringify([raw("ses_a", 100), raw("ses_b", 300), { nope: 1 }]));
    expect(out?.map((s) => s.id)).toEqual(["ses_b", "ses_a"]);
    expect(out?.[0]).toEqual({
      id: "ses_b",
      title: "title ses_b",
      created: 290,
      updated: 300,
      model: "@cf/zai-org/glm-5.3",
      directory: "/home/user/project",
    });
  });

  it("is undefined for output that is not a session list", () => {
    expect(parseSessions("")).toBeUndefined();
    expect(parseSessions("Traceback (most recent call last):")).toBeUndefined();
    expect(parseSessions('{"data":[]}')).toBeUndefined();
  });
});

describe("readSessions", () => {
  it("reads a running workspace live, with the derived password in env only", async () => {
    const h = makeOrbCtx();
    const seen = withSessions(h, () => [raw("ses_a", 100)]);
    await runSpawn(h.newOp(), spawnReq);
    const r = await readSessions(h.ctx);
    expect(r.live).toBe(true);
    expect(r.sessions.map((s) => s.id)).toEqual(["ses_a"]);
    expect(seen[0]?.OPENCODE_SERVER_PASSWORD).toMatch(/.{20,}/);
  });

  it("a paused workspace answers with the list from its pause, and nothing starts", async () => {
    const h = makeOrbCtx();
    let list = [raw("ses_a", 100)];
    withSessions(h, () => list);
    await runSpawn(h.newOp(), spawnReq);
    list = [raw("ses_a", 100), raw("ses_b", 200)];
    await runPause(h.newOp(), { op: "pause" });
    expect(h.fake.running).toBe(false);

    const r = await readSessions(h.ctx);
    expect(r.live).toBe(false);
    expect(r.sessions.map((s) => s.id)).toEqual(["ses_b", "ses_a"]);
    expect(r.at).toBeDefined();
    expect(h.fake.running).toBe(false);
  });

  it("is empty for a workspace that never ran, and keeps the old list when OpenCode does not answer", async () => {
    const fresh = makeOrbCtx();
    expect(await readSessions(fresh.ctx)).toEqual({ sessions: [], live: false });

    const h = makeOrbCtx();
    let answer: unknown = [raw("ses_a", 100)];
    withSessions(h, () => answer);
    await runSpawn(h.newOp(), spawnReq);
    await readSessions(h.ctx);
    answer = "not a list";
    const r = await readSessions(h.ctx);
    expect(r.live).toBe(false);
    expect(r.sessions.map((s) => s.id)).toEqual(["ses_a"]);
  });
});
