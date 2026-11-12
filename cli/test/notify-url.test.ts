// `cf-opencode notify-url`: the notify URL is the Worker secret NOTIFY_URL, set like GITHUB_TOKEN. The value
// reaches wrangler on stdin only and is never printed; a notifyUrl key in the settings file fails before a deploy.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSettings } from "../src/init.js";
import { notifyUrl } from "../src/manage.js";
import { checkNotifyUrl } from "../src/notify-key.js";
import type { RunOptions, RunResult } from "../src/wrangler.js";

const saved = process.env.HOME;
let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cfoc-notify-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".cf-opencode"), { recursive: true });
  writeFileSync(
    join(home, ".cf-opencode", "install.json"),
    JSON.stringify({ url: "https://cf-opencode.sub.workers.dev", name: "cf-opencode" }),
  );
});
afterEach(() => {
  process.env.HOME = saved;
});

const URL_WITH_SECRET = "https://hooks.example.com/services/T000/B000/secret-part-0123456789";

function fake(code = 0) {
  const calls: { args: string[]; opts: RunOptions }[] = [];
  const lines: string[] = [];
  const run = async (cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    calls.push({ args: [cmd, ...args], opts });
    return { code, stdout: "", stderr: code ? "Authentication error" : "" };
  };
  const ui = { json: false, step: (l: string) => lines.push(l), out: () => {}, result: () => {} };
  return { calls, lines, run, ui };
}

describe("cf-opencode notify-url", () => {
  it("stores NOTIFY_URL through stdin, never in argv or output", async () => {
    const f = fake();
    await notifyUrl({ url: `${URL_WITH_SECRET}\n`, remove: false, run: f.run, ui: f.ui });
    const put = f.calls.find((c) => c.args.includes("put"));
    expect(put?.args).toContain("NOTIFY_URL");
    expect(put?.opts.input).toBe(URL_WITH_SECRET);
    expect(f.calls.every((c) => !c.args.join(" ").includes("secret-part"))).toBe(true);
    expect(f.lines.join("\n")).not.toContain("secret-part");
  });

  it("refuses a URL the Worker would refuse, without echoing it", async () => {
    for (const bad of [
      "",
      "http://hooks.example.com/x",
      "https://u:p@hooks.example.com/x",
      "https://10.0.0.1/x",
    ]) {
      const f = fake();
      const e = await notifyUrl({ url: bad, remove: false, run: f.run, ui: f.ui }).catch((x: Error) => x);
      expect(e).toBeInstanceOf(Error);
      if (bad) expect((e as Error).message).not.toContain(bad);
      expect(f.calls).toHaveLength(0);
    }
  });

  it("--remove deletes the secret", async () => {
    const f = fake();
    await notifyUrl({ remove: true, run: f.run, ui: f.ui });
    expect(f.calls[0]?.args).toEqual(expect.arrayContaining(["secret", "delete", "NOTIFY_URL"]));
  });

  it("the rules match the Worker's", () => {
    expect(checkNotifyUrl(URL_WITH_SECRET)).toBeUndefined();
    expect(checkNotifyUrl("https://localhost/x")).toMatch(/public host/);
    expect(checkNotifyUrl("https://[::1]/x")).toMatch(/public host/);
  });
});

describe("settings file", () => {
  it("a notifyUrl key fails with the fix, before any deploy", () => {
    const path = join(home, ".cf-opencode", "config.json");
    writeFileSync(path, JSON.stringify({ notifyUrl: URL_WITH_SECRET }));
    expect(() => readSettings(path)).toThrow(/notifyUrl .* no longer a setting/);
    writeFileSync(path, JSON.stringify({ idlePauseMinutes: 30 }));
    expect(readSettings(path)).toEqual({ idlePauseMinutes: 30 });
  });
});
