// Long jobs: `cf-opencode-job` in the workspace (image/job.sh) runs a command apart from the agent's turn.
//
// The Worker reads the jobs with the task states (TASK_STATUS_SH) and for the idle pause (ACTIVITY_SH), from
// `cf-opencode-job list --json`. A running job counts as use, so the workspace stays awake until it ends;
// maxAwakeHours still pauses it, and each job ends at its own maximum run time. A job that OpenCode started
// is tied to that session. Until the job ends and its end message reaches the session, the task is
// `running`: the agent ended its turn on purpose, and the work goes on. The job sends that message itself,
// with OpenCode's prompt call, as `tasks --reply` does.
//
// The agent is root and can write the job files, so every field is checked and bounded here.

/** One job, as a task record keeps it. Only the name, never the command line: the record goes to the notify URL. */
export interface JobFact {
  id: string;
  name: string;
  /** running, done (exit 0), failed, timeout (its maximum run time), stopped (a stop, a pause or a lost supervisor). */
  state: "running" | "done" | "failed" | "timeout" | "stopped";
  exit?: number;
  /** For stopped: pause (the workspace paused or stopped), stop (cf-opencode-job stop), lost. */
  stoppedBy?: "pause" | "stop" | "lost";
  /** The session the job is tied to. */
  session?: string;
  /** The end message: pending (the job ended, the message waits for the session to be idle), sent, seen (the agent saw the end itself), none, skipped, failed, lost. */
  reply?: string;
  /** Epoch ms when the end message went out. */
  replyAt?: number;
}

const JOB_ID_RE = /^job-[0-9a-f]{6}$/;
const SESSION_RE = /^ses[A-Za-z0-9_-]{1,100}$/;
const STATES = new Set(["running", "done", "failed", "timeout", "stopped"]);
const STOPPED_BY = new Set(["pause", "stop", "lost"]);
const REPLIES = new Set(["pending", "sent", "seen", "none", "skipped", "failed", "lost"]);
/** Jobs kept on one task. */
export const MAX_TASK_JOBS = 10;
const MAX_JOBS = 50;

/** The jobs of the status script's output, checked. Anything that is not a job is dropped. */
export function parseJobs(raw: unknown): JobFact[] {
  if (!Array.isArray(raw)) return [];
  const out: JobFact[] = [];
  for (const x of raw.slice(0, MAX_JOBS)) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    if (typeof o.id !== "string" || !JOB_ID_RE.test(o.id)) continue;
    if (typeof o.state !== "string" || !STATES.has(o.state)) continue;
    const j: JobFact = {
      id: o.id,
      name:
        typeof o.name === "string" && o.name.trim()
          ? [...o.name.slice(0, 60)].map((c) => (c.charCodeAt(0) < 32 || c === "\x7f" ? " " : c)).join("")
          : o.id,
      state: o.state as JobFact["state"],
    };
    if (typeof o.exit === "number" && Number.isInteger(o.exit) && o.exit >= 0 && o.exit < 256)
      j.exit = o.exit;
    if (typeof o.stoppedBy === "string" && STOPPED_BY.has(o.stoppedBy))
      j.stoppedBy = o.stoppedBy as JobFact["stoppedBy"];
    if (typeof o.session === "string" && SESSION_RE.test(o.session)) j.session = o.session;
    if (typeof o.reply === "string" && REPLIES.has(o.reply)) j.reply = o.reply;
    if (typeof o.replyAt === "number" && Number.isFinite(o.replyAt) && o.replyAt > 0)
      j.replyAt = Math.round(o.replyAt * 1000);
    out.push(j);
  }
  return out;
}

/** The jobs tied to one session, newest first, for its task record. */
export function jobsOf(jobs: JobFact[], session: string): JobFact[] {
  return jobs.filter((j) => j.session === session).slice(0, MAX_TASK_JOBS);
}

/**
 * How many of a session's jobs keep its task running: a job that runs, one whose end message waits for the
 * session, and one whose message went out less than `graceMs` ago (OpenCode shows the turn before it until
 * its loop takes the message).
 */
export function holdingJobs(jobs: JobFact[], now: number, graceMs: number): number {
  return jobs.filter(
    (j) =>
      j.state === "running" ||
      j.reply === "pending" ||
      (j.reply === "sent" && j.replyAt !== undefined && now - j.replyAt < graceMs),
  ).length;
}

/** The pause stops the workspace under these jobs. Record that before it does. */
export function stopJobs(jobs: JobFact[] | undefined): JobFact[] | undefined {
  return jobs?.map((j) => {
    if (j.state !== "running" && j.reply !== "pending") return j;
    const next: JobFact = { ...j };
    if (j.state === "running") Object.assign(next, { state: "stopped", stoppedBy: "pause" });
    if (j.reply === "pending") next.reply = "lost";
    return next;
  });
}

/**
 * Python for the workspace scripts: the jobs from `cf-opencode-job list --json`, or [] when the image has no
 * such command (a disk from before 0.4) or it fails. Defines jobs().
 */
export const JOBS_PY = `
def jobs():
    import json as _j, subprocess as _s
    try:
        r = _s.run([os.environ.get("CF_OPENCODE_JOB_BIN") or "/usr/local/bin/cf-opencode-job", "list", "--json"],
                   capture_output=True, text=True, timeout=10)
        return (_j.loads(r.stdout).get("jobs") or []) if r.returncode == 0 else []
    except Exception:
        return []
`;
