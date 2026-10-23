# Changelog

The eight packages share one version. Each entry records what changed and what was
measured, because a release note that only lists features is a release note that
cannot be argued with.

## 1.0.0

### Added

- **Semantic layer**: `MetricQuery → DataflowPlan → Optimize → SqlPlan → Render`,
  five metric kinds (simple, ratio, derived, cumulative, conversion), grain-first
  aggregation.
- **Three engines with integration tests**: DuckDB, SQLite, PostgreSQL 16 and
  MySQL 8.4 (the last two in CI service containers). Read-only is enforced twice —
  a lexical guard before the statement leaves the process, and a read-only session
  that catches what the guard cannot see.
- **Chart compilation for all 22 core ECharts series**, each with a declared
  contract (`describeMark`) and a committed structural baseline; a mark that cannot
  be drawn emits no series instead of throwing inside the renderer.
- **MCP surface that speaks metrics**: `query_metric` and `explain_metric` beside
  `run_sql` and `engine_info`.
- **Trace sealing**: hash-chained events, three distinct failure verdicts, replay
  without reading a clock, and an injectable signer for callers who need an HMAC.
- **A gate that notices a lever with no input**: `inline+retrieval` scored 44.4% with
  `retrievalCorpus` at 0 — it was its parent arm renamed, not a null result. The
  runner now throws when a block's input is missing, the gate fails on an empty
  block, and CI fetches the 4.2 MB training corpus it had never downloaded. A second
  path had the same symptom: `promptFor`'s positional arguments let the measured
  prompt and the sent prompt diverge, so the block reached the size metric only.
  Prompts are now built through one function that the arm drives.
- **`inline+icl`**: the same retrieved neighbours as worked examples, statements
  included, one lever from `inline+retrieval`.
- **`values`**: the literals a question names, resolved against the database under
  test — CHASE-SQL's value retrieval without an embedding index, one lever from
  `inline+evidence`. The index scans each column's distinct values (45,444 keys,
  34.6% of questions matched) instead of the profile's thirty-per-column, which had
  matched 18% and measured the index rather than the idea.
- **`select` / `select5`**: three or five samples chosen by the model instead of
  counted. Measured +2.6pp against voting (p=0.015) and then **+0.6pp when repeated**
  (p=0.85); five candidates did not beat three (+1.0pp, p=0.57). The first result was
  the outlier, and the docs say so.
- **`chooseCandidate`** in `@agentix-e/nl2charts-ai`: the selector as a library
  function, with `decided: false` reported rather than absorbed. It has a measured
  cost (three extra calls) and no replicated gain.
- **An A/A control**: `BIRD_AA` runs one arm twice in the same job, so every delta has
  a measured scale. Serialised into the artifact as `aa`, and the gate fails when the
  pair disagrees by more than the tolerance used to judge regressions.
- **Definitions are pinned**, not regenerated: `eval/baseline/definitions.minidev.json`
  holds the 11 database blocks, because the cache never hit and the model rewrote six
  of them per run, moving `synth-definitions` by 5.1pp between sessions.
- **A gate that notices a declared arm never running**: the baseline now lists the
  arms it expects, so an arm that is wired but missing from the run fails the build.
  `inline+retrieval` was such an arm for one release.
- **Retrieval over BIRD's training split**: BM25 over 9,428 labelled questions from
  69 databases, none of which appears in the split under test.
- **Two Studio views**: a trace timeline rendered to SVG and an issue list as text,
  both pure string functions with geometry asserted in tests.
- **Six runbooks** with drills, and a runtime leak audit driven by a canary
  password.
- **Gates**: coverage (95% on four dimensions per package), layering, public API
  snapshot, bundle budgets, credential scan, and a benchmark floor.

### Measured

- BIRD Mini-Dev: 32.6% (names) → 42.7% (definitions attached to columns) →
  55.2–56.9% (plus the dataset's per-question hint); 58.2% for curated metadata plus
  the same hint. The floors are enforced in CI (`pnpm gate:bird`). The sample was
  our own 240-question cap until this release; CI now scores the whole 500-question
  split (498 scorable — two gold statements exceed the step budget, and the artifact
  names them), and a `bird-dev` workflow scores the 1,534-question public split that
  leaderboards report. Full-split numbers, run `39945679683`: names 36.3%, inline
  definitions 45.0%, plus the dataset hint 57.6%, curated metadata 58.8%, model
  selection over three samples 59.0%.
- Placement is worth +6.7 to +10.5pp across four runs; content, authorship,
  coverage, question-restating and three-sample voting each moved nothing beyond
  noise.
- Adversarial shapes: 81.2%, with full column metadata costing 6–9pp there.

### Not claimed

- No SOTA claim: one model, one sample per case, 498 of 500 questions.
- 22 of the 37 designed chart configurations; the rest need GL or extension
  modules that cannot be rendered head-lessly.
- Studio ships a view model, not a UI.

## 0.4.0

- Compiler, two engines, first benchmark harness, coverage and budget gates.

## 0.3.0

- Chart compiler, lint rules, candidate ranking.

## 0.2.0

- Runner, guard, normalization, span events.

## 0.1.0

- Contract package: ChartIR, MetricQuery, provenance, error codes.
