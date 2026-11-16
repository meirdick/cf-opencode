import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RemoteTasks, TaskResult } from "../src/api.js";
import { taskPrompt } from "../src/handoff.js";
import { NOTIFY_KEY_LABEL, notifyKey, signature } from "../src/notify-key.js";
import { readSchema, schemaProblem } from "../src/schema.js";
import { installSkill, SKILL_NAME, skillFile, skillsRoot, skillTarget } from "../src/skill.js";
import { renderResult, resultOf } from "../src/task-result.js";
import { listTasks, onlyUnseen, renderTasks } from "../src/tasks.js";

const now = Date.parse("2026-11-12T12:00:00Z");
const base: TaskResult = {
  id: "ses_1",
  workspace: "app",
  state: "done",
  title: "Fix login",
  summary:
    "Fixed it.\nResult: login works; branch fix-login; pull request https://github.com/acme/app/pull/7",
  started: "2026-11-12T11:40:00Z",
  updated: "2026-11-12T11:55:00Z",
};

describe("result record", () => {
  it("renders state, then summary, then branch, commits and pull request", () => {
    const r: TaskResult = {
      ...base,
      branch: "fix-login",
      commits: [{ sha: "a".repeat(40), subject: "Fix the login form" }],
      pullRequest: "https://github.com/acme/app/pull/7",
      changedFiles: ["src/login.ts"],
      structured: { ok: true },
      notified: { at: "2026-11-12T11:56:00Z", status: 200 },
    };
    const text = renderResult(r, { live: true, now });
    const at = (s: string) => text.indexOf(s);
    expect(at("State      done")).toBeLessThan(at("Summary:"));
    expect(at("Summary:")).toBeLessThan(at("Branch     fix-login"));
    expect(text).toContain("Commits    1\n  aaaaaaa Fix the login form");
    expect(text).toContain("PR         https://github.com/acme/app/pull/7");
    expect(text).toContain("Changed    src/login.ts");
    expect(text).toContain('Structured {"ok":true}');
    expect(text).toContain("Notified   4m ago (HTTP 200)");
    expect(text).toMatch(
      /Open: cf-opencode connect app --session ses_1\nPull: cf-opencode tasks ses_1 --workspace app --pull$/,
    );
    // No commit, or commits only on the workspace disk: nothing to pull.
    expect(renderResult({ ...r, commits: [] })).not.toContain("--pull");
    expect(renderResult({ ...r, unpushed: 1 })).not.toContain("--pull");
    expect(renderResult({ ...r, worktree: "/home/user/worktrees/a" })).toContain(
      "Worktree   /home/user/worktrees/a",
    );
  });

  it("warns about commits that are not pushed and processes left running, with the fix", () => {
    const text = renderResult({ ...base, unpushed: 13, processes: ["node build.js"] }, { now });
    expect(text).toContain("Not pushed ! 13 commits are only on the workspace disk");
    expect(text).toContain("Processes  ! left running, a pause stops them: node build.js");
    expect(text).toContain(
      'cf-opencode tasks ses_1 --reply "Wait for your process to end, then commit and push."',
    );
    const one = renderResult({ ...base, unpushed: 1 }, { now });
    expect(one).toContain("Not pushed ! 1 commit is only on the workspace disk");
    expect(one).toContain('--reply "Push your branch."');
    expect(renderResult(base, { now })).not.toContain("not safe");
    // A running task is not told to push yet.
    expect(renderResult({ ...base, state: "running", unpushed: 2 }, { now })).not.toContain("not safe");

    const list = renderTasks(
      {
        rows: [
          { id: "ses_1", workspace: "app", title: "a", started: now, state: "done", unpushed: 2 },
          { id: "ses_2", workspace: "app", title: "b", started: now, state: "running", unpushed: 2 },
          { id: "ses_3", workspace: "app", title: "c", started: now, state: "done" },
        ],
        workspaces: [{ id: "app", live: true }],
      },
      now,
    );
    expect(list).toMatch(/ses_1\s+done !/);
    expect(list).toMatch(/ses_2\s+running\s/);
    expect(list).toMatch(/ses_3\s+done\s/);
    expect(list).toContain("! ended with commits that are not pushed");
  });

  it("says none for no commits, shows the question of a waiting task and how to continue a stopped one", () => {
    expect(renderResult({ ...base, commits: [] }, { now })).toContain("Commits    none");
    const waiting = renderResult({ ...base, state: "waiting", question: "Permission: allow bash?" }, { now });
    expect(waiting).toContain("Question: Permission: allow bash?\nThe agent waits for an answer.");
    const stopped = renderResult(
      { ...base, state: "stopped", error: "the workspace paused while the task ran" },
      { now },
    );
    expect(stopped).toContain("State      stopped (the workspace paused while the task ran)");
    expect(stopped).toContain("Continue it in OpenCode");
    expect(
      renderResult({ ...base, structuredError: "the last message has no ```json block" }, { now }),
    ).toContain("Structured ! the last message has no ```json block");
  });

  it("builds a record from an old Worker's answer", () => {
    expect(
      resultOf("app", {
        task: { id: "ses_1", title: "t", started: 0, state: "failed", reason: "x", last: "y" },
      }),
    ).toEqual({
      id: "ses_1",
      workspace: "app",
      state: "failed",
      title: "t",
      summary: "y",
      error: "x",
      started: "1970-01-01T00:00:00.000Z",
      updated: "1970-01-01T00:00:00.000Z",
    });
  });
});

describe("unseen", () => {
  it("lists tasks that ended and nobody read first, with a marker; --unseen keeps only those", async () => {
    const tasks: RemoteTasks = {
      live: true,
      tasks: [
        { id: "ses_new", title: "new", started: now - 60_000, state: "running" },
        { id: "ses_old", title: "old", started: now - 3600_000, state: "done", unseen: true },
        { id: "ses_read", title: "read", started: now - 120_000, state: "done", unseen: false },
      ],
    };
    const r = await listTasks({ tasks: async () => tasks }, ["app"]);
    expect(r.rows.map((t) => t.id)).toEqual(["ses_old", "ses_new", "ses_read"]);
    const text = renderTasks(r, now);
    expect(text).toMatch(/^\*\s+app\s+ses_old\s+done/m);
    expect(text).toContain("* ended, not read yet. Reading one marks it read.");
    expect(onlyUnseen(r).rows.map((t) => t.id)).toEqual(["ses_old"]);
    expect(renderTasks(onlyUnseen({ ...r, rows: [] }), now, { unseen: true })).toMatch(
      /^No unread results\./,
    );
  });
});

describe("--schema", () => {
  it("accepts the subset and refuses the rest in one Failed line", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfoc-schema-"));
    const good = join(dir, "good.json");
    writeFileSync(
      good,
      JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }),
    );
    expect(readSchema(good)).toMatchObject({ type: "object" });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ type: "object", properties: { n: { type: "number", minimum: 0 } } }));
    expect(() => readSchema(bad)).toThrow(
      /^Failed: .*bad\.json is outside the supported JSON Schema subset \(\$\.properties\.n: keyword minimum is not supported\) — fix: use only type, properties/,
    );
    writeFileSync(bad, "{nope");
    expect(() => readSchema(bad)).toThrow(/is not JSON — fix:/);
    expect(() => readSchema(join(dir, "missing.json"))).toThrow(/cannot read .* \(ENOENT\)/);
    expect(schemaProblem({ additionalProperties: true })).toMatch(/may only be false/);
  });

  it("puts the schema at the end of the closing instruction", () => {
    const text = taskPrompt("find the callers of f", "main", { type: "object" });
    expect(text).toMatch(/After the `Result:` line, end your last message with one fenced ```json block/);
    expect(text.endsWith('```json\n{\n  "type": "object"\n}\n```')).toBe(true);
    expect(taskPrompt("x")).not.toContain("JSON Schema");
  });
});

describe("skill", () => {
  it("ships SKILL.md with a name and a description", () => {
    const text = readFileSync(skillFile(), "utf8");
    expect(text).toMatch(new RegExp(`^---\\nname: ${SKILL_NAME}\\ndescription: .+\\n`));
    expect(text).toContain("cf-opencode run");
  });

  it("installs, leaves an equal copy, and replaces a different one only with --force", () => {
    const home = mkdtempSync(join(tmpdir(), "cfoc-home-"));
    const r1 = installSkill({ kind: "claude" }, { home });
    expect(r1).toEqual({
      path: join(home, ".claude/skills/cf-opencode-handoff/SKILL.md"),
      action: "installed",
    });
    expect(installSkill({ kind: "claude" }, { home }).action).toBe("unchanged");
    writeFileSync(r1.path, "my edits\n");
    expect(() => installSkill({ kind: "claude" }, { home })).toThrow(
      /^Failed: .*SKILL\.md exists and differs from this version — fix: pass --force to replace it$/,
    );
    expect(readFileSync(r1.path, "utf8")).toBe("my edits\n");
    expect(installSkill({ kind: "claude" }, { home, force: true }).action).toBe("replaced");
    expect(skillsRoot({ kind: "opencode" }, home)).toBe(join(home, ".config/opencode/skills"));
    expect(installSkill({ kind: "dir", dir: join(home, "x") }, { home }).path).toBe(
      join(home, "x/cf-opencode-handoff/SKILL.md"),
    );
  });

  it("needs exactly one place", () => {
    expect(() => skillTarget({})).toThrow(/needs one place/);
    expect(() => skillTarget({ claude: true, opencode: true })).toThrow(/needs one place/);
    expect(skillTarget({ dir: "/tmp/s" })).toEqual({ kind: "dir", dir: "/tmp/s" });
  });
});

describe("notify key", () => {
  // The same vector is in worker/test/task-push.test.ts: the CLI and the Worker derive the same key.
  it("matches the Worker's key and signature", () => {
    expect(NOTIFY_KEY_LABEL).toBe("cf-opencode/notify-key/v1");
    expect(notifyKey("control")).toBe("a2a940c5d7f3460159b47cfff72480f41a289ec4f4f367d0cb00c0a9dbe14e93");
    expect(signature("k", "{}", 1794500000)).toBe(
      `sha256=${createHmac("sha256", "k").update("1794500000.{}").digest("hex")}`,
    );
  });
});
