#!/bin/bash
# Open a browser session for this workspace and print its CDP websocket URL.
# The URL is on the cf-opencode Worker, which relays to its Browser Run binding; no
# token exists. Connect a CDP client with the header
#   Authorization: Basic base64("opencode:$OPENCODE_SERVER_PASSWORD")
# OPENCODE_SERVER_PASSWORD is in the environment of every tool opencode runs.
set -euo pipefail
url_base="${CF_OPENCODE_URL:-}"
if [ -z "$url_base" ] && [ -r "${HOME}/.cf-opencode-url" ]; then url_base=$(cat "${HOME}/.cf-opencode-url"); fi
workspace="${CF_OPENCODE_WORKSPACE:-}"
if [ -z "$workspace" ] && [ -r "${HOME}/.cf-opencode-workspace" ]; then workspace=$(cat "${HOME}/.cf-opencode-workspace"); fi
if [ -z "$url_base" ] || [ -z "$workspace" ]; then
  echo "Failed: Worker URL or workspace id unknown — fix: reconnect with cf-opencode connect" >&2
  exit 1
fi
if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
  echo "Failed: no workspace password in this environment — fix: run this from an opencode tool, or export OPENCODE_SERVER_PASSWORD" >&2
  exit 1
fi
out=$(mktemp)
trap 'rm -f "$out"' EXIT
# The password goes to curl on stdin as a config line, not as an argument.
code=$(printf 'user = "opencode:%s"\n' "$OPENCODE_SERVER_PASSWORD" | curl -sS -m 30 -K - -o "$out" -w '%{http_code}' \
  -X POST -H 'content-type: application/json' -d '{"keepAliveMs":600000}' "${url_base%/}/browse/${workspace}") || {
  echo "Failed: browse request failed — fix: check the Worker URL in ~/.cf-opencode-url" >&2
  exit 1
}
if [ "$code" != "200" ]; then
  echo "Failed: browse returned ${code}: $(head -c 300 "$out") — fix: see the error" >&2
  exit 1
fi
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["websocketUrl"])
live=d.get("liveUrl")
live and print("live: "+live, file=sys.stderr)' "$out"
echo "connect with header Authorization: Basic base64(opencode:\$OPENCODE_SERVER_PASSWORD); billed per browser hour; closes after 10 min idle" >&2
