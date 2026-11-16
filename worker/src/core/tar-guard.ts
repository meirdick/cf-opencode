// The Worker-side check of a tar stream that `cf-opencode cp` moves into a workspace or to a laptop.
//
// The source is not trusted: an agent is root in its container and can replace `tar`. So the Worker reads every
// header, refuses what could write outside the copied tree, and writes a new archive with headers it made
// itself. The receiving `tar` never sees a header from the source, so a parser difference cannot help an
// attacker. The rules:
//
// - Every member is the root or under it. The root gets the fixed name ROOT_NAME; the receiver renames it.
// - No absolute name and no `..` component, in a name or a link target.
// - Regular files, directories, symlinks and hard links only. A symlink target is relative, has no `..`, and
//   the root itself is not a symlink, so every link points down inside the tree. A hard link names an
//   earlier member of the same tree.
// - Modes lose setuid, setgid and sticky bits, and owners become the workspace user.
// - The data bytes stop at maxBytes, and the members stop at maxEntries.
//
// The source script prints FAILED_MARK after the archive when its tar exits with an error, so a tar that skipped
// an unreadable file does not count as a whole copy.

export const ROOT_NAME = "data";
export const FAILED_MARK = "CF-OPENCODE-TAR-FAILED";
const BLOCK = 512;
const MAX_NAME = 4096;
const MAX_META = 1024 * 1024;
const MAX_TRAILER = 1024 * 1024;
const DATA_CHUNK = 64 * 1024;
/** The largest size an 11-digit octal field holds. */
const OCTAL_MAX = 8 ** 11 - 1;

export interface GuardStats {
  /** Data bytes of the files. Headers are not counted. */
  bytes: number;
  files: number;
  dirs: number;
  links: number;
}

export interface GuardOptions {
  maxBytes: number;
  maxEntries?: number;
  onProgress?: (s: GuardStats) => void;
}

/** A stream the guard refused. The message is a cause, without "Failed:". */
export class CopyRefused extends Error {}

/** Check `src` and give a canonical copy of it. `done` settles when the copy ends or fails. */
export function guardTar(
  src: ReadableStream<Uint8Array>,
  o: GuardOptions,
): { stream: ReadableStream<Uint8Array>; done: Promise<GuardStats> } {
  const stats: GuardStats = { bytes: 0, files: 0, dirs: 0, links: 0 };
  const rd = new BlockReader(src.getReader());
  const gen = canonical(rd, o, stats);
  let settle!: (e?: unknown) => void;
  const done = new Promise<GuardStats>((resolve, reject) => {
    settle = (e) => (e === undefined ? resolve(stats) : reject(e));
  });
  done.catch(() => undefined);
  const stream = new ReadableStream<Uint8Array>({
    type: "bytes",
    async pull(c) {
      try {
        const next = await gen.next();
        if (next.done) {
          c.close();
          settle();
          return;
        }
        // Every chunk owns its buffer (BlockReader copies), as a byte stream's enqueue requires.
        c.enqueue(next.value as Uint8Array<ArrayBuffer>);
        o.onProgress?.(stats);
      } catch (e) {
        const err = e instanceof CopyRefused ? e : new CopyRefused(`the copy broke off: ${errText(e)}`);
        settle(err);
        c.error(err);
        await rd.cancel(err);
      }
    },
    async cancel(reason) {
      settle(new CopyRefused("the receiver stopped reading"));
      await rd.cancel(reason);
    },
  });
  return { stream, done };
}

async function* canonical(rd: BlockReader, o: GuardOptions, stats: GuardStats): AsyncGenerator<Uint8Array> {
  const maxEntries = o.maxEntries ?? 1_000_000;
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  let longLink: string | undefined;
  let entries = 0;
  let first = true;
  let root: string | undefined;
  for (;;) {
    const h = await rd.take(BLOCK);
    if (!h) {
      const left = rd.leftover();
      if (startsWith(left, FAILED_MARK)) throw sourceFailed(left);
      throw new CopyRefused(first ? "the source sent no archive" : "the archive ended early");
    }
    if (startsWith(h, FAILED_MARK)) throw sourceFailed(h);
    if (h.every((b) => b === 0)) {
      if (first) throw new CopyRefused("the source sent an empty archive");
      await checkTrailer(rd);
      yield new Uint8Array(2 * BLOCK);
      return;
    }
    checkSum(h);
    const type = String.fromCharCode(h[156] as number);
    const headerSize = parseNumber(h, 124, 12, "size");
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      if (headerSize > MAX_META) throw new CopyRefused("an archive header is too large");
      const data = await rd.take(padded(headerSize));
      if (!data) throw new CopyRefused("the archive ended early");
      const body = data.subarray(0, headerSize);
      if (type === "x") pax = { ...pax, ...parsePax(body) };
      else if (type === "L") longName = cString(body);
      else if (type === "K") longLink = cString(body);
      // A global header (g) changes nothing here: the new archive has none.
      continue;
    }
    const name = pax.path ?? longName ?? ustarName(h);
    const link = pax.linkpath ?? longLink ?? field(h, 157, 100);
    const size = pax.size !== undefined ? paxSize(pax.size) : headerSize;
    pax = {};
    longName = undefined;
    longLink = undefined;
    first = false;
    if (++entries > maxEntries) throw new CopyRefused(`the tree has more than ${maxEntries} entries`);

    const [top, rest] = memberRest(name);
    root ??= top;
    if (top !== root) throw new CopyRefused(`${shown(name)} is not under ${shown(root)}`);
    const out = `${ROOT_NAME}${rest}`;
    const mode = parseNumber(h, 100, 8, "mode");
    const mtime = Math.min(Math.max(parseNumber(h, 136, 12, "mtime"), 0), OCTAL_MAX);
    if (type === "0" || type === "\0" || type === "7") {
      if (stats.bytes + size > o.maxBytes) throw new CopyRefused(`the copy is larger than ${mb(o.maxBytes)}`);
      if (size > OCTAL_MAX) throw new CopyRefused(`${shown(name)} is larger than 8 GiB`);
      yield* header(out, "0", size, mode & 0o111 ? 0o755 : 0o644, mtime);
      let left = size;
      while (left > 0) {
        const chunk = await rd.chunk(Math.min(left, DATA_CHUNK));
        if (!chunk) throw new CopyRefused("the archive ended early");
        left -= chunk.byteLength;
        stats.bytes += chunk.byteLength;
        yield chunk;
      }
      const pad = padded(size) - size;
      if (pad) {
        if (!(await rd.take(pad))) throw new CopyRefused("the archive ended early");
        yield new Uint8Array(pad);
      }
      stats.files++;
      continue;
    }
    if (size !== 0) throw new CopyRefused(`${shown(name)} has data on an entry that holds none`);
    if (type === "5") {
      yield* header(`${out}/`, "5", 0, 0o755, mtime);
      stats.dirs++;
    } else if (type === "2") {
      if (rest === "") throw new CopyRefused("the source path is a symlink; copy the file it points to");
      checkLinkTarget(link, name);
      yield* header(out, "2", 0, 0o777, mtime, link);
      stats.links++;
    } else if (type === "1") {
      const [linkTop, linkRest] = memberRest(link);
      if (linkTop !== root)
        throw new CopyRefused(`the hard link ${shown(name)} points outside the copied tree`);
      yield* header(out, "1", 0, 0o644, mtime, `${ROOT_NAME}${linkRest}`);
      stats.links++;
    } else {
      throw new CopyRefused(
        `${shown(name)} is a ${KINDS[type] ?? `tar entry of type ${JSON.stringify(type)}`}; cp copies files, directories and links`,
      );
    }
  }
}

const KINDS: Record<string, string> = {
  "3": "character device",
  "4": "block device",
  "6": "named pipe",
  S: "sparse file",
  V: "volume label",
  M: "multi-volume part",
};

/**
 * The root component of a member name, and the part after it ("" for the root itself). Refuses absolute names
 * and `..`. "./" components are dropped.
 */
function memberRest(name: string): [string, string] {
  if (name.length === 0 || name.length > MAX_NAME)
    throw new CopyRefused("a member name is empty or too long");
  if (name.startsWith("/")) throw new CopyRefused(`${shown(name)} is an absolute path`);
  if (name.includes("\0")) throw new CopyRefused("a member name holds a NUL byte");
  const parts = name.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) throw new CopyRefused(`${shown(name)} names no file`);
  if (parts.includes("..")) throw new CopyRefused(`${shown(name)} leaves the copied tree`);
  const rest = parts
    .slice(1)
    .map((p) => `/${p}`)
    .join("");
  return [parts[0] as string, rest];
}

/** Symlinks may only point down, so a chain of them stays inside the tree. */
function checkLinkTarget(target: string, name: string): void {
  if (target.length === 0 || target.length > MAX_NAME || target.includes("\0"))
    throw new CopyRefused(`the symlink ${shown(name)} has a bad target`);
  if (target.startsWith("/") || target.split("/").includes(".."))
    throw new CopyRefused(`the symlink ${shown(name)} points outside the copied tree`);
}

function* header(
  name: string,
  type: "0" | "1" | "2" | "5",
  size: number,
  mode: number,
  mtime: number,
  link = "",
): Generator<Uint8Array> {
  const records: string[] = [];
  if (name.length > 100) records.push(paxRecord("path", name));
  if (link.length > 100) records.push(paxRecord("linkpath", link));
  if (records.length) {
    const body = latin1(records.join(""));
    yield ustar("PaxHeader", "x", body.byteLength, 0o644, mtime, "");
    const block = new Uint8Array(padded(body.byteLength));
    block.set(body);
    yield block;
  }
  yield ustar(name.slice(0, 100), type, size, mode, mtime, link.slice(0, 100));
}

/** The header of a one-file archive whose root is ROOT_NAME. The store sends files in this form. */
export function fileHeader(size: number, mtime: number): Uint8Array {
  return ustar(ROOT_NAME, "0", size, 0o644, Math.min(Math.max(Math.floor(mtime), 0), OCTAL_MAX), "");
}

function ustar(
  name: string,
  type: string,
  size: number,
  mode: number,
  mtime: number,
  link: string,
): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const put = (s: string, at: number) => h.set(latin1(s), at);
  put(name, 0);
  put(octal(mode, 7), 100);
  put(octal(1000, 7), 108);
  put(octal(1000, 7), 116);
  put(octal(size, 11), 124);
  put(octal(mtime, 11), 136);
  put("        ", 148);
  put(type, 156);
  put(link, 157);
  put("ustar\x0000", 257);
  put("user", 265);
  put("user", 297);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${octal(sum, 6)}\0 `, 148);
  return h;
}

/** "<len> key=value\n", where len counts the whole record, itself included. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return `${len}${body}`;
}

function parsePax(body: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = binary(body);
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) === 0) break;
    const sp = text.indexOf(" ", i);
    const len = Number(text.slice(i, sp));
    if (sp < 0 || !Number.isSafeInteger(len) || len <= sp - i || i + len > text.length)
      throw new CopyRefused("an archive header is malformed");
    const rec = text.slice(sp + 1, i + len);
    if (!rec.endsWith("\n")) throw new CopyRefused("an archive header is malformed");
    const eq = rec.indexOf("=");
    if (eq > 0) {
      const key = rec.slice(0, eq);
      if (key === "path" || key === "linkpath" || key === "size") out[key] = rec.slice(eq + 1, -1);
    }
    i += len;
  }
  return out;
}

function paxSize(v: string): number {
  const n = Number(v);
  if (!/^[0-9]+$/.test(v) || !Number.isSafeInteger(n)) throw new CopyRefused("an archive size is malformed");
  return n;
}

/** The name of a ustar header: the prefix field joins it only in POSIX ustar, not in old GNU headers. */
function ustarName(h: Uint8Array): string {
  const name = field(h, 0, 100);
  const posix = binary(h.subarray(257, 263)) === "ustar\0";
  const prefix = posix ? field(h, 345, 155) : "";
  return prefix ? `${prefix}/${name}` : name;
}

function checkSum(h: Uint8Array): void {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
  if (parseNumber(h, 148, 8, "checksum") !== sum)
    throw new CopyRefused("the archive is damaged (bad checksum)");
}

/** Octal, or GNU base-256 when the high bit of the first byte is set. */
function parseNumber(h: Uint8Array, at: number, len: number, what: string): number {
  const f = h.subarray(at, at + len);
  if ((f[0] as number) & 0x80) {
    if ((f[0] as number) === 0xff) throw new CopyRefused(`an archive ${what} is negative`);
    let n = (f[0] as number) & 0x7f;
    for (let i = 1; i < f.length; i++) n = n * 256 + (f[i] as number);
    if (!Number.isSafeInteger(n)) throw new CopyRefused(`an archive ${what} is too large`);
    return n;
  }
  const s = binary(f)
    .replace(/[\0 ]+$/, "")
    .replace(/^ +/, "");
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new CopyRefused(`an archive ${what} is malformed`);
  return Number.parseInt(s, 8);
}

/** After the end: zero padding only. The source script's failure mark, or anything else, fails the copy. */
async function checkTrailer(rd: BlockReader): Promise<void> {
  let seen = 0;
  for (;;) {
    const c = await rd.chunk(DATA_CHUNK);
    if (!c) return;
    seen += c.byteLength;
    const at = c.findIndex((b) => b !== 0);
    if (at >= 0) {
      let rest = c.subarray(at);
      while (rest.byteLength < 40) {
        const more = await rd.chunk(40);
        if (!more) break;
        rest = concatBytes(rest, more);
      }
      if (startsWith(rest, FAILED_MARK)) throw sourceFailed(rest);
      throw new CopyRefused("the archive has data after its end");
    }
    if (seen > MAX_TRAILER) throw new CopyRefused("the archive has data after its end");
  }
}

function sourceFailed(b: Uint8Array): CopyRefused {
  const code = /^CF-OPENCODE-TAR-FAILED (\d{1,3})/.exec(binary(b.subarray(0, 40)))?.[1] ?? "?";
  return new CopyRefused(
    code === "124"
      ? "the copy ran longer than its time limit in the source workspace"
      : `tar in the source workspace exited ${code}; a file there is not readable as user, or changed during the copy`,
  );
}

/** Reads exact block runs, or data chunks, from a byte stream. Every array it returns owns its buffer. */
class BlockReader {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private ended = false;
  constructor(private readonly r: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(n: number): Promise<boolean> {
    while (this.size < n && !this.ended) {
      const { done, value } = await this.r.read();
      if (done) this.ended = true;
      else if (value.byteLength) {
        this.chunks.push(value);
        this.size += value.byteLength;
      }
    }
    return this.size >= n;
  }

  /** Exactly n bytes, or undefined at the end of the stream. */
  async take(n: number): Promise<Uint8Array | undefined> {
    if (n === 0) return new Uint8Array(0);
    if (!(await this.fill(n))) return undefined;
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0] as Uint8Array;
      const k = Math.min(c.byteLength, n - at);
      out.set(c.subarray(0, k), at);
      at += k;
      this.drop(k);
    }
    return out;
  }

  /** 1 to max bytes, or undefined at the end of the stream. */
  async chunk(max: number): Promise<Uint8Array | undefined> {
    if (!(await this.fill(1))) return undefined;
    const c = this.chunks[0] as Uint8Array;
    const k = Math.min(c.byteLength, max);
    const out = c.slice(0, k);
    this.drop(k);
    return out;
  }

  /** The bytes read but not taken, after a take that found the end. */
  leftover(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }

  private drop(k: number): void {
    const c = this.chunks[0] as Uint8Array;
    if (k === c.byteLength) this.chunks.shift();
    else this.chunks[0] = c.subarray(k);
    this.size -= k;
  }

  async cancel(reason: unknown): Promise<void> {
    await this.r.cancel(reason).catch(() => undefined);
  }
}

const padded = (n: number) => Math.ceil(n / BLOCK) * BLOCK;
const octal = (n: number, digits: number) => n.toString(8).padStart(digits, "0");
const field = (h: Uint8Array, at: number, len: number) => cString(h.subarray(at, at + len));

function cString(b: Uint8Array): string {
  const end = b.indexOf(0);
  return binary(end < 0 ? b : b.subarray(0, end));
}

/** Bytes as a string of char codes 0-255, so a file name that is not UTF-8 goes through unchanged. */
function binary(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 8192)
    s += String.fromCharCode(...(b.subarray(i, i + 8192) as unknown as number[]));
  return s;
}

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}

function startsWith(b: Uint8Array, s: string): boolean {
  if (b.length < s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[i] !== s.charCodeAt(i)) return false;
  return true;
}

/** A member name for an error line: UTF-8 when it decodes, at most 120 characters. */
function shown(name: string): string {
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(latin1(name));
  } catch {
    s = name;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
  s = s.replace(/[\x00-\x1f\x7f]/g, "?");
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

export function mb(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
