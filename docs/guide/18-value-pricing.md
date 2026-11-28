# Paired value-grounding pricing

This guide closes the last open gap between the value-retrieval instruments and a
number that can be argued with. Read it after
[fused value grounding](17-fused-value-grounding.md) and
[gold fields from the reference SQL](16-gold-fields.md).

## 1. The gap

Rounds 215 through 218 built a complete chain of instruments:

| Instrument | What it does |
|---|---|
| `semantic-values.ts` | Embeds a profile's column/value vocabulary and retrieves by cosine similarity |
| `value-pair-harness.ts` | Buckets each field a retriever won or lost as confirmed or spurious against gold |
| `gold-fields.ts` | Reads the real `table.column` fields a reference SQL needs |
| `fused-values.ts` | Merges the lexical and semantic arms into one block the prompt seam consumes byte for byte |

Every one of them was consumed only by tests. There was no entry point that ran
all four together on real dev questions with a provider injected, so the paired
pricing that round 37 of the internal plan asks for could not be dispatched. The
retriever had a wire to the generator, but nothing drove a paired reading through
it. That is the gap this module closes.

## 2. The unit of the price is the question

A field-level difference is evidence, not a verdict. If the fused arm finds one
more `table.column` on a question, that is a fact about fields; it is not proof
that the generated SQL got better. The decision the project actually faces —
should the fused arm be promoted into the shipped SQL recipe — is a yes/no choice
per question:

> Did this arm ground **every** field the gold SQL needed?

Two arms are compared on the same question: the lexical `values` arm and the
fused arm. That yields the four cells of a paired design:

|  | fused grounded all | fused missed one |
|---|---|---|
| **lexical grounded all** | both (`a`) | lexical only (`c`) |
| **lexical missed one** | fused only (`b`) | neither (`d`) |

Only `b` and `c` are discordant. The two-sided exact McNemar test runs on those
two counts using the repository's audited `mcnemarExact`. Field coverage and the
confirmed-gain count are still reported, but as evidence for *why* the pair
moved — never as the price. A single coverage ratio is exactly the reading that
turned out to be an artefact of approximate gold in an earlier round.

A question whose gold SQL names no resolvable field is excluded. It cannot
discriminate between arms and would only dilute the denominator.

## 3. What it can and cannot price

The module is explicit about the strength of its own number:

- **With the deterministic hash provider** (the CLI default) it is a **harness
  proof**. The wiring runs end to end on real cached SQL and real profiles, but
  a hash vector is a lexical stand-in, not a semantic model. The emitted note
  says `HARNESS PROOF, NOT an accuracy claim`.
- **With a hosted `EmbeddingProvider`** injected by the Org-secret workflow it
  is a **priced reading** of prompt grounding. Even then the number is a
  *grounding* price — did the retrieved fields cover what the gold SQL needs —
  not an execution-accuracy claim. A prompt can contain the right field and
  still produce wrong SQL; coverage is necessary, not sufficient.

Promotion into `SHIPPED_SQL` remains a separate decision that requires the price
to clear a pre-registered threshold in a real dispatch. The module changes no
product package, no default arm and no shipped SQL recipe.

## 4. Running it

```sh
# Local harness proof (no key, no network): the hash provider stands in.
pnpm bench:bird:price

# A priced reading is a workflow dispatch. Set the hosted variables from the
# Org secret and the CLI builds an OpenAI-compatible HTTP provider instead:
#   PRICING_EMBEDDING_BASE_URL=https://open.bigmodel.cn/api/paas/v4
#   PRICING_EMBEDDING_MODEL=embedding-3
#   PRICING_EMBEDDING_API_KEY=<from the Org secret>
# A partial configuration (only some of these) is refused, not downgraded to
# hash — a dispatch that lost a variable must fail rather than price a straw man.
```

The CLI reads the cached dev split and profiles through injected reader/logger
seams, so it runs in CI where `eval/.cache` is absent — the test uses in-memory
strings and never touches the gitignored cache. Set `VALUE_PRICING_LIMIT` to cap
the number of questions.

## 5. The output

```json
{
  "note": "PRICING RUN — ... NOT an accuracy claim ...",
  "questions": 60,
  "bothFull": 0, "fusedOnly": 0, "lexicalOnly": 0, "neitherFull": 60,
  "discordant": 0, "mcnemarP": 1,
  "lexicalCoverage": 0, "semanticCoverage": 0, "confirmedGain": 0
}
```

The note travels with the number so a result can never be quoted out of
context. `mcnemarP` is `1` when there are no discordant pairs, not `NaN` — an
empty price is a clean zero, not a hidden failure.

## 6. Two corrections found while auditing the baseline

The pricing instrument was correct in shape but wrong in baseline. Two defects were
found by comparing it against the code that actually builds the shipped prompt.

**The lexical baseline was a straw man.** The tool originally constructed the
lexical arm with a hand-written rule: a value counted only if the question named
both the column *and* the value (`"status"` and `"Banned"`). The product's `values`
arm does not work that way — `findValues(buildValueIndex(profile), question)`
resolves a question token to a stored value without requiring the column name.
On the real dev split the hand-written rule missed **228 of the 253 questions**
the product arm grounds. Pricing the fused arm against that weaker arm inflated
its apparent gain — the exact class of artefact this tool was built to reject.
`shippedLexicalArm` now delegates directly to the product function, so the
baseline and the shipped prompt cannot drift into two implementations.

**The hosted seam was a promise with no code.** The module's contract said an
Org-secret workflow injects a hosted `EmbeddingProvider`, but nothing constructed
one. `providerFromEnv` now closes that seam: no hosted variables yields the
deterministic hash provider (a harness proof, no key needed); a complete
base-URL/model configuration builds the HTTP provider; a partial configuration
throws. There is no state in which a dispatch believes it priced a real model
while silently using a hash stand-in.

Neither correction changes a published reading: both were made while the tool
was still a harness proof, before any hosted dispatch. The note on every report
still says the hash run is not an accuracy claim.

## 7. The first dispatchable price, costed before it is sent

Two things kept the reading behind the key. The injection seam existed, but no workflow
constructed a hosted provider, and the price list had no row for the vector model — a
dispatch would have spent real tokens and then printed "no price on file" when asked
what they cost. Both are now closed.

`.github/workflows/value-pricing.yml` is a dispatch-only job. It reads
`PRICING_EMBEDDING_API_KEY` from the `ZHIPU_API_KEY` or `DEEPSEEK_API_KEY` Org secret
at runtime — no dispatch input carries a key and no report prints one — and runs
`pnpm bench:bird:price` against the same `runPricing` code the harness proof uses.
The report and its artifact are published with `if: always()`, so a failed pricing
gate cannot take the per-case evidence down with it. The workflow is a `choice` over
declared inputs and passes the repository's own seven-rule workflow gate.

Cost is bounded before a token is spent. `eval/price.ts` now carries the vector model
at the rate the provider publishes — **¥0.5 per million input tokens** for
`embedding-3`, read off the vector-model table and cited to the provider's pricing
page. Because embeddings have no output tokens, the row records `output: 0` and
states the same rate twice in `cached` (the table requires every row to name a cache
price; a provider with one price charges hits at the miss rate). `projectedPricingYuan`
multiplies a conservative per-case ceiling of 4,000 input tokens by the question
count and the listed rate — 60 questions project to **¥0.12**. `main` reads
`VALUE_PRICING_ACCEPT_COST` and `enforceCostCeiling` refuses the dispatch before the
first embed call if the projection exceeds the ceiling, or if the hosted model has no
price row at all. A local hash run has no price and no ceiling: the harness proof is
never blocked on cost.

The workflow's `accept_cost` default (¥5) is far above the ¥0.12 projection, so a
normal dispatch proceeds; a caller can lower it to refuse an over-budget run. The
number still is not execution accuracy: the report's note says so, and promotion to
`SHIPPED_SQL` still needs a pre-registered threshold met in a real dispatch.

## 8. What the first real dispatch found

The first dispatch (`46130561111`) failed before a single embedding call — and the failure
was not the model, the key or the cost gate. It was the data plumbing that six local
harness proofs had concealed:

- **The split flag did nothing.** `fetch.mjs` reads `BIRD_SPLIT`; passing `--split dev` was
  ignored, so the job fetched the default `minidev` and `dev/dev_20240627/dev.json` was absent.
  The workflow now uses `BIRD_SPLIT=dev pnpm bench:bird:fetch`, the same form `bird-dev.yml` uses.
- **Profiles were never generated.** `runPricing` read `eval/.cache/bird/profiles/` — a directory
  that existed on a developer machine but not in a clean checkout. Profiles are synthesised by
  `bench:bird:dry` into `BIRD_DATA/.profiles/`. `runPricing` now takes an injectable
  `profileCache` (defaulting to the legacy path for compatibility) and `main` reads
  `BIRD_PROFILE_CACHE`; the workflow generates profiles with a dry run and points the reader at
  `eval/.cache/bird/dev/dev_20240627/.profiles`.
- **`eval/out` did not exist.** It is gitignored, so the `tee` target failed on a fresh runner.
  The step now creates it, and `set -o pipefail` keeps a failed price from being reported as a
  successful `tee`.

This is the value of a real dispatch: it exercised seams a local cache had papered over. The
report and artifact were still published (`if: always()`), so the failure carried its own
evidence rather than a silent red step. No price was read and no direction was claimed from
the failed run; the workflow was corrected and re-dispatched.
