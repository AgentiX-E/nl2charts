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
pnpm bench:bird:recall          # every gold identifier is in the prompt; no model
pnpm bench:bird:diagnose <report.json>   # classify the failures a run kept; no model
pnpm bench:bird:strata --arm A --against B   # split a pair by candidate independence; no model
pnpm bench:bird:losses --arm A               # attribute every selection loss to a source; no model
pnpm bench:bird:position --arm A             # stratify a shuffle arm by candidate slot, with intervals; no model
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
| `literal-missing` | a value the gold names is absent | what the prompt shows about values |
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
   runs put `metadata+evidence` 2.54pp above `select` on average; dev puts it 0.39pp above. The
   pruned card, by contrast, is −1.54pp on Mini-Dev (three-run mean) and −1.50pp here — the same
   number on both splits and in five runs. A comparison that moves 2.5 → 0.4 between splits is a
   sample, an arm that lands on −1.5 twice is a cost.

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
| **this harness, `select`** | **61.88%** | deepseek-chat | no | — |
| **this harness, `metadata+evidence`** | 61.49% | deepseek-chat | no | — |

Read the last column first. It is empty for every row but ours, and that is the finding. Three
differences used to be reported from this table — 11.3pp, 2.1–3.6pp, 5.5pp — and not one of them is
a claim about the pipeline. The honest version of each is narrower:

- **11.3pp to the leaderboard's top** (61.88 → 73.2) is a difference in model and training, not in
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
| `eval/competitors/pins.json` | two competitors at a full sha, with the date, the licence and the entrypoint | a branch, a tag or a short sha |
| `eval/competitors/patches/*.patch` | one adapter each — the engine alias, and nothing else | a patch that stopped applying, checked before a model call |
| `eval/competitors/probe.ts` | the checkout against the pin, the patch against the checkout | a run from a half-patched tree |
| `eval/competitors/subset.ts` | the question file, cut by the same `stratifiedSample` that cuts `BIRD_LIMIT` | two samples read as one question set |
| `eval/competitors/predictions.ts` | the three shapes competitors write, and what each left out | an accuracy whose denominator is the answered subset |
| `eval/competitors/score.ts` | their statements through `oracle.py`, judged by `judgeOfficial` | any accuracy before all five coordinates hold |

The two pins are CHESS (`ShayanTalaei/CHESS`, Apache-2.0, five agents, ten-plus-ten candidates a
question) and MAC-SQL (`wbbeyourself/MAC-SQL`, no licence file, three agents, two or three calls a
question, and therefore the cheap one to run first). `score.ts` counts an unanswered question as
wrong, because that is the denominator our own numbers use; it prints the answered share beside the
accuracy and a declared-database disagreement beside both.

`workflow_dispatch` on `competitors.yml` runs it in two stages. `probe` checks the checkout against
the pin and the patch against the checkout, for the price of a clone and no model call. `full`
installs their dependencies, runs their own inference over the subset, runs one arm of ours over the
same subset, and scores theirs against ours with the paired delta, its McNemar p and the MDE of the
design that produced it.

No accuracy has been published from it, and the reason is the discipline that retired five arms: a
number from a half-installed pipeline is a number about an install. What exists is the machinery
that makes the first number checkable — commit, model, host, question-set hash and judge in the same
file as the rate. Until one arrives, the correct statement about the leaderboard is still: **this
harness is 11.3pp behind the published state of the art, and how much of that gap is the pipeline is
unknown.**


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
