// The key that signs the Worker's POSTs to notifyUrl. Derived from the control token, as the Worker does
// (worker/src/orb/task-notify.ts notifyKey), so it is never stored and every machine gets the same one.
import { createHmac } from "node:crypto";

/** Bumping the label changes the key. It must match NOTIFY_KEY_LABEL in the Worker. */
export const NOTIFY_KEY_LABEL = "cf-opencode/notify-key/v1";

/** hex HMAC-SHA256(control token, label). The receiver uses this string as its HMAC secret. */
export function notifyKey(controlToken: string): string {
  return createHmac("sha256", controlToken).update(NOTIFY_KEY_LABEL).digest("hex");
}

/** What a receiver checks: x-cf-opencode-signature equals this for the raw body. */
export function signature(key: string, body: string): string {
  return `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
}
