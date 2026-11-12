// The tools of `cf-opencode mcp`: hand off a task, read one, wait for one, list them.
// They do what `run` and `tasks` do, and return the task record as structured data. mcp.ts speaks the protocol.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { ControlClient, type RemoteTask } from "./api.js";
import { readControlToken, readInstall, readWorkspace } from "./config.js";
import { type ConnectInput, type ConnectResult, connect, httpsRemote, workspaceIdFrom } from "./connect.js";
import { CliError } from "./errors.js";
import { preflight, renderStarted, runTask } from "./handoff.js";
import { localWorkspaceIds } from "./sessions.js";
import { resultOf } from "./task-result.js";
import {
  findTask,
  listTasks,
  renderTask,
  renderTasks,
  type TasksResult,
  type TaskView,
  WAIT_INTERVAL_MS,
  WaitTimeout,
  waitTask,
} from "./tasks.js";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
}

/** What a tool returns: structured content, and the same as text for a model that reads text only. */
export interface ToolOutput {
  structured: Record<string, unknown>;
  text: string;
}

export interface McpTool {
  def: ToolDef;
  run: (args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolOutput>;
}

export interface StartArgs {
  task: string;
  directory?: string;
  workspace?: string;
  title?: string;
  model?: string;
  allowDirty: boolean;
}

/** The task operations, so tests can run the tools without a Worker. */
export interface TaskBackend {
  start(a: StartArgs): Promise<{ workspace: string; task: RemoteTask; warning?: string }>;
  get(session: string, workspace?: string): Promise<TaskView>;
  wait(
    session: string,
    workspace: string | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<TaskView & { timedOut: boolean }>;
  list(workspace?: string): Promise<TasksResult>;
}

export const WAIT_DEFAULT_SECONDS = 240;
/** Most MCP clients end a tool call after 5 minutes. A wait stays under that. */
export const WAIT_MAX_SECONDS = 280;

const SESSION_RE = /^ses[A-Za-z0-9_-]{1,100}$/;
const WORKSPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_TASK_CHARS = 32_000;

// --- Schemas ---

const WHAT_IT_CANNOT_SEE =
  "The workspace clones from the Git remote: it cannot see changes that are not committed, commits that are not pushed, or files outside the repository.";

const TASK_SCHEMA = {
  type: "object",
  description:
    "The task record. Newer Workers add fields such as summary (the result text; older ones send last), error (older ones send reason), branch, commits, pullRequest, changedFiles and question.",
  properties: {
    id: { type: "string", description: "The OpenCode session id, ses_…" },
    title: { type: "string" },
    state: {
      type: "string",
      description:
        "running, waiting (a question or a permission), done, failed, or stopped. Treat any other value as not finished and not successful.",
    },
    started: { type: "number", description: "Epoch milliseconds." },
    updated: { type: "number", description: "Epoch milliseconds of the last change." },
    model: { type: "string" },
    last: { type: "string", description: "The end of the last assistant message with text." },
    reason: { type: "string", description: "Why the task failed, when known." },
  },
  required: ["id", "title", "state", "started"],
  additionalProperties: true,
} as const;

/** The result record (worker/src/orb/task-result.ts), the same object `tasks <ses_…> --json` prints. */
const RESULT_SCHEMA = {
  type: "object",
  description:
    "The task's result record: state, summary, and the facts git read in the workspace (branch, commits, changedFiles, pullRequest), the question of a waiting task, the error of a failed one, and structured when run --schema was used. Built from task when the Worker sends none.",
  properties: {
    id: { type: "string" },
    workspace: { type: "string" },
    state: { type: "string" },
    title: { type: "string" },
    summary: { type: "string", description: "The end of the last assistant message with text." },
    branch: { type: "string" },
    commits: { type: "array", items: { type: "object" } },
    pullRequest: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    question: { type: "string" },
    error: { type: "string" },
    started: { type: "string", description: "ISO 8601." },
    updated: { type: "string", description: "ISO 8601." },
  },
  required: ["id", "workspace", "state", "title", "summary", "started", "updated"],
  additionalProperties: true,
} as const;

const VIEW_PROPERTIES = {
  workspace: { type: "string", description: "The workspace id." },
  result: RESULT_SCHEMA,
  task: TASK_SCHEMA,
  live: {
    type: "boolean",
    description: "True when the running workspace answered; false for its saved copy.",
  },
  at: { type: "string", description: "When the saved copy was read, ISO 8601." },
} as const;

const workspaceArg = {
  type: "string",
  description:
    "Workspace id. Default: the workspace that has this session, found in this machine's workspaces.",
} as const;
const sessionArg = {
  type: "string",
  description: "The session id (ses_…) that handoff_task returned.",
} as const;

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "handoff_task",
    title: "Hand off a task to a cloud workspace",
    description: [
      "Hand a coding task to OpenCode in a cf-opencode workspace on Cloudflare, and return at once.",
      "Use it for work that can go on alone for minutes or hours: the task keeps running after this session ends and after the laptop closes.",
      WHAT_IT_CANNOT_SEE,
      "Commit and push first; the call fails on such changes unless allowDirty is true.",
      "The remote agent has not seen this conversation. Write the task as a full brief: the goal, the branch, the constraints, and how to prove the change works.",
      "The agent commits, pushes a branch, opens a pull request when GitHub access works, and ends with a Result line.",
      "Returns the workspace and the session id. Follow it with wait_task or get_task.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The full task brief.", maxLength: MAX_TASK_CHARS },
        directory: {
          type: "string",
          description:
            "The local git checkout the task is about: the directory the MCP client started this server in (the default), or a folder under it. Any other path is refused.",
        },
        workspace: {
          type: "string",
          description: "Workspace id. Default: the checkout's workspace, as cf-opencode connect names it.",
        },
        title: { type: "string", description: "Session title. Default: from the task." },
        model: {
          type: "string",
          description:
            "provider/model, for example cloudflare-workers-ai/@cf/zai-org/glm-5.3. Default: the workspace's model.",
        },
        allowDirty: {
          type: "boolean",
          description:
            "Start even when the checkout has changes that are not committed or pushed. The workspace will not see them.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string" },
        session: { type: "string", description: "The session id. Pass it to get_task and wait_task." },
        task: TASK_SCHEMA,
        warning: {
          type: "string",
          description: "What the workspace will not see, when allowDirty skipped the check.",
        },
      },
      required: ["workspace", "session", "task"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "get_task",
    title: "Read a handed-off task",
    description: [
      "Read the state of one handed-off task, once. It does not wake a paused workspace.",
      "States: running; waiting (the agent asks a question or a permission: tell the user to answer it with cf-opencode connect <workspace> --session <session>); done; failed; stopped.",
      "A done task names its branch and pull request in its result text. Use wait_task to wait for a change instead of calling this in a loop.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: { session: sessionArg, workspace: workspaceArg },
      required: ["session"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: VIEW_PROPERTIES,
      required: ["workspace", "result", "task", "live"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "wait_task",
    title: "Wait for a handed-off task",
    description: [
      `Wait until a handed-off task leaves the running state, or until timeoutSeconds pass (default ${WAIT_DEFAULT_SECONDS}, at most ${WAIT_MAX_SECONDS}).`,
      "The limit keeps the call under the usual 5-minute tool timeout of MCP clients.",
      "Returns the task and timedOut. When timedOut is true the task still runs: call wait_task again, or do other work and check later with get_task.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        session: sessionArg,
        workspace: workspaceArg,
        timeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: WAIT_MAX_SECONDS,
          description: `How long to wait. Default ${WAIT_DEFAULT_SECONDS}.`,
        },
      },
      required: ["session"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        ...VIEW_PROPERTIES,
        timedOut: { type: "boolean", description: "True when the task still ran at the timeout." },
      },
      required: ["workspace", "result", "task", "live", "timedOut"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "list_tasks",
    title: "List handed-off tasks",
    description: [
      "List the tasks handed off from this machine, newest first, across the workspaces it connected to, or in one workspace.",
      "It wakes nothing: a paused workspace answers with the states saved at its last refresh.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: { workspace: { type: "string", description: "Only this workspace." } },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: { ...TASK_SCHEMA, properties: { ...TASK_SCHEMA.properties, workspace: { type: "string" } } },
        },
        workspaces: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              live: { type: "boolean" },
              at: { type: "string" },
              error: { type: "string", description: "Why this workspace did not answer." },
            },
            required: ["id", "live"],
          },
        },
      },
      required: ["rows", "workspaces"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

// --- Argument checks. A bad argument is a tool error the model can read and fix. ---

function optString(args: Record<string, unknown>, key: string, max = 4096): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length > max)
    throw new CliError(`${key} must be a string of up to ${max} characters`, `pass ${key} as text`);
  return v.trim() ? v : undefined;
}

function sessionOf(args: Record<string, unknown>): string {
  const s = optString(args, "session", 200);
  if (!s || !SESSION_RE.test(s))
    throw new CliError("session must be a ses_… id", "pass the session that handoff_task returned");
  return s;
}

function workspaceOf(args: Record<string, unknown>): string | undefined {
  const w = optString(args, "workspace", 128);
  if (w !== undefined && !WORKSPACE_RE.test(w))
    throw new CliError(`bad workspace ${JSON.stringify(w.slice(0, 40))}`, "use letters, digits, _ and -");
  return w;
}

/**
 * One task for a model: the result record the Worker built (`result`), or the part of it the task record gives
 * (resultOf) from a Worker before 0.2; then the task record as it came.
 */
function view(v: TaskView): Record<string, unknown> {
  const { result: _, ...rest } = v;
  return { ...rest, result: resultOf(v.workspace, v), task: { ...v.task } };
}

/** Text first for a reader; then the same data as JSON, as the MCP spec asks for structured content. */
function both(text: string, structured: Record<string, unknown>): ToolOutput {
  return { structured, text: `${text}\n\n${JSON.stringify(structured)}` };
}

export function taskTools(backend: TaskBackend): McpTool[] {
  const byName = new Map(TOOL_DEFS.map((d) => [d.name, d]));
  const def = (n: string) => byName.get(n) as ToolDef;
  return [
    {
      def: def("handoff_task"),
      run: async (args) => {
        const task = optString(args, "task", MAX_TASK_CHARS);
        if (!task) throw new CliError("task is empty", "pass the full task brief as task");
        if (args.allowDirty !== undefined && typeof args.allowDirty !== "boolean")
          throw new CliError("allowDirty must be true or false", "pass a boolean");
        const directory = optString(args, "directory");
        const workspace = workspaceOf(args);
        const title = optString(args, "title", 200);
        const model = optString(args, "model", 300);
        const r = await backend.start({
          task,
          ...(directory ? { directory } : {}),
          ...(workspace ? { workspace } : {}),
          ...(title ? { title } : {}),
          ...(model ? { model } : {}),
          allowDirty: args.allowDirty === true,
        });
        const out = {
          workspace: r.workspace,
          session: r.task.id,
          task: { ...r.task },
          ...(r.warning ? { warning: r.warning } : {}),
        };
        return both([r.warning, renderStarted(r)].filter(Boolean).join("\n"), out);
      },
    },
    {
      def: def("get_task"),
      run: async (args) => {
        const v = await backend.get(sessionOf(args), workspaceOf(args));
        return both(renderTask(v), view(v));
      },
    },
    {
      def: def("wait_task"),
      run: async (args, signal) => {
        const session = sessionOf(args);
        const workspace = workspaceOf(args);
        const raw = args.timeoutSeconds ?? WAIT_DEFAULT_SECONDS;
        if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > WAIT_MAX_SECONDS)
          throw new CliError(
            `timeoutSeconds must be a whole number from 1 to ${WAIT_MAX_SECONDS}`,
            `pass ${WAIT_DEFAULT_SECONDS}, then call wait_task again`,
          );
        const v = await backend.wait(session, workspace, raw * 1000, signal);
        const head = v.timedOut
          ? `Still running after ${raw} s. Call wait_task again, or check later with get_task.\n`
          : "";
        return both(`${head}${renderTask(v)}`, { ...view(v), timedOut: v.timedOut });
      },
    },
    {
      def: def("list_tasks"),
      run: async (args) => {
        const r = await backend.list(workspaceOf(args));
        return both(renderTasks(r), { rows: r.rows, workspaces: r.workspaces });
      },
    },
  ];
}

// --- The backend on this machine: the install, the control token and the workspaces it connected to. ---

export interface LocalDeps {
  cwd: string;
  log: (line: string) => void;
  install?: () => { url: string; token: string };
  client?: (url: string, token: string) => Pick<ControlClient, "startTask" | "task" | "tasks">;
  connect?: (input: ConnectInput) => Promise<ConnectResult>;
  workspaceIds?: () => string[];
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The install as `run` finds it, without flags: ~/.cf-opencode, then the environment. */
export function installFromState(): { url: string; token: string } {
  const url = process.env.CF_OPENCODE_URL ?? readInstall()?.url;
  const token = readControlToken() ?? process.env.CF_OPENCODE_CONTROL_TOKEN;
  if (!url) throw new CliError("no Worker URL", "run cf-opencode init on this machine");
  if (!token) throw new CliError("no control token", "cf-opencode init writes ~/.cf-opencode/control-token");
  return { url, token };
}

function originRemote(dir: string): string | undefined {
  try {
    return httpsRemote(
      execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return undefined;
  }
}

/** A sleep that ends early, with an error, when the client cancels the call. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((ok, fail) => {
    if (signal.aborted) return fail(new Error("cancelled"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      ok();
    }, ms);
    const stop = () => {
      clearTimeout(t);
      fail(new Error("cancelled"));
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

export function localBackend(d: LocalDeps): TaskBackend {
  const install = d.install ?? installFromState;
  const client = d.client ?? ((url: string, token: string) => new ControlClient(url, token));
  const ids = d.workspaceIds ?? localWorkspaceIds;
  const sleep = d.sleep ?? abortableSleep;
  const where = async (c: Pick<ControlClient, "tasks">, session: string, workspace?: string) =>
    workspace ?? (await findTask(c, ids(), session));
  return {
    async start(a) {
      const { url, token } = install();
      const dir = insideStart(d.cwd, a.directory);
      const p = preflight(dir);
      if (!p.checkout && !a.workspace)
        throw new CliError(`${dir} is not a git checkout`, "pass directory (a git checkout) or workspace");
      const id = a.workspace ?? workspaceIdFrom(dir);
      // connect reads the remote and branch of its own working directory. This server may run elsewhere,
      // so a workspace this machine has not connected yet gets them from the checkout named here.
      const fresh = !readWorkspace(id) && p.checkout;
      const repoUrl = fresh ? originRemote(dir) : undefined;
      const branch = fresh ? p.branch : undefined;
      try {
        return await runTask(
          {
            url,
            token,
            task: a.task,
            id,
            ...(a.title ? { title: a.title } : {}),
            ...(a.model ? { model: a.model } : {}),
            allowDirty: a.allowDirty,
            origin: "mcp",
            dir,
            onLine: d.log,
          },
          {
            connect: (ci) =>
              (d.connect ?? connect)({
                ...ci,
                ...(repoUrl && !ci.repoUrl ? { repoUrl } : {}),
                ...(branch && !ci.branch ? { branch } : {}),
              }),
            client,
          },
        );
      } catch (e) {
        // The preflight names the CLI flag; a model sets the argument.
        if (e instanceof CliError && e.message.endsWith("pass --allow-dirty"))
          throw new CliError(
            e.message.replace(/ — fix: .*$/, "").replace(/^Failed: /, ""),
            "commit and git push, or set allowDirty to true",
          );
        throw e;
      }
    },
    async get(session, workspace) {
      const { url, token } = install();
      const c = client(url, token);
      const ws = await where(c, session, workspace);
      return { workspace: ws, ...(await c.task(ws, session)) };
    },
    async wait(session, workspace, timeoutMs, signal) {
      const { url, token } = install();
      const c = client(url, token);
      const ws = await where(c, session, workspace);
      try {
        const v = await waitTask(c, ws, session, {
          timeoutMs,
          // A short wait still checks a few times.
          intervalMs: Math.min(WAIT_INTERVAL_MS, Math.max(1000, Math.floor(timeoutMs / 4))),
          sleep: (ms) => sleep(ms, signal),
          onLine: d.log,
        });
        return { ...v, timedOut: false };
      } catch (e) {
        if (!(e instanceof WaitTimeout)) throw e;
        return { workspace: ws, ...(await c.task(ws, session)), timedOut: true };
      }
    },
    async list(workspace) {
      const { url, token } = install();
      return listTasks(client(url, token), workspace ? [workspace] : ids());
    },
  };
}

/**
 * The checkout a tool call names, which must be the folder this server started in or a folder under it.
 * The caller is a model, possibly one that read hostile text: it must not point the CLI (which runs git
 * there, and can make a workspace from that checkout's remote) at another project on the machine.
 */
export function insideStart(cwd: string, directory?: string): string {
  const dir = resolve(cwd, directory ?? ".");
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const rel = relative(real(cwd), real(dir));
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new CliError(
      `${dir} is outside the folder this MCP server started in`,
      "start the MCP server in that project, or leave directory out",
    );
  return dir;
}
