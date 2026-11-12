#!/bin/bash
# Search the web from this workspace: cf-opencode-search [-n 1..10] [--provider name] [--json] <query>
# The request goes to the cf-opencode Worker, which runs it with Cloudflare's Web Search API
# through the account's AI Gateway. No key exists in the workspace. Searches bill to the
# account's AI Gateway credits.
set -euo pipefail
limit=5
json=0
provider=""
while [ $# -gt 0 ]; do
  case "$1" in
    -n) limit="${2:-}"; shift 2 ;;
    --json) json=1; shift ;;
    --provider) provider="${2:-}"; shift 2 ;;
    -h|--help) echo "usage: cf-opencode-search [-n 1..10] [--provider exa|linkup|ceramic] [--json] <query>"; exit 0 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
query="$*"
if [ -z "$query" ]; then
  echo "Failed: no query — fix: cf-opencode-search \"what to search for\"" >&2
  exit 2
fi
case "$limit" in ''|*[!0-9]*) echo "Failed: -n needs a number from 1 to 10 — fix: cf-opencode-search -n 5 \"query\"" >&2; exit 2 ;; esac
QUERY="$query" LIMIT="$limit" JSON="$json" PROVIDER="$provider" exec python3 - <<'PY'
import json, os, sys, urllib.error, urllib.request
payload = {"query": os.environ["QUERY"], "limit": int(os.environ["LIMIT"])}
if os.environ.get("PROVIDER"):
    payload["provider"] = os.environ["PROVIDER"]
body = json.dumps(payload).encode()
req = urllib.request.Request(
    "http://ai.cf-opencode.internal/search", data=body, headers={"content-type": "application/json"}
)
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read().decode()
except urllib.error.HTTPError as e:
    try:
        message = json.load(e).get("error", {}).get("message", "")
    except Exception:
        message = ""
    fix = "add AI Gateway credits in the Cloudflare dashboard" if e.code == 402 else "try again; then cf-opencode doctor on your machine"
    print("Failed: %s — fix: %s" % (message or ("search returned %d" % e.code), fix), file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print("Failed: cannot reach the search service (%s) — fix: reconnect with cf-opencode connect" % e, file=sys.stderr)
    sys.exit(1)
if os.environ.get("JSON") == "1":
    print(raw)
    sys.exit(0)
data = json.loads(raw)
items = []
if isinstance(data, dict):
    for key in ("items", "results", "data"):
        if isinstance(data.get(key), list):
            items = data[key]
            break
elif isinstance(data, list):
    items = data
items = [i for i in items if isinstance(i, dict) and i.get("url")]
print('%d results for "%s":' % (len(items), os.environ["QUERY"]))
for n, i in enumerate(items, 1):
    text = " ".join(str(i.get("description") or i.get("snippet") or i.get("content") or "").split())
    if len(text) > 400:
        text = text[:400].rsplit(" ", 1)[0] + "…"
    print("\n%d. %s\n%s" % (n, i.get("title") or i["url"], i["url"]))
    if text:
        print(text)
PY
