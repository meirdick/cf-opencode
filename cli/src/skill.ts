// `cf-opencode skill`: the handoff skill that ships in the package (cli/skill), and its install into an
// agent's skills folder. Claude Code reads ~/.claude/skills/<name>/SKILL.md. OpenCode 2 reads
// ~/.config/opencode/skills/<name>/SKILL.md, and ~/.claude/skills too (opencode.ai/docs/skills).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";

export const SKILL_NAME = "cf-opencode-handoff";

/** SKILL.md in the package. The same path from src (tests) and from dist (the npm package). */
export function skillFile(): string {
  return fileURLToPath(new URL(`../skill/${SKILL_NAME}/SKILL.md`, import.meta.url));
}

export type SkillTarget = { kind: "claude" } | { kind: "opencode" } | { kind: "dir"; dir: string };

/** The folder that gets <SKILL_NAME>/SKILL.md. */
export function skillsRoot(t: SkillTarget, home = homedir()): string {
  if (t.kind === "claude") return join(home, ".claude", "skills");
  if (t.kind === "opencode") return join(home, ".config", "opencode", "skills");
  return t.dir;
}

export interface InstallResult {
  path: string;
  action: "installed" | "unchanged" | "replaced";
}

/** Copy the skill. A file that differs is kept unless force: it may hold the user's own edits. */
export function installSkill(
  t: SkillTarget,
  o: { force?: boolean; home?: string; source?: string } = {},
): InstallResult {
  const content = readFileSync(o.source ?? skillFile(), "utf8");
  const dir = join(skillsRoot(t, o.home), SKILL_NAME);
  const path = join(dir, "SKILL.md");
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") === content) return { path, action: "unchanged" };
    if (!o.force)
      throw new CliError(`${path} exists and differs from this version`, "pass --force to replace it");
    writeFileSync(path, content);
    return { path, action: "replaced" };
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, content);
  return { path, action: "installed" };
}

/** --claude, --opencode or --dir <path>: exactly one. */
export function skillTarget(o: { claude?: boolean; opencode?: boolean; dir?: string }): SkillTarget {
  const n = Number(Boolean(o.claude)) + Number(Boolean(o.opencode)) + Number(o.dir !== undefined);
  if (n !== 1)
    throw new CliError("--install needs one place", "pass --claude, --opencode, or --dir <skills folder>");
  if (o.claude) return { kind: "claude" };
  if (o.opencode) return { kind: "opencode" };
  return { kind: "dir", dir: o.dir as string };
}
