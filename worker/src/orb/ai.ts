// Models through the account's own AI binding. No provider key exists anywhere.
//
// OpenCode in the container uses its built-in Cloudflare providers, pointed at AI_HOST over
// plain HTTP. The platform intercepts that host and hands each request to AiEgress, which
// runs it with env.AI.run() through the install's AI Gateway. Workers AI models bill to the
// Workers Paid plan; third-party models (openai/, anthropic/, google/...) bill to the
// account's AI Gateway credits (Unified Billing). Verified live 2026-11-11 through the
// binding: chat completions (tools, streaming) for @cf/, openai/, anthropic/ and google/
// models, Anthropic Messages for anthropic/, and OpenAI Responses for openai/.
import { previewPortOf } from "./preview-hosts";

export type PreviewFormat = "markdown" | "html" | "links" | "screenshot" | "pdf";

/** Intercepted, never resolved publicly. HTTP, so the request needs no CA. */
export const AI_HOST = "ai.cf-opencode.internal";
export const AI_BASE_URL = `http://${AI_HOST}/v1`;

/** What OpenCode sends as the API key. The binding needs none. */
export const AI_PLACEHOLDER = "cf-opencode-egress";

/** The part of env.AI this module uses. */
export interface AiRunner {
  run(model: string, input: Record<string, unknown>, options: { gateway: { id: string } }): Promise<unknown>;
  /** Cloudflare Web Search API, through AI Gateway. Absent on a runtime from before it existed. */
  websearch?(input: {
    gatewayId: string;
    query: string;
    limit: number;
    provider?: string;
  }): Promise<Response>;
}

/** The part of env.BROWSER this module uses: Browser Run Quick Actions. */
export interface PageRunner {
  quickAction(action: string, options: Record<string, unknown>): Promise<Response>;
}

/** Read a page for the workspace: POST /page on AI_HOST. `cf-opencode-fetch` in the image calls it. */
export const PAGE_PATH = "/page";
/** format in the request → Quick Action, and whether the answer is a JSON envelope with a `result`. */
const PAGE_FORMATS: Record<string, { action: string; envelope: boolean; type: string }> = {
  markdown: { action: "markdown", envelope: true, type: "text/markdown; charset=utf-8" },
  html: { action: "content", envelope: true, type: "text/html; charset=utf-8" },
  links: { action: "links", envelope: true, type: "application/json" },
  screenshot: { action: "screenshot", envelope: false, type: "image/png" },
  pdf: { action: "pdf", envelope: false, type: "application/pdf" },
};

/** Web search for the workspace: POST /search on AI_HOST. `cf-opencode-search` in the image calls it. */
export const SEARCH_PATH = "/search";
export const SEARCH_MAX_QUERY = 1024;
export const SEARCH_MAX_RESULTS = 10;
const SEARCH_PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** The three request shapes OpenCode's Cloudflare providers send. */
const PATHS = new Set(["/v1/chat/completions", "/v1/messages", "/v1/responses"]);

/**
 * OpenCode config for the container, passed as OPENCODE_CONFIG_CONTENT. The serve script also
 * saves it for OpenCode in a shell or an SSH session; it holds a placeholder, not a key. Both built-in Cloudflare providers keep their model lists from models.dev;
 * only where they send changes. The gateway provider's models that have no per-model SDK
 * fall back to OpenAI-compatible chat completions.
 */
export function opencodeConfig(model: string | undefined): string {
  const options = { baseURL: AI_BASE_URL, apiKey: AI_PLACEHOLDER };
  return JSON.stringify({
    provider: {
      "cloudflare-workers-ai": { options },
      "cloudflare-ai-gateway": { npm: "@ai-sdk/openai-compatible", options },
    },
    ...(model ? { model } : {}),
  });
}

/**
 * Reads a page of the workspace's own dev server (preview-browser.ts). Absent when the Worker cannot route a
 * browser to this workspace.
 */
export type PreviewPageReader = (
  port: number,
  path: string,
  format: PreviewFormat,
) => Promise<{ body: string | Uint8Array; type: string }>;

/** Handle one intercepted request. */
export async function handleAi(
  req: Request,
  ai: AiRunner | undefined,
  gateway: string,
  searchProvider?: string,
  browser?: PageRunner,
  preview?: PreviewPageReader,
): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method === "POST" && path === PAGE_PATH) return handlePage(req, browser, preview);
  if (!ai) return aiError(503, "the Worker has no AI binding; redeploy with cf-opencode init");
  if (req.method === "POST" && path === SEARCH_PATH) return handleSearch(req, ai, gateway, searchProvider);
  if (req.method !== "POST" || !PATHS.has(path)) return aiError(404, `no AI route ${req.method} ${path}`);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return aiError(400, "the request body is not JSON");
  }
  const model = body.model;
  if (typeof model !== "string" || model.length === 0) return aiError(400, "the request has no model");
  delete body.model;
  // AI Gateway reads max_tokens on a chat completion as a provider-native request and
  // rejects it (7003) for openai/ and mis-shapes anthropic/. Workers AI models take it.
  if (path === "/v1/chat/completions" && !model.startsWith("@cf/") && "max_tokens" in body) {
    body.max_completion_tokens ??= body.max_tokens;
    delete body.max_tokens;
  }
  let out: unknown;
  try {
    out = await ai.run(model, body, { gateway: { id: gateway } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return aiError(/7003|input/i.test(message) ? 400 : 502, `${model}: ${message}`);
  }
  if (out instanceof ReadableStream) {
    return new Response(out, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }
  if (out instanceof Response) return out;
  return Response.json(out);
}

/**
 * One web search through the account's AI Gateway. Body: { query, limit?, provider? }. The answer is
 * Cloudflare's JSON as it is. Searches bill to the account's AI Gateway credits; no key is in the workspace.
 */
async function handleSearch(
  req: Request,
  ai: AiRunner,
  gateway: string,
  defaultProvider?: string,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return aiError(400, "the request body is not JSON");
  }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) return aiError(400, "the request has no query");
  if (query.length > SEARCH_MAX_QUERY)
    return aiError(400, `the query is longer than ${SEARCH_MAX_QUERY} characters`);
  const asked = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.floor(body.limit) : 5;
  const limit = Math.min(SEARCH_MAX_RESULTS, Math.max(1, asked));
  const provider = typeof body.provider === "string" && body.provider ? body.provider : defaultProvider;
  if (provider && !SEARCH_PROVIDER_RE.test(provider)) return aiError(400, "bad search provider name");
  if (!ai.websearch)
    return aiError(501, "this Worker's AI binding has no web search; run cf-opencode upgrade");
  try {
    const res = await ai.websearch({ gatewayId: gateway, query, limit, ...(provider ? { provider } : {}) });
    const text = await res.text();
    if (!res.ok) return aiError(res.status === 402 ? 402 : 502, `web search failed: ${text.slice(0, 300)}`);
    return new Response(text, { headers: { "content-type": "application/json" } });
  } catch (e) {
    return aiError(502, `web search failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * One page through Browser Run Quick Actions: a real browser loads the URL, so pages that need JavaScript
 * work. Body: { url, format? }. format is markdown (default), html, links, screenshot or pdf. Text formats
 * come back as the text itself; screenshot and pdf as the file. Bills to the account's Browser Run usage.
 */
async function handlePage(
  req: Request,
  browser: PageRunner | undefined,
  preview?: PreviewPageReader,
): Promise<Response> {
  if (!browser?.quickAction)
    return aiError(503, "the Worker has no Browser Run binding; run cf-opencode upgrade");
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return aiError(400, "the request body is not JSON");
  }
  let url: URL;
  try {
    url = new URL(typeof body.url === "string" ? body.url : "");
  } catch {
    return aiError(400, "the request needs a full URL, such as https://example.com/page");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return aiError(400, "only http and https URLs can be read");
  const formatName = typeof body.format === "string" ? body.format : "markdown";
  const format = PAGE_FORMATS[formatName];
  if (!format) return aiError(400, `format must be one of: ${Object.keys(PAGE_FORMATS).join(", ")}`);
  // A dev server in this workspace: Quick Actions cannot reach it, a routed browser session can.
  const previewPort = previewPortOf(url);
  if (previewPort !== undefined) {
    if (!preview)
      return aiError(503, "this Worker cannot open the workspace's dev servers; run cf-opencode upgrade");
    try {
      const out = await preview(previewPort, `${url.pathname}${url.search}`, formatName as PreviewFormat);
      return new Response(out.body as BodyInit, { headers: { "content-type": out.type } });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return aiError(502, `port ${previewPort} was not read (${why}); start the dev server on 0.0.0.0`);
    }
  }
  try {
    const res = await browser.quickAction(format.action, {
      url: url.toString(),
      gotoOptions: { waitUntil: "networkidle2", timeout: 30_000 },
    });
    if (!res.ok) return aiError(502, `the page was not read: ${(await res.text()).slice(0, 300)}`);
    if (!format.envelope) return new Response(res.body, { headers: { "content-type": format.type } });
    const data = (await res.json()) as { success?: boolean; result?: unknown; errors?: unknown };
    if (data.success === false || data.result === undefined)
      return aiError(502, `the page was not read: ${JSON.stringify(data.errors ?? data).slice(0, 300)}`);
    const out = typeof data.result === "string" ? data.result : JSON.stringify(data.result);
    return new Response(out, { headers: { "content-type": format.type } });
  } catch (e) {
    return aiError(502, `the page was not read: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** An error both the OpenAI and Anthropic SDKs show as a message. */
function aiError(status: number, message: string): Response {
  return Response.json({ type: "error", error: { type: "cf_opencode_error", message } }, { status });
}
