// The platform calls this for every intercepted outbound request. It is a WorkerEntrypoint
// because interceptOutboundHttps takes a Fetcher, not a Durable Object method.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { EgressRoute } from "../core/container-port";
import type { Env } from "../env";
import { type AiRunner, handleAi } from "./ai";
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
    return handleAi(req, this.env.AI as unknown as AiRunner | undefined, this.ctx.props.gateway);
  }
}
