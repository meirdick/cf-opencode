// `cf-opencode run "<task>"`: hand a task to OpenCode in the workspace of this checkout, and return.
//
// The workspace clones from the Git remote; a handoff never sends local files. So a preflight checks that
// the checkout is committed and pushed before anything wakes. The task runs as a new session in the
// workspace's opencode serve, so it goes on after this command exits and after the laptop closes.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ControlClient, RemoteTask } from "./api.js";
import { type ConnectInput, type ConnectResult, workspaceIdFrom } from "./connect.js";
import { CliError } from "./errors.js";
import { schemaInstruction } from "./schema.js";

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

/**
 * Fails, or with allowDirty returns the warning to print. undefined when there is nothing to say.
 * The MCP tool matches the end of the fix text (mcp-tools.ts).
 */
export function checkPreflight(p: Preflight, allowDirty: boolean, dir?: string): string | undefined {
  const problems = preflightProblems(p);
  if (problems.length === 0) return undefined;
  // Say which side: the check reads this machine's checkout, never the workspace.
  const where = dir ? `local checkout ${dir}` : "local checkout";
  if (!allowDirty)
    throw new CliError(
      `${where}: ${problems.join("; ")}; the workspace clones from the Git remote and would not see this`,
      "commit and git push on this machine, or pass --allow-dirty",
    );
  return `! the workspace will not see, from the ${where}: ${problems.join("; ")}`;
}

/** Where `run --branch` starts: the branch tip on origin. */
export interface StartBranch {
  name: string;
  /** The commit origin has for it, when this machine could ask origin or knows it from its last fetch. */
  commit?: string;
}

/**
 * Check that `run --branch <name>` can start: the name is a branch name, and origin has that branch. Asks
 * origin itself (git ls-remote), since the task starts from origin, not from this checkout. When origin does
 * not answer, the remote-tracking branch from the last fetch decides. Changes nothing.
 */
export function checkStartBranch(dir: string, name: string): StartBranch {
  if (
    name.startsWith("-") ||
    /[\s~^:?*[\\]/.test(name) ||
    git(dir, ["check-ref-format", "--branch", name]) === undefined
  )
    throw new CliError(
      `--branch ${JSON.stringify(name)} is not a branch name`,
      "pass a branch name, for example main",
    );
  if (git(dir, ["rev-parse", "--is-inside-work-tree"]) !== "true")
    throw new CliError(`${dir} is not a git checkout`, "run it in a git checkout of the repository");
  if (git(dir, ["remote", "get-url", "origin"]) === undefined)
    throw new CliError(
      `the checkout ${dir} has no remote origin`,
      "git remote add origin <url>, then git push",
    );
  const r = spawnSync(
    "git",
    ["-C", dir, "ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${name}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 },
  );
  const sha = /^([0-9a-f]{40})\s/.exec(r.stdout ?? "")?.[1];
  if (r.status === 0 && sha) return { name, commit: sha };
  // 2: origin answered, and it has no such branch.
  if (r.status === 2)
    throw new CliError(
      `branch ${name} is not on origin, and the workspace starts from origin`,
      `git push -u origin ${name}, or pass --branch with a branch that is on origin`,
    );
  const known = git(dir, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${name}^{commit}`]);
  if (known && /^[0-9a-f]{40}$/.test(known)) return { name, commit: known };
  throw new CliError(
    `origin did not answer, and this checkout does not know branch ${name} from a fetch`,
    "check the network and run git fetch origin, then retry",
  );
}

/**
 * The fixed text after each task. The remote agent has not seen the local conversation, and nobody watches
 * it, so it must leave the work where the user can find it: a pushed branch and a pull request.
 */
export function taskPrompt(
  task: string,
  branch?: string,
  schema?: unknown,
  o: { worktree?: boolean } = {},
): string {
  // A worktree task is at origin/<branch> already (the Worker puts it there), on a detached HEAD.
  const start = o.worktree
    ? [
        `- This session has its own git worktree. It starts at ${branch ? `\`origin/${branch}\`` : "the default branch of origin"} with a detached HEAD. Make a new branch for the work before you commit.`,
      ]
    : branch
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
    "- If you changed files, commit the work. If you are on the default branch, first make a new branch for it. A task with nothing to commit (research, a question) needs no commit.",
    "- Push the branch to origin. Push also when the work is not complete: a commit that is not pushed is only on this machine's disk.",
    "- Do not end your turn while a process you started still runs (a build, an import, a long script). This machine pauses some minutes after your last message, and the pause stops every process.",
    "- For a job longer than a few minutes, run it with `cf-opencode-job start -- <command>`, then end your turn. You get a message when it ends; then do the steps above. If `cf-opencode-job` does not exist, wait for the process in your turn: check it in a loop with `sleep`.",
    "- If `gh auth status` succeeds, open a pull request for the branch, or update the open one.",
    "- End your last message with one line: `Result: <what changed>; branch <name>; pull request <URL or none>`.",
    ...(schema === undefined ? [] : schemaInstruction(schema)),
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
  /** JSON Schema subset the last message must end with (readSchema). */
  schema?: unknown;
  allowDirty?: boolean;
  /** Start from this branch as it is on origin, in place of the checkout's branch. */
  branch?: string;
  /** The remote agent runs with no permission prompts. */
  auto?: boolean;
  /** Start in a new workspace, named <checkout>-<short id>. */
  newWorkspace?: boolean;
  /** Start in a new git worktree in the workspace. */
  worktree?: boolean;
  /** The local checkout. Default: the current directory. */
  dir?: string;
  /** Who hands the task off. The session is told (default cli). */
  origin?: "cli" | "mcp";
  /** Passed to connect: runs when the workspace is up, before the task starts. */
  beforeAttach?: ConnectInput["beforeAttach"];
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
  /** True when --new made the workspace for this task. */
  newWorkspace?: boolean;
}

/** The workspace id for `run --new`: the checkout's id and a short random part. */
export function newWorkspaceId(dir: string, short = randomBytes(3).toString("hex")): string {
  return `${workspaceIdFrom(dir).slice(0, 100)}-${short}`;
}

/** The refusal of the running-workspace limit, said for --new, which needs one more workspace. */
export function maxRunningForNew(e: unknown): unknown {
  const m = e instanceof Error ? /(\d+)\/(\d+) workspaces already running/.exec(e.message) : null;
  if (!m) return e;
  return new CliError(
    `--new needs one more running workspace, and ${m[1]} of ${m[2]} run already (the maxRunning limit)`,
    "pause an idle workspace (cf-opencode pause <workspace>), run without --new, or raise maxRunning in ~/.cf-opencode/config.json and run cf-opencode upgrade",
  );
}

/** Preflight, wake the workspace, start the session. Returns as soon as OpenCode has the prompt. */
export async function runTask(input: RunInput, deps: RunDeps): Promise<RunResult> {
  if (!input.task.trim()) throw new CliError("the task is empty", 'cf-opencode run "<task>"');
  if (input.newWorkspace && input.worktree)
    throw new CliError("--new and --worktree both give the task its own checkout", "pass one of them");
  if (input.newWorkspace && input.id)
    throw new CliError("--new names the workspace itself", "leave out the workspace, or leave out --new");
  const dir = input.dir ?? process.cwd();
  const p = preflight(dir);
  // With --branch the task starts from origin, so only origin matters, not the state of this checkout.
  const start = input.branch !== undefined ? checkStartBranch(dir, input.branch) : undefined;
  const warning = start ? undefined : checkPreflight(p, input.allowDirty === true, dir);
  if (warning) input.onLine?.(warning);
  const id = input.newWorkspace ? newWorkspaceId(dir) : input.id;
  if (input.newWorkspace) input.onLine?.(`making the new workspace ${id} for this task`);
  const branch = start?.name ?? p.branch;
  const woke = await deps
    .connect({
      url: input.url,
      token: input.token,
      ...(id ? { id } : {}),
      // A new workspace clones the start branch.
      ...(input.newWorkspace && branch ? { branch } : {}),
      attach: false,
      ...(input.beforeAttach ? { beforeAttach: input.beforeAttach } : {}),
      ...(input.onLine ? { onLine: input.onLine } : {}),
    })
    .catch((e: unknown) => {
      throw input.newWorkspace ? maxRunningForNew(e) : e;
    });
  const wid = woke.workspace.id;
  const commit = start
    ? start.commit
    : p.checkout
      ? git(dir, ["rev-parse", "--verify", "-q", "HEAD"])
      : undefined;
  const { task } = await deps.client(input.url, input.token).startTask(wid, {
    text: taskPrompt(input.task, branch, input.schema, { worktree: input.worktree === true }),
    ...(input.title ? { title: input.title } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.schema !== undefined ? { schema: input.schema } : {}),
    ...(input.auto ? { auto: true } : {}),
    ...(input.worktree ? { worktree: true } : {}),
    // The session is told where it came from and that nobody is attached (worker task-context.ts).
    handoff: {
      origin: input.origin ?? "cli",
      ...(branch ? { branch } : {}),
      ...(commit && /^[0-9a-f]{40}$/.test(commit) ? { commit } : {}),
      dirty: Boolean(warning),
    },
  });
  return {
    workspace: wid,
    task,
    ...(warning ? { warning } : {}),
    ...(input.newWorkspace ? { newWorkspace: true } : {}),
  };
}

/** The lines `run` prints on success. */
export function renderStarted(r: RunResult): string {
  const ref = `${r.task.id} --workspace ${r.workspace}`;
  return [
    `Started ${r.task.id} in ${r.workspace}${r.task.worktree ? ` (worktree ${r.task.worktree})` : ""}: ${r.task.title}`,
    ...(r.newWorkspace
      ? [
          `New:    ${r.workspace} is a new workspace for this task. It pauses when idle, like any other. Remove it: cf-opencode delete ${r.workspace}`,
        ]
      : []),
    `Status: cf-opencode tasks ${ref}`,
    `Wait:   cf-opencode tasks ${ref} --wait`,
    `Follow: cf-opencode tasks ${ref} --follow`,
    `Open:   cf-opencode connect ${r.workspace} --session ${r.task.id}`,
  ].join("\n");
}
