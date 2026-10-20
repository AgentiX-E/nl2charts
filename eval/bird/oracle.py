#!/usr/bin/env python3
"""Execution oracle for external SQLite benchmarks.

Why this file exists in a TypeScript repository: BIRD's official judge runs the
predicted and gold statements through Python's `sqlite3` and compares
`cursor.fetchall()` tuples. Re-implementing SQLite in JavaScript would introduce
a second dialect under test; the adapter in `packages/node` returns object rows,
which collapse duplicate output column names. So the benchmark executes through
the same driver the reference implementation uses, and the TypeScript side does
the judging.

Protocol: one JSON object per line on stdin, one per line on stdout.

  request : {"id": "...", "db": "superhero", "sql": "SELECT ..."}
  response: {"id": "...", "ok": true, "columns": [...], "rows": [[...]], "ms": 3}
            {"id": "...", "ok": false, "error": "no such table: x", "ms": 1}

Rows are arrays so that column order and duplicate rows survive. Bytes are
returned as {"$b64": "..."}; SQLite cannot return a dict cell, so the marker
cannot collide with a value.
"""

from __future__ import annotations

import base64
import json
import os
import sqlite3
import sys
import time

# A statement that takes this many VM steps is aborted. BIRD's reference harness
# uses a 30 second wall clock; a step budget is deterministic and does not depend
# on how loaded the runner is.
STEP_BUDGET = 400_000_000


class Timeout(Exception):
    pass


def wrap(value: object) -> object:
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"$b64": base64.b64encode(bytes(value)).decode("ascii")}
    return value


class Oracle:
    def __init__(self, root: str) -> None:
        self.root = root
        self.connections: dict[str, sqlite3.Connection] = {}
        # One shared deadline: every connection's progress handler reads it, and
        # each statement resets it, so a second database cannot disable the guard
        # installed for the first.
        self.deadline = [0.0]

    def connect(self, db_id: str) -> sqlite3.Connection:
        if db_id not in self.connections:
            path = os.path.join(self.root, db_id, f"{db_id}.sqlite")
            if not os.path.exists(path):
                raise FileNotFoundError(f"database not found: {path}")
            connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            connection.set_progress_handler(self._guard(), 100_000)
            self.connections[db_id] = connection
        return self.connections[db_id]

    def _guard(self):
        def handler() -> int:
            return 1 if time.monotonic() > self.deadline[0] else 0

        return handler

    def execute(self, db_id: str, sql: str) -> dict:
        started = time.monotonic()
        try:
            connection = self.connect(db_id)
            # 30 s per statement, refreshed for every call.
            self.deadline[0] = started + 30.0
            cursor = connection.execute(sql)
            raw = cursor.fetchall()
            columns = [description[0] for description in cursor.description or []]
            return {
                "ok": True,
                "columns": columns,
                "rows": [[wrap(cell) for cell in row] for row in raw],
                "ms": int((time.monotonic() - started) * 1000),
            }
        except Exception as error:  # noqa: BLE001 - every failure is data here
            return {
                "ok": False,
                "error": f"{type(error).__name__}: {error}",
                "ms": int((time.monotonic() - started) * 1000),
            }


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else "eval/.cache/bird/databases"
    oracle = Oracle(root)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = json.loads(line)
        if request.get("op") == "ping":
            print(json.dumps({"id": request.get("id", "ping"), "ok": True, "rows": [], "columns": []}), flush=True)
            continue
        result = oracle.execute(request["db"], request["sql"])
        result["id"] = request["id"]
        print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
