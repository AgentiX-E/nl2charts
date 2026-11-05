#!/usr/bin/env bash
# MAC-SQL, at its pin, on our subset, against our endpoint.
#
# Their entrypoint is `run.py`, and the adapter patch moved three things into the environment:
# the API type, the base URL and the model name. Nothing else in this invocation is ours — the
# selector, the decomposer and the refiner are the method under test, and `--use_gold_schema` is
# deliberately absent: a pipeline that is handed the gold schema is not the pipeline that was
# published.
#
# Its own record shape is written to `outputs/<name>/output_bird.json`, one JSON object a line with
# `idx`, `query`, `db_id` and `pred`, which `eval/competitors/predictions.ts` reads directly. The
# BIRD-format file beside it is the same statements keyed by question text, and the record shape is
# used because it carries the id rather than relying on a text match.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUBSET="${HERE}/eval/out/competitors/${COMPETITOR}-subset.json"
OUT="${HERE}/eval/out/competitors/predictions.json"

# The dataset is the split's, not this script's. `minidev` extracts under `minidev/MINIDEV` and
# `dev` under `dev/dev_20240627`, which is the layout `eval/bird/fetch.mjs` produces; hard-coding
# one of them would silently point a dev run at the 498-question databases and score every
# statement from it as an execution error.
case "${BIRD_SPLIT:-minidev}" in
  minidev) DATA="${HERE}/eval/.cache/bird/minidev/MINIDEV" ;;
  dev) DATA="${HERE}/eval/.cache/bird/dev/dev_20240627" ;;
  *)
    echo "unknown BIRD_SPLIT '${BIRD_SPLIT}': the adapter knows minidev and dev" >&2
    exit 1
    ;;
esac
DATABASES="${DATA}/dev_databases"
TABLES="${DATA}/dev_tables.json"

cd "${HERE}/.competitor"
mkdir -p outputs/run

# Their tokenizer is fetched at import time in some code paths; doing it here keeps the failure
# above the model calls rather than in the middle of one.
python3 -c "import nltk; nltk.download('punkt', quiet=True); nltk.download('punkt_tab', quiet=True)"

python3 ./run.py \
  --dataset_name bird \
  --dataset_mode dev \
  --input_file "${SUBSET}" \
  --db_path "${DATABASES}" \
  --tables_json_path "${TABLES}" \
  --output_file outputs/run/output_bird.json \
  --log_file outputs/run/log.txt

cp outputs/run/output_bird.json "${OUT}"
echo "predictions: ${OUT} ($(wc -l < "${OUT}") lines)"
