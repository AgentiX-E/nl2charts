# ADR 0001 — The set-valued contract nvBench 2.0 requires, and what it would take to report an F1@k

- **Status**: accepted, not implemented
- **Date**: 2026-11-22
- **Deciders**: Lambertyan
- **Context document**: `docs/benchmarks.md`, the paragraph beginning "nvBench 2.0 is the only absent
  row that is a *method* gap rather than a corpus gap"

## Context

Nine leaderboards are registered in `eval/benchmarks.ts` and four of them have no reading here.
nvBench 2.0 (`arXiv:2503.12880`) is the only one whose absence is a **method** gap rather than a
corpus or submission gap: the corpus is public, and what this repository cannot do is *score* it.

Three properties make it different from every benchmark this harness reads today.

1. **One query has a set of valid visualizations.** 7,878 queries map to 24,076 visualizations over
   780 tables in 153 domains — about three acceptable answers per question. The metric is precision
   and recall over that set, reported as F1@3 and F1@5, not accuracy over a top-1 answer. Every arm
   in this repository answers one chart per question and is scored by executing a query or comparing
   a rendered figure; neither shape produces a set.
2. **The mark vocabulary is Vega-Lite.** A gold answer is a Vega-Lite specification, not one of the
   eleven marks in this repository's chart contract. Comparing the two by string is meaningless;
   comparing them at all requires a decision about what "the same chart" means across two
   vocabularies.
3. **The leaderboard is trained-model territory.** Step-NL2VIS, trained on the benchmark, reads
   81.50 F1@3; the reported prompting baseline is 22.54 points lower. This repository does not train
   and will not train for a benchmark, so the number it can honestly target is the prompting one.

## Decision

We adopt a set-valued, key-based contract, in four parts. None of them changes the product's
existing single-chart path.

### 1. The output contract is `k` candidates, and `k` is a scoring parameter rather than a product default

A scoring run asks the pipeline for `k` (3 and 5) candidates for the same question. The candidates
are independent answers, not variants of one answer: a selector that picks the best of three is not
a set, and F1 over a set of one is a different measurement.

The product default stays at one chart. "Return five charts" is not a feature anyone asked for; it
is the shape the metric reads, and it is confined to the harness the way `repairs` and `linking`
already are.

### 2. Comparison happens in a semantic key space, not between two serialisations

A chart is reduced to a **key**: the mark class, then for each encoding channel the field, its
aggregate, its type, and the filter/transform predicates that survive normalisation. Two
specifications are the same chart when their keys are equal.

The reduction is deliberately lossy and the losses are enumerated rather than discovered later:
sort order, colour palette, title text, axis formatting, and legend placement do not enter the key.
Each of those is a way two charts can look different and be the same chart, and a metric that
counted them would measure typography.

A Vega-Lite spec and a `Chartspec` that describe the same chart must produce the same key. That is
the whole adapter: the mapping is from Vega-Lite's vocabulary into the key space, and does **not**
attempt to implement Vega-Lite semantics — no expression evaluation, no layer composition beyond
folding layers into one key when their encodings agree, no data transforms beyond the aggregates the
key already names.

### 3. F1@k is a one-to-one match with a stated ceiling

For a question with gold set `G` (`m` members) and predicted list `P` (at most `k` entries):

```
matched  = maximum one-to-one pairing of P and G by key equality
precision@k = matched / k
recall@k    = matched / m
F1@k        = 2 * precision * recall / (precision + recall)
```

Two consequences are printed with every reading rather than left to the reader:

- **`k < m` caps recall at `k/m`.** A question with seven valid charts cannot reach F1 = 1 at
  `k = 3`, and an arm that is docked for it is being docked for the metric.
- **Duplicate keys in `P` never count twice.** A model that emits the same chart five times scores
  like a model that emitted it once.

### 4. The target is the prompting baseline, stated as such

The number to beat on this harness is the **prompting** baseline, ≈58.96 F1@3, not Step-NL2VIS's
81.50. A trained system's number is not a target for a system that does not train; quoting the gap
to 81.50 as a capability gap would be the coordinate error this repository has a reading about.

If a later round wants to argue about 81.50, that argument needs a training path — a separate
decision, and one this ADR explicitly does not make.

## What has to be measured before any of this can be reported

The following are facts about the corpus, not choices, and none of them is known here yet:

1. **The distribution of `|G|`.** If most questions have one or two gold charts, F1@3 is nearly a
   top-1 metric with a recall cap; if many have six or more, the ceiling dominates and the reading
   is mostly a measurement of the cap. The first artefact of any implementation is this histogram,
   published before any arm is scored.
2. **How many gold keys collapse under the reduction.** If two gold charts for the same question
   reduce to one key, the gold set shrinks and recall changes. That count must be reported, not
   assumed to be zero.
3. **How much of the Vega-Lite vocabulary the key space can express.** A gold spec whose mark or
   encoding has no key representation is *unscoreable* rather than *wrong*, and unscoreable cases
   must be excluded from both numerator and denominator with their count printed.

## Consequences

- **Positive**: the only absent row that is a method gap becomes an implementable one, with a
  contract that can be tested without the corpus (key reduction and F1 are pure functions). The
  reduction is reusable: Text2Vis and any future Vega-Lite corpus compare through the same keys.
- **Negative**: `k` candidates multiply the generation bill by `k` unless a single call is asked for
  several charts, and a single call that returns five charts is a different prompt with a different
  failure mode (truncation, index drift) than five calls that each return one. That trade is decided
  at implementation time, with tokens measured, not assumed.
- **Negative**: the key space is a new vocabulary to keep honest. Two charts that a reader calls
  "the same" and the key calls different is a false negative in every reading that follows, and the
  only defence is the enumerated losses above plus a fixture of pairs that must and must not match.

## Alternatives considered

| alternative | why rejected |
| --- | --- |
| Score with an LLM judge ("are these the same chart?") | Not reproducible across runs, and the judge's own preferences would be inside the metric. The repository already pays for a judge in one place and prices it there; a leaderboard number is not that place. |
| Compare Vega-Lite strings after canonical JSON | Field order and default insertion are spec-legal and change the string without changing the chart. It measures serialisation, not charting. |
| Skip the benchmark because the leaderboard is trained | True of the leaderboard, false of the corpus: a prompting baseline exists and is comparable. Skipping would leave a method gap recorded as a permanent absence. |
| Implement full Vega-Lite semantics and compile gold specs into SQL | The corpus's charts are not queries over our semantic layer; there is no database behind many of them. Compiling would measure a compiler we do not ship. |
| Report top-1 accuracy and call it a proxy | A proxy that cannot be compared to any published number is not a reading. |

## What this does not decide

- Whether the product ever returns more than one chart to a user.
- Which model generates the `k` candidates, or whether they come from one call or `k` calls.
- Whether this repository trains anything, now or later.
- The eleven-mark contract: adding marks so that more gold specs are expressible is a product
  change with its own gate, not a benchmark adapter.
