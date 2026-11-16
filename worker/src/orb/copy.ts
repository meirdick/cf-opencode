// `cf-opencode cp`, the workspace side. The Worker route (copy-api.ts) drives it and checks the stream between.
//
// Source: copyStat (kind, size, entries), then copyOut, which streams `tar c` of the path as `user`.
// Target: copyPrepare picks the target path and makes a stage directory, copyIn runs `tar x` as `user` into the
// stage, and copyCommit moves the tree into place only after the Worker saw the whole stream pass its check.
// A copy that fails leaves the target as it was. A stage left by a lost copy is removed a day later.
//
// Every process runs as `user`, never as root, because /home/user is the agent's and a symlink there could
// point a root write at a system file. The workspace's scripts cannot widen a copy: the Worker resolves and
// checks each path first, and tar-guard.ts checks every member of the stream.
import type { Clock, ContainerPort, KV, StreamProcess } from "../core/container-port";
import { ROOT_NAME } from "../core/tar-guard";
import { DEFAULT_DIRECTORY, type OpRecord, type WorkspaceRecord } from "../core/types";
import { LAST_USE_KEY } from "./alarm";
import { iso } from "./journal";
import { WORKSPACE_USER } from "./spawn";
import { wakeRefusal } from "./task-wake";

export const HOME = "/home/user";
/** Stage directories. Inside /home/user, so the last move is a rename on the same disk. */
export const STAGE_ROOT = `${HOME}/.cache/cf-opencode/cp`;
/** One copy runs at most this long in each container (coreutils timeout). */
export const COPY_TIMEOUT_S = 1800;
/** Data bytes of one copy between workspaces, or to this machine. */
export const MAX_COPY_BYTES = 4_000_000_000;
/** Files, directories and links in one copy. */
export const MAX_COPY_ENTRIES = 200_000;
/** One request body through the Worker: Cloudflare's limit for workers.dev and Free and Pro zones. */
export const MAX_UPLOAD_BYTES = 100_000_000;

export type CopyFail = { ok: false; error: string };

/**
 * A path in a workspace, made absolute. Relative paths start at the checkout, `~` is /home/user. A path that
 * ends outside /home/user is refused. `slash` keeps a trailing slash: "put it inside this directory".
 */
export function resolvePath(
  raw: string,
  directory: string = DEFAULT_DIRECTORY,
): { ok: true; path: string; slash: boolean } | CopyFail {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  if (raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw))
    return fail("the path is longer than 4096 characters or holds a control character", "check the path");
  let s = raw;
  if (s === "~" || s.startsWith("~/")) s = HOME + s.slice(1);
  else if (s.startsWith("~"))
    return fail(`${raw} names another user's home`, "use ~/ or a path under /home/user");
  const slash = s.endsWith("/") || s === "" || s === "." || s.endsWith("/.") || s.endsWith("/..");
  const parts: string[] = [];
  for (const p of `${s.startsWith("/") ? "" : `${directory}/`}${s}`.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  const path = `/${parts.join("/")}`;
  if (path !== HOME && !path.startsWith(`${HOME}/`))
    return fail(
      `${raw || "."} is outside /home/user`,
      "use a path under /home/user, or one relative to the checkout",
    );
  return { ok: true, path, slash };
}

/** Why `name` cannot be the last component of a target, or undefined. */
export function badName(name: string): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  if (!name || name.length > 255 || name === "." || name === ".." || /[/\x00-\x1f\x7f]/.test(name))
    return "the name must be one path component, 1 to 255 characters";
  return undefined;
}

export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** $1 path, $2 home. Prints kind, bytes and entries, NUL-separated. Wakes nothing, writes nothing. */
export const STAT_SH = `p=$1; home=$2
[ -e "$p" ] || { printf 'none\\0'; exit 0; }
r=$(realpath -e -- "$p") || { printf 'none\\0'; exit 0; }
case "$r" in "$home"|"$home"/*) ;; *) printf 'outside\\0'; exit 0;; esac
if [ -d "$r" ]; then k=dir; elif [ -f "$r" ]; then k=file; else printf 'special\\0'; exit 0; fi
b=$(du -sb -- "$r" 2>/dev/null | cut -f1)
n=$(find "$r" 2>/dev/null | wc -l)
printf '%s\\0%s\\0%s\\0' "$k" "\${b:-0}" "\${n:-0}"`;

/** $1 path, $2 home, $3 seconds. The archive on stdout; a failed tar adds the mark that tar-guard.ts refuses. */
export const OUT_SH = `r=$(realpath -e -- "$1") || exit 4
case "$r" in "$2"|"$2"/*) ;; *) exit 3;; esac
cd -- "$(dirname -- "$r")" || exit 4
timeout "$3" tar --format=posix --exclude=.cache/cf-opencode/cp -cf - -- "$(basename -- "$r")"
rc=$?
[ "$rc" -eq 0 ] || printf 'CF-OPENCODE-TAR-FAILED %s\\n' "$rc"
exit "$rc"`;

/**
 * $1 path, $2 name, $3 force, $4 slash, $5 bytes, $6 home, $7 stage root. An existing directory, or a path
 * with a trailing slash, takes the item inside it, as cp does. Prints ok, target, stage; or a reason.
 */
export const PREP_SH = `d=$1; name=$2; force=$3; slash=$4; need=$5; home=$6; sroot=$7
if [ -d "$d" ] || [ "$slash" = 1 ]; then t="\${d%/}/$name"; else t=$d; fi
parent=$(dirname -- "$t")
mkdir -p -- "$parent" 2>/dev/null || { printf 'parent\\0'; exit 0; }
rp=$(realpath -e -- "$parent") || { printf 'parent\\0'; exit 0; }
case "$rp" in "$home"|"$home"/*) ;; *) printf 'outside\\0'; exit 0;; esac
[ -d "$rp" ] || { printf 'parent\\0'; exit 0; }
t="\${rp%/}/$(basename -- "$t")"
if [ -e "$t" ] || [ -L "$t" ]; then [ "$force" = 1 ] || { printf 'exists\\0%s\\0' "$t"; exit 0; }; fi
mkdir -p -- "$sroot" 2>/dev/null || { printf 'stage\\0'; exit 0; }
find "$sroot" -mindepth 1 -maxdepth 1 -mmin +1440 -exec rm -rf -- {} + 2>/dev/null
free=$(df -B1 --output=avail -- "$sroot" 2>/dev/null | tail -n 1 | tr -d ' ')
case "$free" in ''|*[!0-9]*) ;; *) [ "$free" -ge $((need + 100000000)) ] || { printf 'space\\0%s\\0' "$free"; exit 0; };; esac
s=$(mktemp -d -- "$sroot/XXXXXXXX") || { printf 'stage\\0'; exit 0; }
printf 'ok\\0%s\\0%s\\0' "$t" "$s"`;

/** $1 stage, $2 seconds. The checked archive on stdin. */
export const IN_SH = `cd -- "$1" || exit 4
exec timeout "$2" tar -xf - --no-same-owner --no-same-permissions`;

/** $1 stage, $2 target, $3 force, $4 root name. A replaced target goes back when the move fails. */
export const COMMIT_SH = `s=$1; t=$2; force=$3; item="$1/$4"
[ -e "$item" ] || [ -L "$item" ] || exit 5
if [ -e "$t" ] || [ -L "$t" ]; then
  [ "$force" = 1 ] || exit 6
  mv -T -- "$t" "$s/old" || exit 7
fi
if ! mv -T -- "$item" "$t"; then
  [ -e "$s/old" ] && mv -T -- "$s/old" "$t"
  exit 7
fi
rm -rf -- "$s"`;

const run = (script: string, ...args: string[]) => ["bash", "-c", script, "cf-opencode-cp", ...args];

export interface CopyDeps {
  workspaceId: string;
  container: ContainerPort;
  kv: KV;
  clock: Clock;
  /** The workspace record; directory says where relative paths start. */
  record(): Promise<WorkspaceRecord | undefined>;
  /** Wake the workspace when it is not awake. A Failed line when it cannot. */
  wake(): Promise<string | undefined>;
}

export interface PendingCopy {
  stage: string;
  target: string;
  force: boolean;
}

export type StatResult =
  | { ok: true; path: string; name: string; kind: "file" | "dir" | "none"; bytes: number; entries: number }
  | CopyFail;

/** Where a copy reads from: kind, size and entries, so the Worker refuses a large copy before it starts. */
export async function copyStat(d: CopyDeps, raw: string): Promise<StatResult> {
  const woke = await d.wake();
  if (woke) return { ok: false, error: woke };
  const r = resolvePath(raw, (await d.record())?.directory);
  if (!r.ok) return r;
  const out = await d.container.exec(run(STAT_SH, r.path, HOME), {
    user: WORKSPACE_USER,
    timeoutMs: 120_000,
  });
  const [kind = "", bytes = "0", entries = "0"] = out.stdout.split("\0");
  if (out.exitCode !== 0)
    return fail(`reading ${r.path} in ${d.workspaceId} failed`, `cf-opencode logs ${d.workspaceId}`);
  if (kind === "outside")
    return fail(
      `${r.path} in ${d.workspaceId} is a symlink to a place outside /home/user`,
      "copy the file it points to",
    );
  if (kind === "special")
    return fail(`${r.path} in ${d.workspaceId} is not a file or a directory`, "copy a file or a directory");
  if (kind !== "file" && kind !== "dir" && kind !== "none")
    return fail(`reading ${r.path} in ${d.workspaceId} failed`, `cf-opencode logs ${d.workspaceId}`);
  return {
    ok: true,
    path: r.path,
    name: basename(r.path),
    kind,
    bytes: Number(bytes) || 0,
    entries: Number(entries) || 0,
  };
}

/** Stream `tar c` of an absolute path. The Worker checks the stream before anything reads it. */
export async function copyOut(
  d: CopyDeps,
  path: string,
): Promise<{ ok: true; stream: ReadableStream<Uint8Array> } | CopyFail> {
  const woke = await d.wake();
  if (woke) return { ok: false, error: woke };
  const r = resolvePath(path, HOME);
  if (!r.ok || r.path !== path)
    return fail("the copy source is not an absolute path under /home/user", "retry");
  const p = await d.container.execStream(run(OUT_SH, path, HOME, String(COPY_TIMEOUT_S)), {
    user: WORKSPACE_USER,
  });
  await inUse(d, p);
  return { ok: true, stream: p.stdout };
}

/** Pick the target and make a stage directory. Nothing in the target changes yet. */
export async function copyPrepare(
  d: CopyDeps,
  o: { path: string; name: string; force: boolean; bytes: number },
): Promise<{ ok: true; target: string; pending: PendingCopy } | CopyFail> {
  const bad = badName(o.name);
  if (bad) return fail(bad, "check the source path");
  const woke = await d.wake();
  if (woke) return { ok: false, error: woke };
  const r = resolvePath(o.path, (await d.record())?.directory);
  if (!r.ok) return r;
  const out = await d.container.exec(
    run(
      PREP_SH,
      r.path,
      o.name,
      o.force ? "1" : "0",
      r.slash ? "1" : "0",
      String(Math.max(0, Math.floor(o.bytes))),
      HOME,
      STAGE_ROOT,
    ),
    { user: WORKSPACE_USER, timeoutMs: 120_000 },
  );
  const [what = "", a = "", b = ""] = out.stdout.split("\0");
  const id = d.workspaceId;
  if (out.exitCode === 0 && what === "ok" && b.startsWith(`${STAGE_ROOT}/`) && !b.includes("/.."))
    return { ok: true, target: a, pending: { stage: b, target: a, force: o.force } };
  if (what === "exists")
    return fail(`${id}:${a} exists`, "pass --force to replace it, or pick another target");
  if (what === "outside")
    return fail(`the target in ${id} resolves to a place outside /home/user`, "pick another target");
  if (what === "parent") return fail(`cannot make the folder for ${r.path} in ${id}`, "pick another target");
  if (what === "space")
    return fail(
      `${id} has ${Math.round(Number(a) / 1e6)} MB free, too little for this copy`,
      `free disk space in ${id}, then retry`,
    );
  return fail(`preparing the copy in ${id} failed`, `cf-opencode logs ${id}`);
}

/** Unpack the checked stream into the stage. The Worker decides afterwards whether to commit. */
export async function copyIn(
  d: CopyDeps,
  p: PendingCopy,
  tar: ReadableStream<Uint8Array>,
): Promise<{ ok: true } | CopyFail> {
  const proc = await d.container.execStream(run(IN_SH, p.stage, String(COPY_TIMEOUT_S)), {
    user: WORKSPACE_USER,
    stdin: tar,
  });
  await proc.stdout.cancel().catch(() => undefined);
  await inUse(d, proc);
  const code = await proc.exitCode.catch(() => -1);
  if (code === 0) return { ok: true };
  return fail(
    code === 124
      ? `the copy into ${d.workspaceId} ran longer than ${COPY_TIMEOUT_S / 60} min`
      : `unpacking in ${d.workspaceId} exited ${code}`,
    "retry; the target is unchanged",
  );
}

export async function copyCommit(
  d: CopyDeps,
  p: PendingCopy,
): Promise<{ ok: true; target: string } | CopyFail> {
  const out = await d.container.exec(run(COMMIT_SH, p.stage, p.target, p.force ? "1" : "0", ROOT_NAME), {
    user: WORKSPACE_USER,
    timeoutMs: 300_000,
  });
  if (out.exitCode === 0) return { ok: true, target: p.target };
  const id = d.workspaceId;
  if (out.exitCode === 6)
    return fail(`${id}:${p.target} appeared during the copy`, "pass --force to replace it");
  return fail(`moving the copy into place in ${id} exited ${out.exitCode}`, "retry; the target is unchanged");
}

export async function copyAbort(d: CopyDeps, p: PendingCopy): Promise<void> {
  if (!p.stage.startsWith(`${STAGE_ROOT}/`) || p.stage.includes("/..")) return;
  if (!d.container.running) return;
  await d.container
    .exec(["rm", "-rf", "--", p.stage], { user: WORKSPACE_USER, timeoutMs: 120_000 })
    .catch(() => undefined);
}

/**
 * A copy counts as use until it ends, so the idle pause does not stop it. The last use is set to the copy's
 * time limit, then back to now when the process ends.
 */
async function inUse(d: CopyDeps, p: StreamProcess): Promise<void> {
  await d.kv.put(LAST_USE_KEY, iso(d.clock.now() + COPY_TIMEOUT_S * 1000));
  void p.exitCode
    .catch(() => -1)
    .then(() => d.kv.put(LAST_USE_KEY, iso(d.clock.now())))
    .catch(() => undefined);
}

export interface WakeForCopy {
  workspaceId: string;
  running: () => boolean;
  record: () => Promise<WorkspaceRecord | undefined>;
  controlToken?: string | undefined;
  password: (controlToken: string, workspaceId: string) => Promise<string>;
  spawn: (password: string, directory: string | undefined) => Promise<OpRecord | undefined>;
}

/**
 * Wake a workspace for a copy, as A2A does for a task (task-wake.ts). A warm workspace is woken too: its
 * container stops at the end of the warm time and loses what was written after the pause.
 */
export async function wakeForCopy(w: WakeForCopy): Promise<string | undefined> {
  const rec = await w.record();
  if (w.running() && rec?.state === "awake") return undefined;
  const refused = wakeRefusal(rec, w.workspaceId, w.controlToken);
  if (refused) return refused.error;
  const op = await w.spawn(await w.password(w.controlToken as string, w.workspaceId), rec?.directory);
  if (op?.phase === "succeeded") return undefined;
  const why = (op?.error ?? "the wake did not finish").replace(/^Failed: /, "").replace(/ — fix: .*$/, "");
  return `Failed: workspace ${w.workspaceId} did not wake (${why}) — fix: pause another workspace if the limit is reached, or run cf-opencode logs ${w.workspaceId}`;
}

function fail(cause: string, fix: string): CopyFail {
  return { ok: false, error: `Failed: ${cause} — fix: ${fix}` };
}
