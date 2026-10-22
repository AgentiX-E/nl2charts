# 3. Semantic error

## Symptom

Over MCP:

```json
{ "error": { "code": -32000,
  "message": "NL2C_E_UNKNOWN_METRIC: unknown metric: margin",
  "data": { "candidates": ["revenue", "orders"] } } }
```

Over the TypeScript API: a thrown error whose `code` is `NL2C_E_UNKNOWN_METRIC`.

## What it means

The semantic model does not contain what the query asked for. The compiler never
guesses: an unknown metric, an ambiguous column or a second join path is an error
with candidates, because a silent choice here becomes a wrong number in a chart.

## Do this

1. **Use `data.candidates`.** It is the ranked list the compiler considered; a
   near-miss is usually a typo or a metric that exists under an alias.
2. **If the metric should exist, add it to the model** — with `rationale` and
   `grain`. A metric without a grain cannot be aggregated at a different level, and
   the validator warns about it.
3. **Do not "fix" it by querying the table directly.** `run_sql` bypasses the
   definition and reintroduces exactly the ambiguity that produced the error.
4. **Check `-32602` versus `-32000`.** `-32602` means the call was malformed (no
   model, empty metric list); `-32000` means the call was well formed and the model
   could not answer it. They are different teams' problems.

## Drill

`test/runbooks.test.ts` → *runbook: semantic error* calls `query_metric` with an
unknown metric and asserts the `NL2C_E_` prefix and a non-empty `data` payload.
