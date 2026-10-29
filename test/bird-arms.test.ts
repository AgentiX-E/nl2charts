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
  DUO_SOURCES,
  MIXED_SOURCES,
  CROSS_SOURCES,
  BALANCED_SOURCES,
  DEFAULT_ARMS,
  ON_DEMAND_ARMS,
  PAIRS,
  assertArmProducedResults,
  assertFailureRate,
  assertHarnessClean,
  escapeKind,
  assertMixedFeasible,
  assertMixedSources,
  assertCandidateSurvival,
  assertDecompositionFired,
  assertEmptyRetryFired,
  assertRepairPathFired,
  assertUniqueArmLabels,
  decompositionFunnel,
  declaresDecomposition,
  DC_SOURCES,
  MIXED_DC_SOURCES,
  emptyRetryFunnel,
  offeredCandidates,
  candidateCeiling,
  parseArms,
  parseLimit,
  parseMixedSource,
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
const LEVERS = ['notes', 'evidence', 'repairs', 'linking', 'profile', 'definitions', 'focus', 'interpret', 'vote', 'demonstrations', 'select', 'values', 'plan', 'repairFeedback', 'shapeGuard', 'mixed', 'pairwise', 'sourcesVisible', 'judge', 'emptyRetry', 'decompose', 'samples', 'canonical'] as const;

function changedLevers(left: Arm, right: Arm): string[] {
  const levers = LEVERS.filter((lever) => left[lever] !== right[lever]);
  // On a mixed arm `vote` is not a lever: it is the length of the source list, and the
  // suite checks that equality on every mixed arm. Counting both would make every change
  // of candidate set look like a two-lever comparison, which is the shape this test
  // exists to refuse.
  return left.mixed !== undefined && right.mixed !== undefined ? levers.filter((lever) => lever !== 'vote') : levers;
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

  it('refuses an arm whose candidates never arrived, which no case count can see', () => {
    // One candidate of three refused on every question: every case still answers, so the
    // case-level guard passes, and the ceiling falls for a reason that is not in the arm.
    type Lost = { candidateFailures?: { llm: number; other: number } };
    const thin: Lost[] = Array.from({ length: 100 }, () => ({ candidateFailures: { llm: 1, other: 0 } }));
    expect(() => assertCandidateSurvival('select-cross', thin, 3)).toThrow(/never arrived/);
    // Under the outage threshold it is noise, not an outage.
    const sparse: Lost[] = [...thin.slice(0, 25), ...Array.from({ length: 75 }, () => ({}))];
    expect(() => assertCandidateSurvival('select-cross', sparse, 3)).not.toThrow();
    // ...and the message says how many of how many, not just a share.
    expect(() => assertCandidateSurvival('select-cross', thin, 3)).toThrow(/100 of 300 candidates \(33.3%\)/);
  });

  it('refuses an empty arm on which the empty-result turn never fired', () => {
    const quiet = Array.from({ length: 200 }, () => ({ emptyRetried: false, emptyDropped: 0 }));
    expect(() => assertEmptyRetryFired('select-mixed+empty', quiet as never)).toThrow(/the lever did not run/);
    // A drop alone is the lever working: it is the half that costs nothing.
    expect(() =>
      assertEmptyRetryFired('select-mixed+empty', [...quiet.slice(1), { emptyRetried: false, emptyDropped: 2 }] as never),
    ).not.toThrow();
    // ...and a turn is the other half.
    expect(() =>
      assertEmptyRetryFired('select-mixed+empty', [...quiet.slice(1), { emptyRetried: true, emptyDropped: 0 }] as never),
    ).not.toThrow();
    // Twenty questions is not enough to insist: the lever legitimately may not fire.
    expect(() => assertEmptyRetryFired('select-mixed+empty', [{ emptyRetried: false }] as never)).not.toThrow();
  });

  it('drops only the candidates that cannot be right, and only while something is left', () => {
    const empty = { sql: 'SELECT 1 WHERE 0', rows: [] as readonly unknown[][], source: 'a' };
    const rows = { sql: 'SELECT 1', rows: [[1]] as readonly unknown[][], source: 'b' };
    // The lever off: the selector sees everything, which is what its parent arm does.
    expect(offeredCandidates([rows, empty], false)).toEqual({ offered: [rows, empty], dropped: 0 });
    // The lever on: an option that returned nothing is removed and counted.
    const dropped = offeredCandidates([rows, empty], true);
    expect(dropped.offered).toEqual([rows]);
    expect(dropped.dropped).toBe(1);
    // When every candidate is empty there is nothing to choose, so nothing is dropped —
    // an empty offer would read as a selector failure instead of an empty result.
    expect(offeredCandidates([empty], true)).toEqual({ offered: [empty], dropped: 0 });
  });

  it('prices the empty-result lever by its reach and its yield', () => {
    const runs = [
      { emptyRetried: true, emptyRecovered: true, emptyDropped: 1, predicted: '', reason: 'values', strict: false, id: '1', passed: false, calls: 5 },
      { emptyRetried: false, emptyDropped: 2, predicted: '', reason: 'values', strict: false, id: '2', passed: false, calls: 4 },
      { emptyRetried: false, emptyDropped: 0, predicted: '', reason: 'values', strict: false, id: '3', passed: true, calls: 4 },
    ];
    const funnel = emptyRetryFunnel(runs as never);
    expect(funnel).toEqual({ dropped: 3, fired: 1, recovered: 1, extraCallsPerCase: Number((1 / 3).toFixed(4)) });
  });

  it('keeps the empty-result pair one lever apart, in both directions', () => {
    const parent = ARMS.find((arm) => arm.name === 'select-mixed') as Arm;
    const diagnosed = ARMS.find((arm) => arm.name === 'select-mixed+empty') as Arm;
    const blind = ARMS.find((arm) => arm.name === 'select-mixed+empty-blind') as Arm;
    expect(parent.emptyRetry).toBeUndefined();
    expect(diagnosed.emptyRetry).toBe('diagnosed');
    expect(blind.emptyRetry).toBe('blind');
    // Same candidates, same selector, same prompt stack: the only field that moves is
    // the one under test, so a delta cannot borrow from a second change.
    expect({ ...diagnosed, emptyRetry: undefined, name: parent.name }).toEqual(parent);
    expect({ ...blind, emptyRetry: 'diagnosed', name: diagnosed.name }).toEqual(diagnosed);
    expect(PAIRS).toContainEqual(['select-mixed', 'select-mixed+empty']);
    expect(PAIRS).toContainEqual(['select-mixed+empty-blind', 'select-mixed+empty']);
  });

  it('pairs the diagnosed repair with the raw one, at the same cost', () => {    // The comparison that decides whether the diagnosis earns its calls: same arms, same
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
    // A floor may name any arm in the catalogue, not only an arm in the default chain: the
    // dev split carries a floor for `select-cross`, which is on-demand because it needs a
    // second model. Tying floors to the chain made that floor fail the build, which is the
    // same one-split's-configuration mistake the `armsBySplit` field was added to stop.
    const catalogue = ARMS.map((arm) => arm.name);
    for (const [split, floors] of Object.entries(baseline.floors as Record<string, Record<string, number>>)) {
      for (const name of Object.keys(floors)) expect(catalogue, `${split}/${name}`).toContain(name);
    }
    for (const [split, arms] of Object.entries((baseline as { armsBySplit?: Record<string, string[]> }).armsBySplit ?? {})) {
      for (const name of arms) expect(catalogue, `${split}/${name}`).toContain(name);
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

  it('puts the decomposition rules in the prompt the report measures', () => {
    // The arm's size column and the distinct-prompt count both read `promptFor`, so a
    // switch that only reached the pipeline would report a prompt the run never sent.
    const arm = resolveArm('decompose') as Arm;
    const rendered = buildSqlPrompt(question.question, [{ table: 'orders', columns: [{ name: 'id', type: 'INTEGER' }] }], promptFor(arm, question));
    expect(rendered).toContain('STEP <n>');
    // The parent renders the same prompt without them, which is the comparison.
    const parent = buildSqlPrompt(question.question, [{ table: 'orders', columns: [{ name: 'id', type: 'INTEGER' }] }], promptFor(resolveArm('inline+evidence') as Arm, question));
    expect(parent).not.toContain('STEP <n>');
    expect(changedLevers(resolveArm('inline+evidence') as Arm, arm)).toEqual(['decompose']);
  });

  it('puts the stored values on the card the report measures', () => {
    // The lever is only real if the rendered prompt changes: `promptFor` sets the switch and
    // `schemaFor` supplies the values, and an arm where one of the two landed would score
    // like its parent and read like a finding.
    const arm = resolveArm('inline+evidence+samples') as Arm;
    const schema = [
      { table: 'orders', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'status', type: 'TEXT' }] },
    ];
    const options = promptFor(arm, question);
    expect(options.samples).toBe(true);
    expect(buildSqlPrompt(question.question, schema, options)).not.toContain('[Banned|Active]');
    const withValues = schema.map((table) => ({
      ...table,
      columns: table.columns.map((column) => (column.name === 'status' ? { ...column, samples: ['Banned', 'Active'] } : column)),
    }));
    expect(buildSqlPrompt(question.question, withValues, options)).toContain('[Banned|Active]');
    // The parent renders it without, which is the comparison the arm buys.
    const parent = promptFor(resolveArm('inline+evidence') as Arm, question);
    expect(parent.samples).toBe(false);
    expect(buildSqlPrompt(question.question, withValues, parent)).not.toContain('[Banned|Active]');
    expect(changedLevers(resolveArm('inline+evidence') as Arm, arm)).toEqual(['samples']);
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

/**
 * The decomposition lever, which is a shape of generation rather than a budget.
 *
 * Two things have to hold for its delta to mean anything: the arm must actually ask for
 * a decomposition, and the model's reply must actually contain one. The second is
 * measured, not assumed — an instruction is one paragraph among many and a model that
 * skips it leaves an arm that is the parent with a longer prompt.
 */
describe('the decomposition lever', () => {
  it('keeps the trio and adds one fourth source, so the comparison stays a superset', () => {
    expect(MIXED_DC_SOURCES.slice(0, MIXED_SOURCES.length)).toEqual(MIXED_SOURCES);
    expect(MIXED_DC_SOURCES.length).toBe(MIXED_SOURCES.length + 1);
    const arm = resolveArm('select-mixed+dc');
    expect(arm).toBeDefined();
    expect(arm?.vote).toBe(4);
    expect(arm?.select).toBe(true);
  });

  it('swaps the third slot at the same cost on the other arm', () => {
    // Same two prompts, same count, same four calls: the difference is which prompt holds the
    // third candidate, and the value index it replaces had an empty block on 60.9% of the split.
    const arm = resolveArm('select-dc') as Arm;
    expect(arm.vote).toBe(3);
    expect(DC_SOURCES.slice(0, 2)).toEqual(MIXED_SOURCES.slice(0, 2));
    expect(DC_SOURCES).toContain('decompose');
    expect(DC_SOURCES).not.toContain('values');
    expect(changedLevers(resolveArm('select-mixed') as Arm, arm)).toEqual(['mixed']);
  });

  it('is one lever from its parent: the candidate set, and nothing else', () => {
    const parent = resolveArm('select-mixed') as Arm;
    const child = resolveArm('select-mixed+dc') as Arm;
    // `vote` moves with it because the candidate count is the source list's length; the
    // helper discounts it exactly where the suite pins that equality.
    expect(changedLevers(parent, child)).toEqual(['mixed']);
    expect(child.vote).toBe(4);
    expect(parent.vote).toBe(3);
  });

  it('asks for a decomposition on the arm itself and on any arm that names it', () => {
    expect(declaresDecomposition({ decompose: true })).toBe(true);
    expect(declaresDecomposition({ mixed: DC_SOURCES })).toBe(true);
    expect(declaresDecomposition({ mixed: MIXED_SOURCES })).toBe(false);
    expect(declaresDecomposition({})).toBe(false);
  });

  it('counts the cases that asked, not the cases that ran', () => {
    // A candidate that never arrived asked for nothing; folding those into the share
    // would blame the prompt for the endpoint.
    const runs = [
      { decomposition: { candidates: 1, steps: 3 } },
      { decomposition: { candidates: 1, steps: 0 } },
      { candidateFailures: { llm: 1, other: 0 } },
    ];
    expect(decompositionFunnel(runs as never)).toEqual({ asked: 2, fired: 1, share: 0.5, meanSteps: 1.5 });
  });

  it('refuses an arm whose prompt never asked for a decomposition', () => {
    const quiet = Array.from({ length: 120 }, () => ({ calls: 1 }));
    expect(() => assertDecompositionFired('select-mixed+dc', quiet as never)).toThrow(/never asked to decompose/);
  });

  it('refuses an arm where the model ignored the format', () => {
    // Half the cases carrying no steps is the line: below it the arm is a longer prompt,
    // and its delta would be published as a finding about decomposition.
    const ignored = Array.from({ length: 120 }, () => ({ decomposition: { candidates: 1, steps: 0 } }));
    expect(() => assertDecompositionFired('select-mixed+dc', ignored as never)).toThrow(/measured decomposition rather than a longer prompt/);
    // One step per case is a model that labels its answer, not one that decomposes.
    const labelled = Array.from({ length: 120 }, () => ({ decomposition: { candidates: 1, steps: 1 } }));
    expect(() => assertDecompositionFired('select-mixed+dc', labelled as never)).toThrow(/1 steps per case/);
  });

  it('accepts a model that decomposes most questions and answers the rest directly', () => {
    const runs = [
      ...Array.from({ length: 80 }, () => ({ decomposition: { candidates: 1, steps: 3 } })),
      ...Array.from({ length: 20 }, () => ({ decomposition: { candidates: 1, steps: 0 } })),
    ];
    expect(() => assertDecompositionFired('select-mixed+dc', runs as never)).not.toThrow();
  });

  it('stays quiet on a sample too small to judge', () => {
    expect(() =>
      assertDecompositionFired('select-mixed+dc', Array.from({ length: 20 }, () => ({ decomposition: { candidates: 1, steps: 0 } })) as never),
    ).not.toThrow();
  });
});

/**
 * A mixed arm's candidate count is the length of its source list.
 *
 * The two are declared in different fields, so a mismatch is a false price rather than a
 * crash: an arm that names three sources and declares two candidates would spend three
 * generations and report two. The pair is checked for every mixed arm in the catalogue.
 */
describe('mixed arms declare their own sources', () => {
  const mixed = ARMS.filter((arm) => arm.mixed !== undefined);

  it('has at least the two arms under test', () => {
    expect(mixed.map((arm) => arm.name).sort()).toEqual(['select-balanced', 'select-cross', 'select-cross-canon', 'select-cross-judge', 'select-cross-judge-canon', 'select-dc', 'select-duo', 'select-mixed', 'select-mixed+dc', 'select-mixed+empty', 'select-mixed+empty-blind', 'select-tagged', 'vote-cross', 'vote-mixed']);
  });

  it.each(mixed.map((arm) => [arm.name, arm] as const))('%s: candidates equal sources, and every source generates once', (name, arm) => {
    expect(arm.vote, name).toBe(arm.mixed?.length);
    expect(() => assertMixedSources(arm.mixed)).not.toThrow();
  });

  it('keeps the duo strictly inside the trio, so the comparison is a subset', () => {
    // `select-duo` exists to price the third candidate; if it introduced a source the trio
    // does not have, the comparison would no longer be "the same prompts, one fewer".
    for (const source of DUO_SOURCES) expect(MIXED_SOURCES).toContain(source);
    expect(DUO_SOURCES.length).toBe(MIXED_SOURCES.length - 1);
  });
});

/**
 * The stratum join is a tool, and a tool that silently joins nothing would report an
 * empty table as a finding. Its self-test runs in CI; this pins the contract the report
 * has to satisfy for it to work at all.
 */
describe('per-case outcomes', () => {
  it('are recorded per arm and question, not only in aggregate', () => {
    // A total cannot be stratified, and the first question asked of this data was a
    // stratum: did the mixed arm win where its sources differed, or where one of them
    // was duplicated? Reading the runner is cheaper than re-running it to find out.
    const source = readFileSync(resolve(process.cwd(), 'eval/bird/run.ts'), 'utf8');
    expect(source).toContain('report.cases =');
    expect(source).toContain('degenerateIds');
  });
});

/**
 * A candidate's model is part of its identity.
 *
 * `@second` is a suffix rather than a second field so the arm table reads as a sentence,
 * which means the parser is the only thing standing between a typo and an arm that
 * silently generates two candidates while claiming three.
 */
describe('cross-model candidate sources', () => {
  it('reads the suffix and leaves plain names alone', () => {
    expect(parseMixedSource('inline+evidence')).toEqual({ arm: 'inline+evidence', provider: 'primary' });
    expect(parseMixedSource('inline+evidence@second')).toEqual({ arm: 'inline+evidence', provider: 'second' });
  });

  it('resolves a suffixed source to an arm that generates once', () => {
    expect(() => assertMixedSources(CROSS_SOURCES)).not.toThrow();
    for (const source of CROSS_SOURCES) {
      const parsed = parseMixedSource(source);
      const arm = resolveArm(parsed.arm);
      expect(arm, source).toBeDefined();
      expect(arm?.repairs, source).toBe(0);
      expect(arm?.vote, source).toBeUndefined();
    }
  });

  it('rejects a suffixed name that is not an arm', () => {
    // Without the parse the suffix would end up inside the lookup and fail with a less
    // useful message; with it, the name that failed is the one that was written.
    expect(() => assertMixedSources(['inline+evidence', 'not-an-arm@second'])).toThrow(/not an arm/);
  });

  it('is one lever from the trio: same prompts, one of them from the other model', () => {
    const trio = MIXED_SOURCES.map((source) => source.replace('@second', ''));
    const cross = CROSS_SOURCES.map((source) => parseMixedSource(source).arm.replace('@second', ''));
    expect([...cross].sort()).toEqual([...trio].sort());
    expect(CROSS_SOURCES.filter((source) => parseMixedSource(source).provider === 'second')).toHaveLength(1);
  });
});

/**
 * A floor is a claim about three coordinates, not two.
 *
 * The baseline stated the split and the arms and left the model implicit, so `bird-model`
 * — the workflow whose whole purpose is another model — skipped the gate entirely, taking
 * the funnel, cost and empty-lever checks with it. A cross-model run therefore had no
 * structural gate at all, and nobody noticed because nothing was asked to notice.
 */
describe('baseline coordinates', () => {
  const baseline = JSON.parse(readFileSync(resolve(process.cwd(), 'eval/baseline/bird.json'), 'utf8')) as {
    floors: Record<string, Record<string, number>>;
    floorModel?: Record<string, string>;
    scoredBySplit?: Record<string, number>;
  };

  it('names the model behind every set of floors', () => {
    for (const split of Object.keys(baseline.floors)) {
      expect(baseline.floorModel?.[split], split).toBeTruthy();
    }
  });

  it('states how many questions each floored split has, so a shrunken sample is caught', () => {
    // The check compared every split against Mini-Dev's 500, which made a dev run scoring
    // 600 of 1,532 questions look like a full sample.
    for (const split of Object.keys(baseline.floors)) {
      expect(baseline.scoredBySplit?.[split], split).toBeGreaterThan(0);
    }
  });

  it('gates another model on structure rather than on an accuracy floor from DeepSeek', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/bird-model.yml'), 'utf8');
    // Both halves matter: without the gate step a cross-model run is unguarded, and without
    // the split input the only split it can guard is Mini-Dev.
    expect(workflow).toContain('pnpm gate:bird');
    expect(workflow).toContain('BIRD_SPLIT');
  });
});

/**
 * The judge is a variable, and it is the one that separates two explanations.
 *
 * Measured on the dev split: answers held only by the cross set — the statement the second
 * model wrote — were returned 47% of the time, while answers held only by the all-primary set
 * were returned 87%. Either the judge prefers statements that read like its own, or the second
 * model's correct statements are simply harder to recognise. Same candidates, same prompt,
 * different judge: the first explanation makes the asymmetry flip, the second does not.
 */
describe('judge swap', () => {
  const cross = resolveArm('select-cross');
  const judged = resolveArm('select-cross-judge');

  it('differs from the cross arm only in who judges', () => {
    expect(judged).toBeDefined();
    expect(judged?.judge).toBe('second');
    // Everything else identical: same sources, same count, same selector, same prompt stack.
    expect(judged?.mixed).toEqual(cross?.mixed);
    expect(judged?.vote).toBe(cross?.vote);
    expect(judged?.select).toBe(cross?.select);
    expect(judged?.definitions).toBe(cross?.definitions);
    expect(judged?.evidence).toBe(cross?.evidence);
    expect(cross?.judge).toBeUndefined();
  });

  it('is priced like the arm it copies: one judge call, counted', () => {
    // A judge swap does not add a call, it moves one — so the comparison stays about quality
    // rather than about budget.
    expect(judged?.repairs).toBe(0);
    expect(judged?.vote).toBe(3);
  });
});

/**
 * Authorship is the majority, and the majority is what wins a tie.
 *
 * `select-cross` is one second-model candidate and two primary ones; `select-balanced` is the
 * same three prompt styles with the counts reversed. Nothing else moves: same sources, same
 * count, same selector, same four calls. If the 21.5%-47% conversion of the second model's
 * exclusive answers is authorship bias, flipping the majority flips the asymmetry.
 */
describe('balanced authorship', () => {
  it('uses the same three prompts as the cross arm', () => {
    const strip = (sources: readonly string[]): string[] => sources.map((source) => source.replace('@second', '')).sort();
    expect(strip(BALANCED_SOURCES)).toEqual(strip(CROSS_SOURCES));
    expect(BALANCED_SOURCES.length).toBe(CROSS_SOURCES.length);
  });

  it('reverses which author holds the majority', () => {
    const count = (sources: readonly string[]): number => sources.filter((source) => source.endsWith('@second')).length;
    expect(count(CROSS_SOURCES)).toBe(1);
    expect(count(BALANCED_SOURCES)).toBe(2);
  });

  it('resolves, and every source still generates exactly one statement', () => {
    expect(() => assertMixedSources(BALANCED_SOURCES)).not.toThrow();
    expect(resolveArm('select-balanced')?.vote).toBe(BALANCED_SOURCES.length);
  });
});

/**
 * A bug in the runner is not a wrong answer, and it is not the provider's fault either.
 *
 * Every error that escaped the per-sample catch used to be recorded as `llm`, so a `TypeError`
 * in this file was reported as a throttled endpoint — the failure-share guard then blamed the
 * model, and the accuracy absorbed a defect. Three things follow from the split: the provider
 * keeps its own bucket, the harness gets one, and an arm with a harness error cannot publish.
 */
describe('escaped errors', () => {
  it('classifies by who threw: the provider or this file', () => {
    expect(escapeKind(Object.assign(new Error('429'), { code: 'NL2C_E_LLM_UNAVAILABLE' }))).toBe('llm');
    expect(escapeKind(Object.assign(new Error('bad json'), { code: 'NL2C_E_LLM_INVALID_RESPONSE' }))).toBe('llm');
    // Anything else — a TypeError, a missing field, a bug in the arm table — is ours.
    expect(escapeKind(new TypeError('x is not a function'))).toBe('harness');
    expect(escapeKind(Object.assign(new Error('engine'), { code: 'NL2C_E_ENGINE_FAILED' }))).toBe('harness');
    expect(escapeKind(undefined)).toBe('harness');
  });

  it('refuses to publish an arm that failed inside the harness', () => {
    expect(() => assertHarnessClean('names', [{ errorKind: 'llm' }, { errorKind: 'execution' }])).not.toThrow();
    expect(() => assertHarnessClean('names', [{ errorKind: 'harness', error: 'harness: x is not a function' }])).toThrow(/bug in the runner/);
  });

  it('does not let a harness bug inflate the provider failure share', () => {
    // Fifty harness errors in a hundred cases is a broken runner, not an outage; the outage
    // guard must stay quiet so the harness assertion is the one that speaks.
    const runs: { errorKind?: string; error?: string }[] = [
      ...Array.from({ length: 50 }, () => ({ errorKind: 'harness', error: 'harness: boom' })),
      ...Array.from({ length: 50 }, () => ({})),
    ];
    expect(() => assertFailureRate('names', runs)).not.toThrow();
  });
});

/**
 * A guard about the split must not fire on a sample of it.
 *
 * The degeneracy check asks whether a candidate set can ever be three opinions. Its first
 * version asked that of whatever `BIRD_LIMIT` selected, so a five-question run whose questions
 * name no literal declared a correct arm broken and refused to start — the same
 * sample-standing-in-for-the-whole mistake it was written to catch.
 */
describe('mixed feasibility', () => {
  const sources = ['inline+evidence', 'metadata+evidence', 'values'];

  it('refuses a whole split where no question can build distinct prompts', () => {
    expect(() => assertMixedFeasible('select-mixed', sources, { distinct: [], degenerate: ['1', '2'] }, true)).toThrow(/no question/);
  });

  it('accepts a whole split with at least one distinct question', () => {
    expect(assertMixedFeasible('select-mixed', sources, { distinct: ['1'], degenerate: ['2'] }, true)).toBeUndefined();
  });

  it('reports a sampled run instead of failing it', () => {
    const note = assertMixedFeasible('select-mixed', sources, { distinct: [], degenerate: ['1', '2'] }, false);
    expect(note).toContain('sampled the split');
    // The count has to say what it is a count of, or the next reader takes it for the split.
    expect(note).toContain('0 of 2');
  });
});

/**
 * The guards below read a record that may carry no message.
 *
 * Every one of them says `run.error ?? 'no error text'`, and every existing test handed them
 * runs that had an `error`. The fallback is not decoration: it is what a run killed before the
 * provider wrote anything looks like, and the three guards that read it are the three that
 * decide whether a number gets published.
 */
describe('guards whose record carries no message', () => {
  it('names the missing error text instead of inventing one', () => {
    expect(() => assertArmProducedResults('names', [{ errorKind: 'llm' }, { errorKind: 'llm' }])).toThrow(/first error: no error text/);
    expect(() =>
      assertFailureRate('names', Array.from({ length: 10 }, () => ({ errorKind: 'llm' }))),
    ).toThrow(/first error: no error text/);
    expect(() => assertHarnessClean('names', [{ errorKind: 'harness' }, { errorKind: 'harness' }])).toThrow(/first: no error text/);
  });

  it('exempts an empty table from the share and the survival checks, not just from the outage one', () => {
    // A split with no cases is not an arm that failed; it is an arm that was not run, and the
    // share of zero cases is not a share (ADR-216).
    expect(() => assertFailureRate('names', [])).not.toThrow();
    expect(() => assertCandidateSurvival('select-cross', [], 3)).not.toThrow();
  });

  it('counts a run that never recorded a drop as zero drops', () => {
    // `emptyDropped` is written by the lever; a run from an arm without it must not turn the
    // funnel's sum into NaN, and must not be read as "the lever ran".
    const bare = Array.from({ length: 200 }, () => ({ emptyRetried: false }));
    expect(emptyRetryFunnel(bare as never)).toEqual({ dropped: 0, fired: 0, recovered: 0, extraCallsPerCase: 0 });
    expect(() => assertEmptyRetryFired('select-mixed+empty', bare as never)).toThrow(/the lever did not run/);
  });

  it('reads a decomposition record that states no steps as a decomposition that did not fire', () => {
    // The record exists (the arm asked) but carries no counts: `asked` counts it, `fired` must
    // not, and a missing candidate count is one candidate, not zero.
    const runs = [{ decomposition: { steps: 3 } }, { decomposition: {} }];
    // Three steps over two cases that each declared no candidate count: the missing count is
    // one candidate, so the mean is 1.5 and not 3 or 0.
    expect(decompositionFunnel(runs as never)).toEqual({ asked: 2, fired: 1, share: 0.5, meanSteps: 1.5 });
    expect(decompositionFunnel([{ decomposition: {} }] as never)).toEqual({ asked: 1, fired: 0, share: 0, meanSteps: 0 });
  });
});

/**
 * The adaptive arm is the only one whose prompt is chosen per question.
 *
 * It is in the arm table and has never been run end to end (a full run costs four calls a
 * question), so its three branches — the profile lookup, the profile's own `descriptions`
 * and `foreignKeys`, and the notes block it adds — were all unexecuted. They are read here
 * through the same `promptFor` the runner and the prompt-size column both use.
 */
describe('the adaptive profile arm', () => {
  const question = {
    question_id: 1,
    db_id: 'shop',
    question: 'What is the ratio of orders paid in EUR?',
    evidence: '',
    SQL: 'select 1',
    difficulty: 'moderate' as const,
  };

  it('turns the schema-card descriptions off for a question whose shape dictates the notes', () => {
    const options = promptFor(resolveArm('adaptive') as Arm, question, {});
    expect(options.descriptions).toBe(false);
    expect(options.foreignKeys).toBe(false);
    expect(options.notes?.join(' ')).toContain('NULLIF');
  });

  it('answers a window question with window notes, not ratio ones', () => {
    const options = promptFor(resolveArm('adaptive') as Arm, { ...question, question: 'Rank the stores by revenue and show the previous month.' }, {});
    expect(options.notes?.join(' ')).toContain('window function');
    expect(options.notes?.join(' ')).not.toContain('NULLIF');
  });

  it('leaves an ordinary question with no notes and the descriptions on', () => {
    const options = promptFor(resolveArm('adaptive') as Arm, { ...question, question: 'How many orders are there?' }, {});
    expect(options.notes).toEqual([]);
    expect(options.descriptions).toBe(true);
    expect(options.foreignKeys).toBe(true);
  });

  it('reads the same profile for the distinct-prompt count as for the request', () => {
    // The size column and the distinct-prompt check both call `promptFor`, so a profile that
    // is chosen in one place and not the other would make two different questions look
    // identical — the drift this function was extracted to stop.
    const first = promptFor(resolveArm('adaptive') as Arm, question, {});
    const second = promptFor(resolveArm('adaptive') as Arm, { ...question, question: 'Rank the stores by revenue.' }, {});
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(second));
  });

  it('treats the dataset-subset placement as the inline one, descriptions included', () => {
    // `definitions: 'dataset-subset'` attaches the same sentences to the column line, so the
    // descriptions switch is part of that placement rather than a second lever.
    const subset = promptFor({ ...(resolveArm('names') as Arm), definitions: 'dataset-subset' }, question, {});
    expect(subset.descriptions).toBe(true);
  });
});
