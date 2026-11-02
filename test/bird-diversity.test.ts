/**
 * The diversity instrument: how many independent opinions a pool actually carries.
 *
 * `pool.test.ts` pins the union arithmetic — what one more candidate buys. This file pins the
 * question underneath it, and every test is one of three shapes:
 *
 * - **the arithmetic of sole carriage**, because a source's hit rate is not its value: three
 *   sources that agree on the cases they get right each look valuable and none is;
 * - **the two controls that keep a verdict from being printed for free** — a bank where diversity
 *   is real and a bank where it is absent must produce different readings of the same size;
 * - **the refusals**, because an arm with no candidate record is a mistake in the step that named
 *   it and must not print a table of zeros that reads as "the pool is redundant".
 *
 * The branches are synthetic on purpose. An earlier version of this file asserted the published
 * dev artifact's numbers by reading `eval/out/bird-eval-41453395203.json`, which the repository does
 * not carry: it passed here and failed in CI, which is the shape of a test that only runs on one
 * machine. The artifact-level reading belongs where the artifact exists — the `bench:bird:diversity`
 * step in `bird-dev.yml` prints it on every dispatched run — and this file keeps the arithmetic.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MINIMUM_INSTRUMENT_SAMPLE,
  candidateCases,
  dispatch,
  diversityLines,
  diversityRead,
  largestPool,
  main,
  poolingArms,
  resolveDiversitySettings,
  scoredArms,
} from '../eval/bird/diversity.js';
import type { DiversityArtifact } from '../eval/bird/diversity.js';

type Row = NonNullable<DiversityArtifact['cases']>[number];

const ROOT = '/repo';

interface Candidate {
  readonly source: string;
  readonly correct: boolean;
  readonly fingerprint?: string;
}

/** One case: its id, and the candidates the arm kept with their verdicts and result fingerprints. */
function run(id: string, candidates: readonly Candidate[], arm = 'select-cross'): Row {
  return {
    id,
    arm,
    passed: candidates.some((candidate) => candidate.correct),
    candidates: candidates.map((candidate) => ({
      source: candidate.source,
      correct: candidate.correct,
      ...(candidate.fingerprint === undefined ? {} : { fingerprint: candidate.fingerprint }),
    })),
  };
}

/**
 * A bank built to make every reading non-trivial.
 *
 * Ten cases, three sources. `a` is right on 5, `b` on 5, `c` on 5 — a hit rate that cannot tell
 * them apart. What separates them is *where*: `c` carries two cases alone, `a` one, `b` none.
 * Two cases have no correct candidate, one of them unanimous (the correlated loss a selector
 * cannot reach) and one where the three disagree (a selection problem, not a diversity one).
 */
function bank(cases = 10, offset = 0): Row[] {
  const rows: Row[] = [];
  for (let index = 0; index < cases; index += 1) {
    const shared = index < 4;
    const onlyA = index === 4;
    const onlyC = index === 5 || index === 6;
    const bothBC = index === 7;
    const unanimousWrong = index === 8;
    const disagreedWrong = index === 9;
    if (shared) {
      rows.push(run(String(index + offset), [
        { source: 'a', correct: true, fingerprint: 'g' },
        { source: 'b', correct: true, fingerprint: 'g' },
        { source: 'c', correct: true, fingerprint: 'g' },
      ]));
    } else if (onlyA) {
      rows.push(run(String(index + offset), [
        { source: 'a', correct: true, fingerprint: 'g' },
        { source: 'b', correct: false, fingerprint: 'x' },
        { source: 'c', correct: false, fingerprint: 'y' },
      ]));
    } else if (onlyC) {
      rows.push(run(String(index + offset), [
        { source: 'a', correct: false, fingerprint: 'x' },
        { source: 'b', correct: false, fingerprint: 'y' },
        { source: 'c', correct: true, fingerprint: 'g' },
      ]));
    } else if (bothBC) {
      rows.push(run(String(index + offset), [
        { source: 'a', correct: false, fingerprint: 'x' },
        { source: 'b', correct: true, fingerprint: 'g' },
        { source: 'c', correct: true, fingerprint: 'g' },
      ]));
    } else if (unanimousWrong) {
      rows.push(run(String(index + offset), [
        { source: 'a', correct: false, fingerprint: 'x' },
        { source: 'b', correct: false, fingerprint: 'x' },
        { source: 'c', correct: false, fingerprint: 'x' },
      ]));
    } else if (disagreedWrong) {
      rows.push(run(String(index + offset), [
        { source: 'a', correct: false, fingerprint: 'x' },
        { source: 'b', correct: false, fingerprint: 'y' },
        { source: 'c', correct: false, fingerprint: 'z' },
      ]));
    }
  }
  return rows;
}

/** Repeat a bank until it clears the sample floor, keeping the shares exact. */
function cleared(): Row[] {
  const rows: Row[] = [];
  for (let index = 0; index < 11; index += 1) rows.push(...bank(10, index * 10));
  return rows;
}

describe('which arms can be read at all', () => {
  it('names the arms the artifact scored, and the narrower set that kept candidates', () => {
    const report: DiversityArtifact = { cases: [...bank(10), run('99', [], 'plain')] };
    expect(scoredArms(report)).toEqual(['select-cross', 'plain']);
    // `plain` was scored but kept no candidate record, so it has no pool to read.
    expect(poolingArms(report)).toEqual(['select-cross']);
  });

  it('reads the largest pool when no arm is named, because a small one is a share of the draw', () => {
    const report: DiversityArtifact = {
      cases: [...cleared(), run('900', [{ source: 'a', correct: true }], 'select-cross-pooled-vote')],
    };
    expect(largestPool(report)).toBe('select-cross');
    expect(largestPool({ cases: [run('0', [], 'plain')] })).toBeUndefined();
  });

  it('refuses an arm the artifact never scored, and names the ones it has', () => {
    const report: DiversityArtifact = { cases: bank(10) };
    expect(() => candidateCases(report, 'select-mixed', 'artifact.json')).toThrow(/has no arm select-mixed; it holds select-cross/);
  });

  it('refuses an arm with no candidate record, and names the arms that do', () => {
    const report: DiversityArtifact = { cases: [...bank(10), run('99', [], 'plain')] };
    expect(() => candidateCases(report, 'plain', 'artifact.json')).toThrow(
      /plain keeps no candidate record in artifact.json, so it has no pool to read; the arms that do are select-cross/,
    );
  });

  it('refuses an artifact with no candidate records at all, without claiming an arm is missing', () => {
    // The two absences are different: "you named an arm nobody ran" is a mistake in the step,
    // "this artifact has no pools" is a property of the run, and the message must not merge them.
    const report: DiversityArtifact = { cases: [run('0', [], 'inline+evidence')] };
    expect(() => candidateCases(report, 'inline+evidence', 'artifact.json')).toThrow(
      /keeps no candidate record at all, so no pool can be read from it/,
    );
  });

  it('refuses a share computed below the sample floor', () => {
    const report: DiversityArtifact = { cases: bank(10) };
    expect(() => diversityRead(report, 'select-cross', 'artifact.json')).toThrow(
      new RegExp(`10 cases with candidates, under the ${String(MINIMUM_INSTRUMENT_SAMPLE)} this instrument needs`),
    );
  });
});

describe('malformed records, which are refused rather than read', () => {
  it('refuses a case with no id and a candidate with no source', () => {
    // Both are `stringField` refusals: an empty string is as unusable as a missing one, and the
    // message names which field is missing so the artifact can be fixed rather than guessed at.
    const noId = [{ id: '', arm: 'select-cross', candidates: [{ source: 'a', correct: true }] }];
    expect(() => candidateCases({ cases: noId }, 'select-cross', 'artifact.json')).toThrow(/a case has no id/);
    const noSource = [{ id: '0', arm: 'select-cross', candidates: [{ correct: true }] }];
    expect(() => candidateCases({ cases: noSource }, 'select-cross', 'artifact.json')).toThrow(/a case has no candidate source/);
  });

  it('ignores rows whose arm is not a name, in all three readers', () => {
    // A row with no arm cannot belong to any pool, and reading it as one would put a case into a
    // denominator that the reader then divides by.
    const report: DiversityArtifact = { cases: [...bank(10), { id: 'x', arm: 42, candidates: [{ source: 'a', correct: true }] }] };
    expect(scoredArms(report)).toEqual(['select-cross']);
    expect(poolingArms(report)).toEqual(['select-cross']);
    expect(largestPool(report)).toBe('select-cross');
  });

  it('reads an artifact with no case list as an artifact with no pools', () => {
    expect(scoredArms({})).toEqual([]);
    expect(poolingArms({})).toEqual([]);
    expect(largestPool({})).toBeUndefined();
  });

  it('picks the largest pool whichever order the arms appear in', () => {
    const small = run('0', [{ source: 'a', correct: true }], 'select-cross-pooled-vote');
    const large = cleared();
    expect(largestPool({ cases: [small, ...large] })).toBe('select-cross');
    expect(largestPool({ cases: [...large, small] })).toBe('select-cross');
  });
});

describe('rows that belong to the arm but not to the pool', () => {
  it('skips a row with no candidate array or an empty one, and says so when there are only those', () => {
    // A pooled arm can score a case after the pool was read; counting it would put a question in
    // the denominator that no candidate ever answered. Both shapes are skipped, and an arm whose
    // every row is one of them has no pool rather than an empty one.
    const rows: DiversityArtifact['cases'] = [
      ...bank(10),
      { id: 'no-array', arm: 'select-cross', candidates: undefined },
      { id: 'empty', arm: 'select-cross', candidates: [] },
    ];
    expect(candidateCases({ cases: rows }, 'select-cross', 'artifact.json')).toHaveLength(10);
    const onlyEmpty: DiversityArtifact['cases'] = [{ id: 'empty', arm: 'select-cross', candidates: [] }];
    // And with no row carrying candidates anywhere, the artifact has no pools rather than one
    // empty pool — a sentence about the artifact, not about the arm.
    expect(() => candidateCases({ cases: onlyEmpty }, 'select-cross', 'artifact.json')).toThrow(
      /artifact\.json keeps no candidate record at all, so no pool can be read from it/,
    );
  });

  it('refuses an artifact with no case list before it blames the flag', () => {
    // The order of the two refusals is the point: an artifact holding nothing is not a mistyped arm.
    expect(() => candidateCases({}, 'select-cross', 'artifact.json')).toThrow(/carries no cases at all, so no pool can be read from it/);
    expect(() => candidateCases({ cases: [] }, 'select-cross', 'artifact.json')).toThrow(/carries no cases at all/);
  });
});

describe('what the reading counts', () => {
  const read = diversityRead({ cases: cleared() }, 'select-cross');

  it('counts the ceiling once per case, not once per correct candidate', () => {
    // 4 shared + onlyA + two onlyC + bothBC = 8 of every 10 cases have a correct candidate.
    expect(read.cases).toBe(110);
    expect(read.ceiling).toBe(88);
  });

  it('separates a hit rate from a source that carries cases alone', () => {
    // `a` and `b` are right exactly as often as each other — 5 of every 10 cases — and the number
    // cannot tell them apart. What separates them is that one of those cases is `b`'s own.
    expect(read.sources.map((source) => [source.source, source.correct])).toEqual([
      ['a', 55],
      ['b', 55],
      ['c', 77],
    ]);
    // The sole column is what separates them: `c` carries the pool on two cases, `a` on one,
    // and `b` on none even though it is right exactly as often.
    expect(read.sources.map((source) => [source.source, source.sole])).toEqual([
      ['a', 11],
      ['b', 0],
      ['c', 22],
    ]);
  });

  it('prices a source by the ceiling that would be lost without it', () => {
    const lost = Object.fromEntries(read.marginals.map((row) => [row.source, row.lost]));
    expect(lost).toEqual({ a: 11, b: 0, c: 22 });
    // Removing `b` costs nothing: every case it gets right is also got right by someone else.
    expect(read.marginals.find((row) => row.source === 'b')?.without).toBe(read.ceiling);
  });

  it('counts the opinions per case, and the cases where there was only one', () => {
    // 4 shared + 1 unanimous-wrong = 5 of 10 cases carry a single opinion.
    expect(read.distinct.unanimous).toBe(55);
    expect(read.distinct.unanimousCorrect).toBe(44);
    expect(read.distinct.max).toBe(3);
    // 4 shared + 1 unanimous-wrong carry one opinion, 1 carries two, the other 4 carry three.
    expect(read.distinct.mean).toBeCloseTo(1.9, 6);
  });

  it('splits the ceiling loss into correlated and selection failures', () => {
    // Two cases have no correct candidate; on one the three agree, on the other they disagree.
    expect(read.correlated).toEqual({ cases: 22, unanimous: 11 });
  });

  it('treats a record with no fingerprint as its own opinion rather than dropping it', () => {
    // A missing fingerprint is a record that cannot be compared. Counting it as "the same as
    // everything else" would make a pool look redundant; dropping it would make the pool look
    // smaller than it is. It is therefore one opinion, named after its source.
    const rows = [
      ...cleared(),
      run('unfingerprinted', [
        { source: 'a', correct: true },
        { source: 'b', correct: true },
        { source: 'c', correct: true },
      ]),
    ];
    const read = diversityRead({ cases: rows }, 'select-cross');
    expect(read.distinct.unanimous).toBe(55);
    expect(read.distinct.mean).toBeCloseTo((1.9 * 110 + 3) / 111, 6);
  });

  it('prints a table whose numbers agree with the reading', () => {
    const printed = diversityLines(read).join('\n');
    expect(printed).toContain('ceiling (any candidate correct)');
    expect(printed).toContain('distinct results per case');
    expect(printed).toContain('unanimous cases');
    expect(printed).toContain('cases with no correct candidate');
    // The denominator of the correlated share is the loss, not the corpus: 11 of 22, not 11 of 110.
    expect(printed).toMatch(/of which the candidates agreed 11 \(50\.00%\)/);
    expect(printed).toMatch(/ceiling \(any candidate correct\)\s+88\s+80\.00%/);
  });
});

describe('the controls, which are what make the reading mean something', () => {
  it('reports the redundancy when the pool is three draws of one opinion', () => {
    const rows: Row[] = [];
    for (let index = 0; index < 120; index += 1) {
      rows.push(run(String(index), [
        { source: 'a', correct: index % 4 === 0, fingerprint: 'same' },
        { source: 'b', correct: index % 4 === 0, fingerprint: 'same' },
        { source: 'c', correct: index % 4 === 0, fingerprint: 'same' },
      ]));
    }
    const read = diversityRead({ cases: rows }, 'select-cross');
    expect(read.distinct.unanimous).toBe(120);
    expect(read.distinct.mean).toBe(1);
    // Every source is right 30 times and none of them carries a case alone.
    expect(read.sources.map((source) => source.sole)).toEqual([0, 0, 0]);
    expect(read.marginals.map((row) => row.lost)).toEqual([0, 0, 0]);
    // And the loss is entirely correlated: the pool agrees on its way to being wrong.
    expect(read.correlated).toEqual({ cases: 90, unanimous: 90 });
  });

  it('reports the opposite when the pool is three genuinely different attempts', () => {
    const rows: Row[] = [];
    for (let index = 0; index < 120; index += 1) {
      // Each source is right on its own third, and no two agree on their result.
      rows.push(run(String(index), [
        { source: 'a', correct: index % 3 === 0, fingerprint: `a${String(index)}` },
        { source: 'b', correct: index % 3 === 1, fingerprint: `b${String(index)}` },
        { source: 'c', correct: index % 3 === 2, fingerprint: `c${String(index)}` },
      ]));
    }
    const read = diversityRead({ cases: rows }, 'select-cross');
    expect(read.ceiling).toBe(120);
    expect(read.distinct.unanimous).toBe(0);
    expect(read.distinct.mean).toBe(3);
    expect(read.correlated).toEqual({ cases: 0, unanimous: 0 });
    expect(read.sources.map((source) => source.sole)).toEqual([40, 40, 40]);
  });
});

describe('the entry, run the way a workflow runs it', () => {
  const written: string[] = [];
  afterEach(() => {
    for (const path of written.splice(0)) expect(() => readFileSync(path)).not.toThrow();
  });

  function artifact(rows: readonly Row[]): { root: string; path: string } {
    const root = mkdtempSync(join(tmpdir(), 'nl2charts-diversity-'));
    const path = join(root, 'bird-eval.json');
    writeFileSync(path, JSON.stringify({ split: 'dev', cases: rows }, null, 2));
    written.push(path);
    return { root, path };
  }

  it('reads the largest pool when no arm is named, and prints the table', () => {
    const { root, path } = artifact(cleared());
    const printed: string[] = [];
    expect(main([path], root, (line) => printed.push(line))).toBe(0);
    expect(printed.join('\n')).toContain('arm select-cross: 110 cases with a candidate record');
  });

  it('writes the reading as JSON when asked, so a later step can cut it', () => {
    const { root, path } = artifact(cleared());
    const out = join(root, 'diversity.json');
    written.push(out);
    const printed: string[] = [];
    expect(main([path, '--arm', 'select-cross', '--out', 'diversity.json'], root, (line) => printed.push(line))).toBe(0);
    const saved = JSON.parse(readFileSync(out, 'utf8')) as { arm: string; ceiling: number };
    expect(saved.arm).toBe('select-cross');
    expect(saved.ceiling).toBe(88);
  });

  it('prints the reading as JSON instead of the table when asked', () => {
    const { root, path } = artifact(cleared());
    const printed: string[] = [];
    expect(main([path, '--json'], root, (line) => printed.push(line))).toBe(0);
    expect(JSON.parse(printed.join('\n'))).toMatchObject({ arm: 'select-cross', cases: 110, ceiling: 88 });
  });

  it('parses the flags it documents and refuses the ones it does not', () => {
    expect(resolveDiversitySettings([], ROOT)).toEqual({ report: join(ROOT, 'eval/out/bird-eval.json'), arm: undefined, json: false, out: undefined });
    expect(resolveDiversitySettings(['--arm', 'select-cross'], ROOT).arm).toBe('select-cross');
    expect(resolveDiversitySettings(['--out', 'x.json'], ROOT).out).toBe('x.json');
    expect(resolveDiversitySettings(['--json'], ROOT).json).toBe(true);
    expect(resolveDiversitySettings(['/tmp/a.json', '--json'], ROOT).report).toBe('/tmp/a.json');
    expect(() => resolveDiversitySettings(['--arm'], ROOT)).toThrow(/--arm needs an arm name/);
    expect(() => resolveDiversitySettings(['--out'], ROOT)).toThrow(/--out needs a path/);
    expect(() => resolveDiversitySettings(['--wat'], ROOT)).toThrow(/unknown flag --wat/);
  });

  it('says which arms can be read when the artifact keeps no pool', () => {
    const { root, path } = artifact([run('0', [], 'inline+evidence')]);
    expect(() => main([path], root, () => undefined)).toThrow(/keeps no candidate record at all, so no pool can be read from it/);
  });

  it('exits one and prints the sentence rather than a stack trace', () => {
    const printed: string[] = [];
    const failed: string[] = [];
    const exit = dispatch('route.ts', 'file:///repo/eval/bird/diversity.ts', [], ROOT, (line) => printed.push(line), (line) => failed.push(line));
    // The entry check is false for a different file, which is what keeps a test import silent.
    expect(exit).toBeUndefined();
    const code = dispatch(
      '/repo/eval/bird/diversity.ts',
      'file:///repo/eval/bird/diversity.ts',
      ['--wat'],
      ROOT,
      (line) => printed.push(line),
      (line) => failed.push(line),
    );
    expect(code).toBe(1);
    expect(failed.join('\n')).toContain('unknown flag --wat');
    expect(printed).toEqual([]);
  });

  it('prints a thrown string as a sentence instead of crashing on it', () => {
    // A tool that throws a string is a tool someone wrote in a hurry; the entry must still print
    // one line and exit one, because a stack trace for a mistyped flag hides the flag.
    const lines: string[] = [];
    const code = dispatch(
      '/repo/eval/bird/diversity.ts',
      'file:///repo/eval/bird/diversity.ts',
      [],
      ROOT,
      () => undefined,
      (line) => lines.push(line),
      () => {
        throw 'not an Error';
      },
    );
    expect(code).toBe(1);
    expect(lines).toEqual(['not an Error']);
  });

  it('still runs the whole path through the entry guard when its own file is the program', () => {
    const { root, path } = artifact(cleared());
    const printed: string[] = [];
    const code = dispatch(path, `file://${path}`, [path], root, (line) => printed.push(line));
    // The guard compares against the module's own URL, so this is the branch a real run takes.
    expect(code).toBe(0);
    expect(printed.join('\n')).toContain('arm select-cross');
  });
});

/** A guard on the instrument's own output shape: a silent field rename must fail here. */
describe('the shape later steps read', () => {
  it('keeps every field a downstream cut names', () => {
    const read = diversityRead({ cases: cleared() }, 'select-cross');
    expect(Object.keys(read).sort()).toEqual(['arm', 'cases', 'ceiling', 'correlated', 'distinct', 'marginals', 'sources']);
    expect(Object.keys(read.distinct).sort()).toEqual(['max', 'mean', 'unanimous', 'unanimousCorrect']);
    expect(Object.keys(read.correlated).sort()).toEqual(['cases', 'unanimous']);
    expect(Object.keys(read.sources[0] ?? {}).sort()).toEqual(['correct', 'generated', 'sole', 'source']);
  });
});
