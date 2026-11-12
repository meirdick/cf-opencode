// `cf-opencode skills`: copy skills from this machine into a workspace, so the remote agent has them.
//
// A workspace starts with OpenCode's own skills only. The user's skills live on this machine, in the
// agent folders. Copying is explicit and by name: a skill can name local tools or hold local paths, and
// what is copied stays on the workspace disk and in its snapshots.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors.js";
import { sshKey, sshOptions } from "./terminal.js";
import { table } from "./ui.js";

export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A skill is instructions and small helpers. Larger than this is something else. */
export const MAX_SKILL_BYTES = 5 * 1024 * 1024;
/** Never copied: version control, dependencies, and files that often hold secrets. */
export const EXCLUDES = [".git", "node_modules", ".env", ".env.*", "*.pem", "*.key", ".DS_Store"];
/** Where OpenCode in the workspace reads skills. */
export const REMOTE_DIR = ".config/opencode/skills";

export interface LocalSkill {
  name: string;
  /** The folder that holds the skill folder. */
  root: string;
  /** The skill folder itself, with a link to it resolved. */
  dir: string;
  bytes: number;
}

/** The folders this machine's agents read skills from, in the order a name is looked up. */
export function skillRoots(home = homedir(), from?: string): string[] {
  if (from) return [from];
  return [
    join(home, ".config", "opencode", "skills"),
    join(home, ".claude", "skills"),
    join(home, ".agents", "skills"),
  ];
}

function dirBytes(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    // A symbolic link is not followed: it could point anywhere on this machine.
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) n += dirBytes(p);
    else if (e.isFile()) n += statSync(p).size;
  }
  return n;
}

/** Skills found on this machine: a folder with a SKILL.md. The first root that has a name wins. */
export function localSkills(roots: string[]): LocalSkill[] {
  const out = new Map<string, LocalSkill>();
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (out.has(name) || !SKILL_NAME_RE.test(name)) continue;
      const dir = join(root, name);
      try {
        // statSync follows a link to the skill folder itself, which is how some tools install skills.
        if (!statSync(dir).isDirectory() || !existsSync(join(dir, "SKILL.md"))) continue;
        const real = realpathSync(dir);
        out.set(name, { name, root, dir: real, bytes: dirBytes(real) });
      } catch {}
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The skills to copy: the named ones, or all with `all`. Fails with one line on a wrong name or a large skill. */
export function selectSkills(found: LocalSkill[], names: string[], all: boolean): LocalSkill[] {
  if (!all && names.length === 0)
    throw new CliError(
      "skills push needs skill names",
      "name them, or pass --all; cf-opencode skills lists them",
    );
  const picked = all
    ? found
    : names.map((n) => {
        if (!SKILL_NAME_RE.test(n))
          throw new CliError(`bad skill name ${JSON.stringify(n)}`, "cf-opencode skills lists them");
        const s = found.find((f) => f.name === n);
        if (!s) throw new CliError(`no skill ${n} on this machine`, "cf-opencode skills lists them");
        return s;
      });
  if (picked.length === 0)
    throw new CliError("no skills on this machine", "put one in ~/.config/opencode/skills");
  for (const s of picked) {
    if (s.bytes > MAX_SKILL_BYTES)
      throw new CliError(
        `skill ${s.name} is ${(s.bytes / 1048576).toFixed(1)} MB, over the 5 MB limit`,
        "remove large files from it, or copy it by hand with cf-opencode ssh",
      );
  }
  return picked;
}

/**
 * tar arguments that pack the content of one skill folder. No -h: a link inside a skill is packed as a
 * link, never as the file it points to, so a skill cannot carry a file from elsewhere on this machine.
 */
export function tarArgs(s: LocalSkill): string[] {
  return ["-cz", ...EXCLUDES.map((e) => `--exclude=${e}`), "-C", s.dir, "."];
}

/** The command the workspace runs to unpack a skill. Names are checked, so they are safe in the shell. */
export function unpackCommand(name: string): string {
  if (!SKILL_NAME_RE.test(name))
    throw new CliError(`bad skill name ${JSON.stringify(name)}`, "rename the skill folder");
  const dir = `~/${REMOTE_DIR}/${name}`;
  return `rm -rf ${dir} && mkdir -p ${dir} && tar -xz --no-same-owner -C ${dir}`;
}

export function removeCommand(names: string[]): string {
  for (const n of names)
    if (!SKILL_NAME_RE.test(n))
      throw new CliError(
        `bad skill name ${JSON.stringify(n)}`,
        "cf-opencode skills --workspace <id> lists them",
      );
  return `cd ~/${REMOTE_DIR} 2>/dev/null && rm -rf -- ${names.join(" ")}`;
}

export const LIST_COMMAND = `for d in ~/${REMOTE_DIR}/*/; do [ -f "$d/SKILL.md" ] && basename "$d"; done 2>/dev/null; true`;

/** Run a command in the workspace over ssh, with optional stdin from a local process. Returns stdout. */
export type RemoteRun = (
  id: string,
  command: string,
  stdin?: { cmd: string; args: string[] },
) => Promise<string>;

export function sshRun(url?: string): RemoteRun {
  return (id, command, stdin) =>
    new Promise((resolve, reject) => {
      const { path } = sshKey();
      const opts = sshOptions(id, path, url).flatMap(([k, v]) => ["-o", `${k}=${v}`]);
      const ssh = spawn("ssh", [...opts, `cf-opencode-${id}`, command], {
        stdio: [stdin ? "pipe" : "ignore", "pipe", "inherit"],
      });
      let out = "";
      ssh.stdout?.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      ssh.on("error", () => reject(new CliError("ssh is not installed here", "install OpenSSH and retry")));
      if (stdin && ssh.stdin) {
        const src = spawn(stdin.cmd, stdin.args, { stdio: ["ignore", "pipe", "inherit"] });
        src.on("error", () =>
          reject(new CliError(`${stdin.cmd} is not installed here`, `install ${stdin.cmd} and retry`)),
        );
        src.stdout?.pipe(ssh.stdin);
      }
      ssh.on("exit", (code) =>
        code === 0
          ? resolve(out)
          : reject(
              new CliError(
                `the workspace command failed (ssh exit ${code})`,
                `cf-opencode connect ${id}, then retry`,
              ),
            ),
      );
    });
}

export async function pushSkills(
  id: string,
  skills: LocalSkill[],
  run: RemoteRun,
  say: (s: string) => void,
): Promise<void> {
  for (const s of skills) {
    await run(id, unpackCommand(s.name), { cmd: "tar", args: tarArgs(s) });
    say(`✓ ${s.name} → ${id}:~/${REMOTE_DIR}/${s.name}`);
  }
}

export async function remoteSkills(id: string, run: RemoteRun): Promise<string[]> {
  return (await run(id, LIST_COMMAND))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => SKILL_NAME_RE.test(l))
    .sort();
}

export function renderSkills(found: LocalSkill[], remote: string[] | undefined, id: string): string {
  if (found.length === 0 && !remote?.length)
    return "No skills on this machine. A skill is a folder with a SKILL.md in ~/.config/opencode/skills or ~/.claude/skills.";
  const names = [...new Set([...found.map((f) => f.name), ...(remote ?? [])])].sort();
  const rows = names.map((n) => {
    const f = found.find((x) => x.name === n);
    return [n, f ? f.root.replace(homedir(), "~") : "-", remote ? (remote.includes(n) ? "yes" : "no") : "?"];
  });
  return `${table(["SKILL", "ON THIS MACHINE", `IN ${id}`], rows)}\n\nCopy: cf-opencode skills push <name...>   Remove: cf-opencode skills remove <name...>`;
}
