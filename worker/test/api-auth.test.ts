import { describe, expect, it } from "vitest";
import { handleApi, isProjectSnapshotId, WORKSPACE_ID_RE } from "../src/api.js";
import type { Env } from "../src/env.js";

const env = { CONTROL_TOKEN: "control-secret" } as Env;

describe("handleApi auth", () => {
  it("hides every control route when the bearer is wrong", async () => {
    const res = await handleApi(new Request("https://w/v1/health"), env);
    expect(res.status).toBe(401);
  });

  it("tells a visitor without the token nothing: one bare 401 for every path", async () => {
    const bodies = new Set<string>();
    for (const [path, auth] of [
      ["/", undefined],
      ["/v1/health", undefined],
      ["/v1/workspaces/app", "Bearer wrong"],
      ["/v1/nope", "Basic abc"],
      ["/favicon.ico", undefined],
    ] as const) {
      const res = await handleApi(
        new Request(`https://w${path}`, auth ? { headers: { authorization: auth } } : {}),
        env,
      );
      expect(res.status).toBe(401);
      bodies.add(await res.text());
    }
    expect([...bodies]).toEqual(['{"error":"Unauthorized"}']);
  });

  it("answers health with the right bearer", async () => {
    const res = await handleApi(
      new Request("https://w/v1/health", { headers: { authorization: "Bearer control-secret" } }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("cf-opencode");
  });

  it("does not require the control token for the OpenCode ingress", async () => {
    const res = await handleApi(new Request("https://w/oc/not a valid id"), env);
    expect(res.status).toBe(400);
  });

  it("asks for basic auth before proxying", async () => {
    const res = await handleApi(new Request("https://w/oc/my-workspace/global/health"), env);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("id rules", () => {
  it("accepts a normal workspace id and rejects path tricks", () => {
    expect(WORKSPACE_ID_RE.test("my-repo")).toBe(true);
    expect(WORKSPACE_ID_RE.test("../etc")).toBe(false);
    expect(WORKSPACE_ID_RE.test("")).toBe(false);
  });

  it("rejects a snapshot id with a slash or a control character", () => {
    expect(isProjectSnapshotId("snap-repo")).toBe(true);
    expect(isProjectSnapshotId("a/b")).toBe(false);
    expect(isProjectSnapshotId("a\nb")).toBe(false);
  });
});
