// A2A (Agent2Agent) protocol 1.0, JSON-RPC binding. Another agent hands a coding task to a workspace.
//   GET  /.well-known/agent-card.json   the Agent Card; public, like the spec asks; says nothing about the user
//   POST /a2a                           JSON-RPC 2.0; the same bearer check as /v1 runs before this
// Off unless CF_OPENCODE_CONFIG has "a2a": true. Off, both paths answer like any unknown path.
//
// An A2A task is one handed-off OpenCode session. Its id is "<workspace>:<ses_…>", so GetTask and CancelTask
// find the workspace without a lookup. The contextId is the workspace id. The workspace comes from the
// message metadata: { workspace, title?, model?, branch? }.
//
// Spec: https://a2a-protocol.org/v1.0.0/specification (sections cited as §).
import type { WorkspaceSessionApi } from "./api";
import { parseConfig } from "./core/config";
import type { Env } from "./env";
import { parseTaskInput, type TaskRecord } from "./orb/tasks";

export const AGENT_CARD_PATH = "/.well-known/agent-card.json";
export const A2A_RPC_PATH = "/a2a";
/** §3.6: Major.Minor. A missing A2A-Version header means 0.3, which this endpoint does not speak. */
export const A2A_VERSION = "1.0";
/** The task text is capped at 32 000 characters; UTF-8 may need four bytes for one. Same as /v1 tasks. */
export const MAX_A2A_BODY = 160 * 1024;
/** §3.2.2: a blocking SendMessage waits for the task to leave working. It gives up after this. */
export const BLOCKING_WAIT_MS = 60 * 60_000;
export const POLL_MS = 10_000;

const WORKSPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TASK_ID_RE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127}):(ses[A-Za-z0-9_-]{1,100})$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,128}$/;
const TEXT_TYPES = new Set(["text/plain", "text/markdown"]);

type A2aSession = Pick<WorkspaceSessionApi, "startTaskAwake" | "tasks" | "cancelTask">;

export interface A2aDeps {
  sessionOf: (workspaceId: string) => A2aSession;
  /** Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function a2aEnabled(env: Pick<Env, "CF_OPENCODE_CONFIG">): boolean {
  try {
    return parseConfig(env.CF_OPENCODE_CONFIG).a2a === true;
  } catch {
    return false;
  }
}

/** §8 and §4.4.1. Built from the request origin; nothing in it names a workspace, a repository or the user. */
export function agentCard(origin: string, version: string): Record<string, unknown> {
  return {
    name: "cf-opencode",
    description:
      "Runs coding tasks with OpenCode in workspaces on Cloudflare Containers. A task works in the Git repository of one workspace and ends with a pushed branch and, when GitHub access is set up, a pull request.",
    supportedInterfaces: [
      { url: `${origin}${A2A_RPC_PATH}`, protocolBinding: "JSONRPC", protocolVersion: A2A_VERSION },
    ],
    version,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: {
      bearer: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          description: "The control token of this cf-opencode install.",
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      {
        id: "coding-task",
        name: "Run a coding task in a workspace",
        description: [
          "Starts an OpenCode session in an existing workspace with the message text as the task. The workspace must have been connected once with cf-opencode connect; a paused one is woken.",
          "Set message.metadata.workspace to the workspace id (required). Optional: metadata.title (one line), metadata.model (provider/model), metadata.branch (the branch to start from).",
          "Send the text in text parts only. The workspace clones from the Git remote: it cannot see changes that are not committed and pushed.",
          "The agent commits, pushes a branch, opens a pull request when GitHub access works, and ends with a Result line.",
          "The task id is <workspace>:<session>. Poll it with GetTask; stop it with CancelTask. A task in TASK_STATE_INPUT_REQUIRED waits for an answer in OpenCode.",
        ].join(" "),
        tags: ["coding", "git", "opencode", "pull-request"],
        examples: ["Fix the failing unit test in src/date.ts and open a pull request."],
        inputModes: ["text/plain"],
        outputModes: ["text/plain", "application/json"],
      },
    ],
  };
}

/** The Agent Card route. null when A2A is off or this is not the card path, so the caller goes on as usual. */
export function a2aCardRoute(req: Request, env: Env, version: string): Response | null {
  const url = new URL(req.url);
  if (url.pathname !== AGENT_CARD_PATH || !a2aEnabled(env)) return null;
  if (req.method !== "GET" && req.method !== "HEAD")
    return httpJson(405, { error: `Failed: ${req.method} ${url.pathname} is not allowed — fix: use GET` });
  return new Response(req.method === "HEAD" ? null : JSON.stringify(agentCard(url.origin, version)), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      etag: `W/"cf-opencode-${version}"`,
    },
  });
}

/**
 * The JSON-RPC endpoint. The caller checked the bearer token first, so nothing here runs, reads the body or
 * says that A2A is on for a caller without it. null when A2A is off.
 */
export async function a2aRpcRoute(req: Request, env: Env, deps: A2aDeps): Promise<Response | null> {
  if (!a2aEnabled(env)) return null;
  if (req.method !== "POST")
    return httpJson(405, {
      error: `Failed: ${req.method} ${A2A_RPC_PATH} is not allowed — fix: send JSON-RPC with POST`,
    });
  const len = Number(req.headers.get("content-length") ?? "0");
  const text = len > MAX_A2A_BODY ? "" : await req.text();
  if (len > MAX_A2A_BODY || text.length > MAX_A2A_BODY)
    return httpJson(
      413,
      rpcError(
        null,
        -32600,
        "Failed: the request is too large — fix: shorten the task; put details in a file in the repository",
        [errorInfo("PAYLOAD_TOO_LARGE")],
      ),
    );
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return httpJson(200, rpcError(null, -32700, "Invalid JSON payload"));
  }
  const url = new URL(req.url);
  const requested = req.headers.get("a2a-version") ?? url.searchParams.get("A2A-Version") ?? "";
  try {
    return httpJson(200, await handleRpc(body, requested, deps));
  } catch (e) {
    // Never echo the error itself: it may hold anything from the Durable Object.
    console.error(`a2a: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400));
    const id =
      isObject(body) && (typeof body.id === "string" || typeof body.id === "number") ? body.id : null;
    return httpJson(
      200,
      rpcError(id, -32603, "Failed: internal error — fix: retry; if it repeats, check the Worker logs"),
    );
  }
}

type RpcId = string | number | null;

/** One JSON-RPC request in, one response object out. Transport-free, for tests. */
export async function handleRpc(
  body: unknown,
  requestedVersion: string,
  deps: A2aDeps,
): Promise<Record<string, unknown>> {
  if (!isObject(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string")
    return rpcError(null, -32600, "Request payload validation error");
  const id = body.id;
  // Every A2A method answers. A request without an id would start work nobody can follow.
  if (typeof id !== "string" && typeof id !== "number")
    return rpcError(null, -32600, "Failed: the request has no id — fix: send a string or number id");
  if (body.params !== undefined && !isObject(body.params))
    return invalid(id, "params", "params must be an object");
  const params = (body.params ?? {}) as Record<string, unknown>;
  const v = majorMinor(requestedVersion || "0.3");
  if (v !== A2A_VERSION)
    return rpcError(
      id,
      -32009,
      `Failed: A2A version ${requestedVersion ? safe(requestedVersion) : "0.3 (no A2A-Version header)"} is not supported — fix: send the header A2A-Version: ${A2A_VERSION}`,
      [errorInfo("VERSION_NOT_SUPPORTED", { supported: A2A_VERSION })],
    );
  if (typeof params.tenant === "string" && params.tenant !== "")
    return invalid(id, "tenant", "this agent declares no tenant; omit it");
  switch (body.method) {
    case "SendMessage":
      return sendMessage(id, params, deps);
    case "GetTask":
      return getTask(id, params, deps);
    case "CancelTask":
      return cancel(id, params, deps);
    case "ListTasks":
      return listTasks(id, params, deps);
    case "SendStreamingMessage":
    case "SubscribeToTask":
      return unsupported(
        id,
        "streaming is not supported (capabilities.streaming is false) — fix: use SendMessage, then GetTask",
      );
    case "GetExtendedAgentCard":
      return unsupported(id, "there is no extended Agent Card — fix: use the public card");
    case "CreateTaskPushNotificationConfig":
    case "GetTaskPushNotificationConfig":
    case "ListTaskPushNotificationConfigs":
    case "DeleteTaskPushNotificationConfig":
      return rpcError(id, -32003, "Failed: push notifications are not supported — fix: poll with GetTask", [
        errorInfo("PUSH_NOTIFICATION_NOT_SUPPORTED"),
      ]);
    default:
      return rpcError(
        id,
        -32601,
        `Method not found${/^[A-Za-z]{1,64}$/.test(body.method) ? `: ${body.method}` : ""}`,
      );
  }
}

// --- Methods ---

async function sendMessage(id: RpcId, params: Record<string, unknown>, deps: A2aDeps) {
  const m = params.message;
  if (!isObject(m)) return invalid(id, "message", "message is required");
  if (m.role !== "ROLE_USER") return invalid(id, "message.role", "role must be ROLE_USER");
  if (typeof m.messageId !== "string" || !m.messageId || m.messageId.length > 256)
    return invalid(id, "message.messageId", "messageId must be a string of 1 to 256 characters");
  const config = params.configuration;
  if (config !== undefined && !isObject(config))
    return invalid(id, "configuration", "configuration must be an object");
  if (config?.taskPushNotificationConfig !== undefined)
    return rpcError(id, -32003, "Failed: push notifications are not supported — fix: poll with GetTask", [
      errorInfo("PUSH_NOTIFICATION_NOT_SUPPORTED"),
    ]);
  if (config?.returnImmediately !== undefined && typeof config.returnImmediately !== "boolean")
    return invalid(id, "configuration.returnImmediately", "returnImmediately must be true or false");
  const history = checkHistoryLength(config?.historyLength);
  if (history) return invalid(id, "configuration.historyLength", history);

  // A message for an existing task would answer it. OpenCode takes answers in its own UI, not here.
  if (m.taskId !== undefined && m.taskId !== "") {
    const ref = typeof m.taskId === "string" ? TASK_ID_RE.exec(m.taskId) : null;
    const found = ref ? await findTask(deps, ref[1] as string, ref[2] as string) : undefined;
    if (!found) return taskNotFound(id);
    return unsupported(
      id,
      `follow-up messages to a task are not supported — fix: answer in OpenCode: cf-opencode connect ${ref?.[1]} --session ${ref?.[2]}`,
    );
  }

  const meta = m.metadata;
  if (!isObject(meta) || meta.workspace === undefined)
    return invalid(
      id,
      "message.metadata.workspace",
      "set metadata.workspace to the id of a workspace connected with cf-opencode connect",
    );
  const workspace = meta.workspace;
  if (typeof workspace !== "string" || !WORKSPACE_RE.test(workspace))
    return invalid(id, "message.metadata.workspace", "a workspace id is letters, digits, _ and -");
  if (m.contextId !== undefined && m.contextId !== "" && m.contextId !== workspace)
    return invalid(
      id,
      "message.contextId",
      "the contextId of a task is its workspace id; omit it or send the same value",
    );
  if (meta.branch !== undefined && (typeof meta.branch !== "string" || !BRANCH_RE.test(meta.branch)))
    return invalid(id, "message.metadata.branch", "branch names are letters, digits, . _ / -");

  const parts = m.parts;
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 100)
    return invalid(id, "message.parts", "send 1 to 100 parts");
  const texts: string[] = [];
  for (const p of parts) {
    if (!isObject(p)) return invalid(id, "message.parts", "each part must be an object");
    const kinds = ["text", "raw", "url", "data"].filter((k) => p[k] !== undefined);
    if (kinds.length !== 1)
      return invalid(id, "message.parts", "each part holds exactly one of text, raw, url or data");
    if (
      kinds[0] !== "text" ||
      (p.mediaType !== undefined && p.mediaType !== "" && !TEXT_TYPES.has(String(p.mediaType)))
    )
      return rpcError(
        id,
        -32005,
        "Failed: only text parts are supported — fix: send the task as text/plain",
        [errorInfo("CONTENT_TYPE_NOT_SUPPORTED")],
      );
    if (typeof p.text !== "string") return invalid(id, "message.parts.text", "text must be a string");
    texts.push(p.text);
  }
  const task = texts.join("\n\n").trim();
  const parsed = parseTaskInput({
    text: task ? closingInstruction(task, meta.branch as string | undefined) : "",
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    ...(meta.model !== undefined ? { model: meta.model } : {}),
  });
  if ("error" in parsed) return invalid(id, "message", `${parsed.error}; ${parsed.fix}`);

  const session = deps.sessionOf(workspace);
  const started = await session.startTaskAwake(parsed.input);
  if (!started.ok) {
    // A workspace the Worker cannot use is the caller's parameter; anything else is the agent's failure.
    const code = started.status === 404 || started.status === 410 ? -32602 : -32603;
    return rpcError(id, code, started.error);
  }
  let rec: TaskRecord = started.task;
  if (config?.returnImmediately !== true) rec = await waitWhileRunning(session, rec, deps);
  return result(id, { task: toA2aTask(workspace, rec) });
}

async function getTask(id: RpcId, params: Record<string, unknown>, deps: A2aDeps) {
  const ref = parseTaskId(params.id);
  if (!ref) return invalid(id, "id", "a task id is <workspace>:<ses_…>, as SendMessage returned it");
  const history = checkHistoryLength(params.historyLength);
  if (history) return invalid(id, "historyLength", history);
  const rec = await findTask(deps, ref.workspace, ref.session);
  if (!rec) return taskNotFound(id);
  return result(id, toA2aTask(ref.workspace, rec));
}

async function cancel(id: RpcId, params: Record<string, unknown>, deps: A2aDeps) {
  const ref = parseTaskId(params.id);
  if (!ref) return invalid(id, "id", "a task id is <workspace>:<ses_…>, as SendMessage returned it");
  const session = deps.sessionOf(ref.workspace);
  const rec = await findTask(deps, ref.workspace, ref.session);
  if (!rec) return taskNotFound(id);
  const state = a2aState(rec.state);
  if (state !== "TASK_STATE_WORKING" && state !== "TASK_STATE_INPUT_REQUIRED")
    return notCancelable(id, `the task is already ${state}`);
  const r = await session.cancelTask(ref.session);
  if (!r.ok) return notCancelable(id, r.error.replace(/^Failed: /, "").replace(/ — fix: .*$/, ""));
  // OpenCode took the interrupt. Report it as canceled now; GetTask reads the session's own outcome later.
  return result(
    id,
    toA2aTask(ref.workspace, rec, {
      state: "TASK_STATE_CANCELED",
      note: "The task was canceled: its OpenCode session was interrupted.",
    }),
  );
}

async function listTasks(id: RpcId, params: Record<string, unknown>, deps: A2aDeps) {
  // The Worker keeps no index of workspaces, so a list is per workspace: contextId names it.
  const ws = params.contextId;
  if (typeof ws !== "string" || !WORKSPACE_RE.test(ws))
    return invalid(id, "contextId", "set contextId to a workspace id; tasks are listed per workspace");
  const size = params.pageSize === undefined ? 50 : params.pageSize;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > 100)
    return invalid(id, "pageSize", "pageSize is a whole number from 1 to 100");
  const token = params.pageToken ?? "";
  if (typeof token !== "string" || (token !== "" && !/^[0-9]{1,6}$/.test(token)))
    return invalid(id, "pageToken", "pass the nextPageToken of the last answer");
  const history = checkHistoryLength(params.historyLength);
  if (history) return invalid(id, "historyLength", history);
  const status = params.status;
  if (status !== undefined && (typeof status !== "string" || !A2A_STATES.has(status)))
    return invalid(id, "status", "status is one TaskState name, for example TASK_STATE_WORKING");
  const after = params.statusTimestampAfter;
  const afterMs = typeof after === "string" ? Date.parse(after) : undefined;
  if (after !== undefined && (afterMs === undefined || Number.isNaN(afterMs)))
    return invalid(id, "statusTimestampAfter", "an ISO 8601 time, for example 2026-01-01T00:00:00Z");
  if (params.includeArtifacts !== undefined && typeof params.includeArtifacts !== "boolean")
    return invalid(id, "includeArtifacts", "includeArtifacts must be true or false");

  const list = await deps.sessionOf(ws).tasks();
  const all = list.tasks
    .map((t) => toA2aTask(ws, t))
    .filter((t) => status === undefined || t.status.state === status)
    .filter((t) => afterMs === undefined || Date.parse(t.status.timestamp) >= afterMs)
    // §3.1.4: newest status first.
    .sort((a, b) => Date.parse(b.status.timestamp) - Date.parse(a.status.timestamp));
  const from = token ? Number(token) : 0;
  const page = all.slice(from, from + size).map((t) => {
    if (params.includeArtifacts === true) return t;
    const { artifacts: _, ...rest } = t;
    return rest;
  });
  const next = from + size < all.length ? String(from + size) : "";
  return result(id, { tasks: page, nextPageToken: next, pageSize: size, totalSize: all.length });
}

// --- Tasks ---

/** §4.1.3 names, as ProtoJSON writes them (§5.5). */
const A2A_STATES = new Set([
  "TASK_STATE_UNSPECIFIED",
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
]);

/**
 * cf-opencode task state → A2A TaskState. `stopped` (the session was interrupted before it finished) is
 * CANCELED, "canceled before completion". A state this code does not know is UNSPECIFIED, which the spec
 * defines as "unknown or indeterminate": it claims neither success nor failure, and ends a blocking wait.
 */
export function a2aState(state: string): string {
  switch (state) {
    case "running":
      return "TASK_STATE_WORKING";
    case "waiting":
      return "TASK_STATE_INPUT_REQUIRED";
    case "done":
      return "TASK_STATE_COMPLETED";
    case "failed":
      return "TASK_STATE_FAILED";
    case "stopped":
      return "TASK_STATE_CANCELED";
    default:
      return "TASK_STATE_UNSPECIFIED";
  }
}

/** Fields a newer task record may carry. Read with care; pass the record through as it is. */
type AnyRecord = TaskRecord & Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

export interface A2aTask {
  id: string;
  contextId: string;
  status: { state: string; timestamp: string; message?: Record<string, unknown> };
  artifacts?: Record<string, unknown>[];
  metadata: Record<string, unknown>;
}

/**
 * §4.1.1. The summary is the result, so it is an artifact (§3.7: results are artifacts, not messages).
 * A status message says why the task waits, failed or stopped, or what it did last while it works. Branch,
 * commits and pull request are a data artifact. The whole cf-opencode record rides in metadata.task.
 */
export function toA2aTask(
  workspace: string,
  record: TaskRecord,
  override?: { state: string; note: string },
): A2aTask {
  const r = record as AnyRecord;
  const taskId = `${workspace}:${r.id}`;
  const state = override?.state ?? a2aState(String(r.state));
  const note = override?.note;
  const summary = str(r.summary) ?? str(r.last);
  const error = str(r.error) ?? str(r.reason);
  const time = typeof r.updated === "number" ? r.updated : r.started;
  let say: string | undefined;
  if (note) say = note;
  else if (state === "TASK_STATE_INPUT_REQUIRED")
    say =
      str(r.question) ??
      summary ??
      `The agent waits for an answer or a permission. Answer it in OpenCode: cf-opencode connect ${workspace} --session ${r.id}`;
  else if (state === "TASK_STATE_FAILED") say = error ?? "The task failed.";
  else if (state === "TASK_STATE_CANCELED") say = error ?? "The task was stopped before it finished.";
  else if (state === "TASK_STATE_WORKING") say = summary;
  const artifacts: Record<string, unknown>[] = [];
  if (state === "TASK_STATE_COMPLETED" && summary)
    artifacts.push({
      artifactId: "result",
      name: "Result",
      parts: [{ text: summary, mediaType: "text/plain" }],
    });
  const changes: Record<string, unknown> = {};
  for (const k of ["branch", "commits", "pullRequest", "changedFiles"])
    if (r[k] !== undefined) changes[k] = r[k];
  if (Object.keys(changes).length > 0)
    artifacts.push({
      artifactId: "changes",
      name: "Changes",
      description: "The branch, commits and pull request of the task.",
      parts: [{ data: changes, mediaType: "application/json" }],
    });
  if (r.structured !== undefined)
    artifacts.push({
      artifactId: "structured",
      name: "Structured result",
      parts: [{ data: r.structured, mediaType: "application/json" }],
    });
  return {
    id: taskId,
    contextId: workspace,
    status: {
      state,
      timestamp: new Date(Number.isFinite(time) ? time : 0).toISOString(),
      ...(say
        ? {
            message: {
              messageId: `${taskId}:${state}:${time}`,
              contextId: workspace,
              taskId,
              role: "ROLE_AGENT",
              parts: [{ text: say }],
            },
          }
        : {}),
    },
    ...(artifacts.length > 0 ? { artifacts } : {}),
    metadata: { workspace, task: r },
  };
}

/** The text sent to OpenCode: the task, then the same closing instruction `cf-opencode run` adds. */
export function closingInstruction(task: string, branch?: string): string {
  return [
    task,
    "",
    "---",
    "This task came from another agent over A2A. Nobody watches this session. When you finish:",
    ...(branch
      ? [
          `- Start from branch \`${branch}\` as it is on origin: run \`git fetch origin\`, check out \`${branch}\`, and fast-forward it to \`origin/${branch}\`.`,
        ]
      : []),
    "- Commit the work. If you are on the default branch, first make a new branch for it.",
    "- Push the branch to origin.",
    "- If `gh auth status` succeeds, open a pull request for the branch, or update the open one.",
    "- End your last message with one line: `Result: <what changed>; branch <name>; pull request <URL or none>`.",
  ].join("\n");
}

async function findTask(deps: A2aDeps, workspace: string, session: string): Promise<TaskRecord | undefined> {
  const list = await deps.sessionOf(workspace).tasks();
  return list.tasks.find((t) => t.id === session);
}

/** §3.2.2: blocking is the default. Poll the saved state; each read is one short Durable Object call. */
async function waitWhileRunning(session: A2aSession, rec: TaskRecord, deps: A2aDeps): Promise<TaskRecord> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = now() + BLOCKING_WAIT_MS;
  let cur = rec;
  while (a2aState(String(cur.state)) === "TASK_STATE_WORKING" && now() + POLL_MS <= until) {
    await sleep(POLL_MS);
    const list = await session.tasks().catch(() => undefined);
    const next = list?.tasks.find((t) => t.id === cur.id);
    if (next) cur = next;
  }
  return cur;
}

function parseTaskId(v: unknown): { workspace: string; session: string } | undefined {
  const m = typeof v === "string" ? TASK_ID_RE.exec(v) : null;
  return m ? { workspace: m[1] as string, session: m[2] as string } : undefined;
}

function checkHistoryLength(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  return typeof v === "number" && Number.isInteger(v) && v >= 0
    ? undefined
    : "historyLength is a whole number, 0 or more";
}

function majorMinor(v: string): string | undefined {
  const m = /^\s*(\d{1,3})\.(\d{1,3})(?:\.\d{1,3})?\s*$/.exec(v);
  return m ? `${m[1]}.${m[2]}` : undefined;
}

// --- JSON-RPC ---

function result(id: RpcId, value: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result: value };
}

function rpcError(id: RpcId, code: number, message: string, data?: unknown[]): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

/** §9.5: error details are ProtoJSON Any objects; A2A errors carry a google.rpc.ErrorInfo. */
function errorInfo(reason: string, metadata?: Record<string, string>): Record<string, unknown> {
  return {
    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
    reason,
    domain: "a2a-protocol.org",
    ...(metadata ? { metadata } : {}),
  };
}

function invalid(id: RpcId, field: string, description: string): Record<string, unknown> {
  return rpcError(id, -32602, `Failed: invalid ${field} — fix: ${description}`, [
    { "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field, description }] },
  ]);
}

function unsupported(id: RpcId, what: string): Record<string, unknown> {
  return rpcError(id, -32004, `Failed: ${what}`, [errorInfo("UNSUPPORTED_OPERATION")]);
}

function taskNotFound(id: RpcId): Record<string, unknown> {
  return rpcError(id, -32001, "Failed: task not found — fix: use a task id that SendMessage returned", [
    errorInfo("TASK_NOT_FOUND"),
  ]);
}

function notCancelable(id: RpcId, why: string): Record<string, unknown> {
  return rpcError(id, -32002, `Failed: the task cannot be canceled: ${why} — fix: check it with GetTask`, [
    errorInfo("TASK_NOT_CANCELABLE"),
  ]);
}

function httpJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A version string from a header, safe to put in an error: short, plain characters only. */
function safe(v: string): string {
  return /^[A-Za-z0-9._-]{1,16}$/.test(v) ? v : "(unreadable)";
}
