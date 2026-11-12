// cf-opencode connect: wake or create a workspace, then hand the local OpenCode a server URL.
//
// The password is derived from the control token (config.ts derivePassword), written to a mode-600 file, and
// sent in the spawn body.
// It is never printed. OpenCode 2.2's client reads OPENCODE_PASSWORD; the container's
// `opencode serve` reads OPENCODE_SERVER_PASSWORD. attach() sets both.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient } from "./api.js";
import {
  derivePassword,
  readWorkspace,
  stateDir,
  type WorkspaceLocal,
  writeSecret,
  writeWorkspace,
} from "./config.js";
import { CliError } from "./errors.js";
import { forgetHostKey } from "./terminal.js";

export interface ConnectInput {
  url: string;
  token: string;
  /** Workspace id. Default: the git repo name, else "workspace". */
  id?: string;
  directory?: string;
  repoUrl?: string;
  branch?: string;
  /** Attach the local OpenCode TUI. Default true. */
  attach?: boolean;
  /** Open the workspace's last session. */
  continueLast?: boolean;
  /** Open this session in the workspace. */
  session?: string;
  onLine?: (line: string) => void;
  /** Runs when the workspace is up, before the client opens: copy skills, for example. */
  beforeAttach?: (id: string) => Promise<void>;
}

export interface ConnectResult {
  workspace: WorkspaceLocal;
  /** URL the local OpenCode client connects to. Carries no secret. */
  serverUrl: string;
  username: "opencode";
}

/** The error a request gets when a deploy replaces the Durable Object under it. */
export function restartedByDeploy(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e ?? "");
  return /Durable Object instance is no longer active|Durable Object reset because its code was updated/i.test(
    m,
  );
}

export async function connect(input: ConnectInput): Promise<ConnectResult> {
  const id = input.id ?? workspaceIdFrom(input.directory ?? process.cwd());
  const existing = readWorkspace(id);
  const passwordFile = existing?.passwordFile ?? join(stateDir(), "workspaces", `${id}.password`);
  // Derived, so a second machine with the control token gets the same password instead of a new one, which
  // would restart opencode serve and lock out the first. A random password from before derivation is replaced
  // once; opencode serve restarts with the new one on this spawn.
  const password = derivePassword(input.token, id);
  const saved = readIfExists(passwordFile);
  if (saved !== password) {
    if (saved)
      input.onLine?.(`workspace password is now derived from the control token; opencode restarts once`);
    writeSecret(passwordFile, password);
  }

  const directory = input.directory ?? existing?.directory ?? "/home/user/project";
  const repoUrl = input.repoUrl ?? existing?.repoUrl ?? gitRemote(input.directory ?? process.cwd());
  const branch = input.branch ?? existing?.branch ?? gitBranch(input.directory ?? process.cwd());
  const snapshotId = existing?.snapshotId ?? `snap-${id}`;
  const gitName = gitConfig(input.directory ?? process.cwd(), "user.name");
  const gitEmail = gitConfig(input.directory ?? process.cwd(), "user.email");

  const client = new ControlClient(input.url, input.token);
  // Say it before the clone, not after it fails.
  if (repoUrl && /github\.com/i.test(repoUrl) && !existing) {
    const github = await client
      .installStatus()
      .then((s) => s.bindings?.github)
      .catch(() => undefined);
    if (github === false)
      input.onLine?.(
        "! no GitHub token on the Worker: a private repository will not clone, and push will fail — fix: gh auth token | cf-opencode git-token",
      );
  }
  const spawn = async () => {
    const { opId } = await client.submit(id, {
      op: "spawn",
      password,
      directory,
      snapshotId,
      ...(repoUrl ? { repoUrl } : {}),
      ...(branch ? { branch } : {}),
      ...(gitName ? { gitName } : {}),
      ...(gitEmail ? { gitEmail } : {}),
    });
    return client.wait(opId, input.onLine ?? (() => {}));
  };
  // A deploy restarts the workspace's Durable Object; the request in flight fails once. Try again.
  let op = await spawn().catch((e: unknown) => {
    if (!restartedByDeploy(e)) throw e;
    return undefined;
  });
  if (!op || (op.phase === "failed" && restartedByDeploy(op.error))) {
    input.onLine?.("the Worker restarted (a deploy); trying once more");
    op = await spawn();
  }
  if (op.phase === "failed") throw new CliError(op.error ?? "spawn failed", `cf-opencode logs ${id}`);
  // A boot from the bare image has a new SSH host key; the one this machine remembers is gone.
  if (op.result?.source === "image") forgetHostKey(id);

  const workspace: WorkspaceLocal = {
    id,
    url: input.url,
    username: "opencode",
    passwordFile,
    directory,
    ...(repoUrl ? { repoUrl } : {}),
    ...(branch ? { branch } : {}),
    snapshotId,
  };
  writeWorkspace(workspace);
  const serverUrl = `${input.url}/oc/${encodeURIComponent(id)}`;
  await input.beforeAttach?.(id);
  if (input.attach !== false) {
    await attach(serverUrl, password, input.directory ?? process.cwd(), attachArgs(serverUrl, input));
    // OpenCode prints "Continue  opencode -s <id>" on exit. That command starts a local session, not this one.
    input.onLine?.("");
    input.onLine?.(`This session is in the workspace. To continue it: cf-opencode connect ${id} --continue`);
    input.onLine?.(
      `A session by id (the ses_… above):               cf-opencode connect ${id} --session <id>`,
    );
  }
  return { workspace, serverUrl, username: "opencode" };
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function workspaceIdFrom(dir: string): string {
  const name = dir.split("/").filter(Boolean).pop() ?? "workspace";
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 64);
  return /^[a-z0-9]/.test(clean) ? clean : `w-${clean}`;
}

function gitRemote(dir: string): string | undefined {
  try {
    return httpsRemote(
      execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return undefined;
  }
}

/**
 * The workspace clones over HTTPS, where the Worker adds the GitHub token; it has no SSH key. An SSH remote
 * (git@host:owner/repo.git, ssh://git@host/owner/repo) becomes the same repository's HTTPS URL.
 */
export function httpsRemote(url: string): string | undefined {
  if (/^https?:\/\//.test(url)) return url;
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(url);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const ssh = /^ssh:\/\/(?:[\w.-]+@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return undefined;
}

function gitConfig(dir: string, key: string): string | undefined {
  try {
    return (
      execFileSync("git", ["-C", dir, "config", key], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function gitBranch(dir: string): string | undefined {
  try {
    const b = execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return b && b !== "HEAD" ? b : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run the local OpenCode 2 client against the workspace. Resolves with its exit code.
 * OpenCode 2.2 reads OPENCODE_PASSWORD for the basic-auth password of a --server URL.
 * OPENCODE_SERVER_PASSWORD is what the container's `opencode serve` reads; both are set
 * so one env works on either side.
 */
/** Arguments for the local OpenCode client: the workspace's server, and which session to open. */
export function attachArgs(
  serverUrl: string,
  o: { continueLast?: boolean; session?: string } = {},
): string[] {
  return [
    "--server",
    serverUrl,
    ...(o.session ? ["--session", o.session] : o.continueLast ? ["--continue"] : []),
  ];
}

export function attach(
  serverUrl: string,
  password: string,
  cwd: string,
  args: string[] = attachArgs(serverUrl),
): Promise<number> {
  const bin = localOpencode();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        OPENCODE_PASSWORD: password,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_USERNAME: "opencode",
      },
    });
    child.on("error", (e) =>
      reject(new CliError(e.message, "install OpenCode 2: curl -fsSL https://opencode.ai/v2/install | bash")),
    );
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

function localOpencode(): string {
  for (const bin of ["opencode", "opencode2"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {
      // try the next name
    }
  }
  throw new CliError("OpenCode is not installed here", "curl -fsSL https://opencode.ai/v2/install | bash");
}
