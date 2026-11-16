import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeInstall, writeSecret } from "../src/config.js";
import { type Check, doctor, findWorker, renderChecks } from "../src/manage.js";
import type { RunResult } from "../src/wrangler.js";

const saved = process.env.HOME;
beforeEach(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), "cfoc-doctor-"));
  writeSecret(join(process.env.HOME, ".cf-opencode", "control-token"), "ctl");
});
afterEach(() => {
  process.env.HOME = saved;
});

const OLD = "https://cf-opencode.old.workers.dev";
const NEW = "https://cf-opencode.new.workers.dev";
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

/** opencode, ssh, and a wrangler that sees the Worker (or not) and has a login token. */
function fakeRun(o: { workerExists?: boolean } = {}) {
  return async (cmd: string, args: string[]): Promise<RunResult> => {
    if (cmd === "opencode") return ok("opencode 2.0.1");
    if (cmd === "ssh") return { code: 0, stdout: "", stderr: "OpenSSH_9.9" };
    if (args.includes("deployments"))
      return o.workerExists === false
        ? { code: 1, stdout: "", stderr: "This Worker does not exist on your account. [code: 10007]" }
        : ok("[{}]");
    if (args.includes("auth")) return ok('{"type":"oauth","token":"oauth-tok"}');
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
}

/** The old URL answers with Cloudflare's own page; the new one is the Worker; the API names the subdomain. */
const net = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("/workers/subdomain"))
    return new Response(JSON.stringify({ success: true, result: { subdomain: "new" } }));
  if (url.startsWith(NEW)) {
    if (url.endsWith("/v1/status"))
      return new Response(
        JSON.stringify({ version: "9.9.9", config: {}, bindings: { ai: true, browser: true } }),
      );
    return new Response(JSON.stringify({ ok: true, version: "9.9.9" }));
  }
  return new Response("error code: 1042", { status: 404 });
}) as typeof fetch;

const base = { cliVersion: "9.9.9", env: {}, fetch: net, sleep: async () => {} };
const line = (checks: Check[], name: string) => renderChecks(checks.filter((c) => c.name === name));

describe("doctor", () => {
  it("shows the URL in use and where it comes from, and checks it", async () => {
    writeInstall({ url: NEW, name: "cf-opencode", accountId: "acc1", domain: "code.example.com" });
    const checks = await doctor({ ...base, run: fakeRun() });
    expect(line(checks, "url")).toMatch(
      /^✓ url\s+https:\/\/cf-opencode\.new\.workers\.dev \(from .*install\.json, Worker cf-opencode, Custom Domain code\.example\.com\)$/,
    );
    expect(line(checks, "worker")).toMatch(/✓ worker\s+API 9\.9\.9, control token accepted/);
    const env = await doctor({ ...base, env: { CF_OPENCODE_URL: NEW }, run: fakeRun() });
    expect(line(env, "url")).toMatch(/from CF_OPENCODE_URL/);
  });

  it("names the repair command after the workers.dev subdomain changed", async () => {
    writeInstall({ url: OLD, name: "cf-opencode", accountId: "acc1" });
    const checks = await doctor({ ...base, run: fakeRun() });
    expect(line(checks, "worker")).toMatch(
      /^✗ worker\s+.*Worker cf-opencode answers at https:\/\/cf-opencode\.new\.workers\.dev — fix: cf-opencode init --url https:\/\/cf-opencode\.new\.workers\.dev$/,
    );
  });

  it("says when the Worker is gone, and keeps the token fix for a 401", async () => {
    writeInstall({ url: OLD, name: "cf-opencode", accountId: "acc1" });
    const gone = await doctor({ ...base, run: fakeRun({ workerExists: false }) });
    expect(line(gone, "worker")).toMatch(/is not in the account — fix: cf-opencode init$/);
    const denied = (async () => new Response("Unauthorized", { status: 401 })) as typeof fetch;
    const refused = await doctor({ ...base, fetch: denied, run: fakeRun() });
    expect(line(refused, "worker")).toMatch(
      /refused the control token.*— fix: copy ~\/\.cf-opencode\/control-token/,
    );
  });
});

describe("findWorker", () => {
  it("does not offer a URL that does not accept the control token", async () => {
    const elsewhere = (async (input: string | URL | Request) =>
      String(input).includes("/workers/subdomain")
        ? new Response(JSON.stringify({ success: true, result: { subdomain: "new" } }))
        : new Response("Unauthorized", { status: 401 })) as typeof fetch;
    const r = await findWorker({
      name: "cf-opencode",
      accountId: "acc1",
      current: OLD,
      token: "ctl",
      run: fakeRun(),
      fetch: elsewhere,
    });
    expect(r).toEqual({ kind: "found" });
  });
});
