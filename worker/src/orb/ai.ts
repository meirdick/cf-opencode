// Models through the account's own AI binding. No provider key exists anywhere.
//
// OpenCode in the container uses its built-in Cloudflare providers, pointed at AI_HOST over
// plain HTTP. The platform intercepts that host and hands each request to AiEgress, which
// runs it with env.AI.run() through the install's AI Gateway. Workers AI models bill to the
// Workers Paid plan; third-party models (openai/, anthropic/, google/...) bill to the
// account's AI Gateway credits (Unified Billing). Verified live 2026-11-11 through the
// binding: chat completions (tools, streaming) for @cf/, openai/, anthropic/ and google/
// models, Anthropic Messages for anthropic/, and OpenAI Responses for openai/.

/** Intercepted, never resolved publicly. HTTP, so the request needs no CA. */
export const AI_HOST = "ai.cf-opencode.internal";
export const AI_BASE_URL = `http://${AI_HOST}/v1`;

/** What OpenCode sends as the API key. The binding needs none. */
export const AI_PLACEHOLDER = "cf-opencode-egress";

/** The part of env.AI this module uses. */
export interface AiRunner {
  run(model: string, input: Record<string, unknown>, options: { gateway: { id: string } }): Promise<unknown>;
}

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

/** Handle one intercepted request. */
export async function handleAi(req: Request, ai: AiRunner | undefined, gateway: string): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (!ai) return aiError(503, "the Worker has no AI binding; redeploy with cf-opencode init");
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

/** An error both the OpenAI and Anthropic SDKs show as a message. */
function aiError(status: number, message: string): Response {
  return Response.json({ type: "error", error: { type: "cf_opencode_error", message } }, { status });
}
