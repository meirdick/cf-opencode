// authorized_keys holds the CLI keys seen in the last 30 days, in one block. Before, the prep script only
// appended, so every key that ever connected (an old laptop, a former holder of the password) stayed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SSH_PREP_SH } from "../src/orb/scripts";
import {
  AUTHORIZED_KEYS_SH,
  installSshKeys,
  KEYS_BEGIN,
  KEYS_END,
  MAX_SSH_KEYS,
  recordSshKey,
  SSH_KEY_DAYS,
} from "../src/orb/ssh-keys";
import { FakeClock, FakeContainer, MemoryKV } from "./fake-container";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");
const key = (n: number, comment = "cf-opencode") => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${n}xyz ${comment}`;

describe("recordSshKey", () => {
  it("keeps every machine that connected in the last 30 days, newest first", async () => {
    const kv = new MemoryKV();
    await recordSshKey(kv, key(1), T0);
    expect(await recordSshKey(kv, key(2), T0 + DAY)).toEqual([key(2), key(1)]);
  });

  it("drops a key that has not connected for 30 days", async () => {
    const kv = new MemoryKV();
    await recordSshKey(kv, key(1), T0);
    const later = T0 + (SSH_KEY_DAYS + 1) * DAY;
    expect(await recordSshKey(kv, key(2), later)).toEqual([key(2)]);
  });

  it("a key with a new comment is the same key", async () => {
    const kv = new MemoryKV();
    await recordSshKey(kv, key(1), T0);
    expect(await recordSshKey(kv, key(1, "laptop"), T0 + 1)).toEqual([key(1, "laptop")]);
  });

  it("holds at most MAX_SSH_KEYS keys", async () => {
    const kv = new MemoryKV();
    let out: string[] = [];
    for (let i = 0; i < MAX_SSH_KEYS + 5; i++) out = await recordSshKey(kv, key(i), T0 + i);
    expect(out).toHaveLength(MAX_SSH_KEYS);
    expect(out[0]).toBe(key(MAX_SSH_KEYS + 4));
  });
});

function runKeys(file: string, keys: string[]) {
  return spawnSync("bash", ["-c", AUTHORIZED_KEYS_SH], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/nonexistent",
      AUTHORIZED_KEYS_FILE: file,
      AUTHORIZED_KEYS: keys.join("\n"),
    },
    encoding: "utf8",
  });
}

describe.skipIf(process.platform === "win32")("AUTHORIZED_KEYS_SH", () => {
  it("replaces the cf-opencode block, keeps the user's lines, drops keys an earlier release appended", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfoc-keys-"));
    const file = join(dir, ".ssh", "authorized_keys");
    runKeys(file, [key(9)]);
    const mine = "ssh-ed25519 AAAAmine me@laptop";
    writeFileSync(file, `${mine}\n${key(1)}\n${readFileSync(file, "utf8")}# a note\n`);

    const r = runKeys(file, [key(2), key(3)]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("keys 2");
    const text = readFileSync(file, "utf8");
    expect(text).toBe(`${mine}\n# a note\n${KEYS_BEGIN}\n${key(2)}\n${key(3)}\n${KEYS_END}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, ".ssh")).mode & 0o777).toBe(0o700);

    runKeys(file, [key(2), key(3)]);
    expect(readFileSync(file, "utf8")).toBe(text);
  });
});

describe.skipIf(process.platform === "win32")("installSshKeys", () => {
  it("writes the current key set as the workspace user, never as root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfoc-keys-"));
    const file = join(dir, "authorized_keys");
    const c = new FakeContainer(new FakeClock());
    c.running = true;
    const users: (string | undefined)[] = [];
    c.handler = (cmd, opts) => {
      users.push(opts.user);
      const r = spawnSync(cmd[0] as string, cmd.slice(1), {
        env: { ...opts.env, PATH: "/usr/bin:/bin", AUTHORIZED_KEYS_FILE: file },
        encoding: "utf8",
      });
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    };
    const kv = new MemoryKV();
    expect(await installSshKeys(c, kv, key(1), T0)).toBeUndefined();
    expect(await installSshKeys(c, kv, key(2), T0 + DAY)).toBeUndefined();
    expect(readFileSync(file, "utf8")).toContain(`${KEYS_BEGIN}\n${key(2)}\n${key(1)}\n${KEYS_END}`);
    expect(await installSshKeys(c, kv, key(2), T0 + 40 * DAY)).toBeUndefined();
    expect(readFileSync(file, "utf8")).not.toContain(key(1));
    expect(users).toEqual(["1000:1000", "1000:1000", "1000:1000"]);
  });

  it("the root prep script no longer writes in the user's home", () => {
    expect(SSH_PREP_SH).not.toContain("/home/user");
  });
});
