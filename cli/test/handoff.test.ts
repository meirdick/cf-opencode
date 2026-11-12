import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ConnectInput, ConnectResult } from "../src/connect.js";
import {
  checkPreflight,
  preflight,
  preflightProblems,
  renderStarted,
  runTask,
  taskPrompt,
} from "../src/handoff.js";

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A bare origin and a clone of it on main, pushed and clean. */
function repo(): { root: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), "cfoc-handoff-"));
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const work = join(root, "app");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "a.txt"), "a\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "first");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "-u", "origin", "main");
  return { root, work };
}

describe.skipIf(process.platform === "win32")("preflight", () => {
  it("passes a clean checkout that is pushed", () => {
    const { work } = repo();
    const p = preflight(work);
    expect(p).toEqual({
      checkout: true,
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      changed: 0,
      untracked: 0,
    });
    expect(checkPreflight(p, false)).toBeUndefined();
  });

  it("skips a directory that is not a git checkout", () => {
    const p = preflight(mkdtempSync(join(tmpdir(), "cfoc-plain-")));
    expect(p.checkout).toBe(false);
    expect(preflightProblems(p)).toEqual([]);
  });

  it("finds changes not committed, untracked files and commits not pushed", () => {
    const { work } = repo();
    writeFileSync(join(work, "a.txt"), "changed\n");
    writeFileSync(join(work, "new1.txt"), "n\n");
    writeFileSync(join(work, "new2.txt"), "n\n");
    expect(preflightProblems(preflight(work))).toEqual([
      "1 file with changes not committed",
      "2 untracked files",
    ]);

    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "second");
    expect(preflightProblems(preflight(work))).toEqual(["1 commit on main not pushed to origin/main"]);
  });

  it("finds a branch with no upstream, and a detached HEAD", () => {
    const { work } = repo();
    git(work, "checkout", "-q", "-b", "feat");
    expect(preflightProblems(preflight(work))).toEqual(["branch feat is not pushed (no upstream)"]);
    git(work, "checkout", "-q", "--detach");
    expect(preflightProblems(preflight(work))).toEqual(["HEAD is not on a branch"]);
  });

  it("fails with one line, or warns with --allow-dirty", () => {
    const { work } = repo();
    writeFileSync(join(work, "new.txt"), "n\n");
    const p = preflight(work);
    expect(() => checkPreflight(p, false)).toThrow(
      /^Failed: 1 untracked file; the workspace clones from the Git remote and would not see this — fix: commit and git push, or pass --allow-dirty$/,
    );
    expect(checkPreflight(p, true)).toBe("! the workspace will not see: 1 untracked file");
  });
});

describe("taskPrompt", () => {
  it("keeps the task first and adds the closing instruction", () => {
    const text = taskPrompt("  Fix the login form.\n", "feat");
    expect(text.startsWith("Fix the login form.\n\n---\n")).toBe(true);
    expect(text).toContain("`origin/feat`");
    expect(text).toContain("- Commit the work.");
    expect(text).toContain("- Push the branch to origin.");
    expect(text).toContain("open a pull request");
    expect(text).toMatch(/one line: `Result: .*`\.$/);
    expect(taskPrompt("x")).not.toContain("Start from branch");
  });
});

describe.skipIf(process.platform === "win32")("runTask", () => {
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
          startTask: async (id: string, body: { text: string; title?: string; model?: string }) => {
            calls.start = { id, body };
            return { task: { id: "ses_1", title: body.title ?? "t", started: 1, state: "running" as const } };
          },
        }),
      },
    };
  }
  const base = { url: "https://cf-opencode.example.workers.dev", token: "tok" };

  it("fails the preflight before it wakes anything", async () => {
    const { work } = repo();
    writeFileSync(join(work, "a.txt"), "changed\n");
    const { calls, deps: d } = deps();
    await expect(runTask({ ...base, task: "do it", dir: work }, d)).rejects.toThrow(
      /^Failed: 1 file with changes/,
    );
    expect(calls.connect).toBeUndefined();
  });

  it("wakes without attaching, then starts the task with the closing instruction", async () => {
    const { work } = repo();
    const { calls, deps: d } = deps();
    const r = await runTask({ ...base, task: "do it", dir: work, title: "Do", model: "a/b" }, d);
    expect(calls.connect?.attach).toBe(false);
    expect(calls.start?.id).toBe("app");
    expect(calls.start?.body).toMatchObject({ title: "Do", model: "a/b" });
    expect(String(calls.start?.body.text)).toMatch(/^do it\n\n---\n[\s\S]*branch `main`/);
    expect(r).toEqual({ workspace: "app", task: { id: "ses_1", title: "Do", started: 1, state: "running" } });
    expect(renderStarted(r)).toContain("cf-opencode tasks ses_1 --workspace app --wait");
  });

  it("with --allow-dirty says what the workspace will not see, and goes on", async () => {
    const { work } = repo();
    git(work, "checkout", "-q", "-b", "feat");
    const lines: string[] = [];
    const { calls, deps: d } = deps();
    const r = await runTask(
      { ...base, task: "do it", dir: work, id: "other", allowDirty: true, onLine: (l) => lines.push(l) },
      d,
    );
    expect(lines[0]).toBe("! the workspace will not see: branch feat is not pushed (no upstream)");
    expect(calls.connect?.id).toBe("other");
    expect(r.warning).toBe(lines[0]);
  });

  it("refuses an empty task", async () => {
    await expect(runTask({ ...base, task: "  " }, deps().deps)).rejects.toThrow(/^Failed: the task is empty/);
  });
});
