"""Produce an upstream-compatible ``series.jsonl`` from emitted Python chart code.

Why this exists. The VisCodeBench score engine (`t2v_eval`) never reads an image: it monkey-patches
matplotlib and records the coordinates each plotting call actually draws, then compares two such
logs. `viscodebench-score.ts` ports the comparison side, but a comparison needs a producer — a way to
turn generated Python into the exact log shape the comparator consumes. This worker is that producer.
It is the local, offline counterpart of `t2v_eval/batch_log.py` + `t2v_eval.logging`, reduced to the
four chart families the port scores (line / scatter / bar / pie).

It deliberately does NOT fetch the private leaderboard corpus or call a model. The code it runs is
supplied by the caller (see `emitVisualisationCode` in `viscodebench-pilot.ts`), which is what makes
the whole loop reproducible at zero cost: emit → execute → log → parse → score.

Protocol (one JSON object per line, in and out), mirroring `render_worker.py`:

    in:  {"id": "line-001", "code": "import matplotlib.pyplot as plt\\n##START ...\\n..."}
    out: {"id": "line-001", "ok": true, "series": <SeriesLogRecord[]>, "lines": 4}
    out: {"id": "line-001", "ok": false, "error": "ValueError: ..."}

Only the code between ``##START VISUALISATION CODE`` and ``##END VISUALISATION CODE`` is executed, with
``plt`` injected into the scope, so a caller emits the chart intent alone and no preamble can smuggle
in a plotting call the spec did not declare. `Agg` is forced: this process has no display.
"""

import json
import sys
import traceback

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402  (must follow `use`)

START_MARKER = "##START VISUALISATION CODE"
END_MARKER = "##END VISUALISATION CODE"


class LogSink:
    """Accumulates plotting calls into upstream-shaped series.jsonl records."""

    def __init__(self):
        self.records = []
        self._axis_ids = {}
        self._call = 0

    def axis_id(self, axes):
        key = id(axes)
        if key not in self._axis_ids:
            self._axis_ids[key] = "ax_%d" % len(self._axis_ids)
        return self._axis_ids[key]

    def add(self, axes, plt_func, data_series):
        self._call += 1
        self.records.append(
            {
                "axis_id": self.axis_id(axes),
                "plot_func_id": "pf_%d" % self._call,
                "plt_func": plt_func,
                "data_series": data_series,
            }
        )


def numbers(values):
    """Coerce an iterable to plain finite Python floats, dropping non-numeric entries."""
    out = []
    for value in values:
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if number != number:  # NaN
            continue
        out.append(number)
    return out


def install_patches(sink):
    """Replace the four plotting families with logging proxies that also call through."""
    originals = {}

    def wrap(name, plt_func):
        original = getattr(matplotlib.axes.Axes, name)
        originals[name] = original

        def proxy(self, *args, **kwargs):
            series = log_series(plt_func, args, kwargs)
            if series is not None:
                sink.add(self, plt_func, [series])
            return original(self, *args, **kwargs)

        proxy.__name__ = name
        setattr(matplotlib.axes.Axes, name, proxy)

    for name, func in (
        ("plot", "plot"),
        ("scatter", "scatter"),
        ("bar", "bar"),
        ("barh", "barh"),
        ("pie", "pie"),
    ):
        wrap(name, func)
    return originals


def restore_patches(originals):
    for name, original in originals.items():
        setattr(matplotlib.axes.Axes, name, original)


def log_series(plt_func, args, kwargs):
    """Build one upstream ``data_series`` dict from a plotting call's arguments."""
    if plt_func == "plot":
        if len(args) < 2:
            return None
        return {
            "x": numbers(args[0]),
            "y": numbers(args[1]),
            "name": str(kwargs.get("label", "")),
            "linestyle": str(kwargs.get("linestyle", "-")),
        }
    if plt_func in ("bar", "barh"):
        if len(args) < 2:
            return None
        return {
            "x": numbers(args[0]),
            "y": numbers(args[1]),
            "name": str(kwargs.get("label", "")),
        }
    if plt_func == "scatter":
        if len(args) < 2:
            return None
        size = kwargs.get("s")
        return {
            "x": numbers(args[0]),
            "y": numbers(args[1]),
            "s": numbers(size) if size is not None else [5] * len(args[0]),
            "name": str(kwargs.get("label", "")),
        }
    if plt_func == "pie":
        if len(args) < 1:
            return None
        return {"x": numbers(args[0]), "name": str(kwargs.get("label", ""))}
    return None


def extract_region(code):
    """Return only the lines between the two markers; raise if the region is missing."""
    if START_MARKER not in code:
        raise ValueError("missing %s" % START_MARKER)
    after = code.split(START_MARKER, 1)[1]
    if END_MARKER not in after:
        raise ValueError("missing %s" % END_MARKER)
    return after.split(END_MARKER, 1)[0]


def run(job):
    sink = LogSink()
    originals = install_patches(sink)
    try:
        region = extract_region(job["code"])
        # Only drawing calls live in the region; `plt` is injected so a caller emits the chart
        # intent alone rather than a preamble that could smuggle untracked calls.
        scope = {"__name__": "__chart__", "plt": plt}
        exec(compile(region, "<viscodebench %s>" % job.get("id", "?"), "exec"), scope)
        return {"id": job.get("id"), "ok": True, "series": sink.records, "lines": len(sink.records)}
    except Exception as error:  # noqa: BLE001  (a failure is data, not a crash)
        return {"id": job.get("id"), "ok": False, "error": "%s: %s" % (type(error).__name__, error)}
    finally:
        restore_patches(originals)
        plt.close("all")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = json.loads(line)
        verdict = run(job)
        sys.stdout.write(json.dumps(verdict) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
