#!/usr/bin/env python3
"""Rebuild nvBench 2.0's `type_by_field` from the tables the benchmark publishes.

The reference judge (`reference/evaluation.py`) imports `raw_data/nvbench_metadata.json` at module
scope, and the public checkout does not carry that file. What it carries is `database_csv.zip` —
one CSV per table — plus `dev.json`/`test.json`/`train.json`, and each of those records, per sample,
a `table_schema` holding `table_columns` and `column_examples`. Those examples were written by the
same generator that wrote the metadata (`3.generate_metadata.py`: min/median/max for a quantitative
column, three sampled values otherwise), so the corpus states the answer for every field a question
touches, and this script has something to be checked against.

**The checkout's filter stage cannot be what produced the checkout's data.** `2.table_filter.py`
drops a column that is more than 80% empty, a column whose values look like hex, a column holding
characters above 0x7F, and a column whose date-like name does not parse as `%Y-%m-%d`. Applied to
the published CSVs it removes 42 fields that the shipped `table_schema` still lists — `formula_1`'s
`number` (804 of 842 rows empty), `cre_Doc_Template_Mgt`'s `document_id` (its ids `16514113` and
`385906526` are eight digits of hex), `college_2`'s `name` (`Álvarez`, read as latin-1). So the
filter did not run, or ran as a different program, and the rule below is the one the corpus itself
demonstrates: read every column, type it by name and dtype, drop nothing.

    python3 eval/nvbench2/metadata.py <csv dir> --out metadata.json
    python3 eval/nvbench2/metadata.py --self-test
"""
import argparse
import csv
import hashlib
import json
import os
import sys

import pandas as pd

T = "temporal"
Q = "quantitative"
C = "category"


def types_of(frame):
    """`3.generate_metadata.py`'s rule, in its own order. The judge reads only the third test.

    `temporal` is unreachable from the published CSVs: pandas reads `2010-05-01` as text, and no
    column of any published table arrives as a datetime dtype. The label is kept because it is the
    reference's, and because it costs nothing — `reverse_axes_if_needed` asks whether a field is
    `quantitative` and nothing else, so `temporal` and `category` are the same answer to the only
    question the judge asks.
    """
    out = {}
    for name in frame.columns:
        if pd.api.types.is_datetime64_any_dtype(frame[name]):
            out[name] = T
        elif name == "id" or name.endswith("_id"):
            out[name] = C
        elif pd.api.types.is_numeric_dtype(frame[name]):
            out[name] = Q
        else:
            out[name] = C
    return out


def table_names(csv_dir):
    """The tables of a directory, in order.

    `._` is excluded on purpose: the archive carries an `__MACOSX/database_csv/` holding one
    AppleDouble file per table, each of which also ends in `.csv` and each of which is four kilobytes
    of binary header. Pointed at the archive's root instead of the table directory, this function
    would find 1,606 names and type 803 of them from a resource fork.
    """
    return sorted(name for name in os.listdir(csv_dir)
                  if name.endswith(".csv") and not name.startswith("._"))


def read_one(path):
    """Read a table the way `3.generate_metadata.py` does, minus the filter that cannot have run."""
    try:
        return pd.read_csv(path, low_memory=False, quoting=csv.QUOTE_ALL, encoding="utf-8")
    except UnicodeDecodeError:
        return pd.read_csv(path, low_memory=False, quoting=csv.QUOTE_ALL, encoding="latin1")
    except pd.errors.ParserError:
        return pd.read_csv(path, low_memory=False, quoting=csv.QUOTE_ALL, encoding="utf-8",
                           engine="python")


def build(csv_dir, limit=None):
    names = table_names(csv_dir)
    if limit is not None:
        names = names[:limit]
    out = {}
    failed = []
    for index, name in enumerate(names):
        try:
            out[name] = types_of(read_one(os.path.join(csv_dir, name)))
        except Exception as error:  # noqa: BLE001 — a table that will not read is a reading
            failed.append((name, str(error)[:120]))
        if (index + 1) % 100 == 0:
            print(f"  {index + 1}/{len(names)}", file=sys.stderr, flush=True)
    return out, failed


def digest_of(types):
    """One string for the whole map, so a re-run is compared with the fixture in one line."""
    hasher = hashlib.sha256()
    for name in sorted(types):
        row = types[name]
        hasher.update(name.encode())
        hasher.update(b"\n")
        for field in sorted(row):
            hasher.update(f"{field}\t{row[field]}\n".encode())
    return hasher.hexdigest()


def counts_of(types):
    counts = {T: 0, Q: 0, C: 0}
    for row in types.values():
        for kind in row.values():
            counts[kind] += 1
    return counts


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("csv_dir", nargs="?")
    parser.add_argument("--out")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--self-test", action="store_true")
    settings = parser.parse_args(argv)
    if settings.self_test:
        return self_test()
    if settings.csv_dir is None:
        parser.error("csv_dir is required unless --self-test")
    try:
        types, failed = build(settings.csv_dir, settings.limit)
    except FileNotFoundError as error:
        # A directory that is not there is an invocation mistake, not a corpus with no tables, and
        # the two deserve different sentences.
        print(f"no such table directory: {error.filename}", file=sys.stderr)
        return 1
    if not types:
        # An empty directory is a fetched archive that was never extracted, not a corpus with no
        # tables. Reporting a map of zero tables would let the gate below pass on nothing.
        print(f"no tables in {settings.csv_dir}", file=sys.stderr)
        return 1
    payload = {"csv": len(types), "failed": failed, "fields": counts_of(types),
               "digest": digest_of(types), "types": types}
    if settings.out:
        with open(settings.out, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=1, sort_keys=True)
    print(json.dumps({key: payload[key] for key in ("csv", "fields", "digest")}, sort_keys=True))
    for name, why in failed[:5]:
        print(f"failed: {name}: {why}", file=sys.stderr)
    return 0 if not failed else 1


def self_test():
    """Eleven claims on frames built in memory: no corpus, no network.

    Four of them are the filter's rules, asserted *not* to happen, because the shipped
    `table_schema` proves they did not.
    """
    problems = []

    def check(name, got, want):
        if got != want:
            problems.append(f"{name}: got {got!r}, want {want!r}")

    frame = pd.DataFrame({"id": [1, 2], "name": ["a", "b"], "amount": [1.5, 2.5],
                          "note_id": [3, 4], "authid": [50, 62]})
    kinds = types_of(frame)
    check("an id is a category even though it parses as a number", kinds["id"], C)
    check("a trailing _id is a category", kinds["note_id"], C)
    check("an id that is not called _id stays quantitative", kinds["authid"], Q)
    check("a float column is quantitative", kinds["amount"], Q)
    check("a text column is a category", kinds["name"], C)

    frame = pd.DataFrame({"number": [None] * 9 + [7.0], "keep": [1.0] * 10})
    check("a column that is 90% empty still gets a type", types_of(frame)["number"], Q)

    frame = pd.DataFrame({"document_id": [16514113, 385906526]})
    check("an eight-digit id is a category, not binary data", types_of(frame)["document_id"], C)

    frame = pd.DataFrame({"name": ["Álvarez", "Bianchi"]})
    check("an accented name is a category, not binary data", types_of(frame)["name"], C)

    frame = pd.DataFrame({"visit_date": ["5/1/2010", "6/2/2010"]})
    check("a date that does not parse is still a category, not a dropped column",
          types_of(frame)["visit_date"], C)

    frame = pd.DataFrame({"stamp": pd.to_datetime(["2020-01-01", "2020-02-01"])})
    check("a datetime dtype is temporal", types_of(frame)["stamp"], T)

    frame = pd.DataFrame({"url": ["http://example.org/1"], "text": ["a" * 200]})
    kinds = types_of(frame)
    check("a url column is a category, not binary data", kinds["url"], C)
    check("a long text column is a category", kinds["text"], C)

    for problem in problems:
        print(f"metadata self-test: {problem}")
    print(f"metadata self-test: {'ok' if not problems else 'FAILED'}")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
