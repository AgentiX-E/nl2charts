import { describe, expect, it } from 'vitest';
import { ARMS, PAIRS, promptFor } from '../eval/bird/run.js';
import type { Arm } from '../eval/bird/run.js';
import type { BirdQuestion } from '../eval/bird/data.js';

/**
 * The value of an ablation is the invariant, not the run. These tests pin the
 * invariant: two arms in a pair differ by exactly one lever, so an accuracy
 * delta cannot be attributed to anything else. A future edit that adds a second
 * change to a pair turns this red before it turns the benchmark unreadable.
 */
const LEVERS = ['notes', 'evidence', 'repairs', 'linking', 'profile', 'definitions', 'focus'] as const;

function changedLevers(left: Arm, right: Arm): string[] {
  return LEVERS.filter((lever) => left[lever] !== right[lever]);
}

const question = {
  question_id: 1,
  db_id: 'shop',
  question: 'How many orders were placed by each customer?',
  evidence: 'An order belongs to one customer.',
  SQL: 'SELECT 1',
  difficulty: 'simple',
} as unknown as BirdQuestion;

describe('ablation arms', () => {
  it('names every arm in a pair', () => {
    for (const [left, right] of PAIRS) {
      expect(ARMS.find((arm) => arm.name === left), left).toBeDefined();
      expect(ARMS.find((arm) => arm.name === right), right).toBeDefined();
    }
  });

  it('changes exactly one lever per pair', () => {
    for (const [left, right] of PAIRS) {
      const before = ARMS.find((arm) => arm.name === left) as Arm;
      const after = ARMS.find((arm) => arm.name === right) as Arm;
      expect(changedLevers(before, after), `${left} -> ${right}`).toHaveLength(1);
    }
  });

  it('forms a chain rather than a set of unrelated arms', () => {
    const parents = new Map(PAIRS.map(([left, right]) => [right, left]));
    expect(parents.get('definitions')).toBe('names');
    expect(parents.get('definitions+evidence')).toBe('definitions');
    expect(parents.get('synthetic+focus')).toBe('synthetic');
  });

  it('shows semantics only to the arms that carry them', () => {
    const definitions = '- orders.customer_id: foreign key to customers.customer_id.';
    const withSemantics = promptFor(ARMS.find((arm) => arm.name === 'definitions') as Arm, question, undefined, definitions);
    const without = promptFor(ARMS.find((arm) => arm.name === 'names') as Arm, question, undefined, definitions);
    expect(withSemantics.definitions).toBe(definitions);
    expect(without.definitions).toBeUndefined();
  });

  it('keeps the dataset hint out of a synthesized arm', () => {
    const synthetic = promptFor(ARMS.find((arm) => arm.name === 'synthetic') as Arm, question, 'Data profile: 3 values');
    expect(synthetic.evidence).toBe('Data profile: 3 values');
    expect(promptFor(ARMS.find((arm) => arm.name === 'names') as Arm, question, 'Data profile: 3 values').evidence).toBeUndefined();
  });

  it('treats the two hint sources as alternatives on one lever', () => {
    const dataset = ARMS.find((arm) => arm.name === 'metadata+evidence') as Arm;
    const synthesizedArm = ARMS.find((arm) => arm.name === 'synthetic') as Arm;
    expect(changedLevers(dataset, synthesizedArm)).toEqual(['evidence']);
    expect(dataset.evidence).toBe('dataset');
    expect(synthesizedArm.evidence).toBe('synthetic');
  });

  it('drops an empty semantics block instead of leaving a heading', () => {
    const arm = ARMS.find((entry) => entry.name === 'definitions') as Arm;
    expect(promptFor(arm, question, undefined, '').definitions).toBeUndefined();
    expect(promptFor(arm, question, undefined, undefined).definitions).toBeUndefined();
  });

  it('carries the dataset hint on the evidence arm even with semantics present', () => {
    const arm = ARMS.find((entry) => entry.name === 'definitions+evidence') as Arm;
    const prompt = promptFor(arm, question, undefined, '- orders: one row per order.');
    expect(prompt.definitions).toBe('- orders: one row per order.');
    expect(prompt.evidence).toBe(question.evidence);
  });
});
