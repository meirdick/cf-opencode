// Preview a dev server: the workspace Durable Object's side of /preview, /public and the remote browser's
// internal hostnames. The Worker (preview-ingress.ts) only routes; every check is here.
//
// - /preview/<id>/<port>/...  the workspace password (Basic), or the preview cookie, or a one-time sign-in link.
// - /public/<id>/<token>/...  a share the user made with the control token. Off until `preview --public`.
// - p<port>.preview.internal   the workspace's own remote browser, through Browser Run outbound Workers.
//
// A preview never wakes a paused workspace: a dev server does not survive a pause, so a wake would only start
// OpenCode. A request through a preview counts as use for the idle pause, like /oc.
//
// getTcpPort(port).fetch reaches the port on the container's network interface, not on loopback, so the dev
// server must listen on 0.0.0.0. The Host header is localhost:<port>, which dev servers accept by default
// (Vite's allowedHosts); the Worker's host goes in X-Forwarded-Host, as Sandbox SDK 0.12 did.
import { basicPassword, passwordMatches, timingSafeEqualStr } from "../auth";
import type { KV } from "../core/container-port";
import {
  checkPort,
  cookieHeader,
  dropInternalHeaders,
  previewCookies,
  previewPrefix,
  signCookie,
  signShareToken,
  signTicket,
  TICKET_PARAM,
  verifyCookie,
  verifyTicket,
  withoutPreviewCookie,
} from "../preview-auth";
import { loadOrb } from "./journal";

/** Header the Worker sets on the request it hands the Durable Object. It drops any copy the client sent. */
export const TARGET_HEADER = "x-cf-opencode-preview";

export interface PreviewTarget {
  kind: "private" | "public" | "link";
  workspaceId: string;
  /** private */
  port?: number;
  /** public */
  token?: string;
  /** Raw path after the prefix, starting with "/". */
  path: string;
  /** Raw query with its "?", or "". */
  search: string;
  /** The Worker's origin, for the URLs this hands back. */
  origin: string;
}

export interface PreviewDeps {
  workspaceId: string;
  kv: KV;
  /** From the control token. Undefined: previews are off. */
  key: CryptoKey | undefined;
  serverPort: number;
  running: boolean;
  /** One request to a TCP port of the container. Rejects when nothing listens. */
  portFetch(port: number, req: Request): Promise<Response>;
  /** Record use for the idle pause. */
  touch(): void;
  now(): number;
}

export interface PreviewShare {
  port: number;
  token: string;
  createdAt: string;
}

const SHARES_KEY = "preview-public";
const TICKET_KEY = "preview-ticket:";
/** A cost and exposure guard; a workspace rarely runs more dev servers than this. */
export const MAX_SHARES = 8;

export async function handlePreview(deps: PreviewDeps, req: Request): Promise<Response> {
  const target = parseTarget(req.headers.get(TARGET_HEADER));
  if (!target || target.workspaceId !== deps.workspaceId)
    return page(
      400,
      "Bad preview request",
      "the preview route is malformed",
      "use the URL cf-opencode preview printed",
    );
  if (target.kind === "public") return publicPreview(deps, req, target);
  if (target.kind === "link") return mintLink(deps, req, target);
  return privatePreview(deps, req, target);
}

function parseTarget(raw: string | null): PreviewTarget | undefined {
  if (!raw) return undefined;
  try {
    const t = JSON.parse(raw) as PreviewTarget;
    if (!["private", "public", "link"].includes(t.kind) || typeof t.workspaceId !== "string")
      return undefined;
    if (typeof t.path !== "string" || !t.path.startsWith("/") || typeof t.search !== "string")
      return undefined;
    return t;
  } catch {
    return undefined;
  }
}

async function privatePreview(deps: PreviewDeps, req: Request, t: PreviewTarget): Promise<Response> {
  const id = deps.workspaceId;
  const checked = checkPort(t.port, deps.serverPort);
  if ("error" in checked) return page(400, "Bad port", checked.error, `cf-opencode preview ${id} <port>`);
  const port = checked.port;
  const rec = await loadOrb(deps.kv);
  if (rec?.deletedAt)
    return page(
      410,
      "Workspace deleted",
      `${id} was deleted`,
      "start a new workspace with cf-opencode connect",
    );
  if (!deps.key)
    return page(503, "Previews are off", "the Worker has no control token", "run cf-opencode upgrade");
  const prefix = previewPrefix(id, port);
  const signIn = `cf-opencode preview ${id} ${port}`;

  // A sign-in link: check the ticket, spend it, set the cookie, and send the browser to the same path without it.
  const query = new URLSearchParams(t.search);
  const ticket = query.get(TICKET_PARAM);
  if (ticket !== null) {
    const ok = await verifyTicket(deps.key, ticket, id, port, deps.now());
    if (!ok || !(await spendTicket(deps.kv, ok.nonce, ok.expiresAt, deps.now())))
      return page(
        401,
        "Sign-in link used or expired",
        "the sign-in link was used or is older than 2 minutes",
        signIn,
      );
    query.delete(TICKET_PARAM);
    const rest = query.toString();
    // A path on this origin, never a full URL: the prefix starts with "/preview/", so it cannot become "//host".
    const location = `${prefix.slice(0, -1)}${t.path}${rest ? `?${rest}` : ""}`;
    return new Response(null, {
      status: 303,
      headers: {
        location,
        "set-cookie": cookieHeader(await signCookie(deps.key, id, port, deps.now()), id, port),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  let setCookie: string | undefined;
  const password = basicPassword(req.headers.get("authorization"));
  if (password !== undefined) {
    if (!(await passwordMatches(rec?.passwordSha, password)))
      return page(401, "Wrong password", "the workspace refused the password", `cf-opencode connect ${id}`);
    setCookie = cookieHeader(await signCookie(deps.key, id, port, deps.now()), id, port);
  } else {
    let ok = false;
    for (const value of previewCookies(req.headers.get("cookie"))) {
      // Check every value: a browser sends one cookie for each matching path.
      if (await verifyCookie(deps.key, value, id, port, deps.now())) ok = true;
    }
    if (!ok)
      return page(401, "Sign in to this preview", "this browser is not signed in to the preview", signIn);
  }

  if (!awake(deps, rec?.state))
    return page(
      503,
      "Workspace paused",
      `${id} is paused, and a dev server does not survive a pause`,
      `cf-opencode connect ${id}, start the dev server, then reload`,
    );
  deps.touch();
  const res = await forward(deps, port, req, t, prefix.slice(0, -1));
  if (!setCookie || res.webSocket) return res;
  const out = new Response(res.body, res);
  out.headers.append("set-cookie", setCookie);
  return out;
}

async function publicPreview(deps: PreviewDeps, req: Request, t: PreviewTarget): Promise<Response> {
  const share = await findShare(deps.kv, t.token ?? "");
  const rec = await loadOrb(deps.kv);
  // One answer for a wrong token and a deleted workspace: a stranger learns nothing.
  if (!share || rec?.deletedAt)
    return page(404, "Not found", "no preview at this address", "ask for a new link");
  if (!awake(deps, rec?.state))
    return page(503, "Preview not running", "this preview is not running now", "try again later");
  deps.touch();
  const res = await forward(deps, share.port, req, t, `/public/${deps.workspaceId}/${share.token}`);
  if (res.webSocket) return res;
  const out = new Response(res.body, res);
  out.headers.set("x-robots-tag", "noindex, nofollow");
  return out;
}

/**
 * POST /preview/<id>/link { port }, with the workspace password. Answers a one-time sign-in link, so the CLI
 * opens a browser without the password in the URL. Also says whether the workspace is awake and the port answers.
 */
async function mintLink(deps: PreviewDeps, req: Request, t: PreviewTarget): Promise<Response> {
  const id = deps.workspaceId;
  if (req.method !== "POST") return failJson(405, `${req.method} is not allowed here`, "send POST");
  const rec = await loadOrb(deps.kv);
  if (rec?.deletedAt)
    return failJson(410, `${id} was deleted`, "start a new workspace with cf-opencode connect");
  const password = basicPassword(req.headers.get("authorization"));
  if (!(await passwordMatches(rec?.passwordSha, password)))
    return failJson(401, "the workspace refused the password", `cf-opencode connect ${id}`);
  if (!deps.key) return failJson(503, "the Worker has no control token", "run cf-opencode upgrade");
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // an empty body has no port; checkPort says so
  }
  const checked = checkPort(body.port, deps.serverPort);
  if ("error" in checked) return failJson(400, checked.error, `cf-opencode preview ${id} <port>`);
  const port = checked.port;
  const { ticket, expiresAt } = await signTicket(deps.key, id, port, deps.now());
  const url = `${t.origin}${previewPrefix(id, port)}`;
  const isAwake = awake(deps, rec?.state);
  return Response.json({
    url,
    link: `${url}?${TICKET_PARAM}=${ticket}`,
    expiresAt: new Date(expiresAt).toISOString(),
    awake: isAwake,
    listening: isAwake ? await listening(deps, port) : false,
  });
}

/** For p<port>.preview.internal: the workspace's own remote browser. The caller is our PreviewEgress entrypoint. */
export async function internalPreview(deps: PreviewDeps, req: Request, rawPort: number): Promise<Response> {
  const checked = checkPort(rawPort, deps.serverPort);
  if ("error" in checked) return page(400, "Bad port", checked.error, "use http://p<port>.preview.internal/");
  const rec = await loadOrb(deps.kv);
  if (rec?.deletedAt || !awake(deps, rec?.state))
    return page(
      503,
      "Workspace paused",
      `${deps.workspaceId} is not awake`,
      "start the dev server, then reload",
    );
  deps.touch();
  const url = new URL(req.url);
  const t: PreviewTarget = {
    kind: "private",
    workspaceId: deps.workspaceId,
    path: url.pathname,
    search: url.search,
    origin: url.origin,
  };
  return forward(deps, checked.port, req, t, undefined);
}

function awake(deps: PreviewDeps, state: string | undefined): boolean {
  return deps.running && state === "awake";
}

/** Spend a ticket's nonce. False when it was spent before. Expired nonces are dropped on the way. */
async function spendTicket(kv: KV, nonce: string, expiresAt: number, nowMs: number): Promise<boolean> {
  const key = `${TICKET_KEY}${nonce}`;
  if ((await kv.get<number>(key)) !== undefined) return false;
  await kv.put(key, expiresAt);
  for (const [k, exp] of await kv.list<number>(TICKET_KEY)) if (exp <= nowMs) await kv.delete(k);
  return true;
}

/** Whether something answers on the port. A quick GET; its body is dropped. */
async function listening(deps: PreviewDeps, port: number): Promise<boolean> {
  try {
    const res = await deps.portFetch(
      port,
      new Request(`http://localhost:${port}/`, {
        headers: { host: `localhost:${port}` },
        signal: AbortSignal.timeout(3000),
      }),
    );
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/** Request headers the dev server must not see: the workspace password, our cookie, our own routing header. */
function forwardHeaders(req: Request, port: number, t: PreviewTarget, prefix: string | undefined): Headers {
  const headers = new Headers(req.headers);
  headers.delete("authorization");
  headers.delete("host");
  dropInternalHeaders(headers);
  const cookie = withoutPreviewCookie(req.headers.get("cookie"));
  if (cookie) headers.set("cookie", cookie);
  else headers.delete("cookie");
  headers.set("host", `localhost:${port}`);
  try {
    headers.set("x-forwarded-host", new URL(t.origin).host);
  } catch {
    // no origin: nothing to tell the app
  }
  headers.set("x-forwarded-proto", "https");
  if (prefix) headers.set("x-forwarded-prefix", prefix);
  return headers;
}

/**
 * Response headers that act on the whole Worker origin, not on the preview's path. A dev server is the agent's (or
 * a repository's) code. Service-Worker-Allowed: / would let a service worker from a preview control every page of
 * the origin: other previews, sign-in links, /oc. Clear-Site-Data would sign the browser out of every preview.
 */
const ORIGIN_WIDE = ["service-worker-allowed", "clear-site-data"];

async function forward(
  deps: PreviewDeps,
  port: number,
  req: Request,
  t: PreviewTarget,
  prefix: string | undefined,
): Promise<Response> {
  const url = `http://localhost:${port}${t.path}${t.search}`;
  const forwarded = new Request(url, {
    method: req.method,
    headers: forwardHeaders(req, port, t, prefix),
    body: req.method === "GET" || req.method === "HEAD" ? null : req.body,
    redirect: "manual",
  });
  let res: Response;
  try {
    res = await deps.portFetch(port, forwarded);
  } catch {
    return page(
      502,
      "Nothing answers",
      `nothing answers on port ${port} in ${deps.workspaceId}`,
      "start the dev server on 0.0.0.0 (for Vite: --host 0.0.0.0), then reload",
    );
  }
  if (!prefix || res.webSocket) return res;
  const location = res.headers.get("location");
  const moved = location === null ? null : prefixLocation(location, port, prefix);
  const origin = ORIGIN_WIDE.some((h) => res.headers.has(h));
  if (moved === null && !origin) return res;
  const out = new Response(res.body, res);
  if (moved !== null) out.headers.set("location", moved);
  for (const h of ORIGIN_WIDE) out.headers.delete(h);
  return out;
}

/**
 * A redirect from the dev server, moved under the preview prefix. "/login" and "http://localhost:3000/login" become
 * "<prefix>/login". Anything else (another site, a relative path) is left as it is. Null: no change.
 */
export function prefixLocation(location: string, port: number, prefix: string): string | null {
  if (location.startsWith("/") && !location.startsWith("//")) return `${prefix}${location}`;
  let u: URL;
  try {
    u = new URL(location);
  } catch {
    return null;
  }
  const local = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(u.hostname);
  if (!local || u.port !== String(port)) return null;
  return `${prefix}${u.pathname}${u.search}${u.hash}`;
}

// --- Public shares. Only the control plane (bearer token) changes them. ---

export async function listShares(kv: KV): Promise<PreviewShare[]> {
  return (await kv.get<PreviewShare[]>(SHARES_KEY)) ?? [];
}

/** Make a public URL for a port, or return the one that exists. */
export async function addShare(
  kv: KV,
  port: number,
  nowIso: string,
  serverPort: number,
  key: CryptoKey | undefined,
  workspaceId: string,
): Promise<{ ok: true; share: PreviewShare } | { ok: false; error: string; status: number }> {
  const checked = checkPort(port, serverPort);
  if ("error" in checked)
    return { ok: false, status: 400, error: `Failed: ${checked.error} — fix: pick the dev server's port` };
  if (!key)
    return {
      ok: false,
      status: 503,
      error: "Failed: the Worker has no control token — fix: run cf-opencode upgrade",
    };
  const shares = await listShares(kv);
  const existing = shares.find((s) => s.port === port);
  if (existing) return { ok: true, share: existing };
  if (shares.length >= MAX_SHARES)
    return {
      ok: false,
      status: 409,
      error: `Failed: ${MAX_SHARES} public previews already exist — fix: remove one with cf-opencode preview <workspace> <port> --stop`,
    };
  // The token carries its own MAC (signShareToken), so the Worker refuses a forged one before this object runs.
  const share = { port, token: await signShareToken(key, workspaceId), createdAt: nowIso };
  await kv.put(SHARES_KEY, [...shares, share]);
  return { ok: true, share };
}

/** Remove the public URL of one port, or of every port. Returns the ports removed. */
export async function removeShares(kv: KV, port?: number): Promise<number[]> {
  const shares = await listShares(kv);
  const gone = shares.filter((s) => port === undefined || s.port === port).map((s) => s.port);
  const kept = shares.filter((s) => port !== undefined && s.port !== port);
  if (kept.length) await kv.put(SHARES_KEY, kept);
  else await kv.delete(SHARES_KEY);
  return gone;
}

/** Find a share by its token. Compares against every share in constant time, so the timing says nothing. */
async function findShare(kv: KV, token: string): Promise<PreviewShare | undefined> {
  let found: PreviewShare | undefined;
  for (const s of await listShares(kv)) if (await timingSafeEqualStr(s.token, token)) found = s;
  return token.length >= 32 ? found : undefined;
}

// --- Answers ---

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A short HTML page for a person in a browser. The body holds the one-line error, so curl shows it too. */
export function page(status: number, title: string, cause: string, fix: string): Response {
  const line = `Failed: ${cause} — fix: ${fix}`;
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body style="font:16px system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.4rem">${escapeHtml(title)}</h1><p>${escapeHtml(cause)}.</p><p>Fix: <code>${escapeHtml(fix)}</code></p><!-- ${escapeHtml(line)} -->\n`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function failJson(status: number, cause: string, fix: string): Response {
  return Response.json({ error: `Failed: ${cause} — fix: ${fix}` }, { status });
}
