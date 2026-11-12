// `cf-opencode preview`: forward a workspace port to this machine over the workspace's SSH.
//
// This is the private preview. Nothing is public and no URL exists: the dev server appears at
// http://localhost:<port> here, at the root, so absolute asset paths and hot reload work as they do on a
// local machine. It also reaches a dev server that listens on 127.0.0.1 only. The forward lives as long
// as this command runs.
import { createConnection, createServer } from "node:net";
import { CliError } from "./errors.js";

export interface Forward {
  /** Port of the dev server in the workspace. */
  remote: number;
  /** Port on this machine. */
  local: number;
}

/** Ports from the command line. A dev server runs on an unprivileged port. */
export function parsePorts(raw: string[]): number[] {
  if (raw.length === 0)
    throw new CliError("preview needs a port", "cf-opencode preview 3000 (or: preview <workspace> 3000)");
  return raw.map((r) => {
    const n = Number(r);
    if (!/^\d+$/.test(r) || n < 1024 || n > 65535)
      throw new CliError(`${JSON.stringify(r)} is not a port from 1024 to 65535`, "cf-opencode preview 3000");
    return n;
  });
}

/**
 * Split `preview` positionals into the workspace and the ports. With no workspace, it is the one of the
 * current directory, as for `connect`: `preview 3000` and `preview app 3000 5173` both work.
 */
export function splitPreviewArgs(
  positionals: string[],
  fallbackId: () => string,
): { id: string; ports: string[] } {
  const [first, ...rest] = positionals;
  if (first !== undefined && !/^\d+$/.test(first)) return { id: first, ports: rest };
  return { id: fallbackId(), ports: positionals };
}

/** True when nothing listens on 127.0.0.1:<port> here. */
export function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/** The same port here when it is free, else the next free one, so two previews do not collide. */
export async function pickLocal(
  remote: number,
  taken: Set<number>,
  free: (port: number) => Promise<boolean> = isFree,
): Promise<number> {
  for (let p = remote; p < remote + 50 && p <= 65535; p++) {
    if (!taken.has(p) && (await free(p))) return p;
  }
  throw new CliError(`no free port near ${remote} on this machine`, "close what uses it, then retry");
}

/** ssh arguments for the forwards. No remote command; fail at once when a forward cannot be made. */
export function forwardArgs(forwards: Forward[]): string[] {
  return [
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    ...forwards.flatMap((f) => ["-L", `127.0.0.1:${f.local}:localhost:${f.remote}`]),
  ];
}

/** Wait until the local end accepts a connection: ssh is up. False after the limit. */
export async function waitListening(port: number, limitMs = 20_000): Promise<boolean> {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const ok = await new Promise<boolean>((resolve) => {
      const c = createConnection({ host: "127.0.0.1", port });
      c.once("connect", () => {
        c.destroy();
        resolve(true);
      });
      c.once("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export interface ForwardOptions {
  id: string;
  ports: string[];
  open: boolean;
  /** Runs ssh against the workspace with these extra arguments; resolves with its exit code. */
  ssh: (id: string, extra: string[]) => Promise<number>;
  opener: (url: string) => Promise<boolean>;
  err: (s: string) => void;
  free?: (port: number) => Promise<boolean>;
  wait?: (port: number) => Promise<boolean>;
}

export async function forwardPreview(o: ForwardOptions): Promise<number> {
  const taken = new Set<number>();
  const forwards: Forward[] = [];
  for (const remote of parsePorts(o.ports)) {
    const local = await pickLocal(remote, taken, o.free);
    taken.add(local);
    forwards.push({ remote, local });
  }
  for (const f of forwards) {
    const moved = f.local === f.remote ? "" : ` (port ${f.remote} is in use here)`;
    o.err(`http://localhost:${f.local}  →  ${o.id} port ${f.remote}${moved}`);
  }
  o.err("Private: only this machine can open it. Ctrl-C stops the preview.");
  const done = o.ssh(o.id, forwardArgs(forwards));
  const first = forwards[0];
  if (o.open && first) {
    const up = await Promise.race([(o.wait ?? waitListening)(first.local), done.then(() => false)]);
    if (up) await o.opener(`http://localhost:${first.local}`);
  }
  const code = await done;
  // 130: the user pressed Ctrl-C, which is how a preview ends.
  return code === 130 || code === 255 ? 0 : code;
}
