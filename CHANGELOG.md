# Changelog

The eight packages share one version. Each entry records what changed and what was
measured, because a release note that only lists features is a release note that
cannot be argued with.

## Unreleased

### Measured

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
