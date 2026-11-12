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

/** The agents on this machine that read skills: one whose config folder exists. */
export function detectedTargets(home = homedir()): { name: string; target: SkillTarget }[] {
  const out: { name: string; target: SkillTarget }[] = [];
  if (existsSync(join(home, ".claude"))) out.push({ name: "Claude Code", target: { kind: "claude" } });
  if (existsSync(join(home, ".config", "opencode")))
    out.push({ name: "OpenCode", target: { kind: "opencode" } });
  return out;
}

/**
 * The skill step of init: give the agents on this machine the handoff skill, so "run this in the cloud"
 * works with no other setup. It never fails the install, and never replaces a file that differs.
 */
export async function setupSkill(
  o: { interactive: boolean; skip?: boolean; home?: string; source?: string },
  deps: { step: (line: string) => void; ask: (q: string) => Promise<string> },
): Promise<string[]> {
  const later = "later: cf-opencode skill --install --claude (or --opencode)";
  if (o.skip) {
    deps.step(`! handoff skill not installed (--no-skill); ${later}`);
    return [];
  }
  const targets = detectedTargets(o.home);
  if (targets.length === 0) return [];
  const names = targets.map((t) => t.name).join(" and ");
  if (o.interactive) {
    const a = await deps.ask(
      `Install the handoff skill for ${names}? It tells the agent how to hand a task to a workspace. [Y/n] `,
    );
    if (/^n/i.test(a.trim())) {
      deps.step(`! handoff skill not installed; ${later}`);
      return [];
    }
  }
  const done: string[] = [];
  for (const t of targets) {
    try {
      const r = installSkill(t.target, {
        ...(o.home ? { home: o.home } : {}),
        ...(o.source ? { source: o.source } : {}),
      });
      done.push(r.path);
      deps.step(
        r.action === "unchanged"
          ? `✓ Handoff skill for ${t.name} is current`
          : `✓ Handoff skill for ${t.name} installed: ${r.path}`,
      );
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).replace(/^Failed: /, "");
      deps.step(`! handoff skill for ${t.name} not installed: ${why}`);
    }
  }
  return done;
}
