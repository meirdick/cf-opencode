// The Worker refuses a request with no password or a wrong one before it touches any Durable Object.
// Before this, every anonymous request to /oc/<id> (and /browse, /shell, /ssh) created a Durable Object
// for any id it named, which the account paid for.
import { describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/api.js";
import { workspacePassword } from "../src/auth.js";
import type { Env } from "../src/env.js";
import { isWorkspacePassword, unauthorized } from "../src/gate.js";

const TOKEN = "control-secret";
const basic = (pw: string) => `Basic ${btoa(`opencode:${pw}`)}`;

function envWithStub() {
  const stub = {
    proxy: vi.fn(async () => new Response("proxied")),
    browse: vi.fn(async () => ({ ok: true, session: { sessionId: "s-1" } })),
    authorize: vi.fn(async () => false),
    fetch: vi.fn(async () => new Response("terminal")),
    submitOp: vi.fn(async () => ({ opId: "demo:1", attached: false })),
  };
  const getByName = vi.fn(() => stub);
  const env = { CONTROL_TOKEN: TOKEN, WORKSPACE: { getByName } } as unknown as Env;
  return { env, getByName, stub };
}

const ROUTES: [string, RequestInit][] = [
  ["/oc/demo/api/info", {}],
  ["/browse/demo", { method: "POST", body: "{}" }],
  ["/browse/demo/session-1", { headers: { upgrade: "websocket" } }],
  ["/shell/demo", { headers: { upgrade: "websocket" } }],
  ["/ssh/demo", { headers: { upgrade: "websocket" } }],
];

function req(path: string, init: RequestInit, authorization?: string): Request {
  const headers = new Headers(init.headers);
  if (authorization) headers.set("authorization", authorization);
  return new Request(`https://w.example${path}`, { ...init, headers });
}

describe("workspace gate", () => {
  it("no password and a wrong password get the same 401, and no Durable Object is touched", async () => {
    const { env, getByName } = envWithStub();
    const want = await unauthorized().text();
    for (const [path, init] of ROUTES) {
      for (const auth of [undefined, basic("wrong-password-0123456789abcdef"), "Bearer x", "Basic !!"]) {
        const res = await handleApi(req(path, init, auth), env);
        expect(res.status, `${path} ${auth}`).toBe(401);
        expect(await res.text()).toBe(want);
        expect(res.headers.get("www-authenticate")).toBe('Basic realm="cf-opencode"');
      }
    }
    expect(getByName).not.toHaveBeenCalled();
  });

  it("another workspace's password is a wrong password", async () => {
    const { env, getByName } = envWithStub();
    const other = await workspacePassword(TOKEN, "other");
    for (const [path, init] of ROUTES) {
      expect((await handleApi(req(path, init, basic(other)), env)).status).toBe(401);
    }
    expect(getByName).not.toHaveBeenCalled();
  });

  it("refuses everything when the Worker has no control token", async () => {
    const { env, getByName } = envWithStub();
    (env as { CONTROL_TOKEN?: string }).CONTROL_TOKEN = undefined;
    const pw = await workspacePassword(TOKEN, "demo");
    for (const [path, init] of ROUTES) {
      expect((await handleApi(req(path, init, basic(pw)), env)).status).toBe(401);
    }
    expect(getByName).not.toHaveBeenCalled();
  });

  it("the derived password reaches the Durable Object, which still checks it and wakes", async () => {
    const { env, getByName, stub } = envWithStub();
    const pw = await workspacePassword(TOKEN, "demo");
    const oc = await handleApi(req("/oc/demo/api/info", {}, basic(pw)), env);
    expect(await oc.text()).toBe("proxied");
    expect(getByName).toHaveBeenCalledWith("ws:demo");
    const forwarded = (stub.proxy.mock.calls[0] as unknown as [Request])[0];
    expect(forwarded.headers.get("x-cf-opencode-password")).toBe(pw);

    const term = await handleApi(req("/shell/demo", { headers: { upgrade: "websocket" } }, basic(pw)), env);
    expect(await term.text()).toBe("terminal");
    await handleApi(req("/browse/demo", { method: "POST", body: "{}" }, basic(pw)), env);
    expect(stub.browse).toHaveBeenCalledWith(pw, undefined);
  });

  it("isWorkspacePassword needs the token, the id and the password", async () => {
    const pw = await workspacePassword(TOKEN, "demo");
    expect(await isWorkspacePassword(TOKEN, "demo", pw)).toBe(true);
    expect(await isWorkspacePassword(TOKEN, "demo2", pw)).toBe(false);
    expect(await isWorkspacePassword(undefined, "demo", pw)).toBe(false);
    expect(await isWorkspacePassword(TOKEN, "demo", undefined)).toBe(false);
  });
});

describe("control API spawn password", () => {
  const spawn = (password: string) =>
    new Request("https://w.example/v1/workspaces/demo/ops", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "spawn", password }),
    });

  it("refuses a password the Worker would not accept on the workspace routes", async () => {
    const { env, stub } = envWithStub();
    const res = await handleApi(spawn("random-password-0123456789abcdef"), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/derived/);
    expect(stub.submitOp).not.toHaveBeenCalled();
  });

  it("accepts the derived password", async () => {
    const { env, stub } = envWithStub();
    const res = await handleApi(spawn(await workspacePassword(TOKEN, "demo")), env);
    expect(res.status).toBe(202);
    expect(stub.submitOp).toHaveBeenCalledTimes(1);
  });
});
