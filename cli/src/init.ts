// cf-opencode init: check the machine and the account, deploy, store the control token, wait for health.
//
// Wrangler does the deploy from a copy of the Worker and image sources under ~/.cf-opencode/deploy, so the
// CLI works from an npm install as well as a checkout. Preflight collects every problem before anything
// changes, and each one is a single "Failed: … — fix: …" line. A token is read from the environment or a
// file the caller names; it is never an argument, because arguments end up in shell history.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlClient } from "./api.js";
import { apiFor } from "./cloudflare-api.js";
import {
  controlTokenPath,
  readControlToken,
  readInstall,
  stateDir,
  writeInstall,
  writeSecret,
} from "./config.js";
import { domainCheck, hostnameError, probeDomain, type ResolveDns } from "./domain.js";
import { CliError, toFailedLine } from "./errors.js";
import { type GithubOutcome, setupGithub } from "./github.js";
import { setupSkill } from "./skill.js";
import { addStoreBinding, ensureStoreBucket, storeBucketName } from "./store.js";
import { proxyUrl } from "./terminal.js";
import { ask, readSecret, type Ui } from "./ui.js";
import {
  type Account,
  classifyDeployFailure,
  deployFailureError,
  deployWithRetry,
  lastErrorLine,
  lookupWorker,
  makeWrangler,
  parseWhoami,
  type Runner,
  type WhoAmI,
  type Wrangler,
} from "./wrangler.js";

export const DEFAULT_NAME = "cf-opencode";
const WORKER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const WORKERS_DEV_RE = /^([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev$/;

export interface InitOptions {
  name?: string;
  accountId?: string;
  /** File holding a Cloudflare API token. Default: CLOUDFLARE_API_TOKEN, else wrangler's login. */
  tokenFile?: string;
  /** Record an already deployed Worker instead of deploying. */
  url?: string;
  /** Deploy the Worker on this hostname too (a Custom Domain), and record https://<domain> as its URL. */
  domain?: string;
  /** Take over a Worker of this name that this machine did not deploy, and DNS records on --domain. */
  adopt?: boolean;
  /** Never prompt. Also implied by a non-TTY stdin. */
  nonInteractive?: boolean;
  /** Leave GitHub for later (`cf-opencode git-token`). */
  noGithub?: boolean;
  /** Do not install the handoff skill for the agents on this machine. */
  noSkill?: boolean;
}

export interface InitResult {
  url: string;
  name: string;
  accountId?: string;
  tokenPath: string;
  deployed: boolean;
  version?: string;
  /** What the GitHub step did. */
  github?: GithubOutcome;
}

export interface InitDeps {
  run: Runner;
  ui: Ui;
  env?: NodeJS.ProcessEnv;
  tty?: boolean;
  ask?: (q: string) => Promise<string>;
  readSecret?: (q: string) => Promise<string>;
  fetch?: typeof fetch;
  /** Health wait budget. */
  healthMs?: number;
  /** How long a healthy Worker may still answer with the version from before the deploy. */
  versionMs?: number;
  /** Where the Worker and image sources come from. Default: the checkout, else the package's templates. */
  sources?: string;
  /** How the --domain check asks the zone's nameservers. */
  resolveDns?: ResolveDns;
  /** How long a new Custom Domain may take to answer after the deploy. */
  domainMs?: number;
}

/** What preflight looks at. Gathered once, so the plan is a pure function the tests can drive. */
export interface Probes {
  node: string;
  /** Docker server version, or undefined when the daemon does not answer. */
  docker?: string;
  /** True when the buildx plugin answers. wrangler builds with `docker build --load`, which needs it. */
  buildx: boolean;
  whoami: WhoAmI;
  /** True when CLOUDFLARE_API_TOKEN or --token-file supplies a token. */
  apiToken: boolean;
  interactive: boolean;
}

export type Preflight =
  | { kind: "fail"; errors: CliError[] }
  | { kind: "login" }
  | { kind: "pick"; accounts: Account[] }
  | { kind: "ok"; account: Account };

export function preflight(o: InitOptions, p: Probes): Preflight {
  const errors: CliError[] = [];
  if (Number(p.node.replace(/^v/, "").split(".")[0]) < 22) {
    errors.push(
      new CliError(
        `Node ${p.node} is too old; cf-opencode needs Node 22 or later`,
        "install Node 22+ (https://nodejs.org), then rerun",
      ),
    );
  }
  if (!WORKER_NAME_RE.test(o.name ?? DEFAULT_NAME)) {
    errors.push(
      new CliError(`bad Worker name ${o.name}`, "use lowercase letters, digits and -, up to 63 characters"),
    );
  }
  const badDomain = o.domain === undefined ? undefined : hostnameError(o.domain);
  if (badDomain) errors.push(badDomain);
  if (!p.docker) {
    errors.push(
      new CliError(
        "Docker is not running (wrangler builds the workspace image locally)",
        "start Docker Desktop or the docker daemon, check `docker info`, then rerun",
      ),
    );
  }
  if (p.docker && !p.buildx) {
    errors.push(
      new CliError(
        "Docker has no buildx plugin (wrangler builds the image with docker buildx)",
        "install it (Debian/Ubuntu: apt install docker-buildx-plugin; Docker Desktop has it), check `docker buildx version`, then rerun",
      ),
    );
  }
  if (!p.whoami.loggedIn) {
    if (errors.length === 0 && p.interactive && !p.apiToken) return { kind: "login" };
    errors.push(
      new CliError(
        p.apiToken ? "Cloudflare rejected the API token" : "wrangler is not logged in to Cloudflare",
        p.apiToken
          ? "create a token with Workers Scripts Write and Workers Containers Write, then rerun"
          : "run npx wrangler login (or set CLOUDFLARE_API_TOKEN), then rerun cf-opencode init",
      ),
    );
    return { kind: "fail", errors };
  }
  const accounts = p.whoami.accounts;
  let account: Account | undefined;
  if (o.accountId) {
    account =
      accounts.find((a) => a.id === o.accountId) ??
      (accounts.length === 0 ? { id: o.accountId, name: o.accountId } : undefined);
    if (!account)
      errors.push(
        new CliError(
          `account ${o.accountId} is not one this login can see`,
          "pass an id that npx wrangler whoami lists",
        ),
      );
  } else if (accounts.length === 1) account = accounts[0];
  else if (accounts.length === 0)
    errors.push(
      new CliError(
        "this login lists no Cloudflare accounts",
        "pass --account <id>, or log in with an account that has Workers Paid",
      ),
    );
  else if (errors.length === 0 && p.interactive) return { kind: "pick", accounts };
  else
    errors.push(
      new CliError(
        `this login has ${accounts.length} Cloudflare accounts`,
        "pass --account <id> or set CLOUDFLARE_ACCOUNT_ID",
      ),
    );
  if (errors.length > 0 || !account) return { kind: "fail", errors };
  return { kind: "ok", account };
}

export async function init(o: InitOptions, deps: InitDeps): Promise<InitResult> {
  const env = deps.env ?? process.env;
  const ui = deps.ui;
  const recorded = readInstall();
  const name = o.name ?? recorded?.name ?? DEFAULT_NAME;
  if (o.url && o.domain)
    throw new CliError(
      "--url and --domain do not go together",
      "pass --domain <hostname> to deploy on it, or --url <url> to use a Worker that is deployed",
    );
  // A rerun and upgrade keep the recorded Custom Domain. Without it in the config, the URL would change.
  const domain = o.domain ?? (recorded?.name === name ? recorded.domain : undefined);
  const apiToken = o.tokenFile ? readTokenFile(o.tokenFile) : env.CLOUDFLARE_API_TOKEN?.trim() || undefined;
  const interactive = (deps.tty ?? Boolean(process.stdin.isTTY)) && !o.nonInteractive;
  const askFn = deps.ask ?? ask;

  // Later commands that call wrangler (upgrade, uninstall, git-token) act on the recorded Worker name.
  const githubDeps = {
    run: deps.run,
    ui,
    env,
    ask: askFn,
    readSecret: deps.readSecret ?? readSecret,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
  if (o.url) {
    const r = await recordExisting(o.url, o.name, env, deps);
    const control = env.CF_OPENCODE_CONTROL_TOKEN?.trim() || readControlToken() || "";
    const github = await setupGithub(
      { url: r.url, control, interactive: false, canStore: false },
      githubDeps,
    );
    return { ...r, github };
  }

  // 1. Machine and account.
  const wranglerBase = { ...(apiToken ? { apiToken } : {}) };
  let w = makeWrangler(deps.run, wranglerBase);
  const [docker, buildx, who] = await Promise.all([
    dockerVersion(deps.run),
    deps.run("docker", ["buildx", "version"], { timeoutMs: 20_000 }).then((r) => r.code === 0),
    whoami(w),
  ]);
  const probes: Probes = {
    node: process.version,
    docker,
    buildx,
    whoami: who,
    apiToken: Boolean(apiToken),
    interactive,
  };
  const pfOptions = { ...o, name, accountId: o.accountId ?? env.CLOUDFLARE_ACCOUNT_ID, domain };
  let pf = preflight(pfOptions, probes);
  ui.step(`✓ Node ${process.version}`);
  if (docker && buildx) ui.step(`✓ Docker ${docker} with buildx`);
  if (pf.kind === "login") {
    const yes = (
      await askFn("Not logged in to Cloudflare. Log in now in your browser? [Y/n] ")
    ).toLowerCase();
    if (yes.startsWith("n"))
      throw new CliError(
        "not logged in to Cloudflare",
        "run npx wrangler login, then rerun cf-opencode init",
      );
    await w.run(["login"], { interactive: true });
    probes.whoami = await whoami(w);
    pf = preflight(pfOptions, probes);
  }
  if (pf.kind === "pick") pf = { kind: "ok", account: await pickAccount(pf.accounts, askFn, ui) };
  if (pf.kind === "fail") throw joinErrors(pf.errors);
  if (pf.kind !== "ok")
    throw new CliError("not logged in to Cloudflare", "run npx wrangler login, then rerun cf-opencode init");
  const account = pf.account;
  ui.step(
    `✓ Cloudflare account ${account.name} (${account.id})${probes.whoami.email ? `, ${probes.whoami.email}` : ""}`,
  );
  w = makeWrangler(deps.run, { ...wranglerBase, accountId: account.id });

  // 2. The plan has Containers, and the name is ours to use.
  const plan = await w.run(["containers", "list", "--json"], { timeoutMs: 60_000 });
  if (plan.code !== 0) {
    const out = `${plan.stdout}\n${plan.stderr}`;
    const kind = classifyDeployFailure(out);
    if (kind === "paid" || kind === "auth") throw deployFailureError(kind, out);
    ui.step(`! could not confirm Containers access (${lastErrorLine(out)}); deploying anyway`);
  } else ui.step("✓ Containers available (Workers Paid)");
  // A Worker is ours when this machine recorded it, or started deploying it on a run that then failed.
  const pendingPath = join(stateDir(), "deploying.json");
  const mine = (r: { name?: string; accountId?: string } | undefined) =>
    r?.name === name && (!r.accountId || r.accountId === account.id);
  const ours = mine(readInstall()) || mine(readJson(pendingPath));
  if (!ours) {
    const found = await lookupWorker(w, name);
    if (found.kind === "found" && !o.adopt) {
      throw new CliError(
        `a Worker named ${name} already exists in this account, and this machine did not deploy it`,
        `pass --name <other> for a separate install, or --adopt to replace it (its CONTROL_TOKEN changes)`,
      );
    }
    if (found.kind === "unknown")
      ui.step(`! could not check for an existing Worker ${name} (${found.reason})`);
  }
  // The Custom Domain: a zone of this account, and a hostname the deploy does not take from someone.
  if (domain) {
    const api = await apiFor(w, apiToken, deps.fetch);
    const probe = await probeDomain(domain, account.id, api, deps.resolveDns);
    const check = domainCheck(domain, name, probe, o.adopt);
    for (const l of check.warnings) ui.step(l);
    if (check.errors.length > 0) throw joinErrors(check.errors);
    ui.step(`✓ Custom Domain ${domain}${check.zone ? ` (zone ${check.zone})` : ""}`);
  }

  // 3. Control token first: a run that fails after the deploy reuses it on the next try.
  const control =
    readControlToken() || env.CF_OPENCODE_CONTROL_TOKEN?.trim() || randomBytes(32).toString("base64url");
  writeSecret(controlTokenPath(), control);
  writeFileSync(pendingPath, `${JSON.stringify({ name, accountId: account.id })}\n`, { mode: 0o600 });

  // 4. Deploy from a fresh copy of this CLI's sources.
  const deployDir = join(stateDir(), "deploy");
  const settings = readSettings();
  if (Object.keys(settings).length > 0)
    ui.step(`✓ Settings from ${settingsPath()}: ${Object.keys(settings).join(", ")}`);
  await materialize(deps.sources ?? sourcesDir(), deployDir, name, settings, domain);
  // The store's bucket has a fixed name, so it exists before the deploy binds it (cli/src/store.ts).
  if (settings.store === true) await ensureStoreBucket(w, storeBucketName(name), (l) => ui.step(l));
  const logPath = join(stateDir(), "deploy.log");
  let log = "";
  const started = Date.now();
  ui.step(
    `… deploying Worker ${name} and building the workspace image (the first build takes a few minutes)`,
  );
  const phases = new PhaseReporter((l) => ui.step(`  ${l} (${Math.round((Date.now() - started) / 1000)}s)`));
  let url: string;
  let workersDev: string | undefined;
  try {
    ({ url, workersDev } = await deployWithRetry(
      makeWrangler(deps.run, { ...wranglerBase, accountId: account.id, cwd: deployDir }),
      name,
      {
        onOutput: (s) => {
          log += s;
          phases.feed(s);
        },
        onRetry: (n) => ui.step(`  image push failed (registry flake); retry ${n}`),
        ...(domain ? { domain } : {}),
      },
    ));
  } finally {
    writeFileSync(logPath, log, { mode: 0o600 });
  }
  ui.step(`✓ Deployed ${url} in ${Math.round((Date.now() - started) / 1000)}s (log: ${logPath})`);

  // 5. Secret through stdin, never argv.
  const put = await makeWrangler(deps.run, { ...wranglerBase, accountId: account.id, cwd: deployDir }).run(
    ["secret", "put", "CONTROL_TOKEN", "--name", name, "--config", "worker/wrangler.jsonc"],
    { input: control, timeoutMs: 120_000 },
  );
  if (put.code !== 0) {
    throw new CliError(
      `deployed, but the control token was not stored: ${lastErrorLine(`${put.stdout}\n${put.stderr}`)}`,
      "rerun cf-opencode init; it reuses the same token",
    );
  }
  writeInstall({ url, name, accountId: account.id, ...(domain ? { domain } : {}) });
  rmSync(pendingPath, { force: true });
  ui.step(`✓ Control token stored in ${controlTokenPath()} and on the Worker`);

  // 6. The Worker answers with that token.
  // The old version can answer for some seconds after a deploy. Wait for the one that was deployed.
  // A new Custom Domain needs a certificate first, so the workers.dev URL proves the deploy, when there is one.
  const healthUrl = workersDev ?? url;
  const version = await waitHealthy(healthUrl, control, deps, deployedVersion(deployDir));
  ui.step(`✓ Worker healthy (API ${version})${healthUrl !== url ? ` at ${healthUrl}` : ""}`);
  if (healthUrl !== url) {
    try {
      await waitHealthy(url, control, { ...deps, healthMs: deps.domainMs ?? 180_000 });
      ui.step(`✓ ${url} answers`);
    } catch (e) {
      ui.step(
        `! ${url} does not answer yet (${toFailedLine(e)
          .replace(/^Failed: /, "")
          .replace(
            / — fix: .*$/,
            "",
          )}). A new Custom Domain can take some minutes. Check it later with cf-opencode doctor.`,
      );
    }
  }

  // 7. GitHub, once, so the first connect from a private checkout works.
  const github = await setupGithub(
    {
      url: healthUrl,
      control,
      interactive,
      ...(o.noGithub ? { skip: true } : {}),
      ...(apiToken ? { apiToken } : {}),
    },
    githubDeps,
  );

  // 8. The handoff skill, for the agents on this machine.
  await setupSkill(
    { interactive, ...(o.noSkill ? { skip: true } : {}) },
    { step: (l) => ui.step(l), ask: askFn },
  );
  return { url, name, accountId: account.id, tokenPath: controlTokenPath(), deployed: true, version, github };
}

/**
 * init --url: point this machine at a Worker that is deployed, on another machine or at a new URL. Needs that
 * install's control token. Any https origin works: a workers.dev URL, or a Custom Domain. It is also the repair
 * after the URL changed (a renamed workers.dev subdomain): the record keeps its account and Custom Domain, so
 * upgrade still works.
 */
async function recordExisting(
  url: string,
  nameFlag: string | undefined,
  env: NodeJS.ProcessEnv,
  deps: InitDeps,
): Promise<InitResult> {
  const clean = proxyUrl(url);
  // The first label of a workers.dev hostname is the Worker name. A Custom Domain says nothing about it.
  const recorded = readInstall();
  const name =
    nameFlag ?? WORKERS_DEV_RE.exec(new URL(clean).hostname)?.[1] ?? recorded?.name ?? DEFAULT_NAME;
  const same = recorded?.name === name ? recorded : undefined;
  const control = env.CF_OPENCODE_CONTROL_TOKEN?.trim() || readControlToken();
  if (!control) {
    throw new CliError(
      "no control token for that Worker",
      "copy ~/.cf-opencode/control-token from the machine that ran init (mode 600), or set CF_OPENCODE_CONTROL_TOKEN",
    );
  }
  const version = await waitHealthy(clean, control, { ...deps, healthMs: deps.healthMs ?? 10_000 });
  writeSecret(controlTokenPath(), control);
  writeInstall({
    url: clean,
    name,
    ...(same?.accountId ? { accountId: same.accountId } : {}),
    ...(same?.domain ? { domain: same.domain } : {}),
  });
  if (same && same.url !== clean) deps.ui.step(`✓ Replaced the recorded URL ${same.url}`);
  deps.ui.step(`✓ Worker ${clean} accepts the control token (API ${version})`);
  return { url: clean, name, tokenPath: controlTokenPath(), deployed: false, version };
}

/** The API version in the sources that were deployed, or undefined when it cannot be read. */
export function deployedVersion(deployDir: string): string | undefined {
  try {
    return /API_VERSION = "([^"]+)"/.exec(
      readFileSync(join(deployDir, "worker", "src", "api.ts"), "utf8"),
    )?.[1];
  } catch {
    return undefined;
  }
}

async function waitHealthy(url: string, token: string, deps: InitDeps, expect?: string): Promise<string> {
  const until = Date.now() + (deps.healthMs ?? 90_000);
  const client = new ControlClient(url, token, deps.fetch);
  let last = "";
  let seen: string | undefined;
  // Once the Worker answers, give the new version this long to take over from the old one.
  let versionUntil = Number.POSITIVE_INFINITY;
  for (;;) {
    try {
      seen = (await client.health()).version;
      if (!expect || seen === expect) return seen;
      versionUntil = Math.min(versionUntil, Date.now() + (deps.versionMs ?? 45_000));
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    // A fresh secret takes a few seconds to reach every edge; until then control routes answer 404 or 401.
    // Healthy, but still the version from before the deploy: report what answers, do not fail the install.
    if (seen && Date.now() > Math.min(until, versionUntil)) return seen;
    if (Date.now() > until)
      throw new CliError(
        `the Worker did not accept the control token: ${last.replace(/^Failed: /, "")}`,
        "wait a minute, then cf-opencode doctor",
      );
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function pickAccount(
  accounts: Account[],
  askFn: (q: string) => Promise<string>,
  ui: Ui,
): Promise<Account> {
  ui.step("This login can deploy to several accounts:");
  for (const [i, a] of accounts.entries()) ui.step(`  ${i + 1}. ${a.name} (${a.id})`);
  const answer = await askFn(`Deploy to which account? [1-${accounts.length}] `);
  const picked = accounts[Number(answer) - 1] ?? accounts.find((a) => a.id === answer);
  if (!picked)
    throw new CliError(
      `no account ${answer}`,
      "rerun and pick a number from the list, or pass --account <id>",
    );
  return picked;
}

function joinErrors(errors: CliError[]): CliError {
  if (errors.length === 1) return errors[0] as CliError;
  const e = new CliError("preflight", "fix every line, then rerun");
  e.message = errors.map((x) => x.message).join("\n");
  return e;
}

async function whoami(w: Wrangler): Promise<WhoAmI> {
  const r = await w.run(["whoami", "--json"], { timeoutMs: 60_000 });
  return r.code === 0 ? parseWhoami(r.stdout) : { loggedIn: false, accounts: [] };
}

async function dockerVersion(run: Runner): Promise<string | undefined> {
  const r = await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
  const v = r.stdout.trim();
  return r.code === 0 && v ? v : undefined;
}

function readJson(path: string): { name?: string; accountId?: string } | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { name?: string; accountId?: string };
  } catch {
    return undefined;
  }
}

function readTokenFile(path: string): string {
  try {
    const t = readFileSync(path, "utf8").trim();
    if (t) return t;
  } catch {}
  throw new CliError(
    `cannot read a token from ${path}`,
    "write the API token to that file (mode 600) and rerun",
  );
}

/** Turn wrangler's deploy output into a few progress lines. */
class PhaseReporter {
  private seen = new Set<string>();
  constructor(private readonly emit: (line: string) => void) {}
  feed(chunk: string): void {
    const rules: [RegExp, string][] = [
      [/Building image|docker build|\[\+\] Building/i, "building image"],
      [/Uploading|Pushed|pushing|registry\.cloudflare\.com/i, "pushing image"],
      [/Total Upload/i, "uploading Worker"],
      [/Deployed .* triggers|Current Version ID/i, "Worker live"],
    ];
    for (const [re, label] of rules) {
      if (!this.seen.has(label) && re.test(chunk)) {
        this.seen.add(label);
        this.emit(label);
      }
    }
  }
}

/**
 * The directory holding worker/src, worker/wrangler.jsonc and image/. A source checkout wins (so a local
 * edit deploys); an npm install uses the templates its build copied in.
 */
export function sourcesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [resolve(here, "..", ".."), resolve(here, "..", "templates")]) {
    if (existsSync(join(dir, "worker", "src", "index.ts")) && existsSync(join(dir, "image", "Dockerfile")))
      return dir;
  }
  throw new CliError(
    "the Worker sources are missing from this install",
    "reinstall cf-opencode, or run npm run build -w cli in a checkout",
  );
}

/** The files a deploy needs, relative to the sources dir. Tests and tsconfig stay behind. */
export const DEPLOY_FILES = ["worker/src", "worker/wrangler.jsonc", "image"];

/**
 * Copy the deploy files, and write the Worker name into the copy's wrangler.jsonc. `wrangler deploy --name`
 * is not enough: the container application keeps the config's name (cf-opencode-workspacesession), so a
 * second install in one account would collide with the first ("an application with the name … already exists").
 * A Custom Domain goes there too, as a route with custom_domain: true.
 */
export async function materialize(
  from: string,
  to: string,
  name = DEFAULT_NAME,
  settings: Record<string, unknown> = {},
  domain?: string,
): Promise<void> {
  await rm(to, { recursive: true, force: true });
  for (const f of DEPLOY_FILES) {
    await mkdir(dirname(join(to, f)), { recursive: true });
    await cp(join(from, f), join(to, f), {
      recursive: true,
      filter: (s) => !/\.test\.ts$|node_modules|\.wrangler/.test(basename(s)),
    });
  }
  const cfg = join(to, "worker", "wrangler.jsonc");
  const text = readFileSync(cfg, "utf8");
  const named = text.replace(/("name"\s*:\s*)"[^"]*"/, `$1"${name}"`);
  if (named === text && !text.includes(`"name": "${name}"`))
    throw new CliError(`no "name" in ${cfg}`, "reinstall cf-opencode");
  const configured = applySettings(withDomain(named, domain), settings);
  writeFileSync(
    cfg,
    settings.store === true ? addStoreBinding(configured, storeBucketName(name)) : configured,
  );
}

/**
 * Add the Custom Domain route after the top-level "name". wrangler turns workers.dev off for a config with routes
 * unless workers_dev is true; it stays on, so other machines that recorded the workers.dev URL keep working.
 */
export function withDomain(wranglerJsonc: string, domain: string | undefined): string {
  if (!domain) return wranglerJsonc;
  if (/"(routes?|workers_dev)"\s*:/.test(wranglerJsonc))
    throw new CliError("worker/wrangler.jsonc already has routes or workers_dev", "reinstall cf-opencode");
  const route = `"routes": [{ "pattern": ${JSON.stringify(domain)}, "custom_domain": true }]`;
  return wranglerJsonc.replace(
    /^(\s*)("name"\s*:\s*"[^"]*",)$/m,
    `$1$2\n$1"workers_dev": true,\n$1${route},`,
  );
}

/** The user's settings file. Its keys replace the defaults in CF_OPENCODE_CONFIG on each deploy. */
export function settingsPath(): string {
  return join(stateDir(), "config.json");
}

export function readSettings(path = settingsPath()): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(`${path} is not JSON`, "correct the file, or delete it to use the defaults");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new CliError(`${path} must hold one JSON object`, 'for example { "idlePauseMinutes": 30 }');
  // The notify URL is a Worker secret now, not a setting. Fail before the deploy, not after it.
  if ("notifyUrl" in parsed)
    throw new CliError(
      `notifyUrl in ${path} is no longer a setting; the URL is a Worker secret now`,
      "remove notifyUrl from the file, then run cf-opencode notify-url",
    );
  return parsed as Record<string, unknown>;
}

/** Merge settings into the CF_OPENCODE_CONFIG var of a wrangler.jsonc text. `instance` merges key by key. */
export function applySettings(wranglerJsonc: string, settings: Record<string, unknown>): string {
  if (Object.keys(settings).length === 0) return wranglerJsonc;
  const re = /("CF_OPENCODE_CONFIG"\s*:\s*)("(?:[^"\\]|\\.)*")/;
  const m = wranglerJsonc.match(re);
  if (!m?.[2]) throw new CliError("no CF_OPENCODE_CONFIG in worker/wrangler.jsonc", "reinstall cf-opencode");
  const base = JSON.parse(JSON.parse(m[2]) as string) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...base, ...settings };
  if (isObject(base.instance) && isObject(settings.instance))
    merged.instance = { ...base.instance, ...settings.instance };
  return wranglerJsonc.replace(re, (_all, key: string) => `${key}${JSON.stringify(JSON.stringify(merged))}`);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
