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
DATABASES="${HERE}/eval/.cache/bird/minidev/MINIDEV/dev_databases"
TABLES="${HERE}/eval/.cache/bird/minidev/MINIDEV/dev_tables.json"
OUT="${HERE}/eval/out/competitors/predictions.json"

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
