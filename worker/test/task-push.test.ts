// The result record, the git facts, the stopped state, the unseen mark and the notify URL push.
import { execFile, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkNotifyUrl, parseConfig } from "../src/core/config";
import { runPause } from "../src/orb/pause";
import { runSpawn } from "../src/orb/spawn";
import {
  afterFailure,
  deliverDue,
  type FetchFn,
  handleNote,
  NOTIFY_KEY_LABEL,
  notifyKey,
  RETRY_DELAYS_MS,
  taskTick,
} from "../src/orb/task-notify";
import { type TaskResult, taskResult } from "../src/orb/task-result";
import { TASK_GIT_SH, TASK_START_SH, TASK_STATUS_SH } from "../src/orb/task-scripts";
import {
  applyFacts,
  applyStatus,
  parseGitFacts,
  readTask,
  readTasks,
  startTask,
  TASKS_KEY,
  type TaskRecord,
} from "../src/orb/tasks";
import { makeOrbCtx, type OrbHarness } from "./fake-registry";

const SHA = (c: string) => c.repeat(40);
const RECEIVER = "https://hooks.example.com/cf-opencode";
const spawnReq = { op: "spawn" as const, password: "tok-123456" };
type Saved = { tasks: TaskRecord[]; at?: string };

/** OpenCode and git in the fake container. `status` and `git` may change between calls. */
function workspace(o: Record<string, unknown> & { notifyUrl?: string } = {}) {
  const { notifyUrl, ...config } = o;
  const h = makeOrbCtx({ config });
  h.ctx.env.CONTROL_TOKEN = "control";
  // The notify URL is the Worker secret NOTIFY_URL, not a setting.
  if (notifyUrl) h.ctx.env.NOTIFY_URL = notifyUrl;
  const io = {
    status: { active: [] as string[], sessions: {} as Record<string, unknown> },
    git: { tasks: {} } as Record<string, unknown>,
    gitEnvs: [] as Record<string, string>[],
    n: 0,
  };
  const inner = h.fake.handler;
  h.fake.handler = (cmd, opts, fake) => {
    const env = opts.env ?? {};
    if (cmd[2] === TASK_START_SH) return JSON.stringify({ id: `ses_${++io.n}`, title: "", base: SHA("a") });
    if (cmd[2] === TASK_STATUS_SH) return JSON.stringify(io.status);
    if (cmd[2] === TASK_GIT_SH) {
      io.gitEnvs.push({ ...env });
      return JSON.stringify(io.git);
    }
    return inner(cmd, opts, fake);
  };
  return { h, io };
}

async function started(h: OrbHarness, n = 1, schema?: unknown) {
  await runSpawn(h.newOp(), spawnReq);
  for (let i = 0; i < n; i++)
    await startTask(h.ctx, { text: `task ${i + 1}`, ...(schema ? { schema } : {}) });
}

const saved = async (h: OrbHarness) => (await h.kv.get<Saved>(TASKS_KEY))?.tasks ?? [];

/** A receiver that records what it got and answers with the next status in the list (the last repeats). */
function receiver(statuses: (number | Error)[] = [200]) {
  const got: { url: string; headers: Record<string, string>; body: string }[] = [];
  let i = 0;
  const fetchFn: FetchFn = async (url, init) => {
    const s = statuses[Math.min(i++, statuses.length - 1)] as number | Error;
    got.push({
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: String(init.body),
    });
    if (s instanceof Error) throw s;
    return new Response("ok", { status: s });
  };
  return { got, fetchFn };
}

describe("result record", () => {
  it("is built from the status and git output, with facts and no prose parsing", () => {
    const t: TaskRecord = {
      id: "ses_1",
      title: "t",
      started: Date.parse("2026-11-12T10:00:00Z"),
      state: "running",
      base: SHA("a"),
    };
    const [after] = applyStatus(
      [t],
      {
        active: [],
        sessions: {
          ses_1: {
            found: true,
            outcome: "succeeded",
            last: "Did it.\nResult: x",
            time: { updated: Date.parse("2026-11-12T10:05:00Z") },
          },
        },
      },
      Date.parse("2026-11-12T10:06:00Z"),
    );
    const git = parseGitFacts(
      JSON.stringify({
        branch: "fix-login",
        pullRequest: "https://github.com/acme/app/pull/7",
        tasks: {
          ses_1: {
            commits: [
              { sha: SHA("b"), subject: "Fix login" },
              { sha: "nope", subject: "x" },
            ],
            changedFiles: ["a.ts"],
          },
        },
      }),
    );
    const [withFacts] = applyFacts([after as TaskRecord], git!, new Set(["ses_1"]));
    expect(taskResult("app", withFacts as TaskRecord)).toEqual({
      id: "ses_1",
      workspace: "app",
      state: "done",
      title: "t",
      summary: "Did it.\nResult: x",
      branch: "fix-login",
      commits: [{ sha: SHA("b"), subject: "Fix login" }],
      pullRequest: "https://github.com/acme/app/pull/7",
      changedFiles: ["a.ts"],
      started: "2026-11-12T10:00:00.000Z",
      updated: "2026-11-12T10:05:00.000Z",
    } satisfies TaskResult);
  });

  it("bounds every field the workspace writes: the agent is root and can answer for the scripts", () => {
    const big = "z".repeat(200_000);
    const base: TaskRecord = { id: "ses_1", title: "t", started: 0, state: "running", base: SHA("a") };
    const [failed] = applyStatus(
      [base],
      { active: [], sessions: { ses_1: { found: true, outcome: "failed", reason: big, last: big } } },
      1,
    );
    const [withFacts] = applyFacts(
      [failed as TaskRecord],
      {
        branch: big,
        pullRequest: `https://${big}`,
        tasks: { ses_1: { commits: [], changedFiles: Array.from({ length: 500 }, () => big) } },
      },
      new Set(["ses_1"]),
    );
    expect(JSON.stringify(withFacts).length).toBeLessThan(60_000);
  });

  it("a task with no commit is done with an empty list; waiting carries the question; failed the error", () => {
    const base: TaskRecord = { id: "ses_1", title: "t", started: 0, state: "running", base: SHA("a") };
    const [done] = applyFacts(
      applyStatus([base], { active: [], sessions: { ses_1: { found: true, outcome: "succeeded" } } }, 1),
      { tasks: { ses_1: { commits: [], changedFiles: [] } } },
      new Set(["ses_1"]),
    );
    expect(taskResult("app", done as TaskRecord)).toMatchObject({
      state: "done",
      commits: [],
      changedFiles: [],
    });

    const [waiting] = applyStatus(
      [base],
      {
        active: ["ses_1"],
        sessions: { ses_1: { found: true, permissions: 1, question: "Permission: allow bash?" } },
      },
      1,
    );
    expect(taskResult("app", waiting as TaskRecord)).toMatchObject({
      state: "waiting",
      question: "Permission: allow bash?",
    });

    const [failed] = applyStatus(
      [base],
      { active: [], sessions: { ses_1: { found: true, outcome: "failed", reason: "rate limited" } } },
      1,
    );
    expect(taskResult("app", failed as TaskRecord)).toMatchObject({ state: "failed", error: "rate limited" });
    expect(taskResult("app", failed as TaskRecord).question).toBeUndefined();
  });

  it("validates the json block against the task's schema; a bad block does not change the state", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const t: TaskRecord = { id: "ses_1", title: "t", started: 0, state: "running", schema };
    const read = (last: string) =>
      applyStatus(
        [t],
        { active: [], sessions: { ses_1: { found: true, outcome: "succeeded", last } } },
        1,
      )[0] as TaskRecord;
    expect(read('Result: x\n```json\n{"ok": true}\n```').structured).toEqual({ ok: true });
    const bad = read('```json\n{"ok": "yes"}\n```');
    expect(bad.state).toBe("done");
    expect(bad.structuredError).toMatch(/expected boolean/);
    // The block is read from the whole message, though the summary keeps only its end.
    const long = read(`${"x".repeat(9000)}\n\`\`\`json\n{"ok": false}\n\`\`\``);
    expect(long.structured).toEqual({ ok: false });
    expect(long.last?.length).toBe(4000);
  });
});

describe("task lifecycle in the Durable Object", () => {
  it("a task that ends is unseen until one read of it, and git facts are read with gh at the end", async () => {
    const { h, io } = workspace();
    await started(h);
    io.status = { active: ["ses_1"], sessions: { ses_1: { found: true } } };
    expect((await readTasks(h.ctx)).tasks[0]?.unseen).toBeUndefined();
    expect(io.gitEnvs).toHaveLength(0);

    io.status = {
      active: [],
      sessions: { ses_1: { found: true, outcome: "succeeded", last: "Result: ok" } },
    };
    io.git = { branch: "b", tasks: { ses_1: { commits: [], changedFiles: ["x"] } } };
    const list = await readTasks(h.ctx);
    expect(list.tasks[0]).toMatchObject({
      state: "done",
      unseen: true,
      commits: [],
      changedFiles: ["x"],
      branch: "b",
    });
    expect(io.gitEnvs[0]).toMatchObject({ GH: "1", GH_TOKEN: "cf-opencode-egress" });
    expect(JSON.parse(io.gitEnvs[0]?.TASKS ?? "[]")).toEqual([
      { id: "ses_1", base: SHA("a"), since: Math.floor(list.tasks[0]!.started / 1000) },
    ]);
    // No notify URL: nothing is queued.
    expect(list.tasks[0]?.notify).toBeUndefined();

    // Listing does not clear it; a read without seen does not either; a read with seen does.
    await readTasks(h.ctx);
    expect((await readTask(h.ctx, "ses_1"))?.task.unseen).toBe(true);
    expect((await readTask(h.ctx, "ses_1", { seen: true }))?.task.unseen).toBe(false);
    expect((await saved(h))[0]?.unseen).toBe(false);
    expect(await readTask(h.ctx, "ses_9")).toBeUndefined();
  });

  it("a running task gets live git facts, without gh, only on the read that shows it", async () => {
    const { h, io } = workspace();
    await started(h);
    io.status = { active: ["ses_1"], sessions: { ses_1: { found: true } } };
    io.git = {
      branch: "main",
      tasks: { ses_1: { commits: [{ sha: SHA("c"), subject: "wip" }], changedFiles: [] } },
    };
    // A poll (--wait) runs no git.
    expect((await readTask(h.ctx, "ses_1"))?.task.commits).toBeUndefined();
    expect(io.gitEnvs).toHaveLength(0);
    const one = await readTask(h.ctx, "ses_1", { seen: true });
    expect(one?.task.commits).toEqual([{ sha: SHA("c"), subject: "wip" }]);
    expect(io.gitEnvs[0]?.GH).toBe("0");
  });

  it("a cold pause under a running task saves it as stopped; after the wake the interrupt keeps it stopped", async () => {
    const { h, io } = workspace({ notifyUrl: RECEIVER });
    await started(h);
    io.status = { active: ["ses_1"], sessions: { ses_1: { found: true } } };
    io.git = { branch: "b", tasks: { ses_1: { commits: [], changedFiles: [] } } };
    await runPause(h.newOp(), { op: "pause" });
    expect(h.fake.running).toBe(false);
    const [t] = await saved(h);
    expect(t).toMatchObject({
      state: "stopped",
      unseen: true,
      commits: [],
      notify: { state: "stopped", tries: 0 },
    });
    expect(t?.reason).toMatch(/cf-opencode connect ws-test --session ses_1/);
    expect(taskResult("ws-test", t as TaskRecord).error).toMatch(/workspace paused/);

    await runSpawn(h.newOp(), spawnReq);
    io.status = { active: [], sessions: { ses_1: { found: true, outcome: "interrupted" } } };
    expect((await readTasks(h.ctx)).tasks[0]?.state).toBe("stopped");
    // Continued and finished: done, and a new delivery is queued.
    io.status = { active: [], sessions: { ses_1: { found: true, outcome: "succeeded" } } };
    const [done] = (await readTasks(h.ctx)).tasks;
    expect(done).toMatchObject({ state: "done", notify: { state: "done", tries: 0 } });
  });

  it("a warm pause leaves the task running: opencode keeps going", async () => {
    const { h, io } = workspace({ warmMinutes: 10 });
    await started(h);
    h.sim.aliveBoot = h.fake.bootId;
    io.status = { active: ["ses_1"], sessions: { ses_1: { found: true } } };
    await runPause(h.newOp(), { op: "pause" });
    expect((await saved(h))[0]?.state).toBe("running");
  });
});

describe("notify URL push", () => {
  it("POSTs the result record once, signed with the key from the control token", async () => {
    const { h, io } = workspace({ notifyUrl: RECEIVER });
    await started(h);
    io.status = {
      active: [],
      sessions: { ses_1: { found: true, outcome: "succeeded", last: "Result: ok" } },
    };
    const r = receiver([200]);
    // The alarm notices the end (the task was running) and sends at once.
    expect(await taskTick(h.ctx, r.fetchFn)).toBeNull();
    expect(r.got).toHaveLength(1);
    const sent = r.got[0]!;
    expect(sent.url).toBe(RECEIVER);
    expect(sent.headers["x-cf-opencode-event"]).toBe("task");
    const key = createHmac("sha256", "control").update(NOTIFY_KEY_LABEL).digest("hex");
    expect(await notifyKey("control")).toBe(key);
    // The same vector is in cli/test/task-result.test.ts: `cf-opencode notify-key` prints this key.
    expect(key).toBe("a2a940c5d7f3460159b47cfff72480f41a289ec4f4f367d0cb00c0a9dbe14e93");
    // The time is signed with the body, so a copy cannot be sent again later.
    const ts = sent.headers["x-cf-opencode-timestamp"];
    expect(ts).toMatch(/^\d{10}$/);
    expect(sent.headers["x-cf-opencode-signature"]).toBe(
      `sha256=${createHmac("sha256", key).update(`${ts}.${sent.body}`).digest("hex")}`,
    );
    expect(sent.headers["x-cf-opencode-signature"]).not.toBe(
      `sha256=${createHmac("sha256", key).update(sent.body).digest("hex")}`,
    );
    expect(JSON.parse(sent.body)).toMatchObject({
      id: "ses_1",
      workspace: "ws-test",
      state: "done",
      summary: "Result: ok",
    });

    const [t] = await saved(h);
    expect(t?.notify).toBeUndefined();
    expect(t?.notified).toMatchObject({ status: 200, state: "done" });
    expect(taskResult("ws-test", t as TaskRecord).notified?.status).toBe(200);
    // No duplicate: more alarms and reads send nothing.
    await taskTick(h.ctx, r.fetchFn);
    await readTasks(h.ctx);
    await taskTick(h.ctx, r.fetchFn);
    expect(r.got).toHaveLength(1);
  });

  it("retries after 1, 5 and 30 minutes, then gives up and records why", async () => {
    const { h, io } = workspace({ notifyUrl: RECEIVER });
    await started(h);
    io.status = { active: [], sessions: { ses_1: { found: true, outcome: "failed" } } };
    await readTasks(h.ctx);
    const r = receiver([500, new Error("connection reset")]);
    const waits: (number | null)[] = [];
    waits.push(await deliverDue(h.ctx, r.fetchFn));
    for (const ms of RETRY_DELAYS_MS) {
      // Not due yet: nothing is sent.
      h.clock.advance(ms - 1000);
      await deliverDue(h.ctx, r.fetchFn);
      h.clock.advance(1000);
      waits.push(await deliverDue(h.ctx, r.fetchFn));
    }
    expect(r.got).toHaveLength(4);
    expect(waits).toEqual([60_000, 300_000, 1_800_000, null]);
    const [t] = await saved(h);
    expect(t?.notify).toBeUndefined();
    expect(t?.notifyError).toBe("the notify URL did not answer (connection reset); gave up after 4 tries");
    h.clock.advance(3600_000);
    await deliverDue(h.ctx, r.fetchFn);
    expect(r.got).toHaveLength(4);
  });

  it("a retry that succeeds stops the schedule", async () => {
    const { h, io } = workspace({ notifyUrl: RECEIVER });
    await started(h);
    io.status = { active: [], sessions: { ses_1: { found: true, outcome: "succeeded" } } };
    await readTasks(h.ctx);
    const r = receiver([503, 202]);
    expect(await deliverDue(h.ctx, r.fetchFn)).toBe(60_000);
    expect((await saved(h))[0]?.notify?.tries).toBe(1);
    h.clock.advance(60_000);
    expect(await deliverDue(h.ctx, r.fetchFn)).toBeNull();
    h.clock.advance(3600_000);
    await deliverDue(h.ctx, r.fetchFn);
    expect(r.got).toHaveLength(2);
    expect((await saved(h))[0]).toMatchObject({ notified: { status: 202 } });
  });

  it("the schedule: try 2, 3 and 4 wait 1, 5 and 30 minutes; there is no try 5", () => {
    const p = { state: "done" as const, tries: 1, next: 0 };
    expect(afterFailure(p, 0)?.next).toBe(60_000);
    expect(afterFailure({ ...p, tries: 2 }, 0)?.next).toBe(300_000);
    expect(afterFailure({ ...p, tries: 3 }, 0)?.next).toBe(1_800_000);
    expect(afterFailure({ ...p, tries: 4 }, 0)).toBeUndefined();
  });

  it("a paused workspace still delivers: the alarm needs no container", async () => {
    const { h, io } = workspace({ notifyUrl: RECEIVER });
    await started(h);
    io.status = { active: ["ses_1"], sessions: { ses_1: { found: true } } };
    await runPause(h.newOp(), { op: "pause" });
    expect(h.fake.running).toBe(false);
    const r = receiver([200]);
    expect(await taskTick(h.ctx, r.fetchFn)).toBeNull();
    expect(JSON.parse(r.got[0]?.body ?? "{}")).toMatchObject({ state: "stopped" });
    expect(h.fake.running).toBe(false);
  });

  it("a newer change replaces a delivery that waits for a retry", async () => {
    const { h, io } = workspace({ notifyUrl: RECEIVER });
    await started(h);
    io.status = { active: ["ses_1"], sessions: { ses_1: { found: true, permissions: 1 } } };
    await readTasks(h.ctx);
    const r = receiver([500, 200]);
    await deliverDue(h.ctx, r.fetchFn);
    io.status = { active: [], sessions: { ses_1: { found: true, outcome: "succeeded" } } };
    await readTasks(h.ctx);
    expect((await saved(h))[0]?.notify).toMatchObject({ state: "done", tries: 0 });
    await deliverDue(h.ctx, r.fetchFn);
    expect(r.got.map((g) => JSON.parse(g.body).state)).toEqual(["waiting", "done"]);
  });
});

describe("cf-opencode-notify through the Worker", () => {
  const note = (body: unknown, notifyUrl: string | null = RECEIVER, fetchFn?: FetchFn) =>
    handleNote(
      new Request("http://ai.cf-opencode.internal/notify", { method: "POST", body: JSON.stringify(body) }),
      {
        workspaceId: "app",
        controlToken: "control",
        ...(notifyUrl ? { notifyUrl } : {}),
        ...(fetchFn ? { fetchFn } : {}),
        now: () => 0,
      },
    );

  it("posts a signed note", async () => {
    const r = receiver([200]);
    const res = await note({ text: "blocked on a secret" }, undefined, r.fetchFn);
    expect(res.status).toBe(200);
    expect(JSON.parse(r.got[0]?.body ?? "")).toEqual({
      type: "note",
      workspace: "app",
      text: "blocked on a secret",
      at: "1970-01-01T00:00:00.000Z",
    });
    expect(r.got[0]?.headers["x-cf-opencode-event"]).toBe("note");
  });

  it("fails with one line when no URL is set, the text is empty, or the receiver refuses", async () => {
    const empty = await note({ text: "x" }, null);
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toMatch(
      /^Failed: no notify URL is set — fix: the user runs cf-opencode notify-url/,
    );
    const internal = await note({ text: "x" }, "https://169.254.169.254/latest", receiver([200]).fetchFn);
    expect(internal.status).toBe(400);
    expect((await note({ text: " " })).status).toBe(400);
    const refused = await note({ text: "x" }, undefined, receiver([404]).fetchFn);
    expect(((await refused.json()) as { error: string }).error).toMatch(
      /^Failed: the notify URL answered HTTP 404 — fix:/,
    );
  });
});

describe("notify URL", () => {
  it("is a Worker secret, not a setting: a notifyUrl key left in the settings fails with the fix", () => {
    expect(parseConfig(undefined)).not.toHaveProperty("notifyUrl");
    expect(() => parseConfig(JSON.stringify({ notifyUrl: RECEIVER }))).toThrow(
      /^Failed: notifyUrl is no longer a setting.* — fix: .*cf-opencode notify-url$/,
    );
  });

  it("is https, with no user or password, to a public host name", () => {
    expect(checkNotifyUrl(RECEIVER)).toBeUndefined();
    expect(checkNotifyUrl("http://x.example.com")).toMatch(/https/);
    expect(checkNotifyUrl("https://u:p@x.example.com")).toMatch(/user or password/);
    expect(checkNotifyUrl("nope")).toMatch(/not a URL/);
    expect(checkNotifyUrl("")).toMatch(/https URL/);
    for (const bad of [
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.1/x",
      "https://[::1]/x",
      "https://localhost/x",
      "https://metadata.google.internal/x",
      "https://printer.local/x",
      "https://intranet/x",
    ])
      expect(checkNotifyUrl(bad), bad).toMatch(/public host/);
  });

  it("an unusable secret is checked at send time: nothing is sent, and the task says why", async () => {
    const { h, io } = workspace({ notifyUrl: "https://10.0.0.1/hook" });
    await started(h);
    io.status = { active: [], sessions: { ses_1: { found: true, outcome: "succeeded", last: "ok" } } };
    const r = receiver([200]);
    await taskTick(h.ctx, r.fetchFn);
    expect(r.got).toHaveLength(0);
    expect((await saved(h))[0]?.notifyError).toMatch(/public host.*dropped/);
  });
});

// TASK_GIT_SH for real, in python3 and git, against a temp repository. A fake gh stands in for GitHub.
const hasTools =
  spawnSync("python3", ["--version"]).status === 0 && spawnSync("git", ["--version"]).status === 0;

function run(script: string, env: Record<string, string>): Promise<string> {
  return new Promise((ok, fail) => {
    execFile("bash", ["-c", script], { env }, (e, stdout, stderr) =>
      e ? fail(new Error(`${e.message}\n${stderr}`)) : ok(stdout),
    );
  });
}

describe.skipIf(!hasTools || process.platform === "win32")("TASK_GIT_SH against a real repository", () => {
  it("reports the branch, the commits since the start, the changed files and the pull request", async () => {
    const root = mkdtempSync(join(tmpdir(), "cfoc-git-"));
    const repo = join(root, "project");
    mkdirSync(repo);
    const git = (date: number, ...a: string[]) => {
      const r = spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
        encoding: "utf8",
        env: { ...process.env, GIT_COMMITTER_DATE: `@${date} +0000`, GIT_AUTHOR_DATE: `@${date} +0000` },
      });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    const t0 = 1_800_000_000;
    git(t0 - 100, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(t0 - 100, "add", ".");
    git(t0 - 100, "commit", "-q", "-m", "first");
    const base = git(t0, "rev-parse", "HEAD");
    git(t0, "checkout", "-q", "-b", "fix-login");
    // Made before the start (a commit a checkout brought from origin): not the task's.
    writeFileSync(join(repo, "old.txt"), "o\n");
    git(t0 - 50, "add", ".");
    git(t0 - 50, "commit", "-q", "-m", "from origin");
    writeFileSync(join(repo, "a.txt"), "fixed\n");
    git(t0 + 10, "commit", "-q", "-am", "Fix the login form");
    writeFileSync(join(repo, "new.txt"), "n\n");

    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      '#!/bin/sh\n[ "$1 $2 $3" = "pr view fix-login" ] && [ "$GH_TOKEN" = "cf-opencode-egress" ] && echo https://github.com/acme/app/pull/7 && exit 0\nexit 1\n',
    );
    chmodSync(join(bin, "gh"), 0o755);
    const env = {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: root,
      DIRECTORY: repo,
      GH_TOKEN: "cf-opencode-egress",
      TASKS: JSON.stringify([
        { id: "ses_1", base, since: t0 },
        { id: "ses_old", since: t0 },
        { id: "ses_bad", base: SHA("f"), since: t0 },
      ]),
    };
    const out = JSON.parse(await run(TASK_GIT_SH, { ...env, GH: "1" }));
    expect(out.branch).toBe("fix-login");
    expect(out.pullRequest).toBe("https://github.com/acme/app/pull/7");
    expect(out.tasks.ses_1.commits).toEqual([
      { sha: git(t0, "rev-parse", "HEAD"), subject: "Fix the login form" },
    ]);
    expect(out.tasks.ses_1.changedFiles.sort()).toEqual(["a.txt", "new.txt", "old.txt"]);
    expect(out.tasks.ses_old).toBeUndefined();
    expect(out.tasks.ses_bad).toBeUndefined();

    // Without GH, gh is not asked. Not a checkout: no facts.
    expect(JSON.parse(await run(TASK_GIT_SH, { ...env, GH: "0" })).pullRequest).toBeUndefined();
    expect(JSON.parse(await run(TASK_GIT_SH, { ...env, DIRECTORY: root }))).toEqual({ tasks: {} });

    // The Worker side keeps the facts on the right task.
    const facts = parseGitFacts(JSON.stringify(out));
    const [t] = applyFacts(
      [{ id: "ses_1", title: "t", started: t0 * 1000, state: "done" }],
      facts!,
      new Set(["ses_1"]),
    );
    expect(taskResult("app", t as TaskRecord)).toMatchObject({
      branch: "fix-login",
      pullRequest: "https://github.com/acme/app/pull/7",
      commits: [{ subject: "Fix the login form" }],
    });
  });
});

describe("note budget", () => {
  it("allows 20 notes in an hour, then refuses until old ones leave the window", async () => {
    const { noteBudget, NOTE_LIMIT, NOTE_WINDOW_MS, handleNote } = await import("../src/orb/task-notify");
    let sent: number[] = [];
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < NOTE_LIMIT; i++) {
      const r = noteBudget(sent, t0 + i * 1000);
      expect(r.allowed).toBe(true);
      sent = r.sent;
    }
    expect(noteBudget(sent, t0 + 60_000).allowed).toBe(false);
    expect(noteBudget(sent, t0 + 60_000).sent).toHaveLength(NOTE_LIMIT);
    expect(noteBudget(sent, t0 + NOTE_WINDOW_MS + 500).allowed).toBe(true);

    // The handler asks before it sends, and says why it refused.
    let posted = 0;
    const res = await handleNote(
      new Request("http://ai.cf-opencode.internal/notify", { method: "POST", body: '{"text":"hi"}' }),
      {
        workspaceId: "ws-test",
        controlToken: "control",
        notifyUrl: "https://hooks.example.com/x",
        allow: async () => false,
        fetchFn: async () => {
          posted++;
          return new Response("ok");
        },
      },
    );
    expect(res.status).toBe(429);
    expect(JSON.stringify(await res.json())).toMatch(/20 notes in the last hour/);
    expect(posted).toBe(0);
  });
});
