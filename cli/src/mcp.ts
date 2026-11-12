// `cf-opencode mcp`: the task handoff as an MCP server over stdio, with no SDK.
//
// MCP 2026-07-28 has no handshake: each request carries its protocol version in params._meta. Clients
// from before it send `initialize` first (2025-11-25 and 2025-06-18, the first with structured tool output).
// This server answers both, as the spec's "dual-era" server: a request with _meta is served as 2026-07-28;
// `initialize` selects the old behavior for this process.
// Spec: https://modelcontextprotocol.io/specification/2026-07-28 (basic/versioning, basic/transports/stdio,
// server/discover, server/tools) and https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle.
//
// stdout carries protocol messages only. Every log line goes to stderr.
import { createInterface } from "node:readline";
import { toFailedLine } from "./errors.js";
import { localBackend, type McpTool, taskTools } from "./mcp-tools.js";

export const MODERN_VERSION = "2026-07-28";
/** Versions that start with `initialize`, newest first. */
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18"] as const;
export const SUPPORTED_VERSIONS: string[] = [MODERN_VERSION, ...LEGACY_VERSIONS];

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER = "io.modelcontextprotocol/serverInfo";
/** The tool list is fixed for the life of the process, and the same for every user. */
const LIST_TTL_MS = 3_600_000;

export const INSTRUCTIONS = [
  "These tools hand coding tasks to OpenCode in cf-opencode workspaces on Cloudflare, so the work goes on after this session and with the laptop closed.",
  "Commit and push before handoff_task: the workspace clones from the Git remote and cannot see local changes.",
  "Write each task as a full brief; the remote agent has not seen this conversation.",
  "Then wait_task or get_task. A waiting task asks a question that the user answers in OpenCode.",
].join(" ");

type Json = Record<string, unknown>;
type Id = string | number | null;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The protocol core. Feed it one parsed JSON-RPC message; it returns the response, or undefined for none. */
export class McpServer {
  private legacy: string | undefined;

  constructor(
    private readonly tools: McpTool[],
    private readonly info: { name: string; version: string },
    private readonly instructions = INSTRUCTIONS,
  ) {}

  /** The version `initialize` chose, when a client from before 2026-07-28 started with it. */
  get legacyVersion(): string | undefined {
    return this.legacy;
  }

  async handle(msg: unknown, signal: AbortSignal = new AbortController().signal): Promise<Json | undefined> {
    if (!isObject(msg)) return fail(null, -32600, "Invalid Request: one JSON-RPC object per line");
    const hasId = "id" in msg;
    const rawId = msg.id;
    const id: Id = typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
    if (msg.jsonrpc !== "2.0") return fail(id, -32600, 'Invalid Request: jsonrpc must be "2.0"');
    // A response from the client. This server sends no requests, so there is nothing to match.
    if (typeof msg.method !== "string") return undefined;
    // Notifications get no answer. Cancellation is the transport's business (serveStdio).
    if (!hasId) return undefined;
    if (id === null) return fail(null, -32600, "Invalid Request: id must be a string or a number");
    if (msg.params !== undefined && !isObject(msg.params))
      return fail(id, -32602, "Invalid params: params must be an object");
    const params = (msg.params ?? {}) as Json;
    const meta = isObject(params._meta) ? params._meta : undefined;
    const version = meta?.[META_VERSION];
    if (version !== undefined) return this.modern(id, msg.method, params, meta as Json, signal);
    return this.legacyRequest(id, msg.method, params, signal);
  }

  /** 2026-07-28: stateless; every request names its version and the client's capabilities. */
  private async modern(id: Id, method: string, params: Json, meta: Json, signal: AbortSignal) {
    const version = meta[META_VERSION];
    if (version !== MODERN_VERSION)
      return fail(id, -32022, "Unsupported protocol version", {
        supported: SUPPORTED_VERSIONS,
        requested: version,
      });
    if (!isObject(meta[META_CAPABILITIES]))
      return fail(id, -32602, `Invalid params: _meta["${META_CAPABILITIES}"] is required`);
    const done = (result: Json) =>
      ok(id, { resultType: "complete", ...result, _meta: { [META_SERVER]: this.info } });
    switch (method) {
      case "server/discover":
        return done({
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          instructions: this.instructions,
          ttlMs: LIST_TTL_MS,
          cacheScope: "public",
        });
      case "tools/list":
        if (params.cursor !== undefined) return fail(id, -32602, "Invalid params: unknown cursor");
        return done({ tools: this.toolDefs(), ttlMs: LIST_TTL_MS, cacheScope: "public" });
      case "tools/call": {
        const r = await this.call(id, params, signal);
        return "error" in r ? r : done(r.result as Json);
      }
      default:
        return fail(id, -32601, `Method not found: ${printable(method)}`);
    }
  }

  /** 2025-11-25 and 2025-06-18: `initialize` first, then requests without _meta. */
  private async legacyRequest(id: Id, method: string, params: Json, signal: AbortSignal) {
    if (method === "initialize") {
      const asked = params.protocolVersion;
      // The spec: answer the same version when supported, else the newest one this server has.
      const chosen =
        typeof asked === "string" && (LEGACY_VERSIONS as readonly string[]).includes(asked)
          ? asked
          : LEGACY_VERSIONS[0];
      this.legacy = chosen;
      return ok(id, {
        protocolVersion: chosen,
        capabilities: { tools: { listChanged: false } },
        serverInfo: this.info,
        instructions: this.instructions,
      });
    }
    if (method === "ping") return ok(id, {});
    if (!this.legacy)
      return fail(
        id,
        -32602,
        `Invalid params: _meta["${META_VERSION}"] is required; or send initialize first`,
        { supported: SUPPORTED_VERSIONS },
      );
    switch (method) {
      case "tools/list":
        return ok(id, { tools: this.toolDefs() });
      case "tools/call":
        return this.call(id, params, signal);
      default:
        return fail(id, -32601, `Method not found: ${printable(method)}`);
    }
  }

  private toolDefs() {
    return this.tools.map((t) => t.def);
  }

  /**
   * An unknown tool or a malformed call is a protocol error. A failure inside the tool is a result with
   * isError, so the model reads the "Failed: … — fix: …" line and can act on it.
   */
  private async call(id: Id, params: Json, signal: AbortSignal): Promise<Json> {
    const name = params.name;
    if (typeof name !== "string") return fail(id, -32602, "Invalid params: name is required");
    const tool = this.tools.find((t) => t.def.name === name);
    if (!tool) return fail(id, -32602, `Unknown tool: ${printable(name)}`);
    const args = params.arguments ?? {};
    if (!isObject(args)) return fail(id, -32602, "Invalid params: arguments must be an object");
    try {
      const out = await tool.run(args, signal);
      return ok(id, {
        content: [{ type: "text", text: out.text }],
        structuredContent: out.structured,
        isError: false,
      });
    } catch (e) {
      return ok(id, { content: [{ type: "text", text: toFailedLine(e) }], isError: true });
    }
  }
}

function ok(id: Id, result: Json): Json {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: Id, code: number, message: string, data?: unknown): Json {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** A name from the client, safe to echo in an error. */
function printable(s: string): string {
  return /^[A-Za-z0-9_./-]{1,64}$/.test(s) ? s : "(unreadable)";
}

const keyOf = (id: unknown) => (typeof id === "string" || typeof id === "number" ? `${typeof id}:${id}` : "");

/**
 * The stdio transport: one JSON-RPC message per line in, one per line out. Requests run at the same time, so
 * a wait does not hold up a list. notifications/cancelled stops a request; its answer is then not sent.
 * Resolves when stdin closes.
 */
export async function serveStdio(
  server: McpServer,
  io: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
    log: (line: string) => void;
  },
): Promise<void> {
  // A client that goes away closes the pipe; a write after that must not crash the process.
  io.output.on("error", () => {});
  const send = (m: Json) => io.output.write(`${JSON.stringify(m)}\n`);
  const inflight = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input: io.input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send(fail(null, -32700, "Parse error"));
      continue;
    }
    if (isObject(msg) && msg.method === "notifications/cancelled" && !("id" in msg)) {
      const rid = isObject(msg.params) ? msg.params.requestId : undefined;
      inflight.get(keyOf(rid))?.abort();
      continue;
    }
    const ac = new AbortController();
    const key = isObject(msg) && "id" in msg ? keyOf(msg.id) : "";
    if (key) inflight.set(key, ac);
    const p: Promise<void> = server
      .handle(msg, ac.signal)
      .then((res) => {
        if (res && !ac.signal.aborted) send(res);
      })
      .catch((e: unknown) => io.log(`cf-opencode mcp: ${toFailedLine(e)}`))
      .finally(() => {
        if (key && inflight.get(key) === ac) inflight.delete(key);
        pending.delete(p);
      });
    pending.add(p);
  }
  // stdin closed: the client is gone. Stop the waits; nothing more is written.
  for (const ac of inflight.values()) ac.abort();
  await Promise.allSettled([...pending]);
}

/** `cf-opencode mcp`. Returns when the client closes stdin. */
export async function mcpCommand(version: string): Promise<number> {
  const log = (line: string) => process.stderr.write(`${line}\n`);
  // A stray console.log from any module would corrupt the protocol stream.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  const server = new McpServer(taskTools(localBackend({ cwd: process.cwd(), log })), {
    name: "cf-opencode",
    version,
  });
  log(`cf-opencode mcp ${version}: serving on stdio (MCP ${SUPPORTED_VERSIONS.join(", ")})`);
  await serveStdio(server, { input: process.stdin, output: process.stdout, log });
  return 0;
}
