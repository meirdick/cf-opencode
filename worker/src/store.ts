// The store: an R2 bucket of the install, for files that outlive a workspace. Off unless `store` is true.
//
// Clients:
// - `cf-opencode cp` with a `store:<name>` side, and `cf-opencode store` (list, rm). They use /v1, so they need
//   the control token. A workspace side goes through the same copy path as cp (copy-api.ts), so the Worker
//   checks the stream; the store holds files, not folders.
// - `cf-opencode-store` in a workspace, through the intercepted AI host (AiEgress). No R2 key enters the
//   container: the Worker holds the binding. The agent reads every name, and writes and removes only names
//   under `<its workspace>/`, so one agent cannot replace a file that the user or another workspace put there.
import type { CopyStub } from "./copy-api";
import { fileHeader, guardTar, mb } from "./core/tar-guard";
import { basename, type CopyFail, MAX_COPY_BYTES, MAX_COPY_ENTRIES, MAX_UPLOAD_BYTES } from "./orb/copy";

/** What the store needs from R2. Tests use a Map. */
export interface StoreBucket {
  put(key: string, body: ReadableStream<Uint8Array>, size: number): Promise<void>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
  list(prefix: string | undefined, cursor: string | undefined): Promise<StoreList>;
  delete(key: string): Promise<void>;
}

export interface StoreList {
  objects: { key: string; size: number; uploaded: string }[];
  cursor?: string;
}

/** The R2 binding as a StoreBucket. R2 needs the length of a stream; FixedLengthStream gives it. */
export function r2Store(b: R2Bucket): StoreBucket {
  return {
    async put(key, body, size) {
      const { readable, writable } = new FixedLengthStream(size);
      await Promise.all([b.put(key, readable), body.pipeTo(writable)]);
    },
    async get(key) {
      const o = await b.get(key);
      return o ? { body: o.body, size: o.size } : null;
    },
    async list(prefix, cursor) {
      const r = await b.list({ ...(prefix ? { prefix } : {}), ...(cursor ? { cursor } : {}), limit: 1000 });
      return {
        objects: r.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() })),
        ...(r.truncated ? { cursor: r.cursor } : {}),
      };
    },
    delete: (key) => b.delete(key),
  };
}

const KEY_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Why `key` is not a store name, or undefined. */
export function badKey(key: string): string | undefined {
  if (
    key.length < 1 ||
    key.length > 512 ||
    !KEY_RE.test(key) ||
    key.split("/").some((p) => p === "." || p === "..")
  )
    return `${JSON.stringify(key.slice(0, 80))} is not a store name; use letters, digits, . _ - and / between parts`;
  return undefined;
}

export const STORE_OFF =
  "Failed: the store is off in this install — fix: set store to true in ~/.cf-opencode/config.json, then run cf-opencode upgrade";

/** Workspace to store. The file passes the same check as cp, then goes to R2 with its exact length. */
export async function workspaceToStore(
  store: StoreBucket,
  src: CopyStub,
  from: { workspace: string; path: string },
  key: string,
  say: (l: string) => void,
): Promise<{ ok: true; result: StoreCopy } | CopyFail> {
  const t0 = Date.now();
  const st = await src.copyStat(from.path);
  if (!st.ok) return st;
  if (st.kind === "none")
    return fail(
      `${from.workspace}:${st.path} does not exist`,
      `check the path with cf-opencode shell ${from.workspace}`,
    );
  if (st.kind !== "file")
    return fail(
      `${from.workspace}:${st.path} is a folder; the store holds files`,
      "pack it first: tar czf x.tgz <folder>",
    );
  if (st.bytes > MAX_COPY_BYTES)
    return fail(
      `${from.workspace}:${st.path} is ${mb(st.bytes)}; one copy moves at most ${mb(MAX_COPY_BYTES)}`,
      "split the file",
    );
  const name = key || st.name;
  const bad = badKey(name);
  if (bad) return fail(bad, "pass a name: store:<name>");
  say(`copying ${from.workspace}:${st.path} (${mb(st.bytes)}) to store:${name}`);
  const out = await src.copyOut(st.path);
  if (!out.ok) return out;
  const g = guardTar(out.stream, { maxBytes: MAX_COPY_BYTES, maxEntries: MAX_COPY_ENTRIES });
  try {
    const file = await fileOfTar(g.stream);
    await store.put(name, file.body, file.size);
  } catch (e) {
    const why = await g.done.then(
      () => errText(e),
      (x: unknown) => errText(x),
    );
    return fail(`the copy to the store failed: ${why}`, "retry; the store is unchanged");
  }
  return { ok: true, result: copied(`${from.workspace}:${st.path}`, `store:${name}`, st.bytes, t0) };
}

/** Store to workspace: the object becomes a one-file archive that the workspace unpacks as cp does. */
export async function storeToWorkspace(
  store: StoreBucket,
  dst: CopyStub,
  key: string,
  to: { workspace: string; path: string },
  force: boolean,
  say: (l: string) => void,
): Promise<{ ok: true; result: StoreCopy } | CopyFail> {
  const t0 = Date.now();
  const bad = badKey(key);
  if (bad) return fail(bad, "list the names with cf-opencode store");
  const obj = await store.get(key);
  if (!obj) return fail(`store:${key} does not exist`, "list the names with cf-opencode store");
  const prep = await dst.copyPrepare({ path: to.path, name: basename(key), force, bytes: obj.size });
  if (!prep.ok) {
    await obj.body.cancel().catch(() => undefined);
    return prep;
  }
  say(`copying store:${key} (${mb(obj.size)}) to ${to.workspace}:${prep.target}`);
  const put = await dst
    .copyIn(prep.token, tarOfFile(obj.body, obj.size))
    .catch((e: unknown) => ({ ok: false, error: `Failed: ${errText(e)} — fix: retry` }) as CopyFail);
  if (!put.ok) {
    await dst.copyAbort(prep.token).catch(() => undefined);
    return put;
  }
  const done = await dst.copyCommit(prep.token);
  if (!done.ok) return done;
  return { ok: true, result: copied(`store:${key}`, `${to.workspace}:${done.target}`, obj.size, t0) };
}

/**
 * The control routes: GET /v1/store (list), GET, PUT and DELETE /v1/store/<name>. PUT takes one body of at most
 * MAX_UPLOAD_BYTES with its length.
 */
export async function storeRoute(
  req: Request,
  store: StoreBucket | undefined,
  key: string | undefined,
): Promise<Response> {
  if (!store) return json(404, { error: STORE_OFF });
  const method = req.method.toUpperCase();
  if (key === undefined) {
    if (method !== "GET")
      return json(405, { error: `Failed: ${method} /v1/store is not allowed — fix: use GET` });
    const url = new URL(req.url);
    return json(
      200,
      await store.list(
        url.searchParams.get("prefix") ?? undefined,
        url.searchParams.get("cursor") ?? undefined,
      ),
    );
  }
  const bad = badKey(key);
  if (bad) return json(400, { error: `Failed: ${bad} — fix: check the name` });
  if (method === "GET") {
    const obj = await store.get(key);
    if (!obj)
      return json(404, {
        error: `Failed: store:${key} does not exist — fix: list the names with cf-opencode store`,
      });
    return new Response(obj.body, {
      headers: { "content-type": "application/octet-stream", "content-length": String(obj.size) },
    });
  }
  if (method === "PUT") return putBody(req, store, key);
  if (method === "DELETE") {
    await store.delete(key);
    return json(200, { ok: true, removed: key });
  }
  return json(405, { error: `Failed: ${method} on the store is not allowed — fix: use GET, PUT or DELETE` });
}

/**
 * `cf-opencode-store` in a workspace, on the intercepted AI host:
 *   GET /store/list[?prefix=]  GET /store/object/<name>  PUT and DELETE /store/object/<name in this workspace>
 * PUT writes `<workspace>/<name>`. The workspace id comes from the egress props, which only this Worker sets.
 */
export async function storeEgress(
  req: Request,
  store: StoreBucket | undefined,
  workspaceId: string | undefined,
): Promise<Response> {
  if (!store) return json(404, { error: STORE_OFF.replace("fix: set", "fix: ask the user to set") });
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  if (url.pathname === "/store/list" && method === "GET")
    return json(
      200,
      await store.list(
        url.searchParams.get("prefix") ?? undefined,
        url.searchParams.get("cursor") ?? undefined,
      ),
    );
  const m = /^\/store\/object\/(.+)$/.exec(url.pathname);
  if (!m) return json(404, { error: "Failed: no such store path — fix: run cf-opencode-store --help" });
  let key: string;
  try {
    key = decodeURIComponent(m[1] as string);
  } catch {
    return json(400, { error: "Failed: the name is not valid — fix: check the name" });
  }
  if (method === "GET") return storeRoute(req, store, key);
  if (!workspaceId)
    return json(403, {
      error: "Failed: this workspace started before the store existed — fix: pause it, then connect again",
    });
  const own = `${workspaceId}/`;
  if (method === "PUT" || method === "DELETE") {
    const name = key.startsWith(own) ? key : `${own}${key}`;
    if (!name.startsWith(own) || name.slice(own.length).length === 0)
      return json(403, {
        error: "Failed: a workspace writes only its own names — fix: use a name without a workspace prefix",
      });
    if (method === "DELETE") return storeRoute(req, store, name);
    const bad = badKey(name);
    if (bad) return json(400, { error: `Failed: ${bad} — fix: check the name` });
    return putBody(req, store, name);
  }
  return json(405, { error: `Failed: ${method} is not allowed here — fix: run cf-opencode-store --help` });
}

async function putBody(req: Request, store: StoreBucket, key: string): Promise<Response> {
  const len = Number(req.headers.get("content-length") ?? "NaN");
  if (!Number.isSafeInteger(len) || len < 0)
    return json(411, {
      error: "Failed: the upload has no content-length — fix: send the file as one body with its length",
    });
  if (len > MAX_UPLOAD_BYTES)
    return json(413, {
      error: `Failed: the file is ${mb(len)}; one upload takes at most ${mb(MAX_UPLOAD_BYTES)} — fix: split the file, or copy it from a workspace with cf-opencode cp`,
    });
  const body = req.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  await store.put(key, body, len);
  return json(200, { ok: true, key, size: len });
}

/** A one-file archive around a body of known size, as copyIn takes it. */
export function tarOfFile(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let stage: "head" | "data" | "tail" | "end" = "head";
  let left = size;
  return new ReadableStream<Uint8Array>({
    type: "bytes",
    async pull(c) {
      if (stage === "head") {
        c.enqueue(fileHeader(size, Date.now() / 1000) as Uint8Array<ArrayBuffer>);
        stage = left > 0 ? "data" : "tail";
        return;
      }
      if (stage === "data") {
        const { done, value } = await reader.read();
        if (done || value.byteLength > left) {
          c.error(new Error("the stored file changed size during the copy"));
          return;
        }
        if (value.byteLength) {
          left -= value.byteLength;
          c.enqueue(value.slice() as Uint8Array<ArrayBuffer>);
        }
        if (left === 0) stage = "tail";
        return;
      }
      if (stage === "tail") {
        c.enqueue(new Uint8Array(((512 - (size % 512)) % 512) + 1024));
        stage = "end";
        return;
      }
      c.close();
    },
    cancel: (r) => reader.cancel(r),
  });
}

/**
 * The data of a checked one-file archive (guardTar output). The last chunk is held back until the archive has
 * ended and passed its check, so R2 never receives a whole object from a copy that failed.
 */
export async function fileOfTar(guarded: ReadableStream<Uint8Array>): Promise<{
  body: ReadableStream<Uint8Array>;
  size: number;
}> {
  const reader = guarded.getReader();
  const read = async () => {
    const r = await reader.read();
    return r.done ? undefined : r.value;
  };
  let buf: Uint8Array = new Uint8Array(0);
  try {
    while (buf.byteLength < 512) {
      const v = await read();
      if (!v) throw new Error("the archive ended early");
      buf = concat(buf, v);
    }
  } catch (e) {
    await reader.cancel(e).catch(() => undefined);
    throw e;
  }
  const h = buf.subarray(0, 512);
  if (h[156] !== 0x30) {
    await reader.cancel().catch(() => undefined);
    throw new Error("the source is not a single file");
  }
  const size = Number.parseInt(new TextDecoder().decode(h.subarray(124, 135)), 8);
  buf = buf.subarray(512);
  let left = size;
  let held: Uint8Array | undefined;
  const body = new ReadableStream<Uint8Array>({
    type: "bytes",
    async pull(c) {
      try {
        while (left > 0) {
          const v = buf.byteLength ? buf : await read();
          buf = new Uint8Array(0);
          if (!v) throw new Error("the archive ended early");
          const part = v.subarray(0, left);
          left -= part.byteLength;
          if (held) {
            c.enqueue(held as Uint8Array<ArrayBuffer>);
            held = part.slice();
            return;
          }
          held = part.slice();
        }
        // The rest is padding and the end blocks; reading to the end makes the guard check the trailer.
        while (await read());
        if (held?.byteLength) c.enqueue(held as Uint8Array<ArrayBuffer>);
        held = undefined;
        c.close();
      } catch (e) {
        c.error(e);
        await reader.cancel(e).catch(() => undefined);
      }
    },
    cancel: (r) => reader.cancel(r),
  });
  return { body, size };
}

/** The result of a copy with the store: one file. Same fields as a cp result. */
export interface StoreCopy {
  from: string;
  to: string;
  bytes: number;
  files: number;
  dirs: number;
  links: number;
  seconds: number;
}

function copied(from: string, to: string, bytes: number, t0: number): StoreCopy {
  return { from, to, bytes, files: 1, dirs: 0, links: 0, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fail(cause: string, fix: string): CopyFail {
  return { ok: false, error: `Failed: ${cause} — fix: ${fix}` };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
