import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The repair decomposition, held to the numbers the document quotes.
 *
 * This is a falsifier rather than a formality. Round 188 ended with a queue item whose whole case
 * was "`field` is the largest face", priced at ¥40, and the prior behind it was that three prompt
 * changes had failed to move `first.field` (794 -> 800 on the chat tier while `channels` fell
 * 482 -> 414), so the face was probably unrepairable. The counter says the opposite: 70.3% of the
 * reasoning tier's field-first misses are a column the model *did* choose and put in the wrong
 * place or in place of another gold. A plan written on the prior would have spent ¥40 on a fourth
 * prompt rule; the decomposition says the instrument is coverage, not instruction.
 *
 * The numbers are pinned because the sentence in `docs/benchmarks.md` and in the plans is pinned to
 * them. A rule that moves any of the five buckets has to move this file, the document and the plan
 * in one commit — which is the only reason a number in a document stays true.
 */
const METRICS = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../eval/nvbench2/metrics.json'), 'utf8'),
) as {
  arms: {
    repairs: {
      arm: string;
      model: string;
      split: string;
      questions: number;
      predictions: number;
      fieldFirst: number;
      fieldRepair: {
        elsewhere: number;
        misplaced: number;
        unused: number;
        offSchema: number;
        absent: number;
      };
      repairable: number;
      repairableShare: number;
      run: number;
    };
    layers: { reasoning: { best: string; model: string } };
  };
};

const REPAIRS = METRICS.arms.repairs;

describe('the repair decomposition of a field-first miss', () => {
  it('names the arm and the tier the numbers came from, and they are the shipped ones', () => {
    expect(REPAIRS.arm).toBe(METRICS.arms.layers.reasoning.best);
    expect(REPAIRS.model).toBe(METRICS.arms.layers.reasoning.model);
    expect(REPAIRS.split).toBe('dev');
    expect(REPAIRS.questions).toBe(750);
  });

  it('partitions the field-first misses rather than sampling them', () => {
    const { fieldRepair, fieldFirst } = REPAIRS;
    const sum = Object.values(fieldRepair).reduce((total, count) => total + count, 0);
    expect(sum).toBe(fieldFirst);
    // 1,518 scored predictions on this arm, 465 of which part on the column first. Pinned because
    // the share is what the plan prices, and a replay that moves it is a reading that changed.
    expect(REPAIRS.predictions).toBe(1518);
    expect(fieldFirst).toBe(465);
  });

  it('keeps the three repairable causes equal to their own sum, and their share to 70.3%', () => {
    const { elsewhere, misplaced, absent } = REPAIRS.fieldRepair;
    expect(REPAIRS.repairable).toBe(elsewhere + misplaced + absent);
    expect(REPAIRS.repairable).toBe(327);
    expect(REPAIRS.repairableShare).toBeCloseTo(327 / 465, 4);
    expect(REPAIRS.repairableShare).toBeGreaterThan(0.7);
  });

  it('reports no hallucinated column, which is what makes a schema linker unnecessary here', () => {
    // A non-zero value would not be a failure of the corpus or the model; it would move the next
    // spend from `coverage` to `schema linking`, and this assertion is where that decision starts.
    expect(REPAIRS.fieldRepair.offSchema).toBe(0);
  });

  it('leaves the unrepairable bucket as the one a prompt could be blamed for', () => {
    // `unused` is the column-choice gap: the table has the column and no gold of the question uses
    // it. It is the only bucket a prompt rule can address, and it is 29.7% of the face — which is
    // why the next arm is a coverage change on the cheap tier and not a fourth instruction.
    expect(REPAIRS.fieldRepair.unused).toBe(138);
    expect(REPAIRS.fieldRepair.unused / REPAIRS.fieldFirst).toBeLessThan(0.3);
  });

  it('holds every bucket to a count that could have been produced by 750 questions', () => {
    for (const [cause, count] of Object.entries(REPAIRS.fieldRepair)) {
      expect(Number.isInteger(count), cause).toBe(true);
      expect(count, cause).toBeGreaterThanOrEqual(0);
      expect(count, cause).toBeLessThanOrEqual(REPAIRS.fieldFirst);
    }
  });

  it('cites the run the numbers were replayed from, so a reader can re-derive them for free', () => {
    // The dispatch answered nothing: 750 of 750 rows were replayed from the answer store, so the
    // bill was zero and the reading is the same 1,518 predictions the published arm scored.
    expect(REPAIRS.run).toBe(45509465255);
  });
});

describe('the spread and mirror readings, held to the sentences that quote them', () => {
  // Both nodes exist because a plan was written on a number nobody had decomposed. The spread node is
  // the falsifier: the queue item said one guess in seven was spent repeating a column, and 48 of
  // 1,518 is 3.2%. The mirror node is the salvage: 109 of the same 465 misses are one axis swap away
  // from a gold, and both intervals cross zero, so the flag stays out of the product's prompt.
  const metrics = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../eval/nvbench2/metrics.json'), 'utf8'),
  ) as {
    arms: {
      spread: { entries: number; repeatedEntries: number; repeatedShare: number; questions: number; goldColumns: number; predictedColumns: number; coveredColumns: number };
      mirrors: {
        fieldFirst: number; transposed: number; transposedShare: number;
        readings: { tier: string; base: number; arm: number; delta: number; low: number; high: number; separated: boolean; questions: number; yuan: number }[];
      };
      readings: Record<string, { f1: Record<string, number>; rules: readonly string[]; yuan: number }>;
    };
  };

  it('keeps the repeat count small enough that the mechanism it was meant to test cannot bind', () => {
    const { spread } = metrics.arms;
    expect(spread.repeatedEntries).toBe(48);
    expect(spread.entries).toBe(1518);
    expect(spread.repeatedShare).toBeCloseTo(48 / 1518, 4);
    // The claim in the document is "one entry in twenty", and it is the claim that closes the branch.
    expect(spread.repeatedShare).toBeLessThan(0.05);
    // Coverage is still worth reading: the reply touches 71% of the columns the golds use.
    expect(spread.coveredColumns / spread.goldColumns).toBeCloseTo(0.712, 2);
    expect(spread.predictedColumns / spread.questions).toBeLessThan(3);
  });

  it('keeps every mirror reading inside the noise, which is why the flag is not a default', () => {
    const { mirrors } = metrics.arms;
    expect(mirrors.transposed).toBe(109);
    expect(mirrors.fieldFirst).toBe(465);
    expect(mirrors.transposed).toBeLessThan(mirrors.fieldFirst);
    expect(mirrors.readings).toHaveLength(2);
    for (const reading of mirrors.readings) {
      expect(reading.separated).toBe(false);
      expect(reading.low).toBeLessThanOrEqual(0);
      expect(reading.delta).toBeCloseTo(reading.arm - reading.base, 6);
      expect(reading.questions).toBe(750);
      // Free to read: a replay of answers already paid for.
      expect(reading.yuan).toBe(0);
    }
  });

  it('records the spread arm as a loss, so a later round cannot call it untried', () => {
    const entry = metrics.arms.readings['count+ranks+corpus+corpus2+steps+spread'];
    expect(entry).toBeDefined();
    expect(entry!.rules).toContain('spread');
    expect(entry!.f1['3']).toBeCloseTo(0.2725, 4);
    const base = metrics.arms.readings['count+ranks+corpus+corpus2+steps'];
    // Measured against the arm it was stacked on, and lower: −0.86 with an interval that reaches +0.54.
    // That interval is paired against a re-read of the base, which came back 0.04 lower than the
    // published 28.16 (two dispatches of one prompt are not bit-identical); the difference between
    // the two published readings is 0.91, which is the number this pins.
    expect(entry!.f1['3']).toBeLessThan(base!.f1['3']!);
    expect(base!.f1['3']! - entry!.f1['3']!).toBeCloseTo(0.0091, 4);
  });
});
