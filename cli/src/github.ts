// GitHub for workspaces, set up once in `cf-opencode init`.
//
// Most checkouts are private, so init offers the token before the first connect needs it. The common
// case is a machine where `gh` is logged in: init uses that login. Otherwise it asks for a token once.
// The token is the Worker secret GITHUB_TOKEN (see gitToken); it never enters a workspace.
import { ControlClient } from "./api.js";
import { gitToken } from "./manage.js";
import type { Ui } from "./ui.js";
import type { Runner } from "./wrangler.js";

export type GithubOutcome = "already" | "stored" | "skipped";

export interface GithubSetup {
  url: string;
  control: string;
  /** Prompts are allowed. */
  interactive: boolean;
  /** `--no-github`. */
  skip?: boolean;
  /** False for `init --url`: this machine may have no Cloudflare login to store a secret with. */
  canStore?: boolean;
  apiToken?: string;
}

export interface GithubDeps {
  run: Runner;
  ui: Ui;
  env: NodeJS.ProcessEnv;
  ask: (q: string) => Promise<string>;
  readSecret: (q: string) => Promise<string>;
  fetch?: typeof fetch;
}

export const GITHUB_HINT =
  "private repositories, push and gh need a GitHub token: gh auth token | cf-opencode git-token";

const yes = (answer: string) => !/^n/i.test(answer.trim());

/** The token `gh` is logged in with on this machine, if any. */
export async function ghLoginToken(run: Runner): Promise<string | undefined> {
  try {
    const r = await run("gh", ["auth", "token"], { timeoutMs: 15_000 });
    const token = r.stdout.trim().split(/\r?\n/)[0]?.trim();
    return r.code === 0 && token ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Does the Worker hold a GitHub token? undefined when it does not say (an older Worker, or no answer). */
export async function workerHasGithub(
  url: string,
  control: string,
  f?: typeof fetch,
): Promise<boolean | undefined> {
  try {
    return (await new ControlClient(url, control, f).installStatus()).bindings?.github;
  } catch {
    return undefined;
  }
}

/** The GitHub step of init. Never fails the install: a problem is one `!` line with the command to run later. */
export async function setupGithub(o: GithubSetup, deps: GithubDeps): Promise<GithubOutcome> {
  const { ui } = deps;
  if (await workerHasGithub(o.url, o.control, deps.fetch)) {
    ui.step("✓ GitHub token on the Worker (private repositories, push and gh work in workspaces)");
    return "already";
  }
  const later = (why: string): GithubOutcome => {
    ui.step(`! ${why}; ${GITHUB_HINT}`);
    return "skipped";
  };
  if (o.skip) return later("GitHub not set up (--no-github)");
  if (o.canStore === false) return later("no GitHub token on the Worker");

  // An automated run in CI has a short-lived job token, which is no use to a workspace later.
  const ci = Boolean(deps.env.CI || deps.env.GITHUB_ACTIONS);
  let token = ci && !o.interactive ? undefined : await ghLoginToken(deps.run);

  if (o.interactive) {
    const intro = "Workspaces need a GitHub token to clone private repositories, push and run gh.";
    if (token) {
      const a = await deps.ask(
        `${intro}\nUse this machine's gh login? It stays in the Worker, never in a workspace. [Y/n] `,
      );
      if (!yes(a)) token = undefined;
    } else ui.step(intro);
    if (!token) {
      token = await deps.readSecret(
        "Paste a GitHub token (fine-grained, Contents read and write), or press Enter to skip: ",
      );
      if (!token) return later("GitHub not set up");
    }
  } else if (!token) {
    return later(ci ? "GitHub not set up in CI" : "gh is not logged in on this machine");
  } else {
    ui.step("… using this machine's gh login for workspaces (skip with --no-github)");
  }

  try {
    await gitToken({
      token,
      remove: false,
      run: deps.run,
      ui,
      ...(o.apiToken ? { apiToken: o.apiToken } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    return "stored";
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e))
      .replace(/^Failed: /, "")
      .replace(/ — fix: .*$/, "");
    return later(`GitHub token not stored (${msg})`);
  }
}
