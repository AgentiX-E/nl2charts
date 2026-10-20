# Benchmarks and ablations

## What is measured today

The harness runs 20 questions over a deterministic fixture (200 orders, 60
customers, DuckDB, no randomness). It compares result sets, not SQL strings.

```bash
pnpm bench          # execution accuracy with controls
pnpm bench:linking  # schema-linking recall@3 ablation
pnpm bench:ablate   # paired question-normalization ablation
pnpm bench:bird     # external benchmark, see below
```

All artifacts land in `eval/out/` and are uploaded by the CI `benchmark` job.

## Controls come first

| Predictor | Exact | Unordered | Role |
| --- | --- | --- | --- |
| `oracle` (gold SQL) | 100.0% | 100.0% | positive control |
| `empty` (`select 1 where false`) | 0.0% | 0.0% | negative control |
| `template-raw` | 80.0% | 80.0% | non-LLM baseline, literal keywords |
| `template` (normalized) | 80.0% | 80.0% | baseline with synonym mapping |

The run fails if either control breaks. A benchmark that cannot separate a
perfect answer from an empty one is not measuring anything.

The 80% baseline is a **template matcher**, not a language model. It handles
`total revenue by region`, `how many orders by region`, `top 3 products by
revenue`, `monthly revenue` and similar patterns. It fails on windows (`q18`,
`q20`), median (`q19`), filters (`q15`) and two-dimension groupings (`q14`).

## Schema-linking ablation (recall@3, 25 questions)

| Arm | Recall@3 | Delta |
| --- | --- | --- |
| name only | 20.0% (5/25) | — |
| + alias | 56.0% (14/25) | +36.0pp |
| + sample values | 84.0% (21/25) | +28.0pp |

This is the clearest measured result in the repository: value profiling is worth
28pp on its own, and aliases 36pp. Both are cheap (no model call). The four
remaining misses are genuine: they require knowing that "orders" maps to
`order_id` even when the question never says "id", and that two same-named
columns in different tables both matter.

## Question-normalization ablation (paired, n=20)

| Arm | Accuracy |
| --- | --- |
| raw keywords | 80.0% |
| synonym mapping | 80.0% |

Delta +0.0pp, 0 discordant pairs, McNemar exact p = 1.0.

**Conclusion: no evidence that normalization helps on this set.** The code is
kept because it is harmless and the sample is small, but the documentation does
not claim a benefit. With 0 discordant pairs the test has no power; the next
iteration expands the set to ≥100 questions before drawing a conclusion.

## Semantic compiler ablation

`pnpm bench:semantic` runs 200 generated metric queries (8 metric sets × 6
dimension sets × 3 filter sets) against the deterministic fixture, compiling each
one twice: with the optimizer and without it.

| Measurement | Result |
| --- | --- |
| Identical result sets (optimized vs plain) | **200 / 200** |
| CTEs per query | 7.40 → 4.88 (**34.1% fewer**) |
| Naive join vs grain-first, per segment | **3.00x** inflation |

The optimizer is allowed to change SQL, never rows. If one pair diverges the run
fails. The fan-out number is produced by executing a hand-written join and the
compiled query against the same data; the fixture uses `DECIMAL` money columns so
the comparison is exact, not floating-point tolerant.

## Live NL to SQL evaluation

`pnpm bench:live` runs 210 generated questions over the semantic fixture through
a real model (`deepseek-chat`), three times per case, majority-scored. Every gold
query is executed before the model is called.

Latest run (GitHub Actions, commit `f9c8e6e`):

| Arm | Execution accuracy | 95% Wilson | Cases that disagreed with themselves |
| --- | --- | --- | --- |
| schema names | **100%** (210/210) | [98.2, 100] | 0 |
| + enum samples | **100%** (210/210) | [98.2, 100] | 0 |
| + repair loop (2 turns) | **100%** (210/210) | [98.2, 100] | 0 |

**This is a ceiling, not a capability claim.** Twenty intents with paraphrases
are saturated by the current model, so the paired ablations show no difference
and cannot measure a module's contribution. Two earlier runs did:
enum samples induced an unstated `status = 'completed'` filter on 31 cases
(97.1% → 82.4%, McNemar p < 1e-9), and missing column comments made the model
treat item price × quantity as the order amount. Both prompt defects are fixed;
the regression and its fix are recorded rather than hidden by the final number.

Headroom now comes from the external benchmark below. No SOTA claim is made
there either: 58.6% on 239 of 500 questions, one model, one sample per case, no
fine-tuning, is a baseline to beat, not a record.

## External benchmark: BIRD Mini-Dev

The synthetic set saturates: every arm scores 100%, so it cannot rank modules.
BIRD Mini-Dev does not: its schemas, questions, gold SQL and SQLite databases
were written by someone else.

```bash
node eval/bird/fetch.mjs        # ~800 MB archive, extracts the databases that are missing
pnpm bench:bird:dry             # gold execution, schema fidelity, prompt coverage; no model
pnpm bench:bird:port            # DuckDB portability census
pnpm bench:bird                 # five arms, paired ablations, live model
pnpm bench:bird:stability       # 60 cases x 3 repeats: the noise floor
```

Scope: **all 11 databases, 239 of 500 questions** (stratified by difficulty, one
gold statement excluded because it exceeds the 30 s budget), `deepseek-chat`,
temperature 0, one sample per case. Artifacts: `eval/out/bird-eval.json`,
`eval/out/bird-stability.json`, `eval/out/duckdb-portability.json`.

### Controls (these fail the run, not just the table)

| Control | Result |
| --- | --- |
| Gold statements executed before any model call | **239 / 240** (99.6%) |
| Gold executed twice and compared to itself | **239 / 239** identical |
| Negative control: empty result vs non-empty gold | **0** false matches |
| Schema fidelity: advertised columns exist in the database | **798 / 798** |
| Prompt coverage: tables that reach the schema card | **75 / 75** (no truncation) |

### Accuracy (run D, same 239 cases in every arm)

| Arm | Execution accuracy | 95% Wilson | Strict multiset | prompt chars (mean) |
| --- | --- | --- | --- | --- |
| names only | 32.2% (77/239) | [26.6, 38.5] | 71 | 1818 |
| + **structural semantics** | 33.5% (80/239) | [27.8, 39.8] | 74 | 2630 |
| + structural semantics + dataset evidence | 55.2% (132/239) | [48.8, 61.4] | 126 | 2764 |
| + metadata + dataset evidence | **58.6%** (140/239) | [52.2, 64.8] | 130 | 7605 |

| Change | Δ | only before / only after | p | verdict |
| --- | --- | --- | --- | --- |
| names → +structural semantics | +1.3pp | 7 / 10 | 0.63 | **no measurable effect** |
| +structural semantics → +dataset evidence | **+21.8pp** | 6 / 58 | 9e-12 | real |

### The evidence gap is semantic, not statistical

Two rounds tried to manufacture the missing sentence without a human. The first
built a dictionary from the data (`renderEvidence()`, `synthetic` arm): **+1.7pp**
against **+12.1pp** for the sentence BIRD ships with each question. The second
built what a schema can actually support — grain, keys, join direction, column
roles (`renderDefinitions()`, `definitions` arm): **+1.3pp**, p=0.63.

Neither closes the gap. The reason is visible in the text they produce:

- a dictionary says which values exist: `orders.status: 2 values (completed, refunded)`;
- structural semantics say how the tables fit: `orders.customer_id: foreign key to
  customers.customer_id; many orders per customer`;
- BIRD's evidence says what a term means: `ratio of customers who pay in EUR =
  count(Currency='EUR') / count(Currency='CZK')`.

The last one is a business decision. No amount of schema introspection recovers
it, and this benchmark now measures that boundary instead of assuming a clever
renderer would cross it.

### A shorter prompt reaches the same place (not yet a claim)

`definitions+evidence` scores 55.2% with a **2,764-character** prompt;
`metadata+evidence` scores 58.6% with **7,605 characters**. The 3.4pp difference is
inside the 4pp noise threshold (ADR-166), so the honest reading is "these two are
not distinguishable at n=239", not "semantics replace metadata" and not "metadata
is 3.4pp better". If it holds at a larger n, it matters: a warehouse with 2,000
columns cannot afford per-column descriptions, but it can afford a grain/join
block. The next run increases n rather than repeating this one.

### Noise floor (why one sample per case is stated, not assumed)

60 stratified cases, three repeats each, arm `metadata+evidence`:

| Metric | Result |
| --- | --- |
| Cases that disagreed with themselves | **2 / 60 (3.3%)** |
| Majority accuracy | 45.0% |
| Single-run accuracy | 45.0% |
| Difference | **0.0pp** |

Single sampling does not bias the aggregate, but it does move individual cases.
The flip rate fell from 8.3% to 3.3% between runs while the single-run and
majority scores stayed identical, which is itself evidence that a single run's
aggregate is stable and a single case's answer is not. Deltas below 4pp are
reported as "no measurable effect" (ADR-166).

### Adversarial shapes (32 hand-written cases, reported separately)

An aggregate hides the shapes it is bad at. These 32 cases cover windows, ratios,
multi-hop joins and ties, each with a declared output width that the gold must
match — a question promising two columns and a gold returning three would fail
every correct answer.

| Shape | names | definitions | metadata | adaptive |
| --- | --- | --- | --- | --- |
| window | 5/8 | 5/8 | 3/8 | 5/8 |
| ratio | 6/8 | 6/8 | 5/8 | 5/8 |
| multi-hop | **8/8** | 7/8 | **8/8** | **8/8** |
| tie | 7/8 | 7/8 | 7/8 | 7/8 |
| **total** | **81.2%** (26/32) | 78.1% (25/32) | 71.9% (23/32) | 78.1% (25/32) |

`names → definitions`: −3.1pp (1 case before, 0 after, p=1.0). With 32 cases a
single case is 3.1pp, so this face cannot rank the two arms; what it does say is
that structural semantics do not hurt the hard shapes the way full column
metadata does (three consecutive runs of −6.2, −9.4 and −3.1pp for metadata).

The two faces disagree in a way worth remembering: metadata is worth +11.3pp on
BIRD and −3.1pp here. A component's effect is a property of a question shape, not
of the component.

### DuckDB portability of the same gold statements

| Stage | Runnable | Taxonomy of the rest |
| --- | --- | --- |
| as written | 199/250 (79.6%) | Parser 27 (backtick quoting), Binder 14, Catalog 10 (`iif`) |
| backticks rewritten to quotes | 217/250 (86.8%) | Binder 21, Catalog 10, Parser 2 |
| + `iif` macro | **227/250 (90.8%)** | Binder 21, Parser 2 |

The census covers the six smallest databases; the remaining 23 failures are
dialect strictness, not bugs: arithmetic on text dates, bare columns in
`GROUP BY` (SQLite picks a row, DuckDB refuses), and `BETWEEN` over mixed types.

### Judges: official and strict

BIRD's judge is `set(predicted) == set(gold)` over tuples
(`evaluation/evaluation_ex.py`), which ignores row order and **collapses
duplicate rows**. The strict column compares multisets; the official rule credits
4–9 extra cases per arm on this slice. Both numbers are published so the choice
is visible instead of implied.

## What these numbers are not

- **Not a SOTA claim.** The dataset is a local fixture, not BIRD, Spider 2.0 or
  Text2Vis. It cannot be compared to published leaderboard numbers.
- **Not an LLM result.** The pipeline is exercised with a template baseline and
  a replay provider in CI. Live-model numbers require the benchmark workflow
  with a real key and a larger set.
- **Not execution-accuracy-complete.** Row order is compared both ways because
  gold queries often carry an `ORDER BY` that a correct answer may omit; the gap
  between exact and unordered is reported rather than hidden.

## Policy for future SOTA runs

1. Every accuracy gate declares a `baseline` and a `baselineSource`. Without
   them the number is `UNBASELINED` and does not count.
2. A target that is within the minimum detectable difference of its baseline is
   `VACUOUS`.
3. Comparisons are paired on identical questions. Report discordant pairs and a
   McNemar exact p-value; do not report a bare delta.
4. Ablations change one thing. Multi-change runs are labelled exploratory.
5. Absolute targets are frozen until a ≥200-question set exists; before that,
   relative improvement is the only honest signal.

## Reproducing

```bash
pnpm install
pnpm bench
cat eval/out/results.json
cat eval/out/linking-ablation.json
cat eval/out/ablation.json
```

The fixture is `eval/fixtures.sql`; the questions are `eval/golden.jsonl`. Both
are reviewed like code: a new case needs a gold query that is unambiguous and
deterministic.
