import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { completeWords, completionScript } from "../src/completion.js";
import { localWorkspaceIds } from "../src/sessions.js";

const commands = [
  { name: "connect", flags: ["--continue", "-c", "--session"], workspace: true },
  { name: "completion", flags: [], workspace: false },
  { name: "init", flags: ["--yes"], workspace: false },
];
const complete = (...words: string[]) =>
  completeWords(words, commands, ["--json", "--help"], () => ["api", "app"]);

describe("completion", () => {
  it("completes commands, then workspace ids, then flags", () => {
    expect(complete("")).toEqual(["completion", "connect", "init"]);
    expect(complete("co")).toEqual(["completion", "connect"]);
    expect(complete("connect", "")).toEqual(["api", "app"]);
    expect(complete("connect", "ap")).toEqual(["api", "app"]);
    expect(complete("connect", "app", "")).toEqual([]);
    expect(complete("connect", "--c")).toEqual(["--continue"]);
    expect(complete("connect", "--")).toEqual(["--continue", "--help", "--json", "--session"]);
    expect(complete("init", "")).toEqual([]);
    expect(complete("completion", "")).toEqual(["bash", "fish", "zsh"]);
    expect(complete("--")).toEqual(["--help", "--json"]);
  });

  it("never offers a word with shell syntax: bash puts COMPREPLY on the command line as it is", () => {
    const hostile = [
      "ok-id",
      "$(touch pwned)",
      "`id`",
      "a;rm -rf ~",
      "x\ny",
      "*",
      "\u001b]0;title\u0007",
      "a b",
      "../up",
    ];
    expect(completeWords(["connect", ""], commands, [], () => hostile)).toEqual(["ok-id"]);
  });

  it("lists only workspace files whose name is a workspace id", () => {
    const home = mkdtempSync(join(tmpdir(), "cfoc-complete-"));
    const dir = join(home, ".cf-opencode", "workspaces");
    mkdirSync(dir, { recursive: true });
    for (const name of ["good", "$(id)", "a;b", "-flag"]) writeFileSync(join(dir, `${name}.json`), "{}");
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(localWorkspaceIds()).toEqual(["good"]);
    } finally {
      process.env.HOME = saved;
    }
  });

  it("prints a script for each shell that calls back into the CLI, and refuses an unknown shell", () => {
    for (const shell of ["bash", "zsh", "fish"])
      expect(completionScript(shell)).toContain("cf-opencode __complete");
    expect(() => completionScript("tcsh")).toThrow(/no completion.*fix:/);
  });
});
