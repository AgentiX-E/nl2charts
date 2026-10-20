# Concepts

This chapter is the mental model. It takes about ten minutes and everything else
in the guide builds on it.

## Two independent paths

nl2charts solves two problems that are often bundled together, and keeps them
separate on purpose:

```
rows ──────────────► profile ─► candidates ─► lint ─► ChartIR ─► chart option
                                                                    │
                                                              ECharts / SVG

question ─► link schema ─► prompt ─► model ─► guard ─► execute ─► rows
                                               │
                                          reject unsafe
```

You can use either path alone. `chart` does not know what SQL is; `core` does not
know what a chart is. The only shared vocabulary is `@agentix-e/nl2charts-spec`.

## Why a guard instead of a parser

A full SQL parser is large, dialect-specific, and still does not tell you whether
a statement is *safe* — `select * from read_csv('/etc/passwd')` is valid SQL.
The guard therefore does something narrower and more reliable:

- It tokenizes the statement, correctly handling strings, quoted identifiers,
  comments and dollar quotes.
- It accepts only statements whose first keyword is `select`, `with`, `values`,
  `explain`, `describe` or `summarize`.
- It rejects a fixed set of keywords anywhere in the statement (`insert`,
  `attach`, `copy`, `pragma`, `into`, …) and a fixed set of file-reading
  functions.
- It rejects multiple statements and historical snapshots (`AT (VERSION)`).
- If it cannot classify something, it rejects. **A false reject is a bug report;
  a false accept is a breach.**

The guard is not a sandbox. It is the first of several layers; the database user
you connect with must also be read-only.

## ChartIR is the contract

Everything that renders a chart consumes the same document:

```ts
interface ChartIR {
  version: '3.0';
  mark: 'bar' | 'line' | 'pie' | /* 19 more */;
  encoding: {
    x?: FieldRef | FieldRef[];
    y?: FieldRef | FieldRef[];
    theta?: FieldRef; series?: FieldRef; color?: FieldRef; size?: FieldRef;
  };
  data: Record<string, unknown>[];
  title?: string;
  alt?: string;          // required before rendering
  theme?: 'light' | 'dark' | 'print';
  width?: number; height?: number;
}
```

A `FieldRef` carries the field name **and** its semantic type
(`quantitative`, `nominal`, `ordinal`, `temporal`) plus an optional aggregate.
Encoding the type in the document is what allows linting and compilation to be
deterministic: no chart code needs to guess from the values.

## The five stages of the chart path

1. **Profile** — infer a type per column, count distinct values, find nulls and
   the numeric range.
2. **Enumerate** — produce the charts that are structurally valid for those
   profiles, with a score and a reason.
3. **Lint** — twelve rules, each with a severity. `error` blocks rendering
   (empty data, negative pie slice, non-quantitative scatter axis, missing alt
   text); `warn` records a readability problem.
4. **Compile** — turn the IR into a backend option object. Pure function: no
   DOM, no instance, no globals.
5. **Render** — ECharts in the browser, or `echarts.init(null, …, { ssr: true })`
   on the server.

## Value normalization

The same logical value arrives differently depending on the runtime: DuckDB
returns `BIGINT` as `bigint` and `DECIMAL` as `{ width, scale, value }`, the WASM
build returns numbers and strings. Row identity must not depend on that. `core`
canonicalizes every value before it leaves the runtime:

| Input | Canonical |
| --- | --- |
| `1n` within the safe range | `1` |
| `9007199254740993n` | `"9007199254740993"` (exact) |
| `{ width: 10, scale: 2, value: 150n }` | `"1.50"` |
| `Date` | ISO string |
| `NaN`, `±Infinity` | `"NaN"`, `"Infinity"`, `"-Infinity"` |
| `Uint8Array` | `0x…` hex |

`hashRows` runs FNV-1a over that canonical form, so two engines that agree on the
data produce the same hash.

## Errors are data

Every failure is an `Nl2ChartsError` with a stable code:

```ts
try {
  await runner.sql('copy t to \'/tmp/x.csv\'');
} catch (error) {
  if (isNl2ChartsError(error) && error.code === 'NL2C_E_GUARD_REJECTED') {
    console.log(error.details.reason);   // 'unclassified-statement'
  }
}
```

Use `isNl2ChartsError`, never `instanceof`: two copies of the library in one
process must still recognize each other's errors. The brand is registered with
`Symbol.for`.

## What "no model in core" buys you

- A deterministic, testable runtime with no network dependency.
- A bundle that a browser can load without shipping an SDK or an API key.
- A clear place to put the model (`ai`), so it can be replaced, replayed or
  removed without touching execution.

Next: [installation](02-installation.md).
