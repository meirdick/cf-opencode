// Preview credentials. A browser cannot send the workspace password on every request, so the Worker gives it a
// cookie instead. The cookie and the one-time sign-in link are HMACs the Worker checks without stored state.
//
// - The key is HMAC(control token, PREVIEW_KEY_LABEL). It is never the password, and it never leaves the Worker.
// - A cookie says "workspace W, port P, until T". A cookie for another workspace or port does not verify.
// - A sign-in link carries a ticket, not the password: "workspace W, port P, until T, nonce N", valid 2 minutes.
//   The Durable Object keeps used nonces until they expire, so a ticket works once.
// - Rotating the control token rotates the key, and every cookie stops working.
import { timingSafeEqualStr } from "./auth";

/** Bumping the label signs every preview cookie out. */
export const PREVIEW_KEY_LABEL = "cf-opencode/preview/v1";
export const PREVIEW_COOKIE = "cf_opencode_preview";
export const TICKET_PARAM = "cf_opencode_ticket";
/** A browser stays signed in for 8 hours. */
export const COOKIE_TTL_S = 8 * 3600;
/** Long enough to open a browser; short enough that a copied link is useless soon. */
export const TICKET_TTL_S = 120;

export const PORT_MIN = 1024;
export const PORT_MAX = 65535;

/** A preview port: a whole number from 1024 to 65535, not sshd, not opencode serve. Else the reason it is refused. */
export function checkPort(raw: unknown, serverPort: number): { port: number } | { error: string } {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : "";
  if (!/^[0-9]{1,5}$/.test(s)) return { error: "the port must be a whole number from 1024 to 65535" };
  const port = Number(s);
  if (port < PORT_MIN || port > PORT_MAX)
    return { error: "the port must be a whole number from 1024 to 65535" };
  if (port === serverPort)
    return { error: `port ${port} is OpenCode's own server; preview your dev server's port` };
  if (port === 22) return { error: "port 22 is not a web server" };
  return { port };
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** 32 random bytes, base64url: a ticket nonce or a public share token. */
export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64url(b);
}

/** The signing key, derived from the control token. Undefined without a control token: previews are off then. */
export async function previewKey(controlToken: string | undefined): Promise<CryptoKey | undefined> {
  if (!controlToken) return undefined;
  const base = await crypto.subtle.importKey(
    "raw",
    enc.encode(controlToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const raw = await crypto.subtle.sign("HMAC", base, enc.encode(PREVIEW_KEY_LABEL));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function mac(key: CryptoKey, ...fields: string[]): Promise<string> {
  // Newline-joined: no field can hold a newline (ids and numbers only), so two field lists never collide.
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(fields.join("\n")))));
}

/** Cookie value "<expiry s>.<mac>". */
export async function signCookie(
  key: CryptoKey,
  workspaceId: string,
  port: number,
  nowMs: number,
): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + COOKIE_TTL_S;
  return `${exp}.${await mac(key, "cookie", workspaceId, String(port), String(exp))}`;
}

export async function verifyCookie(
  key: CryptoKey,
  value: string,
  workspaceId: string,
  port: number,
  nowMs: number,
): Promise<boolean> {
  const m = /^([0-9]{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return false;
  const exp = Number(m[1]);
  const want = await mac(key, "cookie", workspaceId, String(port), String(exp));
  // Compare first, then check the time, so a wrong and an expired cookie take the same work.
  const ok = await timingSafeEqualStr(m[2] as string, want);
  return ok && exp * 1000 > nowMs;
}

/** Ticket "<expiry s>.<nonce>.<mac>" for a one-time sign-in link. */
export async function signTicket(
  key: CryptoKey,
  workspaceId: string,
  port: number,
  nowMs: number,
): Promise<{ ticket: string; nonce: string; expiresAt: number }> {
  const exp = Math.floor(nowMs / 1000) + TICKET_TTL_S;
  const nonce = randomToken(16);
  const sig = await mac(key, "ticket", workspaceId, String(port), String(exp), nonce);
  return { ticket: `${exp}.${nonce}.${sig}`, nonce, expiresAt: exp * 1000 };
}

/** The ticket's nonce and expiry when it is valid for this workspace and port now. The caller checks one-time use. */
export async function verifyTicket(
  key: CryptoKey,
  ticket: string,
  workspaceId: string,
  port: number,
  nowMs: number,
): Promise<{ nonce: string; expiresAt: number } | undefined> {
  const m = /^([0-9]{1,12})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(ticket);
  if (!m) return undefined;
  const exp = Number(m[1]);
  const nonce = m[2] as string;
  const want = await mac(key, "ticket", workspaceId, String(port), String(exp), nonce);
  const ok = await timingSafeEqualStr(m[3] as string, want);
  if (!ok || exp * 1000 <= nowMs) return undefined;
  return { nonce, expiresAt: exp * 1000 };
}

/**
 * A public share token: "<nonce><mac>", 22 + 32 base64url characters. The MAC covers the workspace and the nonce,
 * so the Worker refuses a forged token, or one for another workspace, before it calls a Durable Object. The
 * Durable Object still decides whether the share exists now and which port it opens: --stop removes it there.
 */
export async function signShareToken(key: CryptoKey, workspaceId: string): Promise<string> {
  const nonce = randomToken(16);
  return `${nonce}${(await mac(key, "share", workspaceId, nonce)).slice(0, 32)}`;
}

export async function verifyShareToken(key: CryptoKey, token: string, workspaceId: string): Promise<boolean> {
  const m = /^([A-Za-z0-9_-]{22})([A-Za-z0-9_-]{32})$/.exec(token);
  if (!m) return false;
  const want = (await mac(key, "share", workspaceId, m[1] as string)).slice(0, 32);
  return timingSafeEqualStr(m[2] as string, want);
}

/** Every value of the preview cookie in a Cookie header. A browser can send several, one for each path. */
export function previewCookies(header: string | null): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === PREVIEW_COOKIE) out.push(part.slice(i + 1).trim());
  }
  return out;
}

/** The Cookie header without the preview cookie, so the dev server never sees it. Null when nothing is left. */
export function withoutPreviewCookie(header: string | null): string | null {
  if (!header) return null;
  const kept = header
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && p.split("=")[0]?.trim() !== PREVIEW_COOKIE);
  return kept.length ? kept.join("; ") : null;
}

/** Remove every x-cf-opencode-* header. A client must not set the Worker's own routing headers. */
export function dropInternalHeaders(headers: Headers): void {
  const names: string[] = [];
  headers.forEach((_, name) => {
    if (name.toLowerCase().startsWith("x-cf-opencode-")) names.push(name);
  });
  for (const name of names) headers.delete(name);
}

/** The path a preview lives under. The cookie is scoped to it. */
export function previewPrefix(workspaceId: string, port: number): string {
  return `/preview/${workspaceId}/${port}/`;
}

/** Set-Cookie for one workspace and port. HttpOnly: page scripts cannot read it. Lax: other sites cannot post with it. */
export function cookieHeader(value: string, workspaceId: string, port: number): string {
  return `${PREVIEW_COOKIE}=${value}; Path=${previewPrefix(workspaceId, port)}; Max-Age=${COOKIE_TTL_S}; HttpOnly; Secure; SameSite=Lax`;
}
