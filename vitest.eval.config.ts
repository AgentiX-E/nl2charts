import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * Coverage for `eval/` — the harness every published number comes out of.
 *
 * The main gate measures the packages and says so; `eval/` sat outside it in silence until
 * ADR-213 drew the boundary. Its honest number on that day was 49.5% of lines, and the
 * reason it could stay there is that nothing ran a measurement that would notice.
 *
 * This config is that measurement. It is derived from the main one so the test-file globs
 * cannot drift, and then it *replaces* the coverage scope rather than merging into it:
 * `mergeConfig` concatenates `include` arrays, and the first version of this file measured
 * the packages and `eval/` together — 9,009 lines with a confident 81.5% next to it, a
 * number about a set nobody meant to measure.
 */
const merged = mergeConfig(base, defineConfig({}));

export default defineConfig({
  ...merged,
  test: {
    ...merged.test,
    coverage: {
      ...merged.test?.coverage,
      include: ['eval/**/*.ts'],
      reportsDirectory: 'coverage-eval',
      // Per-file enforcement lives in tools/check-eval-coverage.mjs, which compares against a
      // committed ledger. The global thresholds describe the packages; applying them here
      // would make this run red for a fact the ledger already states precisely.
      thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 },
    },
  },
});
