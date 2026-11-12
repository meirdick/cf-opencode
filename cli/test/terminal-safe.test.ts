// Text from a workspace (task titles and summaries, branch names, commit subjects, file names, follow events,
// session titles, logs) is the agent's or a repository's. On a terminal it must not carry escape sequences: an OSC
// can set the window title or write to the clipboard, a CSI can rewrite what was printed above.
import { describe, expect, it } from "vitest";
import { EventNormalizer, renderEvent, SseParser } from "../src/follow.js";
import { renderSessions } from "../src/sessions.js";
import { renderResult } from "../src/task-result.js";
import { renderTasks } from "../src/tasks.js";
import { terminalSafe } from "../src/ui.js";

const ESC = "\u001b";
const OSC52 = `${ESC}]52;c;cm0gLXJmIH4K${ESC}\\`;
const CSI = `${ESC}[2J${ESC}[1A`;
const C1 = "\u009b31m";
const BIDI = "‮";
const hostile = `x${OSC52}${CSI}${C1}${BIDI}\r\u0007y`;

function clean(s: string): void {
  expect(s).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
}

describe("terminal output of remote text", () => {
  it("terminalSafe keeps newlines and tabs and replaces every other control character", () => {
    expect(terminalSafe("a\tb\nc")).toBe("a\tb\nc");
    clean(terminalSafe(hostile));
    expect(terminalSafe(hostile).startsWith("x")).toBe(true);
  });

  it("the result record", () => {
    const out = renderResult({
      id: "ses_1",
      workspace: "app",
      state: "failed",
      title: hostile,
      summary: `${hostile}\nline 2`,
      branch: hostile,
      commits: [{ sha: "a".repeat(40), subject: hostile }],
      changedFiles: [hostile],
      pullRequest: `https://example.com/${hostile}`,
      error: hostile,
      question: hostile,
      structuredError: hostile,
      started: "2026-11-12T10:00:00Z",
      updated: "2026-11-12T10:00:00Z",
    });
    clean(out);
    expect(out).toContain("line 2");
  });

  it("an event stream that never ends a line, or a huge text part, stays bounded", () => {
    const p = new SseParser();
    for (let i = 0; i < 6; i++) p.push("x".repeat(1024 * 1024));
    expect(p.push("\n\ndata: {}\n\n")).toEqual([{ data: "{}" }]);
    const n = new EventNormalizer("ses_1");
    const delta = { type: "session.text.delta", data: { sessionID: "ses_1", delta: "y".repeat(100_000) } };
    for (let i = 0; i < 5; i++) n.push(delta);
    const [ended] = n.push({ type: "session.text.ended", data: { sessionID: "ses_1" } });
    expect(String(ended?.text).length).toBeLessThanOrEqual(64 * 1024);
  });

  it("the task list, the session list and follow events", () => {
    clean(
      renderTasks({
        rows: [{ id: "ses_1", workspace: "app", title: hostile, state: "running", started: 0 }],
        workspaces: [{ id: "app", live: false, error: hostile }],
      }),
    );
    clean(
      renderSessions({
        rows: [{ id: "ses_1", workspace: "app", title: hostile, created: 0, updated: 0 }],
        workspaces: [{ id: "app", live: true }],
      }),
    );
    for (const e of [
      { type: "text" as const, at: "", text: hostile },
      { type: "tool" as const, at: "", name: hostile, input: hostile },
      { type: "tool.failed" as const, at: "", name: "bash", error: hostile },
      { type: "question" as const, at: "", text: hostile },
      { type: "turn.ended" as const, at: "", outcome: "failed", error: hostile },
    ])
      clean(renderEvent(e) ?? "");
  });
});
