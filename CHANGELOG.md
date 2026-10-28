# Changelog

The eight packages share one version. Each entry records what changed and what was
measured, because a release note that only lists features is a release note that
cannot be argued with.

## Unreleased

### Adopted

- **Three prompt styles and a selector, four calls per question.** Two consecutive dev-split
  runs at p<0.01 (+1.7pp p=0.0095, +1.8pp p=0.0046 against `select`; +2.4pp p=0.0001 and
  +2.2pp p=0.0002 against the single sample) meet the ADR-184 bar, which no mechanism has
  met since diagnosed repair. The dev split now carries floors for the five arms it always
  runs (`names` 41.5, `inline+evidence` 60.5, `metadata+evidence` 61.0, `select` 60.9,
  `select-mixed` 62.5), so a regression fails the build instead of becoming a paragraph.
  The user guide's recipe replaces "three samples and a selector" with the three prompt
  styles that were actually measured.

### Added

- **`decompose`: a candidate written as steps, in one call.** A plan ahead of the statement
  measured −7.2pp (63/27, p=0.0002) because it anchored the statement it was meant to prepare;
  this is the other shape — the model writes the sub-questions as statements in the same reply
  and composes them. `PipelineOptions.decompose` turns on both halves at once (the prompt rules
  and a reader that takes the **last** block, not the first) because set separately they drift
  into a pipeline whose prompt asks for steps and whose reader returns step one. The reply is
  read the same way through repairs and the empty-result turn, and `AskResult.decomposedSteps`
  reports how many steps the model actually wrote.
- **Two arms to price it**: `decompose` (one lever from `inline+evidence`, same call count) and
  `select-mixed+dc` (the adopted trio plus a fourth candidate, one call more), with the reading
  order registered before the run in `docs/benchmarks.md`. The artifact carries
  `decomposition.{asked,fired,share,meanSteps}` and an arm where the format was ignored on more
  than half the cases — or that averaged fewer than 1.5 steps — is refused rather than
  published, in the runner and in the gate alike.

### Fixed

- **A mechanism that ran and did not reach the artifact is now an error, not a finding.**
  `decompose` scored 911 of 1,532 on the dev split with the runner's own guard satisfied —
  the model wrote `STEP` lines on more than half the cases — and its funnel existed in memory
  and never reached the report, because the field was emitted inside the spread reserved for
  arms that sample several candidates. The gate read the silence as "the prompt was never
  asked to decompose" and failed the build for a cause that did not exist. The funnel is now
  assembled at arm level, `report.arms` is typed (`ArmReportRow`) instead of `unknown[]`, and
  `assertReportComplete` compares, before the file is written, what each arm was configured
  to do against what its row carries.
- **A declared arm set is a measurement, and it cannot hide a lost row.** The dev baseline
  names five arms; the run above scored six, two of them new, and the gate failed it for the
  two it never requested. `report.armsRequested` now states what the run set out to score:
  baseline arms it did not request become notes, and the declaration has to agree with the
  published rows in both directions. An empty or unreadable declaration is an issue, not an
  absence — it claims to have run nothing.
- **The run that fails is the run whose artifact has to survive.** `bird-dev.yml` published
  its summary and uploaded its evaluation only on success, so the six-arm run above left
  nothing behind: no per-case rows, no McNemar p-values, no funnel, and the iteration could
  not be read at all. Both steps run on failure now, the summary states a missing artifact
  instead of dying on it, and `ci.yml`'s benchmark summary had the same defect. A test reads
  every benchmark workflow and fails on the next one written without `if: always()`.

### Measured

- **The fourth prompt raises the ceiling and the selector spends it.** `select-dc` — the
  adopted trio with its third slot given to decomposition instead of the value index, same
  candidate count, same four calls, same selector — reached a candidate recall of 67.0%
  against `select-mixed`'s 65.6% (+1.4pp, about 21 questions) and scored 61.4% against 63.4%
  (−2.0pp, 31 questions), with selection loss up from 34 to 87. The fourth prompt does write
  statements the three cannot, which is the half of the registered claim that had never been
  observed; the selector then prefers them on about fifty questions where they are wrong. The
  distance between the ceiling and the accuracy is the selector's quality, measured.
- **A decomposition inside one reply is a negative result with a cause.** `decompose` 911 of
  1,532 (59.5%) against `inline+evidence` 928 (60.6%), −1.1pp, and unlike an inert arm the
  format was followed: the model wrote steps on more than half the cases and averaged more
  than 1.5 per case. Writing the sub-statements before the answer pulls the answer toward the
  intermediate goals, which is the same failure `plan` showed at −7.2pp from the other
  direction.
- **The empty-result turn, second round on dev: +8 questions and a ceiling that did not move.**
  `select-mixed+empty` 979 of 1,532 (63.9%) against 971 (63.4%), candidate recall unchanged at
  65.6%. The ceiling is unchanged by construction — removing zero-row candidates removes wrong
  options and cannot write an answer — so the lever stays off by default until a paired test
  says otherwise; that test is the re-run, because this artifact was lost to the third defect
  above.

- **A candidate that never arrived was being read as a candidate that was wrong.** The dev
  run of the judge-swap experiment stopped itself when `select-cross-judge` lost 1,526 of
  1,532 calls (99.6%) to `429` on the second endpoint — the outage guard working as designed.
  In the same job `select-cross` completed at 62.5% with a ceiling of 64.8%, against 64.3%
  and 67.0% in its earlier runs, and nothing in the artifact said why: a refused candidate
  casts no vote, so the set shrinks, every case still answers, and the ceiling falls for a
  reason outside the arm. Candidates are now counted where they are lost, and an arm that
  loses more than a tenth of its declared set refuses to publish a ceiling.
- **The empty-result turn earns its call on what it says, not on being a second try.** Dev,
  1,532 questions: `select-mixed+empty` 64.03% against `select-mixed` 63.45% (+0.59pp, 14/23,
  p=0.188 — below the adoption bar, second round dispatched), and the pair against its own
  control is the finding: the extra turn returned rows on 32 of 64 fired cases with the
  diagnosis and 2 of 60 without it, at 0.0033 extra calls per case (Fisher p ≈ 9.8e-10).
  The ceiling did not move (1006 → 1005), which is the expected negative: dropping candidates
  that returned nothing removes wrong options, it cannot write an answer.
- **The third prompt slot was empty on three questions in five.** `values` won 81 of 1,532
  cases (5.3%) and its block was empty on 933 (60.9%), so the adopted trio was a duo with a
  third vote that could not differ; the dry run puts `select-mixed` at 39.1% of questions
  with three distinct prompts against 100% for `select-dc`.
- **One failure in ten announces itself.** Sampling the failing statements the last dev
  artifact keeps, 10.3% of 175 ran and returned zero rows, and 2.3% were refused by the
  engine. Because no question in either split has an empty gold result
  (`emptyGoldExcluded` is 0), a zero-row answer on this benchmark is wrong by construction —
  the only signal here with precision 1.0, and it fires on 8% of cases rather than all of
  them.

- **A perfect router over the seven arms is worth +6.3pp and still lands at 69.6%.** Counting
  the questions at least one arm answered correctly: 1,066 of 1,532 (69.6%), against 63.3% for
  the best single arm. That is below the published 70–73%, so routing is not the path; and the
  466 questions (30.4%) no arm answered are what only new generation can reach.


- **The fourth call is not overhead: counting votes costs 1.76pp.** `vote-mixed` — the same
  three candidates aggregated by modal result — scored 61.5% against `select-mixed`'s 63.3%
  (49 won / 22 lost, p=0.0018) on the dev split, with one call fewer. The model's judgement is
  worth more than the call it costs.
- **`vote-cross` reached the highest ceiling measured here (69.6%) and kept the least of it
  (90.2%).** Modal voting returned 14 of the 65 questions its set alone answered, because the
  set is one second-model statement and two primary-model statements: the two agree and outvote
  the correct one. The asymmetry the model selector shows (47%) is the same mechanism, one step
  less extreme.


- **The cross arm's third run did not replicate its accuracy gain.** +0.6pp (p=0.30) after
  +1.1 (0.043) and +1.2 (0.0094), while its ceiling stayed at 67.7% against 65.9%. A second
  model reliably improves what the selector has to choose from and does not reliably improve
  what it returns: not adopted, and the ceiling finding is stated separately from the
  accuracy one.
- **The second run of the cross arm replicated, and the ceiling now has a paired test.**
  `select-cross` 63.5% / 64.1% against `select-mixed`'s 62.4% / 62.9% (+1.1pp p=0.043,
  +1.2pp p=0.0094); its ceiling 67.8% / 67.0% against 65.3% / 65.7%, and the paired ceiling
  test — 31 questions held only by the cross set against 10 held only by the mixed one — is
  p=0.0015. Not adopted: one of the two accuracy runs misses the p<0.01 bar.
- **The duplicate candidate's contribution, answered.** Stratifying by whether the third
  candidate is a duplicate shows the trio ahead of `select` in both strata (64.6% vs 63.1%
  on the 599 distinct questions, 61.7% vs 60.1% on the 933 duplicate ones), so the gain is
  not the third candidate's distinctness: a duplicate buys a prior, not a second opinion.
- **A second model raises the ceiling, and the selector eats the gain.** `select-cross` —
  the adopted trio with its first candidate written by GLM-4.5 — holds a correct statement
  67.8% of the time against 65.3% for the all-deepseek trio, and returns 63.5% against
  62.4% (+1.1pp, 23 won / 40 lost, p=0.043). Below the pre-registered p<0.01, so not
  adopted: the candidate set gained 38 answers and the selector lost 22 of them (44 → 66
  cases discarded), which is where the next work is.

- **63.0% on the dev split with three prompt styles and a selector** (965/1,532), against
  60.6% for the single sample and 61.3% for three samples of one prompt. Since the dev
  split is the one published leaderboards report, this is the first number here that can
  be compared with another system directly. Paired: +2.4pp over `inline+evidence`
  (23 won / 60 lost, p=0.0001) and +1.7pp over `select` (34/60, p=0.0095).
- **Selection over three samples of one prompt is worth nothing at 1,532 questions**:
  +0.7pp, p=0.28. The same comparison read +2.6pp once and +0.6pp once at 498 questions;
  the larger split settles it.
- **Two prompts are not enough**: `select-duo` reaches 61.8% with three calls and loses to
  the trio by 1.2pp (p=0.0096), so the third source earns its call only inside the trio.

- **The candidate ceiling, and where the remaining gap is.** With the new instrument, the
  best arms hold a correct statement in their candidate set 61–65% of the time and return
  57–60%: three to five points are pure selection loss. `select-mixed` — three prompts
  instead of three samples of one — is **60.4%** against `select`'s 57.6% at the same four
  calls (+2.8pp, 10/24, p=0.024), and beats `select5` (59.2%) with two fewer calls.
- **A counted cost found a bug in its own first version.** The gate rejected the run with
  `select samples 3 times and selects with the model and reports 3 calls per case`: the
  selector call was made on the unwrapped provider. Fixed, and the check now
  distinguishes a model selector from a majority vote, which correctly spends exactly one
  call per sample.
- **`select-mixed` replicated, `select-pair` did not.** Two runs of the same code put
  `select-mixed` at **60.4%** against `select`'s 57.6% — +2.8pp in both (10/24 p=0.024,
  11/25 p=0.029), same four calls, A/A pair 0.2pp apart. The pre-registered bar is p<0.01
  twice (ADR-184), which 498 questions cannot resolve for a 2.8pp effect, so the decision
  moves to the dev split where it can.
- **`select-pair`** (binary comparison, `k - 1` calls) reached 58.4% against 57.6%
  (+0.8pp, 17/20, p=0.74) while discarding *more* of its candidate set: 25 cases against
  20. The absolute prompt is not where the selector loses its points. Out of the default
  chain, kept in the catalogue with the numbers.

- **Labelling candidates by origin moved the selector's preference and not its accuracy.**
  `select-tagged` — `select-cross` with each candidate's source in front of it — scored
  63.7% against 63.3% (+0.46pp, 26 won / 33 lost, p=0.43) and lost 52 of its ceiling instead
  of 54. The pre-registered criterion (loss ≈45) was not met, so "tell the selector more"
  closes the way "ask it differently" did last week.
- **A better candidate set converts at half rate, which is why the ceiling gains do not
  arrive.** On the 37 questions where the cross-model set alone held a correct statement,
  the selector returned it 18 times; on the 991 questions both sets held, the two arms
  returned the same answers (958 vs 960). Returned accuracy has now sat at 63.0-63.7% across
  five dev runs while the ceiling moved from 65.3% to 67.8%.

### Added

- **`select-cross-judge`**, and `judge` as an arm lever: the cross-model candidate set with its
  selector call routed to the **second** model. Same candidates, same prompt, same four calls.
  It exists to separate two causes of an asymmetry the last artifact contains — answers only
  the second model's candidate got right are returned 47% of the time, answers only the primary
  model's got right 87% — either the judge prefers its own generations or the second model's
  correct answers are harder to recognise. The artifact now records `judgeModel` and each arm's
  `judge`, and the gate refuses a judge swap whose judge is not named.
- **Conversion in the stratification tool.** `tools/stratify-mixed.mjs` now reports, per pair,
  the questions one set alone held, how many of those the arm actually returned, and how the
  two arms did on the questions both held. A ceiling gain without a conversion rate was how a
  2.4pp improvement in material came to be read as a 2.4pp improvement in accuracy (ADR-198).

- **`vote-mixed` / `vote-cross`**: the same diverse candidate sets aggregated by **modal
  result** instead of by a model — one lever from `select-mixed` / `select-cross`, three
  calls instead of four. After two failed attempts to improve the selector's judgement, the
  free aggregator is the remaining option that cannot be talked into a plausible wrong
  answer; the arms report `agreement` so a weak majority is visible.

- **`select-tagged`** and a `source` field on `Candidate`: the cross arm's three candidates
  with their origin in front of them (`1. [inline+evidence@second] SELECT …`), one lever
  from `select-cross`. The selector's rules are unchanged, so what changes is the facts it
  is given — the class of change ADR-194 says is worth testing. An unlabelled candidate
  renders exactly as before, which the prompt tests pin.

- **`select-cross`**: the adopted three-prompt candidate set with its first candidate
  generated by a **second model** (`inline+evidence@second`), same prompt, same count,
  same four calls — one lever from `select-mixed`. The hypothesis is that sampling one
  model buys paraphrases while a second model buys different mistakes, and only the
  second can lift the ceiling the selector is bounded by. The harness refuses to run the
  arm without `BIRD_SECOND_MODEL` and a second key, and says which one is missing.

- **`select-duo`**: two prompts that always differ — the dataset hint and the curated
  notes — with the same selector, three calls. The dry run showed that `select-mixed`'s
  third source (`values`) is an exact duplicate of its first on 326 of 498 Mini-Dev
  questions, because the value block only exists when the question names a literal; the
  trio was buying two opinions for three calls on two thirds of the set. The duo prices
  what the third candidate contributed.
- **A mixed arm now declares its own source list**, and `vote` must equal its length:
  the two fields were independent, so a mismatch would have spent three generations and
  reported two.

- **`withCallCounter`** (`@agentix-e/nl2charts-ai`): a provider wrapper that counts the
  calls it was asked to make, so a mechanism is priced by what it spent rather than by what
  its configuration implies.
- **The candidate ceiling.** An arm that generates several candidates now reports
  `candidateRecall` (how often the set contained a correct statement) and `selectionLoss`
  (how often it contained one and the arm returned another). A selector's score alone
  cannot distinguish "no candidate was right" from "the selector threw the right one
  away", and those call for opposite next steps.
- **`select-mixed`**: three candidates from three measured prompt styles — the dataset
  hint, the curated notes, and value grounding — then the same selector. The arm exists to
  separate *sampler* diversity from *prompt* diversity; the dry run fails if two of its
  sources build the same prompt, because three identical candidates agree unanimously and
  read as "diversity does not help" when there was never any.
- **`select-pair`** and `chooseCandidatePairwise`: the same three candidates compared two
  at a time in `k - 1` calls, which is the shape CHASE-SQL's selector has. The refactor
  that shares its rules block with the absolute prompt leaves that prompt byte-identical,
  so earlier `select` numbers stay comparable.

### Changed

- **`ai` bundle budget 35,000 → 36,000 gzip bytes** for the pairwise selector, reviewed
  and recorded in `budgets.json` rather than discovered by the gate.

### Fixed

- **A guard about the split fired on a sample of it.** The candidate-set feasibility check asked
  whether *some* question can build as many distinct prompts as the set has sources, and asked it
  of whatever `BIRD_LIMIT` selected — so a five-question run whose questions name no literal
  declared a correct arm broken and refused to start. That is the same sample-for-the-whole
  mistake the check exists to catch. It fires only on a whole-split run now, and a sampled run
  records `sampled: true` with a note saying what its duplicate count is a count of.

### Changed

- **The artifact records the instrument**: `run.timeoutMs`, `run.concurrency`, `run.retries`
  alongside `model`, `secondModel` and `judgeModel`. Two runs of one configuration that differ by
  deadline are not two measurements of one thing, and a 60-second deadline once made a slower
  model look like a broken endpoint. The gate rejects a report without them, a deadline under a
  second, or a concurrency below one.


- **`pnpm gate:all` was a third of the gate it claimed to be.** It ran five checks; CI ran
  sixteen. That is how a type error reached CI on a commit whose author had "run the gates" —
  the aggregate omitted typecheck, the tests, the coverage gate and three self-tests, and
  nothing said so. It is now the superset, and `tools/check-gate-parity.mjs` expands
  `pnpm <script>` through `package.json` and fails when CI runs something the aggregate does
  not, so the two lists cannot drift again.
- **A slower model was measured as an outage.** The provider's 60-second deadline was not
  configurable from the runner, and a `glm-4.5` run reported 1,355 of 1,532 cases "failed at
  the model … first error: llm call timed out" — the harness measuring its own patience.
  `BIRD_LLM_TIMEOUT_MS` now sets it (60s default, 180s for the cross-model workflow), and the
  outage message names the deadline when every failure is a timeout, because "busy endpoint"
  and "impatient harness" have different fixes.


- **A bug in the runner was recorded as a provider failure.** Every error that escaped a
  case's per-sample catch was labelled `llm`, so a `TypeError` in this file was reported as a
  throttled endpoint — the failure-share guard then blamed the model and the accuracy absorbed
  a defect. Errors are now classified by who threw (`escapeKind`): the provider keeps `llm`, the
  runner gets `harness`, and an arm with any harness error refuses to publish, because its
  accuracy would be a measurement of the bug. The gate also rejects an artifact that contains
  one.


- **The benchmark gate could not gate another model, so it did not run at all.**
  `bird-model.yml` skipped `pnpm gate:bird` because the accuracy floors were taken on
  DeepSeek — and that skipped the repair-funnel arithmetic, cost accounting, empty-lever
  checks and the A/A tolerance with them. Floors are now scoped by model
  (`baseline.floorModel`): a run by another model is measured rather than failed, and every
  structural check still applies. The workflow gains a `split` input and runs the gate.
- **The sample-size check was not split-scoped.** Every split was compared against
  Mini-Dev's 500 questions, so a dev run scoring 600 of 1,532 questions passed a check whose
  only job is to notice a shrunken sample. `baseline.scoredBySplit` states each split's size.
- **Every dev artifact named the wrong split.** The top-level `split` was the literal
  `mini_dev_sqlite` while `selection.split` said `dev`; nothing read the duplicate, so it
  stayed wrong. It is derived from the split now, and the gate rejects a report whose two
  fields disagree.
- **A cross-model arm did not record which second model wrote its candidate.** The artifact
  now carries `secondModel`, and the gate refuses a report that draws an `@second` candidate
  without naming the model behind it — `select-cross`'s 63.5% had no subject without it.

- **A connection that dies is not an answer, and it no longer ends a run.** Two failures
  escaped the provider's retry loop: a `fetch` that rejects, and a body that dies mid-read.
  The second one ended a 1,532-question dev run at case ~700 with `llm response is not
  JSON` and no retry, because the body was read outside the attempt. Both are retried now,
  like a 429. A body that arrives whole and is not JSON is still *not* retried — that is an
  answer from the wrong endpoint, and it is reported as such.
- **One case cannot take the run down.** A provider error raised outside the per-sample
  catch — the selector's own call, an engine call — used to escape the pool and kill the
  process. Every case now runs inside a guard that records the error as an `llm` failure,
  so the failure-share limit decides whether a run is publishable instead of a stack trace.
- **An outage on a voting arm was counted as three wrong statements.** Samples that died
  at the model were indistinguishable from samples the engine refused, so `no sample
  survived guard and execution` covered both and the accuracy absorbed the endpoint's
  mood. The two are now told apart, and the outage case is counted as `llm`.

- **The mixed-prompt guard was split-dependent.** It compared the three prompts on the
  first question of a split; the dev split's first question names no literal, so the guard
  failed a correct arm and stopped a 1,532-question run before a single model call. It now
  measures every question, fails only when a split can never build distinct prompts, and
  reports the degenerate share as a cost.

- **Two numbers in the benchmark report were derived from a field that meant something
  else.** `select5` published `repaired: 496` of 498 — samples per question, counted as
  repair attempts, on an arm with no repair loop — and the cost of selection was computed
  from generation counts, which excluded the selector's own call, so `select → select5`
  reported `extraCallsPerCase: 0` and printed as free. `attempts` now counts generations
  inside a repair loop and nothing else, `repaired` is reported only by an arm that has one,
  and every case records `calls` counted by `withCallCounter` around the provider. The
  gate rejects an arm whose mean calls do not exceed its sample count, an arm that reports
  repaired cases with no funnel, and an arm with no cost at all — and it caught the
  selector call missing from the first version of the counter, one run after it was
  written.

### Removed from the default chain

- **`inline+shape`**, measured at 57.2% against 58.4% for its parent (−1.2pp, 11/5,
  p=0.21). It fired on 21 cases, repaired 2, and pushed 14 more into the wrong column
  count. The trigger's precision, not the repair loop, is what fails; the arm stays in the
  catalogue with its numbers.

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
- **`plan`**: a query plan (scan, filter, join, group, answer) written before the
  statement — CHASE-SQL's second generator. Measured **−7.2pp** against its parent
  (63/27, p=0.0002) and moved out of the default chain: it anchors the statement to a
  join chosen before the columns are constrained.
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
- **Retry on 429 and 5xx inside the provider**, honouring `Retry-After`, and a runner
  guard that refuses an arm when more than 10% of its cases failed at the model: a
  throttled batch was reporting 4.6% where the same arm scores 35.9%.
- **`pnpm eval:preflight`**: one call before five hundred, so a refused key or a
  throttled account costs thirty seconds instead of an arm.
- **A second model, measured**: `glm-4-flash`, 250 questions, `names` 18.9% and
  `inline+evidence` 30.1% — with 20.9%/36.5% of cases failing as SQLite errors, against
  1.0%/2.2% for DeepSeek. Same harness, same pinned inputs; the weak model loses by
  writing statements that do not run.
- **An A/A pair on a deterministic endpoint returns 0.0pp** (75/249 twice, zero
  disagreements), so the published 0.2–1.2pp noise floor is a property of that provider
  rather than of the harness.
- **A model-ablation workflow** (`bird-model.yml`): the same harness and pinned inputs
  against another OpenAI-compatible endpoint, with the key passed as `LLM_API_KEY` and
  no DeepSeek floors applied.
- **Definitions are pinned**, not regenerated: `eval/baseline/definitions.minidev.json`
  holds the 11 database blocks, because the cache never hit and the model rewrote six
  of them per run, moving `synth-definitions` by 5.1pp between sessions.
- **A gate that notices a declared arm never running**: the baseline now lists the
  arms it expects, so an arm that is wired but missing from the run fails the build.
  `inline+retrieval` was such an arm for one release.
- **Retrieval over BIRD's training split**: BM25 over 9,428 labelled questions from
  69 databases, none of which appears in the split under test.
- **`pnpm bench:bird:recall`**: renders the prompt and checks that every identifier the gold
  statement names is visible — 100% on both splits (3,820 and 10,650 identifiers). A better
  linker cannot add information the prompt already shows, which is why the remaining gap is
  selection rather than retrieval. Runs in CI without a model call.
- **The dev split, measured**: 1,532 scorable questions of the split leaderboards report —
  names 42.2%, definitions + the dataset's hint **60.6–61.0%**, curated metadata 61.4–61.5%
  (two runs). Same code
  scores ~2pp lower on Mini-Dev, so the two are quoted separately.
- **A repair result that replicated**: three diagnosed retries are worth **+6.4pp** on
  `glm-4-flash` (249 questions, 16 won / 0 lost, p<0.0001, 0.63 extra calls per case),
  measured twice with identical case counts
  and **+0.4pp / −1.0pp** on `deepseek-chat` across two runs — where only 2.4% of first
  statements fail, so the loop has almost nothing to repair. It raises a floor, not a
  ceiling.
- **The raw error is worth 5.2 of those 6.4pp**: a control arm sending the engine's message
  with no class instruction, candidate or caret reaches 35.3% (88/249). The diagnosis adds
  +1.2pp (3 won / 6 lost, p=0.51), which is unresolved at 250 cases and kept as the default
  for what it adds on unseen schemas, not for a proven gain.
- **Diagnosed repair**: a rejected statement is retried with the engine's own error
  (SQLSTATE, position with a caret, hint), the identifier from the schema it probably
  meant — resolved through the statement's alias — and an instruction specific to the
  failure class. Nine classes, 900-character bound, **3 repairs by default** and
  configurable. Replaces the single sentence "that statement failed, try again".
- **A repair funnel and a price per call**: `firstPass`, `repaired`, `fixedByRepair`,
  `stillFailing`, `repairSuccessRate` and a per-class breakdown, plus
  `extraCallsPerCase` / `ppPerExtraCall` on every ablation, so a mechanism is priced and
  not only measured.
- **Engine errors keep their fields**: every adapter now records the driver's message,
  code, SQLSTATE, position and hint under `details.engineError`. The SQLite adapter's
  message was the constant string "sqlite query failed".
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
