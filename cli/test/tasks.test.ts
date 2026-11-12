import { describe, expect, it } from "vitest";
import type { RemoteTask, RemoteTasks, TaskState } from "../src/api.js";
import { CliError } from "../src/errors.js";
import {
  exitCodeFor,
  findTask,
  listTasks,
  looksLikeSession,
  renderTask,
  renderTasks,
  WaitTimeout,
  waitTask,
} from "../src/tasks.js";

const now = Date.parse("2026-11-12T12:00:00Z");
const task = (
  id: string,
  minutesAgo: number,
  state: TaskState = "running",
  title = `title ${id}`,
): RemoteTask => ({
  id,
  title,
  started: now - minutesAgo * 60_000,
  state,
});

function client(byWorkspace: Record<string, RemoteTasks | Error>) {
  return {
    tasks: async (id: string) => {
      const v = byWorkspace[id];
      if (!v || v instanceof Error) throw v ?? new Error("Failed: unknown — fix: none");
      return v;
    },
  };
}

describe("task list", () => {
  it("merges every workspace, newest first, and says where each list came from", async () => {
    const r = await listTasks(
      client({
        app: { live: true, tasks: [task("ses_a1", 30, "done"), task("ses_a2", 5, "waiting", "Fix login")] },
        api: { live: false, at: "2026-11-12T10:00:00Z", tasks: [task("ses_b1", 10, "failed")] },
        gone: new Error("Failed: cannot reach the Worker — fix: cf-opencode doctor"),
      }),
      ["app", "api", "gone"],
    );
    expect(r.rows.map((t) => `${t.workspace}/${t.id}`)).toEqual(["app/ses_a2", "api/ses_b1", "app/ses_a1"]);
    const text = renderTasks(r, now);
    expect(text).toMatch(/^WORKSPACE\s+SESSION\s+STATE\s+AGE\s+TITLE/);
    expect(text).toMatch(/app\s+ses_a2\s+waiting\s+5m ago\s+Fix login/);
    expect(text).toMatch(/api\s+ses_b1\s+failed\s+10m ago/);
    expect(text).toContain("states from the last refresh: api (2h ago)");
    expect(text).toContain("! gone: Failed: cannot reach the Worker");
  });

  it("says so when there is nothing to show", async () => {
    expect(renderTasks({ rows: [], workspaces: [] })).toMatch(/No workspaces yet/);
    const r = await listTasks(client({ app: { live: true, tasks: [] } }), ["app"]);
    expect(renderTasks(r, now)).toMatch(/^No tasks yet\. In a git checkout: cf-opencode run "<task>"/);
  });

  it("finds the workspace of a task, or says why not in one line", async () => {
    const c = client({
      app: { live: true, tasks: [task("ses_1", 1), task("ses_2", 1)] },
      api: { live: false, tasks: [task("ses_2", 1)] },
    });
    expect(await findTask(c, ["app", "api"], "ses_1")).toBe("app");
    await expect(findTask(c, ["app", "api"], "ses_9")).rejects.toThrow(/^Failed: no task ses_9 .* — fix: /);
    await expect(findTask(c, ["app", "api"], "ses_2")).rejects.toThrow(
      /in app and api — fix: pass --workspace/,
    );
  });

  it("tells a session id from a workspace id", () => {
    expect(looksLikeSession("ses_abc")).toBe(true);
    expect(looksLikeSession("my-app")).toBe(false);
  });
});

describe("one task", () => {
  it("shows the state, the reason, and the last message", () => {
    const text = renderTask(
      {
        workspace: "app",
        live: false,
        at: "2026-11-12T11:00:00Z",
        task: { ...task("ses_1", 20, "failed"), reason: "rate limited", last: "Tried twice.\nResult: none" },
      },
      now,
    );
    expect(text).toContain("State      failed (rate limited)");
    expect(text).toContain("Read       60m ago; the workspace is not running");
    expect(text).toContain("Last message:\n  Tried twice.\n  Result: none");
    expect(text).toContain("Open: cf-opencode connect app --session ses_1");
  });

  it("exit codes: 0 done, 1 failed, 2 waiting", () => {
    expect([exitCodeFor("done"), exitCodeFor("failed"), exitCodeFor("waiting")]).toEqual([0, 1, 2]);
  });
});

describe("waitTask", () => {
  /** A fake clock: sleep moves time on; answers are taken in order, the last one repeats. */
  function poll(answers: (Partial<{ state: TaskState; live: boolean }> | Error)[]) {
    let t = 0;
    let i = 0;
    const slept: number[] = [];
    const c = {
      task: async (_ws: string, sid: string) => {
        const a = answers[Math.min(i++, answers.length - 1)];
        if (a instanceof Error) throw a;
        return { task: { ...task(sid, 1), state: a?.state ?? "running" }, live: a?.live ?? true };
      },
    };
    const o = {
      intervalMs: 10_000,
      timeoutMs: 60_000,
      now: () => t,
      sleep: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
    };
    return { c, o, slept, calls: () => i };
  }

  it("polls until the task leaves running, one short request each time", async () => {
    const { c, o, slept } = poll([{}, {}, { state: "done" }]);
    const v = await waitTask(c, "app", "ses_1", o);
    expect(v.task.state).toBe("done");
    expect(slept).toEqual([10_000, 10_000]);
  });

  it("returns a waiting task", async () => {
    const { c, o } = poll([{ state: "waiting" }]);
    expect((await waitTask(c, "app", "ses_1", o)).task.state).toBe("waiting");
  });

  it("times out with a clear line", async () => {
    const { c, o } = poll([{}]);
    const e = await waitTask(c, "app", "ses_1", o).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WaitTimeout);
    expect((e as Error).message).toBe(
      "Failed: task ses_1 still runs after 1 min — fix: wait again: cf-opencode tasks ses_1 --workspace app --wait",
    );
  });

  it("rides out a failed poll, and stops when the workspace is not running", async () => {
    const flaky = poll([new Error("Failed: cannot reach the Worker — fix: x"), { state: "done" }]);
    expect((await waitTask(flaky.c, "app", "ses_1", flaky.o)).task.state).toBe("done");

    const stopped = poll([{ live: false }]);
    await expect(waitTask(stopped.c, "app", "ses_1", stopped.o)).rejects.toThrow(
      /^Failed: workspace app is not running, so task ses_1 cannot finish — fix: cf-opencode connect app --session ses_1$/,
    );
    expect(stopped.calls()).toBe(3);
  });

  it("stops at once on a task that is gone", async () => {
    const gone = poll([new CliError("Failed: no task ses_1 in app — fix: cf-opencode tasks lists them", "")]);
    await expect(waitTask(gone.c, "app", "ses_1", gone.o)).rejects.toThrow(/no task ses_1/);
    expect(gone.calls()).toBe(1);
  });
});
