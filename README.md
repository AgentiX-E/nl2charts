# nl2charts

TypeScript toolkit that turns **rows into charts** and **questions into guarded SQL**.

Two rules shape the whole design:

1. **The runtime does not need a model.** `core` executes SQL and returns rows. Natural language lives in a separate package (`ai`) that you install only if you want it.
2. **Every statement passes a lexical guard.** The guard refuses what it cannot classify instead of rewriting it. Read-only is enforced before the engine sees the query.

> **Status: 1.0.0.** Eight packages, a four-stage metric compiler, three engines with real integration tests (DuckDB, SQLite, PostgreSQL — plus MySQL), 22 chart types with a structural regression baseline, an MCP surface that speaks metrics, and gates for coverage, layering, API drift, bundle size, credentials and benchmark regression.
>
> **What is a product number.** Every arm below that reads the dataset's per-question hint is marked
> `with the dataset's per-question hint`, and no such arm is a deployment number: the hint is
> supplied by the benchmark and absent from any real schema. The arms a product can run are the
> ones built from table and column names, from definitions attached to columns, and from curated
> notes. The guard is the other thing a deployment needs and a benchmark cannot score:
> `pnpm bench:guard` puts 29 attacks through the gate — **0.0% ASR, 0 of 10 legitimate questions
> refused, 100% utility**, against **69.0%** for the same corpus with no gate at all.
>
> Accuracy is measured on **BIRD Mini-Dev** — 496 of the file's 498 questions (500 rows, since 137 and 138 each appear twice), the two whose gold statements will not run named in [docs/benchmarks.md](docs/benchmarks.md); on the 1,534-question dev split, the one leaderboards report, the same three arms score **42.2% / 60.6–61.0% / 61.4–61.5%** over two runs (1,532 scorable), and **63.0%** when three prompt styles and a selector replace the single sample — one model, one sample per case: **35.7% from table and column names**, **45.0% once definitions are attached to the columns**, **57.4% with the dataset's per-question hint**, against **59.2%** for 798 curated column notes plus the same hint, a 1.8pp gap and therefore not separable. The apparent movement came from *placement*, not content — the identical sentences score 41.4% as a block appended to the schema and 45.0% attached to their columns — but it does not survive being measured the right way: inside three single runs those two arms are **19 against 13**, **18 against 17** and **15 against 18**, pooled 0.28pp apart (± 1.32) with no reading significant, so the 3.6pp was a difference between two runs, not between two placements. Nothing borrowed from the state of the art moved the ceiling: retrieval from BIRD's training split (+1.2pp), the same neighbours as worked examples (−0.2pp), value grounding on 45,444 stored values (+0.8pp) and a model choosing among three samples of one prompt (+0.7pp on 1,532 dev questions, p=0.28) all stayed inside the noise a repeated arm measures — 0.2 to 1.2pp across six runs. What did move is where the candidates come from: three *different* prompts and a selector, four calls per question, is **+2.4pp** over the single sample on the dev split (23 won / 60 lost, p=0.0001) and the best number here; two prompts alone are not (61.8%). The selector loses 2.6pp of what its candidate set contains, which is where the next work is. **Diagnosed repair** is the one mechanism with a measured effect, and it is bounded by how often a model writes invalid SQL: on `deepseek-chat` only 2.4% of first statements fail, so three diagnosed retries are unresolvable at 498 questions (+0.4pp, p=0.69); on `glm-4-flash`, where 36.5% fail, the same loop is worth **+6.4pp** (16 cases won, 0 lost, p<0.0001) for 0.63 extra calls per question — measured twice with identical results, which is the only mechanism here that has cleared the two-run adoption rule. Most of that gain is the engine's message itself: the same three retries carrying the raw error alone reach 35.3% (+5.2pp), and the classification, schema candidate and caret add **+1.2pp** (3 won / 6 lost, p=0.51) — real enough to keep as the default, too small to claim at 250 cases. Curated notes on the same columns are not separated from generated ones on the dev split (+0.07pp, 65:66, p = 1.0 on 1,532 questions) and are +2.89pp ± 1.55 on Mini-Dev over three pooled runs — a conflict between a split and its own subset that is written up as unresolved, not as a result; raising coverage from 37% to 92% changed nothing, a model-written dictionary moved nothing, a reading of the question written before the SQL changed exactly zero cases, and three-sample voting lost 0.6pp (p=0.69) at 91% self-agreement. Those floors are enforced: `pnpm gate:bird` fails the workflow when an arm falls more than 4pp below the recent minimum, when an arm the baseline expects is missing, when an arm's block was empty, when a repair arm never repairs, or when the funnel's three buckets do not sum to the sample. A 32-case adversarial set scores 81.2% and shows column metadata *costs* 6–9pp on window and ratio shapes while attached definitions cost nothing. Two re-measurements (runs `42482353883` and `42491745712`, November 2026) reproduced the no-hint arms and killed the placement gain: `synth-definitions` **41.5%** and **40.9%**, `inline-definitions` **40.3%** and **40.7%**, and paired inside the second run **18 against 17, p = 1.0000**. Both runs asked for `deepseek-chat` and all 6,448 of their answers came back named `deepseek-flash`, so the base that answered is now recorded per arm and pinned in the baseline; the weights behind that name are the next fix. The two runs also measured what a re-run moves on its own: the unchanged `select` arm read **56.05%** and **58.06%** — 26 of 496 cases changed verdict (18 up, 8 down, p = 0.076) — which puts the resolution of a comparison between two runs at **±6.2pp**. Every mechanism claim above is a paired reading taken inside one run for that reason — and a paired
reading is not automatically a result either: the selector's +2.82pp (22 against 8) read 13 against 13
and then 19 against 18 in the next two runs on identical inputs, pooled +1.01pp ± 1.26 with Cochran's Q
at p = 0.043 — the readings differ by more than their own intervals, so it is filed as `heterogeneous`
rather than as a mechanism that works. See [docs/benchmarks.md](docs/benchmarks.md) for exactly what
these numbers do and do not mean.

## What works today

| Capability | Package | Example |
| --- | --- | --- |
| Contract types + JSON Schema | `@agentix-e/nl2charts-spec` | `parseChartIR(input)` |
| Guarded SQL execution | `@agentix-e/nl2charts-core` | `createRunner({ engine }).sql('select 1')` |
| Native DuckDB, file cache | `@agentix-e/nl2charts-node` | `createDuckDbEngine()` |
| Profiling, lint, ECharts option | `@agentix-e/nl2charts-chart` | `compileToECharts(ir)` |
| Prompting, schema linking, repair loop | `@agentix-e/nl2charts-ai` | `createPipeline({ provider }).ask(...)` |
| Metric compiler (Plan→Optimize→Lower→Render) | `@agentix-e/nl2charts-core/semantic` | `compileQuery({ metrics: ['revenue'] }, model)` |
| Query a SQLite file | `@agentix-e/nl2charts-node` | `createSqliteEngine({ path })` |
| Model validation | `@agentix-e/nl2charts-studio` | `validateModel(doc)` |
| MCP tools over stdio | `@agentix-e/nl2charts-mcp` | `attachStreams(server, input, write)` |
| Contract tests and golden cases | `@agentix-e/nl2charts-devkit` | `runContractSuite(runner, cases)` |

## Quick start: rows to SVG

```ts
import { enumerateCandidates, lint, profileRows, compileToECharts } from '@agentix-e/nl2charts-chart';
import * as echarts from 'echarts';

const rows = [
  { month: '2026-01-01', revenue: 120 },
  { month: '2026-02-01', revenue: 150 },
];

const profiles = profileRows(rows);
const [best] = enumerateCandidates(profiles);           // { mark: 'line', ... }
const ir = {
  version: '3.0',
  mark: best.mark,
  encoding: {
    x: { field: 'month', type: 'temporal' },
    y: { field: 'revenue', type: 'quantitative', aggregate: 'sum' },
  },
  data: rows,
  title: 'Revenue by month',
  alt: 'Revenue rises from 120 in January to 150 in February.',
};

const issues = lint(ir);                                 // 14 rules, errors block rendering
const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 640, height: 400 });
chart.setOption(compileToECharts(ir));
const svg = chart.renderToSVGString();
```

## Quick start: guarded SQL

```ts
import { createRunner } from '@agentix-e/nl2charts-core';
import { createDuckDbEngine } from '@agentix-e/nl2charts-node';

const engine = await createDuckDbEngine();               // in-memory DuckDB
const runner = createRunner({ engine, maxRows: 1_000 });

const result = await runner.sql('select region, sum(amount) as total from orders group by 1');
// result.rows are normalized: bigint -> number|string, DECIMAL -> exact string, DATE -> 'YYYY-MM-DD'
// result.provenance === { path: 'sql', chart: false }

await runner.sql('drop table orders');                   // throws NL2C_E_GUARD_REJECTED
```

## Quick start: question to SQL

```ts
import { createHttpProvider, createPipeline } from '@agentix-e/nl2charts-ai';

const provider = createHttpProvider({ baseUrl: '/api/llm', model: 'your-model' });
const pipeline = createPipeline({ provider });

const { sql, linked } = await pipeline.ask({
  question: 'revenue by region',
  schema: [{
    table: 'orders',
    columns: [
      { name: 'region', type: 'VARCHAR', samples: ['north', 'south'] },
      { name: 'amount', type: 'DECIMAL', aliases: ['revenue', 'sales'] },
    ],
  }],
});
```

The pipeline validates every candidate with the same guard the runner uses, so a model cannot "repair" a query by dropping a table.

## Quick start: metrics to SQL

```ts
import { compileQuery } from '@agentix-e/nl2charts-core/semantic';

const compiled = compileQuery({ metrics: ['aov'], dimensions: ['region'] }, model);
const result = await runner.sql(compiled.sql);
// aov is sum(revenue) / count(orders), not avg(unit price)
```

The compiler plans a DAG, optimizes it, lowers it to CTEs and renders SQL. Metrics
declare their native grain, so a measure is aggregated **before** any join: in the
benchmark fixture a hand-written join inflates revenue **3.00x**, while the
compiled query matches the gold result on 200/200 generated queries.

## Build from source

```bash
corepack enable
pnpm install
pnpm build
pnpm verify        # typecheck, build, tests with coverage, all gates, benchmark
```

Node 20.19+ (Node 22 is what CI uses). The packages are not published to npm yet.

### Running every gate locally

`pnpm gate:all` is the same set of checks the `quality` job runs, and a test keeps the two
lists equal (`tools/check-gate-parity.mjs`) — an aggregate that silently covers less than CI
is worse than no aggregate, because it replaces the habit of checking.

Two suites need real database servers; without them they skip and the `node` package's
coverage falls below the gate, which is a *failed* run rather than a passing one:

```bash
PG_TEST_URL="postgres://postgres:postgres@127.0.0.1:5432/nl2charts_test" \
MYSQL_TEST_URL="mysql://analyst:s3cret@127.0.0.1:3306/nl2charts_test" \
pnpm gate:all
```

## Quality gates

Every push runs the same gates locally and in CI:

| Gate | Rule |
| --- | --- |
| Coverage | ≥95% statements, branches, functions and lines **per package** |
| Layering | 8 packages, no forbidden dependency edge, `devkit` never a production dependency |
| Platform | `core`'s browser graph contains no `node:`, driver or `ai` import; declarations leak no driver types (PLT1–PLT7, with 7 mutation tests) |
| API surface | An export that disappears fails the build (430 symbols snapshotted) |
| Gate parity | `gate:all` runs every check command the quality job runs, expanded through the scripts |
| Budgets | gzip size ceilings per package |
| Benchmark | Oracle must score 100%, empty predictor 0%, or the run fails |

## Documentation

- [Concepts](docs/guide/01-concepts.md) — the mental model in ten minutes
- [Installation](docs/guide/02-installation.md)
- [Your first chart](docs/guide/03-first-chart.md)
- [Your first query](docs/guide/04-first-query.md)
- [Natural language](docs/guide/05-natural-language.md)
- [Semantic layer validation](docs/guide/06-semantic-layer.md)
- [Compiling metrics to SQL](docs/guide/08-semantic-compiler.md)
- [Query a SQLite database](docs/guide/09-sqlite.md)
- [Give the model definitions, not just schema](docs/guide/10-evidence.md)
- [Infer semantics from the schema](docs/guide/11-semantics.md)
- [Connectors: what is promised per engine](docs/guide/12-connectors.md)
- [Runbooks: six failures and their drills](docs/runbooks/README.md)
- [Changelog](CHANGELOG.md)
- [Production checklist](docs/guide/07-production.md)
- [Architecture](docs/architecture.md)
- [Glossary](docs/glossary.md)
- [Benchmarks and ablations](docs/benchmarks.md)

## License

Apache-2.0.
