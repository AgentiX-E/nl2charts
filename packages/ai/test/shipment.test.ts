/**
 * The gate that decides whether a better prompt is worth its price, tested on readings that happened.
 *
 * Every number in this file comes from an artifact: the 1,532-question dev run `44991167518` that put
 * the MAC-SQL prompt in the product (1,010 against 980, paired 119:89, p = 0.0441, 134 cache-miss
 * tokens a case against 587), and the second-base run `45040430602` that made thinking mode look
 * attractive (+1.37pp, paired 69:90, p = 0.112) while charging 9.7× the money. Those two are the two
 * verdicts the gate exists to produce, so they are the first two cases here: a rule that cannot
 * reproduce the decision the project already made by hand is a rule nobody should trust with the
 * next one.
 *
 * The remaining cases are the refusals, one per way a declaration can be wrong or a candidate can be
 * too small, too unlikely or too dear. Each is written as the smallest declaration that isolates one
 * branch, because a table of refusals is only useful if a reader can see which field caused which.
 */
import { describe, expect, it } from 'vitest';
import { ASSEMBLED_SQL, SHIPPED_SQL } from '../src/recipe.js';
import {
  adjudicateDecision,
  adjudicateShipment,
  DEFAULT_SHIPMENT_POLICY,
  shipmentLines,
} from '../src/shipment.js';
import type { ShipmentDecision, ShipmentPolicy } from '../src/shipment.js';

/** The shipped reading: the assembled skeleton against the MAC-SQL prompt, both on 1,532 questions. */
const SHIPPED_READING: ShipmentDecision = {
  run: '44991167518',
  dataset: 'bird-dev',
  incumbent: { arm: 'assembled', correct: 980, total: 1532, tokensPerCase: 587 },
  challenger: { arm: 'macsql-prompt', correct: 1010, total: 1532, tokensPerCase: 134 },
  paired: { onlyChallenger: 119, onlyIncumbent: 89 },
  p: 0.04408796929533684,
  // The bootstrap interval the reading published, in percentage points.
  ci: { low: 0.12, high: 3.8 },
  note: 'the MAC-SQL skeleton with this project card and no column hint',
};

/** A decision with one field replaced, so every case states exactly what it changes. */
function withDecision(patch: Partial<ShipmentDecision>): ShipmentDecision {
  return { ...SHIPPED_READING, ...patch };
}

describe('the policy', () => {
  it('states the three budgets the report quotes', () => {
    // Pinned because these numbers are the whole argument: a silent retune of the tariff would
    // change what the product pays without changing a single reading.
    expect(DEFAULT_SHIPMENT_POLICY).toEqual({ alpha: 0.05, minDeltaPp: 1, tokenTariff: 5 });
  });

  it('is overridable per call, and the override is what decides', () => {
    const strict: ShipmentPolicy = { alpha: 0.05, minDeltaPp: 2.5, tokenTariff: 5 };
    // The shipped reading is +1.96pp: worth shipping at a 1pp floor, not at a 2.5pp one.
    expect(adjudicateDecision(SHIPPED_READING).ship).toBe(true);
    expect(adjudicateDecision(SHIPPED_READING, strict).reasons).toEqual(['below-min-effect']);
  });
});

describe('the reading that put the MAC-SQL prompt in the product', () => {
  it('ships: significant, worth a point, and 4.4 times cheaper', () => {
    const verdict = adjudicateDecision(SHIPPED_READING);
    expect(verdict).toMatchObject({ ship: true, reasons: [], problems: [] });
    expect(verdict.deltaPp).toBeCloseTo(1.9582, 3);
    expect(verdict.costRatio).toBeCloseTo(134 / 587, 6);
    // A price ratio below one is not a discount the policy can spend: the requirement stays at the
    // effect floor rather than dropping below it.
    expect(verdict.requiredPp).toBe(1);
  });

  it('folds to the recipe the product ships', () => {
    const result = adjudicateShipment([SHIPPED_READING]);
    expect(result.recipe).toBe('shipped-sql');
    expect(result.recipe).toBe(SHIPPED_SQL.name);
    expect(result.moved).toBe(true);
    expect(result.steps).toHaveLength(1);
  });

  it('starts the chain on the assembled skeleton', () => {
    // The fold starts somewhere, and where it starts is a claim: before the reading, the product was
    // sending the assembled prompt. A chain whose first incumbent is anything else is a chain with an
    // unrecorded step.
    expect(ASSEMBLED_SQL.name).toBe('assembled');
    const broken = adjudicateShipment([withDecision({ incumbent: { ...SHIPPED_READING.incumbent, arm: 'macsql-prompt' } })]);
    expect(broken.recipe).toBe('assembled');
    expect(broken.moved).toBe(false);
    expect(broken.steps[0]?.reasons).toContain('inconsistent');
  });
});

/**
 * Run `45040430602`: the same prompt, the same 1,532 questions, the model allowed to deliberate.
 *
 * The counts and the p are the run's. The two prices are the run's too, in the unit the bill is
 * made of: 319 cache-miss tokens a case for the shipped arm (183 uncached prompt + 136 completion,
 * `45021178365`) and 9.7× that for the thinking cell, which is what the measured ¥0.0107 against
 * ¥0.0011 per question buys at the same token price.
 */
const MODE: ShipmentDecision = {
  run: '45040430602',
  dataset: 'bird-dev',
  incumbent: { arm: 'assembled', correct: 997, total: 1532, tokensPerCase: 319 },
  challenger: { arm: 'macsql-prompt', correct: 1018, total: 1532, tokensPerCase: 3094 },
  paired: { onlyChallenger: 90, onlyIncumbent: 69 },
  p: 0.11243011953493938,
  // Wald interval around +1.37pp, in percentage points: it crosses zero, which is the point.
  ci: { low: -0.30, high: 3.04 },
  note: 'the shipped prompt with thinking on, same questions, same base',
};

describe('the reading that made thinking mode look free', () => {

  it('is refused twice over: not significant, and 9.7 times the price', () => {
    const verdict = adjudicateDecision(MODE);
    expect(verdict.ship).toBe(false);
    expect(verdict.reasons).toEqual(['not-significant', 'too-expensive']);
    expect(verdict.deltaPp).toBeCloseTo(1.37, 2);
    expect(verdict.costRatio).toBeCloseTo(9.7, 1);
    // The tariff names the price in points: 5 points per extra 1× of cost, so 8.7× extra demands
    // 43.5 points and the candidate offers 1.37.
    expect(verdict.requiredPp).toBeCloseTo(43.5, 1);
  });

  it('would ship under a policy that ignored the bill, which is why the bill is in the policy', () => {
    // The single-metric rule, stated as a policy so the difference is arithmetic rather than an
    // argument: with the tariff set to zero the price objection disappears and significance alone
    // refuses; with the significance bar moved as well the same candidate is accepted at 43× the
    // price for 1.37 points.
    const affordable: ShipmentPolicy = { alpha: 0.05, minDeltaPp: 1, tokenTariff: 0 };
    expect(adjudicateDecision(MODE, affordable).reasons).toEqual(['not-significant']);
    const blind: ShipmentPolicy = { alpha: 0.2, minDeltaPp: 1, tokenTariff: 0 };
    const resolved: ShipmentDecision = { ...MODE, ci: { low: 0.01, high: 3.04 } };
    expect(adjudicateDecision(resolved, blind).ship).toBe(true);
  });

  it('leaves the product on the recipe it already ships', () => {
    const result = adjudicateShipment([MODE]);
    expect(result.recipe).toBe('assembled');
    expect(result.moved).toBe(false);
  });
});

describe('refusals that are about the candidate', () => {
  it('refuses a real effect that is smaller than a switch is worth', () => {
    // Ten cases better out of 1,532 is +0.65pp; ten answered only by the challenger is p = 0.0019,
    // so significance is not what refuses it. This is the case a p-value alone gets wrong.
    const verdict = adjudicateDecision(
      withDecision({
        challenger: { arm: 'macsql-prompt', correct: 990, total: 1532, tokensPerCase: 134 },
        paired: { onlyChallenger: 10, onlyIncumbent: 0 },
        p: 0.001953125,
        ci: { low: 0.25, high: 1.05 },
      }),
    );
    expect(verdict.reasons).toEqual(['below-min-effect']);
    expect(verdict.deltaPp).toBeCloseTo(0.65, 2);
  });

  it('refuses an arm the recipe table does not know', () => {
    const verdict = adjudicateDecision(
      withDecision({ challenger: { arm: 'some-arm-nobody-shipped', correct: 1010, total: 1532, tokensPerCase: 134 } }),
    );
    expect(verdict.reasons).toContain('unknown-arm');
    expect(adjudicateShipment([withDecision({ challenger: { arm: 'nope', correct: 1010, total: 1532, tokensPerCase: 134 } })]).recipe).toBe(
      'assembled',
    );
  });

  it('refuses a candidate whose gain the design cannot resolve, even at the same price', () => {
    // The mode reading with the bill removed: the counterfactual "what if deliberation were free".
    // 69:90 is p = 0.112, so the answer is still no — a price of zero does not make an unresolved
    // effect resolved, and this is the case a cost-blind rule gets wrong in the opposite direction.
    const verdict = adjudicateDecision({
      ...MODE,
      challenger: { ...MODE.challenger, tokensPerCase: MODE.incumbent.tokensPerCase },
    });
    expect(verdict.reasons).toEqual(['not-significant']);
    expect(verdict.costRatio).toBe(1);
    expect(verdict.requiredPp).toBe(1);
    expect(verdict.reasons).not.toContain('too-expensive');
  });
});

describe('refusals that are about the declaration', () => {
  /** Each row changes one field of the shipped reading, so the message names the field it broke. */
  const cases: readonly { readonly name: string; readonly decision: ShipmentDecision; readonly contains: string }[] = [
    {
      name: 'the halves of the paired result disagree',
      decision: withDecision({ paired: { onlyChallenger: 119, onlyIncumbent: 88 } }),
      contains: 'the discordant counts imply 31 more correct answers, the arm totals 30',
    },
    {
      name: 'the arms answered different numbers of questions',
      decision: withDecision({ challenger: { arm: 'macsql-prompt', correct: 1010, total: 1531, tokensPerCase: 134 } }),
      contains: 'cannot be paired',
    },
    {
      name: 'a count is not an integer',
      decision: withDecision({ incumbent: { arm: 'assembled', correct: 979.5, total: 1532, tokensPerCase: 587 } }),
      contains: 'incumbent counts are not integers',
    },
    {
      name: 'an arm measured nothing',
      decision: withDecision({ incumbent: { arm: 'assembled', correct: 0, total: 0, tokensPerCase: 587 } }),
      contains: 'measured nothing',
    },
    {
      name: 'more correct answers than questions',
      decision: withDecision({ incumbent: { arm: 'assembled', correct: 1600, total: 1532, tokensPerCase: 587 } }),
      contains: 'outside 0..1532',
    },
    {
      name: 'a negative count',
      decision: withDecision({
        incumbent: { arm: 'assembled', correct: -5, total: 1532, tokensPerCase: 587 },
        paired: { onlyChallenger: 119, onlyIncumbent: 104 },
      }),
      contains: 'outside 0..1532',
    },
    {
      name: 'an arm with no price',
      decision: withDecision({ challenger: { arm: 'macsql-prompt', correct: 1010, total: 1532, tokensPerCase: 0 } }),
      contains: 'has no price',
    },
    {
      name: 'a price that is not a number',
      decision: withDecision({ challenger: { arm: 'macsql-prompt', correct: 1010, total: 1532, tokensPerCase: Number.NaN } }),
      contains: 'has no price',
    },
    {
      name: 'a discordant count that is not an integer',
      decision: withDecision({ paired: { onlyChallenger: 119.5, onlyIncumbent: 89.5 } }),
      contains: 'discordant counts are not integers',
    },
    {
      name: 'a negative discordant count',
      decision: withDecision({ paired: { onlyChallenger: -1, onlyIncumbent: -31 } }),
      contains: 'a discordant count is negative',
    },
    {
      name: 'p is not a probability',
      decision: withDecision({ p: 1.4 }),
      contains: 'not a probability',
    },
    {
      name: 'an interval that is not finite',
      decision: withDecision({ ci: { low: Number.NaN, high: 3.8 } }),
      contains: 'interval is not finite',
    },
    {
      name: 'an inverted interval',
      decision: withDecision({ ci: { low: 3.8, high: 0.12 } }),
      contains: 'interval is inverted',
    },
    {
      name: 'an interval beside a different effect',
      decision: withDecision({ ci: { low: 2.5, high: 3.8 } }),
      contains: 'does not contain the effect 1.96pp',
    },
    {
      name: 'an interval that stops short of the effect',
      decision: withDecision({ ci: { low: 0.12, high: 1.5 } }),
      contains: 'does not contain the effect 1.96pp',
    },
    {
      name: 'an interval that cannot be positive',
      decision: withDecision({ ci: { low: -2, high: -0.5 } }),
      contains: 'does not contain the effect 1.96pp',
    },
  ];

  it.each(cases)('refuses when $name', ({ decision, contains }) => {
    const verdict = adjudicateDecision(decision);
    expect(verdict.ship).toBe(false);
    expect(verdict.reasons).toContain('inconsistent');
    expect(verdict.problems.join('\n')).toContain(contains);
  });

  it('prints the arithmetic under the line that was refused', () => {
    const result = adjudicateShipment([withDecision({ paired: { onlyChallenger: 119, onlyIncumbent: 88 } })]);
    const lines = shipmentLines(result);
    expect(lines[0]).toContain('refuse (inconsistent)');
    expect(lines[1]).toMatch(/^ {4}the discordant counts imply 31/);
    expect(lines.at(-1)).toBe('recipe: assembled (unchanged)');
  });

  it('prints both sides of a decision that shipped, and the recipe it left in place', () => {
    const lines = shipmentLines(adjudicateShipment([SHIPPED_READING]));
    expect(lines[0]).toContain('44991167518');
    expect(lines[0]).toContain('+1.96pp');
    expect(lines[0]).toContain('p=0.0441');
    expect(lines[0]).toContain('cost=0.23x');
    expect(lines[0]).toContain('needs=1.00pp');
    expect(lines[0]).toContain('ship');
    expect(lines.at(-1)).toBe('recipe: shipped-sql (moved)');
  });
});

describe('a chain of two decisions', () => {
  it('folds to the last step that shipped, not to the last step', () => {
    const later: ShipmentDecision = {
      run: '45040430602',
      dataset: 'bird-dev',
      incumbent: { arm: 'macsql-prompt', correct: 1010, total: 1532, tokensPerCase: 134 },
      challenger: { arm: 'assembled', correct: 980, total: 1532, tokensPerCase: 587 },
      paired: { onlyChallenger: 0, onlyIncumbent: 30 },
      p: 1.862645149230957e-9,
      ci: { low: -3.8, high: -0.12 },
      note: 'a later experiment that lost, in the same shape as the one that won',
    };
    const result = adjudicateShipment([SHIPPED_READING, later]);
    // The second decision is chained correctly and is *worse* on both columns: the classic shape of
    // a later experiment that reads "the old prompt was better". It must not move the product back,
    // because the effect it states is a loss, and a chain that re-decides settled questions on a
    // reversed comparison is a chain that oscillates.
    expect(result.steps.map((step) => step.ship)).toEqual([true, false]);
    expect(result.recipe).toBe('shipped-sql');
  });

  it('refuses a step whose incumbent is not what the chain left in place', () => {
    const skipped: ShipmentDecision = {
      ...SHIPPED_READING,
      run: '45040430602',
      incumbent: { arm: 'macsql-bird-os', correct: 1007, total: 1532, tokensPerCase: 443 },
    };
    const result = adjudicateShipment([skipped]);
    expect(result.steps[0]?.reasons).toContain('inconsistent');
    expect(result.recipe).toBe('assembled');
  });
});
