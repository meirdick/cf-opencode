// Scripts for handed-off tasks (`cf-opencode run` and `tasks`). They run in the workspace with
// exec(["bash", "-c", SCRIPT], { env }) and talk to opencode serve on 127.0.0.1, like SESSIONS_SH.
// Python, so the password stays in env and out of argv. Each prints one JSON document and exits 0
// when OpenCode answered with an error, so the Worker can say what went wrong.
import { JOBS_PY } from "./jobs";

/**
 * Start a session with a first prompt, and return without waiting for the agent. Env: PORT,
 * OPENCODE_SERVER_PASSWORD, TASK (JSON: { create: <session.create body>, prompt: <session.prompt body>,
 * context?: <session.synthetic body>, auto?: true, worktree?: { parent, branch? } }),
 * DIRECTORY (optional: the checkout, whose HEAD is the task's base).
 * Prints {"id", "title", "base"?, "worktree"?, "auto"?} on success, plus "error" when the prompt was refused,
 * or {"error"} alone when the session was not made.
 *
 * auto: the session gets a permission ruleset (OpenCode 2.2 Permission.Ruleset, on POST /api/session) that
 * allows every action, followed by the deny rules of the agents, so an explicit deny still wins (OpenCode
 * takes the last rule that matches). This is what `opencode run --auto` does, but on the server: that flag
 * answers each request from its own client, and here no client stays attached. "auto": "rules" says the
 * ruleset was set. "auto": "reply" says the agents could not be read; the Worker then answers each open
 * request with "once" when it reads the task state (TASK_STATUS_SH), as `opencode run --auto` does.
 *
 * worktree: the session starts in a new git worktree, so it does not share the checkout with another task.
 * The start point is origin/<branch> after a fetch, else origin's default branch, else HEAD. The worktree is
 * made with OpenCode's own worktree API (POST /api/worktree, which `opencode run --worktree` uses), in the
 * folder "parent", then moved to the start point on a detached HEAD. When that API does not answer, it is
 * made with `git worktree add --detach`. The base is the start point.
 */
export const TASK_START_SH = `
exec python3 - <<'PY'
import base64, json, os, secrets, subprocess, urllib.error, urllib.parse, urllib.request
base = "http://127.0.0.1:%s" % os.environ.get("PORT", "4096")
auth = "Basic " + base64.b64encode(("opencode:" + os.environ["OPENCODE_SERVER_PASSWORD"]).encode()).decode()
def call(path, body):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"authorization": auth, "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)
def get(path):
    req = urllib.request.Request(base + path, headers={"authorization": auth})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)
def data(r):
    return r.get("data", r) if isinstance(r, dict) else r
def why(e):
    if isinstance(e, urllib.error.HTTPError):
        try:
            body = json.load(e)
            return "HTTP %s %s" % (e.code, body.get("message") or body.get("_tag") or "")
        except Exception:
            return "HTTP %s" % e.code
    return str(e)
def git(d, *args, timeout=10):
    try:
        r = subprocess.run(["git", "-C", d] + list(args), capture_output=True, text=True, timeout=timeout)
    except Exception:
        return None
    return r.stdout.strip() if r.returncode == 0 else None
def fail(msg):
    print(json.dumps({"error": msg}))
    raise SystemExit(0)
def at_location(d):
    return "location%5Bdirectory%5D=" + urllib.parse.quote(d, safe="")
spec = json.loads(os.environ["TASK"])
directory = os.environ.get("DIRECTORY") or ""
out = {}
# HEAD before the agent starts: the commits made after it are the task's. Read before the prompt is sent.
base_sha = (git(directory, "rev-parse", "--verify", "-q", "HEAD") or "") if directory else ""
wt = spec.get("worktree")
if wt:
    if not directory or git(directory, "rev-parse", "--is-inside-work-tree") != "true":
        fail("worktree: %s is not a git checkout" % (directory or "the workspace directory"))
    branch = wt.get("branch") or ""
    if branch:
        if git(directory, "fetch", "-q", "origin", "+refs/heads/%s:refs/remotes/origin/%s" % (branch, branch), timeout=60) is None:
            fail("worktree: branch %s is not on origin, or origin did not answer" % branch)
        start = git(directory, "rev-parse", "--verify", "-q", "refs/remotes/origin/%s^{commit}" % branch)
    else:
        git(directory, "fetch", "-q", "origin", timeout=60)
        start = git(directory, "rev-parse", "--verify", "-q", "refs/remotes/origin/HEAD^{commit}") or base_sha
    if not start or len(start) != 40:
        fail("worktree: no commit to start from")
    parent = wt.get("parent") or "/home/user/worktrees"
    path = ""
    try:
        loc = data(get("/api/location?" + at_location(directory)))
        made = data(call("/api/worktree", {"projectID": loc["project"]["id"], "directory": parent}))
        path = made["directory"]
        if git(path, "checkout", "-q", "--detach", start) is None:
            fail("worktree: git checkout %s failed in %s" % (start[:12], path))
        out["worktreeVia"] = "opencode"
    except SystemExit:
        raise
    except Exception:
        path = os.path.join(parent, "task-" + secrets.token_hex(4))
        os.makedirs(parent, exist_ok=True)
        if git(directory, "worktree", "add", "-q", "--detach", path, start, timeout=60) is None:
            fail("worktree: git worktree add failed in %s" % parent)
        out["worktreeVia"] = "git"
    spec["create"]["location"] = {"directory": path}
    out["worktree"] = path
    base_sha = start
if spec.get("auto"):
    try:
        loc = spec["create"]["location"]["directory"]
        agents = data(get("/api/agent?" + at_location(loc)))
        denies = []
        for a in agents if isinstance(agents, list) else []:
            for rule in a.get("permissions") or []:
                if rule.get("effect") == "deny" and rule not in denies:
                    denies.append({"action": rule["action"], "resource": rule["resource"], "effect": "deny"})
        spec["create"]["permissions"] = [{"action": "*", "resource": "*", "effect": "allow"}] + denies
        out["auto"] = "rules"
    except Exception:
        out["auto"] = "reply"
try:
    s = call("/api/session", spec["create"])["data"]
except Exception as e:
    print(json.dumps({"error": "session.create: " + why(e), **({"worktree": out["worktree"]} if "worktree" in out else {})}))
    raise SystemExit(0)
out = {"id": s["id"], "title": s.get("title") or "", **out}
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
 * separated), AUTO (the ids of `run --auto` tasks, space separated). Prints {"active": [ids], "sessions":
 * {id: {...}}}. A session OpenCode does not know is {"found": false}; one that could not be read is
 * {"error": "..."}, and the Worker keeps its last state.
 * "question" is the text of the first open permission request (Permission.Request) or form (Form.Info).
 * For an AUTO task, each open permission request is answered "once" (POST
 * /api/session/{id}/permission/{request}/reply), as `opencode run --auto` does, and only the ones that could
 * not be answered count. "replied" is the count answered. A form is a question for a person: it stays open.
 * "jobs" are the workspace's long jobs (jobs.ts), from cf-opencode-job.
 */
export const TASK_STATUS_SH = `
exec python3 - <<'PY'
import base64, json, os, urllib.error, urllib.request
base = "http://127.0.0.1:%s" % os.environ.get("PORT", "4096")
auth = "Basic " + base64.b64encode(("opencode:" + os.environ["OPENCODE_SERVER_PASSWORD"]).encode()).decode()
auto = set(os.environ.get("AUTO", "").split())
def get(path):
    req = urllib.request.Request(base + path, headers={"authorization": auth})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)
def reply_once(sid, rid):
    req = urllib.request.Request(base + "/api/session/%s/permission/%s/reply" % (sid, rid),
                                 data=json.dumps({"decision": "once"}).encode(), method="POST",
                                 headers={"authorization": auth, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5):
            return True
    except Exception:
        return False
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
        if sid in auto and perms:
            left = [p for p in perms if not (isinstance(p.get("id"), str) and reply_once(sid, p["id"]))]
            s["replied"] = len(perms) - len(left)
            perms = left
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
${JOBS_PY}
out["jobs"] = jobs()
print(json.dumps(out))
PY
`;

/**
 * Facts about a task's work, read with git in the checkout, never from the agent's words. Env: DIRECTORY,
 * TASKS (JSON list of {"id", "base", "since"}: the HEAD sha and the epoch seconds when the task started),
 * GH ("1": ask gh for the branch's pull request; it goes over the network, so only when a task ends),
 * GH_TOKEN (the placeholder; the Worker adds the real token on egress).
 * Prints {"branch"?, "pullRequest"?, "unpushed"?, "processes"?, "tasks": {id: {"commits": [{sha, subject}],
 * "changedFiles": [...]}}}.
 * "unpushed" is the count of commits on HEAD that no remote branch has: work that is only on this disk.
 * "processes" are the processes that run in the checkout and that nothing watches (started in the background
 * and left): a pause stops them. Not OpenCode and what it runs now, not a terminal (tmux, sshd) and what runs
 * in one, not a long job (cf-opencode-job marks its processes with CF_OPENCODE_JOB). Only the program name and
 * its first plain argument are kept, since a command line can hold a secret.
 * A task with no base (started before 0.2) or a base git does not know gets no entry.
 * Commits are base..HEAD with a commit time at or after the start, and not on a remote branch other than the
 * task's own. So what a checkout, a merge or a new branch brings from origin does not count as the agent's,
 * also when others made it after the task started (a long task, or one that got a reply days later).
 */
export const TASK_GIT_SH = `
exec python3 - <<'PY'
import json, os, re, subprocess
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
if (git("remote") or "").strip():
    n = (git("rev-list", "--count", "HEAD", "--not", "--remotes") or "").strip()
    if n.isdigit():
        out["unpushed"] = int(n)
def stat(pid):
    # (ppid, comm) from /proc/<pid>/stat. comm is in brackets and can hold spaces.
    try:
        with open("/proc/%s/stat" % pid) as f:
            s = f.read()
        return int(s[s.rindex(")") + 2:].split()[1]), s[s.index("(") + 1:s.rindex(")")]
    except Exception:
        return None
def left_running():
    root = os.path.realpath(d)
    procs = {}
    for x in os.listdir("/proc"):
        if x.isdigit():
            st = stat(x)
            if st:
                procs[int(x)] = st
    def chain(pid):
        seen = []
        while pid in procs and pid not in seen:
            seen.append(pid)
            pid = procs[pid][0]
        return seen
    mine = set(chain(os.getpid()))
    # OpenCode and what it runs now (language servers, a tool call), and terminals and what runs in them.
    kept = ("opencode", "tmux", "sshd", "herdr")
    found = []
    for pid in sorted(procs):
        if pid in mine or any(procs[a][1].startswith(kept) for a in chain(pid)):
            continue
        try:
            cwd = os.readlink("/proc/%d/cwd" % pid)
            with open("/proc/%d/cmdline" % pid, "rb") as f:
                argv = [a.decode("utf-8", "replace") for a in f.read().split(b"\\0") if a]
        except Exception:
            continue
        if not argv or not (cwd == root or cwd.startswith(root + "/")):
            continue
        # A long job: it is watched, and the record lists it as a job.
        try:
            with open("/proc/%d/environ" % pid, "rb") as f:
                if b"\\0CF_OPENCODE_JOB=" in b"\\0" + f.read():
                    continue
        except Exception:
            pass
        # A child of a process already listed is the same job.
        if any(a in listed for a in chain(pid)[1:]):
            listed.add(pid)
            continue
        listed.add(pid)
        # A plain word or a file name only: not an option, not inline code, not key=value.
        arg = next((a for a in argv[1:3] if re.match(r"^[\\w./@+-]{1,60}$", a) and not a.startswith("-")), "")
        found.append((os.path.basename(argv[0]) + (" " + os.path.basename(arg) if arg else ""))[:60])
    return found[:5]
listed = set()
try:
    out["processes"] = left_running()
except Exception:
    pass
# Remote branches other than this branch's own: a commit one of them has came from origin.
own = set()
if branch:
    up = (git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}") or "").strip()
    for remote in (git("remote") or "").split():
        own.add(remote + "/" + branch)
    if up:
        own.add(up)
theirs = ["--not"] + ["--exclude=" + r for r in sorted(own)] + ["--remotes"] if (git("remote") or "").strip() else []
for t in json.loads(os.environ.get("TASKS") or "[]"):
    base, since = t.get("base") or "", int(t.get("since") or 0)
    if len(base) != 40 or git("cat-file", "-e", base + "^{commit}") is None:
        continue
    commits = []
    for line in (git("log", "--format=%H %ct %s", "-n", "200", base + "..HEAD", *theirs) or "").splitlines():
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
