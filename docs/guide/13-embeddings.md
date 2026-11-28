# Embeddings: bring your own provider, or run offline

A chat provider writes SQL. An embedding provider turns text into a vector of
numbers, so you can ask "which of these columns or examples is closest in meaning
to this question?" This guide shows the three ways to get one, from zero setup to
a fully custom provider, and the two mistakes the contract refuses to make for you.

Everything here lives in `@agentix-e/nl2charts` and is a peer of the chat
provider you already inject: whatever you can do with a custom `LlmProvider`, you
can now do with a custom `EmbeddingProvider`, including the model and its
parameters.

## 1. The zero-setup path: offline, no key, no network

If you have no API key — on a laptop, in CI, in an air-gapped deployment — start
with the deterministic hashing provider. It hashes each word into a numeric
bucket and normalises the result. It is lexical, not semantic: it knows two
sentences are close when they share words. It is real, reproducible, and needs
nothing.

```ts
import { createHashEmbeddingProvider, cosine, rankByEmbedding } from '@agentix-e/nl2charts';

const embed = createHashEmbeddingProvider({ dimensions: 256 });

const vectors = (await embed.embed({
  texts: ['total revenue by region', 'revenue per region', 'deploy kubernetes'],
})).vectors;

cosine(vectors[0]!, vectors[1]!);  // high: they share "revenue", "region"
cosine(vectors[0]!, vectors[2]!);  // low: nothing in common

// Rank candidate documents against a query vector; ties break by index, deterministically.
rankByEmbedding(vectors[0]!, vectors, 2);
// → [{ index: 0, score: 1 }, { index: 1, score: <high> }]  (top 2)
```

Use this when determinism and zero cost matter more than semantic depth.

## 2. The hosted path: any OpenAI-compatible embeddings endpoint

Point the HTTP provider at your vendor's `/v1/embeddings`. Base URL, key, model
and `dimensions` are all yours to set, so the same code works against DeepSeek,
Zhipu/GLM, OpenAI, or a self-hosted gateway.

```ts
import { createHttpEmbeddingProvider } from '@agentix-e/nl2charts';

const embed = createHttpEmbeddingProvider({
  baseUrl: 'https://api.deepseek.com/v1',   // never hardcode a key; read it from the environment
  apiKey: process.env.DEEPSEEK_API_KEY,
  model: 'embedding-model',
  dimensions: 1024,                          // omitted if the endpoint chooses its own size
  retries: 2,                                // attempts on 429/5xx; a 400 is never retried
});

const { vectors, dimensions, usage } = await embed.embed({
  texts: ['how many free school meals', 'count of students eligible'],
  purpose: 'retrieval-query',                // lets a cost meter file this call
});
```

`usage` is present when the endpoint reports token counts and absent when it
does not — absent does not mean zero. Pass an `AbortSignal` as the second
argument to cancel a call; an already-aborted signal never leaves the process.

## 3. Bring your own: a custom `EmbeddingProvider`

Any object with the contract's shape can be injected. This is the escape hatch
for a local model, a proprietary index, or a provider this library has never
heard of.

```ts
import type { EmbeddingProvider } from '@agentix-e/nl2charts';

const mine: EmbeddingProvider = {
  id: 'my-local-model',
  model: 'bge-small',
  dimensions: 384,
  async embed(request) {
    return {
      vectors: await myModel.embed(request.texts),   // one vector per text, in order
      model: this.model,
      dimensions: 384,
    };
  },
};
```

No registration step and no global state: pass `mine` to the component that
needs embeddings, the same way you pass a custom `LlmProvider` today.

## 4. Two silent failures the contract refuses

Embedding endpoints fail in ways that look like success. The HTTP provider
guards the two most expensive ones at the boundary:

- **Order.** A batch comes back as `{ index, embedding }` records and a vendor
  may return them in any order. Pairing by position attaches the wrong vector to
  the wrong text. The provider reorders by `index` before returning.
- **Shape.** A short batch, or one vector with a different dimension from the
  rest, is rejected — not padded, not zipped. A `cosine` across mismatched
  dimensions throws rather than computing a plausible wrong score.

If you write your own provider, preserve these two guarantees. A retrieval
block built on a mispaired batch is worse than no retrieval, because it reads
confidently.

## Where this leads

This is the contract layer. It is the concrete unblock for building a
cell-and-column-name value index like the one OpenSearch-SQL uses — the module
that was previously unreachable because the repository had no embedding backend.
A shipped index and an accuracy reading still need a paired measurement; this
guide gives you the provider, not a claim about a number.
