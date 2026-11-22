# ADR 0002 — A shipped prompt is a priced decision, and the price is a tariff

- **Status**: accepted, implemented
- **Date**: 2026-11-23
- **Deciders**: Lambertyan
- **Context documents**: `docs/benchmarks.md`, "A gain is not a decision: the gate that prices one,
  and what it refuses"; `docs/guide/05-natural-language.md`, "What it costs to change what ships"

## Context

This repository measured two things about one prompt and could not compare them.

`44991167518` (1,532 BIRD dev questions, one call a case) put the MAC-SQL skeleton on this project's
card into the product: 1,010 answers against the assembled skeleton's 980, paired 119:89, +1.96pp,
exact McNemar p = 0.0441, at **0.23×** the cache-miss tokens per case. `45040430602` allowed the same
prompt to deliberate: 1,018 against 997, paired 69:90, +1.37pp, p = 0.112, at **9.7×** the money.

The first is an obvious yes and the second an obvious no, and *obvious* was the mechanism. The
product's recipe (`packages/ai/src/recipe.ts`) is a value; the arm table (`eval/bird/run.ts`) is a
declaration; the promotion between them was a commit written by a person reading a table. Three ways
that fails, and all three are quiet:

1. **The rule is one column.** A script that promotes the highest accuracy promotes 66.45% at 9.7×.
2. **The rule is one moment.** Nothing requires the promoted recipe to be the one the ledger's last
   accepted decision chose, so a hand-edit and a measurement can disagree forever while both are
   green.
3. **The statistic is retyped.** A p-value in a Markdown table is a number nobody re-derives; four
   document defects in this repository came from exactly that.

## Decision

Four decisions, each with the alternative it replaced.

### 1. The ledger stores counts and a price, and no statistic

`eval/bird/shipment.json` holds, per decision: `run`, `dataset`, both arms' `correct` / `total` /
`tokensPerCase`, and the paired `onlyChallenger` / `onlyIncumbent`. It does not hold `p`, an interval,
or a verdict. `bench:bird:ship` derives `p` with `mcnemarExact` and the interval with
`pairedResolution` — the producers every other reading in this repository uses — and hands the gate
one object per decision.

*Rejected: store the verdict.* A stored `p` survives a count being corrected, and then two numbers
describe one experiment. This is the same rule `eval/baseline/readings.json` follows, and it is the
reason that gate has never had a stale table.

### 2. Three numbers, and the third one is the exchange rate

`DEFAULT_SHIPMENT_POLICY` is `{ alpha: 0.05, minDeltaPp: 1, tokenTariff: 5 }`. A candidate ships when
it is significant (`p ≤ alpha` **and** the interval's lower bound above zero), gains at least
`max(minDeltaPp, tokenTariff × extra cost)` points, and survives the arithmetic in §3.

*Rejected: accuracy alone.* Quantified above: it adopts a 9.7× prompt for a gain the design cannot
resolve.

*Rejected: a hard maximum cost ratio.* A ratio with no exchange rate cannot say yes. The shipped
prompt is 0.23×; a 1.6× prompt that is six points better would be refused by a 1.5× ceiling and is
accepted by the tariff (5 × 0.6 = 3 points ≤ 6). A ceiling also has to be re-litigated for every
candidate, which is the prose argument this gate replaces.

*Rejected: accuracy per token.* `correct / (total × tokensPerCase)` is monotone in the wrong
direction for the case the product cares about — a cheaper prompt that is slightly worse scores
higher, and the gate would ship a regression because it is cheap. Efficiency is a good *report* and a
bad *decision rule*.

*Why 5 points per 1×.* It is a budget, not a measurement, and it is stated as one: at BIRD's current
price a doubling of the bill is worth five points, so a prompt must buy them to be promoted. The
number is revisable in one commit with one reading behind it, which is the most a policy of this kind
can honestly claim.

### 3. The declaration must close arithmetically, and the chain must be a chain

Two halves of a paired result are one number twice: `correct_challenger − correct_incumbent` must
equal `onlyChallenger − onlyIncumbent`. A record whose halves came from different runs is plausible
in every field and wrong in one relation; the gate refuses it and names the relation. Each decision's
incumbent must also be the recipe the previous decision left in place, the fold starts on `assembled`
(what the product sent before the first decision), and an empty ledger therefore folds to `assembled`
— which is not what ships, so "no decisions" is red rather than silent.

*Rejected: trust the record.* The defect this catches has no visible symptom: both counts are
integers, both are within their totals, and the effect they imply is the effect a report would quote.

### 4. CI holds the fold to the product

`pnpm gate:shipment` folds the ledger and fails unless the resulting recipe is `SHIPPED_SQL.name`,
then runs the gate's self-test — four tampered ledgers (a miscopied count, a skipped chain step, an
arm nobody ships, an empty file), each of which must be refused. A priced experiment cannot reach the
product without a commit to the ledger, and a commit to the ledger cannot leave the product behind.
There is no runtime switch, so there is no state in which the product sends one prompt while the
experiment believes it sends another.

*Rejected: adjudicate at runtime.* A product that decides at load time must carry the statistics, the
ledger and the policy into a customer's bundle to answer a question that changes once a month. The
identity-in-CI form answers the same question with a comparison.

## Consequences

- **Promotion is cheap in both directions.** A prompt that is better *and* smaller ships without an
  argument (0.23×). A prompt that buys a point by doubling the bill needs five. A prompt that is
  better by less than a point is refused as *unmeasured* at this sample size, not as small — a
  different sentence, and the one the gate prints.
- **A refusal is recorded, not forgotten.** The ledger keeps the candidates that were priced and
  declined, with the numbers they were declined on, so the next person does not pay to re-measure a
  question already answered.
- **The fold only moves forward.** A later measurement that prefers an older prompt is refused on
  effect and price instead of oscillating the product between two prompts.
- **Text2Viz is out of scope, deliberately.** `eval/text2vis/arbitrate.ts` chooses among marks at a
  *fixed* price per question: one question, two answers, no second column. A tariff there would be a
  column that cannot vary. When a chart decision acquires a price it can be priced with this one.
- **The policy is not free of judgement.** `5 points per 1×` is a budget somebody chose. The gate's
  contribution is not that the number is right; it is that the number exists, is written down, and is
  the only place the argument can happen.
