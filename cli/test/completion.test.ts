import { describe, expect, it } from "vitest";
import { completeWords, completionScript } from "../src/completion.js";

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

  it("prints a script for each shell that calls back into the CLI, and refuses an unknown shell", () => {
    for (const shell of ["bash", "zsh", "fish"])
      expect(completionScript(shell)).toContain("cf-opencode __complete");
    expect(() => completionScript("tcsh")).toThrow(/no completion.*fix:/);
  });
});
