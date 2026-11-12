// The result record of a task, as `tasks <session> --json` and `run --wait --json` print it, and its human
// form. The Worker builds the record (worker/src/orb/task-result.ts); this only reads and shows it.
import type { RemoteTask, RemoteTaskOne, TaskResult } from "./api.js";
import { fmtAge } from "./ui.js";

const iso = (ms: number) => new Date(ms).toISOString();

/** The record from a task answer. A Worker before 0.2 sends none: build the part it can. */
export function resultOf(workspace: string, one: Pick<RemoteTaskOne, "task" | "result">): TaskResult {
  if (one.result) return one.result;
  const t: RemoteTask = one.task;
  return {
    id: t.id,
    workspace,
    state: t.state,
    title: t.title,
    summary: t.last ?? "",
    ...((t.state === "failed" || t.state === "stopped") && t.reason ? { error: t.reason } : {}),
    started: iso(t.started),
    updated: iso(Math.max(t.updated ?? 0, t.started)),
  };
}

const MAX_SUMMARY_LINES = 30;
const MAX_FILES_SHOWN = 8;

/** State, summary, then branch, commits and pull request when present. */
export function renderResult(r: TaskResult, o: { live?: boolean; at?: string; now?: number } = {}): string {
  const now = o.now ?? Date.now();
  const lines = [
    `Task       ${r.id}`,
    `Workspace  ${r.workspace}`,
    `State      ${r.state}${r.error ? ` (${r.error})` : ""}`,
    `Title      ${r.title.replace(/\s+/g, " ").slice(0, 100)}`,
    `Started    ${fmtAge(r.started, now)}`,
  ];
  if (o.live === false)
    lines.push(`Read       ${o.at ? fmtAge(o.at, now) : "never"}; the workspace is not running`);
  if (r.summary) {
    const s = r.summary.split("\n");
    lines.push("", "Summary:", ...s.slice(-MAX_SUMMARY_LINES).map((l) => `  ${l}`));
    if (s.length > MAX_SUMMARY_LINES) lines.splice(lines.length - MAX_SUMMARY_LINES, 0, "  …");
  }
  const facts: string[] = [];
  if (r.branch) facts.push(`Branch     ${r.branch}`);
  if (r.commits)
    facts.push(
      `Commits    ${r.commits.length === 0 ? "none" : r.commits.length}`,
      ...r.commits.slice(0, 10).map((c) => `  ${c.sha.slice(0, 7)} ${c.subject}`),
    );
  if (r.pullRequest) facts.push(`PR         ${r.pullRequest}`);
  if (r.changedFiles?.length) {
    const shown = r.changedFiles.slice(0, MAX_FILES_SHOWN).join(", ");
    const more = r.changedFiles.length > MAX_FILES_SHOWN ? `, … (${r.changedFiles.length} files)` : "";
    facts.push(`Changed    ${shown}${more}`);
  }
  if (r.structured !== undefined) facts.push(`Structured ${JSON.stringify(r.structured).slice(0, 200)}`);
  if (r.structuredError) facts.push(`Structured ! ${r.structuredError}`);
  if (r.notified) facts.push(`Notified   ${fmtAge(r.notified.at, now)} (HTTP ${r.notified.status})`);
  if (r.notifyError) facts.push(`Notified   ! ${r.notifyError}`);
  if (facts.length) lines.push("", ...facts);
  lines.push("");
  if (r.state === "waiting") {
    if (r.question) lines.push(`Question: ${r.question}`);
    lines.push("The agent waits for an answer. Answer it in OpenCode:");
  } else if (r.state === "stopped")
    lines.push("The workspace paused under the task. Continue it in OpenCode:");
  lines.push(`Open: cf-opencode connect ${r.workspace} --session ${r.id}`);
  return lines.join("\n");
}
