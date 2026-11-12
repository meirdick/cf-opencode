// cf-opencode Worker entry.
import { handleApi } from "./api";
import type { Env } from "./env";

export { AiEgress, ProviderEgress } from "./orb/egress-worker";
export { WorkspaceSession } from "./orb/session";
export { Registry } from "./registry";

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handleApi(req, env);
  },
} satisfies ExportedHandler<Env>;
