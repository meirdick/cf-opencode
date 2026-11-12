// HTTP routing.
// Control routes (/v1/...) require a bearer CONTROL_TOKEN.
// The OpenCode ingress (/oc/<id>/...) requires the per-workspace basic password, then proxies.
// Responses never carry stack traces. Errors are one line: "Failed: <cause> — fix: <action>".
import { basicPassword, timingSafeEqualStr } from "./auth";
import { parseConfig } from "./core/config";
import { PRUNE_DEFAULT_AGE_MS } from "./core/registry-core";
import {
  OPENCODE_USERNAME,
  type OpRecord,
  type OpRequest,
  type WorkspaceOp,
  type WorkspaceStatus,
} from "./core/types";
import { type Env, REGISTRY_DO_NAME, workspaceDoName } from "./env";
import { connectCdp, relay, SESSION_ID_RE } from "./orb/browse";
import type { SessionList } from "./orb/sessions";
import type { StartResult, TaskInput, TaskList, TaskOne } from "./orb/tasks";
import { isPreviewPath, previewControl, previewFallback, previewIngress } from "./preview-ingress";
import { tasksRoute } from "./tasks-api";

export const API_VERSION = "0.1.0";

/** Workspace ids: start with a letter or digit, then letters, digits, _ or -. */
export const WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OP_UUID_RE = /^[A-Za-z0-9-]{1,64}$/;
const OPS: readonly WorkspaceOp[] = ["spawn", "pause", "delete", "rebuild"];
export const MAX_WAIT_MS = 25_000;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_LOG_LINES = 1000;

export interface WorkspaceSessionApi {
  submitOp(req: OpRequest): Promise<{ opId: string; attached: boolean }>;
  getOp(opId: string, waitMs: number, since?: number): Promise<OpRecord | null>;
  status(): Promise<WorkspaceStatus>;
  logs(lines: number): Promise<{ containerRunning: boolean; log: string }>;
  sessions(): Promise<SessionList>;
  /** Start a handed-off task in the running workspace. */
  startTask(input: TaskInput): Promise<StartResult>;
  /** Handed-off tasks: live from a running workspace, else the saved copy. Wakes nothing. */
  tasks(): Promise<TaskList>;
  /** One task and its result record; `seen` clears its unseen mark. Wakes nothing. */
  task(sessionId: string, seen?: boolean): Promise<TaskOne | undefined>;
  /** Proxy to opencode serve. Wakes a paused workspace when the password header is present. */
  proxy(req: Request): Promise<Response>;
  /** Open a Browser Run session for this workspace through the Browser Run binding. */
  browse(
    password: string,
    keepAliveMs?: number,
    previewPorts?: number[],
  ): Promise<{ ok: true; session: unknown } | { ok: false; error: string; status: number }>;
  /** True when the password is this workspace's. Wakes nothing. */
  authorize(password: string): Promise<boolean>;
  /** Websocket terminals: /shell (tmux on a PTY) and /ssh (sshd -i). Checks the password itself. */
  fetch(req: Request): Promise<Response>;
}

interface ProjectSnapshotAdmin {
  listProjectSnapshots(): Promise<unknown[]>;
  forgetProjectSnapshot(snapshotId: string): Promise<boolean>;
  status(): Promise<unknown>;
}

interface SnapshotIndexAdmin {
  listSnapshots(): Promise<unknown[]>;
  pruneCandidates(olderThanMs: number): Promise<unknown>;
  forgetSnapshots(ids: string[]): Promise<unknown>;
  status(): Promise<unknown>;
}

export const MAX_FORGET_IDS = 1000;
export const CF_SNAPSHOT_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;

export function isProjectSnapshotId(id: string): boolean {
  if (id.length < 1 || id.length > 256) return false;
  for (const ch of id) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0x7f || ch === "/") return false;
  }
  return true;
}

export async function handleApi(req: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(req.url);
    if (url.pathname === "/oc" || url.pathname.startsWith("/oc/")) return proxyIngress(req, env);
    if (url.pathname === "/browse" || url.pathname.startsWith("/browse/")) return browseIngress(req, env);
    const term = /^\/(shell|ssh)\/([^/]+)$/.exec(url.pathname);
    if (term) return terminalIngress(req, env, term[1] as "shell" | "ssh", term[2] as string);
    if (isPreviewPath(url.pathname)) return previewIngress(req, env);
    const back = previewFallback(req);
    if (back) return back;
    const denied = await checkAuth(req, env);
    if (denied) return denied;
    return await route(req, env);
  } catch (e) {
    const msg = oneLine(e, 400);
    console.error(`api ${req.method} ${new URL(req.url).pathname}: ${msg}`);
    if (msg.startsWith("Failed:")) return json(500, { error: msg });
    return fail(
      500,
      `internal error: ${msg}`,
      "retry; if it repeats, run cf-opencode logs and check Worker logs",
    );
  }
}

async function checkAuth(req: Request, env: Env): Promise<Response | null> {
  const want = env.CONTROL_TOKEN;
  if (!want) return notFound(req);
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  if (!m?.[1] || !(await timingSafeEqualStr(m[1], want))) {
    return fail(
      401,
      "missing or wrong bearer token",
      "set CF_OPENCODE_CONTROL_TOKEN to the CONTROL_TOKEN secret",
    );
  }
  return null;
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter((p) => p !== "");
  if (parts[0] !== "v1") return notFound(req);
  const [, a, b, c, ...rest] = parts;
  if (a === "workspaces" && b && c === "tasks" && rest.length <= 1)
    return tasksRoute(req, (id) => sessionOf(env, id), b, rest[0]);
  if (rest.length > 0) return notFound(req);
  const method = req.method.toUpperCase();

  if (a === "health" && b === undefined) {
    if (method !== "GET") return methodNotAllowed(method, url.pathname);
    return json(200, { ok: true, name: "cf-opencode", version: API_VERSION });
  }

  if (a === "status" && b === undefined) {
    if (method !== "GET") return methodNotAllowed(method, url.pathname);
    const reg = env.REGISTRY.getByName(REGISTRY_DO_NAME) as unknown as SnapshotIndexAdmin;
    const cfg = configOrNull(env);
    // github: whether the token secret is set, never its value.
    const bindings = {
      ai: Boolean(env.AI),
      browser: Boolean(env.BROWSER),
      github: Boolean(env.GITHUB_TOKEN),
    };
    return json(200, {
      name: "cf-opencode",
      version: API_VERSION,
      config: cfg,
      bindings,
      registry: await reg.status(),
    });
  }

  if (a === "workspaces" && c === "ops" && b) {
    const id = decodeSegment(b);
    if (id === null || !WORKSPACE_ID_RE.test(id))
      return fail(400, "bad workspace id", "use letters, digits, _ and -");
    const session = sessionOf(env, id);
    if (method === "POST") return submit(req, session, id);
    return methodNotAllowed(method, url.pathname);
  }

  if (a === "workspaces" && b && c === undefined) {
    const id = decodeSegment(b);
    if (id === null || !WORKSPACE_ID_RE.test(id))
      return fail(400, "bad workspace id", "use letters, digits, _ and -");
    if (method === "GET") return json(200, await sessionOf(env, id).status());
    if (method === "DELETE") {
      const { opId } = await sessionOf(env, id).submitOp({ op: "delete" });
      return json(202, { opId });
    }
    return methodNotAllowed(method, url.pathname);
  }

  if (a === "workspaces" && b && c === "sessions") {
    const id = decodeSegment(b);
    if (id === null || !WORKSPACE_ID_RE.test(id))
      return fail(400, "bad workspace id", "use letters, digits, _ and -");
    if (method !== "GET") return methodNotAllowed(method, url.pathname);
    return json(200, await sessionOf(env, id).sessions());
  }

  if (a === "workspaces" && b && c === "previews") {
    const id = decodeSegment(b);
    if (id === null || !WORKSPACE_ID_RE.test(id))
      return fail(400, "bad workspace id", "use letters, digits, _ and -");
    return previewControl(req, env, id);
  }

  if (a === "workspaces" && b && c === "logs") {
    const id = decodeSegment(b);
    if (id === null || !WORKSPACE_ID_RE.test(id))
      return fail(400, "bad workspace id", "use letters, digits, _ and -");
    if (method !== "GET") return methodNotAllowed(method, url.pathname);
    const lines = clampLines(url.searchParams.get("lines"));
    return json(200, await sessionOf(env, id).logs(lines));
  }

  if (a === "ops" && b && c === undefined) {
    if (method !== "GET") return methodNotAllowed(method, url.pathname);
    const parsed = parseOpId(b);
    if (!parsed) return fail(400, "bad op id", "op ids look like <workspace>:<uuid>");
    const wait = clampWait(url.searchParams.get("wait"));
    const since = numOrUndefined(url.searchParams.get("since"));
    const rec = await sessionOf(env, parsed.workspaceId).getOp(parsed.opId, wait, since);
    if (!rec) return fail(404, "unknown op", "check the op id");
    return json(200, rec);
  }

  if (a === "project-snapshots" && c === undefined) {
    const reg = env.REGISTRY.getByName(REGISTRY_DO_NAME) as unknown as ProjectSnapshotAdmin;
    if (b === undefined) {
      if (method !== "GET") return methodNotAllowed(method, url.pathname);
      const [projectSnapshots, summary] = await Promise.all([reg.listProjectSnapshots(), reg.status()]);
      return json(200, { projectSnapshots, summary });
    }
    if (method !== "DELETE") return methodNotAllowed(method, url.pathname);
    const id = decodeSegment(b);
    if (id === null || !isProjectSnapshotId(id))
      return fail(400, "bad snapshot id", "pass an id from GET /v1/project-snapshots");
    return json(200, { snapshotId: id, forgotten: await reg.forgetProjectSnapshot(id) });
  }

  if (a === "snapshots" && c === undefined && (b === undefined || b === "prune" || b === "forget-many")) {
    if (method !== (b === "forget-many" ? "POST" : "GET")) return methodNotAllowed(method, url.pathname);
  }

  if (a === "snapshots" && b === undefined && method === "GET") {
    const reg = env.REGISTRY.getByName(REGISTRY_DO_NAME) as unknown as SnapshotIndexAdmin;
    return json(200, { snapshots: await reg.listSnapshots() });
  }

  if (a === "snapshots" && b === "prune" && method === "GET") {
    const reg = env.REGISTRY.getByName(REGISTRY_DO_NAME) as unknown as SnapshotIndexAdmin;
    const raw = url.searchParams.get("olderThanMs");
    const older = raw === null ? PRUNE_DEFAULT_AGE_MS : Number(raw);
    if (!Number.isSafeInteger(older) || older < 0) {
      return fail(400, `bad olderThanMs ${raw}`, "pass a whole number of milliseconds, 0 or more");
    }
    return json(200, await reg.pruneCandidates(older));
  }

  if (a === "snapshots" && b === "forget-many" && method === "POST") {
    const reg = env.REGISTRY.getByName(REGISTRY_DO_NAME) as unknown as SnapshotIndexAdmin;
    const body = await readJson(req).catch(() => null);
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length === 0)
      return fail(400, "ids must be a non-empty array", "send { ids: [...] }");
    if (ids.length > MAX_FORGET_IDS) return fail(400, "too many ids", `send at most ${MAX_FORGET_IDS}`);
    if (ids.some((id) => typeof id !== "string" || !CF_SNAPSHOT_ID_RE.test(id)))
      return fail(400, "bad snapshot id", "ids come from GET /v1/snapshots/prune");
    return json(200, await reg.forgetSnapshots(ids as string[]));
  }

  return notFound(req);
}

/**
 * /oc/<workspaceId>/<opencode path>. Basic auth is the per-workspace password.
 * The password also rides to the container as x-cf-opencode-password so a paused workspace can wake.
 */
async function proxyIngress(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter((p) => p !== "");
  const id = parts[1] ? decodeSegment(parts[1]) : null;
  if (!id || !WORKSPACE_ID_RE.test(id)) return new Response("bad workspace id\n", { status: 400 });
  const password = basicPassword(req.headers.get("authorization"));
  if (!password) {
    // JSON, not text. OpenCode 2's client probes /api/info and treats a non-JSON
    // 401 as "not a compatible server" instead of "needs a password".
    return new Response(JSON.stringify({ _tag: "UnauthorizedError", message: "Authentication required" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Basic realm="cf-opencode ${id}"`,
      },
    });
  }
  const rest = parts.slice(2).join("/");
  // getTcpPort().fetch opens a raw TCP connection: https is refused, and the public host
  // makes the container answer its app shell for every path. Cloudflare's own examples
  // rewrite the host to "container" and drop the Host header.
  const target = new URL(req.url);
  target.protocol = "http:";
  target.host = "container";
  target.pathname = rest ? `/${rest}` : "/";
  const headers = new Headers(req.headers);
  headers.set("x-cf-opencode-password", password);
  const forwarded = new Request(target, { method: req.method, headers, body: req.body, redirect: "manual" });
  return sessionOf(env, id).proxy(forwarded);
}

/**
 * POST /browse/<workspaceId> opens a Browser Run session and returns a websocket URL on
 * this Worker. GET /browse/<workspaceId>/<sessionId> with a websocket upgrade is that URL:
 * the Worker connects to the session's CDP socket through the Browser Run binding and relays
 * frames. Both take the workspace's Basic password.
 */
async function browseIngress(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter((p) => p !== "");
  const id = decodeSegment(parts[1] ?? "");
  if (!id || !WORKSPACE_ID_RE.test(id) || parts.length > 3)
    return fail(400, "bad workspace id", "use letters, digits, _ and -");
  const password = basicPassword(req.headers.get("authorization"));
  if (!password) {
    return new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": `Basic realm="cf-opencode ${id}"` },
    });
  }
  const session = sessionOf(env, id);
  if (parts.length === 3) {
    const sessionId = parts[2] as string;
    if (!SESSION_ID_RE.test(sessionId))
      return fail(400, "bad browser session id", "use the URL cf-opencode browse printed");
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return fail(426, "the browser session URL is a websocket", "connect a CDP client to it");
    }
    if (!(await session.authorize(password)))
      return fail(401, "wrong workspace password", `cf-opencode connect ${id}`);
    const upstream = await connectCdp(env.BROWSER, sessionId);
    if ("error" in upstream) return json(upstream.status, { error: upstream.error });
    const pair = new WebSocketPair();
    upstream.accept();
    pair[1].accept();
    relay(pair[1], upstream);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  if (req.method !== "POST") return methodNotAllowed(req.method, url.pathname);
  const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
  const keep = typeof body.keepAliveMs === "number" ? body.keepAliveMs : undefined;
  // Dev-server ports the session may open as p<port>.preview.internal. The Durable Object checks each one.
  const ports = Array.isArray(body.previewPorts)
    ? body.previewPorts.filter((p) => typeof p === "number")
    : [];
  const result = await session.browse(password, keep, ports.length ? ports : undefined);
  if (!result.ok) return json(result.status, { error: result.error });
  const opened = result.session as { sessionId: string; liveUrl?: string };
  // The relay below is the only CDP endpoint the container gets.
  const websocketUrl = `${url.origin.replace(/^http/, "ws")}/browse/${encodeURIComponent(id)}/${opened.sessionId}`;
  return json(200, { ...opened, websocketUrl });
}

/**
 * GET /shell/<id> and /ssh/<id>, websocket upgrades. Same basic password as /oc; the
 * Durable Object checks it before it wakes anything. The password leaves the URL-free
 * Authorization header only as an internal header to the Durable Object.
 */
async function terminalIngress(
  req: Request,
  env: Env,
  kind: "shell" | "ssh",
  seg: string,
): Promise<Response> {
  const id = decodeSegment(seg);
  if (!id || !WORKSPACE_ID_RE.test(id)) return fail(400, "bad workspace id", "use letters, digits, _ and -");
  const password = basicPassword(req.headers.get("authorization"));
  if (!password) {
    return new Response(JSON.stringify({ _tag: "UnauthorizedError", message: "Authentication required" }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": `Basic realm="cf-opencode ${id}"` },
    });
  }
  const url = new URL(req.url);
  const target = new URL(`https://workspace/${kind}${url.search}`);
  const headers = new Headers(req.headers);
  headers.delete("authorization");
  headers.set("x-cf-opencode-password", password);
  return sessionOf(env, id).fetch(new Request(target, { method: req.method, headers }));
}

async function submit(req: Request, session: WorkspaceSessionApi, workspaceId: string): Promise<Response> {
  const body = await readJson(req);
  const parsed = parseOpRequest(body);
  if (!parsed.ok) return fail(400, parsed.error, parsed.fix);
  parsed.req.workerUrl = new URL(req.url).origin;
  const { opId, attached } = await session.submitOp(parsed.req);
  return json(202, { opId, attached, workspaceId, username: OPENCODE_USERNAME });
}

function parseOpRequest(
  body: Record<string, unknown>,
): { ok: true; req: OpRequest } | { ok: false; error: string; fix: string } {
  const op = body.op;
  if (typeof op !== "string" || !(OPS as readonly string[]).includes(op)) {
    return {
      ok: false,
      error: "op must be spawn, pause or delete",
      fix: 'send { op: "spawn" | "pause" | "delete" }',
    };
  }
  const req: OpRequest = { op: op as WorkspaceOp };
  if (body.snapshotId !== undefined) {
    if (typeof body.snapshotId !== "string" || !isProjectSnapshotId(body.snapshotId)) {
      return { ok: false, error: "bad snapshotId", fix: "snapshot ids are 1-256 chars with no slash" };
    }
    req.snapshotId = body.snapshotId;
  }
  if (body.password !== undefined) {
    if (typeof body.password !== "string" || body.password.length < 16 || body.password.length > 256) {
      return { ok: false, error: "bad password", fix: "let cf-opencode connect mint the password" };
    }
    req.password = body.password;
  }
  if (body.directory !== undefined) {
    if (typeof body.directory !== "string" || !body.directory.startsWith("/")) {
      return {
        ok: false,
        error: "directory must be an absolute path",
        fix: "pass /home/user/project or omit it",
      };
    }
    req.directory = body.directory;
  }
  if (body.repoUrl !== undefined) {
    if (typeof body.repoUrl !== "string" || !/^https?:\/\//.test(body.repoUrl)) {
      return { ok: false, error: "repoUrl must be an http(s) URL", fix: "pass the git remote, or omit it" };
    }
    req.repoUrl = body.repoUrl;
  }
  if (body.branch !== undefined) {
    if (typeof body.branch !== "string" || !/^[A-Za-z0-9._/-]{1,128}$/.test(body.branch)) {
      return { ok: false, error: "bad branch", fix: "branch names are letters, digits, . _ / -" };
    }
    req.branch = body.branch;
  }
  for (const key of ["gitName", "gitEmail"] as const) {
    const v = body[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length > 200 || [...v].some((c) => c.charCodeAt(0) < 32)) {
      return { ok: false, error: `bad ${key}`, fix: "one line, up to 200 characters" };
    }
    req[key] = v;
  }
  if (body.image !== undefined) {
    if (typeof body.image !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(body.image)) {
      return { ok: false, error: "bad image key", fix: "image keys match the wrangler images map" };
    }
    req.image = body.image;
  }
  if (op === "spawn" && !req.password) {
    return { ok: false, error: "spawn needs a password", fix: "cf-opencode connect sends one" };
  }
  return { ok: true, req };
}

function sessionOf(env: Env, id: string): WorkspaceSessionApi {
  return env.WORKSPACE.getByName(workspaceDoName(id)) as unknown as WorkspaceSessionApi;
}

function configOrNull(env: Env): unknown {
  try {
    return parseConfig(env.CF_OPENCODE_CONFIG);
  } catch {
    return null;
  }
}

function parseOpId(seg: string): { workspaceId: string; opId: string } | undefined {
  const decoded = decodeSegment(seg);
  if (!decoded) return undefined;
  const idx = decoded.indexOf(":");
  if (idx < 1) return undefined;
  const workspaceId = decoded.slice(0, idx);
  const uuid = decoded.slice(idx + 1);
  if (!WORKSPACE_ID_RE.test(workspaceId) || !OP_UUID_RE.test(uuid)) return undefined;
  return { workspaceId, opId: decoded };
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) throw new Error("Failed: body too large — fix: send only the op fields");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("Failed: body too large — fix: send only the op fields");
  if (!text) return {};
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Failed: body must be an object");
  return v as Record<string, unknown>;
}

function decodeSegment(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function clampWait(s: string | null): number {
  const n = Number(s ?? "0");
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_WAIT_MS);
}

function clampLines(s: string | null): number {
  const n = Number(s ?? "100");
  if (!Number.isFinite(n) || n < 1) return 100;
  return Math.min(Math.floor(n), MAX_LOG_LINES);
}

function numOrUndefined(s: string | null): number | undefined {
  if (s === null) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fail(status: number, cause: string, fix: string): Response {
  return json(status, { error: `Failed: ${cause} — fix: ${fix}` });
}

function notFound(req: Request): Response {
  return json(404, {
    error: `Failed: no route ${req.method} ${new URL(req.url).pathname} — fix: see cf-opencode --help`,
  });
}

function methodNotAllowed(method: string, path: string): Response {
  return json(405, { error: `Failed: ${method} ${path} is not allowed — fix: check the method` });
}

function oneLine(e: unknown, cap: number): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s*\n\s*/g, " ").slice(0, cap);
}
