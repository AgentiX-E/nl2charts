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

**Decoration tolerance** — What a reader accepts around a label without changing what it
infers from the reply. `**2**`, `2.`, `Option 2` and `Choice: 2.` all read as the second
candidate; `The answer is 2 because…` still reads as no answer at all. The tolerance exists
because a model nobody benchmarked decorates a label it was told to write, and requiring the
literal characters would have made "the reply could not be read" and "the reply was wrong"
the same number in a score.

**Format profile** — The four dimensions of a reply's *shape* — fenced, a bare choice, step
lines, named omissions — aggregated over a sample into `always` / `sometimes` / `never` per
dimension. Read by `replyShape`/`formatProfile` and carried per arm as `format` in every
artifact. It is the only instrument here that reads a reply before any result exists, so it
is the only one that can predict a collapse on an uncalibrated model instead of reporting it
as a lower score. Three replies are needed before any verdict, and a dimension must hold in
nine of ten to be called `always`.

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

**Reading ledger** — `eval/baseline/readings.json`: the discordant counts of every
declared arm pair in every run, and nothing else. The tables in
[benchmarks.md](benchmarks.md) are generated from it, so a cell and the pooled line under
it cannot disagree; a hand-typed number would be a second source of truth, which is what
drifted four times before the ledger existed. Every run also names the split it was read
on, and a table whose runs disagree about that is refused: a pool is only ever within one
population.

**Ladder** — The label a pair carries at every prefix of a view's readings, printed under the
generated table. It exists so that "the label settles and stays" is a derived fact rather than a
hand-typed table: the gate fails if any label leaves and returns. A pair's evidence accumulates,
so its label should move in one direction as readings arrive.

**Random effects (DerSimonian–Laird)** — The pool used when the readings of one pair
disagree by more than their own sampling error. The estimate is unchanged; τ² is the
between-reading variance estimated from the excess of Cochran's Q over its degrees of
freedom, and it widens the interval to include the disagreement. τ² is exactly zero unless
the heterogeneity test rejects, so the interval is widened exactly when the label says the
readings are not one number — `heterogeneous` or `sign-flip`.

**Verdict (pair)** — What a pooled pair's readings support, printed with the split it was
measured on because the same pair can read `established` on 496 questions and `none` on
1,532. `none`: the pool includes zero and no single reading cleared its own test.
`one-run-only`: a direction resting on one reading, or on a reading the pool did not keep.
`sign-flip`: readings that cleared their own tests in opposite directions — a reversal, not
a mere disagreement in sign. `heterogeneous`: the readings disagree about the size. Both of
the last two widen the interval. `established`: the pool clears zero and no reading cleared
its own test the other way.

**Refusal** — A 4xx the endpoint will repeat: a model name it does not serve, a key it
rejects, a field it will not accept. `NL2C_E_LLM_REJECTED`, as opposed to
`NL2C_E_LLM_UNAVAILABLE` for the failures worth retrying (network, 408, 429, 5xx). The two
were one code until a reasoning model's `temperature: 0` came back as 400 and read as "the
endpoint is unreachable". Carries the endpoint's own sentence in `details.detail`.

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

**Turn temperature** — The sampling temperature one call is sent at, resolved once by
`turnTemperature`. `undefined` sends zero — the value every published reading was taken at —
and `null` sends no field at all, for an endpoint that refuses to be told. The distinction is
the whole function: `??` anywhere on that path collapses `null` into zero and the endpoint
that refused the field goes on refusing it.

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

**Base fingerprint** — A digest over the answers a base model gives to a fixed
probe set, asked twice at temperature zero. Its job is not to name the model but
to notice that the same name is now being served by different weights, which
neither `model` (what was asked for) nor `servedModels` (the name the endpoint
answered with) can see. Two draws are what separate a fingerprint from a sample:
if they disagree the endpoint is sampling an identical request, and the reading
says `stable: false` instead of pretending to be a fingerprint. Recorded per run
as `baseFingerprint`, pinned per split in `eval/baseline/bird.json`, checked by
`gate:bird`.

**Probe set** — The handful of fixed questions a base fingerprint is taken over,
and the digest of those questions themselves. It is hashed because editing a
question changes the model's digest for a reason that is not the model: a pin
taken over other questions is not a pin, so a run whose probe set moved fails the
gate and the pin has to move in the same commit.

**Coordinate (of an experiment)** — A fact that must be equal for a difference
between two runs to be about the thing they changed: split, corpus digest, model
asked for, model served, base fingerprint, harness settings, second model.
`bench:bird:compare` prints one line per coordinate and refuses to call two runs
the same experiment while any of them differs *or is not recorded* — the two are
different sentences, because "it changed" is a fact and "nobody looked" is not.

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

**Pre-registered margin** — The difference a caller says counts, stated before the
reading. It is not the same number as the Resolution and must not be finer than it:
a margin of 2.30pp applied to a 600-question sample resolves nothing at that width,
so the verdict names the binding number instead of taking the smaller one. The
margin is chosen; the resolution is measured.

**Dissenting candidate** — The one slot whose result differs from the others on a
question. A pool of draws from one prompt produces dissent that is nearly free of
information (the statements differ by wording), while a pool with a different model
in one slot produces dissent that is worth a ceiling: on `select-cross` the correct
answer was a lone dissenter on 20 of the 22 questions the second model added. A
three-way vote cannot take those questions, which is why conversion — not ceiling —
is the factor that decides a cross-model pool.

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

**Result-set key** — The canonical form of a result set: its column width plus the
order-free, duplicate-free set of its rows, so that two results share a key exactly
when the benchmark's judge calls them a match. `modal` counts keys, which means
agreement is a property of what the statements returned rather than of how they
were written — two different statements that produced one table are one opinion.
`resultKey` in the devkit is the authority; the library carries a mirror because a
production package may not depend on the devkit, and a test holds the mirror to
the authority over every value type a SQLite result can carry.

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
independent of who wrote it. It was a confound before it was a finding:
`CROSS_SOURCES` always puts the second model's candidate first, so authorship and
position were perfectly correlated in every cross experiment and "it prefers its
own writing" and "it prefers candidate 1" predicted exactly the same number.
`select-cross-shuffled` separated them — the same three candidates permuted by
question id (`shuffleByCase`, FNV-1a over `id#slot`, then Fisher–Yates), one lever
from `select-cross`, zero extra calls — and run `40865112253` answered it: on the
1,129 cases carrying all three candidates, every source's selection rate collapses
with its slot (79.8% → 33.8% → 5.1% for `metadata+evidence`) while **each source's
own correctness does not move at all**. The judge reads the slot, not the author.

What it does *not* do is change the score. The same run's paired comparison is
−0.65pp at p = 0.19, because the candidates are redundant: only 3.7–4.6% of cases
have exactly one correct statement. Position is a lever on the selector and not on
accuracy, and the number that says so in advance is the *only-correct share*.

**Only-correct share** — The fraction of cases where exactly one candidate is
right. It is the ceiling on what any selector-side lever can win: if three quarters
of the questions have more than one correct statement, then choosing differently
changes almost nothing. Worth computing before proposing a change to candidate
order, prompt layout, or the judge, because it bounds the prize. In run
`40865112253` it was 3.7–4.6% per source, against 63.9–70.5% for "at least one
candidate correct" — which is why a 25pp shift in selection produced a 0.65pp shift
in accuracy.

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

**Strategy** — One of five fixed ways to run a question, priced in calls: `single-lean` (one call,
card without notes), `single-full` (one call, card with notes; the default), `repeat-3` (three
samples, decided by their result sets), `aimed-3` (three candidates from three angles, and the free
rule `shortest` chooses), `aimed-4` (the same three candidates, and the model chooses). A strategy
is a value, so it can be printed, pinned, diffed and rolled back. `aimed-3` and `aimed-4` differ by
one thing — who chooses — which is why they are the pair a selector reading is taken on.

**Free selector** — A rule that picks among candidates using only what the arm already computed:
`shortest` (fewest characters of SQL), `first` (the slot the prompt offered first), `modal` (the
result set most candidates agree on). It costs no call and cannot fail, since there is no reply to
parse. All three rank only the candidates that returned rows, and fall back to the whole set when
every candidate returned nothing — which is why a question whose answer really is empty still gets
an answer. The counterpart is the **paid selector**: a fourth call that shows the candidates to the
model and asks for an index.

**Cold start** — The cost of choosing a strategy from the first few questions a deployment sees
rather than from a benchmark. Measured as *regret*: what the best strategy would have earned on the
questions the calibration never saw, minus what the chosen one earned on them.

**Oracle, in a strategy comparison** — The accuracy of a router that picks the right strategy per
question. It is a ceiling, not a target: no single strategy can reach it, which is why the gap
between the oracle and the best fixed strategy is the size of the prize for routing rather than for
calibration.

**Leave-one-database-out** — A holdout that removes a whole database rather than a random slice of
questions. A random fold lets a rule recognise the corpus it was fitted on; leaving the database out
asks the question a deployment actually asks, which is whether a rule transfers to a schema it has
never seen.

**Router** — A rule that picks a strategy per question instead of once per deployment. In this engine
a router is only worth building if it picks **within one call**, because choosing a four-call
strategy is a purchase rather than a routing decision — and the measurement that would justify one
(`bench:bird:route`) says the disagreements it would have to read are a coin flip.

**Candidate pool** — Every statement an arm kept for one question, before the selector chose among
them. Its size and variety are the only things that can raise an arm's ceiling; the selector can
only decide how much of that ceiling is collected.

**Ceiling (of a pool)** — The share of questions on which at least one statement in the pool is
correct. An arm cannot score above its own ceiling, so the number is a bound rather than a result,
and `bench:bird:pool` prints it beside the score so the two are never read as one.

**Selection loss** — Ceiling minus score: the questions the pool answered and the selector did not
collect. On the dev split it is 4.69pp for three draws of one prompt and 1.50pp for three different
prompts, which is why the loss is read as a property of the pool's *variety* rather than of the
selector's prompt.

**Marginal candidate** — What one more generation call buys, measured as the questions it covers
that nothing already bought covers. A pool earns its call only if that number clears the split's
minimum detectable effect; on the dev split the best second pool buys 1.31pp against a 2.30pp line.

**Result fingerprint** — A sixteen-hex-character digest of `resultKey`, the canonical key of a
result set. Two candidates share a fingerprint exactly when the official judge calls their results a
match, because `judgeOfficial` compares two keys rather than re-deriving equality: a digest over a
second definition would make "the candidates agreed" a claim about the fingerprint's rule instead of
about the benchmark's.

**Selection rule** — A rule that picks one candidate out of the set the arm kept, priced without
running anything. `first` takes the earliest slot, `shortest` the fewest characters of SQL, `modal`
the result set the most candidates agree on; `model` is whatever the arm returned (the only one
that spends a call) and `oracle` any correct candidate, which is the ceiling rather than a rule.
`chooseCandidateByRule` runs the first three in a pipeline, `bench:bird:consensus` scores all five
from one artifact, and a test holds the two implementations to the same slot on the same rows.
All three free rules rank only the candidates that returned rows — see **Empty result**.

**Empty result** — A candidate whose statement ran and returned no rows. It is the only member of
a candidate set that can be ruled out without reading anything, because a result set with no rows
is equal to another empty result and to nothing else: for an empty candidate to be the answer, the
true answer would have to be empty, and no question in the dev artifacts has an empty answer.
**586 empty results across four arms and not one of them was right.** Excluding them lifts
`shortest` from 963 to 975 cases on 1,532 questions (63.64% against the selector's 62.79%) and from
384 to 391 on the 600-question strong artifact (65.17% against 62.00%, p = 0.0163) — the first
call-free rule that beats a paid selector by more than the split resolves. A candidate set where
every member is empty falls back to the whole set, so a question whose answer really is empty still
gets one. Do not confuse it with a **blank statement**, which is a text fact and is ranked last
rather than removed: nothing written and nothing returned are two different refusals.

**Value gap** — A literal a statement compares against a column, together with what that column
actually holds: the same value in another case (`case`), a longer value containing it (`partial`), or
nothing (`absent`). It is the repair target of the zero-row state, and the reason that state is worth
a call: **18 of the 19 dev questions whose whole candidate set returned nothing wrote a value the
database does not contain**, so the failure is a lookup and the fix is a lookup. Reading a gap costs
one query per literal and column and no model call — `probeValueGaps` is the reader. `partial` is
what the message to the model says, and it is deliberately wider than what an edit may act on: a
column that holds `Benalish Knight (Fellwar Stone)` is a useful thing to show a model and a dangerous
thing to substitute without one.

**Literal gap** — The same question asked for the budget rather than for a retry, and answered in
four kinds an edit can or cannot reach: `case`, `padding` (`40` against `0040`), `parenthetical`
(`High Schools` against `High Schools (Public)`), and `absent`. The difference from a **value gap**
is not the data but the licence: a `literal gap` may only name a replacement when the column holds
exactly one candidate, because its output is an edit rather than a hint. `bench:bird:literals`
produces it, and the reading it produced on the dev split is the reason the two are kept apart — of
seventy-six `filter-narrow` cases, sixteen carry a site an edit can explain, fourteen of those have
nothing but such sites, and **seven** are repaired. The other sixty-nine filter a column that has
never held the value, which is a schema-linking failure and not a spelling one.

**Grounded literal** — A literal whose case-only mismatch was settled by the lookup rather than by
the model: the column stores exactly one spelling that matches ignoring case, so the statement is
rewritten with that spelling and adopted if it returns rows. **No call is spent.** Two spellings, or
a second table that stores the literal as written, leave the substitution to the model, because a
guess dressed as a lookup is still a guess.

**Stored-value block** — The bracket a column carries on the schema card when an arm asks for one:
`name TEXT [pen|cup]`, the profiler's most frequent spellings for `samples: 'profile'`, or MAC-SQL's
six-value rule for `samples: 'example'`. It is the *unconditional* half of value grounding — the
`values` block is built from the literals the question names, this one is in front of the model
whether or not the question named anything — and it is the lever the `samples` family prices. On
Mini-Dev its cost is **+38.4% of the card** over every profiled column and **+1.4%** narrowed to the
columns the gold statement filters on, and it reaches 451 of 500 cases wide against 185 narrow. It
buys **+1.24pp** wide and **+0.72pp** narrow on the dev split, which is why the family closed and the
block is not a default.

**Unanimity** — The questions on which every candidate returned the same result, and therefore the
share of the corpus no selection rule can move: if the set agrees and is wrong, choosing cannot
help. It is the boundary between selection workmanship and generation work, and the column is
printed as *unmeasured* rather than zero on artifacts written before fingerprints existed.

**Agreement mark** — The one-based number of the earliest candidate that returned exactly the same
rows, attached to every later member of that group and to no other candidate. The relation is
`resultKey` equality, the judge's own, so a mark means the judge would call the two results a match.
Marks only point backwards, which makes them a partition: each group has one unmarked member and the
number of distinct results is the number of unmarked candidates plus those pointed at. The selector
is shown a mark as `same result as candidate 1` and is told, in one rule, that agreement is evidence
and not proof — the sentence the 2+1 pool turns on.

**Model capability** — What an endpoint does with a request, as a value: the family (`chat` or
`reasoning`), whether the sampling parameters are honoured, whether JSON mode is served, the cap on
the final answer in tokens, and whether the prompt may ask for reasoning before the answer. Derived
from the model name where the family is documented, and declarable through
`BIRD_SECOND_CAPABILITIES` (or the provider's own `capabilities` option) where it is not. A
capability is a protocol fact, never a quality claim: it says `deepseek-reasoner` discards
`temperature`, not that it answers better.

**Sampling omitted** — The parameters a request carried that the endpoint did not honour, counted
per call by the meter and per arm in the artifact (`samplingOmitted`). It exists because a
reasoning endpoint accepts `temperature` for compatibility and ignores it: the request succeeds, the
report prints "temperature 0", and nothing ran at zero. The count is the difference between a
sampling regime the pipeline chose and one it merely asked for.

**Judge format** — The instruction a selector is given, which is part of the judge rather than of
the caller. A chat judge is asked for the number and nothing else; a reasoning judge is asked to
think and to put the number alone on the final line, and its reply is read from that line only. The
two formats are selected by the endpoint's declared capability on an arm that opts in
(`judgeFormat: 'capability'`), so every published selector reading keeps the instruction it was
measured with and the format can be priced against the model it belongs to.

**Query intent** — A query written as data instead of as text: the tables, the join column pairs, the
filters as `(column, op, value)` triples, the grain, the order. `renderIntent`
(`@agentix-e/nl2charts-core/semantic`) turns one into a statement, which is the point — a join
predicate cannot land in the wrong clause, a literal cannot be left unquoted, a function the engine
does not have cannot be invented. The contract is closed: ten optional keys, one function set, and
every construct outside them is refused rather than approximated. Distinct from a `MetricQuery`,
which names metrics and dimensions of a registered semantic model; an intent names tables and columns
of a schema it was shown, which is the case where no model exists.

**Intent refusal** — The name a renderer gives a reply it would not turn into SQL, in place of an
exception: `no-object`, `not-json`, `unsupported-function`, `bad-identifier`, `unknown-identifier`,
`missing-from` and eleven more. The names split into two families that call for opposite fixes — a
reader failure means the format instruction was not followed, a grammar failure means the vocabulary
was too narrow — and the histogram of them over a split is the ordered list of what to add to the
grammar next. A name is a family rather than a construct, so the harness keeps the first few refusals
of each name with the compiler's sentence and the case they came from; that is what turns "five
`bad-expression`" into "the grammar has no `case`". A refusal is a reading, not a defect: only the
case where *nothing* renders is a wiring bug, which is the one state the harness refuses to publish.

**Identifier quoting** — How `renderIntent` writes a name: unchanged when it is a bare word, double
quoted with internal quotes doubled when it is not. The second form is not a nicety — a schema spells
columns `County Name` and `Charter School (Y/N)`, and 4.6% of the columns in BIRD's databases cannot
be written otherwise. Quoting is also why the renderer wants the schema: SQLite reads a double-quoted
name that matches no column as a *string literal*, so a misspelling compares a column to a constant
and returns a clean wrong answer. With `columns` passed, `compileIntent` refuses it as
`unknown-identifier` instead.

**Circuit breaker** — The failure-share verdict taken while a run is still spending calls. The guards
that read a finished table are correct and late: `glm-4.6` spent 496 calls to build a table whose
first sixty rows already said the endpoint was refusing four calls in five. `outageDecided(failures,
total)` seals the same verdict earlier — failures only accumulate, so once the count exceeds a tenth of
the *split* the finished table cannot come back under the threshold — and the pool it feeds stops
starting cases instead of throwing from a worker, because a thrown worker leaves the other pool slots
running and their rejections unhandled. The rule cannot refuse a run the table guard would have
accepted, which is the only property an early verdict has to keep.

**Probe wave** — How a preflight sends its calls: `BIRD_CONCURRENCY` at a time, the run's own number.
A rate limit is a function of simultaneous requests, so twelve calls one after another measure an
endpoint under a load the run never applies. `glm-4.6` passed twelve serial probes (median 7.1 s, none
refused) and then answered 429 to 416 of 496 calls at concurrency 8; the probes saw no failures because
at one call at a time there were none to see.

**Run budget** — The clock a run keeps on itself, per arm: `BIRD_RUN_BUDGET_MS`. A GitHub job cap
cannot report, and `42666720439` proved it — five hours on one arm, killed at `cancelled`, an artifact
of 2,083 bytes. The budget fires first and its message is the deliverable: cases finished, seconds a
case, the projection for the full split, and the `BIRD_LIMIT` that would have fitted. It throws rather
than publishing a partial table, because 137 of 496 cases is a different population and the same reason
stops the gate accepting one.

**Paired subset** — A smaller run read against a larger anchor on the questions both answered. The
sample is cut because a reasoning model costs 18 seconds a case and 496 of them is two and a half
hours; the cut does not cost the comparison, because the anchor already holds a verdict for every
question in the split. `crossPair` restricts both rates to the shared ids and tests the flips with
McNemar, so the questions' own difficulty cancels: at 150 questions near 0.58 with 20 flips the
interval is ±5.8pp, against ±11.2pp for the same two rates read side by side. Two artifacts' own
totals must never be compared directly — that was a difference between two populations.

**Capability declaration** — What an endpoint does with a request, stated rather than guessed:
`BIRD_CAPABILITIES` for the primary endpoint, `BIRD_SECOND_CAPABILITIES` for the second. The guess
from the model name matches only documented families (`reasoner`, `thinking`, `r1`, `qwq`, `magistral`,
`o1`-`o9`) because a wrong guess towards `chat` sends a parameter the endpoint ignores while a wrong
guess towards `reasoning` removes one it would have honoured. `glm-4.6` falls outside the pattern and
was therefore sent a chat request — temperature, a 4,096-token answer budget, no thinking switch — to
a model that deliberates; it answered in 8.5 seconds with nothing in it on fourteen of twenty-eight
cases. The artifact records the resolved row as `modelCapabilities`, so a difference between two runs
can be attributed to the request rather than to the model.

**Failure shape** — The tally the outage verdict prints beside its first message: `HTTP 400 × 13,
timeout × 2`. A verdict built from one message out of sixteen named the wrong fault on `42723786747` —
it said every failure was a timeout when two of twenty-eight cases had taken the full deadline. The
hint is chosen from the tally, so a 4xx sends the reader to the model name and the capability
declaration, a 429 to the concurrency, and only an all-timeout run to `BIRD_LLM_TIMEOUT_MS`.

**Serving deployment** — The name the endpoint puts in a response's `model` field, which is *not* the
alias that was requested. Both `deepseek-chat` and `deepseek-reasoner` came back as `deepseek-flash`
from this account, so a reader holding the artifact has the request (a declaration the harness owns)
and the serving name (a field the provider owns) and no way to derive which model answered.
`gate:bird` prints the mismatch rather than smoothing it — `the run asked for deepseek-reasoner and the
endpoint named deepseek-flash — only the second field answered` — and the only in-file evidence that
the alias changed anything is indirect: completion tokens per case went 55 → 594 across the two runs.
`modelCapabilities` records the half the harness owns; this field is the half it cannot, and both are
in the artifact so neither is mistaken for the other.
