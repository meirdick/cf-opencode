// cf-opencode-fetch for a dev server in the workspace (http://p3000.preview.internal/ or http://localhost:3000/).
//
// Quick Actions document no outboundByHost, so they cannot reach a preview hostname. A browser session can
// (preview-hosts.ts). This opens one session with the preview hostname routed to the workspace, loads the page over
// the Chrome DevTools Protocol, reads what the format asks for, and closes the session. Markdown goes through the
// markdown Quick Action with the rendered HTML, which it accepts in place of a URL.
// Docs: https://developers.cloudflare.com/browser-run/reference/browser-binding-api/ and
// https://developers.cloudflare.com/browser-run/quick-actions/markdown-endpoint/ (read 2026-11-12).
import type { BrowserBinding } from "./browse";
import { previewHost } from "./preview-hosts";

export interface PreviewBrowser extends BrowserBinding {
  quickAction(action: string, options: Record<string, unknown>): Promise<Response>;
  closeSession?(sessionId: string): Promise<unknown>;
}

/** The part of a websocket the CDP client uses. */
export interface CdpSocket {
  accept?(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close", fn: (ev: { data?: unknown }) => void): void;
}

const LOAD_TIMEOUT_MS = 30_000;
/** After the load event, a single-page app still renders. A short wait catches most first renders. */
const SETTLE_MS = 1000;

/** A minimal CDP client: numbered commands, flat sessions, and waits for one event. */
export class Cdp {
  private next = 0;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private readonly waiters: { method: string; sessionId?: string; resolve(v: unknown): void }[] = [];
  private closed = false;

  constructor(private readonly ws: CdpSocket) {
    ws.addEventListener("message", (ev) => {
      let m: {
        id?: number;
        method?: string;
        sessionId?: string;
        result?: unknown;
        error?: { message?: string };
        params?: unknown;
      };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof m.id === "number") {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new Error(m.error.message ?? "CDP error"));
        else p?.resolve(m.result ?? {});
        return;
      }
      for (const w of [...this.waiters]) {
        if (w.method === m.method && (w.sessionId === undefined || w.sessionId === m.sessionId)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(m.params);
        }
      }
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("the browser closed the connection"));
      this.pending.clear();
    });
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("the browser closed the connection"));
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** Resolves on the next event of this name; rejects after timeoutMs. Register before the command that causes it. */
  waitFor(method: string, sessionId: string | undefined, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const w = { method, sessionId, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`the page did not finish loading in ${timeoutMs / 1000} s`));
        }
      }, timeoutMs);
    });
  }
}

/** Run CDP steps on one page of a fresh session whose outbound routes reach the workspace's dev server. */
async function withPage<T>(
  browser: PreviewBrowser,
  outbound: Record<string, Fetcher>,
  run: (cdp: Cdp, page: string) => Promise<T>,
  settleMs: number,
  url: string,
): Promise<T> {
  const acquire = browser.acquire as (o: Record<string, unknown>) => Promise<{ sessionId: string }>;
  const { sessionId } = await acquire({ keepAlive: 60_000, outboundByHost: outbound });
  let ws: CdpSocket | undefined;
  try {
    const { webSocket } = await browser.connectSession(sessionId);
    const res = await webSocket.fetch("https://browser-binding.invalid", {
      headers: { upgrade: "websocket" },
    });
    if (!res.webSocket) throw new Error(`the browser refused the connection (${res.status})`);
    ws = res.webSocket as unknown as CdpSocket;
    ws.accept?.();
    const cdp = new Cdp(ws);
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId: page } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await cdp.send("Page.enable", {}, page);
    const loaded = cdp.waitFor("Page.loadEventFired", page, LOAD_TIMEOUT_MS);
    const nav = await cdp.send<{ errorText?: string }>("Page.navigate", { url }, page);
    if (nav.errorText) {
      loaded.catch(() => undefined);
      throw new Error(nav.errorText);
    }
    await loaded;
    if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
    return await run(cdp, page);
  } finally {
    try {
      ws?.close(1000, "done");
    } catch {
      // already closed
    }
    await browser.closeSession?.(sessionId).catch(() => undefined);
  }
}

async function evaluate(cdp: Cdp, page: string, expression: string): Promise<string> {
  const r = await cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
    "Runtime.evaluate",
    { expression, returnByValue: true },
    page,
  );
  if (r.exceptionDetails) throw new Error("the page script failed");
  return String(r.result?.value ?? "");
}

function fromBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}

/**
 * Read one page of the workspace's dev server on `port`. `path` is the path and query on that server.
 * Answers like handlePage: text for markdown, html and links; the file for screenshot and pdf.
 */
export async function readPreviewPage(
  browser: PreviewBrowser,
  outbound: Record<string, Fetcher>,
  port: number,
  path: string,
  format: "markdown" | "html" | "links" | "screenshot" | "pdf",
  settleMs = SETTLE_MS,
): Promise<{ body: string | Uint8Array; type: string }> {
  const url = `http://${previewHost(port)}${path}`;
  return withPage(
    browser,
    outbound,
    async (cdp, page) => {
      if (format === "screenshot") {
        const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, page);
        return { body: fromBase64(data), type: "image/png" };
      }
      if (format === "pdf") {
        const { data } = await cdp.send<{ data: string }>("Page.printToPDF", { printBackground: true }, page);
        return { body: fromBase64(data), type: "application/pdf" };
      }
      if (format === "links") {
        const links = await evaluate(cdp, page, "JSON.stringify(Array.from(document.links, (a) => a.href))");
        return { body: links, type: "application/json" };
      }
      const html = await evaluate(cdp, page, "document.documentElement.outerHTML");
      if (format === "html") return { body: html, type: "text/html; charset=utf-8" };
      const res = await browser.quickAction("markdown", { html });
      if (!res.ok) throw new Error(`markdown failed: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { result?: unknown };
      if (typeof data.result !== "string") throw new Error("markdown returned no text");
      return { body: data.result, type: "text/markdown; charset=utf-8" };
    },
    settleMs,
    url,
  );
}
