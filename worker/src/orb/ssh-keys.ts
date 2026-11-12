// The SSH keys cf-opencode puts in the workspace's ~/.ssh/authorized_keys.
//
// Each machine has its own CLI key (~/.cf-opencode/ssh/id_ed25519) and sends it on every SSH connect. The
// Durable Object keeps the keys it saw and when, and each connect rewrites one marked block in
// authorized_keys with the keys seen in the last SSH_KEY_DAYS days. So two machines both keep working, and a
// machine that stopped connecting (a former holder of the password, an old laptop) drops out by itself.
// Lines the user wrote outside the block stay.
//
// This is hygiene, not the gate: sshd listens nowhere, and /ssh needs the workspace password first.
// Rotating the control token (which changes every derived password) is what shuts a former holder out.
import type { ContainerPort, KV } from "../core/container-port";
import { sh, WORKSPACE_USER } from "./spawn";

export const SSH_KEYS_KEY = "sshKeys";
export const SSH_KEY_DAYS = 30;
export const MAX_SSH_KEYS = 20;
const DAY_MS = 86_400_000;

type Seen = Record<string, { line: string; at: number }>;

/** "type base64": a key without its comment, so a changed comment is the same key. */
function keyId(line: string): string {
  return line.split(" ").slice(0, 2).join(" ");
}

/** Record that `line` connected now. Returns the current key set, newest first. */
export async function recordSshKey(kv: KV, line: string, nowMs: number): Promise<string[]> {
  const seen: Seen = (await kv.get<Seen>(SSH_KEYS_KEY)) ?? {};
  seen[keyId(line)] = { line, at: nowMs };
  const current = Object.entries(seen)
    .filter(([, v]) => nowMs - v.at <= SSH_KEY_DAYS * DAY_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_SSH_KEYS);
  await kv.put(SSH_KEYS_KEY, Object.fromEntries(current));
  return current.map(([, v]) => v.line);
}

export const KEYS_BEGIN = "# cf-opencode keys: begin. cf-opencode rewrites this block on each ssh connect.";
export const KEYS_END = "# cf-opencode keys: end";

/**
 * Rewrite the cf-opencode block of authorized_keys. Runs as the workspace user, so a symlink planted in
 * ~/.ssh cannot point a root write at a system file. Env: AUTHORIZED_KEYS (the key lines),
 * AUTHORIZED_KEYS_FILE (tests). Lines outside the block stay, except keys with the comment "cf-opencode"
 * that an earlier release appended there. Prints "keys <n>".
 */
export const AUTHORIZED_KEYS_SH = `
set -eu
K="\${AUTHORIZED_KEYS_FILE:-$HOME/.ssh/authorized_keys}"
D=$(dirname "$K")
mkdir -p "$D"
chmod 700 "$D"
tmp=$(mktemp "$D/.authorized_keys.XXXXXX")
trap 'rm -f "$tmp"' EXIT
{
  if [ -f "$K" ]; then
    awk -v b='${KEYS_BEGIN}' -v e='${KEYS_END}' '
      $0 == b { skip = 1; next }
      $0 == e { skip = 0; next }
      skip { next }
      NF == 3 && $3 == "cf-opencode" && $1 ~ /^(ssh-|ecdsa-|sk-)/ { next }
      { print }' "$K"
  fi
  printf '%s\\n' '${KEYS_BEGIN}'
  printf '%s\\n' "$AUTHORIZED_KEYS"
  printf '%s\\n' '${KEYS_END}'
} > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$K"
trap - EXIT
echo "keys $(printf '%s\\n' "$AUTHORIZED_KEYS" | grep -c .)"
`;

/** Record `key` and write the current key set into the workspace. Returns an error line, or undefined. */
export async function installSshKeys(
  port: ContainerPort,
  kv: KV,
  key: string,
  nowMs: number,
): Promise<string | undefined> {
  const keys = await recordSshKey(kv, key, nowMs);
  const [cmd, opts] = sh(AUTHORIZED_KEYS_SH, { AUTHORIZED_KEYS: keys.join("\n") });
  const r = await port.exec(cmd, { ...opts, user: WORKSPACE_USER, timeoutMs: 15_000 });
  if (r.exitCode === 0) return undefined;
  return (r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`).slice(0, 200);
}
