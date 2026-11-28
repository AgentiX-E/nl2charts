# Semantic value retrieval

This guide explains how to resolve a word in a question to a column when the
word is not stored verbatim. It builds on [13 — Embeddings](./13-embeddings.md),
so read that first if you have not injected an `EmbeddingProvider` before.

## 1. The problem: three ways to miss a value

A statement like `where status = 'banned'` can fail even though the database
holds the answer. The repository already has two resolvers:

- `values.ts` matches a token that **equals** a stored value (`Banned`).
- `askdata.ts` matches a literal whose character **shingles** resemble a
  stored value (`Fresno County Office of Education` against `Fresno County
  Office Of Education`).

Both are lexical. A question that names a value in words the database never
stores — "restricted cards" where the column stores `Not Legal`, or "the
reissue" against a column of `reprint` — defeats both, because they share no
token and no n-gram.

Semantic value retrieval embeds each column name and each categorical value
into a vector space and retrieves by cosine distance. It finds fields whose
*meaning* is close even when the spelling is not.

## 2. Build an index

The index is built from a `DatabaseProfile`. For every categorical or `other`
column it embeds two kinds of text: a column-name line and one line per stored
value. Numeric and date columns are skipped deliberately — a question names
their ranges as arithmetic, which the evidence profiler already handles.

```ts
import { createHttpEmbeddingProvider } from '@agentix-e/nl2charts';
import { buildSemanticIndex } from '../../eval/bird/semantic-values';

const provider = createHttpEmbeddingProvider({
  baseUrl: 'https://api.example.com/v1',
  apiKey: process.env.EMBEDDING_API_KEY,
  model: 'text-embedding-3-small',
  dimensions: 256,
});

const index = await buildSemanticIndex(profile, provider);
```

No key available? Use the deterministic offline provider — it is a real
bag-of-words hashing embedding, not a stub:

```ts
import { createHashEmbeddingProvider } from '@agentix-e/nl2charts';
const index = await buildSemanticIndex(profile, createHashEmbeddingProvider());
```

Build once per database and reuse the index across questions. It records the
provider id, model and dimension so a later query cannot silently use a
different model space.

## 3. Search and render

```ts
import { searchSemanticValues, renderSemanticValues } from '../../eval/bird/semantic-values';

const hits = await searchSemanticValues(index, 'Which cards are restricted?', provider, {
  k: 3,          // at most three fields
  minScore: 0.2, // drop weak matches
  perColumn: 1,  // never let one column fill the block
});
const block = renderSemanticValues(hits);
// - legalities.status stores 'Not Legal'
```

Hits are ranked by cosine similarity, descending. Ties break on field order,
so the same question produces the same block on every run — a retrieval arm
that reshuffles between runs is not a measurement. `perColumn` defaults to 1
so a single column with many similar values cannot crowd out the others.

## 4. The guards, and why each one exists

The retriever refuses four things that would otherwise produce a confident
but wrong block:

- **A query in a different model space.** The index stores its provider id and
  model. Searching with a provider that does not match throws, because cosine
  similarity across two models is a number but not a similarity.
- **A dimension drift.** A query vector whose length differs from the index is
  rejected before scoring.
- **No vocabulary, or no content words.** An empty index or a question made
  only of stopwords returns nothing without calling the provider — an empty
  retrieval block is a prompt that invites the model to invent values.
- **An aborted signal.** Build and search propagate `AbortSignal` rather than
  returning a partial index.

## 5. Pairing two retrievers

Choosing between the semantic resolver and the exact one is a measurement,
not a taste. `pairValueRetrieval` reports the fields one found and the other
did not, on the same input:

```ts
import { pairValueRetrieval } from '../../eval/bird/semantic-values';

const pair = pairValueRetrieval(
  exactHits.map((h) => ({ table: h.table, column: h.column })),
  semanticHits.map((h) => h.field),
);
// { gained: ['legalities.status'], lost: [], shared: ['sets.type'] }
```

`gained` and `lost` are the cells a McNemar test needs. Look at them before
quoting an accuracy delta: an aggregate can hide that one arm won five fields
and lost four.

## 6. Status: a candidate, not a shipped claim

This module is the retrieval mechanism that the strongest training-free
competitor (OpenSearch-SQL) uses for its cell-and-column-name index. It is
delivered here as a **candidate**: injectable, offline-testable, and paired.
It is not yet wired into the shipped answer path, because no paired accuracy
reading exists yet to justify the change. When such a reading clears the
pre-registered threshold, the pairing result is what promotes it — not an
assumption that "semantic" must be better.
