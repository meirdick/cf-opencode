// The result record of a handed-off task: one stable object for `tasks <session> --json`, `run --wait
// --json`, the notify URL POST, and any other client of the task API. Built from the saved task only, so a
// paused workspace answers it too.
import type { JobFact } from "./jobs";
import type { Commit, TaskRecord, TaskState } from "./tasks";

export interface TaskResult {
  id: string;
  workspace: string;
  state: TaskState;
  title: string;
  /** The last assistant message with text (its end). */
  summary: string;
  /** Read with git in the workspace, not from the agent's words. */
  branch?: string;
  /** Commits made since the task started. An empty list: the task made none. */
  commits?: Commit[];
  pullRequest?: string;
  changedFiles?: string[];
  /** Commits that are only on the workspace disk: no remote branch has them. Absent when there are none. */
  unpushed?: number;
  /** Processes the task left running in the checkout. The next pause stops them. Absent when there are none. */
  processes?: string[];
  /**
   * The long jobs (cf-opencode-job) the task started. A job is not in `processes`. While one runs, or its end
   * message has not reached the agent, the task is running. Absent when there are none.
   */
  jobs?: { id: string; name: string; state: JobFact["state"]; exit?: number }[];
  /** The open permission request or form, when the state is waiting. */
  question?: string;
  /** Why the task failed or stopped. */
  error?: string;
  /** The json block that matched the schema of `run --schema`. */
  structured?: unknown;
  structuredError?: string;
  /**
   * The automatic reply: the task ended its turn with commits that are not pushed or processes left running,
   * and the Worker told the session once. `found` is what it saw. Absent when none was due.
   */
  autoReply?: { at: string; sent: boolean; found: string; error?: string };
  /** The last delivery to the notify URL. */
  notified?: { at: string; status: number };
  notifyError?: string;
  /** ISO times. */
  started: string;
  updated: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function taskResult(workspace: string, t: TaskRecord): TaskResult {
  const r: TaskResult = {
    id: t.id,
    workspace,
    state: t.state,
    title: t.title,
    summary: t.last ?? "",
    started: iso(t.started),
    updated: iso(Math.max(t.updated ?? 0, t.started)),
  };
  if (t.branch) r.branch = t.branch;
  if (t.commits) r.commits = t.commits;
  if (t.pullRequest) r.pullRequest = t.pullRequest;
  if (t.changedFiles) r.changedFiles = t.changedFiles;
  if (t.unpushed) r.unpushed = t.unpushed;
  if (t.processes?.length) r.processes = t.processes;
  if (t.jobs?.length)
    r.jobs = t.jobs.map((j) => ({
      id: j.id,
      name: j.name,
      state: j.state,
      ...(j.exit !== undefined ? { exit: j.exit } : {}),
    }));
  if (t.state === "waiting" && t.question) r.question = t.question;
  if ((t.state === "failed" || t.state === "stopped") && t.reason) r.error = t.reason;
  if (t.structured !== undefined) r.structured = t.structured;
  if (t.structuredError) r.structuredError = t.structuredError;
  if (t.autoReply)
    r.autoReply = {
      at: iso(t.autoReply.at),
      sent: t.autoReply.status === "sent",
      found: t.autoReply.found,
      ...(t.autoReply.error ? { error: t.autoReply.error } : {}),
    };
  if (t.notified) r.notified = { at: t.notified.at, status: t.notified.status };
  if (t.notifyError) r.notifyError = t.notifyError;
  return r;
}
