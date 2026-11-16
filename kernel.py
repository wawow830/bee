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
    """Run code. Returns whether it raised. What it wrote is in `written`."""
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
    return f"[New Python session. Restored: {', '.join(names()) or 'nothing'}. Lost: {lost}.]\n"


# The harness keeps the pipes. The session and its children get no input, and write to one file.
requests, replies = os.fdopen(os.dup(0)), os.fdopen(os.dup(1), "w")
written = tempfile.TemporaryFile()
os.dup2(os.open(os.devnull, os.O_RDONLY), 0), os.dup2(written.fileno(), 1), os.dup2(written.fileno(), 2)
sys.stdout.reconfigure(line_buffering=True)
signal.signal(signal.SIGINT, signal.SIG_IGN)

# The session's code is the main module, as in a REPL. (`kernel` keeps this script's own module alive.)
kernel, main = sys.modules["__main__"], types.ModuleType("__main__")
sys.modules["__main__"] = main
sys.path[0] = ""  # imports look in the working directory, not next to this script
scope = main.__dict__
note = restore() if os.path.exists(KEPT) else ""  # this session had a Python before

for n, request in enumerate(map(json.loads, requests)):
    failed = call(request["code"], f"<call {n}>")
    save()
    sys.stdout.flush(), sys.stderr.flush()
    written.seek(0)
    output, note = note + written.read().decode(errors="replace"), ""
    written.seek(0), written.truncate()
    if (cut := len(output) - SHOWN) > 0:
        output = f"{output[: SHOWN // 2]}\n[{cut} characters cut]\n{output[-SHOWN // 2 :]}"
    print(json.dumps({"output": output, "failed": failed}), file=replies, flush=True)
