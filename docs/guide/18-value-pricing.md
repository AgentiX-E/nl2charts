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

# A priced reading is a workflow dispatch: the Org-secret workflow imports
# runPricing and injects a hosted EmbeddingProvider instead of the hash one.
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
