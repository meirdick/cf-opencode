// Cancel a handed-off task: interrupt its OpenCode session. A2A's CancelTask calls this.
//
// The script runs in the workspace like the other task scripts (task-scripts.ts): Python, the password in
// env, one JSON document on stdout. It asks opencode serve to interrupt the session; the agent loop stops
// and the session ends with the outcome "interrupted".
import { workspacePassword } from "../auth";
import type { OrbContext } from "./context";
import { redactWith } from "./journal";
import { sh } from "./spawn";

/**
 * Env: PORT, OPENCODE_SERVER_PASSWORD, SESSION (a ses_… id, checked by the Worker). Prints {"ok": true},
 * {"found": false} when OpenCode does not know the session, or {"error": "..."}.
 */
export const TASK_INTERRUPT_SH = `
exec python3 - <<'PY'
import base64, json, os, urllib.error, urllib.request
base = "http://127.0.0.1:%s" % os.environ.get("PORT", "4096")
auth = "Basic " + base64.b64encode(("opencode:" + os.environ["OPENCODE_SERVER_PASSWORD"]).encode()).decode()
req = urllib.request.Request(base + "/api/session/%s/interrupt" % os.environ["SESSION"], data=b"", method="POST",
                             headers={"authorization": auth})
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        r.read()
    print(json.dumps({"ok": True}))
except urllib.error.HTTPError as e:
    print(json.dumps({"found": False} if e.code == 404 else {"error": "HTTP %s" % e.code}))
except Exception as e:
    print(json.dumps({"error": str(e)[:200]}))
PY
`;

export type CancelResult = { ok: true } | { ok: false; status: number; error: string };

const SESSION_ID_RE = /^ses[A-Za-z0-9_-]{1,100}$/;

type Ctx = Pick<OrbContext, "container" | "config" | "env" | "workspaceId">;

/** Interrupt one session in the running workspace. Wakes nothing: a stopped workspace runs no agent. */
export async function cancelTask(ctx: Ctx, sessionId: string): Promise<CancelResult> {
  const id = ctx.workspaceId;
  if (!SESSION_ID_RE.test(sessionId))
    return { ok: false, status: 400, error: "Failed: bad task id — fix: use the ses_… id of the task" };
  if (!ctx.container.running)
    return {
      ok: false,
      status: 409,
      error: `Failed: workspace ${id} is not running, so no agent works on the task — fix: cf-opencode connect ${id} --session ${sessionId}`,
    };
  if (!ctx.env.CONTROL_TOKEN)
    return {
      ok: false,
      status: 500,
      error: "Failed: the Worker has no CONTROL_TOKEN — fix: cf-opencode upgrade",
    };
  const password = await workspacePassword(ctx.env.CONTROL_TOKEN, id);
  let out: { ok?: unknown; found?: unknown; error?: unknown } | undefined;
  try {
    const [cmd, opts] = sh(TASK_INTERRUPT_SH, {
      PORT: String(ctx.config.serverPort),
      OPENCODE_SERVER_PASSWORD: password,
      SESSION: sessionId,
    });
    const r = await ctx.container.exec(cmd, { ...opts, timeoutMs: 30_000 });
    out = r.exitCode === 0 ? (JSON.parse(r.stdout.trim()) as typeof out) : undefined;
    if (!out) throw new Error(r.stderr.trim().slice(0, 200) || `exit ${r.exitCode}`);
  } catch (e) {
    const why = redactWith(password, (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " "));
    return {
      ok: false,
      status: 502,
      error: `Failed: OpenCode in ${id} did not answer (${why.slice(0, 200)}) — fix: cf-opencode logs ${id}`,
    };
  }
  if (out.ok === true) return { ok: true };
  if (out.found === false)
    return {
      ok: false,
      status: 404,
      error: `Failed: OpenCode in ${id} has no session ${sessionId} — fix: cf-opencode tasks ${id}`,
    };
  const why = redactWith(password, String(out.error ?? "no answer").replace(/\s+/g, " ")).slice(0, 200);
  return {
    ok: false,
    status: 502,
    error: `Failed: OpenCode did not interrupt ${sessionId}: ${why} — fix: cf-opencode logs ${id}`,
  };
}
