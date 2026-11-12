import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GithubDeps, setupGithub } from "../src/github.js";
import type { RunOptions, RunResult } from "../src/wrangler.js";

const saved = process.env.HOME;
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "cfoc-gh-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".cf-opencode"), { recursive: true });
  writeFileSync(
    join(home, ".cf-opencode", "install.json"),
    JSON.stringify({ url: "https://cf-opencode.sub.workers.dev", name: "cf-opencode", accountId: "acc1" }),
  );
});
afterEach(() => {
  process.env.HOME = saved;
});

const TOKEN = "gho_exampleexampleexampleexample1234";
const base = { url: "https://cf-opencode.sub.workers.dev", control: "ctl" };

/** A fake gh, wrangler, Worker status and GitHub API. */
function world(o: {
  gh?: string;
  onWorker?: boolean;
  answers?: string[];
  pasted?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const calls: { args: string[]; opts: RunOptions }[] = [];
  const lines: string[] = [];
  const asked: string[] = [];
  const answers = [...(o.answers ?? [])];
  const deps: GithubDeps = {
    run: async (cmd, args, opts = {}): Promise<RunResult> => {
      calls.push({ args: [cmd, ...args], opts });
      if (cmd === "gh")
        return o.gh ? { code: 0, stdout: `${o.gh}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    ui: { json: false, step: (l) => lines.push(l), out: () => {}, result: () => {} },
    env: o.env ?? {},
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? "";
    },
    readSecret: async (q) => {
      asked.push(q);
      return o.pasted ?? "";
    },
    fetch: (async (url: string | URL) =>
      String(url).includes("api.github.com")
        ? new Response(JSON.stringify({ login: "octo" }))
        : new Response(
            JSON.stringify({
              version: "0.1.0",
              bindings: { ai: true, browser: true, github: Boolean(o.onWorker) },
            }),
          )) as typeof fetch,
  };
  const stored = () => calls.find((c) => c.args.includes("secret") && c.args.includes("GITHUB_TOKEN"));
  return { deps, calls, lines, asked, stored };
}

describe("setupGithub", () => {
  it("with --yes, gives workspaces this machine's gh login, through stdin only", async () => {
    const w = world({ gh: TOKEN });
    expect(await setupGithub({ ...base, interactive: false }, w.deps)).toBe("stored");
    expect(w.stored()?.opts.input).toBe(TOKEN);
    expect(w.calls.every((c) => !c.args.join(" ").includes(TOKEN))).toBe(true);
    expect(w.lines.join("\n")).toMatch(/gh login.*--no-github/);
    expect(w.lines.join("\n")).toContain("GitHub user octo");
  });

  it("does nothing when the Worker already has a token", async () => {
    const w = world({ gh: TOKEN, onWorker: true });
    expect(await setupGithub({ ...base, interactive: true }, w.deps)).toBe("already");
    expect(w.calls).toHaveLength(0);
    expect(w.asked).toHaveLength(0);
  });

  it("asks once on a terminal, and Enter accepts the gh login", async () => {
    const w = world({ gh: TOKEN, answers: [""] });
    expect(await setupGithub({ ...base, interactive: true }, w.deps)).toBe("stored");
    expect(w.asked).toHaveLength(1);
    expect(w.stored()?.opts.input).toBe(TOKEN);
  });

  it("takes a pasted token when gh is not logged in, or when the user declines the gh login", async () => {
    const none = world({ pasted: "github_pat_pasted" });
    expect(await setupGithub({ ...base, interactive: true }, none.deps)).toBe("stored");
    expect(none.stored()?.opts.input).toBe("github_pat_pasted");

    const declined = world({ gh: TOKEN, answers: ["n"], pasted: "github_pat_pasted" });
    expect(await setupGithub({ ...base, interactive: true }, declined.deps)).toBe("stored");
    expect(declined.stored()?.opts.input).toBe("github_pat_pasted");
  });

  it("skips, with the command for later, on --no-github, an empty paste, no gh login, or CI", async () => {
    const cases = [
      { w: world({ gh: TOKEN }), o: { ...base, interactive: true, skip: true } },
      { w: world({}), o: { ...base, interactive: true } },
      { w: world({}), o: { ...base, interactive: false } },
      { w: world({ gh: TOKEN, env: { CI: "true" } }), o: { ...base, interactive: false } },
      { w: world({ gh: TOKEN }), o: { ...base, interactive: false, canStore: false } },
    ];
    for (const { w, o } of cases) {
      expect(await setupGithub(o, w.deps)).toBe("skipped");
      expect(w.stored()).toBeUndefined();
      expect(w.lines.join("\n")).toContain("cf-opencode git-token");
    }
  });
});

describe("setupSkill (init)", () => {
  it("installs for the agents that exist on the machine, asks once, and never replaces a file that differs", async () => {
    const { setupSkill } = await import("../src/skill.js");
    const { existsSync, readFileSync } = await import("node:fs");
    const home = mkdtempSync(join(tmpdir(), "cfoc-skill-"));
    const source = join(home, "SKILL.md");
    writeFileSync(source, "skill v1\n");
    const lines: string[] = [];
    const asked: string[] = [];
    const deps = { step: (l: string) => lines.push(l), ask: async (q: string) => (asked.push(q), "") };

    // No agent folder: nothing to do, nothing printed, nothing asked.
    expect(await setupSkill({ interactive: true, home, source }, deps)).toEqual([]);
    expect(lines).toEqual([]);
    expect(asked).toEqual([]);

    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    const done = await setupSkill({ interactive: true, home, source }, deps);
    expect(asked).toHaveLength(1);
    expect(done).toEqual([
      join(home, ".claude", "skills", "cf-opencode-handoff", "SKILL.md"),
      join(home, ".config", "opencode", "skills", "cf-opencode-handoff", "SKILL.md"),
    ]);
    expect(readFileSync(done[0] as string, "utf8")).toBe("skill v1\n");

    // The user edited theirs: an upgrade leaves it and says how to replace it.
    writeFileSync(done[0] as string, "mine\n");
    lines.length = 0;
    await setupSkill({ interactive: false, home, source }, deps);
    expect(readFileSync(done[0] as string, "utf8")).toBe("mine\n");
    expect(lines.join("\n")).toMatch(/Claude Code not installed.*differs/);
    expect(lines.join("\n")).toMatch(/OpenCode is current/);

    lines.length = 0;
    const other = mkdtempSync(join(tmpdir(), "cfoc-skill2-"));
    mkdirSync(join(other, ".claude"));
    expect(await setupSkill({ interactive: false, skip: true, home: other, source }, deps)).toEqual([]);
    expect(existsSync(join(other, ".claude", "skills"))).toBe(false);
    expect(lines[0]).toMatch(/--no-skill/);
  });
});
