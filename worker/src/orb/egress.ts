// Outbound credential injection. The container calls the real provider host with a placeholder
// header. The platform intercepts that host and hands the request here, where the real value
// from a Worker secret replaces the placeholder. The secret never enters the container, so a
// snapshot cannot capture it.
//
// Copied from the pattern Cloudflare documents for container outbound handlers. Nothing here
// imports the Agents SDK or @cloudflare/computer; both are experimental and their wire changes.
import type { EgressRoute } from "../core/container-port";

/** What the container sends. Recognisable, and never a real credential. */
export const PLACEHOLDER = "cf-opencode-egress";

/**
 * Header names a provider key travels in. The container's copy is always dropped, so a
 * workspace cannot smuggle its own value through to the provider.
 */
const STRIP = ["authorization", "x-api-key", "cf-aig-authorization"];

export interface EgressEnv {
  [secret: string]: string | undefined;
}

/**
 * Rewrite one intercepted request. Only provider hosts are intercepted, so a host with no
 * route should not arrive here; refuse it rather than forward it. A route whose secret is
 * unset is refused rather than forwarded with the placeholder. General internet, when the
 * install has not opted into lockdown, never reaches this function.
 */
export function rewriteEgress(
  req: Request,
  routes: readonly EgressRoute[],
  env: EgressEnv,
): Request | Response {
  const host = new URL(req.url).hostname;
  const route = routes.find((r) => r.host === host);
  if (!route) return new Response(`no egress route for ${host}\n`, { status: 403 });
  const value = env[route.secret];
  if (!value) return new Response(`egress secret ${route.secret} is not set\n`, { status: 403 });
  const headers = new Headers(req.headers);
  headers.delete("host");
  for (const name of STRIP) headers.delete(name);
  headers.set(
    route.header,
    route.basicUser
      ? `Basic ${btoa(`${route.basicUser}:${value}`)}`
      : route.header === "authorization"
        ? `Bearer ${value}`
        : value,
  );
  // manual: a redirect goes back to the container, which follows it itself. Following it here would send the
  // secret on to the host the redirect names (api.github.com sends a release download to another host).
  return new Request(req, { headers, redirect: "manual" });
}

/**
 * Hosts whose credential the Worker adds, and the Worker secret each one reads. GITHUB_TOKEN makes git clone,
 * fetch and push to github.com work for private repositories, and `gh` work (GH_TOKEN holds the placeholder),
 * with the token itself never in the container, its env, its disk or its snapshots. Every github.com request
 * from the workspace carries it, so its scope is the workspace's reach: give it only the repositories needed.
 */
export const PROVIDER_ROUTES: readonly EgressRoute[] = [
  { host: "api.anthropic.com", header: "x-api-key", secret: "ANTHROPIC_API_KEY" },
  { host: "api.openai.com", header: "authorization", secret: "OPENAI_API_KEY" },
  {
    host: "github.com",
    header: "authorization",
    secret: "GITHUB_TOKEN",
    basicUser: "x-access-token",
    env: "",
  },
  { host: "api.github.com", header: "authorization", secret: "GITHUB_TOKEN", env: "GH_TOKEN" },
];

/**
 * Env the container's opencode sees. Present only when the install has the secret, so a
 * provider with no key is absent rather than present with a placeholder OpenCode would send.
 */
export function providerEnv(
  env: EgressEnv,
  routes: readonly EgressRoute[] = PROVIDER_ROUTES,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const route of routes) {
    if (!env[route.secret] || route.env === "") continue;
    if (route.env) out[route.env] = PLACEHOLDER;
    else out[route.secret] = route.header === "authorization" ? `Bearer ${PLACEHOLDER}` : PLACEHOLDER;
  }
  return out;
}

/** Routes whose secret is set. These are the hosts the container may call. */
export function activeRoutes(
  env: EgressEnv,
  routes: readonly EgressRoute[] = PROVIDER_ROUTES,
): EgressRoute[] {
  return routes.filter((r) => Boolean(env[r.secret]));
}
