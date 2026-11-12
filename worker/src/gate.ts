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

/**
 * True when a browser on another site sent this request. A browser always sends Origin on a websocket and on a
 * cross-site POST, and it can attach Basic credentials it has cached for this Worker. The CLI, ssh, curl and
 * CDP clients send no Origin. "null" (a sandboxed page, a file) is cross-site too.
 */
export function crossOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin !== null && origin !== new URL(req.url).origin;
}

/**
 * True when a browser made this request. Every current browser sends Sec-Fetch-Site, and a page cannot remove
 * it. CLI, ssh, curl and CDP clients do not send it. Python's websocket client sends Origin set to the Worker's
 * own origin, so Origin alone cannot tell a CDP client from a page.
 */
export function fromBrowser(req: Request): boolean {
  return req.headers.has("sec-fetch-site");
}

/**
 * The Basic password of a request for workspace `id`, or the response to refuse it with. `sameOriginOnly`
 * also refuses a request from a browser page, on another site or on this origin: /shell, /ssh and /browse
 * have no browser client, and a preview page is served on this origin.
 */
export async function workspaceGate(
  req: Request,
  env: { CONTROL_TOKEN?: string },
  id: string,
  opts: { sameOriginOnly?: boolean } = {},
): Promise<{ password: string } | Response> {
  if (opts.sameOriginOnly && (crossOrigin(req) || fromBrowser(req))) {
    return Response.json(
      { error: "Failed: a web page cannot open this — fix: use the cf-opencode CLI" },
      { status: 403 },
    );
  }
  const password = basicPassword(req.headers.get("authorization"));
  if (!(await isWorkspacePassword(env.CONTROL_TOKEN, id, password))) return unauthorized();
  return { password: password as string };
}
