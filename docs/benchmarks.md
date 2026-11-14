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

## Saturated smoke set: the live set has no ranking power

Kept in CI because it is cheap and it fails loudly when the pipeline breaks, not because its
numbers separate anything: every arm scores 100% on it. The section that used to carry the
capability reading is below for the record; the reading it publishes is a ceiling.

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
pnpm bench:bird:recall          # every gold identifier is in the prompt; no model
pnpm bench:bird:diagnose <report.json>   # classify the failures a run kept; no model
pnpm bench:bird:strata --arm A --against B   # split a pair by candidate independence; no model
pnpm bench:bird:losses --arm A               # attribute every selection loss to a source; no model
pnpm bench:bird:position --arm A             # stratify a shuffle arm by candidate slot, with intervals; no model
pnpm bench:bird:pool --artifact <report.json>      # the ceiling each candidate set offers; no model
pnpm bench:bird:consensus --artifact <report.json> # which selection rule kept the answer; no model
pnpm bench:bird:conditions <report.json> --arm A   # which gold condition the statement never wrote; no model
pnpm bench:bird:gate --artifact <report.json> --arm A   # what the question alone can find; no model
pnpm bench:bird:rewrite --artifact <report.json> --arm A # what a deterministic rewrite is worth; no model, re-executes
pnpm bench:bird:rewrite ... --oracle       # also price the ceilings, which read the gold statement
pnpm bench:bird:cache --artifact <report.json> --arm A # how much of the prompt repeats, and what that is worth; no model
pnpm bench:bird:pair <report.json> --pair A,B  # two arms, paired: gains, losses, exact McNemar, and what changed shape; no model
pnpm bench:bird:reasoning <a.json> <b.json> --arms A  # what the statements say, paired, with an interval; no model
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

### The ceiling, measured: selection is losing the points, not generation

Run `40181585037` added the instrument the selection experiments were missing — how often
the candidate set contained a correct statement at all — and the answer reorganises the
remaining work. Mini-Dev, 498 questions, deepseek-chat:

| arm | candidates | model calls | accuracy | candidate recall (ceiling) | cases lost by the selector | share of ceiling kept |
| --- | --- | --- | --- | --- | --- | --- |
| `vote` | 3, one prompt | 3 | 57.2% | 61.4% | 21 | 93.2% |
| `select` | 3, one prompt | 4 | 57.6% | 61.6% | 20 | 93.5% |
| `select5` | 5, one prompt | 6 | 59.2% | **64.7%** | 27 | 91.5% |
| `select-mixed` | 3, three prompts | 4 | **60.4%** | 63.7% | 16 | **94.8%** |

Three things follow, and they are not the three the prompt-layer work assumed:

1. **The ceiling is 61–65%, and the arms return 57–60%.** Between three and five points
   are sitting in candidate sets that were generated, executed, and not chosen. That is
   pure selection loss, and it is larger than any prompt-layer gain measured in this
   file except the dataset hint itself.
2. **Prompt diversity beats sampling diversity at two thirds of the price.** Three
   prompts (`select-mixed`) reach a higher accuracy than five samples of one prompt
   (`select5`) with two fewer calls: +1.2pp at 4 calls versus 6. Against `select` it is
   **+2.8pp** (10 won / 24 lost, McNemar p=0.024) at the *same* cost — the same three
   candidates, the same selector call, only their origin changed. Under ADR-184 that is
   not yet adoption (two consecutive runs at p<0.01); the arm stays in the chain and the
   next run is the second measurement.
3. **The selector, not the generator, is the next lever.** A candidate set that holds
   the answer 64.7% of the time and returns 59.2% is not short of candidates. It is
   picking badly.

Two measurement defects were found while reading this table, both of the same kind — a
number derived from a field that had been reused:

| Symptom | What the field really held |
| --- | --- |
| `select5` published `repaired: 496` of 498 | samples per question, counted as repair attempts |
| `select → select5` published `extraCallsPerCase: 0` | generations, which omit the selector's own call |

Both are fixed at the source (`attempts` now means generations inside a repair loop;
every case counts its calls at the provider), and the gate rejects either shape of lie
on the next run. It did, immediately: the first counted version still missed the
selector call, and the gate said so in one line before the run was published.

### The next experiment: compare two statements, not five

If the selector is losing three to five points, the question is what a selector should be
shown. The absolute prompt asks the model to hold every candidate in mind and emit one
number; CHASE-SQL's selector is a **binary** comparison instead — two statements in view,
one of two answers, nothing to anchor on.

`select-pair` is that shape and nothing else: the same three candidates `select` draws,
the same model, two comparisons instead of one ranking (1 vs 2, winner vs 3). It is one
lever from `select`, and its price is exactly `k - 1` calls, so the comparison stays a
comparison of mechanisms rather than of weights — the fine-tuning CHASE-SQL adds on top
is out of reach here and is not claimed.

A pairwise answer is read strictly: a reply that is not a bare `1` or `2` leaves the
incumbent in place and is counted in `selectorDecided`, because "the comparison did not
answer" and "the comparison preferred the first statement" are different facts and only
one of them is a preference.

It did not work, and the negative is informative (run `40186658774`):

| arm | calls | accuracy | candidate recall | cases lost by the selector |
| --- | --- | --- | --- | --- |
| `select` | 4.0 | 57.6% | 61.6% | 20 |
| `select-pair` | 4.9 | 58.4% | 63.5% | 25 |

+0.8pp at one more call per question (17 won / 20 lost, p=0.74), and it discarded *more*
of its candidate set than the absolute prompt did. The selector reads every candidate the
model wrote; giving it two of them and a binary question changes nothing about the
information it has, and it lost slightly more. So the absolute prompt is not where the
three points go — the pairwise shape is out of the default chain and stays in the
catalogue with these numbers.

The one thing that did move, twice, is the candidate *source*:

| run | `select` | `select-mixed` | Δ | only before / only after | p |
| --- | --- | --- | --- | --- | --- |
| `40181585037` | 57.6% | 60.4% | +2.8pp | 10 / 24 | 0.024 |
| `40186658774` | 57.6% | 60.4% | +2.8pp | 11 / 25 | 0.029 |

Two runs, same delta, same sign, at the same four calls, with the A/A pair in the second
run 0.2pp apart. That is not yet the pre-registered bar (p<0.01 in two consecutive runs,
ADR-184) — 498 questions cannot resolve a 2.8pp effect that finely — so the adoption
decision moves to the split where it can: the same two arms on the 1,532-question dev
split, which is also the split leaderboards report.

### Three runs of the same four arms, and the drift between them

The mixed arm has now run three times on the same 498 questions with the same code:

| run | `inline+evidence` (1 call) | `select` (4) | `select5` (6) | `select-mixed` (4) |
| --- | --- | --- | --- | --- |
| `40181585037` | 57.6% | 57.6% | 59.2% | **60.4%** |
| `40186658774` | 58.0% | 57.6% | 57.8% | **60.4%** |
| `40193372870` | 57.8% | 59.2% | 60.6% | **60.4%** |

Two facts matter more than any single delta here.

**The selector arms move between runs; the mixed arm did not.** `select` travelled 1.6pp
across runs that differ in nothing but the order the questions were answered in, and
`select5` travelled 2.8pp. `select-mixed` returned 301 of 498 in all three. A delta of
1.2–1.4pp between two selector arms is therefore inside the between-run drift of the arms
themselves, which is why the adoption decision for the mixed arm goes to the dev split
rather than to a fourth Mini-Dev run.

**The third candidate is not free, and it is not useless either.** `select-duo` — the two
prompts that always differ — came in at 58.4% (291/498), *below* `select`'s 59.2%
(−0.8pp, 17/13, p=0.58) and 2.0pp below the trio (4/14, p=0.031).

Two mechanisms can produce that, and this run does not separate them: the trio may win on
the 172 questions where `values` adds a genuinely different statement, or it may win
because on the other 326 it presents `{inline, inline, metadata}` — and a repeated
statement is a frequency signal to a selector reading a list. Separating them needs the
comparison stratified by whether the value block existed, which needs per-case outcomes
rather than per-arm totals; the report now carries per-case outcomes (`report.cases`), so the
next run can answer it instead of carrying two hypotheses.

### A third of the mixed arm's candidates were duplicates

The dry run builds the prompt each mixed source would send, without spending a call, and
counted how often the three are actually different:

| arm | sources | questions with every prompt distinct | degenerate |
| --- | --- | --- | --- |
| `select-mixed` | `inline+evidence` + `metadata+evidence` + `values` | 172/498 (34.5%) | **326 (65.5%)** |
| `select-duo` | `inline+evidence` + `metadata+evidence` | 498/498 (100%) | 0 |

The value block only exists when the question names a literal, and BIRD's questions
mostly do not — so on two questions in three, `select-mixed` pays three generations and
gets two opinions. Its +2.8pp came from the *difference between two prompts*, not from a
three-way vote.

`select-duo` is that pair on purpose: two sources, three calls, no duplicate by
construction. If it matches `select-mixed` it is the same accuracy for one call less, and
the difference prices what the value-grounded candidate was contributing (41 wins out of
498 in the first run).

The guard that found this started as a bug: it compared the three prompts on the *first*
question of the split, and the dev split's first question names no literal, so it declared
the arm broken and stopped a 1,532-question run at the dry-run step. A check that holds on
one split and not another is the same mistake as `armsBySplit` and the floor list — the
third time this project has made it — so it now measures the whole split and reports the
degenerate share instead of asserting on a sample of one.

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

**Revision (three runs later).** The −0.8pp above is one run's reading of that pair, and the pair has
now been read three times: 31/18, 28/15, 32/15 discordant, i.e. +2.62, +2.62 and +3.43pp, pooled
**+2.89pp ± 1.55** with Q p = 0.631 — `established` by the label rule, and in the opposite direction to
the paragraph above. It is **not** written up as a product claim yet, because the only dev reading of
the same pair says the opposite: +0.07pp, 65:66, p = 1.0000 on 1,532 questions (`41296610389`). Mini-Dev
is 496 of those questions, and the two intervals do not overlap, so either the effect sits in the
subset — the other 1,036 questions would have to be −1.28pp — or the two runs differ in a coordinate
nobody recorded. Until one of those is excluded, `metadata+evidence` and `inline+evidence` are
"not separated on dev and separated by 2.9pp on Mini-Dev", which is a statement about a corpus and not
about a stack.

### The dev coordinate table, and what four calls buy

The five arms the dev workflow runs had never been measured in one run. `41085194983` ran three of
them, so every comparison against the other two borrowed an anchor from a different run — which is
how a paired test stops being paired. `41296610389` runs all five on the 1,532 scored questions of
the public split, with `deepseek-chat` at concurrency 8, in about an hour:

| arm | passed | accuracy | calls | prompt tokens | selector loss |
| --- | --- | --- | --- | --- | --- |
| `names` | 642/1,532 | 41.91% | 1 | 522 | — |
| `inline+evidence` | 936/1,532 | 61.10% | 1 | 676 | — |
| `metadata+evidence` | 937/1,532 | **61.16%** | 1 | 1,778 | — |
| `select` | 934/1,532 | 60.97% | 3.99 | 2,443 | 72 |
| `select-mixed` | 955/1,532 | **62.34%** | 3.99 | 2,447 | **23** |

| pair | delta | discordant | p | MDE | 95% CI |
| --- | --- | --- | --- | --- | --- |
| `names` → `inline+evidence` | **+19.19pp** | 45:339 | <0.0001 | 3.58pp | [16.68, 21.70] |
| `inline+evidence` → `metadata+evidence` | **+0.07pp** | 65:66 | 1.0000 | 2.09pp | [−1.40, 1.53] |
| `inline+evidence` → `select` | **−0.13pp** | 41:39 | 0.9111 | 1.64pp | [−1.27, 1.01] |
| `metadata+evidence` → `select` | **−0.20pp** | 75:72 | 0.8690 | 2.22pp | [−1.75, 1.36] |
| `select` → `select-mixed` | **+1.37pp** | 32:53 | **0.0295** | 1.69pp | [0.19, 2.55] |
| `inline+evidence` → `select-mixed` | **+1.24pp** | 14:33 | **0.0079** | 1.25pp | [0.36, 2.12] |
| `metadata+evidence` → `select-mixed` | +1.17pp | 63:81 | 0.1563 | 2.19pp | [−0.36, 2.71] |

Four readings, and none of them needs a second opinion:

1. **The card and the hint are worth 19.19pp.** `names` sends the column names with no types, no
   keys and no hint; adding them moves 339 cases one way and 45 the other. It is the largest lever
   in this repository and the third independent run to measure it, this time on a split that can
   resolve it (MDE 3.58pp).
2. **The curated notes and the generated definition block are the same thing here too.** +0.07pp,
   65:66, p=1.0, on a split whose MDE is 2.09pp. The −0.8pp that Mini-Dev reported was noise. The
   product claim — a database with no documentation can be brought to the accuracy of one that has
   it — now has a power test behind it instead of a null result.
3. **Four samples of one prompt buy nothing.** `select` sends the same prompt three times and then
   pays a fourth call to choose; on dev that is −0.13pp against a single call (p=0.911) and
   −0.20pp against the curated card, for 3.6 times the tokens. The four-call tier's *sampling* is
   pure cost.
4. **Four aimed candidates do buy something.** `select-mixed` sends three different prompts and
   pays the same fourth call: +1.37pp over `select` (p=0.0295, CI excluding zero) and +1.24pp over
   a single call. The mechanism is in the last column: **the selector's loss falls from 72 to 23**
   when the candidates come from different angles. What the fourth call buys is not more candidates
   but different ones.

The one comparison that does not reach its criterion is `metadata+evidence` → `select-mixed`, at
+1.17pp (63:81, p=0.156, MDE 2.19pp): it compares the strongest single call with the strongest
four-call arm, and those two disagree on 9.4% of the split, three times the discordance of the
`select` → `select-mixed` pair (5.5%) and four times the `inline+evidence` pair (3.1%). Resolving
1.17pp at that rate needs more questions, not a different split.

Where that leaves the published number: **62.34% on BIRD dev**, which is this repository's highest
reading and the coordinate the leaderboard table compares. The earlier dev figure quoted for the
same arm — 63.0% — is 0.66pp above this run, inside the harness's own A/A movement; the difference
between two runs of one arm is not a reading, which is the reason the five arms were finally put in
one run.

### The two information sources, on one card for the first time

Two blocks on this corpus have been priced separately and never together:

- **what a column means** — 798 curated notes, or a generated definition block. The two are not
  separable from each other (−0.8pp, four cases), and the generated one is what ships because it
  is a third of the prompt.
- **which literal a column holds** — `values`, the strings the question names looked up in the
  database. Worth **+2.82pp** (p=0.039) over a card with neither source.

`metadata+evidence+values` is those two on one prompt: the notes stay on the column lines and the
value block is appended, so the pair against `metadata+evidence` is one lever — the block — on the
strongest single-call card in the corpus (58.9-59.2% on Mini-Dev, 61.5% on dev).

It is the arm that separates two very different next moves:

- **complements** — the arm lands above `metadata+evidence`, and the largest remaining bucket (the
  166 failures that run cleanly, return rows and answer the wrong question) contains statements
  whose literal was on the card and whose *meaning* was the problem, which is a prompt-content
  finding to keep working on;
- **substitutes** — the arm lands within noise, and the +2.82pp `values` bought was the gap the
  generated definition block also filled. That would say the 166 are knowledge the card already
  carries and the model is not using, which points at the reading of the card rather than at more
  text on it.

```bash
BIRD_ARMS=metadata+evidence+metadata+evidence+values pnpm bench:bird   # Mini-Dev, ~1,000 calls
```

### The measurement: the two sources are substitutes, not complements

`41302183201` ran the pair and the A/A on the 496 scored questions, one call an arm:

| arm | passed | accuracy | prompt tokens | card |
| --- | --- | --- | --- | --- |
| `metadata+evidence` | 291/496 | 58.67% | 1,718 | 6,974 chars |
| `metadata+evidence+values` | 297/496 | **59.88%** | 1,725 | 7,005 chars |
| `metadata+evidence` (A/A) | 291/496 | 58.67% | 1,718 | 6,974 chars |

| pair | delta | discordant | p | MDE | 95% CI |
| --- | --- | --- | --- | --- | --- |
| parent → parent + value block | **+1.21pp** | 6:12 | **0.2379** | 2.40pp | [−0.47, +2.89] |
| parent → parent | 0.00pp | 5:5 | 1.0 | 1.79pp | [−1.25, +1.25] |

**+1.21pp, six cases one way and twelve the other, inside a 2.40pp MDE.** The second of the two
pre-registered outcomes is the one that happened: the value block adds nothing measurable once the
curated notes are on the card, so the +2.82pp that `values` is worth against a card with *neither*
source was filling the gap the notes also fill.

Two details keep this from being a wash. The block is cheap — **+7 prompt tokens and +31 characters
a question**, because it only spells the literals the question itself names — so the null is not a
cost story, and the arm did render the block (the rendered prompt is 31 characters longer on
average, and the wiring test pins that both blocks reach one prompt). And the A/A is exact this
time: the same arm twice scored the same 291 cases, which is a noise floor of zero on the count and
a 1.79pp MDE on the difference — the cleanest control this harness has produced.

What survives is the sentence the prediction attached to this branch: **the 166 remaining failures
are knowledge the card already carries and the model is not using.** More text on the prompt is not
the next lever, and the lever that is left is how the card is read.

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

Single-sample arms sit at 57–59% and the best multi-sample arm at **60.4%**; its own
candidate set contains a correct statement 63.7% of the time. So the largest remaining
term is no longer the prompt — it is the three points between "the set has the answer" and
"the system returns it", and beyond that the four points between the set and the published
70–73%.

Two things are settled: the text can be generated instead of curated, and it has to sit
on the column. The dataset's own per-question hint is still worth **+17.6pp** on top of any
definition text, and nothing written once per *database* has moved that number.

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

The measurement renders the prompt with `buildAskMessages`, the builder the pipeline itself
calls, rather than re-deriving the schema card and the linking hint beside it. The earlier
version did the latter and had already drifted: it appended no hint at all when the linker
matched nothing, while the pipeline sends `No column matched; use the schema above.` — so for
those questions the ceiling was measured on a prompt nothing sends (ADR-218). The run also
names any database in the split that `dev_tables.json` does not describe, because a
completeness rate over an unstated subset is the kind of number this repository has had to
withdraw before, and writes `eval/out/recall-<split>.json` with its own verdict inside it
(`passed`, `problems`, `measured`, `skipped`) before it can fail.

## What kind of wrong the failures are

Scoring tells you an arm lost; it does not tell you what to build. `pnpm bench:bird:diagnose
<report.json>` reads an artifact that kept its failing statements, executes each one against
the database the run used, and classifies it as `error`, `empty`, `row-count`,
`column-count`, `scale` or `values`, plus the literals the prediction leaves out. It costs no
model call, so it runs over every failure rather than a sample, and it writes
`eval/out/diagnosis-<split>.json` so two runs can be diffed instead of retyped.

Two facts belong with the table and are now printed beneath it. The first is the **drops**:
a failure whose question id is not in the questions file, one whose prediction is empty, and
one whose *gold* statement the engine refused cannot be classified, and a shape share computed
over the survivors is not a shape share for the run. The second is the **literal miss** — the
share of failures that omit a value the gold statement names — because that distinguishes "the
filter was wrong" from "the model never saw the value", and only the second is a reason to
build value grounding.

The measurement is a CI step and fails the build if any prompt hides an identifier the gold
statement needs, because a truncation bug in the schema card would otherwise appear only as
a slow accuracy decline.

## The half of the score that is not the selector

`candidateRecall − selectionLoss = passed` is an identity, not an approximation: an arm's
accuracy is the product of a candidate set and a selector that picks from it. Every ablation
this project has run acts on the second factor, and the second factor is 4.6pp wide. The
first factor is 34pp wide, and it had no instrument until `pnpm bench:bird:gap <report.json>`.

The tool reads the artifact, spends no model call and no database, and classifies every
question whose candidate set held no answer by the shape of its failure — `engine-refused`
(the statement never ran), `column-count` (it ran and returned the wrong number of columns:
grain), or `values` (right width, wrong numbers: filters, aggregation level, literals). It
then prints how many of those cases the artifact kept a statement for, because a
classification needs the statement and the retention cap is per failure rather than per
question.

Two runs, read with it:

| split / run | arm | no answer | engine-refused | column-count | values | classified |
|---|---|---|---|---|---|---|
| dev `40865112253` | `select-cross` | 523 (34.1%) | 15 (2.9%) | 120 (22.9%) | 388 (74.2%) | 100% |
| dev `40865112253` | `select-cross-shuffled` | 520 (33.9%) | 18 (3.5%) | 121 (23.3%) | 381 (73.3%) | 100% |
| Mini-Dev `40878610004` | `select` | 184 (36.9%) | 3 (1.6%) | 40 (21.7%) | 141 (76.6%) | 100% |
| Mini-Dev `40878610004` | `select-mixed` | 204 (41.0%) | 8 (3.9%) | 49 (24.0%) | 147 (72.1%) | 100% |

The reading is stable across splits, arms and vendors of candidate: **about three quarters of
the questions no candidate answered are `values`, and about a quarter are `column-count`**.
`engine-refused` is under 4% everywhere, so "the engine would not take the statement" is not
the missing 34pp — the statements ran, and the numbers were wrong.

The first run of the tool also found a defect in the instrument rather than in the model:
**687 of the 1,043 no-answer cases in that artifact had no retained statement**, so the oracle
could not be asked why the numbers were wrong for two thirds of the set the iteration exists
for. The retention cap was 200 per arm and is now above the largest split, which makes the
corpus a census for both splits and leaves `truncated` empty.

The gate reads `candidateRecall` beside accuracy. The floors are the minimum observed across
six Mini-Dev runs and four dev runs, enforced with the same 4pp tolerance, because a score can
be bought with a shrinking candidate set and the accuracy column cannot see the trade: on
Mini-Dev `select-mixed` carries a 58.8% ceiling against `select`'s 61.6% and returns 57.8%
against 56.0%, which is a real purchase at a named price and would be invisible without a
column of its own.

## The wrong numbers, by the clause that is wrong

The `values` bucket is the largest column in the failure table and the least actionable sentence
in the project: *the statement ran, the width matched, the numbers were wrong.* `pnpm
bench:bird:gap:values <report.json> --arm <name>` reads the retained statements and files every
case under the clause a fix would change. It costs one oracle query per case and no model call.

There are thirteen causes, and they are ordered by the strength of the evidence rather than by
how often they occur:

| cause | what was measured | the fix it names |
|---|---|---|
| `no-statement` | the model returned nothing | generation |
| `filter-narrow` | the statement returned no rows | a predicate that matches nothing |
| `filter-wide` | a different number of rows | a weak predicate or a fan-out join |
| `scale` | every value a constant multiple | an aggregation at the wrong level |
| `literal-missing` | a *value* the gold compares against is absent | what the prompt shows about values |
| `literal-case` | the value is there, in another case | the stored casing of the value |
| `tables` | the two statements read different tables | join selection |
| `predicate` | same tables, different conditions | condition coverage |
| `aggregate` | different aggregate calls | which function answers the question |
| `grain` | different `group by` | the aggregation level |
| `projection` | different select list, in order | which columns, in what order |
| `window` | different `order by` / `limit` | which window of the same rows |
| `equivalent` | the statements are one statement | the engine broke a tie |

The ladder stops at the first part that differs, because that is the part a fix would change: a
statement that joined an extra table also has different conditions, and reporting both would put
one case in two work items and neither in the queue first.

Two runs, on two splits and two arms:

| cause | dev `select-cross` (`40908325901`) | Mini-Dev `select`, re-read |
|---|---|---|
| `filter-wide` | 88 (22.2%) | 24 (18.5%) |
| `predicate` | 76 (19.2%) | 29 (22.3%) |
| `literal-missing` | 70 (17.7%) | 23 (17.7%) |
| `tables` | 61 (15.4%) | 22 (16.9%) |
| `filter-narrow` | 53 (13.4%) | 22 (16.9%) |
| `no-statement` | 17 (4.3%) | 3 (2.3%) |
| `aggregate` | 11 (2.8%) | 0 |
| `projection` | 10 (2.5%) | 4 (3.1%) |
| `literal-case` | 6 (1.5%) | 2 (1.5%) |
| `window` | 2 (0.5%) | 0 |
| `grain` | 1 (0.3%) | 0 |

> The two columns above were taken before `literal-missing` was narrowed to values. Every
> `literal-missing` count in this document from v9.45 on reads the narrower test, under which the
> dev arm holds 31 rather than 70–72 — see *A bucket that was named after the wrong cause*. The
> older numbers are left as they were measured; a table is a record of an instrument, not a
> statement that the instrument was finished.
| `scale` | 0 | 0 |
| `equivalent` | 0 | 0 |
| `unclassified` | 1 (0.3%) | 1 (0.8%) |
| **named** | **99.7%** | **99.2%** |

**The reading contradicts the hypothesis.** More than half of the bucket — 213 of 396 on dev —
reads a different table or applies different conditions. Another 76 writes a value the gold never
names. The aggregation-level story, which the first version of this taxonomy led with, accounts
for one case out of 396: these statements are not wrong about arithmetic, they are wrong about
which tables join, which rows qualify, and which literal values go in them.

That has a direct consequence for where the next iteration goes. The 34pp candidate-set gap is not
closed by better prompting about aggregates or by repair loops; it is closed by showing the model
how the tables relate and which values the columns actually hold. Six of the literals are the right
word in the wrong case — `'Directly funded'` against `'Directly Funded'`, which SQLite compares as
different values — and no amount of reasoning recovers that, because the schema card names columns
and not their contents.

The tool also caught two defects in itself before any of these numbers were trusted. Its first run
scored **72.1%** and refused to publish; **86 of the 139** unattributed cases were cases the judge
had filed under `column-count`, which this tool has no business splitting — a statement with the
wrong width has a projection finding and no clause reading improves on it. The denominator is now
the parent tool's bucket. The remaining 53 were real gaps, and eight of them are now named causes,
each with the sentence pair that produces it in the test suite.

`--strict` turns the coverage bar into a failure. The quality gate runs it; the dev workflow does
not, because a split that covers 72% of a new corpus is a finding about the taxonomy and not a
regression in the product.

### The reader behind the table read a value with a quote as two values

The Mini-Dev column above is one case moved from an earlier reading, and the reason is a defect
in the reader rather than in the corpus. `literals()` found values with `/'([^']*)'/g`, which turns
`'Ancestor''s Chosen'` into `'Ancestor'` and `'s Chosen'` — two values, neither of which exists.
Any prediction that wrote the value correctly was then reported as missing both, so the taxonomy
named `literal-missing` on a case whose literal was present. 19 dev questions and 8 Mini-Dev
questions carry a value with an apostrophe, so the shape was not hypothetical.

The reader now uses the same scanner the repair stage edits with. Re-measured, Mini-Dev 1068
leaves `literal-missing` for `predicate`: its gold writes `strftime('%Y', date) >= '2010'` and its
prediction writes `cast(strftime('%Y', date) as integer) >= 2010`, so the value is named and the
difference is an affinity question rather than a value nobody retrieved. One case of 130, and the
one the old reader had misattributed.

The same pass stopped reading the digits of a value as a second literal — `where year = '2020'`
names one value, not a value and the number 2020 — and taught `missingLiterals` to compare
`'18'` with `18` as one value. Both change what the report *names*; between them they moved one
case of 130, which is the honest size of the defect.

## Two cases, and a gold query that is wrong

The taxonomy above says the biggest part of the bucket is conditions and tables. It also says
six dev cases are one value away: the question says "directly funded", the column stores
`Directly Funded`, and SQLite compares them as different strings. That is the only entry in the
table a *text edit* could close, so it is the only one worth a tool.
`pnpm bench:bird:repair <report.json> --arm <name>` offers every no-answer statement one edit —
substitute the single stored spelling that equals the literal ignoring case — and reports what it
recovers and what it would break.

The second half is what makes the first publishable. Applied to everything, the edit rewrites one
gold statement in the dev split:

```
dev 640, codebase_community
  stored:  users.DisplayName = 'mornington'
  gold:    users.DisplayName = 'Mornington'
```

BIRD's reference statement compares a value in a case the table does not store. Its answer is
therefore the answer to a filter that matches nothing — and a model that writes the *correct*
statement is judged wrong on that question. The repair, applied unconditionally, "fixes" the
gold, which is exactly how a repair breaks a case that passes.

So the edit is gated on a statement that returned no rows, and the gate is a property of the
corpus rather than a heuristic: `controls.emptyGoldExcluded` is 0 in both splits — no question has
an empty gold answer — so a statement that returns nothing is already failing, and editing it
cannot turn a pass into a failure. Measured both ways, on the 1,532 scorable dev questions:

| | ungated | gated on an empty result |
|---|---|---|
| gold statements edited | **1** of 1,534 (`640`) | **0** of 1,534 |
| no-answer statements offered | 515 | 70 |
| rewritten | 13 | 5 |
| **fixed** | 6 | **2** |
| still wrong | 7 | 3 |
| refused by the engine | 0 | 0 |

The ungated column is the reading that killed the lever in the form it was proposed in: six
recoveries against one edit to the reference answer. The gated column is safe and worth
**+0.13pp** — two cases, which no paired test at n = 1,532 can distinguish from zero (the
minimum detectable effect is 1.27pp). It is not adopted, and the reason is arithmetic rather
than doubt about the mechanism: of the 70 statements that returned nothing, only 5 compared a
value the column stores in another case, and 3 of those five were wrong for a second reason too.

The instrument is kept and gated anyway, for two reasons that outlive the lever. The absolute bar
it enforces — a statement edit must touch no gold statement — is the check any future repair has
to pass before it can be believed, and it is the check that found dev 640. And the gold-literal
defect it exposed is a property of the benchmark that changes how `literal-case` should be read:
the case-correct statement is not always the rewarded one.

One probe was considered and is not there. `select distinct` would be the obvious way to test
whether `filter-wide` is a fan-out multiplying rows, and it cannot be: BIRD's judge compares
result *sets*, so duplicates are already collapsed and `distinct` is a provable no-op on the
metric. The 88 `filter-wide` cases are different rows, not repeated ones.

## The coverage axis that has variance: what the prompt would have had to say

`pnpm bench:bird:recall` answers the question the prompt-coverage entry started from, and it
answers it completely: 500 of 500 Mini-Dev questions and 3,820 of 3,820 gold identifiers are
visible in the prompt the arms send. An ablation on that axis would compare a hundred per cent
with a hundred per cent, because the card advertises every table and column the split asks about,
in both splits and in every arm that carries the card.

The axis one level down is not saturated. Whether a *value* a gold filter compares against is
spelled anywhere in the prompt is a different question, and it has a distribution behind it:

| class | what it means | Mini-Dev `select`, 184 no-answer cases |
|---|---|---|
| `spelled` | every value the gold compares against is in the prompt, as the gold spells it | 111 (60.3%) |
| `casing` | the value is there, in another case | 8 (4.3%) |
| `notation` | the value is there, in another notation | 6 (3.3%) |
| `absent` | the value is not in the prompt in any form | 4 (2.2%) |
| `none` | the gold compares against no string value at all | 55 (29.9%) |

**Three fifths of the failures had every value in front of the model.** 111 of 184 no-answer
cases compared against values the prompt spelled exactly; the prompt was not the reason they
failed, and no prompt-side lever can add information that is already there. The addressable set —
`casing` plus `notation` plus `absent` — is **18 cases, 9.8%**, and that is the ceiling for showing
stored values, before any question of whether a model then uses them.

That ceiling explains a number from two iterations ago that had no explanation at the time. The
`inline+evidence+samples` arm measured +1.31pp at p = 0.052 and was set aside as unresolved; on
500 questions 1.31pp is 6.5 cases, and this instrument says at most 18 were reachable. The lever
had headroom for about a third of its ceiling and delivered that third. It was not a lever without
headroom, which is how a null at p = 0.052 is usually read.

Crossed with the clause taxonomy, the 18 addressable cases are not spread evenly — and the
shape of that spread is the useful part:

| bucket | `spelled` | `none` | `casing` | `notation` | `absent` | cases |
|---|---|---|---|---|---|---|
| `filter-narrow` | 9 | 4 | 3 | 4 | 2 | 22 |
| `literal-missing` | 13 | 6 | 1 | 1 | 2 | 23 |
| `tables` | **17** | 5 | 0 | 0 | 0 | 22 |
| `predicate` | 14 | 15 | 0 | 0 | 0 | 29 |
| `filter-wide` | 13 | 11 | 0 | 0 | 0 | 24 |
| `projection` | 4 | 0 | 0 | 0 | 0 | 4 |
| `literal-case` | 0 | 0 | 2 | 0 | 0 | 2 |
| `no-statement` | 1 | 2 | 0 | 0 | 0 | 3 |
| `column-count` (not in the taxonomy) | 38 | 12 | 2 | 1 | 0 | 53 |

Two readings, both of which change what the next lever should be:

- **`tables` and `predicate` hold no addressable case at all** — 31 of their 51 cases are `spelled`
  and the other 20 compare against no string. A value-grounding lever cannot move them, and the
  identifier axis cannot either (100% visible), so their failure is in how the join is chosen and
  how the condition is expressed. That is a different lever from this one and it can be measured
  separately.
- **`filter-narrow` holds half the addressable set** — 9 of 18. That is the bucket whose statement
  ran and returned nothing, which is exactly the symptom of a predicate comparing against a value
  the column does not store in that form. Two thirds of the addressable cases are in the bucket
  whose signature the lever predicts, which is a stronger check on the classification than the
  class shares are.

One denominator detail, found while building this cross-tab and recorded rather than fixed:
**the Mini-Dev question file carries questions 137 and 138 twice**, so 500 rows are 498 unique
questions and the `select` arm's `total` of 498 is 496 unique questions with two rows counted
twice. The cross-tab above totals 183 for that reason. The effect on a rate is 2/498 = 0.4%,
below what the split can resolve, but the fix is not free: deduplicating moves every published
Mini-Dev denominator and the floors calibrated on them, so it belongs in one deliberate change
with a recalibration rather than folded into a feature commit. It is queued as such.

Two qualifications, because the classes are narrower than "the model knew":

- **Class is about spelling, not about knowing where the value goes.** A value can be in the
  prompt — in the evidence, in a definition, in a column description — and still be attached to
  the wrong column by the model. `spelled` says the prompt was not the constraint; it does not say
  the case was answerable.
- **Three kinds of literal are out of scope**, each for its own reason: the right-hand side of
  `like`/`glob`/`match` is a pattern the statement derives from the question, anything containing
  `%` is a strftime mask, and numbers are excluded because an age written as `18` may be computed
  from "underage" rather than retrieved. What remains is the stored-value question, which is the
  one a sample answers.

The instrument renders the prompt rather than approximating it: the split's questions, the bare
card `buildSchema` produces with `withNotes: false`, the definitions the artifact recorded under
`controls.synthesizedDefinitions`, and the runner's own `promptFor`. The two ways it could end up
measuring a prompt nobody sent are failures and not caveats — an artifact that dropped a
database's definitions, or an arm whose prompt needs a block the artifact does not keep — and
both are absolute zeros, which is what makes `--strict` a gate rather than a threshold. Zero
model calls, zero queries, no oracle.

The taxonomy above is unchanged by this instrument, and the one case that *did* move is the reader
defect described in the section before this one: Mini-Dev 1068 was filed under `literal-missing`
by a reader that compared spellings, and is a `predicate` difference in fact.

## What a question costs to ask, and what a smaller card would save

The prompt had never been priced. Every round so far measured what the prompt *says* — which
identifiers it shows, which values it spells — and none measured what it *costs*, so the token
work in the plan had no data under it. `pnpm bench:bird:card <report> --arm <name> [--strict]`
answers it with zero model calls: it rebuilds the two messages the pipeline sends, with the
split's own questions, the bare card, the definitions the artifact recorded, the runner's
`promptFor` and the pipeline's own `buildAskMessages`, and charges every character to the block
that spent it.

Mini-Dev, `select`, 496 questions at 3.99 calls each:

| block | characters per call | share |
|---|---|---|
| rules | 274 | 9.6% |
| **schema card** | **2,121** | **74.1%** |
| context (evidence) | 135 | 4.7% |
| the linker's hint (user turn) | 133 | 4.6% |
| question | 90 | 3.2% |
| **total** | **2,864** | |

Eleven thousand four hundred characters per question, because an arm that samples spends four
calls on the same card. **Three quarters of every call is the schema card**, and the card is the
whole database: 7.3 tables per case, where the gold statement reads 2.1 of them. 41.6% of the
card's characters belong to a table the gold never mentions, so a linker that never erred would
remove **58.4% of the card** — roughly two fifths of the prompt, on every call, four times a case.

That is a ceiling, not a plan. Two numbers say why:

| | no gold table kept | some kept | every gold table kept |
|---|---|---|---|
| shipped recallers (`name`, `alias`, `value`) | **86 (17.3%)** | 176 (35.5%) | 234 (47.2%) |
| with the table recaller | **9 (1.8%)** | 185 (37.3%) | 302 (60.9%) |

### The linker could not see a table name

The left column of that table is a defect, not a tuning result. `linkSchema` scores *columns*,
and its name recaller tokenizes the column's name, so the table half of every identifier was
invisible: asked "how many customers are there", it looked for a column whose name contains
"customers", found none — `customer_id` contains `customer` and `id` — and returned an empty
list. One case in six. In BIRD that is the common shape of a question, because the entity is
named and the columns are not: *"what is the ratio of customers who pay in EUR"*, *"who had the
least consumption in LAM"*.

The fix is a fourth recaller that reads table names, with a plural allowance and a four-character
floor so that `orders` is not matched by `or`. It is **opt-in**: adding it to the default set
would have changed the hint every measured arm sends, and every accuracy number in this document
would then describe a prompt nobody had run. The pipeline gained a `recallers` option so the
recaller is reachable at all — a recaller nobody can select is dead code — and the default still
resolves to the three the arms were measured with.

What comes out: no table at all falls from 86 cases to 9, and full coverage rises from 47.2% to
60.9%. Not enough to prune with. 194 cases would still lose a table they need, and the residue is
not noise — it is the join partner the question never names (`gold customers, yearmonth`, kept
`yearmonth`). A card that omits it cannot be written correctly, so the next step is a join
closure over the linked tables, which is the table-relation entry in the plan and not a card
tuning exercise. That closure is measured in the next section: it ends the 86 and reaches 95.2%,
and the saving it leaves is 15.1% of the prompt rather than 58.4%.

### A CTE is not a table

The table above said 46.4% and 60.5% until the join instrument needed the same reading. `goldTables`
lowered every `from` and `join` reference, and BIRD's statements define tables of their own:
`with time_in_seconds as (...), champion_time as (...) select ... from champion_time` contributed
three names the card cannot show, so those cases could never be `all` no matter what the linker did.
Five of the 496 do it. Excluding them moves the shipped set to 234 (47.2%) and the candidate set to
302 (60.9%); the 58.4% ceiling does not move, because a CTE has no characters on the card. The
predicate lives in `statement.ts` beside the scanner, and it matches a *definition*
(`name as (select`) rather than a `with`, because a statement with two CTEs would otherwise have
only its first one recognised.

### Two instruments that were measuring someone else's prompt

Both were found while building the above, and both are recorded because the class of error is the
one this file keeps rediscovering: a measurement of a prompt nobody sent.

1. **`bench:bird:info` measured the system message.** It called `buildSqlPrompt` and stopped;
   the model receives `buildSqlPrompt`'s output *and* a user turn carrying the linker's hint and
   the question again. Re-measured through `buildAskMessages`, the five classes are unchanged —
   111 `spelled`, 8 `casing`, 6 `notation`, 4 `absent`, 55 `none` — because the hint lists
   identifiers and the classes are about values. Zero cases moved, and the correction still
   matters: a file whose header promises the prompt that was sent has to measure it.
2. **`renderableArm` accepted an arm whose evidence is retrieved.** The check exists so that an
   instrument never invents a block the artifact does not keep, and it listed the synthesized
   hint, matched values, worked examples and decompositions — but not retrieval, although the
   artifact keeps only a count of the retrieved blocks. `inline+retrieval` came back renderable,
   `promptFor` then dropped the evidence without saying so, and an instrument would have reported
   the result as the prompt that was sent. No gate ran that arm, which is why the hole survived;
   it is refused by name now, and the check lives with the arm definition in `run.ts` rather than
   in one instrument.

## What a question names, and what its answer joins

The card measurement ended on a residue rather than a conclusion: 194 cases lose a gold table with
the best linker this repository has, and the missing table is the join partner the question never
names. `pnpm bench:bird:join <report> --arm <name> [--strict]` asks whether the foreign keys reach
it. Zero model calls, the same shape as the card instrument: the tables the linker names are the
seeds, the graph is breadth-first walked to a stated depth, and the result is compared with the
tables the gold statement reads.

Two decisions are what make the reading usable. The edges come from `dev_tables.json`'s
`foreign_keys`, which are column indices — parsing the `"a.x = b.y"` hints the card renders would
have measured a string format. And every case has two character counts: one for narrowing it, one
for narrowing it only when the closure provably holds every gold table, with the whole card sent
otherwise. The second is the only one a deployment can bank, so it is a column rather than a
footnote.

Mini-Dev, `select`, 496 questions, 2,122-character card:

| edges | recallers | hops | kept tables | chars | saved | **safe** | gold all | some | none | finished | no seed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| declared | shipped | 0 | 3.7 | 1,348 | 36.5% | 15.8% | 304 | 176 | 16 | 0 | 70 |
| declared | shipped | 1 | 5.9 | 1,762 | 17.0% | 14.6% | 463 | 33 | **0** | 159 | 70 |
| declared | shipped | 2 | 6.8 | 2,029 | 4.4% | 4.1% | 485 | 11 | 0 | 181 | 70 |
| declared | +table | 0 | 2.9 | 1,178 | 44.5% | 24.2% | 305 | 185 | 6 | 0 | 3 |
| **declared** | **+table** | **1** | **5.7** | **1,768** | **16.7%** | **15.1%** | **472** | 24 | **0** | 167 | 3 |
| declared | +table | 2 | 6.7 | 2,007 | 5.4% | 5.1% | 485 | 11 | 0 | 180 | 3 |
| +shared columns | +table | 1 | 6.2 | 1,868 | 12.0% | 11.2% | 481 | 15 | 0 | 176 | 3 |
| +shared columns | +table | 2 | 7.0 | 2,078 | 2.1% | 2.1% | **496** | **0** | 0 | 191 | 3 |

`finished` is the number this instrument exists for: cases whose seeds miss a gold table and whose
closure has all of them. One hop finishes **167** of them, ends all six cases that kept nothing, and
leaves 24 that keep part of the gold — down from 185. The depth that fixes coverage is not free:
two hops with a shared-column graph reaches **every** gold table for **every** case and saves
**2.1%**, because the closure has become the card. The plan's prune experiment is therefore pinned
at one hop with the declared keys, where the ceiling is 95.2% coverage and **15.1% of the prompt**
— 2,122 → 1,802 characters, which is 20% of the card.

### The manifest does not declare its own joins

`debit_card_specializing` declares **one** foreign key. Its gold statements join four tables on
`CustomerID` and `GasStationID`, and eight of the eleven cases that two hops still cannot finish are
in that database. The second edge source is the join the manifest forgot: a column name two tables
share (`GasStationID`, `gas_station_id` — flattened so spelling does not matter). It is measured as
its own block rather than merged, because more edges means more reach and less saving, and the two
numbers are 472 → 481 cases for 15.1% → 11.2% saved. That trade is the reason the declared graph is
the recommendation: it is a fact about the dataset, and a saving measured on invented edges is a
saving measured on a graph nobody ships.

The guard on the second source is the interesting part. A shared column is evidence only when it is
not vocabulary: `year`, `name` and `id` appear in most tables of most databases, and connecting every
table that carries one makes the closure the whole card. A name carried by more than a third of a
database's tables is dropped, with a floor of two so that a three-table database keeps its keys.

### Two things the closure taught the linker

Neither was the experiment, and both change how the numbers should be read.

1. **The table recaller is not a superset of the shipped set.** Adding a fourth recaller changes the
   reciprocal-rank fusion, so columns near the twelve-slot cutoff move. Case 1057
   (`european_football_2`, *"average home team goal in the country of Poland"*) keeps `country` with
   the shipped recallers and loses it with the candidate set, while the totals move the other way by
   nine cases. `candidate` is a different linker, not a larger one — a report that called it an
   extension would mis-read every per-case delta computed from it.
2. **Seventy cases have no seed at all with the shipped recallers.** A question like *"how many
   percent of female heroes were published by Marvel Comics"* names no column and no table the
   linker can see, so the closure has nowhere to start and the case falls back to the whole card.
   The table recaller cuts that to three; the remaining three name nothing at all in the schema's
   vocabulary, which is a different failure and not one a graph can fix.

The prune arm itself is not in this section because it is not a measurement — it is a change to the
prompt, and a prompt change needs an accuracy reading rather than a character count. What this
section establishes is the shape of the rule rather than its settings: seed from the question, expand
one hop, send the whole card when the seed is empty. The arm has since been run and read against its
parent in *The card as a join closure: what it saves, and what it costs*. It ships the shipped
recallers rather than the table recaller, so that the card is the only thing that differs between the
two arms, which also moves the fallback count from the 24 this block priced to the 70 of the arm.

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

## The dev split with candidate selection: 63.0% (run 40202780469)

Six arms on the 1,532 scorable dev questions — the split the published leaderboards
report — with the same model and the same pinned inputs:

| arm | candidates | model calls | execution accuracy | candidate recall (ceiling) | cases the selector lost |
| --- | --- | --- | --- | --- | --- |
| `names` | — | 1 | 42.0% (644) | — | — |
| `inline+evidence` | 1 | 1 | 60.6% (928) | — | — |
| `metadata+evidence` | 1 | 1 | 61.8% (946) | — | — |
| `select` | 3 samples of one prompt | 4 | 61.3% (939) | 65.1% | 59 |
| `select-duo` | 2 prompts | 3 | 61.8% (947) | 63.8% | 31 |
| **`select-mixed`** | 3 prompts | 4 | **63.0% (965)** | 65.6% | 40 |

The paired tests, on 1,532 questions rather than 498:

| comparison | Δ | only before / only after | McNemar p |
| --- | --- | --- | --- |
| `inline+evidence` → `select` | +0.7pp | 38 / 49 | 0.28 |
| `inline+evidence` → `metadata+evidence` | +1.2pp | 38 / 56 | 0.079 |
| `inline+evidence` → **`select-mixed`** | **+2.4pp** | 23 / 60 | **0.0001** |
| `select` → `select-mixed` | +1.7pp | 34 / 60 | 0.0095 |
| `select-duo` → `select-mixed` | +1.2pp | 13 / 31 | 0.0096 |

Three conclusions that only appear at this sample size:

1. **Selection over three samples of one prompt is not worth four calls.** +0.7pp, p=0.28.
   The Mini-Dev runs said the same thing at lower resolution and it now holds on the split
   people quote.
2. **Three prompts and a selector is worth four calls.** +2.4pp over the single sample at
   p=0.0001, and the best number this project has measured on any split.
3. **The value-grounded candidate is not worth a call of its own**: `select-duo` reaches
   61.8% with three calls and loses to the trio by 1.2pp (p=0.0096), so the third source
   earns its call only inside the trio — consistent with the Mini-Dev finding that two
   thirds of its candidates are duplicates.

### The second run, and the adoption

Run `40245630669` repeated the same six arms:

| arm | run 1 (`40202780469`) | run 2 (`40245630669`) | mean | Δ between runs |
| --- | --- | --- | --- | --- |
| `names` | 42.0% (644) | 41.8% (641) | 41.9% | 0.2pp |
| `inline+evidence` | 60.6% (928) | 60.7% (930) | 60.6% | 0.1pp |
| `metadata+evidence` | 61.8% (946) | 61.4% (941) | 61.6% | 0.3pp |
| `select` | 61.3% (939) | 61.0% (935) | 61.1% | 0.3pp |
| `select-duo` | 61.8% (947) | 61.6% (944) | 61.7% | 0.2pp |
| **`select-mixed`** | **63.0% (965)** | **62.9% (963)** | **62.9%** | 0.1pp |

| comparison | run 1 | run 2 |
| --- | --- | --- |
| `inline+evidence` → `select-mixed` | +2.4pp, p=0.0001 | +2.2pp, p=0.0002 |
| `select` → `select-mixed` | +1.7pp, p=0.0095 | +1.8pp, p=0.0046 |
| `inline+evidence` → `select` | +0.7pp, p=0.28 | +0.3pp, p=0.65 |

Two consecutive runs, both at p<0.01, +1.7 and +1.8pp — which is the bar ADR-184 sets. So
**`select-mixed` is adopted**: three prompt styles and a selector is the recommended
multi-call path, at four calls per question, and the dev floors now include it (62.5%,
tolerance 4pp) so a regression fails the build rather than becoming a paragraph.

At 1,532 questions the arms repeat within 0.3pp, so the remaining differences are real:
selection over three samples of one prompt is worth nothing (+0.3 to +0.7pp, p=0.28 and
0.65), and two prompts are worth less than three (+1.2pp for the third, p=0.013 across
both runs).

## Raising the ceiling: a second model as a candidate

The adopted arm holds a correct statement 65.6% of the time and returns 62.9%: 2.6pp is
the selector, and the rest of the distance to the published 70–73% is the candidate set
itself. More samples do not raise it — five samples of one prompt hold 65.5% and three
hold 65.1%, and they agree 90% of the time because they make the same mistakes.

`select-cross` changes one thing about the adopted arm: its first candidate comes from a
**second model**, same prompt, same count, same four calls. It is declared as
`inline+evidence@second` in the source list, and the harness refuses to run it when no
second model is configured, naming the missing variable, because an arm that promises
three opinions and generates two is a price that cannot be audited.

The claim under test is narrow: sampling one model buys paraphrases, a second model buys a
different set of mistakes, and only the second can lift the ceiling a selector is bounded
by. It is measured against `select-mixed`, one lever apart, on the dev split.

## A second model raises the ceiling; the selector keeps the gain

Run `40283047123`, the same six arms on the dev split with `select-cross` added — the
adopted trio whose first candidate is written by **GLM-4.5** instead of deepseek-chat:

| arm | calls | accuracy | candidate recall (ceiling) | cases the selector lost |
| --- | --- | --- | --- | --- |
| `inline+evidence` | 1 | 60.8% (931) | — | — |
| `metadata+evidence` | 1 | 61.4% (941) | — | — |
| `select` | 4 | 61.8% (946) | 65.3% | 55 |
| `select-mixed` | 4 | 62.4% (956) | 65.3% | 44 |
| **`select-cross`** | 4 | **63.5% (973)** | **67.8%** | 66 |

The mechanism did what it was built to do: **the ceiling moved 2.5pp**, from 65.3% to
67.8%. A second model does not paraphrase the first one's mistakes the way a resample does.
The GLM candidate was the one returned on 339 of 1,532 questions (22%), which is a real
share rather than a tie-breaker.

The net gain is +1.1pp over `select-mixed` (23 won / 40 lost, p=0.043) — below the
pre-registered p<0.01 bar, so **not adopted**. The reason is visible in the same table: the
selector's loss grew from 44 cases to 66 while the set gained 38 answers. A candidate set
that holds more right answers and returns fewer of them is telling you where the next work
is, and it is not the generator.

That is the sixth mechanism in this file whose negative reading is more useful than its
positive one would have been.

### The second run, and the ceiling as a paired test

Run `40305717702` repeated the six arms:

| arm | run 1 | run 2 | candidate recall, run 1 | run 2 |
| --- | --- | --- | --- | --- |
| `select` | 61.8% (946) | 61.3% (939) | 65.3% | 64.2% |
| `select-mixed` | 62.4% (956) | 62.9% (963) | 65.3% | 65.7% |
| `select-cross` | **63.5% (973)** | **64.1% (982)** | **67.8%** | **67.0%** |

`select-cross` is ahead in both runs (+1.1pp, p=0.043; +1.2pp, p=0.0094) and so is its
ceiling. The ceiling is now a paired outcome, which is the only way to state it honestly —
comparing two shares across arms is the mistake that produced half the retractions in this
file:

| ceiling comparison, run 2 | left held | right held | only left / only right | McNemar |
| --- | --- | --- | --- | --- |
| `select-mixed` vs `select` | 65.7% | 64.2% | 46 / 23 | p≈0.006 |
| **`select-cross` vs `select-mixed`** | **67.0%** | **65.7%** | **31 / 10** | **p=0.0015** |

So a second model raises the ceiling, and the raise survives a paired test.

The third run (`40322733605`) settled the accuracy question, and not in the cross arm's
favour:

| run | `select-cross` | `select-mixed` | Δ | p | ceiling |
| --- | --- | --- | --- | --- | --- |
| `40283047123` | 63.5% | 62.4% | +1.1pp | 0.043 | 67.8% vs 65.3% |
| `40305717702` | 64.1% | 62.9% | +1.2pp | 0.0094 | 67.0% vs 65.7% |
| `40322733605` | 63.7% | 63.1% | +0.6pp | 0.30 | 67.7% vs 65.9% |

Three runs, one at p<0.01, one almost, one at p=0.30. The ceiling moved every time — 67.0
to 67.8 against 65.3 to 65.9, a stable +1.3 to +2.5pp — and the accuracy did not follow it
consistently: +1.1, +1.2, +0.6. So `select-cross` is **not adopted**, and the honest summary
is that a second model reliably improves the *material* the selector works from while the
net effect on the answer stays around one point with a wide run-to-run spread.

That is a different statement from the one the ceiling table invites, and it is the one the
data supports.

### The question the duplicate count left open

The stratified table answers it. If the trio's gain came only from the 172 questions where
`values` adds a distinct statement, questions where its third candidate duplicates the
first would show nothing:

| stratum (run 2) | questions | `select-mixed` | `select` | won / lost |
| --- | --- | --- | --- | --- |
| third candidate distinct | 599 | 64.6% | 63.1% | 22 / 13 |
| third candidate a duplicate | 933 | 61.7% | 60.1% | 31 / 16 |

The gain is present in both strata, so it is not the third candidate's *distinctness* that
carries the arm: a set of three prompts beats three samples of one prompt even when two of
its members are the same statement, which is consistent with `select-duo` (two prompts)
scoring below the trio. What a duplicate buys is not a second opinion but a different
prior — and that is now a measured statement rather than a hypothesis.

## Telling the selector where a candidate came from

The cross arm lost 22 more cases to its selector than the mixed arm did, with a candidate
set that held 38 more answers. One difference is visible in the same run: the selector sees
three SQL strings and nothing about their origin, so a value-grounded statement and a
second model's statement look like two statements, and the only tie-breaker left is style.

`select-tagged` is `select-cross` with each candidate prefixed by its source — one lever,
one field of information, the same question to the same selector. It exists because this
project's own rule (ADR-194) says a change of *information* is where the gains have come
from and a change of *wording* is where they have not: the labelled prompt keeps every rule
of the unlabelled one, so what is measured is whether knowing the origin helps.

## Labelling the candidates did not help, and the numbers say why

`select-tagged` is `select-cross` with each candidate prefixed by its source — one lever, one
field of information, the same question to the same selector. Run `40375082259`, seven arms,
1,532 questions:

| arm | calls | accuracy | candidate recall | cases the selector lost | share of ceiling kept |
| --- | --- | --- | --- | --- | --- |
| `inline+evidence` | 1 | 60.6% (929) | — | — | — |
| `metadata+evidence` | 1 | 61.4% (940) | — | — | — |
| `select` | 4 | 62.1% (952) | 65.5% | 51 | 94.9% |
| `select-mixed` | 4 | 63.3% (969) | 65.5% | 35 | **96.5%** |
| `select-cross` | 4 | 63.3% (969) | 66.8% | 54 | 94.7% |
| **`select-tagged`** | 4 | **63.7% (976)** | **67.1%** | 52 | 94.9% |

The pre-registered criterion for this arm was that its selection loss fall from about 54 to
about 45. It fell to 52. `select-tagged` is +0.46pp over `select-cross` (26 won / 33 lost,
p=0.43) — not adoption, and not the mechanism working: the labels did change the selector's
preference (the second model's candidate was returned 329 times against 296), but not its
accuracy.

### The number that explains five runs

Split every arm's questions by whether its candidate set contained a correct statement:

| pair | questions the better set alone held | of those, returned | questions both held | returned by the better set | by the weaker set |
| --- | --- | --- | --- | --- | --- |
| `select-tagged` vs `select-mixed` | 37 | **18 (49%)** | 991 | 958 | 960 |

**Half.** When the second model contributes a correct statement the all-DeepSeek set did not
have, the selector finds it about half the time — and on the questions both sets held, the two
arms return the same answers (958 against 960). That is the whole of the second model's
effect: +2.4pp of ceiling converted at 49%, which is +0.2 to +1.2pp of accuracy depending on
the run.

It also explains a pattern that has held across five dev runs: returned accuracy sits at
63.0–63.7% while the ceiling moves between 65.3% and 67.8%. The selector keeps 94.7–96.5% of
whatever it is given, and the percentage falls as the set improves — a better set contains
more statements that *look* right.

### What that changes about the next experiment

Two attempts to improve the selector by changing what it is asked and what it is told have
now failed. The remaining free option is not to ask the model at all: aggregate the same three
candidates by **modal result**, which costs no fourth call and cannot be talked into a
plausible wrong answer.

`vote-mixed` is `select-mixed` with the aggregator swapped, one lever; `vote-cross` is the
same swap on the cross-model set. Three diverse candidates agree less often than three samples
of one prompt, so the majority is weaker here — and on questions where two candidates are the
same statement, the duplicate acts as a prior, which the stratification already measured. The
arms report `agreement`, so a weak majority is visible rather than inferred.

## What a perfect router would be worth, and why it is not enough

Seven arms answered the same 1,532 questions in run `40409600418`. Counting the questions at
least one arm got right gives the upper bound for any router over this catalogue — and the
questions no arm got right are what only new generation can fix:

| questions | count | share |
| --- | --- | --- |
| every arm right | 560 | 36.6% |
| six of seven right | 313 | 20.4% |
| two to five right | 133 | 8.7% |
| exactly one right | 60 | 3.9% |
| **no arm right** | **466** | **30.4%** |
| **union** | **1,066** | **69.6%** |

Two readings, both useful:

1. **A perfect router is worth +6.3pp** over the best single arm (63.3% → 69.6%), and it would
   land *below* the published 70–73%. So routing is not the path to the leaderboard, however
   well it is done.
2. **Thirty per cent of the questions are out of reach of every configuration in the
   catalogue** — not of every model, but of these prompts, these candidate sets and these six
   models' worth of calls. That is where the remaining distance lives, and it is a generation
   problem, not a selection one.

The union also cross-checks the ceiling instrument: 69.6% is exactly what `vote-cross`'s
candidate set contained. A candidate set can only be as good as the statements the model
writes, and the best set here is as good as the best arm — no better.

## Counting votes is not free: it costs 1.8pp

`vote-mixed` is `select-mixed` with the aggregator swapped — the same three candidates, the
same count of generations, one call fewer. Run `40409600418`, dev split:

| arm | aggregator | calls | accuracy | candidate recall | cases lost | kept |
| --- | --- | --- | --- | --- | --- | --- |
| `inline+evidence` | — | 1 | 60.5% (927) | — | — | — |
| `metadata+evidence` | — | 1 | 61.4% (941) | — | — | — |
| `select` | model, 3 samples | 4 | 61.1% (936) | 64.7% | 55 | 93.0% |
| `vote-mixed` | modal result | 3 | 61.5% (942) | 65.5% | 62 | 94.1% |
| `vote-cross` | modal result | 3 | 62.9% (963) | **69.6%** | 104 | 90.2% |
| **`select-mixed`** | model, 3 prompts | 4 | **63.3% (969)** | 65.8% | 39 | **96.1%** |

`select-mixed → vote-mixed` is **−1.76pp** (49 won / 22 lost, p=0.0018). The fourth call is
not overhead: it buys 1.8 points of judgement that counting does not provide.

The interesting arm is `vote-cross`, which reaches the **highest candidate ceiling measured in
this project — 69.6%** — with three calls, and returns 62.9%. The stratified conversion says
why:

| pair | questions the left set alone held | returned by left | questions the right set alone held | returned by right | both held | left | right |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `vote-cross` vs `select-mixed` | 65 | **14 (21.5%)** | 6 | 4 (66.7%) | 1,002 | 94.7% | 96.3% |
| `vote-mixed` vs `select-mixed` | 5 | 0 (0%) | 9 | 7 (77.8%) | 999 | 94.3% | 96.3% |

Sixty-five questions where the cross set alone held a correct statement, and modal voting
returned fourteen. The reason is structural, not statistical: the cross set is **one GLM
statement and two DeepSeek statements**, so on those questions the two DeepSeek candidates
agree with each other and outvote the correct one. A majority cannot prefer a minority, and
this candidate set makes the second model a permanent minority.

That is the same asymmetry the model selector shows — 47% conversion of the cross-exclusive
answers — one step more extreme, and it is the first time this project can name the mechanism
rather than the symptom: **whoever wrote two of the three candidates wins the tie**. The next
two experiments test that directly by moving the judge and by balancing the authorship.

## An asymmetry the selector shows, and the experiment that separates two causes

The same artifact that rejected the labels contains a sharper fact. Pairing the cross arm with
the mixed arm question by question, and splitting by *which* set held a correct statement:

| set that alone held the answer | questions | returned by its own arm | rate |
| --- | --- | --- | --- |
| `select-cross` (the statement the **second** model wrote) | 34 | 16 | **47.1%** |
| `select-mixed` (all statements from the primary model) | 15 | 13 | **86.7%** |

Both arms use the same selector — the primary model. When the correct candidate is one the
primary model wrote, the judge returns it 87% of the time; when it is one the second model
wrote, 47%. On questions both sets held, the two arms agree almost exactly (96.4% and 96.7%
of 989), so this is not a difference in difficulty between the two sets' shared cases.

Two explanations fit, and they imply different work:

1. **Self-preference in the judge.** LLM judges are known to favour text that resembles their
   own generations. The judge here is one of the authors, so its own statement looks more
   natural even when wrong.
2. **Oddity of the second model's correct answers.** If GLM's correct statements are
   structurally unusual, they are genuinely harder to recognise — no bias required.

`select-cross-judge` separates them with one lever: the same three candidates, the same
selector prompt, the same four calls — only the judge changes, to the second model. Under
self-preference the asymmetry flips (the second model then under-selects the primary model's
answers); under oddity it does not move.

The criterion is registered before the run, as usual: **if the asymmetry flips, the judge is
the variable and the next step is a judge that is neither author; if it does not, the second
model's answers are simply harder and the cross arm's 47% stands as a property of the material
rather than of the judge.**

## A wrong answer that announces itself

Every mechanism measured so far needed a threshold to decide whether it had fired: the shape
guard guessed from row and column counts and cost 1.2pp doing it; the repair loop can only act
on a statement the engine refused; a schema linker has a top-k. There is one signal on BIRD
that needs no threshold at all.

No question in either split has an empty gold result — `controls.emptyGoldExcluded` is 0 in
every report — so a predicted statement that returns zero rows is wrong, by construction and
not by convention. The precision of the signal is 1.0, which no other signal in this project
has. The open question is its *reach*, and that is measurable without spending a call:

| what the artifact holds | value |
| --- | --- |
| failing statements sampled per arm in the last dev artifact | 25 |
| of those, statements that ran and returned no rows | 8–10% per arm, 10.3% over 175 |
| of those, statements the engine refused | 2.3% |

So roughly one failure in ten says so out loud. That is a small share of 37% failures but an
unusually cheap one: the fix costs one call only on the cases where the winner came back empty,
which is 8% of them, not 100%.

### The lever, and its control

`select-mixed+empty` differs from the adopted arm by one thing: an empty result is a failure.

1. A candidate that returned nothing is dropped before the selector votes. This costs no call.
   An option that cannot be right has no reason to be on the list, and offering it lets a
   tie-break land on it.
2. When every candidate is empty there is nothing to drop, so one turn is spent: the model is
   shown the statement it wrote and told that it ran and returned no rows, with the three
   causes that produce that on a schema it has just read — a literal that is not stored the way
   the question spells it, a join that removed every row, a condition stricter than the
   question.

`select-mixed+empty-blind` keeps the drop, spends the same call on the same cases, and says
nothing about the result. A pair of arms that differ only in those words separates *the model
learned something* from *the model rolled the dice again* — and the second is a real
possibility here, because the arm samples at temperature 0.7 and a second draw is not nothing.

The turn is budgeted apart from repairs. A statement the engine refused and a statement the
question refused are different failures, and one counter would make the cost of each
unreadable.

### What is registered before the run

- **Adoption** follows ADR-184 unchanged: `select-mixed+empty` above `select-mixed` with
  p<0.01 in two independent dev runs.
- **The control decides the story, not the result.** If `+empty` beats `+empty-blind` the
  information is the lever; if they tie, the second draw is, and the arm is a resampling arm
  pretending to be a diagnosis.
- **A loss has one suspect.** Dropping candidates cannot remove a right answer, but it does
  show the selector a shorter list, which can change what it picks among the rest. If the arm
  loses, `emptyRetry.dropped` is the count to look at first.
- **The lever must fire.** An arm that names the mechanism and never invokes it is an error in
  the report, not a 0.0pp finding — the same rule the repair funnel has had since an arm with
  no loop was published as "repaired 496".

## A candidate that never arrived is not a candidate that was wrong

The dev run that was meant to judge the selector-swap experiment ended in a refusal:

```
arm select-cross-judge: 1526 of 1532 calls (99.6%) failed at the model, above the 10%
this harness treats as an outage (first error: llm: llm returned 429)
```

That guard existed and worked: the second endpoint's quota ran out mid-run and no number was
published. But the same job exposed a gap the guard cannot see. `select-cross` completed in
that job with **62.5%** and a ceiling of 64.8%, against 64.3% and 67.0% in its three earlier
runs. Nothing in the artifact explained the 2pp. The explanation is that the second endpoint
was already refusing some of its candidates: a refused candidate casts no vote, so the set
quietly shrinks, every case still answers, and the ceiling falls for a reason that is not in
the arm.

`candidateFailures` now counts them where they are lost — per arm, split by whether the model
or the engine refused — and `assertCandidateSurvival` refuses to publish an arm that lost more
than a tenth of the candidates it declared. The gate checks the same field, because an artifact
written before the guard existed can still be read.

This is the third time a measurement of ours measured the measuring instrument: the 60-second
deadline that reported 1,355 timeouts as model failures, the unrecorded clock that let two
runs of one configuration look comparable, and now a candidate set that was not the size the
arm declared. Each fix is a field, and each field is checked rather than trusted.

## The cross-vendor candidate, measured against a same-vendor control

The first cross-vendor run after the second provider's quota came back looked like a win:
`names` 41/120 (34.2%) against `select-cross` 60/120 (50.0%), a ceiling of 52.5% and a
selector that lost three cases. +15.8pp.

It is not a cross-vendor result. `select-cross` and `names` differ by four levers — three
candidates instead of one, a model selector, schema linking, and inline definitions — and
`PAIRS` does not contain that pair, so the artifact carries no p-value for it.

The single-lever pair does exist: `select-mixed` and `select-cross` ask the same three
prompts with the same selector, and differ only in who wrote the first candidate.

| group | second model | `select-mixed` | `select-cross` | delta | onlyFirst / onlySecond | p | `@second` won |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | `glm-4-flash` | 61/120 · 50.8% | 59/120 · 49.2% | **−1.7pp** | 3 / 1 | 0.625 | 18 / 120 |
| B | `deepseek-chat` | 59/120 · 49.2% | 62/120 · 51.7% | **+2.5pp** | 1 / 4 | 0.375 | **95 / 120** |

Three things have to be read together:

1. The two groups point in opposite directions and neither is significant. The honest reading
   of their difference is "inside the noise".
2. `select-mixed` was **50.8%** in group A and **49.2%** in group B — the same arm, the same
   questions, the same model, the same prompts. That 1.6pp is what two runs of this sample
   happened to differ by; the resolution computed from the discordance rate is 4.7–5.2pp
   (see *The resolution of a delta, computed instead of discovered* below), and both mixes are
   a third challenging where dev is a tenth and drawn from 2 of the split's 11 databases (see
   *A subset is an estimate only if its mix and its databases are the split's*). No claim
   smaller than 5pp survives this sample, and no absolute accuracy from it describes dev.
3. `sources` gives the mechanism. A `deepseek-chat` candidate wins 95 of 120 cases (79%); a
   `glm-4-flash` candidate wins 18 (15%). A candidate's author decides how often it wins, and
   how often it wins decides how far a ceiling can move.

So the negative point estimate is not evidence that heterogeneity hurts. It is evidence that
the second model in group A is much weaker than the primary one, and that a weaker candidate
rarely wins the vote. Testing whether heterogeneity *by itself* helps needs a second model in
the same class as the primary — `glm-4.5` answers 429 from this account (two serial preflight
calls, both 429), so that experiment is blocked outside this repository.

One detail worth keeping, because it turned out not to be noise. `cost.extraCallsPerCase`
was **0.0167**, not zero, in both groups: both arms declare `vote: 3` and `repairs: 0`, so
the count should be identical. The per-case rows put it on two questions, ids 25 and 46,
where `select-mixed` spent three calls and `select-cross` spent four.

The counter is right and the arms differ for a reason worth having. On those two questions
every `select-mixed` candidate was refused by the engine, so the arm returned from the
zero-candidate branch before spending the selector call. `select-cross` kept at least one
candidate there — written by the other model — and spent it. The extra call is a rescue, not
a cost.

What was wrong is that the artifact could not say so. `reason: 'values'` with
`candidateRecall: false` is what a zero-candidate case looks like *and* what a
surviving-candidates-but-wrong case looks like, and those are different problems: three
statements the engine refused versus three that ran and were wrong. `caseRows` now carries
`errorKind` and a truncated `error`, so the next reader gets this in two minutes instead of
following the same trail.

## The preflight that only called one endpoint

Run `40792849132` was the first cross-vendor dispatch after the second provider's quota came
back. It was asked for two arms, 120 questions and `second_model=glm-4.5`:

```
names     43/120  35.8%  strict 41
Error: arm select-cross: 120 of 360 candidates (33.3%) never arrived from the model, above
the 10% this harness treats as an outage.
```

Every `@second` draw failed, from the first case to the last: 120 cases, 120 candidates, none
arrived. The guard did its job — no number was published, and the message said what the arm
could not do. But it took three minutes to say it, and on the 1,534-question split it would
have taken forty.

The preflight exists for exactly this. ADR-202 wrote it after a `glm-4.5` run spent 3h43m and
1,532 calls discovering that 41% of them exceeded a 180-second deadline: three timed calls
would have said so in nine minutes. What that preflight never did was check the *second*
endpoint — and `bird-dev.yml`, the only workflow that can name one, was the only workflow with
no preflight step at all, while carrying `BIRD_PREFLIGHT_SAMPLES: '2'` as though it had one.

So the ordering is now:

1. `resolvePreflightTargets` lists every endpoint the run will call, with the same URL
   fallback `createProviders` uses. A run that preflights one endpoint and calls another has
   measured the wrong thing twice.
2. Each target is checked with the run's own deadline, and named in the output
   (`preflight[primary]` / `preflight[second]`), so one refusal does not erase the fact that
   the other endpoint answered.
3. A target with no key is reported rather than skipped: the run would still try to draw the
   candidate, and a preflight that quietly checks only what it can is the failure mode it
   exists to remove.

The cost is two calls. The saving is the forty minutes between "the endpoint is refusing" and
"the arm has already spent itself finding out".

## A preflight that passed, and a run that failed anyway

`glm-4.6` was dispatched with eight arms, and the first one — `names` — ended the run at
**207 of 496 calls (41.7%) failed at the model**, above the 10% the harness treats as an outage.
Every failure was a timeout. Nothing was published, and the message said why.

The preflight had passed twenty minutes earlier, and it was not lying. It was answering a smaller
question than the one it was read as answering, and the size of that gap is arithmetic:

| clean probes | failure rate a clean run cannot rule out (95%) |
| --- | --- |
| 3 | 63.2% |
| 8 | 31.2% |
| 12 | 22.1% |
| 29 | 9.7% |

If the true rate were `p`, `n` clean probes would still occur with probability `(1-p)^n`, so a clean
run is only 95%-consistent with rates up to `1 - 0.05^(1/n)`. At the three probes this workflow used,
a 41.7% failure rate passes **19.8%** of the time — one run in five. The preflight said "the endpoint
answers"; the reviewer read "the run will finish".

Three changes, and the first two are the ones that matter:

1. **The preflight prints what it did not rule out.** `preflight[primary]: 12 calls to glm-4.6, median
   1,940 ms, deadline 300000 ms; 12 clean probe(s) leave a failure rate above 22.1% undetected`. A
   pass is now a reading with a width rather than a boolean, and `undetectedFailureRate` is the
   arithmetic, tested at 1, 3, 8, 12 and 29 probes.
2. **The deadline is an input.** It was the string `'180000'` in the workflow — a contract with one
   model. `glm-4.6` at 180s is the second provider's reasoning model at a deadline written for its
   chat model, and the 41% figure is the same one `glm-4.5` produced two rounds ago, which says the
   number is a property of the family rather than of a bad afternoon.
3. **The probes went from three to twelve**, because twelve is the smallest round number that puts
   the undetected rate below the 10% the harness uses everywhere else — at 22.1% it is still not
   enough, and the report says so rather than implying it is.

What this does not do is make the run cheaper. Two arms instead of eight, at concurrency 8 and a
300-second deadline, is the experiment the project's own rule asked for — *does a reasoning model move the
accuracy* — and not the eight-arm sweep, which is a different question asked at four times the bill.

## The preflight was serial, and the endpoint was not

`42633514038`, `glm-4.6`, two arms on the 496-case Mini-Dev split. The preflight passed and printed
its own width:

```
preflight[primary]: preflight: 12 calls to glm-4.6 — 12 answered, median 7151 ms, worst 7890 ms,
deadline 300000 ms; 12 clean probe(s) leave a failure rate above 22.1% undetected
```

Then `inline+evidence` failed **416 of 496 calls (83.9%)**, every one of them a 429, and the harness
refused to publish a table computed from the endpoint's mood. The arithmetic above is not the
explanation this time: at a true 83.9% failure rate, twelve clean probes would essentially never
happen (`0.161^12`). The probes saw no failures because, at one call at a time, there were none to
see. What they missed is that they were **serial**.

A rate limit is a function of simultaneous requests, not of requests. Twelve calls one after another
measure an endpoint under a load the run never applies; the run applies eight at a time. So the probe
now goes out in **waves of the run's own concurrency** — `BIRD_CONCURRENCY`, read from the variable the
run reads — and a 429 inside a wave is its own problem line, naming the setting that produced it
rather than the timeout:

> `8 of 12 calls were refused with 429 at 8 concurrent, which is the run's own concurrency: the
> endpoint is rate limiting this account. Lower BIRD_CONCURRENCY, raise the account limit, or
> dispatch this model to another provider.`

The second fix is about when the verdict arrives. `assertFailureRate` reads a **table**, and a table
only exists once every case has been asked: it cost 496 calls and twenty minutes to reach a
conclusion its first sixty rows had already established. `outageDecided(failures, total)` is the same
tenth expressed as a sealed verdict — failures only accumulate, so once the count exceeds a tenth of
the *split*, the finished table cannot come back under the threshold. Stated that way the early stop
cannot refuse a run the table guard would have accepted, which is the only property it has to keep; a
"grace period" for the first N calls would have been a judgement about which refusals are transient,
and a guard is the wrong place for one.

| | `42633514038` | with the breaker |
| --- | --- | --- |
| calls spent before the refusal | 496 | 50 failures is a tenth of 496, reached at about call 60 |
| wall clock before the refusal | 20 min 26 s | the minute the fiftieth 429 arrives |
| what the reader sees | `416 of 496 calls (83.9%) failed` | `stopped after 60 of 496 calls — 50 of 60 calls (83.3%) failed at the model … (first error: llm returned 429). The remaining 436 calls were not spent.` |

The last call is left to `assertArmProducedResults` on purpose: with nothing left to save, "100% of
one case failed" reads as a throttle, and "this is not an accuracy of zero; it is a run that did not
happen" is the reading that is actually true.

### The breaker's first run, and what it did not fix

`42645923773` is the first run in this repository that stopped itself. `glm-4.6`, concurrency 2, a
300-second deadline, two arms. The preflight passed — twelve probes, at the run's own concurrency, no
429 — and the account's rate limit is not what ended it:

```
arm inline+evidence: stopped after 398 of 496 calls — 50 of 398 calls (12.6%) failed at the model,
above the 10% this harness treats as an outage (first error: llm call timed out). Every failure is a
timeout, so the deadline (BIRD_LLM_TIMEOUT_MS) may be shorter than the model needs. The remaining 98
calls were not spent.
```

Three readings, and the third is the one that costs:

1. **The guard worked.** 594 of the 992 calls — the last 98 of the first arm and all of the second —
   were not spent. The verdict arrived at call 398 rather than at the end of the second arm.
2. **The absolute rule trips late when failures are rare.** A tenth of 496 is 50, and a 12.6% timeout
   rate reaches 50 failures only near the end of an arm. A share-based rule would have tripped at
   call 40 — and could have refused a run the table guard would have accepted, which is the property
   this rule was built to keep. The late trip is the price of the guarantee, not a defect in it.
3. **`glm-4.6`'s tail exceeds 300 seconds on one call in eight.** At concurrency 2 there is no rate
   limiting and no queue: the deadline is simply shorter than the model's tail. The 12.6% is above
   the 10% this harness publishes at, so **no split size fixes it** — the guard divides by the split,
   and a smaller split refuses at the same rate. The only two knobs that can produce a table are a
   longer deadline and a lower concurrency, and the next dispatch moves the first one to 600 s.

That is the honest state of the strong-model reading: two attempts, both refused by the harness on
arithmetic rather than on a number, and the reason named in the log each time. What the project has
measured about the model axis is its **tail**, not its accuracy — and the tail is the reason the
accuracy is still unmeasured.

## What the shipped prompt is made of, per block

`pnpm bench:bird:card <report.json> --arm metadata+evidence` renders the prompt the pipeline would
send for every case and splits its cost by the block that spent it. No model calls, so the number can
be re-measured at any time, and it is measured on the split the product is judged on (496 cases):

| block | chars per call | share |
| --- | --- | --- |
| schema card | 6,801 | 90.2% |
| rules | 274 | 3.6% |
| context | 135 | 1.8% |
| linker hint | 133 | 1.8% |
| question | 90 | 1.2% |
| **total** | **7,544** | |

The card is the prompt. What the card carries is not:

- the card shows **7.3 tables**; the gold statement reads **2.1**, so **54.1% of those characters
  belong to tables the gold never reads** — the ceiling for a perfect table linker is half the prompt.
- the linker that ships keeps 2.9 tables: **every** gold table on 234 of 496 cases, some on 176, and
  **none on 86**. That 86 is why `select-prune` loses 1.4pp: the ceiling is large and the coverage is
  the constraint, which is a linker problem rather than a card problem.
- a *field* budget cannot pay for itself yet: at 12 fields the linker names 30.9% of the gold's
  fields and covers all of them on **16 of 496** cases. Cutting columns to save tokens would delete
  answers, so the token work belongs at the table level and only after the linker stops missing whole
  tables.

That ordering matters for the next mechanism: the `filter-narrow` composition below says 72% of the
remaining failures are questions whose literal is absent from the column the prompt compared — a
column-level failure. Column evidence in the prompt is the fix, and the only place to pay for it
without growing the bill is the 54.1% of the card that answers no question.

### What a comment is worth: 77.2% of the card, and 1.6% of it repeats the column name

The same measurement, taken one level down, on the 1,534 questions the dev split carries:

| | share |
| --- | --- |
| the schema card | 90.2% of the prompt |
| comments inside that card | **77.2% of the card** |
| comments that restate the column name, after case, spacing and punctuation are normalised | **1.6% of the card** — 2.0% of all comment characters, on 10.5% of commented columns |

`Currency -- Currency`, `GasStationID -- Gas Station ID - Gas Station ID`. Dropping them is lossless
by construction — the name is already in the prompt — and it is worth **1.6%**, not the third of the
prompt a looser matcher first reported. The loose version asked whether either string started with
the other, which counts `Date -- Date of birth` as a restatement of `Date` and would have deleted
the only part of that comment that says anything. The rule that survives is stricter and smaller:
delete every occurrence of the normalised column name from the normalised comment, and drop the
comment only if nothing is left.

The bigger number in that table is the one that is not a reduction. Comments are 77.2% of the card
and the card is 90.2% of the prompt, so **70% of every prompt the product sends is prose about
columns**, and most of it is load-bearing — `Price -- total price = Amount x Price` is what makes a
question answerable. The 54.1% of the card that belongs to tables no question reads is where the
tokens are; the comments are where the *knowledge* is, and they are not interchangeable.

## The candidate the three prompts cannot write

Seven configurations answered 466 of the 1,532 dev questions wrongly — no arm held the right
statement for them — and a perfect router over all seven is worth +6.3pp and still lands at
69.6%, below the published 70–73%. Both numbers say the same thing: the binding constraint is
no longer which candidate is chosen, it is whether one exists. Every selection experiment from
here (`pairwise`, `tagged`, `balanced`, `vote-*`) can only redistribute what the prompts already
produced.

`decompose` is the first generation lever since the prompt stack that changes what can exist. It
is **not** `plan`, and the difference is the reason it is worth a run: `plan` writes an ordered
plan in an earlier call and carries it into the prompt, and it measured 50.4% against 57.6% for
its parent (−7.2pp, 63/27, p=0.0002) — the plan anchored the statement it was meant to prepare.
`decompose` puts the instruction inside the same reply: the model writes the sub-questions as
statements, one per line, and then composes them into the answer. One call, like any other
candidate, so the comparison prices a **shape of generation** rather than a budget.

Two arms, and one more that the arithmetic of the adopted trio forced:

| arm | candidates | calls | what it answers |
| --- | --- | --- | --- |
| `decompose` | 1 | 1 | does the shape help a single statement, against `inline+evidence` |
| `select-dc` | 3 | 4 | does the shape earn the **third slot**, against `select-mixed` at the same cost |
| `select-mixed+dc` | 4 | 5 | does a **fourth** candidate raise the ceiling, against `select-mixed` |

The third arm exists because of a number the empty-result run produced: `values` won 81 of
1,532 cases (5.3%), and its block was empty on 933 of them (60.9%), so on three questions in
five the adopted trio was a duo with a third vote that could not differ. The dry run states it
directly — `select-mixed` builds three distinct prompts on 39.1% of the split, `select-dc` on
100% — which makes `select-dc` the cheapest test of the prompt itself (same three candidates,
same four calls, one source swapped) and `select-mixed+dc` the test of whether a fourth
candidate is worth a fifth call. The first is run first; the second only if the ceiling has
room that a fourth candidate could fill.

The reading order is fixed before the run, because a fourth candidate can raise the ceiling and
still lower the score (the selector then has one more wrong statement to be talked into):

1. **`candidateRecall` moves first.** It is the ceiling: how often the candidate set contained a
   matching statement. If `select-mixed+dc` does not raise it, decomposition added no
   information and no selection change can recover it. A rise of at least 1pp is the threshold
   for "it added something"; the accuracy test is read only after that.
2. **Adoption needs two rounds at p<0.01** against `select-mixed` on the same cases, as every
   arm since v9.6.
3. **The mechanism is counted, not assumed.** `decomposition.{asked,fired,share,meanSteps}` is
   in the artifact, and a run where the model wrote steps on fewer than half the cases, or fewer
   than 1.5 steps on average, is refused rather than published: a prompt whose format is ignored
   is the parent arm with a longer instruction, and its delta would be attributed to a method
   that never ran. The gate checks the same two thresholds, so the runner cannot reject a run its
   gate accepts.

The format is load-bearing in one place worth stating: the answer is read from the **last**
block, not the first. A reply that fences each step would otherwise hand step one to the
executor — a statement that runs, returns rows and answers a different question, which is the
failure mode that costs accuracy without leaving a trace.

If the ceiling moves and the score does not, the next iteration is a selector for four
candidates; if neither moves, `decompose` closes and the generation side turns to a schema
linker that stops inventing identifiers, which is the remaining source of candidates that never
execute.

## What a report has to say about itself

An artifact that names its arms and its score but not the conditions it ran under cannot be
compared with anything, including a rerun of itself. The fields that decide whether two numbers
are comparable:

| field | why it must be there |
| --- | --- |
| `model`, `secondModel`, `judgeModel` | `select-cross`'s 63.5% has no subject without the model that wrote its candidates, and a judge swap is unreadable without the judge |
| `run.timeoutMs` | a 60-second deadline once reported 1,355 of 1,532 glm-4.5 cases as "failed at the model"; the number was the harness's patience |
| `run.concurrency` | a throttled endpoint and a fast one produce different failure profiles at the same settings |
| `run.retries` | the same, for the transient class |
| `split`, `selection.scored` | the sample, and its size |
| `calls.mean` per arm | the price every `ppPerExtraCall` is divided by |
| `failureSample.{cap,total,truncated}` | the failing statements an arm keeps, and whether that is all of them |
| `decomposition.{asked,fired,share,meanSteps}` | on an arm that asks for a decomposition: whether the model wrote one, and how many steps |

The gate rejects a report missing any of these, or with a deadline under a second, or a
concurrency below one. The point is not bookkeeping: each field stands for a way a measurement
can silently become a measurement of the measuring instrument, and every one of them has
happened here at least once.

## What a floor is a claim about

A gate number has three coordinates: the split it was measured on, the arms it covers, and
the **model** that produced it. This file's baseline recorded two of them, and the missing
coordinate had a cost that took a while to see:

- `bird-model.yml` — the workflow whose entire purpose is running another model — skipped
  `pnpm gate:bird`, because the accuracy floors came from DeepSeek and applying them to GLM
  would report a miss that means nothing. Skipping the tool also skipped the repair-funnel
  arithmetic, the cost accounting, the empty-lever checks and the A/A tolerance, so a
  cross-model run had *no* structural gate at all.
- The sample-size check compared every split against Mini-Dev's 500 questions. A dev run
  that scored 600 of its 1,532 questions would have passed a check whose only job is to
  notice a shrunken sample.

Both are the same shape as `armsBySplit` earlier: a constant that belongs to a coordinate
being applied to all of them. The baseline now states `floorModel` per split and
`scoredBySplit` per split; a run by a different model is *measured* rather than failed,
while every structural check still applies to it. A report must also name its model — an
artifact whose floors cannot be attributed is not gateable — and a cross-model arm must name
the second model, since `select-cross` scoring 63.5% has no subject without it.

One more of the same family, found while wiring this: every dev artifact said
`"split": "mini_dev_sqlite"` at the top level while `selection.split` said `dev`. The field
was a literal, nothing read it, and so it stayed wrong for four releases. It is derived from
the split now, and the gate rejects a report whose two fields disagree — deleting the
duplicate would have hidden the class instead of ending it.

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

### A run that asks for 300 questions is not a run that lost 200

`bird-model.yml` scores a slice — 300 of Mini-Dev's 500 — because a model comparison
needs one prompt and two models, not a full dev run. The artifact recorded the request
in `selection.requested` and the split's size in `selection.available`, and the gate
failed the run anyway:

```
BIRD1: scored 298 questions against a baseline of 500; the sample changed
```

The check was written to catch an artifact that lost rows, and it could not tell that
from a run that never asked for them: it compared `scored` against the split's size and
ignored the declaration sitting next to it. A red build about the sample the run
declared, on the one run whose numbers were the reason it existed.

The rule is now the one the arm list already followed. A declaration is read: a request
for fewer questions than the split holds is a **measurement on a declared subset**, and
the floors — taken on the full sample — are switched off rather than guessed at, in both
directions. A subset cannot fail a floor (298 questions are not 500, and the noise is
twice as wide) and cannot clear one either (a green check on a fifth of the sample is
exactly what a SOTA claim is made of). What is left is arithmetic that a declaration
cannot excuse:

| Declaration | Gate | Why |
| --- | --- | --- |
| no `requested` field | strict, as before | an older artifact has nothing to read |
| `requested < available` | subset: floors off, one note | the run says what it scored |
| `requested` ≥ `available`, `scored` short | **fail** | rows were lost, not unrequested |
| `requested > available` | **fail** | a request the split cannot satisfy |
| `scored > requested` | **fail** | rows that were never asked for |
| `requested` not a number | **fail** | a declaration nobody can read |

The same run, against the same artifact, now prints `298 of 500 minidev questions were
requested, so this is a measurement on a declared subset` and exits 0. The job summary
carries the phrase *declared subset — no accuracy floor applies* next to the number, so
a reader who meets `298/500` does not have to reconstruct which kind of run it was.

## A subset is an estimate only if its mix and its databases are the split's

The paragraph above says a subset run is a measurement rather than a gate. It does not say
what the measurement is *of*, and for a year of runs the answer was not the split. The
sampler walked the three difficulty buckets round-robin — one case each per round — under a
comment that claimed "a limit of 200 therefore keeps the difficulty mix". Equal allocation
does the opposite: it replaces the mix with 33/33/33 as far as the buckets allow.

| | simple | moderate | challenging |
| --- | --- | --- | --- |
| dev split (1,534 questions) | 925 (60.3%) | 464 (30.2%) | 145 (9.5%) |
| a 120-question run, round-robin | 40 (33%) | 40 (33%) | **40 (33%)** |

The hardest bucket is over-weighted by **3.5×** and the easiest under-weighted by 1.8×, so
every accuracy quoted from a 120-question run described a subpopulation harder than the split
it was named after. The size of the bias is measurable in the artifact the run already wrote,
because it carries per-difficulty counts: reweighting `select-mixed`'s
24/40 · 15/40 · 20/40 to the split's mix gives **52.2%** where the run reported **49.2%**.

What survives and what does not:

- **paired deltas survive.** Both arms scored the same 120 cases, so a difference between them
  is still a difference on a harder subpopulation. The cross-vendor numbers, their intervals
  and their discordance rates are *about that subpopulation*, and should be read as such.
- **absolute accuracy does not.** `49.2%` on dev means nothing next to a dev floor taken on the
  full split, and the gate was right to switch floors off for a declared subset — for a reason
  nobody had written down.
- **per-difficulty cells were the round-robin's only defence.** 40 challenging cases per arm is
  a real signal; a proportional 120-case sample carries 11 of them, which is ±15pp. The two
  goals conflict, and the estimator's job — estimating the split — wins.

Quotas are proportional now, floored, with the leftover slots going to the largest fractional
parts, which also covers the two cases the round-robin needed separate logic for (a bucket
smaller than its quota, an unknown difficulty value). A 120-question dev sample is
**73 / 36 / 11**.

### Fixing the mix exposed a larger bias underneath it

The mix was the smaller of the two. Each bucket was still consumed in **ascending question
id**, and BIRD's dev file is grouped by database, so "the first 73 simple questions" is "the
first databases": the 120-question runs scored **2 of the split's 11 databases**, with
`california_schools` at **74.2%** of the sample against **5.8%** of the split. That is the
bulk of the gap between a 120-question run at 49.2% and the full split's 63.0% — the sample
was not a small dev, it was two databases.

| | what a 120-question run covered |
| --- | --- |
| before, ascending id inside each bucket | **2 of 11** databases, largest at 74.2% (split: 5.8%) |
| after, `mix32(question_id)` inside each bucket | **11 of 11**, largest deviation 2.1pp |

The order has to be a function of the question id alone — same sample on any machine, forever —
*and* uncorrelated with it. Ascending ids are not; FNV-1a over the decimal id is not either, in
a subtler way: consecutive ids keep neighbouring hashes, which put 45 of 73 simple picks in one
database. The mixer is the murmur3 finalizer, which avalanches, so a 120-question sample spreads
across databases the way the split does.

The artifact states what the sample *is* rather than what the sampler meant:

```json
"selection": {
  "strategy": "proportional to the split difficulty mix (largest remainder), seeded order within each stratum",
  "mix": { "sample": { "simple": 73, "moderate": 36, "challenging": 11 },
           "available": { "simple": 925, "moderate": 464, "challenging": 145 } },
  "databases": ["california_schools", "…"],            // the 11 that were scored
  "availableDatabases": ["california_schools", "…"]     // the 11 the split has
}
```

Those fields are what let a reader decide whether an accuracy is an estimate of the split or of
some other population — and reweight a reading taken before the fix, which is the only honest
way to reuse it. `databases` used to repeat the databases that were *requested*, which is a
different claim: a run asked for all 11 and scored 2.

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

### A stronger model at the same prompt is the same measurement

`deepseek-reasoner` thinks before it writes. If the remaining gap between ~58% and the
published 70–73% were the model *reasoning* its way to a join nobody showed it, this is
where it would show. `bird-model.yml`, 300-question slice of Mini-Dev, one arm, plus the
arm repeated as its own control:

| | `inline+evidence` | `inline+evidence#2` |
| --- | --- | --- |
| deepseek-reasoner, 298 scored | 155 (52.0%) | 158 (53.0%) |
| deepseek-chat on the same 296 questions | 153 (51.7%) | — |
| discordant, reasoner-only wins | 32 | — |
| discordant, chat-only wins | 32 | — |
| McNemar exact, two-sided | **p = 1.00** | — |

Thirty-two disagreements in each direction. Not "no significant difference" in the sense
of an underpowered run: with 64 discordant pairs out of 296 the test resolves roughly
**±5.3pp** at 95%, and the observed difference is **0.0pp**. The A/A pair inside the run
moved 1.0pp (12 of 15 discordant, p = 0.70), so the harness was behaving the way the
harness behaves.

The comparison is paired on question ids, which is why the chat column is not the 58.0%
in the tables above: those are 498 questions, these are the same 296 the reasoner run
scored, and even a single-model score moves 6pp between samples that size. Paired is the
only comparison that means anything here, and both models were run through this harness
with the same pinned inputs, same prompt, same 400-line schema cards.

What this closes: **model reasoning depth is not the lever, at this prompt.** The same
information in the same shape produces the same SQL. It does not follow that reasoner
would not help a *selector* that ranks candidates it did not write — but the ceiling
argument already bounds that: a perfect selector over four candidates scores 68.4%, and
the ranking signal a second model could add is inside that bound, not above it. What is
left is what the prompt shows and what writes the candidate: the value samples and the
generator family, in that order, because samples change the input rather than the search.

### The spellings on the card: the mechanism fires, the gain does not clear the bar

`samples` puts a column's stored values on its own card line — `status TEXT
[Banned|Active]` — so a question that spells a value differently from the store no longer
depends on the `values` block having matched it. The `values` block is empty exactly when
it did not match, which was 60.9% of the questions that offered it. Two dev runs, 1,532
questions each, one lever, one call:

| | run 1 | run 2 |
| --- | --- | --- |
| `inline+evidence` | 939 (61.3%) | 934 (61.0%) |
| `inline+evidence+samples` | 948 (61.9%) | 954 (62.3%) |
| delta | **+0.59pp** | **+1.31pp** |
| discordant pairs (samples / parent) | 57 / 48 | 58 / 38 |
| McNemar exact | p = 0.44 | p = 0.052 |
| `errors.values` | 444 → **429** | 436 → **431** |
| `errors.columnCount` | 128 → 134 | 133 → 125 |
| mean prompt characters | 2,568 → 3,148 (+22.6%) | idem |

The mechanism is not in doubt: 118 columns and 628 values reach the card, the control
counts them, and the error class the lever targets moves **down in both rounds** (−15 and
−5). What does not clear the bar is the accuracy. The registered criterion is two
consecutive runs at p<0.01 (ADR-184); +0.59 (p=0.44) and +1.31 (p=0.052) miss it, and the
same arm repeated inside one round moved 1.2pp across these two runs, which is the scale
"+9 questions" has to be read against. Pooling the two rounds — not the registered
criterion, but the best estimate available — gives **+0.95pp, 201 discordant pairs,
p=0.048**: real enough to be a direction, too small to be a mechanism worth 22.6% more
prompt.

So `samples` is not adopted as a default. It stays as an ablation reference, which is what
this project does with levers whose mechanism is confirmed and whose effect is not: the
number is in the artifact, the gate refuses an arm that asks for samples and attaches none,
and the next experiment is not "turn it on".

> Two levers were tested in this cycle and both came back inside the noise: a model that
> thinks (p = 1.00) and an input that shows every stored spelling (+0.95pp pooled,
> p = 0.048). The gap from 58% to the published 70–73% is therefore not reachable by a
> lever this harness currently has access to. Recording that plainly is more useful than
> another prompt variation: it says the remaining distance is in the generator family
> (cross-vendor, blocked by quota) or in the fine-tuning around it, not in what this
> pipeline chooses to say.

## A generator that raises the ceiling, and a selector that spends it

The dev split, 1,532 questions, one job, six arms. The two arms that matter here differ by
one thing: which prompt writes the third candidate. `select-mixed` gives the third slot to
the value index, `select-dc` gives it to a decomposition — same candidate count, same four
calls, same selector.

| arm | execution accuracy | candidate recall (ceiling) | selection loss |
| --- | --- | --- | --- |
| `names` | 645 (42.1%) | – | – |
| `inline+evidence` | 928 (60.6%) | – | – |
| `decompose` | 911 (59.5%) | – | – |
| `select-mixed` | 971 (63.4%) | 65.6% | 34 |
| `select-dc` | 940 (61.4%) | **67.0%** | **87** |
| `select-mixed+empty` | 979 (63.9%) | 65.6% | 39 |

Read the two columns on the right together, always. The ceiling is the share of questions
where **some** candidate was right; selection loss is the number of questions the candidate
set answered and the arm did not return. A generator that adds a good candidate raises the
first and says nothing about the second.

Here the first moved: +1.4pp, about twenty-one questions the three prompts could not write
and the fourth could. The second moved the wrong way by more: 34 → 87. The fourth prompt's
statements are attractive to the selector and wrong on about fifty questions, so the arm
answers twenty-one more questions *possible* and thirty-one fewer *correct*.

That is the useful shape of a negative result. It says the generator worked and the choosing
did not, which is a statement about where the next hour goes — and it is invisible in the
accuracy column alone, where both arms look like "roughly 62%, one is a bit worse".

The same reading applies to a single-candidate arm. `decompose` writes the sub-statements as
executable statements in the same reply and then composes them, at the price of one call like
any other candidate; it scored 59.5% against `inline+evidence`'s 60.6%. Its mechanism was
verified rather than assumed — the report carries `decomposition.{asked,fired,share,meanSteps}`
and the runner refuses to publish an arm whose steps appeared on fewer than half the cases or
averaged under 1.5 — so the −1.1pp is a result and not an inert instruction. Writing the
pieces first pulls the final statement toward the intermediate goals, which is the same
failure that a plan written in a *separate* call showed at −7.2pp from the other direction.

If you are reading a report to decide what to build next, the rule is: a generation claim
needs the ceiling, and a selection claim needs the loss. An accuracy delta on its own cannot
tell the two apart, and the two call for opposite work.

## The ceiling is not the constraint, and the selector is not either

The previous section read one run. This is the same experiment one candidate further: the
adopted trio plus a fourth generator, `select-mixed+dc`. Same selector, same prompt for the
selector, one more candidate and one more call. Dev split, 1,532 questions.

| arm | execution accuracy | candidate recall | selection loss | calls/case |
| --- | --- | --- | --- | --- |
| `names` | 647 (42.2%) | – | – | 1.00 |
| `inline+evidence` | 929 (60.6%) | – | – | 1.00 |
| `decompose` | 916 (59.8%) | – | – | 1.00 |
| `select-mixed` | 964 (62.9%) | 66.0% | 47 | 4.00 |
| `select-dc` | 949 (62.0%) | 66.9% | 75 | 4.00 |
| `select-mixed+dc` | 960 (62.7%) | **68.4%** | **88** | 5.00 |
| `select-mixed+empty` | **971 (63.4%)** | 65.7% | 48 | 4.04 |

The ceiling moved again, and by more this time: +37 questions the three prompts could not
write and the four could, +2.4pp. The accuracy moved by −4. Paired McNemar over the same
1,532 questions puts the accuracy difference at p=0.72 while charging one extra call per
question, which the report prices as −0.26pp per extra call.

Two runs now say the same thing. Raising the number of statements a question can be answered
with raises the ceiling, and the selector returns a smaller share of it: 95.4% of the
reachable set with three candidates, 91.6% with four. The fourth candidate is not neutral
noise — it is attractive and wrong often enough to cancel the 37 questions it newly makes
possible.

That leaves a bound worth stating precisely, because it is what decides where the next hour
goes. A **perfect** selector over the four-candidate set would score 68.4%, and a perfect
selector over the three-candidate set 66.0%. The published BIRD dev leaderboard sits at
70-73%. So:

> No selector, however good, reaches the leaderboard from these candidate sets. The gap that
> remains is in what the generator can write, not in how the answer is chosen.

That is a stronger claim than the previous round could make, because it no longer depends on
the selector being good — it is arithmetic on the ceiling. It also inverts the obvious next
move: adding candidates is now known to be a losing trade at this selector, and improving the
selector cannot pay more than the 88 questions it currently misses.

### The empty-result turn, measured twice

`select-mixed+empty` keeps the three candidates, drops any that returned nothing before the
selector sees them, and spends one call when every remaining candidate is wrong in that
specific way.

| round | arm | execution accuracy | delta | paired |
| --- | --- | --- | --- | --- |
| one | `select-mixed+empty` | 979 (63.9%) | +0.59pp | p=0.19 |
| two | `select-mixed+empty` | 971 (63.4%) | +0.46pp | p=0.37 |

Both rounds are in the right direction and neither clears a 1% threshold. The mechanism is
not in doubt — on this split no question has an empty gold result, so a statement that returns
no rows is wrong by construction, and 73 candidates were dropped for free while 61 cases spent
the extra call and 30 of them came back with something. What is in doubt, now with two
independent samples, is that the effect is large enough to measure at 1,532 questions.

The run-to-run noise floor is visible in the same two reports: `select-mixed` scored 971 in
round one and 964 in round two with no change to the arm, and its ceiling moved from 65.6% to
66.0%. Seven questions of drift on an unchanged configuration is the scale against which a
+7 result has to be read, and the paired test inside each run is what makes the comparison
worth anything at all.

So the lever stays off by default. The honest statement is: the information is worth
something, the drop is free, and the accuracy effect is smaller than this split can resolve —
which is a different claim from "it does not work", and would need a different experiment
(repeated splits, or the same split at higher sample) to separate them.

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
6. A model swap is read as a single-variable experiment with two conditions
   fixed: the same split, and the same arm. The reference point is the same arm
   on the same split in the same report cycle, never a number from a previous
   leaderboard entry — vendors retrain, endpoints change, and the only comparable
   measurement is one taken under the harness that is being read. On Mini-Dev the
   A/A control (`inline+evidence` twice) differs by two questions in 498, which is
   the scale any model delta has to clear.
7. A model swap does not inherit an accuracy floor. `eval/baseline/bird.json`
   names the model its floors were taken on, and a run by another model is
   measured rather than failed on a threshold that says nothing about either; the
   structural checks — arm list, funnel arithmetic, cost provenance, empty
   levers, candidate survival, A/A — apply unchanged.

## The resolution of a delta, computed instead of discovered

The previous round ended with a number that was true and useless: a delta of +2.5pp at
McNemar p=0.375, which reads equally well as "the lever does nothing" and "this sample could
not see it". The report could not tell those apart, because a p-value only answers whether the
difference is zero — never whether the design was capable of seeing it.

That capability is arithmetic, and it was already implicit in the data. A paired test uses
**only the discordant cases** — the ones where one arm answered right and the other wrong — so
the paired difference has standard error `sqrt(π / n)` where `π` is the observed discordance
share. The smallest difference this design could have detected is `(1.96 + 0.8416)` standard
errors at 80% power:

```
select-mixed -> select-cross, 120 cases, 1 before / 4 after
  delta            +2.5pp
  95% CI           [-1.2, +6.2]pp        <- includes zero
  discordance      4.17%  (5 cases of 120)
  resolves         5.22pp at 80% power   <- the delta is inside it
  cases for 2pp    818 at this discordance rate
```

The same arithmetic, run over both cross-vendor groups and stated as `select-cross` minus
`select-mixed`:

| second model | cases | discordant | delta | 95% CI | resolves (80%) | cases for 2pp |
| --- | --- | --- | --- | --- | --- | --- |
| `glm-4-flash` (cross-vendor) | 120 | 1 / 3 | −1.7pp | [−4.9, +1.6] | 4.7pp | 655 |
| `deepseek-chat` (same vendor) | 120 | 1 / 4 | +2.5pp | [−1.2, +6.2] | 5.2pp | 818 |

Three facts follow, and only the first one was visible before:

1. **Both intervals include zero**, and they are 4.7–5.2pp wide. Neither group is evidence for
   or against the cross-vendor candidate; both are consistent with nothing.
2. **The intervals overlap each other almost entirely.** So the previous round's "the two
   groups point in opposite directions" was reading noise as direction: at 120 cases the
   *difference between the two second models* is not measured either.
3. **The next dispatch has a size, not an opinion.** At 4.17% discordance a 2pp claim needs
   818 cases and a 1.5pp claim needs 1,454, so the 1,532-case dev split resolves ≈1.5pp and is
   the smallest split that can settle a 2pp question. That number is now in every artifact, per
   comparison, as `casesForClaim` — computed from the discordance the pair actually showed
   rather than quoted from this paragraph.

**Zero discordant pairs is not a zero-width interval.** Two arms that agree on all 120 cases
have a plug-in discordance rate of zero, which would produce a zero standard error and claim
the harness is exact. The 95% upper bound on a rate that produced no event is instead 3/n
(the rule of three), so perfect agreement on 120 cases still cannot exclude a **4.0pp**
difference. The function returns that bound rather than zero, because the alternative is a
report that calls an unresolved question resolved — the same error as reading a large p as
evidence of no effect, with an extra decimal place of confidence.

An artifact from before this change has no `ci`, no `mde` and no `casesForClaim`; the job
summary prints a dash for those columns instead of a zero, which says "not measured" rather
than "measured as exact".

## The full split answers what 120 questions could not: −0.78pp, and it is the selector

The two 120-question groups above were sized for a 2pp claim, and the answer needed 818 cases
at the discordance they showed. The dev split has 1,532, so it was run with the pair as the
only difference between the arms — `select-mixed` against `select-cross`, one lever, same
model (`deepseek-chat` on both sides), same three prompts except that the cross arm's first
one is written by the second model.

| arm | accuracy | 95% CI (Wilson) | ceiling | selection loss |
| --- | --- | --- | --- | --- |
| `select-mixed` | **62.5%** (957/1,532) | [60.0, 64.9] | 975 | 18 |
| `select-cross` | **61.7%** (945/1,532) | [59.2, 64.1] | 974 | 29 |

Paired: 19 cases only the mixed arm got right, 7 only the cross arm → **Δ = −0.78pp**, 95% CI
**[−1.44, −0.13]**, McNemar **p = 0.029**, discordance 1.7%, the design resolves **0.93pp**, and
a 2pp claim would have needed **334** cases. Three things follow.

1. **The effect is real and smaller than anyone would have claimed.** 0.78pp is below the 2pp
   the previous round was waiting for, and it is significant only because 1,532 cases resolve
   0.93pp. The scan of "the two groups pointed in opposite directions" is over: at 120 cases
   the interval was ±5pp and both directions fit inside it.
2. **The sign is negative.** Swapping one of three candidates for a second model's version
   *costs* 0.78pp on the one comparison where nothing else changes. That does not contradict
   the earlier finding that a second model raises the ceiling — that run compared
   `select-cross` against `names`, four levers away — it says the ceiling and the selection are
   different quantities, and only one of them moved.
3. **The loss is in the selector, exactly.** `passed = ceiling − selection loss` for both arms:
   975 − 18 = 957 and 974 − 29 = 945. The candidate set is as good as it was — 974 against 975
   questions where *some* candidate was right, a difference of one case — and the selector
   threw away eleven more. Those eleven cases are 0.72pp of the 0.78pp.

The selector's taste is stable across sample sizes: it picks the `@second` candidate on
1,323 of 1,513 decided questions, 87%, the same preference the 120-question run showed at 79%.
What changed with the sample size is not its preference but its cost. A candidate written by a
second model looks enough like a better answer that the selector prefers it, and it is not
better often enough to pay for the preference.

### The cross-vendor half: the ceiling rises and the selector buries it

The same pair was run again on all 1,532 questions with `glm-4-flash` as the second model
(run `40817333043`), which is the half that separates "a second model" from "a different
vendor" — the earlier 120-question groups could not, because their interval was ±5pp.

| second model | ceiling (mixed / cross) | selection loss (mixed / cross) | accuracy | delta | p | `@second` wins |
| --- | --- | --- | --- | --- | --- | --- |
| `deepseek-chat` (same vendor) | 975 / 974 | 18 / 29 | 62.5% / 61.7% | −0.78pp | 0.029 | 87% |
| `glm-4-flash` (cross-vendor) | 977 / **1018** | 17 / **75** | 62.7% / 61.6% | −1.11pp | 0.0498 | 28% |

Three readings, in order of how much they can carry:

1. **The sign is the same under both second models.** −0.78pp and −1.11pp, on the same
   questions, with the same first arm. A vendor interaction would have had to flip it; it did
   not. What costs accuracy is *a candidate the three prompts were not written for*, not which
   company wrote it.
2. **The cross-vendor candidate raises the ceiling by 2.7pp and the arm still loses.** With
   `glm-4-flash` there are **41 more questions** where some candidate was right (1,018 against
   977) — that is the diversity argument, measured, and it is real. The selector then threw away
   75 of them instead of 17, so the arm ends 17 questions lower. **The ceiling is not the
   constraint; converting it is.** This is the same shape as the same-vendor half, one order of
   magnitude larger.
3. **The magnitude is unresolved, and the artifact says so.** The design's resolution at this
   discordance (4.37%) is **1.5pp** — wider than the 1.11pp it measured — and p = 0.0498 sits on
   the edge. The interval [−2.16, −0.06] excludes zero, so the sign is supported; the size is
   not. A 2pp claim here needs 859 cases, which this split has; a 1pp claim needs 3,434, which
   it does not. Reporting "−1.11pp" without the 1.5pp resolution would be the mistake the
   previous round spent a section undoing.

The selector's preference is what changed with the author: it takes the `@second` candidate on
**87%** of decided questions when the second model is its own vendor and on **28%** when it is
not. Rejecting a candidate 72% of the time and still losing 58 questions to the 28% it accepts is
not a threshold that needs tuning; it is a selector that ranks a prompt's provenance above its
contents. The run-to-run drift of the same arm across the two runs (62.47% vs 62.66%, 0.19pp) is
smaller than either effect, so the comparison is not reading noise between runs.

### The confound, checked instead of argued

`select-mixed` and `select-cross` do not run the same *number* of distinct prompts. Two of the
mixed arm's three sources produce byte-identical text on 933 of 1,532 dev questions, so 61% of
its cases were decided by two prompts; the cross arm's first candidate is sent to a second
model, so all 1,532 of its cases had three. A pooled delta over those arms mixes "three against
three" with "two against three" in an unknown proportion.

`pnpm bench:bird:strata --arm select-mixed --against select-cross` joins the artifact's own
`degenerateIds` with its per-case outcomes and splits the comparison:

| stratum | n | `select-mixed` | `select-cross` | delta | 95% CI | p | resolves |
| --- | --- | --- | --- | --- | --- | --- | --- |
| all cases | 1,532 | 62.5% | 61.7% | −0.78pp | [−1.44, −0.13] | 0.029 | 0.93pp |
| all prompts distinct | 599 | 65.8% | 65.1% | −0.67pp | [−1.59, +0.26] | 0.289 | 1.3pp |
| first arm duplicated a prompt | 933 | 60.3% | 59.5% | −0.86pp | [−1.75, +0.03] | 0.096 | 1.3pp |

The sign holds in both halves at the same magnitude, and the duplicated half — where the cross
arm has one *more* distinct prompt — is not where the effect lives. If a third distinct
candidate were the lever, that is the stratum where the cross arm should have won. It lost
there too, slightly worse. The pooled number is therefore about who wrote the candidate, not
about how many candidates there were.

Neither stratum resolves better than 1.3pp on its own, which is why the claim is carried by the
pooled row and why the tool says so in the same breath: a stratification that halves the sample
cannot confirm a 0.78pp effect in either half, and a reading that reported only the strata
would be claiming a resolution it does not have.

The tool cross-checks its own pooled row against the artifact's `ablations` entry for the same
pair and fails when the two disagree, because two readers of one file that differ mean one of
them is wrong, and printing both for the reader to choose between is not a measurement.

## A loss has an address

`candidateRecall` splits an arm's cases in two: the candidate set held an answer, or it did
not. `selectionLoss` is the first half minus what the arm returned — the cases a better
selector could have won. Neither of them says *which* candidate was thrown away, and the
cross-vendor run made that gap expensive: it lost **75** of the 1,018 cases whose set held
the answer, and the artifact could support two readings that call for opposite work.

- The selector **rejected the second model's statement** — a preference to attack.
- The selector took a different wrong statement **while a right one sat beside it** — a
  ranking failure to attack, on the same candidate set.

Two readings, one file, no way to choose. So the runner now writes the set it chose among,
with the judge's verdict on each member, and which member it took — the fields abbreviated
here to the ones this section is about:

```json
{ "arm": "select-cross", "id": "…", "passed": false, "candidateRecall": true,
  "candidates": [ { "source": "inline+evidence@second", "correct": true },
                  { "source": "metadata+evidence", "correct": false },
                  { "source": "values", "correct": false } ],
  "winnerSource": "metadata+evidence" }
```

That row is the first reading's answer *and* the second's: the answer was in the one
candidate the arm did not take. The record and the ceiling come from the same pass over the
same array — `candidateVerdicts` returns the verdicts once and `candidateRecall` is
`.some(correct)` of them — so the two cannot disagree by a rounding difference or by a
candidate the ceiling never counted.

### The reader

```bash
pnpm bench:bird:losses --arm select-cross --report eval/out/bird-eval.json
```

Two tables. The first is the selector's conversion rate per source: of the questions where
exactly one candidate was right, how often the arm came back with it. That is the 47%/87%
asymmetry with its **denominators printed** instead of implied — the number a judge swap has
to move, and the number that says how much of the loss a per-source fix could reach. The
second groups the losses by address: which sources held the answer, and which one the arm
returned instead.

Three refusals, all of them the same rule as the strata reader's (ADR-226): a stratum that
would be a fiction is reported as an absence, and a file that contradicts itself is a failure
rather than a table.

1. **An artifact written before the record existed** has no candidate set on any row, and the
   tool says so and exits non-zero. A loss attributed over zero records would be a table of
   nothing dressed as a measurement.
2. **A row whose recall is true while its own record marks no candidate correct** is a
   contradiction between two fields written by one pass. The tool reports it and fails: the
   fix is in the writer, not in the reader's preference for one of the two.
3. **A row that failed while its record marks the returned statement correct** is the same
   contradiction from the other side, and the same answer.

The singleton table reads `passed` rather than `winnerSource`, because the sampled arms have
three candidates from one source and no source to name; "the arm came back with it" is the
question, and `passed` answers it for every arm. Where two candidates both answered, the case
is kept as a *set* and neither source is priced alone: a loss with two right statements is a
choice between them, and attributing it to one would invent a preference the score cannot see.

## The judge is the variable, and a judge that cannot read the table

*An asymmetry the selector shows* ends on a registered question and a criterion written down
before any run:

> if the asymmetry flips, the judge is the variable and the next step is a judge that is neither
> author; if it does not, the second model's answers are simply harder and the cross arm's 47%
> stands as a property of the material rather than of the judge.

`select-cross-judge` is that experiment: the same three candidates, the same selector prompt, the
same four calls, one coordinate changed — who judges (run `40828283888`, full dev, second model
`glm-4-flash`).

| arm | judge | accuracy | ceiling | selection loss | `@second` taken | `@second` alone → returned |
| --- | --- | --- | --- | --- | --- | --- |
| `select-cross` | `deepseek-chat` | **60.70%** (930/1,532) | 1,006 | 76 | 27.7% | 11 of 43 (**25.6%**) |
| `select-cross-judge` | `glm-4-flash` | **54.70%** (838/1,532) | 1,004 | 166 | 53.1% | 30 of 44 (**68.2%**) |

**The asymmetry flips.** On the same construction — the second model writes the first candidate —
that candidate is the answer 25.6% of the time when the *other* model judges and 68.2% of the
time when its own author does. Paired: 128 cases only the first arm got, 36 only the second,
**Δ = −6.01pp, 95% CI [−7.64, −4.37], p = 2.7e-13**, discordance 10.7%, the design resolves
**2.3pp**. Two things follow, and the second is the one that matters.

1. **The judge's preference is authorship, measured rather than assumed.** Nothing else changed:
   the candidates were generated the same way, the ceiling is two questions apart (1,006 vs 1,004,
   which is generation drift), and the prompt the judge reads is identical. The only difference in
   the world is which model answers it.
2. **A judge swap is not the fix, because the other judge cannot read SQL.** `glm-4-flash` loses
   **166** of its 1,004 ceiling cases where the first judge loses **76** of 1,006. Both judges
   prefer their own writing; only one of them is good at the job. So the registered next step
   stands — a judge that is neither author — and it is unavailable today (`glm-4.5` answers 429 on
   this account).

### What the attribution table adds to the accuracy

Accuracy says the swap cost 6.01pp. The candidate record says *how*, and it is not the same
mistake in both directions:

| the answer was in | the arm returned | `select-cross` | `select-cross-judge` |
| --- | --- | --- | --- |
| `metadata+evidence` + `values` (two candidates agree) | `inline+evidence@second` | **23** | **128** |
| `inline+evidence@second` (the second model alone) | `metadata+evidence` | **30** | 12 |

The `glm` judge does not merely prefer its own statement when the alternatives are doubtful. It
takes it **against two candidates that agree with each other and are both right**, 128 times
against 23. That is the single largest group of losses in the whole experiment, and no accuracy
number could have found it: it is the same 6pp whether the judge is confused about SQL or
attached to its own prose, and the table is what tells them apart.

So the bias is not a threshold to tune and not a prompt to sharpen. It is a channel: the judge
never sees a label, but it sees the *style* of a statement, and style is authorship. The next
lever is therefore to close that channel rather than to change who speaks through it —
**canonicalise the candidate text** (keyword case, whitespace, operator spelling) so
that two statements which compute the same thing look the same thing. It is one lever on the
existing arm, it needs no third model, and the candidate record now prices it directly: a
canonicalisation that works moves the 128 without touching the 12.

### The drift between runs, stated where it can be seen

The same arm has now been measured four times on dev: **61.70%** (`40806666847`), **61.55%**
(`40817333043`), **60.70%** (`40828283888`) and **60.90%** (`40835164245`). A 1.0pp spread is larger than the −0.78pp the
first of those runs was used to claim, which is exactly why every claim in this file comes from a
*paired* comparison inside one run: pairing cancels the drift, and comparing two arms from two
different runs does not. The three numbers are printed here so that the next reader does not
discover it the way this one did.

The fourth reading came with a reproduction of the swap itself: the same pair re-dispatched
(`40835164245`) reads `select-cross` **60.90%** against `select-cross-judge` **55.03%**, Δ = **−5.87pp**,
95% CI [−7.53, −4.22], p = 1.9e-12, discordance 11.0%, resolves 2.37pp. Two runs, two p-values below
1e-11, same size: the 6pp belongs to the judge and not to the afternoon.

That run also printed a number this file had no place for until the candidate record existed:
`candidateFailures` is `{llm: 1, other: 440}` out of **4,596** attempts, and the losses are not
scattered — **380** of 1,532 cases carry two candidates instead of three, and **375** of those are
missing `inline+evidence@second`. A quarter of the cross arm's cases never had the second model's
statement to choose from, so the 25.6% / 68.2% asymmetry is measured over the cases where it
survived.

`candidateFailures` no longer has an `other` cell. It is `{llm, engine, unparsed}` — the endpoint did
not answer, the statement was written and the database would not run it, the reply carried no
statement — and each arm also carries `candidateSurvival` per source, so "375 of 380 were the second
model's" becomes a reported share instead of a post-hoc grep over `cases[].candidates`. Only `llm`
still fails a run: an endpoint that refuses a tenth of the candidates measures the key, while a
statement the engine refuses measures the model — and an arm whose every candidate was refused (a
read-only database against a prompt that writes `INSERT`s) is a 0% reading that has to survive to be
reported. The first version of this split gated `engine` at 10% and one existing end-to-end test
refuted it immediately: it would have crashed the run that was written to prove the 0% is reported
as a reading rather than as an outage.

### The channel is style, and style can be closed without a third model

The attribution table says the largest loss group is a judge recognising its own prose. That
leaves two ways to act on it: change who judges, or change what the judge can recognise. The first
is blocked (`glm-4.5` answers 429 on this account); the second is a string transformation, and it
was written down as an arm before it was measured:

> `select-cross` (control) against a canonicalised arm, in one run. The 128-group loss must fall by
> at least half, and total accuracy must not fall. Δ with a 95% interval, the resolvable effect and
> a p value; the candidate record reports the two groups (128 and 12) separately.

`eval/bird/canonical.ts` is that transformation. It rewrites a statement so that two authors who
computed the same thing hand the judge the same text:

| what changes | why it cannot change the answer |
| --- | --- |
| keyword and function names upper case, identifiers lower case | SQLite matches both case-insensitively; only literals and quoted identifiers are case-sensitive, and neither is touched |
| runs of whitespace, tabs and newlines become one space, and vanish where punctuation already separates | whitespace is only ever a separator, so normalising it changes where tokens are *drawn*, never what they say |
| `--` and `/* */` comments are removed | a comment is not part of the statement |
| a trailing semicolon is dropped (an interior one is kept, because it separates two statements) | punctuation with no meaning |
| `!=` becomes `<>`, `==` becomes `=` | SQLite documents both as the same operator; which one a model picks is authorship |

What it refuses to touch is the interesting half, because each refusal is a way the transformation
could have changed an answer:

- **String literals, blob literals and quoted identifiers are copied byte for byte.** `'Pen'` and
  `'pen'` are different filters, and `"Order ID"` is a different identifier from `"order id"`.
- **A separator that is load-bearing stays where the author put it.** `x'41'` is the blob `A`;
  `x '41'` is a column beside a string. `?1`, `:name`, `@name` and `$name` are one bound parameter
  and fall apart if a space is inserted. These are enumerated in `glued`, not guessed.
- **Aliases are not renamed, and numbers are not reformatted.** Renaming an alias needs scope
  analysis — a rename that collides with a column name changes the answer — and `1.0` is REAL
  where `1` is INTEGER in SQLite, so "tidying" it would change a type and sometimes a comparison.
  Both are style channels this lever therefore leaves open; the honest claim is that it closes the
  four above, not that it makes two statements indistinguishable.

The transformation is also display-only by construction: the selector reads the canonical text, and
the arm then takes the winner *by index* from the untouched candidate list, so the statement that
executes and the statement the artifact calls the prediction are the model's own. `readableCandidates`
pins that contract, and `test/bird-canonical.test.ts` pins the rest against SQLite itself: a corpus
of 40 statements — literals whose case decides the answer, a blob, JSON operators, both comment
styles, a negative number beside a subtraction, two statements and a semicolon — is executed in both
forms and must return identical rows, plus 100 restylings of one statement that must collapse to a
single string.

### Closing the channel does not help the judge that can read SQL

The lever ran on the full dev split (run `40842268219`, second model `glm-4-flash`), one field
apart from its control:

| arm | judge | accuracy | ceiling | selection loss | two candidates agreed > took its own |
| --- | --- | --- | --- | --- | --- |
| `select-cross` | `deepseek-chat` | **61.42%** (941/1,532) | 1,005 | 68 | 21 |
| `select-cross-canon` | `deepseek-chat` | 60.97% (934/1,532) | 1,004 | 74 | 27 |

Paired: 21 cases only the control got, 14 only the canonical arm, **Δ = −0.46pp, 95% CI
[−1.21, +0.30], p = 0.31**, discordance 2.28%, and the design resolves **1.08pp**. The registered
criterion is **not met**: the two-agree group did not fall by half (21 → 27), and accuracy did not
hold.

The ceiling is the part that makes the null readable rather than disappointing: 1,005 against 1,004
means the two arms generated equally good candidate sets, and 60.97% of the cases were decided the
same way. What moved is not the material. One line in the table is sharper than the delta: the
control took the second model's statement **32** times when it was the only answer, and so did the
canonical arm — **32**. Whatever the primary judge is doing with its 68 losses, recognising the
author's prose is not it.

Three things this licenses, and two it does not. **Licensed:** canonicalisation costs nothing (no
call, no token) and changes nothing for a judge that reads SQL; the `128` that motivated the lever
is **21** under this judge, so the two numbers were never the same phenomenon; and a style channel
that is real for one judge can be absent for another, which is a fact about judges and not about
text. **Not licensed:** that canonicalisation is useless — the arm that can test it where it was
measured is `select-cross-judge-canon` (the same canonical text read by the second model, queued at
the time of writing); and not that the 6.01pp swap was "readability rather than taste", which needs
that arm to separate style from the act of reading.

### The channel is worth 1.24pp — to the judge that was using it

The same canonical text, read by the second model (run `40843792747`, full dev, second model
`glm-4-flash`). One field from its control:

| arm | judge | accuracy | ceiling | selection loss | two candidates agreed > took its own | its own alone > returned | another alone > returned |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `select-cross-judge` | `glm-4-flash` | 54.83% (840/1,532) | 1,003 | 169 | 124 | 26 of 40 (65.0%) | 13 of 26 (50.0%) |
| `select-cross-judge-canon` | `glm-4-flash` | **56.07%** (859/1,532) | 1,008 | 152 | 111 | 29 of 43 (67.4%) | 21 of 29 (**72.4%**) |

Ceiling, loss and both conversions are over the 1,506 / 1,507 cases that carry a candidate record
(`pnpm bench:bird:losses`); the accuracies are over all 1,532.

Paired: 21 cases only the control got, 40 only the canonical arm, **Δ = +1.24pp, 95% CI
[+0.24, +2.24], p = 0.020**, discordance 3.98%, the design resolves 1.43pp.

So the lever does something, and only where the channel was measured: **+1.24pp under the judge
that used it, −0.46pp (p = 0.31) under the judge that did not.** The swap cost 5.87–6.01pp in two
other runs, so closing the channel recovers roughly a fifth of it — a ratio that mixes runs and
should be read as an order of magnitude, not a measurement.

The registered mechanism, however, is **falsified**, and the two conversions say what replaced it.
The criterion asked for the two-agree group to halve; it went **124 → 111**, a tenth. The movement
is in the *other* column: when `metadata+evidence` alone held the answer, the weak judge returned it
**13 of 26** times before and **21 of 29** times after — 50.0% → **72.4%** — while its own
statement's conversion barely moved (65.0% → 67.4%) and its overall share of wins only drifted from
52.6% to 50.5%.

So the channel was not mainly a *loyalty* channel. It was a *comprehension* channel: canonical text
let the judge read a statement it did not write and see that it answered the question. That is also
why the two-agree group barely moved — two candidates that return the same rows usually do so with
**different statements** (different joins, different filters, a subquery here and a `GROUP BY`
there), and no text normalisation can collapse those, because the difference is content and not
style. Style was one channel; equivalence is another, and it is the bigger one.

That leaves a confound this file has been carrying since the first cross run and never tested:
`CROSS_SOURCES` always puts the second model's candidate **first**. Authorship and position are
perfectly correlated in every cross experiment so far, so "the judge prefers its own statement" and
"the judge prefers candidate 1" predict the same 52.6%. `select-cross-shuffled` separates them at no
extra cost — the same three statements, permuted per question id — and `pnpm bench:bird:position`
reads the result.

### Three rates are not a reading

The shuffled artifact holds one percentage per slot, four hundred to a thousand cases each. Read raw,
`52.6 / 49.1 / 55.3` and `52.6 / 20.0 / 48.0` are the same line to a reader who is not shown the
widths, and only the second is a finding. So the tool prints each stratum with a **Wilson** interval
and the two extreme strata with a **Newcombe** interval for their difference, and it says one of three
things rather than two:

| verdict | means | does not mean |
| --- | --- | --- |
| `separated` | the difference interval excludes zero: in this run, the slot moves the choice | that authorship is absent |
| `overlapping` | this run does not separate the slot from the author | **that they are the same** |
| `single-slot` | the artifact cannot answer the question at all — an arm that never moves the statement gives one number for both readings | a position effect of zero |

```bash
pnpm bench:bird:position --arm select-cross-shuffled --report eval/out/bird-eval.json
# | slot | cases | took it | took it, 95% | passed | passed, 95% |
```

`took` and `passed` are counted apart: the first is "the arm returned that source", which is what
"the judge preferred that author" means in an artifact; the second is "the answer was judged right".
They can both hold, or one can hold alone, and the gap between them is the part the judge decided
rather than the selector. Neither Wilson nor Newcombe is decoration here — the strata are exactly
where the textbook interval fails, because a slot taken on every case or on none has an estimated
variance of zero and would read as certainty.

Run `40865112253` (dev, 1,532 scorable, `deepseek-chat` judging, `glm-4-flash` writing the
`@second` candidate) is the first artifact this tool read:

| arm | slot | cases | took it | 95% | passed | 95% |
| --- | --- | --- | --- | --- | --- | --- |
| `select-cross` | 0 | 1,132 | 35.9% | 33.1–38.7 | 64.7% | 61.8–67.4 |
| `select-cross-shuffled` | 0 | 380 | 36.3% | 31.6–41.3 | 68.7% | 63.9–73.1 |
| `select-cross-shuffled` | 1 | 386 | 13.7% | 10.7–17.5 | 61.9% | 57.0–66.6 |
| `select-cross-shuffled` | 2 | 366 | 11.2% | 8.4–14.8 | 61.5% | 56.4–66.3 |

The gap is **+25.1pp**, interval **[+19.2, +30.8]**, so the verdict is `separated`. Two numbers
in that table are worth more than the verdict: `select-cross` puts `@second` in slot 0 on every
case and reads **35.9%**, while the shuffled arm reads **36.3%** on its slot-0 cases — 0.4pp
apart, intervals overlapping. Permuting the order did not change the candidate set, which is the
check the registered criteria asked for first.

Two independent measurements say "only the lever moved", and neither is sufficient alone. The
arms' `promptChars` are identical to the character (mean 2,568, max 5,570), so the permutation
added and removed nothing — but equal length does not prove equal content. The same source's own
correctness is flat across the three slots (49.7 / 45.7 / 46.7 for `@second`), which is what
content changing would have moved.

Putting all three sources on one table (the 1,129 cases that carry all three, so two-candidate
cases cannot inflate the slot-0 rate) shows what the judge is actually reading:

| source | slot 0 | slot 1 | slot 2 | its own correctness (0 / 1 / 2) |
| --- | --- | --- | --- | --- |
| `inline+evidence@second` | 36.2% | 13.8% | 11.2% | 49.7% / 45.7% / 46.7% |
| `metadata+evidence` | **79.8%** | 33.8% | 5.1% | 65.5% / 62.9% / 66.2% |
| `values` | **78.2%** | 35.0% | 7.9% | 60.0% / 69.2% / 65.0% |

Selection rate collapses with the slot; the same statement's own correctness does not move at
all. 64.7% of winners sit in slot 0. Authorship is not what the judge is following here.

**And none of it reaches accuracy.** The paired comparison in the same artifact is Δ **−0.65pp**,
McNemar 29/19, **p = 0.19**, interval **[−1.54pp, +0.23pp]**, MDE 1.27pp. Permuting the order
moved every source's selection rate by 25 to 75pp and moved the score by less than its own noise
floor. The reason is redundancy, and it is measurable in advance: cases where **only** the second
model's statement is right are **3.7–4.6%** of the set, while cases where at least one candidate
is right are 63.9–70.5%. When three quarters of the questions have more than one correct
statement, which one the judge picks barely decides whether the answer is right.

So placement is a first-class lever on the *selector* and not on *accuracy*. The registered
criteria predicted the first and prescribed work on the second; the same run falsified the
prescription. That distinction did not exist in this file before: `selectionLoss` (71 → 84 here)
measures what the selector threw away, and accuracy measures what is left after it.

One caveat about the number this experiment started from. `@second` accounts for **27.0%** of
winners in this run (409/1,517) — the judge is the primary model. The 52.6% that motivated the
shuffle came from the judge-swap run, where the second model judged its own statements. The two
are not comparable: same candidates, different judge, and a stronger second model in the swap.

### The budget the artifact already contained

Every arm satisfies an identity, exactly rather than approximately:

```
candidateRecall − selectionLoss = passed
```

| arm | ceiling | no answer in the set | selection loss | passed | selector efficiency |
| --- | --- | --- | --- | --- | --- |
| `select-cross` | 1,009 / 1,532 = **65.86%** | 523 = **34.14%** | 71 = **4.63pp** | 61.23% | **93.0%** |
| `select-cross-shuffled` | 1,012 / 1,532 = **66.06%** | 520 = **33.94%** | 84 = **5.48pp** | 60.57% | 91.7% |

That table re-prices every experiment this file has recorded over the last five rounds, because
all of them act on the third column: the judge swap (−6.01 / −5.87pp), canonical text (−0.46pp,
p = 0.31), candidate order (−0.65pp, p = 0.19), more candidates and prompt rewording (negative or
dominated). Those are not insensitive designs. The channel is **4.63pp** wide and the minimum
detectable effect at n = 1,532 is 1.27pp, so a real effect in that column is barely larger than
the design's own resolution.

The selector recovers **93.0%** of the questions whose candidate set held an answer. Taking that
to 97% would buy 4.63pp at most. The **34.14%** where the set held nothing is 7.4 times larger,
and it was never touched by any experiment here — because `candidateRecall` only became a
first-class field in ADR-192, and before that "no answer in the set" and "an answer that was
dropped" were hidden behind the same accuracy number.

The consequence is a direction, not a number: the next iteration diagnoses those 523 questions,
puts `candidateRecall` into the baseline gate alongside accuracy (65.86% is a hard ceiling, so a
recall drop that accuracy cannot see is currently silent), and builds the coverage/recall
stratification that says how much prompt coverage is worth. The third-party judge, which used to
be the only remaining exit, is now one more candidate in the narrow column.

## The card as a join closure: what it saves, and what it costs

The join measurement priced the lever and named the depth; this is the arm that sends it.
`select-prune` is one lever from `select` — the same linker, the same three samples, the same
selector — with the card cut to the tables within one join of the ones the question names, and the
whole card when the question names none. The rule lives in one function, `pruneSchema`, and both
instruments that render a prompt call it: an instrument that measured the whole card and called it
the prompt that was sent would report this lever as its parent with a longer name.

| reading | instrument | `select` | `select-prune` |
| --- | --- | --- | --- |
| characters of the generation prompt | `bench:bird:card` | 2,864 | **2,504 (−12.6%)** |
| the card's share of it | `bench:bird:card` | 74.1% | 70.3% |
| tables on the card | `bench:bird:card` | 7.3 | 5.9 |
| characters per question | `bench:bird:card` | 11,420 | **9,984 (−12.6%)** |
| the gold's tables the card holds | `bench:bird:card` | 1,022 / 1,022 | 987 / 1,022 |
| the candidate set held an answer | the run | 306 / 498 = 61.4% | 296 / 498 = 59.4% |
| characters per call, every call | the run | 2,579 | **2,309 (−10.5%)** |
| prompt tokens per call, every call | the run | 636 | **570 (−10.4%)** |
| characters per token | the run | 4.05 | 4.05 |
| accuracy | the run | 283 / 498 = 56.83% | 272 / 498 = **54.62%** |

The saving is smaller than the 58.4% ceiling the card measurement named, and smaller than the 15.1%
the join measurement priced, for three reasons that are facts about the rule rather than about the
instrument.

1. **The rule seeds itself from the arm's own linker.** The join measurement's best block used the
   `table` recaller, which is a different linker: adding a fourth recaller changes the reciprocal
   rank fusion, so the columns near the twelve-slot cutoff move and the `Likely columns` hint in
   the user message changes with them. An arm built on that set would differ from `select` by two
   levers — the hint and the card — and no delta could say which one moved the score. So the arm
   ships the shipped recallers and the depth the measurement pointed at, and nothing else.
2. **Seventy of the split's 498 questions name nothing the linker can see, and those keep the whole
   card.** That is the same population the join instrument reports, and the fallback is what makes
   it a rule a prompt can run rather than an oracle: a card built from an empty seed set would be a
   prompt with no schema in it at all.
3. **One call in four never carries the card.** The selector's prompt holds the candidates and the
   question, so cutting the card leaves it untouched: the generation prompt loses 12.6% and the
   average call loses 10.5%. The ratio of the two is the share of the bill that was prunable.

What the rule cannot ask is whether its closure held the tables the *answer* needs. That is now a
column of its own rather than an inference: the card report used to publish what the linker named,
which is identical on both arms, and the lever is a statement about the card. Comparing the tables
the rendered prompt shows against the tables the gold statement reads:

| the card the arm sends | cases | `select` | `select-prune` |
| --- | --- | --- | --- |
| holds every table the gold reads | 463 | 58.1% (269) | 56.2% (260) |
| holds some of them | 33 | 39.4% (13) | 30.3% (10) |
| holds none of them | 0 | — | — |

`select` sends a card that holds all 1,022 gold tables in all 496 cases; the pruned card holds 987,
short of one table in 33 cases and short of all of them in none — the last row being the evidence
that the no-seed fallback fires rather than a coincidence. Recall falls with it: 304 → 294 overall,
16 → 10 inside the 33, and 288 → 284 outside them. Those counts are over the 496 distinct questions,
which is what the card instrument sees once; the run's own ceiling column counts rows and therefore
reads two higher on both arms (306 → 296, the table above), because Mini-Dev lists 137 and 138 twice
and answers both.

### The same arm, two runs: 1.8pp apart, and the prompts were byte-identical

The first run of this arm (`57f70f71`) reported **281/498 against 281/498** — eighteen cases each
way, McNemar p = 1. The second (`947134b0`) reported **283 against 272**, −2.21pp, 23 lost and 12
gained, p = 0.090, CI −4.54 to +0.12pp. The two commits differ only in how the runner counts
characters and tokens: no prompt, no sample and no case changed between them.

| run | `select` | `select-prune` | Δ | exchanged | p |
| --- | --- | --- | --- | --- | --- |
| `57f70f71` | 56.43% | 56.43% | 0.00pp | 18 / 18 | 1 |
| `947134b0` | 56.83% | 54.62% | −2.21pp | 23 / 12 | 0.090 |

So a four-call arm moves 1.8pp between runs with nothing changed but the draw: three samples at
temperature 0.7, four calls, 498 questions. That number is the floor under every reading in this
section and under the cost table below, and it is larger than the gaps by which that table ranks
the arms. What survives two runs is the direction of what the closure removed, not its size:

| the cases | `57f70f71` | `947134b0` | pooled |
| --- | --- | --- | --- |
| 33 whose card lost a table | 6 lost / 0 gained | 4 lost / 1 gained | **10 / 1** (p = 0.012) |
| 463 whose card kept all of them | 12 lost / 17 gained | 19 lost / 10 gained | 31 / 27 (p = 0.69) |

Where the closure deleted a table the answer needed, the arm lost ten of eleven exchanges across
both runs. Everywhere else it is a coin, which is what "a different prompt is a different sample"
looks like: the same three-sample draw on different text, with no mechanism to prefer either. The
lever therefore has no measured gain to trade for its 10.5%: it stays a cost lever, one switch away
from `select`, rather than a candidate for the default.

### What the provider billed

The cost instruments before this one counted characters, because they never touch a provider. That
is a property of the text and not of the tokenizer, and the ratio between the two is the only
calibration either can get. `bench:bird:card` now prints both, per arm, from the artifact the run
wrote:

- `chars/call` and `tokens/call` are summed over every call a case made — three generations and the
  selector — and divided by calls. They are the same calls, message for message, which is the only
  way the ratio between them describes one request.
- `chars/token` is that ratio. It is reported rather than assumed, and a ratio below half a
  character per token fails the gate: there is no tokenizer that produces it, so the two columns
  would be describing different prompts. Here it is **4.05 for both arms**, which says the pruned
  card is not a different *kind* of text — the same characters per token, 10.5% fewer of them.
- `unbilled` counts answers that arrived without a usage block. Those calls are unknown, not free,
  and a cost column that reported them as zero would be a measurement of nothing that reads as a
  measurement of zero.

The generation prompt the card instrument renders is 2,864 characters against 636 tokens per call
over all calls; the two numbers are not supposed to divide into 4.5, because the selector's prompt
is a different text. An earlier version of this meter did divide them — the token count of four
calls by the characters of one message — and reported 1.04 characters per token, which is how a
mismatched pair announces itself: no tokenizer is that dense.

Four failures fail the build, and none of them is a target: an arm that made calls and metered
none, an arm whose token column is zero despite its calls, an answer without a usage block, and the
impossible ratio.

### What the tokens buy

With both units in one artifact the arms can be compared on what a deployment pays. Total tokens per
question, prompt and completion:

| arm | calls | tokens per question | accuracy |
| --- | --- | --- | --- |
| `names` | 1 | 598 | 36.8% |
| `inline+evidence` | 1 | **756** | 57.0% |
| `values` | 1 | 763 | 56.6% |
| `inline+repair-raw` | 1.03 | 787 | 56.6% |
| `metadata+evidence` | 1 | 1,774 | **59.2%** |
| `vote` | 3 | 2,271 | 56.8% |
| `select-prune` | 3.99 | 2,454 | 54.6% |
| `select` | 3.99 | 2,717 | 56.8% |
| `select-mixed` | 3.99 | 2,721 | 58.0% |
| `select5` | 5.99 | 4,402 | 57.4% |

Every multi-call arm is dominated here: `select` spends 3.6 times `inline+evidence` to score
0.2pp below it, `select-mixed` spends 3.6 times the same arm to score 1.0pp above it and 1.5 times
`metadata+evidence` to score 1.2pp below that, and `select5` spends 2.5 times `metadata+evidence` to
score 1.8pp below it. The pruned card does what it was built to do — 2,717 → 2,454 at a cost — and
is still 3.2 times a single prompt.

This is a reading, not an adoption. The gaps it ranks by are 1–2pp, and the table above shows a
no-op change moving an arm 1.8pp. What it does establish is that the cost axis had never been
computed against the accuracy axis in the same artifact, and that the cheapest arm here is not the
weakest one — which makes "spend fewer calls" a hypothesis with a mechanism instead of an
optimisation with a target.

### The arm the instrument could not see

The two columns of that table come from different instruments: tokens from the provider, characters
from `bench:bird:card`. They are supposed to check each other. They could not, because the card
instrument rendered a prompt the cheapest arm never sends — `buildSchema(..., { withNotes: false })`
left all 798 curated notes out of the card — and then attached the generated definition block to
every arm, including the ones whose prompt has no such block. One error made the cheapest arm look
cheaper than it is; the other made every arm look more expensive. `promptOf` now decides the source
of the column comments the way `schemaFor` in the run decides it, and throws rather than rendering a
noted arm without its notes:

| arm | prompt, rendered | of which card | card share | calls per case | characters per case, billed |
| --- | --- | --- | --- | --- | --- |
| `metadata+evidence` | 7,207 | 6,464 | 89.7% | 1.00 | **7,190** |
| `metadata+evidence+prune` | **6,232** | 5,489 | 88.1% | 1.00 | not run |
| `select` | 2,866 | 2,123 | 74.1% | 3.99 | 10,286 |
| `select-prune` | 2,507 | 1,764 | 70.4% | 3.99 | 9,210 |

Three things follow, and none of them needed a model call:

1. **The single call is 30% cheaper per case than the four-call arm**, not 3.6 times dearer. The
   generation prompt is two and a half times longer and is sent once; the four-call arm sends a
   shorter one four times, and its selector call is billed too. The frontier's ordering was right
   for the wrong reason — the token column was measured, but the block that dominates it was not.
2. **The closure is worth more here than there.** Cutting the card to the tables one join from the
   ones the question names removes 13.5% of this prompt (7,207 → 6,232) against 12.5% of
   `select`'s, because the card is 89.7% of the one and 74.1% of the other. Neither arm's savings
   depend on a model.
3. **The price is identical on both**: 33 of the 496 cases lose one gold table and none lose all of
   them, and the cases that lose one are the same cases, because the rule is the same rule. So the
   lever that cost 2.2pp on `select` has the same bet to offer on the arm that is already cheapest.

Whether that bet pays is a different question, and the artifact can now be asked it directly. The
three pairs below were computed from the per-case rows of the two runs — the same rows the report
publishes, paired by question — and are now part of `COMPARISONS` so that a run states them itself:

| pair | run `57f70f71` | run `947134b0` | per question, both draws | p |
| --- | --- | --- | --- | --- |
| `metadata+evidence` → `select` | −3.41pp (0.040) | −2.41pp (0.119) | 43 : 29 | 0.125 |
| `metadata+evidence` → `select-prune` | −3.41pp (0.033) | −4.62pp (0.003) | 48 : 27 | **0.020** |
| `metadata+evidence` → `select-mixed` | −2.61pp (0.105) | −1.20pp (0.489) | 34 : 25 | 0.298 |

Every row is negative on both runs: the arm that makes one call scores higher than the arm that
makes four. Against the pruned card the gap is the only one that clears p < 0.01 in either run
(0.003), and pooling the two draws by question — the honest unit, since the same 496 questions were
measured twice — puts it at 0.020. That is short of the 0.01 ADR-184 asks before an adoption claim,
and the p-values above are not corrected for the eight other pairs the artifact publishes: at nine
comparisons the smallest p that survives a Bonferroni correction is 0.0056, which none of these
clears. The direction is stable and the cost is measured; the effect size is not yet resolved at
n=496.

These p-values predate a fix to how a pair is built: the comparison keyed on the case id, and
Mini-Dev lists two of its questions twice (137 and 138, in a file of 500 rows for 498 questions), so
one arm's two draws of a question could be compared against the other arm's last one. The size of
that error is measured rather than assumed — on the artifact that carries it, 2 of 11 pairs move and
neither verdict changes (`23:21`, p = 0.8804, becomes `23:22`, p = 1.0000; `38:23`, 0.0722, becomes
`37:23`, 0.0925) — and those two are exactly the pairs whose counts did not reconcile with their own
delta, since `onlyFirst − onlySecond` has to equal the first arm's passes minus the second's. That
identity is now an assertion, so a pairing that drops or duplicates a pair fails instead of
publishing a table: the first run after the fix (`41107220836`) reports `select` 285 against
`select-prune` 278 as 23:16, and 23 − 16 = 7 = 285 − 278. The next run of each pair republishes its
own counts; the numbers above are what those artifacts said.

Two measurements would resolve it, and only one of them needs a run. The dev split is 1,532
scorable questions, so the same pair carries an MDE near 2.3pp instead of 4.0pp — and a 2.4pp gap
at that size is inside what the design can detect. The other is the arm in the second row of the
table above: `metadata+evidence+prune` is priced on the card measurement, and its 13.5% is the
largest saving this project has found that costs no call at all.

### Three runs, and the p-value a repeat buys

The pair above has now been run three times on byte-identical prompts — `57f70f71`, `947134b0` and
`ff9295e7` — which is enough to look at what moves and what does not:

| arm | run 1 | run 2 | run 3 | mean | range |
| --- | --- | --- | --- | --- | --- |
| `metadata+evidence` (1 call) | 59.84% | 59.24% | 59.24% | 59.44% | **0.60pp** |
| `select-mixed` (4) | 57.23% | 58.03% | 57.63% | 57.63% | 0.80pp |
| `select` (4) | 56.43% | 56.83% | 57.43% | 56.89% | 1.00pp |
| `inline+evidence` (1) | 56.22% | 57.03% | 55.62% | 56.29% | 1.41pp |
| `vote` (3) | 57.43% | 56.83% | 56.02% | 56.76% | 1.41pp |
| `select-prune` (4) | 56.43% | 54.62% | 55.02% | 55.35% | **1.81pp** |
| `select5` (6) | 59.04% | 57.43% | 56.22% | 57.56% | **2.81pp** |

The spread grows with the number of calls, which is what an arm that samples should do: every call
is another draw at temperature 0.7, so an arm that makes six of them has six chances to differ from
itself. Three points cannot fit a curve, but they rule out the assumption the previous section had
to make — that one arm's A/A floor can be lent to another. The self-pair, three times:
−0.60pp (7:4, p = 0.55), −0.40pp (8:7, p = 1), 0.00pp (7:8, p = 1). A 1-call arm agrees with itself
to within 0.6pp; a 4-call arm moves 1.8pp; a 6-call arm moves 2.8pp. Comparisons belong inside a
call-count tier, and a 2pp difference between a 1-call arm and a 4-call arm is competing with the
4-call arm's own noise, not with the 1-call arm's.

Paired by question, the three runs give:

| pair | run 1 | run 2 | run 3 | rows, pooled | per question, three draws |
| --- | --- | --- | --- | --- | --- |
| `metadata+evidence` → `select` | −3.41pp (0.040) | −2.41pp (0.119) | −1.81pp (0.321) | 105 : 69 (0.0078) | 48 : 34 (p = 0.151) |
| `metadata+evidence` → `select-prune` | −3.41pp (0.033) | −4.62pp (**0.0032**) | −4.22pp (**0.0075**) | 115 : 55 (<0.0001) | 52 : 29 (p = 0.014) |
| `metadata+evidence` → `select-mixed` | −2.61pp (0.105) | −1.20pp (0.489) | −1.61pp (0.332) | 90 : 66 (0.065) | 40 : 27 (p = 0.142) |

Two of the three runs put the pruned-card gap under 0.01 with an interval that excludes zero
(−7.19 to −1.25pp in the third), which is the shape ADR-184 asks for. Three things keep it short of
an adoption claim, and the first one is a trap worth naming:

1. **Pooling repeated runs into one McNemar test is pseudoreplication.** Stack the three runs and
   the `select` pair reads 105 : 69 at **p = 0.0078**; the `select-prune` pair reads 115 : 55 at
   p < 0.0001. Those numbers are wrong, and they are wrong in the direction that flatters the
   claim: the 1,488 pairs contain each question three times, and the same question does not become
   three questions by being asked again. Aggregating per question first — a sign test over the 496,
   which is the unit that was sampled — gives 48:34 (p = 0.151) and 52:29 (p = 0.014).
2. **Nine comparisons are published.** A Bonferroni floor of 0.05/9 = 0.0056 leaves one run
   (0.0032) and not the other (0.0075).
3. **The gap shrank against `select` and held against `select-prune`.** −3.41 → −2.41 → −1.81pp is
   three draws of a quantity near −2.5pp; −3.41 → −4.62 → −4.22pp is three draws near −4pp. Only
   the second interval excludes zero in two runs.

So the reading on this split is: **the single call is 28% cheaper than the pruned card (1,774
against 2,454 tokens per question, 1 call against 4) and 4pp more accurate, twice at p < 0.01.** The
size of that effect is the one thing three runs of 496 questions cannot settle, which is why the
next section asks the same question on 1,532.

## The dev split, asked once: four calls buy 0.39 points

One run of the split the leaderboards report (`41085194983`), three arms, `deepseek-chat`, 1,532
scorable of 1,534. The pair that decides the cost question is `metadata+evidence` against `select`;
the third arm is there because the pruned card has been measured on every run so far and would
otherwise be the only arm whose dev reading is missing.

| arm | execution accuracy | calls/case | tokens/case | chars/case | candidate recall |
| --- | --- | --- | --- | --- | --- |
| `metadata+evidence` | 61.49% (942) | 1.00 | **1,778** | 7,474 | — |
| `select` | **61.88%** (948) | 3.99 | 2,441 | 9,950 | 65.8% (1,008) |
| `select-prune` | 60.38% (925) | 3.99 | 2,222 | 9,057 | 64.0% (980) |

| pair | delta | 95% CI | p | MDE |
| --- | --- | --- | --- | --- |
| `metadata+evidence` → `select` | **+0.39pp** | −1.22 … +2.00 | 0.691 | 2.30pp |
| `metadata+evidence` → `select-prune` | −1.11pp | −2.76 … +0.54 | 0.216 | 2.36pp |
| `select` → `select-prune` | −1.50pp | −2.84 … −0.17 | **0.035** | 1.91pp |

Three things this settles, and one it does not.

1. **Four calls buy 0.39 points.** The single-call arm and the four-call arm are 0.39pp apart over
   1,532 questions, with an interval that spans zero. At an MDE of 2.30pp this design would have
   seen a 2pp difference; it did not see a difference at all. The bill is 2,441 against 1,778 tokens
   per question — **37% more for 0.39pp, or 0.13pp per extra call**.
2. **The claim is non-inferiority, not equality.** "The same" is not something 1,532 questions can
   establish, and writing it would be the error this document spends its length avoiding. What the
   interval supports is: against a 2pp margin, the single call is not worse. One-sided at that
   margin, z = (0.39 + 2) / 0.82 = 2.91, p ≈ 0.002 — and 0.002 survives a Bonferroni floor of
   0.0167 for the three pairs in the table.
3. **The 2.5pp gap did not reproduce; the 1.5pp cost of the pruned card did.** Mini-Dev's three
   runs put `metadata+evidence` 2.54pp above `select` on average; dev puts it **0.39pp below** —
   the two splits do not even agree on which arm leads. This paragraph said "above" until the
   artifact was re-read against its own table, which is the quietest way for a document to lose the
   finding it exists to report: a sign that flips between splits is the strongest statement here,
   and "the gap shrank" is a weaker one that happens to look reasonable. The pruned card, by
   contrast, is −1.54pp on Mini-Dev (three-run mean) and −1.50pp here — the same number on both
   splits and in five runs. **A comparison that flips sign between splits is a sample; an arm that
   lands on −1.5 five times is a cost.**

What it does not settle is whether the selector pays at all, because the answer depends on the
generator: the three-candidate ceiling here is 65.8%, the selector returns 94.0% of it (948 of
1,008), and a 94% selector over a 65.8% ceiling cannot beat a single draw that is already at 61.5% by
much. The arithmetic of where the next point comes from is in *The ceiling, not the selector*, and
this section's contribution is narrower: it prices the four-call chain at +37% for +0.39pp on the
split that matters.

### What a comparison has to hold, and none of these do

The dev split is the one published systems report, so a gap can be named — but naming a gap is not
measuring one. Two numbers are comparable only if they share five coordinates: the split and its
exact question set, the model, the harness that renders the prompt, the executor that runs the
statement, and the judge that compares result sets. The published numbers below share at most one
of them with ours.

| system | BIRD dev EX | model | trained | what it shares with us |
| --- | --- | --- | --- | --- |
| SQLConductor | **73.2%** | Qwen3-8B policy + Gemma4-31B actions | yes (SFT + GRPO) | the split |
| CHASE-SQL | 73.0–73.01% | Gemini-1.5-Pro | selection agent fine-tuned | the split |
| DeepEye-SQL | 70.6% | Qwen2.5-Coder-32B | yes | the split |
| Alpha-SQL | 69.7% | Qwen2.5-Coder-32B | yes | the split |
| OpenSearch-SQL | 69.3% | GPT-4o | multi-agent, no fine-tune | the split |
| RSL-SQL | 65.51% | DeepSeek-v2 | no | the split, and a sibling model |
| MSL-SQL | 64.00% | DeepSeek-V2.5 | partial | the split, and a sibling model |
| **this harness, `select-mixed`** | **62.34%** | deepseek-chat | no | — |
| **this harness, `metadata+evidence`** | 61.16% | deepseek-chat | no | — |
| **this harness, `inline+evidence`** | 61.10% | deepseek-chat | no | — |
| **this harness, `select`** | 60.97% | deepseek-chat | no | — |
| this harness, `names` | 41.91% | deepseek-chat | no | — |

Read the last column first. It is empty for every row but ours, and that is the finding. Our five
rows now come from one run (the section above), which is what makes them comparable to each other:
the same arm on two runs has moved 0.66pp (`select-mixed`, 63.0 → 62.34) and 0.91pp (`select`,
61.88 → 60.97) across this project's history, so a cross-run difference under a point is not a
reading and every number in this table would otherwise be a cross-run difference. Three
differences used to be reported from this table — 11.3pp, 2.1–3.6pp, 5.5pp — and not one of them is
a claim about the pipeline. The honest version of each is narrower:

- **10.9pp to the leaderboard's top** (62.34 → 73.2) is a difference in model and training, not in
  method. The top five rows run backbones this harness cannot call, and four of them were trained on
  the task. A pipeline that is 11pp behind a trained Qwen3-8B policy has learned nothing about its
  own prompts.
- **2.1–3.6pp to the DeepSeek-family systems** (RSL-SQL 65.51, MSL-SQL 64.00) is the closest thing
  here to a method comparison and still is not one: `deepseek-chat` today is not the `DeepSeek-v2`
  RSL-SQL was built on, their candidate sets come from their own prompts, and both numbers were
  produced by harnesses that execute and judge differently from this one. The gap is a lead, not a
  measurement.
- **5.5pp to a strong model's zero-shot baseline** measures the opposite of method: how much
  accuracy a bigger model buys, which is precisely the axis this project does not optimize for.

What this document does own is every *paired* comparison inside a single run: same questions, same
model, same executor, same judge, one lever apart. Those deltas are the only ones quoted as findings
anywhere above, and they are the reason the arms exist.

A comparison that would count has to be run where the numbers are produced — a pinned competitor
commit, checked out on this repository's runner, driving the same endpoint and model on the same
question file, with its predictions scored by this harness's executor and judge — and each
coordinate is a way for a model difference to wear the clothes of a method difference:

| coordinate | how it is held | what breaks when it is not |
| --- | --- | --- |
| question set | the split's own file, and the count is checked against the baseline | a sample that is easier for one pipeline |
| model | one `LLM_MODEL` and one endpoint, set by the workflow | a stronger backbone read as a better method |
| prompt | the competitor's own templates, unmodified | two levers changed and one attributed |
| executor | this repository's oracle, one process per run | dialect differences read as errors |
| judge | `judgeOfficial` over executed result sets | two judges, two scores, one table |

None of those runs existed when this table was written. The harness for them does now, and it is the
table above written as code rather than as prose:

| piece | what it holds | what it refuses |
| --- | --- | --- |
| `eval/competitors/pins.json` | two competitors at a full sha, with the date, the licence, the entrypoint and how its output names questions | a branch, a tag or a short sha |
| `eval/competitors/patches/*.patch` | one adapter each — the engine alias, and one row renumbering where their own bookkeeping demands it | a patch that stopped applying, checked before a model call |
| `eval/competitors/probe.ts` | the checkout against the pin, the patch against the checkout | a run from a half-patched tree |
| `eval/competitors/subset.ts` | the question file, cut by the same `stratifiedSample` that cuts `BIRD_LIMIT`, and read back by `readIdMap` as the numbering a row-numbered pipeline answered in | two samples read as one question set |
| `eval/competitors/predictions.ts` | the three shapes competitors write, and what each left out | an accuracy whose denominator is the answered subset |
| `eval/competitors/score.ts` | their statements through `oracle.py`, judged by `judgeOfficial` | any accuracy before all five coordinates hold, and any accuracy at all from a file with no records |
| `eval/competitors/attribute.ts` | which of the questions they won were in our pool and which were never written, and what the statement that beat us had | a join whose four counts disagree with the score's own, and a "lift" for a flag that fired on every question |

The two pins are CHESS (`ShayanTalaei/CHESS`, Apache-2.0, five agents, ten-plus-ten candidates a
question) and MAC-SQL (`wbbeyourself/MAC-SQL`, no licence file, three agents, two or three calls a
question, and therefore the cheap one to run first). `score.ts` counts an unanswered question as
wrong, because that is the denominator our own numbers use; it prints the answered share beside the
accuracy and a declared-database disagreement beside both.

`workflow_dispatch` on `competitors.yml` runs it in two stages. `probe` checks the checkout against
the pin and the patch against the checkout, for the price of a clone and no model call. Both pins
have been probed on a runner: `41149938353` reads MAC-SQL's head as `31a9df5e`, six of six named
files present, nine pinned requirement lines, adapter applies; `41150217544` reads CHESS's head as
`3d6e835f`, eight of eight, twenty-eight requirement lines, adapter applies. Neither produced a
number, which is what the stage is for — and after the fourth hunk named `core/agents.py`, the run
that produced the first reading reports seven of seven present, adapter applies, four files changed.
`full`
installs their dependencies, runs their own inference over the subset, runs one arm of ours over the
same subset, and scores theirs against ours with the paired delta, its McNemar p and the MDE of the
design that produced it.

The first `full` dispatch ran, and its reading is why two mechanisms in this tool exist. It finished
**green with a zero-byte predictions file**. MAC-SQL's `run.py` enumerates its batch by position and
compares `question_id` against `range(len(batch))`, so a question file carrying BIRD's own ids — this
split's start at 36, not 0 — matched no row: the batch emptied, `0it [00:00, ?it/s]` was printed
and an empty file was written. `score.ts` then scored that empty file as **0% on 25 questions** and
reported a **60pp gap as significant** (p = 6.1e-05) — the exact failure this section exists to
prevent, produced by this repository's own tool on its own first run.

That first dispatch is worth reading twice, because the second one failed differently and for a reason
that is theirs: with the batch no longer filtered empty, all twenty-five questions raised
`sqlite3.OperationalError: unable to open database file`. Their `core/agents.py` normalises the
database root with `data_path.strip('/')`, which removes the **leading** separator as well as the
trailing one — so the runner's absolute root became a relative path, every `sqlite3.connect` resolved
against the working directory, and `run.py` caught the exception per question, slept twenty seconds,
and wrote an empty output. A green pipeline that measured nothing, for the third time.

Four fixes, three of them on the reading side and one on theirs:

1. **A file with no records is missing input, not a measurement of zero.** It stops the run with
   `holds no records at all` and exits non-zero. The same check covers the other two ways a file can
   be silent — every statement numbered outside the question set, and every record naming a question
   the split does not hold — and names which of the three it was. A file whose records are all
   *blank* still scores 0%, because that run happened and the model returned nothing for every
   question; the difference is whether the pipeline wrote anything that could be attributed.
2. **A row-numbered pipeline is a declared renumbering, not an unreadable file.** `pins.json`
   records `numbering` per competitor (`position` for MAC-SQL, `question-id` for CHESS); the score
   step passes `--id-map <subset>` only for the first, and `readIdMap` reads that same file back as
   position → question id. A declared map governs **every** record, including one whose number also
   happens to be a question id: letting each record pick whichever numbering resolves it would make
   the pairing depend on which ids are small, so one file would pair differently against a different
   subset.
3. **The adapter patch's third hunk renumbers at their I/O boundary**, keeping the original id under
   `bird_question_id`, and its fourth turns `strip('/')` into `rstrip('/\\')` so an absolute database
   root stays absolute. The selector, the decomposer, the refiner, the prompts and the sampling counts
   are untouched, which is what makes the run still their method.
4. **Problems are printed before the verdict, not after the accuracy.** The second dispatch's own
   output printed `no accuracy: nothing was judged` with no line saying that every question had failed
   to open its database, because the problems were only printed on the way out of the happy path. An
   explanation that only appears when nothing went wrong is an explanation that is never read.

### The first comparable reading: MAC-SQL on twenty-five of our questions

`41162862386` is the first run in this repository where the only difference between two numbers is
the pipeline. MAC-SQL at `31a9df5e`, on this runner, pointed at the same endpoint and model, given the
same 25 questions (set hash `51ad259b9396483c`), its statements executed by `oracle.py` and judged by
`judgeOfficial`:

| | MAC-SQL | `metadata+evidence` |
| --- | --- | --- |
| answered | 25/25 | 25/25 |
| statements that ran | 25/25 | — |
| correct | 19 | 16 |
| accuracy | **76.00%** [56.57, 88.50] | 64.00% |

Paired case by case: 14 both, 5 only theirs, 2 only ours, 4 neither. The delta is **12.00pp in
MAC-SQL's favour**, McNemar p = **0.4531**, against an MDE of **29.65pp** for this design. That is
inside the resolution, so the reading is a sign and not a size: on 25 questions a 12-point gap and a
zero are the same reading, and resolving a 2pp effect at this discordance would need **5,495**
questions.

Three things make the number checkable rather than merely printed. The ledger has no unknown ids, no
duplicates, no blank answers and **no database disagreements** — every one of the 25 records declared
the database of the question its position resolved to, which is the check that would have failed first
had the renumbering been off by one. The artifact carries the declared `idMap` and the `renumbered`
list beside the rate. And both sides answered the same 25 questions, checked by hash rather than by
the workflow remembering to pass the same limit twice.

What it does not say: nothing here is comparable to the leaderboard table above, and 25 questions is a
smoke run. What it does say is the thing this section has never been able to say — **the apparatus
produces a reading with a direction, and the direction is not in this harness's favour.**

The discipline that retired five arms still holds for the rest: a number from a half-installed
pipeline is a number about an install, and a number from an empty file is not a number at all — the
two dispatches before this one were both refused by exactly that rule. Until a fuller run resolves one
of these deltas, the correct statement about the leaderboard is still: **this harness is 11.3pp behind
the published state of the art, how much of that gap is the pipeline remains unknown, and the first
paired measurement available points the same way as the assembled one.**


### The split is 500 rows and 498 questions, and 496 of them can be judged

Three different counts have been called "the split" in this document, and only the smallest of them
is a denominator. The file carries **500 rows**; it names **498 questions**, because ids 137 and 138
each appear twice, byte for byte, at positions 484/487 and 485/488; and a run scores **496**, because
two gold statements do not finish inside the executor's thirty-second budget. Until this round the
harness read the file as a list of rows and treated `500 - 2 gold failures = 498` as the question
count, which meant one arbitrary question was asked, weighted and scored **twice**.

The two repeats are exact duplicates, not variants: same question text, same evidence, same gold
statement, same database. Every arm answered both copies the same way in twelve out of twelve arms,
which is what an indistinguishable duplicate should do — and is also why collapsing them changes no
verdict:

| arm | over 498 rows | over 496 questions | change |
| --- | --- | --- | --- |
| `names` | 180/498 = 36.14% | 180/496 = 36.29% | +0.15pp |
| `synth-definitions` | 202/498 = 40.56% | 201/496 = 40.52% | -0.04pp |
| `inline-definitions` | 202/498 = 40.56% | 201/496 = 40.52% | -0.04pp |
| `inline+evidence` | 281/498 = 56.43% | 279/496 = 56.25% | -0.18pp |
| `inline+retrieval` | 203/498 = 40.76% | 202/496 = 40.73% | -0.04pp |
| `inline+icl` | 207/498 = 41.57% | 206/496 = 41.53% | -0.03pp |
| `inline+repair` | 281/498 = 56.43% | 280/496 = 56.45% | +0.03pp |
| `inline+repair-raw` | 284/498 = 57.03% | 283/496 = 57.06% | +0.03pp |
| `values` | 285/498 = 57.23% | 284/496 = 57.26% | +0.03pp |
| `metadata+evidence` | 290/498 = 58.23% | 288/496 = 58.06% | -0.17pp |
| `select` | 289/498 = 58.03% | 288/496 = 58.06% | +0.03pp |
| `inline+evidence#2` | 284/498 = 57.03% | 283/496 = 57.06% | +0.03pp |

Computed from the cases of `41158744927`, not re-run: the same file answers both questions. The
largest movement is **0.18pp**, and the harness's own noise at this size — the A/A pair
`inline+evidence` against `inline+evidence#2` in the same run — is **0.81pp** over the same
denominator. So the correction changes no reading above. It changes what the reading *is*: a rate per
question rather than a rate per row of somebody else's file, and one in which no question is asked
twice.

The two questions that cannot be judged are `701` (`codebase_community`) and `518` (`card_games`),
both `OperationalError: interrupted`, which is this harness's own progress handler stopping a
statement at thirty seconds. Measured on one machine, with the same files: `518` finishes in **39.4 s**
and `701` does not finish in **120 s**. So one is a slow query just over the budget and the other is a
pathological plan, and neither is a statement a pipeline can be scored on. The budget stays at thirty
seconds — BIRD's reference harness uses a thirty-second wall clock, and a budget raised between two
rounds makes the later round's number incomparable with the earlier one. What changes is that both
questions are now **named**, in `gold.unrunnable` in full rather than the first twenty, in the scope
line of a competitor's score, and in the artifact beside the rate.

Three things went wrong because of the counts, and each one is a way a rate can be about something
other than what it says:

1. **`available: 500` was a row count printed as a question count.** `selection` in the artifact now
   carries `rows`, `available` and `repeats` separately, and the run prints the shape of the file
   above the first arm: `minidev: 500 row(s), 498 question(s) — 137, 138 repeat byte-for-byte and are
   counted once`. A reader who stops after that line still knows what the denominator is.
2. **`scored < available` was read as "this run sampled the split".** Two gold refusals make that
   inequality true on a whole-split run, which meant a mixed-candidate arm's feasibility guard was
   switched off for a reason that has nothing to do with sampling — the guard that refuses three
   prompts for one opinion. Sampling is now `selected.length !== questions.length`, recorded as
   `selection.sampled`.
3. **A question whose gold refused was read as an unknown id in a competitor's file.** `score.ts`
   parsed their answers against the questions *this harness could judge*, so any question it could
   not judge came back as `unknown`, which is an accusation about their numbering. Their statements
   are now read against the questions both pipelines were **asked**, the coordinate compares asked
   against asked, and the difference is reported as an exclusion with the executor's own reason.

That third one was not cosmetic: it is why the full-split comparison below is even possible. The
question-set coordinate compared the competitor's 498 declared questions against this harness's 496
judged ones and would have called the run **not comparable** for a reason neither pipeline controls.
And `readIdMap` refused a 500-position map for a file with two repeats — correctly, because a position
would no longer name one question — which is why the subset a competitor is given is now cut from
questions rather than from rows.

### The scope line: what a rate is a rate about

`score.ts` prints, before the answered count and above the accuracy:

```
  scope: the whole minidev split — 498 of 498 question(s), 500 row(s) in the file; 137, 138 appear
  twice and are counted once, 496 judged; 2 outside the comparison because the gold statement would
  not run (518: OperationalError: interrupted, 701: OperationalError: interrupted)
```

and for a sample:

```
  scope: 25 of the minidev split's 498 question(s), 500 row(s) in the file — a sample: every rate
  below is a rate about these 25
```

Until this round a sampled run and a whole-split run printed the same shape of line — `answered:
25/25 (100.00%)` — and the only thing that distinguished them was a number neither the line nor the
artifact carried. The scope is one line and one artifact field, and it is the cheapest honest thing
this section has.


### Where the pruned card's 1.5 points go

The pruned card loses 28 reachable questions (ceiling 1,008 → 980) and returns 925 instead of 948.
If its selector were as good as the full card's, the smaller ceiling would still pay 28 × 0.94 ≈ 26
questions, i.e. 948 → 922 — and it returns 925. So **the loss is the ceiling, not the selector**: the
card that omits a table the question needs makes the answer unreachable, and the selector cannot
pick what was never written.

The difficulty split says the same thing from the other side:

| difficulty | `metadata+evidence` | `select` | `select-prune` | prune − select |
| --- | --- | --- | --- | --- |
| simple (925) | 614 (66.4%) | 626 (67.7%) | 607 (65.6%) | −2.1pp |
| moderate (463) | 249 (53.8%) | 245 (52.9%) | 248 (53.6%) | +0.7pp |
| challenging (144) | 79 (54.9%) | 77 (53.5%) | 70 (48.6%) | **−4.9pp** |

The loss is not confined to one stratum, which is the honest reading: −19 questions simple, +3
moderate, −7 challenging. Challenging is the worst *rate* (4.9pp on 144 questions) and simple is the
largest *count* (19 of 1,532) — a one-hop closure is not "enough for the easy ones", it is a draw
whose cost is spread across the split and slightly worse where the question names fewer tables. The
only claim the table supports is the net one that matches the ceiling arithmetic: the pruned card
loses reachable questions, and everything else follows from that.

### Where the four points they lead by actually sit

`score.ts` says which questions each side won. It cannot say whether a question they won was one a
better selector could have taken out of a pool we already had, or one whose statement we never wrote.
That is the difference between a selection fix and a generation fix, and on 498 questions it is worth
a zero-call instrument rather than an opinion. `bench:competitors:attribute` re-executes both sides'
statements with `oracle.py`, judges them with `judgeOfficial`, and then **requires its four counts to
equal the score artifact's own** — a join that disagrees is refused, because two readings of the same
pair of files must print the same numbers.

```bash
pnpm bench:competitors:attribute --report eval/out/bird-eval.json \
  --score eval/out/competitors/mac-sql-score.json \
  --predictions eval/out/competitors/predictions.json \
  --id-map eval/out/competitors/mac-sql-subset.json
```

Reading of `41856780841` (MAC-SQL 65.12% against `select-mixed` 60.28%, 496 judged, and the counts
reproduce that artifact exactly: 58 / 34 / 265 / 139):

| bucket | questions | points |
| --- | --- | --- |
| they won and we did not | 58 | 11.69pp |
| — our pool held a correct statement (**selection**) | 9 | 1.81pp |
| — our pool held none (**generation**) | 48 | 9.68pp |
| — no candidate statement recorded (**unreadable**) | 1 | 0.20pp |
| we won and they did not | 34 | 6.85pp |

What their winning statement had that none of our candidates had, over the 48 generation cases:

| kind | questions | points | the fix it names |
| --- | --- | --- | --- |
| `condition` | 28 | 5.65pp | a filter none of our candidates writes |
| `table` | 7 | 1.41pp | a table none of our candidates reads |
| `literal` | 6 | 1.21pp | a value inside a filter we did write |
| `projection` | 3 | 0.60pp | a column none of our candidates selects |
| `window` | 2 | 0.40pp | an order or a limit none of our candidates applies |
| `aggregate` | 1 | 0.20pp | a function none of our candidates calls |
| `grain` | 1 | 0.20pp | a grouping none of our candidates applies |

The same reading in the other direction, over the 34 questions we won: `condition` **19**, `table` 5,
`projection` 4, `aggregate` 2, `over-filter` 2, `grain` 1, `literal` 1. The same kind leads on both
sides, which is the first useful thing the table says: the two pipelines do not differ in which
capabilities they have, they differ in **which filters they think the question asks for** — and each
of them writes conditions the other never writes.

Three claims the reading settles:

1. **The gap is not selection.** 1.81pp of their 4.84pp sits on questions whose correct statement was
   already in our pool. The remaining 3.03pp is a statement none of our four candidates wrote — and
   those four are two prompt shapes sampled twice, so it is not a sampling shortfall either.
2. **The largest generation kind is a missing filter condition** (28 of 48, 5.65pp), not a missing
   value. That is worth stating against the expectation this campaign carried for several rounds:
   the value lever was the one already priced twice (`samples` reaches 62.14%, +1.24pp, p = 0.0756,
   oracle ceiling +2.82pp) and it accounts for **six** of the 48. The bucket that is actually large is
   the one `I-45` names — a condition the question implies and the prompt never forces — and it is
   the only bucket in this table that clears the run's own 5.42pp resolution, by 0.23pp.
3. **The axis is large in both directions and the net is not.** The same kind accounts for 19 of our
   34 wins, so the net is 9 questions = 1.81pp, which sits inside the resolution. What this run
   establishes is the *size of the axis*, not an advantage we could bank: both pipelines are guessing
   which filters the question wants, and neither is systematically better at it.

And one claim it refuses:

**No net bucket can be priced here.** The widest single-direction bucket (5.65pp) clears the 5.42pp
resolution by a fifth of a point, and every net difference — 9 questions on this axis, 1.81pp of
selection, 6 for `table` — is inside it. The verdict line says which is which instead of ranking
buckets the design cannot separate, and the dev pair (`41953255372`, 1,532 questions, same
instruments) is the run that can — the next section is that run.

The components, as a lift on winning — and the first row is where the instrument caught itself:

| component | won when it fired | won when it did not | lift |
| --- | --- | --- | --- |
| `decomposed` (their decomposer wrote sub-questions) | 58/496 | 0/0 | **— no contrast** |
| `refined` (their refiner rewrote the statement) | 2/26 | 56/470 | −4.22pp |
| `retried` (more than one attempt) | 2/26 | 56/470 | −4.22pp |
| `extracted` (the extractor pruned the schema) | 50/426 | 8/70 | +0.31pp |

MAC-SQL's decomposer runs on every question, so the first version of this table printed **+11.69pp**
for it — which is not a lift, it is their win rate with a plus sign, and it is the same error as
reading a mean that is constant by construction. The instrument now publishes `null` for a flag with
no contrast and prints which half is missing. What survives here is the refiner's **−4.22pp**: it
fires on 26 questions and wins 2, which is the shape of a mechanism that engages *after* the pipeline
has already failed — **and that reading does not survive the wide split**, where the same pair of
flags on 103 questions is +14.40pp; see *the same pair on dev* below, which retracts it. The
decomposer's contribution cannot be read from this artifact at all: it would need an ablation on
their side, not a correlation on ours.

The same instrument caught a second defect in itself before this table was published, and it is the
more embarrassing one. The first version extracted condition atoms from the raw statements, and the
atom splitter matches `where` and `and` **case-sensitively**: MAC-SQL spells `WHERE` in upper case on
**472 of its 498** statements, so that version read their filters as absent across the split,
published `condition: 0`, put 17 cases in `literal`, and produced a table that looked exactly like a
reading. Normalising through `statementShape` — which lowercases, rewrites aliases and collapses
whitespace — moved 28 cases into `condition` and reversed the conclusion above. A fixture whose
statements are all lower-case cannot see this, so there is now a case for upper case and a case for
aliases, and the lesson is the ordinary one: **a taxonomy built on a splitter inherits the splitter's
sensitivities, and the way to find out is to run it on somebody else's spelling.**

`bench:bird:conditions` reads the same artifact from the other side and lands on the same population.
It compares our failures against the **gold** rather than against their statements, and on
`select-mixed`/Mini-Dev it finds **80 of 197 failures (40.6%) with no condition at all on a column the
gold filters**, 117 that write every gold condition somewhere. That number is not new — 39.2% was
recorded on `inline+evidence+samples` and the value block was measured to leave the population
untouched — but the two instruments now say the same thing from opposite directions: the largest
mechanical class in our failures is a filter we never wrote, and the largest single bucket in their
advantage is the same filter. **The next lever is condition coverage, and it is not the value
family**, which has been priced twice and returns about a third of a ceiling that this gap does not
sit under.

On the dev artifact the same instrument reads **567 failures of 1,532, of which 216 (38.1%) have no
condition at all on a column the gold filters** — 325 missing conditions in total, and 351 failures
that write every gold condition somewhere. That is the number the next lever has to be built
against, and it prices three things before a single call is spent:

| quantity | value | what it decides |
| --- | --- | --- |
| questions any condition gate could reach | 216 (14.1%) | how often the extra call would fire |
| cost at one call per reached question | +0.14 calls/question (+3.5%) | inside the 10% budget `8o` set |
| ceiling if every reached case were fixed | +14.1pp | the largest the lever could possibly be |
| price the same lever already returned, on one statement | +1.01pp | what a *ungated* audit bought |

The gate is the design decision, not the audit: an audit on every question costs a call for 86% of
questions that already write the condition, and the instrument says those questions exist. What the
ceiling cannot say is the yield — a gate that fires on 216 questions and fixes 20 is +1.3pp, and the
measured +1.01pp for the ungated version suggests that is the range to expect rather than the
ceiling.

### The same pair on dev: the sign holds, the ceiling does not

Run `41953255372`, dispatched with `split: dev` and an **empty** `limit` — the whole split, not a
sample of it — and the two arms byte-for-byte the ones Mini-Dev measured: our `select-mixed` (three
candidates, model selection, four calls) and MAC-SQL at `31a9df5`.

| | Mini-Dev `41856780841` | dev `41953255372` |
| --- | --- | --- |
| questions judged | 496 | **1,532** |
| MAC-SQL | 65.12% | **67.89%** (1,040) |
| `select-mixed` | 60.28% | **62.99%** (965) |
| Δ (ours − theirs) | −4.84pp | **−4.90pp** |
| MDE | 5.42pp | **2.93pp** |
| exact McNemar | — | **p = 3.4 × 10⁻⁶** |
| resolves | no | **yes** |
| our `calls.mean` | 3.99 | 3.99 |

`8l` pre-registered the test: the sign is established only if `|Δ| > MDE` **and** `p < 0.05`. On dev
both hold — **we trail MAC-SQL by 4.90pp and the estimate resolves**. What does not survive is the
leaderboard row that made the question look like a contradiction: "dev ahead by 4pp" was never this
arm measured on this split. The two splits now agree in sign and in size (−4.84 / −4.90); Mini-Dev's
number was simply too coarse to say so, and the contradiction was a comparison between an instrument
and a leaderboard.

Repeatability, from three runs of the same arm on the same split: **955, 967, 965** (62.34%, 63.12%,
62.99%) — a 0.78pp spread at temperature 0.7, still nearly four times below the resolution. That is
the number to hold against any future delta on this split.

The pair above is `select-mixed` because that is the arm Mini-Dev measured, and comparability was
the point of the dispatch. The **shipped default** is the free rule (`select-mixed-rule`, 3.00 calls),
and on the same split it reads **63.97% (980/1,532)** — so the gap to the same competitor is
**3.92pp**, not 4.90pp, for one call less per question. Both numbers are behind, and the two
measurements agree on where the mass is: the rule and the model selector draw on the same pool.

**Selection cannot close this gap even if it were perfect.** Our four candidates hold a correct
statement on **1,031 of 1,532** questions — a candidate recall of 67.30% — and MAC-SQL sits at 67.89%.
A selector that never chose wrongly would land **0.59pp behind them**, inside the 2.93pp resolution,
i.e. level. Every point above that ceiling has to come from a statement we did not write.

The attribution instrument, on the same artifact (counts reconciled with the score's own
166 / 91 / 874 / 401):

| bucket | questions | points |
| --- | --- | --- |
| they won and we did not | 166 | 10.84pp |
| — our pool held a correct statement (**selection**) | 38 | 2.48pp |
| — our pool held none (**generation**) | 125 | **8.16pp** |
| — no candidate statement recorded (**unreadable**) | 3 | 0.20pp |
| we won and they did not | 91 | 5.94pp |

Over the 125 generation cases, what their statement had that none of ours had:

| kind | questions | points |
| --- | --- | --- |
| `condition` | **61** | **3.98pp** |
| `literal` | 22 | 1.44pp |
| `table` | 17 | 1.11pp |
| `projection` | 8 | 0.52pp |
| `window` | 7 | 0.46pp |
| `aggregate` | 6 | 0.39pp |
| `other` | 2 | 0.13pp |
| `grain` | 1 | 0.07pp |
| `over-filter` | 1 | 0.07pp |

And in the other direction, over the 91 we won: `condition` **42** (2.74pp), `table` 19 (1.24pp),
`projection` 12 (0.78pp), `aggregate` 7, `over-filter` 7, `window` 4. `condition` leads both
directions on the wide base as it did on the narrow one, with the same shape and about the same size
(5.65 vs 3.98pp theirs; 3.83 vs 2.74pp ours) — so it is an axis of the two pipelines, not an artifact
of Mini-Dev's 500-row databases.

The run's verdict line, at its own 2.93pp resolution: the selection share (2.48pp) is inside it and
**cannot be priced**; `condition` (3.98pp) clears it and **can**. `literal` at 1.44pp does not. Of the
nine kinds this taxonomy can name, exactly one is priced by this run, and it is the one `I-45` has
been describing for several rounds.

The components, and the reading that reverses:

| component | won when it fired | won when it did not | lift (dev) | lift (Mini-Dev) |
| --- | --- | --- | --- | --- |
| `decomposed` | 166/1,531 | 0/0 | **— no contrast** | — no contrast |
| `refined` | 25/103 | 141/1,428 | **+14.40pp** | −4.22pp |
| `retried` | 25/103 | 141/1,428 | +14.40pp | −4.22pp |
| `extracted` | 144/1,322 | 22/209 | +0.37pp | +0.31pp |

**The −4.22pp is retracted.** It was read off 26 questions and 2 wins, and on 103 questions and 25
wins it is +14.40pp: their refiner fires on the 7% of questions whose first statement did not
execute, and 24% of those end up right against 9.9% of the rest. So "reproduce their refiner is
contradicted by their own output" was a small-sample artifact of the narrow split. What survives is
the weaker, structural claim: the refiner engages *after* failure, so its lift is the value of a
second attempt on a failed execution — not of asking a better question the first time — and it says
nothing about the 93% of questions that execute on the first try.

`refined` and `retried` fire on the same 103 questions and win the same 25, because the refiner runs
**because** the first attempt failed. The instrument now prints that identity (`one event, 2 names`)
instead of two rows that read as two findings. The flags stay: they are the competitor's own
vocabulary, and a run that separates them would make the note disappear by itself.

One more self-correction, and it is the third this instrument has caught in itself. Two cases were
filed as `identical` — "the artifact contradicts itself: both sides wrote the same statement and the
judge disagreed with itself". They were not: the pipeline wrote `'Banned'` where we wrote `'banned'`,
and `'east Bohemia'` where we wrote `'East Bohemia'`. `statementShape().text` drops case **inside
quotes** because it exists to compare shapes, where those pairs are the same filter; comparing
statements needs the opposite, since BIRD's judge compares result rows. `identical` now also requires
the literals to match case-sensitively, both cases moved to `literal` (6 → 22 on dev's 20, i.e. two
cases and 0.13pp), and a test would fail if they moved back.

What this leaves, in one sentence: **the 4.90pp is generation, the largest generation bucket is a
filter we never wrote, and it is the only bucket this run can price.** The next lever is condition
coverage (`I-45`); the value family is second at 1.44pp and has already been priced twice, returning
about a third of a ceiling this gap does not sit under.

#### What the condition bucket is made of, and one round in which its breakdown was wrong

`condition` is 61 of the 125 generation cases (3.98pp) and the only bucket on dev that clears the
run's 2.93pp resolution. A name is not a finding, so the instrument splits the bucket by **where the
missing value went**:

| where the value is | questions | points | what a fix would be |
| --- | --- | --- | --- |
| the same column, a different condition | **27** | 1.76pp | already filters that column; the condition is wrong |
| another column of the same table | 9 | 0.59pp | a column choice inside a table already in the prompt |
| a column of another table | 3 | 0.20pp | the table was never in view — schema linking |
| no predicate of ours compares it | 2 | **0.13pp** | the omission the bucket is named for |
| no literal in the atom at all | 16 | 1.04pp | a corpus convention (`IS NOT NULL`) no question names |
| the schema cannot place the column | 4 | 0.26pp | not measured, and reported as such |

Two rows are new this round. `substituted` says the restriction is present on the wrong column; **which
table that column belongs to decides which mechanism could ever fix it**, so the split is read from
BIRD's table manifest (column → tables, and table → columns) rather than guessed from the name — `county`
is not unique — `account_id` is declared on five tables of `financial`, `userid` on four of
`codebase_community` — and the same rule is what places an unqualified column when the statement reads
exactly one table, and refuses to when it reads more. The `unresolved` row is the honest half:
an unqualified column in a statement that reads two tables cannot be placed without parsing the FROM
clause, and this reader does not do that, so it says so instead of picking one.

The same reading answers the question the plan carried as `8p` — whether the `table` bucket and the
value-on-another-column cases are one phenomenon:

| | questions | points |
| --- | --- | --- |
| `table` bucket (their statement reads a table none of ours reads) | 17 | 1.11pp |
| table-level linking (their value sits on another table's column) | 3 | 0.20pp |
| in both | **0** | — |
| union | **20** | **1.31pp** |

**They are not the same thing** — the intersection is empty — and even their union is 1.31pp against a
2.93pp resolution. A schema-linking step, as a single lever, cannot be priced on this run: the ceiling
is below what the instrument can see. `8p` closes without a dispatch, for the same two reasons `8o`
did: the population is smaller than the name suggests, and the ceiling is smaller than the noise.

That table was wrong for one round, and the way it was wrong is worth recording. `conditionKindOf` took
the gap kind as an **optional** parameter, and its guard read `gap !== undefined && gap !== 'condition'`
— so a caller with no gap at all (a selection failure: the pool held a correct statement, no gap was
ever computed) ran the whole taxonomy anyway. On dev that filed **11 pool-held cases** into the
breakdown, and the printed lines said *21 substituted / 18 unstated / 6 absent* with a residual of *16*
where the per-case records said **16 / 16 / 2** and a residual of **27**. The number this document had
carried was the right one, computed by hand from the per-case records — **a right answer with no
instrument behind it**, which is the worst of the two failure modes, because nothing would have caught
it if the next reader had trusted the print. Two things changed: the parameter is required, so the
misuse is a type error rather than a silent count, and an invariant (`strayConditionKinds`) is checked
on every run and emitted as a problem line — a taxonomy applied outside its population is now a
sentence in the output, not a plausible total.

#### Where 62.99% sits, now that a competitor can be run inside this harness

For the first time the field is not only a table of other people's numbers: MAC-SQL at `31a9df5` ran
on the same 1,532 questions, through this repository's executor, judged by this repository's judge,
with the same model, in the same two-hour window. **67.89% against 62.99%** is a like-for-like
measurement, and it is the only competitor number in this document that is.

| comparison | number | what it is |
| --- | --- | --- |
| us, `select-mixed`, dev | **62.99%** | 965/1,532, deepseek-chat, four calls |
| us, `select-mixed-rule`, dev (shipped) | **63.97%** | 980/1,532, three calls |
| MAC-SQL, same everything | **67.89%** | 1,040/1,532 — their pipeline, our harness |
| gap to a competitor we can run | **3.92pp** | from the shipped arm; 4.90pp from the four-call one |
| SQLConductor, published | 73.2% | Qwen3-8B policy + Gemma4-31B, SFT + GRPO |
| CHASE-SQL, published | 73.0% | Gemini-1.5-Pro, fine-tuned binary selector |
| gap to published SOTA | **9.2pp** | 63.97 → 73.2; 5.3pp of it is model and training we do not have |

Two caveats, both of which the table needs. MAC-SQL's published dev number is not 67.89% — a pipeline
scores what the harness around it scores, and the difference between their paper and this row is a
fact about harnesses rather than about them. And this pair ran on **one model**: the strong/weak
contract is exercised elsewhere in this document (the cross-vendor section, `glm-4-flash` at 62.7%
against 61.6% for the two selectors on all 1,532 questions), but a two-model competitor comparison is
a dispatch this round did not spend, so no claim about it is made here.

The 5.3pp between the runnable competitor and the published top is the part this campaign cannot
reach by prompting: every system above 72% trained a generator, a selector, or both. The 4.90pp is
the part it can, and the previous section says where inside it the mass is.

## What the selector costs, and what it returns

`select` and `vote` draw the same three samples from the same prompt and differ in one thing: how
one of the three is chosen. `select` asks the model; `vote` takes the majority answer. That is a
single-lever pair in the strict sense, and the run that finally prices it is the one that also
started metering per call (`41092489988`):

| arm | choose by | calls/case | tokens/case | of which the selector | accuracy |
| --- | --- | --- | --- | --- | --- |
| `vote` | majority | 3.00 | **2,092** | — | 284 (57.03%) |
| `select` | model | 3.99 | 2,539 | **447 (17.6%)** | 284 (57.03%) |
| `select-duo` | model, 2 candidates | 2.98 | 1,754 | 359 (20.5%) | 281 (56.43%) |

Paired over all 498 questions, `select` against `vote` is **+0.00pp**: 17 questions only the
selector got right, 17 only the majority got right, p = 1. Over the same design the MDE is 3.28pp,
so this is "no discernible return", not "proven useless" — but the 17:17 split is what a coin looks
like, and the selector is billed for 17.6% of every case to flip it.

The same table prices the second candidate: `select-duo` spends 359 tokens on a selector over two
candidates and lands 0.6pp under the majority over three (p = 0.690). Neither the extra candidate
nor the judgement is buying much here.

Two of these numbers disagree with the earlier run tabulated in *What the tokens buy*, and the
disagreement is the point: that run bills `vote` 2,271 prompt tokens and `select` 2,717, this one
2,092 and 2,539 — same arms, same split, same model, 7–9% apart. Whatever moves a prompt's size
between runs is not in the artifact, so a token figure here is never quoted without the run that
produced it, and each table is read against its own accuracy column.

### What this does to the cost story

Put the two rounds together and the chain's parts are priced:

| what it buys | calls added | tokens added | accuracy bought | where measured |
| --- | --- | --- | --- | --- |
| two more samples of the same prompt | +2 | +1,395 | — | Mini-Dev, 697 × 2 |
| a model selector over three | +1 | +447 | **0.00pp** (284:284, p = 1) | Mini-Dev |
| the whole chain vs one call | +3 | +663 | **+0.39pp** (p = 0.691) | dev |

The first two rows price the inside of `select`: it sends a 697-token prompt three times and a
447-token selector call once, and `select-duo`'s generated line is literally the two-sample version
of that — 1,395 for two calls. The third row is a different subtraction: one arm against another,
where the arms do not send the same prompt, so 1,395 + 447 is 1,842 while one chain minus one call
is 663. Both are arithmetic; only the third is the price of the chain, and only the first two are
the price of the parts.

Read down the last two rows: four calls cost 37% more than one and return 0.39pp, and the call that
chooses between the candidates is the one with the most measurable price and the least measurable
return. That is not an argument for deleting the selector — a stronger generator moves the ceiling
and could make it pay — but it is an argument for not paying for it by default, which is what the
chain's bill, below, was the review for.

### Why this reading is the one to quote

The dev split's MDE for this pair is 2.30pp against 3.98–4.10pp on Mini-Dev, so the same 2.5pp
question is inside one design's resolution and outside the other's. Three Mini-Dev runs
agreeing in direction is not the same as one dev run measuring a magnitude: agreement in direction
is what a 498-question split produces for a 0.4pp effect, because the sign is more robust than the
size. That is the second time this round has met the same mistake in a different costume — the
first was pooling repeated runs as if they were new questions (*152*) — and both are the same rule:
**a bigger number of observations is not a bigger observation.**

## The chain's bill

`pnpm bench:bird` runs the default chain, and until this round nobody had added it up. The artifact
of `41116622974` did the addition — every arm metered, every call attributed to a purpose — and the
number is **24,537 prompt tokens per question**, or 12.2M for one push over 498 questions:

| arm | calls | prompt tokens | accuracy (498) | Δ vs `select` | MDE of that pair | inside |
| --- | --- | --- | --- | --- | --- | --- |
| `names` | 1.00 | 536 | 36.35% | — | — | — |
| `synth-definitions` | 1.00 | 770 | 41.16% | — | — | — |
| `inline-definitions` | 1.00 | 663 | 40.96% | — | — | — |
| `inline+retrieval` | 1.00 | 801 | 40.96% | — | — | — |
| `inline+icl` | 1.00 | 1,213 | 41.77% | — | — | — |
| `inline+repair-raw` | 1.02 | 713 | 56.43% | — | — | — |
| `inline+repair` | 1.02 | 722 | 56.63% | — | — | — |
| `values` | 1.00 | 704 | 56.63% | — | — | — |
| `inline+evidence` | 1.00 | 697 | 56.22% | — | — | — |
| `metadata+evidence` | 1.00 | 1,716 | **59.44%** | — | — | — |
| `select` | 3.99 | 2,540 | 57.23% | — | — | — |
| `vote` | 3.00 | 2,092 | 56.83% | −0.40pp | 3.47pp | yes |
| `select-prune` | 3.99 | 2,271 | 55.82% | −1.41pp | 3.51pp | yes |
| `select-duo` | 2.98 | 1,753 | 56.02% | −1.20pp | 2.87pp | yes |
| `select-mixed` | 3.99 | 2,546 | 57.83% | +0.60pp | 3.13pp | yes |
| `select5` | 5.99 | 4,103 | 57.63% | +0.40pp | 3.08pp | yes |

The last column is the whole argument. **Every multi-call variant's gap to `select` is inside the
MDE of the pair that produced it**, between 0.40 and 1.41pp against 2.87 to 3.51pp. That is not a
claim that the arms are equivalent — *What the selector costs* is careful about the difference, and
it matters here too: it is a claim about what another push buys. An arm whose effect the split
cannot resolve produces the same unresolved reading next time, at the same price, and the price is
not small: those five arms are 12,765 of the 23,840 tokens a question the chain spends.

So they moved to on-demand, each with the verdict that retired it, and the chain is eleven arms:

| | before | after | change |
| --- | --- | --- | --- |
| arms in the chain | 16 | 11 | −5 |
| nominal calls a question | 34 | 14 | −59% |
| prompt tokens a question (chain) | 23,840 | 11,075 | −53.5% |
| prompt tokens a question (with the A/A control) | 24,537 | 11,772 | −52.0% |
| tokens for one push over 498 questions | 12.2M | 5.9M | −6.4M |

Two things stay, and both for reasons that are not a delta.

`metadata+evidence` is the prompt that ships: nine arms price the rungs that built it, and dropping
the rung is what turns a prompt regression into an unexplained 3pp.

`select` stays at 2,540 tokens a question, 23% of the new chain, and the argument is execution rather
than accuracy: it is the only arm that runs the selector path end to end. `inline+retrieval` is the
precedent for what happens without one — it was written, wired into the prompt, paired for ablation,
and never executed, because the chain is a second list that nothing compared against the catalogue.
A path that no push executes is a path that breaks silently, and the four calls are the insurance
premium, stated as such.

What keeps this from un-happening is a budget rather than a resolution: `test/bird-arms.test.ts`
asserts the chain's nominal calls are at most fifteen against fourteen today, so one more
single-call rung fits and a four-call variant does not. The next arm that wants four calls has to
remove two, and write down why.

One push later the same eleven arms re-measured the bill, on `41144429545`: **11,073** prompt tokens
a question against the 11,075 predicted above, and 14.04 nominal calls. That is the arithmetic
holding to two tokens. The accuracies did not hold as tightly — `select` read 58.23% in that run
against 57.23% here, and `metadata+evidence` 59.44% both times — which is the arm-level noise
*Three runs, and the p-value a repeat buys* measured, arriving on the one arm with four calls in it.
The bill is stable across runs; the per-arm accuracy is not, which is why no sentence above rests on
a single arm's rate.

The retired arms did not lose their floors so much as outlive them: a floor on an arm the chain does
not run is a floor nothing will notice, and the gate says so out loud. Their measurements are the
table above, and a dispatch of `BIRD_ARMS=select5` re-measures against a fresh reading rather than
against a number from a chain that no longer runs it.

## The default sample size was still a row count, and the gate said so

The round that made `selection.available` a count of questions left the runner's *default* asking
for 500 of them. On a split whose file carries 500 rows for 498 questions that is a request the
resource cannot satisfy, and the floor gate — the one check whose job is to notice a shrunken
sample — refused it:

```
BIRD1: the run asked for 500 questions and split minidev has 498
```

which failed `ci` run `41169457147` at the step named *Accuracy floor (a regression fails the
build)* while every arm in the same run had scored normally (`names` 36.9%, `select` 56.5%,
`metadata+evidence` 59.3%). The gate was right and the runner was wrong: the artifact declared a
sample the split does not contain.

The root cause is the shape of the mistake this document has now recorded three times. A number
that describes the split lived in two places — the file and a constant in `parseLimit` — and only
one of them could be corrected. `500` was a *row* count, copied into a *question* count's slot, and
nothing about the two numbers looked different.

The fix removes the copy instead of correcting it:

| before | after |
| --- | --- |
| no limit → `500` (minidev) / `1534` (dev), both row counts | no limit → `undefined`, meaning "whatever the file holds" |
| `BIRD_LIMIT=abc` → the split's size, silently | throws: `BIRD_LIMIT="abc" is not a question count` |
| `BIRD_LIMIT=12.9` → `12`, silently | throws, for the same reason |
| a limit larger than the split → the split's size | `resolveLimit` throws with both numbers |
| `selection.requested` = the unresolved declaration | `selection.requested` = the declared size, resolved against the file |

`resolveLimit(limit, available)` is where the two coordinates meet, and it is the only place that
knows both. A declared size larger than the split is refused rather than clamped: clamping would
publish a smaller sample under the number the caller declared, and `selection.requested` is meant to
be read as a declaration. That rule is what turned a silent substitution into a red build, and it is
worth keeping for exactly that reason.

`eval/baseline/bird.json` moved with it: `scoredBySplit.minidev` is now **496** — the pool a rate is
computed over, after the two questions whose gold statements the executor refuses — rather than 500,
which was a row count standing where the denominator belongs. The 95% floor that reads it is
therefore 471 rather than 475; both are far below any run that scores the split.

Three tests hold the new contract, and the third is the one that would have caught this:

1. `parseLimit` returns `undefined` for a blank value and throws for anything that is not a whole
   number of questions;
2. `resolveLimit` returns the split's size when nothing was declared and throws on a declaration
   larger than it;
3. a dataset built with three rows and two questions — Mini-Dev's shape in miniature, a byte-for-byte
   repeat included — must produce `rows: 3, available: 2, requested: 2, sampled: false`, and the same
   run with `BIRD_LIMIT=500` must throw. Before the fix the first assertion read `requested: 500`.

The competitor harness shares the parser, so `--limit` blank now means the whole split for a
competitor too, and its subset file is named `minidev-subset-all.json` rather than
`minidev-subset-undefined.json`. That is the mode the next comparison runs in.

## Who decides which columns

The prompt is mostly schema: 74.1% of it is the card, and 58.4% of the card belongs to
tables the gold statement never reads. Three instruments here cut it, and all three
decide *tables* with the same lexical linker — the card measurement prices what the
card is worth, the join measurement says one hop over the declared foreign keys keeps
every gold table for 95.2% of cases, and the `select-prune` arm ships that rule and
loses 1.4pp, because the closure reaches the wrong place on exactly the questions the
linker already misses.

`inline+evidence+llm-select` is the other mechanism, and the one a competitor
comparison needs: the model is shown every column with its type and description and
names the ones the question needs, in one call before the statement. Its reply is read
as a set — qualified names, bare names when only one table has them, an ambiguous bare
name resolving to every table that has it — and the card keeps the chosen columns plus
the keys of any join whose two ends survived. A reply that resolves nothing sends the
whole card and is reported as `decided: false`, so "the model chose the whole card" and
"the model chose nothing" stay different numbers.

```bash
BIRD_ARMS=inline+evidence+inline+evidence+llm-select pnpm bench:bird
```

Three numbers make the reading admissible, and all three are in the artifact:

- **the call is charged**: `calls.mean` is 2 for the arm and 1 for its parent, and the
  meter files the choice under `columns`, so the arm's bill splits per kind of call;
- **the card actually shrank**: `columnSelection.cardShare` is the mean of the
  per-case `kept / total`, and a run where the choice never removed a column fails the
  build rather than reporting a null result;
- **the prompt that was sent is the prompt that was measured**: the report's
  prompt-size column reads the card the run recorded, not the card the arm would build
  afterwards. A dry run, which spends no calls, labels its preview
  `before-column-selection` instead of presenting an unpruned card as the sent prompt.

The measurement (`41190457163`): the choice decided 495 of 496 cases and kept a mean
10.8% of the columns — and the arm scored **250/496 against its parent's 278/496**, a
loss of **5.65pp** (53 only-parent, 25 only-lever, McNemar p = 0.0020, MDE 4.99pp,
95% CI [−9.14, −2.16]pp). It is also dearer: 778 prompt tokens for the choice to
remove 505 from the generation prompt, +39% net. Cutting the card to what the model
names removes columns the statement needs, so the arm is kept as the ablation
reference for relevance-by-model and the graph closure (`select-prune`, −1.4pp) stays
the card lever that ships.

### The same reply, applied the way their selector applies it

That −5.65pp is a statement about *this repository's* application rule, not about their
selector. MAC-SQL's selector does not decide per column; it decides per table, and the
decision `drop_all` **keeps a table's first six columns**. Their card is therefore
never missing a table, and the column rule's characteristic mistake — deleting a table
whose only trace in the prompt was the foreign key rendered under it, leaving a join
the model cannot see it can make — is a mistake their rule cannot make.

`eval/bird/dense.ts` is that rule, transcribed from `macsql_agents.py::_get_db_desc_str`
at the same pinned sha as the value-example port, and the two arms share everything
else: one prompt, one call, one reply, parsed by one parser.

| the model named | `columnSelect: 'columns'` | `columnSelect: 'dense'` |
| --- | --- | --- |
| at least one column of the table | those columns, plus the keys of joins whose two ends survived | those columns, plus the table's declared keys, padded back to six in declared order when the table is wider than six |
| no column of the table | **the table is dropped** | **the table keeps its first six columns** |
| the reply resolved nothing | the whole card, `decided: false` | the whole card, `decided: false` |

Three details of their code are load-bearing and none is a quirk to tidy:

1. **Six is a floor, not a target.** `columns[:6]` on a table narrower than six is the
   whole table, and the pad loop stops at six, so the rule only ever compresses wide
   tables. A five-column table loses nothing at `drop_all` and a table the model named
   one column of is padded back up to six — which means the arm can still remove a
   column from a narrow table, because the *named* branch is not floored the same way.
2. **`important_keys` is `primary keys + foreign keys`, and this table cannot carry the
   first half.** The schema card is built from `PRAGMA table_info` without the `pk`
   flag, so the keys the rule always keeps here are the declared foreign keys. That is
   the half the card can express, and a card with no foreign keys gets no key retention
   at all rather than a silent approximation.
3. **Their fallback is `keep_all` and ours is not reachable.** `extracted_schema.get(table,
   '')` lands on the `keep_all` branch, but our prompt asks for a list of columns rather
   than a decision per table, so "this table is irrelevant" is only expressible as
   "none of its columns were named". The arm reads that as `drop_all`, which is the
   aggressive reading and the one that differs from the column rule. The alternative —
   treating an unmentioned table as `keep_all` — would have made the arm the parent with
   extra steps.

The mechanism has its own number, because a rule that never fires and a rule that fires
uselessly both look like a null result: `columnSelection.restored` counts the columns
kept that the model never named — the floor and the keys together. Zero on a full split
means the arm measured the column rule over again, and the funnel reports it only for an
arm that has a floor, so the field's absence is itself a statement.

```bash
BIRD_ARMS=inline+evidence+llm-select+inline+evidence+llm-select-dense pnpm bench:bird
```

Pre-registered before the dispatch, in the form the pair can falsify:

- **if the loss was table deletion**, `dense` recovers most of the 5.65pp, because the
  only columns it still removes are the ones past position six of a table the model
  named nothing in, and `restored` reports how many columns were put back;
- **if the loss was the choice itself** — the model naming the wrong columns rather than
  too few tables — `dense` lands within noise of `columns`, `restored` is large, and the
  selector lever is closed on the strength of two granularities instead of one.

Neither outcome needs the dev split to read: 496 questions resolve 4.99pp at 80% power,
and the pair differs by a rule rather than by a mechanism.

### The measurement: both predictions were right and neither one wins

`41290647076` ran three arms and one A/A on the 496 scored questions with `deepseek-chat` at
concurrency 8, and the file it wrote is the first artifact in this repository with two card
granularities measured against the same parent in the same run:

| arm | passed | accuracy | calls | generation prompt | all prompt tokens | card kept |
| --- | --- | --- | --- | --- | --- | --- |
| `inline+evidence` | 278/496 | **56.05%** | 1 | 2,641 chars | 698 | 100% |
| `inline+evidence+llm-select` | 253/496 | 51.01% | 2 | 683 chars | 974 (+39.5%) | 11.1% |
| `inline+evidence+llm-select-dense` | 261/496 | 52.62% | 2 | 1,535 chars | 1,181 (+69.2%) | 56.9% |
| `inline+evidence` (A/A) | 275/496 | 55.44% | 1 | 2,641 chars | 698 | 100% |

Three paired tests, computed from the run's own case rows with `compareArms` / `mcnemarExact` /
`pairedResolution`:

| pair | delta | discordant | p | MDE | 95% CI |
| --- | --- | --- | --- | --- | --- |
| parent → column rule | **−5.04pp** | 50:25 | 0.0052 | 4.89pp | [−8.46, −1.62] |
| column rule → their rule | **+1.61pp** | 33:41 | 0.416 | 4.86pp | [−1.79, +5.01] |
| parent → their rule | **−3.43pp** | 34:17 | 0.0241 | 4.03pp | [−6.25, −0.61] |
| parent → parent | −0.60pp | 6:3 | 0.508 | 1.69pp | [−1.79, +0.58] |

**The sign survives the correction, and only the sign.** Applying their rule — which never
removes a table and puts back 14,052 columns across the split, 28.3 a question, lifting the kept
share from 11.1% to 56.9% — moves the arm from −5.04pp to **−3.43pp against the parent, still a
loss, at p=0.0241 and outside the paired interval**. So the sentence "the selector lever is worth
−5.65pp" was too harsh by about 1.6pp and right about its direction, and their selector is not
worth copying onto our card at either granularity.

**How much of the loss was table deletion cannot be answered, by this run or by any split here.**
The +1.61pp that the floor recovers is inside a 4.86pp MDE (p=0.416), and the pair ran at 14.9%
discordance — the discordance is what sets the resolution, not the accuracy. Resolving 1.6pp at
that rate needs **4,518 cases** (`casesForEffect`), which is three times the dev split; even on
dev's 1,532 questions the same discordance resolves only 2.76pp. The honest statement is a bound
rather than a split: **deleting tables is worth at most +5.01pp** (the CI's upper end) and the
point estimate is 1.61pp. A design that cannot separate 1.6pp should not be run to try.

**Their cut is milder in the card and dearer in tokens.** The generation prompt falls 42% (2,641 →
1,535 characters) but the choice call costs 778 prompt tokens of its own, so the arm pays **+69%
prompt tokens a question** to arrive at a card that scores 3.43pp worse than the one it replaced.
On the column rule the same arithmetic reads +39.5%. That is the shape of the competitor's
trade as well: their selector pays a call on 426 of 496 questions to compress a card whose
compression is worth less than the call.

So the 6.45pp between their pipeline and `metadata+evidence` is not their selector cut, at either
granularity, and the accounting of I-50 closes here: vocabulary +2.82pp, cut −3.43pp at best,
decomposer −1.1pp / −0.85pp, refiner 10.89pp of reach of which 1.8pp is priced at ≈0 and 3.8pp's
instruction is false. What is left is the 166 failures that run cleanly and return the wrong rows.

## The competitor's block, priced before it is run

MAC-SQL leads this repository on the split both are measured on: 65.73% against our
59.10% (`metadata+evidence`, 496 questions, same endpoint, same judge, −6.45pp,
McNemar p = 0.0027). The next step is to attribute that gap to a *block* of their
prompt rather than to "their pipeline", and the cheapest way to start is to price the
block without spending a model call.

Their selector reads a card on which every non-key column carries
`Value examples: [...]`, gathered by `core/agents.py` at sha `31a9df5e`. Ours carries
stored values for categorical columns only, eight of them, and never says whether a
column stores a NULL. `eval/bird/value-examples.ts` is a port of their rule —
six most-frequent values per non-key column, a numeric column above ten distinct
values skipped whole, a text column dropped for one URL, one email or one value longer
than fifty characters, dates collapsed to one, a NULL emitted first. It keeps their
quirks rather than tidying them: the type tests are exact-case, so a column declared
`varchar(50)` gets neither the numeric cut-off nor the text filters, and a column named
`paid` is skipped because the name ends in `id`.

**The port is checked against their code, not against a reading of it.**
`eval/bird/macsql-examples.py` extracts the two methods from their `core/agents.py` by
`ast` (not by transcription), binds the helpers their bodies import, and runs them over
the same SQLite files. Over the eleven Mini-Dev databases that is **332 columns with
examples on both sides, 0 disagreements** — 0 differing in which columns are shown, 0
differing in a single value. Two things moved the port to that state and both were
found by the comparison rather than by inspection: their dictionary marks *both* ends of
a foreign key as a key column, so the referenced column is skipped as well as the
referring one; and their tie order is SQLite's, so a tiebreak spelled different six
values for most columns of a database where every value is distinct.

```bash
pnpm bench:bird:differential eval/out/bird-eval.json --arm inline+evidence
```

The instrument answers three questions with the database and the artifact, no model
call: is a gold filter value the block would have shown, is it stored but outside their
six, or is it in no column at all. On the 496-question artifact from `41190457163`:

| reading | count | share |
| --- | --- | --- |
| cases whose prompt already spells every value | 349 | 70.4% |
| ...spells it in another case, which the block would fix | 12 | 2.4% |
| ...spells it in another notation | 8 | 1.6% |
| ...does not spell it at all | 4 | 0.8% |
| cases whose gold statement compares against no value | 123 | 24.8% |

Of the 583 literal sites — 496 cases, so 1.18 comparisons each — 553 are already
spelled, **15 are spelled by the block**, 14 are stored but outside their six, and 1 is
in no column at all. That gives the ceiling:
**13 cases the block could reach, 11 of them failures — 2.22pp**, against a gap of
6.45pp. Ten further cases need a *wider* sample than their six, and one needs a value
the column does not store, which no prompt-side lever will supply.

It also gives the bill: **1,154 characters a case on a 1,480-character card, +43.8%**,
from 30.2 columns a database and 4.7 values a column. So the block that distinguishes
their selector's input from ours can explain at most a third of the gap and costs nearly
half again as much prompt — and 2.22pp is below the smallest delta this split can resolve
(3.6pp for this pair, 5.0pp for the widest one), which means the honest statement is
"at most 2.22pp", not "2.22pp".

The arm exists so that claim can be tested rather than computed: `inline+evidence+samples-wide`
carries that block on our card, `inline+evidence+samples` carries our own sampler for
the same lever, and both are compared pairwise against `inline+evidence` in one run.

### What the block bought, measured

Run `41206085907`, 496 scored questions, one model, three arms and one duplicate:

| arm | execution accuracy | 95% Wilson | prompt chars | vs `inline+evidence` | vs `+samples` |
| --- | --- | --- | --- | --- | --- |
| `inline+evidence` | 55.6% | [51.2, 60.0] | 2,641 | — | — |
| `inline+evidence+samples` | **58.5%** | [54.1, 62.7] | 3,209 | **+2.82pp** (13/27, p=0.039, CI [+0.3, +5.3]) | — |
| `inline+evidence+samples-wide` | **58.5%** | [54.1, 62.7] | 3,795 | **+2.82pp** (14/28, p=0.044, CI [+0.3, +5.4]) | **0.00pp** (20/20, p=1.000, CI [−2.5, +2.5]) |

Every `p` is a McNemar exact test on the cases the two arms disagreed on, and the
`resolves` figures are 3.6pp for both pairs against the base and 3.6pp between the two
samplers — the same cases, at 80% power. The A/A duplicate in the same run moved 0.2pp
(6/7) and could not have resolved anything under 2.0pp, which is the scale all three
deltas are read against.

Three things in that table are worth more than the accuracy column.

**The instrument predicted the bill to the character.** Prompts grew 2,641 → 3,795, which
is 1,154 characters — the same 1,154 that `bench:bird:differential` computed from the
databases and the artifact without a model call. A cost model that lands on the measured
cost exactly on a 496-case corpus is a cost model that can price the next mechanism before
anything is spent.

**The information is the lever; their selection rule is not.** Their block and ours carry
the same kind of content — stored values per column — and swapping one rule for the other
changed **nothing**: 20 cases each way, p=1.000, delta 0.00pp. Both samplers move the same
+2.82pp net over the card without them, so what the model used was that the card carries
stored values at all, including a small numeric dictionary and a nullability marker our
profiler never shows. Their rule spends **+586 characters a case (3,795 vs 3,209, +18.3%)**
to arrive at exactly the same score.

**Their rule buys nothing for a fifth more prompt.** So the answer to "should we port their
value examples" is no: porting was necessary to *price* them (the differential needs their
rule to compute the ceiling), and having priced them, our own sampler is the cheaper carrier
of the same information.

Two readings keep the numbers honest. The interval on both +2.82pp deltas reaches down to
+0.3pp, so this is one run at the edge of what 496 cases resolve, not a settled effect — the
honest sentence is "stored values are worth about 2.8pp on this split, and the same run
cannot separate that from 0.3pp". And 28 gains against 14 losses is not the ceiling's claim:
the differential bounds only the cases where the block spells a value the base card did not
(11 failures → 2.22pp), while the arm changes 1,154 characters of everything else the model
reads and loses 14 cases the base got right. The block explains at most 2.22pp of a net
+2.82pp; the rest is prompt perturbation, and no per-case attribution here supports more.

One process note, because it changed the artifact: the pair `inline+evidence` →
`inline+evidence+samples` was **not declared** in `COMPARISONS` when the run was made, so
the artifact reports both samplers only against each other. The row above was computed from
that run's own case rows with the repository's `compareArms`/`pairedResolution`, not by
subtracting two accuracies, and the pair is declared now; a test refuses a sampler that has
no pair against the arm carrying no stored values, because "the two rules tie" is only a
finding next to "and both beat the plain card".

## The pipeline, counted before it is copied

`bench:bird:agents` asks a different question from the block differential: not "what does their
card say" but "when does each of their three agents run". A condition can be counted, and their
source states each one exactly, so the count needs no model call — only the databases, the
artifact, and their predicates transcribed (`eval/bird/agents.ts`, pinned to `mac-sql@31a9df5e`).

| agent | when it fires | what it costs | what we have measured |
| --- | --- | --- | --- |
| selector | unless `columns // tables ≤ 6 and columns ≤ 30` | 1 call + the pruned card | vocabulary priced (`+samples`: +2.82pp at 3,209 characters a question); the cut itself is `inline+evidence+llm-select`: −5.65pp, and at their own granularity `inline+evidence+llm-select-dense` |
| decomposer | always | 1 call, 5,643 characters of template — most of it a worked example | shape: `decompose` −1.1pp then −0.85pp, firing 100%; demonstrations: `inline+icl` 41.7% |
| refiner | the statement threw, returned no rows, or put a NULL in its first five rows | 0.109 calls a case, 4,329 characters a fire | **this file** |

The selector number is the first surprise: `_is_need_prune` **fires on 9 of the 11 Mini-Dev
databases**, so 426 of 496 questions pay for a selector call. "Two to three calls a question"
is therefore 3 on 86% of this split, not 2–3 on average. And when it does fire it compresses
mildly rather than cutting: `drop_all` still keeps a table's first six columns, and a table the
model chose columns from is padded back to six.

### What a refiner can see, on 496 questions

Their `_is_need_refine` has three conditions, applied in this order, over the 220 failing
statements the artifact kept (a census — the cap is 2,000 and `truncated` is empty):

| fires on | cases | share of failures | the message it sends |
| --- | --- | --- | --- |
| the engine refused the statement | 9 | 4.1% | the engine's own words |
| the statement returned no rows | 26 | 11.8% | `no data selected` |
| a NULL in the first five rows | 19 | 8.6% | ``exist None value, you can add `NOT NULL` in SQL`` |
| — nothing — | **166** | **75.5%** | — |

So the reach is **54 cases, 10.89pp**, and **45 of the 54 fires carry a string that is identical
for every case**. The third condition is worse than contentless: it tells the model to remove
rows from a result that was not wrong. Run the same three conditions over the **gold**
statements, where a fire means a correct answer would be rewritten:

| | cases | share |
| --- | --- | --- |
| NULL in the first five rows | **9** | **1.81pp** |
| everything else | 487 | 98.2% |

Nine is a floor and not the size of the surface — a correct prediction may order its rows
differently and present another window — but it is not hypothetical. Question 1399 asks *"Did
Maya Mclean attend the Women's Soccer event?"*; the gold statement answers with
`CASE WHEN … THEN 'YES' END`, so the correct answer **is NULL** when she did not, and their
refiner tells the model to add `IS NOT NULL`, which deletes it. Questions 25, 27, 36 and 50 (a
school's second and third administrators, legitimately absent) and 637 (a post's tags) are the
same shape.

### What that leaves of the 6.45pp

The three agents are now each priced, and the parts we can render are worth zero or less:

- **selector vocabulary** — +2.82pp measured, at 3,209 characters; their sampling rule adds
  +586 characters for 0.00pp.
- **selector cut** — −5.65pp when the model names the columns. Their version keeps six columns a
  table and never drops one, so the lever they actually pull is the milder one; that granularity
  is `inline+evidence+llm-select-dense` (the section above), written as one lever from the column
  arm rather than inferred from it.
- **decomposer** — −1.1pp and −0.85pp for the shape, 41.7% for retrieved demonstrations. Their
  template bundles a fixed worked example with the decomposition, which is the one half of their
  prompt we have not put on our card, and the retrieval result says a worked example is not
  where 6.45pp hides.
- **refiner** — 10.89pp of reach, of which 1.8pp is already priced at ≈0 (`inline+repair`, twice),
  5.2pp has a measured yield of 14.3% a fire (+0.75pp) and 3.8pp is a trigger whose instruction
  is false.

That leaves 166 failures — **33.5pp of cases** — that run cleanly, return rows, and are wrong.
No agent with an execution trigger can see them: not theirs, not ours. Whatever the gap is, it
is not a mechanism that reads the engine's answer, and the next work item is aimed at those 166
rather than at another agent to copy.

### The arm this priced out of a run

`inline+evidence+empty` was written and paired before it was cancelled. The trigger is exact on
this split — no gold result is empty, so every fire is a wrong answer — but the only place it has
been measured is `select-mixed+empty` on dev: 63 fires, 32 retries that returned rows, and **9
cases of accuracy**, which is 14.3% a fire. On 26 fires that is **+0.75pp**, under this harness's
own A/A movement (2.0pp) on 496 questions and under the dev split's MDE. The arm stays in
`ON_DEMAND_ARMS` with that arithmetic in its note, because "we wrote it and did not run it"
is a defensible decision only if the prediction that justified it is written down.

## The answer's width, and whether the extra columns are the mistake

`gap` files 52 of the 496 scored questions under `column-count`: the statement ran, returned the
same number of rows, and carried a different number of columns. The clause ladder deliberately
skipped them — *"a statement whose width is wrong has a projection finding, not a clause
finding"* — and that sentence is a claim about the corpus, so it can be tested.

`pnpm bench:bird:width <report> --arm <name>` tests it with the only edit the claim allows:
delete items from the select list, every subset of them, re-execute, and hand the result to the
same judge. Widths come from the engine (`cursor.description`), not from a scan for commas —
`select *` is one item and three columns, and a reader that counted items would call that case
`exact` and skip the search entirely.

| | cases | share of the bucket |
|---|---|---|
| **wide** — more columns than the answer | 37 | 71.2% |
| **narrow** — fewer columns than the answer | 15 | 28.8% |
| **exact** — the artifact and the re-execution disagree | 0 | — |

**Removing columns recovers 11 of the 37: a ceiling of 2.22pp of the 496 scored questions.** The
subsets are chosen with knowledge of the answer's width, so that is an oracle's number and no
implementable rule can beat it; the rule that is actually writable is one line in the prompt,
which reaches fewer. One case offered more than the 64-subset budget and is reported as
unexplored rather than counted as a zero. (The value-sample block's ceiling is also 2.22pp, from
11 reachable cases on a different population — the same arithmetic on different sets, not the same
number copied.)

What the other 26 look like is the finding: **they stay wrong with the right width**, so the
width was a symptom. Five of the eleven, named:

| question | what had to go | what the model had added |
|---|---|---|
| 1486 | two intermediate `SUM(CASE …)` columns | the two operands of a difference nobody asked for |
| 1533 | `c.CustomerID` | the key, in a question about an aggregate |
| 1031 | `p.player_name` | the name, in a question about an age |
| 1078 / 865 | `birthday` / `d.dob` | the raw date behind the age |

Sometimes the key is the extra column and sometimes the measure is, so there is no rule to write:
those four rows would need four different instructions. That is why the number is published as a
ceiling instead of chased as a lever: 2.22pp is an oracle's number, 0.22pp above this harness's own
A/A movement (2.0pp) on 496 questions, and any rule a prompt can state reaches strictly less.

The 15 narrow cases are the direction with no deletion to try, so they are *named* instead — the
gold items the statement never spells — and they are dominated by multi-column projections of one
entity (`T2.forename`, `T2.surname`, twice each) and by a `CASE`-guarded `COUNT(DISTINCT …)`.

## The condition the statement never wrote

The ladder's largest row on this arm is `predicate` (49 of 211), and "the condition is different"
is where a reader starts rather than where they finish. `pnpm bench:bird:conditions` splits it in
two, because the two have different fixes:

- **a condition on that column, spelled differently** — another literal, operator or range. This
  is the spelling family, and the value-sample block has already been priced at a 2.22pp ceiling.
- **no condition on that column at all** — the statement filters on something else, or on nothing.
  No amount of value spelling reaches this: the model never decided the column was part of the
  question.

The match is on identifiers rather than on text, and both normalizations are load-bearing. Aliases
are rewritten to their table, so `t1.segment` and `customers.segment` are one condition; comparing
the text would report a missing condition on every case where the model chose a different alias.
Keywords are folded before the split, because BIRD's gold writes `WHERE` and the shared atom reader
splits on lowercase — handed a raw statement it returns nothing, which reads as *the gold has no
conditions and the statement wrote them all*. **Both defects were live for one run of this
instrument, and that run said 13 where the answer is 80.**

| | failures | share |
|---|---|---|
| a gold condition names a column the statement never filters on | **80** | 36.4% |
| every gold condition is written somewhere | 140 | 63.6% |

107 conditions in total. They are not spread evenly across the ladder:

| ladder bucket | cases | missing a condition |
|---|---|---|
| tables | 36 | 23 |
| predicate | 49 | 17 |
| filter-wide | 41 | 13 |
| literal-missing | 34 | 13 |
| filter-narrow | 26 | 8 |
| projection | 11 | 0 |
| aggregate | 8 | 0 |
| literal-case | 5 | 0 |

The `tables` row is partly mechanical — a statement reading other tables cannot filter a column of
the table it did not read — so the informative rows are `predicate` and `filter-wide`, where the
tables agree and **30 of 90 conditions are on a column the statement never filters at all**.

**80 cases is 16.1pp of the 496 questions: seven times the projection ceiling**, and it is a
population no spelling lever can reach, because 63.6% of the failures already name every column the
gold filters. The two instruments are complements rather than rivals: the ladder says which clause
differs, this says whether it differs in *value* or in *column*, and a mechanism has to answer the
second before it can answer the first.

## The 166, named

The two buckets the previous round left unexamined — 47 `column-count` and 119 `values` with no
execution trigger — are now read through the same ladder, by admitting both under
`pnpm bench:bird:gap:values <report> --arm <name> --scope all`. Of 220 failures, 211 can be read
(9 were refused by the engine), and 210 of the 211 reach a named cause:

| bucket | cases | share |
|---|---|---|
| predicate | 49 | 23.2% |
| filter-wide | 41 | 19.4% |
| tables | 36 | 17.1% |
| literal-missing | 34 | 16.1% |
| filter-narrow | 26 | 12.3% |
| projection | 11 | 5.2% |
| aggregate | 8 | 3.8% |
| literal-case | 5 | 2.4% |
| **grain** | **0** | — |
| **scale** | **0** | — |
| **window** | **0** | — |
| unclassified | 1 | 0.5% |

**Not one failure is a grouping, aggregation-level or window error.** The `column-count` bucket was
the last place a grain hypothesis could live, and it does not: its 52 cases split into 15
`predicate`, 15 `filter-wide`, 7 `tables`, 6 `projection`, 5 `literal-missing` and 4 `aggregate`.
The two buckets are the same problem — the statement reads the wrong table or the wrong condition —
and 160 of 211 (75.8%) are one of those two.

That is what the next work item has to attack, and it is not a shape guard: a guard can see that a
statement is the wrong width, and nothing in this table is.

### The same three instruments on a second live run

Every number above comes from one artifact (`41206085907`). The CI job on the commit that added the
three instruments runs them again on a fresh live evaluation, so the two readings can be compared
rather than trusted:

| | artifact `41206085907` | CI `41226576767` |
|---|---|---|
| `column-count` cases | 52 | 51 |
| wide / narrow / exact | 37 / 15 / 0 | 36 / 15 / 0 |
| recovered by removing columns | 11 | 11 |
| width ceiling | 2.22pp | 2.22pp |
| failures on the arm | 220 | 216 |
| a gold condition's column never filtered | 80 (36.4%) | 93 (43.1%) |
| `grain` / `scale` / `window` | 0 / 0 / 0 | 0 / 0 / 0 |

The ceiling is identical to the second decimal because it is 11 of 496 in both runs; what moves is
the failure count, which is the model's variance and not the instrument's. So the population the
constraint audit would attack is a range, **16.1–18.8pp**, not a point — reported as a range here
so that a reader who reruns it does not conclude the instrument drifted.

## The audit turn: the model cannot see the filters it left out

`bench:bird:conditions` established the population — in 36-43% of failures, a column the gold
filters on never appears in the statement — and the obvious mechanism follows from it: put the
statement back in front of the model with the question and ask which conditions it failed to
write. `inline+evidence+audit` is exactly that, one lever, one call, and it does not work here.
The reasons it does not are worth more than the delta.

| | `inline+evidence` | `+audit` |
|---|---|---|
| correct | 275 / 496 | **280 / 496** |
| accuracy | 55.44% | 56.45% |
| calls a case | 1.00 | 2.00 |
| characters a case | 2,864 | **6,850** (+139%) |

Paired on the same 496 questions: **+1.01pp, 4 cases gained against 9 lost, p = 0.27,
CI [-0.42, +2.43], MDE 2.04pp.** The delta is smaller than the minimum effect the split can
resolve and nowhere near the 1% bar, so the arm is not adopted. The A/A duplicate of the parent
in the same run moved 2 cases (0.40pp), which is the scale the delta has to be read against.

The funnel is where the mechanism explains itself:

| | count | share of fired |
|---|---|---|
| turns spent | 488 | 100% |
| conditions named as missing | **24** | — |
| statements actually rewritten | 19 | 3.9% |

Asked to check its own statement, **the model reported nothing missing on 96% of the turns.**
It is not that the prompt was ignored — the replies are in the requested shape, with
`MISSING: none` where there was nothing to report. The model believes the statement it wrote is
complete, and the census agrees with the model about the other 58%: most failures really are
complete, and the missing-filter cases are exactly the ones where the model's own reading of the
question already went wrong.

The same instrument that defined the population measures what the turn did to it. On the same
corpus:

| | failures | missing a condition | conditions in total |
|---|---|---|---|
| `inline+evidence` | 221 | 93 (42.1%) | 151 |
| `inline+evidence+audit` | 216 | 90 (41.7%) | **150** |

**One condition out of 151, for 488 calls.** The turn reaches the right population and moves it
by 0.7%; the 19 rewrites it made are not the 93 that needed one. That is a different finding from
"the prompt was weak": a self-check cannot supply information the model did not have when it wrote
the statement, and this corpus is made of cases where it did not have it.

It also rhymes with the refiner that preceded it — 45 of its 54 diagnoses were the same sentence,
and the NULL rule was false on 1.81pp of correct answers. Both mechanisms assume that pointing at
a statement makes the mistake visible to the model that made it. On this split they are both wrong,
and the audit turn is the cleaner experiment: same model, same prompt, one question, and the answer
is "nothing missing".

### The same turn on the split that decides adoption: 2× the calls, and a sign flip

The Mini-Dev reading above was `+1.01pp, p = 0.27, MDE 2.04` — inside its own interval, which the
section already said. What was missing is the split with the sample to resolve it. `43211382444`,
dev, 1,532 scored questions, `served: deepseek-flash` on every case:

| | `inline+evidence` | `+audit` | change |
|---|---:|---:|---:|
| correct | 943 / 1,532 | **930 / 1,532** | **−13 cases** |
| accuracy | **61.55%** | 60.70% | **−0.85pp** |
| calls a case | 1.00 | 2.00 | ×2 |
| prompt tokens a case | 676 | 1,611 | **×2.4** |
| prompt characters a case | 2,568 | 2,568 | 0 |

Every difficulty bucket moved the same way, which is what separates a small real loss from a
stratum that got unlucky: simple 617 → 610, moderate 250 → 247, challenging 76 → 73.

The funnel is the same shape at three times the sample, and slightly worse:

| | Mini-Dev (496) | dev (1,532) |
|---|---:|---:|
| turns fired | 488 (98.4%) | 1,507 (98.4%) |
| missing conditions named | 24 (4.9%) | **30 (2.0%)** |
| statements rewritten | 19 (3.9%) | 43 (2.8%) |

And the failure buckets the turn exists to move moved the other way: `values` 439 → 447,
`columnCount` 126 → 130, `execution` 24 → 25. **One extra call per question, 2.4× the prompt
tokens, and the bucket it targets gets slightly worse.**

The catalogue carried a dev reading of `+1.2pp (p = 0.48)` for this arm before today. Two dev
readings of the same lever now bracket zero — +1.2 and −0.85 — which is what "no effect" looks
like when it is measured twice instead of once. The arm stays as the ablation reference for
"ask the model to check its own conditions", and it is not a candidate.

**This is the second time in this file that a Mini-Dev reading did not survive the split.** On
Mini-Dev the same arm read +1.01pp paired (MDE 2.04) in its declared run, and +2.62pp unpaired in
the committed artifact (286 against 273 of 496, a different run of the same split); on 1,532
questions it reads −0.85pp. The parent arm's own scores across three dev runs are 934, 939 and
943 — a 0.59pp span on an unchanged prompt. A 496-question split has an MDE near 2pp and cannot
promote a lever of that size; it can only nominate one for the split that can.

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

## What a cold start costs, and why this engine declines to calibrate

Every number above was taken on one backbone. A deployment that swaps it keeps the code and
loses the calibration, and the instinct — re-run the benchmark — is 1,532 questions times four
calls, which no deployment can do. `packages/ai/src/adapt.ts` answers the smaller question
instead: of five bounded strategies, which one should this model run? It decides in three layers
that cost nothing, nothing, and one call, and the last layer only fires when two Wilson intervals
separate.

That rule is untested until someone prices the way it can be wrong, which is what
`bench:bird:adapt` does. The five strategies map onto five arms of the dev split — the same run,
the same anchor, so the cost of a cold start is a subtraction rather than another benchmark:

| strategy | arm | calls |
| --- | --- | --- |
| `single-lean` | `names` | 1 |
| `single-full` | `metadata+evidence` | 1 |
| `repeat-3` | `select` | 3 |
| `aimed-3` | `select-mixed-rule` | 3 |
| `aimed-4` | `select-mixed` | 4 |

The readings below were produced while the four-call arm was still named `aimed-3`; they are
`aimed-4`'s numbers and the column here says so. Renaming rather than re-measuring is the honest
move — the arm did not change, its name did — and the distinction matters, because `aimed-3` is now
the rule arm: one call cheaper and 0.85pp ahead on the same split.

The harness calibrates on the first N questions, freezes the verdict, and scores it on the rest.
Three numbers, and the difference between them is the whole point: **chosen** is what a
deployment gets, **best fixed** is what the best strategy would have earned had the split been
known in advance, and **oracle** is a per-question router no fixed strategy can reach.

`41296610389` (dev, 1,532 scored questions, deepseek-chat), with the split's own order and with a
deterministic shuffle as a control:

| window | chosen | accuracy | best fixed | accuracy | oracle | regret | regret (shuffled) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 12 | `single-full` | 60.9% | `aimed-4` | 62.1% | 68.6% | 1.18pp | 1.12pp |
| 24 | `single-full` | 61.0% | `aimed-4` | 62.3% | 68.7% | **1.33pp** | **1.13pp** |
| 48 | `single-full` | 61.4% | `aimed-4` | 62.7% | 69.1% | 1.28pp | 1.28pp |
| 96 | `single-full` | 61.9% | `aimed-4` | 63.5% | 69.5% | 1.60pp | 1.25pp |
| 192 | `single-full` | 62.3% | `aimed-4` | 63.7% | 69.5% | 1.42pp | 1.57pp |
| 1,200 | `single-full` | 62.3% | `repeat-3` | 63.0% | 69.6% | — | 0.60pp |

**The pre-registered criterion fails.** It said regret below one point at a window of 24; the
reading is 1.33pp on the split's own order and 1.13pp on the shuffle. The failure is not noise —
it survives the shuffle, which removes the split's ordering as an explanation — and it is not a
tuning problem either: at every window up to 192 the interval rule keeps `single-full`, and the
only window that clears one point is 1,200 questions, which is three quarters of the split and
therefore the thing the engine exists to avoid.

The reason is arithmetic rather than implementation. The two arms differ by **1.21pp** and
disagree on **9.4%** of cases; resolving that difference at 80% power needs

```
n = (1.96 + 0.8416)^2 · 0.094 / 0.0121^2 = 5,040 questions
```

— more than three dev splits. A rule that switches only when the intervals separate can therefore
never switch to the arm that is 1.2pp better, at any sample size a deployment will see. The
regret in the table is exactly that gap: the cost of never switching, not the cost of switching
wrongly. `single-full` was the right choice at every window, and it was right for a reason the
intervals can state.

Two readings follow, and both are useful:

1. **The engine ships as layers ① and ②, with layer ③ held as a last resort.** `probeProtocol`
   turns a 400 into one retry without a temperature field, and `admissible` stops a four-call
   strategy from being chosen on a model that never writes a parseable choice. Those two are free
   and they are exact. `chooseStrategy` stays in the build because it is the only thing that can
   ever justify leaving the default, and because its floor (`MIN_OBSERVATIONS = 8`) is what makes
   the honest answer to seven observations "seven observations". What it must not be sold as is a
   calibrator: at deployment scale it will not move.
2. **The leverage is per question, not per deployment.** Oracle is **6.1-6.6pp** above the best
   fixed strategy on every window, and that gap does not shrink with calibration because no fixed
   strategy can reach it. A router that reads the question — the same reading `choosePromptProfile`
   already does for window and ratio shapes — is a bigger lever than the choice between these four
   arms has ever been, and the next iteration prices it.

## Routing, and why the per-question oracle is a ceiling

The previous section ended on a column rather than a conclusion: a per-question oracle sat **6.1-6.6pp**
above the best fixed strategy at every calibration window, and that gap does not shrink when you
calibrate harder, because no single strategy can reach it. The obvious next move is a router that
reads the question and picks a strategy. `bench:bird:route` prices that move before anyone builds it,
off the artifact the run already wrote and without spending a model call.

The constraint is that a router has to cost the same. Choosing `aimed-4` over `single-full` is not a
routing decision, it is a purchase of three more calls; the honest question is whether a rule can
choose **within one call**, among the three cards that all send a single request. On dev those three
earn 61.16% together, and a per-question oracle over them earns 67.62% — so **6.46pp** is the entire
prize for routing, before anything is known about whether it is readable.

`41296610389` (dev, 1,532 scored questions), three pairs, each a router's natural target:

| pair | fixed best | oracle | headroom | best rule, in sample | held out | gain |
| --- | --- | --- | --- | --- | --- | --- |
| `metadata+evidence` vs `inline+evidence` (1 + 1 calls) | 61.16% | 65.40% | 4.24pp | `words >= 9` → metadata (61.88%) | 60.18% | **−0.98pp** |
| `metadata+evidence` vs `select-mixed` (1 + 4 calls) | 62.34% | 66.45% | 4.11pp | `schemaColumns >= 16` → mixed (62.73%) | 61.36% | **−0.98pp** |
| `names` vs `metadata+evidence` (1 + 1 calls) | 61.16% | 65.01% | 3.85pp | `quoted >= 2` → names (61.23%) | 60.70% | **−0.46pp** |

The rule family is deliberately the small honest one — one feature, one threshold, either
orientation — and the held-out column is **leave-one-database-out**: fit on ten databases, predict the
eleventh. A random fold would let a rule recognise the corpus rather than read the question, and
BIRD's dev split is ordered by database, with accuracy ranging from 45.3% (`debit_card_specializing`)
to 82.9% (`superhero`) on the same arm.

Three readings, and the first is the one that decides the experiment:

1. **The in-sample optimum is a mirage, and its size is stable.** Every pair finds a rule that beats
   the fixed arm *on the data it was fitted to* — by +0.72, +0.39 and +0.07 points — and every one of
   them **loses** half a point to a point on the database it was not fitted to. That gap between
   +0.72 in sample and −0.98 out of fold is not a modelling failure to be tuned away; it is the
   selection effect, measured on the same axes as the gain it pretends to be.
2. **The two evidence cards disagree like a coin.** They differ on 131 of 1,532 questions, 66 one way
   and 65 the other — an exact two-sided sign test returns **p = 1.0000**. Two cards that carry the
   same information and flip the answer equally often in both directions are not a signal a rule can
   read; they are the model's own instability, and the 4.24pp headroom is that instability counted as
   an opportunity.
3. **The failures are not choice failures.** All five arms fail on 474 cases, and the judge files
   **364 of them (76.8%) under `values`** — the right number of columns, a different number. Another
   110 (23.2%) are `column-count`. A router can only recover a case on which *some* arm passed; on
   three quarters of what is left, no arm passed and the choice was never the problem.

   One boundary on that bucket, because the first draft of this paragraph overstated it: the judge
   has no way to file "it did not run". A statement that never executed returns no values, so it
   lands in `values` as well. The arms record the difference even though the census cannot attribute
   it — **13** execution errors on `names`, **26** on `inline+evidence`, **17** on
   `metadata+evidence`, and 10 / 21 cases on the two selector arms where no sample survived guard and
   execution. So a small share of those 364 is not "wrong number" but "no number", and separating the
   two is a defect **in the census**, not a finding about the corpus. It is the first thing the next
   instrument fixes, because a repair that cannot tell a crash from a miscalculation cannot choose
   between a retry and a re-derivation.

So no router ships. This is the same shape of answer as the cold-start experiment, reached a
different way: the oracle columns in this document are ceilings that describe what is *unreachable by
the mechanism on offer*, and the useful question is always which mechanism the gap actually belongs
to. Here it belongs to the values, which is where the next iteration goes — and it explains why
`select-mixed`'s +1.37pp is a **purchase** (+1.37pp for 3 extra calls) rather than evidence that
routing would work.

## What one more candidate buys

The routing section ended by naming a defect in its own census and pointing at the values. Before
buying a generation call to chase them, though, there is arithmetic worth doing first, because an
arm's score is a **product**: the size of its candidate set times the rate at which the selector
converts it. Only one of those two factors has ever been measured on its own, and the other one has
been treated as the lever by default. `bench:bird:pool` reads both off an artifact the run already
wrote — the ceiling from `cases[].candidates`, the conversion from `cases[].passed` — and costs no
model call and no oracle query.

Five arms on the dev split (`41296610389`, 1,532 scored questions), and the three that send one
request are not pools at all (one candidate each, so their ceiling *is* their score):

| arm | sources | ceiling | scored | lost to the selector | calls |
| --- | --- | --- | --- | --- | --- |
| `select` | 1 prompt × 3 draws | 65.66% | 60.97% | **4.69pp** | 3.99 |
| `select-mixed` | 3 prompts × 1 draw | 63.84% | 62.34% | **1.50pp** | 3.99 |

| pool | recall | questions no other pool answers |
| --- | --- | --- |
| `select` (three draws of `inline+evidence`) | 65.66% | 56 |
| `select-mixed/inline+evidence` | 61.16% | 3 |
| `select-mixed/metadata+evidence` | 61.16% | 2 |
| `select-mixed/values` | 60.97% | 14 |

The union of all four pools is **67.49%** (1,034 questions), against 62.34% for the arm that ships
and 65.66% for the widest single pool. Two cross-checks that this is the right number rather than a
plausible one: the union over the *answers* of all five arms is 69.06% (1,058), and 1,532 − 1,058 =
474 is exactly the count of questions every arm failed that the routing section reported; and the
union over the three one-call cards alone is 67.62% (1,036), which is the figure that section used as
its oracle. Two independent readings of the same ceiling land within two questions of each other.

**The purchase, priced one call at a time.** A ceiling is not an option you can buy in aggregate, so
the harness adds pools greedily by the questions they cover that nothing before them did:

| step | cumulative ceiling | this call buys | price |
| --- | --- | --- | --- |
| `select` (3 draws) | 65.66% | — | 3.99 calls a question |
| `+ select-mixed/values` | 66.97% | +1.31pp (20 questions) | +1 call |
| `+ select-mixed/inline+evidence` | 67.36% | +0.39pp (6 questions) | +1 call |
| `+ select-mixed/metadata+evidence` | 67.49% | +0.13pp (2 questions) | +1 call |

The criterion is stated before the reading and is the split's own resolution: an extra candidate
earns its call only if it adds at least **2.30pp** of ceiling, because below that the difference
cannot be told from the draw. Nothing clears it. The best second call buys 1.31pp, so it does not
ship — and, more usefully, no arrangement of *these* prompts does, which is the reading that decides
where the next run goes.

Three things follow, in order of how much they constrain the plan:

1. **The pool is not the bottleneck, but it is not free either.** 5.15pp of headroom exists across
   all four pools, and it is reachable only by spending three calls to add 0.39 and 0.13 points on
   top of a first one worth 1.31. That is a purchase with a poor exchange rate, not a lever. The
   single most valuable pool is also the least clever: three draws of one prompt beat three
   different prompts by 1.82pp, which is a statement about sampling, not about knowledge.
2. **The conversion is not uniform, and its variation is the interesting part.** The same selector
   prompt, on the same model, in the same run, gives up 4.69pp of a 65.66% ceiling for `select` and
   1.50pp of a 63.84% ceiling for `select-mixed` — 7.1% of the ceiling against 2.3%. The difference
   is what the pool looks like: `select`'s three candidates agree with each other 92.9% of the time
   and differ in wording, while `select-mixed`'s three are different prompts and differ in content.
   A selector handed three near-identical statements has almost nothing to discriminate on, and the
   free selector does no better on that pool (modal result voting tied the model on Mini-Dev,
   17:17, p = 1). The loss is not a bad prompt for the selector; it is that on the questions where
   the draws disagree, the right answer is the minority and nothing cheap can find it.
3. **So the next lever has to raise the ceiling, not widen the pool.** At 67.49% union and a 97.6%
   conversion — the rate `select-mixed` actually achieves — the best score this generation family
   can produce is 65.9%, which is +3.6pp over where the product stands and three calls dearer. The
   only way past it is a candidate that differs in *method* rather than in prompt or in draw, which
   is what the decomposition and plan arms were supposed to be and what their measurements say they
   are not (−7.2pp for `plan`, and `select-mixed+dc` inside its own MDE on Mini-Dev).

One defect found while building this, and fixed in the same commit: a case whose candidate set was
reduced to a single survivor recorded no `candidates` array at all, so seven dev questions were
passed with no correct candidate in their record. Those are exactly the questions where two of three
samples died — the smallest pools — and every reading above would have silently dropped them. The
runner now records a set of one, and the harness prints the count instead of absorbing it.

## Which selection rule kept the answer

The pool section ended with a sentence it could not act on: the ceiling is 67.49%, the conversion is
97.6%, and the factor that was never priced is the conversion. It could not be priced because the
artifact recorded only *whether* each candidate was right — enough to count a loss, not enough to say
which rule would have kept it. Every candidate rule therefore cost a run: three generations plus a
selector is four calls, and a fifth arm to try a different fourth call is another 1,532 questions.

Two fields close that. Each candidate record now carries its statement and a **result fingerprint**,
and the fingerprint is not a second definition of equality: `resultKey` was added to the devkit as
the canonical key of a result set, and `judgeOfficial` was rewritten to compare two keys. The
property that follows is exact rather than approximate — two candidates share a fingerprint **iff**
the benchmark's own judge calls their results a match — so a rule that reads agreement is reading the
score's definition and not a proxy for it. `test/devkit`-side pins the property over every pair of a
twelve-bank corpus rather than over a table of cases a reader could have forgotten.

`pnpm bench:bird:consensus --artifact <report.json>` replays five rules over one artifact, with no
model call, no oracle query and no database:

| rule | what it picks | spends a call |
| --- | --- | --- |
| `first` | the candidate the prompt offered first | no |
| `shortest` | the fewest characters of SQL | no |
| `modal` | the result set the most candidates agree on | no |
| `model` | what the arm actually returned | **yes** |
| `oracle` | any candidate correct — the ceiling, not a rule | no |

**The reading, on the dev artifact the previous section used** (`41296610389`, 1,532 questions). It
was written before the two fields existed, which is the case the harness has to survive: the three
one-call arms are named as unreadable, `shortest` and `modal` print a dash with the reason, and
`first` still works, because a position needs nothing but the order the set was already in.

| arm | cases | `first` | `model` | `oracle` | `first` vs the selector |
| --- | --- | --- | --- | --- | --- |
| `select` — 3 draws of one prompt | 1,532 | **61.29%** | 60.97% | 65.34% | 40 won / 35 lost, p = 0.6445 |
| `select-mixed` — 3 prompts | 1,532 | 61.23% | **62.34%** | 63.71% | 13 won / 30 lost, p = 0.0137 |

Read the two rows against the pool section and the same number changes meaning twice:

- **On three draws of one prompt, choosing is guessing.** Taking candidate one scores 0.33pp
  *ahead* of the selector, and the paired test says the two are indistinguishable (40:35, p=0.64).
  The 4.37pp that this arm "loses to its selector" is therefore not all selection loss: 1.22pp of it
  is recoverable by deleting the fourth call, and the rest is the ceiling's.
- **On three different prompts, the call decides.** The selector wins thirty questions that no fixed
  slot would have won, against thirteen the other way (p=0.0137), and the totals agree this time
  (62.34% against 61.23%). The difference between the rows is not the selector; it is whether the
  candidates *differ in content*. Handed three near-identical statements the selector has nothing to
  discriminate on, which is the mechanism the pool section named at 7.1% versus 2.3% conversion and
  this table now prices from the other end.

Two cross-checks, because an instrument that agrees with itself is not evidence. `oracle` plus the
`unrecorded` count equals `bench:bird:pool`'s ceiling on the same rows — 65.34 + 5 = 65.66 and
63.71 + 2 = 63.84 — which is what it should be, since `pool.ts` repairs those holes by source and
this harness refuses to. And the `unanimous` column is empty here for a reason rather than by
accident: 1,510 and 1,507 questions carry no fingerprint at all, so agreement is *unmeasured*, not
zero, and the column says so instead of printing a rate.

**Two defects in the instrument, found before it was published.** Both were in the report rather than
in the rules, and both are the kind that produce a plausible table:

1. *Each column had its own denominator.* A rule that could not pick was excluded from its own share
   but counted as a miss in the pairing, so `first` was 62.24% of the 1,507 questions that produced a
   candidate while the selector was 62.34% of the 1,532 the arm ran — and the printed difference
   (0.10pp, a tie) disagreed in *sign* with the paired test on the same rows (13:30, p=0.0137). Every
   rule now answers every question; the count of questions it had no input for is printed beside the
   column instead of shrinking it. The bank in `test/bird-consensus.test.ts` that pins this exists
   because the first version passed all its other tests while printing two incomparable numbers.
2. *A negative gap was printed as "behind".* `first` was ahead on `select` and the verdict line said
   "−0.33pp behind", which is not a sentence and reads as a loss. The sign is now stated: 0.33pp
   ahead of it.

Both were found by reading the output against the arithmetic, not by a test — which is why the
regression banks were added after the fix rather than before it.

**A third, found by pointing the instrument at a 600-question sample.** The criterion line printed
the caller's margin and nothing else, so a 600-question dev artifact was judged against 2.30pp —
the resolution of the full 1,532-question split — and a 10pp gap resting on two discordant pairs
was called "earning its price". The margin is the caller's number; the resolution is the
artifact's, computed from the discordant pairs of the very pairing the verdict is about
(`pairedResolution`, the same function `bird-summary` uses). The report now prints both and the
verdict says which binds:

```
criterion: a call-free rule replaces the selector when it scores within 2.30pp of it (this artifact's own pairing on select-cross resolves 3.17pp)
verdict: shortest is inside the 2.30pp line on select-cross (0.67pp ahead of it), but this artifact resolves only 3.17pp — the stated margin is finer than the evidence, so this run does not measure what the call is worth
```

Four verdicts, not two, because a gap inside the margin and a resolution coarser than the margin are
independent: *buys less than the split can resolve* needs both to hold, *earning its price* needs the
gap to clear both, and the other two cases say plainly that this run measured neither. The old
20-question bank that asserted "earning its price" now asserts that it does not — the assertion was
the defect, not the rule.

### A reasoning model in one slot, and what the selector does with it

The instrument above was built to answer a question that costs no calls. The question it was built
*for* costs them: does a fourth call change anything when the candidate that differs is a reasoning
model rather than the same prompt rephrased? Run `41356370371` dispatched `select-mixed,select-cross`
over 600 stratified dev questions with `deepseek-reasoner` in the `inline+evidence@second` slot, and
the criteria were written before the reading: a union of at least 70% inside the same four-call
budget, and a paired difference of at least 2.30pp against `select-mixed` on the same questions.

| arm | score | ceiling | conversion | selector loss |
| --- | --- | --- | --- | --- |
| `select-mixed` — three `deepseek-chat` prompts | 63.67% (382/600) | 65.50% (393) | 97.20% | 1.83pp |
| `select-cross` — two chat, one `deepseek-reasoner` | 62.50% (375/600) | **68.33%** (410) | **91.46%** | 5.83pp |

Neither criterion is met. The union is 68.33%, 1.67pp short of 70%; the paired difference is
**−1.17pp** (25 won / 18 lost, p=0.3604), so the cross arm is behind rather than ahead. What moved is
the ceiling: **+2.83pp** on this sample. That is not the highest ceiling this project has measured —
`vote-cross` reached 69.6% with one GLM statement and two DeepSeek ones — but the two are the same
move measured against different references, and the pair is worth more than either. The reason the
ceiling did not reach the score is the other factor, and the decomposition is exact:

| | questions | converted by the selector |
| --- | --- | --- |
| the reasoner adds a correct candidate the chat arm never had | 22 | 16 |
| the reasoner displaces a correct candidate the chat arm had | 5 | 0 |
| net ceiling | **+17** | 16 |

The reasoner alone is right on 60.00% — below each of the two chat candidates (63.19% and 63.30%) —
and it is the *only* correct slot on 23 questions, of which the selector kept 16.

**Conversion is a property of the pool's shape, not of the aggregator.** `vote-cross` — one GLM
statement and two DeepSeek ones, aggregated by modal vote, run `40409600418` — converts 90.2% of its
69.6% ceiling; `select-cross` — two chat candidates and one reasoner, aggregated by a model selector
— converts 91.46% of its 68.33%. Two different second models, two different aggregators, the same
one-call-missing number, against 94.1% (`vote-mixed`) and 97.20% (`select-mixed`) for pools whose
candidates come from one author. Modal voting
converted 14 of the 65 questions `vote-cross` alone held (21.5%); the model selector converted 16 of
the 22 `select-cross` alone held (72.7%). The aggregator matters for *which* questions, and barely at
all for *how many*: what costs the points is that a 2+1 pool has a minority whose answer is often the
right one, and every aggregator on the list resolves that the same way — badly. On the 22 questions
where it adds an answer, the correct result is a **lone minority of one slot in 20 of them**: the two
chat candidates agree with each other and are both wrong, and only the third candidate dissents
correctly. A three-way vote cannot take those, and the recorded selector takes 73% of them because it
reads the statements rather than the vote.

The same instrument then asks the question the run was not designed to answer, and answers it:

| arm | `first` | `shortest` | `modal` | `model` | `oracle` | unanimous (wrong) |
| --- | --- | --- | --- | --- | --- | --- |
| `select-cross` | 60.00% | **63.17%** | 63.00% | 62.50% | 68.33% | 463 (29.59%) |
| `select-mixed` | 62.67% | 63.00% | 62.50% | 63.67% | 65.50% | 539 (33.40%) |

On the cross arm, **the shortest statement scores higher than the selector** — 63.17% against
62.50%, 25 won / 21 lost, p=0.6587 — so the fourth call is worth less than nothing on that pool while
it is worth 0.67pp (also unresolvable) on the mixed one.

The same table prices the one combination that needs no new generation, because both halves are
already built: **the vote or the selector, whichever is right**. Six hundred questions, one column of
questions only the vote gets and one of questions only the selector gets:

| arm | selector | vote (zero calls) | either | only the vote | only the selector | room |
| --- | --- | --- | --- | --- | --- | --- |
| `select-cross` | 62.50% | 63.00% | **66.33%** | 23 | 20 | **+3.83pp** |
| `select-mixed` | **63.67%** | 62.50% | 64.50% | 5 | 12 | +0.83pp |

+3.83pp on a sample that resolves 3.17pp, and +0.83pp on the same sample where the pool has no
dissenting slot. That is the strongest form the next step can take: not "make the selector smarter",
but "arbitrate between an aggregator that cannot see statements and one that cannot count votes",
with a pre-registered ceiling and every input already in the file. The selector beats `first` there (11 won /
26 lost, p=0.0201), so it is doing something; it is simply not doing enough to hold a pool whose
third candidate dissents. On this sample the resolution is 3.17pp against a stated margin of 2.30pp,
and the verdict says so: this run does not measure what the call is worth, in either arm.

That is the next lever, and it is not generation. Two things follow from the same table:

1. **A pool with a dissenting slot needs a selector, and the selector needs to be told that
   agreement is evidence rather than proof.** The 20-of-22 shape is exactly the correlated-error case
   the `unanimous` column counts from the other side: unanimous sets are 77.2% of the cross arm and
   29.59% of them are wrong, against 89.8% and 33.40% on the mixed arm — a dissenting slot buys away
   a third of the correlated-error mass for 2.83pp of ceiling.
2. **`select-balanced` is the symmetry test, not a rerun.** Two reasoner slots and one chat slot make
   the dissent the majority, which separates "the reasoner is better" from "the reasoner is
   different": if the ceiling moves again while the conversion stays at 91%, the loss is the
   selector's; if the ceiling falls, the reasoner's value was dissent itself and it needs one slot.

The `unanimous` arithmetic closes too, which it did not before: a question with fewer than two
candidates is neither unanimous nor divided, and those questions were absent from the column without a
count — 5 on `select-mixed` and 1 on `select-cross`. Printed now, so `unanimous + unmeasured +
skipped` is every case and the divided rows (56 and 136 here) are what remains.


### What the fingerprint is for, on the run after this one

The `modal` rule is the cheapest consensus there is and the one every reader assumes is already in
place: when candidates agree, take the agreement. It has been measured once, as an arm — `vote-mixed`
against `select-mixed`, 61.5% against 63.3%, −1.76pp (49 won / 22 lost, p=0.0018) — and that
measurement cost a full dev run because the artifact could not count agreement. On the next artifact
it is a reading. The two are not the same rule even then: `vote-mixed` reruns the vote *inside* the
arm, while `modal` replays it over the set the arm kept, including the questions where the arm's own
selector had already removed a candidate.

The column that matters more is `unanimous`: how often every candidate returns the same result, and
how often that shared result is wrong. A set that agrees and is wrong is the correlated-error case,
and no selection rule on any list reaches it — that is the boundary between this instrument and
generation work, and it is the number the next run is being spent to read.

### What the selector was told, and what it did with it

The conversion loss on a 2+1 pool had one obvious explanation left: the selector is shown each
candidate's statement, row count, column count and three preview rows, and none of that establishes
that two candidates returned *exactly* the same rows — so the one fact a dissent is made of was the
one fact it had to infer. Run `41366778872` dispatched four arms over 600 stratified dev questions
with `deepseek-reasoner` in the cross slot, and the marks were priced against the arm that lacks
them:

| arm | score | ceiling | conversion | lost | `first` | `shortest` | `modal` | vote ∪ selector |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `select-mixed` | **64.33%** | 65.50% | **98.22%** | 7 | 63.17% | 63.33% | 63.17% | 65.17% |
| `select-mixed+agree` | 64.17% | 66.17% | 96.98% | 12 | 63.50% | 63.67% | 63.33% | 65.17% |
| `select-cross` | **63.67%** | 69.83% | 91.17% | 37 | 61.83% | **64.33%** | 64.17% | 67.17% |
| `select-cross-agree` | 62.67% | 69.50% | 90.17% | 41 | 60.33% | 63.67% | 62.50% | 66.33% |

**The marks are a null, and the null is the finding.** On the cross pool the marked arm loses
1.00pp (15 won / 21 lost, p=0.405); on the mixed pool it loses 0.17pp (5 won / 6 lost, p=1.000).
Both are inside the resolution of their own pairing — 2.80pp and 1.55pp from the discordant share
— which is the honest way to say this run could not have detected an effect smaller than that, and
also that it did not see a large one.

The clean comparison restricts both arms to the cases where *both* pools held a correct candidate,
which removes the sampling difference between two separately generated candidate sets (the ceilings
differ by 0.33pp on the cross pair and 0.67pp on the mixed pair for that reason):

| pair | cases both reached | conversion before | after | paired | p | MDE |
| --- | --- | --- | --- | --- | --- | --- |
| `select-cross` → `+agree` | 401 | 92.27% | 91.77% | −0.50pp (7:9) | 0.804 | 2.79pp |
| `select-mixed` → `+agree` | 390 | 98.21% | 97.95% | −0.26pp (2:3) | 1.000 | 1.61pp |

And the mechanism read is the part that matters more than the score. The pool population the rule
exists for is the one where exactly one candidate is correct and it is the *minority* result. The
selector's pick rate there:

| arm | minority-correct pools | returned the minority |
| --- | --- | --- |
| `select-cross` | 34 | 52.9% |
| `select-cross-agree` | 42 | 54.8% |
| `select-mixed` | 14 | 85.7% |
| `select-mixed+agree` | 17 | 64.7% |

No shift of the shape a working rule would produce: on the cross pool +1.9pp, on the mixed pool
−21pp on 14 and 17 cases, which is noise in both directions. **The selector was told which
candidates agree and chose the same way.** The 6pp of conversion on a dissenting pool is therefore
not an information deficit — it is a recognition deficit, and the next attempt at it has to change
what the model can *judge*, not what it is told.

The cost is exact and small: the block adds 373 characters to the `select-cross` selector prompt
(1,631 → 2,004, +22.9%) and 387 to `select-mixed`'s (1,601 → 1,988, +24.2%), at the same four calls
per case. Per *case* the bill grows by 74 prompt tokens (2,476 → 2,550, +3.0%), because the selector
is one of four calls — which is the number that matters for a deployment and the one a prompt-length
reading would overstate by eight times. A 22% longer selector prompt bought nothing measurable, so
the marks stay an arm and stay out of every default path.

Two things this run settled that the last one could not:

1. **A zero-call rule now beats the call on a dissenting pool, and loses to it on a homogeneous
   one.** `shortest` scores 64.33% against the selector's 63.67% on `select-cross` (23:19,
   p=0.644) and `modal` 64.17% against 63.67% (21:18, p=0.749); on `select-mixed` the selector
   leads both by 1.00 and 1.17pp. The selector's value is a property of the pool's authorship, not
   of the selector.
2. **The loss is not where the selector is.** Of the 218 questions `select-cross` answered wrongly,
   181 never had a correct candidate — and 129 of those are *unanimous*: every candidate returned the
   same result and that result is wrong. That 21.5% of the corpus is untouched by any aggregator on
   the list, free rule or model, and it is three and a half times the 6.17pp of conversion loss the
   last three rounds have been chasing. The next lever has to change what the sources see.

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

### A stronger model scored lower, and the reason was the pipeline

> **Correction, 2026-11-06: it was never a stronger model.** Every comparison in this section, and
> in the two rounds before it, calls `deepseek-reasoner` "the strong model" and `deepseek-chat`
> "the weak" one. DeepSeek's own API documentation says the two names are **two modes of one base
> model**, not two sizes of it: `deepseek-chat` is the non-thinking mode, `deepseek-reasoner` is the
> thinking mode, and the migration note for the aliases states it in one line — *"`deepseek-chat`
> maps to V4-Flash non-thinking and `deepseek-reasoner` maps to V4-Flash thinking mode; neither
> alias maps to `deepseek-v4-pro`."* Same weights, same parameter count, same pretraining; the only
> difference is whether the model emits a reasoning trace before it writes the statement.
>
> So the phenomenon this section tried to explain — a stronger model scoring lower — was never
> observed here, because **a stronger model was never measured.** What was measured is one base
> model's decoding mode against its own default, and a thinking trace that is worth its price on
> multi-step inference is a cost on the 60% of BIRD that is one join and one filter. Read the rest
> of this section with that substitution: wherever it says "the stronger model", read "the thinking
> mode of the same model".
>
> Two consequences, and the second one is not cosmetic.
>
> 1. **The real strong/weak contrast is unrun.** `deepseek-v4-pro` is 1.6T total / 49B active
>    parameters against `deepseek-v4-flash` at 284B / 13B — a 5.6× width and 3.8× activation gap,
>    where the mode comparison above is a 0× gap. The cross-vendor slot in this repository has
>    always accepted any model name, so the experiment costs one dispatch and one workflow input;
>    it is registered below as `S1` rather than described as done.
> 2. **The aliases are on a soft retirement, and the artifacts could not see it.** Both names left
>    DeepSeek's official model list with a discontinuation date of 2026-07-24; requests still
>    succeed and are routed to `DeepSeek-V4.1-Flash-1017`. A run dispatched before that date and a
>    run dispatched after it asked for the same string and were served by different weights, and
>    every artifact this document quotes records only the string it **asked for** — `model:
>    'deepseek-chat'` — never the model that **answered**. Measurements taken on either side of the
>    cut are therefore not known to be comparable, and no field in the old artifacts can settle it.
>
> The instrument changed in response to point 2, before any number above is re-quoted.
> `withCallCounter` now keeps `servedModels()`, the model name carried by each answer, and every arm
> row publishes it as `servedModels: {name: cases}`. One entry is proof that the row's numbers
> belong to the base its settings name; two entries are the reason they belong to neither, and the
> console line prints `served-by N` so that a mixed base cannot be read as a clean score. The field
> is per case as well (`CaseTokens.served`), because a cross arm legitimately asks two endpoints and
> a single-model arm legitimately sees one. It is **reported and not enforced**: a guard that
> refused a mismatch would have stopped every run after 2026-07-24 for a change the endpoint made,
> and the honest response to "the alias moved" is a published fact, not a red build.

Three readings now point the same way. On 298 questions `deepseek-reasoner` and `deepseek-chat`
scored 153 and 153 at the same prompt; on 600 stratified dev questions the reasoner's single slot
scores 61.94% (371/599) against 63.59% (379/596) for the chat slot at the same prompt, and the arm
that contains it scores 63.67% against the all-chat arm's 64.33%. Read as a statement about models
that is confusing; read as a statement about a pipeline it is exact, and the decomposition is
already in the artifact all three readings came from (`41366778872`):

| | `select-cross` (2 chat + 1 reasoner) | `select-mixed` (3 chat) | difference |
| --- | --- | --- | --- |
| ceiling (a correct candidate exists) | **69.83%** (419) | 65.50% (393) | **+4.33pp** |
| conversion (the selector returns it) | **91.17%** | 98.22% | **−7.05pp** |
| score | 63.67% (382) | 64.33% (386) | −0.66pp |

The stronger model raises the ceiling and lowers the conversion, and the second number is larger.
That is not the model's doing. Four mechanisms in this harness were suppressing a reasoning model,
and one of them was not a model question at all:

1. **A parameter the endpoint ignores was reported as one it honoured.** `temperature: 0` was sent,
   accepted and discarded (`api-docs.deepseek.com/guides/thinking_mode`: the four sampling fields are
   accepted for compatibility and have no effect). No error, no retry, and a report that printed a
   sampling regime nobody ran.
2. **The judge was the model that wrote two of the three candidates.** The reasoner's correct
   statement was returned 47% of the time when only its set held the answer, against 87% for the
   primary's — the asymmetry is measured, and the arms that would separate preference from
   recognisability have never been run with this judge. The one judge swap on record used
   `glm-4-flash` and lost 6pp, which is a fact about that model's SQL reading, not about swapping.
3. **The judge's instruction was written for a model that answers in one token.** "Answer with the
   number of the chosen candidate and nothing else" is either ignored by a reasoning model (its
   prose is then read as an undecided vote) or obeyed at the cost of the deliberation it was chosen
   for.
4. **An arm whose switch never reached the mechanism.** `inline+evidence+empty` was declared, paired
   and filed on demand, and its turn could not fire: the pipeline never received the switch, the
   execution hook existed only on repair arms, and the hook returned nothing, so the row count the
   trigger reads did not exist. Three independent breaks; none produced an error.

Two arms were added and one defect was priced by a third. They are dispatched together, and the
criteria are written here before the reading:

| arm | one lever | criterion (600-question sample) |
| --- | --- | --- |
| `select-cross-judge-reasoning` | who judges, plus the format that judge can answer | ≥ +1.5pp against `select-cross`, paired p<0.05, and `selectorDecided` ≥ 99% |
| `select-cross-unhinted` | `Likely columns` removed from the reasoner's prompt only | the reasoner slot ≥ +1.0pp, arm ≥ +0.5pp, zero extra calls |
| `select-cross-empty` | the empty-result turn sent to the statement's author | funnel `fired` > 0 on every case that reaches it; accuracy is a null result at this base rate |

The resolution of that sample is 3.17pp, so a +1.5pp criterion is deliberately below it: the first
question is whether the mechanism moves at all, and a confirmed movement is re-run at 1,532 questions
(MDE 2.30pp) before it is quoted as a gain. The arms are two levers out of six the artifact makes
visible — the other four (a difficulty-aware allocation of the reasoning slot, a two-sample
self-consistency for it, an arbitration between the vote and the selector, and a schema hint written
for a model that reads the whole card) are registered in the plan and not yet built.

What this section does not say: that a stronger model must score higher on the same prompt. On BIRD
the reasoning model is not uniformly stronger — it is differently wrong, and at 600 questions the
1.65pp gap between its slot and the chat slot is inside the noise (42 discordant for chat, 33 for
the reasoner, exact McNemar p=0.356). What a
pipeline owes a deployment is not that promise; it is that the stronger model's ceiling is usable,
that the role it is paid for is the role it is measured in, and that the number reported is the
number that ran.

#### The two arms ran, and the measurement could not decide between them

`41380616205` (`select-cross,select-cross-judge-reasoning,select-cross-unhinted`, second
`deepseek-reasoner`, 600 of dev's 1,534 questions, 4 calls per case):

| arm | passed | ceiling | conversion | calls | `selectorDecided` |
| --- | --- | --- | --- | --- | --- |
| `select-cross` | 362/600 = **60.33%** | 409 (68.17%) | 88.51% | 4.0 | 600/600 |
| `select-cross-judge-reasoning` | 375/600 = **62.50%** | 417 (69.50%) | 89.93% | 4.0 | 599/599 |
| `select-cross-unhinted` | 377/600 = **62.83%** | 417 (69.50%) | 90.41% | 4.0 | 599/600 |

Both arms clear their **arm-level** criterion against the parent in the same run: +2.17pp
(10 discordant for the parent, 23 for the arm, exact McNemar p=0.035, CI [0.29, 4.04]pp) and
+2.50pp (10:25, p=0.017, CI [0.57, 4.43]pp), at zero extra calls, with the selector deciding on
99.8% of cases. Read as a table of scores, that is two wins.

The slot-level criteria say otherwise, and the reason is a property of the harness rather than of
these two levers. `select-cross-unhinted` exists to move the **reasoner's own slot**, and that slot
moved 358/598 (59.87%) → 360/597 (60.30%) — **+0.43pp**, below the +1.0pp registered before the run.
It is also smaller than the same slot's movement on the arm that changes *nothing* about generation:
`select-cross-judge-reasoning` swaps only the judge, so its three candidate prompts, endpoints and
parameters are identical to `select-cross`'s, and its reasoner slot read 367/597 (61.47%) — **+1.60pp
from no intervention at all**.

That is the noise floor, measured in the same run, and it is larger than the effect being claimed.
Two more readings agree with it:

- **In-run, identical generation configuration.** `select-cross` and `select-cross-judge-reasoning`
  draw their pools from the same three prompts on the same endpoints, yet their ceilings differ on 22
  cases (7 for the parent only, 15 for the arm only) — 8 net cases from configuration that is
  identical.
- **Cross-run, the same arm twice.** Run `41366778872` and this one scored `select-cross` at 382/600
  and 362/600 on the same 600 questions: 26 discordant for the old run, 6 for the new, exact McNemar
  p=5.4e-4. That is a 3.3pp displacement of a control. 474 of the 600 cases had byte-identical
  `(source, fingerprint, correct)` triples across the two runs, and 24 of the 26 old-only wins came
  from the 126 cases whose pool *was* re-drawn — so the displacement is generation, not scoring.

One honest caveat on that last number: the two runs are not the same experiment. `select-cross`'s
requests to the reasoning endpoint changed between them this round — `temperature` is no longer sent
and `max_tokens` is — so the 3.3pp contains whatever that did, and it is the one place where this
round's capability contract could have made an arm worse. The vendor documents the field as accepted
and ineffective; the reading above is not evidence against the documentation, because the field is
not the only thing that moved. A probe that separates them (the same prompt, repeated, with and
without the field) is registered.

**What this establishes.** At 600 questions in this configuration, an arm-level McNemar between two
arms that each generate their own candidate pool is not an attribution test: the pool is re-drawn per
arm, the pool's own displacement is ±1.3–2.5pp, and a 2pp delta is inside it. Both arms are therefore
**not promoted, and not rejected** — they are unmeasured, in the sense that matters: the effect and
the noise are the same size. The fix is structural and now built: an arm that **reuses another arm's pool**
(`pool: '<arm>'`), so a judge swap generates nothing and the only thing that differs between the two
arms is the judge. `select-cross-pooled` reads `select-cross`'s three candidates for one call a case
and must reproduce its score exactly — an exact-zero A/A that `assertPoolShared` refuses to let pass
if the pool was not shared — and `select-cross-pooled-judge-reasoning` swaps only the judge on that
same pool. On it the judge-format comparison has no generation noise in it, and the two levers above
become decidable at 600 questions rather than needing 1,532.

#### The stronger model was not wrong to be weaker: the pipeline never gave it the loop it is good at

The reading that forced this section is a three-way comparison on one product, stable across three
runs: the reasoning model's own slot answers 61.94% of `select-cross`'s questions correctly, while
the two chat-authored slots answer 63.82% and 63.19%, and the arm that contains it scores 63.67%
against 64.33% for the all-chat arm. The tempting conclusion is a claim about models — "on BIRD a
reasoning model is not stronger, it is differently wrong". That conclusion is wrong, and the code
says why.

**The main arm never ran the loop that makes a reasoning model worth its price.** `select-cross` is
declared `repairs: 0`. Its candidates are generated, handed back to the harness, executed once, and
a statement the engine refuses is dropped — the ceiling falls by one and no model is ever told what
went wrong. The largest single-model gain reported on BIRD in the current literature comes from
exactly the loop that was switched off: ExCoT-DPO reports 57.37% → 68.51% (+11.1pp) from execution
feedback alone, and the same paper's negative result is the one that explains this section's
headline — *zero-shot chain-of-thought offers minimal gains*. A reasoning model given a one-shot
prompt is being asked to think with nothing to think about; its advantage appears when it can read
an engine's error and write a corrected statement, which is inference rather than recall.

So the comparison above measures a model inside a pipeline built for the other kind of model, and
the honest description of the result is not "the strong model is weaker" but "the strong model was
never given the one channel where it is stronger". Two things follow, and both are now built.

**One: the loop is per source, and a mixed arm could not previously ask for it.** On a mixed arm the
pipeline is built from the *resolved source's* `Arm`, so the mixed arm's own `repairs` field never
reaches the generator — it is decoration. `sourceRepairs` is the field that does reach it, keyed by
source, so the reasoning model can be granted two repair turns while the chat candidates keep none,
and the delta between those two arms belongs to the model rather than to the arm. The loop costs
nothing on a case that already ran, because a repair turn fires only on a guard rejection or an
engine refusal: measured on the last 600-question run, candidates reach the engine 598, 596 and 595
times out of 600, so the whole mechanism is priced in the low single digits of calls per hundred.

**Two: the arms now exist to price it.**

| arm | what it grants | calls/case | the question it answers |
| --- | --- | --- | --- |
| `select-cross` | nothing | 4 | the baseline as it has always been measured |
| `select-cross-repair-second` | two repair turns, reasoning model only | 4 + ε | does the strong model do more with the engine's words than without them? |
| `select-cross-repair-all` | two repair turns, all three candidates | 4 + ε | do the weaker models gain as much from the same feedback? |

The third row is the one that decides the argument. If the gap between `select-cross-repair-all`
and `select-cross-repair-second` is smaller than the gap between `select-cross-repair-second` and
`select-cross`, then the loop is worth more per unit of model strength, and "a stronger model scores
higher" becomes a property of the pipeline rather than a hope. If it is larger, the loop is a
levelling mechanism — it helps the weak more than the strong — and that is a finding worth
publishing, not a failure to hide.

**A caveat that must travel with every number above.** Three runs of the same arm on the same 600
questions produced 63.67%, 60.33% and 62.70% (`41366778872`, `41380616205`, `41389454128`). The
spread of a control is 3.3pp, which is larger than several effects this document has reported. Any
comparison between two arms that each draw their own candidates is therefore read against that
floor, and a slot-level reading — the same slot, before and after — is the one to trust when the
two are available. `select-cross-pooled` exists to remove the floor for judge comparisons; the
repair arms cannot share a pool, because a repair changes the candidates themselves, so their
deltas are read on the slot and on the ceiling rather than on the arm's total alone.

**A defect the experiment found before it could produce a number.** The first evidence run for
the shared pool (`41389454128`) died at case 60 of 600: the pool guard demanded that a pooled arm's
pool hold as many candidates as the arm declares, and refused nine cases where two of three
statements had failed to execute. The premise was wrong — a candidate the engine refuses does not
exist, so a three-candidate arm legitimately holds one — and the guard would have made pooling
unmeasurable on any arm with a realistic failure rate. It now refuses only an absent pool (the
source never ran the case, an ordering bug) and an empty one (the source ran it and produced
nothing); a pool of one is a pool.

#### Where this sits against the field, and what the gap is made of

BIRD dev, execution accuracy, as reported by the systems themselves. The numbers are not
comparable one-to-one — this repository scores a 600-question subset of dev with two hosted chat
models, while every entry below scores the full split with models it trained — but a table with the
caveat attached is still the only honest way to say where 63.67% sits.

| system | BIRD | what it adds over a prompt |
| --- | --- | --- |
| AskData (2025) | 78.49% dev | GPT-4o with profiling metadata, task-aligned schema linking and a result-set vote; **no training** |
| CHASE-SQL (2024) | 76.02% | divide-and-conquer decomposition, plan-based CoT, fine-tuned binary selector |
| XiYan-SQL (2025) | 75.63% | multi-generator ensemble of fine-tuned models, schema filter, fine-tuned selector |
| CSC-SQL (2025) | 73.67% | self-consistency plus GRPO-trained generation and merge-revision models |
| Reasoning-SQL (2025) | 72.78% | RL with SQL-tailored partial rewards |
| OpenSearch-SQL (2025) | 72.28% | multi-agent with a SQL-Like intermediate language |
| OmniSQL (2025) | 72.06% | 2.5M synthetic chain-of-thought samples |
| Distillery (2024) | 71.83% | full schema in context, augmentation, selection, correction |
| CHESS (2024) | 71.1% | four agents including a unit tester |
| **this repository** | **63.67%** | prompt-only, un-fine-tuned hosted models, three prompts, one selector |

The gap is 7 to 15pp, and the decomposition that matters is not "which model" but **which parts of
the pipeline are trained**. XiYan-SQL's own ablation prices three of them: removing the schema
filter costs 1.24pp, dropping to a single generator costs 4.04pp, and replacing the selector with
majority vote costs 3.13pp — 8.4pp of their 75.63% comes from structure this repository either has
in a weaker form or does not have at all. CSC-SQL's 73.67% is built on self-correction, which is the
loop `sourceRepairs` has just opened here. Two conclusions follow, in the order they are worth
attacking, and a third that this table got wrong:

1. **Supervision is the largest difference for the middle of this table, and the top of it was never
   tested for that.** XiYan-SQL, CSC-SQL, Reasoning-SQL and OmniSQL all trained a generator, a
   selector or both; this repository's selector is a prompted judge, and closing that particular 3pp
   needs training data rather than a better prompt. But the leader trained nothing, and until this
   round this document said it did — see *The number we were comparing to was the wrong number*.
2. **Schema context is the cheapest remaining lever and it is already registered.** 1.24pp for a
   schema filter, on systems that already send the full card; this repository sends the whole card
   plus a linker hint, and the next item on the plan (`I-45`) sends only the columns a differential
   point names.
3. **Diversity of the candidate set is where the ensemble gain lives, and three prompts from two
   models is a thin reading of it.** XiYan-SQL's 4.04pp is for *multi-generator* — different
   fine-tuned models with different generation styles. Three prompt shapes over the same two
   endpoints is a much narrower sample of the same idea, which is why the ceiling sits at 68-70%
   where their ensembles sit at 75%+.

What this repository does have and the table does not show: every lever is priced against a
measured noise floor, a shared-pool instrument for judge comparisons, and an artifact that records
per-source candidate survival and per-turn token cost. The claim is not that 63.67% is competitive
with 75.63%; it is that the path from here to there is a list of priced increments rather than a
different model.

#### The loop ran, cost almost nothing, and could not have paid for the delta

`41392023902`, one run, 600 dev questions, second endpoint `deepseek-reasoner`:

| arm | passed | ceiling | conversion | calls/case | retry calls | `repaired` |
| --- | --- | --- | --- | --- | --- | --- |
| `select-cross` | 367/600 = **61.17%** | 413 (68.83%) | 88.86% | 4.000 | 0 | – |
| `select-cross-repair-second` | 375/600 = **62.50%** | 416 (69.33%) | 90.14% | 4.005 | 3 | 3 |
| `select-cross-repair-all` | 383/600 = **63.83%** | 423 (70.50%) | 90.54% | 4.018 | 11 | 7 |

Read as a column of scores, `select-cross-repair-all` beats its parent by **+2.66pp** with exact
McNemar **p=0.0070** (8 discordant for the parent, 24 for the arm), and the ceiling rises 413 → 423.
The pre-registered criterion for the narrower arm (`-repair-second` ≥ +1.5pp with p<0.05) is **not**
met: +1.33pp, 10:18, p=0.1849.

**The mechanism cannot be the cause, and the arithmetic that says so is one line per case.** A repair
turn fires only when the guard rejects a statement or the engine refuses it. Over 600 questions those
events happened **3 times** on `-repair-second` and **11 times** on `-repair-all` — the arms' token
ledgers record 3 and 11 retry calls, and a case with no retry call cannot have been affected by the
loop. So the number of wins attributable to the loop is bounded by the number of cases where **only
that arm** spent a retry:

| comparison | wins | losses | wins a retry could explain |
| --- | --- | --- | --- |
| `-repair-second` vs `select-cross` | 18 | 10 | **0** |
| `-repair-all` vs `select-cross` | 24 | 8 | **1** |
| `-repair-all` vs `-repair-second` | 18 | 10 | **2** |

Sixteen of `-repair-all`'s twenty-four wins, and all eighteen of `-repair-second`'s, happened on
cases where the loop fired nowhere. They are the pool being re-drawn, which three runs of the same
control already priced at 3.3pp (`63.67% / 60.33% / 62.70%`). The rule this establishes is worth
more than the reading:

> **A mechanism's contribution is bounded by the cases in which only it fired. When a paired
> comparison shows more discordant pairs than that bound allows, the remainder is not the mechanism
> — it is the randomness the two arms did not share.**

Applied retroactively to the arms of rounds 43 and 44 (`select-cross-judge-reasoning` +2.17pp,
`select-cross-unhinted` +2.50pp), the bound is the same: both change a prompt or a judge and therefore
fire on every case, so the bound is 600 — which is why neither could be dismissed this way, and why
they still had to wait for a shared pool. The rule does not rescue them; it tells apart two failures
that look identical in a table of accuracies: *the lever did not fire* from *the lever fired and the
delta belongs to the pool*.

**What the reading actually establishes about the strong model.** The loop is the right idea attached
to the wrong signal. It is wired to the engine's refusal, and a refusal is rare — 0.5% to 1.8% of
candidates, with the reasoning model the *lowest* of the three (2 losses in 600 against 4 and 5 for
the chat prompts). The errors that cost 39% of the benchmark are statements that run and return the
wrong rows, and no repair turn ever sees them. Giving the reasoning model feedback on *the answer*
rather than on *the syntax* is the next lever, and CSC-SQL's 73.67% is built on exactly that:
generation, then reconciliation of conflicting candidates, trained with RL. That is registered as
`I-76`, and it is the first item below that the strong model should win outright, because judging
which of two result sets answers the question is inference.

## The decision was the expensive part

Every `select` arm in this repository is built on one premise: three candidates are drawn, and a
model reads them and names the one that answers the question. The premise has a cost of one call per
question and an assumed benefit over the free alternative — returning the modal result, which is what
a voting arm does. The two were compared as arms twice (`select` vs `vote`, `select-cross` vs
`vote-cross`) and both times the delta sat inside the displacement of two pools that had been drawn
separately.

The artifact can answer it without spending a call, because a candidate record carries `fingerprint`,
the hash of the rows its statement returned. Grouping a case by fingerprint splits it into the
opinions it actually contains, and that split decides what a comparison between two selecting rules
can mean:

- **One group.** Every candidate returned the same rows. The selector and the count return the same
  statement, so no delta between them is a fact about either — and on 451 of 600 `select-cross` cases
  this is the situation.
- **Two or more groups.** The candidates disagree, which is the only situation in which a decision
  exists at all. 149 of 600 cases.

Read that way, the premise has a measurable price and a measurable benefit, and the two are not
what the arms assumed: on three cases in four the call buys nothing, because the choice is not a
choice. What happens on the fourth is the subject of the next section, and the answer depends on the
pool in a way the first version of this section got wrong.

### The two decisions, on the same cases

`bench:bird:decision` prints the split. Three runs of `select-cross` on the same 600 stratified
dev questions, with `deepseek-chat` as the primary model and `deepseek-reasoner` in the cross slot,
plus the homogeneous pool the same harness ran in the same period:

| | `41392023902` | `41380616205` | `41366778872` | `select-mixed`, `41366778872` |
|---|---:|---:|---:|---:|
| cases | 600 | 600 | 600 | 600 |
| one distinct result — the choice is free | 451 | 457 | 460 | 546 |
| two or more — the choice decides | 149 | 143 | 140 | **50** |
| ...and a correct candidate existed | 90 | 80 | 89 | 29 |
| **only the selector right** | 14 | 8 | 18 | **12** |
| **only the count right** | 27 | 26 | 21 | **5** |
| exact McNemar | p = 0.060 | p = 0.0029 | p = 0.75 | p = 0.14 |
| net for the count | +2.17pp | +3.00pp | +0.50pp | **−1.17pp** |
| pooled over the three cross runs | | | **40 : 74, p = 0.0019** | |

The fourth column is the reason this section exists in the shape it does. The first two readings
were written up as "the selector loses the cases it exists for", and that sentence is wrong: on a
**homogeneous** pool — three prompts to one chat model — the selector wins those cases 12 to 5, and
it is the only arm in the table that does. What separates the two pools is how often a decision
exists at all: 8.3% of cases on `select-mixed` and 23–26% on `select-cross`.

So the finding is narrower and more useful than the first reading of it:

**The value of a model-decided choice falls as the pool becomes less homogeneous.** On one author's
three prompts, disagreement is rare (50 cases) and the model resolves it better than the count
(12:5). On two authors and three prompts it is four times more common, and the count is at least as
good (40:74 over 1,800 cases, p = 0.0019) — but the three cross readings are themselves
heterogeneous (+2.17, +3.00, +0.50pp), which is the honest size of the effect: real in direction,
unstable in magnitude, and smaller than the 2.58pp a two-run reading produced.

Two things in the table are worth separating from that.

**The count is stable and the selector is not.** Both of the first two runs score exactly 380 of
600 for the modal result; the selector scores 367 and 362. The count is a function of the rows; the
selector is a function of the rows, the previews, the prompt and the sampling of a call at
temperature 0. A rule that moves between runs while its competitor does not is a rule whose deltas
need a shared pool before they can be read at all.

**Reachability is not conversion.** On the cross pool 259 of 432 disputed cases had a correct
candidate — that is the ceiling. The count reached 219 of them and the selector 185. Aggregate
`candidateRecall` for the three arms was 413, 409 and 419 of 600, so the loss between ceiling and
score lives on the disputed cases, and the decision rule is one of the things that spends it.

### Why this is not a rule chosen after the fact

It was chosen after the fact, and the correction above is the proof of what that costs. What
survives as a finding rather than a fitted rule is a claim about a *shape*, not a claim about a
number:

1. The direction on the cross pool held in three runs (14 / 27, 8 / 26, 18 / 21), dispatched hours
   apart, with code changes in between that touched the repair loop and not the selector.
2. It held on four arms outside the pair as well: `select-cross-repair-second` 18:24,
   `select-cross-judge-reasoning` 20:23, `select-cross-unhinted` 19:22, `select-cross-agree` 23:22 —
   all within a case or two of even, none in the selector's favour.
3. It reversed on the homogeneous pool, which is the prediction a shape claim makes and a
   "selector is bad" claim does not.

What is *not* established is the size, and the first version of this section got that wrong by
reading two artifacts and not the third. Both arms draw their own pools, and this harness has
measured the pool's own displacement at 1.3 to 3.3pp at 600 questions — larger than the +0.50pp the
third reading found. So the reading licensed two arms and an instrument, and no change to any
default.

### Two arms that turn the reading into a measurement

`select-cross-pooled-vote` reads `select-cross`'s candidates and returns the modal group. It
generates nothing and calls no model, so its price is zero and its candidates are the parent's own
objects. `select-cross-pooled-agree` reads the same pool with the agreement marks, which is the
information the selector has never had on this pool: 140 to 155 cases in 600 had more than one
distinct result, and which of three candidates returned the same rows cannot be computed from two
truncated previews.

Both are one lever from `select-cross-pooled`, which is the A/A instrument — the arm that generates
nothing and must score exactly what `select-cross` scored. The chain is therefore:

- `select-cross` → `select-cross-pooled`: must be 0.0pp. If it is not, pooling is broken and no delta
  below can be read.
- `select-cross-pooled` → `select-cross-pooled-vote`: who decides. Same candidates, same rows, same
  order, one call against zero.
- `select-cross-pooled` → `select-cross-pooled-agree`: what the decider is told, at the same price.
- `select-cross-pooled` → `select-cross-pooled-judge-reasoning`: who decides, with the strong model.

The pair is now a two-sided test rather than a one-sided one. On the homogeneous pool the selector
should win and the count should lose; on the heterogeneous pool the count should be at least even.
An arm pair that reports the same sign on both pools would say the shape claim is wrong, which is a
result worth having.

`select-cross-pooled-vote` is also the first arm in the table whose accuracy has no generation noise
in it at all. A run that dispatches the five arms spends three generations per case once and then
reads the same pool four ways, which is what makes a 600-question dispatch affordable enough to
repeat.

### The instrument

```
pnpm bench:bird:decision eval/out/bird-eval.json --arm select-cross
```

It reads any archived artifact, needs no key and no database, and prints the table above for one arm
or for all of them. Two details are deliberate: a case with no candidate is counted apart rather than
scored as an opinion the count got wrong, and the tie-break is taken from the drawing order, which is
what `majorityResult` does — a tie-break that happened to favour one author would look like a
mechanism, and 32 of the 292 disputed cases are ties.

The end-to-end case in `test/bird-run-e2e.test.ts` builds a pool where the two decisions must
disagree — the second model writes a statement that runs and is wrong, the two primary prompts write
the gold one, and the selector answers `1`, the slot the second model holds — and asserts that the
count scores every case, the selector none, and the agreement marks reach the prompt. A pooling bug
would break all three together, which is why they are one case.

## The five-arm reading, and the two defects that were in the way

`41410112996` dispatched the five arms on 600 dev questions — `deepseek-chat` writing two of the
three candidates, `deepseek-reasoner` the third, and the pool read four ways. It scored every arm and
then refused to publish: `assertPoolShared` fired on the reasoning-judge arm. The per-arm lines it
printed before dying are the reading, and the assertion's failure is a finding of its own.

| arm | passed | acc | strict | recall@3 | Δ vs pooled |
|---|---|---|---|---|---|
| `select-cross` | 375/600 | 62.50% | 360 | 69.7% (418) | −0.67pp |
| `select-cross-pooled` | 379/600 | 63.17% | 364 | 69.7% (418) | — |
| `select-cross-pooled-vote` | 380/600 | 63.33% | 361 | 69.7% (418) | +0.17pp |
| `select-cross-pooled-agree` | 386/600 | 64.33% | 370 | 69.7% (418) | +1.17pp |
| `select-cross-pooled-judge-reasoning` | 374/600 | 62.33% | 357 | 69.2% (415) | −0.83pp |

The first column of Δ is `arm − pooled`, and `select-cross`'s was written as `+0.67pp` in the round
that produced this table: 375 against 379 is four cases *below*, not above. The sign is corrected
here rather than quietly, because the direction is the one thing this table is for — the parent arm
has now come in below the pooled arm in both dispatches (−0.67pp, then −0.83pp), and a sign error in
the first reading would have made the second look like a reversal.

Read against the five criteria the round was dispatched with:

1. **The instrument holds at the ceiling and not at the decision.** Both arms read the same pool and
   both report 418/600, which is the identity the pooling was built to prove. The decisions differ by
   four cases. Those four are the selector's own jitter: same candidates, same prompt, same
   temperature, four different answers. That is a number the previous rounds did not have — a
   ±0.67pp floor under every selector comparison this repository has published.
2. **Heterogeneous pool, free aggregator at least even:** 380 against 379, +0.17pp. The vote is not
   worse, and it costs nothing.
3. **Homogeneous pool:** not measured in this dispatch, and the criterion stays unread rather than
   inferred. `select-mixed-pooled` and `select-mixed-pooled-vote` are the pair that reads it, and
   they are in the next one: the same two levers the cross pool was measured with, on a pool where
   three prompts from one author disagree on 8.3% of cases instead of 23–26%.
4. **The agreement marks are worth +1.17pp** at the same price, which is the one positive reading of
   the run: what the selector was missing is *structure* — which of the three candidates returned the
   same rows — and not adjudication.
5. **The reasoning model in the judge's seat loses 0.83pp.** Even with the three unrecorded cases
   scored charitably, the arm cannot exceed 377/600 (62.83%) and stays behind the vote. The seat that
   pays is the generation seat; the adjudication seat does not. That is the answer to "does the strong
   model win", and it is negative for this lever.

The three unrecorded cases are the second defect, and it was not in the assertion. The selector call
was the one call in the vote branch with no catch: a refusal from the endpoint escaped to the
per-case wrapper, which returns a row with no candidate record, so a case whose pool *did* hold the
answer reported nothing about it. `assertPoolShared` then compared a missing ceiling against a
present one and named the wrong bug — "the shared-pool arm generated its own candidates" for an arm
that had read the pool and failed to adjudicate it. Three changes followed, each from a test that
failed first:

- the adjudication and the empty-result turn are caught where they happen, the case is scored by the
  vote it already had, and `selectionFailed` / `retryFailed` record that the lever did not run;
- `assertPoolShared` excludes a case either side never decided, counts it, and proves the shared pool
  from the statements the arm handed back as well as from its ceiling;
- `assertSelectorAnswered` refuses an arm whose adjudications were an outage above the same 10% share
  the candidate-survival guard uses — without it, an endpoint that refuses every adjudication
  publishes the free aggregator's accuracy under the selector's name.

The first of those removed the only test that reached the wrapper whose job is "one case cannot take
the run down". Reaching it again found that the card — the first call an arm makes — was built
outside the wrapper, so a refused card did end the run. That call is now inside it.

The reading above is therefore provisional in one direction and final in another: the direction is
worth acting on now (structure pays, adjudication does not, on this pool), and the exact numbers need
the clean re-dispatch, because `41410112996` wrote no per-case artifact.

## The second dispatch: eight arms, and the guard that mistook a gap for a bug

The clean re-dispatch added the homogeneous pool — `select-mixed`, `select-mixed-pooled`,
`select-mixed-pooled-vote` — beside the five cross-pool arms, because criterion ③ (the free
aggregator is not worse than the selector on a pool where the candidates agree) had never been read
on the pool it was written for. `41430569500` scored six of the eight and then refused to publish.
The six lines it printed before dying are worth recording, because the run is a counter-example to a
conclusion the previous section drew too confidently:

| arm | passed | acc | strict | recall@3 | Δ vs pooled |
|---|---|---|---|---|---|
| `select-cross` | 379/600 | 63.2% | 363 | 70.5% (lost 44) | −0.83pp |
| `select-mixed` | 382/600 | 63.7% | 364 | 65.3% (lost 10) | — |
| `select-cross-pooled` | 384/600 | 64.0% | 368 | 70.5% (lost 39) | — |
| `select-cross-pooled-vote` | 383/600 | 63.8% | 364 | 70.5% (lost 40) | −0.17pp |
| `select-cross-pooled-agree` | 386/600 | 64.3% | 370 | 70.5% (lost 37) | +0.33pp |
| `select-cross-pooled-judge-reasoning` | 383/600 | 63.8% | 368 | 70.5% (lost 40) | −0.17pp |

Three things follow from it and one does not.

The agreement marks are the only lever that has now paid twice: +1.17pp on `41410112996` and +0.33pp
here. The direction survives a re-draw and the magnitude does not, which is exactly what a ±0.67pp
selector jitter predicts — read the pair as "+0.75pp ± 0.67", not as +1.17.

**The selector's advantage over the free aggregator does not survive.** On `41410112996` the vote was
0.17pp *ahead* of the selector on the same pool; here it is 0.17pp *behind*. Both are inside the
jitter the A/A pair measured, so criterion ② reads "even", twice, which is a stronger statement than
either run alone: on a pool where two of three candidates come from one author, paying a call to
choose is worth zero.

**The reasoning judge loses 0.17pp here and 0.83pp there, and it is the same seat.** It also could
not adjudicate one case of six hundred (`select-failed 1`, which the new column exists to report). Two
readings with a sign that never flips are the answer to "does the strong model win in the judge's
chair": no, and the generation seat is where it earns its keep — the ceiling on the cross pool is
70.5% against 65.3% on the homogeneous one, and the extra author is the reason.

What does *not* follow is criterion ③, and the run did not get to it. `select-mixed-pooled` died on
its second case: two of six hundred cases in `select-mixed` produced **no candidates at all** — every
sample died at the engine — and `reusePool` raised a plain `Error` on the empty pool. `escapeKind`
files a plain error under `harness`, and `assertHarnessClean` refuses to publish a run with a harness
error, on the correct principle that a `TypeError` inside the runner is a bug rather than a wrong
answer. Here the principle was right and the diagnosis was not: nothing in this repository was
broken. The source arm could not answer those two questions and its row said why.

The fix is a distinction rather than a tolerance. A pool lookup now returns either the candidates or
*the row in which the source recorded its failure*, so the pooled arm writes the same reason under
the same `errorKind` and the case is scored like any other failure; `reusePool` refuses exactly one
thing, a case the source never ran, which is the ordering bug the lookup exists for. A gap in the
sample is now a case, not a dead run — and the run that revealed it had already scored six arms.

That made a state reachable which the call site had documented as unreachable: a pooled case with no
candidate record. `assertPoolShared` has returned `{ shared, unrecorded }` since the adjudication fix
and the counts were thrown away; they are now published on the arm's row as
`poolRead: { shared, unrecorded, cases }`, and `assertReportComplete` refuses a pooled row that names
its parent and not the denominator. The number a reader needs is not "the pool was shared" but "the
pool was read on 598 of 600 cases, and the two it could not read are the two the source could not
fill". Below the instrument floor the field is absent rather than zero, because seven cases cannot
verify a pool and a zero there would read as a failure.

The lesson is the one D56 named and this round confirms: a guard may only assert what it measured,
and "missing" has to be a counted, permitted state rather than a synonym for "opposite". The two
guards that got this wrong — one refusing an empty pool as a harness bug, one calling a silent case a
disagreement — both failed in the direction of accusing the harness of the data's behaviour.

## Where the eight-arm reading stands

Three dispatches, and the third one finally read criterion ③ — the first run had no homogeneous pool
arms at all, the second was refused before reaching them (I-80), and the third ran to completion on
all eight (`41440646002`, 600 questions, `deepseek-chat` with `deepseek-reasoner` writing the
`@second` candidates):

| arm | score | ceiling | calls |
|---|---|---|---|
| `select-cross` | 382 (63.7%) | 70.0% | 4 |
| `select-mixed` | 384 (64.0%) | 66.5% | 4 |
| `select-cross-pooled` | 383 (63.8%) | 70.0% | 1 |
| `select-cross-pooled-vote` | 381 (63.5%) | 70.0% | 0 |
| `select-cross-pooled-agree` | 386 (64.3%) | 70.0% | 1 |
| `select-cross-pooled-judge-reasoning` | 380 (63.3%) | 70.0% | 1 |
| `select-mixed-pooled` | 385 (64.2%) | 66.5% | 1 |
| `select-mixed-pooled-vote` | 381 (63.5%) | 66.5% | 0 |

| criterion | status | reading |
|---|---|---|
| ① `select-cross-pooled` is an exact A/A instrument | met | identical ceilings on one pool; decisions differ by 1–4 cases in 600 (jitter) |
| ② heterogeneous pool: `vote − pooled ≥ 0` | even three times | +0.17pp, −0.17pp, −0.33pp — all inside ±0.67pp, so the vote neither gains nor loses on this pool |
| ③ homogeneous pool: `vote − pooled ≤ 0` | **met** | `381 − 385 = −0.67pp`, exactly one jitter unit — the selector converts where the vote cannot |
| ④ `agree − pooled ≥ +1.0pp` ⇒ structure is the missing information | met in direction | +1.17pp, +0.33pp, +0.50pp; the mean of three is +0.67pp, below the bar it was registered against |
| ⑤ `judge-reasoning − pooled ≥ +1.0pp` ⇒ the strong model wins the judge's seat | refuted | −0.83pp, −0.17pp, −0.50pp — three readings, one sign |

Two of the five criteria are now settled and they settle each other. ② and ③ are the same comparison
on two pools that differ only in whether the candidates were aimed: on the cross pool the three
candidates disagree often, the vote and the selector tie, and a paid decision buys nothing; on the
mixed pool the candidates largely agree, and the selector beats the vote by exactly the jitter it was
measured against. That is the shape hypothesis the pair was built to test, and it holds in the
direction predicted — **selection pays where the candidate set is redundant and does not where it is
already diverse**. It also reframes the reconcile arm: it is dispatched on the *cross* pool, which is
the one pool on which a model reading the candidates cannot beat a count, so a reconcile win there
would not be a better selector wearing a new name — it would be the only lever that has converted on
that pool at all.

## The third dispatch, and the guard that priced a free candidate set

`41440646002` finished all eight arms and then failed its gate — on four rows, all of them pooled:

```
BIRD1: select-cross-pooled samples 3 times, selects with the model, and reports 1 calls per case;
       the selector call is not counted
```

The rows were right and the tool was wrong, which is the more dangerous of the two errors: a gate that
refuses a correct row teaches its reader to skim. The rule it applied is sound for the arm it was
written for — a generating arm that samples three times and selects with a model spends four calls,
and three means the selector went unbilled — but a pooled arm does not sample. Its candidates are the
ones its source arm already paid for, so one call per case *is* its price, and the four rows were
reporting precisely the number they exist to report (I-81).

The rejection still pointed at a real gap. `calls.mean` cannot separate the two states a pooled arm
can be in: a case whose pool came back empty returns before the selector and spends nothing, so
`0.995` is "three cases never reached the decision" on a correct arm and "the selector is not counted"
on a broken one. The mean is the same number in both readings. The artifact now carries the counts
instead (`spend: { asked, priced }`, published for every arm that decides with the model, because the
same interval opens on a generating arm: `mean > samples` passes with 3.5 calls on 3 samples), the
runner refuses to publish a select arm without
them, and the gate reads them in place of the mean:

- any arm with `selector: 'model'` → `priced === asked > 0`, else "the selector call is not counted";
- a pooled arm → `mean` must be strictly below its source arm's, else "the candidates were drawn
  twice", which is the failure pooling exists to prevent and the one a mean can catch;
- a generating arm keeps the level check as well (`mean > samples`), because the candidates have to be
  paid for on top of the decision.

Fixing the tool rather than the number is the point of the exercise, and it is worth stating plainly
because the opposite move is always available: the four rows could have been "fixed" by adding a call
that never happened.

## The reconcile arm, and the criterion it is dispatched against

The two readings on the shared pool leave one lever standing and close another. Closed: paying a
model to pick among three candidates on the 2+1 pool is worth nothing (+0.17pp, then −0.17pp, both
inside the ±0.67pp jitter the A/A pair measured). Standing: telling the model *which candidates
returned the same rows* has paid twice (+1.17pp, +0.33pp) — structure, not adjudication.

The arithmetic that points to the next lever is the gap between the ceiling and the score. On the
cross pool 70.5% of cases (423/600) hold a statement that matches the gold result, and the arm
scores 64.0% (384/600). Thirty-nine cases contain a correct answer the decision does not return.
An index cannot fix those: an index names a member of the set, and the reading that wins is "the
members are not the answer".

`select-cross-pooled-reconcile` is therefore one lever from `select-cross-pooled` — same
candidates, same shared pool, same single call at temperature 0 — with a different answer format.
It hands over the *result groups* (`resultGroups`: the partition the agreement marks already
define, one group per distinct result) and asks for the statement to run
(`buildReconcilePrompt`). The reply is executed against the case's database and, if it runs,
becomes the answer. Two fallbacks are named rather than silent: a statement the engine refuses
leaves the vote's answer standing, and a turn that never came back is an outage recorded in
`selectionFailed`.

The funnel the arm publishes is `asked / returned / novel / executable / adopted`, and the
guarded column is `novel`. The criterion, registered before the dispatch:

| criterion | threshold | why this number |
|---|---|---|
| ① the lever ran | `novel > 0` on the sample, and the funnel appears in the artifact | an arm whose every reply restates a candidate is a selector with a longer prompt; `assertReconcileFired` refuses the run otherwise |
| ② it beats the free rule where the free rule is weakest | on disputed cases (`select-cross-pooled` vs `select-cross-pooled-vote` disagree), more than the vote's share | the vote scores 63.3% for no calls at all; a paid lever that cannot beat it on the cases where a decision exists has not bought anything |
| ③ it does not lose the cases the vote wins | overall `reconcile − vote ≥ 0`, and no more than 1pp of the 39 reachable cases lost | a statement the model writes can be worse than any candidate it was shown; that is a cost, and it has to be smaller than the gain |
| ④ it is not the selector in disguise | `novel` share ≥ 10% of cases | below that, the delta belongs to the selector and the arm's name is wrong |

Dispatch: `select-cross, select-cross-pooled, select-cross-pooled-vote,
select-cross-pooled-agree, select-cross-pooled-reconcile` on 600 dev questions, second model
`deepseek-reasoner`. The pooled arms must run after `select-cross` in the same dispatch, because
the pool is what makes the comparison free of generation noise.

One cost note: the reconcile prompt is longer than the selector's (it carries one statement per
group rather than one line per candidate), and `packages/ai` sits at 53,270 B gzip against a
54,500 B budget. The next prompt that lands there needs a budget line of its own, priced the way
`packages/node`'s was, rather than a quiet absorption.

## The sixth dispatch: the policy bought back nine cases, and the rest is the model

`41462471819` ran the five arms on the same 600 dev questions with `deepseek-reasoner` as the second
model. Same pool, so the ceiling is shared again; the new arm differs from `-reconcile` by the
adoption policy and by nothing else.

| arm | score | calls/case | funnel |
|---|---|---|---|
| `select-cross` | 375/600 = 62.50% | 4 | — |
| `select-cross-pooled` | 374/600 = 62.33% | 1 | pool read 600/600 |
| `select-cross-pooled-vote` | **379/600 = 63.17%** | 0 | — |
| `select-cross-pooled-reconcile` | 354/600 = 59.00% | 1 | `always`, `novel 88, executable 595, adopted 595` |
| `select-cross-pooled-reconcile-novel` | 363/600 = 60.50% | 1 | `novel`, `novel 88, executable 594, adopted 82` |

The criterion registered before the dispatch:

| criterion | threshold | reading | verdict |
|---|---|---|---|
| ① the policy took effect | `adopted < executable` and `adopted ≤ novel` | 82 < 594, and 82 ≤ 88 | **holds** |
| ② the paraphrases were the loss | `reconcile-novel > reconcile`, strictly | 363 > 354, +9 cases (+1.50pp), p = 0.253 | **holds** |
| ③ the corrections pay for the call | `reconcile-novel − vote ≥ 0` | 363 − 379 = −16 cases (−2.67pp), p = 0.0015 | **fails** |
| ④ the flip set is positive | more `vote`-lost to `novel`-won than the reverse, on the disputed cases | vote 8, novel 3 on the 150 disputed cases, p = 0.227 | **fails** |

So the policy hypothesis was right and it was not enough. Handing the restatements back is worth
**+9 cases** — the damage the fifth dispatch attributed to paraphrases was real, and ② confirms it on
an arm that differs from its parent by nothing else. On the disputed stratum the same change cuts the
count's advantage from 14 cases to 5 (`bench:bird:decision`: `-reconcile` 20/34, p = 0.076;
`-reconcile-novel` 3/8, p = 0.227).

What is left is not a policy. `bench:bird:reconcile` cuts the artifact by the arm's own records:

```
stratum          n     vote  policy  flips (policy/vote)  p
novel            82    34    18         4/20            0.0015
declined         518   345   345        0/0             1.0000
paraphrased      0     0     0          0/0             1.0000
```

Two facts, and the first one closes the line: the declined stratum is **identical to the vote, case
for case** (the invariant holds, 518 of 518), and on the 82 novel cases the vote is right 34 times
against the arm's 18. That deficit is exactly the arm's whole deficit — 379 − 16 = 363 — so after the
adoption rule is removed as a cause, **every remaining case of the gap is a statement the model wrote
and got wrong**. The lever's ceiling on this pool is the model's own writing, not the pipeline around
it, and no prompt or policy change in this repository moves it. On the 518 paraphrases the policy wins
28 cases against the adopting arm's 17, which is the +11 that the nine-point total is made of, minus
two cases the two arms read differently because each asks the model itself.

**Line closed.** Result-level reconciliation on the 2+1 pool is not a lever worth another dispatch:
two rounds priced it (3.50pp of loss, 1.50pp recovered) and the residual is model capability. The
next lever has to change what the candidates are, not what is done with them — `I-45` (the columns a
question needs, named by the split's differential) and `I-77` (candidate diversity) are the two that
remain on that axis.

## The fifth dispatch: eighty-six statements nobody wrote, and 514 paraphrases

`41453395203` ran the five arms on 600 dev questions with `deepseek-reasoner` as the second model.
All five read the same pool — the ceiling is 415/600 = 69.17% on every row — so every delta below
is a decision and not a candidate set.

| arm | score | calls/case | funnel |
|---|---|---|---|
| `select-cross` | 378/600 = 63.00% | 4 | — |
| `select-cross-pooled` | 377/600 = 62.83% | 1 | pool read 600/600 |
| `select-cross-pooled-vote` | **380/600 = 63.33%** | 0 | — |
| `select-cross-pooled-agree` | 374/600 = 62.33% | 1 | — |
| `select-cross-pooled-reconcile` | 359/600 = 59.83% | 1 | `asked 600, returned 600, novel 86, executable 595, adopted 595` |

The criterion registered above, read against its own dispatch:

| criterion | threshold | reading | verdict |
|---|---|---|---|
| ① the lever ran | `novel > 0` on the sample | 86 of 600 replies (14.33%) were a statement nobody wrote | **holds** |
| ② it beats the free rule where the free rule is weakest | more than the vote's share of the disputed cases | reconcile wins 16 of the cases the vote loses and loses 37 of the cases the vote wins | **fails** |
| ③ it does not lose the cases the vote wins | `reconcile − vote ≥ 0`, and ≤ 1pp of the 39 reachable cases lost | 359 − 380 = −21 cases = −3.50pp | **fails** |
| ④ it is not the selector in disguise | `novel ≥ 10%` of cases | 14.33% | **holds** |

`bench:bird:decision` states the same thing, on the 153 cases whose three candidates do not agree —
the only stratum where a decision exists at all. Its columns are each arm's own selector against its
own modal count over the same candidates, not against `select-cross`:

| arm | only the selector right | only the count right | count − selector | p |
|---|---|---|---|---|
| `select-cross` | 16 | 18 | +2 (0.33pp) | 0.864 |
| `select-cross-pooled` | 17 | 20 | +3 (0.50pp) | 0.743 |
| `select-cross-pooled-agree` | 17 | 23 | +6 (1.00pp) | 0.430 |
| `select-cross-pooled-reconcile` | 15 | 28 | **+13 (2.17pp)** | 0.066 |

Read that way the reconcile turn is not "3.5pp worse than the vote" in the abstract: on the stratum
where a decision exists it loses 13 cases to a rule that costs nothing, and the two arms are the same
candidates with the same pool. The full sample is blunter still — the vote wins 37 cases the arm
loses and the arm wins 16 the vote loses, net 21, p = 0.0055 — so the loss is not noise, and the
split of those 37 says where it comes from: 28 on the disputed cases above, and 9 on the 447 where
all three candidates already agreed. A restatement on an agreed case cannot change the rows, so the
nine are statements *nobody* wrote — the paraphrase story explains 28, and the other nine are the
price of the turn writing something of its own.

### Where the twenty-one cases went

The funnel says it: 595 of 600 replies ran, and only 86 of the 600 were a statement no candidate
contained. The other 514 restated a candidate — the model read the result groups and wrote back one
of the statements it had been shown, paraphrased. An arm that adopts whatever the engine runs
therefore replaces the vote's answer with that paraphrase on 514 cases, and 37 of those were cases
the vote had won.

That is arithmetic the artifact supports exactly, and it is worth stating as an identity rather than
a story. Write `R` for the restatement cases and `N` for the novel ones, `v` and `r` for who was
right, and a policy that hands restatements back returns

```
score_policy = v_R + r_N  =  vote + (r_N − v_N)
```

so the whole difference between the policy and the free rule is the novel population. With the
fifth artifact alone the two terms are not recoverable: it says 16 gains and 37 losses overall but
not which of those cases were paraphrases, so the policy's score is bounded and not predicted —
`[380 − 37, 380 + 16] = [343, 396]`, i.e. 57.2% to 66.0%. A band that wide is not a measurement, and
the reason it is wide is a missing field rather than a missing experiment.

### The tool the next reading is taken with

`bench:bird:reconcile` cuts an artifact by the policy's own per-case records and checks the two
invariants that make the cut readable: a declined statement must leave the vote's verdict standing
case for case, and on a novel statement the two arms must agree (they adopt the same reply). It also
names the third state — an arm that says it scores only novel statements and scored a paraphrase —
because that is the arm failing to run the lever it is named for. On an artifact with no per-case
record it says so and exits non-zero rather than printing zeroes: `41453395203` is exactly that
artifact, and a zero there would read as "the policy moved nothing".

### What the next dispatch has to be able to say

Two changes, both to the artifact rather than to the prompt, because the prompt is not what was
wrong:

- **`reconcile.policy` travels with the counts.** `executable === adopted` was a fact about the arm,
  not about the turn, and a reader with only the numbers cannot tell a policy at work from a funnel
  that counted one reply twice. The row now says which policy produced its `adopted` column, and the
  gate reads it: equal under `'always'`, nested under `'novel'` (`adopted ≤ novel`), four nested
  counts either way. `emptyRetry.mode` is the precedent.
- **The per-case record is published.** `cases[].reconcile` carries `{ returned, novel, executable,
  adopted }` per case, because a funnel says how many and a pair of arms is tested on which. The
  16-and-37 above are per-case outcomes; being able to cut them by `novel` is the difference between
  a hypothesis and a reading.

With those in place, `select-cross-pooled-reconcile-novel` — the same prompt, the same call, the same
pool, and restatements handed back to the vote — is one lever from the arm that just read 59.83%, and
the criterion registered before it runs:

| criterion | threshold | why this number |
|---|---|---|
| ① the policy took effect | `adopted < executable` on the sample **and** `adopted ≤ novel` | an arm named for a policy that did not change what it scored is its parent under another name |
| ② the paraphrases were the loss | `reconcile-novel > reconcile`, strictly | nothing else changed between the two arms; if handing the restatements back does not raise the score, the 37 losses were not the paraphrases and the premise of this lever is wrong |
| ③ the corrections pay for the call | `reconcile-novel − vote ≥ 0` | 63.33% for no calls is the bar every paid arm on this pool has now failed to clear three times |
| ④ the flip set is positive | more `vote`-lost to `novel`-won than the reverse on the disputed cases (McNemar) | a net delta can hide two large opposite movements, and the disputed stratum is where the decision is |


## Pricing the value block at the width it would be built at

The block that shows stored values on the card has been carried for three rounds on two readings
that are both about the sampler rather than about the information: a 2.22pp ceiling from the width
audit, and +1.31pp at p = 0.052 on 500 questions, which is 6.5 cases against a design that needed
18. The second reading was retired as "not significant", and that is the wrong reading of it — a
lever that lands at a third of its own ceiling and stops is a lever that was measured too small,
not one that does not work.

What was never priced is the size the block would be built at. Bisecting the two readings needs no
model and no database write, only the profiler cache and the gold statements, and the answer is
the reason the family is still open:

| rule | characters a case | vs the plain card | cases it touches |
| --- | --- | --- | --- |
| no block (the card) | 1,479 | — | 0 |
| every profiled column (`samples`) | 2,047 | **+38.4%** | 500 / 500 |
| the columns a gold statement filters on | 1,499 | **+1.4%** | **185 / 500 (37.0%)** |

Measured on the 500-question Mini-Dev split, per case, with the same renderer the arms use. The
per-case distribution is what makes the second row affordable rather than merely smaller: median
+0.0%, p90 +8.5%, max +25.6%. A block that costs 1.4% of the card on average cannot be blamed for
a prompt budget, and the three rounds of "the prompt grew 22.9% and bought nothing" were measuring
a block that was 27 times larger than the one a rule would send — 568 characters a case
against 20, both measured on the same card.

The by-database spread is the other half of the reading, because it says where the family can and
cannot reach at all:

| database | cases | touched | characters added |
| --- | --- | --- | --- |
| card_games | 52 | 25 | +2,424 |
| student_club | 48 | 22 | +1,883 |
| superhero | 52 | 21 | +1,302 |
| european_football_2 | 51 | 15 | +1,307 |
| financial | 32 | 24 | +895 |
| debit_card_specializing | 30 | 19 | +878 |
| thrombosis_prediction | 50 | 19 | +443 |
| toxicology | 40 | 25 | +319 |
| california_schools | 30 | 10 | +286 |
| formula_1 | 66 | 5 | +310 |
| codebase_community | 49 | **0** | 0 |

`codebase_community` is not a bug: its gold statements filter on `id`-like and text columns the
profiler keeps no dictionary for, so no rule of this family has a column to show there. That is a
**property of the corpus**, and it belongs in the reading before a delta is attributed to it —
0% of 49 questions is not "the block did not help", it is "the block was never built".

### The arm, and why it is an oracle

`inline+evidence+samples-gold` is the same sampler, over the same values, in the same order, with
the same call count, and only the columns the gold statement's conditions name. It reads the
answer, which is exactly what makes it worth one dispatch: no realizable rule can beat a rule that
knows the answer, so its delta closes the question in one direction.

- If the block buys **nothing** while being shown exactly the right columns, no rule that guesses
  them can buy anything either, and the samples family is finished — not "underpowered", finished.
- If it does buy something, the delta is the **budget** a realizable rule has to be judged
  against. A rule that captures a third of it is a rule worth building; one that captures a tenth
  is not, and that comparison is impossible without a ceiling taken at the right width.

The arm is declared on demand, never in a chain, and its catalogue note says it is an oracle. That
is the difference between an experiment and a candidate: the oracle can be run twice and gives the
same number, and it can never be shipped.

### The funnel it needs, and the guard that makes it readable

`controls.sampledColumns` is a total over every database a run touched, so it answers "did anything
get sampled" and not "did this rule reach these cases". The row now carries `sampleBlock`:

```
sampleBlock: { cases, withValues, columns, empty }
```

A rule declared without a sampler is refused one level earlier, at the arm: `assertSampleRule`
rejects `sampleColumns` with no `samples`, because the pair is one lever and the second half alone is
a switch nothing reads. `empty` is the count of cases the rule reached nothing on — a statement with no condition has no
column to narrow to — and it is D56 in its counting form: "the rule kept nothing" and "the rule was
not measured" are the same number and opposite findings. `assertSampleBlockFired` refuses to publish
a narrowed arm whose `withValues` is zero, because that arm is its parent with a longer name and its
zero delta would be read as "the columns that matter do not help".

### The defect the end-to-end run found on the way

The first end-to-end case for the narrowing read a card built from **another fixture's schema**. The
profile cache was one directory for every dataset, keyed by database name: the chain fixture and the
mini fixture both name their database `shop`, so whichever profile was written first answered for
both. The failure mode is the one this repository has already paid for once — it is the reason
`.value-examples` lives inside the dataset — and the sentence in that comment applies verbatim: *a
fixture and the corpus can name a database alike, and a single directory let a test's `shop` be
served to whatever read `shop` next.*

The profile is now cached at `<data>/.profiles`, the layout test names the path, and the adversarial
runner follows the same rule. The cost is one recomputation per split after the change, paid once
and then cached with the dataset it describes.

### What the dispatch has to be able to say

`bird-dev`, three arms, 1,532 questions, one call a case:

| criterion | threshold | why this number |
|---|---|---|
| ① the ceiling is worth having | `samples-gold ≥ +1.5pp` over `inline+evidence` at **p < 0.01** | below it, no realizable rule can clear the 1.5pp the plan asks for |
| ② the narrowing is not the loss | `samples-gold ≥ samples` | if the narrow block is *worse* than the wide one, the columns were never the cost and the family's premise is wrong |
| ③ the block stays affordable | `samples-gold` prompt characters within **5%** of the parent's | a lever that buys a point with a third of the prompt is a different lever |
| ④ the rule reaches cases | `sampleBlock.empty` below the parent's `cases` | a rule that touched nothing anywhere would pass ① at 0.0pp and mean nothing |

Criteria ② and ④ are what this round adds: ① alone cannot separate "the columns were right" from
"the block was smaller", and the artifact now carries the count that separates them.

**The staging is part of the registration.** The plan's criterion for this lever is written on
`select-mixed` (≥ +1.5pp, p < 0.01) and `select-cross` (≥ +1.0pp), and both are four-call arms. This
dispatch is the first stage at one call a case, and it exists because composing a block that has
never been priced at its own width with a four-call arm would spend 6,128 completions to learn the
same thing the 4,596 above can say. Stage B — the block on every candidate of the adopted arm — is
run only if stage A clears ①, and it is then the arm the plan's criterion is written about.

## What the pool's three candidates are worth, one opinion at a time

Every candidate-side reading in this file has priced a **union**: take the candidates an arm kept,
ask which questions any of them answers, and the difference between two unions is what one more
call buys. `bench:bird:pool` prints exactly that, and it is honest about the thing it cannot see —
a pool of three candidates that return the same rows three times costs three calls and carries one
opinion, and its union looks identical to three genuinely different attempts.

`bench:bird:diversity` reads the other half. It costs no model call and no oracle query, because it
reads `cases[].candidates`, which the runner already writes: each candidate carries its source, its
verdict and a fingerprint of its result set.

**Three numbers that a union cannot produce.**

| reading | on the 600-question dev artifact (`41453395203`) |
|---|---|
| ceiling (any candidate correct) | 415 / 600 = **69.17%** |
| distinct results per case | **1.28** mean, 3 max |
| unanimous cases | **447 = 74.50%**, right 326 = **72.93%** |
| cases with no correct candidate | 185 = 30.83%, of which **121 (65.41%) the candidates agreed on** |

The fourth row is the point of the instrument. A ceiling loss that the candidates *agreed* on
cannot be reached by any selector: the pool did not fail to find the answer, it converged on the
wrong one. Two thirds of what this pool misses is that kind, and it is the only part a lever on the
*candidates* can move — a lever on the *selector* moves the other third, which this file has
already priced three times and found worth at most a point.

**A hit rate is not a value.** Per source, on the same artifact:

| source | generated | correct | solely correct | ceiling without it |
|---|---|---|---|---|
| `inline+evidence@second` | 599 | 362 (60.33%) | **24 (4.00%)** | 65.17% |
| `values` | 594 | 377 (62.83%) | 8 (1.33%) | 67.83% |
| `metadata+evidence` | 594 | **378 (63.00%)** | 6 (1.00%) | 68.17% |

The best single source by hit rate is the *least* valuable by marginal ceiling, and the worst by
hit rate is the most valuable: the second model's candidate carries 24 questions alone that
neither prompt-varied source answers. This is the shape the literature describes from the other
direction — XiYan-SQL's end-to-end ablation loses **4.04pp** of execution accuracy when its multiple
generators collapse to one (73.34% → 69.30% on BIRD dev), and MCS-SQL prices five prompts at
**+1.3pp** against twenty samples of a single prompt at **+2.1pp**. Both say what this table says:
*more opinions* and *different opinions* are separate purchases, and only one of them is being
priced by a union.

**A denominator is part of the reading, and an invented field is not a reading.** The fingerprint
is what makes "one opinion" a fact rather than a claim, so an artifact that carries none cannot say
how many opinions a pool held. The first version of this harness answered anyway, by naming each
missing fingerprint after its source — which made every uncomparable case exactly as diverse as the
arm has sources. Read against a 2026-11-01 artifact written before the field existed, `select-mixed`
printed **3.00 mean, 0% unanimous**: the strongest possible statement of independence, on every one
of its cases, computed entirely from the arm's own configuration. The number a reader takes as the
measurement was the one number already known from the flags.

The case is now excluded from the mean and the population is printed beside it — `1.26 mean, 3 max
over 600 of 600 cases that carry a fingerprint` — and the artifact that produced the flattering 3.00
is refused instead:

```
select-mixed carries no result fingerprint on any of its 1507 cases, so the artifact cannot say
how many opinions the pool held — the number it would print is the length of the source list
```

Two refusals rather than one, because the two absences call for different fixes: nothing
fingerprinted at all is an artifact older than the instrument, and fewer than a hundred fingerprinted
cases is a share of the draw. `correlated` takes the same treatment, with `measurable` as the
denominator of "the losses the candidates agreed on" — agreement is precisely what a missing
fingerprint cannot report.

**The registration for the next lever, written before the dispatch.** The reading above is
zero-cost and comes from an artifact that is already paid for, so it decides the next paid arm
rather than following one:

1. **The lever acts on the 121.** An arm that spends a call only where the candidates agree must
   convert at least **2.00pp of the 600** (12 of the 121 unanimous losses) before it is worth its
   price; below that, the extra call is indistinguishable from the split's own resolution.
2. **The gain is placed where the lever claims to act.** On the 447 unanimous cases the arm must
   beat the vote by at least +1.5pp, and on the 153 non-unanimous cases it must stay within
   ±1.0pp. An arm that gains uniformly has not changed the candidates; it has changed the model.
3. **The ceiling moves, not just the score.** `candidateRecall` strictly rises against
   `select-cross-pooled-vote`: a lever that only re-ranks converts a ceiling that already existed.
4. **The price is stated per case.** Extra calls per case are printed on the row; a conditional
   call that fires on 74.5% of cases costs 0.745 and must be read that way, not as "one more call".

Until 1–4 are read, the honest statement about this factor is the one the table above supports:
**our pool carries 1.28 opinions per case, three quarters of its cases are unanimous, and two thirds
of its losses are unanimous** — so the ceiling is limited by *agreement*, not by *selection*.

**The arm that spends it.** `select-cross-pooled-dissent` is `select-cross-pooled` — same pool, same
selector, same one selection call — plus one generation bought on the cases where the three
candidates returned the same rows. Four numbers travel with each case, and each of them is a
failure the accuracy cannot express:

| per case | what it means | what a zero means |
|---|---|---|
| `asked` | the pool agreed with itself, so the call was made | the condition never held here |
| `arrived` | the endpoint answered *and* the engine ran the statement | an outage wore the arm's name |
| `distinct` | its rows differ from the pool's answer | a fourth vote for an answer that had three |
| `adopted` | it became this case's answer | the selector preferred a candidate it already had |

`asked` is the price. On the published pool it fires on 74.5% of cases, so the arm costs **0.745
calls a case**, and a row that published only `calls.mean` would make that indistinguishable from
"one more call on every case". `distinct` is the value: a fourth opinion that returns the pool's own
answer was bought and carried nothing, which is exactly the reading a score cannot give — the vote
keeps its decision either way.

**The source is the registration.** The pool's three opinions are two prompts of the primary model
and one of the second model, so a fourth *prompt* of the primary model would share a model with two
of them. `decompose` is the one generator here that answers by a different **method** rather than by
different wording, which is the property the literature prices: XiYan-SQL's ensemble ablation loses
4.04pp when its generators collapse to one, and MCS-SQL reads five prompts at +1.3pp against twenty
samples of one at +2.1pp. A source already in the pool is refused at the declaration
(`assertDissentRule`) rather than measured, because that purchase is a fourth vote by construction.

**Two failures are refused, one is published.** An arm whose condition never held is its parent
renamed, and an arm whose every call came back unrunnable is an outage; both stop the run with their
own sentence, because they call for opposite fixes. `distinct: 0` is *not* refused — "the extra
opinion always agreed with the pool" is a measurement, and it is the one that says the extra call is
a fourth vote.

**The reading, and the arm it registered.** `41551887197` (dev 1,532 questions, `deepseek-chat` with
`deepseek-reasoner` as the second model) returned a clean negative with a clean mechanism:

| arm | passed | score | ceiling | calls/case | `dissent` |
|---|---|---|---|---|---|
| `select-cross` (pool) | 936 | 61.10% | 1,023 | 3.998 | — |
| `select-cross-pooled` (parent) | 942 | **61.49%** | 1,023 | 0.998 | — |
| `+dissent` | 941 | 61.42% | **1,050** | 1.722 | `{asked 1109, arrived 1101, distinct 100, adopted 21}` |

Criterion ③ passed — the ceiling rose **1,023 → 1,050 (+1.76pp), 27 cases up and none down** — and
criterion ④ passed at **0.724 extra calls a case** against the 0.745 registered. Criterion ① failed
(−0.07pp, 6:5, p = 1.0000) and criterion ② failed on strength (+0.00pp on the 1,109 cases the
condition held) while passing on *placement*: the 423 cases it did not fire on have **token-identical
prompts (423/423)** and moved −0.24pp, which is the noise floor.

**Only 9.1% of the arrivals disagreed** (100 of 1,101), and on those 100 the per-candidate accuracy
was `inline+evidence@second` 38, `metadata+evidence` 38, `values` 37, **`decompose` 27**. The bought
opinion is the weakest of the four exactly where it is the only one that can speak — and it was right
on 27 cases the pool had all answered wrongly, which is why the ceiling rose and nothing fell.

**The information was in the set and the question could not reach it.** Conversion went from 92.08%
to 89.62%, the oracle over the same four candidates is 68.54% (7.1pp above the arm), and the selector
adopted the bought statement 21 times and was right 5 times. Pricing "adopt it whenever it disagrees"
off the same artifact gives **−0.72pp**, so that rule is dead without another dispatch.

**So the next arm changes the question, not the candidate**: `select-cross-pooled-dissent-pair` keeps
the parent's three-candidate prompt byte for byte and spends one comparison call **only** on the 100
disagreements — the shape `select-pair` already has, applied to the one pair that matters. Its price
is 1 selection + 0.724 generation + 0.065 comparison ≈ **1.79 calls a case**, and the criteria were
written before the dispatch:

1. the whole split gains **≥ 1.0pp** (16 cases);
2. the gain sits on the disagreements (**≥ 8 of the 100**), and the rest stays within ±0.5pp;
3. the ceiling is unchanged (the candidate set is unchanged) and **conversion returns above 92%**;
4. the comparison costs **≈ 0.065 calls a case** and its own funnel publishes `asked` and
   `choseDissent`, because a comparison that never fired is a bill with no measurement behind it.

### Rewriting the prompt buys no more opinions than re-rolling it (I-74, `41566622986`)

`I-74` asks a question the candidate side never separated: how much of a pool's disagreement is
**sampling variance** and how much is **heterogeneity** (different wordings seeing different things).
It needs an arm that draws the same prompt more than once, which the dev chain has (`vote`: three
draws at temperature 0.7) and a mixed arm to compare against (`vote-mixed`: three prompts, one draw
each). The probe ran both on the same 160 questions — **960 completions, no selector call** — and the
fingerprints are what make the comparison possible:

| arm | cases | 1 opinion | 2 | 3 | unanimous | ceiling | losses | **agreed-on losses** |
|---|---|---|---|---|---|---|---|---|
| `vote` — same prompt ×3 | 160 | 140 | 16 | 4 | **87.50%** | 109 = **68.13%** | 51 | **42 = 82.35%** |
| `vote-mixed` — 3 prompts ×1 | 158 | 141 | 15 | 2 | **89.24%** | 110 = **69.62%** | 48 | **41 = 85.42%** |

**Distinct results per case: 1.15 for three samples of one prompt, 1.12 for three different
prompts.** Rewriting the question three ways produced *no more independent opinions* than re-rolling
it — and if anything slightly fewer, though the difference is inside the noise at this sample size.
The pool's disagreement is therefore **sampling variance**, not heterogeneity: on this pipeline the
three "sources" are three dice, not three perspectives.

Two consequences, both of which the earlier readings had only inferred:

1. **The candidate side has no diversity lever left.** XiYan-SQL's 4.04pp and MCS-SQL's +1.3pp
   depend on the generators *knowing* different things; here they sample differently and know the
   same. That is why the fourth opinion (a genuinely different method) added 22 to 27 ceiling pieces
   and was still the weakest of the four candidates.
2. **What caps the ceiling is agreement on wrong answers**: 82% and 85% of the losses are cases where
   every candidate returned the same wrong rows. No selector reaches those, no extra sample moves
   them, and no re-wording has moved them either — they are *knowledge* failures.

So the lever that remains is the one that changes what the model can recall, not how it samples — and
`vote-mixed`'s 1.12 is the baseline any such lever has to beat on the same instrument.

**What the comparison can reach, computed before the reading arrives.** The arm was registered on
`41551887197`'s artifact, and that artifact already holds both statements the comparison will choose
between — so the oracle of the *pairwise* selector is an offline fact about the 100 disagreement
cases, taken at zero cost while the run was still in flight:

| on the 100 disagreements | cases |
|---|---|
| the pool's winner is right | 38 |
| the bought opinion is right | 27 |
| both are right | 5 |
| **either is right (the pairwise oracle)** | **60** |
| neither is right | 40 |

So the arm's ceiling is `941 − 38 + 60 = **963 / 1,532 = 62.86%**`, which is **+1.44pp (+22 cases)**
over the child and +1.37pp over the parent. Read against the four criteria that were written before
the dispatch:

- **① ≥1.0pp (16 cases) needs 73% of the 22 available.** The comparison has to convert nearly three
  quarters of everything it could possibly reach.
- **② ≥8 of the 100 needs 36%** — the arm can fail ① while passing ②, which is exactly the shape a
  two-way comparison of a weak candidate should produce.
- **③ unreachable by construction**: 92% of the ceiling is 966 cases and the oracle is 963. The
  criterion was written before this table existed and it sits **three cases above the maximum**. It
  cannot pass, and reporting it as a failure would blame the arm for an arithmetic error in its own
  registration. It is therefore recorded here, before the read, in two parts: ③ stands as written
  and its expected verdict is *unreachable by construction*; **③′** — the criterion that can decide —
  is `conversion ≥ 91.0%` (≥ 956 of 1,050), which is 78% of the way from the child's 89.62% to the
  91.71% oracle.

The general lesson is the one this file keeps recording from the other side: **a criterion phrased as
a share of a ceiling has to be checked against the oracle of the mechanism it prices**, or it
measures the registration rather than the arm.

**The reading (`41561960657`, dev 1,532, success).** `select-cross` **939 = 61.29%** (ceiling 1,034),
`select-cross-pooled` **940 = 61.36%**, `select-cross-pooled-dissent-pair` **941 = 61.42%** (ceiling
**1,056**) — **+1 case**, 5 up and 4 down. The funnel: `asked 1104 / arrived 1095 / distinct 102 /
adopted 10`, `pairwise { asked: 102, choseDissent: 10 }`. Criterion ① fails (+0.07pp), ② fails (no
net gain on the disagreements), ③ fails at 89.11% — and this run's own pairwise oracle is **91.0%**,
so ③ could not have passed even with a perfect comparison, ③′ (≥91.0%) included. ④ passes at
**0.0666 comparisons a case**.

**The contingency table is the verdict.** Of the 102 disagreements:

| incumbent | bought opinion | overturned | cases |
|---|---|---|---|
| wrong | wrong | no | 32 |
| wrong | wrong | **yes** | 8 |
| wrong | **right** | no | **20** |
| **right** | wrong | no | 40 |
| right | right | yes | 2 |

**It overturned on 0 of the 20 cases where overturning would have paid, and on 8 of the 40 where it
could not pay.** Ten flips, of which two were on cases both answers got right and eight on cases
neither did — a net gain of exactly zero. The other extreme is negative too: pricing "adopt it
whenever it disagrees" off this artifact gives **921, twenty cases below the arm (−1.31pp)**.

**Why no question converts.** The bought opinion is right on **21.6%** of the disagreements (22 of
102) against the incumbent's **41.2%** (42 of 102). A judge asked "which of these two answers the
question" prefers the incumbent because the incumbent is *better*, and it is better by a factor of
two. This is not position bias; it is **prior dominance**, and it is the same shape the 4-way reading
produced last round (27 against 38/38/37).

**So the route closes, and the gap moves above the ceiling.** Three selector shapes — four-way,
pairwise, adopt-everything — converted **≈0** across two hundred disagreement cases while each of
them raised the ceiling by **+22 to +27**. The pool's own ceiling on this run is **1,056 / 1,532 =
68.93%**, and CHASE-SQL's **end-to-end** number is **76.02%**: *a perfect selector over this candidate
set lands 7.1pp below the competitor.* The selection side has +1.31pp of headroom left; the gap is
7.1pp before selection starts. `I-77` and the candidate side close negative, and the next lever has to
raise the ceiling — with the ceiling as its criterion (**≥ +4pp**), not the score.

### The lever that raises the ceiling, and the instrument that had no guard (I-83)

Three readings have now closed the candidate side: the fourth opinion raised the ceiling by 22 to 27
cases and converted none of them (`I-77`), the pairwise comparison overturned zero of the twenty
cases where overturning would have paid, and three prompts carried **1.12** distinct results a case
against **1.15** for three samples of one prompt (`I-74`). The pool's own ceiling on the last dev run
is **68.93%** and CHASE-SQL's *end-to-end* number is **76.02%**, so a perfect selector over this
candidate set lands 7.1pp below the competitor. **The next lever has to raise the ceiling**, and its
criterion has to be the ceiling.

The mechanism is the one component of CHASE-SQL's pipeline this repository has never stacked:
**instance-aware worked examples**. `inline+icl` retrieves neighbours from BIRD's training split and
puts their statements in the prompt *instead of* the dataset's per-question hint, which priced
retrieval as a replacement (41-42% on Mini-Dev); `metadata+evidence+icl` puts the same block *on top
of* the hint, which is the configuration their paper describes and the only one whose gain can show
up as a higher ceiling rather than a reshuffled prompt.

**The lever had no guard, and that is a finding in its own right.** `demonstrations` is the last
mechanism in the table that acts at runtime without one: an arm that declares it and receives no
block — no neighbour carrying a statement, the renderer's budget eaten by its first example, a run
that built nothing — published as "the prompt with worked examples scored X". The block is now
counted per case (`examples`), refused at zero on any bank of a hundred cases, and published as a
funnel `{cases, blocks, examples}` beside the accuracy. A funnel and not a total, because the block
is retrieved per question: an arm whose neighbours landed on a third of the split is a blend of two
prompts, and its accuracy is a number about neither.

**The criteria, written before the dispatch (dev, 1,532 questions).**

1. **`metadata+evidence+icl` ≥ `metadata+evidence` + 4.0pp** — 61.03% → **≥ 65.03%**, a paired
   McNemar over the same questions. This is the ceiling criterion, and it is the one that decides
   whether retrieval is worth 8.5 GB of archive.
2. **The block lands**: `demonstrations.blocks / cases ≥ 0.50` and `examples` published. A gain with
   the block on a tenth of the split is a gain on a tenth of the split.
3. **No new calls and a bounded prompt**: `calls.mean = 1.00` exactly, and **≤ +40% prompt tokens**
   against the parent. Three worked examples are 600-2,200 characters; a +4pp that costs +80% of the
   prompt is a different product.
4. **The falsifier**: if the gain is **< +1.0pp**, retrieval-based knowledge is closed as a lever on
   this pipeline and the next mechanism must *synthesise* the examples with the model rather than
   retrieve them — CHASE-SQL's generator, not its retriever. That is a different arm with a
   different cost, and saying so now is what stops a second retrieval arm from being tried instead.

**Why the fetch is conditional.** The training split is an 8.5 GB archive of which only `train.json`
(4.2 MB) is kept, and 95% of dev dispatches never read it. `bench:bird:needs-train` resolves
`BIRD_ARMS` with the same function the runner uses and answers `yes`/`no`, so an arm that reads the
split is fetched for **by being declared** rather than by someone editing a YAML condition — the same
rule that keeps `DEV_ARMS` and the baseline from becoming two opinions.

**The reading (`41584873572`, dev 1,532).** `metadata+evidence` **937 = 61.16%**, `metadata+evidence+icl`
**951 = 62.08%** — **+0.91pp**, 76 up and 62 down, exact McNemar **p = 0.2684**. Criterion ① **fails**:
+4.0pp needed a net 61 cases and the net is 14, and it is not merely missed — the 95% interval on the
difference is **[−0.59, +2.41]pp**, whose upper bound is 2.4pp, so a four-point effect is *excluded*
rather than unresolved. ② **passes**: the block landed on **1,522 of 1,532 cases (99.3%)** with 4,553
examples (2.99 a case) and the ten cases without a block score **8 against 8**, an accidental control.
③ **passes**: `calls.mean` is exactly **1.00** and prompt tokens go 1,778 → 2,184 (**+22.8%**). ④ fires
as registered: below +1.0pp closes retrieval-based knowledge as a lever.

**What the block actually did, and it is not what the lever was bought for.** The failure classes move
in opposite directions:

| class | `metadata+evidence` | `…+icl` | change |
|---|---|---|---|
| column-count | 136 | **106** | **−30** |
| values | 444 | 452 | +8 |
| execution errors | 15 | 23 | +8 |

**The examples teach output shape and leak identifiers.** Thirty cases stop failing on the number of
columns — the largest single-class movement any prompt lever has produced here — and sixteen cases get
worse in exchange. Fifteen of the twenty-three execution errors are new, and they are all of two kinds:
`no such column: APTT`, `T-BIL`, `SC170`, `expense.link_to_event`, `T1.alignment`, `T3.time`,
`T1.Diagnosis` — identifiers that belong to *other* databases' schemas — and `no such function: YEAR`,
`MONTH`, `DATEDIFF` — functions that belong to the dialect the training split was written in. The
parent, given the same question and the same hint, ran those statements. The block is the only new
text in the prompt, and `retrieval.ts` predicted exactly this in the comment it has carried since the
arm was written: *a demonstration from another schema is useful as a shape and harmful as an
identifier source*. It is now measured rather than predicted.

**So the next lever is the one that removes the leak, not the one that adds more examples.** Mask the
schema-specific tokens in the demonstrations and canonicalise their dialect to the one under test —
DAIL-SQL's masked variant, which that comment already named as "a candidate lever once this one is
known". The registration, written here before the dispatch:

1. **`≥ +1.5pp` over `metadata+evidence+icl`** (≥ 23 net cases on 1,532) — recovering the 15 leaked
   statements while keeping most of the 30 shape wins lands at +30 net, so +1.5pp is the conservative
   half of what the mechanism can reach.
2. **`errors.execution` ≤ 16** against this run's 23, and no new `no such column` naming a table the
   schema does not hold.
3. **`column-count` ≤ 112** against 106, so the shape lesson survives the masking.
4. **`calls.mean = 1.00`, prompt tokens ≤ +25%** against this run's 2,184.

A gain below +1.0pp would say the shape lesson *depends* on the copied identifiers, which would be a
different and more interesting finding: that the block helps by giving the model column names from
somewhere rather than by showing it a shape.

### The mask, and what building it turned up (I-84)

`eval/bird/mask.ts` is two edits and one sentence. `maskIdentifiers` replaces every name that belongs
to another schema with `table_1`, `column_1`, …; `canonicaliseDialect` rewrites the MySQL and T-SQL
spellings into the dialect the harness executes; `MASKED_PREAMBLE` tells the model what a placeholder
is, because `table_1` is a valid table name and the cheapest thing to do with an example is copy it.

**What survives the mask is the part that transfers.** Keywords, functions, operators, numbers and
string literals are untouched; the names the statement binds itself — table aliases, column aliases,
cast types, CTEs — are kept, because they are not schema and because renaming one end of them
produces an example that does not run. So

```
SELECT T1.CustomerID FROM customers AS T1 JOIN yearmonth AS T2 ON T1.CustomerID = T2.CustomerID
WHERE T1.Segment = 'LAM' AND SUBSTR(T2.Date, 1, 4) = '2012'
```

becomes

```
SELECT T1.column_1 FROM table_1 AS T1 JOIN table_2 AS T2 ON T1.column_1 = T2.column_1
WHERE T1.column_2 = 'LAM' AND SUBSTR(T2.column_3, 1, 4) = '2012'
```

which still teaches the join, the direction, the aggregate and the date predicate, and names nothing
that the database under test would have to have. `CustomerID` is the *same* placeholder on both sides
of the equality, because the map is per statement: a mask that renumbered each occurrence would
destroy the one thing the example is there to show.

**Measured on Mini-Dev's 500 gold statements:** masking leaves **0 of them** carrying a word that is a
table or column name in its own schema. The four statements that still spell `date` are calling
SQLite's `date()` function, not reading the column of the same name.

**The placeholders cost 47 tokens a case** — the sentence, not the statements, which get shorter — inside
criterion ④'s +25% with room to spare.

**Four defects surfaced while building it, and every one is the same class: a rule that reads text
correctly until the text is a little less regular than the rule assumed.**

1. **A decimal point that ends a number is not a qualifier.** `select 1. from t` came out as
   `select 1. column_1 table_1`: `1.` was lexed as `1` plus a `.`, the dot became the qualifier of
   `from`, the keyword was masked as a column, and the table behind it as another one. SQLite accepts
   `1.` as a number, so the tokenizer now takes it as one — with a rule that a masker which reads
   punctuation as syntax has to get the lexical layer right first.
2. **`extract(year from d)` contains the word `from`.** The table scan read `d` as a table and gave it
   a `table_N` placeholder in a position where a column belongs. The scan now tracks which call each
   open parenthesis belongs to and skips a `from` inside `extract`, `trim`, `substring` and `position`
   — the four spellings in SQL that put one there.
3. **`with t as (` bound `t` at neither end.** The CTE check wanted a `select` behind the parenthesis,
   so a statement whose body is missing kept `t` at the definition and masked it at the reference —
   the exact inconsistency that makes a masked example fail to run. `name as (` is a CTE and nothing
   else in SQL is, so the body is no longer read.
4. **A keyword set cannot tell a time unit from a column.** `year` is `interval 30 day`'s neighbour, and
   `year` is also `formula_1.races`'s column, which Mini-Dev's gold statements read. Holding the units
   in the keyword set leaked that column on four statements; masking them produced examples that do not
   parse. The units are now kept only where the statement is using them as units — after a number or
   `interval`, or followed by `from` inside an `extract` parenthesis — and `select year from races` is
   masked like any other name.

**The arm is one lever, and the count is what makes it one.** `metadata+evidence+icl-masked` runs the
same retrieval, the same `k`, the same card and the *same number of examples* as
`metadata+evidence+icl`: a masked example is shorter, so the renderer's 2,200-character budget would
otherwise have fitted more of them, and the pair would differ in the number of examples as well as in
their text. The masked block is cut to the raw block's width for that reason.

The instrument the lever needs is a count, because the failure it can suffer is silent: a transform
that matches nothing sends the parent's prompt and reports the parent's accuracy as "masking does not
help". So `demonstrationsFunnel` publishes `rewritten` beside `examples`, `assertMaskingFired` refuses
a bank of a hundred cases in which the masker changed nothing, `assertReportComplete` refuses a masked
row whose funnel does not carry the number, and `assertMaskingRule` refuses at the declaration an arm
that names the mask and carries no examples.

**The dispatch** is `41599208436`: `metadata+evidence+icl,metadata+evidence+icl-masked` on dev, 1,532
questions, `deepseek-chat`, temperature 0. The parent is re-run in the same artifact so the delta is
paired case by case, on the same day, against the same endpoint — the reading against
`41584873572`'s parent would be a comparison across two runs, and this repository has already paid
for that lesson twice.

**The reading (`41599208436`, dev 1,532, both arms in one run).** `metadata+evidence+icl` **939 =
61.29%**, `metadata+evidence+icl-masked` **928 = 60.57%** — **−11 cases, −0.72pp**, 39 up and 50 down,
exact McNemar **p = 0.2891**. Criterion ① **fails**, with the sign the criteria did not expect;
② **fails** (`errors.execution` 30 against the 16 it needed, and the parent ran 27 in the same run);
③ **passes** (**105** wrong-width statements, the lowest any arm has recorded and seven below the
parent's 112); ④ **passes** (`calls.mean` 1.00, tokens 2,184 → 2,263 = **+3.6%**, which is the
preamble and nothing else).

**It is a real null rather than an inert lever.** `rewritten` is **4,553**, equal to `examples`; the
blocks landed on 1,522 of 1,532 cases in both arms and carried the same 4,553 examples. A Δ of ~0
after the instrument reads full is a reading about the mechanism; a Δ of ~0 with the instrument at
zero is a reading about the instrument.

**The mechanism verdict falsifies I-83's causal story.** The masked prompt contains, by construction,
no identifier from another schema and no foreign function — all 4,553 examples were rewritten — and
the execution errors went **27 → 30** anyway:

| kind | parent | masked |
|---|---|---|
| `no such function` | 8 | **8** |
| `no such column`, dotted (`T2.Diagnosis`, `e.link_to_event`) | 7 | **10** |
| `no such column`, bare (`APTT`, `SC170`) | 6 | 7 |
| other (`interrupted`, `near "order"`, `ambiguous`) | 6 | 5 |
| **same question as a parent failure** | — | **17 of 30** |

The function count is identical and the prompt does not contain `YEAR(`: **the model wrote it anyway.**
The column errors are `alias.column` pairs whose column exists in the schema and whose alias does not
own it — **binding errors**, not vocabulary. `I-83` inferred causation from the one thing that had
changed, and the control it lacked is exactly this arm. The block did not teach those errors; removing
every name from the block leaves them in place.

**Two further readings came for free.** The endpoint's run-to-run drift is **12 cases**: the same
configuration, temperature 0 and the same split put this parent at 939 where `41584873572` put it at
951 (−0.78pp), which is the scale on which `I-83`'s +0.91pp (p = 0.2684) and the 62.34/63.17 pair have
to be read. And `bench:bird:card`, `join` and `info` each printed `1532 unrenderable arm`: the two
most expensive arms in the catalogue cannot be priced by the three cheapest instruments, because the
artifact does not keep the block. That is a design question, not a defect, and it is recorded as one.

**The next lever.** Three readings in the same direction — +0.91pp, −0.72pp, both inside the drift —
close the demonstrations block, and every other information lever has already read null (`notes` −0.8,
`definitions`, `samples`, `values`, `audit` +1.01). The gap is in the **candidate ceiling**: the pool
reaches **68.93%**, `select-mixed` converts **90.4%** of it, and CHASE-SQL's end-to-end is **76.02%**
— **7.1pp of the 13.7pp is above what any selector could reach**. So the next dispatch is not a new
mechanism but a registered ceiling that was never run: `inline+evidence+samples-gold`, whose criteria
①②③ are written above, aimed at this run's census of **183 cases** (filter-wide 92, literal-missing
83, literal-case 8). If the oracle cannot reach +1.5pp, the `samples` family closes on criterion ①.

## The samples family closes: the oracle is worse than the block it was meant to justify

The previous section ended by naming the next dispatch rather than a mechanism: `inline+evidence`,
`inline+evidence+samples` and `inline+evidence+samples-gold` in one run, so the ceiling and both of
its comparators would be paired case by case. The criteria were written before the run. They are now
answered.

**One dispatch is missing from the record.** `41605217563` ran the same three arms and died on the
third: `185 of 1532 calls (12.1%) failed at the model … (first error: llm returned 503)`, above the
10% this harness treats as an outage, so `assertFailureRate` refused to publish an accuracy that
would have been a function of how busy the endpoint was. It is a real refusal and it produced no
reading at all — the artifact it uploaded is 3 KB. `41620796848` is the re-dispatch, and it is
successful.

**The reading (`41620796848`, dev 1,532, three arms in one run, `deepseek-chat`).**

| arm | passed | accuracy | vs `inline+evidence` |
|---|---|---|---|
| `inline+evidence` | 933 | **60.90%** | — |
| `inline+evidence+samples` | 952 | **62.14%** | **+1.24pp**, 61 up / 42 down, p = 0.0756 |
| `inline+evidence+samples-gold` | 944 | **61.62%** | **+0.72pp**, 36 up / 25 down, p = 0.2000 |

| criterion | threshold | measured | verdict |
|---|---|---|---|
| ① the ceiling is worth having | gold ≥ +1.5pp over the parent at p < 0.01 | **+0.72pp, p = 0.2000** | **fails** |
| ② the narrowing is not the loss | gold ≥ samples | **−0.52pp** (36 up / 44 down, p = 0.4340) | **fails** |
| ③ the block stays affordable | within 5% of the parent's characters | 2,568 → **2,586** (+0.7%) | passes |
| ④ the rule reaches cases | `empty` below the parent's `cases` | **1,021 of 1,532** empty, 644 columns | passes |

**Criterion ② is the one that decides the family, and the reason is in the funnel.** The oracle block
carries 644 columns and lands on **511** of 1,532 cases, because on 1,021 of them the gold statement
filters on no column this profiler keeps — there is nothing to narrow to. Where it lands it works:
**+1.76pp** (24 up, 15 down). Where it does not, **+0.20pp** (12 up, 10 down), which is the same case
count as noise. The wide sampler reaches **1,347** cases with **16,109** columns and reads +1.24pp
overall.

So the honest statement of what this family is worth is not "the columns were the cost" — it is the
opposite. **Knowing exactly which columns matter buys +1.76pp on the cases where the answer's own
statement filters on a profiled column, and that is a third of the split.** A rule that reaches the
other two thirds cannot know more than the wide block already shows, and the wide block's own reading
is +1.24pp. There is no room between +1.24 and +1.5 for a realizable column rule to occupy, which is
what criterion ① was written to detect.

**The family closes on ①, and the wide block does not close with it.** +1.24pp at p = 0.0756 on 1,532
cases is the largest single-call reading on dev since `notes`, and it is underpowered rather than
null: dev's MDE is 2.30pp, and 61 up against 42 down needs roughly 2,900 cases to clear p < 0.01 at
that effect size. What that licenses is **not** another sampler — the oracle just showed that no
column-selection rule can beat the wide block — but the wide block as a **candidate source**: a
fourth prompt in `select-mixed`, where it would have to raise the pool's 68.93% rather than convert it.
That is a new lever with its own criteria; it is not this one.

**Two runs of one arm differ by 33 cases, and that is now the largest number in this file.** The
`inline+evidence` arm scored **900 = 58.7%** on `41605217563` and **933 = 60.90%** on `41620796848`:
same arm, same split, same model, temperature 0, two hours apart. The earlier run was inside the
window in which the third arm lost 12.1% of its calls to 503s, so part of the gap is an outage that
this arm's own failure rate did not exceed and part of it is re-sampling; **the two cannot be
separated from the artifacts, because a failed call and a wrong answer are one row each.** That is
the whole argument for `bench:bird:drift`, below: 2.2pp of run-to-run movement is larger than every
delta this file has published this week, and until it is measured per case and split by whether the
prompt changed, every reading here is a reading with an unstated error bar.

## An instrument for the number that was being assumed: `bench:bird:drift`

Everything above reads a *within-run* pair, because a cross-run pair is two samples of an endpoint.
That rule was arrived at by observation, twice, and it has never had a measurement behind it: the A/A
jitter of ±0.67pp in the earlier sections is quoted from a pair of runs on a different split, and the
12-case and 33-case differences above are the same phenomenon at two scales.

`pnpm bench:bird:drift <left.json> <right.json> [--arm <name>] [--strict]` is the measurement. It
reads two artifacts, pairs them case by case on the shared arms, and publishes four things per arm:
the move, the discordant pairs with exact McNemar, how often one case changed its verdict, and — the
part that makes the rest readable — **whether the prompt was the same**.

The distinction is the instrument's whole point:

| prompt in the two runs | what a flipped verdict means |
|---|---|
| identical (`prompt` tokens **and** `chars`) | the endpoint re-sampled. This is the noise floor. |
| different | something on this side changed, and the pair is not an A/A |
| absent in one artifact | nothing. The flip cannot be attributed, and the row says so. |

Both numbers are compared, not one: a token count is the tokenizer's view and a character count is
the prompt's, and the run above shows why that matters — **every prompt token was identical on all
1,532 cases of `metadata+evidence+icl` across two runs**, while 42 statements changed. A tool that
compared only tokens would have called that pair a pure endpoint effect; it is, but only because the
characters agreed too.

Four refusals keep the pair from being read as something it is not: a file compared with itself, two
splits, two artifacts with no arm in common, and an artifact that carries a case twice. Three
*problems* — printed, and fatal under `--strict`, not refusing — name the pairs that can be compared
but whose disagreement has a cause other than drift: a different model, a different judge, a different
dialect, prompts that moved, or prompt sizes one side never recorded.

The tool is offline and costs no call. It is registered in the same file as the readings it makes
defensible, and like every other instrument here it has its own suite: 33 cases, four dimensions at
98.85 / 98.85 / 100.00 / 99.00, including one that runs it as a script, because a guard that never
fires is a CLI nobody has run.

**The same instrument ran on this artifact, and it moved two buckets.** `bench:bird:gap:values` on
`inline+evidence+samples` reads `filter-wide` **99**, `predicate` **84**, `literal-missing` **74**,
`filter-narrow` **71**, `tables` **69**, `aggregate` **20**, `projection` **12**, `literal-case`
**11**, `window` **2**, `grain` and `scale` **0** — and `bench:bird:conditions` reads **235 = 39.2%**
of the failures carrying no condition on a column the gold filters. Against `I-84`'s census on
`metadata+evidence+icl` the literal bucket fell (83 → 74) and the condition buckets rose (wide 92 →
99, predicate 73 → 84). That is an arm-to-arm difference and not a controlled one — the two cards
differ in three places — but the direction is the one that matters for what comes next: **the block
moves a few literal misses and leaves the condition population untouched at ~41% of the bucket.**

## The third slot, priced before it is read

The closure above leaves one thing standing: the wide block is +1.24pp on its own, and a block that
good is either a source or it is nothing. It cannot be a column rule — the oracle showed that — so
the only place it can act is the candidate set. That makes it a question about a *slot*.

`select-mixed` holds three candidates: `inline+evidence`, `metadata+evidence`, and `values`. The third
one is the weakest purchase in the catalogue, and the arithmetic is not close: the value index builds
a block only when the question names a literal, so it is **empty on 933 of 1,532 dev questions
(60.9%)** and the third vote on those is a restatement of one of the other two. The sampled card
lands on **1,347 of 1,532 (87.9%)** and is the largest single-call reading this split has produced
since `notes`.

`select-samples` is that swap and nothing else: the same two prompts, the same three candidates, the
same four calls, the third slot given to `inline+evidence+samples` instead of to the value index.
`changedLevers` reports exactly one field, `mixed`, which is the pair's whole claim.

**The criteria, written before the run** — `41638466376`, `bird-dev`, both arms in one artifact:

| criterion | threshold | what it decides |
|---|---|---|
| ① the slot is worth a decision | `select-samples` ≥ `select-mixed` **+1.0pp** | a swap that moves less than a point is a preference, not a lever |
| ② the third candidate is not a restatement | the sampled source is **sole-correct on ≥ 36 cases** (dev's MDE) beyond the other two sources | a source that is never the only right answer cannot move the ceiling, whatever its own arm scores |
| ③ the cost is a swap and not a purchase | `calls.mean` **4.00** on both arms | a third opinion bought with a fifth call is a different question |
| ④ the block is still the block | `sampleBlock.withValues` ≥ 1,300 in the new arm | the arm must carry the block on the cases its own source reached, or the swap silently reverted to the parent |

Criterion ② is the one that matters and the one a score cannot express. A candidate set is only worth
what its union covers; if the sampled card is right on cases the other two are also right on, the
score can still rise through selection while the ceiling — the thing that stands between this
repository's 68.93% and CHASE-SQL's 76.02% — does not move at all. `bench:bird:pool` reads that
directly, with no call spent, from the same artifact.

## The third slot's first dispatch returned a defect instead of a reading

`41644040097` ran `select-mixed,select-samples` on dev and stopped in the first step that reads the
split, before a single call:

```
Error: arm select-samples builds no question with 3 distinct prompts from inline+evidence,
metadata+evidence, inline+evidence+samples; it would pay 3 times for one opinion on every case
```

The guard is `assertMixedFeasible`, and it was right. Three defects had to line up for it to say so
on all 1,532 cases rather than on the one question where the third source has nothing to add.

**One: the block loaders asked the wrong population.** The sampled block is built only when an arm
asks for it — `settings.arms.some((name) => resolveArm(name)?.samples === 'profile')` — and a mixed
arm names its sources in `mixed`, never in the arm list. `select-samples` itself declares no sampler;
its third source does. So `sampleValues` stayed empty, `withSamples` returned the card unchanged, and
the third prompt was a byte-for-byte copy of the first. The same question was being asked of
`BIRD_ARMS` by four other loaders — the example sampler, worked examples, synthesized definitions,
and the training-split fetch in the workflow — so the defect was one expression written five times,
each copy wrong in the same way.

**Two: the run built one card and printed every candidate on it.** `cardFor(arm, …)` was called once
per case with the *arm*, and every source was asked with that schema. `select-mixed` therefore sent
`metadata+evidence` — which in its own arm carries descriptions as a separate block and lists joins
under each table — on the inline card, where both differences vanish: the two prompts came out at
**508 characters each, identical**. The arm's own doc comment says it draws "three candidates from
three decompositions"; it drew two prompts and one restatement.

**Three: the guard measured a prompt nobody sent.** `distinctShare` built each prompt with
`schemaFor(sourceArm)`, which is the card the source's own arm sends — so it reported three distinct
prompts for `select-mixed` while the run sent two. The number in every artifact's
`mixedCandidatePrompts.withAllDistinct` was therefore an upper bound on the arm's diversity, not a
measurement of it, and the row that said `degenerate: 0` was describing a comparison that never
happened.

**What this costs the published table.** `select-mixed`'s **62.34%** was measured under one-card
semantics: two distinct prompts (the value index adds a third only on the 599 questions that name a
stored literal) and three votes. `select-mixed` is now a genuinely three-prompt arm, and a score from
it is a score for a different configuration. It is not comparable to the old one across runs — that
is what the 33-case drift in the previous section already forbids — so the re-dispatch measures the
corrected arm and `select-samples` in one artifact, and the number it produces replaces 62.34% as the
baseline rather than being compared to it.

**The fix is three lines of meaning and one of structure.** A candidate is sent on its source's card
(`schemaForSource`), `distinctShare` calls the same function, and `armsInEffect` answers "which arms
does this run read" once — the arm list plus every source, each arm once — for all five loaders and
for `armsNeedRetrieval`. A mixed arm also publishes a `sampleBlock` now: the block rides on one
candidate, so the arm's own card has none, and the funnel counts the widest candidate's bracket per
case. That is the number criterion ④ was written to read.

**The criteria do not move.** They were registered before the dispatch and the dispatch did not
produce a reading, so they stand: ① `select-samples` ≥ `select-mixed` + 1.0pp, ② the sampled source
sole-correct on ≥ 36 cases beyond the other two, ③ `calls.mean` 4.00 on both arms, ④
`sampleBlock.withValues` ≥ 1,300 in the new arm.

**A cheaper question was available and was not taken.** The one-card semantics could be kept as a
control arm (`card: 'parent'`) so the fix's contribution could be priced in the same artifact. It
costs 6,132 calls and the regression rule says a change that costs accuracy must be reverted on
evidence — but it is only worth buying if the corrected arm loses. The re-dispatch answers that
first: if the corrected `select-mixed` is within drift of the two-prompt version's neighbourhood, the
control is a curiosity; if it is not, the control is the next dispatch and the fix is priced rather
than asserted.

## The third slot answers its question, and the answer is that the slot does not matter

`41673950028` is the re-dispatch on the fixed code — one artifact, dev's 1,532 cases, two arms,
`deepseek-chat`. It is the first reading in this file where every candidate is the prompt its own
source sends.

| arm | passed | accuracy | calls.mean | recall@3 |
|---|---|---|---|---|
| `select-mixed` (three real prompts) | 958 | **62.53%** | 3.992 | 67.17% |
| `select-samples` (third slot sampled) | **969** | **63.25%** | 3.993 | **67.75%** |

**+0.72pp, 30 up / 19 down, exact McNemar p = 0.1524.**

| criterion | threshold | measured | verdict |
|---|---|---|---|
| ① the slot is worth a decision | ≥ **+1.0pp** | **+0.72pp**, p = 0.1524 | **fails** |
| ② the third candidate is not a restatement | sampled source sole-correct on ≥ **36** cases | **32** | **fails** |
| ③ the cost is a swap and not a purchase | `calls.mean` **4.00** both | 3.992 / 3.993 | passes |
| ④ the block is still the block | `sampleBlock.withValues` ≥ **1,300** | **1,347**, 16,109 columns | passes |

**The two criteria that fail are the two that decide it.** Criterion ① was written to separate a
lever from a preference, and +0.72pp at p = 0.15 is a preference: it is inside the 33-case run-to-run
drift this file spent a section on. Criterion ② is the one a score cannot express, and it fails in
the same direction — the sampled source is the only right answer on 32 cases, against the 36 that dev
needs before a source can move the ceiling.

**Where the three opinions are actually worth something.**

| arm | `inline+evidence` | `metadata+evidence` | third source |
|---|---|---|---|
| `select-mixed` | 15 | **63** | `values` **17** |
| `select-samples` | 15 | 43 | `inline+evidence+samples` **32** |

Two things fall out of that table. The first is that **`values` is the weakest purchase in the
catalogue** — 17 cases where it is the only correct candidate, against `metadata+evidence`'s 63. The
second is that replacing it with a source worth almost twice as many sole-correct cases (32 against
17) buys **+0.58pp of pool ceiling** (67.17 → 67.75) and +0.72pp of score. Both are real, both are
smaller than the instrument that reads them.

**What the corrected card did to `select-mixed`, and what it did not.** The fix in the previous
section made the trio three genuinely different prompts — `metadata+evidence` now arrives with its
descriptions as a block and its joins listed, instead of as a byte-for-byte copy of
`inline+evidence`. The arm scored **958 = 62.53%**; under the one-card semantics it scored
**955 = 62.34%**. The two are three cases apart — a comparison across runs, which the drift above
forbids reading as a delta, so it is a neighbourhood and not a measurement — and it is the cleanest
negative this line of work has produced: **prompt diversity was not the binding constraint
either.** Making the candidate set more diverse did not move a set that the selector converts at
90.4%.

**The bill.** One of the three calls now carries the bracketed card, and that card measured +43.8%
characters on its own arm — so `select-samples` costs roughly **+15% prompt characters** over its
parent for **+0.72pp at p = 0.15**. The artifact does not print that number: it reports 2,568 mean
characters for both arms, because the cost column read the *arm's* card rather than the widest
candidate's. That is a defect in the instrument, found by this reading, fixed in the same round —
`promptChars` now takes the maximum over the candidates a mixed arm sends, which is what the model
actually read.

**Verdict.** Criterion ① fails, so the swap is a preference and `values` keeps the slot. The
`samples` family closes twice over — as a **column rule** (§71.4: the oracle lost to the heuristic)
and now as a **candidate source** (32 sole-correct against a 36 threshold). Nothing in this family
is worth another dispatch.

**What is left is the ceiling, and both arms say so.** `recall@3` is 67.17% and 67.75%: the pool
itself is what stands between 62–63% and CHASE-SQL's 76.02%, and a third source worth 32 sole-correct
cases moved it by 0.58pp. A source that could move it by 2pp would have to be right on ~150 cases the
other two miss. That is the number the next lever has to be designed against, and it is why the IR
candidate is the only item in P1 that can change the ceiling rather than redistribute it.

## The fourth candidate is a grammar, and the ceiling is the only number it can move

The last three rounds closed the third slot twice and the selector four times. What is left is a
number with a ceiling on it: `select-mixed` answers **62.53%** and reaches **67.17%** (`recall@3`,
1,029 of 1,532), `select-samples` reaches 67.75%; the best published system on this split is at
76.02%. Nine tenths of the selection side is spent (93.4% conversion), so the only lever that can
still move the score is a candidate nobody wrote — and a fourth candidate raises the ceiling without
touching the conversion.

**The arithmetic, corrected.** An earlier section on this page says a source worth 2pp "would have to
be right on ~150 cases the other two miss". That is wrong by a factor of five: 2pp of 1,532 is **31
cases**, and 150 is what closing the whole candidate-side gap (8.27pp) would take. Both numbers are
useful and they are not the same number, so the pre-registration below is written against 31: a
source that is sole-correct on 31 cases the trio misses takes the ceiling from 67.75% to 69.75%. It
is a large ask — `values` is sole-correct on **17** and the sampled card on **32** — and it is the
only ask on the board.

**Why a grammar rather than another prompt.** Every lever this repository has priced changes what the
model *knows* when it writes: the card, the evidence, the definitions, the worked examples, the
literals. Every one of them has been worth between −0.1 and +2.8pp, and the pool still fails to
contain an answer on 32% of the split. A large part of that is not knowledge: it is text. The
diagnostics name the classes — `filter-wide` 99, `predicate` 84, `literal-missing` 74,
`filter-narrow` 71, `tables` 69, `literal-case` 11 out of 600 compared conditions — and of those,
the last is purely a spelling, while the join-shaped and alias-shaped failures are pure layout. A
model that *describes* a query cannot write any of them.

So the fourth source answers with a JSON object, and `renderIntent` writes the statement:
`from`, `joins` as `{table, on: [{left, right}]}`, `select` as expressions with optional aliases,
`where` and `having` as `(column, op, value)` triples, `groupBy`, `orderBy`, `limit`, `distinct`. Ten
keys, one function set, seventeen refusal names. Three rules keep the closed grammar from being
merely small:

| rule | why it is the rule |
|---|---|
| identifiers are **checked, then quoted when the spelling needs it** (a control character, a semicolon or a comment marker is refused; everything else is rendered bare or double-quoted) | the corpus does not spell every column with word characters: `County Name` and `Charter School (Y/N)` are 4.6% of the columns in BIRD's own databases, and a bare-word lexer cannot name them at all. Quoting is then what makes the schema load-bearing — SQLite reads a double-quoted token that names no column as a *string literal*, so the compiler takes the column list and refuses `unknown-identifier` |
| literals are rendered from **values** | a string is quoted here and its quotes doubled, an integer stays an integer, `true` is `1`; the `literal-case` and `literal-missing` classes cannot survive that |
| expressions are **parsed** against a closed grammar | an expression is the one string in the contract where injection could hide; it renders in one canonical form, so two descriptions that mean the same thing produce the same text |

**The refusals are the instrument.** Seventeen names, and they split into two families with opposite
fixes: `no-object` and `not-json` say the format instruction was not followed (a prompt problem),
while `unsupported-function`, `bad-identifier`, `unknown-identifier`, `bad-expression`, `missing-from`
and the rest say the vocabulary could not express the question (a grammar decision). Over a split, the
histogram **is** the ordered list of what to add next, which is a question no amount of reading SQL can
answer. A refusal is therefore a reading and not a defect: the only state the harness refuses to
publish is the one where *nothing* renders, and `assertIntentFired` says so in two separate sentences —
never asked (a wiring break) and never rendered (a format break).

**What the first probe changed, and why a name was not enough.** `41748908122` ran 40 dev questions:
the source rendered **30 of 40 = 75%** and refused ten, which put criterion ③ exactly at its floor, and
the names split `bad-expression` 5, `bad-identifier` 2, `bad-operator` 2, `bad-value` 1. Ten refusals
in five names is a ranking and not a decision — "the grammar has no `case`" and "the model writes
`median`" are a week of work each, in opposite directions, and the histogram cannot tell them apart.
So the funnel now keeps the first three refusals of each name with the compiler's own sentence and the
case they came from, and that is what turned those numbers into four grammar additions in one round:
searched and simple `case` (five of the ten), comparisons, `||`, and `between`. The second probe — 120
questions, same model — renders **91 of 120 = 75.8%** and splits `bad-identifier` 14, `bad-operator` 5,
`bad-expression` 4, `bad-value` 3, `unexpected-value` 2, `unsupported-function` 1. The largest bucket
moved from `bad-expression` to `bad-identifier`, and 4.6% of the columns in the benchmark's databases
cannot be written as a bare word: that is the reading that produced quoting and the schema check, not
a wider expression grammar.

**What the arm is, exactly.** `select-intent` = `['inline+evidence', 'metadata+evidence', 'values',
'intent']`: the shipped trio plus one more candidate, at four generations and one selection per case
rather than three and one. The prompt is **not** rebuilt — the arm's own notes gain one rule line, so
the card, the evidence and the shape notes stay byte-identical to `inline+evidence`'s and an
end-to-end scenario asserts that removing the line gives the parent prompt back byte for byte. The arm
cannot be dispatched alone: `assertIntentRule` refuses it, because a JSON reply read by the statement
reader would publish a wiring mistake as a weak prompt.

**Pre-registration** (written before the dispatch, on dev's 1,532 cases, `deepseek-chat`):

| # | criterion | bar | why this bar |
|---|---|---|---|
| ① | pool ceiling of `select-intent` minus `select-mixed`'s, **same run** | **≥ +2.0pp** (≥ 31 sole-correct cases beyond the trio) | a fourth candidate can only raise the ceiling, so the ceiling decides whether the vocabulary is a lever; the score cannot (MDE 2.30pp) |
| ② | conversion rate | **≥ 91.4%** (drop ≤ 2pp from 93.4%) | four candidates and a selector that reads four: the price is paid in selection, and a lever that buys ceiling by making selection harder has not been priced yet |
| ③ | the intent source's own conversion | **≥ 70%** of cases rendered | below that the vocabulary is rejecting the corpus rather than answering it, and the histogram says which construct |
| ④ | cost, published | `calls.mean` = 5.00, `promptChars` from the **widest** candidate | the corrected cost column, not the parent's card |
| ⑤ | sole-correct, published | as a number, against the 31 the bar implies and the 17/32 the two previous sources scored | the only number that says *which* cases the new source owns |

Fail ① ⇒ revert the lever and keep the instrument (the grammar survives as a refusal histogram,
which is what a negative reading leaves behind). Pass ① ⇒ the ceiling has moved for the first time
since `select-mixed`, and the next round prices `select-intent` as the arm to beat.

**What the 120-question probe says about criterion ①, and the defect it exposes in the criterion.**
Both arms reached a ceiling of **84 of 120 = 70.00%**; the intent source was sole-correct on **one**
case (`168`). Two cases were gained (`168`, `1160`) and two were lost (`1001`, `1325`) — inside the
source's own pool, which is impossible unless the other three candidates moved too. They did: an arm's
three sources are *sampled separately*, so `select-intent` is not `select-mixed` plus one candidate,
it is a different draw of three plus one. `I-74` had already measured the size of that: three prompts
of one prompt differ by enough to move a pool ceiling 1.49pp, which is larger than half the criterion.

So the honest reading of a same-run ceiling difference is "the fourth source plus a redraw", and the
criterion as written would credit the grammar with a resampling artefact in either direction. The
number that isolates the source is a conditional one, and the probe has it: of the 36 cases
`select-mixed` did not reach, the intent source rendered 24 and was right on **1** — 4.2%, against its
own 63.7% overall (58 of 91 rendered), which is the same 63-65% the three prompts score. A candidate
that is as good as its siblings and no better *on the cases its siblings missed* adds nothing to a
pool; it adds a fourth opinion to cases that already had three.

Sizing that against the bar: 31 sole-correct cases out of the ~490 dev cases the trio misses is 6.3%,
and 4.2% at n = 24 cannot separate 6.3% from 0 (the 95% interval runs from 0.1% to 21%). The verdict
therefore needs more cases, not a different argument — but the direction is now a measurement rather
than a guess, and the next dispatch is sized for it.

**The third probe, after quoting and the schema check** (`41760255264`, same 120 questions): rendering
**96 of 120 = 80.0%** against 75.8%, and the refusals are `unknown-identifier` **10**, `bad-operator`
7, `bad-expression` 4, `bad-value` 1, `unexpected-value` 1, `unsupported-function` 1. The ceiling
moved for the first time: **85 → 86**, one case gained (`879`), **none lost**, two sole-correct
(`879`, `1160`). A pool that only grows is what the construction promises, and the previous probe's
two lost cases were the redraw showing through — with them gone, +0.83pp is a reading rather than an
accounting artefact.

It is still short of the bar, and the conditional number says why: of the 35 cases `select-mixed`
missed, the source rendered 25 and was right on **1 = 4.0%** against the 6.3% the bar needs. Its own
accuracy rose to **66/95 = 69.5%**, above all three prompts (64.4 / 64.7 / 66.9) — a fourth opinion
that is slightly better than its siblings and no better *where they failed* is worth about a point of
ceiling and no more.

What the ten `unknown-identifier` refusals were then produced the next round's six changes, and they
were the contract's fault, not the model's: an operator written `IS NULL`, a `null` value on a nullary
operator, `x in 'a'`, a select alias looked up in the schema, an aggregate on the left of a `having`,
and `f."School Name"` read as a name plus a stray dot. Reading those sentences one at a time is what
the `detail` field was added for; the histogram alone would have said "`unknown-identifier` 10" and
stopped there.

**The fourth probe, after those six** (`41766758694`, same 120 questions): rendering **106 of 120 =
88.3%**, refusals down to 14 (`bad-expression` 6, `bad-value` 3, `unsupported-function` 2, and one
each of `bad-identifier`, `unknown-identifier`, `unknown-key`), ceiling **86 → 89** against 86 for
`select-mixed`, three cases gained (`75`, `168`, `617`), none lost, three sole-correct, and the
conditional density at **2 of 27 = 7.4%** against the 6.3% the bar needs.

| probe | rendering | ceiling Δ | sole-correct | conditional density |
|---|---|---|---|---|
| 40 questions, first grammar | 75.0% | — | — | — |
| 120, after `case`/comparisons/`\|\|`/`between` | 75.8% | 0.00pp | 1 | 4.2% (1/24) |
| 120, after quoting + schema check | 80.0% | +0.83pp | 2 | 4.0% (1/25) |
| 120, after six tolerances | **88.3%** | **+2.50pp** | **3** | **7.4% (2/27)** |

The density is the number that moved, and it moved with rendering: a grammar that refuses a quarter
of the replies has a quarter of its cases missing from the pool, so the conditional hit rate was
computed over fewer cases the worse the vocabulary was. That is worth stating plainly, because it
means the first two probes understated the source for a reason the histogram had already named.

**Pre-registration for the full split** (written before the dispatch, dev's 1,532 cases, two arms in
one artifact, `deepseek-chat`):

| # | criterion | bar | why this bar |
|---|---|---|---|
| ① | pool ceiling of `select-intent` minus `select-mixed`'s, **same run** | **≥ +2.0pp** (≥ 31 sole-correct) | the ceiling is the only number a fourth candidate can move, and 2pp is the smallest claim this project acts on |
| ② | conditional density on the cases `select-mixed` missed | **≥ 6.3%** (31 of ~490) | the arm-level delta carries a redraw; this one is computed on one source against one pool |
| ③ | the source's own rendering | **≥ 85%** | the probe reads 88.3%; below this the grammar is again refusing the corpus rather than answering it |
| ④ | cost | `calls.mean` = 5.00, `promptChars` from the widest candidate | the price is published, not inferred |
| ⑤ | conversion rate | **≥ 91.4%** | four candidates make selection harder, and that price has not been paid yet |

Pass ① and ② ⇒ the ceiling has moved for the first time since `select-mixed`, and the next round
prices `select-intent` as the arm to beat. Fail either ⇒ the grammar stays as product surface and as
an instrument, the lever is reverted, and the candidate side is declared closed to *homogeneous*
opinions — which is the reading the density has been pointing at since `I-74`.

### The full split: the ceiling moved, and selection ate it (`41767687844`)

dev's 1,532 cases, both arms in one artifact, `deepseek-chat`:

| | `select-mixed` | `select-intent` | delta |
|---|---|---|---|
| score | 962 = **62.79%** | 957 = **62.47%** | **−0.32pp** (29 up / 34 down, p = 0.6147) |
| pool ceiling | 1,024 = **66.84%** | 1,058 = **69.06%** | **+2.22pp** (41 up / 7 down, p < 0.0001) |
| conversion | **93.95%** | **90.45%** | **−3.50pp** |
| `calls.mean` | 3.994 | **4.999** | +1.005 |
| source rendering | — | **1,339/1,532 = 87.4%** | — |

| # | criterion | bar | read |
|---|---|---|---|
| ① | ceiling delta | ≥ +2.0pp | **pass**, +2.22pp, p < 0.0001 |
| ① | sole-correct, the same criterion's other half | ≥ 31 | **fail**, **28** |
| ② | conditional density | ≥ 6.3% | **pass**, 32 of 410 rendered = **7.80%** (32 of 508 misses = 6.30%) |
| ③ | source rendering | ≥ 85% | **pass**, 87.4% |
| ④ | cost | 5.00 calls | **pass**, 4.999 |
| ⑤ | conversion | ≥ 91.4% | **fail**, 90.45% |

**The ceiling moved, and it moved with p < 0.0001.** 41 cases gained against 7 lost is not a
resampling artefact: this is the first time since `select-mixed` that a lever has raised the pool's
ceiling, and it took four probes to get there because the first three were mostly measuring our own
vocabulary.

**And then selection ate it.** The score is −0.32pp with 29 up and 34 down (p = 0.6147) — the two
arms are the same number — because conversion fell 3.50pp. A fourth candidate raises the ceiling by
2.22pp and costs the selector 3.5pp, and the arithmetic is exact: at `select-mixed`'s conversion rate
this pool would score `1,058 × 0.9395 = 64.88%`, **+2.09pp**. That number is not a reading, it is what
the ceiling is worth to a selector that does not lose ground — and it is the next lever, priced before
it is built.

**Why the source's own accuracy dropped.** It reads 786 of 1,316 = **59.7%** on the full split against
65.4% on 120 questions, which is the same regression `I-85` saw across two runs of one arm: the probe's
120 cases are not a smaller copy of the split, they are the first 120. The lost 7 ceiling cases and the
28-not-31 sole-correct count both live in that difference.

**Verdict.** The lever is **adopted as a ceiling lever and not as a score lever**: `select-intent`
stays in the catalogue with `select-mixed` as the arm to beat on the pool question, and the next round
attacks conversion — a selector that reads four candidates as well as it reads three — because that is
now the only place the +2.22pp can be collected.

## Reading four candidates: the selector does not read them, agreement does

The previous round left one instruction: *attack conversion — a selector that reads four candidates
as well as it reads three*. Before spending another 7,660 calls on a new selector prompt, the
artifact that produced that instruction already holds every candidate's statement and result
fingerprint, so the question can be asked of the file.

`41767687844`, dev's 1,532 cases, both arms in one artifact. Every number below is computed from
those rows with `bench:bird:consensus` and with the two case fields it reads — `candidates[]` and
`passed` — and no model call.

### The loss is not in the choosing, it is in the agreeing

Partition the 1,532 questions by the fingerprints their candidates produced, and read what each
rule scored inside the partition. `sel` is the arm's own selector (one call), the other four columns
are free.

| fingerprint structure | cases | `sel` | `shortest` | `modal` | `first` | `oracle` |
|---|---|---|---|---|---|---|
| four agree (or the only candidate) | 906 | 75.9% | 75.9% | 75.9% | 75.9% | 75.9% |
| three agree, one differs | 260 | 45.4% | 42.7% | **46.9%** | 44.6% | 67.7% |
| three candidates agree | 161 | 53.4% | 53.4% | 53.4% | 53.4% | 53.4% |
| two pairs | 54 | 38.9% | **40.7%** | 31.5% | 31.5% | 64.8% |
| two agree, two singletons | 68 | 16.2% | **23.5%** | 17.6% | 16.2% | 44.1% |
| two agree | 47 | 42.6% | **44.7%** | 25.5% | 25.5% | 59.6% |
| one candidate | 15 | 46.7% | 46.7% | 46.7% | 46.7% | 46.7% |
| three or four singletons, no candidates, two agreeing candidates | 21 | 28.6% | 28.6% | 23.8% | 23.8% | 38.1% |

**The selector is never better than counting on a partition that disagrees.** On the 260 questions
with a 3+1 split it scores 45.4% against the modal result's 46.9%; on the 68 with a 2+1+1 split it
scores 16.2% against the shortest statement's 23.5%. The one place it is ahead is the 906 questions
where there is nothing to choose, and there it ties by construction — all five columns are the same
candidate.

**And 24.1% of that 906 is wrong.** 218 of the 906 questions have four candidates that agree and an
answer that is not the agreed result. No selection rule on any list reaches those: they are one
opinion counted four times, and the count is the disagreement the candidate side never produced.
Against the 474 questions the pool does not contain at all, this is the largest single block of
loss in the corpus — 14.2pp of the split — and it is a generation problem wearing a selection
problem's clothes.

### Where the conversion rate went

The fourth source's own accuracy is 786/1,316 = 59.7%, below the three prompts (61.9 / 62.1 /
62.0%), so a selector that treated it as a fourth equal opinion would lose a little. It does
something worse: on the 1,293 questions that actually carry four candidates, the selector's winner
is `inline+evidence` on 964 (74.6%), `metadata+evidence` on 120, `intent` on 110 and `values` on 99,
and the accuracy of those winners is 71.2%, 48.3%, **35.5%** and 55.6%.

So the loss is not "the model was fooled by a plausible-looking statement" in general — it is that
the 110 cases it took from the fourth source were wrong two times in three. Two hypotheses for why
were testable on the same rows, and both are now closed:

- **the short-statement preference.** The selection prompt's first rule tells the model not to
  choose by length, and a rendered statement is short and tidy. It is not what happened: `intent`
  was the shortest candidate on 258 questions and was chosen on 21 of them (8.1%), and it was not
  the shortest on 1,035 and was chosen on 89 (8.6%). The rate is the same, so the model was reading
  content, and reading it wrong.
- **a post-hoc ban.** Re-running the arm with "if the winner is `intent`, take the first candidate
  instead" gives 848 against 838 on those 1,293 questions — +10 cases, +0.65pp of the split. That is
  a rule fitted to this artifact, it has no mechanism behind it, and it is under a third of the
  split's 2.30pp resolution; it is published as an upper bound on what any source-prior rule could
  collect, not as a candidate.

### The fourth call is not conditional, either

A conditional dispatch — generate the fourth candidate only when the three prompts disagree — would
cut the intent call on the 1,058 of 1,293 questions (81.8%) whose three candidates already agree.
It also throws away 23 questions: on those the three agree, the fourth differs, and the fourth is
right. 23 cases is 1.5pp of ceiling for 0.82 calls a case, and the reverse condition (generate only
when they agree) is worse: it discards 66 correct answers.

So the price of the fourth call is 1.00 call a case with no condition that removes it, and the
benefit is a ceiling 2.22pp higher that the selector then gives back. Both halves are now measured
rather than argued.

### The rules on the whole split, and the one that beats the selector

`bench:bird:consensus` on the same artifact, 1,532 questions:

| arm | `first` | `shortest` | `modal` | `model` (the selector) | `oracle` |
|---|---|---|---|---|---|
| `select-mixed` | 61.36% | **62.86%** | 61.75% | 62.79% | 66.84% |
| `select-intent` | 61.49% | 62.47% | 61.95% | 62.47% | 69.06% |

Reading `shortest` inside the `select-intent` artifact but **only over the three generated
candidates** — the fourth source excluded from the ranking — scores **969/1,532 = 63.25%** with no
selection call at all: +0.78pp over the arm's selector and +0.46pp over the arm to beat. Eight
questions have no three-candidate set to rank and are counted as misses, so the number is a floor.

That is the only place in this corpus where a free rule beats a paid one by more than noise, and
even here the difference (0.78pp, 70 discordant cases one way and 58 the other) does not reach the
split's 2.30pp. It is reported as a direction, not as an adoption.

**Why the rule is now in the library and not only in the harness.** A measurement that says "the
fourth call buys less than this split can resolve" is worth nothing to a deployment that cannot
express the cheaper side. `chooseCandidateByRule(rule, executed)` takes `first`, `shortest` or
`modal` and returns the same decision shape the selector returns, with `decided` always true and no
generation spent. The three rules are the three columns above, so the instrument and the product
now price the same thing under the same names — and a test holds the harness's `pick` and the
library's rule to the same slot on the same rows, because two implementations of one rule that
drift are worse than one implementation nobody can check.

That test found a defect on its first run: `consensus.ts` ranked an empty statement as length zero,
so `shortest` picked the candidate that wrote nothing, while the library ranked it last. Neither
reading had been published against an artifact that carries an empty statement — the harness's own
`-1` for "no statement kept" made the case look handled — but the two rules disagreed, and the fix
is in the harness: a blank statement is not the minimal answer in either implementation.

### The verdict, and what is left

**Selection is closed at 93.95% conversion on three candidates and 90.45% on four.** Four levers
have now been measured on this axis (selector, pairwise, agreement marks, reconcile) and the fifth
(the fourth candidate) is the only one that ever moved the ceiling; the +2.22pp it added is
collectable only by a chooser that reads four as well as it reads three, and the partitions above
say the chooser reads four *worse*, because the extra candidate is a weaker opinion that wins 8.5%
of the cases and is wrong 64.5% of the time it wins.

The candidate side therefore remains the only axis with room, and the two numbers that bound it are
both on this page: **474 questions with no correct candidate**, of which **218 are four-way
agreement on a wrong answer**. A fifth homogeneous prompt cannot reach either. What can is a
candidate written by a model that reasons before it writes, which is the next pre-registration.

## A stronger author raises the ceiling and the conversion falls again

The partition above says a fifth homogeneous prompt cannot reach the 218 questions where four
candidates agree on a wrong answer. The next candidate therefore has to come from an author that
does not share the error, and the catalogue already had one: `select-balanced` draws two of its
three candidates from a second model. It had only ever been run on 600 questions with one reasoning
slot and a `glm-4.5` second endpoint; `41795505400` is the first run with **two** reasoning slots
and a second endpoint in the same vendor, so the comparison isolates the *model* rather than the
vendor.

dev, 600 questions, both arms in one artifact, `deepseek-chat` primary and `deepseek-reasoner`
second:

| | `select-mixed` | `select-balanced` | delta |
|---|---|---|---|
| score | 382 = **63.67%** | 372 = **62.00%** | **−1.67pp** (21 up / 31 down, p = 0.2116) |
| pool ceiling | 408 = **68.00%** | 425 = **70.83%** | **+2.83pp** (29 up / 12 down, **p = 0.0115**) |
| conversion | **93.63%** | **87.53%** | **−6.10pp** |
| `calls.mean` | 3.995 | 4.000 | — |
| `promptChars` | 7,302 / 14,554 | 7,302 / 14,554 | — |

| # | criterion | bar | read |
|---|---|---|---|
| ① | ceiling delta | ≥ +1.5pp | **pass**, +2.83pp, p = 0.0115 |
| ② | score | ≥ +1.0pp and paired p < 0.05 | **fail**, −1.67pp, p = 0.2116 |
| ③ | conversion | ≥ 88% | **fail**, 87.53% — 0.47pp short |
| ④ | cost published | 4.00 calls, widest candidate | **pass** |

### The author is worth more than its own accuracy

The reading that matters is not the ceiling: it is where the ceiling came from.

| arm | `inline+evidence` | `metadata+evidence` | `values` | pool ceiling |
|---|---|---|---|---|
| `select-mixed` (all `deepseek-chat`) | 374/594 = **63.0%** | 369/594 = **62.1%** | 377/595 = **63.4%** | 68.00% |
| `select-balanced` (two `deepseek-reasoner`) | 369/598 = **61.7%** | 358/599 = **59.8%** | 376/594 = **63.3%** | **70.83%** |

**Every reasoning slot is individually worse than the chat slot it replaced, and the pool is
better.** 61.7% and 59.8% against 63.0% and 62.1%, yet +2.83pp of ceiling at p = 0.0115. A weaker
candidate that is wrong on *different* questions is worth more than a stronger one that is wrong on
the same ones — which is the same arithmetic `I-74` produced in the other direction, where three
prompts of one model carried no more independent opinions than three samples of one prompt (1.15
against 1.12 distinct results). **Changing the author buys independence; changing the wording does
not.** That is now measured twice, once per direction.

### And the selection side eats it, for the third time

| configuration | candidates | conversion | score |
|---|---|---|---|
| `select-mixed` | 3 chat | **93.63%** | 63.67% |
| `select-intent` (1,532 questions) | 4 chat | **90.45%** | 62.47% |
| `select-balanced` | 2 reasoning + 1 chat | **87.53%** | 62.00% |

Three configurations, three conversions, one direction: **the more the candidate set is worth, the
less of it the selector converts.** The mechanism is in the partitions above — a stronger pool has
more questions where every candidate is right and more where several look right, and the selector
was never better than counting on a disagreeing partition.

### The free rule on the strong pool, and what it is worth

Read from the same artifact, no model call:

| arm | `first` | `shortest` | `modal` | selector | ceiling |
|---|---|---|---|---|---|
| `select-mixed` | 375 = 62.50% | 372 = 62.00% | 377 = 62.83% | **382 = 63.67%** | 68.00% |
| `select-balanced` | 370 = 61.67% | **384 = 64.00%** | 375 = 62.50% | 372 = 62.00% | 70.83% |

`shortest` beats the selector by **+12 cases (38 up / 26 down, p = 0.1686)** on the strong pool and
loses to it by 10 on the weak one (14 up / 24 down, p = 0.1433) — the two rules trade places with
the pool and neither difference is significant. What is not a trade is the price: the rule is
**3.00 calls against 4.00**, which is 25% of the run, and it produces the best score any
configuration in this document has reached, **64.00%**, against the 63.67% of the arm to beat — a
difference of two cases.

So the free rule is not adopted as a lever either. It is the *cheapest configuration that scores
what the expensive one scores*, which is what `chooseCandidateByRule` exists to let a deployment
choose — and the fact that the best number on this page comes from spending one call fewer is the
clearest statement yet that the second call was never the thing being bought.

### Verdict

**The strong-model lever is a ceiling lever and not a score lever** — the same verdict
`select-intent` received, with a larger ceiling (+2.83pp) and a larger conversion loss (−6.10pp).
`select-balanced` stays in the catalogue; `select-mixed` stays the arm to beat on the score, and its
68.00% ceiling is now the *lower* of two pools on the same questions.

The conversion rate is the structural bottleneck, and it is now measured as a function of the pool:
93.63 → 90.45 → 87.53 as the candidates improve. No candidate-side lever can be collected until
something converts a better pool better, and three rounds of selector work (prompt, marks,
reconcile, pairwise) have not moved it.

One workflow defect was fixed to get this reading. The first dispatch (`41791956315`) sent a valid
DeepSeek key to Zhipu's endpoint, because `second_provider` chose the secret while `second_base_url`
kept an independent default: preflight answered `401 令牌已过期或验证不正确` and the run never reached a
question. The endpoint is now derived from the provider and the overriding input starts empty, so the
pair cannot disagree unless the caller spells both; two tests read the workflow and fail on the old
wiring.

## Execution is decidable; text is not

The partition table left one number standing: 218 of 906 four-way-agreeing questions are wrong.
94% of the candidates in this corpus ran, so the disagreement the pool never produced is not a
disagreement about *whether the statement is well formed* — it is about what the statement
returned. That suggests a signal no rule has used yet, and unlike every text-level rule in this
document it is not an opinion about SQL: **a candidate that returned nothing answered nothing.**

### The one thing a candidate set can rule out without reading it

Every arm's artifact keeps a result fingerprint per candidate, and `resultKey` of no rows is one
string, so the fingerprint of the empty result is a constant. Counting it costs nothing:

| arm | candidates | empty results | of which correct |
|---|---|---|---|
| `select-mixed`, 1,532 questions | 4,534 | **223** | **0** |
| `select-intent`, 1,532 questions | 5,846 | **287** | **0** |
| `select-mixed`, 600 questions | 1,783 | 87 | **0** |
| `select-balanced`, 600 questions | 1,791 | 76 | **0** |

**586 empty results and not one of them was right** — 510 from the two arms over the whole split,
and 76 more from the strong arm, which is the only arm in this document that was not already
counted. The reason is mechanical rather than statistical: a result set with no rows is equal to
another empty result and to nothing else, so for an empty candidate to be correct the true answer
would have to be empty — and no question in either artifact has an empty answer.

That makes the empty result the only member of a candidate set that can be removed before anything
is read. Every free rule now ranks the candidates that returned rows, and falls back to the whole
set when all of them are empty, so the rule stays total:

| arm | `first` | `shortest` | `modal` | selector | ceiling |
|---|---|---|---|---|---|
| `select-mixed`, 1,532 | 61.36 → **61.88%** | 62.86 → **63.64%** | 61.75 → **62.40%** | 62.79% | 66.84% |
| `select-intent`, 1,532 | 61.49 → **62.27%** | 62.47 → **63.51%** | 61.95 → **62.66%** | 62.47% | 69.06% |
| `select-mixed`, 600 | 62.50 → **63.33%** | 62.00 → **63.50%** | 62.83 → **64.00%** | 63.67% | 68.00% |
| `select-balanced`, 600 | 61.67 → **62.17%** | 64.00 → **65.17%** | 62.50 → **63.33%** | 62.00% | 70.83% |

Read the last row. On the strong pool `shortest` was 384 = 64.00% against the selector's 372, and
the difference did not resolve (p = 0.1686). With the empty results removed it is **391 = 65.17%**
against 372, **+3.17pp at p = 0.0163** — *the first call-free rule in this document that beats a
paid selector by more than the split resolves*, on 3.00 calls instead of 4.00.

It is also the highest score any configuration here has reached, and the conversion rate it implies
is **92.00%** of a 70.83% ceiling, against the 87.53% the selector got from the same pool.

### Two things this is not

**It is not a prior about shape.** The obvious generalisation — read the question, predict the
shape, keep the candidates that match — was tested on the 496 questions whose databases are in this
checkout, by executing every candidate against the real engine (zero model calls):

| constraint read from the question | candidates it rejects | of which wrong | precision |
|---|---|---|---|
| "how many / how much" ⇒ a number | 146 | 89 | **0.610** |
| "how many / what is the average …" ⇒ one row, one column | 28 | 18 | **0.643** |

Both are worse than a coin flip on the cases that matter. The reason is visible in the 496-question
alignment: 244 questions phrase the answer as a number and only 207 of them have a numeric gold
value, because "how many X have property Y" can be answered by a list and "what is the average …
of each school" is one row per school. **The question names what the answer *is about*, not what
the answer *looks like***, and every rule that reads shape out of wording inherits that error.

**It is not a selection fix either.** Of the 101 unanimous-but-wrong questions in the 496-question
subset, **52 (51.5%) produced the correct shape and the wrong values** — right width, right row
count, different numbers. No rule on a candidate list can reach those; they are arithmetic or
reasoning errors that were made four times identically. Only 15 (14.9%) were cases where every
candidate returned nothing, which is a value-retrieval failure wearing a selection failure's
clothes.

### What the empty result is actually telling us

Those 15 cases are the interesting ones, because a candidate set whose members all return nothing
is not a candidate set — it is a predicate that matched no row. That is a *repairable* state: the
statement ran, the engine accepted it, and the answer is empty because a literal or a join key
does not exist in the data. `values-gap`'s `filter-narrow` bucket is the same population counted
from the other side.

So the empty result earns two things. As a filter it is worth +12 cases on 1,532 questions and
+7 on the strong 600 — free, and now measured. As a **state** it marks the one failure the
pipeline can detect without a judge and repair without a guess, and that is the next lever: a
candidate that returns nothing should trigger a repair pass with the zero-row fact in hand, not be
voted on.

### Verdict

| item | reading |
|---|---|
| empty result ⇒ wrong | **586 / 586**, two artifacts, four arms |
| `shortest` without empty candidates, 1,532 | **975 = 63.64%**, +0.85pp over the selector, 3.00 calls |
| `shortest` without empty candidates, strong 600 | **391 = 65.17%**, **+3.17pp, p = 0.0163**, 3.00 calls |
| text-derived shape constraints | **rejected**, precision 0.61 / 0.64 |
| unanimous-and-wrong, shape correct | 52 of 101 — not reachable by any rule |
| unanimous-and-wrong, all candidates empty | 15 of 101 — a repair target, not a selection target |

The rule is adopted. The generalisation is not. And the fourth call is now losing to a rule that
costs three on the arm whose candidates are worth the most, which is the first time the arithmetic
of "selection is closed" has been contradicted by a reading rather than by an argument.

### The zero-row state, priced before it is built

If the empty result earns its place as a filter, the state it marks is worth pricing before
anything is built for it. On the 496 questions whose databases are in this checkout — every
candidate executed against the real engine, zero model calls:

| population | questions | share | selector passed |
|---|---|---|---|
| every candidate returned nothing | **19** | **3.83%** | **0** |
| some candidate returned nothing | 15 | 3.02% | 8 |

Nineteen questions where the whole candidate set is empty, and the selector is right on none of
them. Extrapolated to 1,532, that is about **59 questions = 3.85pp** — the ceiling of a repair that
always succeeds, and the largest single deterministically-detectable loss left in the pipeline.

The cost is as bounded as the benefit: a repair triggered only on the zero-row state spends one
extra call on 3.83% of cases, which is 0.038 calls a case — against the 1.00 call a case the fourth
candidate costs and never recovers.

That makes the next pre-registration unusually cheap to state:

1. **Trigger.** Every candidate returned no rows. Deterministic, needs no judge, and is false on
   96.2% of the corpus, so it cannot disturb anything that already works.
2. **Action.** One rewrite with the zero-row fact, the statement's own literals, and the values
   that do exist for those columns — the diagnosis `values-gap` names `literal-missing` and
   `literal-case` is exactly the repair.
3. **Bar.** Correct on ≥ 25% of the triggered questions, i.e. ≥ +0.96pp on the full split, with
   no change on the 96.2% that never trigger. A repair that cannot clear that is a call spent for
   nothing, because the same 3.85pp is available to a filter that simply drops the state and
   reports it.
4. **Cost published.** `calls.mean` and `promptChars` for the triggered subset, so the 0.038 is
   measured rather than assumed.

This is the first lever in the document whose *trigger* is cheaper than its *action*, which is why
it is worth stating in this form: everything measured so far paid per case to maybe help a case,
and this pays per broken case only.

And the cause is locatable without a model. For each of the 19 zero-row questions, every string
literal its candidates wrote was looked up in every table of the database:

| cause | questions | share |
|---|---|---|
| a literal in the candidates does not exist anywhere in the database | **18** | **94.7%** |
| the literals exist, the combination matches nothing | 1 | 5.3% |

**Eighteen of nineteen wrote a value the database does not contain.** Not a predicate that is too
narrow — a value that is not there: `'Benalish Knight'` where the column holds
`Benalish Knight (Fellwar Stone)`, a date written differently, a name with different punctuation.
That is `literal-missing` and `literal-case` from `values-gap`, arriving here as the *cause of an
empty result* rather than as one bucket among many.

So the repair's first step costs nothing and does not need a model: take the literals the statement
used, find the ones the database does not contain, and retrieve the values that do exist for those
columns. A call is only needed when the retrieved values do not settle which one was meant — which
is a much narrower question than "rewrite this statement", and it is the reason this lever can be
priced at 0.038 calls a case rather than 1.00.

The pre-registration above therefore gains a step before its call, and the bar is unchanged
because the bar is about the outcome rather than the mechanism:

1. detect the zero-row state (free, deterministic);
2. locate the absent literals and retrieve the values the columns do hold (no model call, one
   query each — the same retrieval the `values` source already performs for the prompts, which is
   why "free" here means free of a call and not free of a round trip);
3. rewrite once with the zero-row fact and the retrieved values (one call, 3.83% of cases);
4. score against the same judge.

Steps 1 and 2 are the ones `values-gap` has been describing for thirty rounds. What is new is that
they are now the **cause of a detectable state** instead of a hypothesis about a wrong answer, and
a hypothesis can be argued with while a zero-row result cannot.

## The whole split, and the first time a free rule wins a full-split comparison

`41808092447` is the first run that carries both pools over all 1,532 questions with a second
endpoint in the same vendor (`deepseek-chat` primary, `deepseek-reasoner` second). Every previous
strong-model reading was on 600 questions, whose minimum detectable effect is about 3.6pp; this one
resolves the split's 1.63pp.

| | `select-mixed` | `select-balanced` | delta |
|---|---|---|---|
| score | 959 = **62.60%** | 941 = **61.42%** | −1.18pp (61 up / 79 down, p = 0.1505) |
| pool ceiling | 1,022 = **66.71%** | 1,055 = **68.86%** | **+2.15pp** (72 up / 39 down, **p = 0.0022**) |
| conversion | **93.84%** | **89.19%** | −4.65pp |
| `calls.mean` | 3.995 | 4.000 | — |

| # | criterion (registered before dispatch) | bar | read |
|---|---|---|---|
| ① | ceiling delta | ≥ +1.5pp | **pass**, +2.15pp, p = 0.0022 |
| ② | score | ≥ +1.0pp and paired p < 0.05 | **fail**, −1.18pp |
| ③ | conversion | ≥ 88% | **pass**, 89.19% |
| ④ | cost published | 4.00 calls | **pass** |

The 600-question reading said +2.83pp; the whole split says **+2.15pp**. Both are significant, so
the strong-model lever is confirmed as a ceiling lever — the direction survives, the magnitude
shrinks by a quarter, which is what a 600-question MDE of 3.6pp predicted it would.

### Where the ceiling came from, on the whole split

| arm | unanimity | unanimously wrong | share wrong |
|---|---|---|---|
| `select-mixed` | 1,219 (79.6%) | 371 | 30.43% |
| `select-balanced` | 1,007 (65.7%) | **253** | 25.12% |

**Changing the author moved 212 questions out of unanimity and removed 118 wrong votes.** That is
the mechanism, now measured on 1,532 questions rather than argued from 600: a second author does
not have to be more accurate to be worth more — it has to be wrong in different places. Both of its
sources are individually worse than the chat sources they replaced (57.8% and 58.5% against 62.0%
and 61.8%), and the pool still gains 33 correct answers.

### And the free rule wins the comparison

| arm | `first` | `shortest` | `modal` | selector | ceiling |
|---|---|---|---|---|---|
| `select-mixed` | 62.01% | 63.45% | 62.08% | 62.60% | 66.71% |
| `select-balanced` | 58.88% | **63.71%** | 60.97% | 61.42% | 68.86% |

`shortest` on the strong pool is **976 = 63.71%** against the same pool's selector at 61.42%:
**+2.29pp, 84 up / 49 down, p = 0.0030**, on 3.00 calls instead of 4.00. It is also **+1.11pp above
the arm to beat** (`select-mixed`, 62.60%) and is the highest score any configuration has reached on
the full dev split.

Three things follow, and they are not the same thing:

1. **The free rule is a score lever after all.** The previous round's verdict was that 0.78pp and
   2.00pp sat under the split's resolution, so a rule was "a way to pay less for the same pipeline".
   At 2.29pp with p = 0.0030 that reading is dead. What changed was not the rule: it was that the
   rule now sees candidates with the empty results removed, and it is pointed at a pool whose
   candidates are worth more.
2. **The 65.17% measured on 600 questions was optimistic by 1.46pp.** The whole split says 63.71%.
   The 600-question number was not wrong — it was a different sample, and the difference is inside
   that sample's MDE. Every reading in this document that came from 600 questions now has to be
   read with that in mind, including the two that were used as pre-registration bars.
3. **The conversion rate is the pool's, still.** 93.84% on three chat candidates, 89.19% on two
   reasoning plus one, and the free rule lifts the second to 92.52% without a call. The selector and
   the free rule are separated by exactly the amount the selector cannot read: the rows.

### What this does to the gap

| system | dev | note |
|---|---|---|
| AskData | **78.49%** | profiling metadata + schema linking + result-set vote, 8+ calls |
| CHASE-SQL | 76.02% | multi-candidate + selection agent |
| XiYan-SQL | 75.63% | schema linking + ICL |
| DecoSearch | 70.53% | training-free |
| **this repository** | **63.71%** | strong pool + free rule, 3 calls |
| its ceiling | 68.86% | strong pool, no selection loss |

**14.78pp to AskData = 9.63pp of candidates + 5.15pp of selection.** The selection half is still
smaller than the candidate half, and it is the half that three rounds of selector work failed to
move while a rule that reads rows moved it in one round.

That row read `77.14% ... agentic, execution feedback` until this round. Both halves of that cell
were wrong, and one of them was wrong in a way that changed what this project did next — see below.

## The number we were comparing to was the wrong number, and the wrong kind of system

`77.14%` is AskData's **test** score from its 2025 submission, not its dev score, and the system is
not an agent. The leaderboard row (26 September 2026) reads **dev 78.49%, test 83.40%**, and the
paper it comes from — *Automatic Metadata Extraction for Text-to-SQL* (arXiv:2505.19988) — describes
five named mechanisms, none of which is a tool-using agent:

1. **Database profiling**, one pass per column: null fraction, distinct count, min/max, value shape
   (length, alphabet, common prefixes), top-k values with counts, and a minhash sketch.
2. **LLM summary of the profile**, in two lengths: a short one for schema linking, a long one for
   generation.
3. **Schema linking by task alignment** — the paper's own objection to the standard four linking
   techniques is that an LLM is bad at answering "which columns are relevant" and good at writing
   SQL, so it writes SQL under five schema variants, takes the union of the fields those statements
   reference, and revises a statement whose literals no referenced field can contain.
4. **Three candidates**, varied by sampling seed and schema order.
5. **Result-set majority vote**, with up to three corrections on a hand-written list of bad SQL
   constructions (min/max without a null guard, subquery instead of order by, string concatenation
   where a column was asked for).

The mislabel is not cosmetic. "Agentic, execution feedback" files the system under a design this
repository does not have and cannot price, and the cell was read as a different *kind* of system
rather than a better one. It never entered the replication queue. Correcting it costs nothing and
changes the queue.

### What its own ablation says each piece is worth (MiniDev, 500 questions, GPT-4o)

| configuration | accuracy | what moved |
|---|---|---|
| no metadata, no hints | 49.8% | the floor with names only |
| BIRD metadata, no hints | 59.6% | +9.8 for documented column meaning |
| profiling metadata, no hints | 61.2% | +1.6 over documented |
| fused metadata, no hints | 63.2% | +3.6 over documented |
| BIRD metadata, hints | 72.0% | +12.4 for the hint alone |
| fused metadata, hints | 73.0% | +1.0 for profiling on top of documented |
| full schema, fused, hints | **71.2%** | the row this repository actually occupies |
| its schema linking, fused, hints | **73.0%** | +1.8 for the linker |
| perfect schema linking, fused, hints | **77.4%** | +6.2 over full schema, +4.4 above its own linker |

Two readings in that table are uncomfortable for this document. **No single mechanism in it is small,
and the hint is not a footnote.** Metadata from names to fusion is worth +13.4pp with no hint
(49.8 → 63.2); the hint is then worth another +9.8pp on top of fused metadata and +12.4pp on top of
the documented kind. A submission that uses the hint and one that does not are therefore not
comparable, and the leaderboard's "oracle" mark is part of the number. And **the hint is also what this
repository's 63.0% buys**: the comparable cell is not `73.0%`, it is `71.2%`, the same full schema
carrying the same hint. On the 496 Mini-Dev questions this document has been reading since round one,
the gap to that cell is **8.2pp**, and the one mechanism that has never been priced here is inside it.

### Four of its five mechanisms are already here, and the fourth was already beaten

| mechanism | what it is worth there | what it is here | status |
|---|---|---|---|
| profile → per-column summary | +1.0 on top of documented metadata | attached definitions: **+3.6pp across two runs** (41.4 → 45.0) and **no difference inside any of three** (19/13, 18/17, 15/18; pooled 0.28pp apart ± 1.32; see *Two runs of the same experiment are not the same experiment*); on top of the hint 57.4 → 59.2, not separable | taken as a mechanism, **not shown to be worth anything** |
| schema linking | +1.8 (perfect: +6.2) | a linker hint on a full card; it is priced in **characters**, never in accuracy | **not taken** |
| three candidates | the pool it selects from | `select-mixed` / `select-balanced` pools | taken |
| corrections on bad constructions | up to three, syntax plus a hand-written list | repair loop, syntax-triggered only; 2.4% of first statements fail on `deepseek-chat` ⇒ ≤0.4pp | partially, and the bound is known |
| result-set majority vote | execute all three, equal result sets count as agreement | `select-rule modal`: **60.97%** on the strong pool against `shortest`'s **63.71%**, and 64.17 against 63.67 on `select-cross` (21:18, p = 0.749) | taken, and it lost |

That last row is the useful one, because it is the mechanism a reader would most expect to be missing
and it was priced twice. Voting on rows is not better than voting on characters here — the modal
result ties the paid selector on a homogeneous pool and loses 2.74pp to `shortest` on the strong one.
So the replication agenda is narrower than the mechanism list suggests: **one open row, the linker,
and the five-variant construction that feeds it.**

### Why "price the levers" is not a substitute for "build the system"

This project's method is to price one mechanism at a time and adopt only what clears the noise floor.
The method has a blind spot that this repository measured on itself: **MAC-SQL, paired on the same
498 questions with the same endpoint, beat the adopted arm by 4.84pp (p = 0.0160), and the individual
readings of its four components sum to less than that gap.** A pipeline is not the sum of its
levers — the linker decides what the generator sees, the vote decides what the repair loop was
allowed to try, and each one's price is measured in the presence of the others' defaults.

So the honest answer to "why not copy the leader instead of inventing levers" is: **copying is the
only instrument that prices a pipeline, and this document has been substituting levers for it.** It
is also the answer to why copying must be done as a *system* and not as five separate adoptions:
five separate adoptions is the method that already failed to predict a 4.84pp gap.

### The replication arm, its price, and its bars

`askdata-shape` is specified here as a reproduction of the paper's *shape*, not of its code — the
leaderboard lists no release for it, so a code-faithful run is not available and the report has to
say so. Per question, if it were dispatched: five schema variants generate one statement each; the
union of referenced fields plus the literal→field lookup becomes the card; up to two revisions move
a literal onto a field whose values contain it; three candidates are drawn on that card; validity is
checked and up to three corrections applied; all three are executed and voted as result sets. That
is **8 calls at minimum against the 3 the shipped arm spends**, and the cost column is published per
arm because the paper publishes no call count at all.

| reading against `select-mixed` on the same 496 | verdict |
|---|---|
| ≥ +4.0pp, paired p < 0.05 | the pipeline carries something five levers do not: replication becomes the road, and the ablation runs in reverse (drop one mechanism at a time) |
| +1.5 to +4.0pp | the mechanisms are worth their calls but the gap is not theirs; copy the vote and the linker, stop there |
| < +1.5pp | the 8.2pp is the author, not the architecture: GPT-4o and eight retrieved examples against `deepseek-chat` and none, and the correct next lever is a stronger model, not a longer pipeline |

The third row is the one the field's own numbers already hint at: the leaderboard's single-model
column puts a reasoning model at **80.04%** (Gemini-SQL2, June 2026, secondary source) — above every
scaffolded system in the table above. If that holds, the frontier moved from scaffolding to the
model while this document was pricing prompts, and a replication arm is the cheapest way to find out
which of the two the remaining 8.2pp belongs to.

### Which of them can be copied at all

The question "why not copy the leader" has a different answer per system, and only one of the
answers is "copy it". `pnpm bench:competitors:intake` holds the record — one row per system, with
the URL the status was read from and the date it was read, and a gate that refuses a status without
either.

| system | what the artifact is | what copying it produces |
|---|---|---|
| MAC-SQL | repository, 40-character commit, no licence file | **run their code** |
| CHESS | repository, 40-character commit, Apache-2.0 | **run their code** |
| Agentar-Scale-SQL | repository, Apache-2.0, the schema half only | run the released half, rebuild the rest |
| AskData | a paper with five named mechanisms, no release | rebuild the paper's mechanisms |

Two of the four are pinned. One has been run, and it won: MAC-SQL, paired on the same 498 questions
with the same endpoint, beat the adopted arm by **4.84pp** (p = 0.0160). That is the result that
settles the argument in favour of copying, and it is the same result that says why copying has to be
done as a system: its four component readings summed to less than the gap, so a pipeline is not the
sum of its levers, and the only instrument that prices a pipeline is another pipeline.

The third row is the one that arrives looking like the second. `antgroup/Agentar-Scale-SQL` is
Apache-2.0, 480 stars, and its README reports 81.67% test. `ScaleSQL/modules` holds
`light_schema.py`, `metadata_generation.py`, `retrieve.py` and `keyword_extraction.py`; the selection
and refinement modules the paper describes are on the README's roadmap and not in the tree. A run of
that repository therefore produces a schema, not a system, and the number such a run would make
belongs to a hybrid — the released half is exactly the half this document has been pricing in
characters for three rounds.

The fourth row has no artifact at all, and what a rebuild of it is worth is measurable from outside.
A community rebuild of the four-stage pipeline — profiling with FAISS and MinHash LSH over 10,000
literals per column, five schema representations, fifteen candidate statements, `sqlglot`
validation — reports **95.6% mean column recall and 90.5% F1** in linking, and **61.8%** execution
accuracy on BIRD against the paper's **76.14-78.49** dev. The linking half reproduces; the score does
not. What the paper does not carry is the part the score is made of: the eight retrieved
demonstrations, the wording of the templates, and the order in which the metadata is fused and
truncated.

So the answer is not "copying does not work". It is that copying works in proportion to what was
published, and the three kinds of copying cannot be filed in one column:

- **run** may be plotted beside a run of this repository: the templates are theirs, and
  `coordinates.ts` will accept the comparison or say which coordinate broke.
- **run-shell** may not. A number from the released half plus our rebuild of the withheld half
  contains this repository's author, and filing it under their name is the mislabel this document
  spent a round correcting.
- **rebuild** may not either, and it may not be called a replication. The bar it has to clear is its
  own before-and-after, not the paper's number.

That is why the queue is ordered as it is. `askdata-shape` is specified above and **no arm carries
that name today**: the round that would have spent eight calls a question rebuilding it went to
MAC-SQL instead, which is free to dispatch and won 4.84pp. A paper-only leader is worth rebuilding
*after* the released ones have been run, because a rebuild's first result is a number with no
denominator — and this document already has one entry of that kind, the `45.0%` that did not
reproduce at `40.3%`.

## Two runs of the same experiment are not the same experiment

The `40.3%` above left three explanations standing and said the artifact could not separate them.
One round later, the artifact can: `42491745712` scored **both** placement arms, and this round
downloaded both Mini-Dev artifacts and put them side by side. What came out is bigger than the
question that prompted it.

### The placement pair, read inside one run

`bench:bird:pair` over `42491745712` — one artifact, one set of 496 questions, one judge:

| reading | value |
| --- | --- |
| questions paired | 496 |
| `synth-definitions` right, `inline-definitions` wrong | 18 |
| `inline-definitions` right, `synth-definitions` wrong | 17 |
| exact McNemar | **p = 1.0000** |
| the two rates in that run | 40.93% and 40.73% |

So the `+3.6pp` this document credited to *attached definitions* — 41.4% as a block against 45.0% on
the column line — was never a measurement of placement. It was the difference between **two runs**,
and inside one run the same two arms are one case apart. The 45.0% itself is a real reading of run
`40101482710`; what it is not is evidence that the placement was worth anything. The pairing is the
cheapest reading in this document (no model call, one command) and it is now declared per split, so a
run that does not take it fails the gate rather than passing quietly.

### What two runs of one unchanged configuration differ by

Two Mini-Dev runs on 2026-11-08, three hours apart. `bench:bird:compare` checks the coordinates a
difference has to hold constant, and every one of them matches:

| coordinate | run `42482353883` | run `42491745712` |
| --- | --- | --- |
| split | minidev | minidev |
| corpus digest | `7f9b2384df7fd655` | `7f9b2384df7fd655` |
| model asked for | `deepseek-chat` | `deepseek-chat` |
| model that answered | `deepseek-flash` | `deepseek-flash` |
| harness | timeout 60000, concurrency 8, retries 3 | identical |
| arms scored | 13 | 13 |

Same experiment, twice. The arms that did not change between them:

| arm | run A | run B | delta | ±95% on two independent rates | reading |
| --- | --- | --- | --- | --- | --- |
| **`select`** (the shipped arm) | 56.05% | 58.06% | **+2.02** | 6.16 | inside the interval |
| `inline+repair-raw` | 56.25% | 57.46% | +1.21 | 6.16 | inside |
| `inline+evidence` | 56.05% | 55.24% | −0.81 | 6.18 | inside |
| `metadata+evidence` | 58.67% | 57.86% | −0.81 | 6.14 | inside |
| `synth-definitions` | 41.53% | 40.93% | −0.60 | 6.13 | inside |
| `inline-definitions` | 40.32% | 40.73% | +0.40 | 6.11 | inside |
| `names` | 36.29% | 36.29% | 0.00 | 5.98 | inside |

Every row is inside the interval a difference of two independent rates has to clear at n = 496, which
is **6.16pp**. That is not a failure of the runs; it is the resolution of a 496-question benchmark, and
it is the number every `+0.6pp` and `+1.2pp` in this document has been quietly smaller than.

### The flows under the rates

A rate difference is the net of two flows, and the artifact carries the case rows that produce them.
Paired across the two runs — same arm, same question, different execution:

| arm | cases | flips up | flips down | net | churn |
| --- | --- | --- | --- | --- | --- |
| **`select`** | 496 | 18 | 8 | +10 | **5.2%** |
| `inline+evidence+audit` | 496 | 9 | 6 | +3 | 3.0% |
| `inline+evidence` | 496 | 5 | 9 | −4 | 2.8% |
| `values` | 496 | 6 | 8 | −2 | 2.8% |
| `inline+repair-raw` | 496 | 9 | 3 | +6 | 2.4% |
| `metadata+evidence` | 496 | 4 | 8 | −4 | 2.4% |
| `inline+definitions` | 496 | 5 | 3 | +2 | 1.6% |
| `synth-definitions` | 496 | 2 | 5 | −3 | 1.4% |
| `names` | 496 | 5 | 5 | 0 | 2.0% |

**26 of 496 questions came out differently on the shipped arm**, with the corpus, the model and the
harness identical. Eighteen went one way and eight the other, exact McNemar **p = 0.0755**: not a
regression, and not nothing either — it is a 2pp swing sitting one favourable draw away from the
significance line. Anyone comparing two runs would have reported `+2.02pp` as a win, and this document
has a `+1.01pp at p = 0.27` in it that was reported exactly that way.

Two things follow, and they are different things. The **single-call** arms churn about 2%, the
**four-call** selector chain 5.2%, because each extra call is another draw that can move a case. And a
paired test inside one run removes the questions' own difficulty from the difference, which is why the
A/A control on `inline+evidence` is 0.4pp (4 against 6, p = 0.754) while the same arm moved 0.81pp
between runs.

### What the endpoint said it served

Every one of the 6,448 cases in both runs was answered by a base the endpoint named **`deepseek-flash`**
while the artifact's `model` field says `deepseek-chat`, because that is what the run asked for. Both
fields are now recorded and neither is derived from the other: `model` is what a re-run asks for,
`servedModels` is what answered, and `eval/baseline/bird.json` pins the second one. A run whose base
differs from the pin **fails** — a floor is a claim about a model, and the name that has to match is
the one that answered.

The three explanations from the previous section are therefore settled as far as this artifact can
settle them: it was not the corpus (digest equal), it was not the arm (same definition, prompt sizes
within two characters), and it was not a change of weights behind the alias **during** the interval
both runs sit in (both served `deepseek-flash`). What is left is the draw, and the draw is ±2pp on an
arm and 5.2% churn on the chain.

### What this changes in the instrument

- **`bench:bird:compare`** reads two artifacts and prints the coordinate table, the displacement table
  with its ±95% column, and the churn table. It is the only tool here that joins two artifacts, and
  what it produces is a statement about the *instrument*, not about a lever.
- **Pairs are declared.** `eval/baseline/pairs.json` names the pairs each split owes; `ci.yml` reads
  them with `bench:bird:pair --declared` before the floor gate, and the gate fails a run that skipped
  one. Five on Mini-Dev, three on dev, and the same table appears in the job summary.
- **Corpus and base model are pinned.** `corpus.minidev = 7f9b2384df7fd655` and `served.minidev =
  ["deepseek-flash"]`. The first was already checked and unenforced because the baseline had no value;
  the second did not exist.

The declared readings from `42491745712`, which is the last full run before this section was
written:

| pair | won | lost | p | reading |
| --- | --- | --- | --- | --- |
| `synth-definitions` → `inline-definitions` | 18 | 17 | 1.0000 | placement: no difference |
| `inline+evidence` → `inline+evidence+audit` | 11 | 7 | 0.4807 | the audit turn: no difference |
| `inline+evidence` → `select` | 22 | 8 | **0.0161** | selection: **+2.82pp**, separable |
| `metadata+evidence` → `select` | 27 | 26 | 1.0000 | a 1-call curated stack against the 4-call chain: **no difference** |

The third row is what a paired test separates **in this run**; the next subsection reads the same pair
in the two runs that followed and withdraws it. The fourth is the one that matters for the bill, and
in this run it is a tie: **four calls a question buy nothing over one prompt carrying the curated
notes**. It is a cross-level comparison and `COMPARISONS` files it as one — three stack levels, not one
lever — but a tie between a 1-call arm and a 4-call arm is an argument about cost. Two runs later the
tie is a **−1.90pp ± 1.64** estimate with `established` against it — the 1-call arm ahead in two runs of
three — so the argument is about cost **and** about resolution: at 496 questions, four calls a question
are not shown to buy accuracy, and the one-call stack is if anything the better buy.

### The third run, and what one paired reading is worth

Everything above was written with two artifacts. The push that added the declared pairs produced a
third run (`42502095942`) of the same configuration, and it moved the answer again — this time the
answer to "is a paired reading a result?".

The three runs, all Mini-Dev, all `deepseek-chat` asked and `deepseek-flash` served, all on corpus
`7f9b2384df7fd655`, thirteen arms each:

| arm | `42482353883` | `42491745712` | `42502095942` | range |
| --- | --- | --- | --- | --- |
| **`select`** | 56.05% | 58.06% | 56.05% | **2.01** |
| `metadata+evidence` | 58.67% | 57.86% | 59.27% | 1.41 |
| `inline-definitions` | 40.32% | 40.73% | 41.73% | 1.41 |
| `inline+repair` | 56.05% | 56.45% | 55.24% | 1.21 |
| `values` | 57.86% | 57.46% | 58.67% | 1.21 |
| `inline+retrieval` | 40.93% | 41.33% | 41.94% | 1.01 |
| `inline+evidence` | 56.05% | 55.24% | 55.85% | 0.81 |
| `inline+icl` | 41.73% | 41.13% | 41.94% | 0.81 |
| `inline+evidence+audit` | 55.44% | 56.05% | 56.05% | 0.61 |
| `names` | 36.29% | 36.29% | 36.90% | 0.61 |
| `synth-definitions` | 41.53% | 40.93% | 41.13% | 0.60 |
| `inline+evidence#2` (A/A) | 56.05% | 55.65% | 55.85% | 0.40 |

The shipped arm moved **2.01pp across three runs** — up 2.02, then back down 2.01. The A/A arm, which
differs from its twin only by being a second draw, moved 0.40pp over the same three runs. This is the
same displacement the previous section measured, now in both directions, which rules out the reading
that the second run was simply a lucky one.

And the declared pairs, read in all three runs and pooled by inverse variance over the discordant
counts. Each cell is the pair's discordant counts in the order the tool prints them — **the second arm
only, over the first arm only** — so `22/8` on `inline+evidence → select` means 22 questions only the
selector got right and 8 only `inline+evidence` did:

<!-- readings:begin three-runs -->
| pair | `42482353883` | `42491745712` | `42502095942` | pooled | verdict | Q |
| --- | --- | --- | --- | --- | --- | --- |
| `synth-definitions` → `inline-definitions` | 13/19, p = 0.3771 | 17/18, p = 1.0000 | 18/15, p = 0.7283 | −0.28pp ± 1.32 | **none** (minidev) | 0.536 |
| `inline+evidence` → `inline+evidence+audit` | 8/11, p = 0.6476 | 11/7, p = 0.4807 | 10/9, p = 1.0000 | +0.15pp ± 0.99 | **none** (minidev) | 0.515 |
| `inline+evidence` → `select` | 13/13, p = 1.0000 | 22/8, **p = 0.0161** | 19/18, p = 1.0000 | +1.01pp ± 1.26 | **one-run-only** (minidev) | 0.130 |
| `metadata+evidence` → `select` | 19/32, p = 0.0919 | 27/26, p = 1.0000 | 18/34, **p = 0.0365** | **−1.90pp ± 1.64** | **established** (minidev) | 0.209 |
| `inline+evidence` → `metadata+evidence` | 31/18, p = 0.0854 | 28/15, p = 0.0660 | 32/15, **p = 0.0186** | **+2.89pp ± 1.55** | **established** (minidev) | 0.891 |

*The label at every prefix of these readings — it should arrive once and stay:*
- `synth-definitions` → `inline-definitions`: none at 2–3 readings
- `inline+evidence` → `inline+evidence+audit`: none at 2–3 readings
- `inline+evidence` → `select`: one-run-only at 2–3 readings
- `metadata+evidence` → `select`: none at 2, established at 3 readings
- `inline+evidence` → `metadata+evidence`: established at 2–3 readings
<!-- readings:end three-runs -->

So the sentence above the table — "the third row is what a paired test separates **in this run**" —
does not survive the runs that followed, and neither does the one before it that read the fourth row as
a tie worth arguing about. The first was true of one run and false of the next, on identical inputs. `inline+evidence -> select` read 22 against 8, then 19 against 18, and the first run had read
13 against 13 on the same pair: the same questions, the same base model, hours apart. Pooled it is
**+1.01pp ± 1.26**, and Cochran's Q on the three discordant counts is **p = 0.130** — the three readings
are compatible, so nothing in this table is called unpoolable, and the pool stops clearing zero once the
tie is in it: `one-run-only`, which is the label for an effect one run found and the pooled estimate could
not keep. The cost-frontier pair is not a tie either: the 1-call curated stack is ahead by 13 cases in the
first run and 16 in the third, and behind by one in the middle one, and its pool reads **−1.90pp ± 1.64**
with `established` beside it. Both of those labels moved while the rules were being repaired, and the
estimates they label did not: a label is a statement about evidence, and a corrected rule can change it
without touching the pool.

**A defect in the heterogeneity test, and the label it retracted.** The Q column in every table in this
section was computed correctly and referred to the wrong distribution. `poolPair` turned Q into a p-value
by `2·Φ̄(√Q)`, which is the chi-square survival function at **one** degree of freedom — so a pair was judged
as if it had two readings whatever number it had. Cochran's Q is χ² with k−1 degrees of freedom, which is
what the function's own comment claimed and what the verdict rule was written against. The two distributions
coincide at k = 2, which is the shape almost every pooling unit test used, and diverge from k = 3, so the
error was invisible in a suite that passed for three rounds.

Referred correctly, the readings are far more compatible than they were said to be. No pair rejects
homogeneity at any number of readings tried, and the labels move in one direction as readings arrive and
never back. That claim used to be a table of forty hand-typed labels, which is forty numbers that can
drift — and two of them had. It is now a ladder derived from the same counts as the table it sits under
and printed beneath it, one line per pair, with the gate failing on any label that leaves and returns.

Two things follow, and the first is a retraction. The earlier version of this section concluded that the
audit turn's readings "are simply not one number", on Q p = 0.006 at seven readings, and left that mechanism
filed as `heterogeneous`. That p was the one-degree-of-freedom value; with χ²₆ it is 0.277, the pair is not
heterogeneous at any size, and the conclusion was an artefact of the test rather than a property of the
mechanism.

The second is that the DerSimonian–Laird pool added in the same change now widens **nothing**: τ² is zero for
every pair in every table, because the test it is conditioned on no longer rejects anywhere. The estimator
stays, and so do its tests — a pair of +11.09 and −11.09pp gives τ² = 243.33pp² and an interval of ±21.74 —
but on this corpus it is a mechanism with no work to do, which is a different statement from the one the
previous version of this section made.

**A second defect, found by writing the ladder down: `sign-flip` did not mean a reversal.** The label was
`significant.length > 0 && signs.size > 1` — whether *anything* was significant anywhere, and whether any
two readings differed in sign. Those are two different readings. `inline+evidence -> inline+evidence+audit`
satisfied it with the significance in `17/4` and the opposite sign in `8/11`, a reading that is p = 0.65 on
its own, so a pair with seven positive readings and one wobble printed `sign-flip` until this rule was corrected;
`metadata+evidence -> select` did the same with `27/26` — one case — against a single significant negative
reading. A reversal now needs a reading that cleared its own test in *each* direction, and the rule is
applied before heterogeneity because it names the kind of disagreement rather than its existence: both
labels say the readings are not one number, and both widen the interval.

Two pairs changed label under the corrected rule and neither estimate moved. The audit pair reads
`established` at +0.63pp ± 0.56 over nine readings, and the cost-frontier pair `established` at
−1.42pp ± 0.96 — the direction the three-run table had already shown. A label can change without the
evidence changing; that is what a label is for, and it is also why a rule has to be tested against the
readings it will meet rather than against the ones it was written for.

**A fourth run, unasked for.** The commit that added the fifth declared pair was pushed, which produced
another run (`42510049798`) of the same configuration — the first one to read all five pairs in CI. Every
label above survived it, and the intervals narrowed the way the resolution paragraph promised. This is the
same table with one more reading rather than a second kind of table, so the two can be read as a sequence —
the `was (three runs)` column the hand-written version carried is the table above it:

<!-- readings:begin four-runs -->
| pair | `42482353883` | `42491745712` | `42502095942` | `42510049798` | four-run pooled | verdict | Q |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `synth-definitions` → `inline-definitions` | 13/19, p = 0.3771 | 17/18, p = 1.0000 | 18/15, p = 0.7283 | 13/19, p = 0.3771 | −0.52pp ± 1.13 | **none** (minidev) | 0.628 |
| `inline+evidence` → `inline+evidence+audit` | 8/11, p = 0.6476 | 11/7, p = 0.4807 | 10/9, p = 1.0000 | 9/8, p = 1.0000 | +0.16pp ± 0.84 | **none** (minidev) | 0.722 |
| `inline+evidence` → `select` | 13/13, p = 1.0000 | 22/8, **p = 0.0161** | 19/18, p = 1.0000 | 19/11, p = 0.2005 | **+1.16pp ± 1.09** | **established** (minidev) | 0.230 |
| `metadata+evidence` → `select` | 19/32, p = 0.0919 | 27/26, p = 1.0000 | 18/34, **p = 0.0365** | 22/28, p = 0.4799 | **−1.72pp ± 1.42** | **established** (minidev) | 0.346 |
| `inline+evidence` → `metadata+evidence` | 31/18, p = 0.0854 | 28/15, p = 0.0660 | 32/15, **p = 0.0186** | 31/17, p = 0.0595 | **+2.87pp ± 1.35** | **established** (minidev) | 0.972 |

*The label at every prefix of these readings — it should arrive once and stay:*
- `synth-definitions` → `inline-definitions`: none at 2–4 readings
- `inline+evidence` → `inline+evidence+audit`: none at 2–4 readings
- `inline+evidence` → `select`: one-run-only at 2–3, established at 4 readings
- `metadata+evidence` → `select`: none at 2, established at 3–4 readings
- `inline+evidence` → `metadata+evidence`: established at 2–4 readings
<!-- readings:end four-runs -->

This is the check that matters for the instrument and not for the levers: a fifth run is coming, because
every push that touches the pipeline produces one, so the question is not whether the numbers move but
whether the labels do. At four readings one label moved and one only: `select` went from `one-run-only`
to `established`, because a fourth reading pushed its pool clear of zero and every reading but one was
positive. Nothing else moved, and the runs that followed moved nothing back — each label arrives once and
stays, which the ladder beneath the nine-run table prints rather than asserts.

**Runs five to nine: five more readings, and what nine of them say.** Five more runs of one
configuration arrived after the fourth — `42523664683` (the fingerprint commit), `42526940345` (the pin
commit, the first run whose gate enforced a fingerprint), `42527570372` (a dispatch, to ask whether the
fifth reading was an outlier), `42552807523` (the reading-ledger commit, whose push produced it) and
`42571328962` (the commit that corrected the heterogeneity test, whose first attempt lost 296 of 496
`select` calls to the provider and whose re-run scored all of them). All five asked the same questions,
and all five reported the same base fingerprint, `170d0beaa768594b` over `deepseek-flash`, six identical
answers each.

<!-- readings:begin all-runs -->
| pair | A | B | C | D | E | F | G | H | I | nine-run pooled | verdict | Q |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `synth-definitions` → `inline-definitions` | 13/19 | 17/18 | 18/15 | 13/19 | 15/17 | 14/16 | 14/25 | 16/18 | 18/22 | −0.67pp ± 0.77 | **none** (minidev) | 0.899 |
| `inline+evidence` → `inline+evidence+audit` | 8/11 | 11/7 | 10/9 | 9/8 | **17/4** | 11/6 | 10/5 | 10/7 | 11/12 | **+0.63pp ± 0.56** | **established** (minidev) | 0.402 |
| `inline+evidence` → `select` | 13/13 | **22/8** | 19/18 | 19/11 | 26/13 | 19/10 | **23/10** | 18/11 | 15/9 | **+1.54pp ± 0.72** | **established** (minidev) | 0.583 |
| `metadata+evidence` → `select` | 19/32 | 27/26 | **18/34** | 22/28 | 27/33 | 23/29 | 24/28 | 27/33 | 23/30 | **−1.42pp ± 0.96** | **established** (minidev) | 0.882 |
| `inline+evidence` → `metadata+evidence` | 31/18 | 28/15 | **32/15** | 31/17 | **35/16** | **31/16** | **31/14** | 33/20 | 30/17 | **+3.00pp ± 0.91** | **established** (minidev) | 0.999 |

*The label at every prefix of these readings — it should arrive once and stay:*
- `synth-definitions` → `inline-definitions`: none at 2–9 readings
- `inline+evidence` → `inline+evidence+audit`: none at 2–4, one-run-only at 5–6, established at 7–9 readings
- `inline+evidence` → `select`: one-run-only at 2–3, established at 4–9 readings
- `metadata+evidence` → `select`: none at 2, established at 3–9 readings
- `inline+evidence` → `metadata+evidence`: established at 2–9 readings
<!-- readings:end all-runs -->

Three things came out of it, and only one of them is about a lever.

1. **The fingerprint reproduces.** Five runs on five different commits, hours apart, hashed the same six
   answers to the same 16 characters. The third was the first whose gate compared a fresh digest against
   the pin and passed; the fourth is the first whose artifact also records which run produced it. A pin
   taken from one run and never seen again would have been a number; this one has now been reproduced
   four times.
2. **The audit pair is not unpoolable, and two labels that said otherwise were both defects.** Its nine
   readings span −0.60 to +2.62pp, which looks like disagreement and is not: referred to χ²₈, Cochran's Q
   gives p = 0.402, and the pool is **+0.63pp ± 0.56**, `established`. One reading sits on the other side
   of zero — the first, at −0.60pp with p = 0.65 on its own — which is a wobble and not a reversal.
   **Two claims were retracted here.** The first, two versions back, was that the audit turn's readings
   "are simply not one number": the test behind it had one degree of freedom and the correct one never
   rejected. The second, from the last version, was the label `sign-flip` itself, which asked two
   different readings two different questions — the significance was in `17/4` and the opposite sign in
   `8/11`. A reversal now requires a reading that cleared its own test in each direction.
3. **The curated-notes pair is still the firmest thing here, and still not a product claim.** Nine
   readings, every one positive, between +2.62 and +3.83pp, Q p = 0.999, four of nine individually
   significant, pooled **+3.00pp ± 0.91**. That is a homogeneous effect measured nine times on 496
   questions — and it is still not a product claim, because the dev split's only readings of the same pair
   are +0.07pp and +0.91pp on 1,532 questions, and Mini-Dev is a subset of dev. Nine Mini-Dev runs cannot
   outvote the larger split about a different population; the dev run that could was dispatched before
   this paragraph was written, and it reads a third of the effect — below.

The `select` pair deserves its own paragraph, because a costing decision hangs on it and because the
correction changed its label: eight of nine readings are positive and one is exactly zero, the pool is
**+1.54pp ± 0.72** with Q p = 0.583, and it is `established` — an effect Mini-Dev resolves, on 496
questions, in a corpus whose own dev split is the population being claimed about. So cutting the selector
from the default chain would give up about 1.5pp that this corpus establishes — and the dev split, which
is the population being claimed about, reads the same pair at −0.13pp. That reading was dispatched before
this paragraph was written and is set out below; it is the reason the label is a Mini-Dev property and not
a product claim.

What the nine readings cost: nothing. Every one of the nine artifacts was produced by a push that was
going to happen anyway; the only dispatched run in this chapter is the dev one below.

**The dev split, read on the same pairs — the question this section has been deferring.** Nine readings
of 496 questions can establish an effect *on those 496* and say nothing about the split that published
leaderboards report. So a dev dispatch (`42563674600`) ran the same arms on all 1,532 scorable questions,
and the two pairs with a claim resting on them are read here side by side:

<!-- readings:begin dev-split -->
| pair | `42563674600` | pooled | verdict | Q |
| --- | --- | --- | --- | --- |
| `inline+evidence` → `select` | 37/39, p = 0.9088 | −0.13pp ± 1.12 | **none** (dev) | — |
| `metadata+evidence` → `select` | 68/84, p = 0.2236 | −1.04pp ± 1.58 | **none** (dev) | — |
| `inline+evidence` → `metadata+evidence` | 75/61, p = 0.2649 | +0.91pp ± 1.49 | **none** (dev) | — |

*Not read here: `synth-definitions` → `inline-definitions`, `inline+evidence` → `inline+evidence+audit`.*
<!-- readings:end dev-split -->

Two of the five declared pairs are missing from that table because the dispatch did not run the arms they
name — `synth-definitions` and the audit turn are not scored on this split, and the table says so rather
than showing three rows and letting a reader count them.

What it says about the two claims:

1. **The curated-notes effect is a third the size on dev, and not resolvable there.** Nine Mini-Dev runs
   pool at +3.00pp ± 0.91 with Q p = 0.999; the dev split reads **+0.91pp ± 1.49** (75 won, 61 lost,
   p = 0.2649). Same direction, one third the magnitude, and the interval includes zero. This is the second
   dev reading of that pair — the first was +0.07pp (65:66) — and the two are one standard error apart, so
   the dev split's own answer is roughly "between −0.3 and +1.7pp". Mini-Dev's nine runs and dev's one
   differ by about 2.1pp, which is 2.4 standard errors: **the split is not a smaller sample of the same
   question for this pair**, and the smaller number is the one about the population a leaderboard means.
2. **The selector's advantage does not survive the split.** Mini-Dev labels `inline+evidence → select`
   `established` at +1.54pp ± 0.72; on dev it reads **−0.13pp ± 1.12** (37 won, 39 lost, p = 0.9088) — one
   case in the wrong direction, and an interval that excludes everything the smaller split claimed. The
   four-call chain is not shown to be worth a call more than the two-call one on the split that decides,
   which is the opposite of what nine Mini-Dev runs said with an `established` label attached.

Neither of those is a surprise to the paragraph above, which called the conflict a property of the corpus
and refused to let nine small-split runs outvote one large one. It is a surprise to the labels: two pairs
that Mini-Dev calls `established` are, on dev, indistinguishable from zero and pointing the wrong way
respectively. **The corpus a claim is made on belongs in the claim**, and the only reason this section can
say so with a number rather than a caution is that the dev run was dispatched before the answer was known.

A paired test conditions on the questions. It does not condition on the generator's own draw, and on
496 questions that draw is worth about two points per run. So the unit of evidence here is neither a
rate nor a single paired reading: it is the pair's estimate pooled over the runs that read it, with
the disagreement between readings printed rather than averaged away.

That pool is also where the instrument's own first defect turned up. `--pair` accepted two artifacts,
while the table it prints says "in every run that scored it": pooling the last two runs gave +1.65pp
and the label `established`, pooling all three gives +1.01pp and `one-run-only`. **The verdict was
a function of which two runs the command happened to be handed.** `bench:bird:compare` now takes
every artifact it is given as a reading of the pair (`compare.ts a.json b.json c.json --pair x,y`),
names any artifact that did not score both arms instead of dropping it silently, and prints the
verdict and its evidence in two sentences — the label on one line, `1 of 3 readings significant, Q
p = 0.130 — the readings differ no more than their own intervals` on the next. The five labels are
the five things that can be true: `none` (the pool's interval includes zero and no single reading
cleared its own test), `one-run-only` (a direction that rests on one reading, or a reading the pool did
not keep), `sign-flip` (readings that cleared their own tests in *opposite* directions — a reversal, not
a disagreement), `heterogeneous` (readings that disagree about the size and cannot be pooled as one
number), and `established` (the pool clears zero and no reading cleared its own test the other way).
Every one of them is a statement about a split, so every generated table prints the split beside the
label: this section's headline pair reads `established` on 496 questions and `none` on 1,532.

**An interval for a pool the label calls unpoolable.** A pair labelled `heterogeneous` used to keep the
fixed-effect interval: the same weights, the same `1/Σw`, an interval narrower than the distance between
the readings it summarised. That is the estimator answering a question it has just declined to answer, and
the pool is now a random-effects pool whenever the heterogeneity test rejects — DerSimonian–Laird (1986)
estimates the between-reading variance τ² from the excess of Cochran's Q over its degrees of freedom, adds
it to every reading's variance and re-weights. The estimate does not move; the interval does, and each
generated table names the pairs it was widened for and the τ² it was widened by.

On this corpus it currently widens nothing, and that is the honest reading rather than a disappointment:
once Q is referred to the right number of degrees of freedom, no pair rejects homogeneity at any size
tried, so τ² is zero everywhere and every table is the fixed-effect one. The estimator is pinned by tests
that make it work — +11.09 and −11.09pp give τ² = 243.33pp² and ±21.74pp — and the invariant it enforces
is: **the interval is widened exactly when, and only when, the label says the readings are not one
number.** τ² is estimated only behind a rejecting test and is exactly zero otherwise, which is a pre-test
estimator with a known bias — it under-covers when Q sits just above the threshold. That bias is the price
of the invariant; widening unconditionally would avoid it and move every number in this document for a
disagreement no test found.

**None of the numbers above is typed.** The three tables in this section are generated from
`eval/baseline/readings.json`, which stores the only thing that cannot be derived — two discordant counts
per pair per run — and nothing else. `pnpm bench:bird:readings` writes the tables, and
`pnpm gate:readings` fails when a table, or one of the numbers quoted in the sentences around it, is not
what those counts derive. A run also names the split it was read on, and a table whose runs disagree about
that is refused rather than pooled: 496 questions nine times and 1,532 questions once are estimates of two
different populations, and a pool of the two would print as a narrower interval instead of as an error. The arithmetic did not change to make this possible: the per-reading p and the
pool come from `mcnemarExact` and `poolPair`, the same functions `bench:bird:compare` prints with, so a
generated table and the artifact it describes are the same computation rather than two implementations of
it. What changed is provenance. Four hand-typed numbers in this document had already drifted from the
artifacts they described, and every one of them was plausible on the page — which is the property that
made them survive review, and the reason a reader could not have caught them either.

What this leaves standing is the resolution, and it is the useful number: **a prompt-layer lever on
Mini-Dev cannot be resolved smaller than about 2pp per run, and a single run's paired reading can move
by that much.** The ways out are arithmetic, not rhetorical — average three runs (SE falls by √3, which
is why the pools above are ±0.99 to ±1.64pp instead of ±2pp, and why `synth-definitions` →
`inline-definitions` can now be stated as −0.28pp ± 1.32 rather than "18 against 17"), move the decision
to the 1,532-question dev split (SE falls by 1.8×), or stop pricing prompt levers and attack the model
axis, where the gap to the comparable leaderboard cell is 8.2pp. The √3 is not free: it needs a pair whose
readings share one mean, and a pair that rejects homogeneity gets an interval widened by the disagreement
instead of narrowed by the extra readings.

## The zero-row repair, built

The state was priced last round and the bar was written before anything was built: a statement that
returns no rows is wrong by construction on this split, the whole candidate set returned nothing on
**19 of 496 dev questions (3.83%)**, the selector was right on none of them, and 18 of those 19 wrote
a value the database does not contain. That is a lookup failure, so the repair is a lookup.

### What was built

Three steps, and only the third one costs a model call:

1. **Detect.** The winner ran and returned no rows. With the empty candidates dropped before the
   vote, that is the same event as "every candidate returned nothing" — a case where something
   survived with rows never triggers, which is 96.2% of the split.
2. **Look up.** Every string literal the statement compares against a column (`=`/`!=`/`in`/`between`
   sites, from the same `literalSites` the case repair reads) is searched in that column:
   `lower(column) like lower('%literal%')`, one query per column, at most six literals per statement.
   Three outcomes matter. A column that stores the literal as written needs no repair and says
   nothing. A column that stores it in another case is **grounded deterministically** — the stored
   spelling is substituted, and if that statement returns rows it is adopted with **no model call at
   all**. A column that stores values *containing* the literal (`Benalish Knight (Fellwar Stone)` for
   `Benalish Knight`) is a judgement, so those values are quoted back. A literal no value contains is
   a fabrication, and saying so is cheaper than letting the model repeat it.
3. **Rewrite once.** One call, carrying the statement and the quoted values, on the cases the lookup
   could not settle.

The lookup is deliberately not fuzzy: no stemming, no edit distance, no "did you mean". The only
matches reported are the ones the database produced. A repair that guesses turns an empty answer into
a plausible wrong one, and the empty one is visibly empty.

Nothing about the trigger can disturb what already works: on the 96.2% of cases where a candidate
returned rows, the arm does exactly what its parent does — same candidates, same selector, same
calls.

### What the artifact records

Per case, `emptyProbe` carries `queries` (engine work, no calls), `literalGaps` (literals the columns
do not store as written), `grounded` (the deterministic repair fired) and `adoptedFree` (it was
adopted without spending the turn). The arm funnel adds `literalGaps`, `grounded`, `adoptedFree` and
`probeQueries` beside the existing `dropped`/`fired`/`recovered`. The separation is the point: a case
answered by the grounded statement never spent a call, and folding the two yields into one number
would price a free repair as if it were the fourth call.

### Pre-registration

Dispatched as three arms on the full dev split (1,532 questions): `select-mixed` (the arm to beat,
62.60%), `select-mixed+empty` (the same drop and the same call with the diagnosed message, the
published null), and `select-mixed+values` (the lookup). One lever between the last two: the words
of the turn, at the same call count.

| # | criterion | bar |
|---|---|---|
| ① | correct on the triggered questions | **≥ 25%** of them |
| ② | full split | **≥ +0.96pp** against `select-mixed+empty` |
| ③ | the 96.2% that never trigger | **unchanged**, question for question |
| ④ | cost | `calls.mean` and `promptChars` for the triggered subset **published**, with the lookup's `probeQueries` counted apart from its calls |
| ⑤ | the free half is priced apart | `adoptedFree` reported, so a gain the lookup produced without a call cannot be read as a gain the model produced |

A repair that cannot clear ① is a call spent for nothing, because the same 3.85pp is available to a
filter that drops the state and reports it. ③ is not a formality: it is the check that the trigger
is as narrow as it claims, and it fails loudly if a code path that should be untouched moved.

### The reading: the lookup works and the lever does not clear its bar

`41830439625` ran the three arms over all 1,532 dev questions in one artifact.

| arm | score | ceiling | `calls.mean` |
|---|---|---|---|
| `select-mixed` | 967 = **63.12%** | 1,034 = 67.49% | 3.995 |
| `select-mixed+empty` | **973 = 63.51%** | 1,025 = 66.91% | 4.027 |
| `select-mixed+values` | **973 = 63.51%** | 1,028 = 67.10% | 4.024 |

| # | criterion (registered before dispatch) | bar | read |
|---|---|---|---|
| ① | correct on the triggered questions | ≥ 25% | **fail**, 9 of 51 = **17.6%** |
| ② | full split against `select-mixed+empty` | ≥ +0.96pp | **fail**, **0.00pp** (973 = 973; 18 up / 18 down, p = 1) |
| ③ | the 96.2% that never trigger | unchanged | **31 of 1,479 changed** — and the criterion was mis-specified, see below |
| ④ | cost on the triggered subset | published | 96 queries on the 33 cases that were probed; `calls.mean` **4.92 against 4.94**; `promptChars` **20,422 against 20,553** |
| ⑤ | the free half, priced apart | reported | `grounded` **4**, `adoptedFree` **4** |

**The mechanism did exactly what it was built to do.** On the 50 questions the diagnosed arm
retried, 33 had a literal the columns do not store as written, the lookup spent 96 queries and no
calls on them, four were settled by a case-only grounding, and all four were adopted without
spending the turn — three fewer calls than the control spent on the same population. The turn that
did fire recovered 20 cases against the control's 19, and 8 of those 20 were correct against 6 of
19. The triggered subset moved **9 correct against 6**, which is where the 17.6% comes from.

**Why that is not a gain.** The full split moved by zero because 18 questions moved one way and 18
the other. That is the signature of sampling, not of a lever: the two arms generate their own three
candidates at temperature 0.7, so every question is a fresh draw and a paired difference under 1pp
is indistinguishable from redrawing. The +3 on the triggered set and the −3 elsewhere are the same
three cases' worth of noise.

**The criterion that was wrong.** ③ was written as "no change on the 96.2% that never trigger",
which is only meaningful if the two arms see the same candidates. They do not: `select-mixed`,
`select-mixed+empty` and `select-mixed+values` each generate their own trio, so 31 of 1,479
untouched questions differ by construction, and no implementation could have satisfied the bar.
The correct form of that check is an A/A pair or a shared pool — `pool` reuse exists for exactly
this reason — and it is now written that way in the plan rather than left as a bar that fails for
a reason unrelated to the code.

**What the artifact also says, for free.** The empty filter itself is worth **+6 cases** here
(967 → 973, 24 up / 18 down, p = 0.4408) — smaller than the +12 measured on the previous full
split, and the same sign. The two readings bracket a real but small effect; neither resolves it,
and the filter costs nothing, which is why it stays.

### Verdict

The lookup is kept as a **reported state**, not as a repair. On this split the zero-row state is
3.3% of the corpus (50 of 1,532 — the 496-question pilot said 3.83%), of which the deterministic
half settles 4 cases and the paid half buys 3, against a bar of 25% of the population. The 3.85pp
ceiling is therefore claimed by **dropping the state and saying so**, which is what the adopted arm
already does by removing empty candidates before the vote.

Two things would change that verdict, and neither is a tweak to the message:

1. **The `absent` bucket is the whole population.** 33 of the 50 triggered questions wrote a literal
   no value contains, and a literal that does not exist cannot be repaired by quoting. Quoting the
   column's most frequent values instead of the matched ones is a different lever — it changes what
   the prompt says about the schema rather than what it says about the statement — and it is priced
   in the plan as `I-95`, not folded into this one.
2. **The state is rare.** 3.3% of the split, at 0.038 calls a case, cannot move the full split by
   more than 1pp even if every triggered case were repaired. The lever's ceiling was always
   3.85pp; what this run shows is that the reachable part of it, with the taxonomy that actually
   occurs, is 0.2pp.

## The instrument could not see the block, so the block's price was a rumour

Every number in the section above about the stored-value block's cost — **+38.4% of the card** for
the wide sampler, **+1.4%** for the sampler narrowed to the gold's filtered columns — was quoted in
two source comments and in `docs/architecture.md`, and none of them had a reproducing instrument in
this repository. `bench:bird:card` is the instrument that exists for exactly this question: it
renders the prompt an arm sends, block by block, using the function the pipeline uses. It was
rendering the **parent's** card.

The defect is one call that was not made. `promptOf` built the schema, attached the generated
definitions, pruned — and never attached the stored values, while `buildAskMessages` was told
`samples: arm.samples !== undefined`, which renders a bracket only where a column carries one. So an
arm whose whole lever is the block arrived at the renderer as its parent, and the report said so in
the only way that is impossible to argue with:

| report | arm measured | mean card characters |
|---|---|---|
| `eval/out/card-select.json` | `select` | 2,121.4 |
| `eval/out/card-inline+evidence+samples-gold.json` | `inline+evidence+samples-gold` | 2,121.4 |

Two arms, two names, one card, to the tenth of a character. The two arms' *parents* do share a card
by construction — `select` is `inline+evidence` plus two samples and a selector — which is what makes
the identity evidence rather than coincidence: the block should have added **+1.4%** on the arm that
narrows to the gold's columns, and it added nothing at all. A lever the instrument cannot see is a
lever it prices at zero, and this repository had already published a ceiling for that lever — the
`samples` family closed at +0.72pp — so the wrong number was not the verdict, it was the *price*.
The verdict rests on the accuracy reading, which is measured by the run and not by this instrument.

### The fix

`storedValuesFor(arm, db, layout)` reads the cache the run itself writes: the profiler's per-database
JSON for `samples: 'profile'`, the competitor-rule cache for `samples: 'example'`. `promptOf` layers
that map on the resolved card **before** the prune, in the order the run layers it, and narrows it
with the same `conditionColumns` the oracle arm uses. Two refusals keep the fix from becoming a
quieter version of the bug: a cache the run never wrote **throws** — an empty map renders the
parent's card, which is the defect — and an example set written by another rule than the pinned one
throws too, because a stale block is not the block the arm would send. `bench:bird:join` reads the
same block through `blockReader`, and `bench:bird:info` — which builds its own prompt and had the same
blind spot in its own renderer — reads it too, so the three instruments cannot come to disagree about
which card an arm sends, which is the shape of every defect in that file's history.

### What the block costs, re-derived

The fixed instrument, over the 500 Mini-Dev cases and all eleven databases (profiles built locally,
no model call, no query the run would not have made):

| arm | mean card chars | vs parent | cases carrying a bracket |
|---|---|---|---|
| `inline+evidence` | 1,479 | — | 0 |
| `inline+evidence+samples` (wide) | 2,047 | **+38.4%** | 451 of 500 |
| `inline+evidence+samples-gold` (narrowed) | 1,499 | **+1.4%** | 185 of 500 |

The number the comments quoted is confirmed to the tenth of a percent, and the arithmetic behind the
family's closure is now reproducible rather than inherited: the wide block costs more than a third of
the card, and the narrow one is cheap because it is an oracle.

**One denominator note, because the percentage is not portable and the characters are.** The base
above is the schema card *without* the generated definitions block. On an artifact whose inline arm
carries them the same card is 2,121.4 characters, so the same 568 characters of block are **+26.8%**
rather than +38.4%. The block's size is a property of the schema — 568 characters a case, 451 of 500
cases — and the percentage is a property of whatever else is on the card. Quote the characters when
the claim has to travel, and the percentage only against the base it was measured on. The command that reproduces it is a
dispatch carrying both arms — `BIRD_ARMS=inline+evidence,inline+evidence+samples pnpm bench:bird`
then `pnpm bench:bird:card --arm inline+evidence+samples` — which is why the arms stay in the
catalogue even though the family is closed.

## `I-95` closes on the readings it was meant to produce

The previous section ended with a plan item: 33 of the 50 zero-row questions wrote a literal no value
contains, so the repair is not a better message about the statement but a card that says what the
column actually stores. That item was `I-95`, and its four criteria were registered before any arm
was written: ① triggered accuracy ≥ 25% (baseline 17.6%), ② the full split ≥ +0.96pp, ③ the same
candidates as `select-mixed+values`, ④ card growth ≤ 5%.

The lever it describes is the `samples` family. The family's registered ceiling already ran
(`41620796848`, 1,532 dev questions, three arms in one artifact):

| arm | passed | accuracy | vs `inline+evidence` |
|---|---|---|---|
| `inline+evidence` | 933 | 60.90% | — |
| `inline+evidence+samples` | 952 | 62.14% | +1.24pp, 61 up / 42 down, p = 0.0756 |
| `inline+evidence+samples-gold` | 944 | **61.62%** | **+0.72pp**, 36 up / 25 down, p = 0.2000 |

And the cost table above puts the two forms on opposite sides of criterion ④: the wide block is
+38.4% of the card where 5% is allowed, and the narrow block — which passes ④ at +1.4% — is an
**oracle**, so no realizable column rule can beat it. Its reach is 511 of 1,532 cases (1,021 cases
have a gold that filters on no column this profiler keeps), and where it lands it is worth
**+1.76pp**, which is **9 questions**, which is **0.59pp of the split** against criterion ②'s 15
questions.

| criterion | threshold | what is already measured | verdict |
|---|---|---|---|
| ① the ceiling is worth having | triggered accuracy ≥ 25% | the oracle of this lever reads +0.72pp at p = 0.20 on the whole split | fails |
| ② the split moves | ≥ +0.96pp | the narrow form's reach buys 0.59pp at its own measured rate | fails |
| ③ same candidates | stock pool | a card change cannot reuse draws; the criterion is unsatisfiable as written, as 8i's ③ was | mis-specified |
| ④ affordable | ≤ 5% card growth | wide **+38.4%**; narrow +1.4% but an oracle, so it prices a rule nobody can write | **fails** |

**Verdict: closed without a dispatch.** The 3.85pp that the zero-row census opened is not reachable
by showing values, and this is now the second time the repository has priced value grounding and
found the same answer — the first time by candidate source (+2.82pp ceiling, +1.24pp read), this time
by card block (+0.72pp ceiling). What remains true is the diagnosis: 33 of 50 triggered statements
named a value that does not exist. A lever that reaches them has to change what the model *does*
with an unknown literal, not what the prompt shows it, and the candidate that could is a statement
whose filters are checked before it is written rather than after it returns nothing.

## The same endpoint, the same judge, the same questions: MAC-SQL is 4.8pp ahead

Every comparison with a competitor in this document until now has been a comparison of *published
numbers* — theirs produced by their harness, ours by this one, often on a different model and always
with a different executor and judge. This repository has one instrument that removes all three
differences: `competitor pipelines` checks out the competitor at a pinned commit, runs its own
inference against the same endpoint, and scores both pipelines' statements with `eval/bird/oracle.py`
and `judgeOfficial`. It existed for three rounds without ever being run against our *best* arm — the
first dispatch (`41169541647`) paired MAC-SQL with `metadata+evidence`, a single call, which answered
"is our cheapest prompt better than their pipeline" and not "are we".

`41856780841` answers the second question. 498 Mini-Dev questions asked, 496 judged (two excluded at
the source: `OperationalError: interrupted`), `deepseek-chat` at `api.deepseek.com/v1`,
`wbbeyourself/MAC-SQL` at `31a9df5e`, our arm `select-mixed` at 3.99 calls a case.

| pipeline | correct | accuracy | 95% interval |
|---|---|---|---|
| `wbbeyourself/MAC-SQL` @ 31a9df5e | 323 / 496 | **65.12%** | [60.8, 69.2] |
| `select-mixed` (this repository) | 299 / 496 | **60.28%** | — |

| paired reading | cases |
|---|---|
| both correct | 265 |
| only the competitor | 58 |
| only ours | 34 |
| neither | 139 |

**Δ = −4.84pp, exact McNemar p = 0.0160.** The instrument also prints `resolves: false` with
`needed: 3,640`, which is not a contradiction: p = 0.0160 rejects "no difference", and the split is
still too small to *size* the difference to the ±2pp the dispatch asked for. Both statements are true
and only one of them is the claim anyone wants.

**Run against the earlier pairing, the adopted arm closes 1.6pp of a 6.5pp gap.** `41169541647` ran
the same instrument on the same split and paired MAC-SQL against `metadata+evidence`:

| dispatch | our arm | ours | competitor | Δ | p |
|---|---|---|---|---|---|
| `41169541647` | `metadata+evidence` | 294 = 59.27% | 326 = **65.73%** | −6.45pp | 0.0027 |
| `41856780841` | `select-mixed` | 299 = **60.28%** | 323 = **65.12%** | **−4.84pp** | 0.0160 |

The competitor moved 0.6pp between the two runs on identical questions, endpoint and judge, which is
the scale on which the 1.6pp our stronger arm bought has to be read. Two 25-question probes preceded
these runs — `41162862386` (19:16) and `41854048432` (20:17, where an empty `limit` fell back to the
workflow's default) — and both pointed the same way with no resolution at all, 29.65pp of MDE on
twenty-five questions. They are recorded here so the four readings are one history rather than a
convenient pair. It is a real narrowing — the
paired discordance is 58 against 34 — and it is not a closing.

**What this changes.** Three things, and none of them is comfortable.

1. **Our published number and our comparable number are different claims.** `63.71%` on dev is the
   best this harness has measured for this repository, and MAC-SQL's published `59.59%` is on the
   same set of questions under *their* harness. On the one split where both pipelines were run by
   the same instrument, ours is **4.8pp behind**, not 4pp ahead. A leaderboard number compared with
   another leaderboard number is an assumption wearing a table.
2. **The gap is not the model.** Both pipelines called `deepseek-chat` at the same endpoint in the
   same run. Whatever MAC-SQL has that we do not is pipeline: its extractor picks the tables the
   question needs, its card carries value examples for every non-key column, its decomposer splits
   the question before writing, and its refiner reads execution errors. We have priced each of those
   as a separate lever — `samples` +1.24pp, `decompose` −1.1pp, `audit` +1.01pp — and the sum of the
   readings is smaller than the gap, which says the levers were never the same thing as the pipeline.
3. **Mini-Dev is not dev, and that is now a hypothesis with a size.** The split's databases are
   truncated to 500 rows a table, which changes value distributions, cardinalities and what a join
   returns. Our pipeline reads values through the profiler and the value index; theirs reads a
   pre-generated dictionary. A 4.8pp disadvantage on this split and a 4pp advantage on published dev
   numbers cannot both be about method until one of them is measured on the other split, and the
   instrument that would do it — a `split` input on the competitor workflow — is the next dispatch's
   first line of work.

## The fourth call, retired by its own candidates

`I-96`. Every published selector reading in this repository was taken with the same shape: three
candidates, and a fourth call that reads them and answers with an index. The instrument that prices
the *rules* (`bench:bird:consensus`) had been saying for three rounds that the call was not paying
for itself — `shortest` scored 63.64% against the selector's 62.79% on 1,532 dev questions, and
63.71% against 61.42% on the strong pool (+2.29pp, p = 0.0030, 38 wins 19 losses). The product kept
the fourth call anyway, and it was right to: a rule reading taken from an artifact is a
**derivation**. It applies the rule to the candidates a previous run recorded, and it is only right
if a future run draws the same candidates and ranks them the same way.

So the delivery is not another selector. It is the derivation turned into a measurement.

- `Strategy.selector` became one name — `'none' | 'first' | 'shortest' | 'modal' | 'model'` —
  instead of a boolean plus a rule, because the pair allowed the state "a selector that is also a
  rule", which no executor can honour.
- `aimed-3` is three calls with `shortest`; `aimed-4` keeps the fourth call and the model. The
  retired configuration stays in the table, because the reading that retired it is one split on one
  backbone and a strategy that can be re-run is what keeps a finding falsifiable.
- `admissible` now gates only `aimed-4`: the rule reads executed rows, so there is no reply format
  it can fail, and a gate about a call a strategy does not make is a gate about the wrong strategy.
- `select-mixed-rule` runs it end to end — same three prompts, same card, same candidates, same
  judge, one call less — and writes the slot the rule took on every case (`selectedByRule`), which
  is what lets the run and the offline device be checked against each other instead of beside each
  other.

### What the run says

`41947376305`, both arms in one dispatch, 1,532 dev questions, `deepseek-chat`, `eval/bird/oracle.py`
executing and `judgeOfficial` judging:

| arm | calls / case | correct | accuracy | ceiling | prompt tokens / case |
|---|---|---|---|---|---|
| `select-mixed` (the model chooses) | **3.996** | 967 | 63.12% | 67.04% | 3,539 |
| `select-mixed-rule` (`shortest` chooses) | **3.000** | **980** | **63.97%** | 66.91% | **3,137** |

**+13 cases, one call less, and 11.4% fewer prompt tokens.** Question-paired, that is +0.85pp
(50 wins, 37 losses) at exact McNemar p = 0.1980 — under this artifact's own resolution of 1.71pp,
so the *sign* is all this run establishes about superiority. What it establishes about cost is not
statistical: the fourth call is gone (3.996 → 3.000), the bill fell with it, and the candidate
draws are the same three prompts.

The pre-registered criterion was stricter than the reading: **① paired ≥ +0.5pp at p < 0.05**. On
the same pool that criterion is +0.65pp at p = 0.2820 (40:30, `shortest` 63.77% against the
selector's 63.12% on the parent's own candidates), and on the arms it is +0.85pp at p = 0.1980.
**① is not met, and it is recorded as not met.** The decision to ship the rule rests on the reading
this instrument exists to produce — a call-free rule within the split's MDE of the paid one, which
means the paid one buys less than the split can resolve — plus the one reading that was
significant, the strong pool's +2.29pp at p = 0.0030. ②③④ are met: 3.000 calls, the whole 1,532
questions, and the fallback exercised on **53 cases where every candidate returned nothing** (the
rule still decided, which is what makes it a total function rather than a rule with a hole).

**The two instruments agree exactly, and that is the reading this round was built for.** Handing
the rule arm's own artifact back to `bench:bird:consensus` reproduces its score case for case:
`shortest` 63.97% against the arm's 63.97%, **0 won, 0 lost, p = 1.0000** on all 1,532. A rule that
the offline device prices and a rule the pipeline runs are now the same object, measured on the same
candidates — which is the difference between a derivation and a measurement.

| check | what it would have caught |
|---|---|
| `assertRuleSelection` | a rule with no candidate set, or a rule declared beside a lever only the model branch reads (`pairwise`, `judge`, `agreement`, `reconcile`, `sourcesVisible`, `dissentVerify`, `canonical`) — priced and never run |
| `assertReportComplete` | a rule arm whose row carries no funnel: its `calls.mean` equals the candidate count whether the rule ran or the vote did, so nothing else can say the lever acted |
| `BIRD1` | a rule arm that reports more calls than candidates (a four-call arm wearing the rule's name) or prices decisions it never bought (a bill copied from its parent) |


## The bucket that was going to be the lever, split by where its value went

The attribution reading on dev left one lever standing: in 61 of the 166 questions MAC-SQL wins,
their statement filters on a column none of ours names — **3.98pp**, the only bucket above the
split's 2.93pp resolution. Everything else in the round was aimed at it. The plan's next entry was a
gated audit: fire one extra turn only on the questions where the question itself betrays a condition
the statement never wrote, so the turn stops costing 100% of cases and starts costing 14%.

Two measurements were taken before any of that was built, and both of them closed the lever.

### First: the bucket is not what its name says

`bench:bird:conditions` calls a gold condition missing when the prediction names **no column** of it.
A column is not the only way to express a restriction, and the census now files every missing
condition by where its value went — `substituted` (some predicate compares the same literal against
another column), `absent` (nothing compares that literal anywhere), `unstated` (the atom carries no
literal, so no wording could have named it). On `select-mixed-rule`'s 552 dev failures:

| | cases | share of the 1,532 |
|---|---|---|
| failures carrying a missing condition | 226 | 14.75pp |
| — the value is compared on another column | 102 | 6.66pp |
| — the value is compared nowhere | 71 | 4.63pp |
| — the atom carries no literal at all | 126 | 8.22pp |

The three rows overlap by construction: a case can miss two conditions of different kinds. The
run of the *attribution* device, on the population the 3.98pp came from, files the same bucket the
same way — and this is the reading that ends the lever:

| what the 61 condition cases actually are | cases | points |
|---|---|---|
| the same column, a different condition | **27** | **1.76pp** |
| the value compared on another column | 16 | 1.04pp |
| an atom with no literal (`IS NOT NULL` and friends) | 16 | 1.04pp |
| **the value compared nowhere** | **2** | **0.13pp** |

**The bucket that cleared the resolution contains 0.13pp of the finding it was named for.** The
largest part of it — 27 cases, 1.76pp — is a column we *do* filter, with a different operator or a
different value: that is the `literal` / `over-filter` family the taxonomy already had, measured
from the other side. Sixteen more are restrictions we express on a different column, which is schema
linking, and sixteen are null tests the question never states. A mechanism that "writes the missing
condition again" would be adding a filter to a statement that already has one in 43 of the 61 cases.

This is the same defect the round before last found in the taxonomy's own first version, one level
down: a reader that compares columns cannot tell *the restriction is absent* from *the restriction is
somewhere else*, and the difference is the whole population a repair could act on.

### Second: no question-side signal fits the budget

`bench:bird:gate` prices four signals that read only the question and the statement — no model, no
database — against the same 1,532 questions and the same reader. `cost` is what the gate would add to
the bill; `reached` is how many of the gap cases it fires on; `ceiling` is what a repair that always
succeeded on every reach would be worth.

| signal | fires | cost | reached | of the `absent` kind | precision | ceiling |
|---|---|---|---|---|---|---|
| `named-entity` — the question names something the SQL never mentions | 301 | 19.6pp | 83 | 42 | 28% | 5.42pp |
| `no-predicate` — the question wants a row and the SQL filters nothing | 74 | 4.8pp | 32 | 11 | 43% | 2.09pp |
| `cue-without-predicate` — a comparison and no predicate | 43 | 2.8pp | 23 | 7 | 54% | 1.50pp |
| `quoted-literal` — a quoted value the SQL never mentions | 26 | 1.7pp | 5 | 1 | 19% | 0.33pp |

The pre-registration fixed one number in advance: the intervention may cost at most **10% more calls
per case**, which on 1,532 questions is a gate that may fire on 153 of them. The widest reaching
signal fires on 301 — **2.0× the budget** — and even it is wrong about 72% of the calls it would buy.
The widest signal *inside* the budget reaches 32 cases, a ceiling of **2.09pp against a resolution of
2.93pp**: a repair that succeeded on every single case that gate finds could still not be read as a
gain on this split. That is not a small effect; it is an unreadable one.

Both failures have the same cause, and it is not the word list. A text matcher cannot separate *a
value written shorter* (`Alameda` for "Alameda County"), *a value split across columns* (`Kacey` and
`Gibson`), *a value attached to the wrong column* (the 16 substituted cases), and *a column-ish noun*
(`Reading`) from a value the statement never used. Each of those is a different mechanism, and the
corrected census above says the largest of them is not an omission at all.

**Verdict: `I-45`'s gated audit is not dispatched.** The pre-check was designed to cost nothing and
it saved a dispatch of about 12,300 model calls. What it produced instead is a cheaper and more
useful fact: the bucket it was aimed at is 0.13pp of the thing it was named for.

## A rule that came out of the same artifact, priced by re-execution

The audit family is dead, but the census's third row — 16 cases whose condition is a null test the
question never states — is not an omission a model can be told about: it is the engine's behaviour.
SQLite and MySQL sort NULL before every value, so a statement answering "the school with the lowest
average reading score" with `ORDER BY score ASC LIMIT 1` returns the school whose score is *missing*.
BIRD's gold statements say `AND score IS NOT NULL` next to the order; a model writing from the schema
has nothing to tell it that.

`bench:bird:rewrite` prices rewrites of the statement by executing them — the model calls in this
corpus are the expensive part, and a rewrite spends none. It re-executes every case's gold and its
recorded statement first, and requires the recomputed pass count to equal the arm's published count
exactly; a baseline that does not reproduce the score is refused rather than read.

`41947376305`'s artifact, `select-mixed-rule`, 1,532 questions: baseline **980 = 63.97%**, the
artifact claims **980**, agreement **1,532 / 1,532**.

| rewrite | fires | won | lost | broken | net | p | its own resolution |
|---|---|---|---|---|---|---|---|
| `null-order` — put the unknown values last in the sort key that decides a `LIMIT` | 80 | **6** | **0** | 0 | **+0.39pp** | 0.0313 | 0.40pp |
| `drop-limit-on-count` — drop a row cap when the question counts | 35 | 1 | **19** | 0 | **−1.17pp** | <0.0001 | 0.80pp |
| `integer-division` — scale an integer numerator by 1.0 | 17 | 0 | 0 | 0 | 0.00pp | 1.0000 | 0.30pp |

**Six wins and no losses, and the effect sits exactly on its own resolution** (0.39pp against
0.40pp): six discordant pairs are six coin flips and the design they imply can resolve almost exactly
what they bought. So the rule is not adopted as a *gain* — it is adopted on dominance: it costs
nothing, it loses nothing on 1,532 questions, and it is a statement of what the question meant. Its
value is a correctness fix that happens to also be worth six questions.

The other two rows exist to keep the suspicion honest. Dropping a row cap from a counting question
loses **19** cases to win 1 — "how many students does the school with the highest score have" is a
counting question whose cap is the whole point — and the integer-division trap, which the corpus
discussion treats as endemic, fires 17 times and changes nothing, because the statements that divide
already write `* 1.0` or `CAST`.

The instrument also caught a defect in the rule itself before it could ship. The first
`guardNullOrder` built its output by trimming the sort clause and re-splicing `LIMIT`, and emitted
`... ASCLIMIT 1` on **every** case it fired: 80 rewrites that do not run. The `broken` column is
what made it a one-line fix instead of an unexplained −0.39pp, and the rewrite now echoes the key as
the statement wrote it — the diff between the statement and its rewrite has one reason in it.

## The model as a variable: one name changed, and everything else held

Every published reading in this document was taken with `deepseek-chat`. The contract claims the
pipeline runs either family — a reasoning endpoint drops sampling, gets an output budget, and is not
asked to answer in one line — but *claiming* that is not *measuring* it, and "the stronger model is
better" had been an argument rather than a number for the whole life of the project.

The experiment is as narrow as it can be made. Same commit (`669f9c67`), same 1,532 dev questions,
same arm (`inline+evidence`, one call per question), same prompts, same judge (row-by-row execution,
no model), same concurrency, one field different: `LLM_MODEL`.

| model | family | passed | accuracy | A/A duplicate | harness noise | completion tokens/case |
|---|---|---|---|---|---|---|
| `deepseek-chat` | chat | 941 | **61.42%** | 933 = 60.90% | 0.52pp | 49 |
| `deepseek-reasoner` | reasoning | 884 | **57.70%** | 888 = 57.96% | 0.26pp | 500 |

**The reasoning model is worse, by 3.72pp, and the difference is not noise.** Paired: 127 questions
the chat model answers and the reasoner does not, against 70 the other way — exact McNemar
**p = 5.9 × 10⁻⁵**, on a split whose own resolution is 2.93pp. It is also the more expensive of the
two by an order of magnitude on the output side: 500 completion tokens per question against 49, for
3.72pp less accuracy. Input is unchanged (676 vs 700 prompt tokens), so this is not a prompt-length
effect — the two models were asked the same question in the same words.

### Where the 127 questions went

| the chat model answered, the reasoner did not | questions |
|---|---|
| `column-count` — the result had the wrong number of columns | **59** |
| `values` — the rows disagreed on a value | 68 |

And in the other direction the reasoner answers 70 that chat misses. The whole difference is those
two columns, and the larger of them is not a reasoning failure at all: **`column-count` failures rise
from 130 to 204 (+74)** while `values` failures *fall* from 461 to 444. The reasoning model reads and
filters better than the chat model and then returns **more columns than the question asked for** —
`select c.id, c.gender from ...` where the question asked for the gender.

That is a shape failure, and it is the one failure mode this harness has a name for. A statement
that returns an extra column is not a statement that misunderstood the question; it is a statement
that was never told, in terms its family honours, what the projection is. The chat model obeys the
instruction by habit. The reasoning model spends its answer budget explaining the query and treats
the result shape as a detail — and the instruction that was supposed to prevent this is written in
the register a chat model follows and a reasoning model reasons about.

### What this does and does not say

It does **not** say reasoning models cannot write SQL. It says that **on this pipeline, with these
prompts, the family difference is a projection difference**, and that a contract which adapts
sampling and output budget but not the *shape* instruction is only half adapted. The measured
population is exact: 59 of 127 losses are one fix away from being wins, and if all 59 converted the
reasoner would be at 61.55% against the chat model's 61.42%.

The next round was therefore pre-registered as a projection lever rather than a general "use a
stronger model" claim: the same 1,532 questions, the same arm, the same reasoning model, with the
output-shape instruction rewritten for the reasoning family — and the bar that `column-count` falls
without `values` rising. The section below reports what that lever returned; it returned a
redistribution. **That result also closed the shape-instruction line of enquiry**: the sentence this
paragraph reasoned to is a sentence an instruction cannot enforce, so the next question is not "what
should the prompt say" but "what did the statements actually do", and answering it needed an
instrument that did not exist yet.

## The projection rule: the bucket fell, and the bucket was a symptom

`inline+evidence+projection` is one rule line added to the prompt — same card, same hint, same one
call — asking for *exactly* the columns the question names rather than *fewer* of them:

> Select exactly the columns the question asks for, in the order it names them. Do not add an
> identifier column to make rows distinguishable, and do not add a column the question does not
> mention.

The rule costs 194 characters, or 7.0% of a 2,783-character generation prompt (+39 prompt tokens a
case, all of it inside the block every question of a database shares, so it is cache-resident). It
was paired in `PAIRS`, tested from both sides of the prompt, and dispatched with its parent on the
1,532-question dev split in one run (`42122026848`).

### What it returned

| | `inline+evidence` | `+projection` | Δ |
|---|---|---|---|
| passed | 941 (61.42%) | 939 (61.29%) | −0.13pp |
| `column-count` | 129 | **124** | −5 |
| `values` | 462 | **469** | +7 |
| gains / losses | — | 64 / 66 | exact McNemar **p = 0.93** |

The bucket moved, and the pre-registered criterion's second clause refused the reading: the rule
did not repair the failures it aimed at, it **moved** them. `bench:bird:pair` prints the movement
as a transition table, which is the only place it is visible — in the accuracy column, a repair and
a redistribution look the same:

| from | to | cases | share |
|---|---|---|---|
| `values` | `match` | 51 | 3.3% |
| `match` | `values` | 41 | 2.7% |
| `column-count` | `values` | **28** | 1.8% |
| `match` | `column-count` | **25** | 1.6% |
| `column-count` | `match` | 13 | 0.8% |
| `values` | `column-count` | 11 | 0.7% |

**77 cases changed shape to buy two net matches.** The rule moved 13 cases out of `column-count`
into correct answers and 28 out of it into `values`; it also broke 25 answers that were right. That
is churn an order of magnitude larger than the signal, and it is symmetric in both directions —
which is what `p = 0.93` says.

### Why this was predictable, and why the prediction was written down first

`bench:bird:width` had already priced the bucket by deleting the extra items from the select list
and re-executing: on 496 questions the bucket is 37 wide and 15 narrow, removing columns recovers
11 of the 37 — a **2.22pp oracle ceiling**, below the dev split's 2.30pp resolution — and **26 of
the 37 stay wrong with the right width**. A band whose majority is wrong at the right width is a
symptom band, and an instruction can only edit the symptom.

So the round was pre-registered with the bucket as its primary read and accuracy as a side note,
and the rule was rejected on the criterion rather than kept on a `−5`. The arm stays in the
catalogue as the ablation reference for projection rules: any future instruction of this shape has
to beat a measured redistribution, not a hypothetical one.

### What it points at — and what it does not

The 444 `values` failures in the model comparison are now the largest bucket, so the obvious next
lever is "show the model the stored values". `bench:bird:information` answers whether that lever has
anything to buy, with no model call: render the arm's own prompt, extract the filter values the gold
statement compares against, and class each one by whether the prompt already spells it.

It reported **0 cases** on the shipped arm until this round — the population was `candidateRecall
=== false`, which is the right question for a selector arm and an empty one for a single call, and
an empty reading about a population the artifact does not have is not a clean reading. Widening it
to "every wrong answer" on an arm with no pool gives the reading below, on the parent arm's 591 dev
failures:

| class | cases | share |
|---|---|---|
| `spelled` — the prompt already says it | **359** | 60.7% |
| `casing` — present in another case | 29 | 4.9% |
| `notation` — present in another notation | 11 | 1.9% |
| `absent` — not in the prompt in any form | **20** | 3.4% |
| `none` — the gold compares against no string | 172 | 29.1% |

Of 419 cases that compare against a string value, **60.7% had the literal in front of the model**.
A stored-value block can reach at most 60 of the 591 — **3.9pp of 1,532, as a ceiling** — and only
20 (1.3pp) are genuinely absent from the prompt.

So the `values` bucket is **not mainly an information deficit**, and the next lever is not "more
values": four fifths of the reachable cases are a column the model read and then failed to use —
the condition it wrote does not match the value it was shown. That is a different experiment from
the one this result was expected to promote, and it is the one the numbers recommend.

## What the prompt repeats, and what repeating it is worth

The cost page splits a prompt into rules, schema, context, hint and question, and the purpose table
splits the bill by what each call was for. Neither answers the question a budget actually asks:
**how much of what we send is the same bytes we sent a moment ago?** A provider that caches prefixes
bills that part at a fraction of list price, and whether a prompt is cheap depends on the *order* of
its text, not its length.

`bench:bird:cache` renders the messages the arm sends — with the same `promptOf` the run calls —
groups them, and takes the longest common prefix. Two levels, because caches have two: the bytes
every question of the split shares (the rules) and the bytes every question of one database shares
(the rules and the whole schema card).

`select-mixed`, dev, 1,532 questions:

| | characters | share of one generation call |
|---|---|---|
| the system turn | 2,569 | — |
| the user turn | 214 | — |
| **shared by every question of the split** | **283** | 10.2% |
| **shared by every question of the same database** | **2,374** | **85.3%** |
| one generation call | 2,783 | 100% |

Per database the prefix is between **96.0%** (`european_football_2`) and **78.1%** (`toxicology`) of
the system turn: the smaller the schema, the larger the share of the call that is the question.

What that is worth, in the unit the artifact already meters — 2,447 prompt tokens a case, of which
the generation call spends 2,035:

| | prompt tokens a case |
|---|---|
| at list price | 2,447 |
| if the per-database prefix were cached every time | **884** |
| | **−63.9%** |

Two things had to be right for that number to be true, and the first version of this instrument got
the second one wrong. It multiplied the *whole* bill by the prefix share and reported **83%** off —
which prices a selector call as if it carried the schema card, and the selector reads the candidates
and answers one digit. The discount lands on the generation call alone; 63.9% is the truthful
ceiling and 83% was the instrument measuring a prompt nobody sends.

The second thing is that a ceiling is not a discount. The endpoints had never been asked, so the
meter could not see one: `usage` carried `prompt_tokens` and `completion_tokens` and dropped
`prompt_cache_hit_tokens`, `cached_tokens` and `prompt_tokens_details.cached_tokens` on the floor.
A cost column built from that is a **list-price** column published as a bill. The meter now reads all
three spellings, carries `cachedTokens` per purpose, and writes `tokens.cached` into the artifact —
and writes **nothing** when no answer reported the field, because an endpoint that says nothing has
not said it cached nothing.

That distinction turned out to matter immediately. The same arm, one cheap dispatch later
(`42056604480`, `deepseek-chat`, 1,532 questions), and the endpoint had been reporting a cache all
along:

| | prompt tokens a case |
|---|---|
| list price (what this repository published until now) | 676 |
| what the endpoint reported cached | **484 (71.6%)** |
| what the bill actually is, at a cache rate of 0.1 | **240 (−64.5%)** |
| the ceiling, if the whole prefix were always cached | 157 (−76.8%) |

**103 of the 1,532 cases reported zero cached tokens** — the first request of each prefix is a miss,
and a dispatch of 1,532 questions over 11 databases pays that toll eleven times over.

So the deployment already keeps most of what the measurement said it could: **71.6% measured against
85.3% structural**, and the 13.7pp between them is cold misses plus whatever the endpoint does at its
own block granularity, which this instrument cannot see from the outside. What is left is **34.6% of
the bill** (240 → 157), and the discount already realised is **64.5%**, not the 76.8% the ceiling
promises: reading the ceiling as a saving overstates the win by 12.3 points of exactly the quantity a
budget is made of.

## Why a reasoning model can lose: the statements, and the literature

Everything this document said about the model comparison was read off **result sets**. `941` against
`884`, a McNemar test, and a bucket table — `column-count` 130 → 204 while `values` 461 → 444. The
sentence that followed, *the reasoner projects too many columns*, was an inference: a wider result
means a wider select list, and nothing more. The statements themselves were in memory while the run
happened and were **not written to the artifact**, so the inference could not be checked, refined, or
refuted. That is the same defect `failure-shape.ts` was written to remove, one layer up — its own
header says *the result set says "wrong", the statement says "why"* — and the artifact kept only the
first half.

This round fixes the artifact (every case now records `sql` and `gold`) and adds the instrument that
reads them (`bench:bird:reasoning`, no model call). Before the reading lands, the prior has to be
stated, because "a reasoning model lost" is not an anomaly the literature treats as surprising.

### What the literature already knows

| Source | Finding | What it predicts here |
|---|---|---|
| **Inverse Scaling in Test-Time Compute** ([arXiv:2507.14417](https://arxiv.org/abs/2507.14417)) | Longer reasoning **actively degrades** accuracy on simple tasks across nine frontier models; failure modes include fixation on irrelevant context and unfocused exploration. | A longer generation should correlate with a *wider* answer, not a narrower one. |
| **Arctic ExCoT** (Snowflake) | Out-of-the-box CoT is *"negligible or even degraded"* on SQL generation versus direct generation on BIRD-dev. | The family gap on this benchmark is the expected sign, not a broken harness. |
| **AutoThinkSQL** ([arXiv:2607.22622](https://arxiv.org/abs/2607.22622)) | CoT introduces *syntactic noise and hallucination* that direct generation does not; CoT-only models are unstable under greedy decoding. | Extra structure in the thought should surface as extra structure in the statement. |
| Small-model study (AAU, BIRD/Spider ablation) | On BIRD, CoT is *"less helpful"* than on Spider, and few-shot is actively harmful. | The effect is benchmark-shaped: BIRD's wide schemas reward brevity. |

None of these says a reasoning model is worse *at reasoning*. They say the extra tokens are spent on
context that the answer does not need, and that the spend is billed as accuracy on this benchmark.

### Three hypotheses, each with a reading that can fail

The instrument prints three quantities, and each corresponds to a claim that could be wrong:

| Hypothesis | Reading | Refuted when |
|---|---|---|
| **H1 — carried, not invented.** The wider answer projects columns the statement had *already named* in its own filter, grouping or ordering: the model read them, then carried them out. | `extra` items split into `carried` (named elsewhere in the same statement) and `invented` (named nowhere). | `carried / extra` is the same in both arms — then the difference is volume, not kind, and a projection rule is the wrong repair. |
| **H2 — dose and response.** Within one model, more generated tokens predict a wider answer. | `generated tokens: mean` on wrong answers against right ones, per arm. | The reasoner generates *more* on its *correct* answers than on its wrong ones — then length is not the mechanism. |
| **H3 — shape, not knowledge.** The extra columns sit on statements whose `values` were right. | The `wider than gold` count restricted to failures whose other clauses match the gold. | Widening co-occurs with wrong values at the same rate — then it is a symptom of a wrong query, not a cause. |

H1 is the one the projection rule assumed and never measured: if the extra columns are mostly
*carried*, a rule that says "fewer columns" competes with a model that has already decided the column
matters; if they are mostly *invented*, the repair is schema linking and no sentence in the prompt
touches it. The projection rule's measured redistribution (77 cases changed shape for two net
matches) is consistent with either, which is exactly why it could not be kept.

### What the instrument reads, and what it refuses to

`bench:bird:reasoning <artifact.json> [more.json…] --arms <a>[,<b>]` prints one line per quantity with
both arms side by side:

```
                          deepseek-chat inline            deepseek-reasoner inline
  scored statements       …
  select *                …
  wider than gold         …
  the same width          …
  narrower than gold      …
  extra items             …
    of which carried      …
  missing items           …
  generated tokens: mean  …
    on wrong answers      …
    on right answers      …
```

Five decisions are worth naming, because each one is a way the tool could have lied:

1. **`select *` is counted separately.** A wildcard has no item list to compare. Counting it as "wide"
   would credit the model with a projection it did not write; inventing an item for it would put a
   guess in a column of measurements.
2. **`count(*)` is not a wildcard.** It is the narrowest possible answer to "how many", and reading it
   as the widest would invert the sign of the finding on every aggregate question.
3. **A reply that is not a statement is an empty projection, not a match.** The parser treats
   everything after a missing `select` as one item, which read a prose apology as a one-column
   answer — the same mistake as filing "the endpoint said nothing" as "it said zero".
4. **`carried` and `invented` are counted separately**, because they are different repairs.
5. **Generated tokens, not characters of the answer.** On a reasoning endpoint the chain of thought
   is billed as completion, so `completion_tokens` measures the same thing on both sides. `0` is a
   measurement; an absent block is the other measurement, and the table says "not reported".

Two artifacts are accepted rather than refused, unlike `bench:bird:pair`: the endpoint is chosen per
run, so two models are always two files. The pairing is by question id, the columns are labelled by
the model the artifact recorded, and the run-to-run displacement is the one the A/A copies measure —
not something this file invents by joining.

### The reading

Two dispatches on the same commit (`4eb9e0a9`), the same 1,532 questions, the same arm, the same
judge — only `LLM_MODEL` changed (`42138948702`, `42142701511`):

| | `deepseek-chat` | `deepseek-reasoner` | Δ |
|---|---|---|---|
| passed | 939 (61.29%) | 896 (58.49%) | **−2.80pp** |
| `values` | 462 | 432 | **−30** |
| `column-count` | 131 | **204** | **+73** |
| `select *` | 7 (0.5%) | 13 (0.9%) | +6 |
| **wider than gold** | 100 (6.5%) | **183 (12.0%)** | **+83** |
| the same width | 1,350 (88.1%) | 1,250 (81.8%) | −100 |
| narrower than gold | 75 (4.9%) | 83 (5.4%) | +8 |
| extra items | 976 | 1,148 | +172 |
| &nbsp;&nbsp;of which carried | 323 (33.1%) | 387 (33.7%) | **p = 0.78** |
| generated tokens: wrong | 58 | **692** | ×11.9 |
| generated tokens: right | 43 | **333** | ×7.7 |

The A/A copy each run carries puts the instrument's own noise on the table: `inline+evidence#2` read
99 against 100 wider, 977 against 975 extra, 323 against 321 carried. **A reading of two is not a
reading of six.** The marginal counts are then paired by question and tested against exactly that
displacement in *The widening is a property of the model, not of the dispatch* below.

#### H1 is refuted, and that is the finding

`carried` is 33.1% of the chat model's extra columns and 33.7% of the reasoner's — Fisher exact
**p = 0.78**. The stronger model does not carry more of what it read; it adds the *same mix* of
carried and invented columns, only more of them (+172). So the projection rule was aimed at a
mechanism that does not differ between the two models: an instruction about *which* columns cannot
help a model whose column choices were not the thing that changed.

#### H2 holds, with an order of magnitude to spare

The reasoner spends **692** generated tokens on the questions it gets wrong and **333** on the ones it
gets right — a factor of 2.08 and a difference of 359 tokens. The chat model spends 58 and 43: the
same sign, a factor of 1.35, a difference of 15. Longer generation predicts a wrong answer, and the
stronger model's longer generation is a much stronger predictor.

#### H3 holds: the widening lands on answers that were already right

Of the 53 cases that went `match → column-count`, **49 (92%) are wider than the gold**. Restricting
to the 121 losses, 55 are wider and 59 are the same width — so roughly half the damage is not "a wrong
answer got wronger", it is **a right answer that was widened until it was wrong**.

The transition table, both models on the same questions:

| from | to | cases |
|---|---|---|
| `values` | `match` | 71 |
| `match` | `values` | 68 |
| **`match`** | **`column-count`** | **53** |
| `values` | `column-count` | 33 |
| `column-count` | `match` | 7 |
| `column-count` | `values` | 6 |

Net `column-count`: +73, of which 53 were previously correct and 33 previously wrong on values. The
reasoner is not losing the questions it could not do; it is losing questions it had already answered.

#### The widening is a property of the model, not of the dispatch

`100` against `183` is two marginal counts, and a difference of marginals is not the claim. Two
arms can differ in marginal width because they widened the same questions by different amounts, or
because they answered different questions — and on paired data only the questions the two sides
disagree on carry any information about which one is wider. So the counts are paired by question id
and tested the way every other claim here is: exact McNemar on the discordant pairs, a Wald interval
on the paired difference, and the resolution the design actually had.

A case enters the pair only when **both** sides produced a projection to compare. A wildcard on
either side is skipped and counted, because `select *` is not a wide list and not a narrow one, it
is the absence of a list; filing it as "not wider" would put a zero in the discordance the model
never asserted. The denominator is the intersection, which is why the rates below read `6.2%` where
the table above reads `6.5%` — the table counts each arm against everything it answered, and this
counts both arms against the questions they both projected.

| pair | questions both projected | wider only left | wider only right | left → right | Δ [95% CI] | exact McNemar | resolves |
|---|---|---|---|---|---|---|---|
| **chat → reasoner** | 1,515 | **7** | **95** | 6.2% → 12.0% | **+5.81pp [+4.50, +7.12]** | **p < 0.0001** | 1.87pp |
| chat → chat (A/A) | 1,523 | 5 | 8 | 6.4% → 6.6% | +0.20pp [−0.27, +0.66] | p = 0.58 | 0.66pp |
| reasoner → reasoner (A/A) | 1,514 | 43 | 45 | 12.0% → 12.2% | +0.13pp [−1.08, +1.35] | p = 0.92 | 1.74pp |

Three things follow, and the third is the one that changes the design of the next experiment.

**The difference is an order of magnitude outside the instrument's own noise.** The chat model's A/A
copy cannot exclude a widening shift of `0.66pp`; the reasoner's cannot exclude `1.35pp`. The
cross-model difference is `5.81pp` — 8.8× the wider of the two bounds. "The reasoner widens more"
is not a reading of six cases against two; it is a paired difference whose interval excludes zero by
more than four standard errors, on a design that could have resolved `1.87pp`.

**It is asymmetric in the direction the mechanism claims.** `95` questions the chat model kept at
the gold's width and the reasoner widened, against `7` the other way. A model that simply wrote
wider statements everywhere would produce a symmetric disagreement on questions that are hard for
both; this produces a one-sided one, and the side it lands on is the side H3 already named — answers
that were already right.

**The widening rate is stable within a model.** `12.0%` and `12.2%` on two dispatches of the same
endpoint, `6.4%` and `6.6%` on the other. Whatever produces the extra columns is a property of how
the family answers, not a property of one run's sampling — which is the thing a single-dispatch
comparison can never show and the reason both artifacts carry an A/A copy.

What this still does **not** establish is causation. It puts the widening on the model rather than
on the run, and it rules out the sampling explanation; it does not show that the chain of thought
*produces* the extra column, because the trace is not observable from outside the endpoint. That is
what the next experiment has to be an intervention on, and it is the only repair these numbers
leave: generate the statement in a context that does not contain the trace.

### 8u: split the thinking from the writing, and pre-register it

The section above ends on an intervention, and an intervention has to be registered before it is
run or its result is a story about whatever happened. This is the registration.

**The design.** Two arms, same prompt skeleton, same card, same two calls:

- `plan` — the chat model writes the plan, the chat model writes the statement (measured on
  Mini-Dev at 50.4% against its parent's 57.6%, −7.2pp, 63/27, p = 2 × 10⁻⁴: the ordered plan
  anchored the statement it was supposed to prepare).
- `inline+evidence+plan-cross` — the **reasoning** model writes the plan, the **chat** model writes
  the statement, and the writer's context contains no trace at all because the trace never leaves
  the endpoint that produced it.

The ablation pair is `plan → inline+evidence+plan-cross`: one lever, the author of the plan. A pair
against the shipped arm would move two levers — the plan's existence and its author — and the delta
would belong to neither.

**What it tests.** Not "is the reasoning model better". That question is answered: it is worse, by
2.80pp, and the paired reading says the worsening is a widening (`+5.81pp [+4.50, +7.12]` on
questions both arms projected, 7 discordant one way against 95 the other). What is untested is
whether the *reading* half of that model — the part that finds conditions and joins, where `values`
falls 462 → 432 — can be kept while the *projecting* half is discarded. `plan-cross` is exactly that
trade: the reasoning model decides what the query must find, the chat model decides what the answer
shows.

**The criterion, written first.** The arm ships only if it beats **both** parents on the same
1,532 questions:

| reading | bar | why this bar |
|---|---|---|
| accuracy | **> 939** (61.29%) | below the chat model, the extra call buys a worse answer than the free one; below 896 it is not even a hybrid |
| `values` | **≤ 462** | the reasoner's only measured strength is this bucket (432 against 462); a hybrid that loses it has kept the cost and dropped the benefit |
| `column-count` | **≤ 131** | the chat model's level. Anything above it means the widening survived the split, which refutes the mechanism rather than the arm |
| paired McNemar vs `plan` | one lever, so the delta is read against the plan written by the weaker model | a gain here is the plan's *author* talking, which is the only thing that moved |

**What would refute the mechanism.** If `column-count` stays above 131 while `values` improves, the
widening is not produced by the writer's reasoning trace — the split did not remove it, so it lives
in the prompt or the schema card, and the next instrument is the prompt rather than the pipeline.
If `values` does not improve, the reasoner's advantage was never in the plan, and the two families
are simply better at different things with no composition available.

**Cost, stated.** Two calls per question on 1,532 questions: 1,532 plan calls on the reasoning
endpoint (the expensive one, ≈ 6× the chat model's completion) and 1,532 statements on the chat
endpoint. The run also carries `inline+evidence` at A/A, because the comparison it is judged against
was taken on a different day.

### The reading: the split removes the widening and the accuracy with it

Dispatched as registered (`42175859623`), same commit as the arm table, 1,532 dev questions, chat
writing on every arm, `deepseek-reasoner` as the second model:

| arm | passed | accuracy | `column-count` | `values` | calls/case | completion tokens/case |
|---|---|---|---|---|---|---|
| `inline+evidence` (chat writes) | 937 | **61.16%** | 134 | 461 | 1.00 | 49 |
| `plan` (chat plans, chat writes) | 837 | **54.63%** | 141 | 554 | 2.00 | 162 |
| `inline+evidence+plan-cross` (reasoner plans, chat writes) | 841 | **54.90%** | 141 | 550 | 1.99 | **1,478** |

| ablation (one lever each) | Δ | discordant | exact McNemar | resolves |
|---|---|---|---|---|
| `inline+evidence` → `plan` | **−6.53pp** | 158 / 58 | **p = 6.8 × 10⁻¹²** | 2.69pp |
| `plan` → `inline+evidence+plan-cross` | **+0.26pp** | 95 / 99 | p = 0.83 | 2.55pp |

**The criterion fails on every clause, and the way it fails is the finding.** Accuracy 841 against a
bar of 939; `values` **550 against a bar of 462** — the arm did not keep the reasoner's one measured
strength, it lost the chat arm's; `column-count` 141 against a bar of 131.

The refutation clause in the registration said: *if `column-count` stays high while `values`
improves, the widening lives in the prompt*. Neither half happened, and the actual shape is the more
interesting one. **The split did remove the widening** — 141 against the reasoner's 204, within 7 of
the chat model's 134 — and the accuracy did not return: it fell to 54.9%, below both parents. So the
widening was never the thing that cost the 2.80pp. The trace is where the reasoner's accuracy comes
from; it carries the conditions it finds and the extra columns it projects in the same breath, and
removing the trace removes both.

**A better plan's author buys 0.26pp.** `plan → plan-cross` is one lever, and it reads 95/99 at
p = 0.83 against a design that resolves 2.55pp: the reasoning model's plan is worth nothing over the
chat model's plan, at 9× the completion tokens (1,478 against 162). What both plan arms share is the
6.5pp tax, and the full-dev reproduction of the Mini-Dev reading is exact in sign and larger in size
(‑6.53pp here, ‑7.2pp on 498 questions, 158/58, p = 6.8 × 10⁻¹²).

**What that closes.** The model-family gap is now closed on both sides of the obvious repair: an
instruction cannot reach the projection (`8s`, 64/66, p = 0.93) and a pipeline split cannot keep the
reading (`8u`, 841, −6.26pp against the chat arm). The remaining reading is the one the whole
exercise started from — a family that reads better and projects worse — and the product answer is
not to repair it but to **state** it: both families are supported, both are measured, and the
default stays the chat family because on this benchmark the trade is measurable and negative.

**Cost.** 1,478 completion tokens per question for 6.26pp less accuracy is a 30× bill for a
regression. The arm is not shipped; it stays in the catalogue as the measured price of separating
planning from writing.

### What this closes and what it opens

It closes the projection-rule line for good. The sentence "return exactly the columns the question
names" edits a choice the model makes *before* it writes the statement — inside a chain of thought
that the rule never sees — and the measurement says the mix of choices is unchanged, so the rule could
only shake the distribution. 8s's 77 cases changing shape for two net matches was the expected
signature of a rule operating downstream of the decision it meant to control.

It opens the only repair the numbers point at: **separate the thinking from the writing.** If the
widening is produced inside the reasoning trace, then the answer must be generated in a context that
does not contain the trace — a second call with the question and the card only, using the trace's
conclusion rather than its text. That is the implementable core of what AutoThinkSQL does by training
(route easy questions away from CoT) and what ExCoT does with execution feedback (keep only what the
engine confirms), and it is a one-arm experiment here rather than a fine-tuning job.

The three cases the reasoner produced no statement for are worth naming rather than rounding away:
they are `values` failures with an `errorKind`, so the arm made a call and the engine refused the
reply — 1,529 of 1,532 is not a coverage problem, it is three refusals.

## The `values` bucket, priced by re-execution: the literal family is 2.02pp, and half of it is free

Six levers aimed at this bucket have read null: `notes` (−0.8pp), `definitions`, `samples`
(+1.24pp, p = 0.0756), `samples-gold` (+0.72pp), `values`, `audit` (+1.01), and the projection rule
(a redistribution, 64 gains against 66 losses). Every one of them was a change to what the model is
shown. The bucket did not move, and the reason is now measured rather than argued: **the fact the
statement needs is not in the question.** `'East Bohemia'` against a column that stores
`'east Bohemia'` is a lookup failure, and no prompt contains the stored spelling unless someone puts
it there — which `samples` tried, for +1.24pp at p = 0.0756, on a split that resolves 2.30pp.

So this round priced the bucket with executions instead of a dispatch. `bench:bird:rewrite` gained
two rules and one ceiling:

- **`ground-case-empty`** — the literal grounding this project already had
  (`groundLiteralCase`), under its shipped gate: only when the statement returned nothing.
- **`ground-case-any`** — the same edit with no gate. A wrong-case value does not only return
  *nothing*: an `in` list, a `like` pattern or a loosely-typed comparison returns *some* rows and
  answers a different question.
- **`oracle-transplant`** — the ceiling, and the reason the two above are worth pricing at all:
  substitute one value the gold compares against the same column into the statement and re-execute.
  A product does not have the gold, so this can never ship; what it can do is say how much of the
  bucket is about the literal, which is the question six instructions failed to answer.

The instrument refuses to publish unless re-execution reproduces the arm's own score, and it now
also refuses to price a statement the engine refused (`unrunnable`, 26 of 1,532 on
`inline+evidence`, none on the shipped arm), because a rewrite of text that never ran is priced as
a rule defect that is not one.

**`select-mixed-rule`, dev, 1,532 questions, baseline 980 = 63.97% (artifact 980, agreement
1,532/1,532):**

| rewrite | fired | won | lost | broken | net | exact McNemar | resolves |
|---|---|---|---|---|---|---|---|
| `null-order` | 80 | 6 | 0 | 0 | **+0.39pp** | 0.0313 | 0.4pp |
| `drop-limit-on-count` | 35 | 1 | **19** | 0 | **−1.17pp** | <0.0001 | 0.8pp |
| `integer-division` | 17 | 0 | 0 | 0 | 0.00pp | 1.0000 | 0.3pp |
| `ground-case-empty` (shipped gate) | 6 | 3 | 0 | 0 | +0.20pp | 0.2500 | 0.3pp |
| **`ground-case-any` (no gate)** | 18 | **13** | **0** | 0 | **+0.85pp** | **0.0002** | 0.7pp |
| `oracle-transplant`* (ceiling) | 90 | **28** | 0 | 0 | **+1.83pp** | <0.0001 | 1.0pp |
| **union across adopted rules** | | **19** | | | **+1.24pp** | | |

`inline+evidence`, the same 1,532 questions, baseline 937 = 61.16%: `null-order` 5/0 (+0.33pp),
`ground-case-any` **18/0 (+1.17pp, p < 0.0001)**, the ceiling **31 (+2.02pp)**, and a union of
**24 (+1.57pp)**.

**Four readings, and the fourth is the one that changes the product.**

**The ceiling is small and it is real.** 28 cases — 1.83pp — is the entire literal family on the
shipped arm. Every statement in that family could have its value repaired and the arm would still
be 3.92pp behind MAC-SQL. That is a bound worth publishing precisely because it is unflattering: it
says the remaining gap is *not* in the values, which is where four rounds of suspicion pointed.

**Half the ceiling is reachable without a model.** 13 of 28 on the shipped arm, 18 of 31 on the
prompt arm, at zero calls, zero tokens, and zero losses. It is adopted on dominance rather than on
a gain — the same standard `null-order` was adopted on — and it is the first lever in this document
that fires on the failure mode it was aimed at instead of on a proxy for it.

**The gate costs ten wins.** Three against thirteen on the shipped arm, seven against eighteen on
the prompt arm: the assumption "a wrong-case value returns nothing" is false for two thirds of the
cases it excludes. The shipped gate was not wrong about the mechanism, it was wrong about the
population — and it was wrong in the direction that hides work, because an empty result is the only
state the harness had a name for.

**A ceiling is not a dispatch, and here it saved one.** The ceiling is 1.83pp against a resolution
of 1.00pp at the pairs it produced — so a *lever* aimed at literals would have been readable. It
would also have been a lever that had to invent the stored spelling, which is what `samples` did
for a null. The rule needs no invention: one `select distinct` per compared column, cached, and the
edit fires only when exactly one stored spelling matches ignoring case.

### The instrument found two defects on the way, and the second one was shipped

**`statementOf` did not read the `sql` field.** It read `predicted`, then the failure row, and the
artifact publishes the statement of every case as `sql` — so on every single-call artifact the
pricer silently dropped all 937 passing cases. Two consequences, and the second is the serious one:
every `pp` in the report was against the failures alone, and **`lost` could not be non-zero** —
a rule that breaks a correct statement had nowhere to show it. The first run after the fix read
1,532 cases instead of 595 and had a `broken` count on a rule that had been published as clean.

**`guardNullOrder` turned a runnable statement into an unrunnable one.** `order by alt desc nulls
last limit 1` was rebuilt as `order by alt desc nulls last IS NULL, alt desc nulls last`, which
SQLite refuses: the direction test reads `desc` at the *end* of a key, and the statement's own
`nulls last` sits after it, so the key was read as ascending. **The product ships this rule**, and
the case it broke was one the arm answered correctly — which is exactly the case the first defect
was hiding. One branch now refuses any key that already carries `nulls first`/`nulls last`, and the
`broken` count is zero again on both artifacts.

### What this changes, end to end

| | before | after | Δ |
|---|---|---|---|
| `select-mixed-rule` (arm) | 980 = 63.97% | — | — |
| + `null-order` + `ground-case-any` (adopted, disjoint) | | **999 = 65.21%** | **+1.24pp** |
| MAC-SQL, same split, same judge, same endpoint | 1,040 = 67.89% | | |
| **gap to SOTA** | **−3.92pp** | **−2.68pp** | **+1.24pp** |

The two adopted rules are disjoint on the shipped arm (the report prints that rather than assuming
it: `ground-case-empty` overlaps `ground-case-any` by 3 cases, which is the nested gate itself, and
it is not adopted separately). The 1.24pp is free: no call, no token, and one `select distinct` per
compared column.

**What this does not establish.** That a model could be prompted into grounding — six attempts say
no, and the reason is structural: the stored spelling is not in the question. That the rule
generalises past BIRD's casing conventions; on a store whose values are all lower-case the rule
fires more, not less, and on a case-insensitive collation it fires never. And that the remaining
2.68pp is reachable at all: the ceiling for the entire literal family is behind us now, so the next
lever has to be about *which rows*, not *which spelling*.

## `S1`: the contrast this document never ran, and the one it must

The correction at the head of the section above is a claim about the literature and about DeepSeek's
own documentation, not a measurement. It says the 2026 rounds compared a base model against its own
decoding mode and called the difference a difference of strength. The way to settle a claim like
that is not another re-reading of the artifacts. It is the experiment that was skipped.

**Two bases, one prompt, one mode.** `deepseek-flash` serves DeepSeek-V4.1-Flash-1017 at 284B total
and 13B active parameters; `deepseek-v4-pro` serves V4-Pro-0813 at 1.6T total and 49B active — a
5.6× width and 3.8× activation gap, and the largest gap this deployment can reach without changing
vendors. Both default to thinking **on**, so the mode is held constant by construction and the only
variable is the base:

| arm | `LLM_MODEL` | candidates | calls/case | what it isolates |
| --- | --- | --- | --- | --- |
| `S1-a` | `deepseek-flash` | 1 (`inline+evidence`) | 1 | the second-tier base, thinking on |
| `S1-b` | `deepseek-v4-pro` | 1 (`inline+evidence`) | 1 | the first-tier base, thinking on |
| `S1-c` | `deepseek-flash` | 3 (`select-mixed`) | 4 | does a selector change the conclusion |
| `S1-d` | `deepseek-v4-pro` | 3 (`select-mixed`) | 4 | the same, on the wide base |

The single-candidate pair runs first. It is the cheapest configuration in the repository (one call
a case) and it is the one where a base-model difference cannot be absorbed by a pool: with one
candidate there is no selector, no vote, and no disagreement to arbitrate, so the score is the
model's own number. The three-candidate pair exists to answer the second question — whether the
conversion collapse documented above is a property of the reasoning model or of *any* better pool,
and a first-tier base draws a better pool at a 4.4× price.

**The criteria are written before the dispatch, at 1,532 questions (MDE 2.30pp).**

1. `S1-b` beats `S1-a` on the whole split by **≥ 2.30pp** with exact McNemar **p < 0.05**. A
   first-tier base that cannot clear the resolution at 1,532 questions on a task this saturated is
   a result about the task, and it would have to be published as one.
2. Failures move out of `values` rather than out of `match`. The wide base's advantage should be
   visible on the bucket where the question needs arithmetic or a nested aggregate — the bucket
   where thinking has something to think about — and invisible on casing. If the gain lands on
   `match`, the extra parameters bought formatting compliance, not reasoning.
3. The selector's ceiling rises on `S1-d` and the conversion falls, in the same direction as the
   two-reasoner arm. That is the falsifiable half of the "the pool gets better and the judge likes
   its own answers less" story: if a first-tier base *also* loses conversion, the mechanism is the
   selector's, not the thinking mode's.
4. A/A on both: `S1-a` dispatched twice, `S1-b` dispatched twice, and the spread of each pair is the
   floor every number above is read against. The existing 3.3pp control spread was measured across
   arms drawn separately; it is not this floor, and this document has already been wrong once by
   assuming a control's variance transfers.

**What `S1` does not fix.** It does not make the retired aliases safe: `deepseek-chat` and
`deepseek-reasoner` still appear in `.github/workflows/bird-dev.yml` and in every historical
reading, and the migration is a separate change — `LLM_MODEL` moves to `deepseek-flash` and the mode
becomes a request parameter (`thinking: {type: "enabled" | "disabled"}`), which the provider does
not yet send. Until that parameter exists, mode can only be selected by alias, and an alias is the
thing this correction just showed cannot be trusted to mean the same base twice. The `servedModels`
column added today is what makes the migration checkable: after it, a run that says
`servedModels: {"deepseek-v4.1-flash-1017": 1532}` has proved what it ran on, and a run that says
two names has proved it should not be quoted.

### The reading, at one ceiling for both bases

`S1` was dispatched twice, and the first pair is the one that shows why the second exists. Four runs,
two bases, one prompt, 1,532 questions:

| run | base | per-call ceiling | passed | accuracy | cases with no verdict |
| --- | --- | --- | --- | --- | --- |
| `42223938003` | `deepseek-flash` | 120 s | 898 | 58.62% | 6 |
| `42268153728` | `deepseek-flash` | 300 s | 892 | 58.22% | 5 |
| `42230846912` | `deepseek-v4-pro` | 120 s | 913 | 59.60% | 109 (94 timeouts) |
| `42250903916` | `deepseek-v4-pro` | 300 s | 940 | 61.36% | 19 |

**At one ceiling the first-tier base wins by +3.13pp.** Paired 826/66/114/526, exact McNemar
**p = 0.0004**, Wald **[+1.42, +4.84]**; complete case +3.51pp (p = 0.0001) with the two sides'
attrition shares 0.91pp apart, so both denominators agree. At 120 s the same pair was +0.98pp
(p = 0.2926) — same questions, same prompt, same judge. The difference between the two readings is
the ceiling, and it is not small: 94 of the wide base's 1,532 cases were scored wrong because the
call was cut off, and raising the ceiling recovered 24 of them (25.5%) while the narrow base, which
never needed the extra time, moved 898 → 892 on re-sampling alone.

The correction decomposes without a residual: **48 = 27 + 15 + 6** — 27 cases from raising the
ceiling (24 recovered timeouts + 3 net re-sampling on 1,438 cases whose prompt was byte-identical),
15 the base difference as it read at 120 s, 6 the narrow base's own re-sampling. In other words
**a fixed ceiling had been understating the base difference by 2.15pp**, and it was doing so in
proportion to how slow the base is.

**What survives, and it survives exactly.** The claim that extra parameters buy projection rather
than arithmetic is not retired — it is sharper than it was. At one ceiling the `values` bucket is a
tie to the case (**425 vs 425**) and `column-count` falls **210 → 148 (−62)**, with cases carrying no
verdict rising 5 → 19. The 48-case difference is 0 from `values`, −62 from `column-count`, +14 from
unanswered. The wide base writes the right shape; it does not do the arithmetic better.

So of the four criteria registered above: **1 is met** at equal ceiling and was not met at 120 s;
**2 is not met, in the direction it was written to exclude** — the gain did not land on `values`, it
landed on width; **3 was not run**; **4 has one pair of it and not the one it asked for** — the
narrow base's 120 → 300 pair happens to be A/A on everything the criterion needs except the setting,
which does not bind for it (1 timeout at 120 s, 0 at 300 s): **+58/−64, −0.39pp, p = 0.6510, 7.96%
of the split changed verdict with the prompt held byte-identical**. That is the first measured
floor for a paired claim on this split, and it is why a 2.30pp MDE can be read at all.

### What the 425 arithmetic failures are made of

At one ceiling the wide base answers 61.36% and misses 592 questions. 425 of those are scored
`values` — the statement ran, the width matched, the numbers did not — and "the numbers were wrong"
is not a work item, so the bucket was split by re-reading the statements and re-executing them:

| cause | cases | share | what a fix would change |
| --- | --- | --- | --- |
| `filter-wide` | 102 | 24.0% | the predicate is too weak, or a join multiplied the rows |
| `predicate` | 82 | 19.3% | a condition atom the question implies is absent |
| `literal-missing` | 72 | 16.9% | a value the answer needs never appears in the statement |
| `filter-narrow` | 56 | 13.2% | the predicate matches nothing (the statement returns no rows) |
| `tables` | 51 | 12.0% | join selection |
| `aggregate` | 27 | 6.4% | which function answers the question |
| `literal-case` | 15 | 3.5% | the value is stored in another case |
| `projection` | 14 | 3.3% | which columns, in what order |
| `grain`, `window`, `unclassified` | 6 | 1.4% | — |
| `scale`, `equivalent` | **0** | 0% | — |

Two readings matter more than the table. **The `where` clause is 327 of the 425 (76.9%)**: the wide
base computes correctly and filters incorrectly, which is a different defect from the one the
bucket's name suggests. And **`scale` is zero** — "the aggregation happened at the wrong level", a
hypothesis this project has cited for months, does not occur once in four hundred and twenty-five
cases.

### One rule that costs no call, and the gate that was costing it half its wins

Re-executing every statement of that run prices an edit rather than an idea. The baseline
recomputes to 940, matching the artifact on all 1,532 cases, so the differences below are
differences between statements and not between two judges:

| rule | fires | won | lost | net | p |
| --- | --- | --- | --- | --- | --- |
| `null-order` (shipped) | 63 | 1 | 1 | +0.00pp | 1.0000 |
| `drop-limit-on-count` (rejected) | 26 | 0 | 17 | −1.11pp | <0.0001 |
| `integer-division` | 21 | 0 | 0 | +0.00pp | 1.0000 |
| literal grounding, **only after an empty result** | 9 | 7 | 0 | +0.46pp | 0.0156 |
| literal grounding, **no gate** | 22 | 14 | 0 | +0.91pp | 0.0001 |
| literal grounding, **as the pipeline runs it** | 22 | 14 | 0 | +0.91pp | 0.0001 |

The third and fourth rows are the same edit under two gates, and the difference between them is
what the gate costs: **seven cases, with no loss to show for it**. The edit replaces a literal with
the one spelling the column stores that equals it ignoring case; applied to every statement it wins
14 and breaks none, because a value written in another case does not merely return nothing — an
`in` list or a `like` pattern returns rows that answer a different question, and those are the cases
a gate on "returned nothing" never reaches.

The last row is the shipped function itself, and it matches the second: the narrower scanner behind
it — `=` and `in` only, since `like` is already case-insensitive and `between` on strings does not
occur in this split — loses nothing on these 1,532 statements. Precision is exactly 22 fires to 0
losses, which is the only reason a rule of this kind is allowed to ship ungated.


### How much of `where` is one clause away

The census above says `predicate` is 82 cases: statements whose filter is missing a condition the
question implies. A census counts *absences*, and an absence is not a repair — a statement missing a
filter is usually missing something else too, so the question "would writing the condition have been
enough" is a different question and needs a different instrument.

`oracle-predicate` answers it by moving the gold statement's whole `where` clause into the
prediction, unqualifying both sides first, and executing the result. It runs only where both
statements read the same single table — two tables make a bare column name mean two things, and a
spliced clause that is valid against a table the prediction never read would report a `tables`
failure as a `predicate` one — and the 3 cases it could not reach that way are printed rather than
dropped. It reads the gold, so it can never ship:

| ceiling | fires | won | lost | refused | net | p |
| --- | --- | --- | --- | --- | --- | --- |
| one same-column value, moved (`oracle-transplant`) | 87 | 26 | 0 | 0 | +1.70pp | <0.0001 |
| the whole filter, moved (`oracle-predicate`) | 83 | 20 | 0 | 3 | +1.31pp | <0.0001 |

**The criterion was written before the reading: under 54 cases (3.5pp) retires condition coverage as
the next lever.** It is 20. ~~Twenty of the eighty-two `predicate` cases are exactly one clause away
— 24% of the bucket~~ — of those twenty wins, **four** fall in the `predicate` bucket; the other
sixteen are `filter-wide` (7), `filter-narrow` (4), `literal-missing` (4) and `aggregate` (1), which
the join two sections below measures. So the bucket is 4.8% reachable rather than 24%, and the rest
of it is wrong in some second way that moving the filter does not touch. So condition coverage is not the next lever, and the budget moves to the two buckets that are
larger and have not been priced yet: `tables` (51 cases, join selection) and `literal-missing` (72
cases, which is a retrieval problem rather than a generation one — the value the answer needs is not
in the prompt).

Two things this reading does **not** say. It does not say the `where` clause is 20 cases of work: the
narrower reading, that `filter-wide` (102) and `filter-narrow` (56) are also `where`-shaped, stands
untouched, and the clause is still 327 of the 425. And it does not say a condition-coverage mechanism
would recover 20: the ceiling moves the *gold's own* clause in one edit, which no mechanism that
infers conditions from a question can do.

> **Correction.** The paragraph above says `literal-missing` is "a retrieval problem rather than
> a generation one — the value the answer needs is not in the prompt". That sentence was inferred
> from the bucket's name and never from the bucket's cases, and the next round's first act was to
> read them. It is wrong: the value is in the prompt for 18 of the 31 cases the bucket actually
> holds, and the 72 it held at the time contained 36 cases whose missing literals were all
> arithmetic constants. The section below is that reading.

### A bucket that was named after the wrong cause

The taxonomy's fifth rung is `literal-missing`, and the rung's test is `missingLiterals`: *did the
prediction write every literal the gold wrote*. That is the right question for a detector of a
swapped value, and it must count numbers — `where year = 2020` names a value and the number is how
the gold spells it. It is the wrong question for a bucket, because most numbers in a statement are
not values at all: `* 100` turns a ratio into a percentage, `case when ... then 1 else 0 end` counts
rows, `round(x, 5)` fixes a precision, `/ 4` averages quarters.

Reading the 72 cases the bucket held:

| what the missing literals were | cases |
| --- | --- |
| numbers only | **36** |
| strings only | 18 |
| both, or a `%` mask among them | 18 |

Not one of the 36 was a value the database stores. Every one was `100`, `1`, `0`, `5`, `3` or `4`,
and every one sat inside an arithmetic expression. Dev 62 is the shape: the prediction wrote
`frpm."Percent (%) Eligible Free (K-12)" < 0.18` where the gold wrote
`CAST(free_meal_count AS REAL) * 100 / enrollment < 0.18`, so the two statements differ in the
percentage and in nothing else — and the only literal the gold had that the prediction did not was
`100`. Filed as retrieval, that case asked for a value that was already in the prompt, and its real
defect — a different expression — was never counted anywhere.

Two consequences followed, and both were invisible while the bucket kept its name. The 41 cases that
were not value gaps were being counted as retrieval work, and the rungs below — `predicate`,
`aggregate`, `tables` — never saw them, because the literal test sits above all three.

The fix is a second test, `missingValueLiterals`, that reads strings only and skips a string
carrying `%`: a strftime mask or a `like` pattern is derived from the question rather than retrieved
from a column. That is the same scope `information.ts` states for its prompt-coverage classes, and
for the same reason — two instruments that disagree about what a stored value is will disagree about
how many cases need one. Numbers are not discarded; they go back to the ladder, and the case lands
in the rung whose fix would change it:

| bucket | before | after | Δ |
| --- | --- | --- | --- |
| `literal-missing` | 72 (16.9%) | **31 (7.3%)** | −41 |
| `predicate` | 82 (19.3%) | **104 (24.5%)** | +22 |
| `aggregate` | 27 (6.4%) | **38 (8.9%)** | +11 |
| `tables` | 51 (12.0%) | **59 (13.9%)** | +8 |
| everything else | 193 | 193 | 0 |
| `unclassified` | 2 (0.5%) | 2 (0.5%) | 0 |

The 41 re-filed cases land 22 / 11 / 8, and the three add up to 41 — no case was lost and none was
parked in `unclassified`, which is the accounting term a re-classification must not grow. Coverage
stays at 99.5% of 425.

**And then the bucket's own question became answerable.** Crossed with the prompt-coverage classes,
the 31 cases split like this:

| what the prompt says about the value | cases |
| --- | --- |
| spelled verbatim in the prompt | **18** |
| not in the prompt in any form (`absent`) | **7** |
| a different notation of it | 1 |
| the gold has no string value, so this axis does not apply | 5 |

Seven cases. A stored-value sample — the one lever a retrieval reading would justify — can reach at
most seven of the 425, which is **0.46pp** on 1,532 questions, against a measured pairing floor of
0.4pp and a 7.96% verdict-flip rate. That is not a lever, it is a coin. The retrieval reading for
this bucket is now closed on its own arithmetic, the same way condition coverage was closed one
round earlier on its ceiling.

Two numbers must not be confused here. `information.ts` reports "a stored-value sample can reach at
most 56" — that is 28 `casing` + 10 `notation` + 18 `absent` over the 592 failed cases of the arm,
and it is the right number for "how many failures involve a value the prompt does not spell". The
seven above is the same question restricted to the 31 cases of one bucket. Both are true, they answer
different questions, and the bucket-level one is the one that decides where to work next.

### Which bucket a ceiling actually reaches

A ceiling's wins are counted by the shape of one statement; a bucket is counted by the difference
between two. Until this round the pricer printed a total and threw its per-case rows away, so the
two could not be joined, and the sentence the last round wrote — *twenty of the eighty-two
`predicate` cases are one clause away* — was an inference from a numerator and a denominator that
were never the same set. `rewrite --write` keeps the rows now, so the question can be asked:

| ceiling / rule | won | `filter-narrow` | `filter-wide` | `literal-missing` | `literal-case` | `predicate` | `aggregate` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `oracle-transplant` (one value, from the gold) | 26 | **12** | 3 | 4 | 6 | **1** | 0 |
| `oracle-predicate` (the whole filter, from the gold) | 20 | 4 | **7** | 4 | 0 | **4** | 1 |
| `ground-shipped` (the rewrite the pipeline runs) | 14 | 7 | 0 | 1 | 6 | 0 | 0 |

**Four of twenty.** The ceiling that moves the gold's entire `where` clause repairs four cases in
the `predicate` bucket and seven in `filter-wide` — a bucket whose name says the statement returned
the wrong *number* of rows, which a filter can also cause. The two ceilings together reach 5 of the
104 `predicate` cases, which is 4.8%, and every one of the 26 value transplants lands somewhere
other than `predicate` except one.

This does not weaken the decision the last round took — condition coverage stays retired — but it
replaces the reason with the right one. The bucket is not 24% reachable; it is 4.8% reachable by the
strongest instrument we have, and the other 95% of it is wrong in a way that moving the gold's own
filter does not fix. A census can overstate a lever in two directions at once: by counting absences
as repairs, which the previous section measured, and by lending its total to a bucket it does not
belong to, which this one does.

It also redirects the budget, because the largest single share of ceiling-visible work is neither of
the two buckets the plan named. It is `filter-narrow`: the statement ran and returned nothing, and
12 + 7 of the 56 cases there are repaired by an edit that reads the data (a value spelled in the
wrong case) or the gold (one value transplanted). `ground-shipped` alone already holds seven of the
twelve, which is why the shipped rule's 14 wins are mostly a `filter-narrow` number wearing the name
of a value rule.

> **Correction.** The sentence above adds two win sets and calls the sum a share of the bucket. It
> is neither: the sets overlap, and neither is a measurement of whether an edit that *could* be made
> *repairs* the case. The next section measures both, and the number that survives is smaller than
> either — **seven** cases, not twelve plus seven.

## What `filter-narrow` is made of: sixteen spellings and forty-one column choices

The section above ends by calling `filter-narrow` the largest addressable share of the values
bucket, on the strength of a per-case join between a ceiling's wins and a rule's wins. A join of two
win sets cannot say what the bucket is made of, because it begins from the wins. `bench:bird:literals`
begins from the cases: it takes every `values` failure whose statement returned no rows, reads the
column each literal is compared against, and says **why the literal is not in it**.

The reading is on the dev split, arm `metadata+evidence`, run `42563674600` — the same artifact the
rewrite pricer reconciles against 1,532/1,532 below, so the two instruments are measuring one set.
Seventy-six cases returned no rows, and their comparison sites split four ways:

| kind | sites | share | what it is |
| --- | --- | --- | --- |
| `case` | 14 | 24.6% | the column stores one spelling equal to the literal ignoring case |
| `padding` | 1 | 1.8% | the column stores `0040` where the statement wrote `40` |
| `parenthetical` | 1 | 1.8% | the column stores `High Schools (Public)` where the statement wrote `High Schools` |
| `absent` | **41** | **71.9%** | the column holds nothing like it: the statement is filtering the wrong column |

Two numbers follow from the same table, and they are the point of the tool:

1. **Every case has more than one site.** The 76 cases carry 45 statements with at least one literal
   comparison and 57 sites between them; 31 cases compare no string at all (they filter numbers, or
   they filter nothing and lose their rows to a join). So a per-site repair is not a per-case repair.
2. **A site that can be edited is not a case that gets repaired.** Fourteen cases have at least one
   site whose literal the column can explain, thirteen have nothing but such sites, and the pricer —
   which re-executes and judges — repairs **seven**. The other seven are cases where the literal was
   one of several faults: `City = 'Monterey'` against a corpus that files the county in a column
   named `County`, `CharterNum = '40'` against `0040` with a second condition wrong, and so on.

### The same split on a second arm, because one arm is one reading

`literal-gap` starts from a `values` failure rather than from a candidate set, so it runs on any arm
— including the single-call ones, which publish no candidate ceiling and therefore cannot be handed
to `values-gap` at all. That is not a convenience: it is the check that the composition is a property
of the corpus rather than of one prompt.

| arm | `filter-narrow` cases | sites | `case` | `padding` | `parenthetical` | `absent` | repairable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `metadata+evidence` | 76 | 57 | 14 | 1 | 1 | **41 (71.9%)** | 16 (28.1%) |
| `select-mixed` | 53 | 41 | 7 | 1 | 1 | **32 (78.0%)** | 9 (22.0%) |

The better arm returns no rows on fewer questions (53 against 76) and its misses are *more* often
column choices rather than spellings — 78.0% against 71.9%. The two arms disagree about how many
cases fail; they agree about what the failures are made of, which is the only thing the composition
was ever asked to explain.

### The two edits this reading proposed, and what they were worth

The classifier named two forms of absence the shipped rule does not reach, and both were priced
rather than adopted, because a classifier that can name an edit is not evidence that the edit pays:

| rule | fires | won | lost | net | p | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `ground-padding` | 1 | 1 | 0 | +0.07pp | 1.0000 | below the split's resolution |
| `ground-parenthetical` | 1 | 0 | 0 | +0.00pp | 1.0000 | fires, repairs nothing |
| `ground-case-any` (shipped) | 24 | **16** | **0** | **+1.04pp** | <0.0001 | adopted |

Neither new rule loses anything, which is what their licence was designed to guarantee: both require
exactly one stored value that matches, and a second candidate makes the edit refuse. They are still
not adopted, because one case is what this split cannot resolve — and the parenthetical rule shows
why a zero-loss rule is not automatically a rule: it fires on question 26, edits `High Schools` to
`High Schools (Public)`, and the case stays wrong because the same statement also filters the wrong
column. **A rule can be correct and worth nothing at the same time.**

### What the bucket is, then

`filter-narrow` is not a predicate that is too tight. It is, for seven cases in ten, a predicate
aimed at a column that does not hold the value: the statement joined the right tables, filtered a
column of the right type, and compared it with a value the column has never contained. That is a
schema-linking failure, and it is the same failure the schema card prices at **+11.09pp** when the
card is cut to the columns the gold reads — which is now the only lever in this bucket with a
reading above the floor.

The seven cases the shipped rule does repair are real and free, and they are the reason the rule
ships. The other sixty-nine are the reason no further literal edit will move this bucket: an edit to
a literal cannot reach a statement whose literal belongs to another column, and 41 of 57 sites are
exactly that.

The reading is reproducible without a model call, which is why it exists at all:

```bash
BIRD_SPLIT=dev pnpm bench:bird:literals --artifact eval/out/bird-eval.json --arm metadata+evidence
```

It re-executes the artifact's own statements against the split's databases and writes
`eval/out/literal-gap-<arm>.json`. Two conditions fail the build rather than being printed and
ignored: an empty bucket, because `0 of 0` prints as `0.0%` and reads like a measured zero, and a
comparison site whose column could not be read, because classifying a literal against no values turns
"the column stores something else" into "the column stores nothing" — the one confusion the tool
exists to prevent.

### What each arm costs per point, on all 1,532 dev questions

An earlier section priced the arms on a 600-question artifact and found every multi-call arm
dominated. The same question is answerable on the split a product is judged on, from the artifact
`42563674600` that every reading in this section already uses:

| arm | calls | prompt tokens/case | accuracy | tokens per point over `inline+evidence` |
| --- | --- | --- | --- | --- |
| `names` | 1 | 522 | 42.04% | — (18.6pp cheaper and worse) |
| `inline+evidence` | 1 | **676** | 60.57% | baseline |
| `metadata+evidence` | 1 | 1,778 | **61.49%** | 1,198 tokens per point |
| `select` | 3.99 | 2,442 | 60.44% | **negative: 1.4× the tokens, 0.13pp worse** |
| `select-mixed` | 4.00 | 3,547 | **62.92%** | 1,222 tokens per point |

Two things the full split adds to the earlier reading. **`select` is dominated**: four calls and
1.4 times the prompt of `metadata+evidence` buy 1.05pp less accuracy, and there is no axis on which
it wins — which is the same finding the paired test reached from the other direction (`metadata+evidence
→ select` is −1.42pp ± 0.96 over nine Mini-Dev readings). And **the two single-call arms and the
four-call arm cost the same per point** — 1,198 against 1,222 tokens per point — so the selector's
four calls are not a different price for accuracy, they are the same price with four times the
latency. Neither sentence licenses spending the four calls by default; both say that if the
selector is kept, it should be kept for the 1.4pp it actually adds, not for an efficiency argument
that does not hold.

## The card is the prompt, and what is on it is worth 11 points

`card.ts` has priced the schema card in **characters** since the round it was written: 69.7% of the
prompt, 56.1% of it belonging to tables no gold statement reads. What it could not say is what any of
that is worth in accuracy. The literature says it is worth a lot — AskData measures perfect schema
linking at **77.4** against **71.2** for the same full schema with the same hint, on 500 questions and
one model — and this repository has been arguing about the replacement cost of a lever it never
priced. So the lever got an arm.

### The arm, and the one thing it changes

`inline+evidence+card-gold` keeps the tables the gold statement reads and the fields it names, and
nothing else. Same prompt, same hint, same inline definitions, **one call**, one lever:
`changedLevers(parent, arm)` is `['cardColumns']`.

Three rules decide membership, and each is stated rather than tuned:

- `alias.column` resolves the alias back to its table through the statement's own `from`/`join`
  references; a qualifier that matches no reference is dropped instead of guessed at.
- a name written without a qualifier is kept on every referenced table that has a column of that
  name. Over-keeping is the only direction a ceiling may err in — under-keeping would publish a lost
  field as a property of perfect linking, which is the thing being measured.
- a table the statement reads but whose columns cannot be attributed keeps all of them (`count(*)`),
  and a statement that reads no table keeps its card (`select 1`). An empty card is not a prompt.

### The reading (`42346556829`, Mini-Dev, 496 scored, `deepseek-chat`, 1 call)

| arm | passed | accuracy | chars/case | prompt tokens/case |
| --- | --- | --- | --- | --- |
| `inline+evidence` | 276 | 55.65% | 2,864 | 698 |
| `inline+evidence+card-gold` | **331** | **66.73%** | **821** | **194** |
| `inline+evidence#2` (A/A control) | 274 | 55.24% | 2,864 | 698 |

Provenance: `tokens.served` names `deepseek-flash` on every reply, which is what the `deepseek-chat`
alias resolves to at this endpoint — the arm names the alias, not the weights, and the artifact is
where the difference is visible.

| pair | delta | up / down | p (exact McNemar) |
| --- | --- | --- | --- |
| `inline+evidence` → `+card-gold` | **+11.09pp** | **71 / 16** | **2.0e-9** |
| `inline+evidence` → `#2` (A/A) | −0.40pp | 6 / 8 | — |

The funnel says the rule ran and how much it removed: **2,494 columns kept, 35,638 dropped, 0 cases
emptied** — 93.5% of the card, on every one of the 496 cases. The A/A control sits at −0.40pp, which
is this split's floor for a one-call arm, so the effect is not competing with it: the control moved
14 cases in total and the arm moved 87.

Four things follow, and the first one is not a claim about the product.

1. **Card content is the largest mechanism this repository has measured, and it is not a shippable
   one.** The arm reads the answer. What it prices is the ceiling of every realizable column rule —
   the linker we ship, a model asked to choose columns, a diff of two candidate statements — and at
   **+11.09pp** that ceiling is three times the largest prompt lever adopted so far (+3.6pp for
   attaching definitions to their columns).
2. **Smaller is not the same as better, and the two readings now say why.** `select-prune` shrinks the
   card by 13.5% and loses **1.50pp** (p = 0.035 on the full split), because its seeds drop 4.8% of
   the gold's tables. This arm shrinks it by 93.5% and gains 11.09pp, because it drops *no field the
   gold reads*. The variable was never size; it was whether the field is still there.
3. **It beats the best configuration this repository has published, with a quarter of the calls.**
   66.73% on 496 Mini-Dev questions at 1.00 calls against 63.0% for three prompt styles and a
   selector at 4.00. That is not a fair comparison — one is an oracle and the other runs blind — but
   it says where the headroom is: not in more opinions, in a better card.
4. **The model gap is now visible from the other side.** With a perfect card, GPT-4o reaches 77.4 on
   this split in the paper and `deepseek-chat` reaches 66.73 here. Their *full-schema* cell is 71.2.
   So a perfect linker on our model lands below a full schema on theirs, and the remaining distance
   to the top of the leaderboard is the author, not the architecture — which is the reading the
   leaderboard's single-model column already suggested at 80.04%.

### What this does not license

It does not license shipping a column filter fitted on the split, and it does not license reading the
11.09pp as achievable. The next measurement is the one that prices the distance: what fraction of the
gold's fields does a rule that never reads the answer actually name? The shipped linker is the first
candidate, `columnSelect` the second, and each has to be measured against this ceiling rather than
against its parent.

One process note, because it cost fourteen minutes of gate time. The dispatch went out two minutes
after the push and took the shared `bird-eval` slot from `ci.yml`'s Mini-Dev job, which had not reached
the group yet. The rule this round writes down: **a verification dispatch waits until the gate's own
BIRD job is queued or finished — "after the push" is not the same as "after the gate".**

## Same card, same size, one and a half right fields instead of five

The ceiling arm left one question open and it was the only one worth asking next: **93.5% of the card
can go while nothing the gold reads is lost, so what stops a rule that never reads the answer from
doing the same?** The answer needs no model call, and this round took it: `card.ts` now counts the
gold's **fields** — table and column together — and compares them with the fields the shipped linker
names.

### The reading (`bench:bird:card`, Mini-Dev 496, zero calls)

| quantity | value |
| --- | --- |
| fields the gold statements name | **2,494** (5.03 per case) |
| of those, fields the shipped linker names | **773 = 31.0%** |
| fields the linker names that the gold never does | **1,879** (precision 773 / 2,652 = **29.1%**) |
| cases where every gold field is named | **16 of 496 (3.2%)** |
| cases where some but not all are named | 364 (73.4%); 116 (23.4%) name none of them |

And the budget frontier, same recallers at four `topK` values:

| `topK` | gold fields named | fields kept per case | cases with every field |
| --- | --- | --- | --- |
| 12 (shipped) | 31.0% | 5.3 | 16 |
| 24 | 33.4% | 6.5 | 23 |
| 48 | 34.0% | 7.4 | 24 |
| 96 | **34.8%** | 8.0 | 25 |

An eight-fold budget buys **+3.8pp of recall**. The budget is not what limits the linker.

### The comparison that decides the next lever

| card | fields kept per case | of those, fields the gold names |
| --- | --- | --- |
| ceiling arm (`card-gold`) | **5.03** | **5.03** (all of them, by construction) |
| shipped linker at `topK` 12 | **5.3** | **1.6** |

The two cards are the **same width**. The ceiling gains 11.09pp not by keeping fewer fields but by
keeping the right ones, and the linker keeps the right number and the wrong list. Every reading this
document has published about the card has been about its size — 69.7% of the prompt, 56.1% of it on
tables the gold never reads, 13.5% saved by `prune`, 93.5% saved by the ceiling — and the one number
that was missing is the one that separates them.

Three consequences, in the order they are cheap.

1. **Narrowing the card to the linker's fields is closed, and it is closed by arithmetic rather than by
   a run.** Such a rule would drop 69% of the gold's fields on the average case and lose something on
   all but 16 of 496. `select-prune` already measured the direction — 13.5% of the card removed and
   **−1.50pp**, because its seeds drop 4.8% of the gold's tables. This rule removes 65% of the gold's
   fields. Nobody needs a dispatch to know what that is.
2. **The lever is the selection, not the size.** So the next arm does not remove anything: it keeps
   every field — recall 100% by construction — and changes only the **order** the card is read in,
   putting the linker's columns first. That is the one experiment that separates *removal* from
   *attention*: if order alone recovers a share of 11.09pp, then the ceiling's gain was emphasis and
   the linker's 29% precision never had to be good; if it recovers nothing, the gain was removal and
   only a linker with real field recall can reach it.
3. **`topK` is not a knob and will not be turned.** Raising it eight-fold moved recall 3.8pp and the
   card 2.6 fields, so a proposal to widen the hint is a proposal to spend characters for nothing.

### What the instrument guards against now

The field line can be wrong in a way that reads as a finding, so it is guarded the same way the rest of
this file is. `fieldTotal === 0` across a run is refused as a **broken reader** rather than published
as "the linker names nothing"; more than half the cases naming no field is refused as well, since no
corpus of statements produces that and a reader that stopped recognising gold SQL would. An
abstention is kept in its own bucket (`fieldEmpty`) instead of being counted as `none`: `count(*)`
names no column of the table it counts from, and the extractor's limit is not the linker's failure.
Precision is published beside recall for the same reason — a coverage number alone can always be
improved by naming everything.

### The ordering arm was registered, measured, and withdrawn before it was dispatched

Round 97's next step was going to be an arm that keeps every field and only changes the order the
card is read in — the one experiment that separates *removal* from *attention*, since the ceiling's
gain could be either. The instrument that prices it costs nothing, so it was built first and the arm
never ran.

| quantity | value |
| --- | --- |
| where a gold field sits in the card as sent | **41.2%** of the card's width |
| the same after ordering by the linker's score | **36.1%** |
| cases where the gold's fields moved earlier | 296 |
| cases where they moved later | **188** |

A five-point shift, and 38% of cases move the wrong way. Ordering can only promote the fields the
linker already names — that is the same 31% recall — so the 69% it never names cannot move at all,
and the cases that regress are the ones where the linker points at the wrong table: "total price of
every item" scores `orders.item_id` above `items.price`, so the table with the answer goes second.
Five points of position on a card the model reads whole is not a mechanism worth ~1,000 calls, and
the instrument said so before the dispatch existed.

The rule this round writes down is the one the round before needed: **an oracle prices a lever, and a
registered instrument still has to earn its dispatch.** The card-content ceiling is 11.09pp; the two
realizable routes to it are a different *set* of fields (needs recall the linker does not have) and a
different *order* of the same fields (needs a ranking signal worth more than five points of position).
Neither is available, so the lever's next measurement is neither — it is a selector whose field recall
can be stated in the same units as the 31.0% above.

## Which source reaches the fields, and what no linker of this kind can reach

The 31.0% ended the last round on a question it could not answer, and the question decides the next
three dispatches: **is the linker under-built, or has it run out of information?** A ranker that is
under-built wants a better ranker. A ranker that has run out wants a different input — an embedding
index, a model that selects columns, or training — and none of those is cheap enough to start on a
hunch.

`bench:bird:selectivity` answers it with zero model calls, by varying three things that are all local
and reading them in the same units as the 31.0%:

1. **The budget is a slice, not the linker.** The same recallers at `topK = 12` and with no slice
   differ by exactly the fields the cut removed.
2. **A recaller is an information source.** `name` reads the column's own tokens, `alias` reads the
   card's aliases, `value` reads the profiler's stored samples, `table` reads the entity. Opened one
   at a time they say where the misses live.
3. **The union of all of them, unsliced, is the ceiling of the family.** A field that union does not
   name is a field whose name, aliases, comments, values and table all never appear in the question.
   Nothing in the ranker can reach it, because there is nothing in the question to rank on.

```bash
pnpm bench:bird:selectivity eval/out/bird-eval.json --arm metadata+evidence
```

### The reading, on the card the pipeline ships (Mini-Dev 496, zero calls)

| selector | budget | card width | gold fields | recalled | share | precision | full coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `shipped` | 12 | 5.3 | 2,494 | 773 | **31.0%** | 29.1% | 16 |
| `shipped` | none | 8.0 | 2,494 | 869 | 34.8% | 22.0% | 25 |
| `name` | 12 | 5.3 | 2,494 | 773 | **31.0%** | 29.1% | 16 |
| `alias` | 12 | 0.0 | 2,494 | **0** | **0.0%** | — | 0 |
| `value` | 12 | 0.0 | 2,494 | **0** | **0.0%** | — | 0 |
| `table` | 12 | 8.7 | 2,494 | **899** | **36.0%** | 20.9% | 61 |
| `all` (four) | 12 | 9.7 | 2,494 | 1,266 | **50.8%** | 26.4% | 69 |
| `all` (four) | none | 28.1 | 2,494 | 1,693 | 67.9% | 12.1% | 175 |
| `all` + comments | 12 | 10.3 | 2,494 | **1,352** | **54.2%** | 26.5% | 89 |
| `all` + comments | none | 33.8 | 2,494 | **1,872** | **75.1%** | 11.2% | **209** |

Three rows are the answer, and the first two are a defect the document had been quoting around.

### The shipped set is `name` wearing two more names

`shipped` and `name` are **the same row**: 773 fields, 31.0%, precision 29.1%, 16 cases covered. They
are the same row because `Recaller` declares `'name' | 'alias' | 'value' | 'table'`, the shipped set
opens three of the four, and **two of those three have nothing to read**:

* `alias` reports 0.0% on every card, because no constructor anywhere in this repository ever sets
  `SchemaColumn.aliases`. The field exists in the type and nowhere in the data. The recaller is not
  weak; it is unwired.
* `value` reports 0.0% on this card because `samples` is only populated by the arms that ask for
  samples. It is not unwired, it is switched off — and the samples card below turns it on.

So the number this document has been calling "the shipped linker's recall" is the name recaller's
recall, and every statement about it should say so. That is the honest version of the 31.0%, and it
changes what a fix looks like: two of the three cheap fixes are to give the recallers an input rather
than to make the ranker better.

### `table` is the largest single source, and it was never in the shipped set

| selector | recalled @12 | share | card width | precision |
| --- | --- | --- | --- | --- |
| `name` | 773 | 31.0% | 5.3 | 29.1% |
| `table` | **899** | **36.0%** | 8.7 | 20.9% |
| both, plus the two unwired | 1,266 | **50.8%** | 9.7 | 26.4% |

The table recaller alone beats the name recaller by **5.0pp** and adding it lifts the union by
**19.8pp**, for **+4.4 fields per case**. It is the single largest reachable source and it is the one
the shipped set leaves out — deliberately, for a reason the code states: it was added after the corpus
was measured, and turning it on would have changed the hint every measured arm sends. That reasoning
is still correct for *changing* the shipped set. It is no longer a reason not to **price** it.

### `value` is the most precise source in the family

On the card that carries profiled samples (`inline+evidence+samples`, 498 cases):

| selector | recalled @12 | share | card width | precision |
| --- | --- | --- | --- | --- |
| `name` | 777 | 31.0% | 5.4 | 29.1% |
| `value` | **136** | **5.4%** | **0.9** | **32.1%** |
| `shipped` (name + the two unwired) | 850 | 34.0% | 5.8 | 29.2% |
| `all` (four) | 1,311 | 52.4% | 9.8 | 26.9% |

Value matching covers one field in eighteen and is **more precise than the name recaller** — 32.1%
against 29.1% — and it costs 0.9 fields per case. It is a scalpel, not a net, which is the opposite of
what the `values` bucket's −2.02pp suggested about *grounding* values. Recalling a column because its
stored value appears in the question is not the same act as guessing a literal into the statement.

### The curated comment is worth 7.2pp of ceiling and 3.4pp at the shipped budget

`metadata+evidence` is the arm whose card carries the dataset's curated column comments, and its
`comment` row gives the alias recaller that text to read. Nothing else changes.

| | without comments | with comments | delta |
| --- | --- | --- | --- |
| recall, `topK` 12 | 1,266 (50.8%) | 1,352 (54.2%) | **+3.4pp** |
| recall, unsliced | 1,693 (67.9%) | 1,872 (**75.1%**) | **+7.2pp** |
| fields named by nothing | 801 (32.1%) | **622 (24.9%)** | **−7.2pp** |
| card width, `topK` 12 | 9.7 | 10.3 | +0.6 |

The comment is the alias a deployment already has: the card shows it, the linker ignores it. Wiring it
is a one-line change in the recaller and would move the hint every measured arm sends, so it is priced
here as a mode rather than applied. **+7.2pp of reachable recall for +0.6 fields** is the cheapest item
in the whole table, and it is available today with data already in the repository.

### The ceiling, and why it is the number the next three rounds are ordered by

| card | reached by token matching | never reached |
| --- | --- | --- |
| `inline+evidence` | 69.6% | 757 (30.4%) |
| `metadata+evidence` | **75.1%** | **622 (24.9%)** |
| `inline+evidence+samples` | 71.6% | 711 (28.4%) |

`inline+evidence` reaches 69.6% rather than 67.9% even though the arm shows no comments, because the
schema it builds still carries them: the card does not render a comment, and the linker can still read
one. The row is therefore a statement about the *schema*, and the 67.9% in the table above is the same
card with the comments withheld from the alias recaller.

Between 24.9% and 30.4% of the fields the gold statements name are named by nothing the question
contains. The ceiling arm reaches 100% of them **by being given the answer**, which is why it is worth
11.09pp and why its price is not payable by any ranker. The remaining headroom for a system that reads
only the question is bounded above by this row, and that bound is what makes the queue below a
calculation rather than an opinion:

| route | what it must supply | headroom it can reach | cost |
| --- | --- | --- | --- |
| `table` recaller into the shipped set | the entity, already in the question | up to +19.8pp @12 | +4.4 fields/case |
| curated comment into `alias` | the comment, already on the card | up to +7.2pp ceiling | +0.6 fields @12 |
| profiled samples into `value` | the data, already in the cache | +3.0pp @12 | +0.4 fields/case |
| embedding index / column-selecting model / training | information from **outside** the question | the 24.9% above, and only that | calls or an index |

The last row is the one the document has been circling since the AskData comparison, and it now has a
denominator: **24.9% of the fields, no more**. A column selector that costs eight calls a question is
priced against that 24.9%, not against the 69% the card ceiling recovers.

### One interaction that would have been invisible without the split

On `inline+evidence`, `all` at `topK` 12 recalls 1,266 fields and `all` + comments recalls **1,249** —
adding a source *lowers* the shipped-budget recall by 17 fields, while raising the unsliced recall by
44 (1,693 → 1,737). More candidates means more competition for the same twelve slots. The budget and
the source are not independent, which is why a proposal that adds a recaller without touching `topK`
has to be read on this table rather than assumed to help.

### What the instrument refuses to publish

Five refusals, all of them tables that would still print. The three piles must add up to the fields
the statements named — `linked + cut + unreachable === total` — because a reader who sees 31% recalled
and 25% unreachable will assume the remaining 44% is width without being told. A ceiling below a slice
is refused: it would mean the "no budget" arm was sliced after all and every `cut` is a fiction. A
report with no cases, a corpus that named no field, and a corpus where nothing is reachable are
refused for the reasons the rest of this file refuses them — a division by zero wearing a percentage
sign, an abstention read as a measurement, and a reader whose schema never arrived.

One more rule goes in the code with them: **a recaller that reports zero is not evidence that its
source is useless**. `alias` is 0.0% on every card in this document because it has no input, and an
instrument that printed "aliases do not help" from that row would be reporting its own wiring as a
finding about the corpus.

## An outside audit of this evaluation system, and what it changed

A 190-file review of this repository reached three structural conclusions: that the arms requiring the
dataset's per-question hint are written in the same breath as the ones a deployment can run, that a
saturated synthetic set still holds a CI slot, and that the statement guard has examples rather than
an attack budget. Two of the three were already true and are now addressed; the third was wrong about
what exists and right about what was missing. The audit's own numbers are from an earlier snapshot,
which is the subject of the last subsection.

### What it got right, and what this repository did about it

| Finding | State before this round | What changed |
| --- | --- | --- |
| The guard has no attack budget | 44-statement classification corpus, a tokenizer suite and row-cap tests — more than "one `drop table`", and still no measurement of what gets *through* | `pnpm bench:guard`: 29 attacks over 5 classes, 10 legitimate questions, ASR / false-reject / utility, plus a mutation |
| A run cannot say which corpus it read | `scored`, `rows`, `split` — all of them names, none of them content | `corpus.digest` in every artifact, required by `gate:bird` for any report that declares its arms |
| The saturated live set reads like a capability claim | 100% on every arm, in a section titled as if it were an evaluation | Section renamed to `Saturated smoke set: the live set has no ranking power` |

### The guard budget, measured (zero model calls)

```
| class                | cases | contained | block |
| ddl-dml              |     8 |         8 | 100% |
| obfuscation          |     6 |         6 | 100% |
| multi-statement      |     5 |         5 | 100% |
| cte-side-effect      |     5 |         5 | 100% |
| privileged-function  |     5 |         5 | 100% |

ASR 0.0% across 29 attacks. False reject 0.0% of 10 legitimate questions; utility 100%.
Mutation: the same corpus with no gate has ASR 69.0% against 0.0% guarded.
```

Four things make those numbers mean something rather than decorate a claim:

1. **The attacks execute.** Every case runs through `createRunner` against a writable SQLite fixture
   with a canary row, and containment is `the canary did not move` — not `the regex matched`.
2. **The mutation is the self-test.** The same corpus through the bare engine must do more damage. It
   does, 69.0% against 0.0%, which is what licenses the sentence "the gate is what stops these".
3. **The cost is on the same line.** A gate that refuses everything would score ASR 0.0% and be
   useless, so false-reject and utility are published beside it: 0 of 10, 100%.
4. **The classes that cannot be measured are named.** Unbounded queries are listed as unmeasured with
   the reason — `node:sqlite` executes on the calling thread, so the runner's timer cannot preempt it
   and a bound there would measure the machine.

**The first run found two holes, both real.** `SELECT readfile('/etc/passwd')` and
`SELECT load_extension('evil')` were accepted: the function denylist covered DuckDB's readers and
neither of SQLite's file functions, on the driver the product ships by default. A read-only database
does not make `readfile` read-only — it reads a path, not a table. Both names are in the policy now,
and the test that pins them says why.

### The corpus a rate is about

BIRD re-annotated Mini-Dev on 2026-10-28 — corrected annotations, replaced instances — and this
harness downloads the split from a bucket URL rather than a pinned archive. Since then, the same path
can hold a different benchmark, and a 1.5pp movement between two artifacts could be the pipeline, the
questions, or both. Every artifact now carries `corpus.digest`, a SHA-256 of the rows (not of the
bytes: a reformat is not a new benchmark), and `gate:bird` refuses a report that declares its arms and
not its corpus. The pin — the digest the floors were set on — is written by the next baseline update
from a CI run, because a pin guessed on a workstation is a claim about a cache.

### The generator a rate is about

`corpus.digest` names the questions. Two fields name the model and neither of them is a measurement:
`model` is the alias the run asked for, and `servedModels` is the name the endpoint answered with.
Those came apart on 2026-11-08 — `deepseek-chat` asked, `deepseek-flash` served, on all 6,448 answers —
and `served` is pinned per split because of it. What no field could see is the case that matters for
every pooled number in this document: an endpoint that keeps the name and changes the weights. Four
runs of one configuration are averaged above as if one generator produced all four, and until this
round that was an assumption with a name attached to it.

`eval/bird/fingerprint.ts` replaces the assumption with six calls. Three fixed questions, asked twice
each at temperature zero, hashed into `baseFingerprint.digest`:

| field | what a reader does with it |
| --- | --- |
| `digest` | 16 hex characters over the answers, the same width as the corpus digest |
| `probes` / `total` | how many of the three answered; a digest over 2 of 3 is about two questions |
| `draws` | how many times each was asked — two, unless a test says otherwise |
| `stable` | whether every probe answered identically on every draw |
| `probeSet` | a digest of the questions themselves, so editing one is visible as an edit |
| `bases` | the names the endpoint gave itself, which should be one |
| `calls`, `promptTokens`, `completionTokens` | what the six calls cost, beside every other cost in the artifact |

Two draws rather than one, because a single draw cannot tell a change of weights from a change of
draw: an endpoint that samples on an identical request has not given a fingerprint, it has given a
sample, and `stable: false` says exactly that. The probe set is hashed as well, because an edited
question would move the digest for a reason that is not the model — the gate **fails** a run whose
probe set differs from the pin's, which forces the pin to be re-recorded in the commit that edits the
questions rather than months later in a diff nobody reads.

`gate:bird` has four refusals here and only one of them is a failure, which is the whole design:

| state | what the gate says |
| --- | --- |
| digest differs from the pin, same probe set, stable | **fails**: the same name is served by different weights, or the endpoint changed something about the request |
| no fingerprint in the artifact | **fails**: a run that cannot identify its generator cannot be compared with floors taken on one |
| probes all failed, or the digest is empty | **fails**, naming the first failure: the instrument could not establish the coordinate |
| two draws disagree | note: the digest is a draw, and a change of weights cannot be separated from it in this run |
| fewer probes answered than the pin records | note: the two digests are over different questions |

The first reading is `42523664683`: three probes, two draws each, six identical answers —
`170d0beaa768594b` over `deepseek-flash`, for **138 prompt and 10 completion tokens**. Both draws agreeing
is what makes the digest a fingerprint rather than a sample, and it is the branch this design hoped for
rather than one it could assume: had they disagreed the pin would have stayed unwritten and the gate would
have said why. It is now pinned per split in `eval/baseline/bird.json`, with the run that produced it.

The four runs pooled above were written before this field existed, so their `model.fingerprint` line reads
`NOT RECORDED` — including when they are compared with each other. Their pool is still four readings of one
configuration, but "one generator produced all four" is a claim none of those four artifacts supports; the
next pool, made of runs after this one, will be the first that can. That is the honest shape of a coordinate
added after the fact: it makes the following reading checkable and says plainly that the previous one was
not.

A matching digest is not proof of the same weights, and this document will not treat it as one: two
models can agree on three short answers. It is a one-sided test, and the side it covers is the one
that has already cost this repository a claim — a *change* proves something changed, and before this
field there was no reading at all that could. The questions are chosen so that models separate on
wording even where they agree on the value: `17`, `17.` and `The 7th prime is 17.` are three
fingerprints of three generators.

The same field is the seventh coordinate in `bench:bird:compare`, which is where the assumption was
being made loudest. An artifact written before the field existed now prints `NOT RECORDED` on that
line and its comparison is **not comparable** — because "nobody showed these were the same generator"
and "these were the same generator" had been the same output, and the verdict now says which of the
two it means.

### Three things the audit asserted that this repository does not support

| Claim | What is there |
| --- | --- |
| `recall@3` 20% → 56% → 84% shows schema linking is measured | That is `pnpm bench:linking`: **25 questions over two hand-written tables whose aliases and samples are written into the fixture**. Reproduced exactly. On BIRD the same linker reaches **31.0%** of the fields the gold statements name, because production never sets `aliases` (measured in the previous section) |
| The hint is presented as product capability | The README sentence is `57.4% with the dataset's per-question hint`, labelled in place. What it lacks is a machine check, not a label |
| `servedModels()` landed only in v9.42 | True, and still true: the artifact records which base answered, not what weights. A weight fingerprint (`PINNED_BASE_MODEL_SHA`) is not implemented and is on the queue |

### The external facts, verified

* **Mini-Dev V2** is real: 780 instances — the 500 SELECT-only questions of Mini-Dev plus **270 new
  tasks across 18 new end-user databases**, including CRUD and HKB-JSON, in SQLite and PostgreSQL
  (MySQL "coming soon" at the time of writing).
* Those 270 **are** LiveSQLBench-Base-Lite, not a second independent benchmark: 18 databases, 180
  SELECT-only and 90 management tasks. So "V2 + LiveSQLBench" is one corpus read twice, and the two
  cannot be presented as independent evidence.
* The LiveSQLBench leaderboard's best base-model score is **31.15%** (o3-mini and GPT-5), with
  DeepSeek V3 at 23.68%. A CRUD-heavy hidden-test benchmark at ~31% is the first external set here
  where a single-call system is not near the ceiling — and the first that scores *state changes*,
  which `compareResultSets` cannot judge. Management tasks are verified by test cases against the
  database, not by comparing a result set, so adopting V2 means adopting a second judge.

### A number that stopped reproducing while this section was being written

The first CI run with the corpus digest in the artifact printed one: `corpus 7f9b2384df7fd655`, 500
rows, 498 questions. It also printed readings that do not match the ones this file quotes.

| arm | run `40101482710` | run `42482353883` | delta |
| --- | --- | --- | --- |
| `names` | 35.7% | 36.3% | +0.6 |
| `synth-definitions` (block) | 41.4% | 41.5% | +0.1 |
| `inline-definitions` | **45.0%** | **40.3%** | **−4.7** |
| `inline+evidence` | 57.4% | 56.0% | −1.4 |
| `metadata+evidence` | 59.2% | 58.7% | −0.5 |

Same arm definition in the catalogue, same corpus (500 rows, 498 question ids), and prompt sizes
within two characters — 1,865 / 2,904 / 2,506 / 2,641 / 6,974 against 1,862 / 2,903 / 2,504 / 2,639 /
6,967. So this is not the arm, and it is not the corpus. The placement result this file has carried
since `40101482710` — the identical sentences score 41.4% as a block and 45.0% on the column line,
**+3.6pp, p=0.039** — now reads **−1.2pp** on the same text.

Three explanations survive the evidence:

1. the weights behind the `deepseek-chat` alias moved between the two runs;
2. the placement effect is an interaction with a particular base model, and a new base reversed it;
3. something in the inline rendering changed by less than two characters — which the prompt sizes
   cannot rule out and cannot confirm.

The artifact cannot distinguish them, and that is the finding. A 4.7pp movement on a configuration
that did not change is a claim nobody can defend until a run records *what answered*, which is why
the model fingerprint is a P0 rather than the housekeeping item it looked like an hour ago. The next
section takes the question up with two artifacts in hand and answers it with the one reading that has
no cross-run noise in it.

One more reading in the same table: the A/A pair (`inline+evidence` and `inline+evidence#2`) landed on
the same number, 56.0% and 56.0%, tighter than the 0.2–1.2pp this file calls its noise floor. A noise
floor is measured per run, not assumed; two arms agreeing exactly is a floor for *this* run, not a
promise about the next one.

## Five hours, and the two instruments a clock needs

`42666720439` ran `glm-4.6` on `metadata+evidence` with the A/A arm beside it, two calls in flight and
a 600-second deadline. It started at 17:39:20 and ended at 22:39:38 — **exactly the job's
`timeout-minutes: 300`** — with the conclusion `cancelled`, an artifact of **2,083 bytes**, and not one
line of output from the evaluation step. Everything it knew at minute 299 died with it.

The cap was not bad luck. The run before it, `42645923773`, answered the question of how fast this
model is: **398 of 496 cases in 7,169 seconds at concurrency 2**, which is **18.0 seconds a case**.
496 cases at that rate is 2.5 hours per arm; two arms is **five hours**, and the cap is five hours.
The arithmetic was available before the dispatch and nothing computed it.

| | `42645923773` | `42666720439` |
| --- | --- | --- |
| deadline | 300 s | 600 s |
| seconds per case | **18.0** (measured) | unknown — nothing printed |
| cases before the stop | 398 | unknown |
| how it ended | the failure breaker, with the rate and the reason | the job cap, with nothing |
| what a reader learns | `50 of 398 calls (12.6%) failed … The remaining 98 calls were not spent.` | `cancelled` |

Two instruments follow, and they are different instruments because they answer different questions.

**The clock.** `BIRD_RUN_BUDGET_MS` is per arm, checked before each case starts and reported after
each one lands. When it fires the arm does not publish a table — 137 of 496 cases is a different
population, which is the reason the gate refuses a partial artifact — it publishes **the number the
next dispatch needs**:

> `arm metadata+evidence: stopped after 100 of 496 cases — the 10000 s run budget ran out; no call
> failed, the clock did. 100 case(s) took 10000 s at concurrency 2 (100 s/case), so a full split at
> this rate needs 13.8 h. Dispatch again with BIRD_LIMIT=75 (about 7500 s of the same clock), or a
> longer budget, or a faster model. The remaining 396 cases were not spent.`

Three quarters of the budget, not all of it: a run that stops at 99% of its clock has learned nothing
about how close it came, and the next dispatch would be a second guess. Zero cases in a whole budget
prints a different message, because zero cases is a shape rather than a speed — one case makes several
calls, each bounded by `BIRD_LLM_TIMEOUT_MS`, and the product is what to look at. The suggestion is
computed from measurement in both directions; it is not a constant anyone has to remember.

**The line.** One line per case:

```
  [ 42/150] 38.1%  18.0 s/case  case 7.2 s  elapsed 756 s
```

The rate is the only thing that distinguishes *slow* from *stuck*. It cannot be read from a total that
has not arrived, and the five-hour run had neither a line nor a rate — so its death was the first fact
anyone could read about it. The timestamps of these lines are the instrument; the numbers beside them
are what lets a reader stop a run that is going nowhere before the cap does it.

### What a smaller run can claim

Cutting the sample is the only affordable way to measure a reasoning model, and it looks like it
destroys the comparison: `displacement` measures a difference between two runs and states the interval
two independent rates must clear — **±6.2pp** at 496 questions near 0.57. Against a 150-question
subset that interval is wider still, and a 10pp difference between two models would sit inside it.

That interval is the price of the two runs not necessarily having scored the same questions, and for a
*model* comparison the price need not be paid: the DeepSeek anchor already holds a verdict for every
question in the split. `crossPair` restricts **both** rates to the ids the two artifacts share and
tests the flips with McNemar, so the questions' own difficulty cancels:

| | two artifacts, side by side | one arm, read as a pair |
| --- | --- | --- |
| sample | each artifact's own | the intersection |
| interval | both rates' uncertainty | the discordant cases only |
| at 150 questions near 0.58, 20 flips (14 up, 6 down) | ±11.2pp | ±5.8pp |
| what it can say | the runs are, or are not, the same experiment | which of two generators answered better questions |

A tool that read the artifacts' own totals would report 4/6 against 3/3 where the pair is 2/3 against
3/3. The 16.7pp it printed would be a difference between two populations wearing the name of a
difference between two models, which is why the restriction is in the function rather than in the
reader's head.

The experiment this makes possible: `BIRD_LIMIT=150` — a stratified sample of the same corpus, so not
a different population — one arm, no A/A, at 18 seconds a case. **45 minutes** instead of five hours,
and a reading with an interval narrow enough to be about the model.

| design | cases | seconds a case | wall clock | what it can claim |
| --- | --- | --- | --- | --- |
| full split, one arm | 496 | 18 | 2.5 h | a rate on the split |
| full split, one arm + A/A | 992 | 18 | 5.0 h — the cap | the above, plus the harness's own noise |
| **150-question subset, one arm** | 150 | 18 | **45 min** | a pair against the anchor on the same 150 questions |

### How large a difference 150 paired questions can see

A pair is a test, and a test has a resolution. For McNemar at 5% with 80% power the sample a design
needs is `n ≈ (1.96 + 0.84)² · π_d / δ²`, where `π_d` is the share of questions the two generators
answer differently at all and `δ` is the difference being looked for. Reading it the other way, at
`n = 150`:

| discordant share `π_d` | smallest difference detected 80% of the time | what produces that discordance |
| --- | --- | --- |
| 7% | **6.1pp** | two runs of the *same* generator: measured below at 2.8% on the shipped arm |
| 10% | 7.2pp | |
| 20% | 10.2pp | |
| 30% | 12.5pp | two generators roughly ten points apart, with half the flips going the wrong way |

So 150 is enough for a ten-point difference as long as the two models disagree on no more than a
fifth of the split, and not enough for a three-point one whatever they disagree on. That is the honest
resolution of this design, and it is the reason the subset size is a declared input rather than a
constant: a smaller difference needs a bigger sample, and the arithmetic above says how much bigger.

For scale, the same instrument read across two runs of the *same* model on Mini-Dev — the two
DeepSeek artifacts of 2026-11-09, thirteen arms, 496 questions — puts the cross-run displacement of
the shipped arm at **+0.81pp, 9 up and 5 down, p = 0.424**, and no arm outside its own interval. Two
runs of one generator disagree on 2.8% of the split, so the noise a *model* comparison has to clear
is about a point; the interval at 150 questions is what says whether it cleared it.

## The endpoint a model name cannot describe

`42723786747` was the first run to use the clock and the progress line. It printed its budget, then a
line per case, and stopped itself at case 27:

```
budget: 7200 s per arm, deadline 300 s, concurrency 2
  [  1/150] 100.0%  35.1 s/case  case 35.1 s  elapsed 35 s
  ...
  [  8/150]  25.0%  17.0 s/case  case 15.7 s  elapsed 136 s
  [  9/150]  22.2%  47.8 s/case  case 300.0 s  elapsed 430 s
  [ 10/150]  20.0%  43.6 s/case  case 300.0 s  elapsed 436 s
  [ 11/150]  18.2%  40.5 s/case  case 8.8 s  elapsed 445 s
  ...
Error: arm metadata+evidence: stopped after 27 of 150 calls — 16 of 27 calls (59.3%) failed at the
model, above the 10% this harness treats as an outage (first error: llm call timed out). Every
failure is a timeout, so the deadline (BIRD_LLM_TIMEOUT_MS) may be shorter than the model needs.
```

Read the two halves against each other. **Two** of the twenty-eight cases that landed took the full
300-second deadline, and the sentence says *every* failure is a timeout — because it had one message
out of sixteen and generalised from it. The other fourteen cases failed in **8.5 seconds**, and 8.5
seconds is not a timeout.

That is a defect in the instrument, not in the run: a verdict composed from the first message of a
sixteen-message pile can name the wrong fault, and it did. The verdict now tallies the shapes — `HTTP
400 × 13, timeout × 2` — and picks its hint from the tally rather than from its first element: 4xx
sends the reader to the model name and the capability declaration, 429 to the concurrency, and only
an all-timeout run to the deadline.

The tally is also what makes the next question askable, because the shape of this failure is
**a fast completion with nothing in it**:

| the case | what it looks like |
| --- | --- |
| cases 1-8 | 15-54 s, four correct — the endpoint answering |
| cases 9-10 | 300 s — the endpoint thinking until the deadline |
| cases 11-15 | **8.5 s each** — neither of those |

An 8.5-second completion on a 7.5k-character prompt is roughly a full answer budget spent and no
answer returned, which is what a reasoning model does when it is asked to answer immediately. And
`glm-4.6` **is** read as an immediately-answering model here: the family guess matches `reasoner`,
`thinking`, `r1`, `qwq`, `magistral` and `o1`-`o9`, and nothing in `glm-4.6` matches any of them. So
the request carries a temperature, a 4,096-token answer budget and no thinking switch — the shape of a
chat model sent to one that deliberates.

That asymmetry was the gap: the second endpoint has had a capability declaration since the contract
was written (`BIRD_SECOND_CAPABILITIES`), and the primary endpoint never did. A caller pointing this
harness at a private reasoning endpoint could rename the model or nothing. `BIRD_CAPABILITIES` closes
it, the artifact records the resolved row as `modelCapabilities`, and the workflow takes it as an
input:

```json
{"family":"reasoning","maxOutputTokens":16384,"thinkingSwitch":true}
```

The hypothesis that this explains the 8.5-second completions is a hypothesis. It is stated as one
because the instrument that would confirm it — the tally — did not exist when the run was spent, and
the next dispatch with the declaration is what will say whether the fast failures were empty
completions or refusals. **A defect found by an instrument that was built after the money was gone is
still a defect found; it is not a result.**

### The account, measured twice

| run | configuration | preflight |
| --- | --- | --- |
| `42645923773` | concurrency 2, 300 s | 12/12 clean |
| `42726866491` | concurrency 2, 300 s | **2 of 12 refused with 429**, run not started |
| `42645162071` | concurrency 4, 300 s | 3 of 12 refused with 429 |

Same account, same model, same concurrency, two hours apart: clean, then refused. The preflight's own
sentence is the reading — `2 of 12 calls were refused with 429 at 2 concurrent, which is the run's own
concurrency` — and what it establishes is that **this account's limit at two calls in flight is not a
constant**. A benchmark dispatched against it is measuring the queue, and the harness now refuses
before spending anything rather than after five hours. Three of the four `glm-4.6` dispatches this
week were stopped by an instrument before producing a table; the fourth was stopped by a job cap that
now has a clock in front of it.

## What a reasoning alias buys, and the field that cannot confirm it

`42727868711` is the first dispatch that asked for a reasoning model: `deepseek-reasoner`, Mini-Dev,
120 of 498 questions, the shipped arm plus an A/A duplicate, concurrency 8, deadline 300 s, budget
7,200 s per arm. It finished both arms in **101 seconds**, wrote its artifact, and passed every gate:

```
budget: 7200 s per arm, deadline 300 s, concurrency 8
  [  1/120] 0.0%  2.6 s/case  case 2.6 s  elapsed 3 s
  ...
  [120/120] 58.3%  0.8 s/case  case 61.9 s  elapsed 101 s
inline+evidence#2 70/120  58.3%  strict 66  llm-failed 1
gates: gold runnable, controls, signal and no regression all hold
```

### The reading, on the same 120 questions

The anchor is the 496-question `deepseek-chat` run (`2026-11-08T21:16`), restricted to the 120
questions both runs hold. Restricting matters: the full-sample figure for that arm is 58.9%, and
reading it beside a 120-question figure would compare two populations.

| arm | model | n | passed | accuracy | exact | strict | prompt/case | completion/case |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `metadata+evidence` | `deepseek-chat` | 120 | 72 | 60.0% | — | — | 1,551 | 55 |
| `metadata+evidence` | `deepseek-reasoner` | 120 | 69 | 57.5% | 56.7% | 68 | 1,576 | **594** |
| `inline+evidence#2` | `deepseek-reasoner` | 120 | 70 | 58.3% | 55.0% | 66 | 654 | 557 |

Paired, question by question:

| comparison | delta | up | down | p | interval |
| --- | --- | --- | --- | --- | --- |
| reasoner vs chat, same arm, same 120 | **+2.5pp for chat** | 13 | 10 | 0.678 | ±7.8pp |
| reasoner A/A duplicate | +0.8pp | 5 | 4 | 1.000 | ±4.9pp |

A 2.5-point difference at a 19% disagreement rate needs about 2,400 paired questions to clear its own
interval, and Mini-Dev holds 496. **The two models are indistinguishable here, and the run does not
say the reasoner is worse — it says this sample cannot see the difference either way.**

### What the alias did change is the bill

Completion tokens per case went from **55 to 594** — 10.8× — while prompt tokens stayed in the same
band (1,551 → 1,576). Nothing about the question changed: same corpus, same card, same arm, one call
per case. So the routing did happen, and the behaviour it changed is the one that costs money: the
endpoint spent an answer's worth of deliberation before writing 55 tokens of SQL. 71,292 output tokens
bought +0.8pp that its own interval (4.9pp) does not support.

That is the shape this campaign keeps finding: **the lever with the largest visible cost is not the
lever with the largest measured effect.** The same table from the anchor's 496 questions, read the
same way, says the same thing about the audit turn:

| arm | calls/case | prompt/case | completion/case | delta vs `metadata+evidence` | p | interval |
| --- | --- | --- | --- | --- | --- | --- |
| `metadata+evidence` | 1.0 | 1,718 | 58 | — | — | — |
| `inline+evidence` | 1.0 | **698** | 58 | **−3.8pp** | 0.011 | ±2.8pp |
| `inline+evidence+audit` | 2.0 | 1,676 | **131** | −1.2pp | 0.480 | ±2.8pp |

The metadata card is the only arm on that table whose win is larger than its own interval: it pays
2.46× the prompt of the inline card and buys 3.8pp that survives pairing. The audit turn pays twice
the calls and 2.3× the completion for 1.2pp it cannot show — so the next round's order is *the card,
not the audit*, and that order is now a reading rather than a preference.

### The field that cannot confirm what was asked

Both artifacts record the same thing about the endpoint:

```
"model": "deepseek-reasoner",     "servedModels": [{"deepseek-flash": 120}, {"deepseek-flash": 119}]
"model": "deepseek-chat",         "servedModels": [{"deepseek-flash": 496}, ...]
```

`gate:bird` has printed this since the field existed, and on this run it read:

```
BIRD1: the run asked for deepseek-reasoner and the endpoint named deepseek-flash — only the second field answered
```

The response's `model` field names the **serving deployment**, not the alias that was requested, and
this account's endpoint answers `deepseek-flash` whatever it is asked for. A reader of the artifact
therefore holds two facts and cannot derive the one that matters: what ran. The reasoner's 10.8×
completion count is the only evidence in the file that the request changed behaviour, and it is
indirect — it says *something* deliberated, not *which* model.

This is the same boundary as the capability declaration at the other end of the request. The harness
can record exactly what it asked for — that is a declaration it owns — and it cannot read back what it
got from a field the provider controls. `modelCapabilities` was added for the half it owns; the
serving name is the half it cannot, and recording both in the same artifact is what keeps a reader
from mistaking one for the other.

**What this licenses:** a claim that the shipped arm is worth its prompt, since 3.8pp with 16 up and
35 down at p=0.011 is outside its own interval; a claim that the audit turn has not yet earned its
second call; and a claim that swapping in a reasoning alias at 10× the output tokens has no measured
effect on this split.

**What it does not license:** any accuracy figure for a 120-question subset presented as a Mini-Dev
rate — `gate:bird` refuses the floor for exactly this reason (`the minidev floors were taken on the
full sample, so they do not apply to 120 of 498 questions`) — and any statement about which model
answered.

### The counter that turns the inference into a reading

The 10.8× above was read off `completion_tokens`, and that is an inference: a chat model writing SQL
also has a completion bill. What the artifact could not say is how much of the 594 was *thinking*,
because the meter read `completion_tokens` and nothing else — and that is the one number that
separates "this alias deliberated" from "this alias wrote a longer answer".

`reasoning_tokens` closes it. Two spellings are read (OpenAI nests it under
`completion_tokens_details`, gateways put it at the top of `usage`), it is metered per answer like the
cache count, and it reaches the artifact twice: per case as `tokens.reasoning`, and per arm as the
mean over the cases whose endpoint reported one.

| field | on a chat endpoint | on a thinking endpoint | after this change |
| --- | --- | --- | --- |
| `tokens.completion` | the whole answer | thought + answer | unchanged |
| `tokens.reasoning` | **absent** — nobody reported | the deliberate part | present, `0` if it said zero |
| `tokens.cached` | absent unless reported | absent unless reported | unchanged |

Three rules came with it, and each is a test:

1. **Absent is not zero.** An endpoint with no reasoning counter has not claimed it thought for
   nothing, so the field is dropped rather than written as `0`. A reported `0` *is* written: that is
   an endpoint saying the model did not deliberate, which is a measurement.
2. **It decomposes the bill, it does not extend it.** `completion` is unchanged, so a run measured
   before this column existed is still comparable with one measured after.
3. **Averaged over reporters, not over cases.** An endpoint that reports the counter on a third of
   its answers has measured a third, and dividing that by every case would understate all three.

The same rule the cache column follows, one field over — and it is the one column that can answer the
question the serving name cannot.

## The missing half of a capability declaration: `glm-4.6` on 150 questions

An earlier section left a hypothesis and no way to test it. Run `4269…` sent `glm-4.6` twenty-eight
questions with no `capabilities` block, and **fourteen of them came back empty after 8.5 seconds** —
not a timeout, not an error, a successful reply with no content. The reading offered was that a
thinking model was being asked the way a chat model is asked: a `temperature` it ignores, a
`max_tokens` of 4096 that cuts the deliberation off, and no thinking switch at all.

That hypothesis had one prediction: declare the family and the empty replies stop. `42733442619` is
the test — the same endpoint, `glm-4.6`, **150 questions**, concurrency 2, a 7,200-second budget, and
`capabilities: {"family": "reasoning", "thinkingSwitch": true, "maxOutputTokens": 16384}`
recorded in the artifact as `modelCapabilities`.

| reading | run without `capabilities` | run with it |
| --- | --- | --- |
| questions asked | 28 | **150** |
| empty replies | **14 (50%)** | **0** |
| LLM failures | 14 | **1 (0.67%)** — `llm call timed out` |
| `format.replies` | 14 of 28 | **149 of 150** |
| `samplingOmitted.temperature` | absent | **149** — the parameter was not sent |
| accuracy | not publishable | **62.0%** (93/150, Wilson [54.0, 69.4]) |

The failure shape is gone, and it is gone together with the two facts that explain it: the request
no longer carries a sampling parameter, and it now carries a thinking budget. **A model that ignores
`temperature` and needs room to think is a model that returns an empty string when both are wrong**,
and that is what a missing capability block was telling the harness to do.

### What it does not prove

Two limits, both stated because the number is easy to over-read.

**The bill cannot confirm the deliberation.** `tokens.reasoning` is **absent from both arms** — the
endpoint reports no reasoning counter at all. Under the rule this repository wrote for that field,
absent means "nobody reported", not "it thought for nothing", so the artifact says nothing about how
much of the 1,237 completion tokens were thought. What changed is observable in the *shape* of the
answer, not in its decomposition: 1,237 completion tokens across a case that finishes, against a
reply that was empty.

**150 questions is a draw, not the split.** `selection` records `sampled: true`, a seeded order within
each difficulty stratum, and a mix of 44 simple / 74 moderate / 32 challenging against the split's
148 / 248 / 102. The Wilson interval on 93/150 is ±7.7pp, which is wider than the difference between
any two arms on the board — so `62.0%` is a statement about this draw and not a ranking.

What it does establish is the thing that was blocking every other `glm-4.6` reading: **the arm can now
be measured at all.** A harness that loses half its cases to an empty reply is not measuring a model.

## What `filter-wide` is made of: a counterfactual, not a reading

`filter-wide` is the largest rung under `values` — 102 of 425 arithmetic failures on the dev split,
24.0% — and it is the only one whose name hides two defects with **opposite** fixes. A predicate that
is too weak needs condition coverage; a `from` that multiplies rows needs grain. A lever built for one
does nothing for the other, and the two are indistinguishable in the syntax: both are "the statement
differs", which is where `values-gap`'s ladder stops.

One thing about that 102, stated before any table, because the numbers below are smaller and the
difference is not a correction. It is `deepseek-v4-pro`'s wide base on `42250903916`; the reading this
tool publishes is `deepseek-chat` on `42563674600`, where the rung holds 54 to 82 cases depending on
the arm. **The rung's size is a property of the model and the prompt; its composition is the thing
being compared**, which is why every arm below is on one artifact and one model, and why none of them
is set against the 102.

`bench:bird:surplus` separates them by counterfactual rather than by a rule: **keep the prediction's
`from`, put the gold's `where` in place of its own, and run it.**

| outcome | what the engine showed |
| --- | --- |
| `predicate` | the grafted statement matches the gold under the strict multiset rule: the filter was the whole defect |
| `duplicates` | it matches under the *official* rule only — the judge's `set()` folded repeated rows, so this is a missing `distinct` |
| `elsewhere` | it still does not match: no edit to a condition reaches this case |
| `tables` | the gold's filter compares a column of a table the prediction never reads — a `tables` finding the ladder placed here |
| `selfJoin` | the statement reads one table under two aliases, so a qualifier no longer names a role |
| `nested` | a derived table or a subquery: the clause the graft edits is not the one that decides the answer |

### The reading, on five arms and one artifact

Run `42563674600`, dev split, 1,532 questions, `deepseek-chat`, all five arms in one artifact:

| arm | `row-count` cases | `predicate` | `duplicates` | `elsewhere` | `tables` | `selfJoin` | `nested` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `names` | 82 | **18 (22.0%)** | 13 (15.9%) | 32 (39.0%) | 6 (7.3%) | 4 (4.9%) | 9 (11.0%) |
| `inline+evidence` | 65 | 4 (6.2%) | 4 (6.2%) | **39 (60.0%)** | 7 (10.8%) | 4 (6.2%) | 7 (10.8%) |
| `metadata+evidence` | 59 | 6 (10.2%) | 5 (8.5%) | **31 (52.5%)** | 7 (11.9%) | 3 (5.1%) | 7 (11.9%) |
| `select` | 58 | 8 (13.8%) | 4 (6.9%) | **32 (55.2%)** | 5 (8.6%) | 2 (3.4%) | 7 (12.1%) |
| `select-mixed` | 62 | 7 (11.3%) | 4 (6.5%) | **35 (56.5%)** | 7 (11.3%) | 3 (4.8%) | 6 (9.7%) |

Four readings, and the first one is the reason the tool exists.

**1. Condition coverage is not where the bucket is.** Replacing the whole filter with the gold's — an
oracle's edit no prompt can make — repairs **4 to 18 cases depending on the arm**. On the three arms
that carry a semantic card it is 6 to 8: **0.39 to 0.52pp of 1,532.** That is the ceiling of every
condition-coverage lever this project could build, and it is under the dev split's own resolution.

**2. `names` is the exception that proves the rule.** The bare-column card reaches 22.0% by predicate,
three to five times the rate of the arms that carry descriptions and evidence. Stated the other way:
the metadata card did not *fail* to fix conditions, it **moved the failures into the row source** —
`elsewhere` goes from 39.0% on `names` to 52.5–60.0% on the arms that have one. A better prompt does
not make predicates righter; it makes them right often enough that what is left is the `from`.

**3. `elsewhere` is the stable majority.** 31 to 39 cases on every arm, 52.5% to 60.0% of the bucket.
The graft put the gold's filter in place and the answer was *still* wrong, which means the statement
is reading the wrong rows rather than filtering the right ones badly. **This is where the next lever
is**, and it is 2.0–2.5pp of the split.

**4. The judge is carrying five to thirteen cases.** `duplicates` is a case the official rule credits
because `set()` collapses repeated rows — on `names`, 13 of 82 (15.9%). Those are fan-outs that score
while answering with more rows than the question asked for. Counting them as `predicate` would have
sent a condition lever after a `distinct` that was never written.

### Two things the ladder is doing that it does not say

The tool counts what it *cannot* attribute, and two of those counts are findings about `values-gap`
rather than about the arm.

**`tables` lands here.** The ladder places `tables` below `filter-wide`, so a case whose gold filters
on a table the prediction never reads is filed as a row-count first and reaches this tool. Five to
seven cases per arm — **the same five to seven on every arm**, which says they are a property of the
corpus and not of the prompt. A rung that absorbs a rung below it understates the lower one.

**29 to 34 cases are `row-count` with the wrong grain.** Both statements return a different number of
rows *and* answer at different grains — an aggregate against a row set, or a projection two columns
wide against one. Those are `aggregate` and `projection` cases wearing `filter-wide`'s name. They are
counted as `another grain` and kept out of the denominator, because a graft would have reported "the
predicate was not the whole story" for a case that has no predicate problem.

### What it closes

**No further literal or condition edit will move this bucket.** 41 of 57 `filter-narrow` sites were
literals the column does not store (71.9%), and 31 to 39 `filter-wide` cases remain wrong with the
gold's filter in place (52.5–60.0%). Read together those two numbers say the same thing from both
ends: **the defects are about which column and which rows, not about which value or which condition.**

That also settles the question the previous round left open from the other side. Column-level evidence
— every column's stored values on the card, MAC-SQL's block — was worth **+2.82pp** against a card
with neither source, and **+1.21pp at p = 0.2379** once the curated notes are on it, with an exact
A/A. It was a substitute for the descriptions, not a complement. This tool says why: the values were
never the missing information in the cases that remained.

```bash
BIRD_SPLIT=dev pnpm bench:bird:surplus --artifact eval/out/bird-eval.json --arm metadata+evidence
```

It re-executes the artifact's own statements against the split's databases and writes
`eval/out/surplus-<arm>.json`. Two conditions fail the build rather than being printed and ignored: an
empty bucket, because `0 of 0` prints as `0.0%` and reads like a measured zero, and a gold the engine
refuses. A refused *graft* is counted in the tally instead of failing the run — eleven of fifty-nine
dev cases are unreadable by construction, and **a gate that goes red on a property of the corpus is a
gate nobody reads.**

## What is actually under `elsewhere`: the read-set has a direction

The previous section split `filter-wide` by a counterfactual — keep the prediction's `from`, put the
gold's `where` in its place, run it — and left 31 to 39 cases per arm that are still wrong with the
gold's filter in place. It called those `elsewhere` and pointed the next lever at "the row source".
That was a direction as much as a measurement: it assumed the statement was reading *too many* rows.

`bench:bird:residue` asks the question that assumption skipped, and it needs no statement executed
that the previous tool has not already executed. **When the gold's filter is in place and the rows
still differ, is the statement reading more distinct rows than the answer, fewer, or the wrong ones
in both directions?** Containment is tested through the devkit's canonical identity for a result set,
comparing the key of the concatenation with the key of each side, so the normalisation is the judge's
own and the answer is order-free and duplicate-free like the rule it is built on.

### The finding: the residue is not a fan-out

Run `42563674600`, dev split, 1,532 questions, `deepseek-chat`, all five arms of one artifact:

| arm | residue | `capped` | `over` | `under` | `mixed` | capped at all | stripping repairs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `names` | 32 | 6 (18.8%) | 6 (18.8%) | 11 (34.4%) | 9 (28.1%) | 11 (34.4%) | **6** |
| `inline+evidence` | 39 | 6 (15.4%) | 5 (12.8%) | 13 (33.3%) | 15 (38.5%) | 12 (30.8%) | **6** |
| `metadata+evidence` | 31 | 8 (25.8%) | 3 (9.7%) | 10 (32.3%) | 10 (32.3%) | 10 (32.3%) | **8** |
| `select` | 32 | 5 (15.6%) | 5 (15.6%) | 10 (31.3%) | 12 (37.5%) | 8 (25.0%) | **5** |
| `select-mixed` | 35 | 7 (20.0%) | 4 (11.4%) | 13 (37.1%) | 11 (31.4%) | 13 (37.1%) | **7** |

**`over` is 3 to 6 cases per arm, 9.7% to 18.8% of the residue.** The hypothesis the plan inherited —
that `elsewhere` is a `from` multiplying rows — holds for at most a sixth of it. `under` (10–13) and
`mixed` (9–15) together are two thirds: **the statement is reading fewer rows than the answer, or a
different set, and no edit to a condition or a join fan-out reaches that.** A lever built for a
surplus of rows would have spent its budget on the smallest part of the bucket.

### Why the fan-out question did not need its own instrument

The plan also asked to separate "one-to-many fan-out" from "a missing `distinct`". That split is
already made, and the arithmetic is the reason:

> a fan-out repeats rows and preserves the row **set**; the official judge compares `set()`; so a
> case whose only defect is repetition **scores** unless the gold's own answer repeats a row.

Which is the `duplicates` bucket: 4 to 13 cases per arm, credited by the judge because `set()` folded
them. **A case that reaches `elsewhere` cannot be a pure fan-out** — if it were, the set would match
and the case would be a win. Both candidate edits were therefore tried on paper before any of them
was built: a `distinct` view of an `elsewhere` case cannot match its gold (the set already differs
and the view does not change the set), and removing a piece of a `from` clause cannot repair a
statement whose rows are missing as well as extra. Shipping a query whose answer is known is how a
zero gets read as a measurement.

### The cheapest lever this project has found, and it is mechanical

`capped` is not a direction; it is a repair. A statement that answers the question and then keeps
fewer rows than asked is truncating a right answer, and **stripping its own `limit` proves which it
was with one query** — the probe runs on the statement the model wrote, not on the graft, because
the claim is about that statement.

Eight to thirteen cases per arm carry a top-level `limit` the gold does not have, and stripping it
repairs **5 to 8**. On 1,532 questions that is 0.33 to 0.52pp, for a rule that needs no model, no
prompt and no card — and the half of the caps that do *not* repair stay in the residue, which is why
the number is a floor of the guard rather than a forecast of one.

```bash
BIRD_SPLIT=dev pnpm bench:bird:residue --artifact eval/out/bird-eval.json --arm metadata+evidence
```

### Two audits the file carries, one of which clears the previous section

**The `where` graft carried everything.** A gold that states conditions in a `having` clause, or in a
join's `on` clause beside its key, cannot be repaired by a graft that only carries a `where` — and
had that been common, the previous section's 52.5%–60.0% would have been an artifact of the
instrument rather than a finding about the arms. It is **0 of 31 to 0 of 39 on every arm**. The
denominator was clean, and the residue is what it says it is.

**`under` is a stricter join, not a narrower question.** Predictions read a table the gold never does
in 6 to 9 cases per arm, and 5 to 6 of those are `under`: one more join is one more intersection, and
an inner join over a table the answer never needed can only remove rows. The residual floor —
`over`, same tables, the gold's own filter, no condition outside the `where` — is 0 to 3 cases per
arm (0.0%–9.4%), and it is reported as a floor rather than assigned to a clause.

### What it does not prove

It does not price a lever. Stripping a `limit` makes the statement match, which proves the cap was
the whole defect for those cases; it does not prove that a question-side rule can tell a justified
cap from an unjustified one without the gold. Every number here is a ceiling of the same kind as
`literal-gap`'s and `surplus`'s, and the report prints the ceiling next to the count.

## The cheapest lever, priced: a cap the statement cannot justify

The section above ends with a floor and says so: `bench:bird:residue` sees only the cases an arm got
*wrong*, because a case it got right never reaches the residue. Stripping a `limit` repaired 5 to 8
of 8 to 13 capped failures per dev arm, and that is a **ceiling over the failures**, not the net
worth of a rule. A rule is priced by the cases it can hurt, and the cases it can hurt are the ones
the judge already credited.

`bench:bird:rewrite` is the instrument for that: it re-executes each case with and without the edit
and requires the re-execution to reproduce the arm's published pass count before it prints anything
(a baseline that cannot be reproduced is a bug in one of two judges, not a reading). Two rules were
added to it.

- **`drop-unordered-limit`** — the rule that ships. Remove a top-level `limit` when the statement has
  no top-level `order by` (so the cap is not a ranking), the question names no rank (so the cap is
  not the answer to a question about "the top 3"), the cap is a plain positive integer (so it is not
  `limit 0`, which asks for columns and no rows), and there is no `offset` beside it.
- **`oracle-drop-limit`** — the same edit with none of those conditions: remove the cap whenever the
  gold states none. It reads the gold, so it is a ceiling and not a candidate, and it is here because
  it is the reading that refutes the ceiling above.

Mini-Dev, 496 questions per arm, four arms, one artifact, no model called:

| arm | baseline | `drop-unordered-limit` | `oracle-drop-limit` (ceiling) |
|---|---|---|---|
| `metadata+evidence` | 292 (58.87%) | 8 fired · **2 won · 0 lost** · +0.40pp · p=0.500 | 24 fired · 3 won · **8 lost** · −1.01pp |
| `names` | 179 (36.09%) | 16 fired · **4 won · 0 lost** · +0.81pp · p=0.125 | 30 fired · 4 won · **3 lost** · +0.20pp |
| `inline+evidence` | 273 (55.04%) | 15 fired · **4 won · 0 lost** · +0.81pp · p=0.125 | 29 fired · 4 won · **6 lost** · −0.40pp |
| `select` | 286 (57.66%) | 10 fired · **1 won · 0 lost** · +0.20pp · p=1.000 | 20 fired · 1 won · **6 lost** · −1.01pp |

Across the four arms the shipped rule fires 49 times, repairs 11 and breaks none; the ceiling fires
103 times, repairs 12 and breaks 23. The sign test on 11 repairs and 0 losses is p=0.00049, and it is
the only number here that is significant on its own — each arm separately cannot resolve 0.2 to
0.8pp, which is why the table prints the interval rather than the verdict.

**The finding is the column on the right.** Reading the gold buys nothing: the ceiling knows strictly
more than the shipped rule and does worse on three of four arms, because the conditions it skips are
the cases where a cap is how a model expresses a correct answer. The repository has one such rule
already — `drop-limit-on-count` fires 8 to 11 times per arm and loses 3 to 4 every time — and the
gross form is the same shape at a larger size.

**Why removing an unordered cap is sound at all.** An unordered relation has no first k rows. A cap
without an ordering selects an arbitrary subset of the rows the question asked for, so removing it
cannot drop a row that was asked for; it can only stop matching when the answer happens to have
exactly k rows, and that is what the two conditions above exclude. This is a fact about SQL rather
than about models, which is why it holds on four arms with four different score levels.

### Where the rule runs

In the pipeline, on the statement about to execute — after the literals are grounded, before the
engine sees it — and on every turn, not only the first: a repair's statement and the audit turn's
statement are statements the model wrote from the same prompt. The answer reports `capStripped` with
the clause the model wrote, so an artifact can tell a rule that fired from one that had nothing to
do. It costs no call, no token and no candidate.

```bash
pnpm bench:bird:rewrite --artifact eval/out/bird-eval.json --arm metadata+evidence --oracle
```

### What it does not prove

The conditions are two claims of different kinds. "No `order by`" is syntactic and exact. "The
question names no rank" is a word list, and its error rate is one-directional by construction: a
false positive (`at least three`, which contains `least`) makes the rule decline and costs a repair;
a false negative would let it fire on a question that wanted a ranking. The list was not tuned on
these four arms, and the number of cases where it declines wrongly is printed as the difference
between the rule's firings and the caps that carry no ordering at all.

It also does not settle the rule's interaction with the one rewrite the pipeline already ran. A
statement with `order by x asc limit 1` is exactly the shape `guardNullOrder` was written for, and
that module is not called by the pipeline at all — it was priced here at 6 wins and 0 losses on dev
and never wired, and wiring it is a separate change because the direction it guards is a property of
the dialect (`null-order.ts` treats every engine it does not name as SQLite, and DuckDB sorts the
other way). Two free rules do not compose for free.

## What the systems that train nothing actually do

The comparison that matters is not "ours against theirs" but "ours against the ones that pay the
same bill". Two systems sit at the top of that group and both publish enough detail to be copied
rather than admired.

**OpenSearch-SQL** (arXiv 2502.14913) reached 69.3% on BIRD's validation set and 72.28% on test,
first place in August 2024, and states in its own readme that the framework "operates without the
need for additional training". Its five modules are Preprocessing, Extraction, Generation,
Refinement, Alignment. The parts that are mechanisms rather than plumbing:

- **Self-taught CoT few-shot.** Examples are `(question, reasoning, SQL)` triples, not
  `(question, SQL)` pairs. The reasoning is generated once over the training split and then
  retrieved. The paper's own finding is that the *most similar* example is not necessarily the most
  helpful one.
- **SQL-Like, a constrained intermediate language.** Generation proceeds as
  reasoning → columns → values → SELECT → SQL-Like → SQL, so the pieces of the query are named
  before the query is written.
- **Value retrieval over an HNSW index** of cells and column names, to survive misspellings.
- **Error-specific few-shot in refinement**: a failed statement is repaired with examples of that
  class of failure, not with a diagnosis string.
- **Consistency alignment** in three kinds — agent (column and value representation, including
  case sensitivity), function (aggregate misuse, nesting, redundant joins) and style (the dataset's
  preference for `IS NOT NULL`, `MAX` or `ORDER BY … LIMIT 1` when the question asks for a top-k).

**RSL-SQL** (arXiv 2411.00073) reports 67.2% on BIRD with GPT-4o and states that it "outperforms a
series of GPT-4 based Text-to-SQL systems when adopting DeepSeek (much cheaper) with same intact
prompts". Four components:

- **Bidirectional schema linking** — forward and backward pruning, 94% strict recall at 83% fewer
  input columns.
- **Contextual augmentation** of the linked schema.
- **Binary selection**: it hedges the risk of pruning by running one candidate on the full schema
  and one on the pruned schema, then choosing. The hedge is the point — linking can drop an element
  the question needed, and a single view cannot notice.
- **Multi-turn self-correction** driven by execution.

Laid against this repository, four of those nine mechanisms were absent, and the absences are
visible in the code rather than inferred from the scores:

| Mechanism | Where it would live here | State before this round |
|---|---|---|
| `(question, reasoning, SQL)` few-shot | `eval/bird/retrieval.ts` → `renderDemonstrationBlocks` | renders `(question, evidence, SQL)`; no reasoning section |
| SQL-Like intermediate language | `packages/ai/src/` | absent; `decompose` asks for free step sentences and measured at a loss |
| error-specific few-shot in repair | `packages/ai/src/diagnose.ts` | sends a diagnosis string, no examples |
| full / pruned dual view | the arm catalogue | every arm renders the whole card: `renderSchemaCard`'s `limit` counts *tables*, not columns, so "pruned" and "full" are the same prompt |
| value retrieval by vector | `packages/ai/src/values.ts` | exact and `LIKE` matching; the information audit put the ceiling at 3.9pp, so this is not the gap |

The first three are mechanisms. The fourth is a measurement this repository believed it had and did
not: `linking: true` adds a hint line and removes nothing, so the recall result — every gold
identifier visible in 1,534 of 1,534 dev questions — was true and was not evidence about pruning.

### This round implements the first one, in both positions

`packages/ai/src/sql-like.ts` reads a statement back into the eight labelled steps that produced it:

```
Intent: count
Tables: orders, customers
Joins: o.customer_id = c.id
Filters: o.status = 'refunded'
Group: c.region
Order: count(*) DESC
Limit: 3
```

Read backwards rather than generated forward. The paper's version is self-taught: a strong model
writes the reasoning for each training row, which costs a call per row and inherits that model's
mistakes. Recovering the steps from the labelled statement costs nothing, cannot assert anything the
gold statement does not say, and covers every row rather than the ones a budget reached. What it
cannot do is invent a step the statement does not encode — a statement does not explain *why* its
aggregate is a count — so the block states the shape and stops.

The reader refuses five shapes outright: set operations, CTEs, subqueries, window functions, and
anything that does not begin with `SELECT`. For a *demonstration* that refusal is load-bearing: a
block whose examples disagree about whether a reasoning section exists teaches that the section is
optional, so a neighbour the reader cannot decompose is **skipped**, and an arm whose neighbours
were all skipped has no block to send and falls back to nothing rather than to its parent's prompt.

Three arms carry it, and the default chain gained exactly one rung:

| Arm | Parent | What changes | Where it runs |
|---|---|---|---|
| `inline+icl-cot` | `inline+icl` | the same neighbours, the same ranking, the same count — each block gains its steps | default chain |
| `inline+reasoning` | `inline+evidence` | the eight-label block is asked for in the prompt; no few-shot change | on demand |
| `inline+icl-cot+reasoning` | `inline+icl-cot` | both positions at once | on demand |

`inline+icl-cot` costs one call per question and no new preparation, which is why it is the rung
this round spends. The other two are the second position and the composition, and a position is not
worth 496 calls until the first one has a reading.

### Does the reader fire at all? 86.2%, measured before the run

An arm whose mechanism refuses most of its inputs is its parent with a different name, and this
repository has paid for that lesson twice (`inline+retrieval` with an empty corpus, the `values`
block with no matches). So the reader was measured against the corpus before any arm ran it: over
Mini-Dev's 500 gold statements, **431 decompose (86.2%)** and 69 are refused.

| Refusal | Count | Share of refusals |
|---|---|---|
| subquery | 57 | 82.6% |
| not a `SELECT` | 6 | 8.7% |
| window function | 3 | 4.3% |
| `EXCEPT` | 2 | 2.9% |
| `UNION` | 1 | 1.4% |

Subqueries dominate, which is what a corpus of analytical questions should look like and what the
conservative rule costs. At `k = 3` neighbours, a 13.8% refusal rate means a block usually carries
two or three examples rather than three — and `controls.stepDemonstrationBlocks` reports the count
per question, so a run that quietly lost its examples is visible as a number rather than inferred
from a flat delta.

The measurement is on gold statements, not on retrieved neighbours. Both are BIRD's own annotated
SQL, and the retrieval adds a filter (a neighbour without a statement is not usable as a
demonstration), so 86.2% is the ceiling for this reader on this corpus rather than a prediction of
what a run will carry.

### The reading, and what it corrected

The dev split, 1,532 questions, one call a case, both arms in one run:

| Arm | Passed | Accuracy | Examples in the block | Mean prompt |
|---|---|---|---|---|
| `inline+icl` | 737 / 1,532 | **48.11%** | 4,553 | 4,512 chars |
| `inline+icl-cot` | 725 / 1,532 | **47.32%** | 4,550 | 4,546 chars |

**The step block did not help: −0.78pp, 53 cases only in the parent against 41 only in the child,
p = 0.256, CI [−2.02, +0.46], MDE 1.77pp.** The comparison is clean — the example count is three
apart on 1,532 questions, the prompt is 34 characters longer, both arms cost one call and both were
answered by the same served model — so the delta is the block and nothing else. The block is inside
its own confidence interval, which means the honest reading is *no effect measured*, not *harm*.

**The number to look at is 48.11%, not the delta.** `inline+retrieval` — the same arm without the
examples — reads 40.9 to 41.9% on this split across four published runs, so the neighbours are worth
**+7pp** over retrieval alone. Cross-database demonstrations are not the weak part of that arm. What
is weak is the arm: `inline+retrieval` *replaces* BIRD's per-question evidence with retrieved
definitions, and `inline+evidence` reads 61.10%. The examples have been priced only on a prompt that
had already traded away 20 points of hint.

That is the defect this round's second half is about. `inline+evidence+icl` has been in the
catalogue since the retrieval experiments, paired and registered, and **it has never been run** —
the same failure mode as `inline+retrieval` before it, and the reason `test/bird-arms.test.ts` now
holds the chain's arm list against the baseline's. Every competitor stacks few-shot on the complete
pipeline, hint included: CHASE-SQL retries with demonstrations, OpenSearch-SQL retrieves `Query-CoT-SQL`
triples into a prompt that carries the evidence. Our +0.91pp for `inline+icl` was measured in the one
position none of them use.

So a third arm was added and three are dispatched on the same 1,532 questions:

| Arm | Parent | What it is |
|---|---|---|
| `inline+evidence` | — | the strongest single-call arm, 61.10% |
| `inline+evidence+icl` | `inline+evidence` | the same few-shot shape the competitors use, on the hint |
| `inline+evidence+icl-cot` | `inline+evidence+icl` | the same block with its steps |

### The three arms, and the path they close

Same split, same run, one call a case:

| Arm | Passed | Accuracy | Examples | Mean prompt |
|---|---|---|---|---|
| `inline+evidence` | 933 / 1,532 | **60.90%** | — | 2,568 chars |
| `inline+evidence+icl` | 945 / 1,532 | **61.68%** | 4,553 | 4,056 chars |
| `inline+evidence+icl-cot` | 949 / 1,532 | **61.95%** | 4,553 | 4,090 chars |

| Comparison | Delta | Discordant | p | CI | MDE |
|---|---|---|---|---|---|
| hint → hint + few-shot | **+0.78pp** | 72 : 84 | 0.379 | [−0.81, +2.38] | 2.28pp |
| → + steps in each example | **+0.26pp** | 40 : 44 | 0.744 | [−0.91, +1.43] | 1.68pp |
| retrieval → retrieval + steps (earlier) | **−0.78pp** | 53 : 41 | 0.256 | [−2.02, +0.46] | 1.77pp |

**Every delta is inside its own interval.** The sign of the step block even flips between its two
positions — negative on the retrieval arm, positive on the hint arm — which is what a null effect
looks like when it is measured twice. Since the two arms differ only in the block (4553 examples
against 4553, 34 characters of prompt), the honest verdict is **no measurable effect**, and the
decision that follows is to close the path rather than to keep tuning it.

What it closes is narrower than "few-shot does not work", and the narrower statement is the one the
data supports:

- **The mechanism is not worthless.** On the retrieval arm the neighbours were worth +7pp
  (41% → 48%). What fails is the decoration: reading a gold statement back into eight labelled
  steps adds nothing a model can use, on either arm.
- **The competitors' gain cannot be borrowed by copying the shape.** OpenSearch-SQL credits
  self-taught CoT — reasoning *generated* by a strong model, which can say why an aggregation is a
  count. Reading the steps *back* from the statement cannot say that, by construction, and this is
  the measurement of that limit rather than an argument about it.
- **The wall is not in the prompt.** `inline+evidence+icl-cot` is 61.95% at one call; the four-call
  `select-mixed` is 62.34% on this split. **Three more calls buy 0.4pp.** That is the number to
  carry into the next round: the candidates are correlated, so sampling more of them is not a
  lever, and no rearrangement of the prompt has moved this split by more than noise since the
  chain was cut.

A last observation that is a reading rather than a plan: these three arms and the four-call arm all
land within 1.5pp of each other, and the four published no-training competitors are separated from
us by 3 to 7. **The gap is not in how the question is worded to the model.** Naming what it *is* in
requires the next measurement — an execution-time alignment layer, which is what OpenSearch-SQL's
Refinement and Alignment modules actually do — rather than another prompt shape.

## The largest failure class is not the literals: 160 `values` cases, decomposed

Every arm's biggest bucket on Mini-Dev is `values`, and the name invites a specific reading — the
statement ran, returned rows, and the rows were not the gold's, therefore a value was written
wrongly, therefore value handling is the gap. The count is real: on `inline+evidence`, 496
questions, 273 pass and 223 fail, of which **160 are `values`** (71.7%), 52 are `column-count`
(23.3%) and 11 are execution errors.

The decomposition is what decides whether a rule can reach them. Each case was read for the
syntactic shape that distinguishes it from its gold, and the classes are not exclusive:

| shape | cases | what a deterministic rewrite could do |
| --- | --- | --- |
| the two statements read different tables | **60** | nothing — the choice of `from` is the question's meaning |
| a different aggregate | **41** | nothing — `COUNT` against `SUM` is a reading of the question |
| the prediction reads *fewer* tables | 30 | nothing; it is the case above, one direction |
| `CAST`/`CASE WHEN` arithmetic against a plain aggregate | 28 | nothing |
| the prediction carries an `distinct` the gold does not | 25 | nothing — removing it changes the row set |
| the prediction reads *more* tables | 17 | nothing |
| the prediction is missing a `distinct` the gold has | 12 | nothing |
| grouping present on one side only | 10 | nothing |
| deeper nesting than the gold | 5 | nothing |

**Not one of these is a literal.** They are readings of the question, and no rule that does not
understand English can choose between a `COUNT` and a `SUM` or decide that a join is missing. The
class name was a description of the symptom — the values differed — and reading it as a diagnosis of
the literal layer is the mistake this section exists to prevent.

### What the literal layer can still reach, priced at zero calls

Two rules were priced offline, by executing the archive's own statements against the cached
databases with the rewrite applied and comparing to the gold result under the official judge. No
model was called, which is why the numbers are exact rather than sampled.

**Calendar notation.** The question says 9 September 2019, the column stores `2019-09-09`, and the
statement says `'9/9/2019'`. `ground.ts` already settled case; this round adds the second reading —
the same calendar day in another notation — with three refusals that are the whole of its safety:

- **A numeric date that could be read two ways.** `3/4/2019` is 4 March or 3 April and the statement
  never said which. The rule declines; a first component above 12, a second above 12, or two equal
  components are the three cases where the numbers settle it.
- **A day the calendar does not have.** `2019-02-30` parses as three numbers. Month range, day range
  and month length are checked, including the century exception that `year % 4` alone would miss.
- **A precision that differs.** A day is not an instant. Writing `'2019-09-09 08:00:00'` into a
  statement that asked about a day narrows it to one row, and writing `'2019-09-09'` into a
  comparison against a timestamp column matches nothing, so the rule only answers within one
  precision.

| reading | on 496 Mini-Dev questions |
| --- | --- |
| statements the rule changed | **2** |
| cases it repaired | **2** |
| cases it broke | **0** |
| net | **+0.40pp** |

Both repaired cases are one database and one column: `expense.expense_date` and
`income.date_received`, written as `2019-8-20` and `9/9/2019` against columns that store
`2019-08-20` and `2019-09-09`. The rule is kept because it is exact, costs nothing, and cannot lose a
case; it is not a lever. **+0.40pp is inside the interval of any arm this repository runs**, and the
honest statement is that the literal layer is close to exhausted rather than that it was improved.

**Top-K absence.** A question that asks for a ranking and a statement that carries no `limit` is
OpenSearch-SQL's `style` alignment check, and it is the reverse of the `stripUnfoundedCap` rule this
repository already ships. Priced the same way:

| reading | cases |
| --- | --- |
| failing questions whose text names a rank and whose statement has no `limit` | 19 |
| of those, gold statements that carry a `limit` | **6** |
| failing questions whose statement has neither `order by` nor `limit` | 14 |
| of those, gold statements that carry a `limit` | 4 |

Six cases is a ceiling of +1.21pp before any cost, and the rule is not free: a `limit` has to be
placed after the right `order by`, and a statement that ranks nothing has no clause to attach it to.
The four-case subset is smaller still. **Not implemented**, and recorded here so the next round does
not re-derive it: the `style` check that reads as the most mechanical of the three alignment kinds is
worth at most a point on this split.

### A fourth check that looked free and is not: the answer's shape

The one prior that costs nothing to compute is the shape of the result. A question that says "how
many" or "what is the average" wants one number, and a candidate that returns one row of one column
is the only one that answers it. The predicate is accurate: of 115 Mini-Dev questions that ask for a
scalar and name no grouping ("each", "per"), **104 have a gold of exactly 1×1** — 90.4%.

Used as a *selection* rule over three candidate statements written by three different prompts
(`inline+evidence`, `metadata+evidence`, `values`) on 453 questions, it changed the choice
**once**. `shortest` scored 294 and the shape rule scored 294.

The reason is structural and worth stating, because it is the same reason the selector's 6.1pp has
not moved: **candidates rarely disagree about shape.** Three statements that read the same question
return the same width, so a prior on shape has nothing to separate. It is not that the predicate is
wrong — 90.4% is high enough to act on — it is that the defect it describes is not where the
candidates differ. Recorded so the next round does not implement it.

### What this leaves, and why the next lever is generation rather than a rule

Three mechanical checks have now been priced on the same 496 questions: the cap (already shipped,
+0.40pp), the calendar (+0.40pp), and top-K absence (≤1.21pp, not shipped). Together they bound the
deterministic layer at roughly two points, and each is a rewrite of a statement whose *reading* was
already right.

The failure decomposition says where the rest is: 60 cases read the wrong tables and 41 use a
different aggregate. Neither is reachable by an edit that does not know what the question asked. The
`select` arm's own numbers say the same thing from the other side — on the same corpus `agreement`
is **0.901**, so three samples of one prompt agree on nine tenths of the questions, and a vote over
them cannot separate the cases that disagree. A selector is choosing among near-copies on 90% of the
set, which is why its 6.1pp of `selectionLoss` has resisted every rule tried against it.

The reading this leaves is uncomfortable and is written down as a reading: **the gap to the
systems that train nothing is in what the prompt makes the model write, not in what this repository
does to what it wrote.**

## The lever that was never switched: the column hint

The round before this one ended with a plan: cut the schema card down to the columns the question
needs, the way RSL-SQL does when it reports a 94% strict recall. The plan had a kill criterion — if
strict recall came in under 94%, the path is refused. It came in at **52.8%**, and the reason turns
out to be more useful than the lever would have been.

### The pruning measurement, and the layer it fails in

Every number below is offline: the gold statement is read for the columns it names, a pruning rule
is applied to the schema, and the result is checked for whether every one of those columns survived.
No model is called.

| rule (500 Mini-Dev questions) | strict recall | reference recall | columns kept |
| --- | ---: | ---: | ---: |
| linked columns + foreign-key columns | 28.8% | 78.6% | 26.4% |
| … plus every `*id` column | 30.2% | 81.1% | 32.9% |
| … plus every `*name*` column | 43.8% | 86.4% | 36.5% |
| the last rule, with column values supplied to the `value` recaller, `topK` 30 | **54.0%** | 90.6% | 38.9% |

The last row is the ceiling of the family, and it is 40 points short of the criterion. Splitting it
says why:

| layer | rate |
| --- | ---: |
| gold **tables** all kept | **98.11%** |
| gold **columns** all kept | 52.84% |
| gold columns the linker names at all (`topK` 30, all three recallers) | **46.75%** |
| gold columns all kept, with the gold's own tables given as a starting point | 52.21% |

Table selection is not the problem — one hop over the declared foreign keys keeps the gold's tables
98% of the time. The problem is one layer below: **the linker names 46.75% of the columns the answer
uses**, so any rule that keeps only what the linker names can keep at most 46.75% of what is needed.
Pruning is not a lever that was tuned wrong; it is a lever behind a linker that has to get better
first, and the card is 100% covered today precisely because nothing prunes it.

The refusal reproduces on the dev split (1,452 questions with a parseable gold column set, all
eleven databases, values supplied to the third recaller):

| layer | Mini-Dev | dev |
| --- | ---: | ---: |
| gold **tables** all kept | 98.11% | **98.35%** |
| gold **columns** all kept | 52.84% | **55.79%** |
| gold columns the linker names | 46.75% | **49.41%** |
| columns kept by the widest rule | 38.9% | 38.5% |

Three points of difference on 1,452 questions, and the same conclusion at both sizes: the ceiling is
the linker, not the pruning rule.

### What RSL-SQL actually does, read from its source

`src/bid_schema_linking.py` in [Laqcce-cao/RSL-SQL](https://github.com/Laqcce-cao/RSL-SQL) is the
"bidirectional" linking its paper credits. It is shorter than the name suggests, and the three
sources it unions are:

1. **The statement it already wrote.** `extract_from_sql` scans the preliminary SQL for every column
   name in the database: `if column in sql`. Not a question-to-column model — a substring scan of
   its own output.
2. **The dataset's hint.** `extract_from_hint` does the same over `dev_set[i]['evidence']`:
   `if column in hint.lower()`. Also a substring scan, over text this repository already places in
   the prompt.
3. **An LLM's own column list**, in a separate file.

Then `merge` unions the three and `filter` keeps only names the database has. The 94% is what three
scans recover when one of them reads a statement the model already wrote — not a retrieval model
beating ours. The first source is unavailable before generation. **The second is available and this
repository never used it.**

### The hint, measured as an asset

The hint is the line `Likely columns: …` placed above the question. On 500 Mini-Dev questions, with
the linker the prompt uses (`topK` 12, name/alias/value) — precision can only be measured against a
gold statement, so this table is the sample:

| hint built from | precision | recall | columns named | characters |
| --- | ---: | ---: | ---: | ---: |
| the question (shipped) | **29.82%** | 39.26% | 7.4 | 147 |
| question + evidence | 31.39% | **55.15%** | 9.8 | 195 |
| question + evidence, `topK` 30 | 31.39% | **68.30%** | — | — |

Read the first row twice. The hint names 7.4 columns a question, and **fewer than a third of them
are columns the answer uses** — a list that is wrong about two entries in three, printed above the
question, on every arm this repository has ever run. And the second row says the fix is not to
sharpen the linker: it is to give it the text the model is already reading, which recovers 16 points
of recall at the same twelve slots and at no extra precision cost.

Both rows reproduce on the split that decides adoption. On the 1,534-question dev split (7,672 gold
columns, no model calls):

| hint built from | column recall | questions fully covered |
| --- | ---: | ---: |
| the question, `topK` 12 (shipped) | 41.45% | 10.72% |
| the question, `topK` 30 | 47.11% | 15.03% |
| question + evidence, `topK` 12 | **55.20%** | 20.92% |
| question + evidence, `topK` 30 | 66.50% | 33.33% |
| evidence alone, `topK` 30 | 48.10% | 17.39% |

The last row is the one that rules out a confound: the evidence is not a hint about *this* question
that the question already carries, it is a second source. Read alone it covers 48.10% of the gold
columns — more than the question does.

Which raises the question the file has never asked: **is the hint worth having at all?** Every arm
in `eval/bird/run.ts` sets `linking: true`. There is no arm with it off. Two arms are added here —
`inline+evidence-nolink` and `inline+evidence+link-evidence` — and they are the cheapest experiment
in the catalogue: one flag each, no new mechanism, and a parent whose reading already exists on both
splits.

### What this changes about the plan

The remaining steps, in the order the numbers support:

1. **Does the hint help?** (`inline+evidence-nolink`, one call, 1,532 questions.) A 30%-precise list
   in front of a question is as likely to be a distractor as a hint. If it is one, deleting it is a
   gain that costs tokens as well as accuracy, and every future arm inherits it.
2. **Does reading the evidence help?** (`inline+evidence+link-evidence`.) The offline delta is
   +16pp of recall; whether that reaches the answer is the measurement.
3. **Pruning stays refused** until the linker's column recall passes the criterion, and the way to
   raise it is now known: the third RSL-SQL source, the model's own preliminary statement, is
   already in this pipeline on the repair and selection arms.

### The two arms, measured: the hint is neutral, and the evidence does not reach the answer

Run `43185842566`, dev split, 1,532 scored questions, one call per question, `served: deepseek-flash`.

| arm | accuracy | delta vs parent | discordant | p | 95% CI | MDE |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| `inline+evidence` | 934/1,532 · **60.97%** | — | — | — | — | — |
| `inline+evidence-nolink` | 942/1,532 · **61.49%** | **+0.52pp** | 48 : 56 | 0.493 | [−0.78, +1.83] | 1.86 |
| `inline+evidence+link-evidence` | 937/1,532 · **61.16%** | **+0.20pp** | 40 : 43 | 0.826 | [−0.97, +1.36] | 1.67 |

Both deltas are positive and both are far inside their own intervals. Read as verdicts: **the hint is
not an asset, and it is not a liability either** — removing a list that is wrong two entries in three
moves the score by eight cases in 1,532. And **raising the hint's recall by fourteen points does not
move the answer** by more than three cases.

That is not a failed experiment; it is the closure of an argument the last two rounds were building
toward. The card shows every column of every table — `controls.schemaMissingTotal: 0` on this run,
1,534 identifiers for 1,534. Under that condition the hint cannot add information; it can only
**re-order a list the model has already been given**. Re-ordering a complete list is worth nothing,
which is exactly what both arms measure, one from each side.

So the hint becomes a lever only when it stops being a re-ordering and starts being a **filter** —
and a filter is the pruned card, which the previous section refused at 52.8% strict recall. The two
readings agree, and together they say the same thing from opposite ends:

> **The schema layer is exhausted at both of its ends.** You cannot prune (the linker loses half the
> required columns), and you cannot re-order (the model already sees everything). What is left is
> what the model writes *given* a complete schema.

### What RSL-SQL's prompt has that this one does not

The refusal points at the linker, so the prompt templates were read next. `src/configs/Instruction.py`
names its inputs five times, and one of them is not on this repository's card:

> *The first three rows of values in the table: sample data for understanding the content and data
> distribution of the table.*

That is a **row sample**, not a column sample. This repository ships two column samplers (`profile`
and MAC-SQL's `example`) and both were closed at a 2.22pp ceiling — but a column sample shows a
value's domain, while three rows show **which values occur together**: `status = 'Banned'` in the
same row as `currency = 'EUR'`, the pairing no per-column block can express. It is the one input in
RSL-SQL's prompt that this repository has never put in front of a model, and unlike its other
signature mechanism it needs no training and no second call.

**Its price, measured before building it** — the rule this file has been paying for since the
alignment layer. Three rows of every table the gold statement reads, rendered `table: col=val, …`,
on the 1,534-question dev split:

| form | characters per question (mean / median / p90) | gold literals present | questions with any |
| --- | --- | ---: | ---: |
| every column | 1,642 / 948 / 4,888 | 37.2% | 549 / 1,534 |
| text columns only | **1,058 / 483 / 3,244** | 33.8% | 499 / 1,534 |

Against a prompt of 676 tokens (≈2,700 characters) the narrow form is **+39% at the mean and +18% at
the median**, and it makes the prompt's cost tail much fatter — p90 triples. The literal coverage is
not the reason to build it: `values` already resolves 600 of the question's own literals at almost no
cost. The reason is the one thing no column block can carry — **which values occur together**. A row
sample is the only form in which `status='Banned'` and `currency='EUR'` appear on the same line.

So the lever is real, its price is bounded, and the form to test is the narrow one with a per-question
budget, not the whole-row dump. That test is the next round's, and the prediction is registered here
before it runs: if the pairing hypothesis is right, the gain concentrates on questions whose gold
literal the `values` block never found; if it is wrong, the arm lands inside ±1.7pp of its parent and
the schema layer is closed entirely rather than at both ends.

### The third arm, measured: new information that does not move the answer

Run `43198451668`, dev split, 1,532 scored questions, one call per question, `served: deepseek-flash`
on 1,532 of 1,532 cases.

| arm | accuracy | delta vs parent | discordant | p | 95% CI | MDE |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| `inline+evidence` | 939/1,532 · **61.29%** | — | — | — | — | — |
| `inline+evidence+rows` | 944/1,532 · **61.62%** | **+0.33pp** | 52 : 57 | 0.702 | [−1.01, +1.66] | 1.91 |

What it cost:

| | parent | rows arm | change |
| --- | ---: | ---: | ---: |
| prompt characters (mean) | 2,568 | 3,144 | **+22.4%** |
| prompt tokens (mean, endpoint's own count) | 676 | 887 | **+31.2%** |
| cached prompt tokens (mean) | 484 | 633 | +30.8% |
| completion tokens (mean) | 49 | 53 | +8.2% |

By difficulty, the whole of the movement is in the hardest bucket, and it is three cases:

| difficulty | parent | rows arm | delta |
| --- | ---: | ---: | ---: |
| simple (925) | 620 | 622 | +0.22pp |
| moderate (463) | 248 | 248 | 0 |
| challenging (144) | 71 | 74 | +2.08pp |

**Read the parent's own row first.** The same arm, unchanged, scored 934 on `43185842566` and 939 on
`43198451668` — **+0.33pp of run-to-run drift on the identical prompt**, which is exactly the size of
the delta this round was dispatched to detect. The samples are drawn at the endpoint's default
temperature, and at 1,532 questions one arm's own resampling moves it by five cases. Any effect
smaller than that is not visible in one run of this harness, whatever the pairing arithmetic says.

**So the verdict is the pre-registered one.** The prediction registered before this arm ran (§ *What
RSL-SQL's prompt has that this one does not*) was: the gain concentrates on questions whose gold
literal the `values` block never found, or the arm lands inside ±1.7pp of its parent and the schema
layer is closed **entirely** rather than at both of its ends. The arm landed at +0.33pp with a
confidence interval that contains zero and a discordant split (52 : 57) that points the wrong way for
a pairing effect. The schema layer is closed.

**That closure is stronger than the hint's, and this is why it matters.** The hint result could be
explained away — the card shows all 1,534 identifiers (`controls.schemaMissingTotal: 0`), so a hint
can only re-order a list the model already has. A row sample is not a re-ordering. It is **text that
was not in the prompt before**: which values occur on the same line, the one property no per-column
block can carry. Under a complete schema, that was the last candidate for information the model was
missing. It is worth +0.33pp and +31% of the prompt, which is indistinguishable from the arm
resampling itself.

Three levers have now been measured against the same parent and all three land inside the noise:

| lever | delta | 95% CI | verdict |
| --- | ---: | --- | --- |
| the hint, removed | +0.52pp | [−0.78, +1.83] | neutral: the card already shows every column |
| the hint, reading the evidence | +0.20pp | [−0.97, +1.36] | neutral: same reason |
| three stored rows per table | +0.33pp | [−1.01, +1.66] | neutral: new information, same answer |

The next lever cannot be another block in the prompt. The failures the artifact records are the
pointer: `values` 160 of 223 on Mini-Dev, and **none of them a wrong literal** — 60 read a different
table, 41 group differently, 30 read fewer tables. Those are decisions about the *statement*, taken
once per question, and the prompt is not where they are made. The row-sample arm is kept in the
catalogue as the ablation reference that closed the layer, not as a candidate to adopt.

## How many candidates, and why the answer was never "as many as the competitor"

The strongest training-free system on this benchmark is
[`OpenSearch-AI/OpenSearch-SQL`](https://github.com/OpenSearch-AI/OpenSearch-SQL) (MIT): first
place on BIRD in August 2024, **69.3% dev / 72.28% test / 69.36% R-VES**, and by its own README it
"operates without the need for additional training". Its `run/run_main.sh` declares
`"n": 21, "temperature": 0.7` for candidate generation and aggregates by *executed result* —
`vote.py` compares `set(tuple(row))` per candidate and breaks ties on the fastest query, so two
different statements that return the same rows count as one opinion.

This repository implements the same equality (`resultFingerprint` hashes `resultKey`, the official
judge's own notion of a match) and had never fed it more than five candidates. That gap, not the
backbone, is what the readings in this file have been pointing at:

| arm | candidates | calls | accuracy | ceiling | conversion |
| --- | ---: | ---: | ---: | ---: | ---: |
| `select-mixed` | 3, three prompts | 4 | 62.34–63.3% | 65.5–65.8% | 96.1% |
| `select-cross` | 3, two models | 4 | **64.1%** | 67.0–68.33% | 94.7% |
| `vote-cross` | 3, two models | 3 | 62.9% | **69.6%** | **90.2%** |

`vote-cross`'s set holds a correct statement 69.6% of the time — the highest ceiling measured here,
and the same level as the competitor's published score — and returns 90.2% of it. Converting at
`select-mixed`'s 96.1% would be 67.8%. The remaining distance to 69.3% is therefore not "a stronger
model"; it is forty-odd questions already drawn, executed, and thrown away.

### The ladder climbs by prompt, then by repetition

| arm | sources | candidates | calls |
| --- | --- | ---: | ---: |
| `select-mixed` | 3 prompts × 1 | 3 | 4 |
| `select-mixed-spread2` | 3 prompts × 2 | 6 | 7 |
| `select-mixed-spread3` | 3 prompts × 3 | 9 | 10 |

**Withdrawn.** This section used to say that three prompts reached a 65.8% ceiling where five
samples of one prompt reached 64.7%, with two fewer calls — evidence that prompt diversity beats
sampling diversity. The two sides of that comparison were not measured at the same coordinate.
Every multi-prompt arm drew its candidates at **temperature 0**: the request builder read the
temperature off the `target` arm, and a mixed arm's `target` is the *source* it is drawing from,
which declares no `vote` and so resolved to the single-draw constant. `select5` samples at 0.7 and
`select-mixed` was repeating a deterministic request three times, so the 1.1pp was a difference
between two variables, not one. The claim is withdrawn to "no evidence" rather than refuted: it has
not been measured.

What the artifact from the six-draw run (`43379716079`, Mini-Dev 496, `deepseek-chat`) does
measure, at one coordinate, is how little a second pass over a temperature-zero pool buys:

| reading | three draws | six draws |
|---|---|---|
| distinct executed results per question | 1.264 | 1.331 |
| questions the second pass added no answer to | — | 462 of 493 (93.7%) |
| questions converted from "no correct candidate" to "one" | — | 6 |
| `candidateRecall` | 64.31% | 65.93% (+1.62pp, bar was +2pp) |

Unanimity is 74.85% of questions and 29.8% of those unanimous answers are wrong, so the pool
carried one opinion most of the time and the added draws restated it. The defect and its repair are
in the changelog; the arms that now measure the coordinate properly are `select-mixed-cold` (0),
`select-mixed` (0.7 after the repair) and `select-mixed-hot` (1), all at three candidates and four
calls.

**Pre-registered:** distinct executed results per question must reach 1.50 at 0.7 from the cold
arm's 1.26, and `candidateRecall` must rise at least two points. A ceiling that does not move
closes the sampling family — draw count, source count and temperature are then one measurement.
A ceiling that rises while accuracy does not belongs to the selector, not to the generator.

### What the competitor's cost actually is, in requests

Its `n: 21` is one HTTP request that returns twenty-one completions (`src/llm/model.py` puts `n`
straight into the request body). This endpoint has no `n`, so twenty-one candidates are
twenty-one requests: the same tokens, twenty-one times the failure surface. That cuts both ways —
its candidate set is all-or-nothing on a timeout, while this harness records survival per source
(`candidateSurvival`) and can score a set that lost one draw. A larger candidate set is the one
place where the absence of `n` is not purely a cost.

### The dose-response curve for temperature

Run `43404099480`, Mini-Dev 496 questions, `deepseek-chat`, four arms in one dispatch differing only in `temperature`, three candidates and 3.99 calls each.

| arm | T | accuracy | candidateRecall | realization | distinct answers / question | unanimous questions |
|---|---|---|---|---|---|---|
| `select-mixed-cold` | 0 | **59.88%** | 64.52% | **92.81%** | 1.256 | 77.0% |
| `select-mixed` | 0.7 | 59.68% | 66.53% | 89.70% | 1.316 | 73.4% |
| `select-mixed-hot` | 1 | 59.48% | **67.54%** | 88.06% | **1.440** | 65.2% |
| A/A of the middle rung | 0.7 | 58.27% | 64.72% | 90.03% | 1.347 | 70.8% |

Paired across questions, cold to hot: `candidateRecall` **5 wins 20 losses, p = 0.0041** — the pool really did widen. Accuracy **16 wins 14 losses, p = 0.8555**, inside the A/A resolution of 3.44pp — the score did not move. **Fifteen more questions had a correct candidate in the pool and two fewer were answered correctly**, because realization fell from 92.81% to 88.06%.

That is the pre-registered branch "a ceiling that rises while accuracy does not belongs to the selector", and it is the cleanest evidence this repository has for it: same split, same card, same judge, same bill, one variable. The mechanism is not mysterious — the selector was measured on a narrow pool where 77% of questions had all three candidates returning the same rows, and a wider pool turns "which statement answers the question" into a choice between three genuinely different readings.

Two things it also measures. **Unanimity is a knob now**: 77.0% at temperature 0, 65.2% at 1, which explains why repeating a prompt does nothing (a repeat does not change the distribution) and raising the temperature does. And **temperature is free**: 3,566 / 3,569 / 3,567 prompt tokens and 176 / 179 / 179 completion tokens across the three arms, against the +75% of the six-draw arm. Widening a pool by temperature costs nothing; widening it by draws costs 75%.

The next arm follows from that arithmetic rather than from taste: `select-mixed-hot-rule` — temperature 1 with a zero-call rule choosing, three calls a question instead of four, and a bar of 92.81% realization (the cold arm's) with accuracy at or above 62.0%.

### Where the ceiling goes: agreeing and disagreeing pools

Run `43404099480`, Mini-Dev 496, `deepseek-chat`, one dispatch, three arms differing only in
`temperature`. The artifact's own candidate records can be re-read at no cost — the question every
later mechanism has to answer is not "how high is the ceiling" but "where does the distance between
the ceiling and the score live". Grouping each question's three candidates by the judge's equality
answers it:

| arm | temperature | questions with one result | ceiling there | realized there | questions that disagree | ceiling there | realized there |
|---|---|---|---|---|---|---|---|
| `select-mixed-cold` | 0 | 372 | 69.35% | 69.35% | 112 | 54.46% | — |
| `select-mixed` | 0.7 | 350 | 70.57% | 70.57% | 129 | 62.02% | 35.66% |
| `select-mixed-hot` | 1 | 309 | 74.76% | 74.76% | 165 | 61.21% | 36.97% |

Two facts follow, and both are arithmetic rather than argument.

**On an agreeing pool the choice is worth nothing.** The realized column equals the ceiling column
exactly, for every arm, because every candidate returns the same rows and the judge scores rows. On
350 of 479 questions at temperature 0.7 the model selector, `shortest` and `modal` all score
70.57% — the same number to the case. The fourth call is not cheap there; it cannot be spent.

**On a disagreeing pool the choice is worth 26 points and is not being made.** The ceiling is
62.02% and the best chooser reaches 44.19% (the `shortest` rule), the model selector 35.66% and
`modal` 26.36%. That population is 27% of the split, so 17.8 points unrealized there is 4.8 points
of overall score — the largest measured reserve in this repository, and the one every "add a
candidate" or "add a card" lever has been failing to reach.

Reading the same artifact through `bench:bird:consensus` prices the three call-free rules against
the selector on the whole split, at each coordinate:

| arm | `first` | `shortest` | `modal` | model | oracle | paired, `shortest` vs model |
|---|---|---|---|---|---|---|
| `select-mixed-cold` | 57.86% | **61.49%** | 58.67% | 59.88% | 64.52% | 15 / 7, p = 0.13 |
| `select-mixed` | 57.26% | **61.90%** | 58.06% | 59.68% | 66.53% | 24 / 13, p = 0.10 |
| `select-mixed-hot` | 56.25% | **60.08%** | 56.85% | 59.48% | 67.54% | 28 / 25, p = 0.78 |

`shortest` is ahead of the paid selector at all three coordinates and its lead shrinks as the pool
widens (+1.61, +2.22, +0.60 points) — the same story as the table above from the other side: a wider
pool is harder for every chooser, and the free one degrades least. None of the three deltas is
significant at 496 questions, and **that is the point**: every reading in this table is a
*counterfactual*, taken by re-scoring the candidates one arm already drew. At temperature 0.7 the
pool is itself a draw, so a counterfactual understates the variance of an arm.

**The arm disagrees with the counterfactual, and the arm wins the argument.** Run `43421692582`
(five arms in one dispatch, A/A −0.81pp at a resolution of 3.20pp):

| arm | calls / question | accuracy | realization | prompt tokens | selector share | tokens per correct answer |
|---|---|---|---|---|---|---|
| `select-mixed` (0.7 + model, control) | 3.99 | 60.08% | 91.41% | 3,568 | 99.4% | 5,939 |
| `select-mixed-rule` (0.7 + `shortest`) | **3.00** | 59.07% | 90.43% | **3,121** | 0% | **5,283** |
| `select-mixed-gated` | **3.30** | 59.48% | 90.21% | 3,271 | **29.8%** | 5,499 |
| `select-mixed-gated-evidence` | 3.31 | **60.89%** | **91.79%** | 3,318 | 30.6% | 5,449 |

Paired against the control: the rule arm is **−1.01 points (23 wins, 18 losses, p = 0.53)**, inside
the resolution, and its own pool differs in structure from the control's (358 agreeing questions
against 350; the A/A has 345). Three arms, three pools — which is why the counterfactual's +2.22 and
the arm's −1.01 are not in conflict: **neither is a measurement of an accuracy difference.** What the
dispatch does measure is cost, and it is unambiguous: **−25% calls, −12.5% prompt tokens, −11.0%
tokens per correct answer, with no accuracy difference this split can resolve.**

The gate passes all three of its pre-registered bars — accuracy −0.60 points (inside the one-point
invariance, p = 0.74), 3.30 calls, 29.8% of questions reaching a selector — and its accounting closes:
346 questions stopped by the gate plus 148 that reached the selector is 494, the number of questions
that had a candidate at all. The evidence arm is the best of the four on two of three readings
(60.89% accuracy, 91.79% realization) for 1.4% more prompt tokens, but its +1.41 points over the gate
(p = 0.28) falls below the pre-registered two-point bar, so it is **not adopted**: the hypothesis that
the judge is blind is neither confirmed nor refuted at 496 questions, where 143–152 disagreeing
questions cannot resolve a two-point effect (the A/A itself moves 2.08 points on that subset).

A correction this round owes its own past: the previous entry's "a rule that spends no call is never
behind the call and costs 25% less" is withdrawn to **"costs 25% less, and no split measured here can
tell its accuracy from the selector's"**. Four of five readings lean toward the rule and one leans
away; the votes are all inside their own resolutions, and a claim built on them would be a claim about
noise.

### The next mechanism is deliberation on the disagreeing pool, not another card

The four arms above close the text-level question. The reserve that is left is not in the pool and
not in the prompt: on the 27% of the split whose candidates disagree, the ceiling is 62.02%, the best
chooser that reads only statement text reaches 44.19%, and the model selector asked to rank three
absolute candidates reaches 35.66%. Every call-free rule this repository has tried at that level —
fewer joins, fewer predicates, literal grounding, group-by matching — landed within one point of
`shortest`, which is the signature of a family that has nothing more to say. What none of them does
is read the *result* beside the question, and that is the only information the disagreeing pool has
that the agreeing pool does not.

So the next two arms are the same gate with a different adjudication behind it:

| arm | what the judge is asked | calls on a disagreeing question |
|---|---|---|
| `select-mixed-gated-pair` | two candidates, one at a time — a knockout | 2 |
| `select-mixed-gated-reconcile-novel` | the result groups, for a statement to run | 1 |

The knockout is CHASE-SQL's selector shape — a binary comparison rather than an absolute ranking —
made conditional for the first time. Its price is a closed form, `k - 1` comparisons per case, which
is why the harness can check the bill against the pool instead of trusting a counter. The reconcile
turn is the shape that reached the 6.5 points of ceiling an index cannot name on the cross pool,
carried over with the policy correction that reading earned: a reply that restates a candidate is
handed back to the vote rather than scored.

Four bars are pre-registered, and they are the ones a paid decision has to clear:

1. **On the disagreeing subset, at least +5 points over `shortest`.** Below that the turn is the
   free rule with a bill attached.
2. **At most two calls per disagreeing question.** The knockout is exactly two; a shape that needed
   three would be the fourth call made twice, and the gate's whole reading is that the fourth call
   is only worth making where it can change the answer.
3. **`pairwise.comparisons` exactly `2 x pairwise.asked`.** Not a target but an identity: a
   tournament that compared anything other than the pool it drew is a bill nobody can attribute.
4. **`reconcile.novel` at least 10% of the replies.** An arm whose statements are all paraphrases of
   its own candidates is a selector with a longer prompt, and the funnel now says so before the
   delta is read.

An unreadable comparison is the failure mode both shapes share and neither could report until this
round: the incumbent is kept, so a tournament that parsed nothing returns the pool's first candidate
and scores exactly what the vote scored. `assertPairwiseFired` refuses that state above the sample
floor, which makes "the knockout did not run" a bug rather than a null result.

### Text2Vis: the corpus is a file, and the loader is a parser

The chart side of this project has one external benchmark that scores a *visualization* rather than a
result set: Text2Vis (EMNLP 2025), one CSV in a public Hugging Face repository, with the question, the
answer, the reference matplotlib source and the chart type the authors judged correct for each row.

`pnpm bench:text2vis:dataset` downloads it once into `eval/.cache/text2vis` and prints what it holds —
the row count, how many rows carry reference code, and the chart types most frequent first. The
command is the whole loader: the CSV is parsed by `parseCsv`, which honours quoted commas, quoted
newlines, doubled quotes, CRLF and a byte-order mark, because the file is prose and a parser that
splits on the delimiter returns the right number of rows and the wrong ones. A header without
`Prompt` is refused by name rather than answered with an empty string: a corpus of blank questions
produces an accuracy that is a number about nothing.

No score is published from this corpus yet. The loader exists so that the first reading is a
measurement of the engine rather than of a download, and the cache is written under a temporary name
and renamed, so a run that dies mid-transfer leaves nothing a later run would parse as half a
benchmark.

### Deliberation, measured: the two shapes lose to a rule that reads length

The pre-registration above was run in one dispatch — five arms, Mini-Dev 496, `deepseek-chat`,
temperature 0.7, A/A +0.60 points (18:21, p = 0.75) at a **resolution of 3.53 points**.

| arm | calls / question | prompt tokens | accuracy | tokens per correct answer | ceiling, disagreeing pool |
|---|---|---|---|---|---|
| `select-mixed-rule` (`shortest`) | **3.00** | **3,121** | **60.48%** | **5,452** | 54.55% |
| `select-mixed-gated` | 3.26 | 3,255 | 59.07% | 5,812 | 56.15% |
| `select-mixed-gated-pair` | 3.59 | 3,359 | 58.87% | 6,008 | 56.38% |
| `select-mixed-gated-reconcile-novel` | 3.28 | 3,274 | 59.48% | 5,876 | 54.61% |
| A/A (`select-mixed-gated` twice) | 3.29 | 3,271 | 59.68% | 5,779 | 53.52% |

**Two of the four bars passed, one failed, and one was written wrong.** The cost bars held — 1.96
and 1.00 calls per disagreeing question — and 35.5% of the reconcile replies carried a statement no
candidate had written. The accuracy bar did not: on the disagreeing pool the knockout is 4.8 points
below `shortest` and the reconcile turn 3.1 points below it. And `pairwise.comparisons` came back
292 against 298, which is not a bug: 143 cases drew three candidates and 6 drew two, and
`143 x 2 + 6 x 1 = 292`. The closed form is `sum(k - 1)`; writing it as "twice the asked cases"
turned a runtime fact into a design constant, and the funnel caught it.

**What the two shapes are worth is not zero, and it is not here.** Restricted to the questions whose
candidate pools *both* disagreed — same cases, same judge, same pool — the knockout beats the
absolute ranking **+5.77 points** (31.73% against 25.96%, 10:16, p = 0.33). That is the third
independent reading in favour of CHASE-SQL's binary selector shape, and the first taken on a matched
pool. Meanwhile `shortest` is 5.13 points ahead of the knockout and 6.67 ahead of the reconcile turn
on the same subsets, so the shape is a real effect inside a layer that is not where the loss lives.

The knockout also has a nameable bias: **67% of its winners are the first slot**, against 55.6% for
`shortest`. Its prompt says "if both would be judged correct, answer 1", which over a `k - 1` chain
makes the incumbent a strong prior. That is a mechanism to fix — randomise the order, or run both
directions and keep the agreement — not a verdict on the model.

Two explanations were closed on the way. **Length is not a proxy for the strongest prompt**: picking
one source every time scores 56.76% (inline), 58.37% (metadata) and 58.93% (values) against
`shortest`'s 60.61%, so the rule reads something inside the pool that source identity does not
carry. And the reconcile turn is **adverse selection**: of 47 adopted statements, 9 were correct
(19.1%), while the 94 replies handed back to the vote scored 38.3% — the model rewrites exactly
where it is least able to.

Verdict: neither shape is adopted. Both stay as ablation references with their funnels intact, the
gate stays an eval mechanism, and the next lever is not "how to choose" but **"where the candidates
come from"** — the disagreeing ceiling is still 54.5–56.4% against a best chooser of 35%.

### Pre-registration: does a fourth candidate convert under a rule, or only under a model?

The pool was read apart without a model call, from the artifact of `43450970534` on Mini-Dev's 496
questions. What it says is arithmetic, and it is the reason the next experiment buys a candidate
instead of a chooser:

| reading | n | share |
| --- | --- | --- |
| questions whose pool held at least one correct statement | 328 | 66.13% |
| questions the shipped rule answered correctly | 300 | 60.48% |
| **questions whose pool held no correct statement** | **168** | **33.87%** |
| of those, pools where all three candidates executed | 156 | 92.9% |
| of those, filed by the judge as `values` | 119 of 167 | 71.3% |
| questions where all three candidates share one fingerprint | 352 | 71.0% |

A chooser cannot reach the 168: there is nothing in the pool to choose. So the ceiling is the only
number a fourth candidate can move, and the closed-form price of a fourth candidate is one call.

What the repository already knows about that purchase is one reading and one gap. `select-intent`
bought a fourth candidate on the dev split and moved the ceiling **+2.22pp** (66.84 → 69.06, 41 up 7
down, p < 0.0001) — and then the **paid selector gave the gain back**, its conversion falling 3.50pp
because a model reading four candidates does not read them as well as it reads three. The gap is
that the shipped chooser is not a model: `shortest` has never ranked a four-candidate pool, and the
dev artifact cannot answer the question because it stored a *selector's* choice rather than a rule's
ranking. That is a run, not a derivation.

Two arms, one call each, no new prompt:

| arm | sources | why this source |
| --- | --- | --- |
| `select-mixed-rule-rows` | the trio + `inline+evidence+rows` | differs in **knowledge**: three stored rows per table can say a literal belongs to a column the question never names, which is what seven filter sites in ten need |
| `select-mixed-rule-intent` | the trio + `intent` | differs in **grammar**: the only candidate whose statement is rendered rather than written, and the source whose ceiling effect is already measured |

Read against `select-mixed-rule` they are two conversion tests; read against each other they say
which *kind* of difference a fourth candidate has to be.

| # | criterion | bar |
| --- | --- | --- |
| ① | pool ceiling, same run, same 496 questions | **≥ +3.0pp** (66.13 → 69.13) |
| ② | `shortest` on the four-candidate pool | **≥ +1.0pp** (60.48 → 61.48) |
| ③ | conversion (`score` ÷ `candidateRecall`) | within **1.0pp** of the parent's |
| ④ | `calls.mean` | **≤ 4.05** |
| ⑤ | noise | A/A of `select-mixed-rule` as the fifth arm; every delta above is read against its resolution |

Pass ①②③ ⇒ the fourth candidate is adopted and the pool is the new default, and the next round
writes the value-anchored source with a measured bar to beat. Pass ① and fail ②③ ⇒ the `select-intent`
finding is reproduced on the free rule, the resolution is a chooser that reads four candidates, and
the source question closes to *knowledge* differences only. Fail ① ⇒ that source adds nothing and
the candidate side is closed for it.

### The fourth candidate does not arrive: both sources are inside the pool's noise

`43473626220`, Mini-Dev's 496 questions, `deepseek-chat`, four arms in one dispatch, the shipped arm
run twice as the A/A (`−0.81pp`, 22 : 18, p = 0.636, **MDE 3.57pp**, discordance 8.06%):

| arm | calls / question | ceiling | accuracy | conversion | tokens per correct answer |
| --- | --- | --- | --- | --- | --- |
| `select-mixed-rule` (the shipped arm) | **3.00** | 66.13% | **61.29%** | **92.68%** | **5,381** |
| `…-rule-rows` (trio + stored rows) | 4.00 | 66.53% | **61.29%** | 92.12% | 6,939 |
| `…-rule-intent` (trio + rendered intent) | 4.00 | 66.73% | 60.08% | 90.03% | 7,312 |
| A/A (`select-mixed-rule`, second run) | 3.00 | 64.92% | 60.48% | 93.17% | 5,451 |

The pre-registered bars were a ceiling of **+3.0pp**, a score of **+1.0pp**, conversion within 1.0pp
and a price of at most 4.05 calls. The ceiling moved **+0.40pp** for the row source and **+0.60pp** for
the intent source; the score moved **0.00pp** and **−1.21pp**; conversion lost 0.56pp and 2.65pp; the
price was 4.00 calls each. Every accuracy criterion failed.

**The A/A is what makes that a verdict rather than a disappointment.** The same arm, run twice in the
same dispatch, moved its own pool ceiling **−1.21pp** (64.92% against 66.13%) and its own score
−0.81pp. So the quantity a fourth candidate is supposed to move is already moving by ±1.2pp between
two draws of one arm: a +0.4 or +0.6pp ceiling delta is not a small gain, it is **indistinguishable
from resampling**, and even the direction of the two sources disagrees.

**The mechanism reading says why.** The fourth candidate was correct on 56.25% of questions (rows) and
44.96% (intent) — it is a perfectly good candidate. But it was the *only* correct candidate on **10**
questions (2.02%) and **7** questions (1.41%), and the rule adopted it on 5 of each. A fourth prompt
from the same model is ~80% redundant with the three prompts that preceded it: the trio already
returns one distinct fingerprint on 71.0% of questions, so what the fourth prompt mostly adds is a
paraphrase. That is the same redundancy `select-intent`'s dev reading measured in a different way
(87.4% rendering, 2.22pp of ceiling at 1,532 questions — a rate that would predict eleven cases on
496 questions; this run found three).

Two costs are worth naming for anyone about to buy a fourth prompt anyway: **+29% tokens per correct
answer** for the row source and **+36%** for intent, against a 3-call parent. The row block also
carries a real prompt expense (3,121 → 4,018 prompt tokens per question) because three stored rows per
table is text.

**Verdict.** The candidate side closes for *prompt-family* sources: a fourth prompt from the same base
model cannot reach the 33.87% of questions whose pool holds no correct statement, because it is the
same model making the same mistake with different instructions. What is left is a candidate that
differs in **weights** rather than in words — a second base model in the pool, which the harness
already supports (`Arm.secondModel`, `CROSS_SOURCES`) — or a generation that spends two calls on one
question instead of one call on a fourth prompt. Neither is a prompt change, and both are priced
before they are built: the second-model candidate has to lift the ceiling by ≥ 3pp while staying
inside 4 calls, which is the same bar this run failed.

### Depth buys the pool and the vote throws it away: the one part of the competitor's harness we never priced

The strongest training-free system on this benchmark draws **21 candidates at temperature 0.7 and
aggregates them by executed result**. This repository measured its own aggregator at three
candidates (`vote-mixed`, `vote-cross`) and measured its ladder's *ceiling* at six and nine, but it
never pointed the free rule at a wide pool — which is the combination the competitor's score
actually stands on, and the one place a seven-point gap could still be hiding.

It can be priced offline from an artifact that already exists. `43473626220` ran four arms on the
same 496 questions; pooling each question's candidates across those arms gives a set of 1–14
statements per question with the judge's own correctness flag on each, and every subset of size *n*
is a question about what a pool of depth *n* would have produced. Averaging over subsets:

| depth *n* | pool ceiling at *n* | majority by executed result at *n* |
| ---: | ---: | ---: |
| 1 | 57.21% | 57.21% |
| 3 | 64.92% | 58.19% |
| 6 | 68.55% | 59.01% |
| 9 | 69.96% | 59.27% |
| 12 | **71.33%** | **60.10%** |

Read the two columns together and the verdict is not about candidate count at all. **Depth works:
the ceiling rises 6.4 points from one candidate to twelve.** The competitor's 69.3% sits inside what
a twelve-candidate pool already contains. What fails is the *aggregator*: majority-by-result climbs
1.3 points over the same range and never reaches the 61.29% the free `shortest` rule returns at
three candidates. The same pool, read by the same run's rule arms, says the same thing in one line
per arm:

| arm (same run, same questions) | ceiling | `shortest` | majority by result | delta |
| --- | ---: | ---: | ---: | ---: |
| `select-mixed-rule` | 66.13% | **61.29%** | 59.68% | −1.61 |
| `…-rule-rows` | 66.53% | **61.29%** | 56.05% | −5.24 |
| `…-rule-intent` | 66.73% | 60.08% | 56.85% | −3.23 |
| A/A | 64.92% | 60.48% | 59.88% | −0.60 |

**A majority can only remove noise that is zero-mean.** The competitor's samples disagree randomly
and their mode converges on the truth; ours disagree *systematically* — 71.0% of questions return a
single fingerprint, and 71.3% of the misses are `values` failures — so the mode converges on the
model's most common mistake and more draws make it converge harder. That is why the competitor's
aggregation is not borrowable and their *depth* is: the pool widens regardless of who reads it.

So the open question is not "how many candidates" but **"how much of a wide pool can a chooser that
reads length still return"**. Two arms answer it, and neither introduces a prompt, a card or a judge:

| arm | candidates | calls | what it is |
| --- | ---: | ---: | --- |
| `select-mixed-rule-spread2` | 6 (3 prompts × 2) | 6 | `select-mixed-spread2`'s pool, free rule |
| `select-mixed-rule-spread3` | 9 (3 prompts × 3) | 9 | `select-mixed-spread3`'s pool, free rule |

At the parent's measured conversion (92.7%) the arithmetic predicts **63.6%** at six candidates and
**64.8%** at nine, against 61.29% at three. If the conversion holds, depth is the best lever this
repository has priced — and it is the competitor's own lever, applied with a cheaper aggregator.

| # | criterion | bar |
| --- | --- | --- |
| ① | ceiling at six, same run | **≥ +2.0pp** over the parent (68.55 from 64.92 by subset) |
| ② | score at six | **≥ +1.0pp** over the parent, read paired on the same questions |
| ③ | conversion at six | **≥ 90.0%** (parent 92.68%; a fall below 90% is the aggregator giving depth back) |
| ④ | cost at six | **≤ 2.2×** the parent's tokens per correct answer |
| ⑤ | the slope between six and nine | conversion at nine **≥** conversion at six − 2.0pp, else depth closes at six |
| ⑥ | noise | the parent run twice in the same dispatch; every delta read against its own A/A |

Fail ③ with a rising ① is the finding that closes candidate depth for this aggregator — and it would
close it at nine calls instead of the competitor's twenty-one, which is the cheapest form that
answer can take.

### Depth does not convert, and the reason this run can say so is the A/A

The strongest training-free system on this benchmark draws 21 candidates at temperature 0.7. The
reading above showed the *pool* widening with depth — the ceiling at n = 1, 3, 6, 9, 12 is 57.21,
64.92, 68.55, 69.96 and 71.33% — while the competitor's aggregator does worse on our pool than a
free rule does on three candidates. Neither of those settles the question a product has to answer:
**can the shipped rule read a wide pool?** It had never been asked, because `shortest` had never
ranked more than four candidates.

`43535849969`, Mini-Dev 496, `deepseek-chat`, temperature 0.7, three arms plus the parent run twice:

| arm | order | calls / question | accuracy | ceiling | conversion | tokens per correct answer |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `select-mixed-rule` | 1st | **3.00** | 58.06% | 64.72% | 89.72% | 5,678 |
| `…-rule-spread2` (6 candidates) | 2nd | 6.00 | 59.68% | 67.94% | 87.83% | 11,049 |
| `…-rule-spread3` (9 candidates) | 3rd | 9.00 | 61.90% | 69.15% | 89.50% | 15,986 |
| `select-mixed-rule#2` (the A/A) | 4th | 3.00 | **62.30%** | **67.34%** | 92.51% | 5,291 |

Read as totals, the nine-candidate arm beats the parent by 3.84 points at p = 0.005 — a result this
repository would have written down as a win three rounds ago. The A/A is why it is not one:

| pair | delta | cases | p |
| --- | ---: | ---: | ---: |
| parent → A/A *(same arm, same prompts, twice)* | **+4.23pp** | 11 : 32 | **0.0019** |
| `spread2` → A/A | +2.62pp | 15 : 28 | 0.066 |
| **`spread3` → A/A** | **+0.40pp** | 15 : 17 | **0.860** |
| parent → `spread2` | +1.61pp | 17 : 25 | 0.280 |
| parent → `spread3` | +3.83pp | 12 : 31 | 0.0054 |
| `spread2` → `spread3` | +2.22pp | 10 : 21 | 0.071 |

**Nine candidates are 0.40 points from a second run of three candidates, at three times the tokens.**
Every point the wide arm appeared to gain over the parent is inside the +4.23 the parent gained over
itself. The pre-registered bars: ceiling ≥ +2.0pp over the parent — 3.22pp, *and 0.60pp over the
control*; score ≥ +1.0pp paired — 1.61pp at p = 0.28 against the parent, −2.62pp against the control;
conversion ≥ 90% — 87.83% and 89.50%, both below it; cost ≤ 2.2× — 1.95× at six candidates but
**2.82× at nine**.

#### What the 4.23 points are, and what they are not

The obvious suspicion is a defect here, so it was checked before the number was believed. The two
runs of the parent are byte-identical at the input: **496 of 496 cases carried the same prompt-token
count**, the same 3.000 calls, and completion lengths of 175.8 against 175.1 tokens. The 32 cases the
second run won have **0 statements in common** with the first run's, and 24 of them drew a different
candidate set. Nothing this process sent changed; what came back did. That is the endpoint, not the
harness.

It is still a defect of *this repository's design*, and a sharper one than a bug: the four arms ran
**to completion one after another**, so over a forty-minute window arm identity and clock time were
the same variable. A drifting endpoint is then indistinguishable from a real effect, and the whole
artifact's arm-to-arm deltas inherit it. Three things are now in the harness because of that:

- **The A/A already refuses the run.** The baseline gate failed this dispatch with
  *"the same arm twice differs by 4.2pp, more than the 4pp the gate treats as noise"*. The artifact
  is still written and still worth reading; it just cannot be cited as a comparison.
- **`aa.ceiling` prices the noise of the quantity a candidate buys.** The same pair moved the pool
  ceiling by 2.62pp (67.34 against 64.72). Any future "this lifts the ceiling by half a point" claim
  is read against that number rather than against the score's.
- **`endFingerprint` closes the window.** The run already fingerprints its base at the start — three
  fixed questions, twice each, at temperature zero, digested. Asking the same probes again after the
  last arm costs six calls and separates the two explanations that survive the evidence: a serving
  stack that answered differently under load (publish the size of the window) or weights that changed
  (refuse the artifact, because its arms were measured against two models).

#### The correction this forces on the previous round

The 33.87 / 5.65 split of Mini-Dev's misses — pool ceiling 66.13%, rule 60.48% — was computed from a
single draw. The same pool's ceiling now moves 2.62pp between two draws of one arm, so that
decomposition is **5.65 ± 2.6pp inside the pool** against **33.87pp outside it**. The direction is
untouched and the decision it drove stands; the precision was overstated, and the error bar is now a
number in the artifact rather than a caveat in prose.

#### Verdict

The candidate side closes for this aggregator at every width: three prompts (round 132: two fourth
sources at +0.40 and +0.60pp of ceiling, both inside the noise), six and nine (here: +0.60 and
+1.81pp of ceiling, both inside the 2.62pp the control moved). **What a wide pool needs is a chooser
that reads more than length** — and the free rule that beats a vote on three candidates is exactly
the wrong tool for nine, which is why its conversion fell to 87.83% while its ceiling rose.

### What a repeated run can explain about itself: the pool's own lottery

The previous section ends with a defect of design: four arms ran to completion one after another, so
arm identity and clock time were the same variable, and the plan that followed was to interleave
them so that a drifting endpoint could not be mistaken for a lever. That plan was pre-registered
with a criterion — *the same-arm A/A ceiling noise falls to ≤1.5pp* — and it was killed before it
was built, by the artifact it was meant to re-measure.

The first question was whether the +4.23pp was anything this repository did. It is not:

| what was compared | run 1 | run 2 (the A/A half) |
| --- | ---: | ---: |
| cases whose `tokens.prompt` matched | 496 of 496 | — |
| calls per case | 3.000 | 3.000, identical on 496 of 496 |
| cached prompt tokens | 1,261,504 | 1,261,504 |
| base that answered | `deepseek-flash` | `deepseek-flash`, on every case |
| correlation between case position and passing | −0.093 | −0.076 |

No prompt differed, no call count differed, nothing was served by another base. The per-decile pass
rates of the two halves trace the same profile — 59/59, 69/80, 53/51, 74/78, 43/49, 82/88, 55/53,
55/67, 57/59, 41/47 — which is the split's difficulty order, not a warm-up: a run that was getting
better as it warmed would show a trend, and the trend is −0.09.

So the difference is in *which statements the model wrote*. That is a claim about a distribution, and
an artifact can price it without spending a call. Hold the widest pool an arm kept fixed — the nine
shapes `select-mixed-rule-spread3` drew on each case — and draw three of them twice, which is exactly
the lottery a three-candidate arm plays:

```
pnpm bench:bird:lottery eval/out/bird-eval.json --draws 3
```

| reading | value |
| --- | --- |
| the lottery, k = 3 of a pool of up to 9 | **±1.8pp at 95%** (sd 0.9pp, 4,000 seeded replicates, 496 cases) |
| the A/A pair's ceiling delta, observed | 2.6pp |
| the part the offered pool cannot explain | **0.8pp** |
| the smallest delta a claim from this run can rest on | **3.7pp** |

Two conclusions follow, and the second is the one that changes the plan:

- **The draw distribution moved.** Under a stable distribution the pair's ceiling could not have
  separated by more than 1.8pp; it separated by 2.6pp. The shapes the endpoint offers on a question
  are not a fixed set that a re-run samples from — the set itself shifts. This is one draw of that
  shift, not a law, and it is the only reading in this document that rests on a single pair.
- **Interleaving cannot reach the pre-registered bar.** The lottery band is a property of the model
  choosing among its own shapes, and *no ordering of the arms removes it*: even a perfectly
  interleaved pair against a frozen endpoint inherits ±1.8pp at k = 3. A criterion of ≤1.5pp was
  therefore below the floor of the quantity it was written about, and the honest thing to do with a
  pre-registration that is impossible is to retire it in the open rather than to run it and explain
  the miss. What interleaving would still buy is the 0.8pp residual, if that residual is
  clock-correlated — a question that is now priced at 0.8pp rather than assumed at 4pp.

#### The number that reorders the candidate work

`3.7pp` is the resolution of this design: the paired McNemar interval of the A/A pair (43 discordant
cases of 496) is wider than the lottery band, so it is what every arm-to-arm delta in the artifact
has to clear. The candidate-side readings of the last two rounds were **+0.40pp, +0.60pp, +1.81pp and
+3.22pp of ceiling** — all four below it. The word for them is not "negative" and not "inside the
noise"; it is **unmeasurable at this n**, and the difference matters because an unmeasurable effect is
not evidence against a mechanism, it is evidence about the instrument.

The same arithmetic says where the instrument becomes usable. Both numbers scale as 1/√n, and the
discordant share is a per-question rate:

| split | questions | resolution (paired MDE) | lottery band at k = 3 |
| --- | ---: | ---: | ---: |
| Mini-Dev | 496 | 3.7pp | ±1.8pp |
| dev | 1,532 | **2.1pp** | ±1.0pp |

So the split that decides adoption is also the cheapest way to make a 2pp claim measurable, and the
one place this project has been taking its readings — 496 questions, three candidates — cannot
resolve the mechanisms it has been testing. That is a statement about the instrument, and it is now
printed by every BIRD dispatch in both workflows rather than inferred from a failed gate.

#### Where the 30.8% actually goes

The same artifact prices the other side of the product, and it says the candidate work has been
aimed at the smaller half. At nine candidates on 496 questions:

| quantity | cases | share |
| --- | ---: | ---: |
| the pool held a correct candidate | 343 | 69.2% |
| the pool held one and the rule returned it | 307 | 61.9% |
| the pool held one and the rule returned something else | 36 | 7.3% |
| **the pool held none** | **153** | **30.8%** |

and the shape of every failure, from the judge's own verdict:

| defect | out-of-pool (153) | in-pool selection loss (36) |
| --- | ---: | ---: |
| `values` — right width, wrong numbers | **110 (71.9%)** | **32 (88.9%)** |
| `column-count` — a different projection | 43 (28.1%) | 4 (11.1%) |

Three quarters of everything this arm gets wrong is the same defect: the statement is structurally
right and the numbers are not. That is not a candidate-width problem and it is not a selection
problem — it is arithmetic and grounding — and it is why "more opinions" has been buying nothing: the
opinions agree because they are the same opinion. Across 496 questions the nine-candidate arm
averages **1.68 distinct result sets per case**, and on **302 of 496** questions all nine candidates
return the same result. Nine calls, one hypothesis.

### The resolution on the split that decides adoption is 1.77pp, and the 4.23 points did not reproduce

Everything above is a statement about 496 questions. The split a leaderboard reports is 1,532, so
the same pair was run there — one arm, twice, in one dispatch (`43557304930`, `select-mixed`,
`deepseek-chat`, served as `deepseek-flash` on all 1,532 questions):

| reading | Mini-Dev (496) | dev (1,532) |
| --- | ---: | ---: |
| accuracy | 58.06% | **62.86%** |
| the same arm again | 62.30% | **63.12%** |
| A/A score delta | **+4.23pp** (11 : 32, p = 0.0019) | **+0.26pp** (45 : 49, p = 0.757) |
| A/A ceiling delta | +2.62pp | **−0.33pp** (42 : 37) |
| paired MDE — the resolution | 3.70pp | **1.77pp** |
| ceiling MDE | — | 1.63pp |
| discordant share | 8.67% | 6.14% |
| distinct result sets per question | 1.34 | 1.30 |
| questions with one result set | 66.9% | **74.2%** |
| selection loss | 7.3% | 5.6% |
| pool ceiling | 69.2% | 68.47% |

Two predictions were registered before the dispatch and they land differently, which is the point
of registering them:

- **The ceiling delta lands inside the ±1.0pp band** the lottery predicted for this n (−0.33pp).
- **The resolution came in at 1.77pp, not the 2.0–2.3pp predicted.** The prediction scaled 3.7pp by
  1/√n and held the *discordant share* fixed, and the share is the other half of the arithmetic:
  it is 6.14% on dev against 8.67% on Mini-Dev. A design's resolution is `(1.96 + 0.84)·√(share/n)`,
  so a split that also disagrees less often is better than 1/√n twice over. The estimate was wrong
  in the direction that costs nothing, and the formula is now the stated one rather than a scaling
  rule.

**The 4.23 points did not reproduce.** At three times the questions the same pair separates by
0.26pp with p = 0.76. That is the strongest available evidence for the reading above: the Mini-Dev
delta was a draw from a distribution whose tail the 496-question design can reach, not a harness
that is noisy by four points. It also means the honest summary of `43535849969` is not "our
instrument is broken" but "a 496-question A/A can wander that far, which is why it is not the split
to decide anything on".

**What it unlocks.** A mechanism worth 2pp is now measurable with two arms on dev for 1,532 × 4
calls. That is the same bill as the Mini-Dev runs that could not resolve it, and it is the only
change in this document that alters what the next round can claim.

#### The instrument's first external failure, found on the artifact it was pointed at

`select-mixed` draws three candidates and keeps three, so on dev there is no pool wider than the
draw and the lottery band is a constant zero. The verdict printed at that artifact was **"the A/A
ceiling delta of −0.3pp is 0.3pp beyond the ±0.0pp the offered pool can produce, so the draw
distribution itself moved"** — a claim about a moved distribution produced from no evidence at all,
because a zero band makes every delta "beyond" it. The reading was caught within a minute of the
artifact landing, which is what a verdict sentence is for, and the third state is now explicit:

| kind | condition | what it means |
| --- | --- | --- |
| `inside` | the graded delta is inside the band | the pair read the draw |
| `beyond` | it is outside the band | the draw distribution moved |
| `unpriced` | the widest pool is exactly the draw | nothing about composition can be separated; only the pair's own interval grades a delta |
| `unmeasured` | the run carried no A/A | no pair to grade |

So a dev dispatch that wants its band priced has to include a wider arm in the same run — the
dispatch after this one carries `select-mixed-rule-spread3` beside `select-mixed` for exactly that
reason, and `--arm` on the instrument names which arm supplies the universe.

### Text2Vis: the cue table, scored against the one corpus that labels a chart

The chart half of the product ships a deterministic decision — `readCues` reads the question and
ranks the marks that can carry it — and until now nothing external had ever scored it. Text2Vis
states, per row, a question and the chart type its authors judged correct, so the cue half can be
scored with **no model call, no database and no renderer**:

```
pnpm bench:text2vis:rule                 # download once, score, print
pnpm bench:text2vis:rule --artifact out/text2vis-rule.json
```

The unit is a **family**, because the corpus writes `Bar Chart` and the contract writes `bar`; the
mapping is a table, and a label it has no family for is **excluded from the score and named in the
log** rather than folded into `bar`. Three numbers are always printed together, because any one of
them alone is a number about nothing:

| reading | what it is for |
| --- | --- |
| top-1 | the leading mark carries the labelled family |
| shortlist | some recommended mark does — a different claim, reported separately |
| baseline: always *X*, always bar | the two constants a cue table has to beat |

Two widenings are argued rather than convenient: a `line` answers for an `area` because an area chart
is that line filled, and a `bar` does **not** answer for a `histogram` — a histogram is one measure
binned, and folding them together would hide the finding the confusion table exists to surface.
What this does not measure is stated in the module: encoding (which fields, which aggregate), the
recommender's data-shape half, and whether a label is one annotator's judgement.

#### The first reading of the cue table, and the three defects it names

`text2vis-rule` ran for the first time in CI (`43545023250`, the corpus downloaded over the network,
not from a cache), on the whole corpus: **1,985 rows**, of which **1,469** carry a label this build
has a family for. No model call, no database, no renderer.

| reading | value | what it is compared against |
| --- | ---: | --- |
| top-1 | **37.37%** (549) | **always bar: 28.52%** — the constant a cue table has to beat |
| shortlist | 68.01% (999) | a different claim: the family is in the recommended set |
| declined | 0 | every question in this corpus fires at least one cue |
| cue path, p50 / p95 / max | **0.11 / 0.16 / 5.59 ms** | per question, over 1,985 questions |

So the table beats the constant by **8.85 points**, and the shortlist says the *right answer is
usually one of the marks it names* — the loss is in the ordering, not in the vocabulary. The cost is
what a rule is supposed to cost: a fifth of a millisecond per question, four orders of magnitude
inside the one-second budget the chart path is held to.

The confusion table is where the work is, and it names three defects rather than a score:

| label in the corpus | rows | top-1 | what the table answered instead |
| --- | ---: | ---: | --- |
| Line | 391 | 54.48% | pie (81), heatmap (63) |
| **Bar** | **357** | **12.32%** | **pie (164)**, heatmap (61), line (54) |
| Area | 137 | 42.34% | line (58), heatmap (38) |
| Pie | 113 | 78.76% | pie (89) |
| Scatter | 93 | 31.18% | scatter (29), line (25) |
| **Histogram** | **90** | **0.00%** | **boxplot (53)**, pie (24) |
| Boxplot | 89 | 51.69% | boxplot (46) |
| Donut | 69 | 81.16% | pie (56) |
| Stacked Bar | 56 | 12.50% | **pie (30)** |
| Heatmap | 20 | 5.00% | line (8), scatter (5) |
| Funnel | 11 | 0.00% | **pie (11)** |
| Bubble | 10 | 10.00% | bar (5) |

1. **The `share` cue leads with `pie`, and the corpus draws bars.** 164 bar questions and 30 stacked
   bars were answered `pie` — **194 rows, 13.2% of the scored population**, which is where most of the
   8.85-point gap to a *perfect* ordering lives. The table's own justification for pie-leading was
   never measured; it is now.
2. **`histogram` is unreachable by construction.** The contract has 22 series types and none of them
   is a histogram, so the honest product answer to a histogram question is a binned bar — but the
   `distribution` cue prefers `boxplot`, and 90 rows score zero. This is the case the family table
   deliberately *kept* visible instead of folding `bar` over `histogram`; the reading is the argument
   for changing the cue, not for changing the table.
3. **Two labels the build could not name are worth naming.** `Barh` (the corpus's horizontal bar) is
   the same decision as a bar, and it is now mapped. `Dot`, `Dot Plot`, `Choropleth Map`, `Subplot`,
   `Treemap`, `Waterfall` and one empty label stay unmapped and are **printed with the rows they
   account for**, because "516 rows are unmapped" and a list of eight names do not tell a reader which
   one to fix first.

The next reading is one change: `share → ['bar', 'pie']`, with the bar registered in advance —
top-1 ≥ 45.0% and `Bar` top-1 ≥ 60.0%, on the same corpus, with the same two baselines printed
alongside. A change to the cue table that does not clear its own baseline is not a change.

#### What the 515 excluded rows are, and the correction that makes

The block now prints the rows behind each unmapped label, and the second run (`43546926456`) is what
that was for. The 515 excluded rows are not a long tail of odd spellings:

| label | rows | why it is excluded |
| --- | ---: | --- |
| `Subplot` | **200** | a **layout**, not a mark: the reference is a multi-panel figure, and a `ChartIR` is one plot |
| `Waterfall` | 108 | a real chart type with no member in the contract's 22 series types |
| `Treemap` | 92 | in the contract, but not among the marks the recommender chooses between (it needs a hierarchy the result set does not carry) |
| `Dot` | 81 | a lollipop/dot plot; the contract has no such series |
| `Dot Plot` | 15 | the same, spelled differently — which is why the table matches on families rather than on strings |
| `Choropleth Map` | 14 | a map, which needs geometry rather than rows |
| `<empty>` | 5 | rows whose authors left the column blank |

So **13.5% of this corpus is a multi-panel figure or a chart the contract cannot represent**, and the
37.4% is the agreement on the 74% that remains. That is the bound on how far this number generalizes,
and it belongs beside the score rather than under it.

The same run also corrects a claim made one paragraph too early: mapping `Barh` moved **one row**
(1,469 → 1,470 scored, top-1 unchanged at 549). The label was worth naming — it is a bar — but it was
worth one row, and the reason it looked more important is that the first version of this block printed
eight labels without saying how many rows each accounted for. **A list of labels is not a priority
order; that was the defect, and it was in the instrument rather than in the table.**

### The largest bucket was counting spellings: a quarter of `predicate` was one condition written two ways

`bench:bird:gap:values` splits the `values` bucket — the statement ran, the width matched, the
numbers did not — into the fix each case asks for. On the dev split it named `predicate` as the
largest rung at **100 of 365** cases (27.4%), and the fix that rung names is *condition coverage*:
write the conditions the question implies. Before spending a run on that, three cases were read
line by line, and all three were the same statement as the gold with the join written the other
way round:

```
gold  ... from schools as t1 inner join frpm as t2 on t1.cdscode = t2.cdscode
pred  ... from frpm join schools on frpm.cdscode = schools.cdscode

gold  select count(t1.account_id) ... where t1.balance < 0
pred  select count(distinct t.account_id) ... where t.balance < 0
```

`a.id = b.id` and `b.id = a.id` are one condition. The ladder compared the atom lists as text, so
they were two, and the case was filed under a rung whose fix could not have changed the answer.
Three spellings account for the error: an equality written in the other direction, a column with
its table qualifier dropped in front of a literal (`charternum is not null` against
`schools.charternum is not null`), and an `in` list in another order.

`predicateKeys` now compares conditions as keys. It canonicalizes direction (`a > b` is `b < a`),
drops the qualifier when the other side is a value, and reads an `in` list as a set. It keeps the
qualifier when **both** sides are columns, because stripping it there would make every join equal
to every other join, and it keeps `between`'s bounds in order, because swapping them is a
different question. A literal that contains the word — `status = 'like new'` — is still an
equality; the operator is read outside quotes.

The same 365 cases, before and after:

| rung | before | after | the fix it names |
|---|---:|---:|---|
| `filter-wide` | 78 | **78** | the filter is too weak, or a join multiplied rows |
| `predicate` | 100 | **70** | condition coverage |
| `tables` | 62 | 62 | join selection |
| `filter-narrow` | 54 | 54 | a predicate matched nothing |
| `literal-missing` | 34 | 34 | a value the question named is not in the statement |
| `aggregate` | 16 | **27** | which function answers the question |
| `projection` | 12 | **23** | which columns, in what order |
| `literal-case` | 5 | 5 | the value is in another case |
| `window` | 2 | **5** | which window of the same rows |
| `grain` | 0 | **4** | the aggregation level |
| `unclassified` | 2 | **3** | nothing the shape can name |

Thirty cases moved, and the correction changes the order of the work: the largest rung is no
longer `predicate` but `filter-wide`, and `aggregate` + `projection` together went from 28 to 50
cases. Those name a different mechanism than condition coverage — one of them is arithmetic over
the right rows, the other is which column holds the answer — and neither had been visible while a
quarter of the bucket sat one rung too early.

Two things this does **not** fix. A join whose conditions are written as `a = b and c = d` against
`c = d and a = b` still compares equal (the set is sorted), which is correct, but a join that
writes the pair in a subquery and the gold outside it still lands in `tables`. And the rungs are
still counted over cases whose candidate set held no answer: 118 of the no-answer cases sit
outside the `values` scope and are not in this table at all.
