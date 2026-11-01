/**
 * The pool instrument: what it counts, and the two controls that make its verdict mean something.
 *
 * The claim this file has to support is narrow and load-bearing: *a candidate pool's recall is a
 * ceiling, and the difference between two pools is the number of questions only one of them
 * answers*. Every test below is either that arithmetic or a control on it — a bank where the
 * second pool really does add a lot of ceiling (the harness must say "widen it") and a bank where
 * it adds almost nothing (the harness must say the split cannot resolve it). Without both, an
 * instrument that always printed the same verdict would pass every unit test in this file.
 *
 * Three regressions are pinned by name, because each was a real defect found while writing the
 * file:
 *
 * - the denominator is the arm's cases, not the candidate rows, so a question where every
 *   candidate died stays in the corpus instead of vanishing from every union;
 * - a passed question whose record names no correct candidate counts as covered, because the
 *   judge saw one — the runner used to drop the per-candidate record when a single candidate
 *   survived, and that hole is exactly the smallest pool;
 * - a one-call arm is never a pool, whatever its passes look like.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MARGIN_PP,
  coveredBy,
  dispatch,
  greedy,
  main,
  poolName,
  readPools,
  reportLines,
  resolvePoolSettings,
  uniqueTo,
} from '../eval/bird/pool.js';
import type { PoolArtifact, PoolSettings } from '../eval/bird/pool.js';

type Row = NonNullable<PoolArtifact['cases']>[number];

/**
 * One case: the arm, the question, whether it passed, and what each candidate was.
 *
 * A candidate is written `source:correct` so a bank reads as a table rather than as nesting.
 */
function one(arm: string, id: number, passed: boolean, candidates: readonly string[] = [], winner?: string): Row {
  return {
    arm,
    id: String(id),
    passed,
    ...(winner === undefined ? {} : { winnerSource: winner }),
    ...(candidates.length === 0 ? {} : { candidates: candidates.map((entry) => {
      const [source, correct] = entry.split(':');
      return { source: source as string, correct: correct === 'yes' };
    }) }),
  };
}

function artifact(cases: Row[], arms: { arm: string; mean: number }[] = []): PoolArtifact {
  return { split: 'dev', model: 'deepseek-chat', cases, arms: arms.map((entry) => ({ arm: entry.arm, calls: { mean: entry.mean } })) };
}

const settings = (over: Partial<PoolSettings> = {}): PoolSettings => ({ artifact: 'unused.json', margin: DEFAULT_MARGIN_PP, json: false, ...over });

const dirs: string[] = [];
function scratch(name: string, body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'pool-'));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(body));
  return file;
}
afterEach(() => {
  dirs.length = 0;
});

describe('naming and grouping', () => {
  it('names a sampling arm after itself and a mixed arm after the source it drew', () => {
    expect(poolName('select', 'select')).toBe('select');
    expect(poolName('select-mixed', 'values')).toBe('select-mixed/values');
  });

  it('keeps three draws of one prompt as one pool and three prompts as three', () => {
    const corpus = readPools(
      artifact([
        one('select', 1, true, ['select:yes', 'select:no', 'select:no']),
        one('select-mixed', 1, true, ['inline+evidence:yes', 'metadata+evidence:no', 'values:no']),
      ]),
    );
    expect(corpus.pools.map((pool) => pool.name)).toEqual(['select', 'select-mixed/inline+evidence', 'select-mixed/metadata+evidence', 'select-mixed/values']);
    expect(corpus.arms.map((arm) => [arm.arm, arm.sources])).toEqual([
      ['select', 1],
      ['select-mixed', 3],
    ]);
  });

  it('takes the denominator from the cases the arm ran, so a question with no surviving candidate stays', () => {
    // The regression: reading cases from the candidate rows dropped exactly this row, and the
    // corpus then reported a ceiling over the questions that happened to produce candidates.
    const corpus = readPools(
      artifact([one('select', 1, true, ['select:yes']), one('select', 2, false, []), one('select', 3, false, ['select:no', 'select:no'])]),
    );
    expect(corpus.ids).toEqual(['1', '2', '3']);
    const select = corpus.pools[0];
    expect(select?.covered.size).toBe(1);
    expect(select?.cases.size).toBe(3);
  });

  it('reports an arm that never records a candidate as a one-call arm rather than a pool', () => {
    const corpus = readPools(artifact([one('names', 1, true), one('names', 2, false), one('select', 1, true, ['select:yes'])]));
    expect(corpus.single).toEqual(['names']);
    expect(corpus.pools.map((pool) => pool.name)).toEqual(['select']);
  });

  it('drops rows it cannot name instead of inventing a pool for them', () => {
    const corpus = readPools({ cases: [{ id: undefined, arm: 'select', passed: true }, { id: '9', arm: '', passed: true }] });
    expect(corpus.pools).toEqual([]);
    expect(corpus.single).toEqual([]);
  });

  it('returns an empty corpus when the artifact has no cases at all', () => {
    expect(readPools({}).ids).toEqual([]);
    expect(readPools({ cases: [] }).pools).toEqual([]);
  });

  it('falls back to one call when the arm row carries no usable mean', () => {
    const corpus = readPools({
      cases: [one('select', 1, true, ['select:yes'])],
      arms: [{ arm: 'select' }, { arm: '', calls: { mean: 4 } }, { arm: 'select', calls: { mean: Number.NaN } }],
    });
    expect(corpus.pools[0]?.calls).toBe(1);
  });

  it('names a candidate that forgot its source after the arm that drew it', () => {
    const corpus = readPools({ cases: [{ arm: 'select', id: 1, passed: true, candidates: [{ correct: true }, { source: '', correct: false }] }] });
    expect(corpus.pools.map((pool) => pool.name)).toEqual(['select']);
    expect(corpus.pools[0]?.covered.size).toBe(1);
  });

  it('scores a pool whose arm never passed anything as zero rather than crashing', () => {
    const corpus = readPools(artifact([one('select', 1, false, ['select:yes'])]));
    expect(corpus.pools[0]?.passed.size).toBe(0);
    expect(corpus.arms[0]?.scored.size).toBe(0);
  });
});

describe('the hole in the record', () => {
  it('counts a passed question with no correct candidate as covered, and says how many', () => {
    const corpus = readPools(artifact([one('select-mixed', 1, true, ['inline+evidence:no', 'metadata+evidence:no'], 'metadata+evidence')]));
    expect(corpus.unrecorded).toBe(1);
    expect(corpus.pools.find((pool) => pool.name === 'select-mixed/metadata+evidence')?.covered.size).toBe(1);
  });

  it('attributes the repaired case to the arm when the record names no winner', () => {
    const corpus = readPools(artifact([one('select', 1, true, ['select:yes']), one('select', 2, true, [])]));
    expect(corpus.unrecorded).toBe(1);
    expect(corpus.pools[0]?.covered.size).toBe(2);
  });

  it('does not count a one-call arm’s passes as holes', () => {
    const corpus = readPools(artifact([one('names', 1, true), one('names', 2, true), one('select', 1, true, ['select:yes'])]));
    expect(corpus.unrecorded).toBe(0);
  });

  it('invents no pool for a repaired case whose arm never recorded a candidate', () => {
    const corpus = readPools(artifact([one('names', 1, true), one('names', 2, false)]));
    expect(corpus.pools).toEqual([]);
    expect(corpus.arms).toEqual([]);
  });

  it('repairs a case into the arm’s own pool when the winner names a source no pool has', () => {
    // A mixed arm names the pool `arm/source`, so an arm-level pool only exists when a source is
    // spelled like the arm. The repaired case must then land on that pool and not be dropped.
    const corpus = readPools(
      artifact([
        { arm: 'select-mixed', id: '1', passed: false, candidates: [{ source: 'select-mixed', correct: false }] },
        { arm: 'select-mixed', id: '2', passed: true, winnerSource: 'values', candidates: [{ source: 'select-mixed', correct: false }] },
      ]),
    );
    expect(corpus.pools.map((pool) => pool.name)).toEqual(['select-mixed']);
    expect(corpus.pools[0]?.covered.size).toBe(1);
    expect(corpus.unrecorded).toBe(1);
  });
});

describe('denominators', () => {
  it('intersects the questions every pool ran and reports the shortfall', () => {
    const corpus = readPools(
      artifact([
        one('select', 1, true, ['select:yes']),
        one('select', 2, false, ['select:no']),
        one('select-mixed', 1, true, ['values:yes']),
      ]),
    );
    expect(corpus.ids).toEqual(['1']);
    expect(corpus.short.map((entry) => entry.name)).toContain('select');
  });

  it('counts a union over a subset of the shared questions', () => {
    const corpus = readPools(
      artifact([one('select', 1, true, ['select:yes']), one('select', 2, false, ['select:no']), one('select-mixed', 1, true, ['values:no']), one('select-mixed', 2, true, ['values:yes'])]),
    );
    expect(coveredBy(corpus.pools, corpus.ids)).toBe(2);
    expect(coveredBy(corpus.pools, ['1'])).toBe(1);
    expect(coveredBy([], corpus.ids)).toBe(0);
  });

  it('counts the questions only one pool answers', () => {
    const corpus = readPools(
      artifact([
        one('select', 1, true, ['select:yes']),
        one('select', 2, false, ['select:no']),
        one('select-mixed', 1, true, ['values:yes']),
        one('select-mixed', 2, true, ['values:yes']),
      ]),
    );
    const values = corpus.pools.find((pool) => pool.name === 'select-mixed/values');
    const select = corpus.pools.find((pool) => pool.name === 'select');
    expect(uniqueTo(values!, corpus.pools)).toBe(1);
    expect(uniqueTo(select!, corpus.pools)).toBe(0);
  });
});

describe('the greedy path', () => {
  it('starts from the widest pool and adds what each further call buys', () => {
    const corpus = readPools(
      artifact([
        one('wide', 1, true, ['wide:yes']),
        one('wide', 2, true, ['wide:yes']),
        one('narrow', 1, true, ['narrow:yes']),
        one('narrow', 2, false, ['narrow:no']),
        one('extra', 1, false, ['extra:no']),
        one('extra', 2, true, ['extra:yes']),
      ]),
    );
    const steps = greedy(corpus);
    expect(steps[0]?.name).toBe('wide');
    expect(steps[0]?.added).toBe(2);
    expect(steps.map((step) => step.name)).toContain('extra');
    // Every step's `covered` is monotone and the last one is the union.
    for (let index = 1; index < steps.length; index += 1) {
      expect((steps[index] as { covered: number }).covered).toBeGreaterThanOrEqual((steps[index - 1] as { covered: number }).covered);
    }
    expect(steps.at(-1)?.covered).toBe(coveredBy(corpus.pools, corpus.ids));
  });

  it('breaks a tie alphabetically, so two runs on one artifact agree', () => {
    const corpus = readPools(artifact([one('beta', 1, true, ['beta:yes']), one('alpha', 1, false, ['alpha:no'])]));
    expect(greedy(corpus).map((step) => step.name)).toEqual(['beta', 'alpha']);
  });

  it('returns nothing when there is no pool', () => {
    expect(greedy({ pools: [], arms: [], ids: [], single: [], short: [], unrecorded: 0 })).toEqual([]);
  });
});

describe('the report', () => {
  /**
   * Two pools that answer different halves of the bank.
   *
   * Chosen so the second step is unmistakable: `select` answers the first two questions and
   * `values` the last two, so the union is the whole bank and the second call buys 50pp. A bank
   * where the pools overlapped would let a broken `unique` count still produce a plausible table.
   */
  const wide = readPools(
    artifact([
      one('select', 1, true, ['select:yes']),
      one('select', 2, true, ['select:yes']),
      one('select', 3, false, ['select:no']),
      one('select', 4, false, ['select:no']),
      one('select-mixed', 1, false, ['values:no']),
      one('select-mixed', 2, false, ['values:no']),
      one('select-mixed', 3, true, ['values:yes']),
      one('select-mixed', 4, true, ['values:yes']),
    ]),
  );

  it('prints the arm table, the pool table, the union and the criterion', () => {
    const lines = reportLines(wide, settings(), artifact([])).join('\n');
    expect(lines).toContain('candidate pools on 4 questions');
    expect(lines).toContain('union of all 2 pools');
    expect(lines).toContain('criterion: a pool earns its call only if it adds 2.30pp');
  });

  it('says a second pool is worth buying when it clears the margin', () => {
    // Positive control: the two pools answer disjoint halves, so the second call buys 50pp and
    // any threshold under that must read as "widen it".
    const lines = reportLines(wide, settings({ margin: 10 }), artifact([])).join('\n');
    expect(lines).toContain('the pool is worth widening');
  });

  it('says a second pool cannot be resolved when it does not clear the margin', () => {
    const lines = reportLines(wide, settings({ margin: 90 }), artifact([])).join('\n');
    expect(lines).toContain('widening the pool cannot be measured here');
  });

  it('refuses to price a further candidate when the artifact holds one pool', () => {
    const single = readPools(artifact([one('select', 1, true, ['select:yes'])]));
    expect(reportLines(single, settings(), artifact([])).join('\n')).toContain('one pool, nothing to add');
  });

  it('states the arms it is not describing, and the holes it repaired', () => {
    const corpus = readPools(artifact([one('names', 1, true), one('select', 1, true, ['select:yes']), one('select', 2, true, [])]));
    const lines = reportLines(corpus, settings(), artifact([])).join('\n');
    expect(lines).toContain('1 arm(s) kept one candidate and are not pools: names');
    expect(lines).toContain('1 passed question(s) carry no correct candidate');
  });

  it('says so when every arm kept a candidate set and the record is complete', () => {
    const corpus = readPools(artifact([one('select', 1, true, ['select:yes']), one('select-mixed', 1, true, ['values:yes'])]));
    const lines = reportLines(corpus, settings(), artifact([])).join('\n');
    expect(lines).toContain('every arm in this artifact kept a candidate set');
    expect(lines).not.toContain('carry no correct candidate');
  });

  it('names the split and the model it read, or says unknown', () => {
    const lines = reportLines(wide, settings(), { split: 'dev', model: 'deepseek-chat' }).join('\n');
    expect(lines).toContain('(dev, deepseek-chat)');
    expect(reportLines(wide, settings(), {}).join('\n')).toContain('(unknown, unknown)');
  });
});

describe('settings', () => {
  it('requires an artifact', () => {
    expect(() => resolvePoolSettings([], '/tmp')).toThrow(/--artifact is required/);
  });

  it('defaults the margin and reads a stated one', () => {
    expect(resolvePoolSettings(['--artifact', 'a.json'], '/tmp').margin).toBe(DEFAULT_MARGIN_PP);
    expect(resolvePoolSettings(['--artifact', 'a.json', '--margin', '4'], '/tmp').margin).toBe(4);
  });

  it('refuses a margin that is not a positive number', () => {
    expect(() => resolvePoolSettings(['--artifact', 'a.json', '--margin', 'zero'], '/tmp')).toThrow(/positive number/);
    expect(() => resolvePoolSettings(['--artifact', 'a.json', '--margin', '0'], '/tmp')).toThrow(/positive number/);
  });

  it('reads the json flag', () => {
    expect(resolvePoolSettings(['--artifact', 'a.json', '--json'], '/tmp').json).toBe(true);
  });

  it('refuses an argument it does not know instead of dropping it', () => {
    // The regression: CI called `bench:bird:pool eval/out/bird-eval.json`, the harness ignored the
    // path, and the step failed saying the flag was missing — a message about the caller's clear
    // intent rather than about their mistake.
    expect(() => resolvePoolSettings(['eval/out/bird-eval.json'], '/tmp')).toThrow(/unrecognized argument eval\/out\/bird-eval\.json/);
    expect(() => resolvePoolSettings(['--artifact', 'a.json', '--strct'], '/tmp')).toThrow(/unrecognized argument --strct/);
  });
});

describe('entry points', () => {
  it('prints the report for an artifact on disk', () => {
    const file = scratch('bird-eval.json', {
      split: 'dev',
      cases: [one('select', 1, true, ['select:yes']), one('select-mixed', 1, false, ['values:no'])],
    });
    const printed: string[] = [];
    expect(main(['--artifact', file], '/tmp', (line) => printed.push(line))).toBe(0);
    expect(printed.join('\n')).toContain('candidate pools on 1 questions');
  });

  it('prints one json object with the pools and the steps', () => {
    const file = scratch('bird-eval.json', { cases: [one('select', 1, true, ['select:yes']), one('select-mixed', 1, true, ['values:yes'])] });
    const printed: string[] = [];
    expect(main(['--artifact', file, '--json'], '/tmp', (line) => printed.push(line))).toBe(0);
    const parsed = JSON.parse(printed.join('\n')) as { cases: number; pools: string[]; union: number; steps: { name: string }[] };
    expect(parsed.cases).toBe(1);
    expect(parsed.union).toBe(1);
    expect(parsed.steps[0]?.name).toBe('select');
  });

  it('refuses an artifact with no candidate set instead of printing an empty table', () => {
    const file = scratch('bird-eval.json', { cases: [one('names', 1, true)] });
    expect(() => main(['--artifact', file], '/tmp', () => undefined)).toThrow(/keeps no candidate set/);
  });

  it('runs only when it is the entry point', () => {
    expect(dispatch('/somewhere/else.ts', 'file:///workspace/nl2charts/eval/bird/pool.ts', [], '/tmp')).toBeUndefined();
    expect(dispatch(undefined, 'file:///workspace/nl2charts/eval/bird/pool.ts', [], '/tmp')).toBeUndefined();
  });

  it('returns the exit code of the run it dispatches', () => {
    expect(dispatch('/x.ts', 'file:///x.ts', ['--artifact', 'a'], '/tmp', () => undefined, () => undefined, () => 0)).toBe(0);
  });

  it('turns a thrown error into one line and a non-zero exit', () => {
    const printed: string[] = [];
    const code = dispatch(
      '/x.ts',
      'file:///x.ts',
      [],
      '/tmp',
      () => undefined,
      (line) => printed.push(line),
      () => {
        throw new Error('no artifact');
      },
    );
    expect(code).toBe(1);
    expect(printed).toEqual(['no artifact']);
  });

  it('prints a thrown non-error as itself', () => {
    const printed: string[] = [];
    dispatch(
      '/x.ts',
      'file:///x.ts',
      [],
      '/tmp',
      () => undefined,
      (line) => printed.push(line),
      () => {
        throw 'plain';
      },
    );
    expect(printed).toEqual(['plain']);
  });
});
