/**
 * An artifact that omits an instrument reads as a mechanism that did not run.
 *
 * The dev run `40534288883` is the case in point. Its `decompose` arm scored 911/1,532
 * with the runner's own guard satisfied — the model wrote `STEP` lines on more than half
 * the cases, so the arm measured a decomposed statement and not a longer prompt. The
 * artifact then reported that arm without the funnel, because the field was emitted
 * inside the spread reserved for arms that sample several candidates, and the gate read
 * the silence as "the prompt was never asked to decompose" and failed the build for a
 * cause that did not exist.
 *
 * The lesson is not "fix one field". It is that the report has three kinds of claim —
 * what an arm was configured to do, what it did, and what it scored — and nothing was
 * comparing the first two. `assertReportComplete` does, at the moment the artifact is
 * written, so a dropped instrument names itself instead of being renamed by a reader.
 */
import { describe, expect, it } from 'vitest';
import { armDecomposition, assertReportComplete } from '../eval/bird/run.js';
import type { CaseRun } from '../eval/bird/run.js';

/**
 * A scored case with every field the type requires.
 *
 * Deliberately complete rather than cast: the defect this file was written for was a
 * fixture that filled `name` where the type said `table` and passed a cast, so the
 * renderer printed `undefined(id INTEGER)` and every test stayed green.
 */
function run(overrides: Partial<CaseRun> = {}): CaseRun {
  return {
    id: '1',
    passed: false,
    predicted: 'SELECT 1',
    reason: 'values',
    strict: false,
    attempts: 1,
    calls: 1,
    ...overrides,
  };
}

describe('the decomposition funnel in the artifact', () => {
  it('is absent when no case asked for one, so a report cannot claim an instrument it did not run', () => {
    // Emitting `asked: 0` would be worse than emitting nothing: the gate's share check
    // divides by `asked`, and an arm with a zero denominator would pass it.
    expect(armDecomposition([run(), run()])).toEqual({});
  });

  it('is reported for a single-candidate arm, which is the shape that was dropped', () => {
    // `decompose` generates once. The field was inside the sampling-arm spread, so this
    // exact run set produced an artifact with no funnel and a build failure that blamed
    // the prompt.
    const field = armDecomposition([
      run({ decomposition: { candidates: 1, steps: 3 } }),
      run({ decomposition: { candidates: 1, steps: 0 } }),
      run(),
    ]);
    expect(field.decomposition).toEqual({ asked: 2, fired: 1, share: 0.5, meanSteps: 1.5 });
  });

  it('counts the candidates that were asked, not the steps they wrote', () => {
    // A mixed arm asks only its decompose source, so `asked` is the number of those
    // candidates and the mean is over them: dividing by the arm's case count would blame
    // the fourth prompt for questions it was never given.
    const field = armDecomposition([
      run({ decomposition: { candidates: 1, steps: 2 } }),
      run({ decomposition: { candidates: 1, steps: 4 } }),
    ]);
    expect(field.decomposition?.meanSteps).toBe(3);
  });
});

describe('report completeness', () => {
  it('refuses an arm that asks for a decomposition and carries no funnel', () => {
    expect(() => assertReportComplete({ arms: [{ arm: 'decompose', total: 1532 }] })).toThrow(
      /decompose.*no decomposition funnel/,
    );
  });

  it('refuses a mixed arm whose decompose source is unchecked', () => {
    // The same instrument, reached through the source list rather than the flag: `select-dc`
    // has `decompose: false` on the arm and a decomposed candidate in slot three.
    expect(() => assertReportComplete({ arms: [{ arm: 'select-dc', total: 1532 }] })).toThrow(
      /select-dc.*no decomposition funnel/,
    );
  });

  it('refuses a sampling arm without its ceiling', () => {
    // `candidateRecall` is the only number that separates a weak generator from a weak
    // selector, and a sampling row without it cannot be read at all.
    expect(() => assertReportComplete({ arms: [{ arm: 'select-mixed', total: 1532 }] })).toThrow(
      /select-mixed.*no candidate ceiling/,
    );
  });

  it('refuses an arm that runs the empty-result lever and carries no funnel', () => {
    expect(() => assertReportComplete({ arms: [{ arm: 'select-mixed+empty', total: 1532, candidateRecall: 0.65 }] })).toThrow(
      /select-mixed\+empty.*no empty-result funnel/,
    );
  });

  it('accepts a report that carries every instrument its arms declare', () => {
    expect(() =>
      assertReportComplete({
        arms: [
          { arm: 'names', total: 1532 },
          { arm: 'decompose', total: 1532, decomposition: { asked: 1532, fired: 1400, share: 0.91, meanSteps: 2.4 } },
          { arm: 'select-dc', total: 1532, candidateRecall: 0.67, decomposition: { asked: 1532, fired: 1400, share: 0.91, meanSteps: 2.4 } },
          {
            arm: 'select-mixed+empty',
            total: 1532,
            candidateRecall: 0.656,
            emptyRetry: { mode: 'diagnosed', dropped: 12, fired: 3, recovered: 1 },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('names an arm the build does not know instead of skipping it', () => {
    // A row that cannot be resolved is a row whose instruments cannot be checked. Skipping
    // it is the silent pass this file exists to remove.
    expect(() => assertReportComplete({ arms: [{ arm: 'gone-in-1.4', total: 500 }] })).toThrow(
      /gone-in-1\.4.*does not know/,
    );
  });

  it('accepts a dry run, which scores gold queries and runs no arm', () => {
    expect(() => assertReportComplete({})).not.toThrow();
  });
});
