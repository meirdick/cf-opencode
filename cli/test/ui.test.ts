import { describe, expect, it } from "vitest";
import { fmtAge } from "../src/ui.js";

describe("fmtAge", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  const at = (seconds: number) => new Date(now + seconds * 1000).toISOString();

  it("reads a time within a few seconds as now, whichever clock is ahead", () => {
    expect(fmtAge(at(1), now)).toBe("now");
    expect(fmtAge(at(-3), now)).toBe("now");
  });

  it("gives past and future times", () => {
    expect(fmtAge(at(-10), now)).toBe("10s ago");
    expect(fmtAge(at(-600), now)).toBe("10m ago");
    expect(fmtAge(at(30 * 86_400), now)).toBe("in 30d");
    expect(fmtAge(undefined, now)).toBe("-");
  });
});
