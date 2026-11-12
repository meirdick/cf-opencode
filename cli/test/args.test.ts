import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("reads long flags, shorts, and positionals", () => {
    const spec = { dir: { type: "string" as const }, help: { type: "boolean" as const, short: "h" } };
    const args = parseArgs(["connect", "--dir", "/tmp/x", "-h", "workspace"], spec);
    expect(args.positionals).toEqual(["connect", "workspace"]);
    expect(args.flags.dir).toBe("/tmp/x");
    expect(args.flags.help).toBe(true);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--nope"], {})).toThrow(/unknown flag/);
  });
});

describe("ControlClient errors", () => {
  it("keeps a Worker error line whole, with one fix", async () => {
    const { ControlClient } = await import("../src/api.js");
    const line = "Failed: internal error: reset — fix: retry";
    const f = (async () => new Response(JSON.stringify({ error: line }), { status: 500 })) as typeof fetch;
    await expect(new ControlClient("https://w.example", "t", f).health()).rejects.toThrow(line);
    const e = await new ControlClient("https://w.example", "t", f).health().catch((x: Error) => x.message);
    expect(String(e).match(/— fix:/g)).toHaveLength(1);
  });
});
