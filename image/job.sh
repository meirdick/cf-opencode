#!/bin/bash
# Run a long command apart from the agent's turn, so the agent can end its turn:
#   cf-opencode-job start [--name <name>] [--max-minutes <n>] -- <command...>
#   cf-opencode-job list [--json]
#   cf-opencode-job status <id> [--json]
#   cf-opencode-job logs <id> [-f] [-n <lines>]
#   cf-opencode-job wait <id> [--timeout <seconds>]
#   cf-opencode-job stop <id>
# `start` returns at once with the job id and the log path. A running job counts as use, so the workspace
# stays awake until the job ends; maxAwakeHours still pauses it. A job ends after --max-minutes (default 120).
# When OpenCode started the job, the job is tied to that session. When the job ends, the session gets one
# message with the exit code and the end of the log, so the agent goes on. A job the agent already saw end
# (wait, status, logs -f) gets no message.
# Each job is a folder in ~/.cf-opencode/jobs: job.json (the state), log, and the marks seen and stop.
set -euo pipefail
CF_OPENCODE_JOB_SELF="$0" exec python3 - "$@" <<'PY'
import json, os, re, signal, subprocess, sys, time, urllib.error, urllib.request, base64

USAGE = """usage:
  cf-opencode-job start [--name <name>] [--max-minutes <n>] -- <command...>
  cf-opencode-job list [--json]
  cf-opencode-job status <id> [--json]
  cf-opencode-job logs <id> [-f] [-n <lines>]
  cf-opencode-job wait <id> [--timeout <seconds>]
  cf-opencode-job stop <id>"""
HOME = os.environ.get("HOME") or "/home/user"
ROOT = os.environ.get("CF_OPENCODE_JOBS_DIR") or os.path.join(HOME, ".cf-opencode", "jobs")
DEFAULT_MAX_MIN, LIMIT_MAX_MIN = 120, 24 * 60
KEEP = 50
NAME_RE = re.compile(r"^[\w.@+-][\w .@+-]{0,59}$")
ID_RE = re.compile(r"^job-[0-9a-f]{6}$")
# The session gets the message only when it does not work: then it is a new turn, not noise in this one.
POLL_S, BUSY_MAX_S, DOWN_MAX_S = 5, 12 * 3600, 10 * 60
# Tests only: shorter minutes and polls.
MINUTE = float(os.environ.get("CF_OPENCODE_JOB_TEST_MINUTE") or 60)
POLL_S = float(os.environ.get("CF_OPENCODE_JOB_TEST_POLL") or POLL_S)

def fail(cause, fix, code=2):
    print("Failed: %s — fix: %s" % (cause, fix), file=sys.stderr)
    sys.exit(code)

def boot_id():
    try:
        with open("/proc/sys/kernel/random/boot_id") as f:
            return f.read().strip()
    except OSError:
        return "unknown"

def alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True

def folder(jid):
    return os.path.join(ROOT, jid)

def read(jid):
    try:
        with open(os.path.join(folder(jid), "job.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None

def write(j):
    path = os.path.join(folder(j["id"]), "job.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(j, f)
    os.replace(tmp, path)

def mark(jid, name):
    try:
        open(os.path.join(folder(jid), name), "a").close()
    except OSError:
        pass

def marked(jid, name):
    return os.path.exists(os.path.join(folder(jid), name))

def label(argv):
    # The program name and its first plain argument: a command line can hold a secret.
    arg = next((a for a in argv[1:3] if re.match(r"^[\w./@+-]{1,60}$", a) and not a.startswith("-")), "")
    return (os.path.basename(argv[0]) + (" " + os.path.basename(arg) if arg else ""))[:60]

def view(j, boot=None):
    """The job as it is now. A job saved as running whose boot or supervisor is gone was stopped."""
    v = dict(j)
    boot = boot or boot_id()
    gone = v.get("boot") != boot or not alive(v.get("supervisor"))
    if v.get("state") == "running" and gone:
        v["state"] = "stopped"
        v["stoppedBy"] = "pause" if v.get("boot") != boot else "lost"
    if v.get("reply") == "pending" and gone:
        v["reply"] = "lost"
    v["holds"] = v["state"] == "running" or v.get("reply") == "pending"
    return v

def jobs():
    try:
        ids = [x for x in os.listdir(ROOT) if ID_RE.match(x)]
    except OSError:
        return []
    boot = boot_id()
    out = [view(j, boot) for j in (read(x) for x in ids) if j]
    out.sort(key=lambda j: j.get("started", 0), reverse=True)
    return out

def find(jid):
    if not ID_RE.match(jid or ""):
        fail("bad job id %s" % (jid or "(none)"), "cf-opencode-job list shows the ids")
    j = read(jid)
    if not j:
        fail("no job %s" % jid, "cf-opencode-job list shows the jobs")
    return view(j)

def ago(s):
    s = max(0, int(s))
    return "%d s" % s if s < 120 else ("%d min" % (s // 60) if s < 7200 else "%.1f h" % (s / 3600))

def describe(v):
    end = v.get("ended") or time.time()
    took = ago(end - v.get("started", end))
    if v["state"] == "running":
        return "running for %s" % took
    if v["state"] == "timeout":
        return "stopped at its maximum run time (%d min), exit code %s" % (v.get("maxMinutes", 0), v.get("exit"))
    if v["state"] == "stopped":
        why = {"pause": "the workspace paused or stopped", "lost": "its supervisor ended", "stop": "cf-opencode-job stop"}
        return "stopped (%s)" % why.get(v.get("stoppedBy"), "stopped")
    return "%s with exit code %s after %s" % (v["state"], v.get("exit"), took)

def tail(path, lines=40, chars=4000):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 64000))
            text = f.read().decode("utf-8", "replace")
    except OSError:
        return ""
    return "\n".join(text.splitlines()[-lines:])[-chars:]

# --- the supervisor: runs the command, ends it at the deadline, records the end, tells the session ---

def opencode(method, path, body=None):
    pw = os.environ.get("OPENCODE_SERVER_PASSWORD")
    port = "4096"
    try:
        with open(os.path.join(HOME, ".cf-opencode", "port")) as f:
            port = f.read().strip() or port
    except OSError:
        pass
    req = urllib.request.Request(
        "http://127.0.0.1:%s%s" % (port, path),
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={"authorization": "Basic " + base64.b64encode(("opencode:" + (pw or "")).encode()).decode(),
                 "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r) if method == "GET" else None

def message(j):
    head = "Automatic message from cf-opencode-job: job %s (%s) %s." % (j["id"], j["name"], describe(j))
    log = os.path.join(folder(j["id"]), "log")
    end = tail(log)
    return "\n".join([
        head,
        "Log: %s. Its last lines:" % log,
        "",
        "```",
        end or "(the log is empty)",
        "```",
        "",
        "Go on with the task: check the result, commit, push, and end your last message as the task asked.",
    ])

def tell_session(j):
    sid = j.get("session")
    if not sid:
        return "none", None
    if j["state"] == "stopped":
        return "skipped", None
    if not os.environ.get("OPENCODE_SERVER_PASSWORD"):
        return "failed", "no OpenCode password in the environment of the job"
    since, down = time.time(), None
    while True:
        if marked(j["id"], "seen"):
            return "seen", None
        try:
            active = opencode("GET", "/api/session/active").get("data") or {}
            down = None
            if sid not in active:
                opencode("POST", "/api/session/%s/prompt" % sid, {"text": message(j)})
                return "sent", None
        except urllib.error.HTTPError as e:
            return "failed", "OpenCode answered HTTP %s" % e.code
        except Exception as e:
            down = down or time.time()
            if time.time() - down > DOWN_MAX_S:
                return "failed", "OpenCode did not answer (%s)" % str(e)[:200]
        if time.time() - since > BUSY_MAX_S:
            return "failed", "the session stayed busy for 12 h"
        time.sleep(POLL_S)

def supervise(jid):
    j = read(jid)
    if not j:
        sys.exit(1)
    j["supervisor"] = os.getpid()
    write(j)
    log = open(os.path.join(folder(jid), "log"), "ab")
    env = dict(os.environ, CF_OPENCODE_JOB=jid)
    try:
        p = subprocess.Popen(j["command"], cwd=j["cwd"], stdin=subprocess.DEVNULL, stdout=log,
                             stderr=subprocess.STDOUT, start_new_session=True, env=env)
    except OSError as e:
        log.write(("cf-opencode-job: the command did not start: %s\n" % e).encode())
        log.flush()
        j.update(state="failed", exit=127, ended=time.time(), reply="none")
        write(j)
        return
    j["pid"] = p.pid
    write(j)
    def group(sig):
        try:
            os.killpg(p.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass
    def on_term(signum, frame):
        # Stopped from outside (the container stops): end the command too, and record it.
        group(signal.SIGTERM)
        j.update(state="stopped", stoppedBy="pause", ended=time.time(), reply="skipped")
        write(j)
        sys.exit(0)
    signal.signal(signal.SIGTERM, on_term)
    timed_out = False
    try:
        p.wait(timeout=max(1, j["deadline"] - time.time()))
    except subprocess.TimeoutExpired:
        timed_out = True
        group(signal.SIGTERM)
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            group(signal.SIGKILL)
            p.wait()
    # A job leaves nothing behind: what is left in its process group ends with it.
    group(signal.SIGTERM)
    rc = p.returncode
    code = 128 - rc if rc < 0 else rc
    state = "stopped" if marked(jid, "stop") else ("timeout" if timed_out else ("done" if code == 0 else "failed"))
    j.update(state=state, exit=code, ended=time.time())
    if state == "stopped":
        j["stoppedBy"] = "stop"
    j["reply"] = "pending" if j.get("session") and state != "stopped" else ("skipped" if state == "stopped" and j.get("session") else "none")
    write(j)
    reply, err = tell_session(j)
    j["reply"] = reply
    if reply == "sent":
        j["replyAt"] = time.time()
    if err:
        j["replyError"] = err
    write(j)

# --- commands ---

def start(args):
    name, max_min, want_json = None, DEFAULT_MAX_MIN, False
    while args and args[0] != "--" and args[0].startswith("-"):
        a = args.pop(0)
        if a == "--name" and args:
            name = args.pop(0)
        elif a == "--max-minutes" and args:
            v = args.pop(0)
            if not v.isdigit() or not 1 <= int(v) <= LIMIT_MAX_MIN:
                fail("--max-minutes must be 1 to %d" % LIMIT_MAX_MIN, "cf-opencode-job start --max-minutes 240 -- <command>")
            max_min = int(v)
        elif a == "--json":
            want_json = True
        else:
            fail("unknown option %s" % a, USAGE.splitlines()[1].strip())
    if args and args[0] == "--":
        args.pop(0)
    if not args:
        fail("no command", "cf-opencode-job start -- npm run build")
    if name is not None and not NAME_RE.match(name):
        fail("bad name %s" % name[:60], "letters, digits, space and . _ @ + -, up to 60 characters")
    os.makedirs(ROOT, exist_ok=True)
    while True:
        jid = "job-" + os.urandom(3).hex()
        try:
            os.mkdir(folder(jid))
            break
        except FileExistsError:
            continue
    session, tie = os.environ.get("OPENCODE_SESSION_ID") or "", "env"
    if not re.match(r"^ses[A-Za-z0-9_-]{1,100}$", session):
        session, tie = "", ""
        # OpenCode runs this inside the turn of the session that started it. One active session is that one.
        if os.environ.get("OPENCODE_SERVER_PASSWORD"):
            try:
                active = list(opencode("GET", "/api/session/active").get("data") or {})
                if len(active) == 1 and re.match(r"^ses[A-Za-z0-9_-]{1,100}$", active[0]):
                    session, tie = active[0], "active"
            except Exception:
                pass
    now = time.time()
    j = {"id": jid, "name": name or label(args), "command": args, "cwd": os.getcwd(), "started": now,
         "deadline": now + max_min * MINUTE, "maxMinutes": max_min, "boot": boot_id(), "state": "running",
         "reply": "none"}
    if session:
        j["session"], j["tie"] = session, tie
    write(j)
    open(os.path.join(folder(jid), "log"), "ab").close()
    sup = subprocess.Popen(["bash", os.environ["CF_OPENCODE_JOB_SELF"], "__supervise", jid], cwd="/",
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           start_new_session=True, env=dict(os.environ, CF_OPENCODE_JOB=jid))
    # The supervisor writes its own pid first. Until then the job does not look supervised, so wait for it.
    for _ in range(100):
        if (read(jid) or {}).get("supervisor") or sup.poll() is not None:
            break
        time.sleep(0.05)
    if not (read(jid) or {}).get("supervisor"):
        fail("the job supervisor did not start", "try again; see cf-opencode-job list", 1)
    log = os.path.join(folder(jid), "log")
    if want_json:
        print(json.dumps({"id": jid, "name": j["name"], "log": log, "session": session or None}))
    else:
        print("%s started: %s" % (jid, j["name"]))
        print("log: %s" % log)
    if session:
        print("You can end your turn now. This session gets a message when the job ends.", file=sys.stderr)
    else:
        print("No OpenCode session is tied to this job, so no message comes when it ends. Check it: cf-opencode-job status %s" % jid, file=sys.stderr)
    prune()

def prune():
    # Keep the newest jobs that ended. A running job is never removed.
    ended = [j for j in jobs() if not j["holds"]]
    for j in ended[KEEP:]:
        d = folder(j["id"])
        for f in ("job.json", "log", "seen", "stop", "job.json.tmp"):
            try:
                os.remove(os.path.join(d, f))
            except OSError:
                pass
        try:
            os.rmdir(d)
        except OSError:
            pass

def public(v):
    keep = ("id", "name", "state", "exit", "session", "started", "ended", "deadline", "maxMinutes", "reply",
            "replyAt", "replyError", "stoppedBy", "holds")
    out = {k: v[k] for k in keep if k in v}
    out["log"] = os.path.join(folder(v["id"]), "log")
    return out

def cmd_list(args):
    js = jobs()
    if "--json" in args:
        print(json.dumps({"jobs": [public(v) for v in js]}))
        return
    if not js:
        print("No jobs. Start one: cf-opencode-job start -- <command>")
        return
    print("%-11s  %-24s  %s" % ("ID", "NAME", "STATE"))
    for v in js:
        print("%-11s  %-24s  %s" % (v["id"], v["name"][:24], describe(v)))

def cmd_status(args):
    if not args:
        fail("status needs a job id", "cf-opencode-job status <id>")
    v = find(args[0])
    if v["state"] != "running":
        mark(v["id"], "seen")
    if "--json" in args[1:]:
        print(json.dumps(public(v)))
        return
    print("%s %s: %s" % (v["id"], v["name"], describe(v)))
    print("command: %s" % " ".join(v.get("command", [])))
    print("log: %s" % os.path.join(folder(v["id"]), "log"))
    if v.get("session"):
        print("session: %s (message: %s%s)" % (v["session"], v.get("reply", "none"),
                                               ", " + v["replyError"] if v.get("replyError") else ""))

def cmd_logs(args):
    if not args:
        fail("logs needs a job id", "cf-opencode-job logs <id> [-f]")
    v = find(args[0])
    follow = "-f" in args[1:]
    n = 100
    if "-n" in args[1:]:
        i = args.index("-n")
        if i + 1 >= len(args) or not args[i + 1].isdigit():
            fail("-n needs a number", "cf-opencode-job logs <id> -n 200")
        n = int(args[i + 1])
    path = os.path.join(folder(v["id"]), "log")
    sys.stdout.write(tail(path, n, 10 ** 9) + "\n")
    if not follow:
        if v["state"] != "running":
            mark(v["id"], "seen")
        return
    with open(path, "rb") as f:
        f.seek(0, 2)
        while True:
            chunk = f.read()
            if chunk:
                sys.stdout.write(chunk.decode("utf-8", "replace"))
                sys.stdout.flush()
                continue
            v = find(v["id"])
            if v["state"] != "running":
                rest = f.read()
                if rest:
                    sys.stdout.write(rest.decode("utf-8", "replace"))
                mark(v["id"], "seen")
                print("%s %s: %s" % (v["id"], v["name"], describe(v)), file=sys.stderr)
                return
            time.sleep(1)

def cmd_wait(args):
    if not args:
        fail("wait needs a job id", "cf-opencode-job wait <id> [--timeout <seconds>]")
    jid, limit = args[0], 300
    if "--timeout" in args[1:]:
        i = args.index("--timeout")
        if i + 1 >= len(args) or not args[i + 1].isdigit():
            fail("--timeout needs seconds", "cf-opencode-job wait <id> --timeout 600")
        limit = int(args[i + 1])
    until = time.time() + limit
    while True:
        v = find(jid)
        if v["state"] != "running":
            mark(jid, "seen")
            print("%s %s: %s" % (v["id"], v["name"], describe(v)))
            print("log: %s" % os.path.join(folder(jid), "log"))
            code = v.get("exit")
            sys.exit(code if isinstance(code, int) and 0 <= code < 256 else 1)
        if time.time() >= until:
            fail("job %s still runs after %d s" % (jid, limit),
                 "wait again, or end your turn: the session gets a message when the job ends", 124)
        time.sleep(1)

def cmd_stop(args):
    if not args:
        fail("stop needs a job id", "cf-opencode-job stop <id>")
    v = find(args[0])
    if v["state"] != "running":
        print("%s %s: %s" % (v["id"], v["name"], describe(v)))
        return
    mark(v["id"], "stop")
    pid = v.get("pid")
    if isinstance(pid, int) and pid > 0:
        for sig, wait in ((signal.SIGTERM, 10), (signal.SIGKILL, 5)):
            try:
                os.killpg(pid, sig)
            except (ProcessLookupError, PermissionError):
                break
            end = time.time() + wait
            while time.time() < end and find(v["id"])["state"] == "running":
                time.sleep(0.5)
            if find(v["id"])["state"] != "running":
                break
    v = find(v["id"])
    print("%s %s: %s" % (v["id"], v["name"], describe(v)))

def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help", "help"):
        print(USAGE)
        return
    cmd, rest = args[0], args[1:]
    if cmd == "__supervise":
        supervise(rest[0])
        return
    handlers = {"start": start, "list": cmd_list, "status": cmd_status, "logs": cmd_logs, "wait": cmd_wait,
                "stop": cmd_stop}
    if cmd not in handlers:
        fail("unknown command %s" % cmd, "cf-opencode-job --help")
    handlers[cmd](rest)

main()
PY
