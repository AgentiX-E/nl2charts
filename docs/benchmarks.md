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

### Accuracy (run `40101482710`, all 498 scorable Mini-Dev questions per arm)

Every arm is scored on the identical case set, with pinned inputs and one arm run twice.

| Arm | Execution accuracy | 95% Wilson | prompt chars |
| --- | --- | --- | --- |
| names only | 35.7% (178/498) | [31.7, 40.0] | 1,862 |
| model-written definitions, as a block | 41.4% (206/498) | [37.1, 45.7] | 2,903 |
| the same text on the column line | 45.0% (224/498) | [40.7, 49.4] | 2,504 |
| **+ the dataset's per-question hint** | **57.4%** (286/498) | [53.0, 61.7] | 2,639 |
| + retrieved neighbours from the training split | 46.2% (230/498) | [41.9, 50.6] | 3,060 |
| + those neighbours as worked examples | 46.0% (229/498) | [41.7, 50.4] | 4,564 |
| **+ three diagnosed repairs** | 57.8% (288/498) | [53.5, 62.1] | 2,639 (1.03 calls) |
| + three samples, modal result | 56.8% (283/498) | [52.4, 61.1] | 2,639 (3 calls) |
| + three samples, chosen by the model | 58.6% (292/498) | [54.3, 62.9] | 2,639 (4 calls) |
| + five samples, chosen by the model | 58.4% (291/498) | [54.1, 62.7] | 2,639 (6 calls) |
| + values this database stores for words in the question | 58.2% (290/498) | [53.9, 62.5] | 2,670 |
| metadata + the hint (798 curated notes) | 59.2% (295/498) | [54.9, 63.5] | 6,967 |
| **the same arm twice (A/A)** | 57.2% (285/498) | [52.8, 61.5] | identical |

| Change (one lever) | Δ | only before / only after | p | verdict |
| --- | --- | --- | --- | --- |
| block → column line | +3.6pp | 25 / 43 | 0.039 | **real** |
| inline → + the dataset's hint | **+12.4pp** | 15 / 77 | <1e-4 | **real** |
| inline → + retrieved neighbours | +1.2pp | 19 / 25 | 0.45 | no effect |
| retrieved text → the same neighbours as statements | −0.2pp | 29 / 28 | 1.00 | no effect |
| + hint → three diagnosed repairs | +0.4pp | 2 / 4 | 0.69 | **not resolvable here** |
| + hint → three samples, modal result | −0.6pp | 14 / 11 | 0.69 | no effect |
| modal result → chosen by the model | +1.8pp | 7 / 17 | 0.064 | no effect |
| three candidates → five, same selector | −0.2pp | 16 / 15 | 1.00 | no effect |
| + hint → values this database stores | +0.8pp | 6 / 10 | 0.45 | no effect |
| **the same arm twice (A/A)** | −0.2pp | 3 / 2 | 1.00 | the scale |

The repair row is not a null result, it is an **unresolvable** one, and the funnel says why:

| `inline+repair` funnel | Value |
| --- | --- |
| first statement correct | 286 |
| ran once, executed, answered wrong | **200** |
| failed at execution, needed a repair | **12** |
| of those, ended correct | 2 |
| repairable share (the loop's ceiling) | **2.4pp** |

Twelve cases is the entire population the loop can touch on this benchmark with this model,
because 486 of 498 first statements execute. Two runs put the delta at −1.0pp and +0.4pp. No
498-question experiment can resolve 2.4pp, and the A/A pair moved 0.2–1.2pp on its own.

### Where the repair loop does have surface, it pays: +6.4pp

The same three arms on `glm-4-flash`, which writes far more invalid SQL, 249 questions
(deterministic endpoint: the A/A pair returned **0.0pp, 0 disagreements**):

| Arm | GLM-4-Flash | DeepSeek (same code) | execution failures |
| --- | --- | --- | --- |
| names only | 18.9% (47/249) | 35.7% | 53 (21.3%) |
| + the dataset's hint | 30.1% (75/249) | 57.4% | 91 (36.5%) |
| + three repairs carrying the **raw** engine error only | 35.3% (88/249) | — | 19 |
| **+ three diagnosed repairs** | **36.5% (91/249)** | 57.8% | **18 (7.2%)** |

**+6.4pp, sixteen cases won and none lost, McNemar p<0.0001**, at 0.63 extra calls per
case — about 10pp per extra call. Sixteen wins and zero losses is what the mechanism
permits: a case that never executed cannot be made worse by a repair, so the comparison has
one direction.

Measured twice, on the same 249 questions, with identical results down to the case counts
(47 / 75 / 91, 0/16, p<0.0001, A/A 0.0pp both times). That meets the adoption rule this
project set after the selection result failed to replicate — two consecutive runs at
p<0.01 — and it is the first mechanism since the per-question hint to clear it.

### The raw error message is where most of that gain already is

The repair turn always contained the engine's sentence verbatim; the diagnosis adds a class
instruction, the nearest schema identifier and a caret at the reported position. Whether
those additions earn their place was an assumption, so it was run as a control: the same
three retries, the same prompt, the same cost, with the engine's message and nothing else.

| Arm | GLM-4-Flash | Δ vs parent | repaired → correct |
| --- | --- | --- | --- |
| + raw engine error, three retries | 35.3% (88/249) | **+5.2pp** | 13 of 91 |
| + diagnosis, three retries | 36.5% (91/249) | **+6.4pp** | 16 of 92 |
| raw → diagnosis | | **+1.2pp** (3 won / 6 lost, p=0.51) | |

So **the raw error is worth 5.2 of the 6.4pp**, and the classification's increment is
+1.2pp — not separable at this sample (p=0.51, nine cases moved at all). That is a real
finding about where the value lives: telling a model *what the engine said* is most of the
job; telling it *which column exists* is a much smaller second helping, at 250 cases.

The diagnosis stays the default because it costs no extra call, and because its two
additions are the ones that matter on a schema the model has never seen — the benchmark's
eleven databases are the easy case, not the hard one. Its claimed gain, though, is
**+1.2pp unresolved**, not folded into the +6.4pp, and the six cases it lost to the raw form
are unexplained: nine cases moved in total, which is what a coin looks like at n=249.

The funnel explains both results at once:

| | GLM-4-Flash | DeepSeek |
| --- | --- | --- |
| repairable share | **36.9%** | 2.4% |
| repaired cases that ended correct | 16 of 92 | 2 of 12 |
| repaired cases still not executing | 19 | 0 |
| execution failures before → after | 91 → 19 | 9 → 0 |

So the honest claim is narrow and useful: **diagnosed repair removes most of a weak model's
execution failures and converts some of them into correct answers; on a strong model it has
almost nothing to work on.** It is a floor-raiser, not a ceiling-raiser — which is why it is
the wrong instrument for closing the 58%–72% gap and the right one for making a cheap model
usable.

Repair also repairs executability, not understanding: on DeepSeek all eight of the failing
repaired cases ended as statements that ran and answered the wrong question.

### Writing the plan first makes it worse

A plan written before the statement — scan, filter, join, group, answer — loses
**7.2pp** against the same arm without it: 63 cases broken, 27 fixed, p=0.0002. This
is the largest and clearest effect in the table after the two that help, and it points
the opposite way from the intuition (and from CHASE-SQL's second generator, which is
where the idea came from).

Two mechanisms are plausible and this experiment does not separate them: a plan commits
to a join or a filter before the column choice is constrained by evidence, so the SQL
inherits the plan's mistake instead of being free to be right; and the block adds ~40%
more prompt for a schema that was already fully described. The first would be visible
as "the plan is wrong on the cases it breaks" — that is the next measurement, not a
conclusion.

The arm is out of the default chain and stays in the catalogue with its result written
next to it, the same way a rejected hypothesis is kept.

### A check the engine cannot make: built, measured, rejected

A statement can execute and answer the wrong *shape*: "how many schools are in Los
Angeles" answered with 1,436 names is a clean query that no engine will complain about,
and the repair loop never hears about it because there is no error to feed back. The fix
that suggested itself was a deterministic guard — a regex over the question's phrasing
decides whether a scalar was asked for, and a result that is not one row by one column
becomes a repair turn.

It was built, wired into the repair loop and measured, and it loses:

| Arm | Accuracy | Δ vs parent | only before / only after | p | cases it rejected | repaired | still wrong |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `inline+repair` | 58.4% | — | — | — | 12 | 3 | 9 |
| `inline+shape` | 57.2% | **−1.2pp** | 11 / 5 | 0.21 | 35 | 5 | 30 |

The funnel says more than the delta does. 21 of those rejections were the guard's own
(`shape` class): 2 were fixed, 19 were not. And the cases it touched got *worse* in a
way the accuracy hides — wrong column counts rose from 49 to 63, because forcing a
multi-row answer into a scalar produces a different wrong answer rather than no answer.

The reading this project accepts is that the trigger, not the loop, is the weak part:
asking a regex to decide whether a question wants one value or a table is a guess with
poor precision on BIRD's phrasing, and each wrong guess costs a rewrite of an answer
that was already right. A shape check that earns its place would have to be one whose
false-positive rate is measured first — over the gold statements, before it is allowed
to touch a prompt.

The arm is out of the default chain and stays in the catalogue with its numbers, so a
better test can be measured against this one rather than against an intuition.

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

The next experiment had to answer a question this table could not: were the candidates
ever right? An arm that generates five statements and returns one reports a single
number, and 58.8% is compatible with both "the set never contained the answer" and "the
set contained it and the selector discarded it". The report now carries
`candidateRecall` — the share of questions where **any** candidate matched, which is the
ceiling every selector is bounded by — and `selectionLoss`, the questions in that set the
arm did not return. With the ceiling measured, `select-mixed` asks the other half of the
question: same three candidates, same selector, but drawn from three different prompt
styles instead of three samples of one. Three samples of one prompt agree 90% of the
time, so they buy calls without buying a second opinion; the mixed arm is what a second
opinion costs.

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

## What the prompt already contains: every identifier, on both splits

Before spending another call on a mechanism, one question is cheap to answer: does the model
see the columns the gold query needs? `pnpm bench:bird:recall` renders the prompt exactly as
the pipeline sends it, reads the gold statement for the tables and columns it names, and
checks which of them appear. No model, no database.

| Split | Questions | Prompts showing every gold identifier | Identifiers visible |
| --- | --- | --- | --- |
| Mini-Dev | 500 | **500 (100%)** | 3,820 / 3,820 |
| Dev | 1,534 | **1,534 (100%)** | 10,650 / 10,650 |

Every column of every table is already in the card — 199 columns for
`european_football_2`, 71 for `codebase_community` — because BIRD's schemas are small enough
that the forty-line card never truncates.

That result reprices a whole direction:

- **A better schema linker cannot add information here.** The identifiers are all present;
  the failures are choices among them. This is why every linking-adjacent lever measured
  zero, and why `no-linking` is not on the critical path.
- **The remaining gap is selection and reasoning**, not retrieval: which column, which join,
  which aggregation, which literal, and what the question meant. Those are the things a
  prompt cannot enumerate, which is consistent with every prompt-layer mechanism landing
  inside the noise.
- It also sets the ceiling for anything that adds text: a mechanism whose value is "more
  context" starts from 100% context.

The measurement is a CI step and fails the build if any prompt hides an identifier the gold
statement needs, because a truncation bug in the schema card would otherwise appear only as
a slow accuracy decline.

## The dev split, measured: 60.6% on the split leaderboards report

Two runs of the 1,534-question dev split (`40157122326`, `40166834512`), three arms,
`deepseek-chat`, 1,532 scorable:

| Arm | Dev run 1 | Dev run 2 | 95% Wilson (run 2) | Mini-Dev, same code |
| --- | --- | --- | --- | --- |
| names only | 42.2% (647) | 42.2% (646) | [39.7, 44.7] | 35.7% |
| **+ definitions + the dataset's hint** | 60.6% (929) | **61.0%** (935) | [58.6, 63.4] | 57.4% |
| metadata + the hint (798 curated notes) | 61.4% (941) | **61.5%** (942) | [59.0, 63.9] | 59.2% |

Two runs rather than one because the first is a measurement and the second says how much of
it is the draw: the arms land within 0.4pp of each other, which is what 1,532 questions buys
compared with 498.

Three facts about this number, in the order they matter:

1. **It is on the split the published leaderboards report**, so a comparison with another
   system is now a matter of running it rather than arguing about samples. Our 60.6% is
   `deepseek-chat`, one sample per case, no fine-tuning; the systems at 70–73% run GPT-4o
   class models with generated candidate pools.
2. **The dev split is easier than Mini-Dev by ~2pp per arm** with identical code. That is
   the dataset, not the pipeline: the two splits share eleven databases but not their
   questions. Quoting one where the other was measured would be a 2–3pp error, which is why
   both are stated.
3. **Two of 1,534 questions are excluded** for the same reason as on Mini-Dev (`701`, `518`
   exceed the step budget), so the denominator is 1,532.

The gate had to be fixed for this run: it applied Mini-Dev's thirteen-arm list to a
three-arm dev run and failed with six missing arms. `armsBySplit` now states each split's
own list, and a split without floors remains a measurement rather than a gate.

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

### Pricing a mechanism, not just measuring it

Every experiment in this file reports a delta and a paired test. That is necessary and not
sufficient: a mechanism that costs one extra model call per question for +2pp and one that
costs nothing for +2pp are different propositions, and a table of deltas cannot tell them
apart. Two numbers are added to every ablation for that reason:

| Column | Definition | Why it is there |
| --- | --- | --- |
| `extraCallsPerCase` | mean **counted** calls of the second arm minus the first | the price, in the unit the deployment pays |
| `ppPerExtraCall` | delta ÷ that price; **absent** when the price is zero | a free lever is not "infinitely efficient", it is free |

The price is counted at the provider, not inferred from the arm's configuration, and the
distinction is not academic. Two numbers in this table were wrong for a whole release
because they were inferred from a field that meant something else:

| Symptom in the report | What the field actually held | What the reader concluded |
| --- | --- | --- |
| `select5` — `repaired: 496` of 498 | samples per question, counted as repair attempts | the repair loop fixed almost everything |
| `select → select5` — `extraCallsPerCase: 0` | generations, which exclude the selector's own call | selection is free |

Both are now impossible by construction: `attempts` counts generations inside a repair
loop and nothing else, `repaired` is reported only by an arm that has one, and every case
records `calls` counted by `withCallCounter` around the provider. A case that forgets to
report its calls fails the build, and the gate rejects a sampling arm whose mean calls do
not exceed its sample count.

A repair arm also reports a **funnel**, because accuracy alone cannot say what the loop
did:

| Field | Meaning |
| --- | --- |
| `firstPass` | correct on the first statement, no repair involved |
| `ranOnceWrong` | ran once, executed, answered wrong — **no repair can reach these** |
| `repaired` | cases that failed at execution and needed at least one retry |
| `fixedByRepair` | of those, how many ended correct |
| `stillFailing` | of those, how many exhausted the budget or ended wrong |
| `repairableShare` | `repaired / total`: the loop's **ceiling**, in pp |
| `repairSuccessRate` | `fixedByRepair / repaired` |
| `byClass` | the first rejection's class, with how many of each were fixed |

The three buckets have to sum to the sample, and the gate fails when they do not — which
is how the first version of this funnel was found to be missing `ranOnceWrong`: it reported
285 first-pass plus 9 repaired out of 498, and the 204 cases that ran fine and answered
wrong were nowhere.

The `byClass` breakdown is the instrument for the next iteration: it says *which* mistakes
the loop can recover from. If most repairs begin as `binding` and most of those are fixed,
the diagnosis is doing its job; if they begin as `grouping` and none are fixed, the
instruction for that class is wrong, and that is a specific thing to fix rather than a
reason to add another mechanism.

A repair arm also cannot flatter itself by never running: the runner throws when a repair
arm needs no repair across 100 or more questions, because that is the parent arm with a
bigger budget — the same empty-lever failure the retrieval arm had.

### The model is a variable, not an opinion

Every prompt-layer mechanism tried here landed inside the noise, and one was
actively harmful. What remains between ~58% and the published 70–73% is the model and
the fine-tuning around it, so the model is measured the same way as an arm: identical
questions, identical pinned inputs, identical prompts.

> **Status: instrumented, blocked on quota.** The first attempt at another model
> (Zhipu `glm-4.5`) returned 429 on every call, at concurrency 2 with four retries, so
> the comparison is pending an account that answers. The run that produced numbers
> before the guard existed reported `names 4.6%`, which is what a throttled batch looks
> like when each refusal is scored as a wrong answer; that table is void and the guards
> below now refuse it.

```bash
# workflow_dispatch, or locally:
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4 \
LLM_MODEL=glm-4.5 \
LLM_API_KEY=$ZHIPU_API_KEY \
BIRD_ARMS=names,inline+evidence,values \
pnpm bench:bird
```

Three constraints keep the comparison honest:

1. **The key is passed as `LLM_API_KEY`, never as `DEEPSEEK_API_KEY`.** If the DeepSeek
   key were present, a misconfigured job would silently measure the wrong model and
   report it under the right name.
2. **No accuracy floor runs.** The floors in `eval/baseline/bird.json` were derived
   from DeepSeek runs; failing them on another model says nothing about either.
3. **The arm set is short by design.** A model comparison needs the parent chain
   (`names` → `inline+evidence`) and the best-known lever (`values`), not all twelve
   arms.
4. **A preflight runs first** (`pnpm eval:preflight`): one call, no retry, the endpoint
   and the status in the message. A wrong key, a wrong model name or a throttled account
   should cost thirty seconds, not an arm — and it must fail *before* the table is built,
   because a table built during a throttle is a table about the throttle.

### A weak model fails differently, and the difference is legible

`glm-4-flash` on 250 questions, same prompts, same pinned inputs:

| Arm | GLM-4-Flash (n=249) | DeepSeek (n=498) | SQL that would not execute |
| --- | --- | --- | --- |
| names only | 18.9% (47/249) | 35.9% (180/498) | **52 (20.9%)** vs 5 (1.0%) |
| + the dataset's hint | 30.1% (75/249) | 57.6% (287/498) | **91 (36.5%)** vs 11 (2.2%) |

The sample sizes differ, so the gaps are indicative rather than paired — but the
failure *mode* is unambiguous and is the point: the weak model's losses are mostly
statements that SQLite refuses (`near "Type": syntax error`, `no such column:
s.SchoolName`), not statements that run and answer the wrong thing. A model that cannot
bind a column is not going to be rescued by a better hint.

One consequence of the longer prompt is visible here and not in DeepSeek: the hint makes
`glm-4-flash`'s execution failures *worse* (20.9% → 36.5%). More context is not more
capability.

### The A/A pair is a property of the provider, not of the harness

The same run repeated `inline+evidence` and got **75/249 twice, with zero disagreements**
— a 0.0pp A/A. DeepSeek's identical pair moved 0.2–1.2pp across five runs.

So the noise floor published above is a **DeepSeek** number: it measures that provider's
nondeterminism at temperature 0, not a universal property of the harness. On a
deterministic endpoint the same harness is exactly reproducible, which means a 1pp
difference on such an endpoint would be real — and it also means an A/A pair is the only
way to know which kind of endpoint you are measuring on.

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
