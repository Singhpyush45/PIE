# PIE — Python test harness.
#
# Runs INSIDE the sandbox, never on the application server. It is deliberately
# dependency-free and reads everything from one JSON file, because the sandbox
# has no network and a read-only filesystem.
#
# It prints exactly one line of JSON on stdout. Anything the candidate's code
# prints is captured and returned per test rather than mixed into that line —
# otherwise a candidate could print a JSON object and forge their own results.

import json, sys, io, traceback, contextlib

def main():
    with open(sys.argv[1]) as f:
        spec = json.load(f)

    results = []
    ns = {}
    try:
        # Compile first so a syntax error is reported as one, not as every test failing.
        code = compile(spec["code"], "<candidate>", "exec")
    except SyntaxError as e:
        print(json.dumps({"ok": False, "error": "SyntaxError: %s (line %s)" % (e.msg, e.lineno), "results": []}))
        return

    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            exec(code, ns)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e), "results": []}))
        return

    fn = ns.get(spec["entryPoint"])
    if not callable(fn):
        print(json.dumps({"ok": False,
            "error": "No function named '%s' was defined." % spec["entryPoint"], "results": []}))
        return

    for t in spec["tests"]:
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                got = fn(*t.get("input", []))
            passed = got == t.get("expected")
            results.append({"id": t["id"], "passed": bool(passed),
                            "got": repr(got)[:400], "stdout": out.getvalue()[:400]})
        except Exception as e:
            results.append({"id": t["id"], "passed": False,
                            "error": "%s: %s" % (type(e).__name__, e),
                            "stdout": out.getvalue()[:400]})

    print(json.dumps({"ok": True, "error": None, "results": results}))

if __name__ == "__main__":
    main()
