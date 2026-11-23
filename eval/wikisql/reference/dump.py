#!/usr/bin/env python3
"""Regenerate `reference-digest.json` from the vendored reference judge.

`lib/` is `salesforce/WikiSQL`'s own `lib/` at master — `query.py` and `dbengine.py`, unmodified
except for this directory's `__init__.py`. It is vendored rather than depended on because it is the
thing the port is compared *against*: a differential test whose reference moves with a branch is a
test that agrees with whatever it last saw.

The digest is what the TypeScript judge must reproduce, and it is a digest rather than a copy of
1.1 MB of answers for two reasons: the full answers are regenerable in four seconds, and a fixture
that large invites being edited. What is stored is one sha256 over every question's rows plus a
sample every 32nd question, which is enough to (a) prove the whole split agrees and (b) name a
question when it does not.

Dependencies are the reference's: `pip install records babel`.

    node eval/wikisql/fetch.mjs
    python3 eval/wikisql/reference/dump.py            # writes eval/wikisql/reference-digest.json
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib.dbengine import DBEngine  # noqa: E402
from lib.query import Query  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
CACHE = os.environ.get('WIKISQL_CACHE', os.path.join(ROOT, 'eval', '.cache', 'wikisql'))
SAMPLE_EVERY = 32


def canonical(rows: list) -> str:
    """The same compact JSON the TypeScript side produces: no spaces, shortest float repr.

    Integral floats are normalised to integers first. The two serialisers disagree about
    `176.0` — Python prints the decimal point, JavaScript has one number type and prints `176` —
    on 1,145 of the dev split's questions, and a digest over JSON dialects would be a test of
    `json.dumps` rather than of the judge. What is being compared is the answer, so the answer is
    what is normalised: `176.0` and `176` are one value in SQLite and one value here.
    """

    def scalar(cell: object) -> object:
        if isinstance(cell, float) and cell.is_integer():
            return int(cell)
        return cell

    return json.dumps([[scalar(cell) for cell in row] for row in rows], ensure_ascii=False, separators=(',', ':'))


def main() -> int:
    split = sys.argv[1] if len(sys.argv) > 1 else 'dev'
    questions = [json.loads(line) for line in open(os.path.join(CACHE, '%s.jsonl' % split))]
    engine = DBEngine(os.path.join(CACHE, '%s.db' % split))

    digest = hashlib.sha256()
    sample = []
    errors = 0
    for index, row in enumerate(questions):
        sql = row['sql']
        try:
            rows = engine.execute_query(row['table_id'], Query(sql['sel'], sql['agg'], sql['conds']))
            rows = [[cell for cell in r] if isinstance(r, (list, tuple)) else [r] for r in rows]
        except Exception as error:  # noqa: BLE001 — the reference has no error contract to reproduce
            errors += 1
            rows = None
            print('error at %d: %s: %s' % (index, type(error).__name__, error), file=sys.stderr)
        digest.update(('%d\n%s\n' % (index, 'null' if rows is None else canonical(rows))).encode('utf-8'))
        if index % SAMPLE_EVERY == 0:
            sample.append({'index': index, 'rows': rows})

    record = {
        'split': split,
        'questions': len(questions),
        'errors': errors,
        'sha256': digest.hexdigest(),
        'sampleEvery': SAMPLE_EVERY,
        'sample': sample,
        'source': 'salesforce/WikiSQL@master lib/dbengine.py, unmodified',
    }
    out = os.path.join(ROOT, 'eval', 'wikisql', 'reference-digest.json')
    with open(out, 'w') as handle:
        json.dump(record, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    print(json.dumps({'split': split, 'questions': len(questions), 'errors': errors, 'sha256': record['sha256']}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
