// The workspace's remote browser opens its own dev servers with no public URL.
//
// Browser Run's binding takes `outboundByHost` on acquire(): requests from the browser to those hostnames go to a
// Worker Fetcher instead of the internet. Docs: https://developers.cloudflare.com/browser-run/features/outbound-workers/
// (read 2026-11-12). The Agents SDK's "internal hostnames" are built on it; this uses the binding directly, as
// browse.ts does. Constraints from those docs: HTTP only, the hostname set is fixed when the session starts, and a
// hostname must match exactly. So the port is part of the hostname: http://p3000.preview.internal/ is port 3000.
// Each routed request goes to PreviewEgress (egress-worker.ts) with the workspace and port in its props, which only
// this Worker sets.
export const PREVIEW_HOST_SUFFIX = ".preview.internal";
/** A browser session routes at most this many dev-server ports. */
export const MAX_PREVIEW_PORTS = 4;

export function previewHost(port: number): string {
  return `p${port}${PREVIEW_HOST_SUFFIX}`;
}

/**
 * The dev-server port a URL names: http://p3000.preview.internal/ or, for convenience, http://localhost:3000/
 * (which the remote browser could not reach otherwise). Undefined: an ordinary URL.
 */
export function previewPortOf(url: URL): number | undefined {
  const m = /^p([0-9]{4,5})\.preview\.internal$/.exec(url.hostname);
  if (m) return Number(m[1]);
  if (["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname) && url.port)
    return Number(url.port);
  return undefined;
}

export interface PreviewEgressProps {
  workspaceId: string;
  port: number;
}

/** What the session's ctx.exports gives for PreviewEgress. */
export type PreviewEgressFactory = (opts: { props: PreviewEgressProps }) => Fetcher;

/** outboundByHost for a browser session of this workspace: one hostname for each port. */
export function previewOutbound(
  factory: PreviewEgressFactory,
  workspaceId: string,
  ports: readonly number[],
): Record<string, Fetcher> {
  const out: Record<string, Fetcher> = {};
  for (const port of ports) out[previewHost(port)] = factory({ props: { workspaceId, port } });
  return out;
}
