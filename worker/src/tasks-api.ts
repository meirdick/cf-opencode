// Control routes for handed-off tasks. Bearer auth is checked before this runs.
//   POST /v1/workspaces/<id>/tasks   { text, title?, model?, schema? }  start a session in a running workspace
//   GET  /v1/workspaces/<id>/tasks                                      the task list; wakes nothing
//   GET  /v1/workspaces/<id>/tasks/<ses_…>[?seen=1]                     one task and its result record;
//                                                                       seen=1 clears its unseen mark
// Each GET is short. `cf-opencode tasks --wait` polls it; no request is held open while an agent works.
import type { WorkspaceSessionApi } from "./api";
import { parseTaskInput } from "./orb/tasks";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SESSION_RE = /^ses[A-Za-z0-9_-]{1,100}$/;
// The task is capped at 32 000 characters; UTF-8 may need four bytes for one.
const MAX_TASK_BODY = 160 * 1024;

export async function tasksRoute(
  req: Request,
  sessionOf: (id: string) => WorkspaceSessionApi,
  idSeg: string,
  taskSeg: string | undefined,
): Promise<Response> {
  const id = decode(idSeg);
  if (id === null || !ID_RE.test(id)) return fail(400, "bad workspace id", "use letters, digits, _ and -");
  const method = req.method.toUpperCase();
  const path = new URL(req.url).pathname;
  if (taskSeg !== undefined) {
    const sid = decode(taskSeg);
    if (sid === null || !SESSION_RE.test(sid))
      return fail(400, "bad task id", "use the ses_… id cf-opencode run printed");
    if (method !== "GET") return notAllowed(method, path);
    const seen = new URL(req.url).searchParams.get("seen") === "1";
    const one = await sessionOf(id).task(sid, seen);
    if (!one) return fail(404, `no task ${sid} in ${id}`, "cf-opencode tasks lists them");
    return json(200, one);
  }
  if (method === "GET") return json(200, await sessionOf(id).tasks());
  if (method !== "POST") return notAllowed(method, path);
  const len = Number(req.headers.get("content-length") ?? "0");
  const text = len > MAX_TASK_BODY ? "" : await req.text();
  if (len > MAX_TASK_BODY || text.length > MAX_TASK_BODY)
    return fail(413, "the task is too large", "shorten it; put details in a file in the repository");
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    return fail(400, "body is not JSON", 'send { text: "<task>" }');
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return fail(400, "body must be an object", 'send { text: "<task>" }');
  const parsed = parseTaskInput(body as Record<string, unknown>);
  if ("error" in parsed) return fail(400, parsed.error, parsed.fix);
  const r = await sessionOf(id).startTask(parsed.input);
  if (!r.ok) return json(r.status, { error: r.error });
  return json(201, { task: r.task, workspaceId: id });
}

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fail(status: number, cause: string, fix: string): Response {
  return json(status, { error: `Failed: ${cause} — fix: ${fix}` });
}

function notAllowed(method: string, path: string): Response {
  return json(405, { error: `Failed: ${method} ${path} is not allowed — fix: check the method` });
}
