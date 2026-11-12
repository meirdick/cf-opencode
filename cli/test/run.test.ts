import { describe, expect, it } from "vitest";
import { classifyDeployFailure, runProcess, TIMEOUT_CODE, TIMEOUT_MARK } from "../src/wrangler.js";

describe("runProcess timeout", () => {
  it.skipIf(process.platform === "win32")(
    "returns when a grandchild still holds the output pipe, and stops that grandchild",
    async () => {
      // Like wrangler and docker push: the child starts a long process that inherits stdout, then waits on it.
      const started = Date.now();
      const r = await runProcess("sh", ["-c", "sleep 300 & echo $!; wait"], { timeoutMs: 300 });
      expect(r.code).toBe(TIMEOUT_CODE);
      expect(r.stderr).toContain(TIMEOUT_MARK);
      expect(Date.now() - started).toBeLessThan(15_000);
      const grandchild = Number(r.stdout.trim());
      expect(grandchild).toBeGreaterThan(0);
      await new Promise((ok) => setTimeout(ok, 200));
      expect(() => process.kill(grandchild, 0)).toThrow();
    },
  );

  it("a timed out deploy is not retried", () => {
    expect(
      classifyDeployFailure(
        `The push refers to repository [registry.cloudflare.com/a/b]\n${TIMEOUT_MARK} 3600s`,
      ),
    ).toBe("timeout");
  });
});
