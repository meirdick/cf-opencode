// Browser sessions for a workspace, through the Worker's Browser Run binding.
//
// The binding exists only in a Worker, and it needs no token: sessions bill to the account
// that owns the Worker, per browser hour. The container never reaches Browser Run itself.
// It asks the Worker for a session (POST /browse/<id>), then opens a websocket on the
// Worker (GET /browse/<id>/<session>), which the Worker relays to the session's CDP socket.
//
// Docs: https://developers.cloudflare.com/browser-run/reference/browser-binding-api/
// (fetched 2026-11-11). keepAlive is 10 s–20 min.

/** 10 minutes. The documented maximum is 20; a forgotten session should not run that long. */
export const KEEP_ALIVE_MS = 600_000;
const KEEP_ALIVE_MIN = 10_000;
const KEEP_ALIVE_MAX = 1_200_000;

/** Browser Run session ids, as acquire() returns them. */
export const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** The part of the Browser Run binding this module uses. */
export interface BrowserBinding {
  acquire(options?: { keepAlive?: number }): Promise<{ sessionId: string }>;
  connectSession(sessionId: string): Promise<{ webSocket: Fetcher }>;
  getLiveView(sessionId: string): Promise<{ devtoolsFrontendUrl?: string } | null>;
}

export interface BrowserSession {
  sessionId: string;
  /** DevTools UI for a local browser. It carries a session-scoped access token. */
  liveUrl?: string;
}

const NOT_SET_UP = "Failed: this Worker has no Browser Run binding — fix: redeploy with cf-opencode init";

/** Open one browser session. `keepAliveMs` is clamped to the documented range. */
export async function openBrowserSession(
  browser: BrowserBinding | undefined,
  keepAliveMs: number = KEEP_ALIVE_MS,
): Promise<BrowserSession | { error: string; status: number }> {
  if (!browser) return { error: NOT_SET_UP, status: 503 };
  const keepAlive = Math.min(KEEP_ALIVE_MAX, Math.max(KEEP_ALIVE_MIN, Math.floor(keepAliveMs)));
  let sessionId: string;
  try {
    // One retry: acquire has returned a transient 500 right after a deploy (seen live).
    ({ sessionId } = await browser.acquire({ keepAlive }).catch(() => browser.acquire({ keepAlive })));
  } catch (e) {
    return {
      error: `Failed: Browser Run refused a session (${errText(e)}) — fix: retry cf-opencode browse`,
      status: 502,
    };
  }
  const live = await browser.getLiveView(sessionId).catch(() => null);
  return { sessionId, ...(live?.devtoolsFrontendUrl ? { liveUrl: live.devtoolsFrontendUrl } : {}) };
}

/** Open the CDP websocket of one session, for the Worker to relay. */
export async function connectCdp(
  browser: BrowserBinding | undefined,
  sessionId: string,
): Promise<WebSocket | { error: string; status: number }> {
  if (!browser) return { error: NOT_SET_UP, status: 503 };
  try {
    const { webSocket } = await browser.connectSession(sessionId);
    const res = await webSocket.fetch("https://browser-binding.invalid", {
      headers: { upgrade: "websocket" },
    });
    if (res.webSocket) return res.webSocket;
    return {
      error: `Failed: browser session ${sessionId} refused the connection (${res.status}) — fix: open a new one with cf-opencode browse`,
      status: 502,
    };
  } catch (e) {
    return {
      error: `Failed: browser session ${sessionId} is gone (${errText(e)}) — fix: open a new one with cf-opencode browse`,
      status: 502,
    };
  }
}

/** Relay every frame between two accepted websockets until either closes. */
export function relay(a: WebSocket, b: WebSocket): void {
  const forward = (from: WebSocket, to: WebSocket) => {
    from.addEventListener("message", (ev) => {
      try {
        to.send(ev.data as string | ArrayBuffer);
      } catch {
        // the other side is gone; its close handler ends this side
      }
    });
    from.addEventListener("close", (ev) => {
      try {
        to.close(ev.code === 1005 || ev.code === 1006 ? 1000 : ev.code, ev.reason);
      } catch {
        // already closed
      }
    });
    from.addEventListener("error", () => {
      try {
        to.close(1011, "peer error");
      } catch {
        // already closed
      }
    });
  };
  forward(a, b);
  forward(b, a);
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
}
