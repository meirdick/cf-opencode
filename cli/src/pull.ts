// `cf-opencode tasks <session> --pull`: bring the branch a task pushed into the local checkout.
//
// A fetch, and a local branch that tracks the task's branch. The working tree and the branch checked out here
// do not change, except for a fast-forward of the checked-out branch when the tree has no changes, which git
// itself refuses when it would overwrite a file. Everything else stops with a Failed line and the git to run.
import { execFileSync } from "node:child_process";
import type { TaskResult } from "./api.js";
import { httpsRemote } from "./connect.js";
import { CliError } from "./errors.js";

export interface PullResult {
  branch: string;
  /** The commit of origin/<branch> after the fetch. */
  commit: string;
  /** created: a new local branch; updated: a fast-forward; current: it had the commit already. */
  local: "created" | "updated" | "current";
  /** True when the branch is the one checked out here. */
  checkedOut: boolean;
}

function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60_000,
    }).trimEnd();
  } catch {
    return undefined;
  }
}

/** One repository, however its URL is written: host and path, no .git, no trailing slash, lower case. */
export function sameRepo(a: string, b: string): boolean {
  const norm = (u: string) =>
    (httpsRemote(u) ?? u)
      .replace(/^https?:\/\/(?:[^@/]+@)?/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Fetch the task's branch from origin into the checkout `dir`. `repoUrl` is the workspace's repository, when
 * this machine knows it: a checkout of another repository is refused.
 */
export function pullTask(
  dir: string,
  r: Pick<TaskResult, "id" | "workspace" | "state" | "branch" | "commits" | "unpushed">,
  repoUrl?: string,
): PullResult {
  const ref = `${r.id} --workspace ${r.workspace}`;
  if (r.commits !== undefined && r.commits.length === 0)
    throw new CliError(
      `task ${r.id} made no commit, so there is nothing to pull`,
      `read its result: cf-opencode tasks ${ref}`,
    );
  if (!r.branch)
    throw new CliError(
      `task ${r.id} has no branch yet${r.state === "running" ? "; it still runs" : ""}`,
      r.state === "running"
        ? `wait for it: cf-opencode tasks ${ref} --wait, then pull again`
        : `ask it to push a branch: cf-opencode tasks ${ref} --reply "Push your work to a new branch on origin."`,
    );
  const branch = r.branch;
  // The name comes from the workspace, where the agent is root: check it before git sees it.
  if (
    branch.startsWith("-") ||
    /[\s~^:?*[\\]/.test(branch) ||
    git(dir, ["check-ref-format", "--branch", branch]) === undefined
  )
    throw new CliError(`task ${r.id} names a branch git refuses`, `read it: cf-opencode tasks ${ref}`);
  if ((r.unpushed ?? 0) > 0)
    throw new CliError(
      `task ${r.id} has ${r.unpushed} commit${r.unpushed === 1 ? "" : "s"} on branch ${branch} that are only on the workspace disk`,
      `ask it to push: cf-opencode tasks ${ref} --reply "Push branch ${branch} to origin.", then pull again`,
    );
  if (git(dir, ["rev-parse", "--is-inside-work-tree"]) !== "true")
    throw new CliError(`${dir} is not a git checkout`, "run it in your checkout of the task's repository");
  const origin = git(dir, ["remote", "get-url", "origin"]);
  if (!origin)
    throw new CliError(
      `the checkout ${dir} has no remote origin`,
      "run it in your checkout of the task's repository",
    );
  if (repoUrl && !sameRepo(origin, repoUrl))
    throw new CliError(
      `the checkout ${dir} is not of the task's repository ${repoUrl}`,
      "run it in your checkout of that repository",
    );
  if (
    git(dir, ["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]) === undefined
  )
    throw new CliError(
      `git could not fetch branch ${branch} from origin; it is not there, or origin did not answer`,
      `check the network; if the task did not push: cf-opencode tasks ${ref} --reply "Push branch ${branch} to origin."`,
    );
  const remote = git(dir, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}^{commit}`]) ?? "";
  const local = git(dir, ["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`]);
  const current = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]) === branch;
  const done = (l: PullResult["local"]): PullResult => ({
    branch,
    commit: remote,
    local: l,
    checkedOut: current,
  });
  if (!local) {
    if (git(dir, ["branch", "--quiet", "--track", branch, `refs/remotes/origin/${branch}`]) === undefined)
      throw new CliError(
        `git could not make the local branch ${branch}`,
        `git branch --track ${branch} origin/${branch}`,
      );
    return done("created");
  }
  const isAncestor = (a: string, b: string) => git(dir, ["merge-base", "--is-ancestor", a, b]) !== undefined;
  if (local === remote || isAncestor(remote, local)) return done("current");
  if (!isAncestor(local, remote))
    throw new CliError(
      `the local branch ${branch} and origin/${branch} both have commits the other does not have; origin/${branch} is fetched, and ${branch} stays as it was`,
      `merge them yourself: git switch ${branch}, then git merge origin/${branch}`,
    );
  if (!current) {
    // A fast-forward of a branch that is not checked out changes no file.
    if (git(dir, ["update-ref", `refs/heads/${branch}`, remote, local]) === undefined)
      throw new CliError(
        `git could not move the local branch ${branch}`,
        `git fetch origin ${branch}:${branch}`,
      );
    return done("updated");
  }
  const changes = git(dir, ["status", "--porcelain", "--untracked-files=no"]);
  if (changes !== "")
    throw new CliError(
      `${branch} is checked out here with changes not committed, so it stays as it was; origin/${branch} is fetched`,
      `commit or stash your changes, then git merge --ff-only origin/${branch}`,
    );
  if (git(dir, ["merge", "--ff-only", "-q", `refs/remotes/origin/${branch}`]) === undefined)
    throw new CliError(
      `git refused to fast-forward ${branch}; origin/${branch} is fetched`,
      `git merge --ff-only origin/${branch}, and read what git says`,
    );
  return done("updated");
}

/** The line `tasks <session> --pull` prints. */
export function renderPull(p: PullResult): string {
  const short = p.commit.slice(0, 7);
  if (p.local === "created")
    return `Fetched origin/${p.branch} (${short}) and made the local branch ${p.branch}, which tracks it. Switch to it: git switch ${p.branch}`;
  if (p.local === "updated")
    return `Fetched origin/${p.branch} (${short}) and fast-forwarded the local branch ${p.branch}.${p.checkedOut ? "" : ` Switch to it: git switch ${p.branch}`}`;
  return `Fetched origin/${p.branch} (${short}). The local branch ${p.branch} has it already.`;
}
