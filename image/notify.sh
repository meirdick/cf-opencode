#!/bin/bash
# Tell the user something from this workspace: cf-opencode-notify "<text>"
# The request goes to the cf-opencode Worker, which signs it and POSTs it to the install's notify URL
# (a chat webhook, a push service). No key exists in the workspace. With no notify URL set, it fails.
set -euo pipefail
case "${1:-}" in
  -h|--help) echo 'usage: cf-opencode-notify "<text>"'; exit 0 ;;
esac
text="$*"
if [ -z "$text" ]; then
  echo 'Failed: no text — fix: cf-opencode-notify "what the user must know"' >&2
  exit 2
fi
TEXT="$text" exec python3 - <<'PY'
import json, os, sys, urllib.error, urllib.request
body = json.dumps({"text": os.environ["TEXT"]}).encode()
req = urllib.request.Request(
    "http://ai.cf-opencode.internal/notify", data=body, headers={"content-type": "application/json"}
)
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        json.load(r)
except urllib.error.HTTPError as e:
    try:
        line = json.load(e).get("error") or ""
    except Exception:
        line = ""
    print(line or "Failed: the note was not sent (HTTP %d) — fix: try again" % e.code, file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print("Failed: cannot reach the cf-opencode Worker (%s) — fix: reconnect with cf-opencode connect" % e, file=sys.stderr)
    sys.exit(1)
print("sent")
PY
