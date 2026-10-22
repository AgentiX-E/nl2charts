# nl2charts

TypeScript toolkit that turns **rows into charts** and **questions into guarded SQL**.

Two rules shape the whole design:

1. **The runtime does not need a model.** `core` executes SQL and returns rows. Natural language lives in a separate package (`ai`) that you install only if you want it.
2. **Every statement passes a lexical guard.** The guard refuses what it cannot classify instead of rewriting it. Read-only is enforced before the engine sees the query.

> **Status: 1.0.0.** Eight packages, a four-stage metric compiler, three engines with real integration tests (DuckDB, SQLite, PostgreSQL — plus MySQL), 22 chart types with a structural regression baseline, an MCP surface that speaks metrics, and gates for coverage, layering, API drift, bundle size, credentials and benchmark regression.
>
> Accuracy is measured on **BIRD Mini-Dev**, 239 of 500 questions, one model, one sample per case: **32.6% from table and column names**, **42.7% once definitions are attached to the columns**, **56.9% with the dataset's per-question hint**, against **58.2%** for 798 curated column notes plus the same hint. The movement came from *placement*, not content: the identical sentences scored 33.5% as a block appended to the schema (+6.7 to +10.5pp when attached to their columns, four runs). Curated notes on the same columns beat generated ones by 1.3pp (p=0.375), raising coverage from 37% to 92% changed nothing, a model-written dictionary moved nothing, a reading of the question written before the SQL changed exactly zero cases, and three-sample voting lost 1.3pp with a 90% agreement rate. A 32-case adversarial set scores 81.2% and shows column metadata *costs* 6–9pp on window and ratio shapes while attached definitions cost nothing. Runs of the same harness differ by up to 3.4pp, which is why every delta below 4pp is reported as noise. See [docs/benchmarks.md](docs/benchmarks.md) for exactly what these numbers do and do not mean.

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

const issues = lint(ir);                                 // 12 rules, errors block rendering
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

## Quality gates

Every push runs the same gates locally and in CI:

| Gate | Rule |
| --- | --- |
| Coverage | ≥95% statements, branches, functions and lines **per package** |
| Layering | 8 packages, no forbidden dependency edge, `devkit` never a production dependency |
| Platform | `core`'s browser graph contains no `node:`, driver or `ai` import; declarations leak no driver types (PLT1–PLT7, with 7 mutation tests) |
| API surface | An export that disappears fails the build (128 symbols snapshotted) |
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
