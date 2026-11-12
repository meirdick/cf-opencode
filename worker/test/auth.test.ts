import { describe, expect, it } from "vitest";
import { basicPassword, mintPassword, passwordMatches, timingSafeEqualStr } from "../src/auth.js";
import { tokenSha } from "../src/orb/journal.js";

describe("basicPassword", () => {
  it("reads the password from a Basic header and ignores the username", () => {
    const header = `Basic ${btoa("opencode:s3cret-value")}`;
    expect(basicPassword(header)).toBe("s3cret-value");
  });

  it("returns undefined for a missing or malformed header", () => {
    expect(basicPassword(null)).toBeUndefined();
    expect(basicPassword("Bearer tok")).toBeUndefined();
    expect(basicPassword("Basic !!!")).toBeUndefined();
  });
});

describe("timingSafeEqualStr", () => {
  it("matches equal strings and rejects others", async () => {
    expect(await timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(await timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(await timingSafeEqualStr("abc", "abcd")).toBe(false);
  });
});

describe("mintPassword", () => {
  it("is url-safe and long enough to be a server password", () => {
    const p = mintPassword();
    expect(p.length).toBeGreaterThanOrEqual(32);
    expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("passwordMatches", () => {
  it("accepts only the password whose hash the spawn stored", async () => {
    const stored = await tokenSha("right-password-0123456789");
    expect(await passwordMatches(stored, "right-password-0123456789")).toBe(true);
    expect(await passwordMatches(stored, "wrong-password-0123456789")).toBe(false);
    expect(await passwordMatches(stored, "")).toBe(false);
    expect(await passwordMatches(stored, null)).toBe(false);
  });

  it("matches nothing when no password was ever stored", async () => {
    expect(await passwordMatches(undefined, "any-password-0123456789")).toBe(false);
  });
});
