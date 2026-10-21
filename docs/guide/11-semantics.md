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

## The two forms

There are two places a definition can live: appended after the schema card as one
block, or attached to the column it describes. The measurements below say the
column line is the one that works; the block is still what you use for facts that
belong to a table (grain, join direction).

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

On BIRD Mini-Dev, n=239, three runs, same model, same cases:

| Arm | Accuracy | Prompt |
| --- | --- | --- |
| names only | 32 to 34% | 1,818 chars |
| structural semantics, as a block | 33 to 34% | 2,630 chars |
| model-written definitions, as a block | 32 to 35% | 2,819 chars |
| **the same definitions attached to their columns** | **41.8 to 43.5%** | **2,166 to 2,496 chars** |
| the dataset's curated notes, same columns | 43.1% | 2,860 chars |
| **attached definitions + a per-question hint** | **56.1%** | **2,624 chars** |
| full column metadata (798 curated notes) + the same hint | 56.9% | 7,605 chars |

Neither the content nor the author turns out to matter. The same sentences that
did nothing as a block are worth **+6.7 to +10.5pp** on the column line (four
runs, p=0.0015 to 1.7e-4), and the dataset's own curated notes on the same columns
score +1.3pp over generated ones (p=0.375, one case each way).

The practical consequence: **attached definitions plus a per-question hint reach
56.1%, against 56.9% for 798 curated notes plus the same hint — a two-case
difference at a third of the prompt.** A database with no documentation can be
brought to the accuracy of one that has it.

What does not work is asking the model to think first. A stage that restates the
question — measure, rows, numerator, denominator — before writing SQL changed
exactly zero cases (17 fixed, 17 broken, p=1.0) and costs an extra call per
question. The gap is external knowledge, not reasoning order, so `interpret` stays
off by default.

So use the inline form. The block form is kept for one case only: a definition
that belongs to a table rather than a column has nowhere to sit.

```ts
import { attachDefinitions } from '@agentix-e/nl2charts-ai';

// `written` is whatever a person or a model produced, one line per definition:
//   - orders.status = completed means paid and shipped.
//   - "total_amount" is the charged amount, tax included.
const placed = attachDefinitions(schema, written);
// placed.attached   -> how many lines found a column
// placed.unplaced   -> the rest, kept so you can see what was dropped
const schemaWithDefinitions = placed.schema;
```

Two rules came out of the runs above:

- **Only addressable lines matter.** Going from 57 to 143 attached lines (37% to
  92%) changed nothing: 42.3% to 41.8% while the prompt grew. Most of the effect
  comes from the columns a question is likely to touch; the tail adds text.
- **Never guess a column.** `attachDefinitions` returns unplaced lines instead of
  matching loosely. A definition on the wrong column is read with full confidence
  and is worse than a missing one.

## Cost and budget

A definition costs whatever its line costs. The measured inline arm averaged
**2,166 characters** of schema card — less than the block it replaced — because
only the addressable lines survived. The structural renderer is bounded by
`maxChars` (default 900, mean 778 across the eleven BIRD databases), and it stays
useful for grain and join direction, which have no column to attach to.

## Measuring it on your own database

Do not take the numbers in this page on faith, and do not take your own numbers
from one run either. The benchmark page documents the protocol: same questions,
one lever per arm, paired McNemar, and a noise floor measured by asking the same
cases three times. Structural semantics is one lever — `names` → `definitions`
changes nothing else.
