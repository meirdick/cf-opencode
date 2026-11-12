import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { opencodeConfig } from "../src/orb/ai";
import { PREPARE_SH, SERVE_SH } from "../src/orb/scripts";

// Runs the real script in bash. PATH has no opencode, so it stops before it starts a server.
function serve(home: string, env: Record<string, string>) {
  return spawnSync("bash", ["-c", SERVE_SH], {
    env: { HOME: home, PATH: "/usr/bin:/bin", DIRECTORY: join(home, "project"), ...env },
    encoding: "utf8",
  });
}

describe.skipIf(process.platform === "win32")("SERVE_SH model config", () => {
  it("saves the config for OpenCode in a shell or SSH session, and removes it when AI is off", () => {
    const home = mkdtempSync(join(tmpdir(), "cfoc-serve-"));
    const file = join(home, ".cf-opencode", "opencode-config.json");
    const config = opencodeConfig("cloudflare-workers-ai/@cf/zai-org/glm-5.3");

    const on = serve(home, { OPENCODE_CONFIG_CONTENT: config });
    expect(on.stderr).toContain("opencode is not installed");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(JSON.parse(config));

    serve(home, {});
    expect(existsSync(file)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("SERVE_SH agent notes", () => {
  it("writes the notes for the agent, and leaves a file the user wrote alone", () => {
    const home = mkdtempSync(join(tmpdir(), "cfoc-notes-"));
    const notes = join(home, ".config", "opencode", "AGENTS.md");
    serve(home, {});
    expect(readFileSync(notes, "utf8")).toMatch(/cf-opencode-browse/);
    expect(readFileSync(notes, "utf8")).toContain("`sudo apt-get install <package>`");

    writeFileSync(notes, "# mine\n");
    serve(home, {});
    expect(readFileSync(notes, "utf8")).toBe("# mine\n");
  });
});

describe.skipIf(process.platform === "win32")("PREPARE_SH", () => {
  const git = (cwd: string, ...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd,
      encoding: "utf8",
    });
  const prepare = (home: string, env: Record<string, string>) =>
    spawnSync("bash", ["-c", PREPARE_SH], {
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        DIRECTORY: join(home, "project"),
        ...env,
      },
      encoding: "utf8",
    });

  it("starts a branch that is not pushed from the default branch, and still fails on a bad URL", () => {
    const root = mkdtempSync(join(tmpdir(), "cfoc-prepare-"));
    const origin = join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    writeFileSync(join(origin, "a.txt"), "a\n");
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "first");

    const pushed = prepare(mkdtempSync(join(root, "h1-")), { REPO_URL: origin, BRANCH: "main" });
    expect(pushed.stdout.trim()).toBe("cloned");

    const home = mkdtempSync(join(root, "h2-"));
    const local = prepare(home, { REPO_URL: origin, BRANCH: "not-pushed" });
    expect(local.status).toBe(0);
    expect(local.stdout).toMatch(/not-pushed is not on the remote/);
    expect(git(join(home, "project"), "branch", "--show-current").stdout.trim()).toBe("not-pushed");
    expect(existsSync(join(home, "project", "a.txt"))).toBe(true);

    const bad = prepare(mkdtempSync(join(root, "h3-")), { REPO_URL: join(root, "missing"), BRANCH: "main" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/git clone exited/);
  });
});
