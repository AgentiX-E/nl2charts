# Changelog

The eight packages share one version. Each entry records what changed and what was
measured, because a release note that only lists features is a release note that
cannot be argued with.

## Unreleased

### Fixed
- **The template ignored the card budget.** `schemaLines` reached `buildSqlPrompt` and
  `renderMacSqlCard` rendered every column of every table. The card now honours `limit` (default 40),
  counted one line per column and continued across tables, with three tests on the budget, the zero
  case and both entry points. The defect was real and **inert on this arm**: the budget the harness
  passes is 400, so the fix changed no prompt. What the arm actually sends is 12,668 characters
  against the parent's 2,604 — 4.9× — and that is the template's own card layout (`# Table: x` plus
  one bracketed line per column), not a truncation artefact.
- **The template reads 401/600 against the prompt's 386, and the criterion is not met.** Two runs at
  n = 600: +20 (61:41, p = 0.0594) then +15 (50:35, p = 0.1284) against `inline+evidence`; +21 and +20
  against the arm without our hint (p = 0.0355, 0.0330). The registered bar wanted 12 cases **and**
  p < 0.05 against the shipped prompt, so the template is not adopted on this evidence: the effect is
  about the size of what the hint is worth (+6, −1, −5 cases across three runs) and n = 600 cannot
  separate either. 14.2% discordance needs 1,775 questions for 2.5pp at 80% power; the dev split's
  1,534 resolves 2.69pp, which is the next purchase.
- **A whole arm failing inside the harness was published as an accuracy.** `macsql-prompt`'s first
  dispatch (`44974188185`) threw inside `promptFor` on all 600 cases — `assertTemplateCarries` read
  `decompose: false`, which `buildAskMessages` sets on every call, as a block it could not carry — and
  the table recorded 600 zero-second rows at 0.0%. `assertArmProducedResults` refused an all-`llm` and
  an all-`truncated` table and neither matched, so the refusal came from `assertReportComplete` naming
  the symptom (`its row carries no format profile`). It now refuses a table whose every row is a
  harness failure and prints the first error. The template guard treats a boolean lever set to `false`
  as off, and its test goes through `buildAskMessages` — the door the harness uses — with a second
  test that a real `decompose: true` is still refused.
- **The reconcile turn read the first fenced statement under a comment that said it read the last.**
  `extractSql` takes the first block; `parseDecomposed` takes the last; the reconcile prompt asks for
  a line per result group and then the statement, and a model that fences each group's statement had
  its correction read off group one — a candidate's own statement, which the funnel then counts as a
  restatement. `readStatement(text, { template, decompose, last })` now decides which block is the
  answer from the prompt that asked for it, and every harness caller passes the prompt it sent. The
  reconcile readings taken before this round are a floor for the mechanism, not an estimate of it.
  `extractSql` keeps its first-block default and gained a `last` option: the default is correct for
  the fifteen one-statement arms, and changing it would re-read every published artifact.
- **`--consume` prices the members of a pool, not only the subsets.** `--compositions` answered
  "which pool should I have bought"; the plan's next hypothesis was about one member, so
  `consumeOf(rows, source)` reads what that source scored alone and what it does where it
  disagrees with the modal group: `wins`, `losses` and the ceiling a perfect judge over the pair
  would reach (`vote + wins`). The vote is read on the rows that hold the source, so a case without
  one is outside both columns rather than a free point for the count.

### Added
- **A prompt is not a lever: `PromptOptions.template`, and MAC-SQL's BIRD prompt as the first one.**
  Every arm in `eval/bird/run.ts` adds a rule to `buildSqlPrompt`'s skeleton, so none of them can
  price the skeleton — and the gap that has survived every other explanation is 4.90pp on the same
  endpoint with the competitor's parts individually priced at a loss here. `packages/ai/src/template.ts`
  renders their prompt on our card: five constraints, two worked examples, and a sub-question-then-SQL
  shape whose answer is the last fence. The text is re-authored (their repo has no licence file) and
  three differences are deliberate and listed in `docs/benchmarks.md`: the card keeps the column type,
  the value examples are not compiled, and no selector prunes the card. `assertTemplateCarries` refuses
  a template combined with a block it has no slot for — at the arm declaration and at the builder — so
  an arm cannot name a mechanism it does not send. Bundle price: ai 77,000 → 83,000 B gzip, recorded in
  `budgets.json` and conditional on the reading.
- **`macsql-prompt` is dispatched beside `inline+evidence-nolink` and `inline+evidence`.** One field
  from the no-hint arm (a test pins it, including the field that cannot reach the prompt), so the run
  answers two questions at once: their prompt against ours as shipped, and against ours without the
  hint their template has no slot for.
- **`bench:bird:condition-gate`: the audit cannot be aimed, and the reason is in the question.**
  Six gates over what exists before the call (question, statement, schema) were scored against
  `missingConditions` — a label no gate's inputs carry. Bars registered first: precision ≥ 0.50,
  recall ≥ 0.40, fires on ≤ 25%. No gate clears: precision runs 21.7–29.6% against a base rate of
  21.3% (128 of 600), and the best gate's lift is 1.39× for 0.21 calls a case. **Of the 128 cases
  whose statement dropped a condition, only 37 (28.9%) state a comparison word** — the other 91
  imply it through domain language, which is why no lexical gate reaches them.
- **`--consume decompose` falsifies the dilution story.** `decompose` alone reads 369 of 593
  (62.23%) against the vote's 381 on the same rows; on the 95 disagreements it wins 16 and loses
  28, with the ceiling for a perfect judge at 397. It is not being outvoted — it is being outvoted
  correctly, and a 2.7pp ceiling behind four failed decision mechanisms is not a dispatch.
- **The next dispatch is registered: MAC-SQL's template as a source.** Their card rule loses 3.43pp
  here, their decomposition is already a source, their refiner fires on 6.7% of dev — what has never
  been run beside ours is their prompt. The bar is written in `docs/benchmarks.md`: one candidate,
  1.00 calls a case, ≥ 371 + 12 paired (p < 0.05), and ≥ 387 with it in the third slot.
- **A refused arm no longer takes the table with it.** `runArm`'s guards throw because the arm's
  table must not be read as a score, and the throw also deleted the table: on `44905985381` a
  twenty-four-minute, six-hundred-case dispatch ended with an artifact that said `cases: 0`, and the
  rows survived only in the log. The rows now ride out on the refusal — `withArmPartial` attaches
  them, `partialOf` reads them, and `runBird` calls `saveRefusal`, which writes the artifact **and
  then rethrows**, so the file is saved and the job still fails. The artifact carries a `partial`
  key naming the arm, its case count and the count of arms that finished, and `evaluateGate` returns
  exactly one problem for it instead of grading half a table: `3 of 3 cases correct` is 100% of a
  table that was never collected. `saveRefusal` returns `never`, so no caller can continue a run a
  guard stopped.

### Added
- **The 168 are relational, and value retrieval is worth 14 questions.** `bench:bird:gap` on
  `44917562527` splits the no-answer set into 121 `values` and 47 `column-count`, and
  `bench:bird:values` splits the 121 into 120 classified cases: `filter-wide` 28, `predicate` 21,
  `tables` 20, `filter-narrow` 18, **`literal-missing` 14**, `aggregate` 11, `projection` 5,
  `grain` 2, `literal-case` 1. The offline value-retrieval pass the plan carried can therefore win
  **at most 14 of 600 (2.3pp)** — under the noise floor of a 600-case A/A pair — while 69 of the 121
  are relational (wrong join, wrong key, wrong operator) and need a generator, not a retrieval.
- **`bench:bird:coverage-route`: the purchase cannot be aimed.** A fourth call on every case is
  priced and does not pay, so the remaining hope was to buy it only where the pool is empty. Reading
  `asked` and `candidateRecall` from the artifact and nothing else, the best of nineteen question
  features separates the 168 from the rest at **AUC 0.632** (`chars`), earning **+1.00pp** out of a
  leave-one-database-out fold and firing on **3.7%** of the corpus; the diverse-pool arm reads 0.618
  and +0.67pp. The criterion was registered before the run at AUC ≥ 0.70, ≥ 3pp and ≤ 80% bought.
  The cause is arithmetic rather than modelling: BIRD's median question is 79 characters and only
  3.3% reach the 150 the fold chose, so a length feature has no resolution. **Two routers, seven
  pool features and nineteen question features, best AUC 0.646 and 0.632: the features are absent,
  not weak.**
- **The vote counted statements that returned nothing.** `modal` filters empty candidates through
  `eligibleIndices` and the vote called `majorityResult` on the raw list, so two statements that
  returned nothing outvoted the one that answered. On `44897147794` that is **8 questions** and on
  `44889941650` **13** (9 of them won by the non-empty candidate), and it is the whole of the
  advantage the shape rule and the tie gate appeared to hold over the vote. `offeredCandidates(
  considered, true).offered` is now the vote's input pool in `runCase`, and `tools/pool-replay.mjs`
  drops the same candidates through `decidingPool` so that offline pricing and shipping behaviour are
  one rule. Corrected on the same 600 cases: `vote` **391**, `wider` **387**, `vote-unless-tie`
  **395**, `oracle` 406, against the selector's 383.
- **`wider` read the modal group's shape off its first member.** A fingerprint is `resultKey` hashed,
  and `resultKey` collapses duplicate tuples, so two members of one group hold the same distinct rows
  while differing in physical row count — a join fans one row out to six. `widerIndex` took
  `modalFirst.rows.length`, which made the rule depend on arrival order: 21 of the 600 modal groups on
  this pool have members that disagree this way and on 3 of them the fanned-out copy arrived first,
  so the rule skipped the wider candidate it exists to find. The group's row count is now the **fewest**
  any member returned — which is also its distinct-row count, since every member holds the distinct
  set with multiplicity at least one — and `tools/pool-replay.mjs` reads it the same way. The score
  does not move (387 before and after); the replay now reproduces `select-cross-pooled-wider` on
  **600 of 600**, where it disagreed on 1 before (`1066`).
- **`select-cross-pooled-wider-tie` withdrawn before it ran, and the bar it carried replaced.** It was
  registered at ≥ 390/600 against a vote of 377 and a shape rule of 385; over the pool that answered,
  the vote reads 391 and the shape rule 387, and the composition of the two reads 391 against
  `vote-unless-tie`'s 395. The shape rule was never ahead. `docs/benchmarks.md` now registers the arm
  that is left — `select-cross-pooled-tie` re-run on the corrected vote — at ≥ 400/600, with the
  arithmetic that makes the bar falsifiable: the corrected vote answers 391 of the questions the gate
  does not buy, the gate bought 39 and added 13, and none of those 39 is one of the 8 the repair
  recovered.

### Added
- **The third slot's information is not the constraint; the decision is.** `select-cross-diverse`
  swapped the value index for a decomposition at the same three generations and four calls, and the
  swap is a wash: coverage identical (432 of 600 both), the third slot solely right on **16 cases
  either way**, and the free vote 386 against the control's 390 in the same run (21 up, 25 down,
  p = 0.6587). The mechanism is the parity reading: `decompose` is as informative as `values` and
  *more disagreeable* — 401 one-opinion cases against 409, ties 47 against 41 — so it moves eight
  questions out of a majority and into a coin flip. The selectors in the same run say it from the
  other side: 27 down / 16 up on the cross pool (p = 0.1263), **39 down / 20 up on the diverse pool**
  (p = 0.0183). **The more informative the pool, the worse the judge.**


- **The bill for a candidate set, priced the way a policy is priced.** `pool-replay --compositions`
  enumerates every non-empty subset of a pool's sources and reports, on the same rows, its `calls`,
  its `vote`, its ceiling, the cases where it returned one result, and the cases where its top group
  is tied. On `44905985381` that reads 371 for one call (`metadata+evidence`), 374 for the best pair,
  **387 for the three-candidate pool**, against a ceiling of 421 — and 417 of 600 cases return one
  distinct result across three candidates. The unexpected column is `tied`: the best pair ties on
  **141** of 600 and the triple on **45**, because a two-member pool turns every disagreement into
  one. That is why the second call raised the ceiling by 30 questions and the answer by 3: an even
  pool is decided by arrival order on a quarter of the split.
- **`asked`: the question, its evidence, its database and its difficulty, per case.** `caseRows`
  joins them from the questions file the same way it joins `gold`, capped at 400 characters a field
  with `truncated: true` when the cap fires. Three dispatches have now been spent on an analysis the
  artifact could not hold — `rows`/`columns` for the shape rule, `chosen` for every policy
  comparison, and the question for the entire router family — and a field that is not recorded is an
  analysis that is not possible.
- **`trustOf` / `pool-replay --trust <arm>`: two answers to one pool, as a 2x2 and a feature
  ranking.** The vote against the selector is 362 both / 25 vote-only / **17 selector-only** / 196
  neither, exact sign test p = 0.2800 — the reading that made the free vote ship, as four cells
  instead of two rates. The features are scored on the 42 discordant pairs only, because that is the
  population a router would act on: the best of the seven the pool carries reads AUC 0.646, under the
  0.70 bar this repository set for spending a dispatch on a router.
- **`select-cross-diverse` and `select-cross-diverse-pooled-vote`: the third slot spent on a
  decomposition instead of on the value index.** `values` is byte-identical to `metadata+evidence` on
  474 of 591 cases, so the third vote restates a vote already cast on almost three quarters of the
  split and contributes 11 solely-correct cases. The arm is a swap at the same three generations and
  four calls, keeping the pool odd — the parity the composition table says is what makes a majority
  possible. Its bar is written in `docs/benchmarks.md` before the dispatch: coverage at least 421 of
  600, the third slot solely right on at least 11, and the free vote at least 387.

- **`--verify-wider`, and `verifyRule` underneath it: every policy that ran as an arm is checked
  against it.** The vote was the only rule compared to its own arm, and the rule nobody was checking
  is the one that had drifted. `verifyRule(artifact, arm, policy)` replays a policy over an arm's
  recorded pool and compares it case by case; `verifyVote` is now its default, `--verify-wider` is the
  second flag, and `VERIFICATIONS` is the table a new flag has to be added to. On `44897147794`:
  `wider` 600 of 600 agree, `vote` 592 of 600 — the 8 are the repair, and a check that agreed with
  them would be a check that certified the bug.
- **`tools/pool-replay.mjs` prices what shipped, in the shape the reader sees.** `decidingPool`,
  `artifactPath`, the `wider` policy row and a `wider` block of seven tests, a per-policy check for
  membership in `POLICIES`, and a fixture for a pool written before the shape was recorded — `rows`,
  `columns` and `chosen` all read as zero-or-absent rather than as `NaN`. The tool's own four numbers
  are **99.49 / 96.64 / 100 / 99.49** over 47 tests; the residue is the module-level entry guard,
  which no in-process test can enter.
- **`'wider'`: the first selection rule that reads the shape of a result instead of its text or its
  agreement.** Replaying the 600-question dev artifact `44889941650` against every free rule the pool
  admits turned up one the shipping set did not have: take the modal group, **except** where it
  returned a single row and a candidate outside it returned more rows in at least as many columns.
  It reads 385 where `chosen` reads 383 — and 387 where the corrected vote reads 391, which is why it
  ships as a choice and not as a default; it fired on 19 questions, was right on 10, and the vote was
  right on 2 of those 19. The mechanism is
  specific rather than fitted: a single-row consensus is what an aggregate answer looks like, and on
  those 19 the question wanted rows. `chooseCandidateByRule` routes it through `widerIndex`, the
  override is refused when the modal group already returned more than one row, and it is refused when
  the wider candidate is narrower in columns — a projection that dropped a column is not a fuller
  answer. One pool is a hypothesis, so `select-cross-pooled-wider` is the arm that holds it to a bar
  written in `docs/benchmarks.md` before the dispatch (≥ 385/600, strictly above
  `select-cross-pooled-vote`, and `selectorRule.rules.wider` ≥ 15); it ran 387 and the bar is
  withdrawn with the comparison that produced it.
- **`tools/fetch-artifact.mjs`, and the 401 that was a header rather than a wall.** The previous
  round built a readback branch because `/actions/artifacts/{id}/zip` answered `401`. It does not: the
  endpoint answers `302` to a signed storage URL, `urllib` and `fetch` forward the caller's
  `Authorization` header across that redirect, and the storage service refuses a token it did not
  issue — a valid signature failing because of a header the client added on its own. Dropping it on a
  cross-origin redirect returns `200` and the same bytes the Actions page downloads, which this round
  used to read two artifacts end to end. The tool carries the redirect fix plus a zip reader written
  against the format (Node's `unzipSync` is a gzip reader and answers "incorrect header check" to a
  real archive), refuses an entry name that would write outside the output directory, and is held by
  seventeen tests against a real HTTP server that refuses exactly what the storage host refuses.
- **The gate's price is a property of the pool, and the record now says which rule actually ran.**
  `select-cross-tie` was dispatched on `44889941650` against a protocol of ≥ 383/600, `calls.mean` ≤
  3.03 and `spend.asked` ≤ 0.05: it read **388/600** (held), **3.077** (missed) and **46/600** (missed).
  The bar was a constant from another pool — `41453395203` held 16 all-distinct pools and **1**
  two-candidate pool, so every tie there was three-way by construction, while this run held 41
  three-way and 8 two-candidate pools with 5 of the ties in the two-result bucket. The arm paid on 41
  three-way ties and 5 two-way ties, exactly the 46 cases whose pool returned all-distinct
  fingerprints, and `census` had been counting `tied` per bucket all along — the bar needed its total,
  not the one bucket that had a story attached. The reading also
  caught the artifact contradicting its own rows: `selectorRule` published
  `{rule: 'shortest', decided: 554}` for an arm whose gate answered by `modal` on all 554.
  `selectorRuleOf` is now a pure function with a census (`rules`) beside the declaration, `spend`,
  `selectorRule`, `poolRead` and `pairwise` travel through `tools/readback.mjs` — the first
  publication dropped `spend`, which is the field the pre-registration named — and the reading table
  grew the `paid` column those bars are written in.
- **`select-cross-pooled-tie` and `select-cross-pooled-wider`, because the last comparison could not
  be attributed.** `select-cross` scored 383 and `select-cross-tie` 388 in one run, but the arms drew
  their own candidates (`candidateRecall` 427 against 429), so the +5 is a pool difference and a gate
  difference added together. Both new arms read `select-cross`'s recorded pool, so the delta from
  `select-cross-pooled-vote` is the rule and the delta from `select-cross-pooled` is the gate: three
  policies decided on one pool, 0 + 0 + 46 calls against the selector's 600.

### Added
- **The selector's only net contribution is the 16 questions the vote cannot settle, and it now costs
  16 calls instead of 600.** `tools/pool-replay.mjs` prices selection policies offline from an
  artifact's own record, and its first line is a check rather than a table: the replayed modal rule
  reproduces the `select-cross-pooled-vote` arm on **600 of 600** cases, and the tool exits non-zero
  when that stops being true. On the 600-question dev pool the three cross-model candidates returned
  one result on 447 questions (the pool holds the answer 326 times), two on 137 (80), and three on
  **16** — where `majorityResult` has no majority and falls back to arrival order. Replayed over the
  split: `chosen` 378 (63.00%), `vote` 380 (63.33%), **`vote-unless-tie` 383 (63.83%)**, and the
  unshippable oracle over both 396 (66.00%). So the selector is worse than the vote wherever the vote
  can decide, better only where it cannot, and the policy that combines them is the only one above
  both of its parents. `select-cross-tie` (`gate: 'tie'`) is that policy as an arm: same candidates,
  same prompt, one selection call on a tie.
- **The readback channel, which was the actual blocker for three rounds.** `GET
  /actions/runs/{id}/logs` and `/actions/artifacts/{id}/zip` both answer `401` from a signed storage
  URL, so a dispatched 1,532-question reading existed only for whoever had a browser — a defect in the
  measurement loop, not in the metric. `tools/readback.mjs` writes the reading to
  `readings/index.json` on a `readback` branch through the contents API (one entry per workflow) and
  reads it back through `api.github.com`. The channel is exercised end to end in this round: the
  five-arm artifact was published as `bird-dev` and read back identically, and `bird-dev.yml` now
  publishes in an `if: always()` step that reports a failed post without failing the measurement.
- **Two fields the artifact was not recording, and the dispatch each one cost.** `cases[].candidates[]`
  gains `rows`, `columns` (what the selector is *shown*, and what a shape rule needs) and `chosen`
  (which member became the answer — `winnerSource` names a source, not a member). A repair turn that
  replaces the answer with a statement no candidate holds now marks **no** member, which is a reading
  rather than a gap.

### Added
- **BIRD dev R-VES has a number, a floor, and a correction to the story that number first told.** The
  metric was implemented last round; the reading is **56.63%** over the 600-question dev artifact this
  repository already held (arm `select-cross`, 378 correct of 600, 63.0% EX), five timings per
  statement, three full executions of the loop landing 0.07pp apart. It is not the leaderboard's number
  and the row says so in the same field it states the number in: the leaderboard files OpenSearch-SQL
  at 69.36 over all 1,532 questions, so `eval/benchmarks.ts` grew a fourth status, `partial`, which
  refuses a reading without a denominator (`scored` of `of`), refuses a "subset" that is the whole
  split, and prints `= 56.63 (600 of 1532)` on the log line a report quotes.
- **The gap between R-VES and EX was not the statements, and the floor is what proved it.**
  `eval/bird/ves.ts` grew `--self-check`: the same measurement a second time with every prediction
  replaced by its gold statement, which reads **57.96%**. The reward table steps at τ = 1 — it pays a
  quarter less for a ratio one percent under parity, and does not step up until τ = 2 — so a stopwatch
  that resolves 544 µs (the corpus median) to about one percent hands a quarter of the reward away on
  half the answers, and nothing pays it back. Of the 6.37pp between EX (63.0) and R-VES (56.63),
  **5.04pp are the table and the clock** and **1.33pp are the statements**. The previous round explained
  the whole gap with statement shape; two measurements refute that. A per-case cross-tabulation finds
  131 of the 145 statements in the 0.75 band carry exactly the gold's number of joins (9 more, 2 fewer),
  subqueries split 6 / 5, and the median τ of the cases that do carry an extra join is 0.86, inside the
  floor's own spread. Three estimators — minimum, median and MAD-trimmed mean over the same ten samples
  per statement — land within 1.5pp of each other, so the trim stays and the decomposition is not an
  artefact of the summary.
- **Nine leaderboards are now a table a gate reads, instead of a claim in prose.** "We cover Text2SQL
  and Text2Viz" was written as if running BIRD and Text2Vis meant standing on WikiSQL, Spider, nvBench
  2.0 and VisCodeBench too. `eval/benchmarks.ts` carries the nine rows with their corpus, their metric,
  and either a citation a machine resolves or the reason there is no number; `pnpm bench:coverage`
  resolves every citation and fails on a `measured` row without a number, an `absent` row whose reason
  is shorter than a plan, a percentage that is really a count (1,418 rendered figures were "1,418
  percent" in the first draft), and a required leaderboard that has disappeared from the manifest. The
  reading as it stands: four of nine carry a number over their leaderboard's denominator, four are named absences with a price, and the
  table is in `docs/benchmarks.md` next to the BIRD field table it belongs to.
- **BIRD's R-VES is implemented, and the clock it needed was wrong.** The reward table
  (1.25 / 1 / 0.75 / 0.5 / 0.25 over `tau = time(gold) / time(predicted)`), the outlier trim over
  repeated timings, both normalisations the literature uses, and a resolver that follows `winnerSource`
  to the statement the arm actually returned. Writing the first test found the defect: `oracle.py`
  reported whole milliseconds, most BIRD statements finish inside one, so both sides of the ratio read
  `0` and the metric would have paid its top band for the resolution of its own stopwatch. The oracle
  now reports `us` from the same stopwatch (`ms` stays whole, because a timeout budget is written in
  whole milliseconds), `timeRatio(0, 0)` is pinned to 1, and `pnpm bench:bird:ves` writes a reading.
  No number has been dispatched yet — that is a run, not a build, and the ledger says so.
- **The census prints the two halves of every candidate, and names the ones that are fitted.** The
  split has been in the report since the sweep learned to price cue tables — two disjoint halves of
  the scored population, fixed before the reading, so a candidate chosen for winning cannot also be
  chosen for fitting — and `assertCensusReport` refused a split that does not add up. Nothing printed
  it: the calendar ablation next door showed its halves and the thirty-four-table sweep showed only
  the total, so every `+7` arrived as a `+7`. Each line now carries the halves as a delta against the
  control and the word `fitted` when they disagree in sign, and the report refuses a `fitted` flag its
  own arithmetic contradicts. First readback on the 1,470 scored rows: `no-share` is `665` on
  `+8 / −7`, and `no-ranking` — the highest number on the board at `669`, five above the shipped
  table — is `+8 / −3`. Both are fitted, which is what the guard was built to say about them.
- **The sweep has a floor, and it is the first derived reading here to have one.** Every row in the
  thirty-four-table sweep is priced *against the shipped table*, so a change to the shipped table
  moves all thirty-three candidate totals at once and a number quoted from last round describes a tree
  that no longer exists. That is not a hazard in theory: the first draft of the paragraph above carried
  `671` and `677`, taken while a widening was applied to the shipped table, and a re-run on the tree
  the draft described prints `665` and `669`. `eval/text2vis/baseline.json` now records the shipped
  total and the four rows a decision is read off (`distribution-wide`, `no-share`, `no-ranking`,
  `no-histogram`), `tools/check-text2vis-baseline.mjs --census --require` compares them, and the gate's
  ten self-test cases include the one the old table could never show: a total that stands still while
  its halves trade rows.

### Changed
- **The tie gate is refused on its own numbers: 389 against a bar of 400, and 2 short of a free policy
  that costs nothing.** `44905985381` ran `select-cross`, `select-cross-pooled-vote` and
  `select-cross-pooled-tie` on the corrected code over 600 dev questions: **379 / 387 / 389**. The vote
  replay agrees **600 of 600**, which is the bar that says the repair reached the pool. Paired against
  the vote the gate is 3 wins and 1 loss (p = 0.625) for 45 paid calls — and the free rule that reuses
  the selector's recorded choice on a tie reads **391**, two above the arm that pays. On exactly the 45
  bought questions the paid answer was correct **10** times and the recorded answer **12**: the gate
  bought a worse opinion than the one already on file. The arithmetic that predicted 404
  (`vote` 391 + gate 13, disjoint sets) was wrong in its middle term because the 13 came from a tie set
  the empty-result bug had polluted. What ships is the free vote, eight above the four-call selector.
- **The refused widening was re-measured on the ensemble, on a branch, so `master` never carried it.**
  `distribution-wide` clears the rule arm (671 vs 664) and the halves (`+3 / +4`) and is the only
  candidate that has managed both; it was priced on the ensemble once and refused. The reading was
  re-taken end to end — a throwaway branch, a `text2vis-llm` dispatch, 1,470 cache hits, **¥0** — and
  the ensemble refused it again with a receipt: model arms unchanged (889 / 892), `ceiling`
  **1,020 → 1,014**, product 664 → 671. A ceiling bounds every policy, so `shipped` cannot rise while
  it falls. The change also costs 152 bytes of regex and puts `packages/chart` at 41,078 B against a
  41,000 B budget, so it fails three gates rather than one.
- **`ranking` is a bar-for-superlatives default, and that is now measured row by row.** Removing it
  reads 669 against 664 with halves `+8 / −3`; the probe `eval/text2vis/ranking-flips.mts` says the
  total is 98 rows of correct bar given up (55 pie, 21 line, 18 boxplot, 3 candlestick) against 76 rows
  recovered (41 pie, 26 line, 6 boxplot, 2 scatter, 1 candlestick). Both narrowings already priced lose
  (`share-ranked` 657, `ranking` before `share` 664 with no row changed); the unpriced one is a shape
  condition — do not fire when the only axis is temporal, which is where 39 of the 98 losses live.

### Fixed
- **The accuracy gate's tolerance was a constant from n=239 applied to every split, and one floor was
  guarding an arm the split does not run.** `4pp` was measured on 239 questions and then used on
  1,532, where the same σ-multiple is 1.58pp — so a dev arm could lose 3.9pp and pass a check whose
  whole job is to notice. `eval/baseline/bird.json` now records `toleranceAtN: 239` and the gate
  re-expresses the constant per split (`1.58pp` on dev, `2.78pp` on Mini-Dev, `2.10pp` on a
  600-question subset), using the harmonic mean of the floor's sample and the run's, which is the
  sample size of a comparison between two proportions; the A/A check reads the same number, so 5pp on
  100 questions is no longer called a disagreement. In the same loop, an *accuracy* floor on an arm the
  split does not run was skipped in silence while the ceiling loop refused that shape: `floors.dev`
  still carried `select-prune` at 60.4 after the arm became on-demand. The row is gone, the loop
  refuses one, and the fixture that proves it is in `--self-test`.
- **The comparison table started at 73.2% and called it the top, while the field's top was 5.3pp
  above it.** AskData's 78.49% dev EX lived only in the 600-question section, so the table sorted by
  1,532-question dev EX began at SQLConductor and the paragraph under it read "10.9pp to the
  leaderboard's top". Two claims were being made with one number: AskData trained nothing (GPT-4o,
  eight or more calls, profiling + task-aligned linking + result-set vote), so 16.15pp to 78.49 is a
  **method** gap, while 10.86pp to SQLConductor's 73.2 is what a fine-tuned Qwen3-8B policy buys.
  The row is in the table now, the bullet states both gaps and which one is about method, and the
  older "gap to published SOTA 9.2pp" line in the MAC-SQL section is corrected to 14.52pp.
- **A test asserted the tenths digit of a microsecond reading, which is true nine times in ten.**
  `expect(us % 1).not.toBe(0)` was meant to prove the stopwatch is not whole milliseconds, and it
  failed on a full run the first time the clock landed on a round tenth — a ten-percent flaky test
  asserting the clock's aliasing rather than the protocol. The invariant is now the one the protocol
  guarantees: `us` is a tenth (`|us * 10 - round(us * 10)| < 1e-6`) and `ms` is a whole number.
- **A peer that reported whole milliseconds was timed as if it had measured.** `oracle.py` sends
  `us`, but the decoder's `us ?? ms * 1000` fallback turned a coarse clock into a number R-VES would
  accept: every statement that fits inside a millisecond then reads the same on both sides, τ = 1,
  and the reward table pays 1.25 to every system for a question it never timed. That is the defect
  the `us` field was added to fix, reintroduced by the path kept for peers that predate it. The
  decode now records `usFromMilliseconds`, the timer answers `us: undefined` when that flag is set,
  and `measureVes` counts the case as `unmeasured` rather than as fastest. A real Python peer that
  sends `ms` alone is the fixture.
- **The coverage log printed a floor as if it were a reading, and a count as if it were a
  percentage.** `pnpm bench:coverage` printed `bird-dev = 62.5` (the floor a rerun may not fall below)
  next to documents that publish 62.34, and `text2vis top-1 = 664` next to a table that publishes
  45.17%. Both are quotable lines, so both now carry the kind of number they printed — `(floor)`,
  `(count)` — and the `bird-dev` line can no longer be copied into a report as the reading.
- **`uncovered` was two gaps under one word, and the larger one was a missing cue rather than a
  missing mark.** Forty of the corpus's ninety histogram rows were published as `uncovered` — the
  outcome that means no mark leads with the family — while the product demonstrably draws them, with a
  bar or a boxplot, and the corpus calls them histograms because the question names the *statistic*
  ("determine whether the distribution is skewed…"). `cueReachOf` asks `familiesOfMark` over every cue
  the shipped table can fire and returns the mark that would lead with the family and the cue that does
  it (`bar` + `histogram`, derived rather than named); a row it reaches but which never claimed the
  family is now `uncued`. The split is 48 uncovered → **8 uncovered + 40 uncued**; `hit` does not move,
  because this relabels a diagnosis rather than re-ranking. It matters because the two words prescribe
  different next steps: a missing mark is a capability to build, a missing cue is a widening — and the
  widening that would close these forty was measured at −16 three rounds ago.
- **A cue change is priced on the ceiling and the shipped path, not on the rule arm.** Widening the
  `distribution` cue to the statistics box plot questions are written in ("IQR", "outlier", "z-score",
  "standard deviation", "skew") reads **671** on the rule arm against 664 — 17 box plots won against
  6 bars, 2 lines and 2 scatters, and both halves of the corpus agreeing (+3 and +4), so the gain was
  not a property of which rows were drawn. Shipped, the same artifact reads `ceiling` **1,020 → 1,014**
  and `shipped` **843 → 841**. The rule arm gained seven rows while the union of the two arms lost
  six, which can only mean the rows a rule wins are rows the model already had and the rows it loses
  are rows only the rule held. Reverted; `distribution-wide` stays in the sweep with all three numbers
  in its note.
- **A histogram question over a table that is also wide in time was priced as a line by the census
  sweep, and the identity that compares the two counts said so.** Three of the 1,470 scored rows are
  both a histogram question and a wide table: `toChartIR` bins them before the melt, the sweep asked
  the melt first, and the control candidate therefore claimed **661** hits against the classifier's
  **664**. The identity had been reading 664 against the classifier since the histogram shipped and
  nothing else in the repository reads both numbers, so every ablation delta was off by up to three —
  the size of noise, which is how a broken instrument survives. Both `lead` and `fixedLead` now ask
  the bins before the melt, and a census test pins the row the identity stood on.
- **Transport retries were in lockstep, which is the one thing a rate limit punishes.** The wait was
  computed from the attempt number alone, so six calls refused in the same instant waited the same
  500 ms and arrived together, and the second attempt met the limit the first one did — a batch job
  reads that as "the provider is down" when the provider is only busy. `retryJitter` (0.5 by default)
  draws each wait from `[0.5d, d]`, so a retry never arrives earlier than the backoff promised, and
  the draw comes from an injected source so tests state the delay they assert. `Retry-After` is not
  spread: there the endpoint has stated its own window.

### Changed
- **An inferred histogram was measured and refused, and the refusal is now a test.** Reading
  `distribution` as "draw this distribution", gated on the table holding exactly one measure, priced
  at **+31 top-1** from an offline probe and at **−16** from the shipped instrument: +10 histogram
  rows against −13 bars whose family order became `['histogram','bar']` and −12 pies the bins reading
  pre-empts. The probe counted `family in families` — the shortlist rule — while top-1 reads
  `families[0]`, and it assumed a reading that returns first does not outrank the share reading.
  The gate stays on the word, and `test/histogram.test.ts` carries the arithmetic that refuses it.
- **`eval/bill.ts` reaches its 95% branch floor.** An armless BIRD case, a line carrying reasoning
  and cached tokens, a bill with no rows to name, and the `--json` output: 86.2% → 95.8%, and the
  eval ledger now reads 109 of 109 files at or above 95% on all four dimensions.

### Added
- **The push channel built twin commits, and the branch on the remote held content without
  history.** A commit's name is the hash of its tree, its parents, its author line and its exact
  message, and the channel sent `parents: [<remote head>]` when a local commit's parent is the
  previous local commit -- so no rebuilt commit could ever hash to the one it was rebuilding, and
  the remote received a twin each time. It also pushed `HEAD` alone, so the commits behind it were
  dropped. **Measured before the repair: 48 commits on `master` this clone did not have, 27 in this
  clone the remote did not have, 21 of the 48 twins carrying a tree no local commit has** -- states
  pushed from an uncommitted working tree, which CI measured and which no checkout could return to.
  Two documentation citations (`9ccf30d`, `f9c8e6e`) resolved here and 404'd there. **The numbers
  survived on content**: of 469 blobs on the remote head, 467 are byte-identical to the local head,
  two are documents since extended, and one is new, and every file the shipped baseline was
  measured on is the same object on both sides -- so `606 / 710 / 35` stands without re-measuring.
  The replacement replays the span commit by commit and asserts each hash (`createTree` against
  `<commit>^{tree}`, `createCommit` against the commit's own name), reads blobs from the object
  store rather than the working tree, and refuses to replace a ref unless every blob the remote
  carries exists locally or is contained line for line at `HEAD`. `git cat-file -e <remote sha>` is
  the detector, and it runs first.

### Added
- **The chart half's first external competitor reading, and the subtraction it makes possible.**
  Every number this repository publishes about the chart half has been a score against a corpus
  label, which means no reader could tell whether 41.22% was strong or merely alone. `flint-chart`
  1.1.1 (MIT, `microsoft/flint-chart`) is the deterministic recommendation layer inside
  Data Formulator, and `tools/flint-probe.ts` reads it on the same rows. **Measured: 309 top-1
  (21.11%) for Flint against 606 (41.39%) for this repository, on the 1,464 rows both can read.**
  The signature is the finding: `recommendChartTypes(data, semanticTypes, options)` has no parameter
  a question could be passed in, so the pair differs by exactly one input — the question — and the
  20.28pp between them is that input's price. That reframes the next round: a model reading the
  question has ~20pp to win, not ~60pp. Not added as a dependency, on three readings in order of
  weight: it would replace a 41.39% component with a 21.11% one, it pulls 91 packages and 163 MB
  into a package that depends on `spec` alone, and it answers a different question than the
  component it would replace. The probe lives outside `eval/` because it cannot be covered without
  the package installed, and a competitor's number is a fact to record rather than a test to pay
  for on every push.

### Changed
- **A year column with holes in it is a year column, and a scale is a column that steps by one.**
  Two typing rules, shipped together because each one alone is a wash. The calendar rule required a
  *contiguous* block of years and each row one year from the one above it, on the argument that a gap
  makes a year column indistinguishable from a price column that happens to be large — an argument
  that was never priced. A survey fielded every two years (`2002, 2004, 2006, 2008, 2010`) is a time
  axis with holes in it, and refusing it dropped the axis, refused every line and bar drawn over the
  table, and answered `scatter` from the measures that survived. Dropping that clause alone reads
  **+10 rows against −3** on the 1,470 scored rows, and none of the three it loses is a price column.
  The ordinal rule asked only whether a number column *repeated* inside a small range, and a
  cardinality is not a scale: with eight rows and four values `unique <= ceil(n / 2)` holds for any
  four-value column, so a survey's percentages per wave (`10, 12, 9, 14`) were read as an axis while
  the measure they carried disappeared — which is how a two-measure scatter was answered `heatmap`
  and a heatmap answered `scatter`. A scale steps by one, and the pair case that used to need its own
  predicate (`isPair` + `looksLikeScale`, deleted) falls out of it: `[1999, 2000]` is a scale,
  `[183.88, 40.72]` is a measurement. `isCalendarRun` is renamed `isCalendarColumn`, because the run
  is exactly what it no longer requires. **Measured: 606 top-1 (41.22%) against 588, shortlist 710
  against 686, on 27 rows gained and 9 lost — a paired comparison on the same rows, sign test
  p = 0.004.** Line 58.82% → 63.17%, scatter 23.66% → 27.96%, bar 57.42% → 55.46%.
- **The grading workflow defaults to the cheap instrument, and a floor reading can no longer be
  taken on it.** The round that priced the grader measured a full point of correctness between
  `glm-4.5v` and `glm-4.6v` on the same 178 figures (`−0.949 ± 0.358`), so the two are two rulers and
  not one ruler at two prices. `text2vis-judge.yml` therefore takes a `purpose` — `iteration` by
  default, `floor` on request — and its `model`/`think` defaults moved to `glm-4.6v` and `off`, which
  is ¥1.17 a full reading against ¥10.52. The floor is protected in three places rather than by
  discipline: `eval/text2vis/baseline.json` now records `judge.grader = { endpoint, model, thinking }`;
  a `purpose: floor` dispatch runs `tools/check-text2vis-baseline.mjs --expect-instrument
  "$LLM_MODEL@<mode>"` above the probe, so a mismatched dispatch dies at a name instead of after
  1,416 figures; and the post-run shape gate refuses a report whose grader differs from the floor's in
  model, endpoint **or decode mode**, unless the run is declared `--iteration` — which turns the
  difference into a note saying the means are a delta. The decode mode is in that comparison because
  the same model with the switch off costs a third of the same model deliberating.

### Added
- **A control card: what an instrument scores a figure that is not a chart, for one call.**
  Three vision graders were priced on the same 177 rows and the *cheapest* read highest —
  `glm-4.5v` 2.34/5.64, `glm-4.6v@off` 2.34/5.64, `glm-4.6v-flashx@off` 4.51/6.83, monotonically —
  and a mean over charts cannot say whether that is a lenient reader or a different one, because
  neither reader has a zero. `--control-only` supplies the zero: it sends the four-quadrant card
  through the run's own rubric (`JUDGE_SYSTEM`) and a corpus-shaped question, so a card with no
  title, no axis, no tick, no measure and no mark must be scored `0/0`, and every point above zero is
  an offset the instrument adds to every figure it ever grades. `eval/text2vis/judge.ts` reports the
  pair and the sentence that follows from it — *"so 4.50 of every mean it reports is leniency rather
  than signal"* — or the other sentence, when the card is charged nothing and the means are
  comparable as they stand. It is the cheapest question this evaluation can ask (one call, no corpus,
  no renderer) and the one that decides whether two instruments may be compared at all;
  `text2vis-judge.yml` therefore takes `purpose: control`, which runs a one-minute job of its own
  rather than a reading with a flag. `CallPurpose` gains `control` so the meter prices it as an
  instrument call instead of folding it into a case. **Measured, two calls, ¥0.002: `glm-4.6v@off`
  and `glm-4.6v-flashx@off` both score the card `0/0`.** The cheap instrument's two extra points are
  therefore not leniency — it does not reward emptiness either — and the gap between the two readers
  cannot be normalised away by subtracting a floor.
- **A store for answers already paid for, which turns a reading into a reading of the rows that
  changed.** Twelve full readings were taken in two days and every one of them re-graded all 1,286 or
  1,418 figures, including the ~1,280 whose PNG bytes and question had not moved since the reading
  before. `eval/text2vis/judge-cache.ts` keys an answer on the *content* of the call — the picture's
  SHA-256, the prompt, the model, the decode mode, the output cap, the temperature — and a second
  reading of an unchanged figure spends no call at all. The key carries the mode because the
  `--think` A/B reads the same figures twice, and a store that ignored the mode would answer the
  second arm out of the first arm's opinions: two identical means, at zero cost, and fabricated. The
  key carries the model because a grader swap is an instrument swap, and the cap because a reply cut
  at 1,024 tokens is a different answer from one that finished. The store is append-only and
  content-addressed, so a copied or restored directory can produce hits and never a wrong one; an
  entry that is damaged, off the 0-10 scale, or written under another `CACHE_VERSION` costs a call
  rather than a score. `--no-cache` spends every call again, and `eval/.cache/judge` is the default so the
  expensive mistake — a fresh reading that pays for 1,378 figures nobody changed — takes an argument.
  The artifact grows three columns: `cached` (rows answered from the store), `saved` (the tokens the
  store prevented, summed from the usage each row recorded when it was paid for), and `bill`
  (`{yuan, savedYuan}`), so a reading can be priced by whoever reads it and not only by whoever ran it.
- **A price table with a date and a source on every row.** `eval/price.ts` holds what the two
  providers charge — 元 per million tokens, read off their own pages on 2026-11-18 — and `billOf`
  charges a cache hit at the hit price (a fiftieth of a miss on `deepseek-flash`), clamps a claimed
  hit count larger than the prompt instead of billing a negative amount, and returns `undefined` for
  a model it has no price for, so a log prints tokens and says so rather than inventing ¥0.00. The
  judge's log now ends with `bill 1,171,852 prompt + 1,390,180 completion (1,366,108 reasoning) =
  ¥10.68 at glm-4.5v list price (2026-11-18)`, and `report.bill` puts the same two numbers on the
  artifact. `glm-4.6v` is on the table at half of `4.5v`'s price, which is what makes a grader swap
  one paired experiment rather than a paragraph of opinion.
- **`--max-calls <n>` and `--sample <n>`: a budget chosen before the run, and a sample that is the same
  sample in every arm.** `--abort-after` learns that the endpoint has stopped answering; `--max-calls`
  is the ceiling for a dispatch that would rather stop than discover a misconfiguration on row 1,400,
  and reaching it is a **red** run — `--limit` is how a sample is declared, and a sample publishes its
  unselected rows in advance. `--sample` takes every k-th row rather than a prefix, so two arms of an
  experiment are paired by construction and the same `n` is the same rows on every machine.

- **A paired ablation between two judge readings, because two means are not a delta.** The sixth
  reading is `3.44` and the fifth was `3.04`, and the difference between those numbers is not a
  measurement: the denominators differ by four figures and 140 rows changed mark. `eval/text2vis/ablate.ts`
  pairs the two artifacts by row id — only rows graded in both readings enter — and reports each group
  with the 95% interval of its **per-row differences**, `1.96 · SE`, not of the two means. On the
  fifth and sixth readings (1,470 scored rows, 1,411 pairs): the 140 rows the melt re-drew moved
  `chart_correctness` **1.78 → 5.91 (+4.13 ± 0.93)** and `readability` **4.61 → 9.19 (+4.59 ± 0.51)**,
  while every control group held its mean — bar 644 rows −0.08 ± 0.09, line 308 rows +0.02 ± 0.15, pie
  225 rows +0.11 ± 0.17, scatter 64 −0.08 ± 0.21, boxplot 14 +0.07 ± 0.38, heatmap 9 −0.44 ± 0.66,
  funnel 6 +0.83 ± 1.85. Seven control intervals include zero, which is the sentence that licenses the
  rest: the judge did not drift, so the group that moved is the change. Then
  `140 × 4.13 / 1,411 = 0.41` of the 0.39 the two means moved. The tool prints a control group that
  moved *before* the table, because a control that moves is a defect in the instrument and the gain
  cannot be read until it is explained.

- **The `--think off` arm, and the arm that measured nothing.** The cheap arm of the decoder A/B is
  dispatched as `44155803661` and is **void**: the account ran out at row 248, so no number about
  thinking is registered here or in `eval/text2vis/baseline.json`, and the two defects that run
  exposed are under *Fixed*. What the arm leaves behind is the bill that motivated it — 1,272,338 of
  1,294,167 completion tokens (98.3%) were reasoning — and the decision rule already written down.

- **A decode mode for the chart judge, because 98.3% of its completion is deliberation.** The fifth
  reading spent 1,294,167 completion tokens over 1,411 rows and 1,272,338 of them were reasoning
  before the model wrote two integers. `--think on|off` asks the endpoint for the mode (the LLM
  layer already carries `LlmRequest.thinking`, and `adaptRequest` removes it for an endpoint that
  never declared the switch), the artifact records it on the grader — `undefined` when the run left
  the choice to the endpoint, because "the endpoint decided" and "we asked for thinking" are
  different claims — and the log line says `thinking off` before the run spends its first call. Both
  arms are reachable from the command line because an A/B needs both: this is the one cost lever
  left in the instrument, and whether deliberation buys a better reading is a question only a paired
  run on the same figures answers.

- **The `series` channel, in the emitter that lacked it, and the reshape that produces one.** The
  contract has carried `encoding.series` since v3.0 and three of the four readers disagreed about it:
  `compileToECharts` grouped the radar and lines families only, `compileToMatplotlib` had no
  occurrence of the field, and `toChartIR` never set it. `seriesSource` closes the matplotlib side —
  one `plot` per group with a legend and a `None` where a pair is absent (a gap, never a zero), and
  side-by-side bars at `0.8 / groups` width — and the ECharts side now groups `bar` and `line` into
  one series per group with a scrolling legend, because a single series named after the *column*
  draws one line that walks back and forth and a legend that names nothing. `meltWide` reads a table
  that is wide in time (one row per entity, one column per period) as the long form it is, under five
  conditions — at least three period columns, exactly one non-period column, every period name reads
  as a period, every cell a finite number or absent, every entity once — and declines rather than
  renames a table whose entity column is already called `Year`, `Period` or `Value`. A figure without
  the channel compiles byte-identically to what it did before, which is asserted rather than assumed.
  `chart` 31,428 -> 33,851 B gzip (+2,423), ceiling 34,500; api surface 487 -> 489. Measured by the
  rule job of run 44149995497 on 27defec5, zero model calls: **111 tables melt**, not the 44 the
  census had counted — 107 of them were being charted as the wrong mark rather than refused, and the
  sharpest case is boxplot 43 -> 14, because a wide table with five columns fits a boxplot's tuple
  shape and five years were read as `min, q1, median, q3, max`. Top-1 **579 -> 588** (+0.61pp),
  shortlist 676 -> 686, declined 39 -> 35, figures 1,414 -> **1,418**, `failed 0`.

### Fixed
- **The `delta by family` line compared two different predicates and published the difference as a
  result.** The cue report counts a hit when the first mark of its leading cue *covers* the family;
  the profile report counts one only when the mark's **first** family is the label's. Subtracting one
  from the other printed `area -58` on the corpus — a claim that the result set made the area family
  worse — and it had been printed for two rounds. It did not: a line covers `area`, the cue table says
  so, and the strict count will not. The delta is now taken on the covering test the two readings
  share (`shortlist` here, `top1` there), which reads `area +21`, and `top1` stays strict and
  published on its own line where a reader can see it move. This changes no score; it stops one line
  from reporting the shape of a predicate as the shape of a corpus.
- **`bench:text2vis:ablate` paired two readings that two graders wrote.** A paired interval
  presupposes one ruler read twice, and the measurement above says two graders agree on 28% of rows:
  the ± would have been the width of a distribution no row belongs to. The tool now compares both
  artifacts' `grader` — model and decode mode — and refuses the pair with a message naming both, so a
  cross-instrument comparison has to be stated as a comparison of means rather than produced as a
  table of row differences.
- **The probe that decides whether an endpoint can see was itself a guessable, degenerate input.**
  `PROBE_PNG` was a 2×2 red square — 73 bytes, two pixels a side — and the question was "what is the
  dominant colour", answered with one word from a set of five. That is the hardest possible input for
  an encoder that resamples, and it is an answer a blinded model lands on often enough to matter: the
  cheapest arm dispatched, `glm-4.6v-flashx` at ¥0.55 a reading, was refused for saying `orange`, and
  the refusal had three possible causes with only one of them about the endpoint. The probe is now
  64×64 with four quadrants — red, blue, yellow, green in reading order — and a pass has to place all
  four, in reading order or clockwise; `red, blue, yellow` does not pass, and neither does a single
  colour. The refusal now names what the endpoint answered and what the quadrants are, because
  `orange` and `red, blue, yellow` send a reader to two different repairs. `sawRed` is replaced by
  `sawFourQuadrants`, and the eight probe tests were replaced by eleven.

- **A reading that asked for a decode mode and did not get one published the mode anyway.** `--think
  off` on `glm-4.5v` spent 178 calls and ¥1.31 grading 177 figures at 98.2% deliberation, exactly like
  the arm that asked for nothing: the vendor documents that model as **forced thinking**, so the
  request is accepted and the answer is indistinguishable from obedience. Two arms now say so twice
  over — same 177 rows, correctness `3.25` against `3.24` (`−0.006 ± 0.162`), readability `6.44`
  against `6.42` (`−0.017 ± 0.233`), bills ¥1.3148 against ¥1.3541. Three guards replace the claim:
  the vision probe now asks **in the mode the run will grade in** and reports the fields the adapter
  removed, a dropped `thinking` field ends the run before a second figure is graded and writes no
  artifact, and `assertJudgeReport` refuses a report that asked for a direct decode while spending
  more than `DIRECT_DECODE_CEILING` (a fifth) of its completion on deliberation. The capability row
  declares `thinkingSwitch: true` because the *transport* can carry the field, which is all that
  declaration ever meant; whether a model serves it is measured, and `glm-4.6v` — listed as deciding
  for itself, and priced at half of 4.5V — is where the lever now lives.
- **`--group all` reads a paired experiment as one population.** `pnpm bench:text2vis:ablate` cut every
  paired table by what the change did to each row (`melted` against `kept:<mark>`), which is the shape
  of a code change and the wrong shape for an instrument swap: a decode mode or a grader changes every
  row, so a grouped table answers a question nobody asked and the interval that decides is nowhere.
  `--group all` puts the paired rows in one group named `all` and prints the sentence that belongs to
  it, `no control group: every paired row was changed by this comparison` — calling that population a
  control would claim the instrument was held still by the very thing being priced. The flag reads no
  corpus at all when it is asked for, because a population reading is about the rows that were graded
  twice and downloading 6 MB of tables to count them is the cheap question priced as the expensive one.
- **A run whose calls stopped answering spent 1,174 calls on the answer it already had.** Run
  `44155803661` graded 244 of 1,418 rows and then asked an empty account 1,174 more times — thirty-five
  minutes of a runner, `429 余额不足或无可用资源包,请充值。` every time, and a `chart_correctness 2.58`
  printed at the end that read like a reading. `judgeJobsWith` now stops after `PATIENCE = 8`
  consecutive calls without a reply (`--abort-after <n>` to override), reports `{streak, attempted,
  reason}` as `aborted` in the artifact, and prints one line instead of 1,174: `stopped: 8 calls in a
  row without a reply; 8 of 1418 charts were attempted and 1410 were never asked about`. The reason is
  kept verbatim, because the difference between an empty account and a rate limit is in those words
  and not in the status code both share.
- **A stopped run is not a reading, and the exit code now says so.** `gradingExitCode` returns 1 on
  `aborted`, and the workflow's shape check refuses it too. A percentage could not do this job: the
  1,174 failures were over the one-in-twenty tolerance by accident, and a stop at row 1,400 of 1,418
  would have been inside it — the sixth reading's own two refusals must stay green, so the rule has to
  read the stop and not the share.

- **The chart judge exited 1 on every reading.** `report.failed === 0 ? 0 : 1` counted the two
  failures this repository cannot repair — a provider that answers 400 with a content policy has
  declined to look at a picture — and five consecutive runs concluded `failure` while publishing
  usable means, the last of them with 1,411 of 1,414 judged. The cost was not the red badge: the
  workflow's shape assertion, the step that re-reads the artifact and refuses a reading whose
  arithmetic stopped adding up, had to be given `if: always()` to run at all. `gradingExitCode` now
  separates the failures this repository controls (`truncated`, `unreadable`, `invalid-response` —
  red, however few rows) from the ones it does not (`refused`, `unavailable`, `call-failed` — green
  while at most one chart in twenty goes unmeasured, a declared `UNJUDGED_TOLERANCE`), and the log
  prints `not looked at: N of M charts, because the endpoint declined the request`.
- **A two-row table had no measure, so fourteen percent of the corpus drew nothing.** The cardinality
  rule asks whether a number column repeats inside a small range: `unique <= max(2, ceil(n / 2))`.
  With two rows that is `2 <= 2`, true for every pair of different values, so **every** measure in a
  two-row table typed `ordinal` — and a table with no measure is a table all ten admission rules
  refuse. **145 of the corpus's 1,985 tables** are exactly this shape: `Oman` and `Samoa` against
  seven year columns, `Finland` and `Spain` against one indicator. A pair is now decided by what its
  numbers look like rather than by the size of the table: `[1999, 2000]` stays a category (it is the
  pair the calendar guard already refuses to call a timeline) and `[1, 2]` stays an encoding, while
  `[183.8809395, 40.72624401]` is a measurement. Measured over the whole corpus: **145 rows gained a
  chart** — bar 64, pie 49, line 17, boxplot 9, scatter 4 — `declined` 205 -> 62, and 2 heatmaps
  became bars because a measure replaced one of their two category axes. Re-rendered: **1,414
  figures, 0 failed, 39 declined (2.65%)**.
- **A ranking question was drawn in the order the query returned its rows.** `Top products by
  revenue` produced bars in whatever order the result set carried them: the reader was asked to find
  the tallest bar themselves, which is the one thing a bar chart exists to save them. Of the corpus's
  **503** questions that rank something by the cue table and are drawn as a bar, pie or funnel,
  **287 (57.1%)** came back in an order the measure does not have. `rankingDirection(question)` reads
  which end the sentence asked about — the earliest ranking word in it, so a question naming both
  ends is ordered by the one it asked first — and `orderedAlong` learned a direction to match. The
  rule fires only when the axis is `nominal`: a year is not a contest, and sorting a time axis by the
  measure is the shuffle the line rule already refuses. After the change, **0 of 503** are out of
  order on a nominal axis and 84 stay in query order on an ordered axis by design.
- **Two paths carried the same rule and one of them ignored the direction.** A table with no measure
  is drawn from its row counts, and `countsOf` ranked those counts largest-first because that path
  predates the ranking rule. 35 of the corpus's 113 counted tables are asked a ranking question and
  one asks for the smallest ("What is the smallest number of countries ..."), which came back largest
  first. `countsOf` takes the direction now; an ordered axis still keeps the query's order.
- **The direction is read from its own word list, not from the cue table.** `readCues` answers a
  different question — whether a sentence ranks something *strongly enough to ask for a bar* — and
  that table is deliberately narrow because every word in it pays three points to a mark. Reading the
  direction from it made `fewest` invisible ("Which products have the fewest orders?" answered
  `undefined`, so the counted path stayed largest-first), while a sort loses nothing and can
  therefore be wider. Both tables stay; 702 charts are now ordered by a ranking word, 140 of them on
  words the cue table does not name (`greatest`, `fewest`).
- **The shape check never ran on the run that needed it.** `Hold the grading to its shape` had no
  `if:`, so run 44027154427 — which wrote a complete report and exited non-zero on two provider
  refusals — skipped the assertion that the report adds up. The step is now `if: always()`: the day a
  published reading is arithmetically wrong is the day the step above it exited non-zero.

### Measured
- **The two readings of the same corpus disagree on 73 of 1,470 rows, and the census is the one that
  is wrong.** `profileAnswer` asks the reshape first — a table that is wide in time is drawn as one
  line per entity by `toChartIR` without consulting an admission rule — and `classify` in the census
  ranks every table, so on the rows the product melts the census reports a mark the product never
  chooses (mostly `bar` for a wide table the product draws as a line). A row-by-row comparison puts
  the gap at **73 rows, 5.0% of the scored population**, and it is the direction that matters: the
  published `hit` is 606 and the census's is 599, so the diagnostic has been under-reporting the
  product for as long as the melt has existed. It is recorded rather than repaired here because the
  repair needs a decision this classifier does not have — which of `hit`, `substituted`, `outranked`
  and `refused` a reshape belongs to — and a refusal tally that counts a row no admission rule was
  asked about would be a second wrong number. The doc comment on `classify` states the size.
- **The heatmap's second axis had to be a label, and three ways of saying so were priced and
  rejected.** The rule was `dims >= 2`, and `dims` counts a time axis, so `month, region, revenue`
  was admitted and the product drew a heatmap wherever a period crossed a label. Reading the eleven
  figures it drew as heatmaps against their own labels found four matrices, and the rest mostly a
  numeric column that repeated and was typed `ordinal` — a measure standing where a label should be.
  Three repairs were measured on the 1,470 scored rows before one was written down: a heatmap whose
  two axes must be labels (top-1 **588 → 588**: a row-by-row dump of the variant against the tree
  showed not one answer moved, and no heatmap winner in the corpus carries a period — one run of the
  same variant printed 590, and every reproduction since reads 588, so that run is recorded as
  unreproducible rather than as a gain),
  a tighter `ordinal` — a scale is consecutive integers, not merely few distinct values — (588 →
  **587**: the scatter family, the weakest at 23.66%, gains eight correct rows and the bar family
  loses eight, and a net loss is a rejection however good the story), and the two together (587).
  None shipped. What shipped is the diagnostic: the rejected variants are recorded here, with their
  numbers, so the next round starts from the measurement instead of from the argument. The tighter
  `ordinal` is the promising one and it needs the bar half solved in the same change.
- **The instrument's noise floor, from two runs of the same instrument on the same rows.** Two arms
  were dispatched to price `glm-4.6v-flashx` and left a more useful number behind: `glm-4.6v@off`
  against *itself* on 177 rows agrees on **81.4%**, with a per-row standard deviation of **1.222** and
  a maximum disagreement of **10**, and a mean difference of `+0.040 ± 0.180`. That ± is the ablation's
  null interval, and it scales as 1/√n — ±0.06 at 1,411 rows. Anything a round claims below that is
  its own instrument. The same pair of runs also priced the cross-grader question: `glm-4.5v` and
  `glm-4.6v` agree on **28.2%** of rows while their means differ by 0.95, and `glm-4.6v` and
  `flashx` on 36.7% while differing by 2.15 — two readers, not one ruler read twice.
- **`glm-4.6v-flashx` passes the rebuilt probe and scores *above* both graders**: `4.51/6.83` against
  `2.34/5.64` (`glm-4.6v`) and `3.24/6.42` (`glm-4.5v`) on the same 177 rows, for **¥0.0251** — ¥0.20
  a full reading. It is not adopted: a grader two points above the two whose numbers the floor is
  defined against is a different scale, and with no gold standard nothing here can say which reader
  is right. The next round's first call is a null control — the probe card, which is not a chart,
  graded by the same prompt.
- **The answer store pays, and it had one way of restoring the wrong answers.** `44254362649` graded
  178 rows with **177 answered from the store, one call, ¥0.0008, ¥0.1468 saved**. The run before it
  restored the archive of a *default-mode* run into an off-mode reading: 178 answers downloaded, 0
  matched, 178 calls paid. The cache key now carries the model and the decode mode, and the
  branch-wide fallback that matched somebody else's ruler is gone.
- **A reading can cost ¥1.17 instead of ¥10.52, and the deliberation it drops is worth nothing on the
  model that serves the switch.** Four arms on one 200-row stride sample, paired within row. `glm-4.6v`
  with `thinking: disabled` returned **16.9 completion tokens per row, none of them reasoning**, for
  ¥0.1476 where `glm-4.5v` spent ¥1.3541 — `2.29` against `3.24` correctness, `−0.949 ± 0.358`. Its
  default decoder spent ¥0.5430 for `2.19`, which paired against `disabled` is `−0.101 ± 0.323`
  correctness and `+0.157 ± 0.264` readability: **both intervals contain zero**, so on that model
  thinking costs 3.7× and buys nothing measurable. And the half-price grader is a *different
  instrument*, not a cheaper one — a full point below `glm-4.5v` on correctness with or without
  thinking (`−1.045 ± 0.319`) — so published floors stay on 4.5V and iteration moves to the ninth-price
  instrument, where only a delta is claimed.
- **The cheapest arm was refused by the probe.** `glm-4.6v-flashx` (≈¥0.55 a reading) answered `orange`
  to a red probe image: one call, three seconds, no figures drawn. Recorded as a refusal rather than a
  result, with the one thing that would settle it — `PROBE_PNG` is a 1×1 image, which is the hardest
  input for an encoder that resizes.

- **The layout batch was worth +0.84 readability, and pies moved 3.40 -> 6.51.** Run 44096943698
  (`5c8942be`, `glm-4.5v`, 1,286 figures, one call per row): `chart_correctness 2.89 -> 3.04`,
  `readability 5.21 -> 6.05`, 1,284 judged, 2 refusals on the same two rows, no truncation and no 429.
  Per mark readability: pie **3.40 -> 6.51**, funnel 6.50 -> 7.17, scatter 6.46 -> 6.94, bar 6.24 ->
  6.65, line 4.45 -> 4.90, heatmap 2.27 -> 2.73, boxplot 2.17 -> 2.29. The pie move belongs to one rule
  with a label on it (`autopct`), and the correctness move is a finding: **pie 2.01 -> 2.69 and scatter
  2.63 -> 2.97 with no mark changed**, so the grader's reading of whether a figure answers the question
  is not independent of whether it states its numbers. A layout change therefore has to be read on both
  means. Shape behind them: correctness `249 308 349 53 37 17 16 12 23 61 159` (70.6% at 0-2, 12.4% at
  10), readability `4 20 119 130 143 133 115 125 195 242 58`. Tokens: prompt 1,063,617, completion
  1,294,167, reasoning **98.3%** of it.
- **The corpus reading moved for the first time by fixing a refusal: 530 -> 579 (36.05% -> 39.39%).**
  The rule that reads a pair of values as a measurement put 145 tables back on the page, and 49 of them
  hit their labelled family exactly: `top-1 530 -> 579`, `shortlist 623 -> 676`, **`declined` 167 -> 39**.
  The floors are raised by hand in this commit (`eval/text2vis/baseline.json`), and the render floor from
  1,286 to **1,414 figures (96.19% of the 1,470 scored rows, 17 gauge refusals, 0 failed)**. p50 render
  latency reads 116.5 -> **200.0 ms** per figure: the six layout rules, the ordering pass and 128 more
  figures, all of it CPU. Against the two constants any chart reading has to beat: `always line 26.60%`,
  `always bar 24.29%`.
- **The third full reading, and the first one billed in its own unit.** `glm-4.5v`, 1,286 figures, one
  call per row, concurrency 6: `chart_correctness 2.89/10`, `readability 5.21/10`, **1,284 judged, 2
  failed and both `refused`** (the provider's content policy on rows 1006 and 1007 — the corpus ships
  that text, and the same two rows were refused last run). The 4,096-token cap did what it was raised
  for: **truncated 24 -> 0**, and 429s **11 -> 0** at six in flight. The token account says something
  the two means cannot: **prompt 1,068,785, completion 1,269,082, of which reasoning 1,247,254 =
  98.3%** — the two integers this judge publishes cost about 22,000 output tokens in total and
  everything else is deliberation billed inside the same cap. Per-mark readability is where the layout
  work has to be aimed: bar 6.24, scatter 6.46, funnel 6.50, candlestick 9.00 against line 4.45, pie
  3.40, heatmap 2.27 and boxplot 2.17. No floor is set on either mean: readability has now read 4.67,
  5.12 and 5.21, and the step from the second to the third changed three things at once (cap, the
  90-degree tick tier, concurrency), so it is a reading rather than an ablation.

### Changed
- **Six layout rules, each taken from a complaint the chart judge made about a named row.** The 1,275
  graded figures were sampled for the population that isolates layout from modelling — `chart
  correctness >= 7` and `readability <= 4`, 67 rows — and four state the same things twice. `bar` now
  prints the value on the bar (`plt.bar_label`, `%.6g`, and **at most twelve bars**: the first
  version labelled all of them and row 195 came back with forty six-digit populations in one unbroken
  band above the plot, which is the tick smear moved onto the data). The y axis is written in the
  table's own numbers (`plt.ticklabel_format(style="plain")`), because `2.15 … 2.55` with a `1e6`
  badge floating over the title is two readings the reader has to multiply. A category axis
  announces at most twenty labels and stands every `step`-th one upright past that — row 195 had
  forty years in 13 pixels per slot. `plt.tight_layout()` gives the figure room for a five-line
  question and rotated labels instead of clipping them. A pie prints the share. And a tuple axis is
  titled with its five column names only while that title is 30 characters or fewer: `min / q1 /
  median / q3 / max` is a title, while row 99's slash-joined region names grew taller than the axes
  and clipped themselves against the figure edge. Every rule returns the emitted source byte for byte
  identical for a figure it does not apply to, so no earlier reading becomes incomparable. Six
  features, 902 B gzip, budget 29,400 -> 30,400. Re-rendered all 1,286 figures locally: **0
  failures**, PNG total 62.5 -> 65.5 MiB.

### Fixed
- **The histogram's remainder was one number for two denominators, and nothing had ever called the
  guard.** Publishing the shape carried `histogram.decimals` — rows "scored off the whole numbers,
  kept out of both rows" — and the assertion that the buckets plus that remainder equal `judged` read
  the correctness row only. A row scored `correctness 8, readability 7.5` is *inside* the correctness
  row and *outside* the readability row, so one remainder is at once false about the row that kept it
  and silent about the row that lost it. The remainder is now per dimension
  (`histogram.off.{chart_correctness, readability}`), the guard loops both dimensions, and each
  printed row carries its own `(+1 off the whole numbers)` instead of a sentence about "both rows".
  Found by writing the tests the guard should have had: the eval-coverage ratchet reported
  `eval/text2vis/judge.ts` at 99.39% lines and 98.19% branches because four guards shipped with no
  caller — the histogram check, the `NL2C_E_LLM_REJECTED` and `NL2C_E_LLM_INVALID_RESPONSE` mapping
  branches, and the `completion === 0` division. Back to **100.00 / 100.00 / 100.00 / 100.00**, on 108
  tests, with a table over every code `classifyFailure` maps and an assertion that an out-of-range
  integer lands in the remainder rather than in a twelfth bucket.
- **The buckets are tallied in a `Map`, not a dense eleven-slot array.** The dense form needs
  `counts[value] ?? 0` for an index the guard has just bounded, and that fallback is a branch no score
  can reach — a line that can only be covered by lying to the test. Sparse tally, dense row.

### Added
- **`pnpm db:probe` and `pnpm db:up` answer "which server is missing" with a command instead of a
  paragraph.** Thirty-three tests — 29 across the PostgreSQL and MySQL connector integration suites,
  and four in `test/leak-audit.test.ts` / `test/runbooks.test.ts` that point a URL at a real server —
  are `skipIf(url === undefined)`, so a machine without a database reports `5,340 passed | 33 skipped`
  and a coverage gate that is red on `packages/node` (83.74 / 88.21 / 94.55 / 83.74). Those two
  readings describe the same tree and cannot both be true; the gate is the one that says so.
  `tools/local-db.mjs` probes the two ports over TCP, `--start` runs `service <name> start` and then
  **waits for the port** — an init script returns before MariaDB accepts connections, and a tool that
  reports "down" about a server it just started is worse than no tool — and prints the two exports.
  Exit 1 when a server stays down, naming the files its absence removes. 14 self-tests over a real
  socket: a temporary listener proves the probe reads "up", the same port after `close` proves it
  reads "down", and the start/flag decisions are pinned through an injected `spawnSync`.
- **A message can carry an image, and the request it produces for text is byte for byte the request it
  produced before.** `LlmMessage` gained `images?: readonly LlmImage[]`, a typed channel beside a
  `content` that stays a `string` — not the union an OpenAI-shaped wire format suggests, because a
  union makes the wire shape the contract, gives a dialect that attaches images in a separate turn
  nowhere to put them, and turns "a text request is unchanged" into something tests have to
  re-establish instead of something the type cannot express. `wireMessages` writes `{role, content}`
  and nothing else when no images are present; a test pins the exact body an endpoint receives
  (`…"messages":[{"role":"user","content":"hi"}]…`). Three refusals, at three layers: `assertBase64`
  refuses a path, a URL, or a `data:` URL before the request is built (all three are strings that
  arrive as bytes nobody can decode); `adaptRequest` refuses an image to an endpoint that never
  declared `vision` with `NL2C_E_NOT_SUPPORTED`, because the alternative is a silent answer written
  from the text alone; and the judge's probe catches a declaration that lies. The meter counts images
  **apart from** characters — a 44 KiB PNG is about 60,000 base64 characters, and folding it into
  `chars` would publish a characters-per-token ratio of ~88,000 for a prompt whose text is 300
  characters. `transcriptOf` puts an image digest in the replay key, so a fixture recorded for one
  figure cannot answer for another. 26 new tests over a real socket.
- **`pnpm bench:text2vis:judge` grades the figures, one call per row, and refuses a blind endpoint.**
  Both dimensions — `chart_correctness` and `readability` — are asked in one prompt, so
  `calls === judged + failed` is an equality the report asserts rather than a budget it hopes for. The
  report carries two means and the counts behind them, and **no pass rate**: a grader's 7 has no
  calibrated threshold, so "7 or better" would be a cut invented after the fact and published to two
  decimals. Every row lands in exactly one of `judged` / `failed` / `notSelected` / `skipped`, and
  `judged + failed + notSelected === charts` and `charts + skipped === scored` are checked before any
  mean is read. Before the batch the instrument spends one call on a two-by-two red PNG: a grader that
  cannot name the colour stops the run, because a text-only model answering about a chart it never saw
  is the one failure the request path cannot detect once a dispatch has declared `vision: true`.
  `parseJudge` takes JSON, then the labelled form, and **never a bare pair** — an unlabelled `8 7` is
  two numbers in an order only the prompt knows — and refuses a score outside 0–10 rather than
  clamping it.
- **`eval/text2vis/baseline.json` gained a `judge` block with no threshold on either mean**, which is
  the honest part: nothing has been graded yet, so `compareJudge` holds the shape a reading must have
  (one call per attempted row, every row accounted for, both means on the 0–10 scale, a probe that
  named red) and prints the means without comparing them. The self-test count moved from 15 to 24.
  `.github/workflows/text2vis-judge.yml` is dispatch-only and re-takes the render in the same run,
  because a judge report is only comparable with a render artifact from the same corpus. The gate grew
  a twelfth check — a report that names no endpoint or model fails, because two means from two models
  are two facts — and the self-test moved from 24 to 26.
- **The judge's default provider became a declared table** (`JUDGE_ENDPOINTS`), with one row because
  one row is what has evidence behind it. It replaces a builder that named DeepSeek's base url,
  DeepSeek's model and `vision: true`: two of those three were false in the same way, and the only
  thing standing between them and 1,286 means about captions was the probe. A row carries the url, the
  model, the key's variable names, the image dialect, the temperature and the budget — every fact that
  differs between vendors in one place, so a second vendor is a line rather than a refactor. The
  `zhipu` row names `glm-4.5v`, sends bare base64, names **no temperature** (its documented range is
  not this repository's to assume, and an out-of-range value is a 400 on every row) and caps the
  answer at 1,024 tokens with 16,384 declared as the escalation ceiling. The probe now carries that
  temperature too — it used to name zero, so on this endpoint the check itself would have been the
  first thing refused.
- **A title is wrapped before it is drawn, because a question is a sentence.** The contract sets
  `ir.title` to the question — that is what makes a chart citable — and the emitter drew it on one
  line. The corpus's questions have a median of 203 characters and a 90th percentile of 355, and
  matplotlib's `bbox_inches="tight"` grows the figure to hold whatever it is handed, so row 4's
  figure was **2,808 × 483 pixels**: axes a fifth of the width, tick labels a smear. `wrappedTitle`
  wraps at 80 characters on word boundaries; a title that already fits is returned unchanged, so no
  short title's emitted source moved. The same figure is now 795 × 560. Found by the chart judge's
  first priced reading (`readability 2/10`), invisible to any metric that counts marks.
- **`profileRows(rows, columns?)` takes the table's column order, and an all-null column is not an
  axis.** `Object.keys` enumerates integer-like keys first, so a record built as
  `{Country, …, 2016}` enumerates as `[2016, Country, …]` — and a table with a year column was read
  in that order. **389 of the corpus's 1,464 tables (26.6%)** got a first column that was not the
  table's, and five chose an entirely empty year column as the category axis, emitting
  `labels = [None, None, None, None, None]` under `plt.xlabel("2016")`. `ChartIROptions.columns`
  carries the order for callers who know it, and `shapeOf` filters `distinct === 0` for callers who
  do not. The reading moved 529 → **530 (36.05%)**; the drawings moved for 389 rows.
- **`ImageDialect`: how an image is spelled is now a declaration, not a constant.** OpenAI documents a
  `data:image/png;base64,…` URL that carries its own media type; Zhipu's own sample for GLM-4V sends
  the payload alone. Both reach a model that can see, and only one is accepted by any given endpoint —
  and neither failure says which spelling was wrong, because a 400 reads as a bad key and a body of
  undecodable characters reads as a broken image. `HttpProviderOptions.imageDialect` and
  `wireMessages(messages, dialect)` take `'data-url' | 'bare-base64'`; the default is the spelling
  every request in this repository has been written in, so **a text-only request is byte-identical
  under either**, which a test asserts by comparing the two bodies. Four tests, two of them over a
  socket.
- **A failing endpoint's own words survive to the error message, including on a status that was
  retried.** `llm returned 429` is not a sentence anyone can act on: a quota, a concurrency limit and a
  model that is not enabled for this key all arrive as 429, and the vendor's body is the only thing
  that tells them apart. `LLM_UNAVAILABLE` now carries the body's reason (`llm returned 429:
  {"error":"quota"}`) and puts it in `details.detail` — the body was read only for a 4xx that was not
  retryable, so the one failure a batch job actually meets was the one it could not diagnose. Found by
  the chart judge's first production run, which printed the old message and nothing else.
- **`pnpm bench:text2vis:judge --probe-only` asks one endpoint one question and stops.** It needs no
  corpus and no render artifact, which is the point: a wrong base url, a retired model name, a key in
  the wrong secret and an image spelled the wrong way are properties of the *endpoint*, and they used
  to surface after 1,286 charts had been rendered. The judge workflow now runs it as its first step
  after install, and the report carries `grader: {endpoint, model}` so a mean is never quotable as a
  property of the charts.
- **`pnpm bench:text2vis:render` draws every chart, and the first run found ten percent of the emitted
  Python could not run.** `compileToMatplotlib` had 24 tests and **no line of its output had ever been
  executed**: the tests asserted which function is called with which column, and every assertion was
  true. The bridge to a judge is what forced the question — two of the public benchmark's four
  criteria are stated about the figure — so `eval/text2vis/render.ts` now sends the compiler's source
  to `eval/text2vis/render_worker.py`, which does what the reference harness does (`Agg`,
  `plt.show` replaced by a saver, `exec`) and saves a PNG. On all 1,470 scored rows the first run
  raised on **152 (10.34%)**: 135 bar charts whose categories arrived as a mixed object array and met
  the default float bar width; 16 boxplots calling `plt.bxp`, which is not a function, and then
  `Axes.bxp` without the `fliers` key it reads; 1 title quoting a price (`$100k`) that opened mathtext
  and never closed it. After the repair **1,286 reach a PNG (87.48%), failed 0, refused 17, declined
  167**, at **82.2 ms p50 / 137.0 ms p95 per figure**. The floor is recorded in
  `eval/text2vis/baseline.json` as the pair *(failed == 0, rendered >= 1,286)* and checked beside the
  top-1 floor by `pnpm gate:text2vis`, with 7 new self-test cases; the workflow installs a pinned
  `matplotlib==3.10.8` because the default style decides the bytes.
- **Four marks reach matplotlib, so nine of the eleven recommendable marks reach a figure.** `heatmap`
  (a matrix looked up by the cell pair, blank where a pair is missing), `funnel` (a `barh` with the
  first stage at the top), plus `boxplot` and `candlestick`, which the contract already had and the
  compiler did not. `boxplot` reads its five columns in `min, q1, median, q3, max` order and draws
  through `Axes.bxp`; `candlestick` draws a wick and a body, rising red by this project's convention.
  `gauge` stays out with a reason that names the contract rather than the plotting library: a gauge
  states a value *against a scale*, and this IR carries the value without the scale.
- **A heatmap with no measure for its colour is refused instead of painted.** Both axes of a heatmap
  are categories, and `compileToECharts` fell back to `y` for the value — so an IR with no `color`
  drew a heatmap whose colour was the region name: a picture of its own axis, which the linter called
  renderable because `supportOf` said nothing was missing. The verdict now names the missing channel,
  and the ECharts compiler no longer invents one.

- **`pnpm gate:text2vis` holds the chart reading to a floor.** The recommender's Text2Vis score moved
  five times in six rounds — 231, 414, 444, 495, 526 — and every move was checked by a human reading a
  log; nothing refused a run that came back lower. `tools/check-text2vis-baseline.mjs` reads the
  artifact `pnpm bench:text2vis:profile --artifact` already writes and compares it with
  `eval/text2vis/baseline.json`: **no tolerance** (the scorer is deterministic over a fixed corpus, so
  a fall is never noise), the **denominator compared for identity** (a truncated corpus scores a lovely
  percentage over 300 rows, and that is a different question rather than a worse reading), and **one
  floor rather than four** — `shortlist` can fall while `top1` rises, and `declined` can rise while
  `top1` rises when a rule learns to refuse a table it was drawing wrong, so those are printed rather
  than floored. 8 self-test cases pin the three failures it exists for plus the one it must not
  invent; it runs as a self-test in `gate:all` and with `--require` in the `text2vis-rule` workflow.

### Changed
- **A reply cut at the token cap is not a reply that named nothing.** The first full grading run
  (`43979969822`) judged 1,259 of 1,286 figures — `chart_correctness 2.90/10`, `readability 4.67/10`,
  one call per attempted row — and failed 27. Reading the replies, which is what the `reply` field
  exists for, shows 24 of them named `chart_correctness` and stopped at `max_tokens: 1024`
  (`{"chart_correctness": 1, "readability":`), on a model whose deliberation is billed inside
  `max_tokens`; the other 3 were provider content-policy refusals. All 27 were reported as `the reply
  named neither score`, which is false twice and sends the reader after a parser bug that does not
  exist. Four repairs: `parseJudge` counts the labels the reply did name; it takes the provider's
  `finishReason`, which `judgeJobsWith` was already receiving and dropping, so a `length` stop is
  named as a cap rather than inferred from a missing brace; `classifyFailure` maps the error's `code`
  to `truncated` / `unreadable` / `refused` / `unavailable` / `invalid-response` / `call-failed` and
  the report carries `failedByKind`, so `27 failed` prints as `24 truncated, 3 refused`; and
  `maxOutputTokens` goes 1,024 → 4,096, which costs nothing on the 1,262 rows that never needed the
  headroom because a cap is a limit and not a reservation. Two assertions in the suite expected
  "neither" for a one-label object — they had recorded the defect as correct — and the budget
  assertion no longer restates `1024` but reads `JUDGE_ENDPOINTS[0]?.maxOutputTokens`, so the number
  appears in one place. `baseline.json` registers the means with **no floor**: a floor needs a noise
  estimate and there is one reading. 4 new tests over the truncated shape, the cap sentence, the
  classification and the count.
- **The corpus reading is taken on the question, not on the conversational turn it arrived in.**
  `eval/text2vis/dataset.ts` read the `Prompt` column — the reference harness's whole turn, with the
  table inlined — and called it `prompt`, so every rule reading in this repository was a reading about
  "the question and the data". The corpus prices the mistake: a table headed `Projected share of the
  population` contains **share**, the cue that names a pie. On the same 1,470 scored rows the cue table
  reads **627 (42.65%) on `Prompt` and 575 (39.12%) on `Question`**, while the shipped entry point reads
  **526 (35.78%) → 529 (35.99%)**: the arm that never sees the result set was the arm the table's words
  were fooling. The gap this project has tracked between the product and its own cue table therefore
  survives at **3.13pp instead of 6.87pp** — the finding is unchanged and half its size was the
  instrument. `prompt` is now the `Question` column, the loader refuses a file with no `Question`
  column exactly as it already refused one with no `Prompt`, and `modelPrompt` keeps the pre-built turn
  because an LLM arm reproducing the reference harness has to send it verbatim.
- **A line over a category axis runs along the measure, and no longer throws.** The line admission was
  widened to admit a category axis on the corpus's own words ("plot these percentages in order of
  increasing Value ... on a line chart"), and `encodingFor` kept reading `shape.ordered[0]`, which is
  empty for a nominal axis: **106 of the 1,470 scored rows reached a `TypeError` instead of a chart**,
  and no reading could see it because `recommendChart` — the only function the readings call — never
  reaches the branch. `toChartIR` now orders those rows by the measure, ascending, with tied values and
  non-finite cells keeping the order the query returned; a measure with a `NaN` still keeps its row,
  because dropping it would change how long the line is.
- **The third ranking key was deciding accuracy → the time-axis bonus.** *(unchanged from the previous
  entry, kept for the lineage of the number)* top-1 495 → 526 on `Prompt`.
- **A time axis is a fact about the result set, not a tie to break.** Bar and line both need an axis
  and a measure, both scored two, and `bar` is first in `RECOMMENDABLE_MARKS` — so **every** question
  that named neither mark and had a time axis was answered with a bar, because the third ranking key
  (the preference order, which exists for determinism) was deciding accuracy. On Text2Vis `line → bar`
  was 164 rows, and the 47 of them that fired no cue at all are the pure form: the corpus labels those
  47 exactly in half, 47 bar and 47 line. A line states the interval between points and a bar does not,
  so when the axis is a time axis the line's admission now carries a **bonus of three points** — a
  cue's rate — reported as `profile:time-axis` in `reasons`, so `score` can still be recomputed by
  hand. Measured on the same 1,470 scored rows: top-1 **495 → 526 (33.67% → 35.78%)**, shortlist
  560 → **618**, declined unchanged at 167, `Line` 126 → **164** of 391. Two decisions were measured
  rather than argued: **paid in the score, never in the primary key**, because an ask has to outrank a
  fit — the first version put the axis in the key and a table of daily open and close prices stopped
  being a candlestick, since `volatility` *asks* for one; and **three points rather than two**, because
  two tied with a cue that names the bar second (513 rows, +1.22pp) and three wins those back. The
  per-row A/B over all 1,470 rows is the evidence that this is a repair: 1,212 answers identical, 91
  changed, **0 changed outside the single-time-axis domain the rule names**, 38 became hits and 7
  stopped being hits.

### Added
- **The Text2Vis instrument reads the one table in nine it could not.** 196 of the corpus's 1,985
  `Table Data` cells are not CSV: they are a JSON object of columns — `{"Year": [2018, 2019], "Coal":
  [1000, 950]}` — because the prompts around them ask for Python and the table was written the way
  Python prints one. `parseCsv` read the whole object as a one-line header with no rows, so the
  profiler had no columns, `profileAnswer` returned `profile:none`, and **164 of the 352 declined rows
  the published reading carried were this** — a parser defect filed as a product refusal, in the
  direction that flatters nobody but is invisible to any rerun. `parseResultSet` now answers three
  ways rather than two: a brace that is not JSON falls back to the CSV reader (a table whose first
  header cell starts with `{` is still a CSV), a JSON object of equal-length scalar lists is
  transposed with key order as column order and an absent cell kept absent, and a JSON object that is
  not a rectangle — unequal lengths, a non-list value, an empty column, a list of lists, or an array
  of rows without a header — is **refused rather than padded**, because padding invents a row and
  naming an array's columns invents a field. Measured on `pnpm bench:text2vis:profile`, **the same
  1,470 scored rows**: top-1 **444 → 495 (30.20% → 33.67%)**, shortlist **34.56% → 38.10%**, declined
  **352 → 167**, `census`'s `header-only` tables **197 → 6**. The denominator did not move, and the
  claim that this is a repair rather than a re-tune is a per-row A/B: over all 1,985 rows, **1,777
  answer identically, 208 changed, 0 of the changed rows had a non-object cell, all 208 went
  `declined → answered`, and none went the other way.** The 189 rows that now score are hits at
  **26.98%**, *below* the reading they joined, which is the number that says the repair admitted the
  hard ninth and not the easy one. 8 new tests pin the three answers and the five refusals.
- **A result set with no measure is charted by counting its rows.** The largest bucket on the Text2Vis
  side was not a ranking problem: of 1,470 scored rows, **414 were refused by every mark** and 268 of
  those tables carried no measure at all — a grouped query whose answer *is* the count ships one
  categorical column and no number, and the admission sentence `a bar needs a category axis and a
  measure` was true and useless. `shapeOf` now synthesises the measure every such table has, under two
  conditions that keep it a measurement rather than a licence to draw: the caller states the row count
  (`RecommendOptions.rows`, because "does this category repeat" compares a distinct count with a row
  count and a `FieldProfile` holds only the first), and at least one dim repeats (a count over unique
  values is a row of equal bars). `toChartIR` materialises the fold — the contract has no transform
  channel, so the counts arrive as data and the ref carries `aggregate: 'count'`, which is how a reader
  tells a folded column from one called `count`; a result set that already holds that name gets
  `count_2`. Measured on `pnpm bench:text2vis:profile`, same 1,470 rows: top-1 **414 → 444 (28.16% →
  30.20%)**, shortlist **32.45% → 34.56%**, declined **432 → 352**. The refusal-to-hit split is the
  finding and it is recorded rather than summarised: of the 68 rows that stopped being refused, **30
  became hits and 37 were admitted and outranked**, so the admission rule was half the gap and the
  ranking — invisible while the table was refused — is the other half. 8 new tests pin the boundary
  (no row count, no repeating dim, a collision on `count`, ordering, limit-after-fold, two-axis
  grouping, and the untouched path for tables that do carry a measure), and `packages/chart`'s
  `recommend.ts` is at 100% of statements, branches, functions and lines.
- **The arm that carries the rebuild, and the two things it does that the lever list does not say.**
  `askdata-shape` is one lever from `select-mixed-rule` — same three sources, same prompts, same free
  rule, same judge — and its only difference is `arm.askdata`. Wiring it exposed two decisions that a
  reading of the arm table would get wrong. First, the link runs *before* every other card decision,
  because a rule that narrows the card afterwards would be reading an already-narrowed card and its
  cost would be filed under the wrong lever. Second, the union is computed once per question and
  applied to **every** source's card: a mixed arm whose three candidates answered on three different
  schemas is a delta about which source was drawn first, not about linking. Both are pinned on the
  real harness rather than on a unit test — `test/bird-run-e2e.test.ts` drives the parent at **3.00
  calls a case** and this arm at **8.00**, which is five variants and three candidates with no
  rewrite needed on the fixture's statements. The cost is why the arm is on demand and not in the
  chain: it triples the bill of every push, so it earns its place with one reading against the
  criterion `docs/benchmarks.md` registered before the code existed. The catalogue and the runner are
  also made to agree about the new field: `test/bird-arms.test.ts` lists every field of `Arm` as a
  lever and refuses one that no code reads, which is the defect `reconcileAdopt` carried until that
  test was written.
- **The linker of the leader no one can run, rebuilt from its paper.** `AskData` holds the top BIRD
  row this repository compares itself to (dev 78.49%, test 83.40% as the leaderboard read it) and has
  never had a release: the arXiv page carries no artifact link, a repository search for the name
  returns unrelated products, and the one repository whose description names the method is a stub.
  `eval/bird/askdata.ts` now implements the three steps of `arXiv:2505.19988` §3 that the paper
  actually pins down — a shingle index over up to 10,000 distinct values per field, so a *literal*
  can be resolved to the fields that store it (this repository's `values.ts` resolves only an exact
  equality, which cannot see `'Office Of'` against `'Office of'`); the five schema variants (focused
  or full, minimal or maximal profile, and focused-plus-full) each writing one statement, with the
  **union** of the fields those statements read as the linked schema; and step 2.d, which refuses to
  leave a literal in a field that cannot hold it — the fields that do hold it are added to the card
  and the model is asked once more, up to `MaxRetry`, which is a parameter here because the paper
  does not state its value. 36 tests, 100% of statements and lines, 95.4% of branches, no model
  called: the loop is driven by a scripted generator, so the tests hold the call count (five, and a
  sixth only when a literal has nowhere to live) and the text of the prompt that follows. What this
  is worth is not claimed: the paper's own ablation prices *their* linking at +2.0pp without hints
  and +1.8pp with them, for +6.2pp if it were perfect, so the arm that carries it is a measurement
  and not a replication, and no number from it may be filed under their name.
- **OpenSearch-SQL joins the competitor register, which is what makes it a task.** The strongest
  training-free system on BIRD (69.3% dev, 72.28% test) was cited twenty times in `benchmarks.md` —
  the SQL-Like intermediate language, the result-set equality vote behind `resultFingerprint` and
  `vote-cross`, the self-taught CoT triples are all ported here — and it had no row in
  `eval/competitors/intake.json`. That is not a missing line: `intakeGaps` can only report claims the
  file holds, so `released and unpinned` never named it, and "copy it in pieces rather than dispatch
  it" was a paragraph no machine had read. It is registered at `eaed67e8`, MIT, with the two
  obstacles written into the row so a dispatch can be argued against them: value retrieval is an HNSW
  index over cells and column names, which needs an embedding backend this repository cannot reach
  today, and its 69.3% was GPT-4o's, so a same-endpoint number has to be re-run on `deepseek-chat`.
- **`layoutForSplit`: an artifact is read as the benchmark it says it scored.** The coverage ladder
  was loaded against Mini-Dev's questions file while reading a dev artifact, because `resolveLayout`
  defaults `BIRD_SPLIT` to `minidev` and the reading never consulted the field the artifact has
  carried since it was added. Both splits number their questions from zero, so 313 of 483 no-answer
  cases were dropped as unknown and the other 170 were looked up **successfully** and classified
  against a different benchmark's gold statements, on Mini-Dev's copy of a database of the same name.
  Nothing errored: a wrong id is a drop, a shared id is a reading. The gate could not see it either —
  `valuesProblems` stated its criterion as a share of the rows that survived, so losing 313 cases
  *raised* the number it printed, 98.8% over 170 rows against the true 99.6% over 483. Four
  instruments carried a hand-written copy of "the artifact wins", and three of them re-resolved with
  the caller's directory pinned as `BIRD_DATA`, which asks for `dev.json` inside the Mini-Dev
  directory; ten more loaded questions without consulting the artifact at all. One function, fourteen
  callers, and the artifact wins. No published score moved — `bird-dev.yml` sets `BIRD_SPLIT: dev`
  job-wide — but the previous round's work queue was derived from the wrong reading and is replaced.
- **`artifactSplit`, so the oracle's databases follow the split too.** `bench:bird:agents` and
  `bench:bird:differential` build the oracle before they parse the artifact, which is when the
  split's database directory is chosen; reading the field on its own is one predicate in one place
  rather than a second parse per tool.
- **`bench:bird:rules`: the free-rule space, priced in one reading.** The fourth candidate left a
  question sharper than the one it answered — 2.02pp of ceiling sits in the intent pool and
  `shortest` converts 92.92% of it — and the obvious way to answer it was an arm, 1,532 questions
  times four calls per rule. Every rule is a function of two fields the artifact already writes, so
  fifteen variants are priced for nothing: the three shipped rules read through `consensus.pick`
  (which a test holds to `chooseCandidateByRule`) and twelve that no pipeline runs. **None beats the
  shipped rule.** `chars-no-quoted` ties at 994 on the three-candidate arm, everything else is
  behind, and `longest` is 5.55pp behind (won 37 / lost 122). The one arm where anything leads is
  the four-candidate knowledge arm, `identifiers` at 64.56% against 64.16%, p = 0.4514 — inside the
  noise and inside the 0.0042 Bonferroni bound that twelve variants cost, which the harness prints
  instead of the raw p because the smallest p in a family of twelve is the one most likely to be
  noise. The negative result is the finding: the 3.20pp the three-candidate arm loses to its own
  ceiling is not recoverable from anything the artifact records, so the next lever is generation.
- **A `.d.mts` is a class of change that cannot move a number.** The push that fixed a missing
  export in `tools/ci-scope.d.mts` bought thirteen BIRD arms over 496 questions (~6,400 completions)
  and three live passes over 210 cases: a declaration is a TypeScript erase product, so nothing it
  holds survives to runtime and no prompt can read it. `ci-scope` now exempts the suffix rather than
  a directory — the fourth entrance to this hole (empty file, non-Markdown file under `docs/`, root
  configuration) and the first fixed by adding a class instead of a condition. Its guard is
  `test/tool-declarations.test.ts`: both directions between every declaration and its module, plus
  the list assertion that both directories holding one (`tools/`, `eval/bird/`) are covered, because
  the first version of that guard scanned only where the failure happened. Verified by mutation:
  deleting a declaration line, dropping the second directory, or removing the class from the filter
  each turn a named test red.
- **A cue that names the binned measure.** `familiesOfMark` has said since it was written that a bar
  stands in for a histogram *when a cue that names the intent put the bar there*, and no cue emitted
  the kind — so the widening was unreachable, `"show a histogram of revenue"` was answered `boxplot`
  by the `distribution` cue, and 73 corpus rows sat in `uncovered` where the product had answered but
  could not say what. The candidate fixing it had been in the sweep for two rounds and been rejected
  twice on "±0, therefore nothing"; the missing column was the shortlist. Shipping it moves **24 rows
  into the shortlist with no change in top-1** (`414` either way), and its ablation is now read on
  every census run: `no-histogram` = 414 → 414 hits, −24 shortlist. Bundle +279 B gzip (both module
  formats), budget 23,000 → 23,500 with the measurement recorded.
- **A column of years is a time axis in either transport.** `inferType` read `'2019'` as `temporal`
  through `PERIOD` and `2019` as `quantitative`, so the same column lost its axis when a driver handed
  over a `YEAR` instead of a CSV — and every bar, line, pie and area over it was refused. The new rule
  reads the shape of a timeline instead of the size of its numbers: `isCalendarRun` requires every value
  to be an integer, no value to repeat, the distinct values to be a contiguous block inside 1900–2100,
  and the rows to read one year apart. On the 1,470 Text2Vis rows this moves the product **362 → 411
  (24.63% → 27.96%)**, +53 rows converted against 4 lost, both halves up (22/2 and 31/2), and the
  diagnostic that counts time-formatted columns typed as measures falls from 165 rows to 51. The bucket
  it came from is the point: 175 of the 209 tables registered as "no axis at all" carried a year run,
  so the capability the plan asked for would have invented an axis for tables that already had one.
- **The ablation of a shipped rule runs on every census, not once.** `census` now un-types the columns
  `isCalendarRun` accepted, re-ranks the row, and publishes `converted`/`lost` with the two halves, so
  the price of the rule is measured against the tree that ships instead of against the commit that
  introduced it. `assertCensusReport` refuses a report where the count does not reconcile
  (`hit − converted + lost`), where the halves do not add up, or where the rule moved more rows than
  carry a column it reads.
- **A ceiling, published as a population rather than as a score.** 34 tables offer no column a mark can
  group by, and 30 of them are refused a mark that needs one (13 line, 7 area, 5 bar, 4 pie). That is
  the most an index-axis encoding could ever buy, so it is counted and printed beside the hit share
  without entering it — after the typing fix it is a ceiling, and before it was 177 rows that were
  85% a type-inference defect.
- **The slice cap is twelve, and it is the first value that was measured.** `maxSlices` defaulted to
  seven and no reading had ever priced it. The census now prices the cap at 7, 8, 9, 10, 12 and
  unbounded on the 1,470 Text2Vis rows, and the curve is not monotone: **eight and nine read three rows
  below seven**, because the cap admits a pie only where one category is narrow enough, so raising it
  admits the tables the corpus drew as bars while still refusing the ones it drew as pies. Twelve is
  the first value where the pie a question asks for is not overruled by a constant: **358 → 362
  (24.35% → 24.63%)**, bar −10 and pie +14 published together, both halves of the corpus up. No cap
  buys nothing beyond twelve. `DEFAULT_MAX_SLICES` is exported to the package and not from it.
- **Thirty-four one-edit readings of the product, generated rather than hand-written.** Every cue that
  names a fallback is priced with that fallback moved first (8 new), every cue is priced removed (12
  new), and the admission cap beside them (3). Removing `trend` costs 70 rows; removing `ranking`
  costs 13 and changes 205 answers; and four cues — `progress`, `multi-metric`, `profile`,
  `volatility` — change **nothing at all**, which says they are unexercised by this corpus rather than
  useless. Every candidate also carries its hits split over two halves fixed before the reading, and
  `assertCensusReport` refuses a table whose halves do not add up. On that split `matrix-bar-first`
  fails (+5 on one half, −3 on the other), which is why it is still refused — and its published
  reason (−34) is re-priced at +2, because the table it was measured on no longer exists.
- **A candidate now reports how many answers it changes, not only how many hits it costs.** A cue over
  eleven rows that are all misses is worth zero hits either way while every one of those answers moves;
  the ablation would have called those cues inert.
- **A per-cue reading that says which cue fired beside a wrong order, and the finding that a reorder
  is invisible to the product.** `cuePrecision` could say that `share` gets the family right and the
  order wrong on 177 rows; it could not say which row to move, because the repair is not in the cue
  being read. `eval/text2vis/rule.ts` now also exports `cueCrossings`, which splits a cue's covered rows
  in two and counts the companions in each half — publishing both halves, because a companion that
  fires on both is a cue that fires often. Reading it produced the round's central result: moving
  `ranking` in front of `share` scores **+39** on the question half (596 → 635) and **±0** on the
  product (358 → 358), because `recommendChart` ranks by `firstClaims` — how many cues name a mark
  first — and never reads the order of the cue table. The two ways to move the same thing are priced
  separately (`ranking-before-share`, `share-ranked`), both are refused, and `packages/chart` now
  asserts the identity so the next round meets the fact before it ships.
- **`packages/chart/**` no longer buys the SQL chain.** A round that changed one cue bought thirteen
  BIRD arms over 496 questions and three live passes over 210 cases, to re-measure a pipeline not one
  byte of which had changed. The chart package is a leaf under the SQL products — it depends on `spec`
  and nothing imports it except `eval/text2vis/` — so `tools/ci-scope.mjs` exempts it on the same terms
  as the reading, and `text2vis-rule.yml` widened its trigger from one file of the package to all of it
  in the same commit. The pairing is checked by a test that reads the workflow file, so an exemption
  whose trigger did not follow fails the build instead of leaving a path nobody measures.
- **The Text2Vis corpus has a loader, and the loader is a parser.** The chart side of this project
  had one external benchmark and no way to read it without a Python dependency: `mizanurr/Text2Vis`
  is one CSV of prose, so `eval/text2vis/dataset.ts` parses it itself -- quoted commas, quoted
  newlines, doubled quotes, CRLF, a byte-order mark -- rather than splitting on the delimiter, which
  returns the right number of rows and the wrong ones. A header without `Prompt` is refused by name;
  the download is written under a temporary name and renamed, so a run that dies mid-transfer leaves
  nothing a later run would parse as half a benchmark. `pnpm bench:text2vis:dataset` is the command.
- **The gate now admits the choosers it was built for: a knockout, and a reconcile turn.** The gate
  was written to refuse a paid chooser behind it, on the argument that two levers behind one number
  would be priced as one. That argument had the sign wrong. A paid adjudication is exactly the thing
  whose price should be proportional to the questions that have something to decide, so
  `select-mixed-gated-pair` (a knockout, `k - 1` comparisons on the disagreeing pool and nothing
  elsewhere) and `select-mixed-gated-reconcile-novel` (one statement on the same pool, adopting only
  a reply nobody wrote) are now expressible. The refusal that remains is the one that is a real
  contradiction: `dissent` buys an opinion *because* the pool was unanimous, which is the pool the
  gate answers by rule, so the bought call would be unreachable.
- **A knockout reports what it spent and what it could read.** `chooseCandidatePairwise` returns
  `comparisons` and `unreadable` beside the choice, the runner files them per case as `pairwise`, the
  row sums them as `pairwise.asked / comparisons / unreadable`, and `assertPairwiseFired` refuses the
  two states in which the arm measured the vote: a tournament that ran on no case, and one whose
  every comparison came back unreadable — the latter because an unreadable reply keeps the incumbent,
  which returns the pool's own first candidate under a comparison's name.
- **The adjudication is bought only where there is something to adjudicate.** On Mini-Dev at
  temperature 0.7, 350 of 479 three-candidate questions (73.1%) returned one result under the
  judge's own equality, and on those cases the model selector, the `shortest` rule and the `modal`
  rule all score **70.57%** — the same number to the case, because the result is the answer and the
  statement is not. The fourth call is not cheap there, it is unspendable. `Arm.gate: 'results'`
  reads the pool before the selector does, chooses by `gateRule` when the pool agreed, and calls the
  selector unchanged when it did not; `select-mixed-gated` is that arm beside its parent.
- **The judge can read the columns its candidates use.** The selector has never been shown the
  schema — the generator always has. `buildSelectionPrompt` gains an opt-in `evidence` block and
  `columnEvidence` renders the columns of exactly the tables the candidate statements name, within a
  character budget. Absent is byte-identical to the prompt every published reading was taken with,
  so the pair `select-mixed-gated` / `select-mixed-gated-evidence` prices the information rather
  than a rewritten instruction.

- **A sampled candidate is drawn at the temperature its arm declares — until now no multi-prompt
  arm sampled at all.** The request builder resolved the temperature as
  `target.vote === undefined ? 0 : 0.7`, where `target` is the arm that owns the turn. On a mixed
  arm that is the *source* being drawn from, not the arm buying the candidates, and a source
  declares no `vote` by contract (`assertMixedSources` requires it to write exactly one statement).
  Every candidate of every multi-prompt arm therefore went out at **0**: `select-mixed`'s "three
  samples at temperature 0.7", written in its comment, its catalogue note and the plan, was three
  identical deterministic requests.
  The measurement that caught it is the six-draw run `43379716079` (Mini-Dev, `deepseek-chat`):
  doubling the draws moved `candidateRecall` from 64.31% to 65.93% (+1.62pp, below the +2pp bar)
  and distinct executed results per question from **1.264 to 1.331**, with **462 of 493 questions
  gaining no new answer at all** — a repeat, which is what a temperature of zero predicts and what
  three prompts of one opinion produce (74.85% of questions unanimous, 110 of them wrong).
  Three things change. `Arm.temperature` is a declared field, range `[0, 2]`, where **0 is legal**
  and means "send the same request again" — the coordinate the whole family was silently measured
  at, kept as a control rather than as a claim. The resolution order is
  `overrides.temperature ?? target.temperature ?? (target.vote === undefined ? 0 : 0.7)`, and the
  mixed path passes the **arm's** temperature down to every source pipeline (and to the dissent
  vote). `assertTemperature` refuses, at the declaration, a temperature on an arm that draws once
  and a value the endpoint would reject — neither is worth learning from a paid run.
  Two arms go with the repair so the lever can be read as a dose-response curve instead of a point:
  `select-mixed-cold` (0) and `select-mixed-hot` (1) beside `select-mixed` (0.7), all at three
  candidates and four calls.
  **Readings taken before this repair are coordinate-bound.** Every `mixed` arm in this repository
  was scored at temperature 0, including the dev numbers 62.34% / 63.12% / 63.97%. They remain
  comparable to each other and are no longer comparable to a sampled single-prompt arm, and
  `docs/benchmarks.md` withdraws the "prompt diversity beats sampling diversity" claim to *no
  evidence* rather than to a refutation: it was a two-variable comparison whose variables were
  hidden at runtime where `changedLevers` — which compares declarations — could not see them. The
  new end-to-end test asserts the three request bodies (0, 0.7, 1) and that all three arms spend
  four calls on three candidates, because a declaration that is true and a mechanism that never ran
  look identical in a report.

- **An answer budget is a floor now, and a reply cut at one is its own fault rather than an
  outage.** `NL2C_E_LLM_INVALID_RESPONSE` held two opposite situations: "the endpoint answered
  with something that is not a completion" and "the endpoint spent the whole answer budget
  thinking and had nothing left". The harness counts `NL2C_E_LLM*` as an outage, so the second —
  a number *this library* chose — was reported as an endpoint that had gone away, and the outage
  guard ended a run that still had 130 calls in it. Measured on `deepseek-v4-pro` (Mini-Dev, run
  `43339353252`): **50 of 366 calls (13.7%)** returned `content: null` with
  `finish_reason: "length"` and `reasoning_content` filled, at the 4,096-token budget the chat
  family declares, on an endpoint whose single reply had already been billed for **21,932**
  completion tokens.
  Three things change. `NL2C_E_LLM_TRUNCATED` gives the fault its own identity, so the repair
  ("a larger number") is nameable. The provider answers a truncation by asking again with
  **double the budget**, bounded by a new `capabilities.answerBudgetCeiling` (`8,192` for the
  chat row, `32,768` for the reasoning row — the latter justified by this repository's own
  artifact, not by a vendor page) and by `budgetEscalations` (two by default); raising a budget
  costs nothing unless the model uses the room, since `max_tokens` is a limit rather than a
  reservation. And the tokens the **discarded** attempt spent are summed into `usage`, because
  the endpoint charged for them: a cost column that read only the reply it kept would report an
  escalation as free.
  The harness follows: `errorKind: 'truncated'` is its own bucket, `cut-at-budget` is its own
  column beside `llm-failed`, and the tenth-it-will-not-publish rule applies to it with its own
  sentence — a run whose replies were cut is not an accuracy, but it is not an outage either.
  Two declarations were corrected in the same pass, both wrong in the same direction: the
  `maxOutputTokens` doc claimed a chain of thought "does not count against" the cap (on the
  endpoint benchmarked it is billed inside it), and the comment on the chat row called 4,096
  "the vendor's usual 4K" without saying it is not a maximum.
  **Measured:** 13 new provider tests, 5 new harness tests, 2 end-to-end cases (an escalated
  case turning a certain failure into a correct answer on the second request, and a run refused
  with the budget sentence when every budget is too small); suite 4,564 passing with no skips
  against real PG16 and MariaDB 10.11; eight packages at or above 95% on all four dimensions;
  eval ledger 88/88; api surface unchanged at 469; `ai` bundle 70,500 -> 73,000 B gzip (72,063
  measured, reason in `budgets.json`).
- **A refusal now names what it refused, and a reply that is not a statement is no longer
  reported as an unsafe one.** `extractSql` reads a reply with no fenced block as the whole
  reply, which is right for a model that writes bare SQL and wrong for a model that writes
  prose — and the prose was handed to the lexical guard as if it were SQL. The guard rejected
  it on whichever character it could not classify, and that character became the diagnosis.
  Measured on `deepseek-v4-pro` (Mini-Dev, run `43262574193`, 992 case-scored rows, two
  repeats): **six** replies were prose and **all six** were published as `guard` failures with
  `unsupported character "?"` as the reason — the question mark in the model's own aside
  ("Is it 2012? Let me recall…"). One of them was **83,036 characters**. The six points were
  not the cost — they were already wrong answers, and they stayed wrong. What the artifact
  could not do was say *why*, and both its readers act on that sentence: a person looking for
  an unsafe statement, and the repair turn, which is told what to fix. `inline+evidence`
  repairs zero times by design (`repairs: 0`), so **no repair call was spent in that run** —
  this is a correction to an earlier draft of this entry, which claimed three. The claim is
  about every arm that does repair, and about the library's own default of three: there the
  next call is spent on a safety problem the reply does not have. The committed dev artifact
  holds three more of these, on the chat model and in three different arms (`names`,
  `synth-definitions`, `inline+retrieval`), so the wrong sentence is a property of the report
  and not of one endpoint.
  `attemptsStatement(sql, policy)` closes it: a reply is a statement attempt when its first
  word is one the guard's policy names — the kinds it accepts **and** the words it bans — so
  `insert` is a statement this guard refuses and `let` is not a statement at all. The list is
  derived from the policy rather than copied beside it, because a second copy drifts the first
  time someone bans a word. `diagnoseFailure` gained `replyShape: { kind, chars, finishReason }`
  and reports `shape: the reply holds no statement (1,214 chars)`, with a repair sentence that
  asks for the fenced block instead of for a safer statement.
  **Measured:** 13 tests in `reply-shape.test.ts` over prose, empty, inline-SQL-with-preamble,
  a banned head, a placeholder, a cut reply and a provider that reports no reason; 7 in
  `guard.test.ts` including the invariant that nothing `inspectSql` accepts is called prose.
  Reverting the classification turns 7 of the 13 red. Suite 4,548 passing with no skips against
  real PG16 and MariaDB 10.11; the chart package unchanged at 100/100/100/100.
  **Not claimed:** no accuracy moved. All six cases were failures before and after; what changed
  is the sentence the report prints and the turn the model is given. A misspelled statement head
  (`DELETETE FROM students`) is now classified as prose rather than as an unsafe statement,
  which is a deliberate trade recorded in the design note: the observed population of unreadable
  replies is prose (nine rows across 7,440 case-scored rows in two artifacts), the theoretical
  one is a misspelled head (none observed), and the wrong-feedback direction is the expensive one.

- **The answer cap a deployment declares is now the cap the endpoint is given.** `maxOutputTokens`
  documented itself as the number the pipeline chooses because "the endpoint's default is a
  number the pipeline never chose and cannot see" — and `adaptRequest` sent it only to a
  `reasoning` family, so for a chat model the number was declared, printed in the artifact, and
  never put on the wire. Measured on the same run: one reply ran to **21,932 completion tokens**
  (83,036 characters) because nothing in the request named a cap. The field is now sent for
  every family when the caller names no budget of its own, and `0` still means "do not send",
  because several endpoints refuse a zero budget as invalid.
  **Measured:** 6 tests in `provider.test.ts` (chat 4096, reasoning 8192, caller override, a
  declared ceiling of zero, and the wire body itself) plus the two capability tests that used to
  assert the opposite — one of them carried the reason as a comment: *"the default that was never
  a decision: a chat endpoint's own cap stays its own"*. Reverting the rule turns both red.
  **Not claimed:** a tighter cap can only remove runaway replies, not make a short one shorter;
  whether it costs a legitimate long reply is priced by the `truncated` column below, and no
  reading of it exists yet.

### Added
- **`vote` means what its documentation says again: candidates bought per question, not the length
  of the source list.** A mixed arm draws its candidates round-robin over its sources
  (`sources[sample % sources.length]`), so `vote: 6` over three sources was always going to be
  each prompt sampled twice. What blocked it was a declaration-time assertion, `arm.mixed.length
  !== arm.vote`, whose message — "the cost claim would be false" — was about a defect that could
  not happen: the cost is `vote` calls, and the loop draws exactly that many. The rule is now a
  whole number of passes, and it lives in an exported `assertCandidatePasses` instead of inside
  `runArm`, because a rule only a real run can trip is a rule no unit test holds: three branches
  (no sources, whole passes, fractional passes) are now reachable, which is the same discipline as
  deleting a branch no input reaches, seen from the other side.
  Two arms: `select-mixed-spread2` (six candidates, seven calls) and `select-mixed-spread3` (nine,
  ten). They exist because the strongest training-free competitor — `OpenSearch-AI/OpenSearch-SQL`,
  MIT, first on BIRD in August 2024 at 69.3% dev and 72.28% test with no training and no
  fine-tuning — draws `"n": 21` at `temperature 0.7` and aggregates by *executed result*
  (`vote.py` compares `set(tuple(row))`, not statements). This repository has never measured a
  candidate set above five, so the distance to that number had never been attributed to anything.
  **It is not the backbone, and the readings already in this file say so:** `vote-cross`'s set
  contains a correct statement 69.6% of the time — the highest ceiling measured here, and the same
  level as the competitor's score — and it returns 62.9%, converting 90.2% of it. Lifting that
  conversion to `select-mixed`'s 96.1% is 67.8%, which sits on 69.3%.
  The ladder climbs by prompt first and repetition second, on a reading this file already carries:
  three prompts reached a 65.8% ceiling against five samples of one prompt at 64.7%, with two
  fewer calls. Two draws of one prompt differ by temperature; a draw of a second prompt differs by
  what is in front of the model.
  **Pre-registered, before the runs:** `spread2` has to move `candidateRecall` at least two points
  above `select-mixed`'s 67.75% on dev, and `spread3` at least one point above `spread2` — a
  halved slope closes the twenty-one-candidate configuration as an explanation and moves the
  question to the competitor's prompt family. A ceiling that rises while accuracy does not is
  attributed to the selector, and the next call is not another candidate.
  **Verified end to end, not by reading the loop:** a six-candidate arm draws its sources in the
  order `[inline+evidence, metadata+evidence, values, inline+evidence, metadata+evidence, values]`
  and records `calls: 7` — six generations and the selector — on every case of the fixture run.
  That is the assertion the old rule could not have survived: three draws billed as six would have
  produced a row indistinguishable from the parent's.
  **Cost, stated so it is not underestimated:** the competitor sends `n` once and receives
  twenty-one completions in one HTTP response; this endpoint has no `n`, so twenty-one candidates
  are twenty-one requests. Same tokens, twenty-one times the failure surface — which is also the
  one asymmetry in our favour, because its candidate set is all-or-nothing and ours survives
  partially (`candidateSurvival` counts per source).
- **`compileToMatplotlib` — a chart IR becomes Python source, because a public benchmark scores
  the code rather than the picture.** Text2Vis (EMNLP 2025) computes its pass rate from four
  conditions, and one of them is `execution_result`: the generated code has to run and save a
  figure. This repository produces a `ChartIR` and an ECharts option object, so an IR that cannot
  reach Python cannot be scored on that benchmark at all. Four marks are drawable from the encoding
  this compiler reads (`bar`, `line`, `scatter`, `effectScatter` as scatter, `pie`); every other
  series type is refused rather than approximated — a bar chart standing in for a candlestick is a
  picture that answers a different question, which is the failure this repository keeps finding in
  other people's harnesses.
  Two codes, because the repairs differ: `NL2C_E_NOT_SUPPORTED` for a mark with no counterpart or
  an IR missing a channel its mark reads, `NL2C_E_INVALID_IR` when the linter reports an error (a
  pie with a negative slice, an empty result set). Both are asked of the two functions that already
  own those judgements — `supportOf` and `lint` — rather than re-deciding them in an emitter.
  **Values are quoted with the JSON rules**, which Python and JSON agree on for every escape that
  matters, and the three keywords that differ (`null`, `true`, `false`) are spelled `None`, `True`,
  `False`. The reference harness runs the source with `exec`, so a category holding
  `'); import os; os.system(...)` has to stay a category; a value JSON cannot represent keeps its
  text instead of throwing, because whether the code runs is one of the four criteria and a
  `TypeError` here is a zero with no visible cause.
  **Verified by running it, not by matching strings:** all four marks compiled and executed against
  matplotlib 3.6 in this container with `plt.show` replaced by a saver, and every one produced a
  PNG. 17 tests; `packages/chart/src/matplotlib.ts` at 100% statements, 96.4% branches; bundle
  18,400 -> 20,000 B (19,625 measured, reason in `budgets.json` as capability rather than drift);
  api surface 469 -> 470.
- **An arm row states what share of its bill was thinking, over one population.** The row printed
  `completion` averaged over every scored case and `reasoning` averaged only over the cases whose
  endpoint reported a counter — two means over two populations — and a reader divides them,
  because that is what two numbers side by side invite. On `deepseek-v4-pro` (Mini-Dev, run
  `43343813778`, reasoning declaration) the row said **1,650** and **1,691**: 102% of a bill. The
  sum over the cases that reported both counters is **818,438** completion against **771,295** of
  deliberation, so the sentence the reader wanted is **94.2%**, over 456 of the 496 cases. Those
  figures hold each other up — 818,438 over 496 is the 1,650 the row printed, and the ratio is the
  94.2% it could not state. `tokens.thinking` now carries `{share, cases}` and is absent, not
  zero, on an endpoint that reports no counter, which is where every reading before this one was
  taken. `tokens.reasoning` and `tokens.thinking` are also declared on `ArmReportRow`: the row has
  been writing `reasoning` since the meter learned to report it and the type never said so, and a
  type that omits a written field is the same defect as a column that reports two numbers under
  one meaning. `byPurpose` gains `reasoning` for the same reason.
  **Measured, and the reason this column exists:** the chat declaration and the reasoning
  declaration were run on the same 496 questions and the same arm, differing in `capabilities`.
  Reasoning won **24** of the cases the chat declaration lost and lost **25** it won (arm
  `inline+evidence`; net −1 on the same questions) and spent **34% fewer** completion tokens
  (818,438 against 1,237,135) — the declaration that says it thinks is cheaper per case and no
  better. It also returned **71 empty answers across its two arms**, where the chat run returned
  none. That last comparison is not a property of either declaration, and it is the reason the next
  paragraph exists.
  **The two runs are not two request shapes, they are two measurement regimes.** `afb4164d` ("the
  declared cap reaches the wire") made `max_tokens` be sent for every family; before it the line
  read `else if (capabilities.family === 'reasoning')`, so the chat run (`43262574193`) sent **no
  cap at all** and the endpoint applied its own. Its zero empty answers are therefore not evidence
  that the chat declaration is safer — nothing could be truncated. The 13.7% that started this line
  of work (`43339353252`) is the first run in which a 4,096 cap was actually on the wire, and the
  first time this repository could measure truncation at all. A cut answer reads as a wrong one, so
  the cap surfaced the fault rather than caused it: `deepseek-v4-pro` has answered with
  `reasoning_content` in every run, and no declaration changed that.
  **Its own A/A pair is the noise floor.** On the chat run, the *same* configuration twice disagreed
  on 39 of 496 cases and was published at **p = 0.024** — the harness's own control crossed the
  significance line its arm comparisons are read against. On the reasoning run the same pair gave
  **p ≈ 1.0** (22 against 23). Both are what the endpoint does and neither is a property of a
  declaration: it is why one run cannot separate a 3-point difference from a repeat.
- **`finishReason` travels from the endpoint to the artifact, and a truncated answer says so.**
  A reply cut at the token cap and a reply the model chose to end are the same bytes up to the
  cut, and the difference is the whole question. `LlmResponse.finishReason` carries
  `stop | length | content_filter | other` (`undefined` when the endpoint said nothing, which is
  not the same as `stop`), and the pipeline reports `truncated: true` on an answer whose
  statement parsed under a cut. A cut reply is never diagnosed as an unsafe one, even when it
  opens with `select`: the bytes are a prefix of what the model meant to write, so whatever the
  gate objects to is a property of the cut.
- **`bench:bird:channel` — the instrument that reads a report's taxonomy back against its own
  evidence.** Zero model calls, zero database: it opens an artifact, compares each refusal's
  claim with the bytes the case holds, and refuses to let a report be published whose taxonomy
  disagrees with its evidence — a `guard` failure whose reply holds no statement, a `shape`
  failure whose reply holds one. It prints the per-arm table, names every contradiction with the
  case id and the character count, and exits non-zero under `--strict`, which is what the two
  workflows use: `ci.yml` after the readings chain, and `bird-model.yml` after the structural
  gate, because that job's whole purpose is to try unknown endpoints and the taxonomy is what
  needs auditing there. The default mode is a report and exits zero, since the artifacts kept in
  this repository are historical — a tool that fails on a file it did not write teaches its
  reader to add `|| true`.
  **Measured:** 25 tests; `channel.ts` at 98.7 lines / 95.7 branches / 100 functions. Run on
  `43262574193` it reproduces the six rows above and on the committed dev artifact it finds three
  more. One defect in the instrument itself was caught by that second run: counting only the
  channel kinds reported 210 unexplained failures on the pro artifact, when 210 of those cases
  were explained by their result reason (`values` / `column-count`). Both taxonomies are
  attributions, and the rule now says so. A second gap was caught by CI rather than by review:
  the reporting code landed with no case that reached it, and the eval ratchet read
  `eval/bird/run.ts` branches at 95.83% against 96.06%. The endpoint fixture could only ever
  answer `finish_reason: stop`, so `EndpointReply.finishReason` and a `cut` list on a scenario
  plan were added, and the new end-to-end case asserts the cut case carries `truncated: true`
  while the others carry no key at all.

- **A chart of nothing used to compile, and the linter called it renderable.**
  Nothing in the package knew what each of the twenty-two series types reads, so
  `{ mark: 'gauge', encoding: {} }` produced a gauge with a null needle,
  `{ mark: 'pie', encoding: {} }` produced one unnamed slice of null, and
  `{ mark: 'bar', encoding: {} }` produced two unnamed axes. All three passed
  `lint` with no errors — `isRenderable` said yes — and all three render as a
  picture that looks like a rendering bug rather than a contract violation. Eight
  tests asserted those placeholders as correct behaviour, including one whose
  comment read *"the chart draws less, not something else"* about a candlestick
  given two of its four columns: ECharts reads a tuple positionally, so two of
  four is not a shorter candle, it is a candle whose open is a close and whose low
  is a high.
  `supportOf(ir)` closes it. One rule table, twelve families, twenty-two marks,
  each answering `{ supported, missing }` where every `missing` entry names the
  channel and the count (`a boxplot reads 5 numbers per row from y and was given
  2`). The compiler asks it once before reading any channel and emits no series
  when the answer is negative; `lint` reports the same sentences as
  `encoding-unsupported` at `error` severity. The two can no longer disagree,
  because they read one function — which is what makes `isRenderable` mean "the
  compiler will draw it" rather than "no rule objected".
  Eleven hand-written `undefined` guards came out of `compile.ts` in exchange,
  along with the guards' unreachable branches, and a tie-breaker in
  `enumerateCandidates` whose seven scores are distinct by construction.
  **Measured:** 17 new tests over 242 mark-shape pairs (22 marks x 11 encodings),
  asserting the invariant in both directions — a series exactly when the verdict
  approves — plus agreement with the linter and a per-family reading table.
  `support.ts` at 100/100/100/100 and the chart package now **100.00 / 100.00 /
  100.00 / 100.00**, 162 tests, whole suite 4,477 passing with no skips against
  real PG16 and MariaDB 10.11. Budget 16,752 -> 17,895 B gzip; ceiling raised to
  18,400 with the reason recorded.
  **Not claimed:** no external benchmark reading. What changed is which inputs the
  package refuses and why; no chart-quality score moved, and none was measured.

### Changed
- **The chart half publishes the entry point's number, and the two it displaced are dated.** Three
  top-1 readings for Text2Vis appeared in the documentation — 549, 231 and 414 on the same 1,470
  rows — and the first explanation written for them was that they were three different quantities.
  Re-running the three instruments showed they are the same pair at two moments: `rule.ts` (cue table
  alone) reads **627 (42.65%)**, `profile.ts` (the shipped entry point) reads **414 (28.16%)**, and
  `census.ts` reproduces 414 exactly — so the census is a second measurement of the entry point and
  not a third quantity, which is the outcome a single hit test is supposed to produce. The pair that
  disagrees is the cue table against the entry point, by **13.30pp** rather than the 21.64pp this
  document has been quoting from a dispatch whose two figures were both superseded and neither was
  overwritten. What the product should publish is **28.16%**; a reading without the date it was taken
  is a reading about a build that no longer exists.
- **The competitor register is a gate's configuration, not a reading.** `eval/competitors/intake.json`
  is read by `bench:competitors:intake`, which spends one file read and no model call; the classifier
  nevertheless filed it under `eval/` as a harness input, so the push that added the row above would
  have bought thirteen BIRD arms over 496 questions and three live passes over 210 cases to re-measure
  a pipeline whose bytes did not change. Fourth entry in that class, and the test pins the boundary
  from the other side as well: `pins.json` sits beside it and still measures, because a pin is a
  promise that a run will start.
 `eval/competitors/intake.json`
  is read by `bench:competitors:intake`, which spends one file read and no model call; the classifier
  nevertheless filed it under `eval/` as a harness input, so the push that added the row above would
  have bought thirteen BIRD arms over 496 questions and three live passes over 210 cases to re-measure
  a pipeline whose bytes did not change. Fourth entry in that class, and the test pins the boundary
  from the other side as well: `pins.json` sits beside it and still measures, because a pin is a
  promise that a run will start.
- **A case the loaded split cannot find is a problem, not a footnote.** `valuesProblems` reported
  its acceptance as a ratio over the rows that reached a named cause, so an artifact read against the
  wrong benchmark could not fail it. A dropped question now fails the gate and is named before the
  ratio, because it is the reason the ratio is the one it is: `--strict` on a dev artifact under the
  default split exits non-zero instead of publishing a confident number about a fifth of the set.
- **The coverage ledger is a gate's configuration.** `eval/coverage-ledger.json` is the per-file
  record `check-eval-coverage` compares against; it lives under `eval/`, so a classifier written as a
  list of root files read it as a reading and a push that only moves a number in it bought thirteen
  BIRD arms over 496 questions and three live passes over 210 cases. Third entry in that class, and
  the test that pins the boundary asserts the class stops there — an instrument under the same tree
  still measures.
- **`consensus.eligibleIndices` is exported, because it is the predicate every rule shares.** The
  rule harness refuses to restate which candidates a rule may choose among: "the ones that returned
  something" decides every score in both files, and a second copy of it is a second answer to the
  question the scores are about. The three shipped rules were already read through `pick`; their
  eligibility is now read from the same place.
- **`VariantScore` carries the reason its variant is on the list.** The report looked it up in
  `VARIANTS` by name, which needed a fallback for a name that could not be missing — a branch no
  input could reach. Carrying the sentence with the score deletes the branch instead of testing it.
- **The fourth candidate is retired: the ceiling rose and the free rule could not convert it.** One
  dispatch, three arms, the same 1,532 dev questions (`43725927611`, 16,852 completions): the parent
  `select-mixed-rule` reads 994 (64.88%) with a 68.08% ceiling, `-rows` 983 (64.16%) at 69.32%, and
  `-intent` 998 (65.14%) at **70.10%**. Paired: −0.72pp (p = 0.34) and +0.26pp (p = 0.77). The intent
  source does buy 2.02pp of ceiling, and conversion falls 2.4–2.7pp doing it — `shortest` finds a
  short wrong statement more often in a four-candidate pool. That is `select-intent`'s −3.50pp
  conversion loss reproduced with no selector call, so the loss belongs to the pool rather than to
  the model that used to adjudicate it. The knowledge source does not even buy the ceiling (+1.24pp).
  `calls.mean` is 4.00 against a 4.05 bar and prompt length is unchanged, so the price was the call.
  The reading is taken with `pnpm bench:bird:pair --pair left,right` on the artifact that holds both
  arms, not from `pairs.json[dev]`: the first repair was to declare the two pairs for `dev`, and
  `gate:bird` refused with the sentence that matters — "declared for dev and `select-mixed-rule` is
  not in that split's arm list, so the reading it promises can never be taken". A declaration is a
  standing promise read on every routine run, and a routine dev run is five arms at three calls a
  question; a promise the configuration cannot pay is the third face of the same disease this
  round found twice already.
- **A run that outgrows its clock leaves the cases it finished behind, instead of spending them
  twice.** The budget stop was total: it printed the sample size the next dispatch should ask for
  and threw away everything it had bought. A Mini-Dev arm on a reasoning base has been running for
  seventy minutes at four in flight, so a clock that ends before the last case now costs a whole
  attempt rather than the tail of one. `BIRD_RESUME_FROM` names a partial run, and the cases in it
  are counted instead of re-asked — the table still covers the questions the run declared, which is
  the only shape a rate may be computed from.
  The file is refused, with the difference named, when the arm, the split, the model or the exact
  question set does not match: a resume that trusted the file's own header would graft a
  `deepseek-flash` arm onto a `deepseek-v4-pro` reading and publish an accuracy nobody could
  reproduce. A table built by two processes says so — `run.resumedFrom` carries the file name —
  because the first part was scored before whatever happened between the dispatches, including a
  model alias moving under the same name.
  **Measured:** four tests: an end-to-end stop at one of seven cases writes a partial the resumed
  dispatch completes over all seven while spending fewer endpoint calls than the run that never
  stopped, and three cases covering the match, the four refusals and a file that is not a partial at
  all. `eval/bird/run.ts` stays above 95% on all four dimensions; 4,483 tests passing with no skips
  against real PG16 and MariaDB 10.11.
  **Not claimed:** a partial run is not a reading. The gate still refuses a table that does not cover
  its declared population, and this file changes nothing about that — it only stops the next
  dispatch from paying for the same cases twice.

### Added
- **The chart is chosen from the question, and every refusal says what was missing.**
  `enumerateCandidates` reads a profile and nothing else, so it could only ever
  suggest five of the contract's twenty-two series types — bar, line, pie,
  scatter, heatmap — and the other seventeen were reachable by hand only. That is
  a capability gap in a package whose selling point is "22 types": the compiler
  could draw all of them and the assistant could name five. `recommendChart`
  closes it without a model, because the preconditions of the missing marks are
  visible in column types: a boxplot needs five numbers per row, a candlestick
  four on a date axis, a gauge exactly one and no category, a radar three and a
  named row. Eleven marks are now choosable, and each choice carries the counted
  facts that produced it — three points for the first mark a cue names, two for
  the rest, plus the structural prior — so `score: 5` can be recomputed from the
  reasons printed next to it instead of trusted. Two facts travel with every
  answer: `cues`, the phrases that fired (`trend`, `share`, `distribution`,
  `volatility`, eleven in all, each also with Chinese spellings, because a product
  that answers only English questions has a speaking defect), and `refused`, one
  sentence per considered mark saying what the result set lacks
  (`a boxplot reads five numbers per row and this result has 1`). A rejection that
  is not reported is a wrong choice with no trace. `toChartIR` turns the winner
  into a contract-valid IR with the question as its title and the mark in its alt
  text, and orders a candlestick tuple as `[open, close, low, high]` rather than
  "the first four numbers", which would draw a picture whose shape depends on the
  column order of the result set.
  **Measured:** 47 tests, `recommend.ts` at 100/100/100/100, chart package
  100.00 statements / 97.79 branches / 100.00 functions, whole suite 4,460 passing
  with no skips against a real PG16 and MariaDB 10.11. The budget moves
  10,855 -> 16,752 B gzip over both module formats, and the ceiling is raised to
  17,600 with the reason recorded in `budgets.json`; the old ceiling had 645 B of
  headroom, less than the smallest form this layer could take.
  **Not claimed:** no Text2Vis, nvBench or VisEval reading is behind this. The
  chart-choice numbers this repository has quoted came from harnesses that are not
  in this tree, so they cannot be reproduced from it, and this entry adds a
  behaviour with a fixture rather than a benchmark score. Two branches were
  deleted rather than covered on the way in — a third sort key that could never
  fire because `PREFERENCE` already breaks every tie, and a `maxCategories` option
  that nothing read — and the guards `encodingFor` would otherwise have needed are
  casts with the argument written down, because every field they read was proven
  present by the admission that selected the mark.

- **Three stored rows per table: the input RSL-SQL's prompt names five times and this one never
  sent.** A column sample shows a value's domain; three rows show which values occur *together* —
  `status = 'Banned'` on the same line as `currency = 'EUR'` — and no per-column block can carry a
  pairing. `eval/bird/row-samples.ts` renders it as a pure function (`renderRowSamples`, given the
  caller's reader), `PromptOptions.rowSamples` carries it, and the arm `inline+evidence+rows` prices
  it. Priced before it was built, on 1,534 dev questions: text columns only, 1,058 characters at the
  mean and 483 at the median against a prompt of about 2,700, with a 3,244-character p90. The mean
  is affordable and the tail is not, so `ROW_SAMPLE_BUDGET` caps the block at 800 and drops whole
  tables rather than cutting one in half — half a table reads as a table that stores one row, which
  is a claim about the data. A linker that names only numeric tables falls back to the card's first
  three rather than to no block at all. The prediction was registered in `docs/benchmarks.md` before
  the arm ran: the gain concentrates on questions whose gold literal `values` never found, or the
  schema layer closes entirely rather than at both of its ends.

- **`ask_question` gives a deployment the same switch, one layer up.** `AskOptions.linkEvidence`
  reaches the pipeline's option of the same name, so a server whose callers always pass `evidence`
  can have the hint built from it. Off by default, and the third test is the one that matters: with
  the switch on and no `evidence` in the request, the hint is the one the server already sent.

- **The linker can read the evidence, and the hint it builds has finally been measured.** The
  `Likely columns` hint was built from the question alone. RSL-SQL's bidirectional linking — the
  mechanism its paper credits for a 94% strict recall — reads its own preliminary statement, the
  dataset's hint line, and an LLM's column list, and unions them; the middle source is a substring
  scan over text this repository already puts in the prompt and never showed the linker. On 500
  Mini-Dev questions the shipped hint names 7.4 columns a question of which **29.8% are columns the
  answer uses**, and covers 39.3% of them; reading the evidence at the same twelve slots covers
  **55.2%** (68.3% at thirty) at 31.4% precision — and on the 1,534-question dev split, 41.5% →
  55.2%. `PipelineOptions.linkEvidence` and
  `AskMessagesInput.linkEvidence` turn it on; the default does not move, because a linker that
  started reading the evidence because it was in the prompt would change every arm at once and each
  published reading would describe a prompt nobody had run. Two arms price it —
  `inline+evidence+link-evidence` and, for the first time in this repository,
  `inline+evidence-nolink`, because every arm here has always shipped the hint and what it is worth
  has never been a measurement.

- **Column pruning refused by its own kill criterion, with the layer that fails identified.** The
  previous round's plan was to cut the card to the columns a question needs. Measured offline
  against gold references on 500 Mini-Dev questions: linked columns plus foreign-key columns keep
  28.8% of a case's gold columns, adding `*id` 30.2%, adding `*name*` 43.8%, and with column values
  supplied to the `value` recaller at `topK` 30, **54.0%** — against a 94% criterion. The split says
  why: gold **tables** survive 98.11%, gold **columns** 52.84%, and the linker names only **46.75%**
  of the columns the answer uses, so no rule that keeps what the linker names can keep more. Pruning
  is refused until that recall moves, and `docs/benchmarks.md` records the three RSL-SQL sources that
  move it.
- **The second reading the data can prove: the same day, written the way the column writes it.**
  `ground.ts` settled case and called everything else `absent`, so a statement that wrote
  `'9/9/2019'` against a column storing `2019-09-09` was reported as a literal the column does not
  contain. It does contain it, in one notation. The rule now reads a literal as a calendar day and
  rewrites it to the spelling the column stores, with three refusals that are the whole of its
  safety: a numeric date that could be read day-first or month-first (`3/4/2019` and nothing in the
  statement settles it), a day the calendar does not have (`2019-02-30`, checked against month
  length including the century exception), and a precision that differs (a day is not an instant, so
  a timestamp column is never matched). `GroundingSubstitution.match` reports which of the two rules
  found the value, so a reading can tell the edits apart. Priced offline at zero model calls by
  executing the archive's own 496 Mini-Dev statements against the cached databases: **2 changed, 2
  repaired, 0 broken, +0.40pp**. Both are one database, two date columns. `ground.ts` reaches
  100/95.95/100/100 across the four dimensions; 33 new tests, each one a way the rule could be
  wrong. `GroundingMatch` is exported, so `api-surface.json` moves 447 → 448.

- **The failure class everyone reads as "literals", decomposed, and a bound on what a rule can
  reach.** On `inline+evidence` over 496 Mini-Dev questions, 223 fail and 160 of those are filed
  under `values` — which reads as a literal defect and is not one. Reading each case for the
  syntactic shape that separates it from its gold: **60** read different tables, **41** use a
  different aggregate, 30 read fewer tables, 25 carry an `distinct` the gold does not, 12 are missing
  one, and not one is a literal. Three mechanical checks have now been priced on the same questions
  — the cap (shipped, +0.40pp), the calendar (+0.40pp) and top-K absence (19 failing cases name a
  rank and carry no `limit`, of which **6** have a gold with a `limit`; ceiling +1.21pp, not
  shipped). `docs/benchmarks.md` records the decomposition, the offline method, and the reading it
  forces: the deterministic layer is close to exhausted, and the `select` arm's own `agreement` of
  **0.901** says why the selector's 6.1pp of loss has resisted every rule applied to it.
- **The few-shot shape two leading no-training systems share, implemented in both positions.**
  `packages/ai/src/sql-like.ts` reads a statement back into the eight labelled steps that produced
  it, and three arms carry it: `inline+icl-cot` (the same neighbours as `inline+icl`, each block
  gaining its steps — in the default chain), `inline+reasoning` (the same format asked for in the
  prompt) and `inline+icl-cot+reasoning` (both). The mechanism is OpenSearch-SQL's self-taught CoT
  few-shot plus its SQL-Like intermediate language; that system reached 69.3% on BIRD with no
  training of any weight and credits both. This repository had implemented only the
  `(question, SQL)` half of the shape. Read backwards from the gold statement rather than generated
  forward by a model: no calls, and unable to assert anything the statement does not say. Five
  shapes are refused outright — set operations, CTEs, subqueries, window functions, and anything not
  beginning with `SELECT` — and for demonstrations the refusal is load-bearing: a block whose
  examples disagree about whether a reasoning section exists teaches that it is optional, so a
  neighbour the reader cannot decompose is skipped, and an arm whose neighbours were all skipped
  sends nothing rather than its parent's prompt. `ai`'s bundle budget moves 65,000 → 69,000 B gzip
  (measured 67,784) and the chain's call budget 14 → 15, both with the reason recorded. 31 new
  tests; `sql-like.ts` at 100/100/100/100. **No accuracy reading yet** — the claims are that the
  mechanism is implemented, wired, and priced one lever at a time.

- **The server can answer a question, not only run a statement.** `packages/ai` builds the
  question-to-SQL pipeline and no package imported it: `mcp` exposed `run_sql`, `query_metric` and
  `explain_metric`, so a client could ask "run this SQL" and "compile this metric" and could not
  ask the thing the project is named for. `ask_question` closes that edge — it generates, guards,
  repairs on the engine's refusal, executes, and returns the statement beside its rows and its
  attempt count. The tool is listed only when `ask.provider` is configured, because a tool that is
  advertised and then fails every call is a capability the server claimed and does not have; the
  list and the dispatcher read the same option so the two cannot drift. The schema is the caller's
  (reading a live catalog needs a driver, and `mcp` must not depend on `node`), a call naming no
  table or a table with no columns is refused rather than guessed, and `preview` is clamped by the
  runner's `maxRows` rather than granted. `mcp`'s bundle budget moves 7,000 → 10,500 B gzip
  (measured 9,518) with the reason in `budgets.json`. 20 tests, including a repair that takes two
  attempts and a provider failure that keeps its `NL2C_E_` code.

- **A zero-call contrast between two artifacts, and the two denominators it refuses to choose
  between.** `pair.ts` refuses to join two artifacts, correctly: a join across runs puts the
  endpoint's displacement into a delta that was supposed to have none. Comparing two *base models*
  needs two dispatches, so the refusal becomes a condition — `bench:bird:contrast` accepts two
  artifacts when the split, the judge, the arm list and the prompt size are equal, and names both
  values of anything that is not. It prints intent-to-treat (a forfeit scores as a wrong answer,
  which is the arm's own denominator) and complete-case (only questions both sides answered), the
  forfeits on each side by cause, and how many discordant cases have an unanswered side. It does
  not nominate a verdict: `S1`'s two readings were +0.98pp at p=0.29 and +2.50pp at p=0.0049, and
  the difference between them was 94 model timeouts in the arm that ran slower. A case is judged
  when the artifact records no error for it — not when it carries a reason, because every artifact
  written before the verdict fix records `values` on the five no-answer branches, and reading the
  verdict as the evidence would find no attrition in exactly the run this was built for.

- **`tools/bird-dispatch.mjs` refuses to dispatch into an occupied concurrency group.** Four
  workflows share `bird-eval` because they draw on the same quota and write the same artifact. None
  of them cancels, but two dispatches 13 seconds apart still lost a run: the second arrival left the
  first `pending` and it was cancelled, while the `ci` job holding the group was cancelled two
  seconds after the first dispatch arrived. `busyRuns` therefore counts `queued` and `pending` as
  busy, not only `in_progress` — the run that was lost was pending when it died. `--wait` queues
  behind the group instead of into it, the body spells `timeout_ms` as the workflow declares it (a
  number there is dropped by Actions and silently runs the 120 s default), and the token is read
  from `GH_TOKEN` rather than an argument, because this repository has a gate that reads for
  exactly that.

### Changed
- **The dev split is pinned to the base that produced its floors.** It carried floors and no base
  pin: `served`, `corpus` and `baseFingerprint` existed for Mini-Dev only, so a dev run was
  compared by *name* — and a name is the one thing an alias does not keep. All three are recorded
  from `43198451668` (`deepseek-flash` on 1,532 of 1,532 cases, fingerprint `170d0beaa768594b` over
  3 probes, probe set `ac0c70152695fb20`, corpus `db9e8a1aba23ddd9`), and the gate now refuses a dev
  reading whose base answered as another model, whose fixed probes came back with other weights, or
  whose questions are not the ones the floors were taken on. A declared subset of the split is left
  uncompared out loud rather than failed for a corpus it never read — a dispatch with `limit` reads
  a subset by design, and the digest of a subset is not the digest of the split.

### Measured
- **The audit turn on dev: two calls a question, and −0.85pp.** `43211382444`, dev, 1,532 scored,
  `served: deepseek-flash` on every case: `inline+evidence` 943 (61.55%), `inline+evidence+audit`
  930 (60.70%), **−13 cases**. Prompt tokens 676 → 1,611 (×2.4) for one extra call a question, and
  every difficulty bucket moved the same way (simple 617→610, moderate 250→247, challenging 76→73).
  The turn fired on 1,507 cases (98.4%), named a missing condition on **30** (2.0%) and rewrote 43
  (2.8%) — the same shape as its Mini-Dev funnel at three times the sample — while the failure
  buckets it targets got slightly worse (`values` 439→447, `columnCount` 126→130). The catalogue
  already carried a dev reading of +1.2pp (p = 0.48) for this arm, so the two readings bracket zero;
  the arm stays as the ablation reference for "ask the model to check its own conditions".
- **The row-sample arm: +0.33pp for +31% of the prompt, and the schema layer is closed entirely.**
  `43198451668`, dev split, 1,532 scored questions, one call each, `served: deepseek-flash` on every
  case: `inline+evidence` 939 (61.29%), `inline+evidence+rows` 944 (61.62%), delta **+0.33pp**,
  discordant 52 : 57, p = 0.702, 95% CI [−1.01, +1.66], MDE 1.91 — and the price is a prompt of
  2,568 → 3,144 characters and 676 → 887 tokens (+22.4% and +31.2%). The number that decides it is
  not the interval but the parent's own drift: the same unchanged arm scored 934 on `43185842566`
  and 939 here, **+0.33pp of run-to-run resampling, exactly the size of the effect**. The
  pre-registered prediction therefore fails, and the schema layer closes entirely rather than at
  both of its ends — the hint could be dismissed because it only re-ordered a complete card, but a
  row sample is text the prompt did not contain, so nothing is left to add at that layer. The arm
  stays in the catalogue as the ablation reference that closed it.

### Fixed
- **A gate test that dated itself.** `the file this repository ships > passes its own gate` called
  `assertIntake(claims, TODAY)` with a constant frozen at `2026-11-08`, so refreshing a claim failed a
  test about the shipped file and the fix was to edit the constant — which is the moment a reader
  stops trusting the assertion, because the reference point moves with the failure. It now runs on
  `todayOf(new Date())`, the way CI does. Found by the first claim dated after the constant.
- **A case that never produced a result set no longer claims a verdict.** The five no-answer
  branches (model timeout, guard refusal, empty pool, engine error, unusable reply) each wrote
  `reason: 'values'`, and the arm counter worked around it with `&& run.error === undefined`. Every
  other reader inherited the claim: the failure corpus, `pair`, `route`, `width` and every bucket
  attribution written by hand. In the `S1-b` run 94 of 1,532 cases were model timeouts, and they
  arrived in the artifact as 94 answers with the right shape and the wrong numbers — 19% of the
  `values` bucket that four rounds of work had been aimed at. `MatchReason` is what `judgeOfficial`
  returns after comparing two result sets; a case with none has no verdict, so `reason` is absent
  and the bucket counters are restricted to failures rather than to rows.
- **The summary line says when answers never arrived.** `S1-b` printed `913/1532 59.6% strict 854`
  with nothing to say that 6.1% of the split had forfeited, 21 of them questions the other arm
  answered correctly. A denominator that quietly lost six percent of its questions is not the same
  population as one that did not, and the line reporting the score is where a reader compares it
  against something else. Printed only when it happened, so every published reading keeps its exact
  line.
- **`check-budgets` measures the import graph instead of the directory.** It summed every `.js` file
  under `dist`, so one source tree read 62,540 B (fail) and 58,891 B (pass) depending on whether a
  turbo cache replay had left a chunk the cached snapshot did not contain. It now walks from every
  `exports` target, `main` and `module` through the relative specifiers those modules name, charges
  only what is reachable, and reports leftovers as leftovers — with their size, uncounted, and the
  one-line fix. An unresolvable specifier is a broken build and is refused rather than priced. A
  `--self-test` pins the reader on fixtures: static and re-export edges, `require`, dynamic import,
  a bare package and a string literal that contains the word `from` (this repository generates SQL
  for a living), extension and directory resolution, a cycle, an orphan and a missing edge.

### Added
- **The decode mode is a request field now, not a model name.** `deepseek-chat` and
  `deepseek-reasoner` are the non-thinking and thinking modes of one base model, and both names
  were later re-pointed at new weights without a version change. A deployment that wants the
  thinking mode had exactly one way to ask for it — by naming a model — and that way silently
  changes meaning. `LlmRequest.thinking` and `ModelCapabilities.thinkingSwitch` replace it: the
  field is sent as `thinking: {type: 'enabled' | 'disabled'}` only to an endpoint that declared the
  switch, and removed-and-counted (`samplingOmitted.thinking`) on one that did not, because both
  failures are silent otherwise — an endpoint that ignores the field answers 200 and the report
  prints a mode nobody ran, and one that rejects it answers 400 that reads as a bad key. The
  pipeline option reaches every turn it makes, including the audit turn; the first version of this
  change spread the option into an object literal whose parameter type did not declare it, which
  TypeScript accepts across a spread, so the audit turn would have run in a mode nobody chose. A
  test holds all four turns to the value and fails when any of them drops it.
- **The artifact now records which model answered, not just which alias it asked for.** Every
  comparison in this repository's BIRD history calls `deepseek-reasoner` "the strong model" against
  `deepseek-chat` as "the weak" one; DeepSeek's API documentation states the two names are the
  non-thinking and thinking modes **of one base model**, and both aliases have since left the
  official model list and are routed to `DeepSeek-V4.1-Flash-1017`. A run dispatched before
  2026-07-24 and one dispatched after asked for the same string and were served by different
  weights, and no field in the old artifacts could tell them apart. `withCallCounter` gains
  `servedModels()` — the model name carried by each answer, counted per answer including answers
  with no usage block — and every arm row publishes `servedModels: {name: cases}` beside the cases
  each base served. The console line prints `served-by N` when an arm saw more than one, so a score
  drawn from two bases cannot read as a clean score. Reported, not enforced: refusing a mismatch
  would have stopped every run after the alias moved, for a change the endpoint made.
  `CaseTokens.served` carries the same fact per case, sorted and de-duplicated, because a cross arm
  legitimately asks two endpoints.
- **The `values` bucket is priced by re-execution, and half of it is free.** `bench:bird:rewrite`
  gains `ground-case-empty` (the shipped literal-grounding edit under its "returned nothing" gate),
  `ground-case-any` (the same edit with no gate) and, behind `--oracle`, `oracle-transplant` — the
  ceiling of the whole literal family, computed by substituting one same-column value from the gold
  statement and re-executing. On `select-mixed-rule` (dev 1,532, baseline 980 = 63.97%, agreement
  1,532/1,532): **`ground-case-any` 18 fired, 13 won, 0 lost, +0.85pp, p = 0.0002**; the shipped
  gate recovers 3 of those 13; the ceiling is **28 = +1.83pp**. On `inline+evidence` (937 =
  61.16%): **18 won, 0 lost, +1.17pp, p < 0.0001**, ceiling 31 = +2.02pp. Adopted on dominance
  (wins without losses, zero calls), the two adopted rules are disjoint and lift the shipped arm to
  **999 = 65.21%**, closing the MAC-SQL gap from −3.92pp to **−2.68pp**. The report now prints the
  union of wins across adopted rules and names any pair of rules that won the same case, because
  per-rule deltas add up only when nothing overlapped.
- **`--oracle` separates a ceiling from a rule.** A rule that reads the gold statement can never
  ship, so it is printed under its own heading and kept out of the union; `rewriteProblems` still
  refuses a rule that breaks a statement, oracle or not.

### Fixed
- **`statementOf` ignored the `sql` field, so every rewrite reading was priced on the failures
  alone.** The artifact publishes the statement of every case as `sql`; the reader looked for
  `predicted`, then the failure row. On a single-call artifact that dropped all 937 passing cases:
  the denominator of every `pp` was the failure set, and `lost` — the column that catches a rule
  breaking a correct statement — could not be non-zero. Fixed, and the reading it produced
  immediately found the defect below.
- **`guardNullOrder` rewrote `order by alt desc nulls last limit 1` into a statement SQLite
  refuses.** The direction test looks for `desc` at the end of the sort key and the statement's own
  `nulls last` sits after it, so the key was read as ascending and rebuilt as
  `alt desc nulls last IS NULL, alt desc nulls last`. The product ships this rule; the case it
  broke was one the arm answered correctly, which is exactly the case the defect above was hiding.

### Changed
- **`8u` fails its criterion, and the way it fails closes the model-gap line.** `42175859623`, dev
  1,532: `inline+evidence` **937 = 61.16%**, `plan` (chat plans, chat writes) **837 = 54.63%**,
  `inline+evidence+plan-cross` (reasoner plans, chat writes) **841 = 54.90%**. The pre-registered
  bars were accuracy > 939, `values` <= 462, `column-count` <= 131; the arm missed all three
  (`values` **550**, `column-count` **141**). The split *did* remove the widening — 141 against the
  reasoner's 204 — and the accuracy did not come back, so **the widening was never what cost the
  2.80pp**: the trace carries the conditions and the extra columns together, and removing it removes
  both. The one-lever comparison `plan -> plan-cross` reads **+0.26pp** (95/99, p = 0.83, resolution
  2.55pp) at 9x the completion tokens, and `inline+evidence -> plan` reproduces on the full split at
  **-6.53pp** (158/58, p = 6.8e-12). The arm is not shipped: 1,478 completion tokens a question for
  6.26pp less accuracy is a 30x bill for a regression.

### Added
- **`8u`, registered before its dispatch: the plan written by the reasoning model, the statement by
  the chat model.** The paired reading left exactly one repair — the widening is produced inside a
  trace no prompt reaches — so the two halves are split instead of instructed. `createPipeline`
  gains `planProvider` (the plan turn asks one endpoint, the generation turn another, each metered
  where it is billed), and `inline+evidence+plan-cross` puts the plan on the second model. The
  ablation pair is `plan -> inline+evidence+plan-cross` — one lever, the plan's author — because a
  pair against the shipped arm would move the plan's existence and its author at once. The
  criterion ships the arm only if it beats **both** parents: accuracy > 939, `values` <= 462,
  `column-count` <= 131. Each bar is in `docs/benchmarks.md` with the reading that would refute
  the mechanism rather than the arm.

- **The mechanism behind the model gap is now a paired difference with an interval, not two
  marginal counts.** `bench:bird:reasoning` prints `100` against `183` wider-than-gold answers,
  and a difference of marginals is not the claim: on paired data only the questions the two sides
  disagree on carry information about which one is wider. The instrument now pairs by question id —
  skipping a wildcard on either side, because `select *` is the absence of a list rather than a
  narrow one — and prints the discordant counts, the paired difference with its Wald interval, an
  exact McNemar p, and the resolution the design had. On the two dev dispatches already published
  (`42138948702`, `42142701511`, same commit, same 1,532 questions): **chat → reasoner +5.81pp
  [+4.50, +7.12], 7 discordant one way against 95 the other, p < 0.0001**, on a design that
  resolves 1.87pp. Both artifacts' A/A copies put the instrument's own displacement at
  **+0.20pp [−0.27, +0.66]** (chat) and **+0.13pp [−1.08, +1.35]** (reasoner), so the difference is
  8.8× the wider A/A bound and the widening rate is stable within each family (`12.0%` → `12.2%`).
  It also fixes a display defect the reading exposed: `toFixed(4)` published an exact p of
  `1.9 × 10⁻⁶` as `0.0000`, which is a probability no exact test produces.

### Changed
- **The instrument that prices "show the model the values" was reading a population the shipped arm
  does not have.** `bench:bird:information` selected `candidateRecall === false`, which is the right
  question for a selector arm — only a case whose pool held no answer is a prompt question — and an
  empty one for a single call, so it reported **0 cases** on every failure `inline+evidence` has. An
  empty reading is not a clean reading. The population is now stated once per arm shape
  (`noAnswerCases`), and the reading it produces reframes the next lever: of 591 dev failures, 419
  compare against a string value and **359 of those (60.7%) already had the literal in the prompt**;
  `casing` 29, `notation` 11, `absent` **20**. A stored-value block can reach at most 60 cases —
  **3.9pp of 1,532 as a ceiling** — and only 20 (1.3pp) are genuinely missing. The `values` bucket is
  therefore not mainly an information deficit, and "more values" is not the next experiment.

- **The bucket that was going to be the lever is 0.13pp of the thing it was named for.** The dev
  attribution left one candidate standing: `condition` — 61 of the 166 questions MAC-SQL wins, 3.98pp,
  the only kind above the split's 2.93pp resolution. Filing every missing condition by **where its
  value went** splits it into four rows, and none of them is the omission: **27 cases (1.76pp)** filter
  the same column with a different condition, **16 (1.04pp)** compare the value on another column
  (linking), **16 (1.04pp)** are atoms with no literal (`IS NOT NULL` and friends), and **2 (0.13pp)**
  compare the value nowhere. A repair that "writes the missing condition again" would be adding a
  filter the statement already has in 43 of the 61 cases. The census (`bench:bird:conditions`) now
  prints the same three kinds on its own 226 dev cases: 102 on another column, 71 nowhere, 126 with no
  literal, of 357 missing atoms.
- **A question-side gate cannot reach that population inside the cost it would have to fit.** The
  next lever in the plan was an audit turn fired only when the question betrays a condition the
  statement never wrote, which the plan priced at ≤10% more calls. `bench:bird:gate` measures four
  signals against the same 1,532 questions: the widest (`named-entity`) fires on 301 and reaches 83 of
  the gap cases at 28% precision — **2.0× the budget** — and the widest *inside* the budget
  (`no-predicate`, 74 fires) reaches 32, a ceiling of **2.09pp against a 2.93pp resolution**, so a
  repair that succeeded on every case it found could not be read as a gain. Both failures have one
  cause: surface matching cannot separate a value written shorter (`Alameda` for "Alameda County"), a
  value split across columns, a value attached to the wrong column, and a column-ish noun from a value
  the statement never used. **`I-45`'s gated audit is not dispatched**; the pre-check cost zero calls
  and saved about 12,300.
- **A deterministic rewrite is adopted on dominance, not on a gain.** `guardNullOrder` puts the
  unknown values last in the sort key that decides a `LIMIT`, because SQLite and MySQL sort NULL before
  every value and "the school with the lowest score" otherwise returns the school whose score is
  missing. `bench:bird:rewrite` prices it by re-execution on `select-mixed-rule`'s dev artifact (baseline
  **980 = 63.97%**, reproduced exactly on 1,532/1,532): **80 fires, 6 wins, 0 losses, +0.39pp at
  p = 0.0313**, against its own resolution of 0.40pp. Six discordant pairs cannot establish a gain, so
  the rule is shipped for what it is — free, lossless, and a statement of what the question meant.
  The same instrument prices two refusals: dropping a row cap from a counting question **loses 19 to
  win 1** (−1.17pp), and the integer-division trap fires 17 times and changes nothing.
- **The rule's own first version did not run.** `guardNullOrder` trimmed the sort clause and spliced
  `LIMIT` back on, emitting `... ASCLIMIT 1` on every fire; the instrument counted **80 broken
  statements** and refused to publish. The rewrite now echoes the key as the statement wrote it.

- **The competitor comparison now has a split where it resolves, and we lose it.** `competitors.yml`
  gained a `split` input (the four places that hardcoded `minidev` became coordinates), and
  `41953255372` ran the same two arms on the whole dev split: **MAC-SQL 67.89% against `select-mixed`
  62.99%**, Δ = −4.90pp, MDE 2.93pp, p = 3.4 × 10⁻⁶. Mini-Dev's −4.84pp had the same sign and was too
  coarse to say so; the "dev ahead by 4pp" that made this look like a contradiction was a leaderboard
  row, not this arm on this split. Three runs of the same arm on this split (955, 967, 965) span
  0.78pp, so the delta is real and future deltas under a point are not.
- **Selection cannot close the gap, even if it were perfect.** Our four candidates hold a correct
  statement on 1,031 of 1,532 questions (candidate recall 67.30%); MAC-SQL is at 67.89%. A selector
  that never chose wrongly lands 0.59pp behind them — inside the resolution, i.e. level. Everything
  above that ceiling has to be a statement we did not write, which is what the attribution instrument
  now says in numbers: 38 questions (2.48pp) selection, 125 (8.16pp) generation, and `condition` 61 of
  the 125 (`3.98pp`) is the only bucket that clears the run's own resolution.
- **The refiner's −4.22pp is retracted.** It came from 26 questions and 2 wins; on 103 questions and
  25 wins the same flags read **+14.40pp**. `refined` and `retried` fire on the same 103 questions
  because the refiner runs *because* the first attempt failed, and the instrument now prints that
  identity (`one event, 2 names`) rather than two rows that look like two findings.
- **`identical` was folding a value's case.** Two dev cases were filed as "the artifact contradicts
  itself"; `'Banned'` against `'banned'` is a `literal`, and the judge was right twice.
  `statementShape().text` drops case inside quotes because it compares shapes; `identical` now also
  requires the literals to match case-sensitively, and both cases moved to `literal`.

### Added
- **The statement an arm wrote is now part of the artifact, and there is an instrument that reads
  it.** `caseRows` publishes `sql` and `gold` per case. Until now it did not, so every sentence this
  repository wrote about *why* a run failed was an inference from result sets — `column-count`
  130 → 204 is a reading of results, and "the reasoner projects too many columns" had no statement
  behind it, which is the defect `failure-shape.ts` names in its own header (*the result set says
  "wrong", the statement says "why"*). A case that produced no statement omits the field rather than
  writing `''`, and a caller without the questions keeps no `gold`.
- **`bench:bird:reasoning`: what the stronger model wrote differently, with no model call.** Per arm
  it prints `select *`, `wider / same / narrower` against the gold's width, extra items split into
  **carried** (the statement named that column in its own filter, grouping or ordering) and
  **invented** (named nowhere, which is schema linking and not projection), missing items, and
  generated tokens on right against wrong answers. Two artifacts are accepted, because two models are
  two dispatches; the columns are labelled by the model each artifact recorded. `select *` is counted
  separately from a wide list, `count(*)` is not a wildcard, and a reply that is not a statement is an
  empty projection rather than a match — three ways this tool could have lied and does not.
- **A CTE was read as a one-column answer.** `projectionItems` anchors at `select … from`, so a
  statement opening with `with` matched nothing and fell through to "everything after the keyword is
  one item". On the 1,532-question split the reasoning model wrote a CTE on **24** cases and the chat
  model on **none**, so the misreading landed entirely on one side of the comparison it was built for.
  `outerSelect` scans by parenthesis depth and hands the outermost statement to the clause reader; a
  wildcard inside a CTE is no longer read as a wildcard answer either.

### Measured
- **Why the reasoning model loses, statement by statement.** Same commit, same 1,532 questions, same
  arm, same judge; only the model changed. `deepseek-chat` 939 (61.29%) against `deepseek-reasoner` 896
  (58.49%), with `values` 462 → 432 and `column-count` 131 → 204.
  - **The widening is the failure**: 100 → 183 statements wider than the gold (6.5% → 12.0%), while
    narrower barely moves (75 → 83). The reasoner does not write *less accurate* projections; it writes
    **wider** ones.
  - **Carried columns are the same share on both sides** — 33.1% against 33.7%, Fisher p = 0.78 — so the
    extra columns are not "what the statement already read". The mix of carried and invented is
    unchanged and only the volume grows (+172). This refutes the mechanism the projection rule was
    aimed at, which is why that rule could only redistribute.
  - **The widening lands on answers that were already right**: of the 53 cases that went
    `match → column-count`, 49 (92%) are wider than the gold.
  - **More generation, more error**: 692 generated tokens on wrong answers against 333 on right ones
    (2.08×) where the chat model is 58 against 43 (1.35×).
  - The A/A copy in each run bounds the instrument: 99/100 wider, 977/975 extra, 323/321 carried.

- **`bench:bird:pair`: two arms, one artifact, and the counts a rate cannot carry.** A delta of
  `-0.13pp` on 1,532 questions is the same number whether an arm won 64 cases and lost 66 or won 6
  and lost 8, and only the first is worth a second dispatch. The instrument prints the four cells,
  the exact McNemar over the two discordant ones, and — the part no accuracy column can show — the
  **shape transition**: a lever that repairs `column-count` shows `column-count -> match`, and a
  lever that moves the failure shows `column-count -> values`, and the two are indistinguishable in
  a score. Zero model calls, and two artifacts are refused rather than joined, because a join
  across runs puts the endpoint's own displacement back into a paired delta.
- **`inline+evidence+projection`: one rule line, and the bucket it is aimed at is a measurement.**
  The model comparison (`8q`) held every input fixed and moved 127 cases down and 70 up; the shape of
  that movement was not a general loss of reasoning — `values` fell 461 → 444 while `column-count`
  rose 130 → 204, and 59 of the 127 negative cases are filed in that bucket. A statement that ran,
  returned the right number of rows and carried the wrong number of columns is the one failure a rule
  can remove rather than redistribute, so the arm adds one sentence ("select exactly the columns the
  question asks for, in the order it names them") and changes nothing else: same card, same hint,
  same call count, `PAIRS` entry and a one-lever test on both sides of the prompt. The pre-registered
  criterion is `column-count` down with `values` not up, accuracy read against the dev split's 2.30pp
  MDE. `bench:bird:width` bounds the expectation before the run: on 496 questions the bucket is 37
  wide and 15 narrow, deleting columns recovers 11 of the 37 — a **2.22pp oracle ceiling**, below the
  dev split's resolution — and 26 stay wrong with the right width, so the width is usually a symptom
  and the bucket, not the score, is what this experiment can read. Dispatched with its parent in one
  run (`42122026848`): **939 against 941** (−0.13pp, 64 gains, 66 losses, exact McNemar p = 0.93),
  with `column-count` **129 → 124** and `values` **462 → 469**. The bucket fell and the second clause
  of the criterion refused the reading — 13 cases left `column-count` for correct answers while 28
  left it for `values` and 25 correct answers became `column-count`, so **77 cases changed shape to
  buy two net matches**. Rejected on the criterion rather than kept on a `−5`, and kept as the
  ablation reference for projection rules: the bucket was a symptom, exactly as the width ceiling
  said it would be.
- **`bench:bird:cache`: how much of every request is the same bytes as the request before it.** The
  cost page splits a prompt by block and the purpose table splits the bill by call, and neither
  answers what a budget asks. Rendering the arm's own messages and taking the longest common prefix
  says it exactly: on `select-mixed` dev, **283 characters are sent by all 1,532 questions** (the
  rules) and **2,374 are sent by every question of the same database** (the rules and the whole
  schema card) — **85.3% of a generation call**. At a cache rate of 0.1 that is `2,447 → 884`
  prompt tokens a case, **63.9% off**, and the discount lands on the generation call alone: the
  first version multiplied the whole bill by the prefix share, reported 83%, and was pricing a
  selector call as if it carried the card.
- **The meter reads the cache fields.** `usage` carried `prompt_tokens` and `completion_tokens` and
  dropped `prompt_cache_hit_tokens` (DeepSeek), `cached_tokens` (gateways) and
  `prompt_tokens_details.cached_tokens` (OpenAI) on the floor, so every cost column in this
  repository was a *list-price* column published as a bill. `cachedTokensOf` reads all three
  spellings, `withCallCounter` counts them per purpose, and the artifact gains `tokens.cached` and
  `byPurpose[*].cached` — written only when some answer reported the field, because an endpoint that
  says nothing has not said it cached nothing. The same arm, dispatched once more (`42056604480`),
  showed what the columns had been hiding: **484 of 676 prompt tokens a case were served from
  cache (71.6%)**, so the bill is **240 rather than 676 — 64.5% off list**, with 103 of the 1,532
  cases paying a cold miss. `bench:bird:cache` reads the figure from the summary row or, on an
  artifact written before it, from the per-case records.

### Fixed
- **A condition breakdown that counted 11 questions from another bucket.** `conditionKindOf` took the
  gap kind as an optional parameter, and its guard was `gap !== undefined && gap !== 'condition'` — so
  a selection failure, which has no gap at all, ran the whole taxonomy and was filed anyway. On the dev
  pairing that put **11 `pool: held` cases** into the `condition` breakdown: the instrument printed
  **21 substituted / 18 unstated / 6 absent** with a residual of 16, while its own per-case records said
  **16 / 16 / 2** and a residual of 27. The right numbers were the ones in the document, computed by
  hand — a right answer with no instrument behind it, which is the failure mode nothing catches. The
  parameter is now required (the misuse is a type error), the call site computes a kind only when a gap
  exists, and `strayConditionKinds` is checked on every run and printed as a problem line: a taxonomy
  applied outside its population is a sentence in the output, not a plausible total.

### Added
- **`bench:competitors:attribute` now splits a `substituted` value by the table it landed on**, and
  prices the `table` bucket beside it. A value on another column of the same table is a column choice;
  a value on another table's column is the table never being in view, and the two fixes cost different
  things. The split is read from BIRD's manifest (column → tables and table → columns), placed by the
  statement's own table list when there is exactly one, and reported as `unresolved` when the reader
  cannot tell — `account_id` is declared on five tables of `financial`, so the name alone decides
  nothing. On dev: **same table 9, another table 3, unresolved 4**, and the `table` bucket (17) against
  the table-level cases (3) has an **empty intersection** with a union of **20 = 1.31pp**, inside the
  2.93pp resolution. **`8p` closes without a dispatch.**
- **`bench:bird:rewrite`: what a deterministic rewrite of the statement is worth, priced by
  re-execution.** It reads an artifact, re-executes every case's gold and the statement the arm
  recorded, and **refuses to price anything unless the recomputed pass count equals the arm's published
  count exactly** — a rewrite measured against a baseline that cannot reproduce the score is a
  difference between two instruments. Three rules ship: `null-order` (adopted), `drop-limit-on-count`
  and `integer-division` (priced, refused, kept for the next reader who suspects them).
- **`bench:bird:gate`: how much of a condition gap the question alone can find.** Four signals, each
  priced on fires, cost in points of calls, reach into the gap population, precision and ceiling, with
  the plan's pre-registered 10% cost budget printed beside them and the verdict written from the
  numbers rather than from an opinion.
- **`guardNullOrder` in the AI package**, dialect-aware: ascending is the trap where NULL sorts first
  (SQLite, MySQL) and descending is the trap where it sorts last (PostgreSQL). It refuses a statement
  with no row cap, an aggregate sort key (whose ties a constant prefix reorders — priced at 7 wins and
  3 losses on dev), and a key that already states where the unknown values go.
- **`bench:bird:conditions` files every missing condition by kind** — `substituted` (a predicate
  compares the same literal against another column), `absent` (nothing compares it anywhere) and
  `unstated` (the atom carries no literal, so no wording of the question could name it) — and the
  attribution report prints the same split under the `condition` bucket.

- **Which of the competitor's wins were in our pool, priced at zero model calls.** `score.ts` ends
  with four counts and cannot say whether a question they won was one a better selector could have
  taken or one whose statement we never wrote. `bench:competitors:attribute` re-executes both sides'
  statements, judges them, and **refuses to publish a join whose four counts disagree with the score
  artifact's own**. Reading of `41856780841` (MAC-SQL 65.12% against `select-mixed` 60.28%, 496
  judged, 58/34/265/139 reproduced exactly): of the 58 questions they won, **9 (1.81pp) had a correct
  statement in our pool** and **48 (9.68pp) did not**, one record carrying no candidate statement at
  all. Over the 48, what their statement had that none of ours had is **`condition` 28 (5.65pp)** —
  a filter we never wrote — then `table` 7, `literal` 6, `projection` 3, `window` 2, `aggregate` 1,
  `grain` 1. `condition` also leads in the other direction (19 of the 34 we won), so the axis is
  where the two pipelines differ in both directions and the net is 9 questions. **The gap is not
  selection**, the largest bucket is a missing filter rather than a missing value (the value lever,
  priced twice already, accounts for six of the 48), and of every bucket only that one clears the
  run's own 5.42pp resolution — by 0.23pp, which is why the verdict line prices the axis and not a
  gain.
- **The taxonomy read the raw statements, and 472 of theirs are written in upper case.** The atom
  splitter matches `where` and `and` case-sensitively, so the first version extracted no conditions
  from MAC-SQL at all: it published `condition: 0`, filed 17 cases under `literal`, and reversed the
  conclusion above. Conditions are now read from `statementShape`, which lowercases, rewrites aliases
  and collapses whitespace; two tests hold the two halves of that (an upper-case statement and an
  aliased one). **A taxonomy built on a splitter inherits the splitter's sensitivities, and the only
  way to find out is to run it on somebody else's spelling.**
- **A lift with no contrast is not a lift, and the instrument caught itself printing one.** MAC-SQL's
  decomposer runs on every question, so the first run of the table printed `+11.69pp` for it — their
  win rate with a plus sign, the same error as a mean that is constant by construction. A flag with
  an empty half now publishes `liftPp: null`, prints which half is missing, and has two tests. What
  survives is their refiner's **−4.22pp** (it fires on 26 questions and wins 2): a mechanism that
  engages after the pipeline has already failed, which is why "reproduce their refiner" is
  contradicted by their own output.
- **The free selector became the shipped default, and the run that proves it is a measurement
  rather than a re-derivation.** `Strategy.selector` is now one name — `'none' | 'first' |
  'shortest' | 'modal' | 'model'` — instead of a boolean plus a rule, which had allowed the state
  "a selector that is also a rule". `aimed-3` is three calls and `shortest`; `aimed-4` keeps the
  fourth call and the model, and stays in the table as the ablation. `admissible` gates only
  `aimed-4`, because the rule reads executed rows and has no reply format to fail. The arm
  `select-mixed-rule` runs it end to end and records the slot the rule took on every case. Reading
  (`41947376305`, 1,532 dev questions, both arms in one dispatch, same endpoint and judge):
  `select-mixed` **967 = 63.12%** at **3.996** calls a case against `select-mixed-rule`
  **980 = 63.97%** at **3.000**, with **11.4% fewer prompt tokens**. Question-paired that is
  +0.85pp at p = 0.1980 (50:37), under the artifact's 1.71pp resolution; on the parent's own
  candidates the same-pool pairing is +0.65pp at p = 0.2820 (40:30). **The pre-registered
  significance criterion is not met and is recorded as not met** — what the round establishes is
  non-inferiority at one call less, plus the empty-pool fallback exercised on 53 cases where every
  candidate returned nothing. Handing the rule arm's artifact back to `bench:bird:consensus`
  reproduces its score case for case (63.97% against 63.97%, 0 won / 0 lost, p = 1.0000), which is
  the identity that makes the offline rule instrument and the pipeline the same object.
- **Three guards for a selector that spends nothing.** `assertRuleSelection` refuses a rule with no
  candidate set and a rule declared beside a lever only the model branch reads (`pairwise`,
  `judge`, `agreement`, `reconcile`, `sourcesVisible`, `dissentVerify`, `canonical`);
  `assertReportComplete` refuses a rule arm whose row carries no `selectorRule` funnel, because its
  `calls.mean` equals the candidate count whether the rule ran or the vote did; `BIRD1` refuses a
  rule arm that reports more calls than candidates or prices decisions it never bought. Both
  directions of the gate rule have a self-test.
- **`split` is a coordinate of the competitor comparison.** The workflow offers `minidev` and
  `dev`, keys the dataset cache by split, and both adapters resolve their dataset root from
  `BIRD_SPLIT` and refuse a third value before the first model call. The `limit` default is blank
  rather than 25, because blank is what "the whole split" means to the runner and a non-empty
  default silently decided the sample size once already. The contradiction this exists to test is a
  sign: MAC-SQL leads by 4.84pp on Mini-Dev and our published dev row leads by four.

- **A zero-row statement is repaired by looking the value up, and the lookup is free.** The state
  was priced last round: on 496 dev questions whose databases are in this checkout, 19 (3.83%) had
  every candidate return nothing, the selector was right on none of them, and 18 of the 19 had
  written a literal the database does not contain. That is a lookup failure, so the repair is a
  lookup. `probeValueGaps` (`eval/bird/value-probe.ts`) reads each literal the statement compares
  against a column (`=`/`!=`/`in`/`between` sites, at most six literals per statement) and asks the
  engine which of that column's values contain it, ignoring case — one query per column, no model
  call. Three outcomes are acted on and no others: a column that stores the literal in another case
  is **grounded deterministically** and adopted when the rewrite returns rows (**zero calls**); a
  column that stores values *containing* the literal has those values quoted back; a literal no value
  contains is reported as a fabrication. `buildValueGapFeedback` renders that message inside the same
  900-character ceiling the repair turns live under, and `emptyRetryMessages` gains the `values` mode
  and degrades to the diagnosed text when the lookup found nothing — an extra call that says nothing
  would be the blind control by accident. The lookup is not fuzzy: no stemming, no edit distance, and
  two columns storing two spellings (or one storing the literal as written) leave the substitution to
  the model, because a guess dressed as a lookup is still a guess. The arm is `select-mixed+values`,
  one lever from `select-mixed+empty`: same drop, same call count, different words.

- **`chooseCandidateByRule`: the cheap side of a selection, as a library function.** `first`,
  `shortest` and `modal`, returning the same `{index, decided, sql}` the selector returns, with
  `decided` always true and no generation spent. The readings that justify it are on the dev split
  (`41767687844`, 1,532 questions, read from the artifact and not from a new run): the selector
  scored **62.79%** against the shortest statement's **62.86%** on `select-mixed`, and **62.47%**
  against **63.25%** for the shortest of the three generated candidates on `select-intent` — 969
  cases from a rule that costs nothing, against 957 from a call per case. Neither difference
  reaches the split's 2.30pp, which is the point: a deployment that cannot afford a fourth call is
  not choosing between a better and a worse pipeline, it is choosing how to pay for the same one.
  The result-set key the modal rule needs mirrors the devkit's `resultKey` rather than importing it
  (PKG2 forbids a production package from depending on the devkit), and a test asks both the same
  question over every value type a SQLite result carries, so the mirror cannot become a second
  definition of equality.

- **A result with no rows is not an answer, and that is the first free rule here to beat the
  selector significantly.** Every free rule now ranks only the candidates that returned rows,
  falling back to the whole set when all of them are empty so that a question whose answer really
  is empty still gets an answer. The evidence is a count rather than an argument: **586 empty
  results over two dev artifacts and four arms, and not one of them was right** — 223 under
  `select-mixed` and 287 under `select-intent` on the 1,532-question artifact, 87 and 76 on the
  600-question one. A result set with no rows is equal to another empty result and to nothing
  else, so an empty candidate can only be right when the true answer is empty, and no question in
  either artifact has an empty answer. On 1,532 questions `shortest` goes 963 → **975 = 63.64%**
  against the selector's 62.79% for one call less; on the 600-question strong artifact
  (`41795505400`, `select-balanced`, two `deepseek-reasoner` slots) it goes 384 → **391 = 65.17%**
  against 62.00%, **+3.17pp at p = 0.0163** — the first call-free rule in this repository that
  beats a paid selector by more than the split resolves, and the highest score any configuration
  has reached. The harness applies the same exclusion, keyed on `resultFingerprint([])` rather than
  a second definition of empty, and the cross-implementation test that already held the two to the
  same slot now also covers an empty candidate.

### Changed
- **The first best-vs-best comparison puts this repository 4.8pp behind MAC-SQL, not ahead of it.**
  `41856780841` ran `wbbeyourself/MAC-SQL` at its pin and our adopted arm on the same 498 Mini-Dev
  questions, at the same endpoint (`deepseek-chat`) and scored by the same executor and judge:
  **323/496 = 65.12%** against `select-mixed`'s **299/496 = 60.28%**, 58 cases only theirs and 34 only
  ours, **Δ = −4.84pp, exact p = 0.0160**. The instrument also prints `resolves: false` for the ±2pp
  the dispatch asked it to size (3,640 questions would be needed), which is not a contradiction: the
  paired test rejects "no difference" and the split cannot yet say how big it is. Against the earlier
  pairing (`41169541647`, `metadata+evidence` at 59.27% against 65.73%, p = 0.0027) the adopted arm
  closes **1.6pp** of a 6.5pp gap, while the competitor itself drifted 0.6pp between the two runs —
  that is the scale on which the narrowing should be read. **A leaderboard number compared with
  another leaderboard number is an assumption wearing a table**: on the one split where both
  pipelines were run by one instrument, this repository is behind, and the difference is pipeline
  rather than model because both sides called the same endpoint in the same run.

- **`I-95` closes without a dispatch: the lever it names is the family whose oracle already ran.**
  The plan's next item proposed putting each column's most frequent values on the card, for the 33
  of 50 triggered cases that wrote a literal no column stores. That is the `samples` family, whose
  registered ceiling ran in `41620796848`: `inline+evidence+samples-gold` — the same sampler shown
  **exactly** the columns the gold statement filters on — reads **944 = 61.62%, +0.72pp (36 up /
  25 down, p = 0.2000)** against a bar of +1.5pp, and the wide form reads 952 = 62.14% (+1.24pp,
  p = 0.0756). The price measured this round closes it twice over: the wide block is **+38.4% of
  the card**, where the criterion allows 5%, and the narrow block is +1.4% while being an *oracle*,
  so no realizable column rule can beat it. Its reach is 511 of 1,532 cases, where it reads
  **+1.76pp = 9 questions = 0.59pp of the split**, against a bar of 15 questions. Criteria ①, ② and
  ④ therefore all fail on readings that already existed, and they fail without a call being spent.
  This does not say the 33 fabricated literals are beyond repair; it says the repair is not "show
  the values on the card", which is now the one form of value grounding this repository has priced
  twice.

- **The zero-row lookup works; the lever around it does not clear its bar.** `41830439625` ran
  `select-mixed`, `select-mixed+empty` and `select-mixed+values` over all 1,532 dev questions in one
  artifact: **967 = 63.12%**, **973 = 63.51%** and **973 = 63.51%**, with ceilings 67.49%, 66.91%
  and 67.10%. The mechanism behaved exactly as designed — on the 50 questions the control retried,
  33 had a literal the columns do not store, the lookup spent **96 queries and no calls**, four were
  settled by a case-only grounding and adopted for free, the turn recovered 20 cases against 19 and
  8 of those were correct against 6 — and the triggered subset moved **9 correct against 6**. It
  still scores the same, because 18 questions moved one way and 18 the other: the arms generate
  their own candidates at temperature 0.7, so a sub-1pp paired difference is a redraw. Criterion ①
  (**17.6% of triggered, bar 25%**) and ② (**0.00pp, bar +0.96pp**) both fail, and per the
  pre-registration the 3.85pp goes to **dropping the state and reporting it** rather than to a
  repair. Criterion ③ was mis-specified and is recorded as such: "no change on the 96.2% that never
  trigger" is only checkable if the two arms share their candidates, which these do not, so 31 of
  1,479 differ by construction. The empty filter on its own is **+6 cases** (24 up / 18 down,
  p = 0.4408), the same sign as the +12 measured on the previous full split and small enough that
  neither reading resolves it.

- **The full split confirms the strong-model ceiling and, for the first time, a free rule beating a
  paid selector.** `41808092447` ran both pools over all 1,532 dev questions with a second endpoint
  in the same vendor: `select-mixed` **959 = 62.60%** against `select-balanced` **941 = 61.42%**
  (61 up / 79 down, p = 0.1505), with the ceiling **1,022 = 66.71%** against **1,055 = 68.86%** —
  **+2.15pp, 72 up / 39 down, p = 0.0022** — and conversion 93.84% → 89.19%. The 600-question
  reading of +2.83pp was optimistic by a quarter, which is what that sample's 3.6pp MDE predicted.
  The mechanism is the same one and now visible at full width: changing the author moved **212
  questions out of unanimity** and removed **118 wrong unanimous votes** (371 → 253), even though
  both reasoning sources are individually worse than the chat sources they replaced (57.8% / 58.5%
  against 62.0% / 61.8%). And `shortest` on the strong pool is **976 = 63.71%** against the same
  pool's selector at 61.42% — **+2.29pp, 84 up / 49 down, p = 0.0030**, on 3.00 calls instead of
  4.00 — which is also +1.11pp above the arm to beat and the highest score any configuration has
  reached on the full dev split. The previous round's verdict that a call-free rule cannot beat the
  selector by more than the split resolves is withdrawn: what changed was not the rule but the pool
  it reads, once the empty results were removed from it.

- **A stronger author raises the ceiling by 2.83pp and the selector gives back 6.10pp of conversion.**
  `41795505400` ran `select-mixed` against `select-balanced` (two `deepseek-reasoner` slots and one
  `deepseek-chat`) on dev's 600 questions, both arms in one artifact: **382 = 63.67%** against
  **372 = 62.00%** (21 up / 31 down, p = 0.2116), with the pool ceiling **408 = 68.00%** against
  **425 = 70.83%** (**+2.83pp**, 29 up / 12 down, p = 0.0115) and conversion **93.63% → 87.53%**. The
  instruction was that a reasoning model would produce better candidates, and it does. What the
  reading adds is *why*: both reasoning slots are individually worse than the chat slots they
  replaced — 61.7% and 59.8% against 63.0% and 62.1% — and the pool is still 2.83pp higher, because
  their errors do not overlap with the chat author's. A weaker author that errs elsewhere is worth
  more than a stronger one that errs in the same place, which is `I-74`'s finding read from the
  other side: changing the *author* buys independence, changing the *wording* does not.
  Conversion now has three readings in one direction — 93.63% on three chat candidates, 90.45% on
  four, 87.53% on two reasoning plus one — so the better the candidate set, the less of it the
  selector converts. Read from the same artifact at zero calls, `shortest` scores **384 = 64.00%**
  on the strong pool against the selector's 372 (38 up / 26 down, p = 0.1686) and 372 against 382 on
  the weak one (14 up / 24 down, p = 0.1433): the two rules trade places with the pool, neither
  difference is significant, and the rule costs 3.00 calls instead of 4.00. The best number in this
  document is therefore produced by spending one call fewer, which is the clearest statement yet
  that the fourth call was never the thing being bought.
- **The samples family closes, and it closes against the oracle.** `41620796848` ran the three arms in
  one artifact on dev's 1,532 cases: `inline+evidence` **933 = 60.90%**, `+samples` **952 = 62.14%**
  (+1.24pp, 61 up / 42 down, p = 0.0756), `+samples-gold` **944 = 61.62%** (+0.72pp, 36 up / 25 down,
  p = 0.2000). Criterion ① fails (**+0.72pp** against the +1.5pp it had to clear) and ② fails with the
  sign that matters: **the oracle is 0.52pp worse than the wide sampler**, 36 up and 44 down,
  p = 0.4340. The funnel says why. The gold block carries 644 columns on **511** of 1,532 cases —
  on 1,021 of them the gold statement filters on no profiled column, so there is nothing to narrow
  to — and it is worth **+1.76pp where it lands** (24 up, 15 down) and +0.20pp where it does not. The
  wide sampler reaches 1,347 cases with 16,109 columns for +1.24pp. Knowing which columns matter is
  therefore worth about a point and a half on a third of the split, and **no realizable rule can
  occupy the space between +1.24 and +1.5**. The wide block survives the verdict as a *candidate
  source* rather than a column rule, because +1.24pp at p = 0.0756 is underpowered (dev MDE 2.30pp),
  not null, and a source raises the pool's 68.93% where a sampler only converts it.
- **Two runs of one arm, two hours apart, differ by 33 cases.** `inline+evidence` scored **900 = 58.7%**
  on `41605217563` and **933 = 60.90%** on `41620796848` with the same arm, split, model and
  temperature. The earlier run sat inside the window in which the third arm lost 12.1% of its calls
  to 503s, so part of the 2.2pp is an outage and part is re-sampling, and the artifact cannot
  separate them: a refused call and a wrong answer are one row each. That is now the largest number
  in `docs/benchmarks.md`, larger than every delta it published this week, and it is the argument for
  the instrument added below.
- **Three prompts carry no more independent opinions than three samples of one prompt.** `I-74` ran
  the separation the candidate side never made — `vote` (three draws of one prompt at 0.7) against
  `vote-mixed` (three prompts, one draw each) on the same 160 questions, 960 completions and no
  selector call. **Distinct results per case: 1.15 against 1.12**, unanimity 87.50% against 89.24%,
  ceilings 68.13% against 69.62% — the same dice either way. So the pool's disagreement is sampling
  variance, not heterogeneity, and **82% to 85% of the losses are cases where every candidate agreed
  on the same wrong rows**: a knowledge failure that neither an extra sample nor a new wording moves.
  This is why the fourth opinion added 22 to 27 ceiling pieces and was still the weakest candidate,
  and it is the baseline (`1.12`) that any lever claiming to add knowledge has to beat.
- **The candidate side closes negative, and the measurement that closes it is a contingency table.**
  The pairwise arm (`41561960657`, dev 1,532) scored 941 against its parent's 940 — +1 case, 5 up and
  4 down — with 102 comparisons of which it overturned 10: **0 of the 20 where overturning would have
  paid** and 8 of the 40 where it could not. The bought opinion is right on 21.6% of the disagreements
  against the incumbent's 41.2%, so any judge that ranks by "which looks more correct" keeps the
  incumbent; that is prior dominance, not position bias. With the fourth opinion's ceiling at 1,056
  (68.93%) and CHASE-SQL's end-to-end at 76.02%, a perfect selector would land 7.1pp below the
  competitor: the gap is above the candidate set, so the next lever is generation, and its criterion
  is the ceiling (≥ +4pp) rather than the score.
- **A push whose only code is tests no longer buys thirteen arms over the split.** The scope filter
  that decides whether a push is measured (`tools/ci-scope.mjs`) knew one inert class — Markdown — so
  a commit that added tests and a changelog line re-priced the whole BIRD chain, roughly 6,400
  completions, to learn nothing. The red step of a TDD round is written before the implementation
  exists and is exactly the push that should cost nothing: the number comes from `eval/` and
  `packages/`, and `test/` is run by the `quality` job, which is never skipped. The two suites the
  repository has are named rather than pattern-matched (`test/` at the root and
  `packages/<name>/test/`, plus a colocated `*.test.ts`), so `eval/test/…` is still measured and a
  directory nobody argued for cannot buy a skip; the two conservative edges are unchanged — an
  undescribed list and a truncated one both measure.
- **The reconcile line is closed, and the reason is measured rather than argued.** The sixth dispatch
  (`41462471819`, 600 dev questions) ran the five-arm reading the policy was built for:
  `select-cross` 62.50%, `-pooled` 62.33%, `-vote` **63.17%**, `-reconcile` 59.00%,
  `-reconcile-novel` 60.50%. Handing the restatements back is worth **+9 cases** (354 -> 363), which
  confirms the fifth dispatch's diagnosis, and it is not enough: the arm is still 16 short of the
  free count. Cutting the artifact by the arm's own records shows where those 16 live — on its 82
  novel cases the count is right 34 times and the arm 18, and its 518 declined cases are identical to
  the vote case for case. So the pipeline around the lever is exonerated and the remaining gap is the
  model's own writing, which no prompt or policy in this repository changes. The next lever has to
  change what the candidates are (I-45, I-77), not what is done with them.

### Fixed
- **The cost instrument could not see the block it was pricing.** `bench:bird:card` renders the
  prompt an arm sends, and for the arms that carry stored values on their card it rendered the
  **parent's** card: `promptOf` built the schema, attached the definitions, pruned — and never
  attached the values, so `buildAskMessages` was told `samples` and found nothing to render. The
  two stored reports prove it without a run: `eval/out/card-select.json` and
  `eval/out/card-inline+evidence+samples-gold.json` are two different arms with the **same** card
  cost to the tenth of a character (2,121.4 mean). The block that two source comments and
  `docs/architecture.md` price at +38.4% of the card therefore had no reproducing instrument in
  this repository. `storedValuesFor` now reads the cache the run writes (profile or competitor
  example set), `promptOf` layers it on the resolved card **before** the prune — the order the run
  uses — and narrows it with the same `conditionColumns` when the arm asks for the gold's columns;
  a cache the run never wrote throws rather than rendering the parent's card, and `bench:bird:join`
  and `bench:bird:info` read the same block through `blockReader`, so the three instruments cannot
  disagree about which card an arm sends. `bench:bird:info` had the same blind spot in its own
  renderer, with the same shape: `buildAskMessages` told to draw brackets, nothing attached. Re-derived by the fixed instrument over the 500 Mini-Dev cases and all eleven
  databases: **1,479 → 2,047 characters (+38.4%)** for the wide block and **1,479 → 1,499 (+1.4%)**
  narrowed to the gold's filtered columns, with 451 of 500 cases carrying a bracket. The quoted
  number was right; it is now measurable. The block itself is **568 characters a case**; the share
  depends on the base — on an artifact whose inline arm carries its definitions the same card is
  2,121.4 characters and the same block is +26.8% — so the characters travel and the percentage
  does not. Ten tests pin it, including the class guard that was
  missing — **every arm that declares a block must render a card that differs from its parent's**,
  which is the one that would have caught this.

- **The baseline gate rejected a report it should have accepted.** `BIRD1` knew two ways for an
  empty-result arm to speak (`diagnosed`, `blind`) and the third — `values` — reached it as an
  unknown mode, so `41830439625` failed at the accuracy floor with all of its own controls green.
  The mode is named, the funnel is now checked for the two counters the free half adds
  (`grounded`, `adoptedFree`, plus `probeQueries` and `literalGaps`), and the "recovered more cases
  than it retried" rule is arithmetic over both halves, because a grounded statement is adopted
  without a call. Three self-test mutations were added — an arm that adopts more statements than it
  grounded, one that never reports the lookup, and one that recovers four of three retried cases by
  grounding — and the fixed gate was then run against the real artifact, where it passes.

- **A per-case record the lever wrote was not in the artifact.** `CaseRun` carried what the zero-row
  turn did, and `caseRows` projected none of it: the arm funnel said how many cases triggered and
  the file could not say which, so "the lookup answered this one without a call" was a number with no
  rows behind it — the same defect the reconcile turn and the value block each had on their first
  dispatch. `emptyRetried`, `emptyRecovered` and the lookup's own `emptyProbe` are now published per
  case. Nothing published before this release changes: the three fields are additive.

- **`shortest` ranked the candidate that wrote nothing as the minimal answer.** `consensus.ts` read
  a statement's length directly, so an empty statement scored zero and won every comparison it
  entered; the library ranks a blank statement last, and the test that holds the two
  implementations to the same slot on the same rows is what found it. No published reading moves —
  the artifact this was measured against carries a statement for all 10,380 candidate records — but
  an artifact from a run where a source returned nothing would have been scored under the wrong
  rule. The blank case is now a refusal in both implementations.
- **The benchmark workflow sent the second provider's key to the first provider's endpoint.**
  `41791956315` dispatched `select-balanced` with `second_provider=deepseek` and no endpoint, so
  `BIRD_SECOND_API_KEY` became DeepSeek's secret while `BIRD_SECOND_BASE_URL` stayed on the
  workflow's default — Zhipu's host. Preflight answered `401 令牌已过期或验证不正确` and the run
  never reached a question: a valid key, a right model name, an endpoint belonging to another
  vendor. The message blames an expired token, which is the one thing that was not wrong. Only one
  of the two inputs keeps a default now: the endpoint is derived from the provider, and the input
  that overrides it starts empty, so the pair cannot disagree unless the caller spells both. Two
  tests read the workflow and fail on the old wiring, verified by restoring it.
- **A count in the previous commit's message was wrong, and the correction is larger than the
  error.** `ad7fe95` reported 87 and 76 empty candidates "on the 1,532-question artifact"; those
  were the 600-question numbers. The whole split carries **223 and 287**, so the reading is 510
  rather than 163 for the two arms, plus 76 for the strong arm that the smaller artifact alone
  measures. No published rate moves — the rates were computed from the artifact, not from the
  message — but a count in a commit message is a claim like any other, and a wrong one in the log
  is worse than a wrong one in a comment because it cannot be edited.

### Changed
- **The third slot answers its question: it does not matter.** `41673950028` ran the corrected
  `select-mixed` and `select-samples` in one artifact on dev's 1,532 cases — **958 = 62.53%** against
  **969 = 63.25%**, +0.72pp, 30 up / 19 down, exact McNemar p = 0.1524 — and two of the four
  pre-registered criteria fail: ① the gain is under the +1.0pp that separates a lever from a
  preference, and ② the sampled source is sole-correct on **32** cases against the **36** dev needs
  before a source can move the ceiling. ③ (3.992 / 3.993 calls) and ④ (1,347 cases with values,
  16,109 columns) pass. So `values` keeps the slot, and the `samples` family closes twice over: as a
  column rule and as a candidate source.
- **The card fix is neutral, and that is the round's cleanest negative.** `select-mixed` as three
  genuinely different prompts scores 958 against the 955 that the one-card semantics produced. The
  difference is a cross-run comparison, which the 33-case drift forbids reading as a delta — so it
  is a neighbourhood, and the neighbourhood says **prompt diversity was not the binding constraint
  either**: a more diverse candidate set moved nothing in a set the selector converts at 90.4%.

### Fixed
- **The cost column priced the arm's card, not the candidates it sent.** `promptChars` reported
  **2,568 mean characters for both** `select-mixed` and `select-samples`, because it built the prompt
  from `cardOf(arm, …)` — the parent's card — while one of `select-samples`' three calls carries
  16,109 columns of stored values. A mixed arm's size is now the **widest candidate's**, which is
  what the model read; the arm's real bill is roughly +15% prompt characters over its parent.
- **A mixed arm sent one card to all of its candidates while its guard measured one card per
  candidate.** `select-mixed` calls itself three prompts; the run built the arm's card once per case
  and printed every candidate on it, so `metadata+evidence` — descriptions as a block, joins listed —
  arrived as a byte-for-byte copy of `inline+evidence`. `distinctShare` computed each prompt with its
  *source's* card, so the two ends disagreed about what the arm was, and the disagreement was
  invisible because no existing source declared a card-level lever of its own. `select-samples` is
  the first that does, and it failed on its first dispatch: `arm select-samples builds no question
  with 3 distinct prompts … it would pay 3 times for one opinion on every case`, on all 1,532 cases.
  A candidate is now sent on its source's card, which is what the arm's name has always claimed and
  what the guard has always measured.
- **The block loaders asked `BIRD_ARMS` instead of the arms the run reads.** A mixed arm names its
  sources only in `mixed`, so `samples`, `samples: 'example'`, worked examples, synthesized
  definitions and the training split were all decided from a list that did not contain them:
  `select-samples`' third source carries the sampled block, no *arm* in the list declared a sampler,
  the profile's value lists were never attached, and three prompts were two. `armsInEffect` answers
  the question once — the arm list plus every source those arms draw from, each named arm counted
  once — and the four loaders and `armsNeedRetrieval` all read it.
- **A mixed arm published no `sampleBlock`.** The block rides on one candidate, so the arm's own card
  has none and the funnel was dropped. It is now counted per case as the widest candidate's bracket,
  which is what the pre-registered criterion for `select-samples` reads; a pooled arm, which draws
  nothing, still publishes none rather than a zero.

### Added
- **The fourth candidate moved the pool's ceiling by 2.22pp, and selection ate all of it.** `41767687844`
  ran both arms on dev's 1,532 cases: `select-mixed` **962 = 62.79%** against `select-intent`
  **957 = 62.47%** (−0.32pp, 29 up / 34 down, p = 0.6147), and the ceilings are **1,024 = 66.84%**
  against **1,058 = 69.06%** — **+2.22pp, 41 gained and 7 lost, p < 0.0001**. This is the first time
  since `select-mixed` that any lever has raised the pool ceiling rather than redistributed it, and the
  price is exact: conversion fell **93.95% → 90.45%**, so a fourth candidate buys 2.22pp of ceiling and
  costs the selector 3.50pp. At the parent's conversion rate this pool would score
  `1,058 × 0.9395 = 64.88%`, which is +2.09pp — a number that is not a reading but the price of the
  next lever, and the reason the next round is a selector that reads four candidates rather than a
  fifth candidate.
  The registered criteria read: ① ceiling **pass** (+2.22pp) but sole-correct **fail** (**28** against
  31), ② conditional density **pass** (32 of 410 rendered = 7.80%), ③ rendering **pass** (87.4%),
  ④ cost **pass** (4.999 calls), ⑤ conversion **fail** (90.45%). So the lever is adopted as a ceiling
  lever and not as a score lever, and the arm stays with `select-mixed` as the one to beat on the pool
  question.
- **A query-intent renderer, and a fourth candidate that exists to move the pool's ceiling.**
  `packages/core/src/semantic/intent.ts` turns a JSON query description — tables, join column pairs,
  filters as `(column, op, value)` triples, grain, order — into a statement, deterministically. Three
  rules are the reason it is a compiler rather than a prompt: identifiers are validated and never
  quoted (a double-quoted token that names no column is read as a *string literal* by SQLite, so an
  escaping strategy fails silently on the engine this benchmark runs), literals are rendered from
  values rather than copied from text, and expressions are tokenised and parsed against a closed
  grammar. Ten optional keys, one function set, and **sixteen refusal names** split into two families
  that call for opposite fixes — a reader failure (`no-object`, `not-json`) is a format instruction the
  model ignored, a grammar failure (`unsupported-function`, `bad-identifier`) is a vocabulary that was
  too narrow. The histogram is the data the grammar is designed from, which is the only way to answer
  "how wide should it be" without guessing.
- **`select-intent`: the shipped trio plus one candidate whose statement is rendered.** One lever from
  `select-mixed` — same three prompts, same card, same selector — and one call more, which the report
  publishes rather than hides. The pre-registered criterion is the ceiling, because a fourth candidate
  cannot lower it: `select-mixed` reaches 67.75% of dev, so this arm has to reach **69.75%** (+2.0pp,
  ~31 sole-correct cases the trio misses) or the lever is reverted and only the instrument stays.
  `assertIntentRule` refuses to dispatch the `intent` arm alone — its statement is rendered on the
  candidate-source path, and a JSON reply read by a statement reader would publish a near-zero
  accuracy that looks like a weak prompt instead of a wiring mistake.
- **The first probe's refusals rewrote the grammar, and the histogram is why it could.** `41748908122`
  ran 40 dev questions: the intent source rendered **30 of 40 = 75%** and refused 10, which is
  criterion ③ already at its floor, and the refusal names split `bad-expression` 5, `bad-identifier` 2,
  `bad-operator` 2, `bad-value` 1. That is a vocabulary reading, not an accuracy reading: five of ten
  were `case`, so searched and simple `case when .. then .. [else ..] end` is now in the grammar,
  along with comparisons (`=`, `<>`, `>`, `>=`, `<`, `<=`, one per operand and never a chain), `||`, and
  `between` / `not between` as the one operator that takes exactly two bounds. The tokenizer reads two
  characters before one, or `>=` would become `>` and a stray `=` and the refusal would name the wrong
  cause. `IntentRecord` also publishes `detail` — the compiler's own message, truncated to 160
  characters — because a name says which family failed and not what to add next, and a histogram of
  names without details can only rank the families. It reaches the artifact as `intent.refusedCases`:
  three per name, with the case they came from.
- **Names are quoted when the corpus spells them with a space, and the schema is what makes that
  safe.** The second probe's largest refusal bucket was `bad-identifier` (14 of 120), and the reason is
  the corpus: BIRD's `california_schools` stores `County Name` and `Charter School (Y/N)`, which is
  4.6% of the columns in the benchmark's own databases and all of them unnameable by a bare-word
  lexer. Names are now checked for what cannot appear in one (a control character, a semicolon, a
  comment marker) and rendered double-quoted otherwise — in filters, joins, group-by keys, and inside
  expressions, where `"County Name"` is a name and `'County Name'` is a string. Quoting is also what
  makes the column list load-bearing rather than advisory: SQLite reads a double-quoted token that
  names no column as a string literal, so `compileIntent(value, { columns })` refuses it as
  `unknown-identifier` (the seventeenth name), and the harness passes the card's columns on every
  call.
- **Six ways a correct reply was being refused, all of them the contract's fault.** The third probe
  kept the sentence for every refusal it sampled, and twelve sentences said nine of them were ours:
  `IS NULL` because the operator list is lower case, `"value": null` on a nullary operator, `x in 'a'`
  because a one-element list was not written as one, `having: [{column: "n"}]` because a select alias
  was looked up in the schema, `having: [{column: "count(p.Id)"}]` because a filter's left side could
  only be a name, and `f."School Name"` because a tokenizer read the quoted half as a stray dot. Each
  is now read as what it means: operators match without case, a `null` value on `is null` is a missing
  value, a scalar on `in` is a one-element list, a select alias is a name the statement invents, a
  filter takes `expr` when its left side is an aggregate (the key the select list already uses, because
  `column` cannot carry one — a column name may itself contain a space and a parenthesis), and a
  qualified quoted name is one reference. The rule line gains two sentences for the two refusals that
  are the model's: an aggregate on the left goes under `expr`, and distinct rows are the top-level
  `distinct` key rather than DISTINCT inside an expression. The quoting change before this one lifted
  rendering from 75.8% to **96 of 120 = 80.0%**; what these six lift it to is the next dispatch's
  question, and the prompt is still 1,071 characters.
- **A numeric spelling of a name is refused, because three engines read it three ways.** Quoting made
  `1` in a group-by key a *string*, which on SQLite is a constant — `GROUP BY "1"` groups every row
  into one bucket and answers a different question. In Postgres the same token is a position, in the
  standard it is a constant, and none of the three is "this column". The contract names columns, so a
  numeric spelling is `bad-identifier` now; an order item is an expression rather than a name, so a
  number there stays a number and `ORDER BY 2` keeps meaning what it meant.

- **The third candidate slot priced as a swap rather than a purchase.** `select-samples` is
  `select-mixed` with one field changed — `mixed` — so both arms cost four calls. The slot it takes
  from `values` is the weakest purchase in the catalogue: the value index is empty on **933 of 1,532**
  dev questions (60.9%), while the sampled card lands on **1,347**. Criteria are registered before
  the run (`41638466376`): ≥ +1.0pp, the sampled source sole-correct on ≥ 36 cases beyond the other
  two, `calls.mean` 4.00 on both, and `sampleBlock.withValues` ≥ 1,300 in the new arm.
- **A run-to-run drift instrument that splits the endpoint's re-sampling from a change on this side.**
  `pnpm bench:bird:drift <left.json> <right.json> [--arm <name>] [--strict]` pairs two artifacts case
  by case and publishes, per arm, the move, the discordant pairs with exact McNemar, how often a case
  changed its verdict, and **whether the prompt was the same** — `prompt` tokens *and* `chars`, because
  a token count is the tokenizer's view and a character count is the prompt's, and `I-84`'s pair had
  every token identical on 1,532 cases while 42 statements changed. A flip under an identical prompt
  is the noise floor; a flip under a moved prompt is this side; a flip whose prompt size one artifact
  never recorded is `unknown` and is not attributed. Four refusals (a file against itself, two splits,
  no shared arm, a case carried twice) and five printed problems (a different model, judge, dialect,
  moved prompts, unrecorded sizes) keep a comparable pair from being read as an A/A. Offline, no call
  spent; 33 tests, 98.85 / 98.85 / 100.00 / 99.00 across the four dimensions.
- **The schema is masked out of the worked examples, which is DAIL-SQL's masked variant and the answer
, which is DAIL-SQL's masked variant and the answer
  to `I-83`'s failure table.** `eval/bird/mask.ts` replaces every name that belongs to another schema
  with `table_1`, `column_1`, … and rewrites the MySQL and T-SQL spellings into the dialect the harness
  executes; `MASKED_PREAMBLE` says what a placeholder is, because `table_1` is a valid table name and
  the cheapest thing to do with an example is copy it. The arm `metadata+evidence+icl-masked` is one
  lever from `metadata+evidence+icl`: same retrieval, same `k`, same card, **same number of examples**
  — the masked block is cut to the raw block's width because a masked example is shorter, and the pair
  would otherwise differ in count as well as in text. Measured on Mini-Dev's 500 gold statements, the
  mask leaves **0** of them carrying a word that is a table or column name in its own schema.
- **The mask has its own instrument, because a text transform fails silently.** A masker that matches
  nothing sends the parent's prompt and publishes the parent's accuracy as the lever's reading. So
  `demonstrationsFunnel` now publishes `rewritten` beside `examples`, `assertMaskingFired` refuses a
  bank of a hundred cases in which nothing was rewritten, `assertReportComplete` refuses a masked row
  whose funnel carries no count, and `assertMaskingRule` refuses at the declaration an arm that names
  the mask and carries no examples.
- **Four defects in the masker, found while writing it, all of one class.** `1.` is a number and the
  dot after it is not a qualifier (`select 1. from t` came out as `select 1. column_1 table_1`);
  `extract(year from d)` contains the word `from` and had `d` masked as a table; `with t as (` bound
  the name at neither end; and a keyword set cannot tell `interval 30 day`'s unit from
  `formula_1.races`'s column, which leaked four statements of Mini-Dev's 500 until the rule was
  rewritten to read position instead of membership.
- **The one component of CHASE-SQL's pipeline never stacked on this repository's strongest arm, and
  the guard the last unguarded lever was missing.** `metadata+evidence+icl` and `inline+evidence+icl`
  put retrieved worked examples *on top of* the dataset's per-question hint; `inline+icl` had only
  ever put them *instead of* it, so retrieval was priced as a replacement (41-42% on Mini-Dev) and
  never as an addition. The criteria are registered before the dispatch: the stacked arm must reach
  **+4.0pp** over `metadata+evidence` (61.03% → ≥65.03%), the block must land on **≥50%** of cases
  with `examples` published beside it, `calls.mean` must stay exactly 1.00 with **≤+40%** prompt
  tokens, and a gain below +1.0pp closes retrieval-based knowledge as a lever — the next mechanism
  would then have to *synthesise* examples rather than retrieve them.
- **`demonstrations` is now a guarded mechanism.** It was the last lever that acts at runtime with no
  check that it acted: an arm that declares the block and receives none — no neighbour carrying a
  statement, the renderer's budget eaten by its first example, a run that built nothing — published
  as "the prompt with worked examples scored X". The block is counted per case (`examples`), refused
  at zero on any bank of a hundred cases, and published as `demonstrations: {cases, blocks,
  examples}` — a funnel rather than a total, because a block that arrives on a third of the split is
  a blend of two prompts whose mean belongs to neither.
- **`bench:bird:needs-train`, so the 8.5 GB training archive is fetched when an arm reads it.** The
  workflow asks the arm table rather than keeping its own copy of "which arms retrieve": a name that
  resolves to nothing is refused instead of answered `no`, and the answer for a blank `BIRD_ARMS` is
  the chain's own list, which has read the split since `inline+icl` joined it. Only `train.json`
  (4.2 MB) is kept, and a warm cache skips the download entirely.

- **The pairwise arm's third criterion is unreachable, and the oracle that shows it is free.** The arm
  was registered with "conversion returns above 92%", written before anyone computed what a perfect
  two-way comparison could reach. Its parent's artifact already holds both statements the comparison
  chooses between, so the oracle is offline arithmetic: on the 100 disagreements the pool's winner is
  right 38 times, the bought opinion 27, **both 5**, so **either is right 60** and the arm's ceiling is
  `941 − 38 + 60 = 963` — **62.86%, +1.44pp**, which is **91.71%** of the 1,050-case candidate
  ceiling. 92% is 966 cases: **three above the maximum**. Criterion ③ therefore stands as written
  with its expected verdict *unreachable by construction*, and the criterion that can decide is ③′
  at **≥91.0%** (≥956). Criterion ① needs 73% of the 22 available cases, so failing it while passing
  ② (which needs 36%) is the shape a two-way comparison of a weak candidate should produce.

- **Every lever that acts at runtime is now one row in one table, and the table is checkable in four
  directions.** The guards used to be an if-chain inside `runArm`, which let a lever be declared in
  the arms table, priced in the pairs table, explained in the dispatch comment and never guarded —
  the only proof a mechanism runs end to end being a paid artifact, and three levers having been
  published for a round with a zero funnel. `MECHANISMS` carries, per lever, its predicate, its
  guard, the artifact field it writes, the end-to-end scenarios that prove the wiring and a bank of
  cases in which it did not act; `runArm` loops over `mechanismsOf(arm)` rather than listing them.
  `test/bird-mechanisms.test.ts` pins the four directions the register can be wrong in: every
  `assert*Fired`/`Ran`/`Answered` the runner exports must be registered (the naming convention is
  load-bearing, and a guard that dodges the suffix has to be given a documented exemption), every row
  must be declared by an arm that exists, every row's guard must refuse its quiet bank, and every
  row must name a scenario whose body reads the field it writes.

- **The bought opinion is now put to the selector instead of in front of it.**
  `41551887197` gave the conditional-dissent arm a clean negative with a clean mechanism: the ceiling
  rose 1,023 → 1,050 with nothing falling, and the four-candidate prompt converted none of it —
  conversion 92.08% → 89.62%, 21 adoptions of which 5 were right while the bought statement was
  right 27 times, and the oracle over the same four candidates is 68.54%. Only 9.1% of arrivals
  disagreed, and on those the bought opinion was the *weakest* of the four (27 against 38/38/37).
  `select-cross-pooled-dissent-pair` keeps the parent's three-candidate prompt byte for byte and
  spends one comparison call only where the bought statement disagrees — the `select-pair` shape on
  the one pair that matters, at 0.065 comparison calls a case. Its funnel publishes `pairwise:
  { asked, choseDissent }` and `assertDissentFired` refuses an arm that pays for a comparison and
  asks it on no case.
- **A fourth opinion, bought only where the pool agreed with itself.** `bench:bird:diversity` priced
  the candidate set this repository has been reading for six rounds: 74.50% of its cases are
  unanimous and two thirds of its ceiling losses are losses the candidates *agreed* on — a
  population no selector can reach, because there is nothing to choose between. The new arm
  `select-cross-pooled-dissent` is `select-cross-pooled` plus one `decompose` generation on exactly
  those cases: same pool, same selector, same selection call, **0.745 calls a case** instead of one.
  Each case now carries `dissent: { asked, arrived, distinct, adopted }` — the condition holding,
  the call surviving, the statement saying something new, and it becoming the answer — because on
  this arm the score can be identical to the parent's and still have bought nothing. Two refusals
  come with it: an arm whose condition never held is its parent renamed, and an arm whose every
  call came back unrunnable is an outage. `distinct: 0` is published rather than refused: "the
  fourth opinion always agreed" is the finding that the extra call is a fourth vote.
  `assertDissentRule` refuses a dissent source that is already one of the arm's candidates, because
  that purchase is a fourth vote by construction.
- **A pooled arm's pool check no longer skips the cases its lever acted on.**
  `assertPoolShared` compares the candidate statements slot by slot, so an arm holding one bought
  candidate failed the length comparison on exactly the cases the conditional call fired on — and
  the check treated a length mismatch as "not comparable". It would have been silent on the
  population the arm exists for while passing everywhere the arm did nothing, which reads as a
  verified pool. The bought candidate is now excluded by source, so everything the pool supplied is
  still compared; the ceiling comparison does the same, because comparing the arm's four-candidate
  recall against the pool's three-candidate one would report the lever's success as a broken pool.
- **`bench:bird:diversity`: how many opinions the pool actually holds.** `bench:bird:pool` prices the
  union — what one more call buys — and cannot see the thing underneath it: a pool of three
  candidates that return the same rows three times costs three calls and carries one opinion, and
  its union is indistinguishable from three genuinely different attempts. The new instrument reads
  the candidate records the runner already writes and prints three numbers a union cannot: distinct
  results per case, the cases where a source is *solely* right (its marginal value, which is not its
  hit rate), and the ceiling loss the candidates **agreed on** — the part no selector can reach.
  On the 600-case dev artifact behind `41453395203`: ceiling 69.17%, best single source 63.00%,
  **1.28 distinct results per case**, **447 of 600 cases unanimous (74.50%) and right 72.93% of the
  time**, and the second model's candidate carrying **4.00pp of ceiling alone** against 1.00pp and
  1.33pp for the two prompt-varied sources; **121 of the 185 ceiling losses are unanimous** (65.41%),
  so two thirds of what the pool misses is a loss it agreed on. That is the registration for I-77:
  the external anchor is XiYan-SQL's ablation (one generator, −4.04pp) and MCS-SQL's (five prompts
  +1.3pp against twenty samples of one prompt +2.1pp), and this instrument is what makes the same
  purchase measurable here. Wired into `bird-dev.yml` as a zero-cost step, refusals included: an arm
  the run never scored, an arm scored without candidates, and a share below the sample floor are
  three different sentences rather than one table of zeros.

- **`inline+evidence+samples-gold`: the value block priced at the width it would be built at.** The
  block has been carried for three rounds on +1.31pp at p = 0.052 and a 2.22pp ceiling, and both
  readings are about the sampler. Bisected with no model on the 500-question Mini-Dev split: every
  profiled column costs **+38.4%** of the card's characters a case, the columns a gold statement
  filters on cost **+1.4%** and touch **37.0%** of the questions (`codebase_community` 0 of 49, and
  that is a property of the corpus rather than a bug). The new arm keeps the sampler, the values,
  the order and the call count and narrows only the set of columns, which makes it an oracle: no
  realizable rule can beat a rule that reads the answer, so a flat delta closes the family and a
  positive one is the budget a realizable rule has to be judged against. Declared on demand, and its
  catalogue note says which of the two it is.
- **`sampleBlock` and `assertSampleBlockFired`: the count that makes a narrowed arm readable.** A row
  carries `{ cases, withValues, columns, empty }`, because `controls.sampledColumns` is a run-wide
  total and cannot say whether *this* rule reached *these* cases. `empty` counts the cases the rule
  reached nothing on — a statement with no condition has no column to narrow to, so the two numbers
  are D56 in counting form. The guard refuses to publish an arm whose rule kept nothing anywhere:
  that arm is its parent with a longer name.
- **`assertSampleRule`: a column rule with no sampler under it is refused at the declaration.** The
  two halves are one lever — `samples` decides whether values are shown, `sampleColumns` which
  columns carry them — and the second without the first sends the plain card and publishes a delta
  of zero for a rule that never ran. Checked per arm, with the catalogue's own arms asserted too, so
  the mistake costs a test rather than a dispatch.
- **The condition census on the split that decides adoption.** `bird-dev.yml` now runs
  `bench:bird:conditions` on the dispatched artifact — two statements and the gold the run already
  holds, zero queries and zero model calls — so the population the next lever targets is measured on
  1,532 questions instead of inheriting a 498-question reading. No `--strict`: the share is the
  finding, and the failures it can catch are the ones the Mini-Dev gate already fails on.

### Fixed
- **Three instruments refused an artifact that was exactly what the dispatch asked for.** `pool`,
  `diversity` and `consensus` each raised "keeps no candidate set" on a run with no candidate records,
  because every dev dispatch had sampled three candidates since they were written. The round the
  ceiling lever became a single call turned all three into false alarms: the dev run (`41584873572`)
  passed its evaluation and its accuracy floor, then died at the first instrument and skipped the two
  readings behind it. The distinction that was missing is between *no arm draws more than one
  candidate* — a reading, printed in one sentence, exit 0 — and *an arm publishes a ceiling with no
  candidates under it* — an artifact that lost records, still refused. `eval/bird/artifact.ts` holds
  the predicate all three share, plus `scoredQuestions`, because the first version of the sentence
  said "no pool to price (0 questions)" about a run that had just scored 1,532: the denominator had
  been taken from the rows that were missing.


- **The diversity instrument printed the arm's own configuration as its strongest possible
  measurement.** A candidate's fingerprint is what makes "one opinion" a fact, and an artifact that
  carries none cannot say how many opinions a pool held — the harness answered anyway by naming each
  missing fingerprint after its source, which makes every uncomparable case as diverse as the arm has
  sources. Against a 2026-11-01 artifact written before the field existed, `select-mixed` printed
  **3.00 mean, 0% unanimous** on all 1,507 cases: perfect independence, computed entirely from the
  flags, and exactly the number the reading was supposed to discover. Uncomparable cases are now
  dropped from the mean with the population printed beside it (`1.26 mean, 3 max over 600 of 600
  cases that carry a fingerprint`), and an artifact below the floor is refused with one of two
  sentences — nothing fingerprinted at all is an artifact older than the instrument, fewer than a
  hundred is a share of the draw. `correlated` gains `measurable` as its denominator for the same
  reason.

- **A cancellation test measured the machine rather than the contract.** Two cases in the Postgres
  suite aborted a hundred milliseconds after the query returned, on a five-second `pg_sleep`, and
  asserted the rejection: on an idle machine the timer wins, and under a coverage run with a hundred
  and twenty test files in flight it lost — the statement finished on its own and the suite failed
  with `promise resolved instead of rejecting` on code nothing had changed. The contract is about a
  statement that is *running*, so the tests now poll `pg_stat_activity` until the sleeping backend is
  visible and abort there. Faster (281ms against 464ms), and a broken cancellation still fails.

- **A test whose input the repository does not carry passes on one machine and fails in CI.** The
  first version of the diversity instrument's suite pinned the published numbers by reading
  `eval/out/bird-eval-41453395203.json` — a git-ignored artifact that exists only where the run was
  downloaded. It was green locally and red in `41505415484` (`1 failed | 2865 passed`). The fix is
  not an `existsSync` guard: a skipped test that reads as a pass is the shape D56 forbids. The
  artifact-level reading moved to where the artifact exists — the `bench:bird:diversity` step in
  `bird-dev.yml` — and the unit suite keeps the arithmetic and the two control banks. Removing it
  first *raised* branch coverage to 96.36% (smaller denominator), and two new cases for rows that
  belong to the arm but not to its pool brought it to 98.24%.

- **A step that had nothing to say failed the dispatch, and starved six readings behind it.**
  `41492586751` published its three scores and then went red at step 12: `bench:bird:gap` threw on an
  artifact holding no `candidateRecall`, and the six zero-cost instruments queued behind it — census,
  card, repair, width, conditions, losses — were skipped with it, so a dispatched dev run published
  three arms and nothing else. A dispatch whose arms all make one call is a legitimate run of this
  repository: those arms never had a candidate set to lose, so "no no-answer population" is a fact
  about the dispatch and not an instrument losing its input. `runGap` now returns
  `applicable: false`, prints the reason, writes it into the step summary and exits 0 — and the
  reading is safe to absent because `assertReportComplete` refuses to publish an artifact whose
  sampling row dropped its ceiling, so a published artifact with no ceiling row is one whose run
  asked for none. The `--arm` naming mistake is still a failure on that path: the two absences stay
  apart and only the second one fails. Moving the answer earlier left `armOrThrow`'s own "holds no
  arm with a candidate ceiling" variant with no way to be reached, so the branch is gone and the
  table is typed non-empty — the sentence that names the arms which *do* publish a ceiling can now
  never name none. One sentence per fact, at the one place that knows the fact.

- **The profile cache was one directory for every dataset, keyed by database name.** Two fixtures
  that both name their database `shop` read each other's schema, and the end-to-end case for the
  narrowed block rendered a card from the mini fixture's tables on the chain fixture's questions —
  the failure the `.value-examples` comment already describes, in a cache that had not been moved.
  Profiles are now written to `<data>/.profiles`, the layout test names the path, and the adversarial
  runner follows the same rule. Cost: one recomputation per split, then cached with the dataset.

- **`bench:bird:reconcile`: what a policy is worth, case by case.** The arm-level funnel says how
  many replies were statements nobody wrote; it cannot say which cases, and a pair of arms is tested
  on the second. The tool cuts an artifact by the policy's own per-case records and checks the two
  invariants that make the cut readable — a declined statement leaves the vote's verdict standing
  case for case, and on a novel statement the two arms agree because they adopt the same reply — then
  prices the paraphrases (where the two arms differ) against the statements nobody wrote. An
  artifact with no per-case record says so and exits non-zero rather than printing zeroes, because a
  zero reads as "the lever moved nothing" and an absent record is not that.

- **A lever nothing reads fails the suite.** `reconcileAdopt` was written as a field, an arm and a
  pair before anything consumed it: the arm would have run, its row would have looked right, and the
  only difference from its parent would have been the name. TypeScript cannot see it (the field is
  optional and the file compiles), the one-lever-per-pair test cannot (the two arms genuinely
  differ), and the end-to-end suite cannot (both arms are self-consistent — the broken one is simply
  its parent). The catalogue and the runner are now read as text and asked whether every field of an
  `Arm` is referenced outside its own declaration, and whether `LEVERS` and the interface name the
  same set. `name` is the one field that is not a lever: two arms with different names are not one
  lever apart.

- **`select-cross-pooled-reconcile-novel`: the same call, with the paraphrases handed back.** The
  first reconcile arm adopted every statement the engine would run, and `41453395203` priced that
  policy: 359 of 600 against the free count's 380, on a pool where the ceiling is 415. The funnel
  says where the loss is — 595 replies ran and only 86 were a statement nobody wrote, so 514 were a
  candidate rewritten in other words, and the arm overwrote the vote's answer with a paraphrase on
  every one of them. The new arm is one lever from it (`reconcileAdopt: 'novel'`, against
  `'always'`): same pool, same prompt, same single call, and a restatement hands the decision back
  to the vote. A declined restatement is still executed, because `executable` is a property of the
  statement and not of the policy — two funnels read column by column have to agree on the columns
  the policy does not govern, and the query costs no tokens. Registered before the dispatch: the arm
  must beat the adopting arm strictly (nothing else changed, so if handing restatements back does
  not raise the score, the losses were not the paraphrases), and must clear the free rule's 63.33%,
  which every paid arm on this pool has now failed three times.

- **`reconcile.policy` on the row, and `cases[].reconcile` per case.** A funnel whose last column
  depends on a declaration has to carry the declaration: `executable === adopted` is true of the
  adopting policy and false of the other by design, so the row now says which policy produced its
  `adopted` column and the gate asserts the relationship each one implies (equal under `'always'`,
  nested under `'novel'`, four nested counts either way). `emptyRetry.mode` is the precedent. The
  per-case record is published for the reason an arm-level funnel is not enough: the fifth artifact
  could say "16 gains and 37 losses" and not which of them were paraphrases, so the policy's score
  was bounded — `[343, 396]`, 57.2% to 66.0% — rather than predicted.

- **The pool read four ways, and the price of each.** `select-cross` writes three candidates
  (`deepseek-chat` twice, `deepseek-reasoner` once); `select-cross-pooled` reads that pool and asks
  the same question; `-vote` returns the modal group for no call at all; `-agree` shows the selector
  which candidates returned the same rows; `-judge-reasoning` puts the reasoning model in the chair.
  On 600 dev questions (`41410112996`): 62.50%, 63.17%, 63.33%, **64.33%**, 62.33%. The ceiling is
  identical on the first four (418/600), so the deltas are decisions and not pools, and the one that
  pays is information: the marks are worth +1.17pp at the same price. The reasoning judge loses
  0.83pp — at most 0.33pp once the three cases it could not adjudicate are scored charitably — which
  answers "does the strong model win" negatively for the adjudication seat and positively for the
  generation seat, where its candidate is the reason the ceiling is 69.7% and not 65%. The same run
  measures the selector's own jitter: `select-cross` and `select-cross-pooled` read one pool, send
  one prompt and answer differently on four cases, which is a floor of ±0.67pp under every selector
  delta this repository has published.

- **`bench:bird:decision`: what the selector costs, read off an artifact.** A candidate record
  carries `fingerprint`, the hash of the rows its statement returned, so a case splits into the
  opinions it actually contains: one group means every candidate returned the same rows and the
  choice is free, two or more means a decision exists. The tool prints that split, the four outcomes
  of a disputed case, how often a 1:1:1 tie decided it, the exact McNemar test, and the net in cases
  and in points. It reads any archived artifact in a second and calls no model. On two runs of
  `select-cross` (600 dev questions each) the model was right on 22 disputed cases the modal result
  was wrong and wrong on 53 it was right — 63.33% for the count against 60.75% for the selector,
  p = 4.5e-4 — and the count scored exactly 380 of 600 in both runs while the selector moved 5 cases.

- **A correction written in the round that made the mistake.** The first draft of the entry above
  read two artifacts and concluded that "the selector loses the cases it exists for". A third
  archived run (`41366778872`) says otherwise, and it was in the repository the whole time: on that
  run the cross pool was 18:21 (p = 0.75), and on the *homogeneous* pool (`select-mixed`) the
  selector won the disputed cases 12 to 5 — the only arm in the table that does. Three cross runs
  pool to 40:74 (p = 0.0019), but the per-run deltas are +2.17, +3.00 and +0.50pp, so the effect is
  real in direction and smaller and less stable than a two-run reading implies. The claim that
  survives is a claim about pool shape: a decision exists four times more often once the candidates
  come from two authors (23–26% of cases against 8.3%), and that is where the free rule catches up.
  Both the document and the numbers were rewritten, and the correction is recorded rather than
  quietly applied.

- **`select-cross-pooled-vote` and `select-cross-pooled-agree`: the same pool, two decisions.**
  The first returns the modal group in zero calls; the second reads the same candidates with the
  agreement marks. Both are one lever from `select-cross-pooled`, which is the A/A instrument, so the
  chain prices the decision and the information without generation noise. `vote-cross` asked this
  question before and could not answer it: both of its arms drew their own pool, and the pool's
  displacement at 600 questions was measured at 1.3 to 3.3pp, which is the size of the effect.

- **`select-cross-pooled-reconcile`: the same call, asked for a statement instead of an index.**
  Both readings point at the same wall: on the cross pool the correct statement is in the set on
  70.5% of cases and the arms score 64%, so 6.5pp of cases contain a right answer the decision
  misses — and an index cannot name an answer that is not in the set. The arm hands the model the
  *result groups* (the partition the agreement marks already define, computed by `resultGroups`)
  and asks for the statement to run (`buildReconcilePrompt`), in one call at the same temperature
  as the selector it replaces, on the same shared pool. The reply is executed and adopted, so the
  arm's accuracy is a property of a statement the model wrote; a statement the engine refuses
  leaves the vote's answer standing, and a turn that never came back is an outage
  (`selectionFailed`) rather than a disagreement. The funnel (`asked`, `returned`, `novel`,
  `executable`, `adopted`) is published on the arm's row, and `assertReconcileFired` refuses a run
  where the model never wrote a statement of its own: an arm that restates candidate 1 is a
  selector with a longer prompt, and its score would be the selector's. `reconcile` is recorded as
  a source in the winner tally so the per-source counts still sum to the arm's cases.

- **`poolRead`: how much of the pool a pooled arm could verify.** `assertPoolShared` has returned
  `{ shared, unrecorded }` since the adjudication fix, and the counts were thrown away because
  `unrecorded` was documented as an unreachable state — a case with no candidate record could not
  exist. The empty pool above is that state: the source wrote nothing, so the pooled arm had no pool
  to read. A pooled arm's row now carries `{ shared, unrecorded, cases }`, so the delta it publishes
  says whether the pool was read on 598 of 600 cases or on all of them, and `assertReportComplete`
  refuses a pooled row that names its parent and not the denominator. Below the instrument floor the
  field is absent rather than zero, on the same rule as every other share in this file. The empty-pool
  row also stopped claiming `candidateRecall: false`: this arm never held a candidate set, so it has
  no ceiling for that case, and asserting one would have been the same defect in miniature.

- **One name for the sample floor.** `minimumSample = 100` was written out in seven guards, each
  meaning "below this many cases a share describes the sample". It is one number and now has one name,
  `MINIMUM_INSTRUMENT_SAMPLE`, which is also what decides when `poolRead` is published.

### Fixed

- **The condition census read every artifact against mini-dev, whatever split it was measured on.**
  `bench:bird:conditions` compares a prediction against the gold of *its artifact's* split, and the
  split was taken from the environment and defaulted to mini-dev. Run on a 600-case dev artifact it
  reported 84 failures and then admitted that 136 of the 600 cases "name a question the split does
  not hold" — and compared the remaining 464 against whatever mini-dev happened to hold at that id.
  It failed loudly under `--strict`, which is how it was found, but a tool that CI only ever points
  at mini-dev had no way to notice, and the next reader would have had to already know. The split is
  now read from the artifact (`dev` or `minidev`, otherwise the old default), the environment still
  wins when it names one because a reader may want the other file on purpose, and an artifact with
  no declared split keeps the old behaviour instead of guessing. Three tests: the declared split, the
  environment's precedence, and three inputs that must not be trusted (a missing file, no `split`
  field, an unknown one).

- **A table's columns were attributed to the wrong comparator.** `bench:bird:decision` prints, per
  arm, that arm's own selector against its own modal count over the same candidates. The first draft
  of the fifth-dispatch section read the four columns as "against `select-cross`", which is a
  comparison the tool does not make. Every number was right and the attribution was wrong, which is
  why it survived review: nothing in it contradicted anything else. Corrected, and the correction
  added two measurements nobody had taken — the full sample (the vote wins 37 cases the reconcile arm
  loses and loses 16, net 21, p = 0.0055) and the split of those 37 (28 on the 153 disputed cases, 9
  on the 447 where all three candidates already agreed, which cannot be paraphrases at all since a
  restatement there returns the same rows).

- **A funnel column that the code made constant could not be argued with.** `adopted` was defined as
  "the statement ran", which on the only arm that published it was the same number as `executable`
  on every case: the column that was supposed to say "the model's correction was scored" could not
  tell a correction from a candidate restated in other words. `41453395203` read 595 and 595, and the
  3.5pp it lost to a free rule could not be attributed to the 514 paraphrases except by arithmetic
  about a sample the artifact did not carry. The runner now refuses a reconcile arm whose replies
  produced nothing to score — a fourth branch on `assertReconcileFired`, distinguished from "the turn
  never ran", "no reply carried a statement" and "every reply restated a candidate", because a reader
  who is refused needs to know which of the four happened — and the gate reads the funnel's nesting
  under the policy the row declares.

- **A pooled arm was refused for reporting the price it was built to report.** `41440646002` ran
  eight arms to completion and then failed its own gate on four of them: `select-cross-pooled`,
  `-agree`, `-judge-reasoning` and `select-mixed-pooled` each reported one call per case, and the rule
  that prices a sampling arm — more calls than samples, because the selector is one on top of the
  candidates — read that as a selector that went unbilled. The rule is right about the arm it was
  written for and wrong about these: a pooled arm samples nothing, so one call per case *is* its
  bill. The gate now prices the two shapes separately, and the gap the false alarm exposed is closed
  the same way: a mean cannot separate "three cases never reached the selector" from "the selector is
  not counted", because 0.995 and 1.000 are the same number to a reader and opposite facts to an
  auditor. `spend: { asked, priced }` counts the decisions and the ones that carried a call, the
  runner refuses to publish a pooled select arm without it, and the gate reads `priced === asked` in
  place of the mean — plus one rule a mean *can* enforce, that a pooled arm must spend strictly fewer
  calls than the arm whose pool it names.

- **A case the source arm could not fill was filed as a bug in the runner.** `41430569500` scored six
  arms on 600 dev questions and then refused to publish: two cases in `select-mixed` produced no
  candidates at all — every sample for those questions died at the engine — and `reusePool` raised a
  plain `Error` for the empty pool, which `escapeKind` files under `harness` and `assertHarnessClean`
  reads as a defect in this repository. Nothing was broken: the source arm could not answer those
  questions and its row said so. The pool lookup now returns either the candidates or the row in which
  the source recorded its failure (`PoolLookup`), the pooled arm writes the same reason under the same
  `errorKind`, and `reusePool` refuses exactly one thing — a case the source never ran, which is the
  ordering bug the lookup exists for. A gap in the sample is now a scored case with a reason instead
  of a dead run.

- **`AbortSignal` on the PostgreSQL connector did nothing.** `pg` does not cancel a statement it has
  already sent, so aborting during `select pg_sleep(1)` returned the row a second later, exactly as
  if no signal had been given — a forward that looked like a guarantee and was registered as a defect
  rather than papered over. The connector now stops the statement at the server: it learns the
  connection's `pg_backend_pid()` once per physical connection, asks the server to
  `pg_cancel_backend` it on a connection of its own (the pool has none free — the statement being
  cancelled is holding one), destroys that connection instead of returning a half-read protocol to
  the pool, and reports `NL2C_E_TIMEOUT`. Server-side `statement_timeout` produces the same SQLSTATE
  (`57014`) and is reported the same way, because both mean the statement ran out of time and neither
  is something a repair loop should try to fix. The suite that documented the old behaviour now
  measures the new one, and it runs in 0.5s instead of 11s because the sleeps are actually
  interrupted.

- **A case whose adjudication never came back lost the evidence about the pool.** The selector call
  was the one call in the vote branch with no catch: a refusal escaped the per-case worker, which
  returns a row with no candidate record, so a case whose pool *did* hold the answer reported nothing
  about it — and `assertPoolShared` compared that silence against a present ceiling and named the
  wrong bug. Three of six hundred cases did this in `41410112996`, which is why that run refused to
  publish a five-arm reading it had already scored. The adjudication and the empty-result turn are
  now caught where they happen, the case is scored by the vote it already had, and
  `selectionFailed` / `retryFailed` say that the lever did not run; `assertSelectorAnswered` refuses
  an arm whose adjudications were an outage above the same 10% share the candidate-survival guard
  uses, because a selector that never answered would otherwise publish the free aggregator's
  accuracy under its own name.

- **The wrapper that promises "one case cannot take the run down" did not cover the first call.**
  The schema card was built one line above the wrapper's definition, so a refused card escaped the
  per-case worker and ended the run with a provider stack trace — the exact failure the wrapper was
  added for, on 1,532-question runs. It is built inside the wrapper now: the case becomes a recorded
  `llm` failure and the failure-share guard decides what to do with it. The test that found this was
  written to reach the wrapper at all, because catching the selector and the turn removed the only
  path that had been reaching it.

- **The coverage gate measured the environment, not the code.** `packages/node` reported 85.83% on
  lines because `PG_TEST_URL` and `MYSQL_TEST_URL` were unset and every check in two suites was
  skipped — nothing was untested, a server simply was not there. Started PostgreSQL 16 and MariaDB
  10.11 and pointed the variables at them: 99.59% lines, 98.23% branches, 2,751 tests passing and
  none skipped, and the eight-package gate green for the first time on a machine that is not CI.
  Three paths were reachable only with a server and each is a behaviour: `poolSize` was never set,
  a live signal never reached the driver, and a running statement is **not** cancellable through
  `pg` — aborting during `pg_sleep(1)` returns the row a second later, exactly as if no signal had
  been given. The last one is measured and registered rather than asserted away; the first version of
  that test asserted a cancellation that does not happen, and the failure was the finding.

- **`repaired` read a number that means something else on the arm it was printed for.** The column
  came from `attempts > 1`, and on a voting arm `attempts` is the sample count — always the vote. So
  `select-cross-repair-all`, which spent eleven retry calls in one 600-question run, published
  `repaired: 0`; worse, the column was absent entirely on any arm whose grant lived in
  `sourceRepairs`, because the test was `arm.repairs > 0` and on a mixed arm that field never reaches
  the generator. The count now comes from the token ledger's `retry` purpose, where the turn is
  recorded, and an arm that declares `sourceRepairs` gets the column.

- **A pool guard that refused the harness's honest behaviour.** `reusePool` demanded that a pooled
  arm's pool hold as many candidates as the arm declares, on the reasoning that the two arms must be
  compared at the same candidate count. `41389454128` died at case 60 of 600 on it: nine cases held
  one candidate in a three-candidate arm because two statements had failed to execute, and a
  candidate the engine refuses does not exist. The rule now refuses only an absent pool (the source
  never ran the case — an ordering bug) and an empty one (the source ran it and produced nothing);
  a pool of one is a pool. Revert-tested: restoring the size check turns both end-to-end cases red.

- **A declared family took one field of its row and left the rest at the chat defaults.**
  `capabilitiesOf` chose the base row from the model *name* and then overwrote `family` from the
  declaration, so a deployment that declared its endpoint on a name the heuristic cannot read — the
  only kind of endpoint that has to declare anything — got a record that contradicted itself. With
  `{"family":"reasoning","sampling":"ignored"}` on `private-prod-a`: `thinksAloud: false` (the chat
  judge format, the defect fixed two entries below), `jsonMode: true` (a JSON mode a reasoning
  endpoint does not serve, refused with a 400 that reads as a bad key), and `maxOutputTokens: 4096`
  (half DeepSeek's documented 8,192 for the final answer, where a truncated answer scores as a wrong
  one). Declaring *less* was strictly better than declaring *more*. The base now follows the declared
  family and the name is the fallback it was meant to be; a deployment that names its own ceiling
  still wins field by field. Found by writing the test that asks whether the declaration reaches the
  provider `createProviders` builds, which nothing in the suite asked before.

- **An arm whose switch never reached the mechanism was a label, not a lever.** `inline+evidence+empty`
  has been declared, paired and filed on demand since the empty-result turn was written, and the turn
  could not fire: `createPipeline` was never given `emptyRetry`, the execution hook was attached only
  when `repairs > 0`, and the hook returned `void`, so `rowCountOf` had no row count to read. Three
  separate breaks on one path, each invisible because the arm was never dispatched. The hook now
  returns `{ rows }`, the switch is passed to the pipeline, and the single-candidate return path
  records the funnel — an earlier version ran the turn and still reported `fired: 0`. The new
  end-to-end test fails against any one of the three reverts, which is how the three were found.

- **The empty-result turn on a cross arm was spent by the wrong model.** `select-cross-empty`'s turn
  was sent to the primary provider unconditionally, so the reasoning model's empty statement was
  rewritten by the chat model — a lever that silently downgraded the arm it was attached to, and one
  whose tokens were charged to the other counter. The turn now follows `winnerSource`, and the test
  asserts the retry prompt reached the second endpoint and never the first.

- **A parameter the endpoint ignores was reported as one it honoured.** `deepseek-reasoner` accepts
  `temperature` and discards it (its own documentation says so); the harness sent `0`, got a 200,
  and every report printed a sampling regime that never happened. `ModelCapabilities` now declares
  what an endpoint does with a request, `adaptRequest` removes a field the endpoint ignores instead of
  sending it, and the removal is counted per call and per arm (`samplingOmitted`). A chat request is
  byte-identical to the one every published reading was taken with.

- **The metered provider dropped the capability declaration.** `withCallCounter` returned `{id, model,
  complete}`, so a reasoning judge read through the meter looked like an endpoint whose protocol
  nobody knows — and was handed the chat instruction. The wrapper now carries `capabilities` through,
  which is the same defect as the retry above, one layer up.

### Added

- **The engine's refusal can be handed back to the model that wrote the statement, per source.**
  `select-cross` is declared `repairs: 0`, so a candidate the engine refuses is executed once,
  dropped, and no model is ever told why — the ceiling falls by one in silence. That matters most
  for the arm this round is arguing about: the reasoning model's slot reads 61.94% against 63.82%
  and 63.19% for two chat slots, and the arm containing it scores 63.67% against 64.33% for the
  all-chat arm. Against that pipeline the honest reading is not "the strong model is weaker" but
  "the strong model was never given the loop it is better at", because execution feedback is the
  largest single-model gain reported on BIRD (ExCoT-DPO, 57.37% → 68.51%) and the same work's
  negative control is that zero-shot chain-of-thought buys almost nothing. On a mixed arm the
  pipeline is built from the *resolved source's* `Arm`, so the mixed arm's own `repairs` field is
  decoration; `sourceRepairs` is the field that reaches the generator, resolved once where the
  execute hook is attached from the same number. Two arms price it: `select-cross-repair-second`
  (two turns, reasoning model only) and `select-cross-repair-all` (two turns, all three), whose
  difference is what a stronger model does with feedback the weaker ones were also given. The loop
  is nearly free — a repair fires only on a refusal, and candidates reached the engine 598, 596 and
  595 times out of 600.

- **An arm can read another arm's candidate pool instead of drawing its own, because at 600
  questions the pool's noise is the size of the effect.** Every arm in the harness generates its
  own three candidates, so two arms that differ in one lever also differ in their pool, and the
  pool's own displacement — measured by running `select-cross` twice on the same 600 questions —
  is 1.3 to 3.3pp (26:6 discordant, exact McNemar p=5.4e-4). Round 44's two levers read +2.17pp
  (p=0.035) and +2.50pp (p=0.017) against a parent whose pool they did not share, while the slot
  the second one targets moved +0.43pp and the same slot moved +1.60pp on an arm that changed no
  generation at all. `Arm.pool` names another arm and reuses its candidates, its rows and its
  previews: `select-cross-pooled` spends one call per case instead of four and must score exactly
  what `select-cross` scored, which makes it an exact-zero A/A instrument rather than a lever;
  `select-cross-pooled-judge-reasoning` puts the reasoning model in the judge's seat on that same
  pool, so the only thing that differs from `select-cross-pooled` is who judges and in what
  format. `assertPoolShared` refuses a run whose pooled arm disagrees with its pool case for case
  — the failure it guards is silent arithmetic, not a crash — and `secondModelRoles` no longer
  demands a second key from an arm that draws nothing.

- **The judge's format is part of the judge.** A reasoning model told "answer with the number and
  nothing else" either ignores it (its prose was read as an undecided vote) or obeys it and gives up
  the deliberation it was chosen for. `buildSelectionPrompt` has a second instruction — think, then
  put the number alone on the final line — and `parseReasonedChoice` reads the final line only, and
  only on an arm that asked for that instruction. `select-cross-judge-reasoning` puts the reasoning
  model in the judge's seat, which has never been measured: the only judge swap on record used
  `glm-4-flash` and cost 6pp for a reason that is about that model, not about swapping judges.
- **`select-cross-unhinted`** removes `Likely columns` from the reasoning model's prompt and from
  nothing else: the hint is our linker's answer to the question that model was bought to answer, and
  the arm prices the anchor at zero extra calls.
- **`select-cross-empty`** prices the retry-author fix: same candidates, same count, one turn on an
  empty result, sent to the model that wrote the statement.

### Measured

- **The repair loop ran, cost 0.5% of a call per case, and could not have paid for the delta it was
  credited with.** `41392023902`, 600 dev questions: 61.17% (367) / 62.50% (375) / 63.83% (383) for
  `select-cross` / `-repair-second` / `-repair-all`, ceilings 413 / 416 / 423, calls per case 4.000 /
  4.005 / 4.018. The wide arm clears its parent at +2.66pp, 8:24, p=0.0070; the narrow one does not
  (+1.33pp, 10:18, p=0.1849). Neither is attributable: a repair fires only on a refusal, and the
  ledgers record **3** and **11** retry calls in 600 questions, so at most 0, 1 and 2 of the 18, 24
  and 18 wins could have come from the loop. The rest is the pool, which three runs of the same
  control priced at 3.3pp. The rule is now stated where the readings live: a mechanism's
  contribution is bounded by the cases in which only it fired, and a paired comparison with more
  discordant pairs than that bound allows is measuring the randomness the arms did not share. The
  loop is the right idea on the wrong signal — a refusal is rare and the reasoning model has the
  fewest of them (2 in 600); the errors that cost 39% are statements that run and return the wrong
  rows, which no repair turn sees. Registered as `I-76`.


- **The three arms ran, and the harness cannot decide between them yet.** `41380616205`
  (`select-cross,select-cross-judge-reasoning,select-cross-unhinted`, second `deepseek-reasoner`,
  600 of dev's 1,534 questions): 60.33% (362/600) / 62.50% (375/600) / 62.83% (377/600), ceilings
  68.17% / 69.50% / 69.50%, four calls each, the selector deciding on 99.8% of cases. Both arms
  clear their arm-level McNemar against the in-run parent — +2.17pp (10:23, p=0.035) and +2.50pp
  (10:25, p=0.017) — and both fail on attribution: the reasoner slot that `select-cross-unhinted`
  targets moved +0.43pp, below the +1.0pp registered before the run, and the same slot moved
  +1.60pp on an arm that changed no generation at all. At this sample size the pool is the noise
  floor, which is what the shared-pool arms above exist to remove. Not promoted, not rejected:
  re-measured on a shared pool.

- **The agreement mark is a null, and the null closes an explanation.** Four arms over 600 stratified
  dev questions (`41366778872`): `select-cross` 63.67% → `select-cross-agree` 62.67% (−1.00pp, 15:21,
  p=0.405) and `select-mixed` 64.33% → `select-mixed+agree` 64.17% (−0.17pp, 5:6, p=1.000).
  Restricted to the cases where both pools held a correct candidate — which removes the sampling
  difference between two separately generated candidate sets — conversion moves 92.27% → 91.77%
  (7:9, p=0.804, MDE 2.79pp) and 98.21% → 97.95% (2:3, p=1.000, MDE 1.61pp). The minority-correct
  pick rate is unmoved (52.9% → 54.8% on the cross pool), so the selector was told which candidates
  agree and chose the same way: the conversion gap is a recognition deficit, not an information one.
  The block costs 373–387 characters per selector call (+22.9% / +24.2%), at the same four calls.

  Two readings come with it. On a dissenting pool a zero-call rule now beats the call — `shortest`
  64.33% and `modal` 64.17% against the selector's 63.67% — while on a homogeneous pool the selector
  leads both by 1.00 and 1.17pp, so its value is a property of the pool's authorship. And the loss is
  not where the selector is: of the 218 questions `select-cross` answered wrongly, 181 never had a
  correct candidate and 129 of those are unanimous — every source returned the same wrong result,
  21.5% of the corpus that no aggregator can reach.

- **The one fact the selector had to guess: which candidates returned the same rows.** The selector
  is shown each candidate's statement, row count, column count and the first three rows, which
  cannot establish that two result sets are equal — so the fact a 2+1 pool turns on (two of three
  answering identically) was counted exactly by the vote and left implicit for the selector.
  `agreementMarks` partitions the candidate list by `resultKey`, each candidate pointing at the
  earliest candidate it matches, and `select-mixed+agree` / `select-cross-agree` render one line per
  duplicate plus one rule: *agreement is evidence, not proof*. One lever from each parent — same
  candidates, same count, same four calls, 544 B gzip in `packages/ai` — and the block is emitted
  only when marks are supplied, so every earlier arm keeps a byte-identical prompt.

- **A reasoning model in one of three slots: the ceiling moves and the conversion eats it.** Run
  `41356370371` ran `select-mixed,select-cross` over 600 stratified dev questions with
  `deepseek-reasoner` in the `inline+evidence@second` slot. Criteria were written before the reading;
  neither is met:

  | arm | score | ceiling | conversion | `first` | `shortest` | `modal` | selector |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | `select-mixed` | **63.67%** | 65.50% | 97.20% | 62.67% | 63.00% | 62.50% | 63.67% |
  | `select-cross` | 62.50% | **68.33%** | **91.46%** | 60.00% | **63.17%** | 63.00% | 62.50% |

  The ceiling gains **+2.83pp** — 22 questions where only the reasoner is right, 5 where it displaced
  a right answer, net +17 — and the selector converts 16 of the 22, then loses 35 of the 410 it could
  have had. It is not the highest ceiling in this project (`vote-cross` reached 69.6% with one GLM
  statement and two DeepSeek ones), and the pair is the finding: **conversion is a property of the
  pool's shape, not of the aggregator** — 90.2% for `vote-cross`'s modal vote and 91.46% for
  `select-cross`'s model selector, against 94.1% (`vote-mixed`) and 97.20% (`select-mixed`) for
  single-author pools.

  The one combination that needs no new generation is now priced in the same report: the vote and the
  selector, whichever is right, reach **66.33%** on `select-cross` (+3.83pp over the selector, 23
  questions only the vote gets and 20 only the selector gets) and 64.50% on `select-mixed` (+0.83pp).
  The sample resolves 3.17pp, so the first is a measurable room and the second is not — the difference
  is whether the pool holds a dissenting slot. Net **−1.17pp** (25 won / 18 lost, p=0.3604), so the union is 68.33% against a 70% bar and
  the pairing is behind rather than ahead. On the 22 questions the reasoner adds, the correct answer
  is a **lone dissenting slot in 20**: the two chat candidates agree and are both wrong. A vote cannot
  take those; the model selector takes 73% of them, which is why it beats `first` there
  (11 won / 26 lost, p=0.0201) while still scoring *below* zero-call `shortest` (63.17% vs 62.50%).
  The lever is conversion, not generation, and `select-balanced` is the symmetry test that separates
  "the reasoner is better" from "the reasoner is different".

- **`unanimous` now counts what it cannot judge.** A question with fewer than two candidates is
  neither unanimous nor divided, and those questions were absent from the column with no count of
  their own — 5 on `select-mixed`, 1 on `select-cross` in the run above. Printed now, so
  `unanimous + unmeasured + skipped` is every case.

- **The other factor of the score, priced without a call: which selection rule kept the answer.**
  A per-candidate `correct` records that a loss happened and cannot say which rule would have
  avoided it, so every candidate selection rule cost a run. Each artifact candidate now carries its
  statement and a **result fingerprint**, and the fingerprint is the judge's own identity hashed:
  `resultKey` is new in `@agentix-e/nl2charts-devkit` as the canonical key of a result set, and
  `judgeOfficial` was rewritten to compare two keys. Two candidates share a fingerprint **iff** the
  official judge calls their results a match, so agreement is measured with the benchmark's
  definition rather than with a second one. `bench:bird:consensus` replays `first`, `shortest`, modal
  agreement, the arm's own answer and the ceiling over one artifact — no model call, no oracle
  query, no database.

  On the dev artifact the previous round used (`41296610389`, 1,532 questions, and written **before**
  the two fields existed, which is the case the harness has to survive):

  | arm | `first` | `model` (the selector) | `oracle` | paired |
  | --- | --- | --- | --- | --- |
  | `select` (3 draws of one prompt) | **61.29%** | 60.97% | 65.34% | 40 won / 35 lost, p=0.6445 |
  | `select-mixed` (3 prompts) | 61.23% | **62.34%** | 63.71% | 13 won / 30 lost, p=0.0137 |

  So the fourth call's value depends on whether the candidates differ in content: on three draws of
  one prompt, taking candidate one ties the selector and 1.22pp of the arm's 4.37pp "selection loss"
  is recoverable by *deleting* a call; on three different prompts the selector wins thirty questions
  no fixed slot would have. `shortest` and `modal` print a dash with the reason on this artifact
  (no statements, no fingerprints), and `unanimous` reads *unmeasured* rather than zero — the column
  the next run is spent to fill.

  `oracle` plus the `unrecorded` count reproduces `bench:bird:pool`'s ceiling exactly (65.34 + 5 =
  65.66, 63.71 + 2 = 63.84), which is the arithmetic that says the two instruments are still reading
  one corpus rather than two.

  `eval/bird/consensus.ts` at **99.66 / 99.66 / 100 / 98.28**, `test/bird-consensus.test.ts` at 50
  cases. Two defects in the instrument were found and fixed before publication, both in the report
  rather than in the rules: each column had its own denominator (1,507 against 1,532), so the printed
  difference (0.10pp, a tie) disagreed in **sign** with the paired test on the same rows (13:30,
  p=0.0137) — every rule now answers every question, and the questions it had no input for are
  printed beside the column; and a rule that was *ahead* of the selector was printed as
  "−0.33pp behind", which is not a sentence. Regression banks were added for both after the fix.

- **A score is a product, so the candidate pool is priced separately from the selector — and closed
  as a lever.** `bench:bird:pool` reads `cases[].candidates` and `cases[].passed` out of an existing
  artifact and reports, per arm, the ceiling its pool offered and the share of it the selector
  collected; per pool, its recall and how many questions no other pool answers; the union over every
  pool; and a greedy path with the price of each further call. Zero model calls, zero oracle queries.

  On dev (1,532 questions, `41296610389`): `select` keeps three draws of one prompt worth **65.66%**
  and scores 60.97% (**4.69pp** lost), while `select-mixed` keeps three different prompts worth
  **63.84%** and scores 62.34% (**1.50pp** lost). The union of all four pools is **67.49%**, and the
  best single call after the first buys **+1.31pp** (20 questions) — under the split's **2.30pp**
  resolution, so it does not ship. Widening the pool is closed at this model, and the reading that
  closes it also says where to go: the ceiling has to rise, which means a generator that differs in
  method rather than in prompt or in draw.

  Two cross-checks are printed with the numbers: the union over all five arms' answers is 69.06%
  (1,058), leaving exactly the 474 questions the routing instrument reported every arm failing, and
  the union over the three one-call cards is 67.62% (1,036) — the figure that instrument used as its
  oracle. Two independent readings of one ceiling, two questions apart.

  The harness found a defect in the artifact while being written: a case whose candidate set was cut
  to a single survivor recorded **no** `candidates` array, so seven dev questions were passed with no
  correct candidate in their record — exactly the cases where two of three samples died, i.e. the
  smallest pools. `run.ts` now records a set of one, and the harness prints the count for artifacts
  written before the fix.

  `eval/bird/pool.ts` at **100 / 98.63 / 100 / 100**, `test/bird-pool.test.ts` at 39 cases including
  both controls — a bank whose two pools answer disjoint halves, which must read as "widen it", and
  one whose second pool adds nothing, which must read as unresolvable.

  The first CI run of the step failed on the invocation, not on the reading: `bench:bird:pool
  eval/out/bird-eval.json` passed the path positionally, the harness ignored it, and the error said
  `--artifact is required` — a sentence about a flag the caller had plainly meant to supply. Two
  fixes, in that order: the workflows name the flag, and the harness now refuses any argument it does
  not recognise, by name, before it complains about a missing one. A dropped token costs a 40-minute
  run to discover; naming it costs one line.

- **A router is priced and declined, and the reason is what the failures are made of.**
  `bench:bird:route` asks the question the cold-start experiment left open: if a global strategy
  switch cannot move at deployment scale, can a rule read *this* question and pick the better card?
  It joins an existing artifact against the questions file, fits one-feature one-threshold rules in
  both orientations over the arms that cost the same call, and scores them **leave-one-database-out**.

  On dev (1,532 cases) every pair finds a rule that wins in sample — **+0.72pp**, **+0.39pp**,
  **+0.07pp** — and every one of them **loses** out of fold: **−0.98pp**, **−0.98pp**, **−0.46pp**. The
  two evidence cards disagree **66 : 65** (exact sign test **p = 1.0000**), which is what noise looks
  like, and the census explains the rest: all five arms fail on 474 cases and **364 of them (76.8%)
  are `values`** — the right width, a different number. A router can only recover a case some arm
  passed, and on three quarters of what is left no arm passed at all.

  The `values` bucket has a boundary the census cannot see: the judge files a statement that never
  executed there too, because a crash returns no values to compare. The arms record 13 / 26 / 17
  execution errors on the three single-call cards and 10 / 21 cases on the selectors where no sample
  survived guard and execution, so a small share of the 364 is "no number" rather than "wrong
  number". Separating them is a defect in the **census**, and it is what the next instrument fixes:
  a repair that cannot tell a crash from a miscalculation cannot choose between a retry and a
  re-derivation.

  So no router ships, and `select-mixed`'s +1.37pp is recorded as a purchase rather than as evidence
  that routing works. The harness stays because it is what makes the next claim falsifiable: any
  future router can be priced in three seconds against a fresh artifact, for zero model calls.

  `eval/bird/route.ts` at **100 / 97.17 / 100 / 100**, `test/bird-route.test.ts` at 45 cases
  including both controls — a bank a rule *can* solve, which the holdout must recover, and a bank it
  cannot, which the holdout must report as no gain.

- **Adaptation for a model nobody has benchmarked, and the measurement that says not to
  calibrate.** Swapping the backbone keeps the code and loses the calibration, and re-running the
  benchmark is 1,532 questions times four calls — not something a deployment can do.
  `packages/ai/src/adapt.ts` reduces the problem to a choice among four bounded strategies
  (`single-lean` / `single-full` / `repeat-3` / `aimed-3`), decided in three layers that get more
  expensive in that order: `probeProtocol` reads a refusal's status and the first reply's shape,
  `admissible` drops the four-call strategy when a model never writes a parseable choice, and
  `chooseStrategy` / `createObserver` switch only when two Wilson intervals separate, after eight
  observations.

  The layer is worth its 2.9 KB only if someone prices how it can be wrong, so `bench:bird:adapt`
  replays an existing artifact: the four strategies are the four arms of the dev split, calibrated
  on the first N questions and scored on the rest. The pre-registered criterion — regret below one
  point at a window of 24 — **fails at 1.33pp** (1.13pp on a deterministic shuffle, which rules out
  the split's ordering as the explanation). The reason is arithmetic: the arms differ by 1.21pp and
  disagree on 9.4% of cases, so separating them needs 5,040 questions, and no deployment-scale
  window will ever see that. What ships is layers ① and ②, which are free and exact, plus layer ③
  as the only thing that could ever justify leaving the default — and the next lever is not a
  better global strategy but a per-question one: the per-case oracle sits 6.1-6.6pp above the best
  fixed strategy at every window.

- **The two information sources on one card, which they have never been on.** `metadata+evidence`
  is the strongest single-call arm in the corpus (58.9-59.2% on Mini-Dev) and carries 798 curated
  column notes; `values` carries the literals the question names, looked up in the database, and is
  worth +2.82pp over a card with neither source (p=0.039). `metadata+evidence+values` is the pair
  that has never been run: a note says what a column *means*, the block says which literal string
  it *holds*, and the largest remaining bucket in the corpus is statements that run cleanly, return
  rows and answer the wrong question.

  The prediction is pre-registered in the arm's on-demand note rather than inferred after the fact:
  if the two are complements the arm lands above `metadata+evidence` and the corpus has a lever it
  has not pulled; if they are substitutes it lands within noise, and that is a statement about the
  166 remaining failures — they are knowledge the card already carries, not a literal it lacks,
  which makes the next lever something other than "put more text on the prompt".

  `test/bird-arms.test.ts` pins that the arm renders both blocks and that the pair differs by
  exactly one lever (`values`), because an arm whose `descriptions` fell through to `undefined`
  would measure the value block against a card with neither source while wearing the name of the
  comparison.

- **The competitor's card rule, at the granularity their selector actually uses.**
  `eval/bird/dense.ts` applies the reply of the *same* column-choice call the way
  `macsql_agents.py::_get_db_desc_str` applies their selector's: a table the model named nothing
  in keeps its first six columns instead of being deleted, a table it named one column of keeps
  that column plus the table's declared keys and is padded back to six in declared order, and no
  table ever leaves the card. One prompt, one call, one parser, one difference — which is what
  makes `inline+evidence+llm-select-dense` a single lever from `inline+evidence+llm-select` and
  therefore a measurement of the *application rule* rather than of "asking the model".

  The lever this repository had measured was the harsher one. `inline+evidence+llm-select` cuts
  to the named columns and deletes every other table (250/496 against 278/496, −5.65pp, p=0.0020),
  and the sentence "the selector lever is worth −5.65pp" was a statement about our rule that read
  like a statement about theirs. Their card can never be missing a table, so the failure their
  rule cannot make is the one our rule's loss is most plausibly made of.

  The mechanism is counted rather than asserted: `columnSelection.restored` reports the columns
  kept that the model never named — the floor and the keys together — because a rule that never
  fires and a rule that fires uselessly both look like a null result on a scored run. The funnel
  reports the field only for an arm that has a floor, so its absence from the other arm's row is
  a statement and not a zero.

  Two limits are written into the module rather than papered over. Our card carries no primary-key
  marker, so `important_keys` degrades to the declared foreign keys — the half of their rule the
  card can express. And their `keep_all` fallback is unreachable here, because our prompt asks for
  a list of columns rather than a decision per table; an unmentioned table is read as `drop_all`,
  which is the aggressive reading and the one that differs from the column rule.

  Measured on `41290647076`, three arms and one A/A in one run on 496 scored questions:
  parent 278/496, column rule 253/496, their rule 261/496, A/A 275/496 (−0.60pp, p=0.508). So the
  floor recovers **+1.61pp** of the 5.04pp loss — inside a 4.86pp MDE (p=0.416) — and the arm
  still loses **3.43pp** to its grandparent (34:17, p=0.0241, CI [−6.25, −0.61]). The sign of the
  earlier reading survives the correction and the magnitude does not: deleting tables is worth at
  most the CI's upper end of +5.01pp, and separating 1.6pp at this pair's 14.9% discordance needs
  **4,518 cases**, three times the dev split. Their cut is milder in the card (generation prompt
  2,641 → 1,535 characters, kept share 11.1% → 56.9%, 14,052 columns put back) and dearer in
  tokens (+69.2% prompt tokens a question against the column rule's +39.5%), because the choice
  call costs more than the cut saves. The card lever is closed at two granularities, and the
  6.45pp between their pipeline and `metadata+evidence` is not this cut.

- **The format contract: a reply's shape is measured, because it is the one thing a new model
  breaks without an error.** `packages/ai/src/format.ts` reads four dimensions off a reply that
  every reader in this layer already depends on — fenced or bare, nothing but a decorated choice
  or not, step lines written, omissions named — and `formatProfile` aggregates a sample into
  `always`/`sometimes`/`never` per dimension. A verdict needs three replies, and `always` needs
  nine in ten; below either, the honest reading of the evidence is `sometimes`, because a
  selector that answers three times in four looks healthy in aggregate while a quarter of the
  cases are still decided by candidate order.

  The instrument exists for the deployment this repository cannot benchmark. Every reader here
  was calibrated on one backbone; a user who swaps it keeps the code and loses the calibration,
  and the loss is silent — a selector reply of "Option 2" is not an error, it is an unanswered
  call, and the arm scores lower for a reason that reads as a worse statement. `replyShape` costs
  no call and needs no label, so it is the only reading available on the first request a
  deployment makes; `AskResult.shape` carries it, every artifact carries the arm-level `format`,
  and `assertReportComplete` refuses a row that answered cases without one. An arm that failed
  every case carries it too, through the error's `lastShape` — the all-prose run is exactly the
  run with no successful result to read a shape from, and exactly the run the profile is for.

  It is not a scoring change and cannot be mistaken for one: the selector already answered in
  495 of 496 cases on the measured arms, so the widest this instrument can move an existing
  number is one case. Budget `ai` 43,000 → 45,000 (measured 42,735 → 43,997 B gzip).

- **`inline+evidence+audit`: one turn that asks the model what its own statement left out.**
  `packages/ai/src/audit.ts` builds a turn — the statement as the assistant reply, then the
  question and the instruction to list every condition the statement failed to express as
  `MISSING:` lines, then one fenced statement — and the pipeline keeps what comes back when it is
  a safe statement. It fires on the statement the guard accepted, before execution, because the
  failure class it targets is the one that runs and returns rows (16.1-18.8pp of Mini-Dev where a
  gold filter's column is absent, `bench:bird:conditions`). The reply is read for two numbers:
  `named`, the conditions the model says are missing, and `rewritten`, whether the statement
  changed. Neither is inferred from a delta, and `assertAuditFired` refuses to publish an arm whose
  turn never fired over a real sample.

  The result is a negative one and the round's most useful reading, in `docs/benchmarks.md`: 280 of
  496 against the parent's 275, +1.01pp with 4 gained and 9 lost, **p = 0.27, below the split's
  2.04pp MDE**, for **+139% characters a case**. The funnel says why: 488 turns, **24 conditions
  named, 19 statements rewritten** — the model reports nothing missing on 96% of turns — and the
  census that defined the population moves from 151 missing conditions to 150. The turn reaches the
  right cases and does not see what is missing in them.

- **`pnpm bench:bird:width`: the answer's width, and whether the extra columns are the mistake.**
  `eval/bird/width.ts` reads the arm's `column-count` cases, takes both widths from the executed
  result sets (`select *` is one item and three columns), and then prices the one edit the bucket
  permits: delete items from the select list, **every subset**, re-execute, and ask the same judge.
  On `41206085907` the bucket is **37 wide and 15 narrow**, and removing columns recovers **11 of
  the 37 — a 2.22pp ceiling of 496 questions, and an oracle's**: the subsets are chosen with
  knowledge of the answer's width, so no implementable rule beats it. The other 26 stay wrong with
  the right width, which is the finding: the width was a symptom. Narrow cases have no deletion to
  try, so they are named instead — the gold items the statement never spells.

  Two statements the tool rebuilds are re-spaced at both edges, because `head` stops after
  `distinct` and `tail` starts at `from`: the first version produced `… AS ageFROM Player …` and
  `select distinct(…)`, every subset failed to run, every failure counted as "that did not help",
  and the ceiling read **1** where the truth was **11**. A silent zero is the failure mode this
  file exists to avoid, so it is recorded here rather than fixed quietly.

- **`pnpm bench:bird:conditions`: which condition of the question the statement never wrote.**
  `eval/bird/conditions.ts` takes the ladder's `predicate` row one level down and asks a question a
  mechanism would have to answer — the gold compares a column to a value; does the prediction
  compare that column to anything at all? On `41206085907`: **80 of 220 failures (36.4%) never
  filter on a column the gold filters**, 107 conditions in total, which is **16.1pp of the 496
  questions** — seven times the projection ceiling, and a population no spelling lever can reach.
  It joins a `values-gap` artifact with `--ladder`, so the reading is per bucket: `tables` 23 of 36
  (partly mechanical — a statement reading other tables cannot filter a column of one it never
  read), `predicate` 17 of 49, `filter-wide` 13 of 41, `projection` 0 of 11, `aggregate` 0 of 8,
  `literal-case` 0 of 5.

- **`--scope all` on `pnpm bench:bird:gap:values`: the same ladder over every no-answer case.**
  The scope is a flag rather than a rewrite of the tool, because the `values` denominator is what
  every published table counts; the artifact's name carries the scope so two readings of one arm
  cannot overwrite each other. What it produces is the first complete attribution of the corpus:
  of 220 failures, 211 readable and 210 named, and **`grain`, `scale` and `window` are all zero**.

### Changed

- **The curated notes and the value block are substitutes, and the pair says so.** `41302183201` ran
  `metadata+evidence` against `metadata+evidence+values` with an A/A on the 496 scored questions:
  291, 297, and 291 for the duplicate. Paired, the block is **+1.21pp (6:12, p=0.2379, MDE
  2.40pp)** — inside its own resolution, which is the second of the two pre-registered outcomes.

  So the **+2.82pp** that `values` is worth against a card with *neither* source was filling the gap
  the curated notes fill as well, and the sentence the arm was dispatched to test survives in its
  negative form: the 166 remaining failures are knowledge the card already carries and the model is
  not using. More text on the prompt is not the next lever; how the card is read is.

  Two details make the null informative rather than empty: the block costs **+7 prompt tokens and
  +31 characters a question**, because it only spells the literals the question names, so this is
  not a case of a lever that was too expensive to fire; and the A/A is exact — the same arm twice
  scored the same 291 cases, a zero noise floor on the count and a 1.79pp MDE on the difference.


- **The dev coordinate table, in one run.** The five arms the dev workflow runs had never been
  measured together: `41085194983` ran three of them, so two comparisons borrowed their anchor from
  a different run, which is how a paired test stops being paired. `41296610389` runs all five on
  1,532 questions: `names` 41.91%, `inline+evidence` 61.10%, `metadata+evidence` 61.16%, `select`
  60.97%, **`select-mixed` 62.34%**.

  Three of its four readings change what the next round should do. The card and the hint are worth
  **+19.19pp** (45:339). The curated notes and the generated definition block are the same thing on
  this split (+0.07pp, p=1.0) — the −0.8pp Mini-Dev reported was noise, so the product claim now has
  a power test behind it. And **four samples of one prompt buy nothing** while four *aimed*
  candidates do: `select` is −0.13pp against a single call (p=0.911), `select-mixed` is +1.37pp over
  `select` (p=0.0295), and the selector's loss falls 72 → 23. What the fourth call buys is
  different candidates, not more of them.


- **A documentation commit no longer buys a model call.** `ci.yml` measured on every push to
  master: thirteen BIRD arms over 496 questions (~6,400 completions) and three passes over 210
  live cases. Round 36 pushed twice — the second time for a `benchmarks.md` section, a
  `CHANGELOG` entry and a comment — and both pushes re-priced the whole chain, ~12,800
  completions to learn nothing, because a change to Markdown cannot change what a prompt says or
  what a model answers.

  The workflow now starts with a `changes` job that asks `tools/ci-scope.mjs` whether any changed
  file is something a prompt reads, and gates the two model-measuring jobs on the answer. The
  rule is a property of the file name — a path whose last segment ends in `.md` or `.markdown` is
  documentation — rather than a list of directories that drifts the first time someone adds a
  document under `packages/`. A dispatched run always measures: pressing the button is an
  instruction about a number someone wanted.

  Two edges resolve towards measuring, because the two failure modes are not symmetric (a wasted
  run is a bill, a skipped run is a number that was never produced and will still be quoted): a
  change set the commit API could not describe is measured, and so is a list of 300 or more files,
  which is the endpoint's page size and therefore the length at which it may have been cut. The
  filter is unit-tested in `test/ci-scope.test.ts` — 14 cases covering both edges, the suffix
  casing, a directory named `docs.md`, the `$GITHUB_OUTPUT` line, and the workflow actually
  consulting it — instead of being five lines of shell nobody can test.

### Fixed

- **`bird-dev.yml` priced an arm nobody ran.** The workflow gained an `arms` input; five analysis
  steps below it kept the literal `--arm select`. Run `41356370371` dispatched
  `select-mixed,select-cross`, finished its evaluation, passed its floor, and then failed four steps
  later with `eval/out/bird-eval.json has no arm select; it holds select-cross, select-mixed` — and
  the other four steps would have said the same, because they were all reading a name that belonged
  to a different dispatch. The steps now substitute `tools/bird-arm.mjs`, which answers with the
  first arm the run's own `BIRD_ARMS` asked for that the artifact holds, else the largest population
  (ties alphabetical), prints nothing but that name on stdout, and fails rather than printing an
  empty one. Tested for both edges and for the stdout contract, and the workflow is pinned to have
  no literal arm left on any `run:` line.

- **A margin finer than the evidence was published as a finding.** The criterion line printed the
  caller's margin and nothing else, so `bench:bird:consensus` judged a 600-question dev artifact
  against 2.30pp — the resolution of the full 1,532-question split — and called a 10pp gap resting on
  two discordant pairs "earning its price". The margin is now what the caller states and the
  resolution is what the artifact computes from the discordant pairs of the pairing the verdict is
  about, both printed, with four verdicts instead of two: a gap inside both numbers leaves the call
  measurably worthless, one that clears both has earned its price, and the two mixed cases say this
  run measured neither. The 20-question bank that asserted "earning its price" now asserts that it
  does not — the assertion was the defect.

- **A candidate set of one was recorded as no candidate set.** `run.ts` spread `candidates` only
  when the verdict list held two or more members, so a case where two of three samples died kept no
  per-candidate record at all — and those are exactly the questions where the pool was smallest. On
  the dev artifact this made seven passed questions look like passes with no correct candidate, which
  every reading built on `cases[].candidates` would have absorbed silently. The record is now written
  for one candidate as well, and `bench:bird:pool` prints the count for artifacts written before the
  fix rather than allowing the hole to be mistaken for an empty pool.

- **The scope job's first run failed on its own output format.** The tool printed the reason and
  the `models=` key on one stream, the workflow piped both into `$GITHUB_OUTPUT`, and the run went
  red before it could measure anything: `##[error]Invalid format '3 of 5 changed file(s) are not
  Markdown'`. GitHub's output file is a `key=value` list and its parser rejects the step on
  anything else — a sentence in that file is not a formatting preference.

  The split is now part of the tool's contract instead of a shell pipeline: `publish(result,
  {output, summary})` appends the one key to the output file and the Markdown reading to the step
  summary, and the step passes both paths as flags. The test writes to real files and asserts every
  line of the output file matches `key=value`, because a rule that lives in a pipe is a rule no
  test can hold. `describe` was also renamed `explain`: it collided with the test framework's own
  `describe`, which is how the suite failed to collect at all.

### Fixed

- **The temperature was zero and could not be anything else, so a reasoning model could not be
  used at all.** `pipeline` sent `temperature: 0` from three places — the interpretation turn,
  the plan turn, and the statement turn through `?? 0` — and the provider defaulted it again.
  A model that only accepts its own default answers that with a 400, which means the library was
  unusable on that endpoint rather than merely less accurate. `PipelineOptions.temperature` and
  `LlmRequest.temperature` now take `number | null`, and `turnTemperature` resolves the three
  states once: absent sends zero (the value every published reading was taken at, so nothing in
  `docs/benchmarks.md` moves), a number is sent as given, and `null` omits the field entirely.
  `null` reaches every turn — the repair, audit and empty-result turns and the selector, which
  all go to the same endpoint, and a policy that stopped at the first would fail on the turn a
  weak model depends on most. `chooseCandidate` and `chooseCandidatePairwise` take it as an
  optional fourth argument.

- **Every 4xx was reported as an outage, which is the one diagnosis that points at the wrong
  thing.** `NL2C_E_LLM_UNAVAILABLE` covered network failures, timeouts, 429, 5xx and also 400 —
  so a wrong model name, a rejected key, or a field the endpoint will not accept all arrived as
  "llm returned 400" next to "the endpoint is unreachable", and every question that follows from
  that reading sends the reader at the network when the answer is in the request. The two are now
  separate: `NL2C_E_LLM_REJECTED` for a 4xx that the same request will meet again, and
  `NL2C_E_LLM_UNAVAILABLE` for the ones worth retrying (network, 408, 429, 5xx). A rejection
  carries the endpoint's own sentence in `details.detail` — unwrapped from `{error:{message}}`,
  `{error:"…"}` or `{message:"…"}`, collapsed to one line, capped at 200 characters, and omitted
  rather than replaced with an empty string when the body has no readable reason. The harness
  files `REJECTED` with the endpoint failures, not with the unparsed ones: nothing about the
  model's output was measured, because the call never ran.

- **A body that parsed to `null` threw a `TypeError` instead of a contract error.**
  `JSON.parse` is typed `any`, so `null` — which is valid JSON — became the body and the first
  property read on it threw outside the error surface a consumer branches on. A body that parses
  to anything other than an object is now `NL2C_E_LLM_INVALID_RESPONSE`, which is what the
  caller was promised.

- **Three readers required the literal characters of a label they asked for.** `parseSelection`
  matched a closed label list and a bare number; the step line required `STEP` at the start of a
  line after list punctuation; the omission line required `MISSING:` exactly. A model that wrote
  `Option 2`, `1. STEP 1: …`, or `- **MISSING:** …` had followed the instruction and was read as
  having ignored it — the first as `decided: false`, the last two as zero steps and zero
  omissions, which are the numbers an arm gets when its mechanism never ran. The three now accept
  the decoration and still reject prose: the whole reply has to reduce to the label, so
  `The answer is 2 because…` and `SELECT … LIMIT 2` remain unreadable by design. `parseChoiceToken`
  is exported so a format profile can ask whether a reply is a bare choice without inventing a
  candidate count to ask it with.

- **A dev artifact that named itself after the per-commit subset.** `baseReport` wrote the literal
  `'bird-mini-dev'` whatever the split, so every artifact from the 1,532-question sweep announced
  Mini-Dev at the top level while its own `split` said `dev` — and `tools/live-summary.mjs` prints
  that field, so the summary a reader saw named the wrong corpus. `stability.ts` had derived the
  name correctly the whole time, which is what a duplicated expression buys: one copy right, one
  copy wrong, and nothing comparing them. `data.ts` now owns `datasetName(split)`, both writers use
  it, and `check-bird-baseline` fails a report whose `dataset` disagrees with its `split` — the same
  check it already ran on the two `split` fields, one field over. Three unit cases and two gate
  self-tests pin the mapping in both directions.

- **The dev section reported a sign backwards.** *The dev split, asked once* said Mini-Dev puts
  `metadata+evidence` 2.54pp above `select` and "dev puts it 0.39pp above". Re-reading the artifact
  against its own table: `metadata+evidence` is 942/1,532 (61.49%) and `select` is 948/1,532
  (61.88%), so dev puts it 0.39pp **below**. The two splits do not agree on which arm leads. The
  weaker reading — "the gap shrank" — is the one the paragraph carried, and it hides the strongest
  fact on the page: an arm ordering that flips between splits is a sample, not a result.


- **Two gates that measured a build they could not trust.** The audit turn passed the API snapshot
  locally and failed it in CI (`41255435708`, three `A4: ai exports … without a snapshot update`),
  and the same stale `dist` then passed the bundle budget by 735 B and failed that in the next run
  (`41257338754`). Both gates read `dist` and both printed a pass over files that could not contain
  the change — the failure mode is a measurement, not a build. `tools/stale-build.mjs` now compares
  each package's built `index.d.ts` against the newest source in that package, nested modules
  included, and both callers stop with `A0` before reading anything. Four cases on a temporary tree
  pin it: built after its sources, built before a nested source, never built, and no sources.

- **A tool the typecheck could not see.** `test/surface.test.ts` imported `staleBuild` from plain
  JavaScript, which the project typecheck refuses (TS7016, run `41256505036`). The declaration sits
  beside the tool the way `eval/bird/fetch.d.mts` sits beside its fetch helpers, and both modules
  now run `main()` only when they are the entry point, so a test can import them without executing
  the gate.

- **A counter that could not move: `otherBucket`.** `values-gap` declared it, printed it
  ("0 in the column-count bucket") and never incremented it, so the exclusion the tool documents at
  length was reported as zero on every artifact it ever ran. It now counts the no-answer cases
  outside the split's scope, and the state it was hiding — every retained case out of scope — gets
  its own sentence instead of the one about having no statements.

- **The shipped arm's failures were invisible to the ladder.** `values-gap` selected its population
  as `candidateRecall === false`, a field only a multi-candidate arm writes. On a single-call arm it
  is absent rather than false, so filtering on it selected nothing and every reading of the prompt
  the product ships was "0 cases", in the typography of a measurement. The population is now
  `candidateRecall === false` when the arm records one and `passed === false` when it does not, and
  which definition a reading used is written into the artifact beside it.

- **A raw statement read as a statement with no conditions.** `predicateAtoms` splits on lowercase
  `where`/`on`/`and`, because its only caller normalized the statement first. Handed BIRD's gold —
  which writes `WHERE` — it returns an empty list, and an empty list of gold conditions makes every
  statement look complete: the condition census read **13** where the truth is **80**. The new
  reader normalizes before splitting, and a test pins the upper-case gold.


- **`pnpm bench:bird:agents`: their three agents' firing conditions, counted from their source with
  no model call.** `eval/bird/agents.ts` transcribes `_is_need_prune` (fires unless
  `columns // tables ≤ 6 and columns ≤ 30`), `_is_need_refine` (fires on an error, on zero rows, or
  on a NULL in the first five rows) and the two diagnostics their refiner writes itself, then
  applies them to the artifact's failing statements and to the gold statements of the same cases.
  Two readings come out of it that a pipeline cannot be priced without: **how many questions even
  reach an agent** (their selector fires on 9 of the 11 Mini-Dev databases, so 426 of 496 questions
  pay for it) and **whether a fire is a repair** (it is not: `_is_need_refine`'s third condition
  fires on results that were right).

  Faithfulness is the point of the transcription, so three details are reproduced rather than
  tidied: the selector's threshold compares `columns // tables` with floor division, so 13 columns
  over 2 tables is 6 and not 6.5; the NULL scan covers `result[:5]` only, because `_execute_sql`
  returns five rows; and the two fabricated diagnostics are carried verbatim, because the finding
  is about those strings. Each is a test.

- **`inline+evidence+empty`**: the turn after a statement returns nothing, on the arm that ships,
  one lever from `inline+evidence`. Written, paired and **not dispatched** — see Measured for the
  arithmetic that cancelled the run.

- **The competitor's value-example block, ported from their code and priced without a model call.**
  MAC-SQL's selector reads a card on which every non-key column carries `Value examples: [...]`;
  ours carries stored values for categorical columns only. `eval/bird/value-examples.ts` ports their
  rule from `core/agents.py` at `31a9df5e` — six most-frequent values per non-key column, a numeric
  column above ten distinct values skipped whole, a text column dropped for one URL, one email or
  one value longer than fifty characters, dates collapsed to one, a NULL emitted first, keys skipped
  by identity at both ends of every foreign key and by name for anything ending in `id`, `email` or
  `url`. The quirks are kept: the type tests are exact-case, so `varchar(50)` gets neither cut-off
  nor filters, and a column named `paid` is skipped because the name ends in `id`.

  **Verified against their own code, not against a reading of it.** `eval/bird/macsql-examples.py`
  extracts their two methods by `ast`, binds the helpers their bodies import, and runs them over
  the same SQLite files: **332 columns, 0 disagreements** across the eleven Mini-Dev databases. Two
  corrections came out of that comparison and neither was visible by inspection — their dictionary
  marks *both* ends of a foreign key as a key column, and their tie order is SQLite's, so a
  tiebreak showed different values for most columns of a database where every value is distinct.

- **`pnpm bench:bird:differential`: the block is priced from the database and the artifact, no model
  call.** For every gold filter value it asks whether the block would have shown it, whether the
  column stores it outside their six, or whether it is in no column at all — three work items that
  were one question before. On the 496-question artifact from `41190457163`: 349 cases already spell
  every value, 12 differ only in case, 8 in notation, 4 not at all, 123 compare against no value;
  **15 literal sites are spelled by the block, 14 are stored but outside their six, 1 is in no
  column**. That is **13 reachable cases, 11 of them failures — a 2.22pp ceiling** against a 6.45pp
  gap, for **+1,154 characters a case on a 1,480-character card (43.8%)**. The ceiling is below this
  split's 4.99pp MDE, so the reading is "at most 2.22pp", not "2.22pp".

- **`inline+evidence+samples-wide`, the same lever with their sampler instead of ours.** `samples`
  is now a rule (`'profile' | 'example'`) rather than a flag, because which columns are shown and
  what a shown column says is the mechanism being priced; `inline+evidence+samples` keeps our
  profiler's eight categorical spellings and the new arm carries their six, with a small numeric
  dictionary and the nullability marker our profiler never shows. Both are compared pairwise against
  `inline+evidence` in one run, and the second pair prices the rule rather than the information.

### Fixed

- **A rendered line that printed one corpus's count for every corpus.** `agentsLines` wrote "the
  220 statements the artifact kept" — the number from the run it was written against. The fixture
  that exercises the renderer has four statements and printed 220, which is what a hard-coded
  count in a report looks like the first time it is run on anything else.

- **One root cause reported as two faults in the new gate.** An artifact without cases for the arm
  produced both "no agent was counted" and "no gold statement could be read": the second is a
  consequence of the first, and a reader would go looking for a database problem. The gold problem
  is now gated on the arm having been found, the same rule `differential.ts` and `information.ts`
  already follow.

- **The value-example cache was keyed to a database's name, which is not the database.** An entry
  was served as long as the rule string matched, so a set read from one file was returned to a
  reader pointing at another with the same id, and a dataset re-fetched in place kept the values of
  the dataset it replaced. Every entry now carries the size and modification time of the file it
  describes, and a mismatch — or a missing fingerprint, which every entry written before this
  change has — is a miss. The cache also lives inside the dataset (`<data>/.value-examples/`)
  rather than in one directory shared by every dataset, because a fixture and the corpus can name
  a database alike.

  **CI found this and the local suite could not**, which is the whole argument for the guard:
  `test/bird-differential.test.ts` expected three example columns and CI read four, because the
  fixture's `shop` set was still on disk from a run before the fixture grew a fourth column. A
  suite that passes on a machine with a stale cache and fails on a clean one is worse than a suite
  that is red, and the fix is in the cache, not in the expectation.

- **A database that could not be listed was cached as a database without dictionaries.** The
  `sqlite_master` listing ran without a check, so a failure fell through into an empty set, which
  was then written to the cache: a block smaller than the competitor's, remembered as the answer.
  It throws now, with the engine's own text.

- **The two samplers were compared to each other and to nothing else.** `inline+evidence+samples`
  had no pair against `inline+evidence` in `COMPARISONS`, so the artifact could report that the two
  rules tie but not whether either of them beats a card with no stored values — and a tie between
  two arms that each beat the base is a different finding from a tie at the base's level. The pair
  is declared, and a test refuses a sampler without one.

- **A samples arm that sampled nothing could publish as its parent.** `controls.sampledColumns` was
  written and the comment beside it said the gate read it; the floor gate matched the arm's *name*
  for `samples` and read a total over every database the run touched, so a run holding one samples
  arm and one plain arm had a positive total whichever sampler fired. `assertSamplesRan` now takes
  the arm's own count and refuses the arm before a number is printed.

- **The card can be cut by the model, which is the one card mechanism this repository did not
  have.** Every card-cutting instrument here decides *tables* through the same lexical linker: the
  card measurement (74.1% of the prompt is the card, 58.4% of the card belongs to tables the gold
  statement never reads), the join measurement (one hop keeps every gold table for 95.2% of cases),
  and `select-prune`, which ships that rule and loses 1.4pp. The competitor reading left exactly
  one mechanism untested — MAC-SQL's selector puts the columns in front of the model and lets it
  choose — and that is the mechanism a 6.45pp gap has to be attributed to before anything is
  changed. `eval/bird/columns.ts` is it: `buildColumnPrompt` renders every `table.column` with its
  type and comment, `parseColumnChoice` reads a reply as a set of columns (qualified names first,
  then bare names that are unique, an ambiguous bare name resolving to every table that has it, a
  qualified name never read a second time as a bare one), and `applyColumnChoice` keeps the chosen
  columns plus the keys of every join whose two ends survived, and sends the whole card when
  nothing resolved.

  The arm is `inline+evidence+llm-select`, one lever from `inline+evidence`. The choice is one
  call, metered under its own `columns` purpose so the arm's bill can be split per kind of call,
  and `assertColumnChoiceRan` refuses a run whose choice never removed a column — an empty lever is
  a bug, not a null result. The artifact records `columnSelection` per case and per arm (`decided`,
  `unknown`, and `cardShare` as the mean of the per-case shares rather than a ratio of sums,
  because databases differ tenfold in width). A dry run labels the preview
  `before-column-selection`: it spends no calls and therefore cannot show the card a model would
  choose, and a preview presented as the sent prompt is the drift this harness exists to prevent.

  **Measured, and rejected.** On `41190457163` (496 questions, `deepseek-chat`, one arm per run)
  the mechanism fires on 495 of 496 cases and keeps a mean 10.8% of the columns — and scores
  250/496 against the parent's 278/496: **−5.65pp, 53 only-parent / 25 only-lever, McNemar
  p = 0.0020, MDE 4.99pp, 95% CI [−9.14, −2.16]pp**. It is also more expensive, not less: the
  choice costs 778 prompt tokens a case to remove 505 from the generation prompt, +39% net. A
  model-chosen card therefore does not explain a competitor gap on this pipeline; it is the
  ablation reference for relevance-by-model, and `select-prune` (−1.4pp, the graph closure) stays
  the cheaper and better card lever.

- **A comparison harness that holds the five coordinates in code, and two competitors pinned under
  it.** The leaderboard section says a number is comparable only if it shares the question set, the
  model, the prompt, the executor and the judge — and then says none of the runs that would share
  them exist. `eval/competitors/` is that run's machinery: `pins.json` (CHESS at `3d6e835f`, MAC-SQL
  at `31a9df5e`, each with its licence and entrypoint), one adapter patch each that points their
  engine at an OpenAI-compatible endpoint and, for MAC-SQL, renumbers a row at their own I/O
  boundary, `probe.ts` (the checkout against the pin, the patch against the checkout), `subset.ts`
  (the question file cut by the same `stratifiedSample` that cuts `BIRD_LIMIT`, and read back by
  `readIdMap` as the numbering a row-numbered pipeline answered in), `predictions.ts` (the three
  shapes competitors write — CHESS's id-keyed map, MAC-SQL's JSON Lines, BIRD's text-keyed pairs —
  and what each one left out), and `score.ts` (their statements through this repository's
  `oracle.py`, judged by `judgeOfficial`).

  Four refusals define it. No accuracy is printed before the coordinates hold: a failing coordinate
  exits non-zero with both values and the cost of the mismatch, and the artifact records the
  violation instead of a rate. No accuracy is divided by the answered subset: an unanswered question
  is counted wrong, and the answered share is printed beside it. No delta is called a size when it is
  inside the MDE of its own design — the line says so and prints how many questions the effect would
  need, computed by `casesForEffect` from the discordance the run actually observed. And no file that
  nothing could be attributed from is read as a run that answered nothing — see the fix below, which
  is what the first `full` dispatch cost.

  `.github/workflows/competitors.yml` dispatches it in two stages: `probe` costs a clone and no model
  call, `full` installs the competitor's dependencies and runs the pipeline, one arm of ours on the
  same subset, and the scorer. Both probes have run on a runner — `41149938353` for MAC-SQL (head is
  the pin, six of six named files then, seven of seven once the fourth hunk named `core/agents.py`,
  nine pinned requirement lines, adapter applies, four files changed) and `41150217544`
  for CHESS (eight of eight, twenty-eight) — and neither produced a number, which is the point of the
  stage. The `full` stage then took three dispatches to produce a reading at all: the first two are
  under **Fixed** (an empty file read as a zero, then an absolute database root read as a relative
  one), and the third is under **Measured** — 25 questions, MAC-SQL 76.00%, this harness 64.00%,
  inside an MDE of 29.65pp.

### Fixed

- **One artifact, two pairings: the tool that explains a delta and the tool that produces it
  counted different pairs.** `compareArms` consumed each arm's answers by occurrence, because a map
  keyed by id let Mini-Dev's repeated 137 read the last answer recorded for it; `pairCases` in
  `eval/bird/strata.ts` built that map anyway and reported the repetition as a defect in the
  artifact ("took the last one of each"). On a file with a repeated id the two disagreed by one
  pair, so the cross-check that makes a strata reading believable compared two populations. The
  alignment now lives once, in `pairByOccurrence`, and both readers fold over it; `pairCases`
  separates the two things it used to merge — a question one arm never answered (`unpaired`) and a
  question both answered a different number of times (`mismatched`). The regression is held by a
  test that pairs a six-row artifact (two arms, one question twice) and asserts the stratification
  and the runner produce the same four cells; it fails on the old implementation with 2 pairs where
  the runner counted 3.

- **`gap.ts` was the only one of the six instruments that could not be aimed.** `values-gap`,
  `card`, `join`, `info` and `repair` all take `--arm <name>`; this one printed a row per arm and
  left the reader to find the one that failed a gate. It now takes `--arm`, writes its table to
  `eval/out/bird-gap-<arm>.json` rather than over the whole chain's, and refuses two absences
  differently: an arm the artifact never scored (naming the arms it does hold, via `requireArm`) and
  an arm that publishes no candidate ceiling (naming the arms that do) — because an empty table
  would read as "no gaps found".

- **The dev arm list had two owners and neither was the code.** `bird-dev.yml`'s default was
  `names,inline-definitions,inline+evidence,metadata+evidence,select` while
  `eval/baseline/bird.json`'s `armsBySplit.dev` named six arms including the adopted ceiling
  `select-mixed`. Which arms a dev run measures therefore had two answers that nothing compared.
  `DEV_ARMS` in `eval/bird/run.ts` is now the authority: the workflow quotes it byte for byte
  (asserted by a test that reads the YAML), the baseline must equal it plus the arms whose sources
  name `@second`, and every arm in it must be in the catalogue and carry a dev floor. The default
  itself moves from the superseded definition-source arm to `select-mixed`, the arm the dev split
  was run six times to adopt.

- **The default sample size was still the row count, so every push declared a request the split
  could not satisfy.** `selection.available` became a count of question ids in the round above,
  while `parseLimit` kept answering `500` for Mini-Dev — a row count standing where a question
  count belongs. The artifact then carried `requested: 500` against `available: 498`, and the floor
  gate, whose job is to notice a shrunken sample, failed `ci` run `41169457147` at *Accuracy floor (a
  regression fails the build)* on a run whose arms had all scored normally. The gate was right.

  The constant is gone rather than corrected: `parseLimit` returns `undefined` when no size is
  declared — "whatever the file holds" — and throws on anything that is not a whole number of
  questions, instead of substituting the split's size for `0`, `-5`, `abc` or `12.9`. The new
  `resolveLimit(limit, available)` meets the split's own count where both are known and refuses a
  declaration larger than the split rather than clamping it, because clamping would publish a
  smaller sample under the number the caller declared. `selection.requested` is now that resolved
  number; `eval/baseline/bird.json` records `scoredBySplit.minidev: 496`, the pool a rate is
  computed over, instead of 500.

  `subset.ts` shares the parser, so a competitor's `--limit` blank now means the whole split and
  its file is named `minidev-subset-all.json`. Coverage of the change: `parseLimit`/`resolveLimit`
  contract tests, a `resolveSettings` test that asserts the size stays undecided, and an end-to-end
  dry run over a dataset that carries three rows for two questions — Mini-Dev's shape in
  miniature — asserting `rows: 3, available: 2, requested: 2, sampled: false`, plus the same run
  with `BIRD_LIMIT=500` throwing. Before the fix that assertion read `requested: 500`.

- **The split was read as 500 rows, so one question was asked, weighted and scored twice.** Mini-Dev
  carries 500 rows and **498 question ids**: ids 137 and 138 each appear twice, byte for byte, at
  positions 484/487 and 485/488. The harness read the file as a list of rows, so every published rate
  was over 498 cases of which 496 were distinct — one arbitrary question weighted twice — and the
  artifact's `available: 500` was a row count printed where a question count belonged. `data.ts` now
  reads a question file as a pool (`distinctQuestions`): one row per id, the file's own order, and the
  repeats reported. Two rows with one id and **different** content are refused, because there the id
  names two questions and neither id-keyed reader can join on it.

  The correction changes no reading. Recomputed from the cases of `41158744927`, the largest movement
  across its twelve arms is **0.18pp** (`inline+evidence` 281/498 → 279/496), against a harness noise
  floor of **0.81pp** in the same run (the A/A pair `inline+evidence` against `inline+evidence#2` over
  the same denominator). What it changes is what the number is a rate *about*.

  Three defects were the same confusion in three places. `scored < available` was read as "this run
  sampled the split", which two refused gold statements make true on a whole-split run — so a
  mixed-candidate arm's feasibility guard, the one that refuses three prompts for one opinion, was
  switched off for a reason that has nothing to do with sampling; sampling is now
  `selected.length !== questions.length`, recorded as `selection.sampled`. `gold.unrunnable` was
  truncated to twenty, so the twenty-first refused statement was invisible to everything downstream.
  And `score.ts` parsed a competitor's answers against the questions this harness *could judge*, so a
  question whose gold refused came back as an `unknown` id — a false accusation about their numbering.
  Their statements are now read against the questions both pipelines were asked, the question-set
  coordinate compares asked against asked, and the difference is an exclusion carrying the executor's
  own reason. That last one is not cosmetic: it is the reason a full-split comparison can be called
  comparable at all, since the coordinate would otherwise compare their 498 declared questions with
  this harness's 496 judged ones and refuse for a reason neither pipeline controls.

- **The subset handed to a row-numbered pipeline was cut from rows, so `readIdMap` refused it.**
  `readIdMap` refuses a map that repeats an id — correctly, because a position would no longer name
  one question — and a 500-row map of a 498-question file does exactly that. The subset is now cut
  from the pool and prints what it collapsed above the subset it wrote:
  `minidev: 500 row(s), 498 question(s) — 137, 138 repeat byte-for-byte and are counted once`. The
  same line is printed by a run of our own, so the two pipelines in a comparison cannot describe the
  same file differently.

- **Two tools carried their entry guard as a module-scope `if`, and the ledger recorded the debt.**
  `eval/competitors/probe.ts` and `eval/competitors/score.ts` each took that branch exactly once per
  process, in the one context no test can enter, so both the condition and the call were uncovered.
  `eval/entry.ts` holds one guard that *returns* the work instead — generic over the exit code, so
  the synchronous tools and the asynchronous one share it — and the module body is one unconditional
  assignment. Both files move to **100% on all four dimensions** (score.ts was 99.29/99.13, probe.ts
  98.50/98.71); eval coverage is 50 of 50 files at target, 99.38% lines and 97.94% branches.

- **The first `full` competitor run read a zero-byte file as a "significant" 60pp gap.** The
  dispatch finished green with an empty `predictions.json`, and `score.ts` scored it as 0% over 25
  questions with `delta +60pp, p = 6.1e-05, resolves true`. Their side: MAC-SQL's `run.py` builds
  `unfinished_ids` as `range(len(batch))` and compares `question_id` against it, so a question file
  carrying BIRD's own ids — this split starts at 36 — matched no row, the batch emptied, and
  `0it [00:00, ?it/s]` was written where the statements belonged. Our side: nothing in the tool
  distinguished "the pipeline wrote nothing" from "the pipeline answered nothing".

  Three changes. A file that nothing could be attributed from stops the run and exits non-zero, and
  the message says which of the three silences it was — no records at all, every statement numbered
  outside the question set, or every record naming a question this split does not hold — while a file
  whose records are all blank still scores 0%, because that run happened and the model returned
  nothing for every question. `pins.json` now records `numbering` per competitor
  (`position` for MAC-SQL, `question-id` for CHESS), the score step passes `--id-map <subset>` only
  for the first, and `subset.ts`'s `readIdMap` reads that same file back as position → question id.
  A declared map governs **every** record, including one whose number is also a question id: letting
  each record pick whichever numbering resolves it makes the pairing depend on which ids are small,
  so one file would pair differently against a different subset. And the MAC-SQL adapter patch
  gained a third hunk that renumbers at their I/O boundary, keeping the original id under
  `bird_question_id`, so the selector, the decomposer, the refiner and their prompts still are the
  method under test.

  The artifact now carries `idMap` (or `null`) and `ledger.renumbered`, so a score read through a
  different numbering is not the same artifact as one read by id.

  The second dispatch proved the renumbering (the batch now iterates 25 rows instead of `0it`) and
  failed on the next thing that was theirs: `core/agents.py` normalises its database root with
  `data_path.strip('/')`, which strips the leading separator as well as the trailing one, so the
  runner's absolute root became relative and all twenty-five questions raised
  `sqlite3.OperationalError: unable to open database file` — caught per question by `run.py`, slept
  twenty seconds on, and turned into an empty output. The adapter's fourth hunk turns it into
  `rstrip('/\\')` and `core/agents.py` joins the pin's `probe` list. That dispatch also exposed a
  reporting defect on our side: the `PROBLEM` line explaining the empty file was printed after the
  accuracy, so the early return that says `no accuracy: nothing was judged` swallowed it. Problems
  are now printed before the verdict, and a test asserts the line survives that return.

### Measured

- **The audit turn moves 1 condition out of 151, and says "nothing missing" on 96% of turns.**
  `41258117038`, 496 questions, both arms and the parent's A/A duplicate in one run: parent 275
  (55.44%), audit 280 (56.45%), A/A 277. Paired: +1.01pp, 4 gained, 9 lost, p = 0.27, CI [-0.42,
  +2.43], MDE 2.04pp, one extra call a case and 2,864 -> 6,850 characters (+139%), of which the
  audit turn itself is 3,986. The funnel: **488 turns fired, 24 conditions named, 19 statements
  rewritten (3.9%)** — the model believes its statement is complete, and on 58% of failures it is
  right. `bench:bird:conditions` on the same corpus: 93 of 221 failures missing a condition (151
  conditions) before, 90 of 216 (150) after. Not adopted: the mechanism reaches the population and
  cannot see inside it.

- **The projection is not the finding: 2.22pp for an oracle, at or below this harness's noise.**
  The 52 `column-count` failures at `41206085907` split 37 wide / 15 narrow, and the smallest
  deletion that fixes each of them recovers **11** — 1486 (two intermediate `SUM(CASE …)` columns),
  1533 (`c.CustomerID` in a question about an aggregate), 1031 (`p.player_name` in a question about
  an age), 1078 and 865 (the raw date behind the age). Sometimes the key is the extra column and
  sometimes the measure is, so the four rows would need four different instructions: the number is
  published as a ceiling, not chased as a lever: 2.22pp is 0.22pp above this harness's own A/A
  movement (2.0pp) on 496 questions, and any rule a prompt can state reaches strictly less.

- **The 166 are wrong tables and wrong conditions, not wrong grain.** With both buckets admitted
  (`--scope all`), the 220 failures read: `predicate` 49, `filter-wide` 41, `tables` 36,
  `literal-missing` 34, `filter-narrow` 26, `projection` 11, `aggregate` 8, `literal-case` 5,
  unclassified 1 — and **`grain` 0, `scale` 0, `window` 0**. The `column-count` half of the bucket
  splits into 15 `predicate`, 15 `filter-wide`, 7 `tables`, 6 `projection`, 5 `literal-missing`, 4
  `aggregate`. 160 of 211 (75.8%) are a wrong table or a wrong condition, which is what the next
  work item has to attack; a shape guard cannot see any of it.

- **A second live run reproduces the ceiling and brackets the population.** CI (`41226576767`) runs
  the same three instruments on a fresh evaluation: 51 `column-count` cases (36 wide / 15 narrow /
  0 exact), **the same 11 recovered and the same 2.22pp**, 216 failures rather than 220, and **93
  (43.1%) missing a condition against 80 (36.4%)** on the artifact — `grain` / `scale` / `window`
  zero in both. The ceiling is identical because it is 11 of 496 either way; what moves is the
  model's failure count. The population the constraint audit targets is therefore published as the
  range **16.1–18.8pp**, not as a point.


- **Their refiner sees 54 of 496 cases and 166 of the 220 failures are invisible to it.** Applying
  `_is_need_refine` to the artifact's failing statements (`41206085907`, 496 questions, a census:
  the failure cap is 2,000 and nothing was truncated): 9 threw, 26 returned no rows, 19 exposed a
  NULL in their first five rows, and **166 fired nothing** — 75.5% of the failures, 33.5pp of the
  cases. The reach is therefore **10.89pp**, and 45 of the 54 fires carry a string that is the same
  for every case (`no data selected`; ``exist None value, you can add `NOT NULL` in SQL``).

- **The third condition fires on correct answers, and its instruction is false.** Run over the gold
  statements of the same 496 cases, 9 expose a NULL in their first five rows — **1.81pp** of
  correct answers that their refiner would rewrite, told to add `IS NOT NULL`. Question 1399 answers
  *"Did Maya Mclean attend the Women's Soccer event?"* with `CASE WHEN … THEN 'YES' END`, so the
  right answer **is NULL** when she did not attend; 25, 27, 36 and 50 report a school's second and
  third administrators, which are legitimately absent. Nine is a floor, not the size of the surface:
  a correct prediction can order its rows differently and present another window.

- **The empty turn's yield is 14.3% a fire, so `inline+evidence+empty` was cancelled.** The trigger
  is exact on this split — no gold result is empty, so all 26 fires are wrong answers — but the one
  measurement of what it buys is `select-mixed+empty` on dev: 63 fires, 32 retries that returned
  rows, and **9 cases**. A 50.8% row recovery is not a 50.8% accuracy recovery, and pricing the arm
  from the first number would have predicted +2.6pp where the evidence supports **+0.75pp** — under
  the harness's own 2.0pp A/A movement on 496 questions and under the dev split's MDE. The arm is
  declared, paired and filed on demand with that arithmetic in its note.

- **The attribution of the 6.45pp is closed, and it does not land on an agent.** Selector
  vocabulary: +2.82pp measured, and their sampling rule adds +586 characters for 0.00pp. Selector
  cut: −5.65pp when the model names the columns, and their version keeps six columns a table.
  Decomposer: −1.1pp then −0.85pp for the shape with the firing confirmed at 100%, 41.7% for
  retrieved demonstrations. Refiner: 1.8pp of its reach priced at ≈0 twice, 5.2pp with a measured
  yield of 14.3% and 3.8pp carrying a false instruction. What is left is 166 failures that run
  cleanly, return rows and are wrong, which no execution-triggered refiner can see.

- **The competitor's block, priced before it was run and then run: +2.82pp, of which the block
  explains at most 2.22pp and their selection rule explains 0.00pp.** `41206085907`, 496 scored
  questions, `deepseek-chat`, three arms and a duplicate: `inline+evidence` **55.6%** [51.2, 60.0] at
  2,641 prompt characters, `inline+evidence+samples` **58.5%** [54.1, 62.7] at 3,209, and
  `inline+evidence+samples-wide` — the block MAC-SQL's selector reads — **58.5%** [54.1, 62.7] at
  3,795. Paired: **+2.82pp** for the wide block (14/28, p=0.044, CI [+0.3, +5.4]) and **+2.82pp** for
  our sampler (13/27, p=0.039, CI [+0.3, +5.3]), and **0.00pp** between the two samplers (20/20,
  p=1.000, CI [−2.5, +2.5]). The A/A duplicate moved 0.2pp and could not resolve under 2.0pp.

  Two things make this a reading rather than a rate. The prompt grew by **exactly 1,154 characters**
  (2,641 → 3,795), which is the cost `bench:bird:differential` computed from the databases and the
  artifact with no model call — the instrument's bill and the endpoint's bill agree to the character
  on 496 cases. And the two samplers tie while both beat the card without them, so what the model
  used is the *information* (stored values, a small numeric dictionary, a nullability marker) and not
  the rule that picked which values: their rule spends +586 characters a case, +18.3%, for 0.00pp.

  The honest limits: both intervals reach down to +0.3pp, so 496 cases cannot separate +2.8pp from
  +0.3pp; 28 gains against 14 losses is not the ceiling's claim, because the arm changes 1,154
  characters of everything else the model reads and loses 14 cases the base got right; and the
  ceiling was computed on the previous artifact, whose base arm failed a different set of cases, so
  it bounds the *mechanism* (2.22pp of cases where the block spells a value the card did not) and not
  the arm's net.

- **The first reading in which the only difference is the pipeline: MAC-SQL 76.0%, our shipped arm
  64.0%, and nothing resolved.** `41162862386` ran MAC-SQL at `31a9df5e` on this repository's runner,
  against the same endpoint and model, on the same 25 questions (set hash `51ad259b9396483c`), and
  scored its statements with `oracle.py` and `judgeOfficial`. MAC-SQL answered 25/25, all 25 ran, 19
  were correct — **76.00% [56.57, 88.50]** against `metadata+evidence` at 16/25 = **64.00%**. Paired:
  14 both, 5 only theirs, 2 only ours, 4 neither; delta **12.00pp in their favour**, McNemar
  **p = 0.4531**, MDE **29.65pp** — inside the resolution, so this is a sign and not a size, and a 2pp
  effect at this discordance would need **5,495** questions.

  The reading is checkable in three ways that are worth more than the rate. The ledger holds no
  unknown ids, no duplicates, no blanks and **no database disagreements**, so all 25 records declared
  the database of the question their position resolved to — the check that fails first if a
  renumbering is off by one, and it is what makes this a reading rather than an alignment. Both sides
  answered the same 25 questions, checked by hash rather than by the workflow passing the same limit
  twice. And the artifact carries the declared `idMap` and the 25 `renumbered` ids beside the accuracy,
  so the numbering a score was read through travels with it.

  What it is not: 25 questions is a smoke run against a split of 498, nothing here composes with the
  published leaderboard table, and the direction it points — the competitor ahead — is the opposite of
  what an 11.3pp gap to state of the art would suggest about this harness's method. That is worth
  exactly as much as a 25-question sign is worth, which is why the MDE is quoted beside it.

- **The chain's bill, and the five arms that were paying it for no verdict.** Nobody had added up
  what `pnpm bench:bird` costs. The artifact of `41116622974` now prints it — `billedTotal` sums the
  per-arm row the meter writes — and the answer for the sixteen-arm chain is **23,840 prompt tokens
  a question**, 24,537 with the A/A control, **12.2M tokens for one push** over 498 questions. Read
  against each other the arms say where that money went: every multi-call variant's gap to `select`
  is **inside the MDE of the pair that produced it** — `vote` -0.40pp against 3.47pp, `select-prune`
  -1.41 against 3.51, `select-duo` -1.20 against 2.87, `select-mixed` +0.60 against 3.13, `select5`
  +0.40 against 3.08 — so another push cannot resolve any of them, and would pay 12,765 tokens a
  question to re-derive the same unresolved reading.

  Those five arms moved to `ON_DEMAND_ARMS`, each with the verdict that retired it. The chain is
  eleven arms: **14 nominal calls a question instead of 34, 11,075 prompt tokens instead of 23,840
  (-53.5%), 5.9M a push instead of 12.2M**. `metadata+evidence` stays because it is the prompt that
  ships; `select` stays at 2,540 tokens (23% of the new chain) for a reason that is not a delta — it
  is the only arm that executes the selector path every push, and `inline+retrieval` is the
  precedent for a path that is written, wired, paired and never run.

  The next push re-measured the same eleven arms on `41144429545`: **11,073 prompt tokens a question**
  against the 11,075 predicted, 14.04 nominal calls — the arithmetic to two tokens. The per-arm
  accuracies did not hold as tightly (`select` 57.23% → 58.23%, `metadata+evidence` 59.44% twice),
  which is the arm-level noise the repeat runs measured, arriving on the four-call arm.

  A budget keeps it from growing back: `test/bird-arms.test.ts` asserts the chain's nominal calls
  are at most fifteen against fourteen today, so one single-call rung fits and a four-call variant
  does not. The retired arms' floors were removed with them rather than left as floors nothing would
  notice — the gate's own rule — and their numbers are the table in `docs/benchmarks.md`.

- **The leaderboard table was never a pipeline comparison.** The dev-split section reported three
  gaps — 11.3pp to the published state of the art, 2.1-3.6pp to the DeepSeek-family systems, 5.5pp to
  a strong model's zero-shot baseline — as if they said something about this harness. They do not.
  Every row in that table differs from ours in the model, and most differ in the prompt, the
  executor and the judge as well; `deepseek-chat` today is not the `DeepSeek-v2` RSL-SQL was built
  on. The section now carries the five coordinates a comparison has to hold and states the correct
  claim instead: **11.3pp behind, and how much of that is the pipeline is unknown.** A comparison
  that counts has to run a pinned competitor commit on this repository's runner against the same
  endpoint and question file, with its predictions scored by this harness's executor and judge. That
  harness now exists (`eval/competitors/`, see Added) and no run through it has been published yet.

- **The selector is billed for 17.6% of every case and returns a coin.** The first run that meters
  per call (`41092489988`) splits `select`'s 2,539 prompt tokens per question into 2,092 for the
  three samples and **447 for the call that chooses between them** — 17.6% of the bill, on the pair
  that isolates exactly one lever, since `vote` draws the same three samples from the same prompt and
  chooses by majority instead of by asking. Paired over all 498 questions the two arms finish
  **284:284**: 17 questions only the selector got right, 17 only the majority got right, p = 1, on a
  design whose MDE for this pair is 3.28pp. That is "no discernible return" rather than "proven
  useless" — a stronger generator moves the ceiling and could make the judgement pay — but the bill
  is not in doubt. `select-duo` prices the cheaper version of the same bet: 359 tokens (20.5%) on a
  selector over two candidates, landing 0.6pp under the majority over three (p = 0.690).

  The parts now price separately: **+1,395 tokens for two more samples** of the same prompt (the
  two-sample generation line `select-duo` bills is literally that), **+447 for the selector**, and
  **+663 tokens for the whole chain against one call on dev, where it buys +0.39pp**. The first two
  are priced inside one arm's prompt and the third is a difference between two arms whose prompts
  differ by two and a half times, so they do not add up to each other — both subtractions are
  arithmetic, only the third is the price of the chain.

  A token figure belongs to the run that produced it: the same arms, split and model were billed
  2,271 and 2,717 prompt tokens in an earlier run against 2,092 and 2,539 here, 7–9% apart, and the
  artifact cannot say from inside what moved. Every cost table in `docs/benchmarks.md` therefore
  names its run and is read against its own accuracy column.

- **The dev split prices the four-call chain at +37% for +0.39pp.** One run of the 1,532-question
  split the leaderboards report (`41085194983`) scores `metadata+evidence` 942 (61.49%), `select` 948
  (61.88%) and `select-prune` 925 (60.38%). Paired over the same questions the single call is
  **+0.39pp** above the four-call chain, interval −1.22…+2.00, p = 0.691, on a design whose MDE for
  this pair is 2.30pp — it would have seen a 2pp difference and saw none. The bill is 1,778 against
  2,441 prompt tokens per question, so the chain is 37% more expensive for 0.39pp, or 0.13pp per
  extra call.

  The claim is non-inferiority, not equality: against a 2pp margin the single call is not worse
  (one-sided z = 2.91, p ≈ 0.002), which survives a Bonferroni floor of 0.0167 for the three pairs
  published. Two facts move from "direction" to "measurement" as a result: the 2.5pp advantage the
  single call showed on Mini-Dev (three-run mean 2.54pp) does **not** reproduce at 1,532 questions, while the pruned card's
  cost does — −1.54pp on Mini-Dev (three-run mean) and −1.50pp on dev, the same number in five runs.

- **The pruned card's loss is the ceiling, not the selector.** It loses 28 reachable questions
  (1,008 → 980) and returns 925 where the full card returns 948; a selector as good as the full
  card's would have paid 26 of those 28, i.e. 922. By difficulty the cost is −2.1pp on simple
  (−19 questions), +0.7pp on moderate (+3) and −4.9pp on challenging (−7): a one-hop closure is a
  draw spread across the split, not a tax on one stratum.

- **The pruned-card gap reproduced three times, and the p-value a repeat buys.** A third run
  (`ff9295e7`) scored `metadata+evidence` 295/498 against `select` 286 and `select-prune` 274. The
  paired gaps against the pruned card are now −3.41pp (0.033), −4.62pp (**0.0032**) and −4.22pp
  (**0.0075**) — two runs under 0.01 with intervals that exclude zero. Three reservations keep that
  from being an adoption: pooling the three runs into one McNemar test is pseudoreplication and
  returns 115:55 (p < 0.0001) for a set of 1,488 pairs that holds each question three times, while
  the sign test over the 496 sampled questions gives 52:29 (p = 0.014); nine comparisons are
  published, and a Bonferroni floor of 0.0056 leaves one run and not the other; and the gap against
  `select` shrank across the three runs (−3.41 → −2.41 → −1.81pp) while the pruned-card gap held.

  The same three runs price the A/A floor by call count: the self-pair is −0.60pp, −0.40pp and
  0.00pp, and the across-run range of an arm grows with its call count — 0.60pp at one call,
  0.80–1.81pp at three to four, 2.81pp at six. Comparisons belong inside a call-count tier.

- **The card instrument was pricing a prompt nobody sends.** `bench:bird:card` renders every arm's
  prompt from `buildSchema`, and it built that schema with `withNotes: false` — so the 798 curated
  notes that are most of `metadata+evidence` were priced at zero — and then attached the generated
  definition block to every arm, including the ones whose prompt has none. Fixed in both
  directions: comments come from the source the run uses, and an arm that sends notes without being
  given any now fails instead of being rendered. The single-call arm's prompt is **7,207 characters
  against `select`'s 2,866**, and it is sent once where that arm sends four: **7,190 characters per
  case against 10,286** — 30% cheaper rather than 3.6 times dearer.

- **The cheaper arm is not the worse one, on both runs.** Paired by question from the same
  artifacts: `metadata+evidence` → `select` −3.41pp (p = 0.040) then −2.41pp (p = 0.119);
  → `select-prune` −3.41pp (0.033) then −4.62pp (0.0032); → `select-mixed` −2.61pp (0.105) then
  −1.20pp (0.489). Negative means the one-call arm scores higher. Pooled by question over both
  draws — the honest unit, since each of the 496 questions was measured twice — the pruned-card gap
  is 48:27, p = 0.020. Short of the 0.01 ADR-184 asks before an adoption claim, and uncorrected for
  the eight other pairs the artifact publishes; recorded as a direction with a measured price.

- **`metadata+evidence+prune` priced without a call: −13.5% of the prompt.** The closure removes
  13.5% of the single-call arm's prompt (7,207 → 6,232 characters) against 12.5% of `select`'s,
  because the card is 89.7% of one and 74.1% of the other. The price is identical: 33 of 496 cases
  lose one gold table, none lose all of them, and they are the same 33 cases — the rule is the same
  rule. The arm is in the catalogue and on demand; its 13.5% is the largest saving found so far
  that costs no model call.

- **Every four-call arm is dominated on tokens per question.** With both units in one artifact the
  arms can be compared on what a deployment pays: `inline+evidence` **756 tokens per question** at
  57.0%, `values` 763 at 56.6%, `metadata+evidence` **1,774 at 59.2%**, `vote` 2,271 at 56.8%,
  `select` 2,717 at 56.8%, `select-mixed` 2,721 at 58.0%, `select5` 4,402 at 57.4%. `select` spends
  3.6 times a single prompt to score 0.2pp below it; `select-mixed` spends 3.6 times to score 1.0pp
  above that arm and 1.5 times `metadata+evidence` to score 1.2pp below it; `select5` spends 2.5
  times `metadata+evidence` for 1.8pp less.

  Recorded as a reading rather than an adoption, because the gaps it ranks by are 1–2pp and a no-op
  change moved an arm 1.8pp between runs (below). What it establishes is that the cost axis had
  never been computed against the accuracy axis in the same artifact, and that the cheapest arm
  here is not the weakest one.

- **The card as a join closure: 12.6% of the prompt, no measured gain, and a loss where the closure
  cut a table.** `select-prune` is one lever from `select` — same linker, same three samples, same
  selector — with the card cut to the tables within one join of the ones the question names, and the
  whole card when it names none. Mini-Dev: the generation prompt falls **2,864 → 2,504 characters
  (−12.6%)** and 11,420 → 9,984 per question; over every call, **2,579 → 2,309 characters (−10.5%)**
  and **636 → 570 prompt tokens (−10.4%)**, at the same **4.05 characters per token**, which says the
  pruned card is not a different kind of text. The average call saves less than the generation
  prompt because one call in four is the selector's, and it never carried the card.

  Two runs of the same arm, on prompts that no commit between them touched: `57f70f71` scored
  **281/498 against 281/498** (18 exchanged, p = 1) and `947134b0` scored **283 against 272**
  (−2.21pp, 23 lost and 12 gained, p = 0.090). So a four-call arm moves 1.8pp between runs with
  nothing changed but the draw. Stratified by the new `carded` column, the direction survives both
  runs even though the size does not: in the 33 cases whose card lost a table the pruned arm lost
  **10 of 11** exchanges (p = 0.012), and in the other 463 it is 31 lost to 27 gained (p = 0.69) —
  a resample, not a gain.

- **The card report reports the card now, and the gap it had been hiding was 33 questions.**
  `bench:bird:card` published what the *linker* named and what an extra recaller would name — the
  same population on both arms of a card lever, and never the tables of the prompt that was sent.
  The new `carded` column compares the rendered card against the tables the gold statement reads:
  `select` holds **all 1,022** of them across 496 cases, `select-prune` holds **987** with 33 cases
  short of one and none short of all — the last being the evidence that the no-seed fallback fires.

- **Mini-Dev scores 498 rows over 496 distinct questions, and the duplicated pair decides close
  calls.** Questions 137 and 138 are listed twice in `mini_dev_sqlite.json`. The run counts rows,
  which is the official protocol; the card instrument measures each prompt once. `select` and
  `select-prune` are 283/272 by rows and 282/270 by distinct question in `947134b0`, so the two
  denominators differ by one case in each direction. Both are now stated wherever a delta is
  reported: a single question that flips moves the row-based score by 2/498, which is larger than
  the MDE at this sample size.

- **What the provider billed, and the ratio that calibrates the character instruments.** The two
  cost instruments could only count characters, because they never touch a provider; the runner now
  sums each answer's `usage` beside the characters of the same request, and reports both per case
  and per arm. Mini-Dev `select`: **2,579 characters and 636 prompt tokens per call over every
  call**, which is **4.05 characters per token**, against 2,309 and 570 — also 4.05 — for the
  pruned arm. `bench:bird:card` prints both units side by side, because a character count is a
  property of the text and a token count is a property of the tokenizer, and the ratio between them
  is the only calibration either zero-call instrument can get.

  The first version of this meter divided the tokens of four calls by the characters of one message
  and reported 1.04 characters per token. Four failures now fail the gate, none of them a target: an
  arm that made calls and metered none, an arm whose token column is zero despite its calls, an
  answer that arrived without a usage block (an unknown cost, not a free one), and a ratio below
  half a character per token — which no tokenizer produces, so the two columns would be describing
  different prompts.

- **Three quarters of every call is the schema card, and the card is the whole database.**
  `pnpm bench:bird:card <report> --arm <name> [--strict]` prices the prompt with zero model calls:
  it rebuilds the two messages the pipeline sends — the split's questions, the bare card, the
  artifact's definitions, the runner's `promptFor`, the pipeline's own `buildAskMessages` — and
  charges every character to the block that spent it. Mini-Dev `select`, 496 questions at 3.99
  calls each: **2,864 characters per call**, of which the card is **2,121 (74.1%)**, rules 274
  (9.6%), evidence 135 (4.7%), the linker's hint 133 (4.6%) and the question 90 (3.2%); 11,438
  characters per question.

  The card shows 7.3 tables and the gold statement reads 2.1 of them, so 41.6% of the card
  belongs to a table the gold never mentions and **a linker that never erred would remove 58.4%
  of the card**. `--strict` gates the two ways the instrument can be wrong, both absolute:
  nothing read, and a card rebuilt without the text the run placed on it.

- **The linker could name no table at all for one case in six.** `linkSchema` scores columns, and
  its name recaller tokenized the *column* name, so the table half of every identifier was
  invisible: "how many customers are there" matched nothing, because `customer_id` holds
  `customer` and `id`. Measured on 496 Mini-Dev questions: **86 cases (17.3%) kept no gold table**
  and 234 (47.2%) kept all of them. With the new `table` recaller, **9 (1.8%)** and **302
  (60.9%)**. It is opt-in — the default set is unchanged, so every accuracy number in this
  repository still describes the prompt it was measured on — and the pipeline gained a `recallers`
  option so a caller can turn it on, because a recaller nobody can select is dead code.

  60.9% is why the card is not pruned: 194 cases would lose a table they need, and the residue is
  the join partner the question never names (`gold customers, yearmonth`, kept `yearmonth`).

- **Three fifths of the no-answer cases had every value the gold needs in the prompt.** `pnpm
  bench:bird:info <report> --arm <name> [--strict]` renders the prompt the arm actually sent — the
  split's questions, the bare card, the definitions the artifact recorded, the runner's own
  `promptFor` — and classifies each filter value the gold statement compares against as `spelled`,
  `casing`, `notation` or `absent`, with `none` for a statement that compares against no string at
  all. The plan's prompt-coverage entry started on identifiers and that axis is saturated
  (`bench:bird:recall`: 500 of 500 questions, 3,820 of 3,820 identifiers), so this is the same
  question one level down, where the axis has variance.

  Mini-Dev `select`, **184** no-answer cases: `spelled` **111 (60.3%)**, `casing` 8 (4.3%),
  `notation` 6 (3.3%), `absent` 4 (2.2%), `none` 55 (29.9%). The addressable set — the cases a
  stored-value sample could reach — is **18, 9.8%**, and that is a ceiling rather than an estimate.
  It prices a lever two iterations old: `inline+evidence+samples` measured +1.31pp at p = 0.052 and
  was set aside as unresolved, and 18 cases is 3.6pp, so the lever had headroom for roughly a third
  of what it could have reached. Zero model calls, zero queries, no oracle.

  `--strict` gates two things, both absolute: nothing read, and a prompt this tool rebuilt without
  the text the run placed on it (an artifact missing a database's definitions, or an arm whose
  prompt needs a block the artifact does not keep). The quality gate runs it; the dev workflow
  runs it without `--strict` because the class distribution is a reading.

  Crossed with the clause taxonomy the addressable cases are not spread evenly: `filter-narrow`
  holds **9 of the 18** — the bucket whose statement returned nothing, which is the symptom the
  lever predicts — while `tables` and `predicate` hold **none** (31 of their 51 cases are
  `spelled`, 20 compare against no string), so their failure is in how the join is chosen and how
  the condition is expressed rather than in a value nobody showed the model.

  The cross-tab also surfaced a denominator detail that is recorded rather than fixed: the
  Mini-Dev question file carries questions **137 and 138 twice**, so its 500 rows are 498 unique
  questions and an arm's `total` of 498 is 496 unique cases with two counted twice. 2/498 = 0.4%,
  below the split's resolution, and deduplicating moves every published Mini-Dev denominator and
  the floors calibrated on them, so it is queued as one deliberate change with a recalibration.

- **The vocabulary taxonomy read a value that contains a quote as two values.** The reader behind
  `literal-missing` and `literal-case` scanned literals with `/'([^']*)'/g`, which turns
  `'Ancestor''s Chosen'` into `'Ancestor'` and `'s Chosen'` — two values that exist nowhere — so a
  prediction that wrote the value correctly was reported as missing both. It now uses the same
  scanner the repair stage edits with, which unescapes `''` and skips comments and quoted
  identifiers. `missingLiterals` also compares `'18'` with `18` as one value, because the question
  is whether the prediction named it, not how it spelled it. Both changes move exactly one case of
  130: Mini-Dev 1068 leaves `literal-missing` for `predicate`. 19 dev and 8 Mini-Dev gold
  statements carry a value with an apostrophe, so the shape was not hypothetical.

- **One provable repair recovers two cases, and it found a gold query that is wrong.** `pnpm
  bench:bird:repair <report> --arm <name> --strict` offers every no-answer statement one edit —
  substitute the single stored spelling a column has for a literal that differs only in case — and
  reports what it recovers against what it would break. The second half is the finding. Applied
  unconditionally the edit rewrites **1 of 1,534** gold statements: dev `640` stores
  `users.DisplayName = 'mornington'` where BIRD's gold compares `'Mornington'`, so the reference
  answer is the answer to a filter that matches nothing, and a model that writes the *correct*
  statement is judged wrong on that question.

  Gated on a statement that returned no rows — a property of the corpus rather than a heuristic,
  since `controls.emptyGoldExcluded` is 0 in both splits — the edit touches **0 of 1,534** gold
  statements and recovers **2** of the 1,532 scorable dev questions: 70 statements returned nothing,
  5 of them compared a case-twin literal, 3 of those were wrong for a second reason too. Two cases
  is **+0.13pp**, below the 1.27pp the split can resolve, so the repair is **not adopted**: it stays
  a measured candidate while the instrument stays a gate, because the absolute bar it enforces —
  a statement edit must touch no gold statement — is what any future repair has to pass.

- **The `values` bucket is conditions and join paths, not aggregation.** `pnpm bench:bird:gap:values
  <report> --arm <name> --strict` reads the bucket the parent tool cannot split and files every case
  under the clause a fix would change: `no-statement`, `filter-narrow`, `filter-wide`, `scale`,
  `literal-missing`, `literal-case`, `tables`, `predicate`, `aggregate`, `grain`, `projection`,
  `window`, `equivalent`. On the dev split (`40908325901`, `select-cross`) the **396** cases fall:
  `filter-wide` 88, `predicate` 76, `literal-missing` 70, `tables` 61, `filter-narrow` 53,
  `no-statement` 17, `aggregate` 11, `projection` 10, `literal-case` 6, `window` 2, `grain` 1,
  `scale` 0, `equivalent` 0, `unclassified` 1 (99.7% named). Mini-Dev repeats the shape on `select`
  (130 cases, 99.2%).

  **The reading, and it contradicts the hypothesis the taxonomy was built on.** 213 of 396 cases
  (53.8%) read a different table or applied different conditions, and 76 more (19.2%) wrote a value
  the gold does not name. The aggregation-level story — `scale` and `grain`, the two buckets the
  first version led with — accounts for **one** case. Statements are not wrong about arithmetic;
  they are wrong about which tables join and which rows qualify, and about the literal values in
  them. Six of those literals are the right word in the wrong case (`'Directly funded'` against
  `'Directly Funded'`), which SQLite compares as different values: a right-looking statement with a
  wrong answer, and the one bucket whose fix is in what the prompt shows rather than in reasoning.

  Two defects were found in the instrument before any of those numbers were trusted. The first
  reading scored **72.1%** and refused to publish; the 139 unattributed cases were **86 cases the
  judge had filed under `column-count`**, which this tool has no business splitting — a statement
  whose width is wrong has a projection finding, and no clause reading improves on it — plus 53 that
  the taxonomy genuinely lacked a name for. The denominator is now the parent's bucket, the missing
  rungs exist, and the thirteen-cause ladder reaches 99.7%. `--strict` is what a gate uses; a measurement
  prints the same table without failing the run, so a new split can be read before it is enforced.

- **The 34pp column has a shape now, and it is not the engine.** `pnpm bench:bird:gap` reads a run
  artifact and classifies every question whose candidate set held no answer. On the dev split
  (`40865112253`) `select-cross` has **523** such questions: **15** `engine-refused`, **120**
  `column-count`, **388** `values`; on Mini-Dev (`40878610004`) the same shape repeats across five
  arms (1.6–3.9% / 21.7–27.4% / 70.3–76.6%). The statements run and the numbers are wrong, so the
  fix is not error recovery — and the split below is what says which of grain, filters and literals
  it actually is. The tool also measured the instrument
  rather than the model: **687 of 1,043** no-answer cases had no retained statement, because the
  failure corpus was capped at 200 per arm. The cap is now above the largest split (1,534), so the
  corpus is a census and `truncated` stays empty.

- **`candidateRecall` is a gate, beside accuracy, from the minimum of ten runs.** The score is the
  product of a candidate set and a selector, and only the product was guarded: `select-mixed` buys
  4.9pp of score with 2.8pp of ceiling on Mini-Dev (`58.8%` vs `select`'s `61.6%`), a trade the
  accuracy column cannot see and a later run could extend by accident. `eval/baseline/bird.json`
  now carries `recallFloors` per split, taken as the minimum observed across six Mini-Dev runs
  (`vote` 60.6, `select` 61.6, `select-duo` 56.4, `select-mixed` 58.8, `select5` 63.8) and four dev
  runs (`select-cross` 65.8), enforced with the same 4pp tolerance because both are proportions over
  the same questions. The four Mini-Dev sampling arms also gained accuracy floors in the same pass:
  they were measured every push and guarded by nothing. Eight new self-test cases, including a
  ceiling that falls while the score holds, a sampling arm that publishes no ceiling at all, and a
  ceiling share that contradicts its own count.

- **The artifact already contained an accuracy budget, and every recent experiment spent it in the
  narrow column.** `candidateRecall − selectionLoss = passed` holds exactly on both arms of run
  `40865112253`: 1,009 − 71 = 938 and 1,012 − 84 = 928. Read as a budget it says the ceiling is
  **65.86%**, the selection loss is **4.63pp**, and **34.14%** of cases have no correct candidate
  at all. The selector already recovers **93.0%** of what it is given.

  That re-prices the last five rounds, all of which act on the 4.63pp column: judge swap
  −6.01/−5.87pp, canonical text −0.46pp (p = 0.31), candidate order −0.65pp (p = 0.19), more
  candidates and prompt rewording negative or dominated. The channel is narrower than the design's
  own resolution at n = 1,532 (MDE 1.27pp), which is why none of them moved the score. The
  untouched column is 7.4 times larger and it is a generation problem — prompt, retrieval,
  evidence, repair loop — with no repair in common with the selection problem.

  So the next iteration diagnoses the 523 no-answer cases, puts `candidateRecall` into the baseline
  gate beside accuracy (65.86% is a hard ceiling, and a recall drop that accuracy cannot see is
  currently silent), and builds the prompt-coverage/recall stratification. The third-party judge
  drops from "only remaining exit" to one more candidate in the narrow column.

- **The judge reads the slot, not the author — and that moves nothing that counts.** Run
  `40865112253` (dev, 1,532 scorable, `glm-4-flash` writing the `@second` candidate) held the
  candidate set fixed and permuted only the order per question. On the 1,129 cases that carry all
  three candidates, every source's selection rate collapses with its slot
  (`metadata+evidence` 79.8% → 33.8% → 5.1%, `values` 78.2% → 35.0% → 7.9%,
  `inline+evidence@second` 36.2% → 13.8% → 11.2%) while **each source's own correctness does not
  move at all** (65.5/62.9/66.2, 60.0/69.2/65.0, 49.7/45.7/46.7). 64.7% of winners sit in slot 0.

  Accuracy: **61.23% → 60.57%**, Δ **−0.65pp**, McNemar 29/19, **p = 0.19**, interval
  **[−1.54pp, +0.23pp]**, MDE 1.27pp. The permutation moved selection by 25 to 75pp and the score
  by less than its own noise floor. The reason is measurable before the run: cases where **only**
  the second model's statement is correct are **3.7–4.6%**, while cases where at least one
  candidate is correct are 63.9–70.5%. Redundant candidates make "which one" almost irrelevant to
  "is it right".

  So placement is a first-class lever on the selector and not on accuracy. The registered criteria
  predicted the first and prescribed work on the second; this run falsified the prescription with
  its own paired numbers. Two consequences are recorded rather than fixed by a threshold: the
  criterion's 52.6% threshold belonged to the judge-swap run (`@second` is 27.0% of winners under
  the primary judge here), and `select-cross-shuffled` stays out of the adoption chain as a
  diagnostic lever.

- **One foreign key reaches the table the question never names, and two hops reach almost the whole
  card.** `pnpm bench:bird:join <report> --arm <name> [--strict]` walks the foreign-key graph from
  the tables the linker names and compares the closure with the tables the gold statement reads.
  Zero model calls. Mini-Dev `select`, 496 questions, 2,122-character card:

  | edges | recallers | hops | kept tables | chars | saved | **safe** | gold all | some | none |
  |---|---|---|---|---|---|---|---|---|---|
  | declared | shipped | 0 | 3.7 | 1,348 | 36.5% | 15.8% | 304 | 176 | 16 |
  | declared | shipped | 1 | 5.9 | 1,762 | 17.0% | 14.6% | **463** | 33 | **0** |
  | declared | +table | 1 | 5.7 | 1,768 | 16.7% | **15.1%** | **472** | 24 | **0** |
  | declared | +table | 2 | 6.7 | 2,007 | 5.4% | 5.1% | 485 | 11 | 0 |
  | +shared columns | +table | 1 | 6.2 | 1,868 | 12.0% | 11.2% | 481 | 15 | 0 |
  | +shared columns | +table | 2 | 7.0 | 2,078 | 2.1% | 2.1% | **496** | **0** | 0 |

  One hop with the table recaller keeps every gold table for **95.2%** of cases (472 of 496) and
  ends the 86 cases that kept none — the residue the card measurement named. The shippable saving
  is **15.1%** of the prompt (2,122 → 1,802 characters), which is **20% of the card**, because a
  case whose closure misses a gold table is sent the whole card. Two hops reaches 100% with the
  shared-column graph and saves 2.1%: the depth that fixes coverage is the depth that removes the
  saving, which is why the plan's prune experiment is pinned at one hop.

  Two facts about the graph belong in the same entry. The manifest's keys are incomplete —
  `debit_card_specializing` declares **one** foreign key and its gold statements join four tables
  on `CustomerID` and `GasStationID` — so the shared-column source is measured beside it: 26 more
  edges, 481 cases at one hop instead of 472, and 3.9pp less saving. And a shared column is only
  evidence when it is not vocabulary: a name carried by more than a third of a database's tables
  (`year`, `name`, `id`) is dropped, because connecting every table that has one makes the closure
  the whole card.

- **The table recaller is not a superset of the shipped one.** Adding a fourth recaller changes the
  reciprocal-rank fusion, and the columns near the twelve-slot cutoff move: case 1057
  (`european_football_2`, "average home team goal in the country of Poland") keeps `country` with
  the shipped set and loses it with the candidate set, while the totals move the other way by nine
  cases. `candidate` is a different linker, not a larger one, and a report that called it an
  extension would mis-read every per-case delta computed from it.

### Fixed

- **Five instruments measured nothing and exited zero.** `card`, `join`, `information`, `repair` and
  `values-gap` all filter an artifact's cases by arm name, and when the name is not there the filter
  returns nothing and the table prints zeros in the typography of a measurement. `--strict` turned
  that into a failure; the dev workflow omits `--strict` on purpose, because the readings there are
  findings rather than floors. The result is that five steps of `bird-dev.yml` read `select-cross` —
  an arm that workflow never runs — and have been green and empty for as long as they have existed.

  `requireArm` now runs before the filter and throws, naming the arms the report does hold; a zero is
  a finding and no rows is a missing input, and only the first may be reported. The dev workflow runs
  `select` in its default arm list and its five instrument steps read it, so the steps measure the
  run they are attached to. The tools' default arm changed with the same reasoning: it was
  `select-cross`, which no chain contains, and is now `metadata+evidence`, the prompt that ships.

- **The paired comparison keyed on an id that Mini-Dev does not keep unique.** `compareArms` built a
  map from the second arm's outcomes by case id, so when a split lists a question twice — Mini-Dev's
  published file has 500 rows for 498 questions, with questions 137 and 138 each appearing twice —
  both of the first arm's rows for that question read the **last** answer the second arm recorded.
  One draw's pass was then compared with another draw's pass. `delta` was unaffected, because it is
  taken from the accuracies; `onlyFirst` and `onlySecond` were not, and those are the counts
  `mcnemarExact` and the interval are computed from. Occurrences are now consumed in the order the
  arms answered them, and an arm that answers a different multiset of questions is refused instead of
  matched to whatever was left over.

  Measured on the 17-arm artifact that carries the defect (every arm has the two duplicates): **2 of
  the 11 published pairs move**, both toward "no difference" — `select` → `select-prune` 23:21
  (p = 0.8804) becomes 23:22 (p = 1.0000), and `metadata+evidence` → `select-prune` 38:23 (p = 0.0722)
  becomes 37:23 (p = 0.0925). The other nine are unchanged, including every pair this document draws
  a conclusion from, and no verdict flips: nothing crosses 0.01 or 0.05 in either direction. Those
  two pairs are also the only two whose counts did not reconcile with their own delta: a cell count
  of 23:21 implies the first arm passed 2 more cases, and its delta said 1. That identity is now
  asserted — **`onlyFirst - onlySecond` must equal the first arm's passes minus the second's** —
  so a pairing that drops or duplicates a pair fails instead of publishing a plausible table. The
  first run after the fix (`41107220836`) reports `select` 285 against `select-prune` 278 as 23:16,
  and 23 − 16 = 7 = 285 − 278. The p-values quoted for runs whose artifacts are not in the
  repository were computed before this fix and are republished by the next run of each pair; the size
  of the correction is bounded above.

- **A CTE is not a table, and the card instrument counted it as one.** `goldTables` lowered every
  `from` and `join` reference, so `with a as (...), b as (...) select * from a join b` contributed
  two tables the card cannot show and the case could never be `all` — a linker failure read off an
  instrument defect. Five Mini-Dev statements define their own tables; excluding them moves the
  shipped linker's full coverage **230 → 234** and the candidate's **300 → 302**, with the 58.4%
  ceiling unchanged because a CTE contributes no characters. The predicate lives in `statement.ts`
  beside the scanner, matches a *definition* (`name as (select`) rather than a `with`, because BIRD
  writes several CTEs per statement, and is shared by both instruments.

- **The prompt instruments measured the system message and called it the prompt.** The model
  receives `buildSqlPrompt`'s output *and* a user turn carrying the linker's hint and the question
  again; `bench:bird:info` stopped at the first. Re-measured through `buildAskMessages` the five
  value classes are unchanged (111/8/6/4/55) because the hint lists identifiers and the classes
  are about values — zero cases moved, and the claim now matches the measurement.

- **The gate that refuses an arm whose prompt cannot be rebuilt had a hole at the arm it was
  written for.** `renderableArm` listed the synthesized hint, matched values, worked examples and
  decompositions, but not retrieved evidence, although the artifact keeps only a count of the
  retrieved blocks. `inline+retrieval` therefore came back renderable, `promptFor` dropped the
  evidence without saying so, and an instrument would have reported a prompt the model never saw
  as the prompt that was sent. The check now lives with the arm definition in `run.ts` and refuses
  it by name.

- `buildAskMessages` returns its pair as a fixed two-tuple, so a caller cannot index a third
  message that does not exist, and `CaseRecord` declares the `calls` field the runner has always
  written — every tool that priced an arm had been going around the type to read it.

### Added

- **Every call says what it was for, and a bill that cannot be split refuses to publish.** The
  interesting cost in a four-call arm is not the total: it is which call carries it. `LlmRequest`
  now takes an optional `purpose` from a closed set — `generate`, `retry`, `select`, `compare`,
  `plan`, `interpret`, `synthesize` — and `withCallCounter` meters every call twice from one ledger,
  into running totals and into a per-purpose map. A call that does not declare a purpose lands in
  `unlabelled`, and `armReportRow` treats that as fatal rather than as rounding: *"N calls on arm A
  do not say what they were for, so their tokens cannot be attributed."* The alternative — a second
  pass that recomputed the split from the per-purpose map — was implemented, measured **284 bytes**
  fatter in the `ai` bundle (41,555 B against 41,271 B), and reverted; a property test pins
  `Σ purposes == totals` so a purpose added to one view and not the other fails a test instead of
  skewing a table.

  The split lands per case in `tokens.byPurpose`, is averaged into `ArmReportRow.tokens.byPurpose`,
  and `bench:bird:card` prints it as shares of the case total with two absolute failures beside it: a
  non-zero `unlabelled` count, and a per-purpose split that does not add up to the billed total
  within `max(1, 2%)`. `select` and `compare` are named as selector calls in the footnote, because a
  reader who is told only "447 tokens" cannot tell whether that is a sample or a decision.

- **A rate per stratum, with the width that makes it readable.** A shuffled run produces one
  conversion rate per candidate slot, four hundred to a thousand cases each, and `52.6 / 49.1 /
  55.3` reads the same as `52.6 / 20.0 / 48.0` to anyone who is not shown the intervals — while
  only the second is a finding. `eval/bird/position.ts` (`pnpm bench:bird:position --arm A`)
  groups an arm's cases by the slot the tracked candidate sat in and prints, per stratum, the
  cases, `took`, `passed`, and a Wilson interval for each, then a Newcombe interval for the
  difference between the two extreme strata.

  The verdict has three states, and the middle one is the reason for the tool: `separated` (the
  interval excludes zero — the slot moved the choice in this run), `overlapping` (this run does
  not separate the slot from the author, which is **not** the same as showing they are the same),
  and `single-slot` (the artifact cannot answer the question at all, because an arm that never
  moves the statement gives one number for both readings). Wilson rather than the textbook
  interval because the strata are exactly where it fails: a slot taken on every case or on none
  has an estimated variance of zero, and Wald would report a certainty the sample cannot carry.
  `took` and `passed` are counted apart, since their gap is the part the judge decided rather
  than the selector. The comparison is a union type with no `spreadPp` on the one-stratum branch,
  so "no comparison was made" cannot wear the clothes of "a zero was measured".

  The tool writes no verdict about which hypothesis wins: the criteria were registered in advance
  and are read off it, which is the order this repository got wrong once before.

- **`candidateFailures` had one cell for two mechanisms and now has three.** A rerun put 440 of
  4,596 candidates in `other`, and 375 of the 380 cases that were short a candidate were short the
  *second model's* — which reads as a cross-arm ceiling finding when the cause may be a statement
  the engine refused (the prompt writes SQL that will not run) or a reply the parser could not read
  (the prompt produced nothing usable). Those are repaired by changing the prompt and by changing
  extraction respectively, and a merged counter recommends neither. The field is now
  `{llm, engine, unparsed}`, classified straight off the error code
  (`classifyCandidateFailure`: `NL2C_E_TIMEOUT`/`NL2C_E_LLM_UNAVAILABLE` → `llm`,
  `NL2C_E_GUARD_REJECTED`/`NL2C_E_ENGINE_FAILED` → `engine`, everything else including
  `NL2C_E_LLM_INVALID_RESPONSE` → `unparsed` — an unusable answer is output quality, not an outage).

  Each arm also carries `candidateSurvival`: per source, how many candidates it was asked for and how
  many arrived. `candidateFailures` says how many were lost; this says *whose*, which is the
  difference between a second endpoint refusing its candidate (a vendor problem) and one of our own
  prompts never parsing (ours). The per-case record is written even when every candidate died, which
  is the case a merged count is least able to describe.

  Only `llm` still fails a run. `engine` above the same share is a *note*, not a gate: a statement
  that will not run is the model's output quality, and the arm's 0% is a reading the report has to
  be able to carry. The first version of this change gated `engine` at 10% and the existing
  "no sample survived" end-to-end test turned red on the next run, which is the test doing its job.

### Added

- **The order of the candidates is a channel, and it was confounded with authorship.** Every
  cross-model arm so far lists the second model's statement first (`CROSS_SOURCES`), so the 52.6%
  of cases where `@second` is returned supports two readings that call for opposite next steps —
  the judge prefers that author, or the judge prefers slot zero. `select-cross-shuffled` permutes
  the same three candidates per question id (`shuffleByCase`: FNV-1a over `id#slot`, then
  Fisher–Yates) and changes nothing else: one lever from `select-cross`, same candidates, same
  count, same four calls, and the permutation is a function of the question, so a rerun is
  comparable to the run it is compared with rather than to the order the pool happened to finish
  in. The modal vote deliberately stays on the unpermuted set, so a tie it breaks is broken the
  same way in both arms.

  The artifact needed no new field: `cases[].candidates` is documented as "the order the selector
  saw it", and it now actually is — on a canonical arm the text moves and the order does not, on a
  shuffled arm the order moves and the text does not. Author (`source`) crossed with index is the
  position record, which is why the reading is available after a 90-minute run instead of needing
  a second one.

- **A statement can be made to look like nobody's.** The judge swap proved the preference is
  authorship and left the channel open; `eval/bird/canonical.ts` closes it. `canonicalSql` uppercases
  keywords and functions, lowercases identifiers, normalises whitespace, drops comments, writes `!=`
  as `<>` and drops a trailing semicolon — and copies string literals, blob literals and quoted
  identifiers byte for byte, keeps a separator where the source's own was load-bearing (`x'41'` is a
  blob, `x '41'` is a name beside a string; `?1`, `:name`, `@name`, `$name` are one parameter), and
  renames no alias, because a rename needs scope and `1.0` is REAL where `1` is INTEGER.

  The new arm is `select-cross-canon`: one lever from `select-cross`, same candidates, same count,
  same four calls. The transformation is display-only — the selector reads the canonical text and
  the winner is taken by index from the untouched set (`readableCandidates`), so what executes and
  what the artifact calls the prediction are the model's own statement.

### Measured

- **The style channel is worth 1.24pp — and only to the judge that was using it.** The same
  canonical text read by the second model (run `40843792747`, full dev, one field from its control):
  `select-cross-judge` **54.83%** (840/1,532) against `select-cross-judge-canon` **56.07%**
  (859/1,532), **Δ = +1.24pp, 95% CI [+0.24, +2.24], p = 0.020**, 21 cases only the control, 40 only
  the canonical arm. Paired against the −0.46pp (p = 0.31) the same lever produced under the judge
  that can read SQL, the conclusion is that the channel's cost belongs to the weak reader.

  The registered *mechanism* is falsified, and the replacement is sharper than the criterion was.
  The two-agree group was asked to halve and went **124 → 111**. What moved is the column nobody
  predicted: when `metadata+evidence` alone held the answer, the weak judge returned it **13 of 26**
  times before and **21 of 29** after — 50.0% → **72.4%** — while its own statement's conversion
  barely changed (65.0% → 67.4%). So the channel was a **comprehension** channel, not a loyalty one:
  canonical text let the judge read a statement it did not write. And the two-agree group could not
  halve for a reason worth writing down — two candidates that return the same rows usually do so
  with *different statements*, and no text normalisation collapses different content.

- **Canonicalising the candidates changes nothing for a judge that can read SQL.** The lever ran on
  the full dev split (run `40842268219`, one field apart): `select-cross` **61.42%** (941/1,532)
  against `select-cross-canon` **60.97%** (934/1,532), **Δ = −0.46pp, 95% CI [−1.21, +0.30],
  p = 0.31**, 21 cases only the control, 14 only the canonical arm, discordance 2.28%, the design
  resolves 1.08pp. The registered criterion is not met, and the runner-up reading is the
  interesting one: the control took the second model's statement **32** times when it was the only
  correct answer, and so did the canonical arm — 32. The `128` that motivated the lever is **21**
  under this judge, so the two numbers were never the same phenomenon: a style channel that is real
  for one judge can be absent for another.

- **The judge swap reproduces: −5.87pp, and the rerun exposes a counter that merges two
  mechanisms.** The re-dispatched pair (`40835164245`, full dev, second model `glm-4-flash`) is the
  second independent reading of the same experiment: `select-cross` **60.90%** (933/1,532) against
  `select-cross-judge` **55.03%** (843/1,532), 129 cases only the first arm got and 39 only the
  second, **Δ = −5.87pp, 95% CI [−7.53, −4.22], p = 1.9e-12**, discordance 11.0%, resolves 2.37pp.
  The first run measured −6.01pp. Two runs, two p-values below 1e-11, same sign and same size: the
  cost of the swap is a property of the judge, not of one afternoon.

  It also put a number on something the candidate record had never printed. `candidateFailures`
  reads `{llm: 1, other: 440}` of **4,596** attempts, and the shape of the loss is not random:
  **380** of 1,532 cases carry two candidates instead of three, and **375** of those are missing
  `inline+evidence@second` — the second model's statement. So a quarter of the cross arm's cases
  never had that candidate to choose from, and the 25.6%→68.2% asymmetry is computed over the cases
  where it survived. What the counter cannot say is *why*: `other` merges a statement the engine
  refused with a reply no statement could be extracted from, and those call for opposite fixes
  (prompt vs parser). Splitting it is the next increment; until then the honest reading is that the
  ceiling of 1,011 is a ceiling over the candidates that ran.

- **The judge is the variable — and the swap costs 6.01pp because the other judge cannot read
  SQL.** The registered experiment finally ran: `select-cross` against `select-cross-judge`, same
  candidates, same selector prompt, same four calls, only the judge changes (run `40828283888`,
  full dev, second model `glm-4-flash`).

  | arm | judge | accuracy | ceiling | loss | `@second` taken | alone → returned |
  | --- | --- | --- | --- | --- | --- | --- |
  | `select-cross` | `deepseek-chat` | 60.70% | 1,006 | 76 | 27.7% | 11 of 43 (25.6%) |
  | `select-cross-judge` | `glm-4-flash` | 54.70% | 1,004 | 166 | 53.1% | 30 of 44 (68.2%) |

  **The asymmetry flips** (25.6% → 68.2% on the same construction), which answers the registered
  question: the preference is authorship, not "the second model's answers are harder". Paired
  Δ = −6.01pp, 95% CI [−7.64, −4.37], p = 2.7e-13, resolves 2.3pp. And the swap is not a fix —
  `glm-4-flash` loses 166 of its 1,004 ceiling cases against 76 of 1,006, so both judges prefer
  their own writing and only one can read the table.

  The candidate record says *how*, and this is the part accuracy could not: with `glm` judging, the
  single largest loss group is **128** cases where two candidates agreed, both were right, and the
  judge took its own statement anyway — against **23** for the other judge. Not doubt, not a
  threshold: a channel. The judge never sees a label, but it sees style, and style is authorship.
  Next lever: canonicalise the candidate text (keyword case, whitespace, operator spelling), one
  lever on the existing arm, no third model required — the record prices it directly.

- **The same arm has now read 61.70%, 61.55%, 60.70% and 60.90% on dev.** A 1.0pp spread across three runs
  is larger than the −0.78pp the first of them was used to claim. Every claim in `docs/benchmarks.md`
  comes from a paired comparison *inside* one run, which cancels this; the number is written down
  so a cross-run comparison is not made by accident.

- **The cross-vendor half: the ceiling rises 2.7pp, the selector buries it, and the sign does not
  flip.** The same pair on all 1,532 questions with `glm-4-flash` as the second model (run
  `40817333043`): `select-mixed` **62.7%**, `select-cross` **61.6%**, onlyFirst 42 / onlySecond
  25, **Δ = −1.11pp, 95% CI [−2.16, −0.06], p = 0.0498**, discordance 4.37%, resolves **1.5pp**.

  | second model | ceiling (mixed / cross) | selection loss | delta | p | `@second` wins |
  | --- | --- | --- | --- | --- | --- |
  | `deepseek-chat` | 975 / 974 | 18 / 29 | −0.78pp | 0.029 | 87% |
  | `glm-4-flash` | 977 / **1018** | 17 / **75** | −1.11pp | 0.0498 | 28% |

  Two things this settles and one it refuses to. The sign is the same under both second models,
  so the cost is "a candidate the prompts were not written for", not a vendor interaction. And
  the diversity argument is now measured rather than asserted: the cross-vendor candidate adds
  **41 questions** of ceiling (+2.7pp), and the selector converts that into a **58-question**
  loss, ending 17 lower — the ceiling is not the constraint, converting it is. What it refuses
  to settle is the size: the resolution at 4.37% discordance is 1.5pp, wider than the 1.11pp it
  measured, so the sign is supported and the magnitude is not. A 1pp claim on this split would
  need 3,434 cases.

- **The full dev split answers the question 120 questions could not: −0.78pp, and the loss is
  the selector's.** `select-mixed` against `select-cross`, one lever, 1,532 cases: **62.5% vs
  61.7%**, 19 cases only the mixed arm got, 7 only the cross arm, **Δ = −0.78pp, 95% CI
  [−1.44, −0.13], p = 0.029**, discordance 1.7%, resolves **0.93pp**, 334 cases for a 2pp
  claim. The previous round had computed that this question needed 818 cases; the split had
  1,532, and the effect it found is smaller than the 2pp anyone would have claimed — but the
  interval excludes zero, so "the cross-vendor candidate contributes nothing measurable" now
  has a sign and a size instead of an unresolved interval.

  The mechanism is exact, because the artifact carries both halves of the identity
  `passed = ceiling − selection loss`: the candidate sets are equal (**975 vs 974** questions
  where some candidate was right, a difference of one case) and the selector's losses are not
  (**18 vs 29**). All eleven extra discarded points are 0.72pp of the 0.78pp. The selector picks
  the `@second` candidate on 1,323 of 1,513 decided questions, 87% — the same preference the
  120-question run showed at 79%. Its taste did not change with the sample size; its cost did.

- **The confound was checked, not argued.** `select-mixed` duplicated a prompt on 933 of 1,532
  cases (61%), so the pooled delta mixed "three prompts against three" with "two against three".
  Splitting on those ids: **−0.67pp** where all three prompts were distinct (n=599) and
  **−0.86pp** where one was duplicated (n=933). The sign holds in both, so the delta is about who
  wrote the candidate, not about how many candidates there were — and the half where the cross
  arm has *more* distinct prompts is not where it gains. Neither stratum resolves better than
  1.3pp, which is why the pooled row carries the claim and the tool says so.

- **The cross-vendor candidate contributes nothing measurable on 120 questions, and the
  measurement itself is why we can say so.** Three groups on the same 120 dev questions:

  | group | second model | `select-mixed` | `select-cross` | delta | p | `@second` won |
  | --- | --- | --- | --- | --- | --- | --- |
  | A | `glm-4-flash` (cross-vendor) | 50.8% | 49.2% | −1.7pp | 0.625 | 18 / 120 |
  | B | `deepseek-chat` (same vendor) | 49.2% | 51.7% | +2.5pp | 0.375 | 95 / 120 |

  `select-cross` had shown 50.0% against `names`' 34.2% in the run before this, but that pair
  differs by four levers (three candidates, a model selector, linking, inline definitions) and
  is not in `PAIRS`, so it carried no p-value. Against `select-mixed` — same three prompts,
  only the first candidate's author changed — the cross-vendor arm loses 1.7pp. The two groups
  point in opposite directions and neither is significant. `select-mixed` was 50.8% and 49.2%
  in its two runs, which is the resolution of 120 questions: **±2pp**. Anything smaller than
  that cannot be claimed on this sample.

  The mechanism is in `sources`: a `deepseek-chat` candidate wins 95 of 120 cases, a
  `glm-4-flash` candidate wins 18. **A candidate's author decides how often it wins, and how
  often it wins decides how far the ceiling moves** — so the negative point estimate is a weak
  second model, not a property of heterogeneity. `glm-4.5` returns 429 from this account (two
  serial preflight calls, both 429), which is an external block on the question, not a design
  defect.

  To express the control at all, `bird-dev.yml` needed `second_provider`: it hard-coded
  `BIRD_SECOND_API_KEY` to `secrets.ZHIPU_API_KEY`, and Actions cannot index `secrets[name]`
  by an input, so "same vendor" was not expressible as an arm.

- **The ±2pp above was a coincidence, and the artifact can now compute the number it needs.**
  "`select-mixed` was 50.8% and 49.2% in its two runs, which is the resolution" is a resolution
  obtained by waiting for two runs of the same arm to differ; it is not a property of the design,
  it cannot be planned with, and it silently assumes the two runs are interchangeable. The
  paired difference's standard error is `sqrt(discordance / n)` — only the cases the arms
  disagree on carry information — so the resolution is `(1.96 + 0.8416)` standard errors at 80%
  power, and it can be computed from the same artifact:

  | second model | cases | discordant | delta (cross − mixed) | 95% CI | resolves (80%) | cases for 2pp |
  | --- | --- | --- | --- | --- | --- | --- |
  | `glm-4-flash` (cross-vendor) | 120 | 1 / 3 | −1.7pp | [−4.9, +1.6] | 4.7pp | 655 |
  | `deepseek-chat` (same vendor) | 120 | 1 / 4 | +2.5pp | [−1.2, +6.2] | 5.2pp | 818 |

  Both intervals include zero, both are 4.7–5.2pp wide, and **they overlap each other almost
  entirely** — so "the two groups point in opposite directions" was direction read into noise.
  The substantive finding is smaller and firmer: the cross-vendor candidate changes the answer on
  **3–4% of questions**, which is why 120 cases cannot settle it and why the 1,532-case dev split
  (≈1.5pp at this discordance) is the smallest split that can. Every comparison in the artifact
  now carries `ci`, `discordantShare`, `mde` and `casesForClaim`; the log's A/A line states what it
  could not see instead of printing "0.0pp" and letting that read as exact.

### Adopted

- **A floor may name any arm in the catalogue, not only an arm in the chain.** Recording
  `select-cross`'s dev floor failed `test/bird-arms.test.ts`, which required every floor to
  appear in `expectedArms` — that is, in the seven-arm default chain. `select-cross` is on
  demand because it needs a second model, so the invariant made the arm's own floor unrecordable:
  the same "one list applied to a configuration it does not describe" mistake that `armsBySplit`
  and `split`-scoped floors were added to stop. The check now resolves both `floors` and
  `armsBySplit` against `ARMS`, the catalogue, which is the set that actually defines what can be
  run.

- **Three prompt styles and a selector, four calls per question.** Two consecutive dev-split
  runs at p<0.01 (+1.7pp p=0.0095, +1.8pp p=0.0046 against `select`; +2.4pp p=0.0001 and
  +2.2pp p=0.0002 against the single sample) meet the ADR-184 bar, which no mechanism has
  met since diagnosed repair. The dev split now carries floors for the five arms it always
  runs (`names` 41.5, `inline+evidence` 60.5, `metadata+evidence` 61.0, `select` 60.9,
  `select-mixed` 62.5), so a regression fails the build instead of becoming a paragraph.
  The user guide's recipe replaces "three samples and a selector" with the three prompt
  styles that were actually measured.

### Added

- **A selection loss has an address.** `candidateRecall` says whether an arm's candidate set
  held an answer and `selectionLoss` counts the cases it did not return, and neither says
  *which* candidate was thrown away — which is the difference between "the selector rejected
  the second model's statement" and "it took a wrong statement while a right one sat beside
  it". The cross-vendor run lost 75 of its 1,018 ceiling cases and the artifact supported both
  readings, so the runner now writes `cases[].candidates` (each member with the judge's verdict)
  and `cases[].winnerSource`, and `pnpm bench:bird:losses --arm <arm>` reads them back: the
  selector's conversion rate per source — the 47%/87% asymmetry with its denominators printed —
  and every loss grouped by which sources held the answer and which one the arm returned.

  The record and the ceiling are one pass over one array (`candidateVerdicts` returns the
  verdicts, `candidateRecall` is `.some(correct)` of them), so a loss cannot be attributed to a
  member the ceiling never counted. The reader refuses three shapes rather than averaging them:
  an artifact written before the field existed (no record anywhere → stated absence, non-zero
  exit), a row whose recall is true while its record marks nothing correct (contradiction → fail),
  and a row that failed while its record marks the returned statement correct (same). A case
  whose two candidates both answered is kept as a set and neither source is priced alone.
  23 tests, and `eval/` is 30 of 30 files at 95% on all four dimensions.

- **A comparison can be stratified by the candidates it actually sent.** `eval/bird/strata.ts`
  (`pnpm bench:bird:strata --arm select-mixed --against select-cross`) joins an artifact's
  `mixedCandidatePrompts.degenerateIds` with its per-case outcomes and reports the paired delta,
  interval, p and resolution inside each stratum, using the same `pairedResolution` and
  `mcnemarExact` the runner uses. It reads an artifact and calls no model, which is why the
  question could be asked at all rather than answered by another 1,532-case run.

  It refuses the cases where a stratum would be a fiction: an artifact that counts duplicated
  prompts without listing them, a list that covers fewer ids than its own count, and an empty
  stratum are each reported as a stated absence rather than as a stratum of zero. A question
  scored twice for one arm is reported too — the artifact is a file this tool did not write, and
  last-wins would resolve an ambiguity into a number nobody can reproduce. It audits its
  own pooled row against the artifact's `ablations` entry and **throws** when the two readers
  disagree, because printing both for the reader to choose between is not a measurement.
  `isEntry` is a value rather than an inline guard for the same reason the other entries ended
  up that way: the first half of `argv[1] !== undefined && …` is permanently dark inside a test
  process. 29 tests, and `eval/` is 29 of 29 files at 95% on all four dimensions.

- **The job summary has a test, and it prints the resolution beside every delta.** The summary is
  the only part of a benchmark run a human reads, and until now no test touched it: every column in
  `tools/bird-summary.mjs` is a formatter, and a formatter that prints the wrong field looks exactly
  like a run that measured the wrong thing. The ablation table gained the interval on each delta and
  a `resolves` column (`5.2pp · 818 for 2pp`), the A/A sentence gained the difference the same cases
  could not have separated, and `node tools/bird-summary.mjs --self-test` renders three artifacts
  through the real CLI: one with the new columns, one written before they existed (which must show
  dashes rather than zeros), and one with no arms. The step is in the quality job and in `gate:all`,
  so the parity check covers it.

- **The preflight checks every endpoint the run will call, and `bird-dev` finally has one.** Run
  `40792849132` is the evidence: `bird-dev` was dispatched with `second_model=glm-4.5`, `names`
  finished at 43/120 in twenty-five seconds, and the cross arm then threw after three minutes with
  "120 of 360 candidates never arrived" — every single `@second` draw, from an endpoint that never
  answered. On the 1,534-question split that discovery costs forty minutes, which is the exact
  failure ADR-202 was written to prevent ("three timed calls instead of a 3h43m run"). The preflight
  only ever called the primary endpoint, and `bird-dev.yml` — the only workflow that can name a
  second model — was the only one with no preflight step, while carrying `BIRD_PREFLIGHT_SAMPLES: '2'`
  as though it had one. `resolvePreflightTargets` now returns every endpoint with the same URL
  fallback `createProviders` uses, `targetProblem` states which variable is missing on which target,
  and `main` names the target it is reporting (`preflight[primary]` / `preflight[second]`) and keeps
  going, so one failure does not erase the fact that the other endpoint answered.

- **The `@second` path is executed, not described.** `select-cross-judge` — the one arm whose result
  is unreadable without the name of the judge — had never been scored end to end; `createProviders`'s
  fallback to the primary URL (two keys against one gateway) had never run, because every test that
  configured a second model also gave it a URL; and `assertSecondModel`'s four missing-setting
  combinations had only one of them read, so its sentence "this arm needs a second model" could not
  say whether the model or the key was absent. All three are driven now against a real
  `http.Server`, and `judgeModelName(arms, second)` makes "who judged" a function whose `null` means
  "nobody but the primary model" rather than "no second model is configured".

- **The group standard under `eval/` is a gate now, not a printed line.** `check-eval-coverage`
  enforced the direction only: every file's four numbers are a ratchet, so a build failed when
  something got *worse*, never when the group as a whole was below the standard. A ratchet's floor
  is wherever the last commit left it — `eval/` was 49.5% of lines with every row honest — so the
  two readers answer different questions and both are needed. `groupProblems` fails the build
  while a dimension of `eval/` is under 95%, and refuses to read a group ratio whose denominator
  is zero (a run that covered no line is not a coverage figure, ADR-217). `--allow-regression`
  cannot record its way out of the floor: the sentence says so. Self-test: 18 → 23 checks, and
  the floor was proven to fire end-to-end on a summary whose group branch ratio was lowered.
- **`bird/retrieval.ts` is at 100% of branches, and two of its guards were deleted.** Six sites were
  uncovered and they split in two: `index.averageLength === 0 ? 1 :` and `index.idf.get(word) ?? 0`
  guarded a state the only caller cannot reach — `averageLength` is zero exactly when no document
  contributed a term, and then `idf` is empty, so `retrieve` filters every query word away and
  returns before scoring — and they are gone, with the invariant written down at the division. The
  other four are real inputs nobody had asked for: `retrieve` with no options (the defaults the
  pipeline runs with), two rows that score identically (the tiebreak by question is what keeps a
  block stable across a re-sorted training file), and both renderers handed a hit the caller
  assembled itself, which is what an arm asking for statements only produces. `ablate.ts` 93.9 →
  97.5 on the same pass, because `pnpm bench:ablate`'s default output directory was the one path
  every test bypassed by passing a temporary one.
- **Every branch under `eval/` is now reachable, and the suite says so.** Branch coverage sat at
  92.1% while lines and functions were already 99.3% and 100%: the missing branches were not
  untested, they were unreachable. Each one lived inside a template literal or behind a guard no
  fixture can produce, so no test could execute the other side. Each is a function of its inputs
  now — `ablationLines` (a negative delta and an empty id list are arguments), `missLine`
  (the engine sentence and its absence), `endsOf` (an empty arm chain), `semanticProblems` /
  `requireSemantic` / `equivalenceOf` / `fanoutRow` / `key`, `resolvePreflightSettings`, and
  `phrasing` / `uniqueById` in `eval/live/cases.ts`. Two fallbacks in `bird/failure-shape.ts`
  that no input can reach are gone rather than covered. Readings: **92.1% → 95.4% branches**,
  99.3% lines, 100% functions, and **21 → 25 of 28 files** meet 95% on all four dimensions. The
  three that remain short — `ablate.ts` 93.9, `bird/retrieval.ts` 91.3, `bird/run.ts` 91.0 — are
  in the ledger by name. Tests: 1,180 → 1,211.
- **`diagnose-corpus.ts` never wrote a diagnosis, and `recall.ts` measured a prompt nobody sends.**
  The last two entry points under `eval/` were also top-level scripts: `diagnose-corpus` printed a
  table and kept nothing, `recall` re-derived the linking hint beside `buildSqlPrompt` instead of
  asking the pipeline for the two messages it sends. Both are `resolve*Settings` +
  `measure*`/`run*` + a report function + a `main` now, they share the runner's own
  `resolveLayout`, and each writes an artifact (`diagnosis-<split>.json`, `recall-<split>.json`)
  whose keys can be diffed between runs. Readings: **diagnose-corpus 99.1 / 100 / 98.9**,
  **recall 99.4 / 100 / 99.0** (lines / functions / branches), from 53.2 / 75.0 / 58.8 and
  73.3 / 83.3 / 80.0. `eval/` overall: **96.8% → 99.3% lines**, **99.2% → 100% functions**,
  **92.1% → 93.4% branches**, and 15 → **17 of 28 files** meet 95% on all four dimensions.
  Verified against the real Mini-Dev cache, not only fixtures: `pnpm bench:bird:recall` still
  reports 500/500 questions and 3,820/3,820 identifiers visible.
- **A `--import tsx` child process runs both entries in a test.** The module guard cannot fire
  inside a test process — `process.argv[1]` is vitest there — so a guard nobody executes is a CLI
  nobody has run. Two tests spawn the entry exactly as the workflow does and assert the printed
  table and the artifact it leaves behind.
- **The last three harness entries are values too, and all three are above 95% on every
  dimension.** `eval/bird/stability.ts` (94 lines), `eval/live/run.ts` (206) and
  `eval/adversarial/run.ts` (280) were the remaining 505 lines of `eval/` at zero, each a top-level
  script that read `process.env` at import time, built its own engine or oracle, and threw where a
  caller wanted an exit code. They are now `resolve*Settings` (the environment as a parameter),
  `prepare*`/`run*` (the work as a function of those settings), a report function, and a `main`
  that owns nothing but the exit code. Readings: **stability 99.0 / 100 / 98.6**, **live 99.4 / 100
  / 99.1**, **adversarial 98.7 / 100 / 96.9** (lines / functions / branches). `eval/` overall went
  from **85.6% lines, 89.9% branches** to **96.8% lines, 92.1% branches**, and the number of files
  meeting the 95% standard on all four dimensions went from 9 to 15 of 28.
- **One BIRD-shaped dataset, written once.** `test/helpers/bird-dataset.ts` builds the four things
  every `eval/bird/` entry reads — a questions file, `dev_tables.json`, a description CSV and a
  real SQLite file — so the runner, the stability probe and the adversarial harness are driven
  against the same seven questions instead of three copies of them that can drift. The runner's
  38-case end-to-end test was refactored onto it and kept passing unchanged.
- **`pnpm bench:live -- --dry-run` and `pnpm bench:adversarial -- --dry-run`.** Both execute every
  gold statement, print how many ran, and call no model. `LIVE_LIMIT` runs a prefix of the
  generated cases, which is what CI uses to prove the path without spending 1,890 calls.

- **The BIRD runner is drivable, so its guards are testable.** `eval/bird/run.ts` was one
  1,124-line `main()` that read `process.env` at import time and exited through
  `process.exitCode`; nothing in it could be observed without spending a model run on the real
  benchmark, so schema fidelity, the gold controls, the failure-share refusal and the gate were
  all claims with no test behind them. It is now `resolveLayout` (paths as a value),
  `resolveSettings` (the environment as a parameter), `prepareRun` (dataset, schemas, blocks and
  controls), `runArm` (one arm over every case), `armReportRow`, `pairedComparisons`,
  `evaluateGate` (returns the problems; the caller decides the exit code) and `runBird`, with a
  `main` that is nine lines. `eval/bird/run.ts` is **99.2% lines / 100% functions / 90.9%
  branches**, from 31.4 / 78.8 / 90.8 — and the branch ratio *rose* even though the denominator
  it was taken over grew from 196 sites to 685 (ADR-216).
- **A BIRD-shaped dataset in a temporary directory, and a real endpoint.**
  `test/bird-run-e2e.test.ts` builds questions, `dev_tables.json`, a description CSV and a real
  SQLite file, serves the OpenAI chat shape from a loopback `http.Server`, and drives the same
  `main()` the workflow calls: 38 cases covering the dry run, two paired arms, an A/A duplicate,
  a sampling arm with an empty-result turn, a repair arm that succeeds and one that never lands,
  the pairwise selector, a decomposed candidate, a candidate set that lost exactly one member, a
  corrupt value cache, pinned and regenerated definitions, a semantics request that never
  answers, a gold that does not run, a table file advertising a column the database does not
  have, a gold that returns no rows, and an endpoint that is down for the selector, for every
  sample, or too slow to answer before the deadline. The oracle is the real Python process;
  nothing here is a mock.

- **The harness is measured now, and no file of it may fall behind.** `eval/` produced every
  published number and sat outside the coverage include, so its coverage could only go down
  unnoticed: 49.5% of lines. It is **64.0% lines / 93.6% functions / 88.5% branches** as of this
  entry, and the direction is enforced rather than hoped for. `vitest.eval.config.ts` derives the
  measurement from the main config (and replaces its coverage scope instead of merging into it —
  `mergeConfig` concatenates `include`, so the first version measured the packages too and
  reported a confident 81.5% about a set nobody meant to measure). `eval/coverage-ledger.json`
  records each of the 27 files' four numbers, and `tools/check-eval-coverage.mjs` fails the build
  if any of them measures lower, if a recorded file stops being measured, or if a file is
  measured without a ledger entry. The run prints the distance to 95% on every push, and eight
  files already meet it on all four dimensions. A threshold was the alternative and it would have
  been red for months, which is how thresholds become `|| true`.

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

- **`samples`: a column's stored spellings on its own card line.** `values` builds a block
  from the question's literals matched against the cells, so it is empty exactly when the
  question spells a value differently from the store; it was empty on 60.9% of the questions
  that offered it. The other half needs no match — `status TEXT [Banned|Active]` is in front of
  the model whether or not the question said "banned", at the price of prompt length rather
  than a call. The arm is `inline+evidence+samples`: one lever, one call, 113 columns and 597
  values across the dev split's eleven databases, and the sample prompt grows from 2,411 to
  4,230 characters. The values reach an arm through a decorator on the schema it resolved to,
  not a parallel map, so an arm can ask for samples and for inline definitions without one
  silently dropping the other.

### Fixed

- **A judge swap that loses ground is the result, not a regression.** `evaluateGate` fails a run
  whose last arm trails its first by more than 5pp — a sane rule for an arm that was a candidate
  for adoption, and exactly wrong for an arm built to price the judge: it refused to publish
  `select-cross-judge` at 54.7% against 60.7%, the one number the experiment existed to produce,
  after 57 minutes of evaluation. The rule now exempts a pair whose arms declare different judges,
  because that delta *is* the measurement; outages are caught by their own guards (failure share,
  candidate survival, an arm that produced no results), so the exemption cannot hide a dead
  endpoint. Two `evaluateGate` cases hold it: the swap passes, and the same 6pp gap between two
  arms that share a judge still fails.

- **A candidate the engine refused was dropped in silence.** The sampling loop read
  `const executed = await oracle.run(...); if (executed.ok) candidates.push(...)` with no
  `else`: a statement the read-only oracle refused (a write, a missing table, a timeout)
  vanished from the set, the case still answered, the ceiling fell, and `candidateFailures` —
  whose own comment promises a split between "the model refused" and "the engine refused" —
  stayed at zero. That is the defect `assertCandidateSurvival` was written for, one layer down
  from where it was looking. Found by a test that makes one source of a mixed set answer with
  `delete from items`: the arm now reports `{ llm: 0, other: 1, attempted: 21 }`, and the
  candidate record shows the two that survived rather than three that look like the whole set.
  45 tests in the end-to-end file, and `eval/bird/run.ts` is back to **95.2%** branches with
  all 30 files at 95% on all four dimensions.

- **The coverage gate names the file that is short, and whether its suite needed a service.**
  `FAIL node st=85.83 br=87.50` was read as "coverage fell" on two consecutive rounds; it meant
  "PostgreSQL and MariaDB were not running on this machine", because `mysql.test.ts` and
  `postgres.test.ts` are `describe.skipIf(url === undefined)` and a skipped suite subtracts its
  lines without touching the denominator. With the services up the same tree measures
  **99.18 / 97.13 / 100 / 99.18**. The gate printed one aggregate line per package and nothing
  else, so the two readings were indistinguishable — a gate that does not name its failure point
  manufactures misdiagnosis, and a misdiagnosis costs more than a red build.

  The gate now prints, under a failing package, each short file worst-first with its four
  numbers; it carries a declared table of files whose suite is gated on a variable
  (`ENV_GATED`), and when that variable is unset it says which one. The closing line states
  which of the two causes it is: *"2 short file(s) belong to suites gated on an unset variable"*
  or *"no short file belongs to an environment-gated suite, so this is missing tests"*. A zero
  denominator is now **n/a** and a problem rather than 100% (ADR-217 at the package level). The
  declaration cannot rot: `--self-test` fails if a listed file no longer exists, and it plants
  the exact tree that caused the misdiagnosis — gated file, unset variable — plus the same tree
  with the variable set, a renamed gated file, an unmeasured package, an empty summary and a
  capped offender list. The self-test is in the quality job and in `gate:all`, so parity covers
  it (19 commands).

- **The sampler did equal allocation and its comment claimed proportional — so every subset
  accuracy described a harder split.** `stratifiedSample` walked the difficulty buckets
  round-robin, one case per round, under a docstring promising that "a limit of 200 therefore
  keeps the difficulty mix". A 120-question dev run was therefore 40/40/40 against a split that
  is 925/464/145 (60.3 / 30.2 / 9.5): the challenging bucket over-weighted 3.5×. Reweighting the
  per-difficulty counts the artifact already carries moves `select-mixed` from **49.2% to
  52.2%**, which is the size of the bias. Paired deltas survive (both arms saw the same cases);
  absolute accuracy does not. Quotas are proportional now (largest remainder), a 120-question
  sample is **73/36/11**, and `selection.mix` prints the sample's counts next to the split's so
  an old reading can be reweighted rather than merely trusted.

- **Fixing that exposed a larger bias: the sampler took the head of the file.** Each bucket was
  consumed in ascending question id, and BIRD's dev file is grouped by database, so a subset was
  a prefix of the split. The 120-question runs scored **2 of 11 databases**, `california_schools`
  at **74.2%** of the sample against **5.8%** of the split — which is most of the gap between
  49.2% on 120 questions and 63.0% on the full split. The order is now `mix32(question_id)`, the
  murmur3 finalizer: deterministic, uncorrelated with the id, and a 120-question dev sample
  covers **11 of 11 databases** within 2.1pp of their shares. FNV-1a was tried first and rejected
  — consecutive ids keep neighbouring hashes, which put 45 of 73 simple picks in one database.
  `selection.databases` now lists the databases that were *scored* (it repeated the ones that
  were requested), `availableDatabases` lists the split's, and the summary prints `covers 11 of
  11 databases` or `covers 2 of 11 databases, and a sample that skips one is not an estimate of
  the split`.

- **`eval/` no longer carries a fallback that no arm can reach.** `arm.vote ?? 1` appeared twice — in
  the summary line's `recall@` column and in the attempted-call count — and both sat inside a branch
  guarded by `arm.vote` being defined, so neither `1` could ever be returned. The column is built by
  `ceilingColumn(vote, ceiling)`, which takes a number, and the branch is gone from the ledger
  instead of being counted against it (ADR-219).

- **`ablate.ts` printed its own footer twice.** `ablationLines` ends with the arm count and the
  path it wrote, and the caller then logged the same sentence again, so one run read as two. The
  formatter is the only thing that prints now, and a test counts the occurrences.
- **`diagnose-corpus.ts` divided its shares by the failures it could grade.** Three bare
  `continue`s erased a failure whose question id was not in the questions file, one whose
  prediction was empty, and one whose *gold* statement the engine refused — and every share in
  the table was then computed over the survivors. A run with a broken gold would have published a
  confident shape distribution over the handful of cases that happened to run. The drops are
  counted by reason, printed under the table, and written into the artifact (ADR-216 at a second
  site). The gold was also fetched and the literals extracted twice per failure, and the whole
  entry read `BIRD_SPLIT` at import time, so one process could not diagnose two splits.
- **`recall.ts` threw before it wrote, and skipped the databases it could not describe.** The gate
  raised after the console lines, so a failing run left the previous green `recall-<split>.json`
  in place — a file that said 100% about a split nobody had just measured. The artifact is written
  first and carries `passed` and `problems`; the entry throws afterwards. Questions whose `db_id`
  is missing from `dev_tables.json` were dropped by a `continue`, shrinking the denominator of the
  completeness rate in silence; they are counted per database and named on the first line. A split
  where nothing was measured used to fail with "0 of 0 prompts hide at least one identifier",
  which is a true statement about no measurement at all — it now says so.
- **`recall.ts` rendered its own prompt.** It called `buildSqlPrompt` and appended a `Likely
  columns:` line, while the pipeline appends that hint to the *user* message and words it
  `No column matched; use the schema above.` when the linker finds nothing. For a question with no
  linked column the ceiling was measured on a prompt that is never sent, and any future change to
  `buildAskMessages` would have left the gate green about a prompt nobody sends. It calls
  `buildAskMessages` now. The `BIRD_LIMIT` sample bound counted measured rows rather than examined
  questions, so a split with three undescribed databases examined `limit + 3`; and the entry
  guard was `argv[1].endsWith('recall.ts')`, which a file called `notrecall.ts` also satisfies.
- **A fallback that no input can reach sat in the middle of both entries.** `report.failures ?? {}`,
  `outcome.cap ?? '?'` and a second lookup of an alias that had just been resolved from the same
  map were unreachable branches: no test could cover them and no run could take them. The failures
  record is a validated type now, `cap` and `truncated` travel as one `sample`, the alias table
  holds the table rather than its name, and the example collector is a named rule
  (`noteExample`) instead of a compound condition inside the loop.
- **`oracle.ts` dropped the two fields that make an engine error legible.** `oracle.py` sends
  `errorName` and `errorCode` — with a comment explaining that without the name a repair has to
  guess the failure class from prose — `OracleResult` declares both, and `eval/bird/run.ts` turns
  the name into `details.engineError.code` for the repair turn. The decoder never copied them, so
  the code was always `undefined` and the branch that reads it was dead in production. A test now
  asserts `SQLITE_ERROR` survives the round trip, and that a failure raised by this client rather
  than by SQLite carries no code at all.
- **`profile.ts` could be made to write into the repository.** The cache directory was an optional
  argument defaulted inside the function, and `eval/adversarial/run.ts` omitted it — so the
  adversarial harness read and wrote the repository's profile cache, which is exactly the sharing
  the comment above the option said it prevented. The argument is required now, which makes the
  property a type error instead of a comment. Four more branches in the same file guarded outcomes
  SQLite cannot produce (`count()` returning NULL, `min()` of a counted column being NULL,
  `pragma_table_info` reporting a NULL type, a capture group that did not participate); they are
  gone, and the file reads **100% on all four dimensions** where it read 86.3% of a denominator
  that changed with the tests that ran.
- **`stability.ts` reported an arm it had not measured.** `BIRD_STABILITY_ARM` fell back to
  `ARMS[2]` when the name did not resolve, so a typo produced a complete artifact labelled
  `metadata+evidence` while the operator believed they had measured something else; the lookup is
  now an error that lists the arms that exist. The same probe conflated a call that never reached
  the model with an answer that was wrong, which made an endpoint outage look like model noise:
  `outages` and `engineFailures` are counted separately, and a statement the engine refused is
  scored rather than lost. The artifact also hard-coded `bird-mini-dev` as its dataset whatever
  split it ran on.
- **`live/run.ts` compared an empty result against `undefined`.** The negative control read
  `cases[0]` through an `as string` cast, so a run with no cases compared against nothing and
  passed. It is an error now. The "N cases, N gold queries executed" line printed the case count
  twice, the gates were exceptions thrown after the artifact was written, and the per-intent
  breakdown existed only as console output — it is in the artifact, which is where a reader looks
  for it a week later.
- **`adversarial/run.ts` published the metadata lever with the definitions arm's numbers.** The
  headline ablation and the per-category table both read `outcomes.get(ARMS[1])` — the
  `definitions` arm — and labelled it `names -> metadata`, so the number the docs quote for the
  metadata lever belonged to a different arm. Both now look the arm up by name, and a missing one
  is an error rather than a silently empty pairing. The inline arm's definitions were also
  synthesized by the model *before* the gold statements ran, which spent a call per database on a
  case set that might not run; gold comes first.
- **The eval ratchet recorded 100% for files it had never executed.** v8 reports a function and
  branch ratio of 100% for a module it never entered, because the denominator is zero and 0/0 is
  rendered as perfection: `eval/adversarial/run.ts` sat in the ledger as `lines 0.0, branches
  100.0`, and the first honest measurement of it read as a regression from a promise nobody had
  made. The ledger now records zero in all four dimensions for a file that executed nothing, and a
  recorded row that cannot describe a measurement is replaced by the first one that can. The
  recorder also used a strict comparison while the check used a 0.2pp tolerance, so a hundredth of
  a point of jitter refused to write a run at all.

- **A definition block that failed to generate left no trace in the artifact.**
  `synthesizedDefinitions` recorded the empty string and `definitionsProvenance` recorded
  nothing, so a database whose semantics request was refused was indistinguishable in the report
  from a database whose arm never needed definitions — and the arm then read as its parent with a
  longer prompt. The failure is now a provenance state (`failed: <message>`), which is what the
  report already promised when it said which databases were written in this run and which came
  from cache.
- **An A/A duplicate was labelled with the arm it resolved to, not the name it was asked for.**
  Both rows said `names`, and the uniqueness guard refused the run — correctly, since two rows
  with one label let a duplicate stand in for the arm it duplicates. The row and the printed line
  now carry the requested name, so `names#2` keeps its own row and the pair compares two runs.

- **Six measurement scripts could only be observed through `process.exit`.** `preflight`,
  `run`, `ablate`, `linking-ablation`, `semantic-ablation` and `profile` were top-level scripts
  whose result was a log line and an exit code, so the properties they exist to establish could
  only be read off a job. Each is a function returning a report, with a `main` that prints and
  returns a code, and each is now exercised against real inputs: a local HTTP endpoint for the
  preflight (healthy, one refusal, too slow for the deadline, unreachable, empty reply), real
  DuckDB for the harness and both ablations, a real SQLite file for the profile. Three defects
  fell out of the conversion:
  - `pnpm bench:ablate` **failed with ENOENT on a clean checkout**, because it read
    `eval/out/results.json` — a file the *other* script writes — for one log line.
  - A predictor that emitted SQL the engine refuses **would have crashed the run** instead of
    scoring a zero: the `catch` in `runPredictor` was unreachable by construction, since no
    predictor here emits invalid SQL. It is `evaluateCase` now, and a test drives it with a
    statement the engine rejects.
  - `runHarness` checked its controls through two `?.` chains whose failure paths were
    unreachable and whose messages were duplicated in `ablate`; both callers now share
    `assertControls`, which is tested against a summary that scores the oracle at 95%.
- **The pairing rule was right and untested.** `compareArms` — the normalization comparison,
  now separable from the measurement — already skipped a case that only one arm ran, which is
  the correct rule: a skipped case is neither a win nor a loss, and counting it as either turns
  a sample difference into a capability difference. The rule now has a test that pins it, and
  the two non-degenerate conclusions (significant at 5%, direction observed but not significant)
  have tests for the first time; on the current golden set the arms agree on all twenty cases,
  so those branches had never executed.
- **A run that declared its sample was failed for its sample.** `bird-model.yml` scored 298 of
  Mini-Dev's 500 questions — a 300-question slice, the declared subject of the run — and the
  artifact recorded `requested: 300` beside `available: 500`. The gate compared `scored` against
  the split's size, ignored the declaration, and failed the run with "the sample changed": a red
  build about the sample the run declared, on the one run whose numbers were the reason it
  existed. The rule is now the one the arm list already followed. A declaration is read, and a
  request for fewer questions than the split holds is a **measurement on a declared subset**:
  the floors, taken on the full sample, are switched off in both directions — a subset can
  neither fail a floor (298 questions carry twice the noise) nor clear one (a green check on a
  fifth of the sample is what a SOTA claim is made of). What remains is arithmetic a declaration
  cannot excuse: `requested > available`, `scored > requested`, a non-numeric request, and a
  sample that shrank with no declaration at all are each fatal. Six self-test cases cover the
  six rows of that table, and the job summary now prints *declared subset — no accuracy floor
  applies* beside the number so a reader who meets `298/500` does not have to reconstruct which
  kind of run it was.
- **The coverage gate had a silent boundary, and `eval/` was outside it.** `coverage-gate.mjs`
  buckets by `packages/<name>/` and skips every other path without a word, so the harness every
  published number comes out of was never measured. Asked directly it is **49.5% lines, 86.6%
  functions, 87.1% branches** — the gaps are the run entrypoints, which need a dataset and an
  endpoint. `test/coverage-scope.test.ts` now draws the boundary: every source file in the
  repository is either inside the include globs declared in `vitest.config.ts` or listed as
  unmeasured with a reason and the task that will bring it inside, and a stale declaration (a
  root that moved, a file that became measured) fails as loudly as a new unmeasured directory.
  Verified by adding `scripts/probe.ts` and watching the test refuse it.
- **Two instruments rendered a prompt nobody sends.** The arms render the schema card at 400
  lines with descriptions and join hints; the coverage control rendered at 2,000, so a
  truncation could never appear in it; and `bench:bird:recall` — the check that exists to catch
  a column the model was never shown — rendered at the default 40 lines from a schema built
  without notes. All three were green. The shape now lives in `eval/bird/prompt-shape.ts` and a
  test refuses a numeric limit at either call site. Measured again after the fix on all 1,534
  dev questions: 10,650 of 10,650 gold identifiers visible, and a stricter check that matches
  each reference inside its own table's block agrees at 7,672 of 7,672.
- **A card that dropped tables was reported and never refused.** `controls.tablesInPrompts`
  carried the comment "a truncated schema card silently drops tables, and a model cannot query
  what it was never shown" and nothing acted on it: the count was printed, and the gate read
  every lever except the one whose absence no rewording can recover. Any database whose card is
  shorter than its schema now fails the build, naming the database and the loss; so does a
  prompt with no table in it at all.
- **The dry run previewed arms that were not requested.** It rendered `ARMS[0]` and `ARMS[1]`
  whatever `BIRD_ARMS` said, so the dry run of a new lever put two unrelated prompts in the
  artifact and left the lever unverified — and wrote the second one under `definitionsPrompt`,
  after whichever arm happened to sit at that index, where nothing read it. The preview now
  renders the arms the run was asked to score, with their sizes.

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

- **`samples`: the mechanism fires, the gain does not clear the bar.** Two dev runs, 1,532
  questions each, one lever, one call: 948 against 939 (**+0.59pp**, 57/48 discordant,
  p=0.44) and 954 against 934 (**+1.31pp**, 58/38, p=0.052). The control confirms 118 columns
  and 628 values reach the card, and the error class the lever targets moves down in both
  rounds (`errors.values` 444→429, 436→431) — the mechanism is doing what it says. Pooled,
  the best estimate is **+0.95pp at p=0.048** on 201 discordant pairs, against +22.6% prompt
  characters. Not adopted as a default (ADR-184 wants two runs at p<0.01); kept as an
  ablation reference, with the gate still refusing an arm that asks for samples and attaches
  none. **What this leaves**: with a thinking model at p=1.00 and every stored spelling
  visible at +0.95pp, no lever this harness currently holds moves 58% toward 70–73%.
- **A stronger model at the same prompt is the same measurement.** `deepseek-reasoner` on 298
  of Mini-Dev's 500 questions, one arm, plus the arm repeated as its own control: 155 (52.0%)
  and 158 (53.0%). Paired against `deepseek-chat` on the same 296 questions — same pinned
  inputs, same 400-line cards, same prompt — chat scores 153 and reasoner scores 153:
  **32 disagreements in each direction, McNemar exact p = 1.00**. With 64 discordant pairs the
  test resolves about ±5.3pp at 95%, so this is a measured zero rather than an underpowered
  run; the in-run A/A moved 1.0pp (12 of 15, p=0.70). The conclusion is narrow and it closes a
  family: at this prompt, model reasoning depth is not the lever. What is left is what the
  prompt shows (`inline+evidence+samples`, unmeasured) and what writes the candidate (I-36).
- **The ceiling moved again and the accuracy did not, so the bound is now arithmetic.** A fourth
  generator (`select-mixed+dc`) raised candidate recall from 66.0% to **68.4%** — 37 questions
  the three prompts could not write — and scored 960 against 964, p=0.72, at one extra call per
  question. Conversion fell from 95.4% to 91.6%. With two runs saying the same thing, the useful
  statement is a bound rather than a delta: a **perfect** selector over these candidate sets
  scores 66.0% on three and 68.4% on four, while the published dev leaderboard sits at 70-73%.
  No selector reaches it from here; the remaining gap is in what the generator can write.
- **`select-dc` second reading**: 949 (62.0%) against 964 (62.9%), p=0.09, ceiling 66.9% against
  66.0%. The first run put the same arm at −2.0pp; the direction holds and the size does not, and
  the ceiling gain shrank from +1.4pp to +0.9pp. Not adopted.
- **The empty-result turn, measured twice**: +0.59pp (p=0.19) then +0.46pp (p=0.37), same
  direction, neither clearing a 1% bar. The mechanism is exact (73 zero-row candidates dropped
  for free, 61 retries, 30 came back with something); the effect is smaller than 1,532 questions
  can resolve. The run-to-run drift of an unchanged arm in the same pair of reports — 971 then
  964, ceiling 65.6% then 66.0% — is the scale that "+7" has to be read against.

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
