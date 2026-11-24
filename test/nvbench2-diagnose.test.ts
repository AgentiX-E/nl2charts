import { describe, expect, it } from 'vitest';
import {
  ASPECTS, compareAspects, diagnose, nearest, withoutCountFields, type Aspect,
} from '../eval/nvbench2/diagnose.js';
import { canonical, normalizeOrder, type Case, type Chart, type FieldTypes } from '../eval/nvbench2/judge.js';

const TYPES: FieldTypes = { paperid: 'quantitative', authorder: 'quantitative', name: 'category' };

/** A gold as the corpus writes one: no `type`, keys in the corpus's own order. */
const GOLD: Chart = {
  mark: 'line',
  encoding: { y: { field: 'authorder', aggregate: 'mean' }, x: { field: 'paperid' } },
};

const normal = (chart: Chart): Chart => normalizeOrder(chart);

const FIRST_DIFFERENCE = (prediction: Chart, gold: Chart): Aspect | null =>
  compareAspects(normal(prediction), normal(gold)).first;

describe('compareAspects', () => {
  it('says two identical charts part nowhere, and all seven groups agree', () => {
    const comparison = compareAspects(normal(GOLD), normal(GOLD));
    expect(comparison.equal).toBe(true);
    expect(comparison.first).toBeNull();
    expect(Object.values(comparison.aspects)).toEqual([true, true, true, true, true, true, true]);
  });

  it('agrees with `canonical` on what equal means, group by group', () => {
    // The invariant the module promises: the seven groups partition a normalised chart, so
    // `first === null` and "the canonical forms are equal" are the same statement. Checked against
    // charts that differ in each group rather than asserted from the shape of the code.
    const variants: Chart[] = [
      GOLD,
      { ...GOLD, mark: 'bar' },
      { ...GOLD, encoding: { y: { field: 'authorder', aggregate: 'mean' } } },
      { ...GOLD, encoding: { y: { field: 'authorder', aggregate: 'mean' }, x: { field: 'name' } } },
      { ...GOLD, encoding: { y: { field: 'authorder' }, x: { field: 'paperid' } } },
      { ...GOLD, encoding: { y: { field: 'authorder', aggregate: 'mean', type: 'quantitative' }, x: { field: 'paperid' } } },
      { ...GOLD, transform: [{ filter: { field: 'authorder', gte: 2 } }] },
      { ...GOLD, title: 'author order' },
    ];
    for (const left of variants) {
      for (const right of variants) {
        const normalisedLeft = normal(left);
        const normalisedRight = normal(right);
        expect(compareAspects(normalisedLeft, normalisedRight).equal)
          .toBe(canonical(normalisedLeft) === canonical(normalisedRight));
      }
    }
  });

  it('names `properties` when the only difference is a channel `type` — the corpus keeps none', () => {
    // The corpus's 6,044 dev channel slots carry `field`, `aggregate`, `bin`, `sort` and `timeUnit`
    // and never `type`; a reply written the way the Vega-Lite documentation writes one does. That is
    // a harness fact, so it must be reported as `properties` rather than as a wrong column.
    const reply: Chart = {
      mark: 'line',
      encoding: {
        y: { field: 'authorder', aggregate: 'mean', type: 'quantitative' },
        x: { field: 'paperid', type: 'quantitative' },
      },
    };
    const comparison = compareAspects(normal(reply), normal(GOLD));
    expect(comparison.equal).toBe(false);
    expect(comparison.first).toBe('properties');
    expect(comparison.aspects.field).toBe(true);
    expect(comparison.aspects.aggregate).toBe(true);
    expect(comparison.aspects.mark).toBe(true);
  });

  it('names the group the reference would have caught first, not the last one', () => {
    expect(FIRST_DIFFERENCE({ ...GOLD, mark: 'bar', title: 'x' }, GOLD)).toBe('mark');
    expect(FIRST_DIFFERENCE({ mark: 'line', encoding: { x: { field: 'paperid' } } }, GOLD)).toBe('channels');
    expect(FIRST_DIFFERENCE({ ...GOLD, encoding: { y: { field: 'name', aggregate: 'mean' }, x: { field: 'paperid' } } }, GOLD))
      .toBe('field');
    expect(FIRST_DIFFERENCE({ ...GOLD, encoding: { y: { field: 'authorder' }, x: { field: 'paperid' } } }, GOLD))
      .toBe('aggregate');
    expect(FIRST_DIFFERENCE({ ...GOLD, transform: [{ filter: { field: 'authorder', gte: 3 } }] }, GOLD))
      .toBe('transform');
    expect(FIRST_DIFFERENCE({ ...GOLD, title: 'author order' }, GOLD)).toBe('rest');
  });

  it('treats a non-object slot and an absent key as the same absence', () => {
    // `normalizeOrder` leaves `{ x: 'name' }` behind as `{ x: {} }`, which is the shape a
    // half-written reply produces. It must compare as "no field", not crash the diagnostic.
    const broken: Chart = { mark: 'line', encoding: { x: 'paperid', y: { field: 'authorder', aggregate: 'mean' } } };
    const comparison = compareAspects(normal(broken), normal(GOLD));
    expect(comparison.equal).toBe(false);
    expect(comparison.aspects.channels).toBe(true);
    expect(comparison.aspects.field).toBe(false);
  });

  it('reads a channel whose encoding is not an object at all as no channels', () => {
    const noEncoding: Chart = normalizeOrder({ mark: 'line', encoding: 'nonsense' });
    expect(compareAspects(noEncoding, normal(GOLD)).aspects.channels).toBe(false);
    // And `channelsOf` on a chart with no `encoding` key at all: both read as the empty set, which
    // is why the two are reported as agreeing on `channels` and parting on `mark`.
    expect(compareAspects(normalizeOrder({}), noEncoding).aspects.channels).toBe(true);
  });
});

describe('nearest', () => {
  it('picks the gold that agrees on the most groups, and the first one on a tie', () => {
    const sameMark: Chart = { mark: 'line', encoding: { x: { field: 'name' }, y: { field: 'paperid' } } };
    const sameFields: Chart = { mark: 'bar', encoding: { y: { field: 'authorder', aggregate: 'mean' }, x: { field: 'paperid' } } };
    const reply: Chart = normal({ mark: 'line', encoding: { y: { field: 'authorder', aggregate: 'mean' }, x: { field: 'paperid' } } });
    expect(nearest(reply, [normal(sameMark), normal(sameFields)])).toEqual(normal(sameFields));
    const tied: Chart = { mark: 'line', encoding: { x: { field: 'a' }, y: { field: 'b' } } };
    const other: Chart = { mark: 'line', encoding: { x: { field: 'c' }, y: { field: 'd' } } };
    expect(nearest(normal(tied), [normal(tied), normal(other)])).toEqual(normal(tied));
  });
});

describe('withoutCountFields', () => {
  it('drops the column a count names and keeps everything else', () => {
    const counted = normal({ mark: 'arc', encoding: { theta: { field: 'paperid', aggregate: 'count' }, color: { field: 'name' } } });
    expect(withoutCountFields(counted)).toEqual({
      mark: 'arc',
      encoding: { theta: { aggregate: 'count' }, color: { field: 'name' } },
    });
  });

  it('leaves a channel alone when its aggregate is not a count, or when it names no column', () => {
    const summed = normal({ mark: 'bar', encoding: { x: { field: 'amount', aggregate: 'sum' }, y: { aggregate: 'count' } } });
    expect(withoutCountFields(summed)).toEqual(summed);
  });

  it('returns a chart with no encoding unchanged', () => {
    const bare = normal({ mark: 'point' });
    expect(withoutCountFields(bare)).toBe(bare);
  });
});

describe('diagnose', () => {
  const caseOf = (predictions: unknown[], golds: unknown[] = [GOLD]): Case => ({
    predictions, golds, types: TYPES,
  });

  it('counts a matched prediction as matched and nothing else', () => {
    const diagnostic = diagnose([caseOf([GOLD, { ...GOLD, title: 'x' }])], 3);
    expect(diagnostic.predictions).toBe(2);
    expect(diagnostic.matched).toBe(1);
    // Only the unmatched one is described, so the groups sum to one rather than to two.
    expect(Object.values(diagnostic.first).reduce((sum, n) => sum + n, 0)).toBe(1);
    expect(diagnostic.first.rest).toBe(1);
    expect(diagnostic.agree.rest).toBe(0);
    expect(diagnostic.agree.mark).toBe(1);
  });

  it('examines only the top k, because a chart ranked below k was never scored', () => {
    const far: Chart = { mark: 'bar', encoding: { x: { field: 'name' } } };
    const diagnostic = diagnose([caseOf([GOLD, far, far])], 1);
    expect(diagnostic.predictions).toBe(1);
    expect(diagnostic.matched).toBe(1);
    const top2 = diagnose([caseOf([GOLD, far, far])], 2);
    expect(top2.predictions).toBe(2);
    expect(top2.first.mark).toBe(1);
  });

  it('skips a question with no gold, and one whose golds do not normalise', () => {
    const diagnostic = diagnose([
      caseOf([GOLD], []),
      caseOf([GOLD], ['not a chart']),
      caseOf([GOLD]),
    ], 3);
    expect(diagnostic.predictions).toBe(1);
    expect(diagnostic.matched).toBe(1);
  });

  it('skips a prediction that is not a chart, and counts the ones that are', () => {
    const diagnostic = diagnose([caseOf([42, 'chart', null, GOLD])], 5);
    expect(diagnostic.predictions).toBe(1);
    expect(diagnostic.matched).toBe(1);
  });

  it('counts a miss that is one convention from a hit as a count-fieldless miss, and still counts the miss', () => {
    // The gold counts rows; the reply counts rows and names the column it counts. The reading must
    // stay 0 — the reference is the reference — and the probe must say why.
    const gold: Chart = { mark: 'arc', encoding: { theta: { aggregate: 'count' }, color: { field: 'name' } } };
    const reply: Chart = { mark: 'arc', encoding: { theta: { field: 'name', aggregate: 'count' }, color: { field: 'name' } } };
    const diagnostic = diagnose([{ predictions: [reply], golds: [gold], types: TYPES }], 1);
    expect(diagnostic.matched).toBe(0);
    expect(diagnostic.countFieldless).toBe(1);
    expect(diagnostic.first.field).toBe(1);
  });

  it('does not call a genuinely different column a count-fieldless miss', () => {
    const gold: Chart = { mark: 'arc', encoding: { theta: { aggregate: 'count' }, color: { field: 'name' } } };
    const reply: Chart = { mark: 'arc', encoding: { theta: { field: 'paperid', aggregate: 'count' }, color: { field: 'authorder' } } };
    expect(diagnose([{ predictions: [reply], golds: [gold], types: TYPES }], 1).countFieldless).toBe(0);
  });

  it('reports an empty split as nothing examined rather than dividing by zero', () => {
    const diagnostic = diagnose([], 3);
    expect(diagnostic.predictions).toBe(0);
    expect(diagnostic.matched).toBe(0);
    expect(Object.keys(diagnostic.first)).toEqual([...ASPECTS]);
  });

  it('describes the whole split when every prediction is wrong in the same way', () => {
    const typed: Chart = {
      mark: 'line',
      encoding: {
        y: { field: 'authorder', aggregate: 'mean', type: 'quantitative' },
        x: { field: 'paperid', type: 'quantitative' },
      },
    };
    const diagnostic = diagnose([caseOf([typed]), caseOf([typed])], 3);
    expect(diagnostic.predictions).toBe(2);
    expect(diagnostic.matched).toBe(0);
    expect(diagnostic.first.properties).toBe(2);
    expect(diagnostic.agree.field).toBe(2);
    expect(diagnostic.agree.mark).toBe(2);
  });
});
