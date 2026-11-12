// Start a task in a workspace that may be paused. A2A's SendMessage calls this through the Durable Object.
//
// `cf-opencode run` wakes the workspace with connect, from the checkout, before it starts the task. An A2A
// caller has no checkout, so the Worker wakes the workspace itself. It can do that only for a workspace that
// was connected at least once: the disk then holds the repository, and the record holds the directory. The
// password is derived from the control token, as admit() in session.ts does for a wake through /oc.
import type { OpRecord, WorkspaceRecord } from "../core/types";
import type { StartResult, TaskInput } from "./tasks";

export interface WakeDeps {
  workspaceId: string;
  running: () => boolean;
  record: () => Promise<WorkspaceRecord | undefined>;
  controlToken?: string | undefined;
  /** Run a spawn op with this password and directory, and resolve when it ends. */
  spawn: (password: string, directory: string | undefined) => Promise<OpRecord | undefined>;
  password: (controlToken: string, workspaceId: string) => Promise<string>;
  start: (input: TaskInput) => Promise<StartResult>;
}

/** Why the Worker cannot wake this workspace, or undefined when it can. */
export function wakeRefusal(
  rec: WorkspaceRecord | undefined,
  id: string,
  controlToken: string | undefined,
): (StartResult & { ok: false }) | undefined {
  if (!rec || rec.state === "none")
    return {
      ok: false,
      status: 404,
      error: `Failed: workspace ${id} was never connected, so the Worker has no repository for it — fix: run cf-opencode connect ${id} once from its git checkout`,
    };
  if (rec.deletedAt || rec.state === "deleted")
    return {
      ok: false,
      status: 410,
      error: `Failed: workspace ${id} is deleted — fix: run cf-opencode connect from its git checkout to make a new one`,
    };
  if (!controlToken)
    return {
      ok: false,
      status: 500,
      error: "Failed: the Worker has no CONTROL_TOKEN — fix: cf-opencode upgrade",
    };
  return undefined;
}

/** Wake the workspace when it is not running, then start the task. */
export async function wakeAndStart(d: WakeDeps, input: TaskInput): Promise<StartResult> {
  if (!d.running()) {
    const rec = await d.record();
    const refused = wakeRefusal(rec, d.workspaceId, d.controlToken);
    if (refused) return refused;
    const op = await d.spawn(await d.password(d.controlToken as string, d.workspaceId), rec?.directory);
    if (op?.phase !== "succeeded") {
      const why = (op?.error ?? "the wake did not finish")
        .replace(/^Failed: /, "")
        .replace(/ — fix: .*$/, "");
      return {
        ok: false,
        status: 503,
        error: `Failed: workspace ${d.workspaceId} did not wake (${why}) — fix: cf-opencode logs ${d.workspaceId}`,
      };
    }
  }
  return d.start(input);
}
