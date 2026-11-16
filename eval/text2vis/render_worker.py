"""Run the source this repository's compiler emits, and save what it draws.

The reference harness of the public NL2Vis benchmark replaces `plt.show` with a saver and calls the
generated code with `exec`; this worker does the same thing so that the picture a judge sees is the
picture the emitted source actually makes. Nothing here decides what to draw — the source arriving on
standard input already says that — so a defect in the reading belongs to `packages/chart`, and a
defect in this file is a defect in the instrument.

Protocol, one JSON object per line, in and out:

    {"id": "17", "png": "/tmp/x/17.png", "code": "import matplotlib.pyplot as plt\\n..."}
    {"id": "17", "ok": true, "ms": 31.4, "bytes": 41233}
    {"id": "18", "ok": false, "error": "ValueError: ..."}

Agg is chosen rather than the default backend because this process has no display: the default
backend on a machine without one is a source of failures that say nothing about the chart. `show` is
patched rather than appended to, because the emitted source calls it and a second saver would write
the same file twice.
"""

import json
import os
import sys
import time

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402  (after `use`, which must come first)


def render(job):
    """One job in, one verdict out. Never raises: a failure is a line of the report."""
    started = time.perf_counter()
    png = job["png"]
    os.makedirs(os.path.dirname(png), exist_ok=True)

    def saver(*_args, **_kwargs):
        # The figure the source built, not a new one: `savefig` on the current figure is what
        # `plt.show` would have shown, and `bbox_inches="tight"` keeps a long axis label from being
        # cropped off the picture a judge has to read.
        plt.savefig(png, dpi=110, bbox_inches="tight")

    plt.show = saver
    try:
        exec(compile(job["code"], f"<chart {job['id']}>", "exec"), {"__name__": "__chart__"})
    finally:
        # Every figure is closed, so a job that leaked one cannot tint the next job's picture.
        plt.close("all")
    ms = (time.perf_counter() - started) * 1000.0
    if not os.path.exists(png):
        raise RuntimeError("the source ran and saved nothing: it never called plt.show()")
    return {"id": job["id"], "ok": True, "ms": round(ms, 3), "bytes": os.path.getsize(png)}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = json.loads(line)
        try:
            verdict = render(job)
        except Exception as error:  # noqa: BLE001  (a failure is data, not a crash)
            # The message, not the traceback: the emitted source travels with the report, so the
            # frames would repeat what a reader already has, and the type is the part that says
            # whether the compiler emitted something Python cannot run.
            verdict = {"id": job.get("id"), "ok": False, "error": f"{type(error).__name__}: {error}"}
        sys.stdout.write(json.dumps(verdict) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
