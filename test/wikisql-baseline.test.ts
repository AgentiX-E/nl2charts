/**
 * The WikiSQL reading, checked against itself.
 *
 * A baseline file is a citation: every later arm is a delta against it, and a percentage that its own
 * counts do not produce is a citation to nothing. Three things are asserted here and nothing else —
 * the arithmetic, the subject (which prompt, which model, which split), and the one number that says
 * the leaderboard's ordered comparison is not the reason for the score.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BENCHMARKS, resolveReading } from '../eval/benchmarks.js';
import { PROMPT_VERSION } from '../eval/wikisql/ask.js';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (file: string): unknown => JSON.parse(readFileSync(join(ROOT, file), 'utf8'));

interface Baseline {
  readonly instrument: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly split: string;
  readonly asked: number;
  readonly scored: number;
  readonly exact: number;
  readonly exactPct: number;
  readonly bag: number;
  readonly predErrors: number;
  readonly unreadable: number;
  readonly calls: number;
  readonly yuan: number;
  readonly run: number;
  readonly note: string;
  readonly arms: readonly {
    readonly arm: string;
    readonly promptVersion: string;
    readonly sampleRows: number;
    readonly asked: number;
    readonly scored: number;
    readonly exact: number;
    readonly exactPct: number;
    readonly yuan: number;
    readonly run: number;
    readonly model?: string;
  }[];
  readonly paired: readonly {
    readonly first: string;
    readonly second: string;
    readonly cases: number;
    readonly onlyFirst: number;
    readonly onlySecond: number;
    readonly deltaPp: number;
    readonly lowPp: number;
    readonly highPp: number;
    readonly p: number;
    readonly verdict: string;
  }[];
}

const BASELINE = read('eval/baseline/wikisql.json') as Baseline;

describe('the WikiSQL baseline is a citation, so its arithmetic has to close', () => {
  it('states a percentage its own counts produce', () => {
    expect(BASELINE.exactPct).toBeCloseTo((100 * BASELINE.exact) / BASELINE.scored, 2);
    expect(BASELINE.exact).toBe(7_183);
    expect(BASELINE.scored).toBe(8_421);
    expect(BASELINE.exactPct).toBe(85.3);
  });

  it('keeps the failed statements in the denominator rather than beside it', () => {
    // 14 statements did not execute. They are cases that were asked and answered wrongly, so a
    // reading that dropped them would report 7,183 of 8,407.
    expect(BASELINE.predErrors).toBe(14);
    expect(BASELINE.scored).toBe(BASELINE.asked);
    expect(BASELINE.unreadable).toBe(0);
  });

  it('reads the same score under the leaderboard comparison and under a bag one', () => {
    // `exact` is the reference's ordered comparison of `fetchall()` tuples and `bag` erases order.
    // They agree here, which is the useful half of the row: no statement was right in content and
    // wrong in row order. A reader who wants to know whether the ordered comparison is costing us
    // anything reads this line rather than an argument.
    expect(BASELINE.bag).toBe(BASELINE.exact);
  });

  it('names the prompt, the model and the split, because a score without them is a rumour', () => {
    expect(BASELINE.promptVersion).toBe(PROMPT_VERSION);
    expect(BASELINE.instrument).toBe('eval/wikisql/ask.ts');
    expect(BASELINE.model).toBe('deepseek-chat');
    expect(BASELINE.split).toBe('dev');
    expect(BASELINE.calls).toBe(BASELINE.asked);
    expect(BASELINE.yuan).toBeGreaterThan(0);
    expect(Number.isInteger(BASELINE.run)).toBe(true);
  });

  it('is the row the coverage table prints, not a number that lives only in a document', () => {
    const row = BENCHMARKS.find((candidate) => candidate.id === 'wikisql');
    expect(row?.status).toBe('measured');
    expect(row?.reading?.file).toBe('eval/baseline/wikisql.json');
    const reading = row?.reading;
    if (reading === undefined) throw new Error('the wikisql row cites no reading');
    expect(resolveReading(reading, (file) => read(file))).toBe(85.3);
  });

  it('records each arm as counts that produce its own percentage', () => {
    // The rule the top-level row obeys, applied to every arm under it: a percentage that its own
    // counts cannot produce is a number nobody can correct in a year.
    for (const arm of BASELINE.arms) {
      expect(arm.exactPct).toBeCloseTo((100 * arm.exact) / arm.scored, 2);
      expect(arm.scored).toBeLessThanOrEqual(arm.asked);
    }
    const schema = BASELINE.arms.find((arm) => arm.arm === 'schema');
    expect(schema?.exact).toBe(6_899);
    expect(schema?.exactPct).toBe(81.93);
    expect(schema?.sampleRows).toBe(0);
    // Cheaper and worse, in that order and in the record: the ablation is a trade, not a defect.
    expect(schema?.yuan).toBeLessThan(BASELINE.yuan);
  });

  it('records the paired difference, not the distance between two percentages', () => {
    const row = BASELINE.paired.find((pair) => pair.second === 'schema');
    expect(row).toBeDefined();
    if (row === undefined) throw new Error('no paired row for the schema arm');
    expect(row.cases).toBe(8_421);
    // The cells must add up to the cases, or the interval was computed over a denominator that was
    // not the run.
    expect(row.cases).toBe(6_656 + row.onlyFirst + row.onlySecond + 995);
    expect(row.deltaPp).toBeCloseTo((100 * (row.onlySecond - row.onlyFirst)) / row.cases, 2);
    expect(row.lowPp).toBeLessThan(row.deltaPp);
    expect(row.highPp).toBeGreaterThan(row.deltaPp);
    expect(row.verdict).toContain('3.37pp');
  });

  it('records the reasoning-tier comparison as unresolved rather than as a win', () => {
    const row = BASELINE.paired.find((pair) => pair.second === 'values@reasoner');
    expect(row?.cases).toBe(800);
    // An interval that holds zero is the finding: on a corpus of values the tier buys nothing
    // measurable, and the record says so with the width that made it unsayable.
    expect(row?.lowPp).toBeLessThan(0);
    expect(row?.highPp).toBeGreaterThan(0);
    expect(row?.p).toBeGreaterThan(0.5);
    expect(row?.verdict).toContain('indistinguishable');
  });

  it('says in its own note what a reader would otherwise have to infer', () => {
    expect(BASELINE.note).toContain('dev split');
    expect(BASELINE.note).toContain('no training');
    expect(BASELINE.note).toContain('`exact` and `bag` are the same count');
  });
});
