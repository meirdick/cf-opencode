// Run wrangler (the CLI's own pinned dependency) and other tools as child processes, and read their output.
// Patterns from the cf-orbs CLI; no shared code.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CliError } from "./errors.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Written to the child's stdin, then stdin closes. A secret goes here, never in argv. */
  input?: string;
  /** Inherit the terminal (wrangler login). Output is not captured. */
  interactive?: boolean;
  /** Called with each output chunk (stdout and stderr) as it arrives. */
  onOutput?: (chunk: string) => void;
  timeoutMs?: number;
}

export type Runner = (cmd: string, args: string[], o?: RunOptions) => Promise<RunResult>;

/** Spawn without a shell. Stdin is closed unless `input` is given, so wrangler runs non-interactive. */
export const runProcess: Runner = (cmd, args, o = {}) =>
  new Promise((resolve) => {
    const group = !o.interactive && process.platform !== "win32";
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      stdio: o.interactive ? "inherit" : [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      // Own process group, so a timeout can stop the grandchildren too (wrangler starts docker).
      detached: group,
    });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    let timedOut: (() => RunResult) | undefined;
    const finish = (r: RunResult) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (group && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {}
    };
    if (o.timeoutMs) {
      const ms = o.timeoutMs;
      timer = setTimeout(() => {
        timedOut = () => ({
          code: TIMEOUT_CODE,
          stdout,
          stderr: `${stderr}\n${TIMEOUT_MARK} ${Math.round(ms / 1000)}s`,
        });
        signal("SIGTERM");
        // A grandchild that keeps the output pipe open would hold "close" back for ever. Do not wait for it.
        timer = setTimeout(() => {
          signal("SIGKILL");
          if (timedOut) finish(timedOut());
        }, 5_000);
      }, ms);
    }
    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stdout += s;
      o.onOutput?.(s);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stderr += s;
      o.onOutput?.(s);
    });
    if (o.input !== undefined) child.stdin?.end(o.input);
    child.on("error", (e) => finish({ code: 127, stdout, stderr: `${stderr}${e.message}` }));
    child.on("close", (code) => finish(timedOut ? timedOut() : { code: code ?? 1, stdout, stderr }));
  });

/** Exit code and stderr marker of a run that `timeoutMs` stopped. */
export const TIMEOUT_CODE = 124;
export const TIMEOUT_MARK = "cf-opencode: stopped after";

/** The wrangler version the CLI depends on (cli/package.json). */
export const WRANGLER_PIN = "4.156.0";

/** [command, ...prefix args] that runs the pinned wrangler. Prefers the CLI's own dependency over npx. */
export function wranglerCommand(): [string, string[]] {
  try {
    const req = createRequire(import.meta.url);
    const bin = join(dirname(req.resolve("wrangler/package.json")), "bin", "wrangler.js");
    if (existsSync(bin)) return [process.execPath, [bin]];
  } catch {}
  return [process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", `wrangler@${WRANGLER_PIN}`]];
}

export interface Wrangler {
  run(args: string[], o?: RunOptions): Promise<RunResult>;
}

export function makeWrangler(
  run: Runner,
  base: { cwd?: string; accountId?: string; apiToken?: string } = {},
): Wrangler {
  const [cmd, prefix] = wranglerCommand();
  return {
    run(args, o = {}) {
      return run(cmd, [...prefix, ...args], {
        cwd: base.cwd,
        ...o,
        env: {
          WRANGLER_SEND_METRICS: "false",
          FORCE_COLOR: "0",
          ...(base.accountId ? { CLOUDFLARE_ACCOUNT_ID: base.accountId } : {}),
          ...(base.apiToken ? { CLOUDFLARE_API_TOKEN: base.apiToken } : {}),
          ...o.env,
        },
      });
    },
  };
}

export interface Account {
  id: string;
  name: string;
}

export interface WhoAmI {
  loggedIn: boolean;
  email?: string;
  accounts: Account[];
}

/** Parse `wrangler whoami --json`. */
export function parseWhoami(stdout: string): WhoAmI {
  const start = stdout.indexOf("{");
  if (start === -1) return { loggedIn: false, accounts: [] };
  try {
    const j = JSON.parse(stdout.slice(start)) as { loggedIn?: boolean; email?: string; accounts?: Account[] };
    return {
      loggedIn: j.loggedIn === true,
      ...(j.email ? { email: j.email } : {}),
      accounts: (j.accounts ?? []).map((a) => ({ id: a.id, name: a.name })),
    };
  } catch {
    return { loggedIn: false, accounts: [] };
  }
}

/** The workers.dev URL in `wrangler deploy` output, preferring https://<name>.<sub>.workers.dev. */
export function parseWorkerUrl(output: string, name: string): string | undefined {
  const all = [...output.matchAll(/https:\/\/([a-z0-9-]+)\.([a-z0-9-]+)\.workers\.dev\b/gi)].map((m) => m[0]);
  return all.find((u) => u.toLowerCase().startsWith(`https://${name.toLowerCase()}.`)) ?? all[0];
}

/** One `wrangler deploy`. The first image is about 180 MB compressed; a slow uplink needs most of this. */
export const DEPLOY_TIMEOUT_MS = 60 * 60_000;

export type DeployFailure =
  | "retry"
  | "timeout"
  | "paid"
  | "docker"
  | "buildx"
  | "auth"
  | "subdomain"
  | "other";

const PUSH_MARKERS = /Pushed|Layer already exists|already exists remotely|registry\.cloudflare\.com/;
const PUSH_DROPPED =
  /use of closed network connection|connection reset by peer|unexpected EOF|TLS handshake timeout|i\/o timeout|broken pipe/i;

/**
 * Classify a failed deploy. "retry": the registry push flake (timeouts, a 401 after a push), and container
 * app settings that did not apply on a first deploy.
 */
export function classifyDeployFailure(output: string): DeployFailure {
  // The deploy ran out of time: a slow or stalled image upload. Another try would take as long.
  if (output.includes(TIMEOUT_MARK)) return "timeout";
  if (/timeout awaiting response headers/i.test(output)) return "retry";
  // Seen on the first deploy of a new Worker (wrangler 4.156.0); wrangler itself says to re-run.
  if (/Container application settings were not fully applied/i.test(output)) return "retry";
  if (/Unauthorized/.test(output) && PUSH_MARKERS.test(output)) return "retry";
  // A dropped connection in the middle of a layer upload. Docker reports it; the pushed layers are kept.
  if (PUSH_DROPPED.test(output) && PUSH_MARKERS.test(output)) return "retry";
  if (
    /workers paid|paid plan|upgrade your plan|not entitled|entitlement|containers? (?:is|are) not (?:enabled|available)/i.test(
      output,
    )
  ) {
    return "paid";
  }
  if (
    /Cannot connect to the Docker daemon|docker: command not found|The Docker CLI could not be launched|is docker running/i.test(
      output,
    )
  ) {
    return "docker";
  }
  if (/unknown flag: --load|buildx/i.test(output)) return "buildx";
  if (/not logged in|wrangler login|Authentication error|code: 10000\b/i.test(output)) return "auth";
  if (/workers\.dev subdomain/i.test(output)) return "subdomain";
  return "other";
}

export function deployFailureError(kind: DeployFailure, output: string): CliError {
  switch (kind) {
    case "paid":
      return new CliError(
        "Containers need the Workers Paid plan on this account",
        "upgrade at https://dash.cloudflare.com/?to=/:account/workers/plans, then rerun cf-opencode init",
      );
    case "docker":
      return new CliError(
        "Docker is not running (wrangler builds the workspace image locally)",
        "start Docker, check `docker info`, then rerun",
      );
    case "buildx":
      return new CliError(
        "Docker has no buildx plugin (wrangler builds the image with docker buildx)",
        "install it (Debian/Ubuntu: apt install docker-buildx-plugin), check `docker buildx version`, then rerun",
      );
    case "auth":
      return new CliError(
        "wrangler is not logged in, or the token lacks Workers Scripts Write and Workers Containers Write",
        "run npx wrangler login, then rerun cf-opencode init",
      );
    case "subdomain":
      return new CliError(
        "this account has no workers.dev subdomain yet",
        "open https://dash.cloudflare.com/?to=/:account/workers-and-pages once (it creates one), then rerun",
      );
    case "timeout":
      return new CliError(
        `wrangler deploy did not finish in ${DEPLOY_TIMEOUT_MS / 60_000} minutes (a slow or stalled image upload)`,
        "check the connection, then rerun cf-opencode init (pushed layers are kept)",
      );
    case "retry":
      return new CliError(
        "wrangler deploy kept failing on a transient error (image push, or container app settings)",
        "rerun cf-opencode init (pushed layers are kept); if it repeats, read ~/.cf-opencode/deploy.log",
      );
    default:
      return new CliError(
        `wrangler deploy failed: ${lastErrorLine(output)}`,
        "fix the error above, then rerun cf-opencode init",
      );
  }
}

export type WorkerLookup = { kind: "found" } | { kind: "missing" } | { kind: "unknown"; reason: string };

/**
 * Does a Worker with this name exist in the account? Verified with wrangler 4.156.0: an existing Worker
 * exits 0 with a JSON array; a missing one exits 1 with "This Worker does not exist on your account. [code: 10007]".
 */
export async function lookupWorker(w: Wrangler, name: string): Promise<WorkerLookup> {
  const r = await w.run(["deployments", "list", "--json", "--name", name], { timeoutMs: 60_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.code === 0) {
    try {
      if (Array.isArray(JSON.parse(r.stdout.slice(Math.max(0, r.stdout.indexOf("["))))))
        return { kind: "found" };
    } catch {}
    return { kind: "unknown", reason: "unreadable wrangler output" };
  }
  if (/\[code: 10007\]|This Worker does not exist/.test(out)) return { kind: "missing" };
  return { kind: "unknown", reason: lastErrorLine(out) };
}

/** Last meaningful line of wrangler output, preferring the "✘ [ERROR]" line. */
export function lastErrorLine(output: string): string {
  const clean = output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const err = [...lines].reverse().find((l) => /\[ERROR\]/.test(l));
  const pick = err
    ? err.replace(/^.*\[ERROR\]\s*/, "")
    : [...lines].reverse().find((l) => !/Logs were written/.test(l));
  return (pick ?? "no output").replace(/\s+/g, " ").slice(0, 300);
}

/** `wrangler deploy` with up to two retries for the registry flake. Plan, Docker and auth failures do not retry. */
export async function deployWithRetry(
  w: Wrangler,
  name: string,
  o: { onOutput?: (s: string) => void; onRetry?: (attempt: number) => void; retries?: number } = {},
): Promise<{ url: string; attempts: number }> {
  const retries = o.retries ?? 2;
  for (let attempt = 1; ; attempt++) {
    const r = await w.run(["deploy", "--config", "worker/wrangler.jsonc"], {
      timeoutMs: DEPLOY_TIMEOUT_MS,
      ...(o.onOutput ? { onOutput: o.onOutput } : {}),
    });
    const output = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0) {
      const url = parseWorkerUrl(output, name);
      if (!url) {
        throw new CliError(
          "wrangler deploy did not print a workers.dev URL",
          "enable workers.dev for the Worker in the dashboard, then cf-opencode init --url <url>",
        );
      }
      return { url, attempts: attempt };
    }
    const kind = classifyDeployFailure(output);
    if (kind !== "retry" || attempt > retries) throw deployFailureError(kind, output);
    o.onRetry?.(attempt);
  }
}
