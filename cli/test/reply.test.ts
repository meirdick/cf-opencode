import { describe, expect, it } from "vitest";
import { replyTask } from "../src/reply.js";

const t = { url: "https://cf-opencode.example.workers.dev/", id: "app", password: "pw-1" };

describe("tasks --reply", () => {
  it("posts the text to the session's prompt call through /oc, with the workspace password", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await replyTask(t, "ses_abc123", "  use the staging database  ", f);
    expect(calls[0]?.url).toBe(
      "https://cf-opencode.example.workers.dev/oc/app/api/session/ses_abc123/prompt",
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ text: "use the staging database" });
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(Buffer.from(headers.authorization?.split(" ")[1] ?? "", "base64").toString()).toBe(
      "opencode:pw-1",
    );
    // The password is in a header, never in the URL.
    expect(calls[0]?.url).not.toContain("pw-1");
  });

  it("refuses a bad id or an empty reply before any request, and names the fix for each answer", async () => {
    let n = 0;
    const count = (async () => {
      n++;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await expect(replyTask(t, "ses_x/../../v1", "hi", count)).rejects.toThrow(/bad task id/);
    await expect(replyTask(t, "ses_abc", "   ", count)).rejects.toThrow(/reply is empty/);
    expect(n).toBe(0);
    const answer = (status: number) =>
      (async () => new Response("{}", { status })) as unknown as typeof fetch;
    await expect(replyTask(t, "ses_abc", "hi", answer(401))).rejects.toThrow(
      /no access.*fix: cf-opencode connect app/,
    );
    await expect(replyTask(t, "ses_abc", "hi", answer(404))).rejects.toThrow(/no session ses_abc/);
    await expect(replyTask(t, "ses_abc", "hi", answer(500))).rejects.toThrow(
      /refused the reply \(HTTP 500\)/,
    );
  });
});
