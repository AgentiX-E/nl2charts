# Glossary

**Abort signal** — A standard `AbortSignal` passed to a call so the caller can
cancel it. The runner also races the call against its own timeout, so a driver
that ignores the signal cannot hang the process.

**Additivity** — Whether a metric can be summed across a dimension without
double counting. `sum(x)` is additive, `avg(x)` and `count(distinct x)` are not.
Recorded explicitly in a semantic model; inferred only as a warning.

**Aggregate** — The function applied to a measure before it is charted
(`sum`, `mean`, `count`, `min`, `max`, `median`). Stored in the `ChartIR` so the
chart does not have to guess.

**Alt text** — The textual alternative for a chart. Required by lint before
rendering: a chart without it cannot be cited, searched or read aloud.

**Canonical value** — The runtime-independent form of a database value
(`bigint` → number or exact string, `DECIMAL` → exact string, `DATE` →
`YYYY-MM-DD`). Row hashes are computed on canonical values.

**Candidate** — A chart type that is structurally valid for a result set, with a
score and a reason. Enumeration proposes; linting and the caller decide.

**ChartIR** — The contract document describing a chart: mark, encoding, data,
title, alt text, theme, size. Versioned (`3.0`), validated with zod, published as
JSON Schema.

**Consumer** — Code that imports a package. Consumers must use symbol imports,
not `import * as`, to keep tree-shaking effective.

**Contract code** — A stable `NL2C_E_*` error code. Consumers branch on codes,
never on message text.

**Control (positive/negative)** — A predictor with a known score, used to prove a
benchmark can discriminate. Oracle = 100%, empty = 0%. A run with a broken
control is invalid.

**Core** — The package that executes SQL, guards statements, normalizes values
and negotiates routing. It contains no model calls and no `node:*` imports.

**Dialect** — The SQL flavour of an engine (`duckdb`, `postgres`, `sqlite`).
Carried on the engine and in span attributes.

**Engine** — The adapter that actually runs SQL. `core` defines the interface;
`node` implements it for native DuckDB. An engine is the only component that
touches a database.

**Decomposition** — A shape of generation in which the model writes the
sub-questions as working statements (`STEP 1: …`) and then composes them into
the answer, all in one reply and one call. Opt-in (`decompose`), and unlike a
*plan* it is not carried in from an earlier call: the benchmark measured a plan
carried in at −7.2pp, because it anchored the statement it was meant to prepare.
The answer is read from the last block, and `decomposedSteps` reports how many
steps the model actually wrote, so an ignored instruction is visible.

**Empty-result turn** — One extra model call, made only when a statement the
engine accepted returned no rows. Separate from *repair*, which answers a
statement the engine refused: the two failures have different causes and
different costs. It is opt-in (`emptyRetry` plus an `execute` hook that returns a
row count), it never fires twice, and it reports `{ fired, recovered }` so the
call can be divided by what it bought. On BIRD the signal is exact rather than a
heuristic — no question in either split has an empty gold result — which is why
this turn is allowed while the row-and-column shape guard was rejected.

**Execution accuracy** — Benchmark metric: the predicted SQL's result set equals
the gold SQL's result set. Compared both exactly (row order matters) and
unordered. Both are reported; neither is "the" accuracy.

**Guard** — The lexical statement filter. Accepts `select`/`with`/`values`/
`explain`/`describe`/`summarize`, rejects banned keywords, file-reading
functions, multiple statements and `AT (VERSION)`. Rejects when unsure.

**Golden case** — A recorded expectation for a query: columns, row count and a
row-set hash. Used as a warehouse contract test.

**Lint rule** — One of twelve readability and correctness checks on a chart.
`error` blocks rendering; `warn` records a problem.

**Mark** — The chart type in a `ChartIR` (`bar`, `line`, `pie`, …). Closed list
of 22 ECharts series types at contract version 3.0.

**McNemar test** — A paired test for two classifiers on the same cases. Used for
ablations; with small samples the exact p-value is reported and the result is
called underpowered rather than significant.

**MCP** — Model Context Protocol. The `mcp` package exposes `run_sql` and
`engine_info` over newline-delimited JSON-RPC.

**Measure** — A quantitative field that is aggregated (revenue, quantity). In a
semantic model, a metric with an expression and a grain.

**Normalization (question)** — Mapping synonyms and punctuation before matching
(`sales` → `revenue`, `per` → `by`). Its effect is measured, not assumed.

**PLT1–PLT7** — The seven platform-boundary assertions (no `node:` builtins, no
drivers, no type leaks, dependency direction, no orchestration in bindings,
symbol-based identity, no `ai` in `core`).

**Provenance** — Who wrote the SQL: `sql` (a human) or `nl` (a model). Attached
to every result for audit.

**Recall@k** — Benchmark metric for schema linking: the share of cases where
every expected column appears in the top *k*. The pipeline uses k = 3.

**Reciprocal Rank Fusion (RRF)** — Combining several ranked lists by summing
`1 / (60 + rank)`. Used to fuse the name, alias and value recallers.

**Replay provider** — A first-class LLM provider that returns recorded responses
by matching the prompt. Used in CI so the real pipeline runs deterministically.

**Runner** — The object that wraps an engine: guard, limit, timeout, normalize,
provenance, spans. Created with `createRunner({ engine })`.

**Schema card** — The compact textual schema given to a model: one line per
table, column names and types. No sample values unless explicitly added.

**Schema linking** — Selecting the tables and columns relevant to a question
before prompting. Three recallers: name, alias, sample value.

**Span** — One observability event per execution, delivered to `onSpan`. A
throwing hook cannot fail the query.

**Truncated** — True when the engine returned more rows than the cap. Detected by
fetching `limit + 1` rows, not by a second count query.

**Value profiler** — The recaller that matches sample values from a column
(`north` → `region`). Worth 28pp of recall@3 on the benchmark fixture.

**DataflowPlan** — The semantic graph the compiler builds before SQL exists:
read, aggregate, join, compute, window, project, sort, limit. It is what
`explainQuery()` returns and what the optimizer rewrites.

**Fan-out** — Row multiplication caused by joining a one-to-many table before
aggregating. A hand-written join inflates revenue 3.00x on the benchmark fixture;
aggregating at the metric grain first prevents it.

**Grain** — The column(s) that make a row unique for a measure (`order_id` for an
order-level amount). Declared per metric and used as the aggregation key before
joins.

**Inner join on a filtered dimension** — When a query filters a dimension table,
the compiler joins it with `INNER JOIN` instead of `LEFT JOIN`, so filtered-out
rows do not survive as a `NULL` group.

**Masked column** — A column the compiler may not read at all. Referencing it in a
metric, dimension or filter fails with `MASKED_COLUMN` rather than returning null.

**Ratio metric** — A metric compiled as `sum(numerator) / sum(denominator)`, never
`avg(numerator/denominator)`; the two differ whenever group sizes differ.

**Row-level security (RLS)** — A predicate attached to a table and injected into
every read of that table, including reads generated for joins. A contradictory
query filter yields zero rows rather than escaping it.

**SqlPlan** — The lowered, dialect-neutral form: one CTE per dataflow node. A new
SQL dialect is a renderer over this plan, not a new compiler.

**Execution accuracy** — Whether a predicted query's result set equals the gold
result: same column count, same column order, same values; aliases are ignored.

**Repeat / majority** — Every live case is asked several times (default three)
and scored by majority. `temperature: 0` alone is not deterministic; the
artifact reports how many cases disagreed with themselves.

**Saturation** — A benchmark on which every arm scores near 100%, so it cannot
measure a module's contribution. The 210-question synthetic set is saturated for
`deepseek-chat`; external sets are required for headroom.

**Self-flip** — A case whose outcome differs across repeated identical calls. A
non-zero flip count invalidates single-run ablation claims.

**BIRD Mini-Dev** — An external text-to-SQL benchmark: 500 questions over 11
SQLite databases, with evidence hints and gold SQL written by its authors. Used
here so accuracy is not a property of our own fixtures.

**Duplicate credit** — Cases the official BIRD judge passes because it compares
`set()` and therefore collapses duplicate rows. Reported next to the strict
multiset score so the gap is visible.

**Execution accuracy** — A predicted query is correct when its result set equals
the gold result set: same column count, same column order, same values; row order
and aliases do not matter.

**Gold runnability** — The share of dataset gold statements that execute on the
engine under test. A gold statement that fails is excluded and counted; treating
it as a model error would understate every arm equally and hide the real problem.

**Evidence (BIRD)** — A dataset-provided sentence that defines the business terms
a question uses, for example how a ratio is computed. An arm either includes it
or does not; that is the ablation.

**Structural semantics** — Grain, keys, join direction and column roles inferred
from names, declared types and foreign keys, with no human-written dictionary.
Rendered by `renderDefinitions()` and passed to the prompt as `definitions`. It
states what the schema licenses, not what a business owner meant.

**Discordance (paired)** — The share of cases where exactly one of two arms is
right. Only those cases carry information about a paired difference, whose
standard error is `sqrt(π/n)`. A pair that agrees on every case has a plug-in
discordance of zero, which would claim the harness is exact; the report answers
`3/n` instead (the rule of three), because zero events do not bound a difference
at zero.

**Resolution (of a delta)** — The smallest difference a comparison could have
detected: `(1.96 + 0.8416)` standard errors at 80% power, computed from the
observed discordance. It is a property of the design rather than of the result,
so it is printed beside every p-value — a p-value answers whether a difference is
zero, never whether the run was able to see it. `casesForClaim` is the inverse
question: how many cases a given delta would need.

**Candidate independence** — Whether the prompts an arm declares are actually
distinct for a question. An arm that names three prompts and sends two identical
ones is not the arm its label says it is; the artifact counts those questions
(`mixedCandidatePrompts.degenerateIds`), and `pnpm bench:bird:strata` splits a
comparison on them, because a pooled delta across arms with different
independence mixes two comparisons in an unknown proportion.

**Selection loss** — The ceiling minus what the arm returned: the cases where some
candidate answered the question and the arm did not come back with it. It is the
whole room a better selector has, and it is bounded by the candidate set — an arm
that loses nothing cannot be improved by choosing better, and an arm that loses a
lot cannot be improved by generating more.

**Candidate record** — Per case, the candidate set with the judge's verdict on each
member, and which member the arm returned (`cases[].candidates`,
`cases[].winnerSource`). Without it a loss has a size but no address: "the selector
rejected the second model's statement" and "it took a different wrong statement
while a right one sat beside it" are the same two numbers.

**Selector judge** — The model asked which of an arm's candidates answers the
question. It never sees a label, so any preference it has for statements one model
wrote has to travel through *style* — which is why the same candidate set scores
25.6% on the second model's own statement under one judge and 68.2% under the
model that wrote it, and why canonicalising the candidate text is a lever rather
than a cosmetic change.

**Self-preference (of a judge)** — A judge's tendency to prefer text that resembles
its own generations. It is measured here rather than assumed: the same three
candidates, the same prompt, only the judge's identity changed, and that
candidate's conversion moved by 42.6pp. It is also *expensive*: the second model's
bias takes its own statement over two candidates that agree and are both right on
128 cases, where the first model's bias does so on 23. Closing the style channel
then showed that the bias is smaller than it looked: with the text normalised, the
weak judge's conversion of its own statement moved 65.0% → 67.4% while its
conversion of *another* source's statement moved 50.0% → 72.4%. What canonical text
fixed was comprehension, not allegiance.

**Position bias** — A judge's tendency to prefer the candidate it reads first,
independent of who wrote it. It is an *untested confound* here rather than a
finding: `CROSS_SOURCES` always puts the second model's candidate first, so
authorship and position are perfectly correlated in every cross experiment run so
far, and "it prefers its own writing" and "it prefers candidate 1" predict exactly
the same number. `select-cross-shuffled` is the arm that separates them: the same
three candidates permuted by question id (`shuffleByCase`, FNV-1a over `id#slot`,
then Fisher–Yates), one lever from `select-cross`, zero extra calls. The record
that makes the reading possible is the existing `candidates` array — on a shuffled
arm entry `i` is the statement offered in slot `i`, so author crossed with index
answers the question after the run instead of before it. `pnpm bench:bird:position`
does the crossing, and it reports intervals rather than percentages (see *Slot
stratum*).

**Slot stratum** — The set of cases in which the tracked candidate occupied one
particular index of the selector's list. A shuffled run produces two or three of
them, four hundred to a thousand cases each, and the point of stratifying is that
the *same* candidate's conversion rate can then be read at each position. The
reading is not a percentage: each stratum carries a Wilson interval and the two
extreme strata carry a Newcombe interval for their difference, and the verdict is
one of `separated` (the interval excludes zero), `overlapping` (this run does not
separate the slot from the author), or `single-slot` (the artifact cannot answer
the question, because an arm that never moves the statement gives one number for
both readings). The third case is why the comparison is a union type with no
`spreadPp` field rather than a struct of optionals: a `spreadPp: 0` would let "no
comparison was made" wear the clothes of "a zero was measured".

**Wilson interval** — The score interval for a binomial proportion, used instead
of `p ± 1.96·√(p(1−p)/n)` wherever a rate in this repository is quoted per stratum.
The reason is specific rather than stylistic: the strata are exactly where the
textbook (Wald) interval fails. A slot whose candidate was taken on all of its
cases, or on none, has an estimated variance of zero, so Wald reports a zero-width
interval and turns a small sample into a certainty. Wilson keeps a width there.
`Newcombe` is the matching construction for the *difference* of two proportions,
built from the two Wilson intervals rather than from the two point estimates.

**Candidate failure** — A candidate that never reached the selector's shortlist, counted by
mechanism instead of merged: `llm` (the endpoint did not answer), `engine` (the statement
was written and the database refused to run it), `unparsed` (the reply carried no usable
statement). Each arm also reports `candidateSurvival` per source, because *how many* were
lost and *whose* were lost are different findings — a second endpoint that refused its
candidate is a vendor problem, a prompt of ours that never parsed is ours. Only `llm` fails
a run: it measures the key. The other two measure the model, and an arm whose whole set was
refused is a 0% reading that the artifact has to be able to carry.

**Canonical candidate text** — The one form a statement takes before a selector
reads it: keyword and function names upper case, identifiers lower case, one space
between tokens, comments gone, `!=` written `<>`, a trailing semicolon dropped
(`eval/bird/canonical.ts`). It exists to close the only channel a judge can use to
recognise an author, and it is a *display* transformation: the winner is taken by
index from the untouched set, so what executes is still the statement the model
wrote. It is not a normal form for SQL — aliases are not renamed and literals are
copied byte for byte, because both would change answers.

**Load-bearing separator** — A space that is part of the statement rather than of
its layout, and that a canonicaliser therefore copies instead of normalising:
`x'41'` is a blob literal and `x '41'` is a name beside a string, `?1`/`:name`/
`@name`/`$name` are one bound parameter. It is the reason whitespace normalisation
is enumerated per token pair (`glued`) rather than applied everywhere.

**Visual baseline** — A committed fingerprint per series type: the element
skeleton and the count of drawn shapes, not the coordinates. It fails when a chart
stops drawing or changes shape and stays quiet when a label moves, because a
baseline that fails on float noise is one people regenerate without reading.

**Trace** — The ordered events of one query, sealed by hashing each event with the
previous one's hash. Replay re-derives the timeline without reading a clock, so a
trace that verifies is quotable and a trace that was edited says where.

**Semantic tool** — An MCP tool that takes a semantic model and a metric query
instead of SQL. It exists because `run_sql` moves the definition of a metric into
the caller's head, which is exactly where it gets forgotten.

**Mark contract** — What a chart type needs before it can be drawn: which
encoding channels it reads, how many numbers one row supplies, and whether it
needs geometry or a render function that a result set cannot contain.
`describeMark()` answers; `compileToECharts()` refuses rather than guesses.

**Connector** — The set of promises the library makes about an engine before a
query reaches it: quoting, row cap, whether `ATTACH` is available, and read-only.
Distinct from a driver, which needs a server; the promises are testable without
one.

**Portability census** — The share of a dataset's statements that also run on a
second engine, with the failure taxonomy. Not an accuracy number: it answers
"will this SQL run on my engine", which is the first question a deployment asks.

**Reference driver** — The engine implementation the benchmark's own judge uses
(Python `sqlite3` for BIRD). Benchmarks execute through it so the judge compares
tuples, including duplicate column names and duplicate rows.
