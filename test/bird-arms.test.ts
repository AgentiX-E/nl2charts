import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSqlPrompt } from '@agentix-e/nl2charts-ai';
import { ARMS, COMPARISONS, DEFAULT_ARMS, ON_DEMAND_ARMS, PAIRS, assertArmProducedResults, assertUniqueArmLabels, parseArms, parseLimit, promptFor, resolveArm } from '../eval/bird/run.js';
import type { Arm } from '../eval/bird/run.js';
import type { BirdQuestion } from '../eval/bird/data.js';

/**
 * The value of an ablation is the invariant, not the run. These tests pin the
 * invariant: two arms in a pair differ by exactly one lever, so an accuracy
 * delta cannot be attributed to anything else. A future edit that adds a second
 * change to a pair turns this red before it turns the benchmark unreadable.
 */
const LEVERS = ['notes', 'evidence', 'repairs', 'linking', 'profile', 'definitions', 'focus', 'interpret', 'vote', 'demonstrations', 'select', 'values'] as const;

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

  it('states a decision question for every cross-level comparison', () => {
    // These are not one-lever pairs, so they live in their own list with the question
    // they answer; an entry without one would be a delta with no claim attached.
    for (const [left, right, question] of COMPARISONS) {
      expect(ARMS.map((arm) => arm.name), left).toContain(left);
      expect(ARMS.map((arm) => arm.name), right).toContain(right);
      expect(question.length, `${left} -> ${right}`).toBeGreaterThan(20);
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
    const withSemantics = promptFor(ARMS.find((arm) => arm.name === 'definitions') as Arm, question, { definitions });
    const without = promptFor(ARMS.find((arm) => arm.name === 'names') as Arm, question, { definitions });
    expect(withSemantics.definitions).toBe(definitions);
    expect(without.definitions).toBeUndefined();
  });

  it('keeps the dataset hint out of a synthesized arm', () => {
    const synthetic = promptFor(ARMS.find((arm) => arm.name === 'synthetic') as Arm, question, { synthesized: 'Data profile: 3 values' });
    expect(synthetic.evidence).toBe('Data profile: 3 values');
    expect(promptFor(ARMS.find((arm) => arm.name === 'names') as Arm, question, { synthesized: 'Data profile: 3 values' }).evidence).toBeUndefined();
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
    expect(promptFor(arm, question, { definitions: '' }).definitions).toBeUndefined();
    expect(promptFor(arm, question, {}).definitions).toBeUndefined();
  });

  it('carries the dataset hint on the evidence arm even with semantics present', () => {
    const arm = ARMS.find((entry) => entry.name === 'definitions+evidence') as Arm;
    const prompt = promptFor(arm, question, { definitions: '- orders: one row per order.' });
    expect(prompt.definitions).toBe('- orders: one row per order.');
    expect(prompt.evidence).toBe(question.evidence);
  });
});

describe('the chain that actually runs', () => {
  it('files every arm as default or on demand, with no arm falling between', () => {
    // The bug this prevents: `inline+retrieval` was written, wired into the prompt,
    // paired for ablation — and never executed, because the default chain is a
    // second list that nothing compared against the catalogue.
    const filed = [...DEFAULT_ARMS, ...Object.keys(ON_DEMAND_ARMS)].sort();
    const declared = ARMS.map((arm) => arm.name).sort();
    expect(filed).toEqual(declared);
  });

  it('puts the retrieval arm in the default chain', () => {
    expect(DEFAULT_ARMS).toContain('inline+retrieval');
  });

  it('keeps the chain free of duplicates and of arms that do not exist', () => {
    expect(new Set(DEFAULT_ARMS).size).toBe(DEFAULT_ARMS.length);
    for (const name of DEFAULT_ARMS) expect(ARMS.map((arm) => arm.name), name).toContain(name);
  });

  it('gives the demonstration arm statements and the textual arm only text', () => {
    // One lever apart: if the textual arm also carried examples, the delta would
    // price two things at once.
    const demonstrations = 'Question: How many rows?\nSQL: SELECT COUNT(*) FROM t';
    const viaIcl = ARMS.find((arm) => arm.name === 'inline+icl') as Arm;
    const viaText = ARMS.find((arm) => arm.name === 'inline+retrieval') as Arm;
    expect(promptFor(viaIcl, question, { retrieved: 'hint', demonstrations }).demonstrations).toBe(demonstrations);
    expect(promptFor(viaText, question, { retrieved: 'hint', demonstrations }).demonstrations).toBeUndefined();
  });

  it('sends the block it measures, through the same builder', () => {
    // The bug this prevents: the prompt *size* was computed with the retrieved block
    // and the request was built without it, so an arm that never saw its input was
    // published as evidence that the input does not help.
    const retrieval = ARMS.find((arm) => arm.name === 'inline+retrieval') as Arm;
    const options = promptFor(retrieval, question, { retrieved: 'a retrieved neighbour' });
    expect(buildSqlPrompt(question.question, [], options)).toContain('Evidence: a retrieved neighbour');

    const values = ARMS.find((arm) => arm.name === 'values') as Arm;
    expect(buildSqlPrompt(question.question, [], promptFor(values, question, { values: '- t.c stores \'x\'' }))).toContain(
      'Values in this database named by the question:',
    );
  });

  it('states a reason for every arm it defers', () => {
    for (const [name, reason] of Object.entries(ON_DEMAND_ARMS)) {
      expect(reason.length, name).toBeGreaterThan(20);
    }
  });

  it('keeps the baseline expecting exactly the arms the chain runs', () => {
    // The gate can only notice an arm that vanished if the baseline knows the arm
    // should be there. These two lists drifting apart is how an arm becomes
    // invisible again.
    const baseline = JSON.parse(readFileSync(resolve(process.cwd(), 'eval/baseline/bird.json'), 'utf8')) as {
      expectedArms: string[];
      floors: Record<string, Record<string, number>>;
    };
    expect([...baseline.expectedArms].sort()).toEqual([...DEFAULT_ARMS].sort());
    for (const floors of Object.values(baseline.floors)) {
      for (const name of Object.keys(floors)) expect(baseline.expectedArms, name).toContain(name);
    }
  });
});

describe('A/A pairs', () => {
  it('refuses a table where every call was rejected by the provider', () => {
    // A dead key or an empty balance arrives as "nothing came back", which scores as
    // a wrong answer: 0% is then a number that hides an outage.
    expect(() => assertArmProducedResults('names', [{ errorKind: 'llm', error: 'llm returned 402' }])).toThrow(/run that did not happen/);
    expect(() => assertArmProducedResults('names', [{ errorKind: 'llm' }, { errorKind: 'execution' }])).not.toThrow();
    expect(() => assertArmProducedResults('names', [{}])).not.toThrow();
    expect(() => assertArmProducedResults('names', [])).not.toThrow();
  });

  it('refuses a report where two arms share a label', () => {
    expect(() => assertUniqueArmLabels(['names', 'inline+evidence', 'inline+evidence'])).toThrow(/#2 name/);
    expect(() => assertUniqueArmLabels(['names', 'inline+evidence', 'inline+evidence#2'])).not.toThrow();
  });

  it('appends the duplicate under a distinct name', () => {
    const arms = parseArms(undefined, 'inline+evidence', DEFAULT_ARMS);
    expect(arms).toEqual([...DEFAULT_ARMS, 'inline+evidence#2']);
    expect(new Set(arms).size).toBe(arms.length);
  });

  it('adds nothing when no A/A arm is asked for', () => {
    expect(parseArms(undefined, undefined, DEFAULT_ARMS)).toEqual([...DEFAULT_ARMS]);
    expect(parseArms(undefined, '  ', DEFAULT_ARMS)).toEqual([...DEFAULT_ARMS]);
  });

  it('respects an explicit arm list', () => {
    expect(parseArms('names, vote', 'names', DEFAULT_ARMS)).toEqual(['names', 'vote', 'names#2']);
  });

  it('resolves a duplicated name to the arm it duplicates', () => {
    // The A/A pair has to run the *same* configuration, or the delta it reports is
    // the difference between two arms rather than the harness's noise.
    expect(resolveArm('inline+evidence#2')).toEqual(ARMS.find((arm) => arm.name === 'inline+evidence'));
    expect(resolveArm('inline+evidence')).toEqual(ARMS.find((arm) => arm.name === 'inline+evidence'));
  });

  it('returns undefined for a name that is not an arm', () => {
    expect(resolveArm('not-an-arm#2')).toBeUndefined();
  });
});

describe('sample size', () => {
  it('scores the whole split when nothing is asked for', () => {
    // `workflow_dispatch` passes an empty string for a blank input, and Number('')
    // is 0: the dev workflow would have scored nothing and divided by it.
    expect(parseLimit(undefined, 'minidev')).toBe(500);
    expect(parseLimit('', 'minidev')).toBe(500);
    expect(parseLimit('   ', 'minidev')).toBe(500);
    expect(parseLimit(undefined, 'dev')).toBe(1534);
    expect(parseLimit('', 'dev')).toBe(1534);
  });

  it('treats a nonsensical cap as no cap instead of as zero questions', () => {
    expect(parseLimit('0', 'minidev')).toBe(500);
    expect(parseLimit('-5', 'minidev')).toBe(500);
    expect(parseLimit('abc', 'dev')).toBe(1534);
  });

  it('honours a real cap', () => {
    expect(parseLimit('120', 'minidev')).toBe(120);
    expect(parseLimit('12.9', 'dev')).toBe(12);
  });
});
