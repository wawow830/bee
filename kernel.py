#!/usr/bin/env python3
"""bee's one tool: a Python session. Takes {code, settings} lines on stdin, answers {output, failed, lines} on stdout.

    kernel.py FILE    FILE is the session's JSONL file
"""
import ast, json, linecache, os, signal, sys, tempfile, traceback, types

asked = []  # lines the running call wants appended to the session


def branch(parent, text):
    """Append text as a user message after line parent, and this call after that."""
    if parent not in range(sum(1 for _ in open(bee.file))):
        raise ValueError(f"no line {parent!r}")
    asked.append({"parent": parent, "text": text})
    print(f"Continuing after line {parent}.")


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

# The harness, as a module: the session file, the one act, and the settings.
bee = scope["bee"] = sys.modules["bee"] = types.ModuleType("bee")
bee.file, bee.branch = sys.argv[1], branch
ran = any('"role":"toolResult"' in line for line in open(bee.file))  # this session has had a Python before
note = "[New Python session: earlier variables are gone.]\n" if ran else ""

for n, request in enumerate(map(json.loads, requests)):
    settings = request["settings"]
    vars(bee).update(settings)
    asked.clear()
    failed = call(request["code"], f"<call {n}>")
    sys.stdout.flush(), sys.stderr.flush()
    written.seek(0)
    output, note = note + written.read().decode(errors="replace"), ""
    written.seek(0), written.truncate()
    if (cut := len(output) - settings["output"]) > 0:
        half = settings["output"] // 2
        output = f"{output[:half]}\n[{cut} characters cut]\n{output[-half:]}"
    changed = {key: getattr(bee, key, None) for key in settings if getattr(bee, key, None) != settings[key]}
    lines = [changed, *asked] if changed else asked
    print(json.dumps({"output": output, "failed": failed, "lines": lines}, default=str), file=replies, flush=True)
