// Preview a dev server: the auth paths (no auth, wrong and expired cookies, a cookie for another workspace or port,
// wrong ports, one-time links), the paused page, header hygiene, public shares, and the Worker routes.
import { describe, expect, it } from "vitest";
import { handleApi } from "../src/api";
import type { Env } from "../src/env";
import { tokenSha } from "../src/orb/journal";
import {
  addShare,
  handlePreview,
  internalPreview,
  listShares,
  type PreviewDeps,
  type PreviewTarget,
  prefixLocation,
  removeShares,
  TARGET_HEADER,
} from "../src/orb/preview";
import {
  COOKIE_TTL_S,
  checkPort,
  cookieHeader,
  PREVIEW_COOKIE,
  previewKey,
  signCookie,
  signTicket,
  TICKET_PARAM,
  TICKET_TTL_S,
  verifyCookie,
  verifyShareToken,
  verifyTicket,
  withoutPreviewCookie,
} from "../src/preview-auth";
import { previewFallback } from "../src/preview-ingress";
import { MemoryKV } from "./fake-container";

const CONTROL = "control-token-0123456789abcdef0123456789";
const PASSWORD = "right-password-0123456789abcdef";
const T0 = Date.parse("2026-11-12T10:00:00Z");
const ORIGIN = "https://cf-opencode.example.workers.dev";

interface Harness {
  deps: PreviewDeps;
  kv: MemoryKV;
  forwarded: { port: number; req: Request }[];
  touched: number;
  clock: { now: number };
}

async function harness(
  o: { state?: string; running?: boolean; deleted?: boolean; listen?: boolean; key?: boolean } = {},
): Promise<Harness> {
  const kv = new MemoryKV();
  await kv.put("orb", {
    v: 1,
    workspaceId: "demo",
    orbId: "demo",
    state: o.state ?? "awake",
    imageKey: "orb",
    instance: "standard-1",
    passwordSha: await tokenSha(PASSWORD),
    updatedAt: new Date(T0).toISOString(),
    ...(o.deleted ? { deletedAt: new Date(T0).toISOString() } : {}),
  });
  const clock = { now: T0 };
  const h: Harness = {
    kv,
    forwarded: [],
    touched: 0,
    clock,
    deps: undefined as unknown as PreviewDeps,
  };
  h.deps = {
    workspaceId: "demo",
    kv,
    key: o.key === false ? undefined : await previewKey(CONTROL),
    serverPort: 4096,
    running: o.running ?? true,
    portFetch: async (port, req) => {
      if (o.listen === false) throw new Error("connection refused");
      h.forwarded.push({ port, req });
      const url = new URL(req.url);
      if (url.pathname === "/go") return new Response(null, { status: 302, headers: { location: "/login" } });
      if (url.pathname === "/sw.js")
        return new Response("self.onfetch = () => {}", {
          headers: {
            "content-type": "text/javascript",
            "service-worker-allowed": "/",
            "clear-site-data": '"cookies"',
          },
        });
      return new Response(`hello from ${port}${url.pathname}`, { headers: { "content-type": "text/plain" } });
    },
    touch: () => {
      h.touched++;
    },
    now: () => clock.now,
  };
  return h;
}

function previewReq(
  target: Partial<PreviewTarget>,
  init: { headers?: Record<string, string>; method?: string; body?: string } = {},
): Request {
  const t: PreviewTarget = {
    kind: "private",
    workspaceId: "demo",
    port: 3000,
    path: "/",
    search: "",
    origin: ORIGIN,
    ...target,
  };
  return new Request("https://workspace/preview", {
    method: init.method ?? "GET",
    headers: { [TARGET_HEADER]: JSON.stringify(t), ...(init.headers ?? {}) },
    ...(init.body ? { body: init.body } : {}),
  });
}

const basic = (pw: string) => `Basic ${btoa(`opencode:${pw}`)}`;

async function cookieFor(workspaceId: string, port: number, nowMs = T0): Promise<string> {
  const key = (await previewKey(CONTROL)) as CryptoKey;
  return `${PREVIEW_COOKIE}=${await signCookie(key, workspaceId, port, nowMs)}`;
}

describe("preview credentials", () => {
  it("a cookie verifies only for its workspace, its port, and before it expires", async () => {
    const key = (await previewKey(CONTROL)) as CryptoKey;
    const value = await signCookie(key, "demo", 3000, T0);
    expect(await verifyCookie(key, value, "demo", 3000, T0 + 1000)).toBe(true);
    expect(await verifyCookie(key, value, "other", 3000, T0)).toBe(false);
    expect(await verifyCookie(key, value, "demo", 3001, T0)).toBe(false);
    expect(await verifyCookie(key, value, "demo", 3000, T0 + COOKIE_TTL_S * 1000 + 1)).toBe(false);
    // A longer expiry with the old mac does not verify.
    const [exp, mac] = value.split(".");
    expect(await verifyCookie(key, `${Number(exp) + 3600}.${mac}`, "demo", 3000, T0)).toBe(false);
    // A cookie from another control token does not verify.
    const other = (await previewKey("another-control-token-0123456789")) as CryptoKey;
    expect(await verifyCookie(other, value, "demo", 3000, T0)).toBe(false);
    expect(await verifyCookie(key, "garbage", "demo", 3000, T0)).toBe(false);
  });

  it("a ticket verifies for its workspace and port for two minutes", async () => {
    const key = (await previewKey(CONTROL)) as CryptoKey;
    const { ticket } = await signTicket(key, "demo", 3000, T0);
    expect(await verifyTicket(key, ticket, "demo", 3000, T0)).toBeDefined();
    expect(await verifyTicket(key, ticket, "demo", 3001, T0)).toBeUndefined();
    expect(await verifyTicket(key, ticket, "other", 3000, T0)).toBeUndefined();
    expect(await verifyTicket(key, ticket, "demo", 3000, T0 + TICKET_TTL_S * 1000 + 1)).toBeUndefined();
  });

  it("no control token, no key: previews are off", async () => {
    expect(await previewKey(undefined)).toBeUndefined();
  });

  it("checkPort takes 1024-65535 and refuses OpenCode's port and 22", () => {
    expect(checkPort("3000", 4096)).toEqual({ port: 3000 });
    expect(checkPort(5173, 4096)).toEqual({ port: 5173 });
    for (const bad of ["80", "22", "1023", "65536", "4096", "3000x", "-1", "", "1e4", null, 3000.5])
      expect(checkPort(bad, 4096)).toHaveProperty("error");
  });

  it("the cookie is HttpOnly, Secure, SameSite=Lax and scoped to one workspace and port", () => {
    const h = cookieHeader("v", "demo", 3000);
    expect(h).toContain("Path=/preview/demo/3000/");
    expect(h).toContain("HttpOnly");
    expect(h).toContain("Secure");
    expect(h).toContain("SameSite=Lax");
  });

  it("the dev server never gets the preview cookie", () => {
    expect(withoutPreviewCookie(`a=1; ${PREVIEW_COOKIE}=x.y; b=2`)).toBe("a=1; b=2");
    expect(withoutPreviewCookie(`${PREVIEW_COOKIE}=x.y`)).toBeNull();
  });
});

describe("private preview", () => {
  it("no auth: 401, and nothing reaches the dev server", async () => {
    const h = await harness();
    const res = await handlePreview(h.deps, previewReq({}));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("cf-opencode preview demo 3000");
    expect(h.forwarded).toHaveLength(0);
    expect(h.touched).toBe(0);
  });

  it("a wrong, an expired, another workspace's or another port's cookie: 401", async () => {
    const h = await harness();
    const cookies = [
      `${PREVIEW_COOKIE}=123.${"A".repeat(43)}`,
      await cookieFor("demo", 3000, T0 - COOKIE_TTL_S * 1000 - 5000),
      await cookieFor("other", 3000),
      await cookieFor("demo", 5173),
    ];
    for (const cookie of cookies) {
      const res = await handlePreview(h.deps, previewReq({}, { headers: { cookie } }));
      expect(res.status).toBe(401);
    }
    expect(h.forwarded).toHaveLength(0);
  });

  it("a wrong password: 401", async () => {
    const h = await harness();
    const res = await handlePreview(
      h.deps,
      previewReq({}, { headers: { authorization: basic("wrong-password-0123456789") } }),
    );
    expect(res.status).toBe(401);
    expect(h.forwarded).toHaveLength(0);
  });

  it("a wrong port: 400 before any check", async () => {
    const h = await harness();
    for (const port of [4096, 22, 80, 70000]) {
      const res = await handlePreview(
        h.deps,
        previewReq({ port }, { headers: { authorization: basic(PASSWORD) } }),
      );
      expect(res.status).toBe(400);
    }
    expect(h.forwarded).toHaveLength(0);
  });

  it("a route for another workspace: 400", async () => {
    const h = await harness();
    const res = await handlePreview(
      h.deps,
      previewReq({ workspaceId: "other" }, { headers: { cookie: await cookieFor("other", 3000) } }),
    );
    expect(res.status).toBe(400);
  });

  it("the right password: proxied, signed in with a cookie, and the password never reaches the dev server", async () => {
    const h = await harness();
    const res = await handlePreview(
      h.deps,
      previewReq(
        { path: "/app/x.js", search: "?v=1" },
        { headers: { authorization: basic(PASSWORD), cookie: "theme=dark" } },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello from 3000/app/x.js");
    expect(res.headers.get("set-cookie")).toContain(`${PREVIEW_COOKIE}=`);
    const sent = h.forwarded[0]!.req;
    expect(sent.url).toBe("http://localhost:3000/app/x.js?v=1");
    expect(sent.headers.get("authorization")).toBeNull();
    expect(sent.headers.get(TARGET_HEADER)).toBeNull();
    expect(sent.headers.get("cookie")).toBe("theme=dark");
    expect(sent.headers.get("host")).toBe("localhost:3000");
    expect(sent.headers.get("x-forwarded-prefix")).toBe("/preview/demo/3000");
    expect(sent.headers.get("x-forwarded-host")).toBe(new URL(ORIGIN).host);
    expect(h.touched).toBe(1);
  });

  it("a valid cookie: proxied, the cookie stripped, and counted as use", async () => {
    const h = await harness();
    const cookie = `${await cookieFor("demo", 5173)}; ${await cookieFor("demo", 3000)}; a=1`;
    const res = await handlePreview(h.deps, previewReq({}, { headers: { cookie } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(h.forwarded[0]!.req.headers.get("cookie")).toBe("a=1");
    expect(h.touched).toBe(1);
  });

  it("a paused workspace: a clear page, no wake, no use", async () => {
    for (const o of [
      { state: "paused", running: false },
      { state: "warm", running: true },
    ]) {
      const h = await harness(o);
      const res = await handlePreview(
        h.deps,
        previewReq({}, { headers: { cookie: await cookieFor("demo", 3000) } }),
      );
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toContain("paused");
      expect(text).toContain("cf-opencode connect demo");
      expect(h.forwarded).toHaveLength(0);
      expect(h.touched).toBe(0);
    }
  });

  it("a deleted workspace: 410; no control token: 503", async () => {
    const del = await harness({ deleted: true });
    expect((await handlePreview(del.deps, previewReq({}))).status).toBe(410);
    const off = await harness({ key: false });
    expect(
      (await handlePreview(off.deps, previewReq({}, { headers: { authorization: basic(PASSWORD) } }))).status,
    ).toBe(503);
  });

  it("nothing listening: 502 that says to bind 0.0.0.0", async () => {
    const h = await harness({ listen: false });
    const res = await handlePreview(
      h.deps,
      previewReq({}, { headers: { cookie: await cookieFor("demo", 3000) } }),
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("0.0.0.0");
  });

  it("drops response headers that would act on the whole Worker origin", async () => {
    const h = await harness();
    const res = await handlePreview(
      h.deps,
      previewReq({ path: "/sw.js" }, { headers: { cookie: await cookieFor("demo", 3000) } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(res.headers.get("service-worker-allowed")).toBeNull();
    expect(res.headers.get("clear-site-data")).toBeNull();
    const k = await previewKey(CONTROL);
    const made = await addShare(h.kv, 3000, new Date(T0).toISOString(), 4096, k, "demo");
    if (!made.ok) throw new Error(made.error);
    const pub = await handlePreview(
      h.deps,
      previewReq({ kind: "public", port: undefined, token: made.share.token, path: "/sw.js" }),
    );
    expect(pub.headers.get("service-worker-allowed")).toBeNull();
  });

  it("a redirect from the dev server stays under the prefix", async () => {
    const h = await harness();
    const res = await handlePreview(
      h.deps,
      previewReq({ path: "/go" }, { headers: { cookie: await cookieFor("demo", 3000) } }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/preview/demo/3000/login");
    expect(prefixLocation("http://localhost:3000/a?b#c", 3000, "/p")).toBe("/p/a?b#c");
    expect(prefixLocation("https://example.com/x", 3000, "/p")).toBeNull();
    expect(prefixLocation("//evil.example/x", 3000, "/p")).toBeNull();
    expect(prefixLocation("http://localhost:9999/x", 3000, "/p")).toBeNull();
  });
});

describe("one-time sign-in link", () => {
  async function mint(h: Harness, password = PASSWORD, port: unknown = 3000): Promise<Response> {
    return handlePreview(
      h.deps,
      previewReq(
        { kind: "link", port: undefined },
        { method: "POST", headers: { authorization: basic(password) }, body: JSON.stringify({ port }) },
      ),
    );
  }

  it("minting needs the password and puts a ticket, not the password, in the link", async () => {
    const h = await harness();
    expect((await mint(h, "wrong-password-0123456789")).status).toBe(401);
    expect((await mint(h, PASSWORD, 4096)).status).toBe(400);
    const res = await mint(h);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; link: string; awake: boolean; listening: boolean };
    expect(body.url).toBe(`${ORIGIN}/preview/demo/3000/`);
    expect(body.link.startsWith(`${body.url}?${TICKET_PARAM}=`)).toBe(true);
    expect(body.link).not.toContain(PASSWORD);
    expect(body.awake).toBe(true);
    expect(body.listening).toBe(true);
  });

  it("a ticket signs in once: cookie, redirect to the same origin; a second use is refused", async () => {
    const h = await harness();
    const { link } = (await (await mint(h)).json()) as { link: string };
    const search = new URL(link).search;
    const first = await handlePreview(h.deps, previewReq({ search: `${search}&tab=2` }));
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/preview/demo/3000/?tab=2");
    expect(first.headers.get("set-cookie")).toContain("Path=/preview/demo/3000/");
    const again = await handlePreview(h.deps, previewReq({ search }));
    expect(again.status).toBe(401);
  });

  it("an expired ticket, or one for another port, is refused", async () => {
    const h = await harness();
    const { link } = (await (await mint(h)).json()) as { link: string };
    const search = new URL(link).search;
    expect((await handlePreview(h.deps, previewReq({ port: 5173, search }))).status).toBe(401);
    h.clock.now += TICKET_TTL_S * 1000 + 1000;
    expect((await handlePreview(h.deps, previewReq({ search }))).status).toBe(401);
  });
});

describe("public preview", () => {
  it("is off by default, works with the token once shared, and stops with --stop", async () => {
    const h = await harness();
    expect(await listShares(h.kv)).toEqual([]);
    const k = await previewKey(CONTROL);
    const made = await addShare(h.kv, 3000, new Date(T0).toISOString(), 4096, k, "demo");
    if (!made.ok) throw new Error(made.error);
    expect(made.share.token.length).toBeGreaterThanOrEqual(43);
    const again = await addShare(h.kv, 3000, new Date(T0).toISOString(), 4096, k, "demo");
    expect(again.ok && again.share.token).toBe(made.share.token);
    expect(await addShare(h.kv, 4096, "", 4096, k, "demo")).toMatchObject({ ok: false, status: 400 });
    expect(await addShare(h.kv, 5173, "", 4096, undefined, "demo")).toMatchObject({ ok: false, status: 503 });
    expect(await verifyShareToken(k as CryptoKey, made.share.token, "demo")).toBe(true);

    const ok = await handlePreview(
      h.deps,
      previewReq({ kind: "public", port: undefined, token: made.share.token }),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-robots-tag")).toContain("noindex");
    expect(h.forwarded[0]!.port).toBe(3000);

    const wrong = await handlePreview(
      h.deps,
      previewReq({ kind: "public", port: undefined, token: "x".repeat(43) }),
    );
    expect(wrong.status).toBe(404);

    expect(await removeShares(h.kv, 3000)).toEqual([3000]);
    const gone = await handlePreview(
      h.deps,
      previewReq({ kind: "public", port: undefined, token: made.share.token }),
    );
    expect(gone.status).toBe(404);
  });
});

describe("remote browser", () => {
  it("p<port>.preview.internal reaches the port when awake, and checks the port", async () => {
    const h = await harness();
    const res = await internalPreview(h.deps, new Request("http://p3000.preview.internal/a?b=1"), 3000);
    expect(await res.text()).toBe("hello from 3000/a");
    expect(h.forwarded[0]!.req.headers.get("x-forwarded-prefix")).toBeNull();
    expect((await internalPreview(h.deps, new Request("http://p4096.preview.internal/"), 4096)).status).toBe(
      400,
    );
    const paused = await harness({ state: "paused", running: false });
    expect(
      (await internalPreview(paused.deps, new Request("http://p3000.preview.internal/"), 3000)).status,
    ).toBe(503);
  });
});

describe("Worker routes", () => {
  function env() {
    const seen: Request[] = [];
    const calls: string[] = [];
    const stub = {
      fetch: async (r: Request) => {
        seen.push(r);
        return new Response("ok");
      },
      previewShares: async () => [{ port: 3000, token: "t".repeat(43), createdAt: "x" }],
      sharePreview: async (port: number) => {
        calls.push(`share ${port}`);
        return { ok: true, share: { port, token: "t".repeat(43), createdAt: "x" } };
      },
      unsharePreview: async (port?: number) => {
        calls.push(`unshare ${port}`);
        return port ? [port] : [];
      },
    };
    const e = {
      CONTROL_TOKEN: CONTROL,
      CF_OPENCODE_CONFIG: "{}",
      WORKSPACE: { getByName: () => stub },
    } as unknown as Env;
    return { e, seen, calls };
  }

  it("routes a preview to the workspace's Durable Object and overwrites a forged routing header", async () => {
    const { e, seen } = env();
    const forged = JSON.stringify({
      kind: "public",
      workspaceId: "demo",
      token: "x",
      path: "/",
      search: "",
      origin: "",
    });
    await handleApi(
      new Request(`${ORIGIN}/preview/demo/3000/src/main.ts?x=1`, {
        headers: { [TARGET_HEADER]: forged, cookie: await cookieFor("demo", 3000, Date.now()) },
      }),
      e,
    );
    const t = JSON.parse(seen[0]!.headers.get(TARGET_HEADER)!) as PreviewTarget;
    expect(t).toEqual({
      kind: "private",
      workspaceId: "demo",
      port: 3000,
      path: "/src/main.ts",
      search: "?x=1",
      origin: ORIGIN,
    });
  });

  it("refuses a bad port or id before the Durable Object, and adds the slash", async () => {
    const { e, seen } = env();
    expect((await handleApi(new Request(`${ORIGIN}/preview/demo/80/`), e)).status).toBe(400);
    expect((await handleApi(new Request(`${ORIGIN}/preview/..%2F/3000/`), e)).status).toBe(400);
    const slash = await handleApi(new Request(`${ORIGIN}/preview/demo/3000?a=1`), e);
    expect(slash.status).toBe(308);
    expect(slash.headers.get("location")).toBe("/preview/demo/3000/?a=1");
    expect(seen).toHaveLength(0);
  });

  it("sends an absolute path from a preview page back under its prefix, for this origin only", async () => {
    const same = previewFallback(
      new Request(`${ORIGIN}/assets/app.js?v=2`, { headers: { referer: `${ORIGIN}/preview/demo/3000/` } }),
    );
    expect(same?.status).toBe(307);
    expect(same?.headers.get("location")).toBe("/preview/demo/3000/assets/app.js?v=2");
    const cross = previewFallback(
      new Request(`${ORIGIN}/assets/app.js`, {
        headers: { referer: "https://evil.example/preview/demo/3000/" },
      }),
    );
    expect(cross).toBeNull();
    expect(previewFallback(new Request(`${ORIGIN}/assets/app.js`))).toBeNull();
    // Without a preview referer, an unknown path still needs the bearer token.
    const { e } = env();
    expect((await handleApi(new Request(`${ORIGIN}/assets/app.js`), e)).status).toBe(401);
  });

  it("public shares change only with the bearer token", async () => {
    const { e, calls } = env();
    const noBearer = await handleApi(
      new Request(`${ORIGIN}/v1/workspaces/demo/previews`, { method: "POST", body: '{"port":3000}' }),
      e,
    );
    expect(noBearer.status).toBe(401);
    expect(calls).toEqual([]);
    const auth = { authorization: `Bearer ${CONTROL}` };
    const made = await handleApi(
      new Request(`${ORIGIN}/v1/workspaces/demo/previews`, {
        method: "POST",
        headers: auth,
        body: '{"port":3000}',
      }),
      e,
    );
    expect(made.status).toBe(200);
    expect(((await made.json()) as { url: string }).url).toBe(`${ORIGIN}/public/demo/${"t".repeat(43)}/`);
    const bad = await handleApi(
      new Request(`${ORIGIN}/v1/workspaces/demo/previews`, {
        method: "POST",
        headers: auth,
        body: '{"port":22}',
      }),
      e,
    );
    expect(bad.status).toBe(400);
    await handleApi(
      new Request(`${ORIGIN}/v1/workspaces/demo/previews?port=3000`, { method: "DELETE", headers: auth }),
      e,
    );
    expect(calls).toEqual(["share 3000", "unshare 3000"]);
  });
});
