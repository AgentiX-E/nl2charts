# Installation

## Requirements

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | 20.19+ (22 recommended) | ESM, `AbortSignal`, native test runner |
| pnpm | 10.x | workspace protocol and lockfile format |
| Platform | macOS, Linux, Windows | `@duckdb/node-api` ships prebuilt binaries for all three |

There is no build toolchain requirement: DuckDB arrives as a prebuilt native
binding, not as something you compile.

## From source (npm packages are not published yet)

```bash
git clone https://github.com/AgentiX-E/nl2charts.git
cd nl2charts
corepack enable
pnpm install
pnpm build
```

Verify the checkout before using it:

```bash
pnpm typecheck        # strict TypeScript, no emit
pnpm test:coverage    # 200+ tests, per-package coverage gate
pnpm verify           # everything, including the benchmark
```

`pnpm verify` should end with:

```
coverage gate: 8 packages, all dimensions >= 95%
layering: 8 packages, 0 forbidden edges
platform: PLT1-PLT7 clean
api surface: 128 symbols across 8 packages, no drift
harness: controls hold (oracle 100%, empty 0%)
```

## Adding the packages to your project

Inside this workspace, depend on them with the workspace protocol:

```json
{
  "dependencies": {
    "@agentix-e/nl2charts-core": "workspace:*",
    "@agentix-e/nl2charts-node": "workspace:*",
    "@agentix-e/nl2charts-chart": "workspace:*"
  }
}
```

Outside the workspace, wait for the first publish, or build and pack the
packages you need:

```bash
pnpm --filter @agentix-e/nl2charts-core build
pnpm --filter @agentix-e/nl2charts-core pack
```

## Choosing packages by runtime

| You are building | Install |
| --- | --- |
| A browser app that runs SQL locally | `core` + `ai` + `@duckdb/duckdb-wasm` |
| A Node service | `core` + `node` (+ `ai` if you want natural language) |
| Only chart rendering | `chart` + `echarts` |
| An MCP server | `mcp` + `core` + `node` |
| A semantic-layer admin tool | `studio` |

The rule is physical, not stylistic: `core`'s root entry bundles in a browser;
everything that imports `node:*` or a native driver lives in `-node` subpaths.

## Troubleshooting

**`Cannot find module '@duckdb/node-api'`** — run `pnpm install` at the
repository root, not inside a package. The workspace hoists the native binding.

**`Nl2ChartsError: NL2C_E_ENGINE_FAILED` on every query** — you are probably
reusing an engine after `close()`. Create one engine per process (or per test
file) and close it once.

**A query returns fewer rows than expected** — the runner caps rows at
`maxRows` (default 10,000) and sets `truncated: true`. Pass `{ limit }` per call
if you need more, up to your own ceiling.

**A legitimate statement is rejected** — the guard is lexical and deliberately
conservative. Open an issue with the statement; each case is added to the
44-statement corpus in `packages/core/test/guard.test.ts` and the decision is
recorded.

Next: [your first chart](03-first-chart.md).
