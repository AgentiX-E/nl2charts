# Infer semantics from the schema you already have

A customer database usually arrives without a data dictionary. There is no
`evidence` sentence per question and no column descriptions — the page
[Give the model definitions](10-evidence.md) explains why that costs accuracy and
what a hand-written definition is worth.

This page is about the part you can recover without a human: **grain, keys, join
direction and column roles**, derived from names, declared types and the foreign
keys the schema already declares. It is the semantics a new analyst picks up in
their first hour, and it turns out to be exactly what a model is missing when it
invents a `DISTINCT`, joins the wrong way, or sums a percentage.

## The block

```ts
import { renderDefinitions } from '@agentix-e/nl2charts-ai';
import type { SchemaTable } from '@agentix-e/nl2charts-ai';

const schema: SchemaTable[] = [
  {
    table: 'orders',
    columns: [
      { name: 'order_id', type: 'BIGINT' },
      { name: 'customer_id', type: 'BIGINT' },
      { name: 'order_date', type: 'DATE' },
      { name: 'total_amount', type: 'DOUBLE' },
      { name: 'is_paid', type: 'BIGINT' },
    ],
    foreignKeys: ['orders.customer_id = customers.customer_id'],
  },
];

const semantics = renderDefinitions(schema);
// - orders: one row per order (key: order_id).
// - orders.customer_id: foreign key to customers.customer_id; many orders per customer.
// - orders.order_date: calendar date, day precision.
// - orders.total_amount: monetary amount.
// - orders.is_paid: yes/no flag.
```

Pass it to the pipeline as `definitions`. The prompt places it after the schema
card and before any data profile, because a model that knows what a column means
reads its values differently:

```ts
const pipeline = createPipeline({
  provider,
  prompt: { dialect: 'PostgreSQL', definitions: semantics },
});
```

`renderDefinitions()` returns an empty string when it can infer nothing, and the
prompt then adds nothing — an empty heading is worse than no heading.

## What each line is, and what it is not

| Line | Inferred from | Safe to rely on |
| --- | --- | --- |
| `one row per order (key: order_id)` | a column named `<table>_id`, `id`, or referenced by another table | yes — it restates a declared or conventional key |
| `foreign key to customers.customer_id; many orders per customer` | a declared join hint | direction yes; "many" is a convention, not a count |
| `monetary amount`, `count`, `fraction or rate`, `yes/no flag` | name stems (`amount`, `price`, `qty`, `pct`, `is_`) | a hint, not a business definition |
| `calendar date, day precision` | declared type, or a `date`/`day` word in the name | yes for the type, no for the timezone |
| `"region" appears in customers and orders` | the same name in two tables, not joined to each other | yes — the two columns are different scopes |

Two deliberate refusals are worth knowing, because they came from real output:

- **A year or month label is not a date.** `Academic Year` holding `2012-2013` was
  rendered as "calendar date, day precision" by the first version; the word `year`
  no longer promotes a column to a date.
- **A code is not a count.** `Charter School Number` holds a school identifier, so
  `number` is not a count stem. A wrong gloss costs a line that a real measure
  needed.

## What it is worth, measured

On BIRD Mini-Dev, n=239, two independent runs, same model, same schema card:

| Arm | Accuracy (run E / run F) | Prompt |
| --- | --- | --- |
| names only | 32.6% / 33.5% | 1,818 chars |
| + structural semantics | 33.9% / 33.5% | 2,630 chars |
| + definitions written by the model (once per database) | 34.3% / 32.2% | 2,819 chars |
| + definitions + dataset hint | 52.7% / 53.1% | 2,953 chars |
| + metadata + dataset hint | 57.7% / 56.1% | 7,605 chars |

Structural semantics gain **+0.0 to +1.3pp** over a bare schema; letting the model
write the dictionary instead gains **−1.3 to +1.7pp**. Both are inside the noise of
this sample, and the model-written text was competent — it produced lines like
`"Charter School (Y/N)" is 1 if the school is a charter school, 0 otherwise.` and
still moved nothing.

That is the finding worth carrying: knowing the database is not the bottleneck.
The 12.1pp comes from a sentence that resolves *this question's* ambiguity, which
no per-database block can anticipate. Use this block for the cost, not for the
accuracy: 2,953 characters get within 3 to 5pp of a 7,605-character card, which is
not yet a result but is close enough to be worth testing.

## Cost and budget

The block is bounded by `maxChars` (default 900, mean 778 across the eleven BIRD
databases when every case got one). It is not free: it competes with the schema
card for the same context. Two rules keep it cheap:

- Only informative roles are printed. Text and plain numbers are silent.
- Every claim is one line, in a stable order: table grain, keys, join direction,
  roles, then name reuse. A stable order also makes the block cacheable and
  diffable.

## Measuring it on your own database

Do not take the numbers in this page on faith, and do not take your own numbers
from one run either. The benchmark page documents the protocol: same questions,
one lever per arm, paired McNemar, and a noise floor measured by asking the same
cases three times. Structural semantics is one lever — `names` → `definitions`
changes nothing else.
