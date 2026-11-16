#!/usr/bin/env python3
"""bee's one tool: a Python session that outlives the harness.

    kernel.py STEM    serve STEM.sock, read STEM.jsonl, write output to STEM.out, save variables in STEM.pkl
"""
import ast, json, linecache, os, pickle, signal, socket, sys, traceback, types

STEM = sys.argv[1]
SHOWN = 20_000  # characters of output the model sees per call
IDLE = 24 * 3600  # seconds without a call before the session ends


class Bee:
    """The harness, seen from inside the session."""

    file = STEM + ".jsonl"
    out = ""

    def append(self, text=None, parent=None, **settings):
        ids = [json.loads(line)["id"] for line in open(self.file)]
        if parent not in (None, *ids):
            raise ValueError(f"no line {parent!r} in {self.file}")
        self.lines.append({"text": text, "parent": parent, **settings})


def run(code, name):
    tree = compile(code, name, "exec", ast.PyCF_ONLY_AST)
    last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
    exec(compile(tree, name, "exec"), scope)
    if last and (value := eval(compile(ast.Expression(last.value), name, "eval"), scope)) is not None:
        print(repr(value))


def call(code, name):
    """Run code; return what it wrote, and whether it raised."""
    linecache.cache[name] = len(code), None, code.splitlines(True), name
    start, failed = os.path.getsize(STEM + ".out"), False
    signal.signal(signal.SIGINT, signal.default_int_handler)
    try:
        run(code, name)
    except BaseException as e:
        failed, tb = True, e.__traceback__
        while tb and tb.tb_frame.f_code.co_filename == __file__:
            tb = tb.tb_next
        traceback.print_exception(type(e), e, tb)
    finally:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    sys.stdout.flush(), sys.stderr.flush()
    with open(STEM + ".out", errors="replace") as f:
        f.seek(start)
        return f.read(), failed


def save():
    """Keep what can be kept, for the day this process dies."""
    names = [name for name in scope if not name.startswith("__") and name != "bee"]
    kept = {}
    for name in names:
        try:
            kept[name] = pickle.dumps(scope[name])
        except Exception:
            pass  # a module, a function, or something live: an open file, a thread, a process
    with open(STEM + ".tmp", "wb") as f:
        pickle.dump((kept, names), f)
    os.replace(STEM + ".tmp", STEM + ".pkl")


def restore():
    """After a restart: definitions again from the log, data from the last save. Returns the names there were."""
    definitions = ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef
    for line in open(bee.file):
        message = json.loads(line).get("message", {})
        for block in message["content"] if message.get("role") == "assistant" else []:
            try:
                for node in ast.parse(block["arguments"]["code"]).body if block["type"] == "toolCall" else []:
                    if isinstance(node, definitions):
                        exec(compile(ast.Module([node], []), "<restored>", "exec"), scope)
            except Exception:
                pass
    kept, names = pickle.load(open(STEM + ".pkl", "rb"))
    for name, data in kept.items():
        try:
            scope[name] = pickle.loads(data)
        except Exception:
            pass
    return names


# Everything the session writes, children included, goes to one file.
log = os.open(STEM + ".out", os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
os.dup2(log, 1), os.dup2(log, 2)
sys.stdout.reconfigure(line_buffering=True)

server = socket.socket(socket.AF_UNIX)
if os.path.exists(STEM + ".sock"):
    os.unlink(STEM + ".sock")
server.bind(STEM + ".sock")
server.listen()
if os.fork():
    os._exit(0)  # the launcher returns once the socket is ready
os.setsid()
signal.signal(signal.SIGINT, signal.SIG_IGN)

# The session's code is the main module, as in a REPL. (`kernel` keeps this script's own module alive.)
kernel, main = sys.modules["__main__"], types.ModuleType("__main__")
sys.modules["__main__"] = main
sys.path[0] = ""  # imports look in the working directory, not next to this script
scope, bee = main.__dict__, Bee()
scope["bee"] = bee
note = ""
if os.path.exists(STEM + ".pkl"):  # this session has run code before, in a process that is gone
    lost = ", ".join(name for name in restore() if name not in scope)
    back = ", ".join(name for name in scope if not name.startswith("__") and name != "bee")
    note = f"[The Python session restarted. Restored: {back or 'nothing'}. Lost: {lost or 'nothing'}.]\n"

server.settimeout(IDLE)
try:
    for n in range(sys.maxsize):
        connection, _ = server.accept()
        try:
            with connection, connection.makefile("rw") as peer:
                print(json.dumps({"pid": os.getpid()}), file=peer, flush=True)
                request = json.loads(peer.readline())
                vars(bee).update(request["bee"], lines=[])
                bee.out, failed = call(request["code"], f"<call {n}>")
                save()
                shown, cut = bee.out, len(bee.out) - SHOWN
                if cut > 0:
                    half = SHOWN // 2
                    shown = f"{shown[:half]}\n[{cut} characters cut; all of it is in bee.out]\n{shown[-half:]}"
                print(json.dumps({"output": note + shown, "failed": failed, "lines": bee.lines}), file=peer, flush=True)
                note = ""
        except (OSError, ValueError):
            pass  # the harness went away mid-call
except TimeoutError:
    pass
finally:
    os.unlink(STEM + ".sock")
