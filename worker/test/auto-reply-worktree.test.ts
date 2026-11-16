// The automatic reply and run --worktree together: git facts belong to one checkout, so the reply goes only
// to the task whose own checkout has work that is not safe, and only when that checkout answered.
import { describe, expect, it } from "vitest";
import { TASK_REPLY_SH } from "../src/orb/auto-reply";
import { runSpawn } from "../src/orb/spawn";
import { TASK_GIT_SH, TASK_START_SH, TASK_STATUS_SH } from "../src/orb/task-scripts";
import { readTasks, startTask } from "../src/orb/tasks";
import { makeOrbCtx } from "./fake-registry";

const SHA = (c: string) => c.repeat(40);
const WORKTREE = "/home/user/worktrees/task-2";

/** Two tasks: ses_1 in the workspace checkout, ses_2 in a worktree. `git` answers for one directory. */
async function twoTasks(git: (dir: string, ids: string[]) => string) {
  const h = makeOrbCtx();
  h.ctx.env.CONTROL_TOKEN = "control";
  const io = { n: 0, ended: false, replies: [] as string[], gitDirs: [] as string[] };
  const inner = h.fake.handler;
  h.fake.handler = (cmd, opts, fake) => {
    const env = opts.env ?? {};
    if (cmd[2] === TASK_START_SH) {
      io.n++;
      const spec = JSON.parse(env.TASK ?? "{}");
      return JSON.stringify({
        id: `ses_${io.n}`,
        title: "",
        base: SHA("a"),
        ...(spec.worktree ? { worktree: WORKTREE } : {}),
      });
    }
    if (cmd[2] === TASK_STATUS_SH) {
      const ids = (env.IDS ?? "").split(" ").filter(Boolean);
      const sessions = Object.fromEntries(
        ids.map((id) => [id, io.ended ? { found: true, outcome: "succeeded", last: "Result: ok" } : { found: true }]),
      );
      return JSON.stringify({ active: io.ended ? [] : ids, sessions });
    }
    if (cmd[2] === TASK_GIT_SH) {
      const dir = env.DIRECTORY ?? "";
      io.gitDirs.push(dir);
      return git(dir, (JSON.parse(env.TASKS ?? "[]") as { id: string }[]).map((t) => t.id));
    }
    if (cmd[2] === TASK_REPLY_SH) {
      io.replies.push(env.SESSION ?? "");
      return '{"ok": true}';
    }
    return inner(cmd, opts, fake);
  };
  await runSpawn(h.newOp(), { op: "spawn", password: "tok-123456" });
  await startTask(h.ctx, { text: "one" });
  await startTask(h.ctx, { text: "two", worktree: true });
  await readTasks(h.ctx);
  io.ended = true;
  return { h, io };
}

const facts = (ids: string[], unpushed?: number) =>
  JSON.stringify({
    branch: "fix",
    ...(unpushed ? { unpushed } : {}),
    tasks: Object.fromEntries(ids.map((id) => [id, { commits: [] }])),
  });

describe("automatic reply with a worktree task", () => {
  it("goes only to the task whose own checkout has commits that are not pushed", async () => {
    const { h, io } = await twoTasks((dir, ids) => facts(ids, dir === WORKTREE ? 2 : undefined));
    const list = await readTasks(h.ctx);
    expect(new Set(io.gitDirs).has(WORKTREE)).toBe(true);
    expect(new Set(io.gitDirs).size).toBe(2);
    expect(io.replies).toEqual(["ses_2"]);
    const byId = Object.fromEntries(list.tasks.map((t) => [t.id, t]));
    expect(byId.ses_1).toMatchObject({ state: "done" });
    expect(byId.ses_1?.autoReply).toBeUndefined();
    expect(byId.ses_2).toMatchObject({ state: "running", unpushed: 2, autoReply: { status: "sent" } });
  });

  it("the checkout's unpushed commits do not reach the worktree task", async () => {
    const { h, io } = await twoTasks((dir, ids) => facts(ids, dir === WORKTREE ? undefined : 3));
    const list = await readTasks(h.ctx);
    expect(io.replies).toEqual(["ses_1"]);
    expect(list.tasks.find((t) => t.id === "ses_2")).toMatchObject({ state: "done" });
    expect(list.tasks.find((t) => t.id === "ses_2")?.unpushed).toBeUndefined();
  });

  it("sends nothing to a task whose checkout did not answer in this read", async () => {
    const { h, io } = await twoTasks((dir, ids) => (dir === WORKTREE ? "not json" : facts(ids)));
    const list = await readTasks(h.ctx);
    expect(io.replies).toEqual([]);
    expect(list.tasks.find((t) => t.id === "ses_2")).toMatchObject({ state: "done" });
    expect(list.tasks.find((t) => t.id === "ses_2")?.autoReply).toBeUndefined();
  });
});
