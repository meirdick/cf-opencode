// cf-opencode shell and SSH. Both open a websocket to the Worker with the workspace
// password in a Basic header; the password never goes in a URL or an argument.
//
// shell: a PTY on `tmux new-session -A` inside the workspace. Closing the laptop drops the
//   websocket, which only detaches the tmux client; the session and its programs keep running.
// ssh-proxy: an ssh ProxyCommand. It carries the SSH bytes over the websocket to `sshd -i`
//   in the workspace, so ssh, scp, and tools such as herdr treat a workspace as a machine.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPassword, readWorkspace, stateDir } from "./config.js";
import { CliError } from "./errors.js";

export interface Target {
  url: string;
  id: string;
  password: string;
}

/** Workspace id, password, and Worker URL from local state. */
export function target(url: string, id: string | undefined): Target {
  if (!id) throw new CliError("needs a workspace id", "pass the id cf-opencode connect printed");
  const local = readWorkspace(id);
  if (!local) throw new CliError(`no local password for ${id}`, `cf-opencode connect ${id}`);
  return { url: url.replace(/\/$/, ""), id, password: readPassword(local) };
}

const basic = (password: string) => `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

function wsUrl(url: string, path: string): string {
  return `${url.replace(/^http/, "ws")}${path}`;
}

/**
 * Check the password and wake the workspace through the OpenCode route, so a wrong password
 * or a failed wake is one clear line instead of a refused websocket.
 */
export async function wake(t: Target, say: (line: string) => void): Promise<void> {
  say(`waking ${t.id} if it is paused`);
  let res: Response;
  try {
    res = await fetch(`${t.url}/oc/${encodeURIComponent(t.id)}/api/info`, {
      headers: { authorization: basic(t.password) },
    });
  } catch (e) {
    throw new CliError(
      `cannot reach ${t.url} (${e instanceof Error ? e.message : String(e)})`,
      "cf-opencode doctor",
    );
  }
  await res.body?.cancel();
  if (res.status === 401)
    throw new CliError(`the workspace refused the password for ${t.id}`, `cf-opencode connect ${t.id}`);
  if (res.status === 410)
    throw new CliError(`${t.id} was deleted`, "start a new workspace with cf-opencode connect");
  if (!res.ok) throw new CliError(`${t.id} did not wake (${res.status})`, `cf-opencode logs ${t.id}`);
}

export interface ShellIO {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

/** Attach the local terminal to tmux session `session` in the workspace. Resolves with an exit code. */
export async function shell(t: Target, session = "main", io: ShellIO = process): Promise<number> {
  if (!io.stdin.isTTY) {
    throw new CliError("shell needs an interactive terminal", `cf-opencode ssh ${t.id} -- <command>`);
  }
  await wake(t, (l) => io.stderr.write(`${l}\n`));
  const q = new URLSearchParams({
    cols: String(io.stdout.columns || 80),
    rows: String(io.stdout.rows || 24),
    session,
  });
  const ws = new WebSocket(wsUrl(t.url, `/shell/${encodeURIComponent(t.id)}?${q}`), {
    headers: { authorization: basic(t.password) },
  } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  return new Promise((resolve) => {
    let opened = false;
    const onData = (b: Buffer) => ws.send(b);
    const onResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: io.stdout.columns, rows: io.stdout.rows }));
      }
    };
    const restore = () => {
      io.stdin.off("data", onData);
      process.off("SIGWINCH", onResize);
      if (io.stdin.isTTY) io.stdin.setRawMode(false);
      io.stdin.pause();
    };
    ws.onopen = () => {
      opened = true;
      io.stdin.setRawMode(true);
      io.stdin.resume();
      io.stdin.on("data", onData);
      process.on("SIGWINCH", onResize);
    };
    ws.onmessage = (ev) => {
      io.stdout.write(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = (ev) => {
      restore();
      if (!opened) {
        io.stderr.write(
          `Failed: the shell websocket was refused (${ev.code}) — fix: cf-opencode logs ${t.id}\n`,
        );
        resolve(1);
        return;
      }
      const exited = /^exit 0$/.test(ev.reason);
      io.stderr.write(
        exited
          ? `\r\n[tmux session ${session} detached or ended]\r\n`
          : `\r\n[disconnected; tmux session ${session} keeps running. Reattach: cf-opencode shell ${t.id}]\r\n`,
      );
      resolve(0);
    };
    ws.onerror = () => {
      // onclose follows with the code
    };
  });
}

/** ssh ProxyCommand: stdin/stdout to `sshd -i` in the workspace. */
export async function sshProxy(t: Target, publicKey: string | undefined): Promise<number> {
  const headers: Record<string, string> = { authorization: basic(t.password) };
  if (publicKey) headers["x-cf-opencode-ssh-key"] = publicKey;
  await wake(t, (l) => process.stderr.write(`cf-opencode: ${l}\n`));
  const ws = new WebSocket(wsUrl(t.url, `/ssh/${encodeURIComponent(t.id)}`), {
    headers,
  } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  const queued: Buffer[] = [];
  process.stdin.on("data", (b: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(b);
    else queued.push(b);
  });
  process.stdin.on("end", () => ws.close());
  return new Promise((resolve) => {
    let opened = false;
    ws.onopen = () => {
      opened = true;
      for (const b of queued.splice(0)) ws.send(b);
    };
    ws.onmessage = (ev) => {
      process.stdout.write(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = (ev) => {
      if (!opened)
        process.stderr.write(
          `Failed: the ssh websocket was refused (${ev.code}) — fix: cf-opencode logs ${t.id}\n`,
        );
      resolve(opened ? 0 : 1);
    };
    ws.onerror = () => {};
  });
}

/** The key cf-opencode installs in workspaces. Made once, mode 600, no passphrase. */
export function sshKey(): { path: string; publicKey: string } {
  const dir = join(stateDir(), "ssh");
  const path = join(dir, "id_ed25519");
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "cf-opencode", "-f", path], {
        stdio: "ignore",
      });
    } catch {
      throw new CliError("ssh-keygen failed", "install OpenSSH (ssh and ssh-keygen) and retry");
    }
  }
  return { path, publicKey: readFileSync(`${path}.pub`, "utf8").trim() };
}

/** The CLI itself, as a command ssh can run for ProxyCommand. */
function selfCommand(): string {
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cf-opencode.js");
  return `"${process.execPath}" "${bin}"`;
}

/** ssh options for workspace `id`, as `Key value` pairs. One source for `ssh` and `ssh-config`. */
export function sshOptions(id: string, keyPath: string, url?: string): [string, string][] {
  const urlFlag = url ? ` --url "${url}"` : "";
  return [
    ["HostName", `cf-opencode-${id}`],
    ["User", "user"],
    ["IdentityFile", keyPath],
    ["IdentitiesOnly", "yes"],
    ["ProxyCommand", `${selfCommand()} ssh-proxy ${id}${urlFlag}`],
    // The transport is TLS to your own Worker plus the workspace password. The host key is
    // made on first use and kept on the workspace disk, so it changes only after a re-image.
    ["HostKeyAlias", `cf-opencode-${id}`],
    ["UserKnownHostsFile", join(stateDir(), "ssh", "known_hosts")],
    ["StrictHostKeyChecking", "accept-new"],
    // Plain names in our own known_hosts file, so forgetHostKey can find a workspace's line.
    ["HashKnownHosts", "no"],
    ["ServerAliveInterval", "30"],
  ];
}

/** A Host block for ~/.ssh/config, so `ssh cf-opencode-<id>` and herdr work unchanged. */
export function sshConfigBlock(id: string, keyPath: string, url?: string): string {
  return [`Host cf-opencode-${id}`, ...sshOptions(id, keyPath, url).map(([k, v]) => `  ${k} ${v}`)].join(
    "\n",
  );
}

/** Run the system ssh against the workspace. Extra args go to ssh after the host. */
export function ssh(id: string, extra: string[], url?: string): Promise<number> {
  const { path } = sshKey();
  const opts = sshOptions(id, path, url).flatMap(([k, v]) => ["-o", `${k}=${v}`]);
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...opts, `cf-opencode-${id}`, ...extra], { stdio: "inherit" });
    child.on("error", () => reject(new CliError("ssh is not installed here", "install OpenSSH and retry")));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Drop the workspace's SSH host key from this machine's known_hosts. A workspace that boots from the bare
 * image makes a new host key, and ssh would refuse it as a changed host. The control plane says when that
 * happened (a delete, or a first boot), so the old key is known to be gone.
 */
export function forgetHostKey(id: string, file = join(stateDir(), "ssh", "known_hosts")): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const alias = `cf-opencode-${id}`;
  const lines = text.split("\n");
  const kept = lines.filter((l) => !l.split(/\s+/)[0]?.split(",").includes(alias));
  if (kept.length === lines.length) return false;
  writeFileSync(file, kept.join("\n"), { mode: 0o600 });
  return true;
}
