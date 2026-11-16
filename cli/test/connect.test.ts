import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connect, httpsRemote, workspaceIdFrom } from "../src/connect.js";

describe("workspaceIdFrom", () => {
  it("uses the directory name, lowercased and scrubbed", () => {
    expect(workspaceIdFrom("/home/user/My Repo")).toBe("my-repo");
  });

  it("prefixes a name that would not be a legal id", () => {
    expect(workspaceIdFrom("/tmp/-bad")).toBe("w--bad");
  });
});

describe("connect", () => {
  it("refuses a session id in the place of a workspace id, before any request", async () => {
    const home = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "cfoc-connect-"));
    try {
      await expect(
        connect({ url: "http://127.0.0.1:9", token: "t", id: "ses_abc123", attach: false }),
      ).rejects.toThrow(
        /^Failed: ses_abc123 is a session id, not a workspace — fix: cf-opencode connect <workspace> --session ses_abc123, or cf-opencode tasks ses_abc123$/,
      );
    } finally {
      process.env.HOME = home;
    }
  });
});

describe("httpsRemote", () => {
  it("turns SSH remotes into the HTTPS URL the workspace clones over", () => {
    expect(httpsRemote("git@github.com:acme/app.git")).toBe("https://github.com/acme/app.git");
    expect(httpsRemote("ssh://git@github.com/acme/app.git")).toBe("https://github.com/acme/app.git");
    expect(httpsRemote("ssh://git@gitlab.example.com:2222/team/app")).toBe(
      "https://gitlab.example.com/team/app",
    );
    expect(httpsRemote("https://github.com/acme/app.git")).toBe("https://github.com/acme/app.git");
    expect(httpsRemote("/srv/git/app.git")).toBeUndefined();
  });
});

describe("restartedByDeploy", () => {
  it("knows the error a deploy causes, and no other", async () => {
    const { restartedByDeploy } = await import("../src/connect.js");
    expect(
      restartedByDeploy(
        "Failed: internal error: Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
      ),
    ).toBe(true);
    expect(restartedByDeploy(new Error("Failed: repo prepare failed: git clone exited 128"))).toBe(false);
    expect(restartedByDeploy(undefined)).toBe(false);
  });
});

describe("attachArgs", () => {
  it("points the local client at the workspace, and at a session when asked", async () => {
    const { attachArgs } = await import("../src/connect.js");
    const url = "https://w.example/oc/app";
    expect(attachArgs(url)).toEqual(["--server", url]);
    expect(attachArgs(url, { continueLast: true })).toEqual(["--server", url, "--continue"]);
    expect(attachArgs(url, { continueLast: true, session: "ses_1" })).toEqual([
      "--server",
      url,
      "--session",
      "ses_1",
    ]);
  });
});

describe("forgetHostKey", () => {
  it("drops only that workspace's line", async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { forgetHostKey } = await import("../src/terminal.js");
    const file = join(mkdtempSync(join(tmpdir(), "cfoc-kh-")), "known_hosts");
    writeFileSync(file, "cf-opencode-app ssh-ed25519 AAAA1\ncf-opencode-app2 ssh-ed25519 AAAA2\n");
    expect(forgetHostKey("app", file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("cf-opencode-app2 ssh-ed25519 AAAA2\n");
    expect(forgetHostKey("app", file)).toBe(false);
    expect(forgetHostKey("app", join(file, "missing"))).toBe(false);
  });
});
