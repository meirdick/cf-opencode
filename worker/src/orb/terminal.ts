// Shell and SSH: one websocket bridged to one exec'd process inside the container.
//
// `cf-opencode shell` runs `tmux new-session -A` on a PTY. The tmux server outlives the
// websocket, so a closed laptop detaches the client and the agent keeps running.
// `cf-opencode ssh-proxy` runs `sshd -i`, which speaks SSH on stdin/stdout, so no port is
// opened and nothing listens. Both use bridge(); only the process differs.
//
// Wire: binary frames are bytes for the process. Shell text frames are JSON control
// messages ({"type":"resize","cols":N,"rows":N}); SSH has no control channel, so its
// text frames are bytes too. The Worker checks the workspace password before any of this.

export interface StdioProcess {
  readonly stdin: WritableStream | null;
  readonly stdout: ReadableStream | null;
  readonly exitCode: Promise<number>;
  kill(signal?: number): void;
  resize?(cols: number, rows: number): void;
}

/** The accepted server end of a WebSocketPair. */
export interface SocketLike {
  send(data: ArrayBuffer | ArrayBufferView | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", fn: () => void): void;
}

export interface BridgeOptions {
  /** Text frames carry control messages (shell). False: every frame is bytes (SSH). */
  control: boolean;
  /** Called on every frame in either direction. The caller throttles. */
  onActivity: () => void;
}

const enc = new TextEncoder();

/** Pump frames both ways until either side ends. Resolves when the process exited or was killed. */
export async function bridge(ws: SocketLike, proc: StdioProcess, opts: BridgeOptions): Promise<void> {
  const writer = proc.stdin?.getWriter();
  let writes: Promise<void> = Promise.resolve();
  let closed = false;
  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    try {
      ws.close(code, reason.slice(0, 120));
    } catch {
      // already closed
    }
    writer?.close().catch(() => undefined);
    try {
      proc.kill();
    } catch {
      // already exited
    }
  };

  ws.addEventListener("message", (ev) => {
    let data = ev.data;
    if (typeof data === "string") {
      if (opts.control) {
        const size = parseResize(data);
        if (size) proc.resize?.(size.cols, size.rows);
        return;
      }
      data = enc.encode(data);
    }
    if (!writer) return;
    opts.onActivity();
    // Chained, so frames reach the process in order even when one needs an async read.
    writes = writes
      .then(async () => {
        const bytes = await toBytes(data);
        if (bytes) await writer.write(bytes);
      })
      .catch(() => finish(1011, "process input closed"));
  });
  ws.addEventListener("close", () => finish(1000, "client closed"));
  ws.addEventListener("error", () => finish(1011, "socket error"));

  const reader = proc.stdout?.getReader();
  try {
    while (reader && !closed) {
      const { done, value } = await reader.read();
      if (done) break;
      opts.onActivity();
      ws.send(value as Uint8Array);
    }
  } catch {
    // stdout broke: the process is gone or was killed
  }
  const code = await proc.exitCode.catch(() => -1);
  finish(1000, `exit ${code}`);
}

/**
 * Binary frame payload as bytes. Workers deliver binary frames as Blob under the standard
 * binaryType (current compatibility dates), as ArrayBuffer under the old default.
 */
async function toBytes(data: unknown): Promise<Uint8Array | undefined> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Blob !== "undefined" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return undefined;
}

/** {"type":"resize","cols":N,"rows":N} with sane bounds, else undefined. */
export function parseResize(text: string): { cols: number; rows: number } | undefined {
  try {
    const m = JSON.parse(text) as { type?: unknown; cols?: unknown; rows?: unknown };
    if (m.type !== "resize") return undefined;
    const cols = Number(m.cols);
    const rows = Number(m.rows);
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return undefined;
    if (cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return undefined;
    return { cols, rows };
  } catch {
    return undefined;
  }
}

/** tmux session names a user can pick. Default "main". */
export const SESSION_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function shellParams(url: URL): { cols: number; rows: number; session: string } | { error: string } {
  const size = parseResize(
    JSON.stringify({
      type: "resize",
      cols: Number(url.searchParams.get("cols") ?? 80),
      rows: Number(url.searchParams.get("rows") ?? 24),
    }),
  );
  if (!size) return { error: "cols and rows must be whole numbers from 1 to 1000" };
  const session = url.searchParams.get("session") ?? "main";
  if (!SESSION_RE.test(session)) return { error: "session names are 1-32 letters, digits, _ or -" };
  return { ...size, session };
}

/** One OpenSSH public key line. Anything else is refused before it reaches authorized_keys. */
const KEY_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [\x20-\x7e]{0,200})?$/;

export function isPublicKey(line: string | null): line is string {
  return Boolean(line) && (line as string).length <= 8192 && KEY_RE.test(line as string);
}
