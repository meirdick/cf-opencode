// Local install state. Nothing here is a secret except the files named *-token and the password file.
import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface InstallState {
  url: string;
  /** Worker name, default cf-opencode. */
  name: string;
  accountId?: string;
}

export interface WorkspaceLocal {
  id: string;
  url: string;
  username: string;
  /** Path of the password file, mode 600. The password is not in this record. */
  passwordFile: string;
  directory: string;
  repoUrl?: string;
  branch?: string;
  snapshotId?: string;
}

/** Read on every call, not at import: a test that points HOME elsewhere must not touch the real state. */
export function stateDir(): string {
  return join(homedir(), ".cf-opencode");
}

export function installPath(): string {
  return join(stateDir(), "install.json");
}

export function readInstall(): InstallState | undefined {
  try {
    return JSON.parse(readFileSync(installPath(), "utf8")) as InstallState;
  } catch {
    return undefined;
  }
}

export function writeInstall(s: InstallState): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(installPath(), `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
}

export function controlTokenPath(): string {
  return join(stateDir(), "control-token");
}

export function readControlToken(): string | undefined {
  try {
    const t = readFileSync(controlTokenPath(), "utf8").trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

export function writeSecret(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function workspacePath(id: string): string {
  return join(stateDir(), "workspaces", `${id}.json`);
}

export function readWorkspace(id: string): WorkspaceLocal | undefined {
  try {
    return JSON.parse(readFileSync(workspacePath(id), "utf8")) as WorkspaceLocal;
  } catch {
    return undefined;
  }
}

export function writeWorkspace(w: WorkspaceLocal): void {
  mkdirSync(join(stateDir(), "workspaces"), { recursive: true });
  writeFileSync(workspacePath(w.id), `${JSON.stringify(w, null, 2)}\n`, { mode: 0o600 });
}

export function readPassword(w: WorkspaceLocal): string {
  return readFileSync(w.passwordFile, "utf8").trim();
}

/**
 * The workspace password: HMAC-SHA256 of the workspace id under the control token, base64url. The Worker
 * (worker/src/auth.ts workspacePassword) and the plugin derive the same value, so every machine with the
 * control token agrees on it, and the Worker can ask the workspace whether an agent is busy.
 */
export function derivePassword(controlToken: string, id: string): string {
  return createHmac("sha256", controlToken)
    .update(`cf-opencode/workspace-password/v1/${id}`)
    .digest("base64url");
}
