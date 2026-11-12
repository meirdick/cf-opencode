// The platform calls this for every intercepted outbound request. It is a WorkerEntrypoint
// because interceptOutboundHttps takes a Fetcher, not a Durable Object method.
import { WorkerEntrypoint } from "cloudflare:workers";
import { parseConfig } from "../core/config";
import type { EgressRoute } from "../core/container-port";
import type { Env } from "../env";
import { type AiRunner, handleAi, type PageRunner } from "./ai";
import { rewriteEgress } from "./egress";

interface EgressProps {
  routes: EgressRoute[];
}

export class ProviderEgress extends WorkerEntrypoint<Env, EgressProps> {
  override fetch(req: Request): Promise<Response> | Response {
    const rewritten = rewriteEgress(
      req,
      this.ctx.props.routes,
      this.env as unknown as Record<string, string>,
    );
    if (rewritten instanceof Response) return rewritten;
    return fetch(rewritten);
  }
}

/** The platform calls this for every request the container sends to AI_HOST. */
export class AiEgress extends WorkerEntrypoint<Env, { gateway: string }> {
  override fetch(req: Request): Promise<Response> {
    let searchProvider: string | undefined;
    try {
      searchProvider = parseConfig(this.env.CF_OPENCODE_CONFIG).searchProvider;
    } catch {
      // A bad config already fails every control request with its own message. Search uses Cloudflare's default.
    }
    return handleAi(
      req,
      this.env.AI as unknown as AiRunner | undefined,
      this.ctx.props.gateway,
      searchProvider,
      this.env.BROWSER as unknown as PageRunner | undefined,
    );
  }
}
