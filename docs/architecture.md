# Architecture

## Layers

```
T0  contract     spec
T1  runtime      core      ai        node      chart
T2  access       mcp       studio
T3  development  devkit
```

`spec` holds types and schemas and depends on nothing. `core` holds execution
and depends only on `spec`. `ai` holds the model layer and depends on `core`.
`node` holds native bindings and depends on `core`. `chart` is a pure function
library over `spec`. `mcp` and `studio` are entry points. `devkit` is the only
package that may be used exclusively by tests.

## Dependency rules (enforced)

```
spec ─┬─ core ─┬─ ai ─── mcp
      │        ├─ node
      │        └─ devkit
      └─ chart
studio ──HTTP──► host
```

Forbidden, and checked in CI by `tools/check-layering.mjs`:

| Edge | Why |
| --- | --- |
| `core → node` | would force a native binary on every browser user |
| `core → ai` | would force an LLM SDK on every SQL-only user |
| `core → chart` | would force ECharts on every SQL-only user |
| `chart → core` | the chart path must work without a database |
| `spec → anything` | the contract must be the bottom of the graph |
| production → `devkit` | test utilities must not ship |
| `studio → core` | the admin UI must talk over HTTP, not import a runtime |

## The browser/Node split

`core` is the only package with a dual runtime, and it achieves that with
subpaths and a zero-IO root entry:

```
@agentix-e/nl2charts-core                  pure logic: guard, normalize, runner contract
@agentix-e/nl2charts-core/guard            the lexical guard
@agentix-e/nl2charts-core/normalize        canonical values and row hashing
@agentix-e/nl2charts-core/negotiate        local / remote / reject routing
@agentix-e/nl2charts-core/semantic         four-stage metric compiler

@agentix-e/nl2charts-node                  Node bindings
@agentix-e/nl2charts-node/duckdb           native DuckDB
@agentix-e/nl2charts-node/cache            content-addressed file cache

@agentix-e/nl2charts-ai                    model layer
@agentix-e/nl2charts-ai/linking            schema linking
@agentix-e/nl2charts-ai/llm                provider factory
```

This is enforced by five checks, not by convention:

1. **PLT1** — the browser bundle of `core`'s root entry must not reference
   `node:` builtins.
2. **PLT2** — its import graph must not contain `pg`, `mysql2`, `better-sqlite3`
   or `@duckdb/*`.
3. **PLT3** — its published declarations must not import driver or `node:` types
   (a type leak makes consumers fail with TS2307 even though the runtime works).
4. **PLT7** — its graph must not contain `ai` or an LLM SDK.
5. **PLT4/PLT5/PLT6** — dependency direction, no orchestration in the binding
   package, and cross-copy identity through `Symbol.for`.

PLT1/PLT2/PLT7 are decided from an esbuild **metafile**, not by searching the
output text: a tree-shaken import never reaches the output, so string matching
would silently pass a broken package. The checker is itself mutation-tested —
seven deliberate violations must each turn the corresponding check red.

## Semantic compilation

```
MetricQuery
   │ Plan       resolve names, joins, grain; refuse ambiguity
   ▼
DataflowPlan   read / aggregate / join / compute / window / project / sort / limit
   │ Optimize   deduplicate reads, collapse projections, merge limits
   ▼
DataflowPlan'
   │ Lower      one CTE per node
   ▼
SqlPlan
   │ Render     quoted SQL
   ▼
SQL
```

Two invariants are enforced by construction rather than by review:

1. **Grain first.** A measure is aggregated at its declared grain before any
   dimension table is joined, so a one-to-many join cannot inflate it. The
   benchmark reproduces a 3.00x inflation for a hand-written join and 0x for the
   compiler.
2. **Filters cannot be swallowed.** A query filter on a dimension table turns the
   dimension join into an inner join, and a filter on a table the query never
   reads is a compile error (`UNUSED_FILTER`).

The optimizer is measured, not asserted: 200 generated queries are executed with
and without it, and every pair must produce identical result sets. It currently
removes 34.1% of the CTEs on that set.

## Request flow

```
question
   │
   ├─ linkSchema(question, schema)            3 recallers, RRF fusion
   ├─ buildSqlPrompt                           rules + schema card
   │                                            + structural semantics
   │                                            + evidence hint
   ├─ provider.complete()                      OpenAI-compatible, pluggable
   ├─ extractSql()                             fenced or plain
   ├─ inspectSql()                             lexical guard
   │     └─ rejected → repair prompt → retry (bounded)
   ├─ execute()                                optional: the caller's engine
   │     └─ rows == 0 → empty-result turn → one retry (separate budget)
   └─ runner.sql(sql)
         ├─ inspectSql()                       again: the guard is not optional
         ├─ withRowLimit()                     cap + 1 for truncation detection
         ├─ engine.run()                       native or WASM
         ├─ canonicalRow()                     cross-runtime equality
         └─ onSpan()                           observability, failure isolated
```

The guard runs twice on purpose. The pipeline's check explains a rejection to
the model; the runner's check is the one that protects the engine, including SQL
that came from somewhere else.

## Engines

Two engines ship, both in `@agentix-e/nl2charts-node`:

| Engine | Backing | Notes |
| --- | --- | --- |
| `duckdb-native` | `@duckdb/node-api` | the default; columnar, reads Parquet/CSV, and can attach SQLite through its extension |
| `sqlite` | `node:sqlite` (lazy import) | single file, opened read-only by default |

Everything above them sees `Engine` (`id`, `dialect`, `run`, `close`). The
semantic compiler renders dialect-neutral SQL and a per-dialect renderer is a
plan visitor, not a second compiler.

The SQLite adapter documents a runtime limitation instead of hiding it: until
`node:sqlite` exposes `setReturnArrays()`, duplicate output column names collapse
and an empty result cannot report its columns. That is why the external benchmark
executes statements through the reference driver (Python's `sqlite3`) rather than
through this adapter — the judge must compare tuples, and a judge that silently
loses a column would be measuring its own bug.

## Evaluation

Three harnesses, each with a control that must fail if the harness is wrong:

| Harness | Data | Control |
| --- | --- | --- |
| `pnpm bench` | 20 fixtures, template baseline | oracle 100%, empty 0% |
| `pnpm bench:live` | 210 generated questions, live model | gold pre-execution, 3 repeats, self-flip count |
| `pnpm bench:bird` | BIRD Mini-Dev subset, live model | gold pre-execution, self-consistency, negative control |

`bench:bird` adds two properties the others do not have:

1. **Gold runnability is a metric.** A gold statement that does not execute is
   reported and excluded, never scored as a model failure.
2. **Two judges.** The official BIRD rule is `set(predicted) == set(gold)` over
   tuples (`evaluation/evaluation_ex.py`), which collapses duplicate rows. A
   strict multiset judge runs beside it, and the difference is published as
   "duplicate credit" rather than argued about.

A third artifact, `eval/out/duckdb-portability.json`, executes the same gold
statements on DuckDB and reports what survives. It is a census, not a gate.

`bench:bird:stability` measures the noise floor: 60 cases asked three times, and
the share that disagree with themselves (8.3% on the current slice). Without that
number a 2pp delta is a story, not a measurement — which is why the schema linker
and the repair loop are reported as "no measurable effect" rather than as wins.

### The harnesses are measured too

Everything in `eval/` was, until recently, outside the coverage scope, so the code that
produces every number above could lose coverage with nothing noticing: measured directly it
was 49.5% of lines. `pnpm gate:eval-coverage` measures it with its own config and compares
every file against `eval/coverage-ledger.json`. The rule is direction rather than a
threshold: a file may not measure lower than the ledger says, a file that stops being
measured is a failure, and a file measured without an entry is a failure. The command also
prints how far each dimension is from 95%, so the remaining work is a number on every push
rather than a sentence in a plan.

Each harness is a function returning a report plus a `main` that prints and returns an exit
code. That is what makes the controls testable: `runPreflight` is driven against a local
endpoint that answers, refuses, and answers too slowly; `runHarness` and both ablations run
against the real DuckDB fixtures; `profileDatabase` runs against a real SQLite file.

The BIRD runner (`eval/bird/run.ts`) needed one more step, because its parts are not
independent scripts. It is now a pipeline of values rather than one `main()`:

| Function | What it owns |
| --- | --- |
| `resolveLayout(env, root)` | every path a run reads or writes, as a value instead of a module constant read at import time |
| `resolveSettings(env, argv, root)` | the arm chain, the sample size, the harness knobs, the second model — a pure function of its arguments |
| `prepareRun(settings, io)` | dataset, schemas, blocks, schema fidelity, gold execution, and the controls, all before an arm runs |
| `runArm(prepared, name, io)` | one arm over every case, its guards, its artifact row and its printed line |
| `pairedComparisons` / `caseRows` / `failureSection` | the paired tests and the per-case rows a stratum needs |
| `evaluateGate(report)` | the thresholds, returned as a list of problems rather than set as an exit code |
| `runBird(settings)` | the whole run, from prepare to a written artifact |
| `main(env, argv, root)` | nine lines: resolve, run, gate, exit code |

`test/bird-run-e2e.test.ts` then drives `main` itself: a BIRD-shaped dataset in a temporary
directory (questions, table file, description CSV, a real SQLite file), a loopback
`http.Server` speaking the OpenAI chat shape, and the real Python oracle. The endpoint decides
each answer from the prompt, so one server plays a correct model, a wrong one, one that returns
no rows, one that is refused, and one that is too slow — and the same `main()` the workflow
calls produces an artifact each time. That is the difference between a guard that is written
and a guard that is known to fire.

One measurement changed meaning in the process, which is worth recording: the file's *branch*
ratio was 90.8% before this round and 90.9% after, while the number of branch sites v8 counted
went from 196 to 685. An unexecuted body reports fewer sites, so the earlier ratio was taken
over the part of the file that happened to run (ADR-216).

## Value model

Rows are `Record<string, CanonicalValue>`. Before a row leaves the runtime:

- `bigint` becomes a number when safe, otherwise an exact string;
- DuckDB `DECIMAL` becomes an exact string with its scale;
- `DATE` becomes `YYYY-MM-DD`, timestamps become ISO strings, `TIME` becomes
  `HH:MM:SS.mmm`;
- `NaN` and infinities become tagged strings so JSON stays valid;
- byte arrays become hex; lists become arrays; structs become objects.

`hashRows` is FNV-1a over the canonical JSON with sorted keys, so column order
does not change identity but row order does.

## Error model

One class, closed code list, data payload:

| Code | Raised by |
| --- | --- |
| `NL2C_E_GUARD_REJECTED` | guard (runner and pipeline) |
| `NL2C_E_ENGINE_UNAVAILABLE` | closed engine |
| `NL2C_E_ENGINE_FAILED` | driver error |
| `NL2C_E_TIMEOUT` | runner timeout or caller abort |
| `NL2C_E_INVALID_IR` | contract parse |
| `NL2C_E_INVALID_INPUT` | bad arguments |
| `NL2C_E_LLM_UNAVAILABLE` | provider network/timeout/non-2xx |
| `NL2C_E_LLM_INVALID_RESPONSE` | provider body |
| `NL2C_E_CONTRACT_VIOLATION` | consumer misuse |
| `NL2C_E_NOT_SUPPORTED` | capability negotiation |

Identity is `Symbol.for('@agentix-e/nl2charts/error')`, so a duplicated install
still recognizes the error. `instanceof` is forbidden across package boundaries.

## Repository layout

```
packages/          8 packages, one responsibility each
  spec/ core/ ai/ node/ chart/ mcp/ studio/ devkit/
eval/              golden set, deterministic fixture, baseline, ablations
tools/             gates: layering, platform, exports, budgets, coverage, summary
test/              cross-package public-surface snapshot
.github/workflows/ ci.yml (quality + benchmark)
```

## Quality gates

| Gate | Failure means |
| --- | --- |
| `pnpm typecheck` | strict TypeScript violation |
| `pnpm test:coverage` | a test failed, or a global threshold is missed |
| `pnpm gate:coverage` | a **single package** is below 95% on any dimension |
| `pnpm gate:layering` | a forbidden dependency edge |
| `check-platform` | a runtime boundary was crossed |
| `check-platform --self-test` | the checker stopped detecting a known mutation |
| `pnpm gate:exports` | the public surface (including subpaths) drifted without review |
| `pnpm gate:budgets` | a package exceeded its gzip ceiling |
| `pnpm gate:eval-coverage` | an `eval/` file dropped below its recorded coverage |
| `pnpm bench` | a control broke (oracle ≠ 100% or empty ≠ 0%) |

## Design decisions worth knowing

- **No UI framework adapter.** The library exposes promises and async iterables;
  a React binding would triple the compatibility matrix for little value.
- **No OpenTelemetry dependency.** A span hook is enough; the host maps it.
- **Replay is a provider, not a mock.** CI exercises the real pipeline with
  recorded responses, so the code path is identical to production.
- **Benchmarks have controls.** A number without a positive and a negative
  control is not a measurement.
