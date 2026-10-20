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
