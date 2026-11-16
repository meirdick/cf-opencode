import { describe, expect, it } from "vitest";
import { type CfApi, type Known, makeCfApi } from "../src/cloudflare-api.js";
import { type DomainProbe, domainCheck, hostnameError, probeDomain, zoneCandidates } from "../src/domain.js";

const known = <T>(value: T): Known<T> => ({ kind: "known", value });
const unknown = (reason: string) => ({ kind: "unknown" as const, reason });
const ZONE = { id: "z1", name: "example.com", status: "active", nameServers: ["ns1.example.net"] };

/** A fake API that answers GETs from a table keyed by path and query. */
function api(table: Record<string, unknown>): CfApi & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async get<T>(path: string, query: Record<string, string> = {}) {
      const key = `${path}?${new URLSearchParams(query)}`;
      seen.push(key);
      if (!(key in table)) return unknown(`no fake for ${key}`) as Known<T>;
      const v = table[key];
      return (v instanceof Error ? unknown(v.message) : known(v)) as Known<T>;
    },
  };
}

describe("--domain hostname", () => {
  it("takes a hostname and refuses a URL, a wildcard, an IP and workers.dev", () => {
    expect(hostnameError("code.example.com")).toBeUndefined();
    expect(hostnameError("example.com")).toBeUndefined();
    for (const bad of [
      "https://code.example.com",
      "*.example.com",
      "code",
      "1.2.3.4",
      "Code.Example.com",
      "a..b",
    ])
      expect(hostnameError(bad)?.message).toMatch(/^Failed: .* — fix: pass only the hostname/);
    expect(hostnameError("x.sub.workers.dev")?.message).toMatch(/workers\.dev hostname/);
  });

  it("looks for the zone from the longest name to the registrable one", () => {
    expect(zoneCandidates("a.b.example.com")).toEqual(["a.b.example.com", "b.example.com", "example.com"]);
    expect(zoneCandidates("example.com")).toEqual(["example.com"]);
  });
});

describe("domain check", () => {
  const base: DomainProbe = { zone: known(ZONE), owner: known(undefined), records: known([]) };

  it("passes a free hostname in an active zone of the account", () => {
    expect(domainCheck("code.example.com", "cf-opencode", base)).toEqual({
      errors: [],
      warnings: [],
      zone: "example.com",
    });
  });

  it("reports a hostname whose zone is not in the account, as one Failed line", () => {
    const r = domainCheck("code.example.com", "cf-opencode", { ...base, zone: known(undefined) });
    expect(r.errors.map((e) => e.message)).toEqual([
      "Failed: no zone for code.example.com in this Cloudflare account — fix: add the domain to this account, pass --account <id> of the account that has it, or pass another --domain",
    ]);
  });

  it("reports a zone that is not active yet", () => {
    const r = domainCheck("code.example.com", "cf-opencode", {
      ...base,
      zone: known({ ...ZONE, status: "pending" }),
    });
    expect(r.errors[0]?.message).toMatch(/example\.com is pending, not active — fix: finish its setup/);
  });

  it("refuses to take DNS records or another Worker's Custom Domain without --adopt", () => {
    const records = domainCheck("code.example.com", "cf-opencode", {
      ...base,
      records: known(["A", "AAAA"]),
    });
    expect(records.errors[0]?.message).toMatch(
      /has DNS records \(A, AAAA\), and the deploy replaces them.*--adopt/,
    );
    const other = domainCheck("code.example.com", "cf-opencode", { ...base, owner: known("blog") });
    expect(other.errors[0]?.message).toMatch(/Custom Domain of the Worker blog — fix: .*--adopt/);
    expect(
      domainCheck(
        "code.example.com",
        "cf-opencode",
        { ...base, owner: known("blog"), records: known(["A"]) },
        true,
      ).errors,
    ).toEqual([]);
  });

  it("passes the install's own Custom Domain on an upgrade, whatever its record", () => {
    const r = domainCheck("code.example.com", "cf-opencode", {
      ...base,
      owner: known("cf-opencode"),
      records: known(["AAAA"]),
    });
    expect(r.errors).toEqual([]);
  });

  it("warns, and does not fail, when it cannot read a fact", () => {
    const r = domainCheck("code.example.com", "cf-opencode", {
      zone: unknown("Cloudflare API answered 403"),
      owner: unknown("Cloudflare API answered 403"),
      records: unknown("no zone to read"),
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/^! could not check the zone of code\.example\.com/);
  });
});

describe("domain probe", () => {
  const zones = (name: string) => `/zones?name=${name}&account.id=acc1`;
  const domains = "/accounts/acc1/workers/domains?hostname=code.example.com";
  const records = "/zones/z1/dns_records?name=code.example.com";
  const zoneRow = { id: "z1", name: "example.com", status: "active", name_servers: ["ns1.example.net"] };

  it("finds the zone in this account, the owner and the records, with reads only", async () => {
    const a = api({
      [zones("code.example.com")]: [],
      [zones("example.com")]: [zoneRow],
      [domains]: [],
      [records]: [{ name: "code.example.com", type: "CNAME" }],
    });
    const p = await probeDomain("code.example.com", "acc1", a, async () => known(["A"]));
    expect(p).toEqual({ zone: known(ZONE), owner: known(undefined), records: known(["CNAME"]) });
  });

  it("asks the zone's nameservers when the login cannot read DNS records", async () => {
    const a = api({
      [zones("code.example.com")]: [],
      [zones("example.com")]: [zoneRow],
      [domains]: [],
      [records]: new Error("Cloudflare API answered 403"),
    });
    const asked: string[][] = [];
    const p = await probeDomain("code.example.com", "acc1", a, async (_h, ns) => {
      asked.push(ns);
      return known([]);
    });
    expect(asked).toEqual([["ns1.example.net"]]);
    expect(p.records).toEqual(known([]));
  });

  it("says the zone is missing when no candidate is in the account", async () => {
    const a = api({ [zones("code.example.com")]: [], [zones("example.com")]: [], [domains]: [] });
    const p = await probeDomain("code.example.com", "acc1", a);
    expect(p.zone).toEqual(known(undefined));
  });

  it("reads nothing without a token", async () => {
    const p = await probeDomain("code.example.com", "acc1", undefined);
    expect(p.zone.kind).toBe("unknown");
  });
});

describe("Cloudflare API client", () => {
  it("sends the token in a header only, and turns an error answer into a reason", async () => {
    const urls: string[] = [];
    let auth = "";
    const f = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return url.includes("bad")
        ? new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), {
            status: 403,
          })
        : new Response(JSON.stringify({ success: true, result: [1] }));
    }) as typeof fetch;
    const c = makeCfApi("tok-123", f);
    expect(await c.get("/zones", { name: "example.com" })).toEqual(known([1]));
    expect(urls[0]).toBe("https://api.cloudflare.com/client/v4/zones?name=example.com");
    expect(urls[0]).not.toContain("tok-123");
    expect(auth).toBe("Bearer tok-123");
    expect(await c.get("/bad")).toEqual(unknown("Cloudflare API answered 403: Authentication error"));
  });
});
