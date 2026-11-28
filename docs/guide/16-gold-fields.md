# Gold fields from the reference SQL

This guide completes the first of the three conditions in
[15 — Pairing evidence](./15-pairing-evidence.md#5-when-this-earns-a-number).
That guide said a pairing harness becomes evidence only when gold comes from the
reference SQL, the semantic arm uses a real provider, and the discordant fields
enter a McNemar test. This guide delivers the first condition: a trustworthy,
deterministic **gold field set** extracted from a question's gold SQL.

## 1. Why the question text is not gold

The obvious way to guess which fields a question needs is to match its words
against column names. It is also wrong in a specific, costly way. A question
such as "what is the highest eligible free rate in Alameda County" names
*Alameda* and *free rate*; matching those words against the schema returns a set
that looks like gold but includes fields the reference SQL never reads and
misses fields it does. When that approximate set is used as the denominator for
a pairing harness, the harness reports a confident-looking gain that is really
just the gap between two approximations.

The reference SQL is the ground truth. It names exactly the fields the answer
depends on. Gold must be read from it.

## 2. The two shapes a statement uses

`referencedFields` (in `eval/bird/statement.ts`) already splits a statement into
the two ways SQL names a field:

| Shape | Example | What it gives you |
|---|---|---|
| qualified | `f."County Name"` after `FROM frpm f` | `frpm` + `county name`, alias already resolved, lower-cased |
| bare | `SELECT \`County Name\` FROM frpm` | `county name`, lower-cased, **not** resolved to a table |

BIRD's gold SQL leans heavily on the bare shape with quoted column names that
contain spaces and punctuation. A naive reader that only looked at qualified
pairs would see an empty gold set for most questions — the exact trap that made
an earlier smoke run report `referencedFields.qualified = []` on a question
whose SQL clearly read three columns.

## 3. Resolving against the profile

`extractGoldFields(sql, profile)` turns both shapes into one canonical
`table.column` space:

- A **qualified** pair is looked up in the profile to restore the canonical
  spelling (`county name` → `County Name`). A qualifier that resolves to a table
  the column does not belong to is never borrowed from another table.
- A **bare** name is resolved against the tables the statement actually reads.
  Names that are not profile columns drop out for free — SQL keywords such as
  `select`, `from`, `where`, `order` are not schema columns, so they cannot enter
  gold. A name owned by more than one named table is expanded across all of them
  rather than guessed onto one.
- A qualified pair that resolves to no profile row — a CTE or temporary table —
  is kept lower-cased, the honest key it was given, instead of being dropped
  (which would understate coverage) or invented (which would be worse).

The result is deduplicated and stably sorted, so the same SQL always produces a
byte-for-byte identical gold set.

```ts
import { extractGoldFields, goldKeys } from '../../eval/bird/gold-fields';

const sql = 'SELECT `Free Meal Count (K-12)` FROM frpm WHERE `County Name` = \'Alameda\'';
extractGoldFields(sql, profile);
// [{ table: 'frpm', column: 'County Name' },
//  { table: 'frpm', column: 'Free Meal Count (K-12)' }]

goldKeys(sql, profile); // Set { 'frpm.County Name', 'frpm.Free Meal Count (K-12)' }
```

## 4. Pairing against real gold

`buildGoldPairRow(questionId, question, goldSql, profile, exact, semantic)` is
the seam that puts the three together: canonical gold from the SQL, the two
retrieval arms canonicalised into the same space, and the six-bucket split from
`classifyCase`. Each row keeps the exact and semantic key lists for audit, so a
reader can see not just the buckets but the fields that produced them.

`renderGoldPairRows(rows)` prints one line per question with its confirmed gain,
spurious gain and confirmed loss — the per-question export Z.35 asks for before
any dispatch is priced. `toSummary(rows)` aggregates them with the same
summariser the harness uses.

```ts
import { buildGoldPairRow, toSummary } from '../../eval/bird/gold-pairing';

const row = buildGoldPairRow(0, question, goldSql, profile, exactHits, semanticHits);
// row.goldKeys, row.classification.semanticGainedConfirmed, ...
const summary = toSummary([row]);
```

## 5. What changed when gold became real

Running the export over the first 60 cached BIRD dev questions with the two
offline lexical arms produced a result that is worth reading carefully:

| Reading | Approximate gold (earlier smoke) | Real gold from SQL (this harness) |
|---|---:|---:|
| `confirmedGain` (fields) | large positive | **−42** |
| `semanticGainedSpurious` | — | 170 |
| `goldFields` | — | 293 |

The sign flip is the point. With an approximate gold built from question words,
the semantic arm's lexical hits looked like confirmed gains. With gold read from
the reference SQL, those same hits are overwhelmingly spurious, and the arm is
net negative. This is a concrete demonstration of the guide-15 warning: a
headline gain against approximate gold is not evidence, and reading fields from
the SQL is what turned an apparent breakthrough into an honest null result.

## 6. What this is — and what it is not

This module is deterministic and offline. It emits no score, makes no model
call, and is **not a pricing signal**. Its CLI prints `HARNESS PROOF ONLY` at the
top of every output so a number cannot be lifted out of context. It completes
condition 1 of guide 15; conditions 2 and 3 — a real embedding provider and a
paired McNemar test with a pre-registered threshold and token cost — still
belong to a priced dispatch through the Org-secret workflow. See
[the ADR](../adr/0002-priced-promotion.md).
