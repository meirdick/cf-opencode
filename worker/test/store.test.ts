import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CopyStub } from "../src/copy-api";
import { copyRoute } from "../src/copy-api";
import { parseConfig } from "../src/core/config";
import { FAILED_MARK } from "../src/core/tar-guard";
import {
  badKey,
  type StoreBucket,
  type StoreList,
  storeEgress,
  storeRoute,
  storeToWorkspace,
  workspaceToStore,
} from "../src/store";
import { linux, pair, stages } from "./local-workspace";

/** R2 as a Map. A put that fails mid-stream stores nothing, as R2 does. */
class MemoryStore implements StoreBucket {
  map = new Map<string, Uint8Array>();
  async put(key: string, body: ReadableStream<Uint8Array>, size: number) {
    const data = new Uint8Array(await new Response(body).arrayBuffer());
    if (data.byteLength !== size) throw new Error(`length ${data.byteLength} is not ${size}`);
    this.map.set(key, data);
  }
  async get(key: string) {
    const v = this.map.get(key);
    return v
      ? { body: new Response(v.slice()).body as ReadableStream<Uint8Array>, size: v.byteLength }
      : null;
  }
  async list(prefix?: string): Promise<StoreList> {
    return {
      objects: [...this.map]
        .filter(([k]) => !prefix || k.startsWith(prefix))
        .map(([key, v]) => ({ key, size: v.byteLength, uploaded: "2026-11-16T00:00:00.000Z" })),
    };
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

const text = (s: string) => new TextEncoder().encode(s);
const put = (path: string, body: string) =>
  new Request(`http://ai.cf-opencode.internal${path}`, {
    method: "PUT",
    body,
    headers: { "content-length": String(text(body).byteLength) },
  });

describe("store settings and names", () => {
  it("is off by default and takes only true or false", () => {
    expect(parseConfig("{}").store).toBe(false);
    expect(parseConfig('{"store":true}').store).toBe(true);
    expect(() => parseConfig('{"store":"yes"}')).toThrow(/store must be true or false/);
  });

  it.each(["a", "app/export.json.gz", "x_1-2.tar"])("takes the name %s", (k) =>
    expect(badKey(k)).toBeUndefined(),
  );
  it.each(["", "/abs", "a/../b", "a//b", "a/", "sp ace", "..", "a\nb"])("refuses the name %j", (k) =>
    expect(badKey(k)).toBeTruthy(),
  );
});

describe("store routes with the control token", () => {
  it("says the store is off when the binding is absent", async () => {
    const r = await storeRoute(new Request("https://w/v1/store"), undefined, undefined);
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toMatch(/set store to true/);
  });

  it("puts, lists, gets and removes a file", async () => {
    const s = new MemoryStore();
    const req = (method: string, key?: string, body?: string) =>
      new Request(`https://w/v1/store${key ? `/${key}` : ""}`, {
        method,
        ...(body !== undefined ? { body, headers: { "content-length": String(body.length) } } : {}),
      });
    const parts = (key?: string) => ["v1", "store", ...(key ? key.split("/") : [])];
    const route = (r: Request, key?: string) =>
      copyRoute(r, () => ({}) as CopyStub, parts(key), s) as Promise<Response>;
    expect((await route(req("PUT", "shared/x.txt", "hello"), "shared/x.txt")).status).toBe(200);
    const list = (await (await route(req("GET"))).json()) as StoreList;
    expect(list.objects.map((o) => o.key)).toEqual(["shared/x.txt"]);
    expect(await (await route(req("GET", "shared/x.txt"), "shared/x.txt")).text()).toBe("hello");
    await route(req("DELETE", "shared/x.txt"), "shared/x.txt");
    expect(s.map.size).toBe(0);
  });

  it("refuses an upload over 100 MB", async () => {
    const r = await storeRoute(
      new Request("https://w/v1/store/x", {
        method: "PUT",
        body: "x",
        headers: { "content-length": "100000001" },
      }),
      new MemoryStore(),
      "x",
    );
    expect(r.status).toBe(413);
  });
});

describe("cf-opencode-store in a workspace", () => {
  it("writes under its own workspace name and reads every name", async () => {
    const s = new MemoryStore();
    s.map.set("shared/in.csv", text("1,2"));
    const r = await storeEgress(put("/store/object/out.json", "{}"), s, "app");
    expect(await r.json()).toEqual({ ok: true, key: "app/out.json", size: 2 });
    // A name that looks like another workspace's still lands under its own.
    await storeEgress(put("/store/object/api/x", "y"), s, "app");
    expect([...s.map.keys()].sort()).toEqual(["app/api/x", "app/out.json", "shared/in.csv"]);
    const got = await storeEgress(
      new Request("http://ai.cf-opencode.internal/store/object/shared/in.csv"),
      s,
      "app",
    );
    expect(await got.text()).toBe("1,2");
    const list = await storeEgress(
      new Request("http://ai.cf-opencode.internal/store/list?prefix=app/"),
      s,
      "app",
    );
    expect(((await list.json()) as StoreList).objects).toHaveLength(2);
  });

  it("cannot remove a name of the user or of another workspace", async () => {
    const s = new MemoryStore();
    s.map.set("shared/in.csv", text("1"));
    s.map.set("api/x", text("1"));
    for (const k of ["shared/in.csv", "api/x"])
      await storeEgress(
        new Request(`http://ai.cf-opencode.internal/store/object/${k}`, { method: "DELETE" }),
        s,
        "app",
      );
    expect(s.map.size).toBe(2);
  });

  it("needs the workspace id and the binding", async () => {
    expect((await storeEgress(put("/store/object/x", "y"), new MemoryStore(), undefined)).status).toBe(403);
    const off = await storeEgress(put("/store/object/x", "y"), undefined, "app");
    expect(((await off.json()) as { error: string }).error).toMatch(/ask the user to set store to true/);
  });
});

describe.skipIf(!linux)("cp with the store", () => {
  it("copies a file from a workspace to the store and on to another workspace", async () => {
    const { a, b } = pair();
    const s = new MemoryStore();
    writeFileSync(a.file("project/export.json"), '{"rows":3}');
    const up = await workspaceToStore(s, a.stub, { workspace: "a", path: "export.json" }, "", () => {});
    expect(up).toMatchObject({ ok: true, result: { to: "store:export.json", bytes: 10 } });
    expect(new TextDecoder().decode(s.map.get("export.json"))).toBe('{"rows":3}');
    const down = await storeToWorkspace(
      s,
      b.stub,
      "export.json",
      { workspace: "b", path: "data/" },
      false,
      () => {},
    );
    expect(down).toMatchObject({ ok: true, result: { to: "b:/home/user/project/data/export.json" } });
    expect(readFileSync(b.file("project/data/export.json"), "utf8")).toBe('{"rows":3}');
    expect(stages(b)).toEqual([]);
  });

  it("copies an empty file and a file of whole blocks", async () => {
    const { a } = pair();
    const s = new MemoryStore();
    for (const [name, size] of [
      ["empty", 0],
      ["blocks", 1024],
    ] as const) {
      writeFileSync(a.file(`project/${name}`), "z".repeat(size));
      const r = await workspaceToStore(s, a.stub, { workspace: "a", path: name }, `t/${name}`, () => {});
      expect(r.ok).toBe(true);
      expect(s.map.get(`t/${name}`)?.byteLength).toBe(size);
    }
  });

  it("refuses a folder, and stores nothing when the source tar fails", async () => {
    const { a } = pair();
    const s = new MemoryStore();
    const dir = await workspaceToStore(s, a.stub, { workspace: "a", path: "" }, "x", () => {});
    expect(dir).toMatchObject({
      ok: false,
      error: expect.stringMatching(/is a folder; the store holds files/),
    });
    writeFileSync(a.file("project/f"), "data");
    const failing: CopyStub = {
      ...a.stub,
      copyOut: async (p) => {
        const out = await a.stub.copyOut(p);
        if (!out.ok) return out;
        const tail = new Response(`${FAILED_MARK} 2\n`).body as ReadableStream<Uint8Array>;
        const both = new Response(
          new ReadableStream({
            async start(c) {
              for (const r of [out.stream, tail])
                for await (const x of r as unknown as AsyncIterable<Uint8Array>) c.enqueue(x);
              c.close();
            },
          }),
        ).body as ReadableStream<Uint8Array>;
        return { ok: true, stream: both };
      },
    };
    const r = await workspaceToStore(s, failing, { workspace: "a", path: "f" }, "f", () => {});
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringMatching(/tar in the source workspace exited 2/),
    });
    expect(s.map.has("f")).toBe(false);
  });

  it("refuses a name that is not in the store", async () => {
    const { b } = pair();
    const r = await storeToWorkspace(
      new MemoryStore(),
      b.stub,
      "nope",
      { workspace: "b", path: "" },
      false,
      () => {},
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/store:nope does not exist/) });
  });
});
