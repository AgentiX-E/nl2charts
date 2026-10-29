/**
 * The strata reading, tested on the shapes an artifact actually takes.
 *
 * The tool exists because a pooled delta across two arms that ran a different number of
 * distinct prompts is not one comparison. Everything here is a function of an artifact, so
 * the fixtures are artifacts: a paired case list, the candidate-set record that names the
 * duplicated questions, and the runner's own ablation row to agree with.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import {
  checkAgainstAblation,
  conclusion,
  isEntry,
  main,
  pairCases,
  reportLines,
  resolveStrataSettings,
  stratify,
  summariseStratum,
} from '../eval/bird/strata.js';

const ROOT = process.cwd();

interface Case {
  arm: string;
  id: string;
  passed: boolean;
}

/**
 * Two arms over six questions.
 *
 * `first` wins q1, q2 and q5; `against` wins q3; both are wrong on q4 and q6. q5 and q6 are
 * the questions where `first` duplicated one of its three prompts, so the duplicated stratum
 * is 1 of 2 and the distinct one is 2 of 4 — imbalanced in the same direction as the pooled
 * row, which is the case the reading has to be able to call consistent.
 */
const cases: Case[] = [
  { arm: 'first', id: 'q1', passed: true },
  { arm: 'first', id: 'q2', passed: true },
  { arm: 'first', id: 'q3', passed: false },
  { arm: 'first', id: 'q4', passed: false },
  { arm: 'first', id: 'q5', passed: true },
  { arm: 'first', id: 'q6', passed: false },
  { arm: 'against', id: 'q1', passed: false },
  { arm: 'against', id: 'q2', passed: false },
  { arm: 'against', id: 'q3', passed: true },
  { arm: 'against', id: 'q4', passed: false },
  { arm: 'against', id: 'q5', passed: false },
  { arm: 'against', id: 'q6', passed: false },
];

/** The runner's pooled row for those two arms: (1 − 3) / 6, with one case each way in the strata. */
const ablation = { delta: -2 / 6, onlyFirst: 3, onlySecond: 1 };

const artifact = (over: Record<string, unknown> = {}): Parameters<typeof stratify>[0] =>
  ({
    split: 'dev',
    cases,
    mixedCandidatePrompts: [{ arm: 'first', questions: 6, withAllDistinct: 4, degenerate: 2, degenerateIds: ['q5', 'q6'] }],
    ablations: { 'first -> against': ablation },
    ...over,
  }) as Parameters<typeof stratify>[0];

describe('pairing two arms', () => {
  it('pairs the questions both arms scored and names the one only one of them did', () => {
    const { pairs, unpaired } = pairCases(cases, 'first', 'against');
    expect(pairs).toHaveLength(6);
    expect(unpaired).toEqual([]);
    // A question one arm never answered is not a question it answered wrongly: scoring it as
    // a failure would make an endpoint timeout look like a modelling result.
    const withHole = pairCases(cases.filter((row) => !(row.arm === 'against' && row.id === 'q4')), 'first', 'against');
    expect(withHole.pairs.map((pair) => pair.id)).toEqual(['q1', 'q2', 'q3', 'q5', 'q6']);
    expect(withHole.unpaired).toEqual(['q4']);
  });

  it('names a case the second arm alone scored, which the first arm never ran', () => {
    const extra = [...cases, { arm: 'against', id: 'q7', passed: true }];
    expect(pairCases(extra, 'first', 'against').unpaired).toEqual(['q7']);
  });
});

describe('one stratum', () => {
  it('reports the paired delta, its interval, p and the cases a 2pp claim would need', () => {
    const row = summariseStratum('all', [
      { first: true, second: false },
      { first: true, second: false },
      { first: false, second: true },
      { first: true, second: true },
      { first: false, second: false },
    ]);
    expect(row).toMatchObject({ stratum: 'all', n: 5, first: 3, second: 2, onlyFirst: 2, onlySecond: 1 });
    // Sign convention is the runner's: against minus first.
    expect(row.delta).toBeCloseTo(-0.2, 10);
    expect(row.ci.low).toBeLessThan(-0.2);
    expect(row.ci.high).toBeGreaterThan(-0.2);
    expect(row.p).toBeGreaterThan(0.5);
    // Two discordant cases in five is a 40% discordance rate, so a 2pp claim needs thousands.
    expect(row.casesForClaim).toBeGreaterThan(3000);
    expect(row.mde).toBeGreaterThan(0.3);
  });

  it('refuses to call an empty stratum a tie', () => {
    const row = summariseStratum('degenerate', []);
    expect(row.n).toBe(0);
    expect(Number.isNaN(row.delta)).toBe(true);
    expect(Number.isNaN(row.p)).toBe(true);
    expect(row.casesForClaim).toBe(0);
  });
});

describe('splitting by candidate independence', () => {
  it('splits on the first arm\'s duplicated prompts, and the strata add up to the pooled row', () => {
    const reading = stratify(artifact(), 'first', 'against');
    expect(reading.rows.map((row) => row.stratum)).toEqual(['all', 'distinct', 'degenerate']);
    expect(reading.rows.map((row) => row.n)).toEqual([6, 4, 2]);
    const [, distinct, degenerate] = reading.rows;
    expect(distinct).toMatchObject({ first: 2, second: 1, onlyFirst: 2, onlySecond: 1 });
    expect(degenerate).toMatchObject({ first: 1, second: 0, onlyFirst: 1, onlySecond: 0 });
    expect((distinct?.n ?? 0) + (degenerate?.n ?? 0)).toBe(reading.rows[0]?.n);
    expect(reading.problems).toEqual([]);
    expect(reading.stratifier).toEqual({ arm: 'first', degenerate: 2, questions: 6, complete: true });
  });

  it('says the comparison cannot be stratified when the artifact records no candidate set', () => {
    const reading = stratify(artifact({ mixedCandidatePrompts: [] }), 'first', 'against');
    expect(reading.rows).toHaveLength(1);
    expect(reading.stratifier).toBeUndefined();
    // Absent is not empty: one pooled row with a reason, not a stratum of zero.
    expect(reading.problems[0]).toContain('records no candidate set for first');
  });

  it('refuses to build a stratum from a list that does not cover the count', () => {
    const reading = stratify(
      artifact({ mixedCandidatePrompts: [{ arm: 'first', questions: 6, withAllDistinct: 4, degenerate: 2, degenerateIds: ['q5'] }] }),
      'first',
      'against',
    );
    expect(reading.rows).toHaveLength(1);
    expect(reading.problems[0]).toContain('lists 1 duplicated prompts for first and counts 2');
  });

  it('refuses a count with no list behind it', () => {
    const reading = stratify(
      artifact({ mixedCandidatePrompts: [{ arm: 'first', questions: 6, withAllDistinct: 4, degenerate: 2 }] }),
      'first',
      'against',
    );
    expect(reading.rows).toHaveLength(1);
    expect(reading.problems[0]).toContain('does not list them');
  });
});

describe('auditing the pooled row against the run that wrote the artifact', () => {
  it('agrees with the artifact\'s own ablation row', () => {
    expect(checkAgainstAblation(stratify(artifact(), 'first', 'against'), artifact())).toEqual([]);
  });

  it('fails a pooled row the artifact contradicts, naming both numbers', () => {
    const wrong = artifact({ ablations: { 'first -> against': { delta: -0.6, onlyFirst: 3, onlySecond: 1 } } });
    const problems = checkAgainstAblation(stratify(wrong, 'first', 'against'), wrong);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('delta -0.6 in the artifact and -0.3333333333333333 from its cases');
  });

  it('says so when there is no ablation row to audit against', () => {
    const bare = artifact({ ablations: {} });
    expect(checkAgainstAblation(stratify(bare, 'first', 'against'), bare)).toEqual([
      'the artifact carries no ablation row for first -> against, so the pooled row is unaudited',
    ]);
  });
});

describe('what the reading is allowed to conclude', () => {
  it('calls a same-sign delta not a composition effect, and names the resolutions', () => {
    const text = conclusion(stratify(artifact(), 'first', 'against'));
    expect(text).toContain('the same sign in both strata');
    expect(text).toContain('not a composition effect');
    expect(text).toContain('neither stratum resolves better than');
  });

  it('calls opposite signs a weighted average of two populations', () => {
    // The duplicated half pulled the other way: q5 is wrong for both arms and q6 only
    // `against` gets, so that stratum is +100% where the distinct one is −25%.
    const crossed = cases.map((row) =>
      row.id === 'q5' ? { ...row, passed: false } : row.id === 'q6' ? { ...row, passed: row.arm === 'against' } : row,
    );
    const text = conclusion(stratify(artifact({ cases: crossed }), 'first', 'against'));
    expect(text).toContain('opposite signs in the two strata');
    expect(text).toContain('describes neither');
  });

  it('says a stratum with no difference cannot share the pooled sign', () => {
    // One win each way inside the duplicated half: exactly even, which is neither the pooled
    // direction nor the opposite of it, so the pooled number is carried by the other half.
    const even = cases.map((row) =>
      row.id === 'q5' ? { ...row, passed: row.arm === 'first' } : row.id === 'q6' ? { ...row, passed: row.arm === 'against' } : row,
    );
    const text = conclusion(stratify(artifact({ cases: even }), 'first', 'against'));
    expect(text).toContain('no difference at all in one stratum');
  });

  it('names the other half when the distinct stratum is the flat one', () => {
    // One win each way outside the duplicated stratum, and the duplicated half still carries
    // the difference: the sentence has to name the *other* half rather than assume which one
    // went flat.
    const flat = cases.map((row) =>
      row.id === 'q2' ? { ...row, passed: row.arm === 'against' } : row.id === 'q3' ? { ...row, passed: true } : row,
    );
    const text = conclusion(stratify(artifact({ cases: flat }), 'first', 'against'));
    expect(text).toContain('(all prompts distinct: 0.0pp)');
    expect(text).toContain('-50.0pp with a duplicated prompt');
  });

  it('answers when no stratum was available', () => {
    const text = conclusion(stratify(artifact({ mixedCandidatePrompts: [] }), 'first', 'against'));
    expect(text).toContain('unanswered');
  });
});

describe('rendering', () => {
  it('prints a row per stratum, the stratifier\'s provenance and no dropped-case line', () => {
    const lines = reportLines(stratify(artifact(), 'first', 'against')).join('\n');
    expect(lines).toContain('first vs against on dev: 6 paired cases');
    expect(lines).toContain('| all cases | 6 | 50.0% | 16.7% | -33.3pp |');
    expect(lines).toContain('| all prompts distinct | 4 | 50.0% | 25.0% |');
    expect(lines).toContain('| first arm duplicated a prompt | 2 | 50.0% | 0.0% |');
    expect(lines).toContain('2 of 6 questions could not build the declared number of distinct prompts');
    expect(lines).not.toContain('Dropped');
  });

  it('dashes an empty stratum instead of printing a zero that reads as a tie', () => {
    const onlyDistinct = cases.filter((row) => !['q5', 'q6'].includes(row.id));
    const lines = reportLines(stratify(artifact({ cases: onlyDistinct }), 'first', 'against')).join('\n');
    expect(lines).toContain('| first arm duplicated a prompt | 0 | — | — | — | — | — | — | — |');
  });

  it('prints the reason a comparison could not be stratified', () => {
    const lines = reportLines(stratify(artifact({ mixedCandidatePrompts: [] }), 'first', 'against')).join('\n');
    expect(lines).toContain('note: the artifact records no candidate set for first');
  });

  it('prints the dropped cases when one arm never scored them', () => {
    const holed = cases.filter((row) => !(row.arm === 'against' && row.id === 'q4'));
    const lines = reportLines(stratify(artifact({ cases: holed }), 'first', 'against')).join('\n');
    expect(lines).toContain('Dropped 1 cases one arm never scored (q4)');
  });
});

describe('an artifact that says less than this one', () => {
  it('reads a file with no cases and no split as empty rather than as an error', () => {
    const reading = stratify({}, 'first', 'against');
    expect(reading.split).toBe('unknown');
    expect(reading.pooled.n).toBe(0);
    expect(reading.rows).toHaveLength(1);
    expect(reading.unpaired).toEqual([]);
  });

  it('does not call an empty pooled row a contradiction, and says why it cannot audit it', () => {
    // Nothing was scored, so the artifact's counts are about a measurement that did not
    // happen. Reporting "the readers disagree" there would be a red light for an absent run.
    const empty = { split: 'dev', cases: [], ablations: { 'first -> against': { delta: -0.2, onlyFirst: 2, onlySecond: 1 } } };
    expect(checkAgainstAblation(stratify(empty, 'first', 'against'), empty)).toEqual([
      'first -> against has no paired cases in this artifact, so there is no pooled row to audit',
    ]);
  });
});

describe('the entry, run the way a reader runs it', () => {
  it('knows when it is the entry point, including when there is no argv at all', () => {
    const own = pathToFileURL(join(ROOT, 'eval/bird/strata.ts')).href;
    expect(isEntry(join(ROOT, 'eval/bird/strata.ts'), own)).toBe(true);
    expect(isEntry(join(ROOT, 'eval/bird/run.ts'), own)).toBe(false);
    expect(isEntry(undefined, own)).toBe(false);
  });

  it('defaults to the artifact the benchmark writes and honours --report', () => {
    expect(resolveStrataSettings(['--arm', 'a', '--against', 'b'], {}, '/root').reportPath).toBe('/root/eval/out/bird-eval.json');
    expect(resolveStrataSettings(['--arm', 'a', '--against', 'b', '--report', '/tmp/x.json'], {}, '/root').reportPath).toBe('/tmp/x.json');
    expect(resolveStrataSettings(['--arm', 'a', '--against', 'b'], { BIRD_REPORT: '/tmp/y.json' }, '/root').reportPath).toBe('/tmp/y.json');
  });

  it('refuses a call with no second arm, or with the same arm twice', () => {
    expect(() => resolveStrataSettings(['--arm', 'a'], {}, '/root')).toThrow('usage: strata.ts');
    expect(() => resolveStrataSettings(['--arm', 'a', '--against', 'a'], {}, '/root')).toThrow('usage: strata.ts');
  });

  it('prints the table for a real artifact file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-root-'));
    writeFileSync(join(root, 'artifact.json'), JSON.stringify(artifact()));
    const printed: string[] = [];
    const log = console.log;
    console.log = (line: string) => printed.push(line);
    try {
      await main(['--arm', 'first', '--against', 'against', '--report', join(root, 'artifact.json')], {}, root);
    } finally {
      console.log = log;
    }
    expect(printed.join('\n')).toContain('| all cases | 6 |');
  });

  it('throws when its own reading contradicts the artifact, rather than exiting 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-bad-'));
    writeFileSync(join(root, 'artifact.json'), JSON.stringify(artifact({ ablations: { 'first -> against': { delta: 0.4 } } })));
    const log = console.log;
    console.log = () => undefined;
    try {
      await expect(main(['--arm', 'first', '--against', 'against', '--report', join(root, 'artifact.json')], {}, root)).rejects.toThrow('the two readers disagree');
    } finally {
      console.log = log;
    }
  });

  it('is executable as a script, because that is how a reader runs it', () => {
    // Imported, `import.meta.url` is never the entry, so the guard stays dark in every other
    // test in this file — and a guard that never fires is a CLI nobody has run.
    const root = mkdtempSync(join(tmpdir(), 'strata-cli-'));
    const path = join(root, 'artifact.json');
    writeFileSync(path, JSON.stringify(artifact()));
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'eval/bird/strata.ts'), '--arm', 'first', '--against', 'against', '--report', path], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(result.stderr).not.toContain('Error');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('first vs against on dev: 6 paired cases');
  });
});
