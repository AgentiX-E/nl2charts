import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSqlPrompt } from '@agentix-e/nl2charts-ai';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARMS,
  COMPARISONS,
  MIXED_SOURCES,
  DEFAULT_ARMS,
  ON_DEMAND_ARMS,
  PAIRS,
  assertArmProducedResults,
  assertFailureRate,
  assertMixedSources,
  assertRepairPathFired,
  assertUniqueArmLabels,
  candidateCeiling,
  parseArms,
  parseLimit,
  promptFor,
  readPinnedDefinitions,
  repairAccounting,
  resolveArm,
  winnerSources,
} from '../eval/bird/run.js';
import type { Arm } from '../eval/bird/run.js';
import type { BirdQuestion } from '../eval/bird/data.js';

/**
 * The value of an ablation is the invariant, not the run. These tests pin the
 * invariant: two arms in a pair differ by exactly one lever, so an accuracy
 * delta cannot be attributed to anything else. A future edit that adds a second
 * change to a pair turns this red before it turns the benchmark unreadable.
 */
const LEVERS = ['notes', 'evidence', 'repairs', 'linking', 'profile', 'definitions', 'focus', 'interpret', 'vote', 'demonstrations', 'select', 'values', 'plan', 'repairFeedback', 'shapeGuard', 'mixed'] as const;

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

  it('keeps a mechanism that measured harmful out of the default chain', () => {
    // A plan before the statement lost 7.2pp against its parent (63/27, p=0.0002).
    // Keeping it in the chain would spend two minutes of every run to make the table
    // worse; the catalogue keeps it so the finding can be re-tested.
    expect(DEFAULT_ARMS).not.toContain('plan');
    expect(ON_DEMAND_ARMS.plan).toMatch(/-7\.2pp/);
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

  it('refuses a repair arm on which the repair path never fired', () => {
    // A switch that is on and never fires produces its parent's number under its own
    // name — the failure the retrieval arm already had once.
    const flat = Array.from({ length: 200 }, () => ({ attempts: 1 }));
    expect(() => assertRepairPathFired('inline+repair', flat)).toThrow(/did not run/);
    expect(() => assertRepairPathFired('inline+repair', [...flat.slice(1), { attempts: 2 }])).not.toThrow();
    // A small sample is exempt: on twenty questions the loop legitimately may not fire.
    expect(() => assertRepairPathFired('inline+repair', [{ attempts: 1 }])).not.toThrow();
  });

  it('pairs the diagnosed repair with the raw one, at the same cost', () => {
    // The comparison that decides whether the diagnosis earns its calls: same arms, same
    // budget, same prompt — only the text of the repair turn differs.
    const diagnosed = ARMS.find((arm) => arm.name === 'inline+repair') as Arm;
    const raw = ARMS.find((arm) => arm.name === 'inline+repair-raw') as Arm;
    expect(diagnosed.repairFeedback).toBeUndefined();
    expect(raw.repairFeedback).toBe('raw');
    expect({ ...raw, repairFeedback: undefined, name: diagnosed.name }).toEqual(diagnosed);
    expect(PAIRS).toContainEqual(['inline+repair-raw', 'inline+repair']);
  });

  it('pairs the repair arm with the best prompt stack, one lever apart', () => {
    const repair = ARMS.find((arm) => arm.name === 'inline+repair') as Arm;
    const parent = ARMS.find((arm) => arm.name === 'inline+evidence') as Arm;
    expect(repair.repairs).toBe(3);
    expect(parent.repairs).toBe(0);
    // Everything except the repair budget must be identical, or the delta prices the
    // prompt as well as the loop.
    expect({ ...repair, repairs: 0, name: parent.name }).toEqual(parent);
    expect(PAIRS).toContainEqual(['inline+evidence', 'inline+repair']);
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

  it('refuses a run where a tenth of the cases were throttled away', () => {
    // Partial rate limiting is worse than an outage: the table looks like a result.
    expect(() =>
      assertFailureRate('names', Array.from({ length: 10 }, () => ({ errorKind: 'llm', error: 'llm returned 429' }))),
    ).toThrow(/outage \(first error: llm returned 429\)/);
    expect(() => assertFailureRate('names', [{ errorKind: 'llm' }, ...Array.from({ length: 19 }, () => ({}))])).not.toThrow();
    expect(() => assertFailureRate('names', [{ errorKind: 'execution' }, { errorKind: 'guard' }])).not.toThrow();
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

describe('pinned definitions', () => {
  const dirs: string[] = [];
  const write = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'nl2charts-pin-'));
    dirs.push(dir);
    const path = join(dir, 'definitions.json');
    writeFileSync(path, body);
    return path;
  };

  it('reads the committed pin, one entry per database', () => {
    const pinned = readPinnedDefinitions(join(process.cwd(), 'eval/baseline/definitions.minidev.json'));
    expect(pinned).toBeDefined();
    // The eleven databases under test. A pin that covers only some of them would
    // throw at run time, which is the point — but it is cheaper to fail here.
    expect(pinned?.size).toBe(11);
    for (const [db, text] of pinned ?? []) expect(text.length, db).toBeGreaterThan(0);
  });

  it('returns nothing when there is no pin', () => {
    expect(readPinnedDefinitions(join(tmpdir(), 'no-such-pin.json'))).toBeUndefined();
  });

  it('refuses an empty pin instead of falling back to generating', () => {
    // A silent fallback restores the drift the pin exists to remove.
    expect(() => readPinnedDefinitions(write(JSON.stringify({ definitions: {} })))).toThrow(/regenerate/);
    expect(() => readPinnedDefinitions(write(JSON.stringify({ model: 'x' })))).toThrow(/regenerate/);
  });
});

/**
 * `attempts` counts generations for a repair arm and samples for a voting arm, so a
 * report that reads it as "did the repair loop run" tells the truth on one arm and a
 * fiction on the other. The published table said `select5 repaired 496` — an arm with no
 * repair loop — which is exactly the column a reader uses to decide whether the loop is
 * worth its calls.
 */
describe('repair accounting', () => {
  it('counts generations on an arm that repairs', () => {
    const arm = resolveArm('inline+repair');
    expect(arm).toBeDefined();
    const runs = [{ attempts: 1 }, { attempts: 3 }, { attempts: 2 }, { attempts: 1 }];
    expect(repairAccounting(arm as Arm, runs)).toEqual({ repaired: 2 });
  });

  it('reports samples, and no repair count, on an arm that only samples', () => {
    const arm = resolveArm('select5');
    expect(arm).toBeDefined();
    const runs = [{ attempts: 5 }, { attempts: 5 }, { attempts: 5 }];
    const accounting = repairAccounting(arm as Arm, runs);
    expect(accounting).toEqual({ samples: 5 });
    // The bug was the key existing, not its value: `repaired: undefined` would still
    // render as a column a reader could mistake for zero repairs.
    expect('repaired' in accounting).toBe(false);
  });

  it('reports nothing at all on a single-shot arm', () => {
    const arm = resolveArm('inline+evidence');
    expect(arm).toBeDefined();
    const accounting = repairAccounting(arm as Arm, [{ attempts: 1 }, { attempts: 1 }]);
    expect(accounting).toEqual({});
    expect('repaired' in accounting).toBe(false);
    expect('samples' in accounting).toBe(false);
  });

  it('agrees with the arms catalogue, so no arm can be mislabelled', () => {
    // Every arm that declares a repair loop must be able to produce a repaired count,
    // and every arm that declares votes must produce a sample count.
    for (const arm of ARMS) {
      const accounting = repairAccounting(arm, [{ attempts: 2 }]);
      expect('repaired' in accounting, arm.name).toBe(arm.repairs > 0);
      expect('samples' in accounting, arm.name).toBe((arm.vote ?? 1) > 1);
    }
  });
});

/**
 * A selector's score is unreadable without its ceiling.
 *
 * `select5` returning 58.8% says nothing about whether the five candidates contained a
 * correct statement — the set could have been empty of correct answers or full of them
 * with the selector discarding one. Those two readings imply opposite next steps, so the
 * ceiling is measured on the same cases at no extra cost and reported beside the score.
 */
describe('candidate ceiling', () => {
  it('counts the questions the candidate set answered, not the ones the arm returned', () => {
    const ceiling = candidateCeiling([
      { passed: true, candidateRecall: true },
      { passed: false, candidateRecall: true },
      { passed: true, candidateRecall: true },
      { passed: false, candidateRecall: false },
      { passed: false, candidateRecall: false },
    ]);
    expect(ceiling.candidateRecall).toBe(3);
    expect(ceiling.candidateRecallShare).toBeCloseTo(0.6, 6);
    // The arm scored 2/5 and the set held 3/5: exactly one question is pure selection loss.
    expect(ceiling.selectionLoss).toBe(1);
  });

  it('reports zero rather than NaN on an empty arm', () => {
    expect(candidateCeiling([])).toEqual({ candidateRecall: 0, candidateRecallShare: 0, selectionLoss: 0 });
  });

  it('never counts a loss on a question the arm got right', () => {
    const ceiling = candidateCeiling([{ passed: true, candidateRecall: false }]);
    // The candidate marker is written by the same judge as the pass, so this combination
    // is a bug upstream; the count must not silently become "1 loss" and inflate the
    // apparent headroom of a better selector.
    expect(ceiling.selectionLoss).toBe(0);
    expect(ceiling.candidateRecall).toBe(0);
  });
});

/**
 * The mixed arm buys a second opinion with the same three calls.
 *
 * Its whole claim is that three *different* decompositions beat three samples of one.
 * That claim only holds if a candidate is one generation: a source that repairs or
 * samples would spend unbounded calls inside a candidate the arm counts as one.
 */
describe('mixed candidate sources', () => {
  it('resolves, and each source generates exactly one statement', () => {
    expect(() => assertMixedSources()).not.toThrow();
    expect(MIXED_SOURCES.length).toBeGreaterThanOrEqual(2);
    for (const source of MIXED_SOURCES) {
      const arm = resolveArm(source);
      expect(arm, source).toBeDefined();
      expect(arm?.repairs, source).toBe(0);
      expect(arm?.vote, source).toBeUndefined();
    }
  });

  it('refuses a source that repairs, because the candidate would cost more than one call', () => {
    expect(() => assertMixedSources(['inline+evidence', 'inline+repair'])).toThrow(/one statement/);
  });

  it('refuses a source that samples', () => {
    expect(() => assertMixedSources(['inline+evidence', 'select5'])).toThrow(/one statement/);
  });

  it('refuses a name that is not an arm', () => {
    expect(() => assertMixedSources(['inline+evidence', 'not-an-arm'])).toThrow(/not an arm/);
  });

  it('refuses a set of one, which is not a set', () => {
    expect(() => assertMixedSources(['inline+evidence'])).toThrow(/at least two/);
  });

  it('counts which decomposition won, including the ones that never did', () => {
    const counts = winnerSources([
      { winnerSource: 'inline+evidence' },
      { winnerSource: 'metadata+evidence' },
      { winnerSource: 'inline+evidence' },
    ]);
    // A generator missing from the report would look like a generator that was never
    // tried; zero is the number that says "tried, never won".
    expect(counts).toEqual({ 'inline+evidence': 2, 'metadata+evidence': 1, values: 0 });
  });
});
