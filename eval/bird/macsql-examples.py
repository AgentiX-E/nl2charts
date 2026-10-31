#!/usr/bin/env python3
"""Run MAC-SQL's own value-example code over the BIRD databases.

The port in `eval/bird/value-examples.ts` claims to reproduce a competitor's rule. A claim
like that is worth exactly as much as the comparison behind it, so this script takes the
two methods out of their `core/agents.py` by `ast` (not by transcription), binds them to a
stub object, and runs them over the same SQLite files our port reads. Whatever it prints is
their rule's output; the diff against ours is the evidence.

    python3 eval/bird/macsql-examples.py --src /tmp/macsql/core__agents.py --db-root <root> \\
        --utils /tmp/macsql/core__utils.py --out /tmp/theirs.json [--dbs a,b]

`database_root` is the directory holding one directory per database, each with a `.sqlite`
file, which is BIRD's own layout.
"""
import argparse
import ast
import json
import os
import sqlite3
import sys
import types


def load_functions(path, names):
    """Bind the named top-level functions or class methods defined in `path`."""
    source = open(path, encoding="utf-8").read()
    tree = ast.parse(source)
    chunks = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            chunks.append(ast.get_source_segment(source, node))
    missing = names - {n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
    if missing:
        raise SystemExit(f"{path} does not define {sorted(missing)}")
    module = types.ModuleType("extracted")
    # Their bodies are annotated and use a few module-level names; the extraction has no
    # imports, so the namespace is given the same names `agents.py` itself imports.
    module.__dict__.update(
        {
            "List": list,
            "Dict": dict,
            "Tuple": tuple,
            "Optional": object,
            "Any": object,
            "re": __import__("re"),
            "os": os,
            "sys": sys,
            "time": __import__("time"),
            "sqlite3": sqlite3,
        }
    )
    exec("\n\n".join(chunks), module.__dict__)  # noqa: S102 - the point of the script
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", required=True)
    parser.add_argument("--utils", required=True)
    parser.add_argument("--db-root", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--dbs", default="")
    args = parser.parse_args()

    utils = load_functions(args.utils, {"is_email", "is_valid_date", "is_valid_date_column"})
    agents = load_functions(
        args.src, {"_get_unique_column_values_str", "_get_value_examples_str"}
    )

    # Their method swallows exceptions into an empty string, so a missing helper would
    # print as "this column has no examples" and the diff would pass for the wrong reason.
    # The names the body reads from its module are bound here, and a miss is fatal.
    for helper in ("is_email", "is_valid_date_column"):
        if not hasattr(utils, helper):
            raise SystemExit(f"utils does not define {helper}")
        setattr(agents, helper, getattr(utils, helper))

    class Stub:
        dataset_name = "bird"

    stub = Stub()
    # `_get_unique_column_values_str` calls `self._get_value_examples_str`, so the stub needs
    # both, bound the way a class method expects.
    stub._get_unique_column_values_str = types.MethodType(
        agents._get_unique_column_values_str, stub
    )
    stub._get_value_examples_str = types.MethodType(agents._get_value_examples_str, stub)
    # ...and the module the method body references for its own helpers.
    agents.is_valid_date_column = utils.is_valid_date_column

    root = args.db_root
    dbs = [d for d in args.dbs.split(",") if d] or sorted(os.listdir(root))
    out = {}
    for db in dbs:
        path = os.path.join(root, db, f"{db}.sqlite")
        if not os.path.exists(path):
            print(f"skip {db}: no database", file=sys.stderr)
            continue
        conn = sqlite3.connect(path)
        conn.text_factory = lambda b: b.decode("utf-8", "replace")
        cursor = conn.cursor()
        tables = [
            row[0]
            for row in cursor.execute(
                "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name"
            )
        ]
        # Their dictionary marks both ends of every foreign key as a key column, so the
        # referenced column is skipped as well as the referring one.
        targets = set()
        for table in tables:
            for row in cursor.execute(f'pragma foreign_key_list("{table}")'):
                # Their dictionary extends its key list with both indices of every pair, so
                # both ends are skipped: the referring column and the referenced one.
                targets.add((table, row[3]))
                targets.add((row[2], row[4]))
        per_db = {}
        for table in tables:
            info = list(cursor.execute(f'pragma table_info("{table}")'))
            names = [row[1] for row in info]
            declared = [row[2] for row in info]
            keys = [
                bool(row[5]) or (table, row[1]) in targets
                for row in info
            ]
            pairs = stub._get_unique_column_values_str(cursor, table, names, declared, names, keys)
            for column, values in pairs:
                if values:
                    per_db[f"{table}.{column}"] = values
        cursor.close()
        conn.close()
        out[db] = per_db
        print(f"{db}: {len(per_db)} columns with examples", file=sys.stderr)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(out, handle, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
