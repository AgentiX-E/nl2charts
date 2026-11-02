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
import { armDecomposition, armFormat, assertReportComplete } from '../eval/bird/run.js';
import type { CaseRun } from '../eval/bird/run.js';

/**
 * The profile a healthy run reports on the models this repository benchmarks.
 *
 * Every dimension held, which is the state the existing arms are in and the state a new
 * backbone has to reach before its accuracy is worth comparing with theirs.
 */
const FORMAT = { replies: 1532, fenced: 'always', index: 'always', steps: 'always', named: 'never' } as const;

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

  it('refuses an audit arm whose row carries no funnel', () => {
    // The turn is one call on every question, so a row without its funnel is a report in which
    // the mechanism's price and its reach are both unreadable — the same refusal the
    // empty-result lever gets, for the same reason.
    expect(() => assertReportComplete({ arms: [{ arm: 'inline+evidence+audit', total: 1532 }] })).toThrow(
      /inline\+evidence\+audit.*no audit funnel/,
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
          { arm: 'names', total: 1532, format: FORMAT },
          { arm: 'decompose', total: 1532, decomposition: { asked: 1532, fired: 1400, share: 0.91, meanSteps: 2.4 }, format: FORMAT },
          { arm: 'select-dc', total: 1532, candidateRecall: 0.67, decomposition: { asked: 1532, fired: 1400, share: 0.91, meanSteps: 2.4 }, format: FORMAT },
          {
            arm: 'select-mixed+empty',
            total: 1532,
            candidateRecall: 0.656,
            emptyRetry: { mode: 'diagnosed', dropped: 12, fired: 3, recovered: 1 },
            format: FORMAT,
          },
          {
            arm: 'inline+evidence+audit',
            total: 1532,
            audit: { fired: 1532, named: 411, rewritten: 980, extraCallsPerCase: 1 },
            format: FORMAT,
          },
        ],
      }),
    ).not.toThrow();
  });

  it('refuses a pooled arm that does not say how much of the pool it could verify', () => {
    // The delta a pooled arm publishes is the pool's noise unless the pool was read, and on two of
    // six hundred cases in `41430569500` it could not be read at all (I-80). A row that names its
    // parent and not the number of shared cases leaves that denominator unstated.
    expect(() =>
      assertReportComplete({ arms: [{ arm: 'select-cross-pooled', total: 600, candidateRecall: 0.697 }] }),
    ).toThrow(/select-cross-pooled.*no pool verification/);
  });

  it('accepts a pooled arm that says it, and a short run where there is nothing to say', () => {
    expect(() =>
      assertReportComplete({
        arms: [
          {
            arm: 'select-cross-pooled',
            total: 600,
            pool: 'select-cross',
            candidateRecall: 0.697,
            poolRead: { shared: 598, unrecorded: 2, cases: 600 },
            poolSpend: { asked: 598, priced: 598 },
          },
        ],
      }),
    ).not.toThrow();
    // Below the instrument floor the field is absent by contract: seven cases cannot verify a pool,
    // and a zero here would read as a pool that failed rather than a sample that cannot say.
    expect(() =>
      assertReportComplete({ arms: [{ arm: 'select-cross-pooled', total: 7, pool: 'select-cross', candidateRecall: 0.857 }] }),
    ).not.toThrow();
  });

  it('refuses a pooled arm that selects and does not say how many decisions it priced', () => {
    // A pooled arm's whole bill is one call per decision, and the gate cannot read that off its
    // mean: 1.0 and 0.97 are the same line to a reader and opposite facts to an auditor — one arm
    // priced its selector, the other never reached it on three cases (I-81).
    expect(() =>
      assertReportComplete({
        arms: [
          {
            arm: 'select-cross-pooled',
            total: 600,
            pool: 'select-cross',
            candidateRecall: 0.697,
            poolRead: { shared: 600, unrecorded: 0, cases: 600 },
          },
        ],
      }),
    ).toThrow(/select-cross-pooled.*does not say how many of those decisions were priced/);
    // A pooled majority vote never asks the model, so there is no decision to price and the row
    // carries no such count: the rule is keyed on the selector, not on the pool.
    expect(() =>
      assertReportComplete({
        arms: [
          {
            arm: 'select-mixed-pooled-vote',
            total: 600,
            pool: 'select-mixed',
            candidateRecall: 0.665,
            poolRead: { shared: 600, unrecorded: 0, cases: 600 },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('refuses a reconcile arm that does not say what the turn produced', () => {
    // Without the funnel the row cannot separate "it reconciled and was wrong" from "it restated
    // candidate 1 on every case", and the second reading belongs to the selector.
    expect(() =>
      assertReportComplete({ arms: [{ arm: 'select-cross-pooled-reconcile', total: 600, pool: 'select-cross', candidateRecall: 0.705 }] }),
    ).toThrow(/select-cross-pooled-reconcile.*no reconcile funnel/);
    expect(() =>
      assertReportComplete({
        arms: [
          {
            arm: 'select-cross-pooled-reconcile',
            total: 600,
            pool: 'select-cross',
            candidateRecall: 0.705,
            poolRead: { shared: 600, unrecorded: 0, cases: 600 },
            poolSpend: { asked: 600, priced: 600 },
            reconcile: { asked: 600, returned: 600, novel: 214, executable: 605, adopted: 380 },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('reports the shape an arm\'s replies had, aggregated over its cases', () => {
    const shape = { fenced: true, index: false, steps: 0, named: 0 };
    expect(armFormat([run({ shape }), run({ shape }), run({ shape })])).toEqual({
      format: { replies: 3, fenced: 'always', index: 'never', steps: 'never', named: 'never' },
    });
  });

  it('carries no profile when no case recorded a shape, which is the dry run', () => {
    // A profile over zero replies would be a verdict about a model that was never called.
    expect(armFormat([run(), run()])).toEqual({});
  });

  it('refuses a row that answered cases and dropped the shape of every reply', () => {
    // The profile is the only reading that predicts a collapse on a model nobody calibrated,
    // and it is read on every case. A row without one is an artifact whose most portable
    // instrument was collected and thrown away.
    expect(() => assertReportComplete({ arms: [{ arm: 'names', total: 1532 }] })).toThrow(/no format profile/);
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
