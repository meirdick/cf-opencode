// Long jobs: cf-opencode-job in the workspace, and how the Worker counts and records them.
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { idleTick, runAlarm } from "../src/orb/alarm";
import { TASK_REPLY_SH } from "../src/orb/auto-reply";
import { holdingJobs, type JobFact, jobsOf, parseJobs, stopJobs } from "../src/orb/jobs";
import { loadOrb } from "../src/orb/journal";
import { runPause } from "../src/orb/pause";
import { ACTIVITY_SH } from "../src/orb/scripts";
import { runSpawn } from "../src/orb/spawn";
import { taskResult } from "../src/orb/task-result";
import { TASK_GIT_SH, TASK_START_SH, TASK_STATUS_SH } from "../src/orb/task-scripts";
import {
  readTasks,
  START_GRACE_MS,
  startTask,
  TASKS_KEY,
  type TaskRecord,
  taskState,
} from "../src/orb/tasks";
import { makeOrbCtx, type OrbHarness } from "./fake-registry";

const SHA = (c: string) => c.repeat(40);
const MIN = 60_000;
type Saved = { tasks: TaskRecord[]; at?: string };
const job = (o: Partial<JobFact> & Pick<JobFact, "id" | "state">): JobFact => ({ name: "build", ...o });

describe("job facts", () => {
  it("keeps only checked, bounded fields; drops anything that is not a job", () => {
    const jobs = parseJobs([
      {
        id: "job-abc123",
        name: "npm\u0007 run",
        state: "failed",
        exit: 2,
        session: "ses_1",
        reply: "sent",
        replyAt: 1_800_000_000.5,
        command: ["npm", "run", "build", "--token=secret"],
        stoppedBy: "nope",
      },
      { id: "job-zzz", state: "running" },
      { id: "job-abc124", state: "exploded" },
      { id: "job-abc125", state: "running", exit: -1, session: "bad id", name: "x".repeat(200) },
      "job-abc126",
    ]);
    expect(jobs).toEqual([
      {
        id: "job-abc123",
        name: "npm  run",
        state: "failed",
        exit: 2,
        session: "ses_1",
        reply: "sent",
        replyAt: 1_800_000_000_500,
      },
      { id: "job-abc125", name: "x".repeat(60), state: "running" },
    ]);
    expect(parseJobs("nope")).toEqual([]);
    expect(JSON.stringify(jobs)).not.toContain("secret");
  });

  it("a job holds its task while it runs, while its end message waits, and briefly after the message", () => {
    const now = 1_000_000;
    expect(holdingJobs([job({ id: "job-000001", state: "running" })], now, START_GRACE_MS)).toBe(1);
    expect(
      holdingJobs([job({ id: "job-000001", state: "done", reply: "pending" })], now, START_GRACE_MS),
    ).toBe(1);
    const sent = job({ id: "job-000001", state: "done", reply: "sent", replyAt: now - 1000 });
    expect(holdingJobs([sent], now, START_GRACE_MS)).toBe(1);
    expect(holdingJobs([sent], now + START_GRACE_MS, START_GRACE_MS)).toBe(0);
    expect(holdingJobs([job({ id: "job-000001", state: "done", reply: "seen" })], now, START_GRACE_MS)).toBe(
      0,
    );
    expect(jobsOf([job({ id: "job-000001", state: "done", session: "ses_2" })], "ses_1")).toEqual([]);
    expect(
      stopJobs([
        job({ id: "job-000001", state: "running" }),
        job({ id: "job-000002", state: "done", reply: "pending" }),
      ]),
    ).toEqual([
      job({ id: "job-000001", state: "stopped", stoppedBy: "pause" }),
      job({ id: "job-000002", state: "done", reply: "lost" }),
    ]);
  });

  it("taskState: a turn that succeeded with a job at work is running, not done", () => {
    const f = { found: true, active: false, permissions: 0, forms: 0, outcome: "succeeded" };
    expect(taskState({ ...f, jobs: 1 }, 0, 0).state).toBe("running");
    expect(taskState({ ...f, jobs: 0 }, 0, 0).state).toBe("done");
    expect(taskState({ ...f, jobs: 1, permissions: 1 }, 0, 0).state).toBe("waiting");
    expect(taskState({ ...f, jobs: 1, outcome: "failed" }, 0, 0).state).toBe("failed");
  });
});

/** OpenCode, git and the jobs in the fake container. */
function workspace(config: Record<string, unknown> = {}) {
  const h = makeOrbCtx({ config });
  h.ctx.env.CONTROL_TOKEN = "control";
  h.ctx.env.NOTIFY_URL = "https://hooks.example.com/x";
  const io = {
    status: { active: [] as string[], sessions: {} as Record<string, unknown>, jobs: [] as unknown[] },
    git: { tasks: { ses_1: { commits: [] } } } as Record<string, unknown>,
    replies: 0,
    jobsRunning: 0,
  };
  const inner = h.fake.handler;
  h.fake.handler = (cmd, opts, fake) => {
    if (cmd[2] === TASK_START_SH) return JSON.stringify({ id: "ses_1", title: "", base: SHA("a") });
    if (cmd[2] === TASK_STATUS_SH) return JSON.stringify(io.status);
    if (cmd[2] === TASK_GIT_SH) return JSON.stringify(io.git);
    if (cmd[2] === TASK_REPLY_SH) {
      io.replies++;
      return '{"ok": true}';
    }
    const r = inner(cmd, opts, fake);
    if (cmd[2] === ACTIVITY_SH && typeof r === "string") return `${r}\njobs ${io.jobsRunning}`;
    return r;
  };
  return { h, io };
}

async function started(h: OrbHarness) {
  await runSpawn(h.newOp(), { op: "spawn", password: "tok-123456" });
  await startTask(h.ctx, { text: "task" });
}
const saved = async (h: OrbHarness) => (await h.kv.get<Saved>(TASKS_KEY))?.tasks ?? [];
const ended = { ses_1: { found: true, outcome: "succeeded", last: "Started the build as a job." } };
const jobRow = (o: Record<string, unknown>) => ({
  id: "job-abc123",
  name: "npm run",
  session: "ses_1",
  ...o,
});

describe("a task with a long job", () => {
  it("is running while the job runs and its message waits; done after the turn that the message starts", async () => {
    const { h, io } = workspace();
    await started(h);
    // The agent ended its turn with commits not pushed and a job at work: no automatic reply, no done.
    io.status = { active: [], sessions: ended, jobs: [jobRow({ state: "running" })] };
    io.git = { unpushed: 1, tasks: { ses_1: { commits: [] } } };
    const [t] = (await readTasks(h.ctx)).tasks;
    expect(t).toMatchObject({ state: "running", jobs: [{ id: "job-abc123", state: "running" }] });
    expect(t?.unseen).toBeUndefined();
    expect(t?.notify).toBeUndefined();
    expect(taskResult("ws-test", t as TaskRecord).jobs).toEqual([
      { id: "job-abc123", name: "npm run", state: "running" },
    ]);

    // The job ended; the message waits for the session.
    io.status.jobs = [jobRow({ state: "failed", exit: 1, reply: "pending" })];
    expect((await readTasks(h.ctx)).tasks[0]?.state).toBe("running");
    // The message went out; OpenCode does not show the new turn yet.
    io.status.jobs = [jobRow({ state: "failed", exit: 1, reply: "sent", replyAt: h.clock.now() / 1000 })];
    expect((await readTasks(h.ctx)).tasks[0]?.state).toBe("running");
    io.status = { ...io.status, active: ["ses_1"] };
    expect((await readTasks(h.ctx)).tasks[0]?.state).toBe("running");
    // The agent fixed it, pushed, and ended its turn.
    h.clock.advance(5 * MIN);
    io.status = { ...io.status, active: [] };
    io.git = { unpushed: 0, tasks: { ses_1: { commits: [] } } };
    const [d] = (await readTasks(h.ctx)).tasks;
    expect(d).toMatchObject({ state: "done", unseen: true, notify: { state: "done" } });
    expect(taskResult("ws-test", d as TaskRecord).jobs).toEqual([
      { id: "job-abc123", name: "npm run", state: "failed", exit: 1 },
    ]);
    expect(io.replies).toBe(0);
  });

  it("a cold pause under a job records it stopped by the pause, and the task stays stopped after the wake", async () => {
    const { h, io } = workspace({ warmMinutes: 0 });
    await started(h);
    io.status = { active: [], sessions: ended, jobs: [jobRow({ state: "running" })] };
    await readTasks(h.ctx);
    await runPause(h.newOp(), { op: "pause" });
    const [t] = await saved(h);
    expect(t).toMatchObject({
      state: "stopped",
      jobs: [{ id: "job-abc123", state: "stopped", stoppedBy: "pause" }],
    });
    expect(taskResult("ws-test", t as TaskRecord).jobs?.[0]?.state).toBe("stopped");

    await runSpawn(h.newOp(), { op: "spawn", password: "tok-123456" });
    io.status = { active: [], sessions: ended, jobs: [jobRow({ state: "stopped", stoppedBy: "pause" })] };
    expect((await readTasks(h.ctx)).tasks[0]?.state).toBe("stopped");
  });

  it("an older status script with no jobs keeps what the task had", async () => {
    const { h, io } = workspace();
    await started(h);
    io.status = {
      active: ["ses_1"],
      sessions: { ses_1: { found: true } },
      jobs: [jobRow({ state: "running" })],
    };
    await readTasks(h.ctx);
    const { jobs: _, ...old } = io.status;
    io.status = old as typeof io.status;
    expect((await readTasks(h.ctx)).tasks[0]?.jobs).toHaveLength(1);
  });
});

describe("idle pause with a long job", () => {
  it("a running job is use: the workspace stays awake, and pauses idlePauseMinutes after the job ends", async () => {
    const { h, io } = workspace({ idlePauseMinutes: 20 });
    await started(h);
    io.jobsRunning = 1;
    for (let i = 0; i < 90; i++) {
      h.clock.advance(MIN);
      expect(await idleTick(h.newOp(), undefined)).toBe(false);
    }
    io.jobsRunning = 0;
    h.clock.advance(19 * MIN);
    expect(await idleTick(h.newOp(), undefined)).toBe(false);
    h.clock.advance(2 * MIN);
    expect(await idleTick(h.newOp(), undefined)).toBe(true);
    expect((await loadOrb(h.kv))?.lastStop?.reason).toMatch(/no job/);
  });

  it("maxAwakeHours still pauses a workspace with a running job: it is the cost guard", async () => {
    const { h, io } = workspace({ idlePauseMinutes: 20, maxAwakeHours: 2 });
    await started(h);
    io.jobsRunning = 1;
    h.clock.advance(2 * 60 * MIN);
    expect(await idleTick(h.newOp(), undefined)).toBe(false);
    await runAlarm(h.newOp());
    expect((await loadOrb(h.kv))?.state).toMatch(/paused/);
  });
});

// The real job command, against a stub OpenCode on localhost.
const JOB_SH = fileURLToPath(new URL("../../image/job.sh", import.meta.url));
const hasPython = spawnSync("python3", ["--version"]).status === 0;

interface Stub {
  server: Server;
  active: Set<string>;
  prompts: { session: string; auth: string; text: string }[];
  port: number;
}

async function stubOpenCode(): Promise<Stub> {
  const s = { active: new Set<string>(), prompts: [] as Stub["prompts"] } as Stub;
  s.server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/session/active")
        return res.end(JSON.stringify({ data: Object.fromEntries([...s.active].map((x) => [x, {}])) }));
      const m = /^\/api\/session\/(ses_\w+)\/prompt$/.exec(req.url ?? "");
      if (m && req.method === "POST") {
        s.prompts.push({
          session: m[1] as string,
          auth: req.headers.authorization ?? "",
          text: JSON.parse(body).text,
        });
        return res.end("{}");
      }
      res.end(JSON.stringify({ data: {} }));
    });
  });
  await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", r));
  s.port = (s.server.address() as AddressInfo).port;
  return s;
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function home(stub?: Stub) {
  const h = mkdtempSync(join(tmpdir(), "cfoc-job-"));
  mkdirSync(join(h, ".cf-opencode"), { recursive: true });
  mkdirSync(join(h, "project"));
  if (stub) writeFileSync(join(h, ".cf-opencode", "port"), `${stub.port}\n`);
  return h;
}

function run(h: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [JOB_SH, ...args], {
    cwd: join(h, "project"),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: h, CF_OPENCODE_JOB_TEST_POLL: "0.1", ...env },
    encoding: "utf8",
  });
}

/** As run, without blocking this process: the stub OpenCode answers from it. */
function arun(h: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((ok) =>
    execFile(
      "bash",
      [JOB_SH, ...args],
      {
        cwd: join(h, "project"),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: h, CF_OPENCODE_JOB_TEST_POLL: "0.1", ...env },
      },
      (e, stdout, stderr) => ok({ status: e ? Number(e.code ?? 1) : 0, stdout, stderr }),
    ),
  );
}

const list = (h: string) => JSON.parse(run(h, ["list", "--json"]).stdout).jobs as Record<string, unknown>[];

async function until<T>(f: () => T | undefined, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!hasPython || process.platform !== "linux")("cf-opencode-job", () => {
  it("returns at once with an id and a log; a job that ends records its exit code; no session, no message", async () => {
    const h = home();
    const t0 = Date.now();
    const r = run(h, ["start", "--name", "build", "--", "bash", "-c", "echo one; sleep 1; echo two; exit 3"]);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.status).toBe(0);
    const id = /^(job-[0-9a-f]{6}) started: build$/m.exec(r.stdout)?.[1] as string;
    expect(id).toBeTruthy();
    expect(r.stdout).toContain(`log: ${join(h, ".cf-opencode", "jobs", id, "log")}`);
    expect(r.stderr).toContain("No OpenCode session is tied to this job");
    expect(list(h)[0]).toMatchObject({ id, state: "running", holds: true });

    const w = run(h, ["wait", id, "--timeout", "10"]);
    expect(w.status).toBe(3);
    expect(w.stdout).toContain(`${id} build: failed with exit code 3`);
    expect(list(h)[0]).toMatchObject({ id, state: "failed", exit: 3, reply: "none", holds: false });
    expect(run(h, ["logs", id]).stdout).toBe("one\ntwo\n");
    expect(run(h, ["status", id]).stdout).toContain("command: bash -c echo one; sleep 1; echo two; exit 3");
  });

  it("tells the tied session once, when it is idle, with the exit code and the end of the log", async () => {
    const stub = await stubOpenCode();
    servers.push(stub.server);
    const h = home(stub);
    stub.active.add("ses_abc");
    const env = { OPENCODE_SESSION_ID: "ses_abc", OPENCODE_SERVER_PASSWORD: "pw" };
    const r = await arun(h, ["start", "--", "bash", "-c", "echo built it; exit 0"], env);
    expect(r.stderr).toContain("You can end your turn now");
    // The job ends while the agent still works: the message waits, and the job still holds the task.
    await until(() => list(h).find((j) => j.state === "done"));
    expect(list(h)[0]).toMatchObject({ session: "ses_abc", reply: "pending", holds: true });
    expect(stub.prompts).toEqual([]);
    stub.active.clear();
    await until(() => stub.prompts[0]);
    expect(stub.prompts).toHaveLength(1);
    expect(stub.prompts[0]?.session).toBe("ses_abc");
    expect(stub.prompts[0]?.auth).toBe(`Basic ${Buffer.from("opencode:pw").toString("base64")}`);
    expect(stub.prompts[0]?.text).toMatch(
      /^Automatic message from cf-opencode-job: job job-\w+ \(bash\) done with exit code 0/,
    );
    expect(stub.prompts[0]?.text).toContain("built it");
    expect(stub.prompts[0]?.text).toContain("commit, push");
    const done = await until(() => list(h).find((j) => j.reply === "sent"));
    expect(done.holds).toBe(false);
    expect(typeof done.replyAt).toBe("number");
  });

  it("sends nothing when the agent saw the end itself (wait, status, logs -f)", async () => {
    const stub = await stubOpenCode();
    servers.push(stub.server);
    const h = home(stub);
    stub.active.add("ses_abc");
    const env = { OPENCODE_SESSION_ID: "ses_abc", OPENCODE_SERVER_PASSWORD: "pw" };
    const id = /^(job-\w+)/.exec((await arun(h, ["start", "--", "true"], env)).stdout)?.[1] as string;
    expect((await arun(h, ["wait", id], env)).status).toBe(0);
    stub.active.clear();
    await until(() => list(h).find((j) => j.reply === "seen"));
    expect(stub.prompts).toEqual([]);
  });

  it("ties the job to the one active session when OpenCode gives no session id", async () => {
    const stub = await stubOpenCode();
    servers.push(stub.server);
    const h = home(stub);
    stub.active.add("ses_one");
    await arun(h, ["start", "--", "sleep", "5"], { OPENCODE_SERVER_PASSWORD: "pw" });
    expect(list(h)[0]).toMatchObject({ session: "ses_one" });
    stub.active.add("ses_two");
    await arun(h, ["start", "--", "sleep", "5"], { OPENCODE_SERVER_PASSWORD: "pw" });
    expect(list(h)[0]?.session).toBeUndefined();
    for (const j of list(h)) run(h, ["stop", j.id as string]);
  });

  it("ends a job at its maximum run time, and a stop is a stop with no message", async () => {
    const stub = await stubOpenCode();
    servers.push(stub.server);
    const h = home(stub);
    const env = {
      OPENCODE_SESSION_ID: "ses_abc",
      OPENCODE_SERVER_PASSWORD: "pw",
      CF_OPENCODE_JOB_TEST_MINUTE: "1",
    };
    await arun(h, ["start", "--max-minutes", "1", "--", "sleep", "30"], env);
    const t = await until(() => list(h).find((j) => j.state === "timeout"), 10_000);
    expect(t.exit).toBe(143);
    await until(() => stub.prompts[0]);
    expect(stub.prompts[0]?.text).toContain("stopped at its maximum run time (1 min)");

    const id = /^(job-\w+)/.exec((await arun(h, ["start", "--", "sleep", "30"], env)).stdout)?.[1] as string;
    expect((await arun(h, ["stop", id])).stdout).toContain(`${id} sleep 30: stopped (cf-opencode-job stop)`);
    expect(list(h).find((j) => j.id === id)).toMatchObject({
      state: "stopped",
      stoppedBy: "stop",
      reply: "skipped",
    });
    expect(stub.prompts).toHaveLength(1);
  });

  it("a job saved as running on another boot was stopped by a pause; bad input is one Failed line", () => {
    const h = home();
    const dir = join(h, ".cf-opencode", "jobs", "job-aaaaaa");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "job.json"),
      JSON.stringify({
        id: "job-aaaaaa",
        name: "import",
        state: "running",
        boot: "an-old-boot",
        supervisor: 1,
        started: 1,
      }),
    );
    expect(list(h)[0]).toMatchObject({
      id: "job-aaaaaa",
      state: "stopped",
      stoppedBy: "pause",
      holds: false,
    });
    expect(run(h, ["list"]).stdout).toContain("stopped (the workspace paused or stopped)");

    for (const [args, line] of [
      [["start"], "Failed: no command — fix: cf-opencode-job start -- npm run build"],
      [["start", "--max-minutes", "0", "--", "x"], "Failed: --max-minutes must be 1 to 1440"],
      [["start", "--name", "a;b", "--", "x"], "Failed: bad name a;b"],
      [["status", "job-ffffff"], "Failed: no job job-ffffff — fix: cf-opencode-job list shows the jobs"],
      [["frob"], "Failed: unknown command frob"],
    ] as const) {
      const r = run(h, [...args]);
      expect(r.status).toBe(2);
      expect(r.stderr.split("\n").filter(Boolean)).toHaveLength(1);
      expect(r.stderr).toContain(line);
    }
  });
});

function script(s: string, env: Record<string, string>): Promise<string> {
  return new Promise((ok, fail) =>
    execFile(
      "bash",
      ["-c", s],
      { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } },
      (e, out, err) => (e ? fail(new Error(`${e.message}\n${err}`)) : ok(out)),
    ),
  );
}

describe.skipIf(!hasPython || process.platform !== "linux")("the Worker's scripts read the jobs", () => {
  it("ACTIVITY_SH counts running jobs inside their maximum run time; TASK_STATUS_SH lists them", async () => {
    const h = home();
    const bin = join(h, "fake-job");
    const now = Date.now() / 1000;
    writeFileSync(
      bin,
      `#!/bin/sh\necho '${JSON.stringify({
        jobs: [
          { id: "job-000001", state: "running", deadline: now + 600 },
          { id: "job-000002", state: "running", deadline: now - 1 },
          { id: "job-000003", state: "done", deadline: now + 600 },
        ],
      })}'\n`,
    );
    chmodSync(bin, 0o755);
    expect(await script(ACTIVITY_SH, { CF_OPENCODE_JOB_BIN: bin })).toMatch(/^jobs 1$/m);
    expect(await script(ACTIVITY_SH, { CF_OPENCODE_JOB_BIN: join(h, "missing") })).toMatch(/^jobs 0$/m);

    const stub = await stubOpenCode();
    servers.push(stub.server);
    const out = JSON.parse(
      await script(TASK_STATUS_SH, {
        PORT: String(stub.port),
        OPENCODE_SERVER_PASSWORD: "pw",
        IDS: "",
        CF_OPENCODE_JOB_BIN: bin,
      }),
    );
    expect(out.jobs.map((j: { id: string }) => j.id)).toEqual(["job-000001", "job-000002", "job-000003"]);
  });

  it("TASK_GIT_SH does not count a job's processes as processes left running", async () => {
    const h = home();
    const repo = join(h, "project");
    spawnSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    const r = run(h, ["start", "--", "sleep", "60"]);
    const id = /^(job-\w+)/.exec(r.stdout)?.[1] as string;
    await until(() => (list(h)[0]?.state === "running" ? true : undefined));
    const plain = spawnSync("bash", ["-c", "setsid sleep 61 >/dev/null 2>&1 </dev/null & echo $!"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    try {
      const out = JSON.parse(await script(TASK_GIT_SH, { HOME: h, DIRECTORY: repo, TASKS: "[]", GH: "0" }));
      expect(out.processes).toEqual(["sleep 61"]);
    } finally {
      process.kill(Number(plain), "SIGKILL");
      run(h, ["stop", id]);
    }
    expect(existsSync(join(h, ".cf-opencode", "jobs", id, "log"))).toBe(true);
    expect(readFileSync(join(h, ".cf-opencode", "jobs", id, "job.json"), "utf8")).toContain(
      '"stoppedBy": "stop"',
    );
  });
});
