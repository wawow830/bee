#!/usr/bin/env python3
"""bee's one tool: a Python session. Takes {code} lines on stdin, answers {output, failed} lines on stdout.

    kernel.py FILE    FILE is the session's JSONL file. Its variables are kept beside it.
"""
import ast, json, linecache, os, pickle, signal, sys, tempfile, traceback, types

SHOWN = 20_000  # characters of output the model sees per call
FILE = sys.argv[1]
KEPT = FILE.removesuffix(".jsonl") + ".pkl"


def run(code, name):
    tree = compile(code, name, "exec", ast.PyCF_ONLY_AST)
    last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
    exec(compile(tree, name, "exec"), scope)
    if last and (value := eval(compile(ast.Expression(last.value), name, "eval"), scope)) is not None:
        print(repr(value))


def call(code, name):
    """Run code. Returns whether it raised."""
    linecache.cache[name] = len(code), None, code.splitlines(True), name  # so tracebacks can quote it
    signal.signal(signal.SIGINT, signal.default_int_handler)
    try:
        run(code, name)
    except BaseException as e:
        tb = e.__traceback__
        while tb and tb.tb_frame.f_code.co_filename == __file__:
            tb = tb.tb_next
        traceback.print_exception(type(e), e, tb)
        return True
    finally:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    return False


def names():
    return [name for name in scope if not name.startswith("__")]


def save():
    """Keep what can be kept, for the next Python this session gets."""
    kept = {}
    for name in names():
        try:
            kept[name] = pickle.dumps(scope[name])
        except Exception:
            pass  # a module, a function, or something live: an open file, a thread, a process
    with open(KEPT + ".tmp", "wb") as f:
        pickle.dump((kept, names()), f)
    os.replace(KEPT + ".tmp", KEPT)


def restore():
    """Run the session's imports and definitions again, then load its variables. Says what came back."""
    definitions = ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef
    for line in open(FILE):
        try:
            blocks = json.loads(line)["message"]["content"]
            codes = [block["arguments"]["code"] for block in blocks if block["type"] == "toolCall"]
        except Exception:
            continue  # not a reply that ran code
        for code in codes:
            try:
                for node in ast.parse(code).body:
                    if isinstance(node, definitions):
                        exec(compile(ast.Module([node], []), "<restored>", "exec"), scope)
            except Exception:
                pass
    kept, before = pickle.load(open(KEPT, "rb"))
    for name, data in kept.items():
        try:
            scope[name] = pickle.loads(data)
        except Exception:
            pass
    lost = ", ".join(name for name in before if name not in scope) or "nothing"
    print(f"[New Python session. Restored: {', '.join(names()) or 'nothing'}. Lost: {lost}.]")


def take():
    """What the session has written since this was last asked, cut to its two ends when it is too long."""
    sys.stdout.flush()
    sys.stderr.flush()
    written.seek(0)
    output = written.read().decode(errors="replace")
    written.seek(0)
    written.truncate()
    cut = len(output) - SHOWN
    return output if cut <= 0 else f"{output[: SHOWN // 2]}\n[{cut} characters cut]\n{output[-SHOWN // 2 :]}"


# The harness keeps the pipes. The session and its children get no input, and write to one file.
requests = os.fdopen(os.dup(0))
replies = os.fdopen(os.dup(1), "w")
written = tempfile.TemporaryFile()
os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
os.dup2(written.fileno(), 1)
os.dup2(written.fileno(), 2)
sys.stdout.reconfigure(line_buffering=True)
signal.signal(signal.SIGINT, signal.SIG_IGN)

# The session's code is the main module, as in a REPL. (`kernel` keeps this script's own module alive.)
kernel = sys.modules["__main__"]
main = sys.modules["__main__"] = types.ModuleType("__main__")
sys.path[0] = ""  # imports look in the working directory, not next to this script
scope = main.__dict__

if os.path.exists(KEPT):  # this session had a Python before, and the first call is told what is left of it
    restore()

for n, request in enumerate(map(json.loads, requests)):
    failed = call(request["code"], f"<call {n}>")
    save()
    print(json.dumps({"output": take(), "failed": failed}), file=replies, flush=True)
