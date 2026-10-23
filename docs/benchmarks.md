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
there either: 58.8% on 498 of the 500 Mini-Dev questions, one model, one sample per
case, no fine-tuning, is a baseline to beat, not a record.

## External benchmark: BIRD Mini-Dev

The synthetic set saturates: every arm scores 100%, so it cannot rank modules.
BIRD Mini-Dev does not: its schemas, questions, gold SQL and SQLite databases
were written by someone else.

```bash
node eval/bird/fetch.mjs        # ~800 MB archive, extracts the databases that are missing
pnpm bench:bird:dry             # gold execution, schema fidelity, prompt coverage; no model
pnpm bench:bird:port            # DuckDB portability census
pnpm bench:bird                 # seven arms, paired ablations, live model
pnpm bench:bird:stability       # 60 cases x 3 repeats: the noise floor
```

Scope: **all 11 databases, all 500 Mini-Dev questions** (498 scorable: two gold
statements exceed the harness's step budget and are named below), `deepseek-chat`,
temperature 0, one sample per case. Artifacts: `eval/out/bird-eval.json`,
`eval/out/bird-stability.json`, `eval/out/duckdb-portability.json`.

### Controls (these fail the run, not just the table)

| Control | Result |
| --- | --- |
| Gold statements executed before any model call | **498 / 500** (99.6%) — two exceed the step budget, named below |
| Gold executed twice and compared to itself | **498 / 498** identical |
| Negative control: empty result vs non-empty gold | **0** false matches |
| Schema fidelity: advertised columns exist in the database | **798 / 798** |
| Prompt coverage: tables that reach the schema card | **75 / 75** (no truncation) |

### Accuracy (run `39950408855`, all 498 scorable Mini-Dev questions per arm)

Every arm is scored on the identical case set, every block an arm advertises is in the
prompt it received, and one arm is run twice so the table carries its own scale.

| Arm | Execution accuracy | 95% Wilson | prompt chars |
| --- | --- | --- | --- |
| names only | 35.9% (179/498) | [31.9, 40.3] | 1,862 |
| model-written definitions, as a block | 40.8% (203/498) | [36.5, 45.1] | 2,908 |
| the same text on the column line | 45.6% (227/498) | [41.3, 50.0] | 2,515 |
| **+ the dataset's per-question hint** | **58.0%** (289/498) | [53.7, 62.3] | 2,650 |
| + retrieved neighbours from the training split | 46.0% (229/498) | [41.7, 50.4] | 3,071 |
| + those neighbours as worked examples | 45.8% (228/498) | [41.5, 50.2] | 4,575 |
| + three samples, modal result | 57.2% (285/498) | [52.8, 61.5] | 2,650 (3 calls) |
| + three samples, chosen by the model | 57.8% (288/498) | [53.5, 62.1] | 2,650 (4 calls) |
| + five samples, chosen by the model | 58.8% (293/498) | [54.5, 63.1] | 2,650 (6 calls) |
| + values this database stores for words in the question | 59.0% (294/498) | [54.7, 63.3] | 2,681 |
| metadata + the hint (798 curated notes) | 58.6% (292/498) | [54.3, 62.9] | 6,967 |
| **the same arm twice (A/A)** | 57.8% (288/498) | [53.5, 62.1] | identical |

| Change (one lever) | Δ | only before / only after | p | verdict |
| --- | --- | --- | --- | --- |
| block → column line | +4.8pp | 22 / 46 | 0.005 | **real** |
| inline → + the dataset's hint | **+12.4pp** | 18 / 80 | <1e-4 | **real** |
| inline → + retrieved neighbours | +0.4pp | 21 / 23 | 0.88 | no effect |
| retrieved text → the same neighbours as statements | −0.2pp | 31 / 30 | 1.00 | no effect |
| + hint → three samples, modal result | −0.8pp | 13 / 10 | 0.68 | no effect |
| modal result → chosen by the model | +0.6pp | 13 / 15 | 0.85 | no effect |
| three candidates → five, same selector | +1.0pp | 12 / 16 | 0.57 | no effect |
| + hint → values this database stores | +1.0pp | 8 / 13 | 0.38 | no effect |
| **the same arm twice (A/A)** | **−0.2pp** | 6 / 5 | 1.00 | the scale |

Four runs of the identical pair now bracket the noise: **0.2, 0.6, 1.2 and 0.2pp**.
Nothing in this table clears it except placement (+4.8pp) and the dataset's hint
(+12.4pp), which are the two things the product already does.

### Selection looked real once, and did not replicate

Run `39945679683` made selection look like the one borrowed mechanism that worked:
+2.6pp over voting, 6 cases won and 19 lost the other way, p=0.015. Run
`39950408855` repeated the comparison and got **+0.6pp** (13/15, p=0.85). The
identical A/A pair in that second run differed by 0.2pp, so the replication is not
noise — the first result was.

| Run | select | vote | Δ | only before / only after | p | A/A in the same job |
| --- | --- | --- | --- | --- | --- | --- |
| `39945679683` | 59.0% | 56.4% | +2.6pp | 6 / 19 | 0.015 | 0.6pp |
| `39950408855` | 57.8% | 57.2% | +0.6pp | 13 / 15 | 0.85 | 0.2pp |

More samples did not rescue it either: `select5` (five candidates, six calls) reached
58.8% against 57.8% for three, +1.0pp at p=0.57. If the gain came from reading
candidates, two more of them would have helped.

The conclusion this project has to live with is the boring one: **on this harness, at
this sample size, nothing borrowed from the state of the art beat the dataset's
per-question hint.** The library still exposes `chooseCandidate` — it is a capability
with a measured cost (three extra calls) and no measured gain — and the policy below
now requires a second run before anything is called an improvement.

A mechanism is adopted only when it reaches p<0.01 in **two consecutive runs**, which
is stricter than the one-lever table needs and stricter than a single p=0.015
deserves. The alternative is a README that changes its mind every week.

### Two gold statements cannot be scored, and the reason is measured

The denominator is 498, not 500. Two Mini-Dev gold statements exceed the
harness's deterministic step budget (400M SQLite VM steps):

| Question | Database | Measured | Why |
| --- | --- | --- | --- |
| 701 | `codebase_community` | 227 s, 14.6B steps | join on `MAX(Reputation)` scans `posts` once per matching user |
| 518 | `card_games` | 39.7 s, 3.0B steps | joins the whole `legalities` table to `cards` before filtering on the top banned format |

Both are properties of the gold statement, not of the harness: they were measured
directly with Python's `sqlite3` and no oracle in the way. Scoring them as wrong
answers would be measuring the budget, and raising the budget to cover them would
add four minutes to every arm of every run for two cases. The artifact records the
exclusion (`gold.unrunnable`) and the summary prints it, so the sample is quotable
rather than quietly 498. BIRD's reference harness applies a 30-second wall clock,
which would exclude both as well — we differ in making the limit deterministic
instead of hardware-dependent.

### Voting cannot recover knowledge the model never had

Three samples per question at temperature 0.7, executed, and the modal result set
kept: **58.0% against 58.8%** for a single sample — −0.8pp, sixteen cases gained and
thirteen lost, p=0.71. The samples agreed with each other **91.1% of the time**.
Handing the same three samples to the model to choose between did no better
(−0.6pp, p=0.72) even though the selector returned a usable answer in 495 of 496
cases: a selector can only pick among the candidates it is given.

That agreement is the explanation. Voting helps when errors are random — it picks
the majority of draws around the right answer. Here the errors are systematic:
when the model does not know what "paid in EUR" means, all three samples make the
same wrong choice, and the majority is wrong three times instead of once. The
remaining gap is knowledge, and no amount of resampling creates it.

### The generated stack matches the curated one at a third of the prompt

`inline+evidence` reaches **58.8%** with a 2,617-character prompt.
`metadata+evidence` — 798 curated column notes plus the same hint — reaches
**58.0%** with 6,967 characters. The difference is −0.8pp, four cases, inside the
noise: the two are not separable, and this run puts the generated stack marginally
ahead, which is a different sentence from "the curated one is better".

That is the product claim this whole line of work was looking for: a database
without documentation can be brought to the accuracy of a database with it, by
generating definitions once per database and attaching them to the columns. What
it cannot do is replace the per-question hint: that is still worth +14.1pp.

### A model-written reading of the question buys nothing

Asking the model to restate what the question computes — measure, rows counted,
numerator and denominator — before writing SQL changed **exactly zero** cases:
17 fixed, 17 broken, p=1.0, and one extra call per question.

The reading is not wrong; it is redundant. The information it restates was already
in the prompt. What BIRD's hint supplies is knowledge the prompt does not contain —
which currency counts as "paying in EUR" — and restating a question cannot invent
it. This closes the "ask the model to think first" branch: the gap is knowledge,
not reasoning order.

### Who wrote the text does not matter; where it sits does

Run H adds the control the placement result needed: the dataset's own column
descriptions, truncated to exactly the columns the generated block reached (128
versus 143). Same placement, same columns covered, different author.

They are indistinguishable: **43.1% vs 41.8%**, one case each way, p=0.375. Curated
documentation buys nothing over generated documentation once both are attached to
the column, on the same columns.

Raising addressability from 36.8% (57 lines) to 92.3% (143 lines) also changed
nothing: the arm moved 42.3% → 41.8% while its prompt grew from 2,166 to 2,496
characters. Most of the effect comes from the first few dozen columns a question
might touch; the tail of rarely mentioned columns adds text, not accuracy.

### Placement, not content: three runs of the same sentences

| Run | block | inline | Δ | prompt (block → inline) |
| --- | --- | --- | --- | --- |
| G1 (`9120c2b`) | 33.1% | **43.5%** | **+10.5pp** (9/34, p=1.7e-4) | 2,819 → 2,166 |
| G2 (`148a621`) | 33.9% | **42.3%** | **+8.4pp** (12/32, p=0.0037) | 2,819 → 2,166 |
| H (`d5927b0`) | 35.1% | 41.8% | **+6.7pp** (11/27, p=0.014) | 2,819 → 2,496 |
| I (`700529b`) | 33.5% | **42.3%** | **+8.8pp** (10/31, p=0.0015) | 2,817 → 2,490 |

Same cached sentences, same model, same cases. The only change is where they sit:
attached to the column they describe instead of appended after the schema card.
Both runs clear the 6pp bar that the previous two attempts missed.

Two controls make this credible:

- **No dataset metadata leaked in.** The inline arm runs on a bare schema built
  with `withNotes: false`, so the only comments are the ones attached. The
  artifact records `inlineSchemaComments = 57` against 798 dataset columns. The
  first attempt at this arm did not do that, scored +9.2pp, and was thrown away:
  its prompt had grown from 2,819 to 7,395 characters, which was the tell that it
  had quietly re-enabled the metadata lever.
- **Only addressable lines survive.** 57 of 155 generated lines name a column and
  were attached; 98 were table-level or unplaceable and were dropped. The arm
  that scores +8.4pp is *shorter* than the block it replaces, so the gain cannot
  be a length effect.

On the adversarial face the inline arm scores **84.4% (27/32), equal to `names`**
and 12.5pp above full column metadata (71.9%). A per-column definition does not
cost what a full description card costs on window and ratio questions.

### What is still missing

The best arm remains `metadata+evidence` at 58.6%, and the dataset's own evidence
is still worth **+17.6pp** on top of any definition text. That is now the single
largest unexplained term in the pipeline, and it is question-level by
construction: BIRD writes one sentence per *question*, and nothing that is written
once per *database* has moved the number.

Two things are settled: the text can be generated instead of curated, and it has
to sit on the column. What is left is the per-question sentence.

### Noise floor: the same arm, twice, in the same job

Between-session drift is not hypothetical here, and it is now explained.
`synth-definitions` scored 36.5% in run `39790152728` and 41.6% in `39804736066`; the
artifact showed the stored definitions differing for 6 of 11 databases. The
provenance fields then said something more precise: across two later runs every
prompt hash was **identical**, and the same 6 databases were still `cached: false`.
The prompt never changed — the cache never hit, so the model rewrote those six
databases every run and returned different text at temperature 0.

The fix is not a better cache. Definitions are an **input** to every
definition-dependent arm, so they are frozen in `eval/baseline/definitions.minidev.json`
(11 databases, 11 KB) and read from there; `BIRD_DEFINITIONS_FORCE=1` regenerates and
prints what to commit. An arm whose input is regenerated on each run measures the
prompt and the input together, and no amount of pairing can separate them.

So every job now runs one arm twice (`BIRD_AA=inline+evidence`), reports the pair's
delta as `aa`, and the gate fails when the pair disagrees by more than the tolerance
it uses to judge regressions. Two runs so far: **0.6pp** (5 cases one way, 2 the
other) and **1.2pp**. That is the scale a delta has to clear before it means anything,
and it is why the one-lever table reports p values rather than rankings. The artifact also records, per database, the synthesis
prompt hash and whether the text came from cache (`controls.definitionsProvenance`):
that is the difference between "the input changed" and "the model answered
differently", and it was previously unobservable.

### Noise floor (why one sample per case is stated, not assumed)

60 stratified cases, three repeats each, arm `metadata+evidence`:

| Metric | Result |
| --- | --- |
| Cases that disagreed with themselves | **2 / 60 (3.3%)** |
| Majority accuracy | 45.0% |
| Single-run accuracy | 45.0% |
| Difference | **0.0pp** |

Single sampling does not bias the aggregate, but it does move individual cases.
The flip rate across runs is 8.3%, 3.3%, 1.7%, 6.7% — it moves, while the
single-run and majority scores never do. A single run's aggregate is stable; a
single case's answer is not. Deltas below 4pp are reported as "no measurable
effect" (ADR-166), and the +8.4pp above is reported with its pair counts so it can
be checked.

### Adversarial shapes (32 hand-written cases, reported separately)

An aggregate hides the shapes it is bad at. These 32 cases cover windows, ratios,
multi-hop joins and ties, each with a declared output width that the gold must
match — a question promising two columns and a gold returning three would fail
every correct answer.

| Shape | names | structural | **inline** | metadata | adaptive |
| --- | --- | --- | --- | --- | --- |
| window | 6/8 | 5/8 | 4/8 | 3/8 | 5/8 |
| ratio | 6/8 | 6/8 | 6/8 | 5/8 | 5/8 |
| multi-hop | **8/8** | 7/8 | **8/8** | **8/8** | **8/8** |
| tie | 7/8 | 7/8 | 7/8 | 7/8 | 7/8 |
| **total** | **81.2%** (26/32) | 78.1% (25/32) | 75.0% (24/32) | 71.9% (23/32) | 75.0% (24/32) |

On these shapes the inline arm never gains: across four paired runs it equals
`names` twice (84.4% / 81.2%) and trails by one and two cases twice (78.1% /
75.0% vs 81.2%). At n=32 a case is 3.1pp, so none of these is significant, but the
direction is consistently non-positive — a column's definition helps a filter and
adds nothing to a window. What is clear is the comparison with full metadata:
71.9% in every run, 6 to 9 points below the bare schema.

The two faces disagree in a way worth remembering: metadata is worth +11.3pp on
BIRD and −9pp here. A component's effect is a property of a question shape, not
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
11–21 extra cases per arm on all 498 cases. Both numbers are published so the choice
is visible instead of implied.

## Which split, and how many questions

The sample size was ours, not the dataset's: the runner defaulted to a 240-question
cap, which is where "239 of 500" came from. That cap is gone, and CI now scores the
whole split. Of the 500, **498 are scorable** — the two that are not, and why, are in
the section above rather than folded into a percentage.

| Split | Questions | Databases | Where it runs |
| --- | --- | --- | --- |
| Mini-Dev | **500** | 11 | every push (CI) |
| Dev | **1,534** | 11 | on demand (`bird-dev` workflow) |

Both archives are public (`bird-bench.oss-cn-beijing.aliyuncs.com`), both use the same
11 databases, and the dev split is the one published leaderboards report — so a
comparison with another system is a matter of running the workflow, not of arguing
about samples. What is still not comparable is the model and the prompting budget;
those are stated with every number instead of being implied away.

## Retrieved knowledge from the training split

The per-question hint in BIRD's dev split is worth 14pp and cannot be regenerated from
a schema. The training split is a legitimate substitute for *part* of it: 9,428
labelled questions across 69 databases, **none of which appears in the eleven
databases under test**, so nothing it contains can leak a gold statement.

`inline+retrieval` retrieves the three nearest training questions with BM25
(document-length normalised, because plain cosine ranked a four-word question above
the longer one that actually shared the construction) and injects their evidence
sentences — never their SQL, because a statement written for another schema is copied
verbatim into a "no such column" error.

One curation rule is measured rather than stylistic: evidence that states a
*definition* (`rate = count(meal = "free") / count(student)`) is preferred over
evidence that only maps a word to a literal (`free refers to lowest_price = 0`). The
second kind, retrieved for a question about free school meals, teaches a false
equivalence — it was visible in the first retrieved block we inspected.

The same neighbours are used twice, one lever apart:

| Arm | Block | Question it answers |
| --- | --- | --- |
| `inline+retrieval` | questions and evidence, **no SQL** | does the *phrasing* transfer? |
| `inline+icl` | the same three neighbours, each with its statement | does a *worked example* transfer? DAIL-SQL and CHASE-SQL are built on this |

`inline+icl` is paired with `inline+retrieval`; the delta prices the statements and
nothing else. The opening warning in that block says the tables are not the ones
above — a demonstration from another schema is a shape to imitate and an identifier
to avoid, and which one a model takes is the measurement. DAIL-SQL masks
schema-specific tokens instead; masking is a candidate lever once this one is known.

### Two ways an arm can be empty, and neither looks like a bug

The retrieval arms have now been measured three times and have not yet been
measured once. The failures are worth recording, because each produced a number
that read like a finding.

| Run | What was wrong | What the table showed |
| --- | --- | --- |
| `39784843750` | the training corpus was never downloaded (`retrievalCorpus: 0`) | `inline+retrieval` 44.4% vs parent 43.6% |
| `39790152728` | corpus present, but the **live prompt** was built by a different call site than the **measured prompt**, so the block reached the size metric and not the request | 44.0% vs 43.6%, and `inline+icl` −0.6pp against it |
| this run | one builder feeds both call sites; the arm chooses which blocks it uses | — |

The second one is the subtle one: `promptFor` took six optional positional
arguments, the size measurement passed all of them and the request passed two. A
prompt whose measured length and delivered content disagree is indistinguishable
from a model that ignored the block. The fix is structural rather than a sixth
argument: `promptFor(arm, question, blocks)` receives everything available and the
arm decides, so there is no call site that can forget a lever, and a test asserts
that the block the arm is supposed to use appears in the prompt that would be sent.

Three guards now exist, each at a different level:

1. the runner **throws** when an arm needs a block whose input is missing;
2. the artifact records `retrievedBlocks`, `demonstrationBlocks` and `valueMatches`,
   so an empty lever is visible in the numbers, not only in the log;
3. the gate fails when one of those is zero for an arm the baseline expects.

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

## The floor is enforced, not remembered

A benchmark that only produces a report gets read once. The BIRD arms have a
committed floor (`eval/baseline/bird.json`) taken from the minimum of the last four
runs, and the workflow fails when an arm lands more than 4pp below it — the same
4pp that ADR-166 measured as the noise threshold at n=239:

```bash
pnpm gate:bird
# BIRD floor: <n> questions, <arm> <accuracy>, …
```

Three details make the gate mean something:

- **the arm set is part of the check**: an arm in the baseline that vanishes from
  the report fails, because "we stopped measuring it" is not an improvement;
- **the sample size is checked first**: a report scored on fewer than 95% of the
  baseline questions is a different measurement, and comparing across it would
  attribute a dataset change to the pipeline;
- **the gate has a self-test** (`node tools/check-bird-baseline.mjs --self-test`)
  that plants a passing run, a noisy run, a 10pp regression, a missing arm and a
  shrunken sample. A gate nobody has seen fail is a gate nobody should trust.

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
