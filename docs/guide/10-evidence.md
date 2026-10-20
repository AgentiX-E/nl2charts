# Give the model definitions, not just schema

A schema card says what columns exist. It does not say what a term in a question
means. The gap is measurable: on BIRD Mini-Dev, the same model with the same
schema card scores **44.4%**; adding a one-sentence definition per question
("ratio of customers who pay in EUR = count(Currency='EUR') /
count(Currency='CZK')") takes it to **58.2%**.

That is a 12.1pp difference produced by text, not by a model change.

## Three things you can add, in order of value

| What you add | Where it goes | Measured effect |
| --- | --- | --- |
| A definition of a business term | `evidence` | +12.1pp |
| A one-line meaning per column | `comment` | +11.3pp |
| The values a column actually contains | `samples`, or a data profile | +1.7pp |

The first two are knowledge only a person has. The third can be generated — and
generating it is worth far less than writing the first two, which is the whole
point of this page.

## Definitions: one sentence per question

```ts
import { createPipeline, createHttpProvider } from '@agentix-e/nl2charts-ai';

const pipeline = createPipeline({
  provider: createHttpProvider({ baseUrl, apiKey, model }),
  prompt: {
    dialect: 'SQLite',
    evidence: 'active customer = at least one order in the last 90 days; revenue excludes tax and refunds',
  },
});
```

Write the sentence a new analyst would need. Say what a filter excludes, how a
ratio is computed, and which column carries the money. Do not restate the schema.

## Column meaning: one line per column

```ts
const schema = [
  {
    table: 'orders',
    columns: [
      { name: 'amount', type: 'DECIMAL', comment: 'total charged, tax included' },
      { name: 'status', type: 'VARCHAR', comment: 'order state' },
    ],
  },
];
```

Labels and descriptions are on by default; turn them off with
`descriptions: false` when the schema is large and the question is a simple
filter. On window and ranking questions a shorter card measures better.

## Data profile: generated, and worth less than you hope

`renderEvidence()` turns a per-column profile into a dictionary:

```
Data profile:
- orders.status: 2 values (completed, refunded)
- orders.order_date: dates from 2024-01-01 to 2024-12-31
- orders.amount: numbers from 10.5 to 199.9
```

It is useful for date ranges and enum spelling, and it is cheap to produce: one
query per column for cardinality and range, one grouped query per categorical
column, cached per database. But it does not define anything, and the measured
gain over a plain schema card is 1.7pp — inside the noise of a 239-question run.

**Use it to fill gaps, not as a substitute for writing definitions.**

## What to watch for

- A profile that lists identifiers (`id: numbers from 1 to 25`) spends the
  character budget without adding meaning. `renderEvidence` drops them by name.
- Opaque keys (`recLKj8BbTNqxFbTb`) look categorical and are useless; they are
  dropped by value shape.
- A dictionary of 200 distinct free-text values is not a dictionary. Cardinality
  above 30 is dropped.
