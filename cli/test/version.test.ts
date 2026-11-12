import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const pkg = (p: string) => (JSON.parse(read(p)) as { version: string }).version;
const constant = (p: string, name: string) => read(p).match(new RegExp(`${name} = "([^"]+)"`))?.[1];

describe("release version", () => {
  it("is the same in every package and in both version constants", () => {
    const version = pkg("cli/package.json");
    expect(pkg("plugin/package.json")).toBe(version);
    expect(pkg("worker/package.json")).toBe(version);
    expect(constant("cli/src/index.ts", "VERSION")).toBe(version);
    expect(constant("worker/src/api.ts", "API_VERSION")).toBe(version);
  });
});
