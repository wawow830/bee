#!/usr/bin/env python3
"""bee's one tool: a Python session. Takes {code} lines on stdin, answers {output, failed, branch} on stdout.

    kernel.py FILE    FILE is the session's JSONL file
"""
import ast, json, linecache, os, signal, sys, tempfile, traceback, types

SHOWN = 20_000  # characters of output the model sees per call


class Bee:
    """The session, seen from inside it."""

    file = sys.argv[1]

    def branch(self, parent, text):
        if parent not in range(sum(1 for _ in open(self.file))):
            raise ValueError(f"no line {parent!r}")
        self.next = {"parent": parent, "text": text}


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
scope, bee = main.__dict__, Bee()
scope["bee"] = bee
ran = any('"role":"toolResult"' in line for line in open(bee.file))  # this session has had a Python before
note = "[New Python session: earlier variables are gone.]\n" if ran else ""

for n, request in enumerate(requests):
    bee.next = None
    failed = call(json.loads(request)["code"], f"<call {n}>")
    sys.stdout.flush(), sys.stderr.flush()
    written.seek(0)
    output, note = note + written.read().decode(errors="replace"), ""
    written.seek(0), written.truncate()
    if (cut := len(output) - SHOWN) > 0:
        output = f"{output[: SHOWN // 2]}\n[{cut} characters cut]\n{output[-SHOWN // 2 :]}"
    print(json.dumps({"output": output, "failed": failed, "branch": bee.next}), file=replies, flush=True)
