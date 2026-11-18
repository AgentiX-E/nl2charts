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
| ~~Decode mode off, `glm-4.5v`~~ | was: ~¥8 of every ¥10.68 reading | 178 calls, **¥2.67 for both arms** | **spent; the answer is no — `glm-4.5v` is forced thinking** |
| ~~Grader `glm-4.6v`~~ | was: half of every reading (¥1/¥3 against ¥2/¥6) | the same sample, twice: **¥0.69 for both arms** | **spent; 4.6V is ¥4.32 a reading and 1.0 point lower — a different instrument, not a cheaper one** |
| **Decode mode off, `glm-4.6v`** | was: the deliberation | the second half of the same dispatch | **spent; it works, it saves 3.7×, and it costs nothing measurable** — see below |
| **A cheap instrument for iteration** | ¥10.52 → **¥1.17** a reading, 9× | already measured | **adopted, and it is the default**: `purpose: iteration` dispatches `glm-4.6v@off`; a floor run names `glm-4.5v@default` and is refused before its first call if it does not |
| **`glm-4.6v-flashx`** | ¥1.17 → ≈¥0.55 a reading | one probe call, now that the probe is a 64×64 four-quadrant image | the refusal had three causes and two of them were the probe's; re-running |
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

The lever moved to the model that serves it. `glm-4.6v` is in the *模型自动判断* group, priced at ¥1/¥3
against 4.5V's ¥2/¥6, so the same 200 rows were taken twice on it — 44240226991 with `disabled`,
44240239563 with the default. Both arms are green, which already says the switch is served; the token
column says it plainly:

| instrument (same 178 rows, 200-row stride sample) | prompt/row | completion/row | reasoning share | ¥/row | **¥/reading** | correctness | readability |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `glm-4.5v`, any mode (forced thinking) | 830.7 | 961.1 | 98.2% | 0.00743 | **10.52–10.83** | 3.24–3.25 | 6.42–6.44 |
| `glm-4.6v`, default | 774.8 | 758.5 | 97.3% | 0.00305 | **4.32** | 2.19 | 5.75 |
| `glm-4.6v`, `disabled` | 778.8 | **16.9** | **0.0%** | 0.00083 | **1.17** | 2.29 | 5.60 |

Two results, and the second is the one that matters:

1. **`glm-4.6v` serves the switch.** 178 rows, 3,006 completion tokens between them, **zero** of them
   reasoning. A reading on it costs ¥1.17 instead of ¥10.52 — **9× cheaper**, measured, not projected.
2. **On `glm-4.6v` the deliberation is worthless.** Paired within row, `disabled` against default:
   correctness `2.29 → 2.19` (**−0.101 ± 0.323**), readability `5.60 → 5.75` (**+0.157 ± 0.264**). Both
   intervals contain zero, so thinking on that model buys nothing measurable and costs **3.7×** — the
   same 178 rows for ¥0.1476 instead of ¥0.5430.

And the half-price grader is **not a cheaper copy of the same instrument**:

| comparison | correctness | readability |
| --- | ---: | ---: |
| `glm-4.6v` `disabled` against `glm-4.5v` default | **−0.949 ± 0.358** | −0.842 ± 0.339 |
| `glm-4.6v` default against `glm-4.5v` default | **−1.045 ± 0.319** | −0.667 ± 0.317 |

Both arms of 4.6V sit a full point below 4.5V on correctness, with or without thinking, and the
intervals exclude zero by three standard errors. That is not "the newer model is worse" — nothing here
has a gold standard to say which grader is right. It is the repo's own rule standing where it says it
does: **a grader swap is an instrument swap, and a floor is relative to the instrument.** Two
consequences, both of them about money:

- **Published floors stay on `glm-4.5v`.** The 3.44/6.49 in `docs/benchmarks.md` is a fact about that
  instrument, and re-basing it on a grader that scores a point lower would make the project look worse
  for having cheaper eyes. A re-baseline is a decision, not a side effect of saving money.
- **Iteration moves to the ¥1.17 instrument.** A round that only needs a *delta* — did this change move
  the figure, did that reshape break a mark — can take its before and after on `glm-4.6v` `disabled`,
  paired within row, for a ninth of the price. Twelve such rounds cost ¥14 instead of the ¥63 the judge
  chain spent in five days.

A fifth arm — `glm-4.6v-flashx`, ¥0.15/¥1.5, which would be ≈¥0.55 a reading — was dispatched as
44240917967 on the same sample and **was refused by the probe**: asked for the dominant colour of a red
image it answered `orange`. One call, three seconds, ¥0.0002, and no figures drawn — which is the probe
doing the job it exists for, and the cheapest rejection this instrument can produce.

That refusal had three possible causes, and only one of them is about the endpoint: a blind endpoint
answering from the prompt, a weak colour encoder, or an input the encoder could not use. The probe's
image was a **2×2 red square, 73 bytes**, and a two-pixel image is the hardest possible input for an
encoder that resamples. Writing off an instrument that would cut the reading to ¥0.55 on the strength
of a check with a guessable answer and a degenerate input would be the expensive mistake in the other
direction — a probe that rejects a working model costs as much as one that admits a blind one.

So the probe was rebuilt before anything was concluded:

| | was | is |
| --- | --- | --- |
| image | 2×2, one colour, 73 B | 64×64, four quadrants, 150 B |
| question | "what is the dominant colour" | "name the colour of each quadrant, top-left first" |
| a pass | one word from a set of five | four colours, in the order the quadrants are in |
| a blind guess | plausible often enough to matter | asks for a compound fact from an image it never saw |
| the refusal | "it did not see the probe image" | what it answered, and what the quadrants are |

Reading order and clockwise both pass, because both put every colour in its own corner. `flashx` is
re-run against the new probe before its ¥0.55 reading is either used or refused; the price of finding
out is one call.

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
6. **The cheap ruler never takes the floor.** Defaults are the iteration instrument — ¥1.17, most
   dispatches — and a floor reading names `glm-4.5v` and its decode mode, is refused before the first
   call if it does not, and is refused again afterwards by the gate. A floor is registered against
   the instrument that took it (`judge.grader`), including the mode, and `--iteration` is how a
   reading says that its means are a delta rather than a candidate.

## What this does not fix

`ci.yml` still runs `benchmark and ablation` on every push. It is free — no key is in its
environment, so the pipeline runs on the recorded fixtures — and it is the only per-push check of the
evaluation code's own behaviour. It stays.

The `--think` question is **answered, and it is two answers**: the mode does not exist on `glm-4.5v`
(forced thinking) and it is worthless on `glm-4.6v` (both intervals contain zero). What the same
dispatches bought is better than the ¥8 lever they were sent for: a **¥1.17 instrument** for iteration,
which is where most of the week's ¥63 was spent, and a measured reason to keep the ¥10.52 one for the
numbers that get published. Nothing about the remaining work is expensive: what was expensive was
taking a reading that could not answer the question it was dispatched for, at full price, and calling
the result a null.

## The store, measured — and the one way it was restoring the wrong answers

The round that added the store claimed a re-reading would cost the rows that changed. It was not
measured until now, and the first two measurements disagree, which is why both are here:

| run | what it restored | graded | answered from the store | calls | bill |
| --- | --- | ---: | ---: | ---: | ---: |
| `44249999301` | `glm-4.6v` **default-mode** answers | 178 | **0** | 178 | ¥0.1468 |
| `44254362649` | `glm-4.6v@off` answers | 178 | **177** | 1 | **¥0.0008** |

The second run is the feature working: 177 of 178 answers restored for free, one call for the row the
first run had lost to a parse failure, and `savedYuan: 0.146809` on the artifact — the tokens the
store prevented, priced at the same table as the tokens it did not.

The first run is the defect. `actions/cache` restores the **most recently created** archive matching a
`restore-keys` prefix, and the prefix was `text2vis-judge-<corpus digest>-`: the digest says which
figures, and nothing said *which instrument*. So a `glm-4.6v@off` run restored the archive of a
`glm-4.6v` default-mode run, downloaded 178 answers that its key computation could not match (a
request that names `thinking: false` and one that names nothing are two requests), and paid for all
178 again. **A cache that restores into a directory of unusable entries is worse than a cold one**:
it costs the download, the same calls, and one misleading line in the log.

The key now carries the instrument:

```yaml
key: text2vis-judge-${{ inputs.model }}-${{ inputs.think }}-${{ steps.figures.outputs.digest }}-...
restore-keys: |
  text2vis-judge-${{ inputs.model }}-${{ inputs.think }}-${{ steps.figures.outputs.digest }}-
  text2vis-judge-${{ inputs.model }}-${{ inputs.think }}-
```

The last fallback is the useful one — same instrument, different corpus — and the branch-wide
`text2vis-judge-` fallback is gone, because the only thing it ever matched was somebody else's ruler.

Two numbers follow from the hit rate, and both change the ledger:

| | before | after |
| --- | ---: | ---: |
| a re-reading of unchanged figures | ¥1.17 (4.6v) to ¥10.52 (4.5v) | **¥0.001** |
| a round that changes 40 of 1,418 figures | ¥1.17 | **≈¥0.03 + the 40** |

`glm-4.6v-flashx` was measured for the first time on the same 178 rows: **¥0.0251**, which is ¥0.20 a
full reading — a sixth of the iteration instrument. It is not adopted, and the reason is in
[benchmarks.md](./benchmarks.md#the-null-interval-what-a-grading-reading-can-claim-measured-against-itself):
it scores the corpus two points *above* both graders whose numbers the floor is defined against.

## The zero a mean needs, and the one call that buys it

The store above answers "how much does a reading cost". It cannot answer the question the same
ledger raises next: **how much of a mean is the instrument's own floor.** Three vision graders were
priced on the same 177 figures and the reading is monotone in price, in the wrong direction:

| instrument | ¥ / full reading | chart_correctness | readability |
| --- | ---: | ---: | ---: |
| `glm-4.5v` (the floor) | 10.52 | 3.24 | 6.42 |
| `glm-4.6v@off` (iteration) | 1.17 | 2.34 | 5.64 |
| `glm-4.6v-flashx@off` | **0.20** | **4.51** | **6.83** |

Cheapest reads highest. A mean over charts cannot say whether that is a lenient reader or a
different one — both are being asked about figures they can see, in a range the prompt defines
loosely. What is missing is a figure they cannot see as a chart at all.

`pnpm bench:text2vis:control` sends exactly that: four coloured squares, graded through the run's own
rubric and a corpus-shaped question. No title, no axis, no tick, no measure, no mark — so `0/0` is
the only correct answer, and every point above it is an offset added to every figure the instrument
ever grades. One call.

```
pnpm bench:text2vis:control --think off
text2vis: glm-4.6v answered "{"chart_correctness": 0, "readability": 0}" and the control card —
          four coloured squares, no title, no axis, no measure — scored correctness 0,
          readability 0: this instrument charges nothing for a figure that is not a chart, so its
          means are comparable as they stand
```

Two things follow, and both are decisions rather than prose:

1. **A cheap instrument is admissible if its card is charged nothing — and it is not.** Measured on
   2026-11-18, one call each: `glm-4.6v@off` scored the card `0/0` and `glm-4.6v-flashx@off` scored it
   `0/0` as well. So the cheap instrument's two extra points are not leniency; it does not reward
   emptiness either, and it rates charts higher. That is a disagreement about charts, and no
   subtraction removes it — which is the measured form of the decision already taken, that `flashx`
   stays out of the iteration comparison at 28% and 37% row agreement with the two graders the floor
   is defined against. The control's value is that the decision no longer rests on suspicion: ¥0.002
   bought the statement that the gap cannot be normalised away.
2. **The card is priced as an instrument call, not a case.** `CallPurpose` gained `control` for it,
   so the meter cannot fold an instrument check into an arm — the same reason `probe` has its own
   bucket.

What it does not do is make a cheap grader *good*. A card at `0/0` says a grader does not reward
emptiness; it says nothing about whether the grader can tell a good chart from a mediocre one. The
paired arm is still the only instrument for that, and it still costs a reading.
