#!/usr/bin/env python3
"""bee's one tool: a Python session. Takes {code} lines on stdin, answers {output, failed} lines on stdout."""
import ast, json, linecache, os, signal, sys, tempfile, traceback, types

SHOWN = 20_000  # characters of output the model sees per call


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

for n, request in enumerate(map(json.loads, requests)):
    failed = call(request["code"], f"<call {n}>")
    print(json.dumps({"output": take(), "failed": failed}), file=replies, flush=True)
