// The platform calls this for every intercepted outbound request. It is a WorkerEntrypoint
// because interceptOutboundHttps takes a Fetcher, not a Durable Object method.
import { WorkerEntrypoint } from "cloudflare:workers";
import { parseConfig } from "../core/config";
import type { EgressRoute } from "../core/container-port";
import { type Env, workspaceDoName } from "../env";
import { type AiRunner, handleAi, type PageRunner, type PreviewPageReader } from "./ai";
import { rewriteEgress } from "./egress";
import { type PreviewBrowser, readPreviewPage } from "./preview-browser";
import { type PreviewEgressFactory, type PreviewEgressProps, previewOutbound } from "./preview-hosts";
import { handleNote, NOTE_PATH } from "./task-notify";

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
export class AiEgress extends WorkerEntrypoint<Env, { gateway: string; workspaceId?: string }> {
  /**
   * The notify URL of the newest deploy, for the workspace's Durable Object (an RPC method: a container can
   * only fetch, so it cannot call this). The Durable Object's own env is as old as the object.
   */
  notifyUrl(): string | undefined {
    return this.env.NOTIFY_URL;
  }

  private async noteAllowed(workspaceId: string): Promise<boolean> {
    const stub = this.env.WORKSPACE.getByName(workspaceDoName(workspaceId)) as unknown as {
      allowNote(): Promise<boolean>;
    };
    return stub.allowNote();
  }

  override fetch(req: Request): Promise<Response> {
    if (req.method === "POST" && new URL(req.url).pathname === NOTE_PATH)
      return handleNote(req, {
        workspaceId: this.ctx.props.workspaceId,
        controlToken: this.env.CONTROL_TOKEN,
        ...(this.env.NOTIFY_URL ? { notifyUrl: this.env.NOTIFY_URL } : {}),
        // The count lives in the workspace's Durable Object, so the agent cannot reset it.
        ...(this.ctx.props.workspaceId
          ? { allow: () => this.noteAllowed(this.ctx.props.workspaceId as string) }
          : {}),
      });
    let searchProvider: string | undefined;
    // A config that does not parse counts as lockdown: refuse pages rather than guess the install allows them.
    let lockdown = true;
    try {
      const cfg = parseConfig(this.env.CF_OPENCODE_CONFIG);
      searchProvider = cfg.searchProvider;
      lockdown = cfg.lockdown;
    } catch {
      // A bad config already fails every control request with its own message. Search uses Cloudflare's default.
    }
    return handleAi(
      req,
      this.env.AI as unknown as AiRunner | undefined,
      this.ctx.props.gateway,
      searchProvider,
      this.env.BROWSER as unknown as PageRunner | undefined,
      this.previewReader(),
      { lockdown },
    );
  }

  /** cf-opencode-fetch of this workspace's own dev server. Needs the workspace id, which a container started before 0.2 lacks. */
  private previewReader(): PreviewPageReader | undefined {
    const workspaceId = this.ctx.props.workspaceId;
    const browser = this.env.BROWSER as unknown as PreviewBrowser | undefined;
    const factory = (this.ctx as unknown as { exports?: { PreviewEgress?: PreviewEgressFactory } }).exports
      ?.PreviewEgress;
    if (!workspaceId || !browser || !factory) return undefined;
    return (port, path, format) =>
      readPreviewPage(browser, previewOutbound(factory, workspaceId, [port]), port, path, format);
  }
}

/**
 * Browser Run calls this for each request its browser sends to p<port>.preview.internal (preview-hosts.ts).
 * The props come from this Worker only, when it opens the session, so they name this workspace and port.
 */
export class PreviewEgress extends WorkerEntrypoint<Env, PreviewEgressProps> {
  override fetch(req: Request): Promise<Response> {
    const { workspaceId, port } = this.ctx.props;
    const stub = this.env.WORKSPACE.getByName(workspaceDoName(workspaceId)) as unknown as {
      previewInternal(req: Request, port: number): Promise<Response>;
    };
    return stub.previewInternal(req, port);
  }
}
