// The Worker checks every preview credential it can check without state before it calls a Durable Object, as
// gate.ts does for /oc. Before this, an anonymous request to /preview/<id>/… or /public/<id>/… created a Durable
// Object for any id it named, which the account paid for.
import { describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/api";
import { workspacePassword } from "../src/auth";
import type { Env } from "../src/env";
import {
  PREVIEW_COOKIE,
  previewKey,
  signCookie,
  signShareToken,
  signTicket,
  TICKET_PARAM,
  verifyShareToken,
} from "../src/preview-auth";

const CONTROL = "control-token-0123456789abcdef0123456789";
const ORIGIN = "https://cf-opencode.example.workers.dev";
const T0 = Date.now();
const basic = (pw: string) => `Basic ${btoa(`opencode:${pw}`)}`;

function envWithStub(control: string | null = CONTROL) {
  const stub = { fetch: vi.fn(async () => new Response("ok")) };
  const getByName = vi.fn(() => stub);
  const env = {
    CONTROL_TOKEN: control ?? undefined,
    CF_OPENCODE_CONFIG: "{}",
    WORKSPACE: { getByName },
  } as unknown as Env;
  return { env, getByName, stub };
}

async function key(): Promise<CryptoKey> {
  return (await previewKey(CONTROL)) as CryptoKey;
}

describe("preview gate in the Worker", () => {
  it("an anonymous or forged request touches no Durable Object", async () => {
    const { env, getByName } = envWithStub();
    const other = await workspacePassword(CONTROL, "other");
    const otherCookie = await signCookie(await key(), "other", 3000, T0);
    const otherTicket = (await signTicket(await key(), "demo", 5173, T0)).ticket;
    const otherShare = await signShareToken(await key(), "other");
    const cases: [string, RequestInit, number][] = [
      ["/preview/demo/3000/", {}, 401],
      ["/preview/demo/3000/", { headers: { authorization: basic(other) } }, 401],
      ["/preview/demo/3000/", { headers: { authorization: "Basic !!" } }, 401],
      ["/preview/demo/3000/", { headers: { cookie: `${PREVIEW_COOKIE}=1.${"A".repeat(43)}` } }, 401],
      ["/preview/demo/3000/", { headers: { cookie: `${PREVIEW_COOKIE}=${otherCookie}` } }, 401],
      [`/preview/demo/3000/?${TICKET_PARAM}=${otherTicket}`, {}, 401],
      [`/preview/demo/3000/?${TICKET_PARAM}=junk`, {}, 401],
      ["/preview/demo/link", { method: "POST", body: '{"port":3000}' }, 401],
      ["/preview/demo/link", { method: "POST", headers: { authorization: basic(other) }, body: "{}" }, 401],
      ["/preview/demo/link", {}, 405],
      [`/public/demo/${"x".repeat(43)}/`, {}, 404],
      [`/public/demo/${"x".repeat(54)}/`, {}, 404],
      [`/public/demo/${otherShare}/`, {}, 404],
      [`/public/anything-${Math.random().toString(36).slice(2)}/${"y".repeat(54)}/`, {}, 404],
    ];
    for (const [path, init, status] of cases) {
      const res = await handleApi(new Request(`${ORIGIN}${path}`, init), env);
      expect(res.status, path).toBe(status);
    }
    expect(getByName).not.toHaveBeenCalled();
  });

  it("no control token: previews are off, and no Durable Object is touched", async () => {
    const { env, getByName } = envWithStub(null);
    const pw = await workspacePassword(CONTROL, "demo");
    for (const path of ["/preview/demo/3000/", `/public/demo/${"x".repeat(54)}/`]) {
      const res = await handleApi(
        new Request(`${ORIGIN}${path}`, { headers: { authorization: basic(pw) } }),
        env,
      );
      expect(res.status).toBe(503);
    }
    const link = await handleApi(
      new Request(`${ORIGIN}/preview/demo/link`, { method: "POST", headers: { authorization: basic(pw) } }),
      env,
    );
    expect(link.status).toBe(401);
    expect(getByName).not.toHaveBeenCalled();
  });

  it("the password, a cookie, a ticket or a signed share token reaches the Durable Object", async () => {
    const pw = await workspacePassword(CONTROL, "demo");
    const cookie = await signCookie(await key(), "demo", 3000, T0);
    const { ticket } = await signTicket(await key(), "demo", 3000, T0);
    const share = await signShareToken(await key(), "demo");
    const cases: [string, RequestInit][] = [
      ["/preview/demo/3000/", { headers: { authorization: basic(pw) } }],
      ["/preview/demo/3000/a.js", { headers: { cookie: `x=1; ${PREVIEW_COOKIE}=${cookie}` } }],
      [`/preview/demo/3000/?${TICKET_PARAM}=${ticket}`, {}],
      // No body: Node's Request needs a duplex option to forward one. The Durable Object reads it.
      ["/preview/demo/link", { method: "POST", headers: { authorization: basic(pw) } }],
      [`/public/demo/${share}/index.html`, {}],
    ];
    for (const [path, init] of cases) {
      const { env, getByName, stub } = envWithStub();
      const res = await handleApi(new Request(`${ORIGIN}${path}`, init), env);
      expect(res.status, path).toBe(200);
      expect(getByName).toHaveBeenCalledWith("ws:demo");
      expect(stub.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("a share token carries its own MAC: bound to the workspace and the control token", async () => {
    const k = await key();
    const t = await signShareToken(k, "demo");
    expect(t).toMatch(/^[A-Za-z0-9_-]{54}$/);
    expect(await signShareToken(k, "demo")).not.toBe(t);
    expect(await verifyShareToken(k, t, "demo")).toBe(true);
    expect(await verifyShareToken(k, t, "demo2")).toBe(false);
    const flipped = `${t.slice(0, 53)}${t.endsWith("A") ? "B" : "A"}`;
    expect(await verifyShareToken(k, flipped, "demo")).toBe(false);
    const other = (await previewKey("another-control-token-0123456789")) as CryptoKey;
    expect(await verifyShareToken(other, t, "demo")).toBe(false);
    expect(await verifyShareToken(k, "x".repeat(43), "demo")).toBe(false);
  });
});
