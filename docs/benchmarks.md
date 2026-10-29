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
