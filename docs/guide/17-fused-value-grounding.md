# Fused value grounding

This guide closes a gap between two parts of the evaluation harness. Read it
after [semantic value retrieval](14-semantic-value-retrieval.md) and
[pairing evidence](15-pairing-evidence.md).

## 1. Two arms that never met

The repository has carried two ways of finding which values a question is
about.

The **lexical arm** (`eval/bird/values.ts`) scans the stored cells and matches a
word in the question to a value it finds there. It is precise: it drops a word
that lands in more than one column rather than guessing, and it keeps one hit
per word. Its limit is that the word has to appear literally. A question that
says "banned" resolves a column holding `Banned`, but a question that
paraphrases the value as "not allowed" finds nothing.

The **semantic arm** (`eval/bird/semantic-values.ts`, added in round 215) embeds
both the question and the column/value vocabulary and retrieves by cosine
similarity. It can reach a value the question only paraphrases. But until round
218 it was called only by tests: nothing turned its hits into a string a SQL
prompt could read. The retrieval existed; the wire to the generator did not.

A reader could reasonably ask why three rounds built a retriever that no prompt
consumes. This module is that wire, and the rest of this guide says exactly
what it does and does not claim.

## 2. The seam it feeds

The product prompt builder already has a slot for data-derived values:

```ts
buildSqlPrompt(question, schema, { values: "- legalities.status stores 'Banned'" });
```

That slot renders as `Values in this database named by the question:`, followed
by the block. It was designed for the lexical arm's output. The fusion module
emits the **same heading-free line format**, so the seam consumes either arm's
output byte for byte. Nothing in the product package changed and no new prompt
field was added.

## 3. The fusion rule

`fuseValues(lexical, semantic, options)` merges the two arms' records into one
list:

- **Identity** is `table · column · value`. A value found by both arms appears
  once.
- **Provenance goes to the exact arm.** When both find the same value, the line
  is marked `lexical`, because a value named word-for-word in the question is a
  stronger claim than a similarity match.
- **Lexical hits keep their order**; the lexical index has already applied its
  ambiguity guard and there is no reason to reshuffle it.
- **Semantic hits are ordered by descending cosine score**, with identity as a
  stable tie-break, then capped at one per column by default so one prolific
  column cannot crowd out the rest.
- A semantic hit that names a **column without a stored value** is dropped: a
  grounding line promises a value, and `t.c is a column` is not one.

`renderFusedValues(rows, maxChars)` turns the rows into the heading-free lines,
with the same character budget as the existing value renderer.

## 4. The async builder

`buildFusedValueBlock(question, profile, lexicalHits, provider, options)` is the
end-to-end entry point. It builds a semantic index from the profile, searches it
with the injected embedding provider, fuses the hits with the caller's lexical
hits, and returns the rendered block together with per-arm counts.

```ts
const block = await buildFusedValueBlock(question, profile, lexicalHits, provider);
const prompt = buildSqlPrompt(question, schema, { values: block.text });
```

The provider/model/dimension contract is owned by `buildSemanticIndex` and
`searchSemanticValues`: a provider that drifts from the index, or an already
aborted signal, is rejected before a line is produced. The embedding provider
is injected, so any vendor — or a user-defined `EmbeddingProvider` — can drive
the semantic arm.

## 5. What it is — and what it is not

This is **wiring**, not a result. It removes the structural gap between a
retriever and a prompt seam, with a test that asserts the fused block appears in
a real `buildSqlPrompt` output. It is deterministic, makes no network call on
its own, and publishes no accuracy gain.

The unit tests use a real deterministic hash provider, which is a stand-in for
the retrieval *wiring*, not a priced semantic-quality reading. Whether the
semantic arm earns its place is a question for a paired dispatch with a real
provider and a pre-registered threshold, under the Org-secret workflow; see
[the ADR](../adr/0002-priced-promotion.md) and
[the benchmark record](../benchmarks.md). Nothing here turns the semantic arm on
by default or changes the shipped SQL recipe.
