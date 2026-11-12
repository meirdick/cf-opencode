// ssh runs ProxyCommand with the user's shell. Before, --url went into it inside double quotes, so a value
// such as `https://x" ; touch pwned ; "` ran a command on this machine on every `ssh cf-opencode-<id>`.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { proxyUrl, shellQuote, sshConfigBlock, sshOptions } from "../src/terminal.js";

const proxyOf = (opts: [string, string][]) => opts.find(([k]) => k === "ProxyCommand")?.[1] ?? "";

describe("proxyUrl", () => {
  it("keeps an https Worker origin, and http only for a local dev Worker", () => {
    expect(proxyUrl("https://cf-opencode.example.workers.dev")).toBe(
      "https://cf-opencode.example.workers.dev",
    );
    expect(proxyUrl("https://w.example/")).toBe("https://w.example");
    expect(proxyUrl("https://w.example:8443")).toBe("https://w.example:8443");
    expect(proxyUrl("http://localhost:8787")).toBe("http://localhost:8787");
  });

  it("refuses anything that could carry shell syntax or an ssh token", () => {
    for (const bad of [
      'https://x" ; touch pwned ; "',
      "https://w.example/$(touch pwned)",
      "https://w.example/`id`",
      "https://w.example/%h",
      "https://w.example/?a=1",
      "https://w.example/#x",
      "https://user:pw@w.example",
      "http://w.example",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(() => proxyUrl(bad), bad).toThrow(/Failed|URL/);
    }
  });
});

describe("sshOptions", () => {
  it("refuses a hostile --url and a hostile workspace id", () => {
    expect(() => sshOptions("demo", "/k", 'https://x" ; touch pwned ; "')).toThrow();
    expect(() => sshOptions("demo; touch pwned", "/k")).toThrow();
    expect(() => sshConfigBlock("demo\n  ProxyCommand evil", "/k")).toThrow();
  });

  it("quotes every part of the ProxyCommand and escapes ssh's % tokens", () => {
    const cmd = proxyOf(sshOptions("demo", "/k", "https://w.example"));
    expect(cmd).toMatch(/^'[^']+' '[^']+' ssh-proxy demo --url 'https:\/\/w\.example'$/);
    expect(cmd.replaceAll("%%", "")).not.toContain("%");
  });
});

describe.skipIf(process.platform === "win32")("shellQuote", () => {
  it("passes any string through sh as one word", () => {
    for (const s of ["plain", "it's", "a b", "$(touch pwned)", "`id`", "'", '"; rm -rf ~; "']) {
      const out = execFileSync("sh", ["-c", `printf %s ${shellQuote(s)}`], { encoding: "utf8" });
      expect(out).toBe(s);
    }
  });
});
