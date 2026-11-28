# Pairing evidence: turn a difference into an auditable reading

This guide builds on [14 — Semantic value retrieval](./14-semantic-value-retrieval.md).
Read that first if you have not seen `pairValueRetrieval` yet. Here we take the
step from "the two arms differ" to "we know which fields differ, and whether the
difference is one we care about" — without ever calling an accuracy difference
a decision.

## 1. Why a difference is not yet a reading

`pairValueRetrieval` tells you the `table.column` fields one retriever found and
the other missed. That is a difference of *sets*, and it has two problems if you
stop there:

- A field the semantic arm **gained** may be a field the question never needed.
  Calling it a gain would reward a false positive.
- A field the semantic arm **lost** may be a field the question never needed.
  Calling it a loss would punish denoising.

Both need the one thing the pair does not contain: the set of fields the question
actually needed. In this project that is the **gold** set — the `table.column`
fields the reference SQL reads. Pairing against gold is what separates a signal
from noise.

## 2. Six buckets, not one number

`classifyPair` crosses the pair with gold and sorts the result into six buckets.
Each is deduplicated and sorted, so the same input always prints the same reading.

| Bucket | Meaning | Treat as |
|---|---|---|
| `semanticGainedConfirmed` | semantic found, exact missed, gold needs it | a candidate real gain |
| `semanticGainedSpurious` | semantic found, exact missed, gold does not need it | a false positive |
| `semanticLostConfirmed` | exact found, semantic missed, gold needs it | a candidate real loss |
| `semanticLostSpurious` | exact found, semantic missed, gold does not need it | denoising, not a loss |
| `bothCorrect` | both found, gold needs it | agreement on a needed field |
| `bothWrong` | both found, gold does not need it | agreement on an unneeded field |

```ts
import { classifyPair } from '../../eval/bird/value-pair-harness';

const reading = classifyPair(
  { gained: ['legalities.status'], lost: [], shared: ['sets.type'] },
  new Set(['legalities.status']), // gold fields this question needed
);
// reading.semanticGainedConfirmed = ['legalities.status']
// reading.bothWrong = ['sets.type']
```

The point is that `gained` alone said "semantic found `legalities.status`".
Against gold it says "semantic found a field the question genuinely needed,
which exact missed" — a statement you can act on.

## 3. From one question to a corpus

`classifyCase` is the seam a harness calls. Give it the two arms and the gold,
each as `{ table, column }`, and it returns one classified row:

```ts
import { classifyCase, summarizeClassifications } from '../../eval/bird/value-pair-harness';

const rows = questions.map((q) =>
  classifyCase(
    q.questionId,
    exactFieldsFor(q),     // from values.ts findValues
    semanticFieldsFor(q),  // from searchSemanticValues
    goldFieldsFor(q),      // from referencedFields(q.sql)
  ),
);
const summary = summarizeClassifications(rows);
```

`summarizeClassifications` returns per-question coverage for each arm, the
confirmed gain (confirmed gains minus confirmed losses, in **fields**), and all
six counters. Coverage is computed per question from that question's gold count
and then averaged over gold fields — so a question with no gold fields neither
divides by zero nor inflates the rate. Spurious buckets are reported but never
folded into the gain.

## 4. What this is — and what it is not

This is a **harness proof**: a reproducible, field-level shape for pairing
evidence, plus a mechanism that runs it on a real corpus. It is not a priced
reading, and no number it emits may be quoted as "semantic retrieval is better".

Three reasons, all deliberate:

1. The offline semantic arm uses the deterministic **hash embedding** — a lexical
   stand-in. It proves the pairing apparatus works, not that semantic similarity
   helps.
2. The gold in a smoke test is often an approximation (column-name tokens found
   in the question), not the exact fields of the reference SQL. A confirmed gain
   against approximate gold is a structural result, not an accuracy claim.
3. Pricing — deciding whether a difference is real and worth what it costs — is
   the job of the shipment gate (`gate:shipment`) on a real paired dispatch, not
   of this harness. See [the ADR](../adr/0002-priced-promotion.md).

The value of keeping the harness honest is concrete: a smoke run on real BIRD
questions produced a large positive `confirmedGain` while most semantic hits
were spurious against approximate gold. Reported alone, that number would have
looked like a breakthrough. Reported with its buckets, it is correctly read as
"the apparatus runs; the reading is not evidence yet."

## 5. When this earns a number

The harness becomes evidence for a decision only when all three hold:

- gold comes from the reference SQL through `referencedFields`, not an
  approximation;
- the semantic arm uses a real embedding provider, not the hash stand-in;
- the per-field discordance is paired into a McNemar test with a pre-registered
  threshold and a token cost.

Until then, use this module to *inspect* — which fields moved, in which
direction, and whether they were needed — and leave the verdict to a priced
dispatch.
