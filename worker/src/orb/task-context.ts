// What a handed-off session is told about itself.
//
// Two layers. The workspace notes (SERVE_SH) hold the facts of the machine and are the same for every
// session. This block is for one session that nobody is attached to: it says where the task came from and
// how to behave alone. It goes in as its own message, before the task, so the task text stays the user's.
// It names no host and no person: "the user's machine" is enough.

export type HandoffOrigin = "cli" | "mcp" | "a2a";

export interface Handoff {
  origin: HandoffOrigin;
  /** The branch of the local checkout, when there is one. */
  branch?: string;
  /** The commit the local checkout was on. */
  commit?: string;
  /** True when the local checkout had changes that are not pushed (run --allow-dirty). */
  dirty?: boolean;
}

const ORIGINS: Record<HandoffOrigin, string> = {
  cli: "the cf-opencode CLI (`cf-opencode run`)",
  mcp: "an agent on the user's machine, through the cf-opencode MCP tools",
  a2a: "another agent, through the A2A endpoint of the user's cf-opencode Worker",
};

/** A git branch name, loosely: no space, no control character, none of the characters git refuses. */
function isBranch(s: string): boolean {
  if (s.length < 1 || s.length > 200 || /[\s~^:?*[\\]/.test(s)) return false;
  return [...s].every((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127);
}
const COMMIT_RE = /^[0-9a-f]{7,40}$/;

/** The handoff facts of a request body, or why they are wrong. Unknown keys are refused, not ignored. */
export function parseHandoff(v: unknown): { handoff: Handoff } | { error: string } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "handoff must be an object" };
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!["origin", "branch", "commit", "dirty"].includes(k))
      return { error: `handoff has an unknown key ${k}` };
  if (o.origin !== "cli" && o.origin !== "mcp" && o.origin !== "a2a")
    return { error: "handoff.origin must be cli, mcp or a2a" };
  const handoff: Handoff = { origin: o.origin };
  if (o.branch !== undefined) {
    if (typeof o.branch !== "string" || !isBranch(o.branch))
      return { error: "handoff.branch is not a branch name" };
    handoff.branch = o.branch;
  }
  if (o.commit !== undefined) {
    if (typeof o.commit !== "string" || !COMMIT_RE.test(o.commit))
      return { error: "handoff.commit is not a commit id" };
    handoff.commit = o.commit;
  }
  if (o.dirty !== undefined) {
    if (typeof o.dirty !== "boolean") return { error: "handoff.dirty must be true or false" };
    handoff.dirty = o.dirty;
  }
  return { handoff };
}

/** The block the session reads first. The workspace notes tell the agent what a "# Handoff" block means. */
export function handoffBlock(h: Handoff, taskId?: string): string {
  const start = h.branch
    ? `- Start point: branch \`${h.branch}\`${h.commit ? ` at commit \`${h.commit.slice(0, 12)}\`` : ""} on origin.`
    : "- Start point: the default branch on origin.";
  const local = h.dirty
    ? "- The user's checkout has changes that are not pushed. You cannot see them. Do not assume they exist here."
    : "- The user's checkout had nothing that is not pushed. What you see is what they have.";
  return [
    "# Handoff",
    "",
    `This session was started by ${ORIGINS[h.origin]}. Nobody is attached to it and nobody reads it live.`,
    "",
    start,
    local,
    "- Work alone. Ask a question only when you cannot continue: a question stops the task until the user opens this session.",
    "- Your last message is the result the caller reads. Keep it short and factual.",
    '- Use `cf-opencode-notify "<text>"` only for something the user must know before the task ends.',
    ...(taskId ? [`- This task's id is \`${taskId}\`.`] : []),
    "",
    "The task follows in the next message.",
  ].join("\n");
}
