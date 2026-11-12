// Shell scripts run inside the workspace container with exec(["bash", "-c", SCRIPT], { env }).
//
// Rules for every script:
// - Exec env is not inherited from start(); the caller passes HOME=/home/user, USER, LANG and inputs.
// - Safe to run twice. An exec timeout only aborts the request; the script keeps running, so every wait is bounded.
// - The server password is never written to disk or argv. The state file keeps only its sha256 prefix.
// - Every log tail goes through redact.
//
// State file $HOME/.cf-opencode/server, one line: "<pid> <boot_id> <password_sha>".
// It is on the root disk, so it survives snapshots; boot_id tells a restore apart from a retry.
//
// Template literals: "\${" is a literal "${" for bash; "\\" is one backslash.

/** Redaction rules shared by the Worker (redact) and the scripts. Order matters. */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{16,}/g, "sk-<redacted>"],
  [/Bearer [A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>"],
  [/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9._-]+/g, "<redacted-jwt>"],
  [/[A-Za-z0-9+/=]{48,}/g, "<redacted>"],
];

/**
 * Remove secrets from a log line or block. Exact values in `secrets` (the server password of the current
 * op, a model key) go first, then the pattern rules.
 */
export function redact(s: string, secrets: readonly string[] = []): string {
  let out = s;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join("<redacted>");
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

const PRELUDE = `
set -u
D="$HOME/.cf-opencode"
STATE="$D/server"
LOG="$D/serve.log"
BOOT=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)
mkdir -p "$D"

redact() {
  local s="$1"
  local k
  for k in \${REDACT_SECRETS:-}; do
    [ -n "$k" ] || continue
    s=\${s//"$k"/"<redacted>"}
  done
  printf '%s\\n' "$s" | sed -E \\
    -e 's/sk-[A-Za-z0-9_-]{16,}/sk-<redacted>/g' \\
    -e 's/Bearer [A-Za-z0-9._~+/-]+/Bearer <redacted>/g' \\
    -e 's/eyJ[A-Za-z0-9_-]*\\.[A-Za-z0-9._-]+/<redacted-jwt>/g' \\
    -e 's/[A-Za-z0-9+/=]{48,}/<redacted>/g'
}

read_state() {
  [ -f "$STATE" ] || return 1
  read -r S_PID S_BOOT S_SHA _ < "$STATE" || return 1
  case "$S_PID" in ''|*[!0-9]*) return 1 ;; esac
}

alive() { kill -0 "$1" 2>/dev/null; }

is_server() {
  alive "$1" || return 1
  local cmd
  cmd=$(tr '\\0' ' ' < /proc/$1/cmdline 2>/dev/null) || return 1
  case "$cmd" in *opencode*serve*) return 0 ;; *) return 1 ;; esac
}
`;

/**
 * Start opencode serve if this boot does not already have one.
 * Env: PORT, DIRECTORY, PASSWORD_SHA, OPENCODE_SERVER_PASSWORD, REDACT_SECRETS (optional),
 * OPENCODE_CONFIG_CONTENT (optional).
 * Prints "started <pid>" or "already <pid>". The password reaches the process through env only.
 */
export const SERVE_SH = `${PRELUDE}
PORT=\${PORT:-4096}
DIR=\${DIRECTORY:-/home/user/project}
if [ -n "\${CF_OPENCODE_WORKSPACE:-}" ]; then
  printf '%s\n' "$CF_OPENCODE_WORKSPACE" > /home/user/.cf-opencode-workspace
fi
if [ -n "\${CF_OPENCODE_URL:-}" ]; then
  printf '%s\n' "$CF_OPENCODE_URL" > /home/user/.cf-opencode-url
fi
# The model config, for OpenCode started outside this script (a shell, SSH, tmux): the image's
# opencode wrapper reads it. Written on each wake, so it follows the Worker. No secret in it.
if [ -n "\${OPENCODE_CONFIG_CONTENT:-}" ]; then
  printf '%s\n' "$OPENCODE_CONFIG_CONTENT" > "$D/opencode-config.json"
else
  rm -f "$D/opencode-config.json"
fi
# Tell the agent what this machine is. OpenCode reads ~/.config/opencode/AGENTS.md in every session.
# Ours carries a marker line; a file the user wrote there is left alone.
NOTES="$HOME/.config/opencode/AGENTS.md"
if [ ! -e "$NOTES" ] || head -n 1 "$NOTES" | grep -q "cf-opencode workspace notes"; then
  mkdir -p "$(dirname "$NOTES")"
  cat > "$NOTES" <<'CF_OPENCODE_NOTES'
<!-- cf-opencode workspace notes. cf-opencode rewrites this file on each wake. -->
# This machine

You run in a cf-opencode workspace: a Debian container on Cloudflare, owned by the user.

- Tools: \`sudo apt-get install <package>\` works without a password. Installed packages stay on the disk.
- GitHub: \`git clone\`, \`pull\`, \`push\` and \`gh\` work for the user's repositories. Do not ask for a token
  and do not run \`gh auth login\`; the credential is added outside this machine.
- Web search: run \`cf-opencode-search "<query>"\` (\`-n 10\` for more results, \`--json\` for the raw answer).
  Use it for web searches; it runs on the user's Cloudflare account. Read a result's page with your fetch tool.
- Browser: no browser is installed. Run \`cf-opencode-browse\` to open a remote browser session. It prints a
  Chrome DevTools Protocol websocket URL and how to connect. Python has the \`websocket\` module for it.
- The disk is saved when the workspace is idle. Processes do not survive that; files do.
CF_OPENCODE_NOTES
fi
SHA=\${PASSWORD_SHA:-unknown}
mkdir -p "$DIR"
if read_state && [ "$S_BOOT" = "$BOOT" ] && is_server "$S_PID"; then
  if [ "$S_SHA" = "$SHA" ]; then
    echo "already $S_PID"
    exit 0
  fi
  # A control-plane spawn with a new password wins: the old one would lock the user out.
  kill -TERM -- "-$S_PID" 2>/dev/null || kill -TERM "$S_PID" 2>/dev/null || true
  for _ in $(seq 1 20); do is_server "$S_PID" || break; sleep 0.5; done
  echo "password changed; restarting opencode"
fi
if ! command -v opencode >/dev/null 2>&1; then
  echo "opencode is not installed in this image" >&2
  exit 1
fi
# setsid so the server survives this exec. The password is an env var, never an argument.
setsid opencode serve --hostname 0.0.0.0 --port "$PORT" >>"$LOG" 2>&1 < /dev/null &
pid=$!
echo "$pid $BOOT $SHA" > "$STATE"
disown "$pid" 2>/dev/null || true
echo "started $pid"
`;

/**
 * Server status, boot_id guarded. First line: "alive <pid>" | "dead" | "none".
 * Then "sha <password_sha> boot <current|other>" and "act <bytes>" (serve.log size, the activity marker).
 */
export const STATUS_SH = `${PRELUDE}
if ! read_state; then echo "none"; exit 0; fi
if [ "$S_BOOT" = "$BOOT" ] && is_server "$S_PID"; then echo "alive $S_PID"; else echo "dead"; fi
if [ "$S_BOOT" = "$BOOT" ]; then b=current; else b=other; fi
echo "sha \${S_SHA:-unknown} boot $b"
a=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
echo "act $a"
`;

/**
 * Stop opencode before a snapshot. TERM the server group, wait, KILL leftovers, sync.
 * Last line: "quiesced; remaining opencode processes: N".
 */
export const QUIESCE_SH = `${PRELUDE}
ME=$(id -u)
SKIP=" 1 "
p=$$
while [ -n "$p" ] && [ "$p" -gt 1 ]; do SKIP="$SKIP$p "; p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' '); done

server_pids() {
  local q cmd
  for q in $(pgrep -u "$ME" -f 'opencode' 2>/dev/null | sort -un); do
    case "$SKIP" in *" $q "*) continue ;; esac
    cmd=$(tr '\\0' ' ' < /proc/$q/cmdline 2>/dev/null) || continue
    case "$cmd" in *opencode*) ;; *) continue ;; esac
    alive "$q" && echo "$q"
  done
}

if read_state; then
  if [ "$S_BOOT" != "$BOOT" ]; then
    echo "state file is from another boot; not signalling pid $S_PID"
  elif is_server "$S_PID"; then
    echo "stopping opencode pid $S_PID"
    kill -TERM -- "-$S_PID" 2>/dev/null || kill -TERM "$S_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do is_server "$S_PID" || break; sleep 0.5; done
  fi
fi

left=$(server_pids)
if [ -n "$left" ]; then
  echo "stopping opencode processes: $(echo "$left" | tr '\\n' ' ')"
  # shellcheck disable=SC2086
  kill -TERM $left 2>/dev/null || true
  for _ in $(seq 1 10); do [ -n "$(server_pids)" ] || break; sleep 0.5; done
  left=$(server_pids)
  # shellcheck disable=SC2086
  if [ -n "$left" ]; then kill -KILL $left 2>/dev/null || true; sleep 0.5; fi
fi
sync
echo "quiesced; remaining opencode processes: $(server_pids | grep -c . || true)"
`;

/**
 * Clone or fetch the repo into DIRECTORY when no snapshot already has it.
 * Env: DIRECTORY, REPO_URL, BRANCH (optional), REDACT_SECRETS (optional).
 * Prints "cloned", "fetched" or "present".
 */
export const PREPARE_SH = `${PRELUDE}
[ -n "\${GIT_NAME:-}" ] && git config --global user.name "$GIT_NAME"
[ -n "\${GIT_EMAIL:-}" ] && git config --global user.email "$GIT_EMAIL"
DIR=\${DIRECTORY:-/home/user/project}
URL=\${REPO_URL:-}
BRANCH=\${BRANCH:-}
mkdir -p "$(dirname "$DIR")"
if [ -d "$DIR/.git" ]; then
  if [ -n "$URL" ]; then
    git -C "$DIR" remote set-url origin "$URL" 2>/dev/null || git -C "$DIR" remote add origin "$URL"
    git -C "$DIR" fetch --prune origin >>"$D/prepare.log" 2>&1 || true
    echo "fetched"
  else
    echo "present"
  fi
  exit 0
fi
if [ -z "$URL" ]; then
  mkdir -p "$DIR"
  echo "present"
  exit 0
fi
rm -rf "$DIR"
how="cloned"
if [ -n "$BRANCH" ]; then
  git clone --branch "$BRANCH" --single-branch "$URL" "$DIR" >>"$D/prepare.log" 2>&1
  rc=$?
  # A local branch that is not pushed yet. Start it here from the default branch.
  if [ "$rc" -ne 0 ] && tail -n 3 "$D/prepare.log" | grep -q "Remote branch .* not found"; then
    rm -rf "$DIR"
    git clone "$URL" "$DIR" >>"$D/prepare.log" 2>&1 && git -C "$DIR" checkout -q -b "$BRANCH" >>"$D/prepare.log" 2>&1
    rc=$?
    how="cloned the default branch; $BRANCH is not on the remote, so it starts here (push it to bring your commits)"
  fi
else
  git clone "$URL" "$DIR" >>"$D/prepare.log" 2>&1
  rc=$?
fi
if [ "$rc" -ne 0 ]; then
  redact "git clone exited $rc: $(grep -v '^ *$' "$D/prepare.log" | tail -n 1)" >&2
  exit 1
fi
echo "$how"
`;

/**
 * Trust the CA the platform signs intercepted HTTPS with (the Worker adds credentials on egress). Runs as root
 * after interception is installed: the CA appears then, after the entrypoint already ran at boot. Waits up to
 * 5 s for the file. Prints "trusted" or "no egress CA"; exits 1 when the store still lacks it.
 */
export const TRUST_CA_SH = `
ca=/etc/cloudflare/certs/cloudflare-containers-ca.crt
dst=/usr/local/share/ca-certificates/cloudflare-containers-ca.crt
for _ in $(seq 1 20); do [ -r "$ca" ] && break; sleep 0.25; done
if [ ! -r "$ca" ]; then echo "no egress CA"; exit 0; fi
line=$(sed -n 2p "$ca")
# The entrypoint may still be running update-ca-certificates from boot; retry rather than race it.
for _ in 1 2 3 4 5; do
  if cmp -s "$ca" "$dst" && grep -qF "$line" /etc/ssl/certs/ca-certificates.crt; then echo trusted; exit 0; fi
  cp "$ca" "$dst" && update-ca-certificates >/dev/null 2>&1
  sleep 1
done
echo "egress CA is not in the system store"
exit 1
`;

/** Redacted tail of serve.log. Env: LINES (default 50, max 1000). */
export const LOGTAIL_SH = `${PRELUDE}
N=\${LINES:-50}
case "$N" in ''|*[!0-9]*) N=50 ;; esac
if [ "$N" -gt 1000 ]; then N=1000; fi
if [ -f "$LOG" ]; then redact "$(tail -n "$N" "$LOG")"; else echo "(no serve log yet)"; fi
`;

/**
 * Prepare sshd for one `sshd -i` connection. Runs as root. Env: AUTHORIZED_KEY (one public key line).
 * Host keys are made once and live on the disk, so a restored workspace keeps its host key.
 * Prints "ready".
 */
export const SSH_PREP_SH = `
set -eu
mkdir -p /run/sshd
chmod 755 /run/sshd
ls /etc/ssh/ssh_host_*_key >/dev/null 2>&1 || ssh-keygen -A >/dev/null
K=/home/user/.ssh/authorized_keys
install -d -m 700 -o 1000 -g 1000 /home/user/.ssh
touch "$K"
if [ -n "\${AUTHORIZED_KEY:-}" ] && ! grep -qxF "$AUTHORIZED_KEY" "$K"; then
  printf '%s\\n' "$AUTHORIZED_KEY" >> "$K"
fi
chown 1000:1000 "$K"
chmod 600 "$K"
echo ready
`;

/**
 * Newest tmux window activity (output in any pane), as epoch seconds; 0 when no tmux server runs.
 * Runs as the workspace user, whose tmux socket this is.
 */
/**
 * What is going on in the workspace, for the idle pause. Env: PORT, OPENCODE_SERVER_PASSWORD (optional).
 *   pty <epoch>   last output on any terminal: tmux and herdr panes, ssh sessions, OpenCode's own PTYs.
 *                 The kernel stamps a pty's mtime on write (8 s granularity).
 *   agent <state> busy: an OpenCode session is running. waiting: every running session waits on a
 *                 permission or a question, which is a person's turn, not work. idle. unknown: no password,
 *                 or opencode did not answer.
 */
export const ACTIVITY_SH = `
exec python3 - <<'PY'
import base64, glob, json, os, urllib.request
pty = 0
for p in glob.glob("/dev/pts/[0-9]*"):
    try:
        pty = max(pty, int(os.stat(p).st_mtime))
    except OSError:
        pass
print("pty %d" % pty)
state = "unknown"
pw = os.environ.get("OPENCODE_SERVER_PASSWORD")
if pw:
    base = "http://127.0.0.1:%s" % os.environ.get("PORT", "4096")
    auth = "Basic " + base64.b64encode(("opencode:" + pw).encode()).decode()
    def get(path):
        req = urllib.request.Request(base + path, headers={"authorization": auth})
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.load(r)
    try:
        active = list(get("/api/session/active").get("data", {}))
        waiting = 0
        for sid in active:
            if get("/api/session/%s/permission" % sid).get("data") or get("/api/session/%s/form" % sid).get("data"):
                waiting += 1
        state = "idle" if not active else ("waiting" if waiting == len(active) else "busy")
    except Exception:
        state = "unknown"
print("agent %s" % state)
PY
`;

/**
 * Print OpenCode's root sessions, newest first, as a JSON array. Env: PORT, LIMIT,
 * OPENCODE_SERVER_PASSWORD. Python, so the password stays out of argv.
 */
export const SESSIONS_SH = `
exec python3 - <<'PY'
import base64, json, os, urllib.request
url = "http://127.0.0.1:%s/api/session?limit=%s&parentID=null" % (os.environ.get("PORT", "4096"), os.environ.get("LIMIT", "50"))
req = urllib.request.Request(url)
auth = base64.b64encode(("opencode:" + os.environ["OPENCODE_SERVER_PASSWORD"]).encode()).decode()
req.add_header("authorization", "Basic " + auth)
with urllib.request.urlopen(req, timeout=8) as r:
    print(json.dumps(json.load(r).get("data", [])))
PY
`;

/**
 * Exit 0 when opencode serve answers /api/info with this password. Env: PORT,
 * OPENCODE_SERVER_PASSWORD. Python, so the password stays out of argv.
 */
export const HEALTH_SH = `
exec python3 - <<'PY'
import base64, os, urllib.request
req = urllib.request.Request("http://127.0.0.1:%s/api/info" % os.environ.get("PORT", "4096"))
auth = base64.b64encode(("opencode:" + os.environ["OPENCODE_SERVER_PASSWORD"]).encode()).decode()
req.add_header("authorization", "Basic " + auth)
urllib.request.urlopen(req, timeout=3).read()
PY
`;
