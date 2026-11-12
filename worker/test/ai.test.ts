import { describe, expect, it } from "vitest";
import { AI_BASE_URL, type AiRunner, handleAi, opencodeConfig } from "../src/orb/ai";

function runner(out: unknown = { choices: [] }) {
  const calls: { model: string; input: Record<string, unknown>; gateway: string }[] = [];
  const ai: AiRunner = {
    run: async (model, input, options) => {
      calls.push({ model, input, gateway: options.gateway.id });
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return { ai, calls };
}

const post = (path: string, body: unknown) =>
  new Request(`http://ai.cf-opencode.internal${path}`, { method: "POST", body: JSON.stringify(body) });

describe("handleAi", () => {
  it("runs the model through the install's gateway, without the model field in the input", async () => {
    const { ai, calls } = runner({ choices: [{ message: { content: "pong" } }] });
    const res = await handleAi(
      post("/v1/chat/completions", { model: "@cf/zai-org/glm-5.3", messages: [] }),
      ai,
      "gw1",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ choices: [{ message: { content: "pong" } }] });
    expect(calls).toEqual([{ model: "@cf/zai-org/glm-5.3", input: { messages: [] }, gateway: "gw1" }]);
  });

  it("renames max_tokens for third-party chat completions only (AI Gateway rejects it with 7003)", async () => {
    const { ai, calls } = runner();
    await handleAi(
      post("/v1/chat/completions", { model: "openai/gpt-5.4-mini", max_tokens: 50 }),
      ai,
      "default",
    );
    await handleAi(
      post("/v1/chat/completions", { model: "@cf/zai-org/glm-5.3", max_tokens: 50 }),
      ai,
      "default",
    );
    await handleAi(
      post("/v1/messages", { model: "anthropic/claude-haiku-4.5", max_tokens: 50 }),
      ai,
      "default",
    );
    expect(calls.map((c) => c.input)).toEqual([
      { max_completion_tokens: 50 },
      { max_tokens: 50 },
      { max_tokens: 50 },
    ]);
  });

  it("streams a ReadableStream back as server-sent events", async () => {
    const stream = new Response("data: {}\n\n").body as ReadableStream;
    const { ai } = runner(stream);
    const res = await handleAi(
      post("/v1/messages", { model: "anthropic/claude-haiku-4.5", stream: true }),
      ai,
      "default",
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe("data: {}\n\n");
  });

  it("refuses unknown paths, a missing model, and a missing binding, as JSON errors", async () => {
    const { ai, calls } = runner();
    expect((await handleAi(post("/v1/embeddings", { model: "x" }), ai, "default")).status).toBe(404);
    expect((await handleAi(post("/v1/chat/completions", {}), ai, "default")).status).toBe(400);
    const none = await handleAi(post("/v1/chat/completions", { model: "x" }), undefined, "default");
    expect(none.status).toBe(503);
    expect(((await none.json()) as { error: { message: string } }).error.message).toMatch(/AI binding/);
    expect(calls).toEqual([]);
  });

  it("reports a gateway input error as 400 with the model named", async () => {
    const { ai } = runner(new Error("7003: User Input Error"));
    const res = await handleAi(post("/v1/chat/completions", { model: "openai/gpt-5.4-mini" }), ai, "default");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "openai/gpt-5.4-mini",
    );
  });
});

describe("opencodeConfig", () => {
  it("points both Cloudflare providers at the intercepted host with a placeholder key", () => {
    const cfg = JSON.parse(opencodeConfig("cloudflare-workers-ai/@cf/zai-org/glm-5.3")) as {
      provider: Record<string, { options: { baseURL: string; apiKey: string } }>;
      model: string;
    };
    for (const p of ["cloudflare-workers-ai", "cloudflare-ai-gateway"]) {
      expect(cfg.provider[p]?.options).toEqual({ baseURL: AI_BASE_URL, apiKey: "cf-opencode-egress" });
    }
    expect(cfg.model).toBe("cloudflare-workers-ai/@cf/zai-org/glm-5.3");
    expect(JSON.parse(opencodeConfig(undefined))).not.toHaveProperty("model");
  });
});

describe("web search (POST /search)", () => {
  function searcher(
    answer: Response | Error = Response.json({ items: [{ title: "t", url: "https://e.example" }] }),
  ) {
    const calls: unknown[] = [];
    const ai: AiRunner = {
      run: async () => ({}),
      websearch: async (input) => {
        calls.push(input);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    return { ai, calls };
  }

  it("runs the query through the install's gateway and returns Cloudflare's JSON", async () => {
    const { ai, calls } = searcher();
    const res = await handleAi(post("/search", { query: " opencode on workers ", limit: 3 }), ai, "gw1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ title: "t", url: "https://e.example" }] });
    expect(calls).toEqual([{ gatewayId: "gw1", query: "opencode on workers", limit: 3 }]);
  });

  it("keeps the limit from 1 to 10, default 5, and passes a provider when named", async () => {
    const { ai, calls } = searcher();
    await handleAi(post("/search", { query: "a" }), ai, "default");
    await handleAi(post("/search", { query: "a", limit: 99, provider: "exa" }), ai, "default");
    await handleAi(post("/search", { query: "a", limit: 0 }), ai, "default");
    expect(calls).toEqual([
      { gatewayId: "default", query: "a", limit: 5 },
      { gatewayId: "default", query: "a", limit: 10, provider: "exa" },
      { gatewayId: "default", query: "a", limit: 1 },
    ]);
  });

  it("uses the install's provider unless the request names one", async () => {
    const { ai, calls } = searcher();
    await handleAi(post("/search", { query: "a" }), ai, "default", "exa");
    await handleAi(post("/search", { query: "a", provider: "linkup" }), ai, "default", "exa");
    expect(calls).toEqual([
      { gatewayId: "default", query: "a", limit: 5, provider: "exa" },
      { gatewayId: "default", query: "a", limit: 5, provider: "linkup" },
    ]);
  });

  it("refuses a missing or long query, and says what to do when search is not there or fails", async () => {
    const { ai } = searcher();
    expect((await handleAi(post("/search", {}), ai, "default")).status).toBe(400);
    expect((await handleAi(post("/search", { query: "x".repeat(1025) }), ai, "default")).status).toBe(400);
    expect(
      (await handleAi(post("/search", { query: "a", provider: "Bad Name" }), ai, "default")).status,
    ).toBe(400);

    const old = await handleAi(post("/search", { query: "a" }), { run: async () => ({}) }, "default");
    expect(old.status).toBe(501);
    expect(JSON.stringify(await old.json())).toContain("cf-opencode upgrade");

    const noCredit = searcher(new Response("no credits", { status: 402 }));
    expect((await handleAi(post("/search", { query: "a" }), noCredit.ai, "default")).status).toBe(402);
    const down = searcher(new Error("gateway timeout"));
    const res = await handleAi(post("/search", { query: "a" }), down.ai, "default");
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).toContain("gateway timeout");
  });
});
