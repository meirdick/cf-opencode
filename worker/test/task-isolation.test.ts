// run --auto, run --worktree, and the guard against a second task in one checkout.
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExclusiveQueue } from "../src/orb/exclusive";
import { runSpawn } from "../src/orb/spawn";
import { handoffBlock } from "../src/orb/task-context";
import { taskResult } from "../src/orb/task-result";
import { TASK_GIT_SH, TASK_START_SH, TASK_STATUS_SH } from "../src/orb/task-scripts";
import {
  busyError,
  checkoutHolder,
  parseTaskInput,
  readTask,
  readTasks,
  startTask,
  TASKS_KEY,
  type TaskRecord,
  WORKTREE_PARENT,
} from "../src/orb/tasks";
import { makeOrbCtx, type OrbHarness } from "./fake-registry";

const SHA = (c: string) => c.repeat(40);
const spawnReq = { op: "spawn" as const, password: "tok-123456" };
type Saved = { tasks: TaskRecord[]; at?: string };

/** OpenCode and git in the fake container. The answers may change between calls. */
function workspace() {
  const h = makeOrbCtx();
  h.ctx.env.CONTROL_TOKEN = "control";
  const io = {
    n: 0,
    specs: [] as Record<string, unknown>[],
    status: undefined as undefined | ((ids: string[]) => unknown),
    statusEnvs: [] as Record<string, string>[],
    gitEnvs: [] as Record<string, string>[],
    git: (_dir: string, _tasks: { id: string }[]): unknown => ({ tasks: {} }),
    /** What the start script adds to its answer. */
    start: (spec: Record<string, unknown>): Record<string, unknown> =>
      spec.worktree ? { worktree: `${WORKTREE_PARENT}/task-${io.n}` } : {},
  };
  const inner = h.fake.handler;
  h.fake.handler = (cmd, opts, fake) => {
    const env = opts.env ?? {};
    if (cmd[2] === TASK_START_SH) {
      const spec = JSON.parse(env.TASK ?? "{}");
      io.specs.push(spec);
      io.n++;
      return JSON.stringify({ id: `ses_${io.n}`, title: "", base: SHA("a"), ...io.start(spec) });
    }
    if (cmd[2] === TASK_STATUS_SH) {
      io.statusEnvs.push({ ...env });
      const ids = (env.IDS ?? "").split(" ").filter(Boolean);
      return JSON.stringify(io.status ? io.status(ids) : { active: ids, sessions: {} });
    }
    if (cmd[2] === TASK_GIT_SH) {
      io.gitEnvs.push({ ...env });
      return JSON.stringify(io.git(env.DIRECTORY ?? "", JSON.parse(env.TASKS ?? "[]")));
    }
    return inner(cmd, opts, fake);
  };
  return { h, io };
}

const saved = async (h: OrbHarness) => (await h.kv.get<Saved>(TASKS_KEY))?.tasks ?? [];
const found = (ids: string[], f: Record<string, unknown>) =>
  Object.fromEntries(ids.map((id) => [id, { found: true, ...f }]));

describe("task input", () => {
  it("takes auto and worktree as booleans", () => {
    expect(parseTaskInput({ text: "x", auto: true, worktree: true })).toEqual({
      input: { text: "x", auto: true, worktree: true },
    });
    expect(parseTaskInput({ text: "x", auto: false })).toEqual({ input: { text: "x" } });
    expect(parseTaskInput({ text: "x", auto: "yes" })).toMatchObject({ error: "auto must be true or false" });
    expect(parseTaskInput({ text: "x", worktree: 1 })).toMatchObject({
      error: "worktree must be true or false",
    });
  });
});

describe("one task in the checkout", () => {
  const t = (id: string, state: TaskRecord["state"], worktree?: string): TaskRecord => ({
    id,
    title: id,
    started: 0,
    state,
    ...(worktree ? { worktree } : {}),
  });

  it("a running or waiting task holds the checkout; a stopped, ended or worktree task does not", () => {
    expect(checkoutHolder([t("ses_1", "done"), t("ses_2", "running")])?.id).toBe("ses_2");
    expect(checkoutHolder([t("ses_1", "waiting")])?.id).toBe("ses_1");
    expect(checkoutHolder([t("ses_1", "stopped"), t("ses_2", "failed")])).toBeUndefined();
    expect(checkoutHolder([t("ses_1", "running", "/home/user/worktrees/a")])).toBeUndefined();
  });

  it("the refusal is one Failed line with the fixes of the caller", () => {
    const run = busyError("app", t("ses_1", "running"), "cli");
    expect(run).toMatch(/^Failed: task ses_1 is running in the checkout of workspace app; .* — fix: .*$/);
    expect(run).toContain("--new");
    expect(run).toContain("--worktree");
    expect(run.split("\n")).toHaveLength(1);
    expect(busyError("app", t("ses_1", "running"), "mcp")).toContain("set newWorkspace or worktree to true");
    expect(busyError("app", t("ses_1", "running"), "a2a")).toContain("metadata.worktree");
    expect(busyError("app", t("ses_1", "waiting"), "cli")).toContain(
      'cf-opencode tasks ses_1 --workspace app --reply "<text>"',
    );
  });

  it("a second task in the checkout fails before a session starts", async () => {
    const { h, io } = workspace();
    await runSpawn(h.newOp(), spawnReq);
    expect(await startTask(h.ctx, { text: "one" })).toMatchObject({ ok: true });
    const r = await startTask(h.ctx, { text: "two", handoff: { origin: "cli" } });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(!r.ok && r.error).toMatch(/^Failed: task ses_1 is running .* — fix: pass --new/);
    // No session was made for the second task.
    expect(io.specs).toHaveLength(1);
    expect((await saved(h)).map((x) => x.id)).toEqual(["ses_1"]);
  });

  it("reads the live state before it refuses: a task that ended frees the checkout", async () => {
    const { h, io } = workspace();
    await runSpawn(h.newOp(), spawnReq);
    await startTask(h.ctx, { text: "one" });
    io.status = (ids) => ({ active: [], sessions: found(ids, { outcome: "succeeded" }) });
    expect(await startTask(h.ctx, { text: "two" })).toMatchObject({ ok: true, task: { id: "ses_2" } });
  });

  it("a waiting task holds the checkout; the fix also says how to answer it", async () => {
    const { h, io } = workspace();
    await runSpawn(h.newOp(), spawnReq);
    await startTask(h.ctx, { text: "one" });
    io.status = (ids) => ({ active: ids, sessions: found(ids, { permissions: 0, forms: 1 }) });
    const r = await startTask(h.ctx, { text: "two" });
    expect(!r.ok && r.error).toMatch(/is waiting .*--reply/);
  });

  it("a worktree task does not hold the checkout, and starts while another task runs there", async () => {
    const { h, io } = workspace();
    await runSpawn(h.newOp(), spawnReq);
    await startTask(h.ctx, { text: "one" });
    const w = await startTask(h.ctx, { text: "two", worktree: true });
    expect(w).toMatchObject({ ok: true, task: { id: "ses_2", worktree: `${WORKTREE_PARENT}/task-2` } });
    // The checkout task still runs, the worktree task does not count: a third task in a worktree starts too.
    expect(await startTask(h.ctx, { text: "three", worktree: true })).toMatchObject({ ok: true });
    expect(io.specs).toHaveLength(3);
  });

  it("two starts at once in one queue: the second sees the first and fails", async () => {
    const { h } = workspace();
    await runSpawn(h.newOp(), spawnReq);
    const q = new ExclusiveQueue();
    const [a, b] = await Promise.all([
      q.run(() => startTask(h.ctx, { text: "one" })),
      q.run(() => startTask(h.ctx, { text: "two" })),
    ]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: false, status: 409 });
  });
});

describe("run --auto", () => {
  it("asks the start script for a session with no prompts, and keeps the mark", async () => {
    const { h, io } = workspace();
    await runSpawn(h.newOp(), spawnReq);
    const r = await startTask(h.ctx, { text: "x", auto: true });
    expect(io.specs[0]).toMatchObject({ auto: true });
    expect(r).toMatchObject({ ok: true, task: { auto: true } });
    // A task without --auto sends nothing about it.
    io.status = (ids) => ({ active: [], sessions: found(ids, { outcome: "succeeded" }) });
    await startTask(h.ctx, { text: "y" });
    expect(io.specs[1]).not.toHaveProperty("auto");
  });

  it("each status read lists the auto tasks that run or wait, so their requests get an answer", async () => {
    const { h, io } = workspace();
    await runSpawn(h.newOp(), spawnReq);
    await startTask(h.ctx, { text: "x", auto: true });
    await startTask(h.ctx, { text: "y", worktree: true });
    await readTasks(h.ctx);
    expect(io.statusEnvs.at(-1)?.AUTO).toBe("ses_1");
    expect(io.statusEnvs.at(-1)?.IDS).toBe("ses_2 ses_1");
  });
});

describe("run --worktree", () => {
  it("sends the parent folder and the start branch, and tells the agent it is in a worktree", async () => {
    const { h, io } = workspace();
    await runSpawn(h.newOp(), spawnReq);
    await startTask(h.ctx, { text: "x", worktree: true, handoff: { origin: "cli", branch: "feat/a" } });
    expect(io.specs[0]?.worktree).toEqual({ parent: WORKTREE_PARENT, branch: "feat/a" });
    expect((io.specs[0]?.context as { text: string } | undefined)?.text).toContain("your own git worktree");
    expect(handoffBlock({ origin: "cli" })).not.toContain("worktree");
  });

  it("a script error about the worktree is its own Failed line", async () => {
    const { h, io } = workspace();
    await runSpawn(h.newOp(), spawnReq);
    h.fake.handler = (
      (inner) => (cmd, opts, fake) =>
        cmd[2] === TASK_START_SH
          ? JSON.stringify({ error: "worktree: branch feat/a is not on origin, or origin did not answer" })
          : inner(cmd, opts, fake)
    )(h.fake.handler);
    const r = await startTask(h.ctx, {
      text: "x",
      worktree: true,
      handoff: { origin: "cli", branch: "feat/a" },
    });
    expect(!r.ok && r.error).toBe(
      "Failed: no worktree for the task: branch feat/a is not on origin, or origin did not answer — fix: push the branch to origin, or run without --worktree",
    );
    expect(io.specs).toHaveLength(0);
  });

  it("a start that reports no worktree records no task", async () => {
    const { h, io } = workspace();
    io.start = () => ({});
    await runSpawn(h.newOp(), spawnReq);
    const r = await startTask(h.ctx, { text: "x", worktree: true });
    expect(!r.ok && r.error).toMatch(/^Failed: the start script made no worktree/);
    expect(await saved(h)).toEqual([]);
  });

  it("reads the git facts of a worktree task in its worktree, and those of the others in the checkout", async () => {
    const { h, io } = workspace();
    await runSpawn(h.newOp(), spawnReq);
    await startTask(h.ctx, { text: "main" });
    await startTask(h.ctx, { text: "side", worktree: true });
    io.git = (dir, tasks) => ({
      branch: dir.startsWith(WORKTREE_PARENT) ? "task/side" : "main",
      unpushed: dir.startsWith(WORKTREE_PARENT) ? 2 : 0,
      processes: dir.startsWith(WORKTREE_PARENT) ? ["vite"] : [],
      tasks: Object.fromEntries(
        // A script that answered for every id it got: only the tasks of that checkout may take it.
        ["ses_1", "ses_2"].map((id) => [
          id,
          { commits: [{ sha: SHA(dir.length % 2 ? "b" : "c"), subject: `in ${dir}` }], changedFiles: [] },
        ]),
      ),
      asked: tasks.map((t) => t.id),
    });
    await readTask(h.ctx, "ses_1", { seen: true });
    await readTask(h.ctx, "ses_2", { seen: true });
    const dirs = io.gitEnvs.map(
      (e) => `${e.DIRECTORY} ${JSON.parse(e.TASKS ?? "[]").map((t: { id: string }) => t.id)}`,
    );
    expect(dirs).toEqual(["/home/user/project ses_1", `${WORKTREE_PARENT}/task-2 ses_2`]);
    const [side, main] = await saved(h);
    expect(main).toMatchObject({ branch: "main", commits: [{ subject: "in /home/user/project" }] });
    expect(main?.unpushed).toBeUndefined();
    expect(side).toMatchObject({
      branch: "task/side",
      unpushed: 2,
      processes: ["vite"],
      commits: [{ subject: `in ${WORKTREE_PARENT}/task-2` }],
    });
    expect(taskResult("app", side as TaskRecord).worktree).toBe(`${WORKTREE_PARENT}/task-2`);
  });
});

// The real scripts, in python3 and git, against a stub OpenCode server and a local origin.
const hasTools =
  spawnSync("python3", ["--version"]).status === 0 && spawnSync("git", ["--version"]).status === 0;

function runScript(script: string, env: Record<string, string>): Promise<string> {
  return new Promise((ok, fail) => {
    execFile(
      "bash",
      ["-c", script],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: tmpdir(),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
          ...env,
        },
      },
      (e, stdout, stderr) => (e ? fail(new Error(`${e.message}\n${stderr}`)) : ok(stdout)),
    );
  });
}

function git(dir: string, ...a: string[]): string {
  const r = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A bare origin with main and feat/a, and a clone of it on main. */
function repos() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cfoc-wt-")));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  spawnSync("git", ["init", "-q", "-b", "main", seed]);
  git(seed, "commit", "-q", "--allow-empty", "-m", "first");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  git(seed, "switch", "-q", "-c", "feat/a");
  git(seed, "commit", "-q", "--allow-empty", "-m", "on feat");
  git(seed, "push", "-q", "origin", "feat/a");
  const clone = join(root, "project");
  spawnSync("git", ["clone", "-q", origin, clone]);
  return { root, clone, featSha: git(seed, "rev-parse", "HEAD"), mainSha: git(clone, "rev-parse", "HEAD") };
}

/**
 * A stub OpenCode: sessions, agents with one deny rule, permission replies, and (with api) the location
 * and worktree routes. The worktree route makes a real git worktree, as OpenCode's git strategy does.
 */
function stub(o: { password: string; clone: string; api: boolean; agents?: boolean }) {
  const calls: { method: string; url: string; body: string }[] = [];
  const wantAuth = `Basic ${Buffer.from(`opencode:${o.password}`).toString("base64")}`;
  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      calls.push({ method: req.method ?? "", url: req.url ?? "", body });
      if (req.headers.authorization !== wantAuth) return send(res, 401, { _tag: "UnauthorizedError" });
      const u = new URL(req.url ?? "/", "http://x");
      const p = u.pathname;
      if (req.method === "POST" && p === "/api/session")
        return send(res, 200, { data: { id: "ses_new", title: "" } });
      if (req.method === "POST" && /^\/api\/session\/ses_new\/(prompt|synthetic)$/.test(p))
        return send(res, 200, { data: {} });
      if (p === "/api/agent" && o.agents !== false)
        return send(res, 200, {
          data: [
            {
              id: "build",
              permissions: [
                { action: "*", resource: "*", effect: "allow" },
                { action: "read", resource: "*.env", effect: "ask" },
                { action: "bash", resource: "rm -rf /*", effect: "deny" },
              ],
            },
            { id: "plan", permissions: [{ action: "bash", resource: "rm -rf /*", effect: "deny" }] },
          ],
        });
      if (o.api && p === "/api/location" && u.searchParams.get("location[directory]") === o.clone)
        return send(res, 200, { directory: o.clone, project: { id: "prj_1", directory: o.clone } });
      if (o.api && req.method === "POST" && p === "/api/worktree") {
        const { projectID, directory } = JSON.parse(body);
        if (projectID !== "prj_1") return send(res, 404, { _tag: "NotFound" });
        const dir = join(directory, "brave-fox");
        git(o.clone, "worktree", "add", "-q", "--detach", dir, "HEAD");
        return send(res, 200, { directory: dir });
      }
      if (p === "/api/session/active") return send(res, 200, { data: { ses_auto: {}, ses_ask: {} } });
      const m = /^\/api\/session\/(ses_\w+)(\/.*)?$/.exec(p);
      if (!m) return send(res, 404, { _tag: "NotFound" });
      const [, sid, sub] = m;
      if (!sub) return send(res, 200, { data: { id: sid, title: sid, time: {} } });
      if (sub === "/permission")
        return send(res, 200, {
          data: [{ id: `per_${sid}`, sessionID: sid, action: "bash", resources: ["make"] }],
        });
      if (/^\/permission\/per_\w+\/reply$/.test(sub)) return send(res, 204);
      if (sub === "/form") return send(res, 200, { data: [] });
      if (sub === "/message") return send(res, 200, { data: [] });
      return send(res, 404, {});
    });
  });
  return { server, calls };
}

async function listening(s: ReturnType<typeof stub>) {
  await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", r));
  return String((s.server.address() as AddressInfo).port);
}

describe.skipIf(!hasTools || process.platform === "win32")("start and status scripts, for real", () => {
  const spec = (extra: Record<string, unknown>) => ({
    create: { location: { directory: "/home/user/project" } },
    prompt: { text: "do it" },
    ...extra,
  });

  it("auto: the session gets allow-all, then the agents' deny rules, so a deny still wins", async () => {
    const r = repos();
    const s = stub({ password: "pw", clone: r.clone, api: false });
    try {
      const port = await listening(s);
      const out = JSON.parse(
        await runScript(TASK_START_SH, {
          PORT: port,
          OPENCODE_SERVER_PASSWORD: "pw",
          TASK: JSON.stringify(spec({ auto: true })),
        }),
      );
      expect(out).toEqual({ id: "ses_new", title: "", auto: "rules" });
      const create = JSON.parse(s.calls.find((c) => c.url === "/api/session")?.body ?? "{}");
      expect(create.permissions).toEqual([
        { action: "*", resource: "*", effect: "allow" },
        { action: "bash", resource: "rm -rf /*", effect: "deny" },
      ]);
      expect(s.calls.some((c) => c.url.startsWith("/api/agent?location%5Bdirectory%5D=%2Fhome%2Fuser"))).toBe(
        true,
      );
    } finally {
      s.server.close();
    }
  });

  it("auto: when the agents cannot be read, no ruleset is sent and the status read answers instead", async () => {
    const r = repos();
    const s = stub({ password: "pw", clone: r.clone, api: false, agents: false });
    try {
      const port = await listening(s);
      const out = JSON.parse(
        await runScript(TASK_START_SH, {
          PORT: port,
          OPENCODE_SERVER_PASSWORD: "pw",
          TASK: JSON.stringify(spec({ auto: true })),
        }),
      );
      expect(out.auto).toBe("reply");
      expect(JSON.parse(s.calls.find((c) => c.url === "/api/session")?.body ?? "{}")).not.toHaveProperty(
        "permissions",
      );
    } finally {
      s.server.close();
    }
  });

  it("status: answers the permission requests of auto tasks with once, and leaves the others", async () => {
    const r = repos();
    const s = stub({ password: "pw", clone: r.clone, api: false });
    try {
      const port = await listening(s);
      const out = JSON.parse(
        await runScript(TASK_STATUS_SH, {
          PORT: port,
          OPENCODE_SERVER_PASSWORD: "pw",
          IDS: "ses_auto ses_ask",
          AUTO: "ses_auto",
        }),
      );
      expect(out.sessions.ses_auto).toMatchObject({ permissions: 0, replied: 1 });
      expect(out.sessions.ses_auto.question).toBeUndefined();
      expect(out.sessions.ses_ask).toMatchObject({
        permissions: 1,
        question: "Permission: allow bash on make?",
      });
      const replies = s.calls.filter((c) => c.url.endsWith("/reply"));
      expect(replies.map((c) => `${c.url} ${c.body}`)).toEqual([
        '/api/session/ses_auto/permission/per_ses_auto/reply {"decision": "once"}',
      ]);
    } finally {
      s.server.close();
    }
  });

  for (const api of [true, false]) {
    it(`worktree (${api ? "OpenCode's worktree API" : "git, when that API does not answer"}): starts at origin/<branch>, detached`, async () => {
      const r = repos();
      const parent = join(r.root, "worktrees");
      const s = stub({ password: "pw", clone: r.clone, api });
      try {
        const port = await listening(s);
        const out = JSON.parse(
          await runScript(TASK_START_SH, {
            PORT: port,
            OPENCODE_SERVER_PASSWORD: "pw",
            DIRECTORY: r.clone,
            TASK: JSON.stringify(spec({ worktree: { parent, branch: "feat/a" } })),
          }),
        );
        expect(out).toMatchObject({ id: "ses_new", base: r.featSha, worktreeVia: api ? "opencode" : "git" });
        expect(out.worktree.startsWith(`${parent}/`)).toBe(true);
        // The session is made in the worktree, which is on origin/feat/a with no branch checked out.
        const create = JSON.parse(s.calls.find((c) => c.url === "/api/session")?.body ?? "{}");
        expect(create.location).toEqual({ directory: out.worktree });
        expect(git(out.worktree, "rev-parse", "HEAD")).toBe(r.featSha);
        expect(spawnSync("git", ["-C", out.worktree, "symbolic-ref", "-q", "HEAD"]).status).not.toBe(0);
        // The checkout did not move.
        expect(git(r.clone, "rev-parse", "HEAD")).toBe(r.mainSha);
        expect(git(r.clone, "symbolic-ref", "--short", "HEAD")).toBe("main");
      } finally {
        s.server.close();
      }
    });
  }

  it("worktree: no branch starts at origin's default branch; a branch not on origin fails", async () => {
    const r = repos();
    const parent = join(r.root, "worktrees");
    const s = stub({ password: "pw", clone: r.clone, api: false });
    try {
      const port = await listening(s);
      const env = { PORT: port, OPENCODE_SERVER_PASSWORD: "pw", DIRECTORY: r.clone };
      const plain = JSON.parse(
        await runScript(TASK_START_SH, { ...env, TASK: JSON.stringify(spec({ worktree: { parent } })) }),
      );
      expect(plain.base).toBe(r.mainSha);
      const missing = JSON.parse(
        await runScript(TASK_START_SH, {
          ...env,
          TASK: JSON.stringify(spec({ worktree: { parent, branch: "nope" } })),
        }),
      );
      expect(missing).toEqual({ error: "worktree: branch nope is not on origin, or origin did not answer" });
    } finally {
      s.server.close();
    }
  });

  it("TASK_GIT_SH in a worktree reads that worktree, not the checkout", async () => {
    const r = repos();
    const wt = join(r.root, "worktrees", "w1");
    git(r.clone, "worktree", "add", "-q", "--detach", wt, "origin/feat/a");
    const since = Math.floor(Date.now() / 1000) - 5;
    git(wt, "switch", "-q", "-c", "task/w1");
    git(wt, "commit", "-q", "--allow-empty", "-m", "worktree work");
    const out = JSON.parse(
      await runScript(TASK_GIT_SH, {
        DIRECTORY: wt,
        GH: "0",
        TASKS: JSON.stringify([{ id: "ses_w", base: r.featSha, since }]),
      }),
    );
    expect(out.branch).toBe("task/w1");
    expect(out.unpushed).toBe(1);
    expect(out.tasks.ses_w.commits.map((c: { subject: string }) => c.subject)).toEqual(["worktree work"]);
    const main = JSON.parse(
      await runScript(TASK_GIT_SH, {
        DIRECTORY: r.clone,
        GH: "0",
        TASKS: JSON.stringify([{ id: "ses_m", base: r.mainSha, since }]),
      }),
    );
    expect(main.branch).toBe("main");
    expect(main.unpushed).toBe(0);
  });
});
