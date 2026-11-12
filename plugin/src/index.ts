// OpenCode plugin.
//
// OpenCode 1 calls `server` and has experimental_workspace. We register a "cf-opencode" type,
// shaped like the E2B plugin: configure, create, target. The sandbox id is not stored in the
// workspace row, because OpenCode persists configure() before create().
//
// OpenCode 2 dropped that API. It calls `setup`. We register a /cf-connect command that prints
// the attach line; the CLI does the attach, because a plugin cannot replace the running client.
import {
  basicAuth,
  type ControlOptions,
  createWorkspace,
  workspaceIdFrom,
  workspacePassword,
} from "./client.js";

export interface PluginOptions {
  url?: string;
  /** Project path inside the workspace. Default /home/user/project. */
  directory?: string;
}

interface WorkspaceInfo {
  id: string;
  name?: string;
  branch?: string | null;
  directory?: string;
  extra?: Record<string, unknown>;
}

interface WorkspaceAdapter {
  name: string;
  description: string;
  configure(info: WorkspaceInfo): Promise<WorkspaceInfo>;
  create(info: WorkspaceInfo): Promise<void>;
  target(info: WorkspaceInfo): Promise<{ type: "remote"; url: URL; headers?: Record<string, string> }>;
}

interface PluginInput {
  directory: string;
  experimental_workspace?: { register(type: string, adapter: WorkspaceAdapter): void };
}

interface CommandDef {
  name: string;
  description: string;
  handler: () => Promise<string>;
}

/** OpenCode 1 entry. */
export async function server(input: PluginInput, raw: PluginOptions = {}): Promise<Record<string, unknown>> {
  const ws = input.experimental_workspace;
  if (!ws) return {};
  ws.register("cf-opencode", adapter(raw));
  return {};
}

/** OpenCode 2 entry. */
export function setup(input: unknown, raw: PluginOptions = {}): { commands: CommandDef[] } {
  const local = (input as { directory?: string } | undefined)?.directory ?? process.cwd();
  return {
    commands: [
      {
        name: "cf-connect",
        description: "Wake this project's cf-opencode workspace and print the attach command.",
        handler: async () => {
          const opts = controlFromEnv(raw);
          const id = workspaceIdFrom(local);
          const password = workspacePassword(id, opts.token);
          const target = await createWorkspace(opts, { id, password, directory: raw.directory });
          return `Workspace ${target.id} is up. Attach with:\n  cf-opencode connect ${target.id}\nTerminal: cf-opencode shell ${target.id}`;
        },
      },
    ],
  };
}

function adapter(raw: PluginOptions): WorkspaceAdapter {
  return {
    name: "cf-opencode",
    description: "OpenCode workspace on Cloudflare Containers, in your own account",
    async configure(info) {
      return {
        ...info,
        name: info.name ?? `cf-${info.branch ?? info.id.slice(0, 6)}`,
        directory: raw.directory ?? "/home/user/project",
      };
    },
    async create(info) {
      const opts = controlFromEnv(raw);
      const password = workspacePassword(info.id, opts.token);
      await createWorkspace(opts, {
        id: info.id,
        password,
        directory: info.directory,
        ...(info.branch ? { branch: info.branch } : {}),
      });
    },
    async target(info) {
      const opts = controlFromEnv(raw);
      return {
        type: "remote",
        url: new URL(`${opts.url}/oc/${encodeURIComponent(info.id)}`),
        headers: { authorization: basicAuth(workspacePassword(info.id, opts.token)) },
      };
    },
  };
}

function controlFromEnv(raw: PluginOptions): ControlOptions {
  const url = raw.url ?? process.env.CF_OPENCODE_URL;
  const token = process.env.CF_OPENCODE_CONTROL_TOKEN;
  if (!url) throw new Error("Failed: CF_OPENCODE_URL is not set — fix: export the Worker URL");
  if (!token) throw new Error("Failed: CF_OPENCODE_CONTROL_TOKEN is not set — fix: export the control token");
  return { url, token };
}

export default server;

export const _localDirectory = (d: string) => d;
