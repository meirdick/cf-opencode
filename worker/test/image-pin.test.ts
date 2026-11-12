// The image build must not run a script it fetched, and must fail when the OpenCode asset changes.
// Before, it piped https://opencode.ai/v2/install to bash and checked only the version the binary printed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(join(__dirname, "..", "..", "image", "Dockerfile"), "utf8");
const code = dockerfile
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"))
  .join("\n");

describe("image/Dockerfile OpenCode pin", () => {
  it("pins the release asset by sha256 and checks it before extracting", () => {
    expect(code).toMatch(/^ARG OPENCODE_VERSION=\d+\.\d+\.\d+$/m);
    expect(code).toMatch(/^ARG OPENCODE_SHA256=[0-9a-f]{64}$/m);
    const run = code.slice(code.indexOf("opencode.tgz") - 200, code.indexOf("--version"));
    expect(run).toContain(
      `registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-${"$"}{OPENCODE_VERSION}.tgz`,
    );
    expect(run.indexOf("sha256sum -c")).toBeGreaterThan(-1);
    expect(run.indexOf("sha256sum -c")).toBeLessThan(run.indexOf("tar -xzf"));
  });

  it("pipes nothing it downloaded into a shell", () => {
    expect(code).not.toMatch(/\|\s*(ba)?sh\b/);
    expect(code).not.toContain("opencode.ai/v2/install");
  });
});
