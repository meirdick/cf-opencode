// Worker routes for previews. These only parse and route; the workspace's Durable Object checks every credential
// (orb/preview.ts). The request reaches it through the Durable Object's fetch(), not RPC, because a dev server's
// hot reload is a websocket, and a websocket does not pass through an RPC return value.
//
//   /preview/<id>/<port>/<path>   private preview: workspace password, preview cookie, or one-time link
//   POST /preview/<id>/link        a one-time sign-in link, for the workspace password
//   /public/<id>/<token>/<path>    public share, made only with the control token
//   GET|POST|DELETE /v1/workspaces/<id>/previews   public shares (bearer; routed from api.ts)
//
// Absolute paths. A preview lives under a path prefix, so a page's "/assets/app.js" asks this Worker for
// /assets/app.js, outside the preview. previewFallback() sends such a request back under the prefix when its
// Referer is a preview page on this origin. That covers most dev servers (Vite, Next, plain static servers), but
// not a request with no Referer (a websocket for hot reload, a page with Referrer-Policy: no-referrer). A dev
// server told its base path (Vite: --base /preview/<id>/<port>/) needs no fallback.
import { WORKSPACE_ID_RE } from "./api";
import { type Env, workspaceDoName } from "./env";
import { type PreviewShare, type PreviewTarget, TARGET_HEADER } from "./orb/preview";
import { checkPort, dropInternalHeaders } from "./preview-auth";

export interface PreviewSessionApi {
  fetch(req: Request): Promise<Response>;
  previewShares(): Promise<PreviewShare[]>;
  sharePreview(
    port: number,
  ): Promise<{ ok: true; share: PreviewShare } | { ok: false; error: string; status: number }>;
  unsharePreview(port?: number): Promise<number[]>;
}

const PREVIEW_RE = /^\/preview\/([^/]+)\/([0-9]{1,5})(\/.*)?$/;
const LINK_RE = /^\/preview\/([^/]+)\/link$/;
const PUBLIC_RE = /^\/public\/([^/]+)\/([A-Za-z0-9_-]{32,64})(\/.*)?$/;

function sessionOf(env: Env, id: string): PreviewSessionApi {
  return env.WORKSPACE.getByName(workspaceDoName(id)) as unknown as PreviewSessionApi;
}

export function isPreviewPath(pathname: string): boolean {
  return pathname.startsWith("/preview/") || pathname.startsWith("/public/");
}

export async function previewIngress(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  let target: Omit<PreviewTarget, "path" | "search" | "origin"> | undefined;
  let rest: string | undefined;
  let base = "";
  const link = LINK_RE.exec(url.pathname);
  const priv = PREVIEW_RE.exec(url.pathname);
  const pub = PUBLIC_RE.exec(url.pathname);
  if (link) {
    target = { kind: "link", workspaceId: link[1] as string };
    rest = "/";
  } else if (priv) {
    // The port is checked again in the Durable Object, against the install's OpenCode port.
    const checked = checkPort(priv[2], 0);
    if ("error" in checked) return fail(400, checked.error, "use the URL cf-opencode preview printed");
    target = { kind: "private", workspaceId: priv[1] as string, port: checked.port };
    rest = priv[3];
    base = `/preview/${priv[1]}/${checked.port}`;
  } else if (pub) {
    target = { kind: "public", workspaceId: pub[1] as string, token: pub[2] as string };
    rest = pub[3];
    base = `/public/${pub[1]}/${pub[2]}`;
  } else {
    return fail(404, "no preview at this path", "use the URL cf-opencode preview printed");
  }
  if (!WORKSPACE_ID_RE.test(target.workspaceId))
    return fail(400, "bad workspace id", "use letters, digits, _ and -");
  // /preview/<id>/3000 without the slash: relative links on the page would resolve one level up.
  if (rest === undefined)
    return new Response(null, { status: 308, headers: { location: `${base}/${url.search}` } });

  const headers = new Headers(req.headers);
  dropInternalHeaders(headers);
  const full: PreviewTarget = { ...target, path: rest, search: url.search, origin: url.origin };
  headers.set(TARGET_HEADER, JSON.stringify(full));
  const forwarded = new Request("https://workspace/preview", {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? null : req.body,
    redirect: "manual",
  });
  return sessionOf(env, target.workspaceId).fetch(forwarded);
}

/**
 * A request for an absolute path that came from a preview page: send it back under that page's prefix. Only for a
 * Referer on this same origin; the answer is a path on this origin, never another site. Null: not a preview's.
 */
export function previewFallback(req: Request): Response | null {
  const url = new URL(req.url);
  if (isPreviewPath(url.pathname)) return null;
  const referer = req.headers.get("referer");
  if (!referer) return null;
  let from: URL;
  try {
    from = new URL(referer);
  } catch {
    return null;
  }
  if (from.origin !== url.origin) return null;
  const m =
    /^(\/preview\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/[0-9]{4,5}|\/public\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/[A-Za-z0-9_-]{32,64})\//.exec(
      from.pathname,
    );
  if (!m) return null;
  // 307 keeps the method and body, so a fetch("/api/x", { method: "POST" }) from the page still works.
  return new Response(null, {
    status: 307,
    headers: { location: `${m[1]}${url.pathname}${url.search}`, "cache-control": "no-store" },
  });
}

/** /v1/workspaces/<id>/previews. The caller checked the bearer token: only the control plane makes a port public. */
export async function previewControl(req: Request, env: Env, id: string): Promise<Response> {
  const url = new URL(req.url);
  const session = sessionOf(env, id);
  const method = req.method.toUpperCase();
  const view = (s: PreviewShare) => ({
    port: s.port,
    url: `${url.origin}/public/${id}/${s.token}/`,
    createdAt: s.createdAt,
  });
  if (method === "GET")
    return Response.json({ workspace: id, public: (await session.previewShares()).map(view) });
  if (method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      // checkPort reports the missing port
    }
    // The real OpenCode port is checked in the Durable Object; 0 here only skips that one test.
    const checked = checkPort(body.port, 0);
    if ("error" in checked) return fail(400, checked.error, `cf-opencode preview ${id} <port> --public`);
    const r = await session.sharePreview(checked.port);
    if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
    return Response.json({ workspace: id, ...view(r.share) });
  }
  if (method === "DELETE") {
    const raw = url.searchParams.get("port");
    let port: number | undefined;
    if (raw !== null) {
      const checked = checkPort(raw, 0);
      if ("error" in checked) return fail(400, checked.error, `cf-opencode preview ${id} <port> --stop`);
      port = checked.port;
    }
    return Response.json({ workspace: id, removed: await session.unsharePreview(port) });
  }
  return fail(405, `${method} ${url.pathname} is not allowed`, "use GET, POST or DELETE");
}

function fail(status: number, cause: string, fix: string): Response {
  return Response.json({ error: `Failed: ${cause} — fix: ${fix}` }, { status });
}
