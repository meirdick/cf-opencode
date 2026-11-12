// Scripts for handed-off tasks (`cf-opencode run` and `tasks`). They run in the workspace with
// exec(["bash", "-c", SCRIPT], { env }) and talk to opencode serve on 127.0.0.1, like SESSIONS_SH.
// Python, so the password stays in env and out of argv. Each prints one JSON document and exits 0
// when OpenCode answered with an error, so the Worker can say what went wrong.

/**
 * Start a session with a first prompt, and return without waiting for the agent. Env: PORT,
 * OPENCODE_SERVER_PASSWORD, TASK (JSON: { create: <session.create body>, prompt: <session.prompt body> }).
 * Prints {"id", "title"} on success, plus "error" when the prompt was refused, or {"error"} alone when
 * the session was not made.
 */
export const TASK_START_SH = `
exec python3 - <<'PY'
import base64, json, os, urllib.error, urllib.request
base = "http://127.0.0.1:%s" % os.environ.get("PORT", "4096")
auth = "Basic " + base64.b64encode(("opencode:" + os.environ["OPENCODE_SERVER_PASSWORD"]).encode()).decode()
def call(path, body):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"authorization": auth, "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)
def why(e):
    if isinstance(e, urllib.error.HTTPError):
        try:
            body = json.load(e)
            return "HTTP %s %s" % (e.code, body.get("message") or body.get("_tag") or "")
        except Exception:
            return "HTTP %s" % e.code
    return str(e)
spec = json.loads(os.environ["TASK"])
try:
    s = call("/api/session", spec["create"])["data"]
except Exception as e:
    print(json.dumps({"error": "session.create: " + why(e)}))
    raise SystemExit(0)
out = {"id": s["id"], "title": s.get("title") or ""}
try:
    # session.prompt admits the input and schedules the agent loop; it does not wait for the turn.
    call("/api/session/%s/prompt" % s["id"], spec["prompt"])
except Exception as e:
    out["error"] = "session.prompt: " + why(e)
print(json.dumps(out))
PY
`;

/**
 * Read what decides each task's state. Env: PORT, OPENCODE_SERVER_PASSWORD, IDS (session ids, space
 * separated). Prints {"active": [ids], "sessions": {id: {...}}}. A session OpenCode does not know is
 * {"found": false}; one that could not be read is {"error": "..."}, and the Worker keeps its last state.
 */
export const TASK_STATUS_SH = `
exec python3 - <<'PY'
import base64, json, os, urllib.error, urllib.request
base = "http://127.0.0.1:%s" % os.environ.get("PORT", "4096")
auth = "Basic " + base64.b64encode(("opencode:" + os.environ["OPENCODE_SERVER_PASSWORD"]).encode()).decode()
def get(path):
    req = urllib.request.Request(base + path, headers={"authorization": auth})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)
def text_of(m):
    return "".join(c.get("text", "") for c in m.get("content", []) if c.get("type") == "text").strip()
active = list(get("/api/session/active").get("data", {}))
out = {"active": active, "sessions": {}}
for sid in os.environ.get("IDS", "").split():
    try:
        info = get("/api/session/%s" % sid).get("data", {})
    except urllib.error.HTTPError as e:
        out["sessions"][sid] = {"found": False} if e.code == 404 else {"error": "HTTP %s" % e.code}
        continue
    except Exception as e:
        out["sessions"][sid] = {"error": str(e)[:200]}
        continue
    s = {"found": True, "title": info.get("title") or "", "outcome": info.get("outcome"), "time": info.get("time", {})}
    try:
        s["permissions"] = len(get("/api/session/%s/permission" % sid).get("data", []))
        s["forms"] = len(get("/api/session/%s/form" % sid).get("data", []))
        # The newest assistant message with text. Tool-only messages have none.
        for m in get("/api/session/%s/message?type=assistant&order=desc&limit=10" % sid).get("data", []):
            t = text_of(m)
            if t:
                s["last"] = t[-4000:]
                break
        if s["outcome"] in ("failed", "interrupted"):
            idle = get("/api/session/%s/message?type=idle&order=desc&limit=1" % sid).get("data", [])
            if idle and isinstance(idle[0].get("error"), dict):
                s["reason"] = str(idle[0]["error"].get("message", ""))[:300]
    except Exception as e:
        out["sessions"][sid] = {"error": str(e)[:200]}
        continue
    out["sessions"][sid] = s
print(json.dumps(out))
PY
`;
