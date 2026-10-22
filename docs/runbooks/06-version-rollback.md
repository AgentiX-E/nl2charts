# 6. Version rollback

## Symptom

None, until it matters: the eight packages disagree about their version, or the
public API differs from `api-surface.json`.

## What it means

The workspace publishes `1.0.0` as a single promise: the A1–A5 rules hold (an
export never disappears within a major, a required parameter is never added, a
return type is never narrowed, new configuration is optional, a subpath keeps
working). A mixed workspace is how that promise quietly stops being true.

## Do this

1. **Roll back all eight together.** The packages share a lockstep version on
   purpose; a partial rollback produces a graph nobody tested.
2. **Run the gates before and after**:

   ```bash
   pnpm gate:exports     # no drift from api-surface.json
   pnpm gate:coverage    # still 95% on all four dimensions
   pnpm gate:budgets     # still inside the ceilings
   pnpm gate:bird        # the external benchmark is still above its floor
   ```

3. **Check the surface snapshot, not the changelog.** `api-surface.json` is the
   compatibility record; if a symbol changed, the rollback is not a rollback, it is
   a breaking change with a new number.
4. **Record the run.** A rollback without the benchmark result is a guess about
   whether the old version was better.

## Drill

`test/runbooks.test.ts` → *runbook: version rollback* asserts that all eight
package manifests carry one version and that `api-surface.json` contains an entry
for every package.
