// `cf-opencode run "<task>"`: hand a task to OpenCode in the workspace of this checkout, and return.
//
// The workspace clones from the Git remote; a handoff never sends local files. So a preflight checks that
// the checkout is committed and pushed before anything wakes. The task runs as a new session in the
// workspace's opencode serve, so it goes on after this command exits and after the laptop closes.
import { execFileSync } from "node:child_process";
import type { ControlClient, RemoteTask } from "./api.js";
import type { ConnectInput, ConnectResult } from "./connect.js";
import { CliError } from "./errors.js";

export interface Preflight {
  /** False when the directory is not a git checkout: there is nothing to check. */
  checkout: boolean;
  branch?: string;
  /** The upstream, as origin/<branch>. */
  upstream?: string;
  /** Commits on HEAD that the upstream does not have. */
  ahead: number;
  /** Files with changes not committed, and files git does not track. */
  changed: number;
  untracked: number;
}

function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trimEnd();
  } catch {
    return undefined;
  }
}

/** Read the checkout. Changes nothing, and does not fetch: the upstream is as this machine last saw it. */
export function preflight(dir: string): Preflight {
  if (git(dir, ["rev-parse", "--is-inside-work-tree"]) !== "true")
    return { checkout: false, ahead: 0, changed: 0, untracked: 0 };
  const branch = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || undefined;
  const upstream = branch
    ? git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) || undefined
    : undefined;
  const ahead = upstream ? Number(git(dir, ["rev-list", "--count", "@{u}..HEAD"]) ?? "0") || 0 : 0;
  const status = (git(dir, ["status", "--porcelain"]) ?? "").split("\n").filter(Boolean);
  const untracked = status.filter((l) => l.startsWith("??")).length;
  return {
    checkout: true,
    ...(branch ? { branch } : {}),
    ...(upstream ? { upstream } : {}),
    ahead,
    changed: status.length - untracked,
    untracked,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the workspace will not see, one short phrase each. Empty when the checkout is all on the remote. */
export function preflightProblems(p: Preflight): string[] {
  if (!p.checkout) return [];
  const out: string[] = [];
  if (!p.branch) out.push("HEAD is not on a branch");
  else if (!p.upstream) out.push(`branch ${p.branch} is not pushed (no upstream)`);
  else if (p.ahead > 0) out.push(`${plural(p.ahead, "commit")} on ${p.branch} not pushed to ${p.upstream}`);
  if (p.changed > 0) out.push(`${plural(p.changed, "file")} with changes not committed`);
  if (p.untracked > 0) out.push(`${plural(p.untracked, "untracked file")}`);
  return out;
}

/** Fails, or with allowDirty returns the warning to print. undefined when there is nothing to say. */
export function checkPreflight(p: Preflight, allowDirty: boolean): string | undefined {
  const problems = preflightProblems(p);
  if (problems.length === 0) return undefined;
  if (!allowDirty)
    throw new CliError(
      `${problems.join("; ")}; the workspace clones from the Git remote and would not see this`,
      "commit and git push, or pass --allow-dirty",
    );
  return `! the workspace will not see: ${problems.join("; ")}`;
}

/**
 * The fixed text after each task. The remote agent has not seen the local conversation, and nobody watches
 * it, so it must leave the work where the user can find it: a pushed branch and a pull request.
 */
export function taskPrompt(task: string, branch?: string): string {
  const start = branch
    ? [
        `- Start from branch \`${branch}\` as it is on origin: run \`git fetch origin\`, check out \`${branch}\`, and fast-forward it to \`origin/${branch}\`.`,
      ]
    : [];
  return [
    task.trim(),
    "",
    "---",
    "This task was handed off with cf-opencode run. Nobody watches this session. When you finish:",
    ...start,
    "- Commit the work. If you are on the default branch, first make a new branch for it.",
    "- Push the branch to origin.",
    "- If `gh auth status` succeeds, open a pull request for the branch, or update the open one.",
    "- End your last message with one line: `Result: <what changed>; branch <name>; pull request <URL or none>`.",
  ].join("\n");
}

export interface RunInput {
  url: string;
  token: string;
  task: string;
  /** Workspace id. Default: the checkout's, as connect picks it. */
  id?: string;
  title?: string;
  model?: string;
  allowDirty?: boolean;
  /** The local checkout. Default: the current directory. */
  dir?: string;
  onLine?: (line: string) => void;
}

export interface RunDeps {
  connect: (input: ConnectInput) => Promise<ConnectResult>;
  client: (url: string, token: string) => Pick<ControlClient, "startTask">;
}

export interface RunResult {
  workspace: string;
  task: RemoteTask;
  /** What the workspace will not see, when --allow-dirty skipped the check. */
  warning?: string;
}

/** Preflight, wake the workspace, start the session. Returns as soon as OpenCode has the prompt. */
export async function runTask(input: RunInput, deps: RunDeps): Promise<RunResult> {
  if (!input.task.trim()) throw new CliError("the task is empty", 'cf-opencode run "<task>"');
  const dir = input.dir ?? process.cwd();
  const p = preflight(dir);
  const warning = checkPreflight(p, input.allowDirty === true);
  if (warning) input.onLine?.(warning);
  const woke = await deps.connect({
    url: input.url,
    token: input.token,
    ...(input.id ? { id: input.id } : {}),
    attach: false,
    ...(input.onLine ? { onLine: input.onLine } : {}),
  });
  const id = woke.workspace.id;
  const { task } = await deps.client(input.url, input.token).startTask(id, {
    text: taskPrompt(input.task, p.branch),
    ...(input.title ? { title: input.title } : {}),
    ...(input.model ? { model: input.model } : {}),
  });
  return { workspace: id, task, ...(warning ? { warning } : {}) };
}

/** The lines `run` prints on success. */
export function renderStarted(r: RunResult): string {
  const ref = `${r.task.id} --workspace ${r.workspace}`;
  return [
    `Started ${r.task.id} in ${r.workspace}: ${r.task.title}`,
    `Status: cf-opencode tasks ${ref}`,
    `Wait:   cf-opencode tasks ${ref} --wait`,
    `Open:   cf-opencode connect ${r.workspace} --session ${r.task.id}`,
  ].join("\n");
}
