// Scripts for handed-off tasks (`cf-opencode run` and `tasks`). They run in the workspace with
// exec(["bash", "-c", SCRIPT], { env }) and talk to opencode serve on 127.0.0.1, like SESSIONS_SH.
// Python, so the password stays in env and out of argv. Each prints one JSON document and exits 0
// when OpenCode answered with an error, so the Worker can say what went wrong.

/**
 * Start a session with a first prompt, and return without waiting for the agent. Env: PORT,
 * OPENCODE_SERVER_PASSWORD, TASK (JSON: { create: <session.create body>, prompt: <session.prompt body>,
 * context?: <session.synthetic body> }),
 * DIRECTORY (optional: the checkout, whose HEAD is the task's base).
 * Prints {"id", "title", "base"?} on success, plus "error" when the prompt was refused, or {"error"} alone
 * when the session was not made.
 */
export const TASK_START_SH = `
exec python3 - <<'PY'
import base64, json, os, subprocess, urllib.error, urllib.request
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
# HEAD before the agent starts: the commits made after it are the task's. Read before the prompt is sent.
base_sha = ""
if os.environ.get("DIRECTORY"):
    try:
        base_sha = subprocess.run(["git", "-C", os.environ["DIRECTORY"], "rev-parse", "--verify", "-q", "HEAD"],
                                  capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        base_sha = ""
try:
    s = call("/api/session", spec["create"])["data"]
except Exception as e:
    print(json.dumps({"error": "session.create: " + why(e)}))
    raise SystemExit(0)
out = {"id": s["id"], "title": s.get("title") or ""}
if len(base_sha) == 40:
    out["base"] = base_sha
prompt = spec["prompt"]
if spec.get("context"):
    # The handoff context goes in as its own message, with resume false so the agent does not start on it.
    # An OpenCode without that call still gets the context: it is put in front of the task.
    try:
        call("/api/session/%s/synthetic" % s["id"], spec["context"])
        out["context"] = "message"
    except Exception:
        prompt = dict(prompt, text=spec["context"]["text"] + "\\n\\n---\\n\\n" + prompt["text"])
        out["context"] = "inline"
try:
    # session.prompt admits the input and schedules the agent loop; it does not wait for the turn.
    call("/api/session/%s/prompt" % s["id"], prompt)
except Exception as e:
    out["error"] = "session.prompt: " + why(e)
print(json.dumps(out))
PY
`;

/**
 * Read what decides each task's state. Env: PORT, OPENCODE_SERVER_PASSWORD, IDS (session ids, space
 * separated). Prints {"active": [ids], "sessions": {id: {...}}}. A session OpenCode does not know is
 * {"found": false}; one that could not be read is {"error": "..."}, and the Worker keeps its last state.
 * "question" is the text of the first open permission request (Permission.Request) or form (Form.Info).
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
def ask_permission(p):
    if p.get("message"):
        return "Permission: %s" % p["message"]
    res = ", ".join(str(r) for r in (p.get("resources") or [])[:5])
    return "Permission: allow %s%s?" % (p.get("action") or "an action", " on " + res if res else "")
def ask_form(f):
    parts = []
    for fld in f.get("fields") or []:
        label = fld.get("title") or fld.get("description") or fld.get("key") or ""
        opts = [o.get("label") or o.get("value") for o in (fld.get("options") or [])][:8]
        parts.append(label + (" (%s)" % ", ".join(str(o) for o in opts) if opts else ""))
    return "; ".join([f.get("title") or "Question"] + [p for p in parts if p])
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
        perms = get("/api/session/%s/permission" % sid).get("data", [])
        forms = get("/api/session/%s/form" % sid).get("data", [])
        s["permissions"] = len(perms)
        s["forms"] = len(forms)
        if perms:
            s["question"] = ask_permission(perms[0])[:1000]
        elif forms:
            s["question"] = ask_form(forms[0])[:1000]
        # The newest assistant message with text. Tool-only messages have none. Long enough for a result
        # json block at its end; the Worker keeps less of it as the summary.
        for m in get("/api/session/%s/message?type=assistant&order=desc&limit=10" % sid).get("data", []):
            t = text_of(m)
            if t:
                s["last"] = t[-16000:]
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

/**
 * Facts about a task's work, read with git in the checkout, never from the agent's words. Env: DIRECTORY,
 * TASKS (JSON list of {"id", "base", "since"}: the HEAD sha and the epoch seconds when the task started),
 * GH ("1": ask gh for the branch's pull request; it goes over the network, so only when a task ends),
 * GH_TOKEN (the placeholder; the Worker adds the real token on egress).
 * Prints {"branch"?, "pullRequest"?, "tasks": {id: {"commits": [{sha, subject}], "changedFiles": [...]}}}.
 * A task with no base (started before 0.2) or a base git does not know gets no entry.
 * Commits are base..HEAD with a commit time at or after the start, so commits that a checkout of the task's
 * branch brings from origin do not count as the agent's.
 */
export const TASK_GIT_SH = `
exec python3 - <<'PY'
import json, os, subprocess
d = os.environ.get("DIRECTORY") or "/home/user/project"
MAX_COMMITS, MAX_FILES = 30, 100
def git(*args):
    try:
        r = subprocess.run(["git", "-C", d] + list(args), capture_output=True, text=True, timeout=15)
    except Exception:
        return None
    return r.stdout if r.returncode == 0 else None
out = {"tasks": {}}
if git("rev-parse", "--is-inside-work-tree") is None:
    print(json.dumps(out))
    raise SystemExit(0)
branch = (git("symbolic-ref", "--quiet", "--short", "HEAD") or "").strip()
if branch:
    out["branch"] = branch
for t in json.loads(os.environ.get("TASKS") or "[]"):
    base, since = t.get("base") or "", int(t.get("since") or 0)
    if len(base) != 40 or git("cat-file", "-e", base + "^{commit}") is None:
        continue
    commits = []
    for line in (git("log", "--format=%H %ct %s", "-n", "200", base + "..HEAD") or "").splitlines():
        parts = line.split(" ", 2)
        if len(parts) >= 2 and parts[1].isdigit() and int(parts[1]) >= since:
            commits.append({"sha": parts[0], "subject": (parts[2] if len(parts) > 2 else "")[:200]})
    # The files of the task's own commits, changes not committed yet, and new files git does not ignore.
    # Not a diff from the start commit: a checkout that first catches up with origin would add every
    # file that changed upstream.
    files = []
    for c in commits[:MAX_COMMITS]:
        files += (git("show", "--name-only", "--format=", c["sha"]) or "").splitlines()
    files += (git("diff", "--name-only", "HEAD") or "").splitlines()
    files += (git("ls-files", "--others", "--exclude-standard") or "").splitlines()
    changed = []
    for f in files:
        if f and f[:300] not in changed:
            changed.append(f[:300])
    out["tasks"][t["id"]] = {"commits": commits[:MAX_COMMITS], "changedFiles": changed[:MAX_FILES]}
if branch and os.environ.get("GH") == "1":
    try:
        r = subprocess.run(["gh", "pr", "view", branch, "--json", "url", "-q", ".url"], cwd=d,
                           capture_output=True, text=True, timeout=15)
        url = r.stdout.strip()
        if r.returncode == 0 and url.startswith("https://"):
            out["pullRequest"] = url[:500]
    except Exception:
        pass
print(json.dumps(out))
PY
`;
