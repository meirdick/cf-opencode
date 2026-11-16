import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cp, parseSide } from "../src/cp.js";
import { materialize } from "../src/init.js";
import { addStoreBinding, ensureStoreBucket, storeBucketName, storeBucketNote } from "../src/store.js";
import type { Wrangler } from "../src/wrangler.js";

const repo = join(import.meta.dirname, "..", "..");
const jsonc = readFileSync(join(repo, "worker", "wrangler.jsonc"), "utf8");
/** wrangler.jsonc as JSON: drop the // comments, which never hold "//" inside a string here. */
const parse = (s: string) => JSON.parse(s.replace(/^\s*\/\/.*$/gm, ""));

function wrangler(out: { code: number; stdout?: string; stderr?: string }) {
  const calls: string[][] = [];
  const w: Wrangler = {
    run: async (args) => {
      calls.push(args);
      return { code: out.code, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
    },
  };
  return { w, calls };
}

describe("store setup", () => {
  it("names the bucket after the Worker, as R2 allows", () => {
    expect(storeBucketName("cf-opencode")).toBe("cf-opencode-store");
    expect(storeBucketName("My_Worker")).toBe("my-worker-store");
    expect(storeBucketName("x".repeat(80)).length).toBeLessThanOrEqual(63);
  });

  it("adds the binding to wrangler.jsonc once, and the file still parses", () => {
    const out = addStoreBinding(jsonc, "cf-opencode-store");
    expect(parse(out).r2_buckets).toEqual([{ binding: "STORE", bucket_name: "cf-opencode-store" }]);
    expect(parse(out).containers).toEqual(parse(jsonc).containers);
    expect(addStoreBinding(out, "cf-opencode-store")).toBe(out);
  });

  it("writes the binding into the deploy copy only when store is true", async () => {
    for (const store of [true, false]) {
      const to = mkdtempSync(join(tmpdir(), "deploy-"));
      await materialize(repo, to, "my-ws", { store });
      const cfg = parse(readFileSync(join(to, "worker", "wrangler.jsonc"), "utf8"));
      expect(cfg.r2_buckets).toEqual(store ? [{ binding: "STORE", bucket_name: "my-ws-store" }] : undefined);
      expect(JSON.parse(cfg.vars.CF_OPENCODE_CONFIG).store).toBe(store);
    }
  });

  it("makes the bucket, keeps an existing one, and says how to fix R2 being off", async () => {
    const steps: string[] = [];
    const made = wrangler({ code: 0 });
    await ensureStoreBucket(made.w, "b-store", (l) => steps.push(l));
    expect(made.calls[0]).toEqual(["r2", "bucket", "create", "b-store"]);
    await ensureStoreBucket(
      wrangler({
        code: 1,
        stderr: "The bucket you tried to create already exists, and you own it. [code: 10004]",
      }).w,
      "b-store",
      (l) => steps.push(l),
    );
    expect(steps).toEqual(["✓ Store: made the R2 bucket b-store", "✓ Store: R2 bucket b-store"]);
    await expect(
      ensureStoreBucket(
        wrangler({ code: 1, stderr: "Please enable R2 through the Cloudflare Dashboard. [code: 10042]" }).w,
        "b",
        () => {},
      ),
    ).rejects.toThrow(/^Failed: R2 is not turned on .* — fix: turn on R2/);
  });

  it("tells uninstall that the bucket stays, only when it exists", async () => {
    expect(await storeBucketNote(wrangler({ code: 0 }).w, "cf-opencode")).toMatch(
      /^Kept: the store, R2 bucket cf-opencode-store, .* npx wrangler r2 bucket delete cf-opencode-store$/,
    );
    expect(await storeBucketNote(wrangler({ code: 1 }).w, "cf-opencode")).toBeUndefined();
  });
});

describe("cp with the store", () => {
  it("parses store sides", () => {
    expect(parseSide("store:a/b.gz")).toEqual({ kind: "store", key: "a/b.gz" });
    expect(parseSide("store:")).toEqual({ kind: "store", key: "" });
  });

  it("sends a workspace and store copy as one /v1/copy request", async () => {
    const bodies: unknown[] = [];
    const fetchFn = (async (_u: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(`${JSON.stringify({ ok: true, result: { from: "a:/x", to: "store:x" } })}\n`);
    }) as typeof fetch;
    const o = { url: "https://w", token: "t", force: false, err: () => {}, fetchFn };
    await cp(parseSide("a:x"), parseSide("store:"), o);
    await cp(parseSide("store:x"), parseSide("b:in/"), o);
    expect(bodies).toEqual([
      { from: { workspace: "a", path: "x" }, to: { store: "" }, force: false },
      { from: { store: "x" }, to: { workspace: "b", path: "in/" }, force: false },
    ]);
    await expect(cp(parseSide("store:x"), parseSide("store:y"), o)).rejects.toThrow(
      /both sides are the store/,
    );
  });

  it("uploads a local file and downloads it again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    writeFileSync(join(dir, "in.csv"), "1,2");
    const kept = new Map<string, Uint8Array>();
    const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
      const key = decodeURIComponent(new URL(String(u)).pathname.replace("/v1/store/", ""));
      if (init?.method === "PUT") {
        kept.set(key, init.body as Uint8Array);
        return Response.json({ ok: true, key, size: 3 });
      }
      const v = kept.get(key);
      return v ? new Response(v) : Response.json({ error: "Failed: no — fix: x" }, { status: 404 });
    }) as typeof fetch;
    const o = { url: "https://w", token: "t", force: false, err: () => {}, fetchFn };
    expect(await cp(parseSide(join(dir, "in.csv")), parseSide("store:shared/in.csv"), o)).toMatchObject({
      to: "store:shared/in.csv",
      bytes: 3,
    });
    const out = mkdtempSync(join(tmpdir(), "store-out-"));
    expect(await cp(parseSide("store:shared/in.csv"), parseSide(`${out}/`), o)).toMatchObject({
      to: join(out, "in.csv"),
    });
    expect(readFileSync(join(out, "in.csv"), "utf8")).toBe("1,2");
    await expect(cp(parseSide("store:shared/in.csv"), parseSide(out), o)).rejects.toThrow(
      /exists — fix: pass --force/,
    );
    await expect(cp(parseSide(dir), parseSide("store:"), o)).rejects.toThrow(/the store holds files/);
  });
});
