import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { derivePassword as cliPassword } from "../../cli/src/config.js";
import { workspacePassword as workerPassword } from "../../worker/src/auth.js";
import { createWorkspace, workspacePassword } from "../src/client.js";

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as typeof fetch;
}

describe("createWorkspace", () => {
  it("spawns, waits, and returns an attach URL with no secret in it", async () => {
    const seen: string[] = [];
    const fetch = fakeFetch((url, init) => {
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/ops")) return new Response(JSON.stringify({ opId: "ws:abc" }), { status: 202 });
      return new Response(JSON.stringify({ phase: "succeeded" }), { status: 200 });
    });
    const target = await createWorkspace(
      { url: "https://worker.example", token: "tok", fetch },
      { id: "repo", password: "p".repeat(32), repoUrl: "https://example.com/repo.git" },
    );
    expect(target.url).toBe("https://worker.example/oc/repo");
    expect(target.url).not.toContain("p".repeat(32));
    expect(seen[0]).toBe("POST https://worker.example/v1/workspaces/repo/ops");
  });

  it("surfaces a failed spawn instead of returning a URL", async () => {
    const fetch = fakeFetch((url) => {
      if (url.endsWith("/ops")) return new Response(JSON.stringify({ opId: "ws:abc" }), { status: 202 });
      return new Response(JSON.stringify({ phase: "failed", error: "Failed: boom — fix: retry" }), {
        status: 200,
      });
    });
    await expect(
      createWorkspace(
        { url: "https://worker.example", token: "tok", fetch },
        { id: "repo", password: "p".repeat(32) },
      ),
    ).rejects.toThrow(/boom/);
  });
});

describe("workspacePassword", () => {
  it("is the CLI's and the Worker's derivation, written mode 600, and replaces an older random password", async () => {
    const home = mkdtempSync(join(tmpdir(), "cfoc-plugin-"));
    const file = join(home, ".cf-opencode", "workspaces", "repo.password");
    mkdirSync(join(home, ".cf-opencode", "workspaces"), { recursive: true });
    writeFileSync(file, "old-random-password");
    const p = workspacePassword("repo", "control-token", home);
    expect(p).toBe(await workerPassword("control-token", "repo"));
    expect(p).toBe(cliPassword("control-token", "repo"));
    expect(readFileSync(file, "utf8")).toBe(p);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(workspacePassword("other", "control-token", home)).not.toBe(p);
    expect(workspacePassword("repo", "another-token", home)).not.toBe(p);
  });
});
