import { describe, expect, it } from "vitest";
import type { OpRequest } from "../src/core/types";
import {
  appendProgress,
  finishOp,
  getOp,
  hashInputs,
  markRunning,
  openOp,
  PROGRESS_CAPPED,
  pruneOps,
  recoverInflight,
  redactLine,
  redactWith,
} from "../src/orb/journal";
import { MemoryKV } from "./fake-container";

const T = "2026-10-30T20:00:00.000Z";
const spawn: OpRequest = { op: "spawn", token: "eyJhbGciOi.test.sig", image: "img", snapshotId: "snap-1" };

describe("op journal", () => {
  it("identical in-flight inputs share one opId", async () => {
    const kv = new MemoryKV();
    const a = await openOp(kv, "orb1", spawn, T);
    const b = await openOp(kv, "orb1", { ...spawn }, T);
    expect(a.attached).toBe(false);
    expect(b.attached).toBe(true);
    expect(b.record.opId).toBe(a.record.opId);
    expect(a.record.opId).toMatch(/^orb1:[0-9a-f-]{36}$/);
    expect(await kv.get("ops:inflight")).toEqual([a.record.opId]);
  });

  it("different inputs get a different op", async () => {
    const kv = new MemoryKV();
    const a = await openOp(kv, "orb1", spawn, T);
    const b = await openOp(kv, "orb1", { ...spawn, token: "other" }, T);
    const c = await openOp(kv, "orb1", { op: "pause" }, T);
    expect(new Set([a.record.opId, b.record.opId, c.record.opId]).size).toBe(3);
  });

  it("a finished op is not attached to; the next identical job is new", async () => {
    const kv = new MemoryKV();
    const a = await openOp(kv, "orb1", spawn, T);
    await finishOp(kv, a.record.opId, "succeeded", { result: { source: "image" } });
    const b = await openOp(kv, "orb1", spawn, T);
    expect(b.attached).toBe(false);
    expect((await getOp(kv, a.record.opId))?.phase).toBe("succeeded");
    expect(await kv.get("ops:inflight")).toEqual([b.record.opId]);
  });

  it("journal survives a simulated restart; running ops are failed with the retry text", async () => {
    const kv = new MemoryKV();
    const a = await openOp(kv, "orb1", spawn, T);
    await markRunning(kv, a.record.opId);
    const p = await openOp(kv, "orb1", { op: "pause" }, T); // queued behind it
    // restart: in-memory state gone, storage kept
    const after = new MemoryKV();
    after.map = kv.map;
    const failed = await recoverInflight(after, "2026-10-30T20:01:00.000Z");
    expect(failed.map((o) => o.opId).sort()).toEqual([a.record.opId, p.record.opId].sort());
    const got = await getOp(after, a.record.opId);
    expect(got?.phase).toBe("failed");
    expect(got?.finishedAt).toBe("2026-10-30T20:01:00.000Z");
    expect(got?.error).toContain("control plane restarted during spawn; the connect will be retried");
    expect(got?.error).toMatch(/^Failed: .* — fix: /);
    expect(await after.get("ops:inflight")).toEqual([]);
    // a replay after restart starts fresh
    expect((await openOp(after, "orb1", spawn, T)).attached).toBe(false);
  });

  it("never stores the token", async () => {
    const kv = new MemoryKV();
    const a = await openOp(kv, "orb1", spawn, T);
    await appendProgress(kv, a.record.opId, `oops ${spawn.token}`);
    await finishOp(kv, a.record.opId, "failed", { error: "Failed: x sk-abcdefghijklmnop1234 — fix: y" });
    const all = JSON.stringify([...kv.map]);
    expect(all).not.toContain("eyJhbGciOi.test.sig");
    expect(all).not.toContain("sk-abcdefghijklmnop1234");
  });

  it("progress is capped at 200 lines, append-only, and redacted", async () => {
    const kv = new MemoryKV();
    const a = await openOp(kv, "orb1", { op: "pause" }, T);
    await appendProgress(kv, a.record.opId, "Authorization: Bearer abc.def");
    for (let i = 1; i < 230; i++) await appendProgress(kv, a.record.opId, `line ${i}`);
    const op = await getOp(kv, a.record.opId);
    expect(op?.progress).toHaveLength(200);
    expect(op?.progress[0]).toBe("Authorization: Bearer <redacted>");
    expect(op?.progress[198]).toBe("line 198");
    expect(op?.progress.at(-1)).toBe(PROGRESS_CAPPED);
  });

  it("hashInputs depends on op, snapshot, image and token", async () => {
    const h = await hashInputs(spawn);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashInputs({ ...spawn })).toBe(h);
    expect(await hashInputs({ ...spawn, token: "x" })).not.toBe(h);
    expect(await hashInputs({ ...spawn, snapshotId: undefined })).not.toBe(h);
    expect(await hashInputs({ ...spawn, ampUrl: "https://x" })).toBe(h); // AMP_URL is not an input of identity
  });

  // Regression: the API sends `password`, never `token`, so two connects with different passwords hashed the
  // same, and the second attached to the first's op and got its password: the second client was locked out.
  it("a spawn with another password or other inputs does not attach to the in-flight one", async () => {
    const base: OpRequest = { op: "spawn", password: "p".repeat(43), snapshotId: "snap-1", directory: "/a" };
    const h = await hashInputs(base);
    expect(await hashInputs({ ...base })).toBe(h);
    for (const change of [
      { password: "q".repeat(43) },
      { directory: "/b" },
      { repoUrl: "https://example.com/r.git" },
      { branch: "dev" },
      { gitName: "A" },
      { gitEmail: "a@example.com" },
      { workerUrl: "https://other.example" },
    ]) {
      expect(await hashInputs({ ...base, ...change })).not.toBe(h);
    }
    const kv = new MemoryKV();
    const a = await openOp(kv, "orb1", base, T);
    const b = await openOp(kv, "orb1", { ...base, password: "q".repeat(43) }, T);
    expect(b.attached).toBe(false);
    expect(b.record.opId).not.toBe(a.record.opId);
  });

  it("the stored hash does not contain the password", async () => {
    const kv = new MemoryKV();
    const pw = "secret-password-0123456789abcdef";
    await openOp(kv, "orb1", { op: "spawn", password: pw }, T);
    expect(JSON.stringify([...kv.map.values()])).not.toContain(pw);
  });

  it("pruneOps drops old finished ops, keeps in-flight ones", async () => {
    const kv = new MemoryKV();
    const a = await openOp(kv, "orb1", { op: "pause" }, T);
    await finishOp(kv, a.record.opId, "succeeded", { finishedAt: T });
    const b = await openOp(kv, "orb1", { op: "delete" }, T);
    expect(await pruneOps(kv, "2026-10-31T00:00:00.000Z")).toBe(1);
    expect(await getOp(kv, a.record.opId)).toBeUndefined();
    expect(await getOp(kv, b.record.opId)).toBeDefined();
  });
});

describe("redactLine", () => {
  it.each([
    ["Authorization: Bearer s3cr3t.v", "Authorization: Bearer <redacted>"],
    ["jwt eyJhbGciOi.test.sig end", "jwt <redacted-jwt> end"],
    ["orb_id is fine", "orb_id is fine"],
  ])("%s", (input, out) => {
    expect(redactLine(input)).toBe(out);
  });

  it("redactWith removes the exact token first", () => {
    expect(redactWith("plain-token-value", "x plain-token-value y")).toBe("x <redacted> y");
  });
});
