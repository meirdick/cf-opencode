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
