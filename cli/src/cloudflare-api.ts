// Read-only calls to the Cloudflare API, for checks that wrangler has no command for. Every call is a GET, so a
// check changes nothing in the account. The token is CLOUDFLARE_API_TOKEN, the --token-file token, or wrangler's
// own login, which `wrangler auth token --json` writes to its stdout. It goes in a header, never in argv or a log.
import type { Wrangler } from "./wrangler.js";

/** A fact, or the reason it could not be read. A check that cannot read a fact warns; it does not fail. */
export type Known<T> = { kind: "known"; value: T } | { kind: "unknown"; reason: string };

export const API_BASE = "https://api.cloudflare.com/client/v4";

export interface CfApi {
  get<T>(path: string, query?: Record<string, string>): Promise<Known<T>>;
}

export function makeCfApi(token: string, fetchFn: typeof fetch = (i, init) => fetch(i, init)): CfApi {
  return {
    async get<T>(path: string, query: Record<string, string> = {}): Promise<Known<T>> {
      const q = new URLSearchParams(query).toString();
      let res: Response;
      try {
        res = await fetchFn(`${API_BASE}${path}${q ? `?${q}` : ""}`, {
          headers: { authorization: `Bearer ${token}` },
        });
      } catch (e) {
        return {
          kind: "unknown",
          reason: `cannot reach the Cloudflare API (${e instanceof Error ? e.message : String(e)})`,
        };
      }
      let body: { success?: boolean; result?: unknown; errors?: { message?: string }[] } | undefined;
      try {
        body = (await res.json()) as typeof body;
      } catch {}
      if (!res.ok || !body?.success) {
        const m = body?.errors?.[0]?.message;
        return { kind: "unknown", reason: `Cloudflare API answered ${res.status}${m ? `: ${m}` : ""}` };
      }
      return { kind: "known", value: body.result as T };
    },
  };
}

/** The token wrangler uses, from `wrangler auth token --json`. Undefined when wrangler has none. */
export async function wranglerToken(w: Wrangler): Promise<string | undefined> {
  const r = await w.run(["auth", "token", "--json"], { timeoutMs: 60_000 });
  if (r.code !== 0) return undefined;
  try {
    const j = JSON.parse(r.stdout.slice(Math.max(0, r.stdout.indexOf("{")))) as {
      type?: string;
      token?: string;
    };
    return (j.type === "oauth" || j.type === "api_token") && j.token ? j.token : undefined;
  } catch {
    return undefined;
  }
}

/** An API client with the given token, else with wrangler's. Undefined when there is no token. */
export async function apiFor(
  w: Wrangler,
  apiToken: string | undefined,
  fetchFn?: typeof fetch,
): Promise<CfApi | undefined> {
  const token = apiToken ?? (await wranglerToken(w));
  return token ? makeCfApi(token, fetchFn) : undefined;
}
