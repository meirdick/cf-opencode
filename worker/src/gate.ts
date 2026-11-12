// The Worker's own check on the workspace routes (/oc, /browse, /shell, /ssh), before any Durable Object.
//
// Every workspace password is derived: workspacePassword(CONTROL_TOKEN, id). So the Worker can tell a
// right password from a wrong one with no state, and a request with no password or a wrong one costs one
// Worker invocation, never a Durable Object. The Durable Object still checks the password against the hash
// the last spawn stored, and it still wakes a paused workspace only after that check.
//
// A password that is not derived (a random one from before derivation) is refused here. The control API
// refuses to set one, and `cf-opencode connect` replaces an old one, so no current client sends one.
//
// No lockout: the password is 256 bits, so guessing is not a threat, and a hold keyed on the workspace id
// (the checkout's name, easy to guess) would let anyone lock the owner out. It would also need a state
// write per failed attempt, which is the cost this check removes.
import { basicPassword, timingSafeEqualStr, workspacePassword } from "./auth";

/**
 * The one 401 a caller without the right password gets, on every workspace route and from the Durable
 * Object. JSON: OpenCode 2's client reads a plain-text 401 as "not a compatible server". It names no
 * workspace and says nothing about whether one exists.
 */
export function unauthorized(): Response {
  return new Response(JSON.stringify({ _tag: "UnauthorizedError", message: "Authentication required" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": 'Basic realm="cf-opencode"' },
  });
}

/** True when `password` is the derived password of workspace `id`. Constant time. */
export async function isWorkspacePassword(
  controlToken: string | undefined,
  id: string,
  password: string | undefined,
): Promise<boolean> {
  if (!controlToken || !password) return false;
  return timingSafeEqualStr(password, await workspacePassword(controlToken, id));
}

/** The Basic password of a request for workspace `id`, or the 401 to answer with. */
export async function workspaceGate(
  req: Request,
  env: { CONTROL_TOKEN?: string },
  id: string,
): Promise<{ password: string } | Response> {
  const password = basicPassword(req.headers.get("authorization"));
  if (!(await isWorkspacePassword(env.CONTROL_TOKEN, id, password))) return unauthorized();
  return { password: password as string };
}
