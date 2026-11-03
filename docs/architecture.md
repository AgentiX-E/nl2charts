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

### The decision is a measurement too

Three candidates are drawn and a model names one. That call is the only part of the `select` tier a
reader never priced, because pricing it needs a pool two arms share: every arm that differed in who
decides also differed in what was drawn, and the pool's own displacement at 600 questions (1.3 to
3.3pp) is the size of the effect.

`eval/bird/decision.ts` prices it from the artifact instead. A candidate record carries
`fingerprint`, the hash of the rows its statement returned, so a case reduces to the opinions it
contains: one group is a case where both decisions return the same statement, and two or more is the
only case where a decision exists. Three runs of `select-cross` put that at 140 to 149 disputed cases
in 600, and the count was right on 74 of them against the model's 40 (exact McNemar p = 0.0019); the
modal result scored 380 of 600 in two of the runs while the selector scored 367 and 362.

The homogeneous pool reverses it, which is the part that makes this a claim about shapes rather than
about selectors: `select-mixed` had 50 disputed cases and the model won 12 of them against the
count's 5. A decision exists four times more often once the candidates come from two authors, and on
that pool the free rule is at least as good. Both readings are in `docs/benchmarks.md`.

Two arms make that a measurement rather than a re-reading. `select-cross-pooled-vote` returns the
modal group from `select-cross`'s candidates in zero calls, and `select-cross-pooled-agree` reads the
same pool with the agreement marks. Both are one lever from `select-cross-pooled`, the A/A
instrument: the same candidates, the same rows, the same order, so the delta is the decision.

The third arm on that pool changes the answer format rather than the ranking.
`select-cross-pooled-reconcile` shows the model the *result groups* — the partition the agreement
marks already define, one group per distinct result — and asks it to write the statement to run.
The reply is executed and, if it runs, becomes the answer; a statement the engine refuses leaves the
modal result standing, and a turn that never came back is recorded as an outage. The reason to ask
for a statement instead of an index is arithmetic: on this pool 70.5% of cases hold a matching
statement and the arms score 64.0%, so the 39 cases in between contain a correct answer that no
index can name. An arm whose replies only restate a candidate is not measured as a reconcile arm at
all — `assertReconcileFired` refuses it, because its score would belong to the selector.

The instrument's two rules are worth stating because both are places where a plausible number could
have been invented: a case with no candidate is counted apart instead of scored as an opinion the
count got wrong, and the tie-break is taken from the drawing order, which is what `majorityResult`
does — 32 of the 292 disputed cases were 1:1:1, and a tie-break that happened to favour one author
would have looked like a mechanism.

### A text transform needs its own instrument

The masked variant of the worked examples (`eval/bird/mask.ts`) is the first lever in this repository
whose mechanism is a *string rewrite* rather than a call, a block or a rule over candidates, and it
failed in the way that class fails: silently. A masker that matches nothing sends the parent's prompt,
spends the parent's tokens and publishes the parent's accuracy as the lever's reading. Nothing throws,
nothing is missing, and the delta of ~0 reads as "masking the schema does not help" — which is a real
finding about the mechanism being tested, attributed to a transform that never ran.

So the count is the instrument. `demonstrationsFunnel` publishes `rewritten` beside `examples`,
`assertMaskingFired` refuses a bank of a hundred cases in which the masker changed nothing, and the
count is measured against the *raw* block rather than assumed from the fact that a masker exists. The
three other levers whose mechanism lives in text — the synthesized hint, the value block, the
canonical statement — are each read through a funnel for the same reason.

Four defects surfaced while the masker was being written, and they share one shape: a rule that reads
text correctly until the text is less regular than the rule assumed.

- **`1.` is a number, and a dot after it is not a qualifier.** Lexing the number as `1` plus `.` made
  `select 1. from t` come out as `select 1. column_1 table_1` — the keyword that opens the table list
  masked as a column, and the table behind it masked as another one. A transform over punctuation has
  to get the lexical layer right before its rules mean anything.
- **`extract(year from d)` contains the word `from`.** The table scan read `d` as a table. The scan now
  records which call each open parenthesis belongs to and skips a `from` inside `extract`, `trim`,
  `substring` and `position`.
- **`with t as (` bound the name at neither end.** Requiring a `select` behind the parenthesis meant a
  truncated statement kept the name at its definition and masked it at its reference, which is the one
  outcome a masked example cannot survive.
- **A keyword set cannot tell a time unit from a column name.** `year` follows `interval` in one
  statement and names `formula_1.races`'s column in another. Keeping the units as keywords leaked four
  statements of Mini-Dev's 500; masking them produced examples that do not parse. The units are kept
  only in the two spellings that make them units.

The general form of that last one is worth carrying forward: a set of words is the wrong shape for a
distinction that is about *position*, and the rule that replaces it has to state the positions.

The arm is one lever only because the count is held fixed. A masked example is shorter than the raw
one, so the renderer's character budget fits more of them — the masked block is cut to the raw block's
width, or the pair would differ in how many examples it carried as well as in their text, and the
delta would price two things.

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

### Running the gates on a machine that has no service containers

`ci.yml` starts PostgreSQL 16 and MySQL 8.4 as services and exports `PG_TEST_URL` and
`MYSQL_TEST_URL`. Without them the two connector suites are **skipped**, not failed — and
`packages/node` then reports 85.83% on lines, which is a measurement of the environment rather
than of the code. The four dimensions of all eight packages reach 95% only when the servers are
there: 99.59% lines and 98.23% branches for `packages/node`, 2,751 tests passing and none skipped.

On Debian/Ubuntu the whole setup is six commands:

```bash
rm -rf /var/lib/postgresql/16/main
su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /var/lib/postgresql/16/main -A trust -U postgres"
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/16/main -l /tmp/pg.log \
  -o '-k /tmp -p 5432 -h 127.0.0.1' -w start"
psql -h 127.0.0.1 -U postgres -c 'create database nl2charts_test'

mariadbd --user=mysql --datadir=/var/lib/mysql --socket=/tmp/mysql.sock --port=3306 \
  --bind-address=127.0.0.1 &
mysql --socket=/tmp/mysql.sock -uroot -e "create database nl2charts_test; \
  create user 'analyst'@'%' identified by 's3cret'; \
  grant all on nl2charts_test.* to 'analyst'@'%';"

export PG_TEST_URL='postgres://postgres:postgres@127.0.0.1:5432/nl2charts_test'
export MYSQL_TEST_URL='mysql://analyst:s3cret@127.0.0.1:3306/nl2charts_test'
```

MariaDB stands in for MySQL 8.4 in the connector suite; every assertion in it passes against
both. One behaviour is worth knowing before trusting an `AbortSignal` on this engine: `pg` does not
cancel a statement it has already sent, so forwarding the signal to the driver was a comment that
looked like a guarantee — aborting during `select pg_sleep(1)` returned the row a second later,
exactly as if no signal had been given. The connector now stops the statement where it can: on
abort it looks up the connection's `pg_backend_pid()` once per physical connection, asks the server
to `pg_cancel_backend` it on a connection of its own, destroys that connection rather than
returning a half-read protocol to the pool, and reports the case as `NL2C_E_TIMEOUT`. A
`statement_timeout` on the server produces the same SQLSTATE (`57014`) and is reported the same
way, because to everything above the connector both mean one thing: the statement ran out of
time.

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
- **A threshold finer than the evidence is not a finding.** Every verdict in `eval/bird` compares a
  difference against a margin, and the margin was a constant: 2.30pp, the resolution of the full dev
  split. That constant then judged a 600-question sample, where the same design resolves 3.17pp, and
  a 10pp gap resting on two discordant pairs was published as "earning its price". The margin is now
  what the caller states and the resolution is what the artifact computes from the discordant pairs of
  the very pairing the verdict is about (`pairedResolution`), and both are printed. The four resulting
  sentences say which number binds: a gap inside the margin *and* inside the resolution leaves the
  call measurably worthless; a gap that clears both has earned its price; the two mixed cases say this
  run measured neither, in the direction it failed to measure. The rule generalises past this
  instrument — an artifact that carries its own sample size can price its own claims, and one that
  does not should not be quoted at someone else's resolution.
- **A step that names an arm may be naming an arm nobody ran.** `bird-dev.yml` gained an `arms` input
  and five analysis steps below it kept the literal `--arm select`, which is an arm the Mini-Dev chain
  always runs and a dev dispatch runs only on request: run `41356370371` finished its evaluation,
  passed its floor, and then failed four steps later with "has no arm select; it holds select-cross,
  select-mixed". The fix is not a default and not a shell prefix match — the first is wrong for every
  dispatch but one and the second is a rule no test can hold — but `tools/bird-arm.mjs`, which answers
  with the first arm the run's own `BIRD_ARMS` asked for that the artifact holds, else the largest
  population, and is tested for both edges plus the contract that it prints nothing else on stdout.
- **Agreement is a partition, and the selector was never handed it.** The selector receives each
  candidate's statement, row count, column count and the first three rows — and three hundred
  characters of a wide result cannot establish that two result sets are the same set. So the one
  fact a 2+1 pool turns on, that two of the three returned exactly the same thing, was the one fact
  the selector had to guess, while the vote counted it exactly. `agreementMarks` computes the
  partition in one pass over `resultKey` — each candidate points at the earliest candidate it
  matches, so groups have exactly one unmarked member and the number of distinct results is
  countable from the marks alone — and `select-mixed+agree` / `select-cross-agree` hand it to the
  prompt as a line per duplicate plus one rule: agreement is evidence, not proof. The block is
  opt-in, so every arm measured before it keeps a byte-identical prompt and the pair prices the
  information rather than a rewrite; the marks cost no call, because the rows were already executed.
- **An explanation that does not move the number is still a finding, and it is the one that
  narrows the next attempt.** Telling the selector which candidates returned the same rows — the
  fact a 2+1 pool is built on and the only one it could not compute from truncated previews —
  changed nothing: −1.00pp on the cross pool (15:21, p=0.405) and −0.17pp on the mixed one (5:6,
  p=1.000), with the minority-correct pick rate unmoved (52.9% → 54.8%). That result rules out the
  cheap explanation of the 6pp conversion gap rather than leaving it open, and the difference
  matters: an information deficit would be fixed by a prompt, a recognition deficit is fixed only by
  changing what the model can judge. It also puts a price on the habit of explaining a null by
  "the model could not know" — here it was told, at 373 characters a call, and it chose the same way.

- **A parameter the endpoint ignores is not a parameter the pipeline sent.** The reasoning endpoint
  this repository benchmarks accepts `temperature`, `top_p`, `presence_penalty` and
  `frequency_penalty` and discards all four; its documentation says the fields are accepted for
  compatibility and have no effect. The harness sent `temperature: 0`, read a 200, and printed the
  sampling regime in every report, because the only refusal path in the code was a 400/422
  (`probeProtocol`) and a vendor that says yes and means nothing never enters it. The correction is
  not a retry: it is a declaration. `ModelCapabilities` states what an endpoint does with a request,
  `adaptRequest` removes a field the endpoint ignores rather than sending it, and the removal is
  counted — per call in the meter, per arm in the artifact — so "sampled at zero" is a claim the
  report can support. The chat path is byte-identical, which is what lets the old readings stay
  comparable while the new ones stop being false.
- **The judge is part of the measurement, and its format is part of the judge.** A selector prompt
  that ends "answer with the number and nothing else" is written for a model that answers in one
  token. A reasoning judge either ignores it — and its prose is read as an undecided vote, which the
  artifact reports as a broken prompt — or obeys it and gives up the deliberation it was bought for.
  Both failure modes have the same root: the format was a property of the caller's memory rather than
  of the endpoint. `buildSelectionPrompt` now takes the capability, asks a thinking judge to think and
  to end on the number, and `parseReasonedChoice` reads the final line only when that instruction was
  sent. The default is unchanged and byte-identical, so every published selector reading keeps the
  instruction it was measured with; the two formats are separated by an arm, not by a release.
- **An arm whose switch never reaches the mechanism is a label, not a lever.** `inline+evidence+empty`
  was declared, paired and filed on demand, and the mechanism it is named for could not run: the
  pipeline never received `emptyRetry`, the execution hook was attached only when `repairs > 0`, and
  the hook returned `void`, so the row count the turn triggers on did not exist. Three independent
  breaks, and none of them produced an error — the arm simply spent no call and reported no funnel,
  which the run guard would have refused had the arm ever been dispatched. The general lesson is not
  "test more": it is that a lever crossing three layers needs one test that asserts it crossed all
  three, and that the artifact must carry the mechanism's own count. Both are now in place, and the
  test fails against any one of the three reverts.
- **A declaration is read before a name, and the row is read whole.** `capabilitiesOf` picked its
  base row from the model *name* and then overwrote `family` from the deployment's declaration. On
  the only endpoints that have to declare anything — self-hosted ones, whose names say nothing — the
  result contradicted itself: `family: 'reasoning'` beside `thinksAloud: false` (the chat judge
  format), `jsonMode: true` (a JSON mode the endpoint does not serve, answered with a 400 that reads
  as a bad key) and a 4,096-token answer budget against the 8,192 the vendor documents, where a
  truncated answer scores as a wrong one. Declaring both fields, which is the natural way to write
  it, was worse than declaring one. The rule is the same one the contract already states: a
  declaration is knowledge and a name is a guess, so the guess may not choose what the knowledge is
  merged into. The base now follows the declared family and the name is the fallback; a deployment
  that knows its own ceiling still wins field by field.
- **Two arms that generate separately cannot be compared at this sample size, and the fix is a
  shared pool rather than a bigger sample.** Every arm draws its own candidates, so a one-lever
  pair also differs in its pool, and the pool moves on its own: `select-cross` scored 382/600 and
  then 362/600 on the same 600 questions (26:6 discordant, p=5.4e-4), with 474 of 600 cases
  carrying byte-identical candidate sets and 24 of the 26 flips coming from the 126 cases whose
  pool was re-drawn. In the same run, an arm that changed *no* generation — the judge swap — moved
  the reasoning model's own slot by +1.60pp, which is larger than the +0.43pp the de-anchoring arm
  moved the slot it targets. `Arm.pool` makes an arm read another arm's candidates, its rows and
  its previews, so the only difference between `select-cross-pooled` and
  `select-cross-pooled-judge-reasoning` is who judges and in what format: one call per case instead
  of four, zero generation noise, and an exact-zero A/A (`select-cross` → `select-cross-pooled`)
  that fails loudly through `assertPoolShared` if the pool was not in fact shared. The general rule
  is the one this project keeps rediscovering: before pricing a lever, make sure the instrument can
  see it, and if two arms cannot share their randomness, measure the noise they do not share.
- **A lever that is off on the main arm is not a reading about the model.** `select-cross` is
  declared `repairs: 0`, so a candidate the engine refuses is executed once, dropped, and never
  shown to the model that wrote it: the ceiling falls by one and nobody is told why. Against that
  pipeline, a reasoning model's slot read 61.94% while two chat slots read 63.82% and 63.19%, and
  the arm holding it scored 63.67% against 64.33% for the all-chat arm — a result that invites the
  conclusion "on BIRD a reasoning model is differently wrong". The conclusion is not available from
  that experiment, because the loop that a reasoning model is actually better at was switched off:
  execution feedback is the largest single-model gain reported on BIRD (ExCoT-DPO, 57.37% → 68.51%),
  and the same work's negative control is that zero-shot chain-of-thought buys almost nothing. A
  one-shot prompt asks a thinking model to think with nothing to think about.
- **A mixed arm's own `repairs` field never reaches the generator, so the grant has to be keyed by
  source.** `runArm` resolves each source to its own `Arm` and builds the pipeline from that arm,
  which means the mixed arm's field is decoration — a silent trap, because the arm's declaration
  looks authoritative and the number it names is never read. `sourceRepairs` is resolved where the
  pipeline is built, and the execute hook is attached from the same resolved number: raising
  `maxRepairs` without attaching the hook arms a loop that cannot hear the engine, which is exactly
  the defect `emptyRetry` had. Keying by source is what makes "which model gets the feedback" a
  measurable question rather than an arm-wide constant, and the loop is nearly free — a repair turn
  fires only on a refusal, and candidates reached the engine 598, 596 and 595 times out of 600.
- **A guard's premise can be wrong in a way only a real run reveals.** The shared-pool guard
  required a pooled arm's pool to hold as many candidates as the arm declares, on the reasoning
  that the two arms must be compared at the same candidate count. `41389454128` refused nine of six
  hundred cases on it: a three-candidate arm legitimately holds one candidate where two statements
  failed to execute, because a candidate the engine refuses does not exist. The guard now refuses
  only an absent pool (an ordering bug) and an empty one (the source ran the case and produced
  nothing). The general lesson is the one this file keeps relearning: a guard that fires on the
  harness's honest behaviour is worse than no guard, because it turns a measurement into an
  incident and the fix is then applied to the guard rather than to the question.
- **A pooled arm pays for a decision and for no candidates, so a mean cannot state its price.** The
  cost rule — an arm that samples three times and selects with a model spends four calls, and three
  means the selector went unbilled — is right about the arms it was written for and wrong about the
  one case it had never met. `41440646002` ran eight arms to completion and the gate refused four
  pooled rows for reporting exactly one call per case, which is what a pooled arm is built to report.
  The false refusal carried a real gap inside it: `calls.mean` cannot separate "three cases never
  reached the selector" (an empty pool returns before the decision) from "the selector was never
  counted", because both read 0.995. The artifact now carries the two counts instead —
  `spend: { asked, priced }` — and the gate reads `priced === asked` in place of the mean, plus
  the one rule a mean *can* enforce: a pooled arm must spend strictly fewer calls than the arm whose
  pool it names, or the candidates were drawn twice. Two shapes, two rules, and the reason a guard
  refuses is checked as carefully as the refusal — a reader will go looking for whatever the message
  names.
- **Removing the suspected cause is how a negative result becomes a finding.** The reconcile arm lost
  3.5pp to a free count, and the funnel said the loss was on paraphrases: 514 of 600 replies restated
  a candidate. That diagnosis was turned into a lever rather than an explanation — a policy that hands
  restatements back — and the policy was worth +9 cases (`41462471819`, 354 -> 363). It was also not
  the whole loss. With the adoption rule removed as a cause, the residual is 16 cases short of the
  count, and the `bench:bird:reconcile` cut puts all 16 on the 82 cases where the model wrote a
  statement nobody had written (the count is right 34 times there, the arm 18). That is a different
  sentence than "the lever does not work": the pipeline around the lever is now measured and
  exonerated, and what remains is the model's writing. A round that improves an arm and still closes
  its line is worth more than one that improves an arm and declares victory, because the second
  leaves the next round looking in the same place.

- **One column of a funnel can be a constant, and a constant cannot be argued with.** The reconcile
  arm's funnel published `executable` and `adopted` and the two were equal by construction, because
  the arm adopted every statement the engine ran — so the column that says "the model's correction
  was scored" could not distinguish a correction from a candidate rewritten in other words.
  `41453395203` adopted 595 of 600 and 514 of those replies were paraphrases; the score fell 3.5pp
  against a free rule and the artifact could not say which cases it fell on. A count that the code
  makes equal to another count is not a measurement, and the fix is not a better column name: the
  policy that decides what `adopted` means is now a lever of its own (`reconcileAdopt`), it travels
  with the counts in the row (`reconcile.policy`), the gate asserts the relationship each policy
  implies rather than one relationship for both, and the per-case record is published so a paired
  reading can cut the deltas by it. The same rule as `emptyRetry.mode`: a funnel whose last column
  depends on a declaration has to carry the declaration.
- **A mechanism that fires three times cannot explain a delta of eighteen wins, and the check is
  arithmetic rather than statistical.** The repair loop fires only on a guard rejection or an engine
  refusal: 3 times on `-repair-second` and 11 on `-repair-all` in 600 questions, while the same arms
  beat their parent on 18 and 24 cases (p=0.0070 for the wider one). Counting the cases where *only*
  the arm spent a retry bounds the mechanism's possible contribution at 0, 1 and 2 wins; everything
  above that is the pool being re-drawn, which three runs of the same control priced at 3.3pp. The
  rule generalises past this round — **a lever's contribution is bounded by the cases in which only
  it fired, so a paired comparison with more discordant pairs than the bound allows is measuring
  shared-randomness noise** — and it is useful precisely because it separates two failures that look
  identical in a table of accuracies: the lever never fired, versus the lever fired and the delta
  belongs to the pool. It does not rescue a lever that fires everywhere (a prompt change, a judge
  swap); those still need a shared pool, which is why `select-cross-pooled` exists.
- **The feedback signal was attached to the rarest failure.** The loop reads the engine's refusal,
  which happens to 0.5–1.8% of candidates — and the reasoning model has the *fewest* of them (2 in
  600, against 4 and 5 for the chat prompts), so the one channel the strong model was given is the
  one it needs least. The errors that cost 39% of the benchmark are statements that execute and
  return the wrong rows, which no repair turn ever sees. Reconnecting the loop to *disagreement
  between candidates' results* rather than to syntax is the next lever, and it is the first one
  where the strong model should win outright, because deciding which of two result sets answers the
  question is inference rather than recall.
- **A cost that is a property of the rule has to be measured on the rule, not on its family.** The
  value block was rejected three times on a 22.9% prompt growth, and that number belongs to the
  sampler it was built with: every profiled column. The block a column rule would actually send is
  1.4% of the card on Mini-Dev, and the difference between the two — 27× — is larger than every
  effect the family was ever read against. **A family priced at the wrong width is not a priced
  family**, and the cheapest fix is a bisection with no model in it: render both cards, count the
  characters, look at which cases each one touches. The generalisation is uncomfortable because it
  applies to levers this repository has already closed for cost reasons: the reading that closes a
  family has to name the width it was taken at, or it closes a different family.
- **A cache keyed by a name is keyed by nothing until the name is unique.** The profile cache was
  one directory for every dataset, keyed by database name, and two fixtures that both called their
  database `shop` read each other's schema — a card rendered from another dataset, on every case,
  with no instrument able to see it. The comment that already existed on `.value-examples` says why:
  *a profile is a description of these files*, so it belongs beside them. The reading that finds
  this is not a unit test of the cache; it is a run whose fixture had a schema the assertion did not
  expect. **A shared cache is a shared opinion about what the inputs are**, and the only safe key is
  the input itself.
- **A call bought on a condition has to publish the condition, or its price is a fiction.** The
  conditional-dissent arm spends a generation on the 74.5% of cases where the candidate set agreed
  and nothing on the rest, so its `calls.mean` is 0.745 — a number that is arithmetically identical
  to an unconditional extra call on three quarters of a split, and to a call that never fired. The
  funnel is what makes them different sentences: `asked` is the condition holding, `arrived` is the
  call surviving, `distinct` is the call carrying information, `adopted` is it changing the answer.
  The general rule is the one every other instrument here follows, and it bites hardest on the
  cheapest lever: **a lever priced by a mean has to publish the population the mean is over.**
- **A check that skips the cases a lever acted on is weakest where it matters.** The shared-pool
  identity compares a pooled arm's candidate statements against the arm it read, slot by slot. An
  arm that buys one extra candidate therefore fails the length comparison on exactly the cases its
  lever fired on — and the first version of the check treated a length mismatch as "not comparable"
  and skipped it. The guard would have been silent on the population the arm was built for, while
  still passing on every case it did nothing on, which reads in a summary as a verified pool. The
  fix is to exclude the bought candidate *by source* — the one field that says who wrote it — so
  everything the pool supplied is still compared, and the exclusion cannot hide a regeneration.
- **A mechanism that lives only in an if-chain is a mechanism nothing forces you to guard.** Every
  lever that acts at runtime used to be guarded by its own line in `runArm`, which meant the arms'
  table could declare a mechanism, the pair table could price it, the dispatch comment could explain
  it, and the guard could simply not exist — the only proof a mechanism runs end to end is a paid
  artifact, and three levers have now been published for a round with a zero funnel. The chain is a
  loop over `MECHANISMS`, one row per lever carrying its predicate, its guard, the artifact field it
  writes, the end-to-end scenario that proves the wiring and a bank of cases in which it did not act.
  The register is then checkable in four directions at once: every `assert*Fired`/`Ran`/`Answered`
  the runner exports must appear in it, every row must be declared by an arm that exists, every row's
  guard must refuse its quiet bank, and every row must name a scenario whose body reads the field it
  writes. **The naming convention is load-bearing** — a guard that dodges the suffix has to be added
  to an exemption table with a reason, so that adding a mechanism can never be a silent act.
- **A test whose deadline races the machine measures the machine.** Two cancellation cases aborted a
  hundred milliseconds after the query returned, on a five-second `pg_sleep`, and asserted the
  rejection. On an idle machine the timer wins; under a coverage run with a hundred and twenty test
  files in flight it lost, the statement finished on its own, and the suite failed with "promise
  resolved instead of rejecting" — the same code, green here and red there. The contract is about a
  statement that is *running*, so the test now asks the server: it polls `pg_stat_activity` until the
  sleeping backend is visible, then aborts. It is faster (281ms against 464ms), and a broken
  cancellation still fails. The general rule: **a timeout in a test is an assumption about the
  machine; an observation is a fact about the system.**
- **A missing record must be excluded and counted, never given a value.** The diversity harness
  answered "how many opinions did this pool hold" for an artifact that carried no fingerprints by
  naming each missing one after its source — which makes every uncomparable case as diverse as the
  arm has sources, and printed `3.00, 0% unanimous` on all 1,507 cases of a pool that could not be
  compared at all. The invented value was the configuration's own number, which is the one thing the
  reading was supposed to discover. Missing records are now dropped from the mean with the population
  printed beside it, and an artifact below the floor is refused rather than summarised. It is the same
  rule as `0 is a measured 0`, one step earlier: **an absent field is a population of zero, and a
  population of zero has no mean.**
- **A criterion phrased as a share of a ceiling has to be checked against the oracle of the
  mechanism it prices.** The pairwise arm was registered with "conversion returns above 92%", written
  before anyone had computed what a *perfect* two-way comparison could reach. It can reach 963 of
  1,050 cases — 91.71% — so the criterion sat three cases above the maximum and could never pass, and
  the reading would have blamed the arm for an arithmetic slip in its own registration. The oracle is
  an offline fact about the parent's artifact, available for free while the arm is still running: take
  it first, then write the number, or publish both and say which one decides.
- **Two prompts that disagree are not necessarily two opinions.** The pool was built on the
  literature's premise that different wordings see different things, and the probe that tested it cost
  960 completions: three samples of one prompt at temperature 0.7 carry **1.15** distinct results per
  case, three different prompts carry **1.12**. The mechanisms are the same dice either way, so
  "diversity" in the pool was sampling variance wearing the name of heterogeneity — and 82% of the
  losses are cases where every candidate agreed on the same wrong rows, which is a knowledge failure
  that neither sampling nor re-wording touches. **A factor nobody measured will be named after the
  thing it was supposed to be**, and the name survives every reading that does not separate them.
- **A lever that only edits a prompt has no natural failure signal; the absence of its input is the
  only one.** Every other mechanism in this repository fails loudly when it breaks — a candidate
  that never arrives, a selector that answers nothing, an engine that refuses every statement. A
  prompt block that never arrives fails silently: the prompt is valid, the model answers, the arm
  scores, and the number reads as "worked examples do not help". `demonstrations` was the last
  runtime lever without a guard, and the reason is structural rather than careless — nothing in the
  pipeline ever asked whether the block was there. The guard therefore counts the input per case,
  refuses a zero on any bank large enough to be a reading, and publishes the share beside the score:
  **a block that arrives on a third of the split is a blend of two prompts, and the mean belongs to
  neither.**
- **A conditional download decided by a name list belongs beside the list.** The training split is
  an 8.5 GB archive that most dispatches never read, so the workflow has to ask before it fetches —
  and the first version of that question is always a YAML `contains('+icl')`, which is a second
  opinion about which arms exist and drifts the first time an arm is renamed. `bench:bird:needs-train`
  resolves the same arm table the runner resolves and prints one word. The workflow asks it; the
  table answers; a new arm that reads the split is fetched for by being declared.
- **A refusal written when every dispatch looked alike becomes a false alarm the first time one does
  not.** Three instruments (`pool`, `diversity`, `consensus`) each refused an artifact with no
  candidate record, because for a year every dev dispatch sampled three candidates. The round the
  ceiling lever became a single call turned all three into false alarms on an artifact that was
  exactly what the dispatch asked for: the dev run **passed** its evaluation and its accuracy floor,
  then died at the first instrument, skipped the two readings behind it, and went red. The missing
  distinction was between two absences — *no arm draws more than one candidate* (a reading, printed in
  one sentence, exit 0) and *an arm publishes a ceiling with no candidates under it* (an artifact that
  lost records, refused). `eval/bird/artifact.ts` holds the one predicate all three now share, and
  `scoredQuestions` exists because the first version of the sentence said "no pool to price (0
  questions)" about a run that had just scored 1,532: **a sentence that states a number has to state
  the run's number**, and the denominator had been taken from the rows that were missing.
- **A retrieval block is two things at once, and the two have opposite signs.** The worked examples
  moved one failure class by thirty cases (column-count, 136 → 106, the largest any prompt lever has
  produced here) and cost sixteen in exchange: eight value failures and eight execution errors. Every
  new execution error was a borrowed identifier (`APTT`, `T-BIL`, `SC170`, `T1.Diagnosis`) or a
  borrowed dialect (`YEAR`, `MONTH`, `DATEDIFF`). A block that arrives from another schema carries
  shape *and* vocabulary, and no single accuracy number can separate them — which is why the next
  lever masks the vocabulary rather than adding more examples.
