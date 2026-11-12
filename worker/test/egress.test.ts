import { describe, expect, it } from "vitest";
import { activeRoutes, PLACEHOLDER, PROVIDER_ROUTES, providerEnv, rewriteEgress } from "../src/orb/egress";

const env = { ANTHROPIC_API_KEY: "sk-ant-real", OPENAI_API_KEY: "sk-oai-real" };

function sent(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("rewriteEgress", () => {
  it("replaces the placeholder and drops the host header", () => {
    const out = rewriteEgress(
      sent("https://api.anthropic.com/v1/messages", { "x-api-key": PLACEHOLDER, host: "api.anthropic.com" }),
      PROVIDER_ROUTES,
      env,
    );
    expect(out).toBeInstanceOf(Request);
    const req = out as Request;
    expect(req.headers.get("x-api-key")).toBe("sk-ant-real");
    expect(req.headers.get("host")).toBeNull();
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("sends a bearer token for openai and ignores a value the container supplied", () => {
    const out = rewriteEgress(
      sent("https://api.openai.com/v1/chat/completions", { authorization: "Bearer container-smuggled" }),
      PROVIDER_ROUTES,
      env,
    ) as Request;
    expect(out.headers.get("authorization")).toBe("Bearer sk-oai-real");
  });

  it("refuses a host with no route", () => {
    const out = rewriteEgress(sent("https://evil.example/steal"), PROVIDER_ROUTES, env);
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(403);
  });

  it("refuses a route whose secret is unset instead of forwarding the placeholder", () => {
    const out = rewriteEgress(sent("https://api.anthropic.com/v1/messages"), PROVIDER_ROUTES, {});
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(403);
  });

  it("never puts the real key in the container env", () => {
    const got = providerEnv(env);
    expect(got.ANTHROPIC_API_KEY).toBe(PLACEHOLDER);
    expect(got.OPENAI_API_KEY).toBe(`Bearer ${PLACEHOLDER}`);
    expect(JSON.stringify(got)).not.toContain("sk-ant-real");
    expect(JSON.stringify(got)).not.toContain("sk-oai-real");
  });

  it("omits a provider the install has no key for", () => {
    expect(providerEnv({ ANTHROPIC_API_KEY: "sk" })).toEqual({ ANTHROPIC_API_KEY: PLACEHOLDER });
    expect(activeRoutes({ ANTHROPIC_API_KEY: "sk" }).map((r) => r.host)).toEqual(["api.anthropic.com"]);
    expect(activeRoutes({})).toEqual([]);
  });

  it("adds the GitHub token as git's basic auth on github.com and a bearer on api.github.com", () => {
    const gh = { GITHUB_TOKEN: "ghp_real" };
    const git = rewriteEgress(
      sent("https://github.com/acme/private.git/info/refs?service=git-upload-pack", {
        authorization: "Basic c211Z2dsZWQ=",
      }),
      PROVIDER_ROUTES,
      gh,
    ) as Request;
    expect(git.headers.get("authorization")).toBe(`Basic ${btoa("x-access-token:ghp_real")}`);
    const api = rewriteEgress(
      sent("https://api.github.com/user", { authorization: `token ${PLACEHOLDER}` }),
      PROVIDER_ROUTES,
      gh,
    ) as Request;
    expect(api.headers.get("authorization")).toBe("Bearer ghp_real");
    expect(providerEnv(gh)).toEqual({ GH_TOKEN: PLACEHOLDER });
    expect(activeRoutes(gh).map((r) => r.host)).toEqual(["github.com", "api.github.com"]);
  });
});
