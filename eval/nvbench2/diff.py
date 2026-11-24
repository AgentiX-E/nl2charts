#!/usr/bin/env python3
"""Run the *vendored* nvBench 2.0 judge over a split and print what it read.

This is the other half of the differential test. `eval/nvbench2/judge.ts` is a port, and a port
whose only evidence is its own test suite is a port that agrees with itself: the reference has to be
executed, on the same questions, with the same predictions, and produce the same numbers.

The reference is imported, not re-implemented. `reference/evaluation.py` loads
`raw_data/nvbench_metadata.json` at module scope, so this script builds that file (from the map
`metadata.py` generated), changes into the directory that holds it, and then imports the module — no
edit, no monkey-patch, no copy of `preprocess_charts` or `deep_compare_charts`.

    python3 eval/nvbench2/diff.py --cache eval/.cache/nvbench2 --split dev

Prints one JSON object: the metrics at k=1,3,5, the count of questions where a transposed gold
matched, and a sha256 over every preprocessed gold. `test/nvbench2-reference.test.ts` recomputes all
three in TypeScript and compares.
"""
import argparse
import copy
import hashlib
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REFERENCE = os.path.join(HERE, "reference")


def canonical(value):
    """The same canonical JSON `judge.ts` writes: keys sorted, integral numbers without a fraction."""
    if isinstance(value, dict):
        items = ",".join(f"{json.dumps(key)}:{canonical(value[key])}" for key in sorted(value))
        return "{" + items + "}"
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, (int, float)):
        return json.dumps(value)
    return json.dumps(value, ensure_ascii=False)


def swapped(chart):
    """The gold with its two object channels exchanged — the probe for the type map."""
    if not isinstance(chart, dict) or not isinstance(chart.get("encoding"), dict):
        return chart
    encoding = chart["encoding"]
    if not isinstance(encoding.get("x"), dict) or not isinstance(encoding.get("y"), dict):
        return chart
    out = dict(chart)
    out["encoding"] = {**encoding, "x": encoding["y"], "y": encoding["x"]}
    return out


def patched(chart, **changes):
    if not isinstance(chart, dict):
        return chart
    return {**chart, **changes}


def build_case(golds):
    gold = golds[0]
    return [gold, swapped(gold), patched(gold, mark="point")], golds


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", required=True)
    parser.add_argument("--split", default="dev")
    settings = parser.parse_args(argv)

    with open(os.path.join(settings.cache, "metadata.json"), encoding="utf-8") as handle:
        payload = json.load(handle)
    types = payload.get("types", payload)
    rows = json.load(open(os.path.join(settings.cache, f"{settings.split}.json"), encoding="utf-8"))

    work = tempfile.mkdtemp(prefix="nvbench2-diff-")
    os.makedirs(os.path.join(work, "raw_data"), exist_ok=True)
    metadata = {csv: {"type_by_field": fields} for csv, fields in types.items()}
    with open(os.path.join(work, "raw_data", "nvbench_metadata.json"), "w", encoding="utf-8") as handle:
        json.dump(metadata, handle)
    with open(os.path.join(work, "raw_data", f"{settings.split}.json"), "w", encoding="utf-8") as handle:
        json.dump(rows, handle)

    previous = os.getcwd()
    sys.path.insert(0, REFERENCE)
    try:
        os.chdir(work)
        import evaluation as judge  # noqa: E402 — the import must follow the working directory
        from utils import deep_compare_charts  # noqa: E402
    finally:
        os.chdir(previous)

    dataset = []
    for row in rows:
        golds = json.loads(row["gold_answer"])
        predictions, _ = build_case(golds)
        dataset.append({"csv_filename": row["csv_file"], "model_predict": predictions,
                        "ground_truth": golds})

    results = judge.evaluate_metrics(dataset, deep_compare_charts, [1, 3, 5])

    hasher = hashlib.sha256()
    transposed = 0
    for index, row in enumerate(rows):
        metadata_row = judge.all_metadata[row["csv_file"]]
        golds = json.loads(row["gold_answer"])
        processed = judge.preprocess_charts(copy.deepcopy(golds), metadata_row)
        hasher.update(f"{index}\n{canonical(processed)}\n".encode())
        predictions, _ = build_case(golds)
        guess = judge.preprocess_charts(copy.deepcopy(predictions[1:2]), metadata_row)
        if len(guess) == 1 and guess[0] is not None and deep_compare_charts(guess[0], processed[0]):
            transposed += 1

    print(json.dumps({
        "split": settings.split,
        "questions": len(rows),
        "hit": results["hit"],
        "recall": results["recall"],
        "precision": results["precision"],
        "f1": results["f1"],
        "transposed": transposed,
        "digest": hasher.hexdigest(),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
