// cf-opencode cp: copy a file or a folder between two workspaces, or between a workspace and this machine.
//
// Each side is <workspace>:<path> or a local path. A workspace path is relative to the checkout, or starts with
// / or ~ inside /home/user. The Worker checks every path and every member of the stream (worker/src/copy-api.ts);
// this side only reads and writes local files. Only the control token can start a copy.
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { CliError } from "./errors.js";

/** The Worker's limit for one upload (MAX_UPLOAD_BYTES in worker/src/orb/copy.ts). */
export const MAX_UPLOAD_BYTES = 100_000_000;
/** The name the Worker gives the root of every archive it sends (ROOT_NAME in worker/src/core/tar-guard.ts). */
export const ROOT_NAME = "data";

export type CpSide = { kind: "workspace"; workspace: string; path: string } | { kind: "local"; path: string };

/** <workspace>:<path> is a workspace; /x, ./x, ../x, ~/x, C:\x and a name with no colon are local. */
export function parseSide(s: string): CpSide {
  if (/^(\/|\.\.?($|[/\\])|~|[A-Za-z]:[\\/])/.test(s)) return { kind: "local", path: s };
  const m = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127}):(.*)$/s.exec(s);
  if (m) return { kind: "workspace", workspace: m[1] as string, path: m[2] as string };
  return { kind: "local", path: s };
}

export interface CpResult {
  from: string;
  to: string;
  bytes: number;
  files: number;
  dirs: number;
  links: number;
  seconds: number;
}

export interface CpDeps {
  url: string;
  token: string;
  force: boolean;
  /** Progress lines (stderr). */
  err: (line: string) => void;
  fetchFn?: typeof fetch;
  /** The local tar program. */
  tar?: string;
}

export async function cp(src: CpSide, dst: CpSide, d: CpDeps): Promise<CpResult> {
  if (src.kind === "local" && dst.kind === "local")
    throw new CliError(
      "both sides are on this machine",
      "name a workspace side, such as app:data/export.json",
    );
  if (src.kind === "workspace" && dst.kind === "workspace") return between(src, dst, d);
  if (src.kind === "workspace" && dst.kind === "local") return download(src, dst.path, d);
  return upload((src as { path: string }).path, dst as CpSide & { kind: "workspace" }, d);
}

/** Workspace to workspace: one request, NDJSON progress lines, one result line. */
async function between(
  src: CpSide & { kind: "workspace" },
  dst: CpSide & { kind: "workspace" },
  d: CpDeps,
): Promise<CpResult> {
  const res = await call(d, "POST", "/v1/copy", {
    body: JSON.stringify({
      from: { workspace: src.workspace, path: src.path },
      to: { workspace: dst.workspace, path: dst.path },
      force: d.force,
    }),
    headers: { "content-type": "application/json" },
  });
  let result: CpResult | undefined;
  let error: string | undefined;
  for await (const line of lines(res)) {
    let o: { line?: string; ok?: boolean; result?: CpResult; error?: string };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof o.line === "string") d.err(o.line);
    else if (o.ok === true) result = o.result;
    else if (o.ok === false) error = o.error;
  }
  if (error) throw new CliError(error, "see the line above");
  if (!result)
    throw new CliError(
      "the copy broke off before it ended",
      "run the command again; the target changes only when a copy ends",
    );
  return result;
}

interface Stat {
  path: string;
  name: string;
  kind: "file" | "dir" | "none";
  bytes: number;
  entries: number;
}

/** Workspace to this machine: unpack into a stage folder next to the target, then move it into place. */
async function download(src: CpSide & { kind: "workspace" }, local: string, d: CpDeps): Promise<CpResult> {
  const t0 = Date.now();
  const id = src.workspace;
  const st = await stat(d, id, src.path, "read");
  if (st.kind === "none")
    throw new CliError(`${id}:${st.path} does not exist`, `check the path with cf-opencode shell ${id}`);
  const target = localTarget(local, st.name);
  const parent = dirname(target);
  if (!existsSync(parent))
    throw new CliError(`the folder ${parent} does not exist`, `make it first: mkdir -p ${parent}`);
  if (exists(target) && !d.force)
    throw new CliError(`${target} exists`, "pass --force to replace it, or pick another target");
  const res = await call(
    d,
    "GET",
    `/v1/workspaces/${encodeURIComponent(id)}/files?path=${encodeURIComponent(src.path)}`,
  );
  const stage = mkdtempSync(join(parent, ".cf-opencode-cp-"));
  try {
    const counted = { bytes: 0 };
    await unpack(res, stage, d, counted, st.bytes);
    replace(join(stage, ROOT_NAME), target, d.force, stage);
    return { from: `${id}:${st.path}`, to: target, bytes: st.bytes, ...tally(target), seconds: secs(t0) };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** This machine to a workspace: one request body, so at most MAX_UPLOAD_BYTES of archive. */
async function upload(local: string, dst: CpSide & { kind: "workspace" }, d: CpDeps): Promise<CpResult> {
  const t0 = Date.now();
  const abs = resolve(local);
  if (!exists(abs)) throw new CliError(`${local} does not exist`, "check the path");
  const real = realpathSync(abs);
  const name = basename(abs);
  const archive = await pack(real, d);
  await stat(d, dst.workspace, dst.path, "write");
  d.err(`copying ${local} (${mb(archive.byteLength)}) to ${dst.workspace}`);
  const q = new URLSearchParams({ path: dst.path, name, ...(d.force ? { force: "1" } : {}) });
  const res = await call(d, "PUT", `/v1/workspaces/${encodeURIComponent(dst.workspace)}/files?${q}`, {
    body: archive,
    headers: { "content-type": "application/x-tar", "content-length": String(archive.byteLength) },
  });
  const body = (await res.json()) as { result: CpResult };
  return { ...body.result, from: local, seconds: secs(t0) };
}

/** Kind and size of a workspace path. It wakes a paused workspace; say so first. */
async function stat(d: CpDeps, id: string, path: string, verb: "read" | "write"): Promise<Stat> {
  const s = await call(d, "GET", `/v1/workspaces/${encodeURIComponent(id)}`)
    .then((r) => r.json() as Promise<{ workspace?: { state?: string }; containerRunning?: boolean }>)
    .catch(() => undefined);
  const state = s?.workspace?.state;
  if (s && !(s.containerRunning && state === "awake") && state && state !== "none")
    d.err(
      `${id} is ${state}; waking it to ${verb} its disk (it counts toward maxRunning and pauses again when idle)`,
    );
  const res = await call(
    d,
    "GET",
    `/v1/workspaces/${encodeURIComponent(id)}/files?stat=1&path=${encodeURIComponent(path)}`,
  );
  return (await res.json()) as Stat;
}

/** The target path on this machine: inside an existing folder, or with a trailing separator; else the path. */
export function localTarget(local: string, name: string): string {
  const abs = resolve(local);
  const into = local.endsWith("/") || local.endsWith(sep) || isDir(abs);
  return into ? join(abs, name) : abs;
}

/** Move `from` to `to`. A replaced target goes aside first and comes back when the move fails. */
function replace(from: string, to: string, force: boolean, stage: string): void {
  if (!exists(from)) throw new CliError("the archive held nothing", "retry");
  const old = join(stage, "old");
  const had = exists(to);
  if (had) {
    if (!force) throw new CliError(`${to} appeared during the copy`, "pass --force to replace it");
    renameSync(to, old);
  }
  try {
    renameSync(from, to);
  } catch (e) {
    if (had) renameSync(old, to);
    throw e;
  }
}

/** Run the local tar over the response body. The Worker sends only checked archives with one root. */
async function unpack(
  res: Response,
  stage: string,
  d: CpDeps,
  counted: { bytes: number },
  total: number,
): Promise<void> {
  const p = spawn(d.tar ?? "tar", ["-xf", "-", "-C", stage, "--no-same-owner"], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  p.stderr?.on("data", (b: Buffer) => {
    stderr += b.toString();
  });
  const exited = new Promise<number>((r) => p.on("close", (code) => r(code ?? -1)));
  let last = Date.now();
  let broke: unknown;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      counted.bytes += chunk.byteLength;
      if (Date.now() - last > 2000) {
        last = Date.now();
        d.err(`received ${mb(counted.bytes)}${total ? ` of about ${mb(total)}` : ""}`);
      }
      if (!p.stdin?.write(chunk)) await new Promise((r) => p.stdin?.once("drain", r));
    }
  } catch (e) {
    broke = e;
  }
  p.stdin?.end();
  const code = await exited;
  if (broke)
    throw new CliError(
      "the download broke off; the Worker stops a copy that fails its check or that the workspace could not read",
      "run the command again; nothing on this machine changed",
    );
  if (code !== 0)
    throw new CliError(
      `tar on this machine exited ${code}: ${stderr.trim().split("\n")[0] ?? ""}`,
      "check the target folder, then retry",
    );
}

/** tar of a local path into memory, at most MAX_UPLOAD_BYTES. */
async function pack(real: string, d: CpDeps): Promise<Uint8Array> {
  const p = spawn(d.tar ?? "tar", ["-cf", "-", "-C", dirname(real), basename(real)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const parts: Buffer[] = [];
  let size = 0;
  let over = false;
  let stderr = "";
  p.stderr?.on("data", (b: Buffer) => {
    stderr += b.toString();
  });
  p.stdout?.on("data", (b: Buffer) => {
    size += b.byteLength;
    if (size > MAX_UPLOAD_BYTES) {
      over = true;
      p.kill();
    } else parts.push(b);
  });
  const code = await new Promise<number>((r) => p.on("close", (c) => r(c ?? -1)));
  if (over)
    throw new CliError(
      `${real} is more than ${mb(MAX_UPLOAD_BYTES)} as an archive; one upload through the Worker takes at most that`,
      "copy a smaller part, or push it to a workspace through git",
    );
  if (code !== 0)
    throw new CliError(
      `tar on this machine exited ${code}: ${stderr.trim().split("\n")[0] ?? ""}`,
      "check that every file is readable",
    );
  return new Uint8Array(Buffer.concat(parts));
}

async function call(
  d: CpDeps,
  method: string,
  path: string,
  init: { body?: string | Uint8Array; headers?: Record<string, string> } = {},
): Promise<Response> {
  let res: Response;
  try {
    res = await (d.fetchFn ?? fetch)(`${d.url.replace(/\/$/, "")}${path}`, {
      method,
      ...(init.body !== undefined ? { body: init.body } : {}),
      headers: { authorization: `Bearer ${d.token}`, ...(init.headers ?? {}) },
    });
  } catch (e) {
    throw new CliError(
      `cannot reach ${d.url} from this machine (${e instanceof Error ? e.message : String(e)})`,
      "run the command again; if it repeats, check the network with cf-opencode doctor",
    );
  }
  if (res.status === 401)
    throw new CliError(
      "the Worker refused the control token on this machine",
      "copy ~/.cf-opencode/control-token from the machine that ran cf-opencode init",
    );
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    if (body?.error) throw new CliError(body.error, "see the line above");
    throw new CliError(
      `${d.url} answered HTTP ${res.status}${res.status === 404 ? "; the Worker is older than this CLI" : ""}`,
      res.status === 404 ? "cf-opencode upgrade" : "retry",
    );
  }
  return res;
}

async function* lines(res: Response): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        yield buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    }
  } catch {
    // A broken stream ends the lines; the caller reports the missing result.
  }
  if (buf.trim()) yield buf;
}

function tally(path: string): { files: number; dirs: number; links: number } {
  const t = { files: 0, dirs: 0, links: 0 };
  const walk = (p: string) => {
    const s = lstatSync(p);
    if (s.isSymbolicLink()) t.links++;
    else if (s.isDirectory()) {
      t.dirs++;
      for (const e of readdirSync(p)) walk(join(p, e));
    } else t.files++;
  };
  walk(path);
  return t;
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const secs = (t0: number) => Math.round((Date.now() - t0) / 100) / 10;

export function mb(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`;
}
