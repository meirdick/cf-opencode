// Per-workspace server password. The proxy checks it against a stored sha256 prefix.
// The password is derived from the control token and the workspace id (workspacePassword), so every
// machine with the control token gets the same one, and the Worker can compute it to ask the
// workspace's opencode whether an agent is busy. It is never stored, by the Worker or in the container.

export async function sha256Hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 bytes, base64url, no padding. Suitable as an HTTP basic password. */
export function mintPassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Bumping the label rotates every workspace password. The CLI (cli/src/connect.ts) must match. */
export const PASSWORD_LABEL = "cf-opencode/workspace-password/v1/";

/** base64url(HMAC-SHA256(controlToken, PASSWORD_LABEL + workspaceId)), no padding: 43 characters. */
export async function workspacePassword(controlToken: string, workspaceId: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(controlToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(PASSWORD_LABEL + workspaceId)));
  return btoa(String.fromCharCode(...mac))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const aa = new Uint8Array(da);
  const bb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** Authorization: Basic base64(opencode:<password>). Returns the password, or undefined. */
export function basicPassword(header: string | null): string | undefined {
  if (!header) return undefined;
  const m = /^Basic\s+(\S+)\s*$/i.exec(header);
  if (!m?.[1]) return undefined;
  let decoded: string;
  try {
    decoded = atob(m[1]);
  } catch {
    return undefined;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return undefined;
  return decoded.slice(idx + 1);
}

/**
 * Check a workspace password against the stored hash prefix (journal.tokenSha: first 16 hex
 * of sha256). Constant time. A workspace that never started has no hash, so nothing matches:
 * only the control plane, with its bearer token, can set the first password.
 */
export async function passwordMatches(
  storedSha: string | undefined,
  password: string | null | undefined,
): Promise<boolean> {
  if (!storedSha || !password) return false;
  return timingSafeEqualStr((await sha256Hex(password)).slice(0, 16), storedSha);
}
