// Worker bindings. wrangler.jsonc must match.

export interface Env {
  /** WorkspaceSession DO, one per workspace, named `ws:<id>`. */
  WORKSPACE: DurableObjectNamespace;
  /** Registry DO, single instance named `registry`. */
  REGISTRY: DurableObjectNamespace;
  /** ProviderConfig as a JSON string. Parsed by core/config.ts. */
  CF_OPENCODE_CONFIG: string;
  /** Bearer token for the control API. Unset → control routes return 404. */
  CONTROL_TOKEN?: string;
  /** Provider keys. Read by ProviderEgress; the container only ever sees a placeholder. */
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** GitHub token for git and gh in workspaces. Added on egress to github.com; never in the container. */
  GITHUB_TOKEN?: string;
  /**
   * https URL the Worker POSTs a handed-off task's result to, and the notes of cf-opencode-notify. A secret, not
   * a setting: a webhook URL often holds its own secret. Set with `cf-opencode notify-url`; read at send time.
   */
  NOTIFY_URL?: string;
  /** Workers AI and AI Gateway. Models bill to the account; no provider key exists. */
  AI?: Ai;
  /** Browser Run. Sessions bill to the account; no token exists. */
  BROWSER?: import("./orb/browse").BrowserBinding;
}

/** DO name for a workspace. The `ws:` prefix keeps workspace ids from naming the registry. */
export function workspaceDoName(workspaceId: string): string {
  return `ws:${workspaceId}`;
}

export const REGISTRY_DO_NAME = "registry";
