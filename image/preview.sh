#!/bin/bash
# Print how the user opens a dev server that runs in this workspace:
#   cf-opencode-preview <port>
# The URL is on the cf-opencode Worker, behind the workspace password; it is not public. The user opens it with
# `cf-opencode preview <workspace> <port>` on their machine, which signs the browser in. This script also checks
# that something listens on the port, and on 0.0.0.0: the Worker reaches the container's network interface, not
# its loopback, so a server bound to 127.0.0.1 only does not answer.
set -euo pipefail
port="${1:-}"
case "$port" in -h|--help) echo "usage: cf-opencode-preview <port>"; exit 0 ;; esac
case "$port" in
  ''|*[!0-9]*) echo "Failed: no port — fix: cf-opencode-preview 3000" >&2; exit 2 ;;
esac
if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ] || [ "$port" = 4096 ]; then
  echo "Failed: port $port cannot be previewed — fix: use the dev server's port, 1024-65535, not 4096 (OpenCode)" >&2
  exit 2
fi
url_base="${CF_OPENCODE_URL:-}"
if [ -z "$url_base" ] && [ -r "${HOME}/.cf-opencode-url" ]; then url_base=$(cat "${HOME}/.cf-opencode-url"); fi
workspace="${CF_OPENCODE_WORKSPACE:-}"
if [ -z "$workspace" ] && [ -r "${HOME}/.cf-opencode-workspace" ]; then workspace=$(cat "${HOME}/.cf-opencode-workspace"); fi
if [ -z "$url_base" ] || [ -z "$workspace" ]; then
  echo "Failed: Worker URL or workspace id unknown — fix: reconnect with cf-opencode connect" >&2
  exit 1
fi
# Listening sockets from /proc, so no extra package is needed. "all": bound to 0.0.0.0 or ::. "local": loopback only.
bound=$(PORT="$port" python3 - <<'PY'
import os
port = int(os.environ["PORT"])
seen = set()
for name in ("/proc/net/tcp", "/proc/net/tcp6"):
    try:
        lines = open(name).read().splitlines()[1:]
    except OSError:
        continue
    for line in lines:
        f = line.split()
        if len(f) < 4 or f[3] != "0A":
            continue
        addr, hexport = f[1].rsplit(":", 1)
        if int(hexport, 16) != port:
            continue
        seen.add("all" if set(addr) == {"0"} else "local")
print("all" if "all" in seen else ("local" if seen else "none"))
PY
)
echo "${url_base%/}/preview/${workspace}/${port}/"
echo "The user opens it on their machine with: cf-opencode preview ${workspace} ${port}" >&2
echo "Your remote browser opens it as http://p${port}.preview.internal/ (cf-opencode-browse --preview ${port}," >&2
echo "or cf-opencode-fetch http://p${port}.preview.internal/). Nothing here is public." >&2
case "$bound" in
  local)
    echo "Failed: port ${port} listens on 127.0.0.1 only, so the preview cannot reach it — fix: start the dev server with --host 0.0.0.0" >&2
    exit 1 ;;
  none)
    echo "Failed: nothing listens on port ${port} — fix: start the dev server on 0.0.0.0:${port}, then run this again" >&2
    exit 1 ;;
esac
