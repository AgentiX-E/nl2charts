/**
 * Spider's first reading, checked against its own counts and its own anatomy.
 *
 * Two things in this file can only be wrong in ways a percentage cannot show: a denominator that
 * excludes the statements the parser refused, and a failure anatomy whose classes do not add up to
 * the refusals. Both are asserted here, because both are what a later arm will be measured against.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Arm {
  readonly arm: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly asked: number;
  readonly scored: number;
  readonly exact: number;
  readonly exactPct: number;
  readonly predErrors: number;
  readonly yuan: number;
  readonly run: number;
}

interface Baseline {
  readonly promptVersion: string;
  readonly arm: string;
  readonly metric: string;
  readonly asked: number;
  readonly scored: number;
  readonly exact: number;
  readonly exactPct: number;
  readonly predErrors: number;
  readonly goldErrors: number;
  readonly arms: readonly Arm[];
  readonly unparseable: {
    readonly total: number;
    readonly bareAlias: number;
    readonly valueListIn: number;
    readonly selectAlias: number;
    readonly outerJoin: number;
    readonly other: number;
  };
}

const BASELINE = JSON.parse(readFileSync('eval/baseline/spider.json', 'utf8')) as Baseline;

describe('the Spider baseline is a citation, so its arithmetic has to close', () => {
  it('states a percentage its own counts produce', () => {
    expect(BASELINE.exactPct).toBeCloseTo((100 * BASELINE.exact) / BASELINE.scored, 2);
    expect(BASELINE.exact).toBe(593);
    expect(BASELINE.scored).toBe(1_034);
    expect(BASELINE.exactPct).toBe(57.35);
  });

  it('keeps the refused statements in the denominator, because Spider scores them zero', () => {
    // 185 statements the reference parser would not read. Dropping them would report 593 of 849 —
    // 69.9% — which is a fact about the parser's input rather than about the model.
    expect(BASELINE.predErrors).toBe(185);
    expect(BASELINE.scored).toBe(BASELINE.asked);
    expect(BASELINE.goldErrors).toBe(0);
  });

  it('says which metric it is, because a skeleton cannot answer a SELECT for real', () => {
    expect(BASELINE.metric).toContain('exact match');
    expect(BASELINE.metric).toContain('execution accuracy is out of reach');
  });

  it('adds its failure anatomy up to the refusals it reports', () => {
    const anatomy = BASELINE.unparseable;
    expect(
      anatomy.bareAlias + anatomy.valueListIn + anatomy.selectAlias + anatomy.outerJoin + anatomy.other,
    ).toBe(anatomy.total);
    expect(anatomy.total).toBe(BASELINE.predErrors);
    // The four grammar classes are what the `grammar` arm prices; if this number moved, that arm is
    // arguing about a smaller thing than it says it is.
    expect(anatomy.bareAlias + anatomy.valueListIn + anatomy.selectAlias + anatomy.outerJoin).toBe(137);
  });

  it('records both tiers as counts that produce their own percentage', () => {
    const chat = BASELINE.arms.find((arm) => arm.model === 'deepseek-chat');
    const reasoner = BASELINE.arms.find((arm) => arm.model === 'deepseek-reasoner');
    for (const arm of BASELINE.arms) expect(arm.exactPct).toBeCloseTo((100 * arm.exact) / arm.scored, 2);
    expect(chat?.exact).toBe(593);
    expect(reasoner?.exact).toBe(524);
    // The tier with the larger bill refused more statements, not fewer: the difference between the
    // two rows is dialect before it is reasoning, and the record has to make that visible.
    expect(reasoner?.predErrors).toBeGreaterThan(chat?.predErrors as number);
    expect(reasoner?.yuan).toBeGreaterThan(chat?.yuan as number);
  });
});
