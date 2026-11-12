// list, doctor and uninstall: commands about the install as a whole.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ControlClient } from "./api.js";
import {
  installPath,
  readControlToken,
  readInstall,
  readWorkspace,
  stateDir,
  type WorkspaceLocal,
} from "./config.js";
import { CliError, toFailedLine } from "./errors.js";
import { fmtAge, table, type Ui } from "./ui.js";
import { lastErrorLine, lookupWorker, makeWrangler, type Runner } from "./wrangler.js";

// ---------- list ----------

interface RemoteStatus {
  workspace?: { state?: string; awakeSince?: string; lastStop?: { at: string } };
  containerRunning?: boolean;
  snapshotExpiresAt?: string;
}

export interface ListRow {
  id: string;
  state: string;
  directory: string;
  repo?: string;
  since?: string;
  snapshotExpiresAt?: string;
  error?: string;
}

/** Workspaces this machine connected to, with their state from the Worker. */
export async function listWorkspaces(client: ControlClient): Promise<ListRow[]> {
  let files: string[] = [];
  try {
    files = readdirSync(join(stateDir(), "workspaces")).filter((f) => f.endsWith(".json"));
  } catch {}
  const locals = files
    .map((f) => readWorkspace(f.slice(0, -5)))
    .filter((w): w is WorkspaceLocal => Boolean(w));
  return Promise.all(
    locals.map(async (w): Promise<ListRow> => {
      const base = { id: w.id, directory: w.directory, ...(w.repoUrl ? { repo: w.repoUrl } : {}) };
      try {
        const s = (await client.status(w.id)) as RemoteStatus;
        const state = s.containerRunning
          ? s.workspace?.state === "warm"
            ? "warm"
            : "running"
          : (s.workspace?.state ?? "none");
        const since = s.containerRunning ? s.workspace?.awakeSince : s.workspace?.lastStop?.at;
        return {
          ...base,
          state,
          ...(since ? { since } : {}),
          ...(s.snapshotExpiresAt ? { snapshotExpiresAt: s.snapshotExpiresAt } : {}),
        };
      } catch (e) {
        return { ...base, state: "unknown", error: toFailedLine(e) };
      }
    }),
  );
}

const WARN_DAYS = 2;

/** The Worker refreshes a snapshot 3 days before expiry, so one under 2 days out means refresh is failing or off. */
export function expiresSoon(iso: string | undefined, now = Date.now()): boolean {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) && t - now < WARN_DAYS * 86_400_000;
}

export function renderList(rows: ListRow[]): string {
  if (rows.length === 0) return "No workspaces yet. In a git checkout: cf-opencode connect";
  const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const soon = sorted.filter((r) => expiresSoon(r.snapshotExpiresAt));
  const out = table(
    ["WORKSPACE", "STATE", "SINCE", "SNAPSHOT EXPIRES", "REPO"],
    sorted.map((r) => [
      r.id,
      r.state,
      fmtAge(r.since),
      `${fmtAge(r.snapshotExpiresAt)}${expiresSoon(r.snapshotExpiresAt) ? " !" : ""}`,
      r.repo ?? "-",
    ]),
  );
  if (soon.length === 0) return out;
  return `${out}\n\n! ${soon.map((r) => r.id).join(", ")}: the snapshot expires within ${WARN_DAYS} days. The Worker refreshes it 3 days before; if that keeps failing, cf-opencode connect <workspace> restores it and starts a new 30 days.`;
}

// ---------- doctor ----------

export interface Check {
  status: "ok" | "warn" | "fail";
  name: string;
  detail: string;
  fix?: string;
}

export async function doctor(o: {
  url?: string;
  cliVersion: string;
  run: Runner;
  fetch?: typeof fetch;
}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (status: Check["status"], name: string, detail: string, fix?: string) =>
    checks.push({ status, name, detail, ...(fix ? { fix } : {}) });

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) add("ok", "node", process.version);
  else add("fail", "node", `${process.version} is too old`, "install Node 22 or later");

  const oc = await firstVersion(o.run, ["opencode", "opencode2"]);
  if (!oc)
    add(
      "fail",
      "opencode",
      "not installed; connect needs it",
      "curl -fsSL https://opencode.ai/v2/install | bash",
    );
  else if (!/^v?2\./.test(oc.version))
    add(
      "warn",
      "opencode",
      `${oc.bin} ${oc.version}; connect needs OpenCode 2`,
      "curl -fsSL https://opencode.ai/v2/install | bash",
    );
  else add("ok", "opencode", `${oc.bin} ${oc.version}`);

  const ssh = await o.run("ssh", ["-V"], { timeoutMs: 10_000 });
  if (ssh.code === 0) add("ok", "ssh", lastErrorLine(`${ssh.stdout}${ssh.stderr}`));
  else add("warn", "ssh", "no ssh client; only ssh, ssh-config and herdr need it", "install OpenSSH");

  const install = readInstall();
  const url = o.url ?? process.env.CF_OPENCODE_URL ?? install?.url;
  const token = readControlToken() ?? process.env.CF_OPENCODE_CONTROL_TOKEN;
  if (url) add("ok", "install", `${url}${install?.name ? ` (Worker ${install.name})` : ""}`);
  else add("fail", "install", "no Worker URL", "cf-opencode init");
  if (token) add("ok", "control token", join(stateDir(), "control-token"));
  else add("fail", "control token", "missing", "cf-opencode init writes ~/.cf-opencode/control-token");
  if (!url || !token) return checks;

  const client = new ControlClient(url, token, o.fetch);
  try {
    const s = await client.installStatus();
    if (s.version === o.cliVersion) add("ok", "worker", `API ${s.version}, control token accepted`);
    else add("warn", "worker", `API ${s.version}, CLI ${o.cliVersion}`, "cf-opencode upgrade");
    if (!s.bindings)
      add("warn", "bindings", "the Worker predates the AI and Browser Run bindings", "cf-opencode upgrade");
    else {
      add(
        s.bindings.ai ? "ok" : "fail",
        "models",
        s.bindings.ai ? "Workers AI / AI Gateway binding" : "no AI binding",
        "cf-opencode upgrade",
      );
      add(
        s.bindings.browser ? "ok" : "warn",
        "browse",
        s.bindings.browser ? "Browser Run binding" : "no Browser Run binding",
        "cf-opencode upgrade",
      );
      if (s.bindings.github) add("ok", "github", "token on the Worker: private repositories, push and gh");
      else
        add(
          "warn",
          "github",
          "no token on the Worker: public repositories only, no push",
          "gh auth token | cf-opencode git-token",
        );
    }
  } catch (e) {
    add(
      "fail",
      "worker",
      toFailedLine(e)
        .replace(/^Failed: /, "")
        .replace(/ — fix: .*$/, ""),
      "cf-opencode init, or check the URL",
    );
  }
  return checks;
}

export function renderChecks(checks: Check[]): string {
  const mark = { ok: "✓", warn: "!", fail: "✗" } as const;
  const w = Math.max(...checks.map((c) => c.name.length));
  return checks
    .map(
      (c) =>
        `${mark[c.status]} ${c.name.padEnd(w)}  ${c.detail}${c.status !== "ok" && c.fix ? ` — fix: ${c.fix}` : ""}`,
    )
    .join("\n");
}

async function firstVersion(
  run: Runner,
  bins: string[],
): Promise<{ bin: string; version: string } | undefined> {
  for (const bin of bins) {
    const r = await run(bin, ["--version"], { timeoutMs: 15_000 });
    if (r.code === 0) return { bin, version: r.stdout.trim().split(/\s+/).pop() ?? "" };
  }
  return undefined;
}

// ---------- uninstall ----------

export const RETENTION_NOTE =
  "Snapshots (paused workspaces) have no delete API; Cloudflare keeps their data up to 30 days after the last restore.";

export interface Resources {
  worker: string;
  apps: { id: string; name: string }[];
  images: string[];
}

function jsonArray<T>(s: string): T[] {
  const i = s.indexOf("[");
  if (i === -1) return [];
  try {
    const v = JSON.parse(s.slice(i)) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** This install's container app and image tags, out of `containers list --json` and `containers images list --json`. */
export function selectResources(worker: string, appsJson: string, imagesJson: string): Resources {
  const app = `${worker}-workspacesession`;
  const apps = jsonArray<{ id: string; name: string }>(appsJson)
    .filter((a) => a.name === app)
    .map((a) => ({ id: a.id, name: a.name }));
  const images = jsonArray<{ name: string; tags?: string[] }>(imagesJson)
    .filter((r) => r.name.startsWith(`${app}-`))
    .flatMap((r) => (r.tags ?? []).map((t) => `${r.name}:${t}`));
  return { worker, apps, images };
}

export async function uninstall(o: {
  yes: boolean;
  run: Runner;
  ui: Ui;
  apiToken?: string;
}): Promise<Resources & { errors: string[] }> {
  const install = readInstall();
  if (!install)
    throw new CliError("no install on this machine", "nothing to remove; cf-opencode init installs");
  const w = makeWrangler(o.run, {
    ...(install.accountId ? { accountId: install.accountId } : {}),
    ...(o.apiToken ? { apiToken: o.apiToken } : {}),
  });
  const [apps, images] = await Promise.all([
    w.run(["containers", "list", "--json"], { timeoutMs: 60_000 }),
    w.run(["containers", "images", "list", "--json"], { timeoutMs: 60_000 }),
  ]);
  for (const r of [apps, images]) {
    if (r.code !== 0)
      throw new CliError(
        `wrangler could not list containers: ${lastErrorLine(`${r.stdout}\n${r.stderr}`)}`,
        "run npx wrangler login, then rerun",
      );
  }
  const res = selectResources(install.name, apps.stdout, images.stdout);
  const { ui } = o;
  ui.out(`${o.yes ? "Deleting" : "Would delete"}:`);
  ui.out(`  Worker ${res.worker} (${install.url}) and its Durable Objects`);
  for (const a of res.apps) ui.out(`  container app ${a.name} (${a.id})`);
  ui.out(`  ${res.images.length} image tag(s) under ${res.worker}-workspacesession-*`);
  const errors: string[] = [];
  if (o.yes) {
    const del = async (args: string[], what: string) => {
      const r = await w.run(args, { timeoutMs: 120_000, env: { CI: "1" } });
      if (r.code === 0) ui.step(`✓ deleted ${what}`);
      else errors.push(`${what}: ${lastErrorLine(`${r.stdout}\n${r.stderr}`)}`);
    };
    // wrangler delete can remove the Worker and still exit 1 (it then lists KV namespaces, which a scoped
    // token may not read), so the lookup decides.
    if ((await lookupWorker(w, res.worker)).kind === "missing")
      ui.step(`✓ Worker ${res.worker} already deleted`);
    else {
      const r = await w.run(["delete", "--name", res.worker, "--force"], {
        timeoutMs: 120_000,
        env: { CI: "1" },
      });
      if (r.code === 0 || (await lookupWorker(w, res.worker)).kind === "missing")
        ui.step(`✓ deleted Worker ${res.worker}`);
      else errors.push(`Worker ${res.worker}: ${lastErrorLine(`${r.stdout}\n${r.stderr}`)}`);
    }
    for (const a of res.apps) await del(["containers", "delete", a.id], `container app ${a.name}`);
    for (const i of res.images)
      await del(["containers", "images", "delete", i, "--skip-confirmation"], `image ${i}`);
  } else ui.out("Dry run. cf-opencode uninstall --yes deletes them.");
  ui.out(RETENTION_NOTE);
  if (errors.length > 0) {
    for (const e of errors) ui.step(`✗ ${e}`);
    throw new CliError(
      `${errors.length} delete(s) failed`,
      "rerun cf-opencode uninstall --yes; deleted items are skipped",
    );
  }
  if (o.yes) {
    // The install record points at a Worker that no longer exists. Tokens and passwords stay until removed by hand.
    rmSync(installPath(), { force: true });
    ui.out(
      `Removed ${installPath()}. Other files in ${stateDir()} are kept; delete the folder to remove them.`,
    );
  }
  return { ...res, errors };
}

// ---------- git-token ----------

/**
 * Store (or with remove, delete) the GITHUB_TOKEN Worker secret. The Worker adds it to the workspace's
 * requests to github.com and api.github.com; the token never enters a container. The value reaches wrangler
 * on stdin, never in argv.
 */
export async function gitToken(o: {
  token?: string;
  remove: boolean;
  run: Runner;
  ui: Ui;
  apiToken?: string;
  fetch?: typeof fetch;
}): Promise<{ login?: string }> {
  const install = readInstall();
  if (!install) throw new CliError("no install on this machine", "cf-opencode init");
  const w = makeWrangler(o.run, {
    ...(install.accountId ? { accountId: install.accountId } : {}),
    ...(o.apiToken ? { apiToken: o.apiToken } : {}),
  });
  if (o.remove) {
    const r = await w.run(["secret", "delete", "GITHUB_TOKEN", "--name", install.name], {
      timeoutMs: 120_000,
      env: { CI: "1" },
    });
    if (r.code !== 0)
      throw new CliError(
        `could not delete the secret: ${lastErrorLine(`${r.stdout}\n${r.stderr}`)}`,
        "run npx wrangler login, then retry",
      );
    o.ui.step(
      `✓ removed GITHUB_TOKEN from ${install.name}; running workspaces drop it on their next connect`,
    );
    return {};
  }
  const token = o.token?.trim();
  if (!token) throw new CliError("no token given", "pipe one in: gh auth token | cf-opencode git-token");
  let login: string | undefined;
  try {
    const res = await (o.fetch ?? fetch)("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token}`, "user-agent": "cf-opencode" },
    });
    if (res.status === 401) throw new CliError("GitHub rejected that token", "create a new one, then retry");
    if (res.ok) login = ((await res.json()) as { login?: string }).login;
  } catch (e) {
    if (e instanceof CliError) throw e;
    o.ui.step("! could not reach api.github.com to check the token; storing it anyway");
  }
  const r = await w.run(["secret", "put", "GITHUB_TOKEN", "--name", install.name], {
    input: token,
    timeoutMs: 120_000,
  });
  if (r.code !== 0)
    throw new CliError(
      `could not store the secret: ${lastErrorLine(`${r.stdout}\n${r.stderr}`)}`,
      "run npx wrangler login, then retry",
    );
  o.ui.step(`✓ GITHUB_TOKEN stored on ${install.name}${login ? ` (GitHub user ${login})` : ""}`);
  o.ui.step(
    "  Workspaces clone, pull and push github.com over HTTPS with it, and gh works; the token stays in the Worker.",
  );
  o.ui.step("  A running workspace picks it up on its next cf-opencode connect.");
  return login ? { login } : {};
}
