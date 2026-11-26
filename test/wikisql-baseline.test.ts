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

  it('says in its own note what a reader would otherwise have to infer', () => {
    expect(BASELINE.note).toContain('dev split');
    expect(BASELINE.note).toContain('no training');
    expect(BASELINE.note).toContain('`exact` and `bag` are the same count');
  });
});
