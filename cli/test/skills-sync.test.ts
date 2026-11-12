import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type LocalSkill,
  localSkills,
  pushSkills,
  removeCommand,
  selectSkills,
  skillRoots,
  tarArgs,
  unpackCommand,
} from "../src/skills-sync.js";

function skill(root: string, name: string, files: Record<string, string> = {}) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `# ${name}\n`);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(root, name, f, ".."), { recursive: true });
    writeFileSync(join(root, name, f), text);
  }
}

describe("skills sync", () => {
  it("finds folders with a SKILL.md, the first root winning, and skips odd names", () => {
    const home = mkdtempSync(join(tmpdir(), "cfoc-skills-"));
    const [oc, claude] = skillRoots(home) as [string, string];
    skill(oc, "wrangler");
    skill(claude, "wrangler");
    skill(claude, "cloudflare");
    mkdirSync(join(claude, "not-a-skill"), { recursive: true });
    skill(claude, "bad name; rm -rf");
    const found = localSkills(skillRoots(home));
    expect(found.map((s) => `${s.name}@${s.root === oc ? "opencode" : "claude"}`)).toEqual([
      "cloudflare@claude",
      "wrangler@opencode",
    ]);
    expect(skillRoots(home, "/x")).toEqual(["/x"]);
  });

  it("needs names or --all, and refuses an unknown or a large skill with one line", () => {
    const found: LocalSkill[] = [
      { name: "a", root: "/r", dir: "/r/a", bytes: 10 },
      { name: "big", root: "/r", dir: "/r/big", bytes: 6 * 1024 * 1024 },
    ];
    expect(selectSkills(found, ["a"], false).map((s) => s.name)).toEqual(["a"]);
    expect(() => selectSkills(found, [], false)).toThrow(/needs skill names.*fix:/);
    expect(() => selectSkills(found, ["nope"], false)).toThrow(/no skill nope/);
    expect(() => selectSkills(found, ["big"], false)).toThrow(/over the 5 MB limit/);
    expect(() => selectSkills(found, [], true)).toThrow(/big/);
    expect(() => selectSkills([], [], true)).toThrow(/no skills on this machine/);
  });

  it("builds shell commands only from checked names", () => {
    expect(unpackCommand("wrangler")).toBe(
      "rm -rf ~/.config/opencode/skills/wrangler && mkdir -p ~/.config/opencode/skills/wrangler && tar -xz --no-same-owner -C ~/.config/opencode/skills/wrangler",
    );
    expect(() => unpackCommand("a; curl evil")).toThrow(/bad skill name/);
    expect(removeCommand(["a", "b"])).toBe("cd ~/.config/opencode/skills 2>/dev/null && rm -rf -- a b");
    expect(() => removeCommand(["../x"])).toThrow(/bad skill name/);
    expect(() => removeCommand(["$(id)"])).toThrow(/bad skill name/);
  });

  it("packs a skill without secrets, dependencies or links that leave it, and unpacks it whole", async () => {
    const root = mkdtempSync(join(tmpdir(), "cfoc-pack-"));
    const outside = join(root, "outside-secret");
    writeFileSync(outside, "do not copy");
    skill(root, "demo", {
      "scripts/run.sh": "echo hi\n",
      ".env": "TOKEN=x\n",
      ".env.local": "TOKEN=y\n",
      "node_modules/pkg/index.js": "x\n",
      "id.pem": "key\n",
    });
    // A link inside the skill that points out of it. It must not bring the file along.
    symlinkSync(outside, join(root, "demo", "link"));
    const found = localSkills([root]);
    const demo = found.find((s) => s.name === "demo") as LocalSkill;
    const dest = mkdtempSync(join(tmpdir(), "cfoc-unpack-"));
    const ran: string[] = [];
    await pushSkills(
      "app",
      [demo],
      async (_id, command, stdin) => {
        ran.push(command);
        const tgz = execFileSync((stdin as { cmd: string }).cmd, (stdin as { args: string[] }).args);
        mkdirSync(join(dest, "demo"));
        execFileSync("tar", ["-xz", "-C", join(dest, "demo")], { input: tgz });
        return "";
      },
      () => {},
    );
    expect(ran[0]).toBe(unpackCommand("demo"));
    expect(readFileSync(join(dest, "demo", "SKILL.md"), "utf8")).toBe("# demo\n");
    expect(existsSync(join(dest, "demo", "scripts", "run.sh"))).toBe(true);
    for (const f of [".env", ".env.local", "node_modules", "id.pem"])
      expect(existsSync(join(dest, "demo", f))).toBe(false);
    expect(tarArgs(demo)).toContain("--exclude=.env.*");
    expect(tarArgs(demo)).not.toContain("-h");
    // The link arrives as a link, not as the file: nothing from outside the skill is in the copy.
    expect(lstatSync(join(dest, "demo", "link")).isSymbolicLink()).toBe(true);
    expect(
      execFileSync("tar", ["-tzvf", "-"], { input: execFileSync("tar", tarArgs(demo)) }).toString(),
    ).not.toContain("do not copy");
    // A skill folder that is itself a link (how some tools install skills) is found and packed from its target.
    const linked = mkdtempSync(join(tmpdir(), "cfoc-linked-"));
    symlinkSync(join(root, "demo"), join(linked, "demo"));
    expect(localSkills([linked])[0]?.dir).toBe(realpathSync(join(root, "demo")));
  });
});

describe("default skills", () => {
  it("is empty until set, keeps a sorted list, and skips a name that is gone from this machine", async () => {
    const { readDefaults, writeDefaults, resolveDefaults } = await import("../src/skills-sync.js");
    const file = join(mkdtempSync(join(tmpdir(), "cfoc-def-")), "sub", "skills.json");
    expect(readDefaults(file)).toEqual([]);
    writeDefaults(["wrangler", "cloudflare", "wrangler"], file);
    expect(readDefaults(file)).toEqual(["cloudflare", "wrangler"]);
    expect(() => writeDefaults(["a b"], file)).toThrow(/bad skill name/);
    writeFileSync(file, '{"names":["ok","$(id)",7]}');
    expect(readDefaults(file)).toEqual(["ok"]);
    writeFileSync(file, "not json");
    expect(readDefaults(file)).toEqual([]);

    const found: LocalSkill[] = [
      { name: "cloudflare", root: "/r", dir: "/r/cloudflare", bytes: 10 },
      { name: "huge", root: "/r", dir: "/r/huge", bytes: 9 * 1024 * 1024 },
    ];
    const said: string[] = [];
    const got = resolveDefaults(found, ["cloudflare", "gone", "huge"], (s) => said.push(s));
    expect(got.map((s) => s.name)).toEqual(["cloudflare"]);
    expect(said.join("\n")).toMatch(/gone is not on this machine/);
    expect(said.join("\n")).toMatch(/huge is over 5 MB/);
  });
});
