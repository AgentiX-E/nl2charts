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
| `pairedComparisons` / `caseRows` / `failureSection` | the paired tests, the resolution each delta is read against, and the per-case rows a stratum needs |
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

The other three entries followed the same shape, and the same rule applied to them:

| Entry | Before | After (lines / functions / branches) |
| --- | --- | --- |
| `eval/bird/stability.ts` | 0% | 99.0 / 100 / 98.6 |
| `eval/live/run.ts` | 0% | 99.4 / 100 / 99.1 |
| `eval/adversarial/run.ts` | 0% | 98.7 / 100 / 96.9 |

The last two entries, driven the same way:

| Entry | Before | After (lines / functions / branches) |
| --- | --- | --- |
| `eval/bird/diagnose-corpus.ts` | 53.2 / 75.0 / 58.8 | 99.1 / 100 / 98.9 |
| `eval/bird/recall.ts` | 73.3 / 83.3 / 80.0 | 99.4 / 100 / 99.0 |

`eval/` as a whole is 99.3% of lines, 100% of functions and 97.2% of branches, and **all 28 of its
files** meet 95% on all four dimensions. Getting the last dimension there was not a matter of writing
more tests: every branch that was still uncovered lived inside a template literal or behind a guard
no fixture can produce, so the other side of it was *unreachable* rather than untested. Each one is
a function of its inputs now (`ablationLines`, `missLine`, `endsOf`, `equivalenceOf`, `fanoutRow`,
`semanticProblems`, `requireSemantic`, `resolvePreflightSettings`, `phrasing`, `uniqueById`), and
fallbacks that no input can reach were deleted instead of covered — a guard that cannot fire is not
a test target, it is a claim the reader has to verify. `bird/failure-shape.ts` had two (`?? 0` after
a statement already known non-empty, and after a counted row set); `bird/retrieval.ts` had two more
(`averageLength === 0 ? 1 :` and `idf.get(word) ?? 0`, which guard a state `retrieve` returns before
reaching); `bird/run.ts` had two (`arm.vote ?? 1` in the summary line and in the attempted-call
count, both behind a guard that already proved `vote` defined, now `ceilingColumn(vote, ceiling)`
taking a number). Every remaining short marker is named in the ledger on every push, which is the
only reason a number like this can be trusted later.

The last mile of `bird/run.ts` (93.1 → 96.5) came from the other direction: with the second
provider's quota back, the `@second` path stopped being describable and became executable.
`select-cross-judge` had never been scored end to end, `createProviders`'s fallback to the primary
URL had never run (every test that configured a second model also gave it a URL), and
`assertSecondModel` had four missing-setting combinations of which one had been read. The artifact's
`judgeModel` was written inline; it is `judgeModelName(arms, second)` now, where `null` means
"nobody judged but the primary model", not "no second model is configured".

Two readers now judge these numbers, and they answer different questions. The per-file ledger is a
*ratchet*: it fails a build when a file moves backwards from wherever the last commit left it, which
is the only thing that was enforceable when `eval/` stood at 49.5% of lines. A ratchet's floor is by
definition wherever it last was, so it can never say the group is good enough — that half is a
*floor*: `groupProblems` fails while any dimension of `eval/` is below 95%, and refuses to read a
group ratio whose denominator is zero, because a run that covered no line has not produced a
coverage figure (ADR-217). `--allow-regression` deliberately cannot record its way out of the floor:
a regression behind a reason is a fact about one commit, a dimension below the standard is a fact
about the harness.

Both of those files were also measuring the wrong thing, which is the part a coverage number
cannot show. `recall.ts` exists to answer one question — is every identifier the gold statement
needs visible in the prompt the model receives — and it was building that prompt itself:
`buildSqlPrompt` plus its own `Likely columns:` line. The pipeline puts that hint in the *user*
message and words it `No column matched; use the schema above.` when the linker finds nothing, so
for every question with no linked column the ceiling was measured on a prompt that is never sent,
and any change to `buildAskMessages` would have left the gate green about a prompt nobody sends.
It calls `buildAskMessages` now (ADR-218). `diagnose-corpus.ts` exists to say what kind of wrong
the failures are, and it dropped three kinds of ungradable failure with a bare `continue` before
dividing its shares by the survivors — a shape distribution over the cases that happened to run
(ADR-216 again, at a second site).

A second reading lesson came out of this round and it is the same lesson as ADR-216 from the
other side. v8 reports **100% of functions and 100% of branches for a module it never
executed**, because those ratios have a zero denominator and 0/0 prints as perfection. The
ledger had recorded exactly that for the two files above — `lines 0.0, branches 100.0` in one
row — so the first honest measurement of them looked like a regression, and the documented
escape (`--allow-regression`) would have written a sentence about a drop that never happened.
The ledger now records zero in every dimension for a file that executed nothing, and a recorded
row that cannot describe a measurement is replaced by the first one that can (ADR-217). A ratio
is only comparable when its denominator is reported with it; a ratio whose denominator is zero
is not a measurement at all.

ADR-218 adds the sibling rule for gates: **a gate must measure the bytes that are actually sent,
and must write its verdict before it acts on it.** `recall.ts` failed the first half — it
re-rendered the prompt instead of asking the pipeline — and both entries failed the second:
`recall.ts` threw before writing its artifact, so a failing run left the previous green
`recall-<split>.json` on disk for the next reader to trust, and `diagnose-corpus.ts` wrote
nothing at all. Every harness entry now writes an artifact carrying its own verdict
(`passed`, `problems`, the denominator, the drops) and only then turns that verdict into an exit
code. A measurement that cannot be read back is not a measurement; a green artifact left behind
by a red run is worse than no artifact.

## The format contract

Every reader in the natural-language layer assumes something about the *shape* of a reply
rather than its content: `extractSql` looks for a fenced block, `parseDecomposed` counts
`STEP <n>:` lines and takes the last block, `applySelection` wants a reply that reduces to a
single choice, `countNamedConditions` wants `MISSING:` lines. Those assumptions are the only
part of the pipeline that a different model can break without producing an error.

The failure is silent in a way that matters. A selector that answers "Option 2" has followed
the instruction as it read it; `parseSelection` returns `-1`; the caller falls back to the
first candidate and reports `decided: false`. The arm then scores lower for a reason that
looks like a worse statement. Nothing in the result says which of the two happened, and the
score is the only thing a reader sees.

So the shape is measured rather than assumed. `replyShape` reads four dimensions off one
reply — fenced or not, a bare choice or not, how many step lines, how many omissions named —
and costs nothing: it is a pass over text that was going to be parsed anyway.
`formatProfile` aggregates a sample of shapes into `always` / `sometimes` / `never` per
dimension, with a floor of three replies and a nine-in-ten threshold. The floor and the
threshold are the two places where the instrument could lie: with two replies "always" and
"sometimes" differ by one case, and a selector that answers three times in four looks
healthy in aggregate while a quarter of the cases are still decided by candidate order.

The reader side of the same contract is decoration tolerance. A label a model bolds, bullets,
numbers, or writes with a full-width colon is still the label the prompt asked for, so the
three strict readers accept it:

| Reader | Accepts | Still rejects |
| --- | --- | --- |
| `parseChoiceToken` | `2`, `**2**`, `2.`, `Option 2`, `choice #3`, `Answer - 4` | `The answer is 2 because…`, `SELECT … LIMIT 2` |
| step line | `STEP 1:` , `**STEP 1:**` , `1. STEP 1:` , `- STEP 1:` | a numbered line with no label |
| omission line | `MISSING: x`, `- **MISSING:** x`, `MISSING：x` | the word inside a fenced statement |

What stays strict is the shape of the whole reply: it must reduce to the label and nothing
else. That is the property the callers depend on — a model that ignored the instruction must
not be counted as a model that chose — and it is why the tolerance above widens what a reader
*accepts* without widening what it *infers*.

The window is small on the models this repository benchmarks, and that is the point: the
selector already answered in 495 of 496 cases, so the relaxation can move at most one case
and cannot be mistaken for a scoring change. On a model nobody has calibrated, the same
window is the difference between "the reply could not be read" and "the reply was wrong".

Every artifact now carries the profile per arm (`format`), and a report whose arm answered
cases without one is refused by `assertReportComplete`. An arm that failed every case
carries it too, through the error's `lastShape`: the case where the model wrote prose for all
496 questions is the case the profile exists for, and it is exactly the case that has no
successful result to read a shape from.

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
| `NL2C_E_LLM_UNAVAILABLE` | provider network/timeout/429/5xx/408 |
| `NL2C_E_LLM_REJECTED` | provider refused the request (4xx that is not 408/429) |
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
.github/workflows/ ci.yml (five jobs: changes, quality, benchmark, and the two
                   model-measuring jobs that the first gates)
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

### What a push has to measure

Two of `ci.yml`'s jobs spend model calls: the BIRD Mini-Dev job sends thirteen arms over
496 questions (~6,400 completions) and the live job sends three passes over 210 cases. The
first job in the workflow, `changes`, decides whether they run, using
`tools/ci-scope.mjs` — a file whose own name ends in `.md` cannot reach a prompt, so a push
that only edits Markdown does not buy a completion. A dispatched run always measures, and
two edges resolve towards measuring rather than towards saving: a change set the API could
not describe, and a list of 300 or more files (the commit endpoint's page size, which is
where a list may have been cut). The rule is unit-tested in `test/ci-scope.test.ts`,
including both edges, because a filter written as five lines of shell is a filter nobody
can test.

The rule is about file names, not about content, and one push showed the width of that
gap: `9ccf30d` changed a comment string in `eval/bird/run.ts` and therefore measured
thirteen arms, ~6,400 completions, for a sentence no prompt reads. That is the accepted
cost of the choice. The alternative — parsing each diff to decide whether a `.ts` change
is semantic — is a second rule with its own false negatives, and its failure mode is the
expensive one: a real change classified as prose, and a number that then gets quoted
without ever being produced. Between paying for a comment and quoting a measurement that
does not exist, the guard pays.

### Adaptation without a benchmark

A deployment that swaps the backbone loses the calibration and keeps the code. The layer that
handles this is `packages/ai/src/adapt.ts`, and its unit of change is a `Strategy` — one of four
fixed configurations, each a value a caller can print, pin, diff and roll back:

| strategy | calls | what it spends the calls on |
| --- | --- | --- |
| `single-lean` | 1 | the card without curated notes |
| `single-full` | 1 | the card with notes, which is the default |
| `repeat-3` | 3 | three samples, decided by their result sets |
| `aimed-3` | 4 | three candidates from three angles, plus a selector |

Three layers choose among them, cheapest first, and each one can stop the search:

1. `probeProtocol` reads the first contact. A 400 or a 422 is a statement about the *request* —
   usually a temperature field a reasoning model will not accept — and costs one retry with the
   field omitted. An answer is a statement about the model, and its shape is free evidence.
2. `admissible` drops `aimed-3` when the model's replies never parse as a choice: a selector
   spends a call asking for a label, and prose is not a label.
3. `chooseStrategy` (and its online form, `createObserver`) switches only when two Wilson
   intervals separate, after at least eight observations. The same interval the report uses, so
   the runtime decision and the published number cannot disagree about what "better" means.

Nothing here rewrites a prompt. The measurable surface a compiler could optimize is 7.1% of the
prompt and already parametrised; editing it at runtime would make every number in
[`benchmarks.md`](./benchmarks.md) unattributable and every deployment unreproducible.

The same instrument then asked the next question, which is per-question rather than per-deployment:
if a global switch cannot move, can a rule read *this* question and pick the better card? It cannot.
`bench:bird:route` fits one-feature, one-threshold rules — both orientations — over the arms that cost
the same call, and scores them leave-one-database-out: every pair finds a rule worth +0.07 to +0.72
points in sample, and every one of them loses 0.46 to 0.98 points on the database it was not fitted
on. The two evidence cards disagree **66 : 65** (sign test p = 1.0000), and 76.8% of the cases every
arm failed are wrong *values* rather than wrong structure. A router would have to read a coin flip;
the gap belongs to the values, not to the choice.

What the harness found is that layer ③ will not move at deployment scale, and the harness is what
says so: `bench:bird:adapt` replays an existing `bench:bird` artifact, calibrates on the first N
questions and scores the verdict on the rest. Regret is 1.1-1.6pp at every window below 200, the
effect it would have to detect is 1.21pp at a 9.4% discordance (5,040 questions), and the only
window that clears one point is three quarters of the split. The defaults follow from that
measurement rather than from taste.

The instrument that followed prices the other half of the same object. Every arm here sends one
request or several, and its score is the size of the candidate set it kept times the rate at which
the selector converted it; `bench:bird:pool` separates those two factors from `cases[].candidates`
and `cases[].passed`, with no model call. It reports a ceiling per pool, the union over every pool
in the artifact, which questions only one pool answers, and a greedy path with the price of each
step. The dev reading is that the pool is closed as a lever — the best second call adds 1.31pp
against a 2.30pp resolution — and the useful part of that answer is where it points: a generator
that differs in method rather than in prompt or in draw.

## Design decisions worth knowing

- **No UI framework adapter.** The library exposes promises and async iterables;
  a React binding would triple the compatibility matrix for little value.
- **No OpenTelemetry dependency.** A span hook is enough; the host maps it.
- **Replay is a provider, not a mock.** CI exercises the real pipeline with
  recorded responses, so the code path is identical to production.
- **Benchmarks have controls.** A number without a positive and a negative
  control is not a measurement.
- **Adaptation chooses a configuration, never a prompt.** A bounded `Strategy` can be diffed,
  pinned and rolled back; a rewritten prompt cannot, and it would make the benchmark table
  describe a prompt that no longer exists.
- **A router is a claim about predictability, not about mechanism.** Before a rule picks per
  question, the instrument asks whether anything the rule can read separates the outcomes — and
  answers held out by database, because a rule fitted and scored on one corpus has already read
  the answer.
- **A score is a product, and the two factors are measured apart.** Candidate ceiling times
  selector conversion; `bench:bird:pool` reads both from one artifact so that a proposal to spend a
  call is priced against the ceiling it adds, not against the score it hopes for. On the dev split
  the widest pool reaches 65.66% and the union of all four reaches 67.49%, while the best single
  call after the first adds 1.31pp — under the 2.30pp the split can resolve. The pool is therefore
  closed as a lever at this model, and the decision that follows is about generators, not about
  selectors or routers.
- **A verdict is not a record; the statement and the result travel with it.** A per-candidate
  `correct` says a loss happened and cannot say which rule would have avoided it, so every
  selection rule used to cost a run. Each artifact candidate now carries its `sql` and a
  `fingerprint`, and the fingerprint is the judge's own identity hashed — `resultKey` is the
  canonical key of a result set and `judgeOfficial` compares two of them, so "same fingerprint"
  means `match` rather than resembling it. `bench:bird:consensus` replays `first`, `shortest` and
  modal agreement from the file at zero calls; a rule whose input the artifact lacks is printed as a
  dash with the reason, never as a zero. On the dev artifact this already separates two arms that
  looked alike: taking candidate one ties the selector on `select` (40:35, p=0.64) and loses to it
  on `select-mixed` (13:30, p=0.0137). Choosing is guessing when the candidates are draws of one
  prompt and deciding when they differ in content — the same mechanism the ceiling was measured to
  assume.
