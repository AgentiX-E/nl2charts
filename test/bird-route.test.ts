/**
 * The routing instrument: two controls, then the reading it produces.
 *
 * A harness that answers "no router works" is worth exactly as much as its ability to say "this
 * router works". Both directions are therefore asserted: one bank where a single feature really
 * does separate the two arms, which the leave-one-database-out loop must recover, and one bank
 * where the pass/fail depends on nothing the router can read, which the loop must report as no
 * gain. Without the first, a broken feature extractor that returned zero for everything would
 * print the same verdict as a real measurement; without the second, an over-eager fitter would
 * be indistinguishable from a working one.
 *
 * The unit cases pin the two pieces of arithmetic a reader is most likely to take on trust: the
 * sign test at its exact extremes, and the stump tie-break that makes two runs on one artifact
 * produce the same rule.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PAIR,
  REQUIRED_GAIN,
  align,
  armsOf,
  dispatch,
  bounds,
  features,
  fitStump,
  groupByDatabase,
  leaveOneOut,
  main,
  mix,
  reportLines,
  resolveRouteSettings,
  scoreStump,
  signTest,
  split,
} from '../eval/bird/route.js';
import type { ArtifactShape, Labelled, RouteSettings } from '../eval/bird/route.js';
import type { BirdQuestion, BirdTable } from '../eval/bird/data.js';

/** A case whose pass set is spelled out, so each test states its own bank. */
function one(
  id: number,
  over: Omit<Partial<Labelled>, 'passed' | 'reasons'> & { passed: Record<string, boolean>; reasons?: Record<string, string> },
): Labelled {
  return {
    id: String(id),
    db: over.db ?? 'shop',
    difficulty: over.difficulty ?? 'simple',
    question: over.question ?? 'How many orders are there?',
    evidence: over.evidence ?? '',
    passed: new Map(Object.entries(over.passed)),
    reasons: new Map(Object.entries(over.reasons ?? {})),
  };
}

function table(db: string, names: readonly string[]): BirdTable {
  return {
    db_id: db,
    tableNames: ['orders'],
    tableNamesReadable: ['orders'],
    columnNames: names.map((name, index) => [index, name] as const),
    columnNamesReadable: names.map((name, index) => [index, name] as const),
    columnTypes: names.map(() => 'text'),
    foreignKeys: [],
  };
}

const LEFT = 'metadata+evidence';
const RIGHT = 'inline+evidence';

/**
 * A bank a router *can* solve: short questions are answered by the left arm and long ones by the
 * right, and every database holds both. The only thing separating them is a feature the extractor
 * computes, so a working loop scores near 100% and a broken one does not.
 */
function separable(): Labelled[] {
  const out: Labelled[] = [];
  for (const db of ['alpha', 'beta']) {
    for (let index = 0; index < 6; index += 1) {
      out.push(one(out.length, { db, question: 'count rows', passed: { [LEFT]: true, [RIGHT]: false } }));
      out.push(
        one(out.length, {
          db,
          question: 'count every single distinct row of the orders table for each customer segment please',
          passed: { [LEFT]: false, [RIGHT]: true },
        }),
      );
    }
  }
  return out;
}

/** A bank no router can solve: the winner alternates with a counter the extractor cannot see. */
function unreadable(): Labelled[] {
  const out: Labelled[] = [];
  for (const db of ['alpha', 'beta']) {
    for (let index = 0; index < 6; index += 1) {
      const leftWins = index % 2 === 0;
      out.push(
        one(out.length, {
          db,
          question: 'count rows',
          passed: { [LEFT]: leftWins, [RIGHT]: !leftWins },
        }),
      );
    }
  }
  return out;
}

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  directories.length = 0;
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'route-'));
  directories.push(directory);
  return directory;
}

describe('align', () => {
  const questions: BirdQuestion[] = [
    { question_id: 7, db_id: 'shop', question: 'How many orders?', evidence: 'orders = `id`', SQL: '', difficulty: 'simple' },
  ];

  it('keeps one row per case and one bit per arm', () => {
    const artifact: ArtifactShape = {
      cases: [
        { id: '7', arm: LEFT, passed: true, reason: 'match' },
        { id: '7', arm: RIGHT, passed: false, reason: 'values' },
      ],
    };
    const ones = align(artifact, questions, new Map());
    expect(ones).toHaveLength(1);
    expect(ones[0]!.passed.get(LEFT)).toBe(true);
    expect(ones[0]!.passed.get(RIGHT)).toBe(false);
    expect(ones[0]!.reasons.get(RIGHT)).toBe('values');
    expect(ones[0]!.db).toBe('shop');
  });

  it('drops a case the corpus cannot describe rather than defaulting its question', () => {
    const artifact: ArtifactShape = { cases: [{ id: '8', arm: LEFT, passed: true }] };
    expect(align(artifact, questions, new Map())).toEqual([]);
  });

  it('ignores a row with no arm, which a truncated artifact can produce', () => {
    const artifact: ArtifactShape = {
      cases: [{ id: '7', arm: '', passed: true }, { id: '7', arm: undefined, passed: true }, { id: '7', arm: LEFT, passed: true }],
    };
    const ones = align(artifact, questions, new Map());
    expect([...ones[0]!.passed.keys()]).toEqual([LEFT]);
  });

  it('orders by numeric id, not by string id', () => {
    const many: BirdQuestion[] = ['2', '10'].map((id) => ({
      question_id: Number(id),
      db_id: 'shop',
      question: 'q',
      evidence: '',
      SQL: '',
      difficulty: 'simple' as const,
    }));
    const artifact: ArtifactShape = { cases: [{ id: '10', arm: LEFT, passed: true }, { id: '2', arm: LEFT, passed: true }] };
    expect(align(artifact, many, new Map()).map((one) => one.id)).toEqual(['2', '10']);
  });

  it('reads an artifact with no cases as an empty corpus', () => {
    expect(align({}, questions, new Map())).toEqual([]);
  });
});

describe('features', () => {
  it('counts what the question states, without the gold statement', () => {
    const vector = features(
      one(1, {
        question: 'How many orders above 500 are rated "gold" between 2 and 4?',
        evidence: 'Use `amount` and `rating` = `tier`',
        passed: {},
      }),
    );
    const value = (name: string): number => vector.find((feature) => feature.name === name)?.value ?? -1;
    expect(value('numbers')).toBe(3);
    expect(value('quoted')).toBe(1);
    expect(value('evidenceSpans')).toBe(3);
    expect(value('evidenceEmpty')).toBe(0);
    expect(value('comparison')).toBe(1);
    expect(value('howMany')).toBe(1);
    expect(value('window')).toBe(0);
  });

  it('reports the same feature names in the same order for every case', () => {
    const names = features(one(1, { passed: {} })).map((feature) => feature.name);
    expect(names).toEqual(features(one(2, { question: 'a much longer question about rankings', passed: {} })).map((feature) => feature.name));
    expect(names).toContain('identifierHits');
  });

  it('reads the schema for identifier hits, and stays at zero when the database is unknown', () => {
    const withSchema = features(one(1, { question: 'How many orders per customer?', passed: {} }), new Map([['shop', table('shop', ['orders', 'customer', 'amount'])]]));
    const without = features(one(1, { question: 'How many orders per customer?', passed: {} }));
    const read = (vector: { name: string; value: number }[], name: string): number => vector.find((feature) => feature.name === name)?.value ?? -1;
    expect(read(withSchema, 'identifierHits')).toBe(2);
    expect(read(withSchema, 'schemaColumns')).toBe(3);
    expect(read(without, 'identifierHits')).toBe(0);
    expect(read(without, 'schemaTables')).toBe(0);
  });

  it('reads the shapes a router would condition on', () => {
    const vector = features(
      one(1, {
        question: 'Which student has the highest rank by ratio of solved tasks?',
        evidence: '',
        passed: {},
      }),
    );
    const value = (name: string): number => vector.find((feature) => feature.name === name)?.value ?? -1;
    expect(value('superlative')).toBe(1);
    expect(value('window')).toBe(1);
    expect(value('ratio')).toBe(1);
    expect(value('whichStart')).toBe(1);
    expect(value('evidenceEmpty')).toBe(1);
  });

  it('treats a missing evidence note as no note rather than as the text "undefined"', () => {
    const bare = { ...one(1, { passed: {} }), evidence: undefined } as unknown as Labelled;
    expect(features(bare).find((feature) => feature.name === 'evidenceChars')?.value).toBe(0);
  });

  it('does not divide by zero on a question with no words', () => {
    const vector = features(one(1, { question: '???', passed: {} }));
    expect(vector.find((feature) => feature.name === 'identifierShare')?.value).toBe(0);
  });
});

describe('split and bounds', () => {
  const bank = [
    one(1, { passed: { [LEFT]: true, [RIGHT]: true } }),
    one(2, { passed: { [LEFT]: true, [RIGHT]: false } }),
    one(3, { passed: { [LEFT]: false, [RIGHT]: true } }),
    one(4, { passed: { [LEFT]: false, [RIGHT]: false } }),
  ];

  it('fills the four cells of a paired comparison', () => {
    expect(split(bank, LEFT, RIGHT)).toEqual({ n: 4, both: 1, leftOnly: 1, rightOnly: 1, neither: 1, left: 2, right: 2 });
  });

  it('separates the best fixed arm from the per-question ceiling', () => {
    const reading = bounds(bank, [LEFT, RIGHT]);
    expect(reading.bestAccuracy).toBe(0.5);
    expect(reading.oracle).toBe(0.75);
  });

  it('reports 0 rather than NaN on an empty bank', () => {
    expect(bounds([], [LEFT, RIGHT])).toEqual({ best: LEFT, bestAccuracy: 0, oracle: 0 });
    expect(bounds(bank, [])).toEqual({ best: '', bestAccuracy: 0, oracle: 0 });
  });
});

describe('signTest', () => {
  it('is 1 when the split is exactly symmetric', () => {
    expect(signTest(65, 66)).toBe(1);
    expect(signTest(0, 0)).toBe(1);
  });

  it('is the exact tail on a small split', () => {
    expect(signTest(0, 3)).toBeCloseTo(0.25, 12);
    expect(signTest(0, 10)).toBeCloseTo(2 / 1024, 12);
  });

  it('falls away as the lopsidedness grows', () => {
    expect(signTest(0, 20)).toBeLessThan(1e-5);
    expect(signTest(59, 354)).toBeLessThan(1e-6);
  });
});

describe('the stump family', () => {
  it('recovers a separation that a question feature really carries', () => {
    const bank = separable();
    const rule = fitStump(bank, LEFT, RIGHT);
    // The bank hands the long questions to the right arm, so a rule fitted in the other
    // orientation would be the harness failing its own control rather than a harder bank.
    expect(rule.above).toBe(RIGHT);
    expect(rule.below).toBe(LEFT);
    expect(scoreStump(bank, rule) / bank.length).toBeGreaterThan(0.99);
  });

  it('recovers it on databases the rule was not fitted on', () => {
    const held = leaveOneOut(separable(), LEFT, RIGHT);
    expect(held.total).toBe(separable().length);
    expect(held.score / held.total).toBeGreaterThan(0.95);
  });

  it('reports no gain when the winner depends on nothing the features can see', () => {
    const bank = unreadable();
    const held = leaveOneOut(bank, LEFT, RIGHT);
    const tuned = Math.max(split(bank, LEFT, RIGHT).left, split(bank, LEFT, RIGHT).right) / bank.length;
    expect(held.score / held.total - tuned).toBeLessThan(REQUIRED_GAIN);
  });

  it('breaks ties the same way twice, so a re-run cannot look like a different reading', () => {
    const bank = unreadable();
    expect(fitStump(bank, LEFT, RIGHT)).toEqual(fitStump(bank, LEFT, RIGHT));
  });

  it('fits nothing on an empty bank, and still answers with a rule that names its arms', () => {
    expect(fitStump([], LEFT, RIGHT)).toEqual({ feature: '', threshold: 0, above: LEFT, below: RIGHT });
    expect(scoreStump([], { feature: 'chars', threshold: 0, above: LEFT, below: RIGHT })).toBe(0);
  });

  it('scores a rule that names a feature this build does not have as the below side', () => {
    const bank = separable().slice(0, 2);
    expect(scoreStump(bank, { feature: 'no-such-feature', threshold: 1, above: LEFT, below: RIGHT })).toBe(
      bank.filter((entry) => entry.passed.get(RIGHT) === true).length,
    );
  });

  it('has nothing to fit on one database, and says so by scoring nothing', () => {
    const held = leaveOneOut(separable().filter((one) => one.db === 'alpha'), LEFT, RIGHT);
    expect(held.total).toBe(0);
    expect(held.folds).toEqual([]);
  });
});

describe('groupByDatabase', () => {
  it('groups in name order so the fold list is stable', () => {
    const groups = groupByDatabase([one(1, { db: 'zeta', passed: {} }), one(2, { db: 'alpha', passed: {} })]);
    expect(groups.map((group) => group.name)).toEqual(['alpha', 'zeta']);
  });
});

describe('mix', () => {
  it('lists the arms the artifact ran, in first-seen order', () => {
    expect(armsOf([one(1, { passed: { [LEFT]: true } }), one(2, { passed: { [RIGHT]: true, [LEFT]: false } })])).toEqual([LEFT, RIGHT]);
  });

  it('counts the cases no arm answered, by the first bucket the judge filed', () => {
    const bank = [
      one(1, { passed: { [LEFT]: true, [RIGHT]: false }, reasons: { [RIGHT]: 'values' } }),
      one(2, { passed: { [LEFT]: false, [RIGHT]: true } }),
      one(3, { passed: { [LEFT]: false, [RIGHT]: false }, reasons: { [LEFT]: 'values', [RIGHT]: 'values' } }),
      one(4, { passed: { [LEFT]: false, [RIGHT]: false }, reasons: { [LEFT]: 'column-count', [RIGHT]: 'values' } }),
      one(5, { passed: { [LEFT]: false, [RIGHT]: false } }),
    ];
    const census = mix(bank, [LEFT, RIGHT]);
    expect(census.failed).toBe(3);
    expect(census.byReason).toEqual([
      { reason: 'column-count', count: 1 },
      { reason: 'unfiled', count: 1 },
      { reason: 'values', count: 1 },
    ]);
  });
});

describe('resolveRouteSettings', () => {
  it('requires an artifact, because this harness produces nothing on its own', () => {
    expect(() => resolveRouteSettings([], '/repo')).toThrow(/--artifact is required/);
  });

  it('defaults to the pair that costs the same call', () => {
    const settings = resolveRouteSettings(['--artifact', 'a.json'], '/repo');
    expect(settings.pair).toEqual(DEFAULT_PAIR);
    expect(settings.questions).toBe(join('/repo', 'eval/.cache/bird/dev/dev_20240627/dev.json'));
    expect(settings.json).toBe(false);
  });

  it('rejects a pair that is not two arms', () => {
    expect(() => resolveRouteSettings(['--artifact', 'a.json', '--pair', 'one'], '/repo')).toThrow(/two arm names/);
  });

  it('takes both arms from the flag', () => {
    const settings = resolveRouteSettings(['--artifact', 'a.json', '--pair', 'names,select', '--json'], '/repo');
    expect(settings.pair).toEqual(['names', 'select']);
    expect(settings.json).toBe(true);
  });
});

describe('reportLines', () => {
  const settings = (pair: readonly [string, string]): RouteSettings => ({
    artifact: 'a.json',
    questions: 'q.json',
    tables: undefined,
    pair,
    json: false,
  });

  it('says a releasable router cleared the criterion only when it did', () => {
    const lines = reportLines(separable(), settings([LEFT, RIGHT]), undefined, { split: 'dev', model: 'm' });
    expect(lines.some((line) => line.includes('clears the 1pp criterion'))).toBe(true);
    expect(lines[1]).toContain('schema features: off');
  });

  it('calls the headroom a ceiling when no rule survives the holdout', () => {
    const lines = reportLines(unreadable(), settings([LEFT, RIGHT]), undefined, {});
    expect(lines.some((line) => line.includes('is a ceiling, not an opportunity'))).toBe(true);
    expect(lines[0]).toContain('unknown');
  });

  it('prints one line per bucket when the union of failures is not empty', () => {
    const bank = [...separable(), one(99, { passed: { [LEFT]: false, [RIGHT]: false }, reasons: { [LEFT]: 'values' } })];
    const lines = reportLines(bank, settings([LEFT, RIGHT]), undefined, {});
    const census = lines.findIndex((line) => line.includes('all 2 arms failed on 1 cases'));
    expect(census).toBeGreaterThan(0);
    expect(lines[census + 1]).toContain('values');
    expect(lines[census + 1]).toContain('100.0%');
  });

  it('reports a held-out reading of 0 when one database leaves nothing to fit on', () => {
    const bank = separable().filter((entry) => entry.db === 'alpha');
    const lines = reportLines(bank, settings([LEFT, RIGHT]), undefined, {});
    expect(lines.some((line) => line.includes('best stump, held out'))).toBe(true);
  });

  it('prints the failure census even when the bank has none', () => {
    const lines = reportLines(separable(), settings([LEFT, RIGHT]), undefined, {});
    expect(lines.some((line) => line.includes('all 2 arms failed on 0 cases'))).toBe(true);
  });
});

function corpus(): { directory: string; artifact: string; questions: string; tables: string } {
  const directory = scratch();
  const artifact = join(directory, 'bird-eval.json');
  const questions = join(directory, 'dev.json');
  const tables = join(directory, 'dev_tables.json');
  const rows = separable();
  writeFileSync(
    artifact,
    JSON.stringify({
      split: 'dev',
      model: 'test-model',
      cases: rows.flatMap((entry) => [
        { id: entry.id, arm: LEFT, passed: entry.passed.get(LEFT) === true, reason: 'match' },
        { id: entry.id, arm: RIGHT, passed: entry.passed.get(RIGHT) === true, reason: 'values' },
      ]),
    }),
  );
  writeFileSync(
    questions,
    JSON.stringify(
      rows.map((entry, index) => ({
        question_id: index,
        db_id: entry.db,
        question: entry.question,
        evidence: entry.evidence,
        SQL: '',
        difficulty: entry.difficulty,
      })),
    ),
  );
  writeFileSync(tables, JSON.stringify([]));
  return { directory, artifact, questions, tables };
}

describe('dispatch', () => {
  it('does nothing when the module was imported rather than run', () => {
    expect(dispatch(undefined, 'file:///repo/eval/bird/route.ts', [], '/repo')).toBeUndefined();
    expect(dispatch('/repo/other.ts', 'file:///repo/eval/bird/route.ts', [], '/repo')).toBeUndefined();
  });

  it('runs when it is the entry point, and reports the code main returned', () => {
    const { directory, artifact, questions, tables } = corpus();
    const log = vi.fn();
    const code = dispatch(
      '/repo/eval/bird/route.ts',
      'file:///repo/eval/bird/route.ts',
      ['--artifact', artifact, '--questions', questions, '--tables', tables],
      directory,
      log,
    );
    expect(code).toBe(0);
    expect(log).toHaveBeenCalled();
  });

  it('turns a thrown error into one line and a non-zero code', () => {
    const error = vi.fn();
    const code = dispatch('/repo/eval/bird/route.ts', 'file:///repo/eval/bird/route.ts', [], '/repo', () => {}, error);
    expect(code).toBe(1);
    expect(String(error.mock.calls[0]![0])).toContain('--artifact is required');
  });

  it('prints a thrown value that is not an Error verbatim', () => {
    const error = vi.fn();
    const code = dispatch('/repo/eval/bird/route.ts', 'file:///repo/eval/bird/route.ts', [], '/repo', () => {}, error, () => {
      throw 'a string, not an Error';
    });
    expect(code).toBe(1);
    expect(error.mock.calls[0]![0]).toBe('a string, not an Error');
  });

  it('prints a thrown non-error verbatim rather than an empty object', () => {
    const error = vi.fn();
    const code = dispatch('/repo/eval/bird/route.ts', 'file:///repo/eval/bird/route.ts', ['--artifact', 'missing.json'], '/repo', () => {}, error);
    expect(code).toBe(1);
    expect(String(error.mock.calls[0]![0])).toContain('missing.json');
  });
});

describe('main', () => {
  it('prints the report it computed', () => {
    const { directory, artifact, questions, tables } = corpus();
    const log = vi.fn();
    const code = main(['--artifact', artifact, '--questions', questions, '--tables', tables], directory, log);
    expect(code).toBe(0);
    const printed = log.mock.calls.map((call) => String(call[0]));
    expect(printed[0]).toContain('routing between metadata+evidence and inline+evidence');
    expect(printed.some((line) => line.includes('test-model'))).toBe(true);
  });

  it('prints json when asked, with the cells the report was built from', () => {
    const { directory, artifact, questions, tables } = corpus();
    const log = vi.fn();
    main(['--artifact', artifact, '--questions', questions, '--tables', tables, '--json'], directory, log);
    const parsed = JSON.parse(String(log.mock.calls[0]![0])) as { cases: number; pair: string[]; cells: { n: number } };
    expect(parsed.cases).toBe(24);
    expect(parsed.pair).toEqual([LEFT, RIGHT]);
    expect(parsed.cells.n).toBe(24);
  });

  it('refuses to report on a join that found nothing', () => {
    const { directory, artifact } = corpus();
    const questions = join(directory, 'other.json');
    writeFileSync(questions, JSON.stringify([]));
    expect(() => main(['--artifact', artifact, '--questions', questions], directory, () => {})).toThrow(/share no case/);
  });

  it('works without a table manifest, which every question feature tolerates', () => {
    const { directory, artifact, questions } = corpus();
    const log = vi.fn();
    expect(main(['--artifact', artifact, '--questions', questions], directory, log)).toBe(0);
    expect(log.mock.calls.length).toBeGreaterThan(10);
  });
});
