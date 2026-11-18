# What a reading costs, and what was done about it

A benchmark that counts calls cannot say what it spent. Every number in this repository was
published in *calls* — 1,418 figures, one call each; 496 questions at 3.99 calls — and a call is not
a unit of money: a call that answers two integers after nine hundred tokens of deliberation and a
call that answers them directly are the same column and about forty times apart on the invoice. So
for a week the project measured accuracy to two decimals and cost not at all, and the invoice
arrived as a surprise.

This page is the ledger and the levers. Every figure on it is produced by a command in this
repository, from artifacts this repository wrote.

```console
$ pnpm bench:bill eval/out/text2vis-judge.json
bill: 1 line(s), 1416 rows
  spent: 1416 rows, 1,171,852 prompt + 1,390,180 completion (1,366,108 reasoning) = ¥10.68 at glm-4.5v list price (2026-11-18)
  total: ¥10.68
```

## The bill for the week of 2026-11-09

| what | runs | rows | prompt | completion | ¥ |
| --- | ---: | ---: | ---: | ---: | ---: |
| chart judge (`text2vis-judge`, dispatched) | 12 | 8,187 | 4.7 M | 5.6 M | **63** |
| BIRD Mini-Dev, **on every push** (`ci.yml`) | 40 | 258,000 | 258 M | 17.8 M | **276** |
| BIRD, dispatched (`bird-model`, `bird-dev`) | 21 | 51,152 | 111 M | 12.9 M | **160** |
| live NL→SQL, **on every push**, 3 repeats | 40 | 25,200 | 23 M | 4 M | **77** |
| | | | | | **≈ 570** |

Read in either direction, the two facts are the same fact: **the chain that runs by itself cost more
than the chain that was asked for.** Forty pushes each re-took a reading, and each reading re-ran
thirteen arms over 496 questions — ¥6.91 a push, measured, before the second job beside it.

```console
$ pnpm bench:bill <one push's bird-eval artifact>
  select: 496 rows, 1,259,142 prompt, 823,873 of them cache hits + 87,572 completion = ¥1.58
  ...
  total: ¥6.91
```

Three structural causes, in descending order of what they cost:

1. **The paid half of the evaluation was triggered by a push.** `ci.yml` ran `bird-eval` and
   `live-eval` whenever a push touched anything a prompt reads — forty times each in five days,
   beside thirty-five dispatched runs of the same chains. Nothing about a measurement improves by
   taking it more often: a floor is a number to publish against, and a published number is taken
   once, on purpose.
2. **Every reading re-graded the whole corpus.** Twelve judge readings, each 1,286 or 1,418 figures,
   and between any two of them about 1,280 figures were byte-identical with an identical question.
   The project was paying to be told what it already knew.
3. **98.3% of the judge's completion tokens were deliberation.** 1,366,108 of 1,390,180 tokens on
   the sixth reading were spent before two integers were written. On a vision model that charges ¥6
   per million output tokens, that is ¥8.2 of a ¥10.68 reading spent on thinking about a score.

## What is now true in the code

| lever | what it does | where |
| --- | --- | --- |
| **The store** | keys an answer on the picture's SHA-256, the prompt, the model, the decode mode, the output cap and the temperature; a second reading of an unchanged figure spends no call | `eval/text2vis/judge-cache.ts` |
| **The bill on the artifact** | every reading publishes `cached`, `saved` and `bill: {yuan, savedYuan}`; `bill.yuan` is what it cost and `bill.savedYuan` is what the store prevented | `eval/text2vis/judge.ts` |
| **A price table with provenance** | 元 per million tokens, each row carrying the page it was read from and the day; a hit is charged at the hit price; a model with no row prints tokens and says so | `eval/price.ts` |
| **A budget before the run** | `--max-calls <n>` stops the run and is red; `--sample <n>` takes every k-th row so two arms are paired by construction | `eval/text2vis/judge.ts` |
| **Patience** | eight consecutive unanswered calls end the run; 1,174 identical 429s became eight calls and one sentence | `PATIENCE` |
| **The paid half is dispatched** | `bird-eval` and `live-eval` no longer run on push; the free half of the BIRD chain — gold identifiers in the prompt, dry-run controls, DuckDB portability — moved to `bird-prompt`, which costs nothing and still runs on every push | `.github/workflows/ci.yml` |

The store is the one that changes the shape of the problem rather than the size of the bill. A
reading used to cost one call per figure; it now costs one call per figure **that changed**. The 111
tables the melt re-marked, the four it newly drew, the nineteen whose labels were stood up — those
are the reading. The other 1,280 rows are a lookup.

It is also the lever that can lie, and the key is where that is prevented:

| input | what goes wrong without it |
| --- | --- |
| the picture's bytes | a re-drawn figure is answered with the old figure's opinion |
| the question and the label | one figure answers two questions differently |
| the model | a grader swap is an instrument swap, and the floor is relative to the instrument |
| the decode mode | the `--think` A/B reads the same figures twice and would read one answer twice |
| the output cap | a reply cut at 1,024 tokens is a different answer from one that finished |
| the temperature | a sample is not a reading, and a cached sample is a fabricated one |

`CACHE_VERSION` travels with them, so an edit to the prompt — which the key cannot see — can be made
a miss on purpose. An entry that is damaged, off the 0-10 scale, or written by another model is a
**miss and a counted defect**, never a score: rounding a bad entry into the histogram would be this
file choosing a number the grader did not write, and caching it would make the choice permanent.

## The levers still on the table

| lever | expected saving | what it costs to find out | state |
| --- | --- | --- | --- |
| ~~Decode mode off~~ | was: ~¥8 of every ¥10.68 reading | one paired arm on a 200-row stride sample: 178 calls, **¥2.67 for both arms** | **spent, and the answer is no: `glm-4.5v` is forced thinking** — see below |
| **Grader `glm-4.6v`** | half of every reading before any mode change (¥1/¥3 against ¥2/¥6) | the same paired sample, against the same figures: ≈¥1.3 an arm | ready; the price row is already in the table |
| **Decode mode off, on `glm-4.6v`** | whatever the deliberation turns out to be worth: the same page lists 4.6V as deciding for itself | the arm above, taken twice | ready, and it is the second half of the same dispatch |
| **Batch API** | half of whatever is left | nothing to measure — the provider states 5折 — but it is asynchronous, so the workflow changes shape | not started |
| **`deepseek-v4-pro` vs `flash`** | negative: pro is ¥4.5/¥13.5 against ¥2/¥8 | one dispatched arm | not worth it for the gate; relevant only if BIRD accuracy needs it |
| **Sample on push instead of dispatch** | removes the dispatch step from the round's loop | a recorded sample floor, which needs one full reading to establish | not started |

## The arm that measured the wrong instrument

`--think off` was the cheapest lever on the list: 98.3% of a reading's completion was deliberation, so
turning thinking off looked like spending ¥2 instead of ¥10.68. Two arms were dispatched on the same
200-row stride sample — 44234111191 with `--think off`, 44234138243 with the endpoint's default — and
they cost ¥1.31 and ¥1.35 and disagreed by nothing:

| | `--think off` | default | paired difference |
| --- | ---: | ---: | --- |
| rows graded | 177 | 177 | 177 paired |
| chart correctness | 3.25 | 3.24 | **−0.006 ± 0.162** |
| readability | 6.44 | 6.42 | **−0.017 ± 0.233** |
| prompt tokens | 147,031 | 147,031 | identical |
| completion tokens | 170,117 | 176,669 | −3.7% |
| of which reasoning | 167,108 (**98.2%**) | 173,660 (98.3%) | — |
| bill | ¥1.3148 | ¥1.3541 | −¥0.039 (**−2.9%**) |

Two identical populations, at two nearly identical prices. The first reading of that table is "thinking
costs nothing to turn off, and buys nothing" — which contradicts a lever worth ¥8 a reading, so it is a
bug report, not a result.

It is a documented property of the model. The vendor's page on 深度思考 splits the family in two:

> `thinking.type`: `enabled`(默认)…(`GLM-4.6` `GLM-4.6V` `GLM-4.5` 为模型自动判断是否思考，`GLM-5.3`
> `GLM-5.3-FLASH` `GLM-4.7` `GLM-4.5V` 为强制思考) / `disabled`：禁用思考，直接给出回答

**`glm-4.5v` is in the forced-thinking list.** `disabled` on that model is a request the endpoint
accepts and does not serve, and the 200 that comes back is indistinguishable from obedience. The arm
was not a null result about deliberation; it was the same decoder, asked twice.

Three things changed in the code, and the third is the one that would have caught this by itself:

1. **The probe asks in the mode the run will grade in.** It used to ask with no mode at all, so the one
   call that exists to prove "this deployment serves what the dispatch asked for" proved it about a
   different request.
2. **A field the adapter drops ends the run.** A deployment that has not declared a thinking switch has
   `thinking` removed before the request is sent — correct behaviour, and a run that continued would
   grade 178 figures in another mode. It now refuses on the probe, or on the first graded reply, and
   writes no artifact: a report that exists is a report somebody will read.
3. **A mode that was asked for and not obtained is refused by its own evidence.** The token counts
   survive where the request does not: a run claiming a direct decode while spending more than a fifth
   of its completion on deliberation now fails `assertJudgeReport`, naming the share. `DIRECT_DECODE_CEILING`
   is a fifth because the two populations this instrument has measured are 98% and near zero, and a
   guard at zero would refuse a correct reading on its arithmetic.

The lever is not gone; it moved to the model that serves it. `glm-4.6v` is in the *模型自动判断* group,
priced at ¥1/¥3 against 4.5V's ¥2/¥6 — so the next dispatch takes the same 200 rows twice on 4.6V, once
with `disabled` and once with the default, and answers both questions with one pair of arms: is the
halved grader as good, and does the mode it serves save the other half. Expected: ¥1.3 an arm again,
and a reading that costs ≈¥5 with thinking and ≈¥1.3 without.


## The rules this round adds

1. **A reading publishes its bill.** `report.bill` is on the artifact, so a number that cost money
   can be priced by whoever reads it and not only by whoever ran it. Twelve readings were taken
   before this rule, and four of the twelve predate the token column entirely — 2,548 of the 8,187
   rows were graded by a build that could not say what they cost. Two of those were full readings, so
   the ¥63 above is 5,639 measured rows plus 2,548 estimated at their neighbours' rate, and it is
   marked as an estimate rather than presented as a measurement.
2. **Never re-take a number that is already recorded.** A dispatched reading is a milestone, and a
   milestone is published once. The one exception is a reading whose *instrument* changed.
3. **A sample is declared, not discovered.** `--limit` and `--sample` say what the denominator is
   before the run; a run that stopped early — on `--max-calls`, on a dead endpoint — is red and is
   not a reading, however tidy its arithmetic. `judged + failed + notSelected === charts` holds in
   both cases, which is exactly why arithmetic cannot be the test.
4. **One instrument per comparison.** Swapping the grader, the decode mode or the prompt produces a
   different instrument; two readings of different instruments are two readings, not a delta.
5. **Money is a reason to change a workflow, and never a reason to skip a check.** The four checks
   that moved out of the paid jobs are the ones that need no model. Nothing that catches a defect was
   dropped to save a yuan.

## What this does not fix

`ci.yml` still runs `benchmark and ablation` on every push. It is free — no key is in its
environment, so the pipeline runs on the recorded fixtures — and it is the only per-push check of the
evaluation code's own behaviour. It stays.

The `--think` question is now **answered and closed for `glm-4.5v`**: the mode is not served there, the
two arms above say so twice over, and the guard refuses the claim instead of publishing it. The grader
question is dispatched on the model that serves the mode, at ¥1.3 an arm. Nothing about the remaining
work is expensive: what was expensive was taking a reading that could not answer the question it was
dispatched for, at full price, and calling the result a null.
