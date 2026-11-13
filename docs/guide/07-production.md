# Production checklist

## Security

- [ ] **The database user is read-only.** The guard is a lexical filter, not a
      sandbox. `READ_ONLY` on the DuckDB instance and a read-only role on
      PostgreSQL are the actual boundary.
- [ ] **File-reading functions are banned at the policy level**, not only by the
      default list. If you add a function to `bannedFunctions`, add a test for it
      in `packages/core/test/guard.test.ts`.
- [ ] **LLM keys never reach the browser.** `ai.baseUrl` points at your proxy.
- [ ] **Prompt injection is assumed.** A schema comment or a value can contain
      instructions. The guard is the mitigation that does not depend on the
      model behaving.
- [ ] **Log provenance.** `result.provenance.path` tells you whether a human or
      a model wrote the SQL.

## Resource limits

```ts
const runner = createRunner({
  engine,
  maxRows: 5_000,
  timeoutMs: 10_000,
  onSpan: (span) => exporter(span),
});
```

- `maxRows` caps rows, not bytes. A query returning five wide JSON columns can
  still be large; cap at the connector if that matters.
- `timeoutMs` aborts the caller even if the driver keeps running. Pair it with a
  server-side statement timeout so the database stops too.
- Streaming enforces the cap across batches.

## Observability

`onSpan` receives one event per execution:

```ts
{
  name: 'execute',
  traceId: 'trace-000001',
  spanId: 'span-execute',
  startMs, endMs,
  status: 'ok' | 'error',
  attrs: {
    'nl2charts.engine': 'duckdb-native',
    'nl2charts.sql.length': 74,
    'nl2charts.rows': 4,
    'nl2charts.truncated': false,
    'nl2charts.path': 'sql',
  },
}
```

A throwing exporter cannot break a query: the call is wrapped. Attribute names
use the `nl2charts.` prefix; mapping them to OpenTelemetry is the host's job, so
the library does not depend on an observability SDK.

## MCP server

```ts
import { attachStreams, createMcpServer } from '@agentix-e/nl2charts-mcp';

const server = createMcpServer({ runner, name: 'warehouse', version: '1.0.0' });
await attachStreams(server, process.stdin, (chunk) => process.stdout.write(chunk));
```

Four tools are exposed:

| Tool | Input | Returns |
| --- | --- | --- |
| `run_sql` | `{ sql }` | rows, or a guard rejection |
| `engine_info` | `{}` | engine id, dialect, row cap |
| `query_metric` | `{ model, query }` | compiled SQL and rows |
| `explain_metric` | `{ model, query, optimize? }` | SQL before and after optimization, both plans |

`query_metric` is the one to give an agent. `run_sql` asks the caller to write the
statement, and a caller that does not know what `revenue` means writes the wrong
one — the failure this project exists to measure. `query_metric` takes a semantic
model once and then only names metrics and dimensions:

```json
{
  "name": "query_metric",
  "arguments": {
    "model": { "name": "shop", "tables": [], "metrics": [] },
    "query": { "metrics": ["revenue"], "dimensions": ["region"] }
  }
}
```

`explain_metric` compiles the same query and returns the plan without executing
it, so an agent can inspect what it is about to ask for. `stages` names the four
pipeline steps — plan, optimize, lower, render — and `plan` / `optimizedPlan` are
returned side by side so the rewrite is visible rather than asserted.

A client's `limit` is a request, not a permission: it is clamped to the runner's
row cap, so a server configured for 1,000 rows cannot be asked for 5,000.

A guard rejection or a semantic error is a tool error (`-32000`) with the contract
code in the message — `NL2C_E_UNKNOWN_METRIC` can be branched on, prose cannot.
Neither is a transport crash.

## Reading a trace

A trace is the story of one query: which stage ran, for how long, what came out.
It is also the artefact people cite when they argue about a number, so the library
lets you seal one and check it later.

```ts
import { sealTrace, verifyTrace, replayTrace } from '@agentix-e/nl2charts-studio';

const sealed = sealTrace([
  { name: 'guard', startMs: 0, endMs: 2 },
  { name: 'compile', startMs: 2, endMs: 9 },
  { name: 'execute', startMs: 9, endMs: 41, attrs: { 'nl2charts.rows': 239 } },
]);

verifyTrace(sealed);      // { ok: true, count: 3 }
replayTrace(sealed);      // { ok: true, durationMs: 41, slowest: { name: 'execute', … }, errors: [] }
```

Each event is hashed together with the previous event's hash, and replay refuses a
chain that does not reach its head:

| Edit | Verdict |
| --- | --- |
| change one `endMs` | `{ ok: false, brokenAt: 1, reason: 'hash' }` |
| drop an event | `{ ok: false, reason: 'head' }` |
| point `prev` elsewhere | `{ ok: false, brokenAt: 1, reason: 'link' }` |

Hashing uses canonical JSON — keys sorted, `undefined` dropped — so an event that
went through `JSON.stringify` and back still verifies. It is FNV-1a, not a
cryptographic hash: this detects an edit, it does not stop a determined forger, and
the guide says FNV-1a rather than "hash" because the difference matters.

`replayTrace` reads no clock. The same sealed trace replays to the same summary,
which is what makes it quotable.

Two views render that summary without a DOM — paste them into an incident review:

```ts
import { renderTraceSvg, renderIssueListText } from '@agentix-e/nl2charts-studio';

const svg = renderTraceSvg(replay);          // one bar per stage, width ∝ duration
const text = renderIssueListText(issues);    // errors first, summary last
```

The timeline marks a failed stage with `data-status="error"` and prints its code, so
"where did the time go" and "what broke" answer the same glance. A trace that does
not verify renders as that sentence rather than as an empty axis — an empty
timeline would be a claim, and the claim is exactly what failed.

## Choosing among candidates

One sample per question is the default and the cheapest. If you can pay four calls, the
measured recipe is **three different prompts and a selector**, not three samples of one
prompt:

| approach | calls | accuracy on the dev split (1,532 questions, two runs) |
| --- | --- | --- |
| one sample | 1 | 60.6% |
| three samples of one prompt + selector | 4 | 61.1% (no better than one sample: p=0.28 and 0.65) |
| two prompt styles + selector | 3 | 61.7% |
| **three prompt styles + selector** | 4 | **62.9%** (+2.2pp over the single sample, p=0.0002) |

The three styles are the ones whose combination was measured: the dataset's per-question
hint attached to the columns, curated column notes, and literal values resolved against the
database. Same selector, same model, same four calls — only where the candidates come from
changes.

```ts
import { chooseCandidate, createPipeline, createHttpProvider } from '@agentix-e/nl2charts-ai';

const provider = createHttpProvider({ baseUrl, apiKey, model });
const styles = [
  { definitions: inlineGlossary, evidence: hint },              // definitions on the column line
  { notes: true, evidence: hint },                              // curated column notes
  { definitions: inlineGlossary, evidence: hint, values: literals }, // plus resolved literals
];

const candidates = [];
for (const prompt of styles) {
  const pipeline = createPipeline({ provider, prompt });
  const { sql } = await pipeline.ask({ question, schema });
  const result = await run(sql);               // your engine, read-only
  if (result.ok) candidates.push({ sql, rows: result.rows });
}

const { sql, decided } = await chooseCandidate(provider, question, candidates);
```

Four things worth knowing before you turn it on:

- **It costs four calls**, and on a split of 1,532 questions that is worth +2.2 to +2.4pp
  with p≤0.0002 in two consecutive runs. On 498 questions the same effect was only
  p≈0.02, which is why the smaller split could not settle it.
- **Same-prompt sampling is not a substitute.** Three samples at temperature 0.7 agree
  90% of the time and add nothing measured at 1,532 questions. Diversity of *prompt* is
  what moves the number.
- **`decided: false` is not an error.** It means the reply carried no usable index; the
  chosen candidate is then the first one, which is what a single call would have returned.
  Log the rate — a selector that stops answering is a prompt regression, not a model
  regression.
- **The selector still leaves 2.6pp on the table**: its candidate set contains a correct
  statement 65.6% of the time and it returns 62.9%. That gap is the honest description of
  what this mechanism has not yet solved.

### When a paid selector cannot pay for itself

A candidate pool splits into two populations, and only one of them contains a decision. Group the
executed candidates by the judge's own equality — same rows, same answer — and on Mini-Dev at
temperature 0.7, **350 of 479 three-candidate questions returned one result**. On those questions the
model selector, the `shortest` rule and the `modal` rule score **70.57%, the same number to the
case**, because the result is the answer and the statement is not. A fourth call there is not cheap;
it has nothing to decide.

The 27% that disagree are the only population a paid selector can change, and there the pool's
ceiling is 62.02% while the best chooser reaches 44.19% — which is where the remaining 4.8 points of
overall score live, and also where every cheap trick has failed: the text-level rules (fewest joins,
fewest predicates, literal grounding, group-by matching) all land within one point of `shortest`.

The chooser that wins on that population is not stable between artifacts: `shortest` reaches 44.19%
on one pool and 31.11% on the next, the model selector 35.66% and 34.27%. Read that as the honest
state of the art here rather than as an ordering — 130-odd disagreeing questions cannot rank two
choosers, and the ordering flips. What is stable is that **no chooser currently gets close to the
62% the pool contains**, and that is the reserve the next mechanism has to reach.

Run `43421692582` (five arms in one dispatch, A/A −0.81pp at a resolution of 3.20pp) prices the
configurations rather than arguing about them:

| configuration | calls / question | accuracy | tokens per correct answer |
| --- | --- | --- | --- |
| three candidates + `shortest` (`aimed-3`) | **3.00** | 59.07% | **5,283** |
| three candidates, judge called only on a disagreeing pool | 3.30 | 59.48% | 5,499 |
| three candidates, judge called on every question (`aimed-4`) | 3.99 | 60.08% | 5,939 |

**No accuracy difference in that table survives the split's own resolution.** What survives is cost:
`aimed-3` is 25% fewer calls and 11% fewer tokens per correct answer than `aimed-4`. That is why it
is the default, and the reason is worth stating precisely — not "the rule is better", but **"the
split cannot tell them apart, and one of them is a quarter cheaper"**.

If you want to keep a model in the loop, spend it where a decision exists: group the executed
candidates by result before adjudicating, and skip the call when there is one group. In the harness
that policy is `Arm.gate: 'results'`; it removes 17% of the calls with accuracy inside a one-point
invariance, and it reports both counts (`selectorRule.decided`, `spend.asked`) so the saving is
attributable rather than inferred.

### If you will not pay the fourth call

**This is the shipped default.** `aimed-3` is three candidates and the free rule; `aimed-4` is the
same three candidates and the paid selector. The reading below is why the fourth call was retired
from the default — and the arm that runs it end to end is `select-mixed-rule`, whose artifact makes
the rule's score checkable against the candidates it read.

```ts
import { STRATEGIES, strategy } from '@agentix-e/nl2charts-ai';

strategy('aimed-3');  // { calls: 3, candidates: 3, selector: 'shortest', temperature: 0.7, ... }
strategy('aimed-4');  // { calls: 4, candidates: 3, selector: 'model',    temperature: 0.7, ... }
```

Pin one or the other; both are values, so the choice can be diffed, rolled back and put in a
baseline. The rest of this section is the measurement behind the default.

The selector is one generation a case, and on this repository's dev split it returns
what the candidates already imply. Read from the artifact of `41767687844` (1,532
questions, three prompts), a rule that costs nothing scores at least as much:

| way of choosing | calls | dev split | strong-600 |
| --- | --- | --- | --- |
| the first candidate | 0 | 61.88% | 62.17% |
| the shortest statement | 0 | **63.64%** | **65.17%** |
| the result most candidates returned | 0 | 62.40% | 63.33% |
| the model selector | 1 | 62.79% | 62.00% |

The second column is the 1,532-question split; the third is `select-balanced` on 600
questions, whose candidates come from two reasoning slots and are worth more. On that
pool the shortest statement beats the selector by **+3.17pp at p = 0.0163** — the one
comparison in this repository where a free rule wins by more than the split resolves.

```ts
import { chooseCandidateByRule } from '@agentix-e/nl2charts-ai';

// `first` | `shortest` | `modal` — no provider, no call, never undecided.
const { sql, index } = chooseCandidateByRule('shortest', candidates);
```

- **`first`** is what a pipeline with no selector already returns, written down so that
  "we did not choose" can be compared instead of assumed.
- **`shortest`** is the rule every reader believes they are using. Leading and trailing
  whitespace is ignored, and a blank statement ranks last: an empty string is shorter
  than every real statement, and a candidate that wrote nothing is not the minimal answer.
- **`modal`** keeps the result set most candidates returned, and it is the only rule that
  reads the rows rather than the text. Two different statements that produced one table
  are one opinion, which is what makes the rule stronger than it looks — and also what
  makes it fragile on a corpus where every candidate is wrong in the same way.

**All three skip a candidate that returned no rows**, and that is worth more than the choice
of rule. 586 empty results across four arms were all wrong: a result with no rows equals
another empty result and nothing else, so an empty candidate can only be right when the true
answer is empty. If every candidate is empty the rules fall back to the whole set, so a
question whose answer really is empty is unaffected. Nothing else about a result is used —
reading the shape out of the question ("how many" ⇒ one number) was tested against 146
rejected candidates and agreed with the truth 61% of the time, which is worse than not
looking.

Two things the table above does not say. The difference between the selector and the
shortest statement is **0.85pp on the 1,532-question split and 3.17pp on the strong 600** —
the first is under the 2.30pp the split resolves, the second is not. And a rule cannot report
`decided: false`: it always answers, which means a corpus whose candidates are all bad gets a
confident wrong answer instead of a visible regression. Log which rule ran and what it picked;
the selector's `decided` flag was doing that job for you.

## Repairing a rejected statement

The pipeline retries a statement the guard or the engine refused, and **three** times by
default. Each retry is not "try again": it carries a diagnosis built from what the engine
and the schema actually contain.

```ts
const pipeline = createPipeline({
  provider,
  maxRepairs: 3,                                  // default
  execute: async (sql) => { await engine.run(sql); },  // gate for execution errors
  prompt: { dialect: 'PostgreSQL' },
});
```

Returning a row count from `execute` also enables the empty-result turn, which is
budgeted separately (`emptyRetry`) because a statement the engine refused and a statement
the question refused are different failures. It costs a call only where it fires, and it
reports `{ fired, recovered }` so the cost can be divided by what it bought:

```ts
const pipeline = createPipeline({
  provider,
  maxRepairs: 3,
  emptyRetry: 'diagnosed',
  execute: async (sql) => ({ rows: (await engine.run(sql)).rowCount }),
});
```

See [the natural-language guide](./05-natural-language.md#when-the-statement-runs-and-returns-nothing)
for what the turn says and why the `blind` control exists.

### When the empty result is a lookup, not a guess

The diagnosed turn names three causes and leaves the model to find which applies. If your
deployment can afford one query per literal — and it can, because the turn only happens on cases
where every candidate returned nothing — look the literals up first and quote what the columns
hold. That is the difference between a second opinion and evidence:

```ts
import { probeValueGaps } from '../eval/bird/value-probe.js';   // harness-side, not shipped

const probe = await probeValueGaps(statement, columns, async (sql) => {
  const result = await engine.run(sql);
  return result.ok ? result.rows : undefined;    // a refused lookup is not evidence
});

// 1. A case-only difference is settled here, for no call at all.
if (probe.grounded !== undefined) statement = probe.grounded;

// 2. Everything else is quoted back to the model in one turn.
messages.push(...emptyRetryMessages('values', statement, statement, probe.gaps));
```

`probeValueGaps` lives in the benchmark harness rather than in a package because it needs the
engine and the schema card together; the parts that belong to the library are the message
(`buildValueGapFeedback`) and the rendering rule that keeps it inside the same 900-character budget
every other feedback turn lives under. Two properties are worth keeping if you port it:

1. **No fuzzy matching.** The only values reported are ones the database returned. A repair that
   guesses turns an empty answer into a plausible wrong one, and the empty one is visibly empty.
2. **Ambiguity is not resolved by guessing.** Two columns storing two spellings, or one column
   storing the literal as written, leave the substitution to the model.


#### The other half: showing values before the statement is written

The lookup above fixes a literal *after* a statement returned nothing. The unconditional version —
put the column's stored values on the schema card, `name TEXT [pen|cup]` — is the obvious next step,
and it is measured: it costs **+38.4% of the card** when every profiled column carries a bracket and
**+1.4%** when only the columns your answer filters on do, and it buys **+1.24pp** and **+0.72pp**
respectively on BIRD's dev split (p = 0.0756 and 0.2000). Both are under the split's resolution, and
the cheap form is an oracle — it uses the gold statement to pick the columns. So the block is not a
default in this repository's benchmark arms, and you should treat it the same way: it is a lever to
measure on your schema, not a setting to switch on. What to expect if you do measure it: on the third
of cases whose answer filters on a column the profiler keeps, it is worth about +1.8pp, and on the
other two thirds the block cannot know more than "here are the values" already shows.

Two practical notes. The profiler only keeps values for categorical columns with a bounded number of
distinct spellings, so an empty bracket means "nothing to show", not "no values". And a bracket
invites invented filters — the prompt says samples are examples rather than defaults for a reason;
if your model starts writing `where status = 'Active'` on questions that asked for every row, the
block is why.

What the model is told on the second turn:

```
That statement was rejected. Fix exactly the problem below; keep the rest of the statement as it is.

PostgreSQL, 42703: column s.schoolname does not exist
Engine hint: Perhaps you meant to reference the column "s.SchoolName".

Closest identifier in the schema: students.SchoolName.
`s` has: StudentID, StudentName, Class, SchoolName.

Use only tables and columns that exist in the schema above, spelled exactly as they are there.
```

Four properties make that message worth the call:

- **The engine's own error**, not a summary: SQLSTATE where the engine uses one,
  position where it reports one, and its hint.
- **The schema's answer**: the identifier two edits away, resolved through the alias the
  statement bound (`s` → `students`), and the columns the table really has.
- **A class-specific instruction**: a grouping failure says to add the column to
  `GROUP BY`; a timeout says to filter before joining. Nine classes, each with its own
  sentence (`classifyFailure`).
- **A bound**: the block is capped at 900 characters, so a wide schema cannot crowd out
  the question.

`ask()` returns `failures` (the class of every rejected attempt) and `diagnoses` (one line
each), and when the budget is spent the thrown error carries `failureClasses`, `lastError`
and `lastSql` in `details`.

What the loop can and cannot reach is worth knowing before you enable it: a statement that
executes and answers the wrong question produces **no error**, so there is nothing to
diagnose. On BIRD Mini-Dev with `deepseek-chat`, 489 of 498 first statements executed — the
loop's ceiling there is 1.8pp. On a weaker model writing 20–36% invalid SQL, the same loop
has an order of magnitude more to work with. Measure the ceiling on your own model before
budgeting for retries. Those are what the repair funnel in [the benchmark page](../benchmarks.md) is computed from.

Three cases where the loop does nothing, which is the point:

| Case | What happens |
| --- | --- |
| First statement executes | `attempts: 1`, no repair turn, no extra call |
| Guard refuses a `DELETE` | Classified as `guard`, told the read-only rule, never executed |
| Engine reports a syntax error at a position | The caret line is drawn under that position, not under the first token |

## Gates you inherit

These run in CI on every commit, and the same commands run locally:

| Gate | Fails when |
| --- | --- |
| `gate:coverage` | any package is below 95% on statements, branches, functions or lines |
| `gate:layering` | a package imports one that breaks its runtime |
| `gate:exports` | the public API drifted from `api-surface.json` |
| `gate:budgets` | a package's gzipped output exceeds its ceiling |
| `gate:secrets` | a credential-shaped string is tracked |
| `gate:bird` | an external-benchmark arm falls more than 4pp below its floor |

The secret scan prints the file and the rule, never the matched text — echoing a
token into a CI log is the same leak to a different audience. It has a self-test
that plants a token, a clean environment reference and a key in a dotfile, so the
scanner is known to catch the first and third and to ignore the second.

## Upgrading

The public surface is snapshotted in `api-surface.json`. The compatibility rules:

| Rule | Meaning |
| --- | --- |
| A1 | An export never disappears within a major version |
| A2 | A required parameter is never added |
| A3 | A return type is never narrowed |
| A4 | New configuration is optional |
| A5 | A subpath keeps working |

`pnpm gate:exports` fails the build on any drift. Updating the snapshot is a
reviewed commit, not an automatic consequence of a refactor.

## Performance

- `core` is ~15 KB gzip; `chart` ~7 KB (ECharts is a peer, not a dependency).
- Import symbols, not namespaces: `import * as core` defeats tree-shaking.
  Package linting forbids it in documentation examples.
- Budgets are enforced per package in `budgets.json`. Raising one requires
  review; lowering one is always welcome.

## Testing your integration

Use the same tools CI uses:

```ts
import { recordCase, runContractSuite } from '@agentix-e/nl2charts-devkit';

const golden = await recordCase(runner, 'monthly revenue', 'select date_trunc(...)');
const { passed, failed, results } = await runContractSuite(runner, [golden]);
```

A golden case stores columns, row count and a row-set hash. It survives
formatting changes and fails when the data changes — which is usually what you
want for a warehouse contract test.

## Release checklist

- [ ] `pnpm verify` green locally
- [ ] CI `quality` and `benchmark` jobs green
- [ ] `api-surface.json` diff reviewed
- [ ] `budgets.json` diff reviewed
- [ ] Benchmark artifacts attached to the release
- [ ] No new `NL2C_E_*` code without a test that produces it
