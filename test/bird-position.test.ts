/**
 * The position reader, on artifacts shaped like the ones the runner writes.
 *
 * The tool exists because one number supported two opposite next steps. `@second` was the
 * winner on 52.6% of the cross-vendor cases — which reads as "the judge prefers the second
 * model's writing" (swap the judge) or as "the judge prefers the first candidate in the list"
 * (move the prompt) with equal support, because the second model's candidate was always
 * first. Every test here is a shape that separates them or refuses to: a table whose strata
 * are far apart, a table whose strata are not, an artifact taken without a shuffle, and a
 * record that puts one source in two slots.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  compare,
  conclusion,
  DEFAULT_TRACKED,
  differenceInterval,
  isEntry,
  main,
  reportLines,
  resolvePositionSettings,
  slotStrata,
  wilson,
} from '../eval/bird/position.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const scratch = mkdtempSync(join(tmpdir(), 'nl2birds-position-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CROSS = 'inline+evidence@second';
const METADATA = 'metadata+evidence';
const VALUES = 'values';

/** The three orders `CROSS_SOURCES` can reach a selector in, by the slot the second model sits in. */
const IN_FIRST = [CROSS, METADATA, VALUES];
const IN_MIDDLE = [METADATA, CROSS, VALUES];
const IN_LAST = [METADATA, VALUES, CROSS];

interface Verdict {
  readonly source: string;
  readonly correct: boolean;
}

const verdict = (source: string, correct = false): Verdict => ({ source, correct });

interface RowOptions {
  readonly arm?: string;
  readonly passed?: boolean;
  /** Omit to leave `winnerSource` off the row, the way an unlabelled arm writes it. */
  readonly taken?: string;
}

function row(id: string, order: readonly string[] | undefined, options: RowOptions = {}): Record<string, unknown> {
  return {
    arm: options.arm ?? 'select-cross-shuffled',
    id,
    passed: options.passed ?? false,
    ...(order === undefined ? {} : { candidates: order.map((source) => verdict(source)) }),
    ...(options.taken === undefined ? {} : { winnerSource: options.taken }),
  };
}

/** `count` rows that put the tracked source in `slot` and take it on `took` of them. */
function stratum(
  slot: 0 | 1 | 2,
  count: number,
  took: number,
  prefix: string,
  arm = 'select-cross-shuffled',
): Record<string, unknown>[] {
  const order = [IN_FIRST, IN_MIDDLE, IN_LAST][slot] as readonly string[];
  return Array.from({ length: count }, (_, index) =>
    row(`${prefix}${String(index)}`, order, { arm, taken: index < took ? CROSS : VALUES, passed: index < took }),
  );
}

/** A comparison that has two strata to compare. Named so the tests read as assertions, not as casts. */
function compared(reading: Parameters<typeof compare>[0]): Extract<ReturnType<typeof compare>, { verdict: 'separated' | 'overlapping' }> {
  const comparison = compare(reading);
  if (comparison.verdict === 'single-slot') throw new Error('one stratum cannot be compared with itself');
  return comparison;
}

type ArtifactInput = Parameters<typeof slotStrata>[0];

function artifact(cases: readonly Record<string, unknown>[]): ArtifactInput {
  return { split: 'dev', cases: cases as unknown as NonNullable<ArtifactInput['cases']> };
}

describe('the strata', () => {
  it('files every case under the slot its tracked source sat in', () => {
    const reading = slotStrata(
      artifact([row('q1', IN_FIRST, { taken: CROSS }), row('q2', IN_MIDDLE, { taken: METADATA }), row('q3', IN_LAST, { taken: VALUES })]),
      'select-cross-shuffled',
    );
    expect(reading.strata.map((entry) => [entry.slot, entry.cases, entry.took])).toEqual([
      [0, 1, 1],
      [1, 1, 0],
      [2, 1, 0],
    ]);
    expect(reading.recorded).toBe(3);
    expect(reading.absent).toBe(0);
    expect(reading.problems).toEqual([]);
  });

  it('counts a case as taken only when the winner label is the tracked source', () => {
    const reading = slotStrata(
      artifact([row('q1', IN_MIDDLE, { taken: CROSS }), row('q2', IN_MIDDLE, { taken: METADATA })]),
      'select-cross-shuffled',
    );
    expect(reading.strata).toHaveLength(1);
    expect(reading.strata[0]?.cases).toBe(2);
    expect(reading.strata[0]?.took).toBe(1);
    expect(reading.strata[0]?.share).toBe(0.5);
  });

  it('keeps a case whose choice is unlabelled in the denominator and out of the choices', () => {
    // An arm that does not write `winnerSource` still tells us where the candidate sat. Dropping
    // the row would shrink the denominator; counting it as "not taken" silently would be the
    // same as saying the arm rejected it, which the file does not say.
    const reading = slotStrata(artifact([row('q1', IN_MIDDLE, { taken: CROSS }), row('q2', IN_MIDDLE)]), 'select-cross-shuffled');
    expect(reading.unlabelled).toBe(1);
    expect(reading.strata[0]?.cases).toBe(2);
    expect(reading.strata[0]?.took).toBe(1);
  });

  it('counts passed separately from taken, because the judge can pass a statement the arm did not take', () => {
    const reading = slotStrata(
      artifact([row('q1', IN_MIDDLE, { taken: VALUES, passed: true }), row('q2', IN_MIDDLE, { taken: CROSS, passed: false })]),
      'select-cross-shuffled',
    );
    expect(reading.strata[0]?.took).toBe(1);
    expect(reading.strata[0]?.passed).toBe(1);
  });

  it('counts a case that does not carry the tracked source apart from the slots', () => {
    // The second model's candidate never arrived. That is a fact about the candidate set and not
    // about positions, so it belongs beside the strata and never inside one.
    const reading = slotStrata(artifact([row('q1', [METADATA, VALUES], { taken: VALUES }), row('q2', IN_MIDDLE, { taken: CROSS })]), 'select-cross-shuffled');
    expect(reading.absent).toBe(1);
    expect(reading.recorded).toBe(2);
    expect(reading.strata.map((entry) => entry.cases)).toEqual([1]);
  });

  it('leaves a case without a candidate record outside every stratum', () => {
    const reading = slotStrata(artifact([row('q1', undefined), row('q2', IN_MIDDLE, { taken: CROSS })]), 'select-cross-shuffled');
    expect(reading.scored).toBe(2);
    expect(reading.recorded).toBe(1);
    expect(reading.strata.map((entry) => entry.cases)).toEqual([1]);
  });

  it('ignores the cases another arm scored', () => {
    const reading = slotStrata(artifact([row('q1', IN_MIDDLE, { taken: CROSS, arm: 'select-cross' })]), 'select-cross-shuffled');
    expect(reading.scored).toBe(0);
    expect(reading.strata).toEqual([]);
  });

  it('reports a record that puts one source in two slots instead of picking one', () => {
    const doubled: readonly string[] = [CROSS, METADATA, CROSS];
    const reading = slotStrata(artifact([row('q1', doubled, { taken: CROSS })]), 'select-cross-shuffled');
    expect(reading.strata).toEqual([]);
    expect(reading.problems).toEqual(['case q1 records `inline+evidence@second` in slots 0 and 2, so the case has no single position']);
  });

  it('says an artifact written before the record cannot be read for position', () => {
    const reading = slotStrata(artifact([row('q1', undefined), row('q2', undefined)]), 'select-cross-shuffled');
    expect(reading.recorded).toBe(0);
    expect(reading.problems).toEqual([
      'select-cross-shuffled carries no candidate record in this artifact, so no slot can be read — the run predates the field',
    ]);
    expect(reportLines(reading)[0]).toBe(
      'select-cross-shuffled on dev: 2 scored, 0 with a candidate record, 0 carried `inline+evidence@second` in 0 slot(s), 0 did not',
    );
  });

  it('reads an arm the artifact never scored as empty rather than as an error', () => {
    const reading = slotStrata({}, 'select-cross-shuffled');
    expect(reading.scored).toBe(0);
    expect(reading.split).toBe('unknown');
    expect(reading.problems).toEqual([]);
  });

  it('tracks the source it was told to, not a hard-coded one', () => {
    const reading = slotStrata(artifact([row('q1', [METADATA, CROSS], { taken: METADATA })]), 'select-cross-shuffled', METADATA);
    expect(reading.tracked).toBe(METADATA);
    expect(reading.strata.map((entry) => [entry.slot, entry.took])).toEqual([[0, 1]]);
    expect(DEFAULT_TRACKED).toBe(CROSS);
  });
});

describe('the intervals', () => {
  it('matches a published Wilson example', () => {
    // 81 of 263, the textbook illustration: (0.2553, 0.3662).
    const interval = wilson(81, 263);
    expect(interval.low).toBeCloseTo(0.2553, 3);
    expect(interval.high).toBeCloseTo(0.3662, 3);
  });

  it('keeps a width at the edges, where the textbook interval collapses to zero', () => {
    // This is the case that decides the reading: a slot taken 0 times or every time. A Wald
    // interval would report certainty from one case.
    expect(wilson(0, 1)).toEqual({ low: 0, high: 0.7934506856227626 });
    expect(wilson(1, 1).high).toBe(1);
    expect(wilson(1, 1).low).toBeCloseTo(0.2065, 3);
    expect(wilson(0, 40).high).toBeCloseTo(0.0876, 3);
  });

  it('is antisymmetric in the difference it reports', () => {
    const left = slotStrata(artifact(stratum(0, 40, 30, 'a')), 'select-cross-shuffled').strata[0];
    const right = slotStrata(artifact(stratum(1, 40, 10, 'b')), 'select-cross-shuffled').strata[0];
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    const forward = differenceInterval(left!, right!);
    const backward = differenceInterval(right!, left!);
    expect(forward.low).toBeCloseTo(-backward.high, 10);
    expect(forward.high).toBeCloseTo(-backward.low, 10);
  });
});

describe('the comparison', () => {
  it('separates two strata that are far apart', () => {
    const comparison = compared(slotStrata(artifact([...stratum(0, 100, 80, 'a'), ...stratum(1, 100, 20, 'b')]), 'select-cross-shuffled'));
    expect(comparison.verdict).toBe('separated');
    expect(comparison.high.slot).toBe(0);
    expect(comparison.low.slot).toBe(1);
    expect(comparison.spreadPp).toBeCloseTo(60, 6);
    expect(comparison.interval.low).toBeGreaterThan(0);
  });

  it('refuses to separate two strata whose intervals overlap', () => {
    const comparison = compared(slotStrata(artifact([...stratum(0, 100, 40, 'a'), ...stratum(1, 100, 50, 'b')]), 'select-cross-shuffled'));
    expect(comparison.verdict).toBe('overlapping');
    expect(comparison.interval.low).toBeLessThan(0);
    expect(comparison.interval.high).toBeGreaterThan(0);
  });

  it('picks the extreme strata by share, not by slot number', () => {
    // A shuffle makes the slot that holds the second model's statement vary per question, so
    // there is no privileged pair to name. The pair reported is whichever two are furthest
    // apart — the largest difference in the table, which is also the most conservative one to
    // test, since a run that separates these separates every other pair as well.
    const comparison = compared(slotStrata(artifact([...stratum(0, 100, 20, 'a'), ...stratum(2, 100, 80, 'b')]), 'select-cross-shuffled'));
    expect(comparison.verdict).toBe('separated');
    expect(comparison.high.slot).toBe(2);
    expect(comparison.low.slot).toBe(0);
    expect(comparison.spreadPp).toBeCloseTo(60, 6);
  });

  it('says a single stratum cannot be compared at all', () => {
    const comparison = compare(slotStrata(artifact(stratum(0, 30, 15, 'a')), 'select-cross-shuffled'));
    expect(comparison).toEqual({ verdict: 'single-slot' });
    // Absent rather than zero: a `spreadPp: 0` here would be a measured-looking number for a
    // comparison that never happened.
    expect('spreadPp' in comparison).toBe(false);
    expect('interval' in comparison).toBe(false);
  });

  it('breaks a tie between equal shares by slot, so the table does not depend on row order', () => {
    const comparison = compared(slotStrata(artifact([...stratum(2, 20, 10, 'c'), ...stratum(0, 20, 10, 'a')]), 'select-cross-shuffled'));
    expect(comparison.verdict).toBe('overlapping');
    expect(comparison.spreadPp).toBe(0);
    expect([comparison.high.slot, comparison.low.slot]).toEqual([0, 2]);
  });
});

describe('the sentence', () => {
  it('prices a separated gap and says the position moves the choice', () => {
    const text = conclusion(slotStrata(artifact([...stratum(0, 100, 80, 'a'), ...stratum(1, 100, 20, 'b')]), 'select-cross-shuffled'));
    expect(text).toContain('was returned on 80.0% of its 100 cases in slot 0 and on 20.0% of its 100 cases in slot 1');
    expect(text).toContain('a gap of +60.0pp with an interval of +47.4pp to +69.4pp');
    expect(text).toContain('the position of the statement changes how often it is taken');
  });

  it('refuses to read a difference out of an interval that contains zero', () => {
    const text = conclusion(slotStrata(artifact([...stratum(0, 100, 40, 'a'), ...stratum(1, 100, 50, 'b')]), 'select-cross-shuffled'));
    expect(text).toContain('The interval does not exclude zero, so this run does not separate the slot from the author');
    expect(text).toContain('which is not the same as showing they are the same');
  });

  it('says an unshuffled arm answers both readings at once', () => {
    // The whole reason the tool exists: `select-cross` alone cannot separate them, and this
    // sentence has to say so rather than print a percentage that looks like a finding.
    const text = conclusion(slotStrata(artifact(stratum(0, 40, 21, 'a', 'select-cross')), 'select-cross'));
    expect(text).toBe(
      'Every case put `inline+evidence@second` in slot 0, so this artifact cannot separate the slot from the author: ' +
        'an arm that never moves the statement gives the same number for both readings, and only a shuffled arm can tell them apart.',
    );
  });

  it('answers an arm that does not draw the source at all with an absence', () => {
    const text = conclusion(slotStrata(artifact([row('q1', [METADATA, VALUES], { taken: VALUES })]), 'select-cross-shuffled'));
    expect(text).toBe(
      'None of the 1 recorded cases of select-cross-shuffled carries `inline+evidence@second`, so this arm does not draw that source at all.',
    );
  });

  it('answers an artifact with no record with an absence rather than a uniform zero', () => {
    expect(conclusion(slotStrata(artifact([row('q1', undefined)]), 'select-cross-shuffled'))).toBe(
      'select-cross-shuffled carries no candidate record, so which slot `inline+evidence@second` sat in is unanswered rather than uniform.',
    );
  });

  it('answers an artifact whose every record is self-contradictory with the problems, not a table', () => {
    const doubled: readonly string[] = [CROSS, CROSS];
    const text = conclusion(slotStrata(artifact([row('q1', doubled)]), 'select-cross-shuffled'));
    expect(text).toBe(
      'No case of select-cross-shuffled puts `inline+evidence@second` in one slot, so there is nothing to stratify — the problems below say why.',
    );
  });
});

describe('the table', () => {
  it('prints one row per slot with its denominator and both intervals', () => {
    const lines = reportLines(slotStrata(artifact([...stratum(0, 100, 80, 'a'), ...stratum(1, 100, 20, 'b')]), 'select-cross-shuffled')).join('\n');
    expect(lines).toContain(
      'select-cross-shuffled on dev: 200 scored, 200 with a candidate record, 200 carried `inline+evidence@second` in 2 slot(s), 0 did not',
    );
    expect(lines).toContain('| 0 | 100 | 80.0% | 71.1% to 86.7% | 80.0% | 71.1% to 86.7% |');
    expect(lines).toContain('| 1 | 100 | 20.0% | 13.3% to 28.9% | 20.0% | 13.3% to 28.9% |');
  });

  it('says how many cases carry a slot but no choice', () => {
    const lines = reportLines(
      slotStrata(artifact([row('q1', IN_MIDDLE, { taken: CROSS }), row('q2', IN_MIDDLE), row('q3', IN_FIRST)]), 'select-cross-shuffled'),
    ).join('\n');
    expect(lines).toContain('2 of 3 cases carry no winner label, so their slot is known and the arm\'s choice is not');
  });

  it('prints the problems under the sentence rather than instead of it', () => {
    const lines = reportLines(
      slotStrata(artifact([row('q1', IN_MIDDLE, { taken: CROSS }), row('q2', [CROSS, CROSS])]), 'select-cross-shuffled'),
    ).join('\n');
    expect(lines).toContain('problem: case q2 records `inline+evidence@second` in slots 0 and 1');
    expect(lines).toContain('Every case put `inline+evidence@second` in slot 1');
  });
});

describe('the entry, run the way a reader runs it', () => {
  it('knows when it is the entry point, including when there is no argv at all', () => {
    const own = pathToFileURL(join(ROOT, 'eval/bird/position.ts')).href;
    expect(isEntry(join(ROOT, 'eval/bird/position.ts'), own)).toBe(true);
    expect(isEntry(join(ROOT, 'eval/bird/losses.ts'), own)).toBe(false);
    expect(isEntry(undefined, own)).toBe(false);
  });

  it('takes the artifact from the flag, then the environment, then the report path', () => {
    expect(resolvePositionSettings(['--arm', 'x', '--report', 'x.json'], {}, ROOT).reportPath).toBe(resolve(ROOT, 'x.json'));
    expect(resolvePositionSettings(['--arm', 'x'], { BIRD_REPORT: 'y.json' }, ROOT).reportPath).toBe(resolve(ROOT, 'y.json'));
    expect(resolvePositionSettings(['--arm', 'x'], {}, ROOT).reportPath).toBe(resolve(ROOT, 'eval/out/bird-eval.json'));
  });

  it('defaults the tracked source and lets a run override it', () => {
    expect(resolvePositionSettings(['--arm', 'x'], {}, ROOT).tracked).toBe(DEFAULT_TRACKED);
    expect(resolvePositionSettings(['--arm', 'x', '--source', METADATA], {}, ROOT).tracked).toBe(METADATA);
  });

  it('refuses to guess which arm to read', () => {
    expect(() => resolvePositionSettings([], {}, ROOT)).toThrow(
      'usage: position.ts --arm <arm> [--source <candidate source>] [--report <artifact>]',
    );
  });

  it('prints the strata for a real file and exits 0', () => {
    const path = join(scratch, 'good.json');
    writeFileSync(path, JSON.stringify({ split: 'dev', cases: [...stratum(0, 100, 80, 'a'), ...stratum(1, 100, 20, 'b')] }));
    const out = execFileSync('npx', ['tsx', 'eval/bird/position.ts', '--arm', 'select-cross-shuffled', '--report', path], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(out).toContain('| 0 | 100 | 80.0% |');
    expect(out).toContain('The interval excludes zero');
  });

  it('prints the table and then fails when the file contradicts itself', () => {
    const path = join(scratch, 'doubled.json');
    writeFileSync(path, JSON.stringify({ split: 'dev', cases: [row('q1', [CROSS, CROSS])] }));
    const printed = execFileSync('sh', ['-c', `npx tsx eval/bird/position.ts --arm select-cross-shuffled --report ${path} 2>&1 || true`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(printed).toContain('so the case has no single position');
  });

  it('runs main in process, so the same code path is covered without a subprocess', async () => {
    const path = join(scratch, 'main.json');
    writeFileSync(path, JSON.stringify({ split: 'dev', cases: stratum(0, 20, 10, 'a') }));
    await expect(main(['--arm', 'select-cross-shuffled', '--report', path], {}, ROOT)).resolves.toBeUndefined();
    writeFileSync(path, JSON.stringify({ split: 'dev', cases: [row('q1', undefined)] }));
    await expect(main(['--arm', 'select-cross-shuffled', '--report', path], {}, ROOT)).rejects.toThrow('carries no candidate record');
  });
});
