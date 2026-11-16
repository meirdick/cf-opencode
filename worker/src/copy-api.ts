// The /v1 routes of `cf-opencode cp`. api.ts calls copyRoute after the control token check, so only the
// control token starts a copy: a workspace password, which the agent holds, reaches none of these.
//
//   POST /v1/copy                          { from: {workspace, path}, to: {workspace, path}, force? }
//                                          workspace to workspace; NDJSON progress, then one result line
//   GET  /v1/workspaces/<id>/files?path=p  the checked tar of p (to this machine); &stat=1: kind and size only
//   PUT  /v1/workspaces/<id>/files?path=p&name=n[&force=1]   a tar from this machine, at most 100 MB
//
// Every stream passes guardTar (core/tar-guard.ts) here, in the Worker, before a workspace or a laptop
// unpacks it. A paused workspace wakes: its disk is only readable and writable in a running container.
import { type GuardStats, guardTar, mb } from "./core/tar-guard";
import type { WorkspaceStatus } from "./core/types";
import {
  type CopyFail,
  MAX_COPY_BYTES,
  MAX_COPY_ENTRIES,
  MAX_UPLOAD_BYTES,
  type StatResult,
} from "./orb/copy";
import { STORE_OFF, type StoreBucket, storeRoute, storeToWorkspace, workspaceToStore } from "./store";

/** Same rule as WORKSPACE_ID_RE in api.ts; a copy here keeps the import one way. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface CopyStub {
  status(): Promise<WorkspaceStatus>;
  copyStat(path: string): Promise<StatResult>;
  copyOut(path: string): Promise<{ ok: true; stream: ReadableStream<Uint8Array> } | CopyFail>;
  copyPrepare(o: {
    path: string;
    name: string;
    force: boolean;
    bytes: number;
  }): Promise<{ ok: true; token: string; target: string } | CopyFail>;
  copyIn(token: string, tar: ReadableStream<Uint8Array>): Promise<{ ok: true } | CopyFail>;
  copyCommit(token: string): Promise<{ ok: true; target: string } | CopyFail>;
  copyAbort(token: string): Promise<void>;
}

export interface CopyResult {
  from: string;
  to: string;
  bytes: number;
  files: number;
  dirs: number;
  links: number;
  seconds: number;
}

/** The cp routes, or undefined for any other path. */
export function copyRoute(
  req: Request,
  stubOf: (id: string) => CopyStub,
  parts: string[],
  store?: StoreBucket,
): Promise<Response> | undefined {
  const [, a, b, c, ...rest] = parts;
  const method = req.method.toUpperCase();
  if (a === "copy" && b === undefined) {
    if (method !== "POST") return Promise.resolve(fail(405, `${method} /v1/copy is not allowed`, "use POST"));
    return copyBetween(req, stubOf, store);
  }
  if (a === "store") {
    const key = parts.length > 2 ? decode(parts.slice(2).join("/")) : undefined;
    if (key === null) return Promise.resolve(fail(400, "bad store name", "check the name"));
    return storeRoute(req, store, key);
  }
  if (a === "workspaces" && b && c === "files" && rest.length === 0) {
    const id = decode(b);
    if (id === null || !ID_RE.test(id))
      return Promise.resolve(fail(400, "bad workspace id", "use letters, digits, _ and -"));
    const url = new URL(req.url);
    const path = url.searchParams.get("path") ?? "";
    if (method === "GET")
      return url.searchParams.get("stat") === "1" ? stat(stubOf(id), path) : download(stubOf(id), id, path);
    if (method === "PUT") return upload(req, stubOf(id), id, path, url.searchParams);
    return Promise.resolve(fail(405, `${method} on files is not allowed`, "use GET or PUT"));
  }
  return undefined;
}

/** Workspace to workspace. Progress lines go out while the copy runs, so the client sees each step. */
async function copyBetween(
  req: Request,
  stubOf: (id: string) => CopyStub,
  store: StoreBucket | undefined,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 64 * 1024) throw new Error("too large");
    body = JSON.parse(text || "{}") as Record<string, unknown>;
  } catch {
    return fail(
      400,
      "the body is not a JSON object",
      "send { from: {workspace, path}, to: {workspace, path} }",
    );
  }
  const from = side(body.from);
  const to = side(body.to);
  if (!from || !to)
    return fail(
      400,
      "from and to need a workspace id and a path, or a store name",
      "send { from: {workspace, path}, to: {workspace, path} }",
    );
  if ("store" in from && "store" in to)
    return fail(400, "both sides are the store", "copy from the store to a workspace or to this machine");
  if (("store" in from || "store" in to) && !store) return json(404, { error: STORE_OFF });
  const force = body.force === true;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const send = (o: unknown) => w.write(enc.encode(`${JSON.stringify(o)}\n`)).catch(() => undefined);
  const say = (line: string) => void send({ line });
  void (async () => {
    try {
      let r: { ok: true; result: CopyResult } | CopyFail;
      if ("store" in from) {
        const dst = to as Side;
        await sayWake(stubOf(dst.workspace), dst.workspace, "write", say);
        r = await storeToWorkspace(store as StoreBucket, stubOf(dst.workspace), from.store, dst, force, say);
      } else if ("store" in to) {
        await sayWake(stubOf(from.workspace), from.workspace, "read", say);
        r = await workspaceToStore(store as StoreBucket, stubOf(from.workspace), from, to.store, say);
      } else r = await runBetween(stubOf, from, to, force, say);
      await send(r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error });
    } catch (e) {
      await send({
        ok: false,
        error: `Failed: the copy broke off: ${errText(e)} — fix: retry; the target is unchanged`,
      });
    } finally {
      await w.close().catch(() => undefined);
    }
  })();
  return new Response(readable, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}

type Side = { workspace: string; path: string };

export async function runBetween(
  stubOf: (id: string) => CopyStub,
  from: Side,
  to: Side,
  force: boolean,
  say: (line: string) => void,
): Promise<{ ok: true; result: CopyResult } | CopyFail> {
  const t0 = Date.now();
  const src = stubOf(from.workspace);
  const dst = stubOf(to.workspace);
  await sayWake(src, from.workspace, "read", say);
  if (to.workspace !== from.workspace) await sayWake(dst, to.workspace, "write", say);
  const st = await src.copyStat(from.path);
  if (!st.ok) return st;
  const limit = overLimit(st, from.workspace, MAX_COPY_BYTES);
  if (limit) return limit;
  const prep = await dst.copyPrepare({ path: to.path, name: st.name, force, bytes: st.bytes });
  if (!prep.ok) return prep;
  say(
    `copying ${from.workspace}:${st.path} (${st.kind === "dir" ? `${st.entries} entries, ` : ""}${mb(st.bytes)}) to ${to.workspace}:${prep.target}`,
  );
  const out = await src.copyOut(st.path);
  if (!out.ok) {
    await dst.copyAbort(prep.token).catch(() => undefined);
    return out;
  }
  const g = guardTar(out.stream, {
    maxBytes: MAX_COPY_BYTES,
    maxEntries: MAX_COPY_ENTRIES,
    onProgress: progress(st.bytes, say),
  });
  const [put, checked] = await Promise.all([
    dst
      .copyIn(prep.token, g.stream)
      .catch((e: unknown) => ({ ok: false, error: `Failed: ${errText(e)} — fix: retry` }) as CopyFail),
    g.done.then(
      (s) => ({ ok: true as const, s }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
  ]);
  if (!checked.ok || !put.ok) {
    await dst.copyAbort(prep.token).catch(() => undefined);
    if (!checked.ok)
      return {
        ok: false,
        error: `Failed: ${errText(checked.e)} — fix: check ${from.workspace}:${st.path}, then retry; the target is unchanged`,
      };
    return put as CopyFail;
  }
  const done = await dst.copyCommit(prep.token);
  if (!done.ok) return done;
  return {
    ok: true,
    result: result(`${from.workspace}:${st.path}`, `${to.workspace}:${done.target}`, checked.s, t0),
  };
}

async function stat(stub: CopyStub, path: string): Promise<Response> {
  const st = await stub.copyStat(path);
  return st.ok ? json(200, st) : json(400, { error: st.error });
}

/** To this machine: the checked tar as the body. A check that fails mid-way breaks the body off. */
async function download(stub: CopyStub, id: string, path: string): Promise<Response> {
  const st = await stub.copyStat(path);
  if (!st.ok) return json(400, { error: st.error });
  const limit = overLimit(st, id, MAX_COPY_BYTES);
  if (limit) return json(400, { error: limit.error });
  const out = await stub.copyOut(st.path);
  if (!out.ok) return json(502, { error: out.error });
  const g = guardTar(out.stream, { maxBytes: MAX_COPY_BYTES, maxEntries: MAX_COPY_ENTRIES });
  return new Response(g.stream, {
    headers: {
      "content-type": "application/x-tar",
      "cache-control": "no-store",
      "x-cf-opencode-path": encodeURIComponent(st.path),
      "x-cf-opencode-name": encodeURIComponent(st.name),
      "x-cf-opencode-kind": st.kind,
      "x-cf-opencode-bytes": String(st.bytes),
    },
  });
}

/** From this machine: one request body, so at most MAX_UPLOAD_BYTES. */
async function upload(
  req: Request,
  stub: CopyStub,
  id: string,
  path: string,
  q: URLSearchParams,
): Promise<Response> {
  const t0 = Date.now();
  const len = Number(req.headers.get("content-length") ?? "NaN");
  if (!Number.isSafeInteger(len) || len <= 0)
    return fail(411, "the upload has no content-length", "send the archive as one body with its length");
  if (len > MAX_UPLOAD_BYTES)
    return fail(
      413,
      `the upload is ${mb(len)}; one upload takes at most ${mb(MAX_UPLOAD_BYTES)}`,
      "copy a smaller part, or move it through git",
    );
  if (!req.body) return fail(400, "the upload has no body", "send a tar archive");
  const prep = await stub.copyPrepare({
    path,
    name: q.get("name") ?? "",
    force: q.get("force") === "1",
    bytes: len,
  });
  if (!prep.ok) {
    await req.body.cancel().catch(() => undefined);
    return json(400, { error: prep.error });
  }
  const g = guardTar(req.body, { maxBytes: MAX_UPLOAD_BYTES, maxEntries: MAX_COPY_ENTRIES });
  const [put, checked] = await Promise.all([
    stub
      .copyIn(prep.token, g.stream)
      .catch((e: unknown) => ({ ok: false, error: `Failed: ${errText(e)} — fix: retry` }) as CopyFail),
    g.done.then(
      (s) => ({ ok: true as const, s }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
  ]);
  if (!checked.ok || !put.ok) {
    await stub.copyAbort(prep.token).catch(() => undefined);
    const error = !checked.ok
      ? `Failed: ${errText(checked.e)} — fix: check the local path, then retry`
      : (put as CopyFail).error;
    return json(400, { error });
  }
  const done = await stub.copyCommit(prep.token);
  if (!done.ok) return json(502, { error: done.error });
  return json(200, { ok: true, result: result("upload", `${id}:${done.target}`, checked.s, t0) });
}

async function sayWake(
  stub: CopyStub,
  id: string,
  verb: "read" | "write",
  say: (l: string) => void,
): Promise<void> {
  const s = await stub.status().catch(() => undefined);
  if (!s) return;
  if (s.containerRunning && s.workspace.state === "awake") return;
  if (s.workspace.state === "none" || s.workspace.deletedAt) return;
  say(
    `${id} is ${s.workspace.state}; waking it to ${verb} its disk (it counts toward maxRunning and pauses again when idle)`,
  );
}

function overLimit(st: StatResult & { ok: true }, id: string, max: number): CopyFail | undefined {
  if (st.kind === "none")
    return {
      ok: false,
      error: `Failed: ${id}:${st.path} does not exist — fix: check the path with cf-opencode shell ${id}`,
    };
  if (st.bytes > max)
    return {
      ok: false,
      error: `Failed: ${id}:${st.path} is ${mb(st.bytes)}; cp moves at most ${mb(max)} at a time — fix: copy a smaller part, or move it through git`,
    };
  if (st.entries > MAX_COPY_ENTRIES)
    return {
      ok: false,
      error: `Failed: ${id}:${st.path} has ${st.entries} entries; cp moves at most ${MAX_COPY_ENTRIES} at a time — fix: copy a smaller part, or pack it with tar first`,
    };
  return undefined;
}

/** A progress line at most every 2 seconds. */
function progress(total: number, say: (l: string) => void): (s: GuardStats) => void {
  let last = Date.now();
  return (s) => {
    const now = Date.now();
    if (now - last < 2000) return;
    last = now;
    say(
      `copied ${mb(s.bytes)}${total ? ` of ${mb(total)} (${Math.min(100, Math.round((s.bytes / total) * 100))}%)` : ""}`,
    );
  };
}

function result(from: string, to: string, s: GuardStats, t0: number): CopyResult {
  return { from, to, ...s, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}

function side(v: unknown): Side | { store: string } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.store === "string") return { store: o.store };
  if (typeof o.workspace !== "string" || !ID_RE.test(o.workspace) || typeof o.path !== "string")
    return undefined;
  return { workspace: o.workspace, path: o.path };
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

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
