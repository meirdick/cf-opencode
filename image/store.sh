#!/bin/bash
# The install's store, an R2 bucket that outlives this workspace. Off unless the user set `store` to true.
#   cf-opencode-store put <file> [name]   save a file as <this workspace>/<name> (at most 100 MB)
#   cf-opencode-store get <name> [path]   save a stored file here (-f replaces a file; path - prints it)
#   cf-opencode-store list [prefix]       list the stored files
#   cf-opencode-store rm <name>           remove a file that this workspace saved
# The requests go to the cf-opencode Worker, which holds the bucket. No key exists in the workspace.
set -euo pipefail
usage() {
  sed -n '3,6p' "$0" | sed 's/^# *//'
}
case "${1:-}" in
  -h|--help|"") usage; exit 0 ;;
esac
exec python3 - "$@" <<'PY'
import json, os, sys, tempfile, urllib.error, urllib.parse, urllib.request

BASE = "http://ai.cf-opencode.internal/store"

def fail(cause, fix):
    print("Failed: %s — fix: %s" % (cause, fix), file=sys.stderr)
    sys.exit(1)

def call(req):
    try:
        return urllib.request.urlopen(req, timeout=600)
    except urllib.error.HTTPError as e:
        try:
            line = json.load(e).get("error") or ""
        except Exception:
            line = ""
        print(line or "Failed: the store answered HTTP %d — fix: try again" % e.code, file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        fail("cannot reach the cf-opencode Worker (%s)" % e, "reconnect with cf-opencode connect")

def quote(name):
    return urllib.parse.quote(name, safe="/")

args = sys.argv[1:]
cmd, rest = args[0], args[1:]
force = "-f" in rest
rest = [a for a in rest if a != "-f"]

if cmd == "put":
    if not rest:
        fail("put needs a file", "cf-opencode-store put <file> [name]")
    path = rest[0]
    if not os.path.isfile(path):
        fail("%s is not a file" % path, "pack a folder first: tar czf x.tgz <folder>")
    name = rest[1] if len(rest) > 1 else os.path.basename(path)
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        req = urllib.request.Request(BASE + "/object/" + quote(name), data=f, method="PUT",
                                     headers={"content-length": str(size), "content-type": "application/octet-stream"})
        out = json.load(call(req))
    print(out["key"])
elif cmd == "get":
    if not rest:
        fail("get needs a name", "cf-opencode-store list shows the names")
    name = rest[0]
    dest = rest[1] if len(rest) > 1 else os.path.basename(name)
    if dest != "-" and os.path.isdir(dest):
        dest = os.path.join(dest, os.path.basename(name))
    if dest != "-" and os.path.exists(dest) and not force:
        fail("%s exists" % dest, "pass -f to replace it, or name another path")
    res = call(urllib.request.Request(BASE + "/object/" + quote(name)))
    if dest == "-":
        while True:
            b = res.read(1 << 20)
            if not b:
                break
            sys.stdout.buffer.write(b)
        sys.exit(0)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(dest)) or ".", prefix=".cf-opencode-store-")
    try:
        with os.fdopen(fd, "wb") as f:
            while True:
                b = res.read(1 << 20)
                if not b:
                    break
                f.write(b)
        os.replace(tmp, dest)
    except BaseException:
        os.unlink(tmp)
        raise
    print(dest)
elif cmd == "list":
    q = "?prefix=" + urllib.parse.quote(rest[0]) if rest else ""
    out = json.load(call(urllib.request.Request(BASE + "/list" + q)))
    for o in out.get("objects", []):
        print("%12d  %s  %s" % (o["size"], o["uploaded"][:19].replace("T", " "), o["key"]))
    if out.get("cursor"):
        print("(more; name a prefix to narrow the list)")
elif cmd == "rm":
    if not rest:
        fail("rm needs a name", "cf-opencode-store rm <name>")
    out = json.load(call(urllib.request.Request(BASE + "/object/" + quote(rest[0]), method="DELETE")))
    print("removed " + out["removed"])
else:
    fail("unknown command %s" % cmd, "cf-opencode-store --help")
PY
