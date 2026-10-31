#!/usr/bin/env bash
# CHESS, at its pin, on our subset, against our endpoint.
#
# Two steps of theirs, both documented in their README: build the value index over the databases
# (`--db_id all`), then run the five agents. The only edit to their tree is the engine alias the
# adapter patch adds; the config file keeps their agents, their prompts and their sampling counts
# (ten candidates twice, twenty unit tests), and the substitution below only renames the engine,
# because the engine is the coordinate this comparison holds fixed rather than the method it varies.
#
# `--data_mode dev` is what makes their database manager look under `dev_databases`, which is the
# layout Mini-Dev ships: `DB_ROOT_PATH` is the parent of that directory, not the directory.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUBSET="${HERE}/eval/out/competitors/${COMPETITOR}-subset.json"
ROOT="${HERE}/eval/.cache/bird/minidev/MINIDEV"
OUT="${HERE}/eval/out/competitors/predictions.json"

cd "${HERE}/.competitor"

sed -i "s/gpt-4o-mini/${LLM_MODEL}/g" run/configs/CHESS_IR_CG_UT.yaml
grep -c "${LLM_MODEL}" run/configs/CHESS_IR_CG_UT.yaml >/dev/null || {
  echo "the engine substitution did not land: their config still names gpt-4o-mini" >&2
  exit 1
}

export DB_ROOT_PATH="${ROOT}"
python3 -u ./src/preprocess.py \
  --db_root_directory "${ROOT}/dev_databases" \
  --signature_size 100 \
  --n_gram 3 \
  --threshold 0.01 \
  --db_id all \
  --verbose true

python3 -u ./src/main.py \
  --data_mode dev \
  --data_path "${SUBSET}" \
  --config ./run/configs/CHESS_IR_CG_UT.yaml \
  --num_workers 1 \
  --pick_final_sql true

# The newest run directory holds `-predictions.json`: a map from question id to
# `statement\t----- bird -----\tdatabase`, the shape `predictions.ts` reads first.
PREDICTIONS="$(find results/dev -name '-predictions.json' -print0 | xargs -0 ls -t | head -1)"
if [[ -z "${PREDICTIONS}" ]]; then
  echo "CHESS wrote no -predictions.json under results/dev, so the run produced no statements" >&2
  exit 1
fi
cp "${PREDICTIONS}" "${OUT}"
echo "predictions: ${OUT} from ${PREDICTIONS}"
