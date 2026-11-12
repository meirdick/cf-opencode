#!/bin/bash
# Read a web page from this workspace:
#   cf-opencode-fetch <url>                    the page as Markdown
#   cf-opencode-fetch --links <url>            the links on the page, one per line
#   cf-opencode-fetch --html <url>             the rendered HTML
#   cf-opencode-fetch --screenshot f.png <url> save a screenshot
#   cf-opencode-fetch --pdf f.pdf <url>        save a PDF
#   cf-opencode-fetch http://p3000.preview.internal/   this workspace's dev server on port 3000 (or
#                                              http://localhost:3000/); the browser reaches it with no public URL
# The cf-opencode Worker loads the page in a real browser (Browser Run Quick Actions), so pages that
# need JavaScript work. No token exists in the workspace. It bills to the account's Browser Run usage.
set -euo pipefail
format=markdown
out=""
max=60000
usage="usage: cf-opencode-fetch [--links|--html|--screenshot <file>|--pdf <file>] [--max-chars <n>] <url>"
while [ $# -gt 0 ]; do
  case "$1" in
    --links) format=links; shift ;;
    --html) format=html; shift ;;
    --screenshot) format=screenshot; out="${2:-}"; shift 2 ;;
    --pdf) format=pdf; out="${2:-}"; shift 2 ;;
    --max-chars) max="${2:-}"; shift 2 ;;
    -h|--help) echo "$usage"; exit 0 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
url="${1:-}"
if [ -z "$url" ]; then
  echo "Failed: no URL — fix: cf-opencode-fetch https://example.com/page" >&2
  exit 2
fi
if { [ "$format" = screenshot ] || [ "$format" = pdf ]; } && [ -z "$out" ]; then
  echo "Failed: --$format needs a file name — fix: cf-opencode-fetch --$format page.${format/screenshot/png} <url>" >&2
  exit 2
fi
case "$max" in ''|*[!0-9]*) echo "Failed: --max-chars needs a number — fix: $usage" >&2; exit 2 ;; esac
URL="$url" FORMAT="$format" OUT="$out" MAX="$max" exec python3 - <<'PY'
import json, os, sys, urllib.error, urllib.request
fmt = os.environ["FORMAT"]
body = json.dumps({"url": os.environ["URL"], "format": fmt}).encode()
req = urllib.request.Request(
    "http://ai.cf-opencode.internal/page", data=body, headers={"content-type": "application/json"}
)
try:
    with urllib.request.urlopen(req, timeout=90) as r:
        raw = r.read()
except urllib.error.HTTPError as e:
    try:
        message = json.load(e).get("error", {}).get("message", "")
    except Exception:
        message = ""
    print("Failed: %s — fix: check the URL, then try again" % (message or ("the page service returned %d" % e.code)), file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print("Failed: cannot reach the page service (%s) — fix: reconnect with cf-opencode connect" % e, file=sys.stderr)
    sys.exit(1)
if fmt in ("screenshot", "pdf"):
    with open(os.environ["OUT"], "wb") as f:
        f.write(raw)
    print("saved %s (%d bytes)" % (os.environ["OUT"], len(raw)))
    sys.exit(0)
text = raw.decode("utf-8", "replace")
if fmt == "links":
    try:
        text = "\n".join(str(x) for x in json.loads(text))
    except Exception:
        pass
limit = int(os.environ["MAX"])
if limit and len(text) > limit:
    text = text[:limit] + "\n\n[cut at %d of %d characters; --max-chars 0 prints all]" % (limit, len(text))
print(text)
PY
