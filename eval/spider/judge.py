#!/usr/bin/env python3
"""Spider's exact-match judge, behind a JSON-lines pipe.

`salesforce`-style ports are not available here: Spider's judge is `evaluation.py` and `process_sql.py`,
and both are vendored beside this file, unmodified, pinned by sha256 in `check.ts`. This wrapper adds
three things the reference does not have and that a harness needs:

1. **A database per request.** `process_sql.get_sql` resolves every column through a `Schema` built
   from a live SQLite file — so exact match is not a string comparison and cannot be computed from the
   question file alone. That is the finding this wrapper exists to make operational: the corpus is the
   databases, not `dev.json`.
2. **A parse verdict per side.** A prediction that fails to parse is an empty SQL in the reference's
   own `evaluate()`, which scores it 0 silently; here the two sides are reported separately, so a
   corpus whose golds do not parse is visible instead of being read as "the model is weak".
3. **No shared label.** `Evaluator.eval_partial_match` **mutates** the label it is given (`eval_sel`
   calls `label_sel.remove(...)`). Passing one parsed gold to several comparisons therefore scores
   every comparison after the first against a shrinking list: in the measurement that produced this
   file, 279 of 734 golds read 0 when compared with themselves. `--self-test` asserts that trap and
   the way out of it, because it is invisible in every reading a harness would otherwise print.

Usage:
    python3 judge.py                 # JSON lines on stdin, JSON lines on stdout
    python3 judge.py --self-test     # the three claims above, as assertions
"""
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REFERENCE = os.path.join(HERE, "reference")
sys.path.insert(0, REFERENCE)

from evaluation import Evaluator  # noqa: E402
from process_sql import Schema, get_schema, get_sql  # noqa: E402

SCHEMAS = {}
EVALUATOR = Evaluator()


def schema_of(db):
    """One `Schema` per database, cached: building it reads the whole catalogue."""
    if db not in SCHEMAS:
        if not os.path.exists(db):
            raise FileNotFoundError(db)
        SCHEMAS[db] = Schema(get_schema(db))
    return SCHEMAS[db]


def compare(db, pred, gold):
    """Exact match for one pair, with a parse verdict for each side and no shared label.

    A refused prediction also carries `reason`: the parser's own sentence for why it stopped. The
    count of refusals says how many were lost, and the reason says to whom — a prompt that names four
    restrictions turns a refusal into a readable statement, and a refusal that survives them is one
    more sentence the prompt does not have yet. Without the reason, the only way to find that sentence
    is to read 1,034 statements; with it, the refusals group themselves.
    """
    schema = schema_of(db)
    try:
        gold_sql = get_sql(schema, gold)
        gold_state = "ok"
    except Exception:  # the reference swallows this; a corpus check must not
        return {"em": 0, "gold": "error", "pred": "unparsed"}
    try:
        pred_sql = get_sql(schema, pred)
    except Exception as error:
        return {"em": 0, "gold": gold_state, "pred": "error", "reason": str(error)[:160]}
    # Two parses for two arguments: `compare(pred, pred)` would hand the evaluator one object and it
    # would consume it.
    return {"em": 1 if EVALUATOR.eval_exact_match(pred_sql, get_sql(schema, gold)) else 0,
            "gold": gold_state, "pred": "ok"}


def self_test():
    """The claims in this file's docstring, checked against the vendored reference."""
    problems = []
    db = os.path.join(HERE, "self-test.db")
    if os.path.exists(db):
        os.remove(db)
    connection = sqlite3.connect(db)
    connection.executescript(
        'CREATE TABLE singer ("singer_id" number, "name" text, "country" text, "age" number);'
        'CREATE TABLE concert ("concert_id" number, "concert_name" text, "singer_id" number);'
    )
    connection.commit()
    connection.close()
    try:
        two = "SELECT name , country , age FROM singer"
        single = "SELECT name FROM singer"
        joins = "SELECT count(*) FROM singer AS T1 JOIN concert AS T2 ON T1.singer_id = T2.singer_id"

        problems.append(("no shared label", compare(db, two, two)["em"], 1))
        # The reference consumes its label: the same object on both sides reads 0 once the select has
        # more than one unit. If this ever stops being true, the two-parse rule below is no longer
        # what makes the numbers right and this file should say so.
        problems.append(("the reference consumes its label", reuse(db, two), 0))
        problems.append(("column order is a set", compare(db, two, "SELECT age , name , country FROM singer")["em"], 1))
        problems.append(("a different table is not a match", compare(db, single, joins)["em"], 0))
        problems.append(("a gold that does not parse is reported, not swallowed", compare(db, single, "SELECT nope FROM singer")["gold"], "error"))
        problems.append(("a prediction that does not parse is reported", compare(db, "SELECT nope FROM singer", single)["pred"], "error"))
    finally:
        if os.path.exists(db):
            os.remove(db)
    return [p for p in problems if not p[1] == p[2]]


def reuse(db, sql):
    """What a harness that parses a gold once and reuses it would read. Kept for the self-test."""
    schema = schema_of(db)
    gold = get_sql(schema, sql)
    return 1 if EVALUATOR.eval_exact_match(gold, gold) else 0


def main(argv):
    if "--self-test" in argv:
        failed = self_test()
        for name, got, want in failed:
            print(f"spider judge: {name}: got {got!r}, want {want!r}")
        print("spider judge: self-test: " + ("ok" if not failed else "FAILED"))
        return 0 if not failed else 1
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            answer = compare(request["db"], request["pred"], request["gold"])
        except Exception as error:  # a broken request is a broken run, not a 0
            answer = {"error": f"{type(error).__name__}: {error}"}
        sys.stdout.write(json.dumps(answer) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
