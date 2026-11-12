import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["worker/test/**/*.test.ts", "cli/test/**/*.test.ts", "plugin/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
