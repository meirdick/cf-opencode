import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init, type Probes, preflight } from "../src/init.js";
import { selectResources } from "../src/manage.js";
import type { Ui } from "../src/ui.js";
import type { RunOptions, RunResult } from "../src/wrangler.js";

const saved = process.env.HOME;
beforeEach(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), "cfoc-init-"));
});
afterEach(() => {
  process.env.HOME = saved;
});

const ACCOUNT = { id: "acc1", name: "Main" };
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const quiet: Ui = { json: false, step: () => {}, out: () => {}, result: () => {} };

/** A fake wrangler and docker. `deploy` answers with the given results in turn. */
function fakeRun(o: { workerExists?: boolean; deploys?: RunResult[]; loggedIn?: boolean } = {}) {
  const calls: { args: string[]; opts: RunOptions }[] = [];
  const deploys = [...(o.deploys ?? [ok("Uploaded\nhttps://cfo.sub.workers.dev\nCurrent Version ID: x")])];
  const run = async (cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    calls.push({ args: [cmd, ...args], opts });
    if (cmd === "docker") return ok("27.3.1\n");
    const sub = args.find((a) => !a.includes("/") && !a.startsWith("-") && a !== "--yes") ?? "";
    if (sub === "whoami") {
      return ok(
        JSON.stringify({ loggedIn: o.loggedIn ?? true, email: "me@example.com", accounts: [ACCOUNT] }),
      );
    }
    if (sub === "containers") return ok("[]");
    if (sub === "deployments") {
      return o.workerExists
        ? ok("[{}]")
        : { code: 1, stdout: "", stderr: "This Worker does not exist on your account. [code: 10007]" };
    }
    if (sub === "deploy") return deploys.shift() ?? { code: 1, stdout: "", stderr: "no more deploys" };
    return ok();
  };
  return { calls, run };
}

// The version of the sources the tests deploy, as the Worker would report it after the deploy.
const DEPLOYED = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
const healthy = (async () => new Response(JSON.stringify({ ok: true, version: DEPLOYED }))) as typeof fetch;

describe("preflight", () => {
  const base: Probes = {
    node: "v22.11.0",
    docker: "27.3.1",
    buildx: true,
    whoami: { loggedIn: true, accounts: [ACCOUNT] },
    apiToken: false,
    interactive: false,
  };

  it("reports every blocker at once, each as a Failed line with a fix", () => {
    const r = preflight(
      {},
      { ...base, node: "v20.1.0", docker: undefined, whoami: { loggedIn: false, accounts: [] } },
    );
    expect(r.kind).toBe("fail");
    const lines = r.kind === "fail" ? r.errors.map((e) => e.message) : [];
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).toMatch(
      /Node v20.1.0.*fix:[\s\S]*Docker.*fix:[\s\S]*not logged in.*fix: run npx wrangler login/,
    );
  });

  it("names the missing buildx plugin instead of letting the build fail with exit 125", () => {
    const r = preflight({}, { ...base, buildx: false });
    expect(r.kind === "fail" && r.errors[0]?.message).toMatch(/buildx.*fix: install it/);
  });

  it("offers a browser login on a terminal, but not over a token that failed", () => {
    const out = { ...base, whoami: { loggedIn: false, accounts: [] }, interactive: true };
    expect(preflight({}, out).kind).toBe("login");
    const r = preflight({}, { ...out, apiToken: true });
    expect(r.kind === "fail" && r.errors[0]?.message).toMatch(/rejected the API token/);
  });

  it("asks which account on a terminal and demands --account without one", () => {
    const two = { loggedIn: true, accounts: [ACCOUNT, { id: "acc2", name: "Work" }] };
    expect(preflight({}, { ...base, whoami: two, interactive: true }).kind).toBe("pick");
    const r = preflight({}, { ...base, whoami: two });
    expect(r.kind === "fail" && r.errors[0]?.message).toMatch(/--account/);
    expect(preflight({ accountId: "acc2" }, { ...base, whoami: two })).toEqual({
      kind: "ok",
      account: { id: "acc2", name: "Work" },
    });
    expect(preflight({ accountId: "nope" }, { ...base, whoami: two }).kind).toBe("fail");
  });
});

describe("init", () => {
  it("deploys a copy of the sources, stores the token through stdin only, and waits for health", async () => {
    const { calls, run } = fakeRun();
    const tokenFile = join(process.env.HOME as string, "api");
    writeFileSync(tokenFile, "api-secret-123\n");
    const r = await init({ tokenFile, nonInteractive: true }, { run, ui: quiet, env: {}, fetch: healthy });
    expect(r).toMatchObject({
      url: "https://cfo.sub.workers.dev",
      name: "cf-opencode",
      accountId: "acc1",
      deployed: true,
    });

    const control = readFileSync(r.tokenPath, "utf8");
    expect(control.length).toBeGreaterThan(30);
    expect(statSync(r.tokenPath).mode & 0o777).toBe(0o600);
    const argv = calls.map((c) => c.args.join(" ")).join("\n");
    expect(argv).not.toContain("api-secret-123");
    expect(argv).not.toContain(control);
    const put = calls.find((c) => c.args.includes("secret"));
    expect(put?.opts.input).toBe(control);
    expect(
      calls.every(
        (c) =>
          ["docker", "gh"].includes(c.args[0] ?? "") || c.opts.env?.CLOUDFLARE_API_TOKEN === "api-secret-123",
      ),
    ).toBe(true);

    const deploy = calls.find((c) => c.args.includes("deploy"));
    expect(deploy?.opts.env?.CLOUDFLARE_ACCOUNT_ID).toBe("acc1");
    const dir = deploy?.opts.cwd as string;
    expect(existsSync(join(dir, "worker", "src", "index.ts"))).toBe(true);
    expect(existsSync(join(dir, "worker", "wrangler.jsonc"))).toBe(true);
    expect(existsSync(join(dir, "image", "Dockerfile"))).toBe(true);
    expect(existsSync(join(dir, "worker", "test"))).toBe(false);

    const install = JSON.parse(readFileSync(join(r.tokenPath, "..", "install.json"), "utf8"));
    expect(install).toEqual({ url: r.url, name: "cf-opencode", accountId: "acc1" });
  });

  it("names the Worker and its container app in the deployed config, so two installs do not collide", async () => {
    const { calls, run } = fakeRun();
    await init({ name: "cfo-two", nonInteractive: true }, { run, ui: quiet, env: {}, fetch: healthy });
    const dir = calls.find((c) => c.args.includes("deploy"))?.opts.cwd as string;
    const cfg = readFileSync(join(dir, "worker", "wrangler.jsonc"), "utf8");
    expect(cfg).toMatch(/^\s*"name": "cfo-two",$/m);
    expect(cfg).not.toContain('"cf-opencode"');
  });

  it("keeps the control token across a rerun, so other machines keep working", async () => {
    const first = await init(
      { nonInteractive: true },
      { run: fakeRun().run, ui: quiet, env: { CLOUDFLARE_API_TOKEN: "t" }, fetch: healthy },
    );
    const token = readFileSync(first.tokenPath, "utf8");
    const { calls, run } = fakeRun({ workerExists: true });
    await init(
      { nonInteractive: true },
      { run, ui: quiet, env: { CLOUDFLARE_API_TOKEN: "t" }, fetch: healthy },
    );
    expect(readFileSync(first.tokenPath, "utf8")).toBe(token);
    expect(calls.find((c) => c.args.includes("secret"))?.opts.input).toBe(token);
  });

  it("refuses to overwrite a Worker this machine did not deploy, unless --adopt", async () => {
    const { calls, run } = fakeRun({ workerExists: true });
    await expect(init({ nonInteractive: true }, { run, ui: quiet, env: {}, fetch: healthy })).rejects.toThrow(
      /already exists.*--adopt/,
    );
    expect(calls.some((c) => c.args.includes("deploy"))).toBe(false);
    const again = fakeRun({ workerExists: true });
    await expect(
      init({ nonInteractive: true, adopt: true }, { run: again.run, ui: quiet, env: {}, fetch: healthy }),
    ).resolves.toMatchObject({ deployed: true });
  });

  it("finishes a first deploy that failed after creating the Worker, without --adopt", async () => {
    const half = {
      code: 1,
      stdout: "",
      stderr: "Container application settings were not fully applied. Re-run",
    };
    const first = fakeRun({ deploys: [half, half, half] });
    await expect(
      init({ nonInteractive: true }, { run: first.run, ui: quiet, env: {}, fetch: healthy }),
    ).rejects.toThrow(/transient/);
    expect(first.calls.filter((c) => c.args.includes("deploy"))).toHaveLength(3);
    const rerun = fakeRun({ workerExists: true });
    await expect(
      init({ nonInteractive: true }, { run: rerun.run, ui: quiet, env: {}, fetch: healthy }),
    ).resolves.toMatchObject({ deployed: true });
  });

  it("retries the registry push flake, and does not retry a plan error", async () => {
    const flake = { code: 1, stdout: "Pushed layer\n", stderr: "Unauthorized" };
    const { calls, run } = fakeRun({ deploys: [flake, ok("https://cf-opencode.sub.workers.dev")] });
    await init({ nonInteractive: true }, { run, ui: quiet, env: {}, fetch: healthy });
    expect(calls.filter((c) => c.args.includes("deploy"))).toHaveLength(2);

    const dropped = {
      code: 1,
      stdout:
        "The push refers to repository [registry.cloudflare.com/acct/cf-opencode-workspacesession-orb]\n",
      stderr:
        'failed to copy: failed to do request: Put "https://registry.cloudflare.com/v2/x": write tcp: use of closed network connection',
    };
    const second = fakeRun({ deploys: [dropped, ok("https://cf-opencode.sub.workers.dev")] });
    await init({ nonInteractive: true }, { run: second.run, ui: quiet, env: {}, fetch: healthy });
    expect(second.calls.filter((c) => c.args.includes("deploy"))).toHaveLength(2);

    const paid = fakeRun({
      deploys: [
        { code: 1, stdout: "", stderr: "You must be on the Workers Paid plan" },
        ok("https://x.y.workers.dev"),
      ],
    });
    await expect(
      init({ nonInteractive: true }, { run: paid.run, ui: quiet, env: {}, fetch: healthy }),
    ).rejects.toThrow(/Workers Paid/);
    expect(paid.calls.filter((c) => c.args.includes("deploy"))).toHaveLength(1);
  });

  it("--url needs the other machine's control token and checks it against the Worker", async () => {
    const { calls, run } = fakeRun();
    const deps = { run, ui: quiet, fetch: healthy };
    await expect(init({ url: "https://cf-opencode.sub.workers.dev" }, { ...deps, env: {} })).rejects.toThrow(
      /no control token/,
    );
    const r = await init(
      { url: "https://cf-opencode.sub.workers.dev/" },
      { ...deps, env: { CF_OPENCODE_CONTROL_TOKEN: "ctl" } },
    );
    expect(r).toMatchObject({
      url: "https://cf-opencode.sub.workers.dev",
      deployed: false,
      name: "cf-opencode",
    });
    const other = await init(
      { url: "https://cfo-team.sub.workers.dev" },
      { ...deps, env: { CF_OPENCODE_CONTROL_TOKEN: "ctl" } },
    );
    expect(other.name).toBe("cfo-team");
    expect(readFileSync(r.tokenPath, "utf8")).toBe("ctl");
    expect(calls).toHaveLength(0);
    const denied = (async () =>
      new Response('{"error":"Failed: missing or wrong bearer token — fix: x"}', {
        status: 401,
      })) as typeof fetch;
    await expect(
      init(
        { url: "https://a.b.workers.dev" },
        { run, ui: quiet, fetch: denied, healthMs: 0, env: { CF_OPENCODE_CONTROL_TOKEN: "bad" } },
      ),
    ).rejects.toThrow(/did not accept the control token/);
  });

  it("rejects a URL that is not a workers.dev host", async () => {
    await expect(
      init(
        { url: "https://example.com" },
        { run: fakeRun().run, ui: quiet, env: { CF_OPENCODE_CONTROL_TOKEN: "x" } },
      ),
    ).rejects.toThrow(/workers\.dev/);
  });
});

describe("uninstall", () => {
  it("selects only this install's container app and image tags", () => {
    const apps = JSON.stringify([
      { id: "1", name: "cf-opencode-workspacesession" },
      { id: "2", name: "cf-opencode-two-workspacesession" },
      { id: "3", name: "other-app" },
    ]);
    const images = JSON.stringify([
      { name: "cf-opencode-workspacesession-orb", tags: ["a", "b"] },
      { name: "cf-opencode-two-workspacesession-orb", tags: ["c"] },
    ]);
    expect(selectResources("cf-opencode", apps, images)).toEqual({
      worker: "cf-opencode",
      apps: [{ id: "1", name: "cf-opencode-workspacesession" }],
      images: ["cf-opencode-workspacesession-orb:a", "cf-opencode-workspacesession-orb:b"],
    });
  });
});

describe("settings file", () => {
  const jsonc = `{
  "name": "cf-opencode",
  "vars": {
    "CF_OPENCODE_CONFIG": ${JSON.stringify(JSON.stringify({ instance: { vcpu: 2, memoryMib: 6144 }, idlePauseMinutes: 20 }))}
  }
}`;
  const config = (text: string) =>
    JSON.parse(
      (JSON.parse(text.replace(/\/\/.*$/gm, "")) as { vars: { CF_OPENCODE_CONFIG: string } }).vars
        .CF_OPENCODE_CONFIG,
    );

  it("replaces defaults, merges instance key by key, and leaves the file alone when empty", async () => {
    const { applySettings } = await import("../src/init.js");
    expect(applySettings(jsonc, {})).toBe(jsonc);
    const out = applySettings(jsonc, { idlePauseMinutes: 45, model: "a/b", instance: { memoryMib: 8192 } });
    expect(config(out)).toEqual({
      instance: { vcpu: 2, memoryMib: 8192 },
      idlePauseMinutes: 45,
      model: "a/b",
    });
  });

  it("reads ~/.cf-opencode/config.json, and names the fix for a bad file", async () => {
    const { readSettings } = await import("../src/init.js");
    const dir = mkdtempSync(join(tmpdir(), "cfoc-settings-"));
    expect(readSettings(join(dir, "none.json"))).toEqual({});
    writeFileSync(join(dir, "ok.json"), '{"idlePauseMinutes":30}');
    expect(readSettings(join(dir, "ok.json"))).toEqual({ idlePauseMinutes: 30 });
    writeFileSync(join(dir, "bad.json"), "{nope");
    expect(() => readSettings(join(dir, "bad.json"))).toThrow(/is not JSON.*fix:/);
    writeFileSync(join(dir, "list.json"), "[1]");
    expect(() => readSettings(join(dir, "list.json"))).toThrow(/one JSON object/);
  });
});

describe("init after a deploy", () => {
  it("waits for the deployed version, and reports the old one only when it never changes", async () => {
    let n = 0;
    const slow = (async () =>
      new Response(JSON.stringify({ ok: true, version: ++n < 3 ? "0.0.9" : DEPLOYED }))) as typeof fetch;
    const lines: string[] = [];
    const ui: Ui = { json: false, step: (l) => lines.push(l), out: () => {}, result: () => {} };
    const r = await init({ nonInteractive: true }, { run: fakeRun().run, ui, env: {}, fetch: slow });
    expect(r.version).toBe(DEPLOYED);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(lines.join("\n")).toContain(`Worker healthy (API ${DEPLOYED})`);

    const stuck = (async () => new Response(JSON.stringify({ ok: true, version: "0.0.9" }))) as typeof fetch;
    const old = await init(
      { nonInteractive: true },
      { run: fakeRun({ workerExists: true }).run, ui: quiet, env: {}, fetch: stuck, versionMs: 0 },
    );
    expect(old.version).toBe("0.0.9");
  });
});
