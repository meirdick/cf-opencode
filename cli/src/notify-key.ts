// The key that signs the Worker's POSTs to notifyUrl. Derived from the control token, as the Worker does
// (worker/src/orb/task-notify.ts notifyKey), so it is never stored and every machine gets the same one.
import { createHmac } from "node:crypto";

/** Bumping the label changes the key. It must match NOTIFY_KEY_LABEL in the Worker. */
export const NOTIFY_KEY_LABEL = "cf-opencode/notify-key/v1";

/** hex HMAC-SHA256(control token, label). The receiver uses this string as its HMAC secret. */
export function notifyKey(controlToken: string): string {
  return createHmac("sha256", controlToken).update(NOTIFY_KEY_LABEL).digest("hex");
}

/**
 * Why a notify URL is not usable, or undefined. The same rules as the Worker's checkNotifyUrl
 * (worker/src/core/config.ts), which checks again at each send: https, no user or password, a public host name.
 */
export function checkNotifyUrl(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length === 0 || v.length > 2000)
    return "must be an https URL up to 2000 characters";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "is not a URL";
  }
  if (u.protocol !== "https:") return "must start with https://";
  if (u.username || u.password) return "must not hold a user or password; the POST is signed instead";
  const host = u.hostname.toLowerCase();
  if (
    !host.includes(".") ||
    /^[0-9.]+$/.test(host) ||
    host.startsWith("[") ||
    /\.(localhost|local|internal|home\.arpa)$/.test(host)
  )
    return "must name a public host, not an IP address, localhost or an internal name";
  return undefined;
}

/**
 * What a receiver checks: x-cf-opencode-signature equals this for the raw body and the value of
 * x-cf-opencode-timestamp (Unix seconds). It should also refuse a timestamp more than 5 minutes old.
 */
export function signature(key: string, body: string, timestamp: number | string): string {
  return `sha256=${createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex")}`;
}
