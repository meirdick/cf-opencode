import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInstall, writeInstall } from "../src/config.js";
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
    if (sub === "auth") return ok('{"type":"oauth","token":"oauth-tok"}');
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

  it("takes a Custom Domain URL, and refuses a URL with a path or without https", async () => {
    const deps = { run: fakeRun().run, ui: quiet, fetch: healthy, env: { CF_OPENCODE_CONTROL_TOKEN: "x" } };
    await expect(init({ url: "https://code.example.com/" }, deps)).resolves.toMatchObject({
      url: "https://code.example.com",
      name: "cf-opencode",
    });
    for (const bad of ["http://code.example.com", "https://code.example.com/oc", "code.example.com"])
      await expect(init({ url: bad }, deps)).rejects.toThrow(
        /^Failed: .* — fix: pass (the Worker URL, )?https:/,
      );
  });

  it("--url repairs the recorded URL after a rename, and keeps the account and the Custom Domain", async () => {
    writeInstall({
      url: "https://cf-opencode.old.workers.dev",
      name: "cf-opencode",
      accountId: "acc1",
      domain: "code.example.com",
    });
    const lines: string[] = [];
    const ui: Ui = { ...quiet, step: (l) => lines.push(l) };
    const env = { CF_OPENCODE_CONTROL_TOKEN: "ctl" };
    await init(
      { url: "https://cf-opencode.new.workers.dev" },
      { run: fakeRun().run, ui, fetch: healthy, env },
    );
    expect(readInstall()).toEqual({
      url: "https://cf-opencode.new.workers.dev",
      name: "cf-opencode",
      accountId: "acc1",
      domain: "code.example.com",
    });
    expect(lines.join("\n")).toContain("Replaced the recorded URL https://cf-opencode.old.workers.dev");
  });

  it("refuses --url with --domain", async () => {
    await expect(
      init(
        { url: "https://code.example.com", domain: "code.example.com" },
        { run: fakeRun().run, ui: quiet, env: {} },
      ),
    ).rejects.toThrow(/--url and --domain do not go together/);
  });
});

describe("init --domain", () => {
  const API = "https://api.cloudflare.com/client/v4";
  const zone = { id: "z1", name: "example.com", status: "active", name_servers: ["ns1.example.net"] };
  /** The Cloudflare API by path, the Worker for every other URL. */
  function router(o: { zones?: unknown[]; owner?: string; records?: unknown[]; domainUp?: boolean } = {}) {
    const seen: string[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      const answer = (result: unknown) => new Response(JSON.stringify({ success: true, result }));
      if (url.startsWith(API)) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oauth-tok");
        const u = new URL(url);
        if (u.pathname.endsWith("/zones"))
          return answer(u.searchParams.get("name") === "example.com" ? (o.zones ?? [zone]) : []);
        if (u.pathname.endsWith("/workers/domains"))
          return answer(o.owner ? [{ hostname: "code.example.com", service: o.owner }] : []);
        if (u.pathname.endsWith("/dns_records")) return answer(o.records ?? []);
        return new Response("{}", { status: 404 });
      }
      if (url.startsWith("https://code.example.com") && o.domainUp === false) throw new Error("ENOTFOUND");
      return healthy(input as string, init);
    }) as typeof fetch;
    return { seen, f };
  }

  it("deploys with the route in the copied config and records https://<domain>", async () => {
    const { calls, run } = fakeRun();
    const { seen, f } = router();
    const r = await init(
      { domain: "code.example.com", nonInteractive: true },
      { run, ui: quiet, env: {}, fetch: f, resolveDns: async () => ({ kind: "known", value: [] }) },
    );
    expect(r.url).toBe("https://code.example.com");
    expect(readInstall()).toEqual({
      url: "https://code.example.com",
      name: "cf-opencode",
      accountId: "acc1",
      domain: "code.example.com",
    });
    const dir = calls.find((c) => c.args.includes("deploy"))?.opts.cwd as string;
    const cfg = JSON.parse(
      readFileSync(join(dir, "worker", "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
    ) as Record<string, unknown>;
    expect(cfg.routes).toEqual([{ pattern: "code.example.com", custom_domain: true }]);
    expect(cfg.workers_dev).toBe(true);
    expect(cfg.name).toBe("cf-opencode");
    // The deploy is proven on workers.dev; the domain is asked after.
    expect(seen.some((u) => u.startsWith("https://cfo.sub.workers.dev/v1/health"))).toBe(true);
    expect(seen.some((u) => u.startsWith("https://code.example.com/v1/health"))).toBe(true);
    // The token for the checks came from wrangler on stdout, never from argv.
    expect(calls.map((c) => c.args.join(" ")).join("\n")).not.toContain("oauth-tok");
  });

  it("stops before any deploy when the account has no zone for the hostname", async () => {
    const { calls, run } = fakeRun();
    const { f } = router({ zones: [] });
    const err = await init(
      { domain: "code.example.com", nonInteractive: true },
      { run, ui: quiet, env: {}, fetch: f },
    ).catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(
      /^Failed: no zone for code\.example\.com in this Cloudflare account — fix: [^\n]+$/,
    );
    expect(calls.some((c) => c.args.includes("deploy"))).toBe(false);
    expect(readInstall()).toBeUndefined();
  });

  it("does not replace DNS records or another Worker's domain without --adopt", async () => {
    const records = router({ records: [{ name: "code.example.com", type: "A" }] });
    await expect(
      init(
        { domain: "code.example.com", nonInteractive: true },
        { run: fakeRun().run, ui: quiet, env: {}, fetch: records.f },
      ),
    ).rejects.toThrow(/has DNS records \(A\)/);
    const other = router({ owner: "blog" });
    await expect(
      init(
        { domain: "code.example.com", nonInteractive: true },
        { run: fakeRun().run, ui: quiet, env: {}, fetch: other.f },
      ),
    ).rejects.toThrow(/Custom Domain of the Worker blog/);
  });

  it("a rerun keeps the recorded domain, and a domain that does not answer yet is a warning", async () => {
    await init(
      { domain: "code.example.com", nonInteractive: true },
      { run: fakeRun().run, ui: quiet, env: {}, fetch: router().f },
    );
    const lines: string[] = [];
    const { calls, run } = fakeRun({ workerExists: true });
    const later = router({
      owner: "cf-opencode",
      records: [{ name: "code.example.com", type: "AAAA" }],
      domainUp: false,
    });
    const r = await init(
      { nonInteractive: true },
      { run, ui: { ...quiet, step: (l) => lines.push(l) }, env: {}, fetch: later.f, domainMs: 0 },
    );
    expect(r.url).toBe("https://code.example.com");
    const dir = calls.find((c) => c.args.includes("deploy"))?.opts.cwd as string;
    expect(readFileSync(join(dir, "worker", "wrangler.jsonc"), "utf8")).toContain(
      '"pattern": "code.example.com"',
    );
    expect(lines.join("\n")).toMatch(
      /! https:\/\/code\.example\.com does not answer yet .*cf-opencode doctor/,
    );
    expect(readInstall()?.domain).toBe("code.example.com");
  });

  it("refuses a value that is not a hostname in preflight", async () => {
    await expect(
      init(
        { domain: "https://code.example.com", nonInteractive: true },
        { run: fakeRun().run, ui: quiet, env: {}, fetch: healthy },
      ),
    ).rejects.toThrow(/is not a hostname/);
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
