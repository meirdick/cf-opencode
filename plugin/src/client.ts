// Talks to the user's own cf-opencode Worker. No third-party host, no shared credential.
import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export interface WorkspaceTarget {
  id: string;
  /** URL the local OpenCode client attaches to. No secret in it. */
  url: string;
  username: "opencode";
  password: string;
}

export interface ControlOptions {
  /** Worker URL, for example https://cf-opencode.<account>.workers.dev. */
  url: string;
  /** Control token. The plugin reads CF_OPENCODE_CONTROL_TOKEN; it never stores the token in OpenCode config. */
  token: string;
  fetch?: typeof fetch;
}

export async function createWorkspace(
  opts: ControlOptions,
  input: { id: string; directory?: string; repoUrl?: string; branch?: string; password: string },
): Promise<WorkspaceTarget> {
  const f = opts.fetch ?? fetch;
  const res = await f(`${opts.url}/v1/workspaces/${encodeURIComponent(input.id)}/ops`, {
    method: "POST",
    headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      op: "spawn",
      password: input.password,
      snapshotId: `snap-${input.id}`,
      ...(input.directory ? { directory: input.directory } : {}),
      ...(input.repoUrl ? { repoUrl: input.repoUrl } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
    }),
  });
  if (!res.ok) throw new Error(await errorOf(res));
  const { opId } = (await res.json()) as { opId: string };
  await waitOp(opts, opId);
  return {
    id: input.id,
    url: `${opts.url}/oc/${encodeURIComponent(input.id)}`,
    username: "opencode",
    password: input.password,
  };
}

async function waitOp(opts: ControlOptions, opId: string): Promise<void> {
  const f = opts.fetch ?? fetch;
  const until = Date.now() + 5 * 60_000;
  while (Date.now() < until) {
    const res = await f(`${opts.url}/v1/ops/${encodeURIComponent(opId)}?wait=20000`, {
      headers: { authorization: `Bearer ${opts.token}` },
    });
    if (!res.ok) throw new Error(await errorOf(res));
    const op = (await res.json()) as { phase: string; error?: string };
    if (op.phase === "succeeded") return;
    if (op.phase === "failed") throw new Error(op.error ?? "spawn failed");
  }
  throw new Error("workspace did not become ready in 5 min");
}

async function errorOf(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: string };
    return parsed.error ?? text;
  } catch {
    return text || `HTTP ${res.status}`;
  }
}

/**
 * The workspace password: HMAC of the workspace id under the control token, the same derivation as the CLI
 * and the Worker, so every machine and client with the control token agrees on it. Written to the mode-600
 * file the CLI's shell, ssh and browse read. A file from before derivation is replaced; the next spawn restarts
 * opencode serve once with the derived password.
 */
export function workspacePassword(id: string, controlToken: string, home: string = homedir()): string {
  const password = createHmac("sha256", controlToken)
    .update(`cf-opencode/workspace-password/v1/${id}`)
    .digest("base64url");
  const path = join(home, ".cf-opencode", "workspaces", `${id}.password`);
  let saved: string | undefined;
  try {
    saved = readFileSync(path, "utf8").trim();
  } catch {
    // first use on this machine
  }
  if (saved !== password) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, password, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return password;
}

/** Same rule as the CLI: the directory name, lowercased and scrubbed. */
export function workspaceIdFrom(dir: string): string {
  const name = dir.split("/").filter(Boolean).pop() ?? "workspace";
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 64);
  return /^[a-z0-9]/.test(clean) ? clean : `w-${clean}`;
}

export function basicAuth(password: string): string {
  return `Basic ${btoa(`opencode:${password}`)}`;
}
