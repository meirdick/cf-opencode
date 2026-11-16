// run --branch, --auto, --new and --worktree; tasks --pull; their completion.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ConnectInput, ConnectResult } from "../src/connect.js";
import { CliError } from "../src/errors.js";
import {
  checkStartBranch,
  maxRunningForNew,
  newWorkspaceId,
  renderStarted,
  runTask,
  taskPrompt,
} from "../src/handoff.js";
import { main } from "../src/index.js";
import { pullTask, renderPull, sameRepo } from "../src/pull.js";

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A bare origin with main and feat/a, and a clone of it on main named app. */
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cfoc-iso-")));
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "a.txt"), "a\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "first");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  git(seed, "switch", "-q", "-c", "feat/a");
  git(seed, "commit", "-q", "--allow-empty", "-m", "on feat");
  git(seed, "push", "-q", "origin", "feat/a");
  const work = join(root, "app");
  git(root, "clone", "-q", origin, work);
  return { root, origin, seed, work, feat: git(seed, "rev-parse", "HEAD") };
}

function deps() {
  const calls: { connect?: ConnectInput; start?: { id: string; body: Record<string, unknown> } } = {};
  return {
    calls,
    deps: {
      connect: async (input: ConnectInput): Promise<ConnectResult> => {
        calls.connect = input;
        return {
          workspace: {
            id: input.id ?? "app",
            url: input.url,
            username: "opencode",
            passwordFile: "/x",
            directory: "/home/user/project",
          },
          serverUrl: `${input.url}/oc/app`,
          username: "opencode",
        };
      },
      client: () => ({
        startTask: async (id: string, body: Record<string, unknown>) => {
          calls.start = { id, body };
          return {
            task: {
              id: "ses_1",
              title: "t",
              started: 1,
              state: "running" as const,
              ...(body.worktree ? { worktree: "/home/user/worktrees/brave-fox" } : {}),
            },
          };
        },
      }),
    },
  };
}
const base = { url: "https://cf-opencode.example.workers.dev", token: "tok" };

describe.skipIf(process.platform === "win32")("run --branch", () => {
  it("checks origin for the branch, not the state of this checkout", async () => {
    const r = repo();
    // A dirty tree and a local branch with no upstream do not matter: the task starts from origin.
    writeFileSync(join(r.work, "a.txt"), "changed\n");
    git(r.work, "switch", "-q", "-c", "local-only");
    const { calls, deps: d } = deps();
    const out = await runTask({ ...base, task: "do it", dir: r.work, branch: "feat/a" }, d);
    expect(out.warning).toBeUndefined();
    expect(calls.start?.body.handoff).toEqual({
      origin: "cli",
      branch: "feat/a",
      commit: r.feat,
      dirty: false,
    });
    expect(String(calls.start?.body.text)).toContain("`origin/feat/a`");
  });

  it("fails before the wake when origin has no such branch, or the name is not a branch", async () => {
    const r = repo();
    const { calls, deps: d } = deps();
    await expect(runTask({ ...base, task: "x", dir: r.work, branch: "nope" }, d)).rejects.toThrow(
      /^Failed: branch nope is not on origin, and the workspace starts from origin — fix: git push -u origin nope/,
    );
    await expect(runTask({ ...base, task: "x", dir: r.work, branch: "-x" }, d)).rejects.toThrow(
      /^Failed: --branch "-x" is not a branch name/,
    );
    await expect(runTask({ ...base, task: "x", dir: r.work, branch: "a b" }, d)).rejects.toThrow(
      /is not a branch name/,
    );
    expect(calls.connect).toBeUndefined();
  });

  it("uses the branch from the last fetch when origin does not answer", () => {
    const r = repo();
    git(r.work, "fetch", "-q", "origin");
    git(r.work, "remote", "set-url", "origin", join(r.root, "gone.git"));
    expect(checkStartBranch(r.work, "feat/a")).toEqual({ name: "feat/a", commit: r.feat });
    expect(() => checkStartBranch(r.work, "other")).toThrow(/^Failed: origin did not answer/);
  });
});

describe.skipIf(process.platform === "win32")("run --auto, --worktree and --new", () => {
  it("--auto and --worktree go to the Worker; the prompt says the worktree starts detached", async () => {
    const r = repo();
    const { calls, deps: d } = deps();
    const out = await runTask({ ...base, task: "x", dir: r.work, auto: true, worktree: true }, d);
    expect(calls.start?.body).toMatchObject({ auto: true, worktree: true });
    expect(String(calls.start?.body.text)).toContain(
      "This session has its own git worktree. It starts at `origin/main` with a detached HEAD.",
    );
    expect(String(calls.start?.body.text)).not.toContain("check out `main`");
    expect(renderStarted(out)).toContain("Started ses_1 in app (worktree /home/user/worktrees/brave-fox)");
    // Without them, nothing is sent about them.
    await runTask({ ...base, task: "x", dir: r.work }, d);
    expect(calls.start?.body).not.toHaveProperty("auto");
    expect(calls.start?.body).not.toHaveProperty("worktree");
  });

  it("--new makes a workspace named <checkout>-<short id> that clones the start branch", async () => {
    const r = repo();
    const { calls, deps: d } = deps();
    const lines: string[] = [];
    const out = await runTask(
      { ...base, task: "x", dir: r.work, newWorkspace: true, branch: "feat/a", onLine: (l) => lines.push(l) },
      d,
    );
    expect(calls.connect?.id).toMatch(/^app-[0-9a-f]{6}$/);
    expect(calls.connect?.branch).toBe("feat/a");
    expect(calls.start?.id).toBe(calls.connect?.id);
    expect(out.newWorkspace).toBe(true);
    expect(lines).toContain(`making the new workspace ${calls.connect?.id} for this task`);
    expect(renderStarted(out)).toContain(`cf-opencode delete ${out.workspace}`);
    expect(newWorkspaceId("/x/My Repo", "abc123")).toBe("my-repo-abc123");
  });

  it("refuses --new with --worktree, and --new with a workspace id", async () => {
    const r = repo();
    const { calls, deps: d } = deps();
    await expect(
      runTask({ ...base, task: "x", dir: r.work, newWorkspace: true, worktree: true }, d),
    ).rejects.toThrow(/^Failed: --new and --worktree .* — fix: pass one of them$/);
    await expect(
      runTask({ ...base, task: "x", dir: r.work, newWorkspace: true, id: "app" }, d),
    ).rejects.toThrow(/^Failed: --new names the workspace itself/);
    expect(calls.connect).toBeUndefined();
  });

  it("--new names maxRunning when the running limit refuses the new workspace", async () => {
    const r = repo();
    const { deps: d } = deps();
    const cap = new CliError(
      "Failed: 3/3 workspaces already running — fix: pause an idle workspace, or raise maxRunning in ~/.cf-opencode/config.json and run cf-opencode upgrade",
      "x",
    );
    d.connect = async () => {
      throw cap;
    };
    await expect(runTask({ ...base, task: "x", dir: r.work, newWorkspace: true }, d)).rejects.toThrow(
      /^Failed: --new needs one more running workspace, and 3 of 3 run already \(the maxRunning limit\) — fix: .*run without --new, or raise maxRunning/,
    );
    // Without --new the line stays as the Worker said it.
    await expect(runTask({ ...base, task: "x", dir: r.work }, d)).rejects.toBe(cap);
    const other = new Error("boom");
    expect(maxRunningForNew(other)).toBe(other);
  });

  it("the prompt for a worktree with no branch starts at origin's default branch", () => {
    expect(taskPrompt("x", undefined, undefined, { worktree: true })).toContain(
      "It starts at the default branch of origin with a detached HEAD.",
    );
  });
});

describe.skipIf(process.platform === "win32")("tasks --pull", () => {
  /** The workspace side: a second clone that pushes a task branch. */
  function pushed(r: ReturnType<typeof repo>, branch = "task/x") {
    const ws = join(r.root, "ws");
    git(r.root, "clone", "-q", r.origin, ws);
    git(ws, "switch", "-q", "-c", branch);
    git(ws, "commit", "-q", "--allow-empty", "-m", "task work");
    git(ws, "push", "-q", "origin", branch);
    return { ws, sha: git(ws, "rev-parse", "HEAD") };
  }
  const task = (over: Record<string, unknown> = {}) => ({
    id: "ses_1",
    workspace: "app",
    state: "done" as const,
    branch: "task/x",
    commits: [{ sha: "a".repeat(40), subject: "task work" }],
    ...over,
  });

  it("fetches the branch and makes a local branch that tracks it; the checkout does not change", () => {
    const r = repo();
    const { sha } = pushed(r);
    writeFileSync(join(r.work, "a.txt"), "my change\n");
    const p = pullTask(r.work, task());
    expect(p).toEqual({ branch: "task/x", commit: sha, local: "created", checkedOut: false });
    expect(git(r.work, "rev-parse", "task/x")).toBe(sha);
    expect(git(r.work, "rev-parse", "--abbrev-ref", "task/x@{u}")).toBe("origin/task/x");
    expect(git(r.work, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(r.work, "status", "--porcelain")).toBe("M a.txt");
    expect(renderPull(p)).toContain("git switch task/x");
    // Again: it has the commit already.
    expect(pullTask(r.work, task()).local).toBe("current");
  });

  it("fast-forwards a local branch that is behind; the checked-out one only when it has no changes", () => {
    const r = repo();
    pushed(r);
    pullTask(r.work, task());
    const { ws } = { ws: join(r.root, "ws") };
    git(ws, "commit", "-q", "--allow-empty", "-m", "more");
    git(ws, "push", "-q", "origin", "task/x");
    const next = git(ws, "rev-parse", "HEAD");
    expect(pullTask(r.work, task())).toMatchObject({ local: "updated", checkedOut: false });
    expect(git(r.work, "rev-parse", "task/x")).toBe(next);

    git(ws, "commit", "-q", "--allow-empty", "-m", "more again");
    git(ws, "push", "-q", "origin", "task/x");
    git(r.work, "switch", "-q", "task/x");
    writeFileSync(join(r.work, "a.txt"), "dirty\n");
    expect(() => pullTask(r.work, task())).toThrow(
      /^Failed: task\/x is checked out here with changes not committed, so it stays as it was; origin\/task\/x is fetched — fix: commit or stash/,
    );
    expect(git(r.work, "rev-parse", "HEAD")).toBe(next);
    git(r.work, "checkout", "-q", "--", "a.txt");
    expect(pullTask(r.work, task())).toMatchObject({ local: "updated", checkedOut: true });
    expect(git(r.work, "rev-parse", "HEAD")).toBe(git(ws, "rev-parse", "HEAD"));
  });

  it("does not merge a branch that went two ways", () => {
    const r = repo();
    pushed(r);
    pullTask(r.work, task());
    git(r.work, "switch", "-q", "task/x");
    git(r.work, "commit", "-q", "--allow-empty", "-m", "mine");
    const mine = git(r.work, "rev-parse", "HEAD");
    const ws = join(r.root, "ws");
    git(ws, "commit", "-q", "--allow-empty", "-m", "theirs");
    git(ws, "push", "-q", "origin", "task/x");
    expect(() => pullTask(r.work, task())).toThrow(/both have commits .* — fix: merge them yourself/);
    expect(git(r.work, "rev-parse", "HEAD")).toBe(mine);
  });

  it("fails with a fix when there is nothing on origin to pull", () => {
    const r = repo();
    expect(() => pullTask(r.work, task({ commits: [] }))).toThrow(/made no commit/);
    expect(() => pullTask(r.work, task({ branch: undefined }))).toThrow(
      /has no branch yet — fix: ask it to push/,
    );
    expect(() => pullTask(r.work, task({ branch: undefined, state: "running" }))).toThrow(
      /still runs — fix: wait for it/,
    );
    expect(() => pullTask(r.work, task({ unpushed: 2 }))).toThrow(
      /^Failed: task ses_1 has 2 commits on branch task\/x that are only on the workspace disk — fix: ask it to push: cf-opencode tasks ses_1 --workspace app --reply/,
    );
    expect(() => pullTask(r.work, task())).toThrow(/^Failed: git could not fetch branch task\/x from origin/);
    expect(() => pullTask(r.work, task({ branch: "--upload-pack=x" }))).toThrow(/names a branch git refuses/);
    expect(() => pullTask(r.work, task(), "https://github.com/acme/other")).toThrow(
      /is not of the task's repository/,
    );
  });

  it("knows one repository in its URL forms", () => {
    expect(sameRepo("git@github.com:Acme/App.git", "https://github.com/acme/app")).toBe(true);
    expect(sameRepo("https://x@github.com/acme/app/", "https://github.com/acme/app.git")).toBe(true);
    expect(sameRepo("https://github.com/acme/app", "https://github.com/acme/api")).toBe(false);
  });

  it("--pull needs one task and goes alone", async () => {
    let err = "";
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err += String(c);
      return true;
    });
    try {
      const env = { ...process.env };
      process.env.CF_OPENCODE_URL = "https://cf-opencode.example.workers.dev";
      process.env.CF_OPENCODE_CONTROL_TOKEN = "tok";
      try {
        expect(await main(["tasks", "--pull"])).not.toBe(0);
        expect(await main(["tasks", "ses_1", "--pull", "--wait"])).not.toBe(0);
      } finally {
        process.env = env;
      }
    } finally {
      spy.mockRestore();
    }
    expect(err).toContain("Failed: --pull needs one task — fix: cf-opencode tasks <session> --pull");
    expect(err).toContain("Failed: --pull goes alone");
  });
});

describe("completion of the new flags", () => {
  it("offers them for run and tasks", async () => {
    let text = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      text += String(c);
      return true;
    });
    try {
      await main(["__complete", "--", "run", "--"]);
      await main(["__complete", "--", "tasks", "--p"]);
    } finally {
      spy.mockRestore();
    }
    for (const f of ["--auto", "--branch", "--new", "--worktree", "--pull"]) expect(text).toContain(`${f}\n`);
  });
});
