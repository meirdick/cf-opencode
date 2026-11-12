// cf-opencode CLI. One command does the thing: `cf-opencode connect`.
import { readFileSync, rmSync } from "node:fs";
import { ControlClient } from "./api.js";
import { type FlagSpec, flagBool, flagString, type ParsedArgs, parseArgs } from "./args.js";
import { readControlToken, readInstall, readPassword, readWorkspace, workspacePath } from "./config.js";
import { connect } from "./connect.js";
import { CliError, toFailedLine } from "./errors.js";
import { type InitOptions, init } from "./init.js";
import {
  doctor,
  expiresSoon,
  gitToken,
  listWorkspaces,
  renderChecks,
  renderList,
  uninstall,
} from "./manage.js";
import { preview } from "./preview.js";
import { listSessions, localWorkspaceIds, renderSessions } from "./sessions.js";
import { forgetHostKey, shell, ssh, sshConfigBlock, sshKey, sshProxy, target } from "./terminal.js";
import { fmtAge, makeUi, readSecret } from "./ui.js";
import { runProcess } from "./wrangler.js";

const VERSION = "0.1.0";

const GLOBAL: FlagSpec = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  url: { type: "string" },
  json: { type: "boolean" },
};

interface Command {
  group: "Set up" | "Workspaces" | "Terminal" | "Browser";
  usage: string;
  summary: string;
  flags: FlagSpec;
  details?: string[];
  run: (args: ParsedArgs) => Promise<number>;
}

const COMMANDS: Record<string, Command> = {
  connect: {
    group: "Workspaces",
    usage: "connect [workspace]",
    summary: "Wake or create a workspace and open it in local OpenCode.",
    details: [
      "--dir <path>        project directory inside the workspace (default /home/user/project)",
      "--repo <url>        git remote to clone when the workspace has no snapshot yet",
      "--branch <name>     branch to check out",
      "--no-attach         print the server URL instead of opening OpenCode",
      "--continue, -c      open the workspace's last session",
      "--session, -s <id>  open that session (the ses_… id OpenCode prints on exit)",
      "--url <url>         Worker URL (default: ~/.cf-opencode/install.json)",
    ],
    flags: {
      dir: { type: "string" },
      repo: { type: "string" },
      branch: { type: "string" },
      "no-attach": { type: "boolean" },
      continue: { type: "boolean", short: "c" },
      session: { type: "string", short: "s" },
    },
    run: connectCommand,
  },
  status: {
    group: "Workspaces",
    usage: "status [workspace]",
    summary: "Show one workspace, or the install.",
    flags: {},
    run: statusCommand,
  },
  logs: {
    group: "Workspaces",
    usage: "logs <workspace>",
    summary: "Redacted opencode serve log.",
    flags: { lines: { type: "string" } },
    run: logsCommand,
  },
  pause: {
    group: "Workspaces",
    usage: "pause <workspace>",
    summary: "Snapshot the disk and scale the workspace to zero.",
    flags: {},
    run: (args) => opCommand(args, "pause"),
  },
  delete: {
    group: "Workspaces",
    usage: "delete <workspace>",
    summary: "Destroy the workspace. Its snapshot data expires on its own.",
    flags: {},
    run: (args) => opCommand(args, "delete"),
  },
  list: {
    group: "Workspaces",
    usage: "list",
    summary: "Workspaces this machine connected to, with their state.",
    flags: {},
    run: listCommand,
  },
  sessions: {
    group: "Workspaces",
    usage: "sessions [workspace]",
    summary: "OpenCode sessions across your workspaces, newest first. Wakes nothing.",
    details: [
      "A running workspace answers live. A paused one answers with the list saved at its last pause.",
      "Open a session: cf-opencode connect <workspace> --session <session>",
    ],
    flags: {},
    run: sessionsCommand,
  },
  rebuild: {
    group: "Workspaces",
    usage: "rebuild <workspace>",
    summary: "Move a workspace onto the deployed image, keeping /home/user. Stops its agent.",
    details: [
      "A paused workspace restores the tools of the image it first booted, even after cf-opencode upgrade.",
      "rebuild copies /home/user (the project, dotfiles, caches, ~/.local) and the SSH host keys into the",
      "current image and saves that as the workspace's disk. Packages installed outside /home/user (apt) are",
      "not carried. cf-opencode status <workspace> says when the image is out of date.",
    ],
    flags: {},
    run: (args) => opCommand(args, "rebuild"),
  },
  init: {
    group: "Set up",
    usage: "init",
    summary: "Check this machine and your Cloudflare account, deploy, and save the install.",
    details: [
      "--account <id>       account, when the login can see more than one (or CLOUDFLARE_ACCOUNT_ID)",
      "--name <name>        Worker name (default cf-opencode)",
      "--token-file <path>  Cloudflare API token file. Default: CLOUDFLARE_API_TOKEN, else wrangler login",
      "--adopt              replace a Worker of that name this machine did not deploy",
      "--url <url>          deploy nothing; use a Worker deployed from another machine",
      "                     (needs its control token in ~/.cf-opencode/control-token or CF_OPENCODE_CONTROL_TOKEN)",
      "--yes                never prompt (also implied by --json and a non-terminal stdin)",
      "--no-github          do not set up GitHub now (later: cf-opencode git-token)",
      "GitHub: init gives workspaces this machine's gh login, or asks for a token once, so private",
      "repositories, push and gh work. The token is a Worker secret; it never enters a workspace.",
      "Needs Node 22+, Docker running, and an account on Workers Paid.",
    ],
    flags: {
      "token-file": { type: "string" },
      account: { type: "string" },
      name: { type: "string" },
      adopt: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      "no-github": { type: "boolean" },
    },
    run: (args) => initCommand(args),
  },
  upgrade: {
    group: "Set up",
    usage: "upgrade",
    summary: "Redeploy the Worker and image from this CLI version. Keeps the control token.",
    details: ["--token-file <path>  Cloudflare API token file", "--yes                never prompt"],
    flags: {
      "token-file": { type: "string" },
      yes: { type: "boolean", short: "y" },
      "no-github": { type: "boolean" },
    },
    run: (args) => initCommand(args, true),
  },
  uninstall: {
    group: "Set up",
    usage: "uninstall [--yes]",
    summary: "List, then with --yes delete, the Worker, its container app and images.",
    details: [
      "--token-file <path>  Cloudflare API token file",
      "--yes                delete; without it, a dry run",
    ],
    flags: { "token-file": { type: "string" }, yes: { type: "boolean", short: "y" } },
    run: uninstallCommand,
  },
  "git-token": {
    group: "Set up",
    usage: "git-token [--remove]",
    summary: "Let workspaces use GitHub (private clones, push, gh). The token stays in the Worker.",
    details: [
      "Reads the token from stdin, or asks for it on a terminal without echo. Never an argument.",
      "  gh auth token | cf-opencode git-token",
      "A fine-grained token with Contents read and write on the repositories you work on is enough;",
      "add Pull requests read and write for gh pr. Every github.com request from a workspace carries it.",
      "--remove             delete it from the Worker",
      "--token-file <path>  Cloudflare API token file (default: wrangler login or CLOUDFLARE_API_TOKEN)",
    ],
    flags: { remove: { type: "boolean" }, "token-file": { type: "string" } },
    run: async (args) => {
      const ui = makeUi(flagBool(args, "json"));
      const remove = flagBool(args, "remove");
      const tokenFile = flagString(args, "token-file");
      const r = await gitToken({
        remove,
        run: runProcess,
        ui,
        ...(remove ? {} : { token: await readSecret("GitHub token (input hidden): ") }),
        ...(tokenFile ? { apiToken: readFileSync(tokenFile, "utf8").trim() } : {}),
      });
      ui.result({ ok: true, removed: remove, ...r });
      return 0;
    },
  },
  shell: {
    group: "Terminal",
    usage: "shell <workspace>",
    summary: "Open a terminal in the workspace, inside tmux. Closing it does not stop what runs there.",
    details: [
      "--session <name>   tmux session to attach or create (default main)",
      "Detach with the tmux prefix, then d (ctrl-b d). A dropped connection also detaches;",
      "run the same command to reattach.",
    ],
    flags: { session: { type: "string" } },
    run: async (args) => {
      const { url } = requireUrl(args);
      return shell(target(url, args.positionals[0]), flagString(args, "session") ?? "main");
    },
  },
  ssh: {
    group: "Terminal",
    usage: "ssh <workspace> [-- ssh args]",
    summary: "SSH into the workspace as user, over the Worker. Needs the system ssh.",
    flags: {},
    run: async (args) => {
      const [id, ...extra] = args.positionals;
      if (!id) throw new CliError("ssh needs a workspace id", "cf-opencode ssh <workspace>");
      const { url } = requireUrl(args);
      target(url, id);
      return ssh(id, extra, flagString(args, "url"));
    },
  },
  "ssh-config": {
    group: "Terminal",
    usage: "ssh-config <workspace>",
    summary: "Print a ~/.ssh/config Host block, so ssh, scp and herdr reach the workspace by name.",
    flags: {},
    run: async (args) => {
      const id = args.positionals[0];
      if (!id) throw new CliError("ssh-config needs a workspace id", "cf-opencode ssh-config <workspace>");
      target(requireUrl(args).url, id);
      process.stdout.write(`${sshConfigBlock(id, sshKey().path, flagString(args, "url"))}\n`);
      return 0;
    },
  },
  "ssh-proxy": {
    group: "Terminal",
    usage: "ssh-proxy <workspace>",
    summary: "ssh ProxyCommand. ssh-config and ssh set it up; you do not run it yourself.",
    flags: {},
    run: async (args) => {
      const id = args.positionals[0];
      const { url } = requireUrl(args);
      const t = target(url, id);
      const pub = `${sshKey().path}.pub`;
      return sshProxy(t, readFileSync(pub, "utf8").trim());
    },
  },
  doctor: {
    group: "Set up",
    usage: "doctor",
    summary: "Check this machine, the install and the Worker. Never starts a workspace.",
    flags: {},
    run: doctorCommand,
  },
  browse: {
    group: "Browser",
    usage: "browse <workspace>",
    summary: "Open a browser session for a workspace and print its address.",
    details: [
      "Billing is per browser hour on your Cloudflare account. A session closes",
      "after 10 minutes without activity. The account token never enters the workspace.",
    ],
    flags: {},
    run: browseCommand,
  },
  preview: {
    group: "Browser",
    usage: "preview <workspace> <port>",
    summary: "Open a dev server that runs in the workspace, in your browser. No public URL.",
    details: [
      "Prints the preview URL and opens it, signed in, with a one-time link. The password is not in the URL.",
      "The dev server must listen on 0.0.0.0. A paused workspace is not woken: cf-opencode connect first.",
      "--no-open           print the URL and the one-time sign-in link; open nothing",
      "--public            make a URL that needs no password, until --stop. Needs the control token",
      "--stop              remove the public URL of <port>, or of every port without one",
      "--list              list the public URLs of the workspace",
    ],
    flags: {
      "no-open": { type: "boolean" },
      public: { type: "boolean" },
      stop: { type: "boolean" },
      list: { type: "boolean" },
    },
    run: async (args) => {
      const [id, port] = args.positionals;
      if (!id) throw new CliError("preview needs a workspace id", "cf-opencode preview <workspace> <port>");
      return preview({
        id,
        ...(port ? { port } : {}),
        public: flagBool(args, "public"),
        stop: flagBool(args, "stop"),
        list: flagBool(args, "list"),
        open: !flagBool(args, "no-open") && Boolean(process.stdout.isTTY),
        json: flagBool(args, "json"),
        target: () => target(requireUrl(args).url, id),
        control: () => {
          const { url, token } = requireInstall(args);
          return new ControlClient(url, token);
        },
        out: (s) => process.stdout.write(`${s}\n`),
        err: (s) => process.stderr.write(`${s}\n`),
      });
    },
  },
};

export function helpText(): string {
  const cmds = Object.values(COMMANDS);
  const w = Math.max(...cmds.map((c) => c.usage.length));
  const groups = ["Set up", "Workspaces", "Terminal", "Browser"] as const;
  return [
    `cf-opencode ${VERSION}: OpenCode workspaces on Cloudflare Containers, in your own account.`,
    "",
    "Usage: cf-opencode <command> [options]",
    ...groups.flatMap((g) => [
      "",
      `${g}:`,
      ...cmds.filter((c) => c.group === g).map((c) => `  ${c.usage.padEnd(w)}  ${c.summary}`),
    ]),
    "",
    "Global options:",
    "  --url <url>     Worker URL (default: ~/.cf-opencode/install.json or CF_OPENCODE_URL)",
    "  --json          print one JSON document on stdout; progress stays on stderr",
    "  -h, --help      help for a command: cf-opencode <command> --help",
    "  -v, --version",
    "",
    "First time: cf-opencode init deploys into your Cloudflare account.",
    "Then, from any git checkout: cf-opencode connect.",
  ].join("\n");
}

export async function main(argv: string[]): Promise<number> {
  const name = findCommand(argv);
  const cmd = name ? COMMANDS[name] : undefined;
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!name || argv.includes("--help") || argv.includes("-h")) {
    const details = cmd?.details ? `\nOptions:\n${cmd.details.map((d) => `  ${d}`).join("\n")}\n` : "";
    process.stdout.write(
      `${cmd ? `Usage: cf-opencode ${cmd.usage}\n\n${cmd.summary}\n${details}` : helpText()}\n`,
    );
    return name && !cmd ? 2 : 0;
  }
  if (!cmd) {
    process.stderr.write(`Failed: unknown command ${name} — fix: cf-opencode --help\n`);
    return 2;
  }
  let args: ParsedArgs;
  try {
    args = parseArgs(argv, { ...GLOBAL, ...cmd.flags });
  } catch (e) {
    process.stderr.write(`${toFailedLine(e)}\n`);
    return 2;
  }
  args.positionals.shift();
  try {
    return await cmd.run(args);
  } catch (e) {
    if (flagBool(args, "json"))
      process.stdout.write(`${JSON.stringify({ ok: false, error: toFailedLine(e) })}\n`);
    else process.stderr.write(`${toFailedLine(e)}\n`);
    return 1;
  }
}

async function connectCommand(args: ParsedArgs): Promise<number> {
  const { url, token } = requireInstall(args);
  const id = args.positionals[0];
  const result = await connect({
    url,
    token,
    ...(id ? { id } : {}),
    ...(flagString(args, "dir") ? { directory: flagString(args, "dir") } : {}),
    ...(flagString(args, "repo") ? { repoUrl: flagString(args, "repo") } : {}),
    ...(flagString(args, "branch") ? { branch: flagString(args, "branch") } : {}),
    attach: !flagBool(args, "no-attach"),
    continueLast: flagBool(args, "continue"),
    ...(flagString(args, "session") ? { session: flagString(args, "session") } : {}),
    onLine: (line) => process.stderr.write(`${line}\n`),
  });
  if (flagBool(args, "json") || flagBool(args, "no-attach")) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, workspace: result.workspace.id, url: result.serverUrl, username: result.username })}\n`,
    );
  }
  return 0;
}

async function statusCommand(args: ParsedArgs): Promise<number> {
  const id = args.positionals[0];
  const { url, token } = requireInstall(args);
  const client = new ControlClient(url, token);
  const body = id ? await client.status(id) : await client.installStatus();
  if (flagBool(args, "json")) {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return 0;
  }
  if (!id) {
    const s = body as {
      version: string;
      config?: {
        instance?: { vcpu: number; memoryMib: number; diskMb: number };
        idlePauseMinutes?: number;
        warmMinutes?: number;
      };
    };
    const c = s.config;
    const lines = [`Worker   ${url} (API ${s.version})`];
    if (c?.instance)
      lines.push(
        `Size     ${c.instance.vcpu} vCPU, ${c.instance.memoryMib / 1024} GiB, ${c.instance.diskMb / 1000} GB disk`,
      );
    if (c)
      lines.push(`Idle     pause after ${c.idlePauseMinutes} min, stop ${c.warmMinutes} min after a pause`);
    lines.push("Workspaces: cf-opencode list");
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }
  const s = body as {
    workspace: {
      state: string;
      awakeSince?: string;
      lastStop?: { at: string; reason: string };
      directory?: string;
    };
    containerRunning: boolean;
    imageCurrent?: boolean;
    snapshotExpiresAt?: string;
  };
  const lines = [
    `Workspace  ${id}`,
    `State      ${s.workspace.state}${s.containerRunning ? " (container running)" : ""}`,
  ];
  if (s.workspace.directory) lines.push(`Directory  ${s.workspace.directory}`);
  if (s.containerRunning && s.workspace.awakeSince)
    lines.push(`Awake      since ${fmtAge(s.workspace.awakeSince)}`);
  if (!s.containerRunning && s.workspace.lastStop)
    lines.push(`Stopped    ${fmtAge(s.workspace.lastStop.at)} (${s.workspace.lastStop.reason})`);
  if (s.imageCurrent === false)
    lines.push(`Image      older than the deployed one — cf-opencode rebuild ${id} moves it`);
  if (s.snapshotExpiresAt) {
    const warn = expiresSoon(s.snapshotExpiresAt) ? `  ! connect ${id} now to keep it` : "";
    lines.push(`Snapshot   expires ${fmtAge(s.snapshotExpiresAt)}${warn}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function logsCommand(args: ParsedArgs): Promise<number> {
  const id = args.positionals[0];
  if (!id) throw new CliError("logs needs a workspace id", "cf-opencode logs <workspace>");
  const { url, token } = requireInstall(args);
  const lines = Number(flagString(args, "lines") ?? "100");
  const { log } = await new ControlClient(url, token).logs(id, lines);
  process.stdout.write(log.endsWith("\n") ? log : `${log}\n`);
  return 0;
}

async function opCommand(args: ParsedArgs, op: "pause" | "delete" | "rebuild"): Promise<number> {
  const id = args.positionals[0];
  if (!id) throw new CliError(`${op} needs a workspace id`, `cf-opencode ${op} <workspace>`);
  const local = readWorkspace(id);
  const { url, token } = requireInstall(args);
  const client = new ControlClient(url, token);
  const body: Record<string, unknown> = { op };
  if ((op === "pause" || op === "delete") && local?.snapshotId) body.snapshotId = local.snapshotId;
  const { opId } = await client.submit(id, body);
  const result = await client.wait(opId, (line) => process.stderr.write(`${line}\n`));
  if (result.phase === "failed") throw new CliError(result.error ?? `${op} failed`, `cf-opencode logs ${id}`);
  if (op === "delete") {
    // A deleted workspace leaves cf-opencode list; its password is derived, so nothing is lost.
    rmSync(workspacePath(id), { force: true });
    if (local) rmSync(local.passwordFile, { force: true });
    forgetHostKey(id);
  }
  process.stdout.write(`${id} ${op === "rebuild" ? "rebuilt" : `${op}d`}\n`);
  return 0;
}

async function initCommand(args: ParsedArgs, upgrade = false): Promise<number> {
  const ui = makeUi(flagBool(args, "json"));
  const installed = readInstall();
  if (upgrade && !installed) throw new CliError("nothing to upgrade on this machine", "cf-opencode init");
  const o: InitOptions = {
    ...(flagString(args, "url") && !upgrade ? { url: flagString(args, "url") } : {}),
    ...(flagString(args, "token-file") ? { tokenFile: flagString(args, "token-file") } : {}),
    ...(flagString(args, "account")
      ? { accountId: flagString(args, "account") }
      : upgrade && installed?.accountId
        ? { accountId: installed.accountId }
        : {}),
    ...(flagString(args, "name") ? { name: flagString(args, "name") } : {}),
    adopt: flagBool(args, "adopt"),
    nonInteractive: flagBool(args, "yes") || flagBool(args, "json"),
    noGithub: flagBool(args, "no-github"),
  };
  const result = await init(o, { run: runProcess, ui });
  ui.result({ ok: true, ...result, next: "cf-opencode connect" });
  ui.out("");
  ui.out(`${result.deployed ? (upgrade ? "Upgraded" : "Ready") : "Using"}: ${result.url}`);
  ui.out("");
  ui.out("Next, from any git checkout:");
  ui.out("  cf-opencode connect");
  return 0;
}

async function listCommand(args: ParsedArgs): Promise<number> {
  const { url, token } = requireInstall(args);
  const rows = await listWorkspaces(new ControlClient(url, token));
  if (flagBool(args, "json")) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  else process.stdout.write(`${renderList(rows)}\n`);
  return 0;
}

async function sessionsCommand(args: ParsedArgs): Promise<number> {
  const { url, token } = requireInstall(args);
  const one = args.positionals[0];
  const result = await listSessions(new ControlClient(url, token), one ? [one] : localWorkspaceIds());
  if (flagBool(args, "json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${renderSessions(result)}\n`);
  return 0;
}

async function uninstallCommand(args: ParsedArgs): Promise<number> {
  const ui = makeUi(flagBool(args, "json"));
  const tokenFile = flagString(args, "token-file");
  const res = await uninstall({
    yes: flagBool(args, "yes"),
    run: runProcess,
    ui,
    ...(tokenFile ? { apiToken: readFileSync(tokenFile, "utf8").trim() } : {}),
  });
  ui.result({ ok: true, dryRun: !flagBool(args, "yes"), ...res });
  return 0;
}

async function browseCommand(args: ParsedArgs): Promise<number> {
  const id = args.positionals[0];
  if (!id) throw new CliError("browse needs a workspace id", "cf-opencode browse <workspace>");
  const local = readWorkspace(id);
  if (!local) throw new CliError(`no local password for ${id}`, `cf-opencode connect ${id}`);
  const { url } = requireInstall(args);
  const res = await fetch(`${url.replace(/\/$/, "")}/browse/${id}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${readPassword(local)}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  const body = (await res.json().catch(() => undefined)) as
    | { websocketUrl?: string; liveUrl?: string; error?: string }
    | undefined;
  if (!res.ok || !body?.websocketUrl) {
    throw new CliError(
      body?.error ?? `browse returned ${res.status}`,
      "check the workspace is awake, then retry",
    );
  }
  process.stdout.write(`${body.websocketUrl}\n`);
  if (body.liveUrl) process.stderr.write(`live: ${body.liveUrl}\n`);
  process.stderr.write("billed per browser hour on your Cloudflare account; closes after 10 min idle\n");
  return 0;
}

async function doctorCommand(args: ParsedArgs): Promise<number> {
  const url = flagString(args, "url");
  const checks = await doctor({ ...(url ? { url } : {}), cliVersion: VERSION, run: runProcess });
  if (flagBool(args, "json"))
    process.stdout.write(
      `${JSON.stringify({ ok: !checks.some((c) => c.status === "fail"), checks }, null, 2)}\n`,
    );
  else process.stdout.write(`${renderChecks(checks)}\n`);
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}

/** Shell and SSH need only the Worker URL and the workspace password, not the control token. */
function requireUrl(args: ParsedArgs): { url: string } {
  const url = flagString(args, "url") ?? process.env.CF_OPENCODE_URL ?? readInstall()?.url;
  if (!url) throw new CliError("no Worker URL", "run cf-opencode init, or pass --url");
  return { url };
}

function requireInstall(args: ParsedArgs): { url: string; token: string } {
  const install = readInstall();
  const url = flagString(args, "url") ?? process.env.CF_OPENCODE_URL ?? install?.url;
  const token = readControlToken() ?? process.env.CF_OPENCODE_CONTROL_TOKEN;
  if (!url) throw new CliError("no Worker URL", "run cf-opencode init, or pass --url");
  if (!token) throw new CliError("no control token", "cf-opencode init writes ~/.cf-opencode/control-token");
  return { url, token };
}

function findCommand(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") return argv[i + 1];
    if (a.startsWith("-")) {
      const name = a.replace(/^-+/, "");
      if (!a.includes("=") && GLOBAL[name]?.type === "string") i++;
      continue;
    }
    return a;
  }
  return undefined;
}
