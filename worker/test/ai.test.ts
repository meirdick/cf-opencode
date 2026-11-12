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

describe("read a page (POST /page)", () => {
  function pages(answer: () => Response | Promise<Response>) {
    const calls: { action: string; options: Record<string, unknown> }[] = [];
    const browser = {
      quickAction: async (action: string, options: Record<string, unknown>) => {
        calls.push({ action, options });
        return answer();
      },
    };
    return { browser, calls };
  }
  const page = (body: unknown, browser?: Parameters<typeof handleAi>[4]) =>
    handleAi(post("/page", body), undefined, "default", undefined, browser);

  it("returns the page as Markdown by default, without the JSON envelope, and needs no AI binding", async () => {
    const { browser, calls } = pages(() => Response.json({ success: true, result: "# Title\n\ntext" }));
    const res = await page({ url: "https://example.com/a" }, browser);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe("# Title\n\ntext");
    expect(calls[0]?.action).toBe("markdown");
    expect(calls[0]?.options.url).toBe("https://example.com/a");
  });

  it("maps each format to its Quick Action, and passes a file through as bytes", async () => {
    const links = pages(() =>
      Response.json({ success: true, result: ["https://a.example/", "https://b.example/"] }),
    );
    const res = await page({ url: "https://example.com", format: "links" }, links.browser);
    expect(await res.json()).toEqual(["https://a.example/", "https://b.example/"]);
    expect(links.calls[0]?.action).toBe("links");

    const html = pages(() => Response.json({ success: true, result: "<p>x</p>" }));
    await page({ url: "https://example.com", format: "html" }, html.browser);
    expect(html.calls[0]?.action).toBe("content");

    const shot = pages(
      () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }),
    );
    const png = await page({ url: "https://example.com", format: "screenshot" }, shot.browser);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it("refuses a bad URL or format, and reports a page that Browser Run did not read", async () => {
    const { browser, calls } = pages(() => Response.json({ success: true, result: "x" }));
    expect((await page({ url: "not a url" }, browser)).status).toBe(400);
    expect((await page({ url: "file:///etc/passwd" }, browser)).status).toBe(400);
    expect((await page({ url: "https://example.com", format: "video" }, browser)).status).toBe(400);
    expect(calls).toHaveLength(0);

    expect((await page({ url: "https://example.com" })).status).toBe(503);
    const failed = pages(() =>
      Response.json({ success: false, errors: [{ message: "net::ERR_NAME_NOT_RESOLVED" }] }),
    );
    const res = await page({ url: "https://nope.invalid" }, failed.browser);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).toContain("ERR_NAME_NOT_RESOLVED");
    const down = pages(() => new Response("rate limited", { status: 429 }));
    expect((await page({ url: "https://example.com" }, down.browser)).status).toBe(502);
  });

  // Regression: with lockdown on the container has no general internet, but /page loaded any URL through
  // the Worker's Browser Run binding, so the workspace could still reach (and send data to) any site.
  it("refuses with lockdown on, before Browser Run sees the URL", async () => {
    const { browser, calls } = pages(() => Response.json({ success: true, result: "x" }));
    const res = await handleAi(
      post("/page", { url: "https://example.com/?data=secret" }),
      undefined,
      "default",
      undefined,
      browser,
      { lockdown: true },
    );
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toMatch(/lockdown/);
    expect(calls).toHaveLength(0);
  });
});
