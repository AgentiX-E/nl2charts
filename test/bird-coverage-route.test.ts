/**
 * The coverage router's arithmetic, pinned without an artifact.
 *
 * `44917562527` closed the diversity line: the pool grew 3.6pp of ceiling and the answer fell
 * 2.8pp, because the judge is worse where the pool is better. What that reading left open is
 * whether the purchase could be *aimed* — 168 of 600 cases have no answer in the pool at all, and
 * a router that read the question could buy a fourth call there and nowhere else. This file pins
 * the machinery that answers it: the join, the separation, the fold, and the criterion.
 *
 * The tests are hand-computed on sets small enough to check with a pen, because the failure mode
 * of an AUC is not a crash — it is a plausible number.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_AUC,
  REQUIRED_BUY,
  REQUIRED_GAIN,
  auc,
  casesFromArtifact,
  dispatch,
  fitThreshold,
  leaveOneDatabaseOut,
  main,
  reportLines,
  resolveSettings,
  scoreThreshold,
  vectorOf,
  type ArtifactShape,
  type RouteCase,
} from '../eval/bird/coverage-route.js';

const one = (over: Partial<RouteCase> & { id: string }): RouteCase => ({
  db: 'shop',
  difficulty: 'simple',
  question: 'How many singers are there?',
  evidence: '',
  recall: true,
  truncated: false,
  ...over,
});

describe('reading the cases out of an artifact', () => {
  const artifact = (cases: unknown[]): ArtifactShape => ({ split: 'dev', model: 'deepseek-chat', cases: cases as never });

  it('takes one row per case from the arm it was asked about, in numeric order', () => {
    const { cases } = casesFromArtifact(
      artifact([
        { arm: 'names', id: '10', candidateRecall: false, asked: { db: 'shop', difficulty: 'simple', question: 'b' } },
        { arm: 'names', id: '2', candidateRecall: true, asked: { db: 'shop', difficulty: 'simple', question: 'a' } },
        { arm: 'other', id: '3', candidateRecall: true, asked: { db: 'shop', difficulty: 'simple', question: 'c' } },
      ]),
      'names',
    );
    expect(cases.map((entry) => entry.id)).toEqual(['2', '10']);
    expect(cases.map((entry) => entry.recall)).toEqual([true, false]);
  });

  it('counts what it could not use instead of filling it in', () => {
    // A case without `asked` is a join that failed, not a short question: defaulting it to the
    // empty string would read every length feature as zero and teach the router the majority class.
    const { cases, missingAsked, missingRecall } = casesFromArtifact(
      artifact([
        { arm: 'names', id: '1', candidateRecall: true },
        { arm: 'names', id: '2', asked: { db: 'shop', question: 'q' } },
        { arm: 'names', id: '3', asked: { db: 'shop', question: 'q' }, candidateRecall: true },
        { arm: 'names', id: '4', asked: { db: 'shop', question: 'q' }, passed: true },
      ]),
      'names',
    );
    expect(cases.map((entry) => entry.id)).toEqual(['3']);
    // One row had no `asked`, and two had one but no `candidateRecall` — a different join failing
    // in a different place, which is why the two are counted apart.
    expect(missingAsked).toBe(1);
    expect(missingRecall).toBe(2);
  });

  it('keeps one row per case when an arm wrote the same id twice', () => {
    const { cases } = casesFromArtifact(
      artifact([
        { arm: 'names', id: '1', candidateRecall: false, asked: { db: 'shop', question: 'first' } },
        { arm: 'names', id: '1', candidateRecall: true, asked: { db: 'shop', question: 'second' } },
      ]),
      'names',
    );
    expect(cases).toHaveLength(1);
    expect(cases[0]!.question).toBe('first');
  });

  it('normalises a missing evidence note and carries the truncation flag', () => {
    const { cases } = casesFromArtifact(
      artifact([{ arm: 'names', id: '1', candidateRecall: true, asked: { db: 'shop', question: 'q', truncated: true } }]),
      'names',
    );
    expect(cases[0]!.evidence).toBe('');
    expect(cases[0]!.truncated).toBe(true);
    expect(cases[0]!.difficulty).toBe('unknown');
  });

  it('reads no cases, rather than failing, from an artifact that has no cases key', () => {
    // An artifact from before per-case rows existed: the right answer is "nothing to route", which
    // the caller turns into a sentence, not a TypeError from inside a loop.
    expect(casesFromArtifact({ split: 'dev' }, 'names')).toEqual({ cases: [], missingAsked: 0, missingRecall: 0 });
  });

  it('does not treat a non-string evidence note as a note', () => {
    const { cases } = casesFromArtifact(
      artifact([{ arm: 'names', id: '1', candidateRecall: true, asked: { db: 'shop', question: 'q', evidence: 7 } }]),
      'names',
    );
    expect(cases[0]!.evidence).toBe('');
  });

  it('falls back to a string order when the ids are labels rather than numbers', () => {
    const { cases } = casesFromArtifact(
      artifact([
        { arm: 'names', id: 'b', candidateRecall: true, asked: { db: 'shop', question: 'q' } },
        { arm: 'names', id: 'a', candidateRecall: true, asked: { db: 'shop', question: 'q' } },
      ]),
      'names',
    );
    // `Number('b') - Number('a')` is NaN, which leaves the order to the sort's implementation.
    expect(cases.map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});

describe('the vector the two routers share', () => {
  it('measures the question it was given, not the answer', () => {
    const long = vectorOf(one({ id: '1', question: 'x'.repeat(40) }));
    const short = vectorOf(one({ id: '2', question: 'x' }));
    const chars = (vector: typeof long) => vector.find((entry) => entry.name === 'chars')!.value;
    expect(chars(long)).toBe(40);
    expect(chars(short)).toBe(1);
    // Every feature `route.ts` defines, in its order: a router that silently lost one would report
    // an AUC computed over a shorter vector.
    expect(long.map((entry) => entry.name)).toEqual(short.map((entry) => entry.name));
    expect(long).toHaveLength(19);
  });
});

describe('how well one feature separates an empty pool from a full one', () => {
  it('reads 1.0 when every unanswered case sits above every answered one', () => {
    // The label is inverted inside `auc`: a case whose pool held no answer is the positive class.
    const ones = [one({ id: '1', recall: false, question: 'x'.repeat(30) }), one({ id: '2', recall: true, question: 'x' })];
    expect(auc(ones, 'chars')).toBe(1);
  });

  it('reads 0.0 when the separation is exactly backwards', () => {
    const ones = [one({ id: '1', recall: false, question: 'x' }), one({ id: '2', recall: true, question: 'x'.repeat(30) })];
    expect(auc(ones, 'chars')).toBe(0);
  });

  it('counts a tie as half, which is what keeps a constant feature at 0.5', () => {
    // positives {1, 2} against negatives {1, 3}: 0.5 + 0 + 1 + 0 = 1.5 of 4.
    const ones = [
      one({ id: '1', recall: false, question: 'x'.repeat(1) }),
      one({ id: '2', recall: false, question: 'x'.repeat(2) }),
      one({ id: '3', recall: true, question: 'x'.repeat(1) }),
      one({ id: '4', recall: true, question: 'x'.repeat(3) }),
    ];
    expect(auc(ones, 'chars')).toBeCloseTo(0.375, 10);
    // A feature that is identical on every case has nothing to rank: exactly a coin, not a crash.
    expect(auc(ones, 'aggregate')).toBe(0.5);
  });

  it('reads 0.5 when one of the classes is empty, because there is nothing to separate', () => {
    expect(auc([one({ id: '1', recall: true })], 'chars')).toBe(0.5);
    expect(auc([], 'chars')).toBe(0.5);
  });

  it('refuses a feature name it does not have instead of scoring zero', () => {
    expect(() => auc([one({ id: '1' })], 'nonsense')).toThrow(/no feature named nonsense/);
    // The same refusal from the two readers that used to write `?.value ?? 0`: a missing feature
    // read as zero becomes a comparison against a constant, which looks like a null result.
    expect(() => fitThreshold([one({ id: '1' })], 'nonsense')).toThrow(/no feature named nonsense/);
    expect(() => scoreThreshold([one({ id: '1' })], { feature: 'nonsense', at: 0, above: true, accuracy: 0 })).toThrow(
      /no feature named nonsense/,
    );
  });
});

describe('the best threshold a single feature can express', () => {
  it('finds the cut that separates the two classes, and says which side means empty', () => {
    const ones = [
      one({ id: '1', recall: false, question: 'x'.repeat(10) }),
      one({ id: '2', recall: false, question: 'x'.repeat(20) }),
      one({ id: '3', recall: true, question: 'x'.repeat(1) }),
      one({ id: '4', recall: true, question: 'x'.repeat(2) }),
    ];
    const rule = fitThreshold(ones, 'chars');
    expect(rule.accuracy).toBe(1);
    // Midpoint between 2 and 10, and `>=` means "the pool is empty".
    expect(rule.at).toBe(6);
    expect(rule.above).toBe(true);
  });

  it('prefers the smaller cut on a tie, so the same input always yields the same rule', () => {
    // A constant feature can only ever predict one class, and both directions tie on accuracy.
    // The fit has to pick deterministically: a rule that depends on iteration order cannot be
    // re-run, and a re-run is how every other reading in this repository is checked.
    const ones = [one({ id: '1', recall: false }), one({ id: '2', recall: false })];
    const first = fitThreshold(ones, 'chars');
    const second = fitThreshold([...ones].reverse(), 'chars');
    expect(first).toEqual(second);
    expect(first.above).toBe(true);
    expect(first.accuracy).toBe(1);
  });

  it('refuses to fit an empty set rather than inventing a threshold', () => {
    expect(() => fitThreshold([], 'chars')).toThrow(/empty set/);
  });

  it('fits a cut where the empty pool sits below it, and reports the direction it found', () => {
    // The mirror of the first case: short questions have gaps here, so the fitted direction is
    // `<`. A report that always printed `>=` would describe a rule nobody fitted.
    const ones = [
      one({ id: '1', recall: false, question: 'x' }),
      one({ id: '2', recall: false, question: 'xx' }),
      one({ id: '3', recall: true, question: 'x'.repeat(20) }),
    ];
    const rule = fitThreshold(ones, 'chars');
    expect(rule.above).toBe(false);
    expect(rule.accuracy).toBe(1);
  });
});

describe('scoring a fitted rule on cases it has not seen', () => {
  it('counts the right answers, the cases it looked at, and the ones it would buy', () => {
    const rule = { feature: 'chars', at: 10, above: true, accuracy: 1 };
    const scored = scoreThreshold(
      [
        one({ id: '1', recall: false, question: 'x'.repeat(20) }),
        one({ id: '2', recall: true, question: 'x'.repeat(1) }),
        one({ id: '3', recall: true, question: 'x'.repeat(20) }),
      ],
      rule,
    );
    // Case 1 is called empty and is; case 2 is called full and is; case 3 is called empty and is
    // not. Two cases are called empty, so two would cost a fourth call — the count the report
    // divides by the corpus, and the one the first version had inverted.
    expect(scored).toEqual({ right: 2, total: 3, aimed: 2 });
  });
});

describe('the fold that leaves a whole database out', () => {
  it('fits on the other databases and scores the held one, against its own majority class', () => {
    const ones = [
      // `shop` is learnable: long questions have empty pools.
      ...Array.from({ length: 10 }, (_, index) =>
        one({ id: `s${String(index)}`, db: 'shop', recall: index < 5, question: 'x'.repeat(index < 5 ? 30 : 2) }),
      ),
      // `library` is held out and points the other way, which is the point: a rule fitted on
      // `shop` should fail on it rather than be rescued by having seen it.
      ...Array.from({ length: 10 }, (_, index) =>
        one({ id: `l${String(index)}`, db: 'library', recall: true, question: 'x'.repeat(index < 5 ? 30 : 2) }),
      ),
    ];
    const held = leaveOneDatabaseOut(ones, 'chars');
    expect(held.total).toBe(20);
    // The baseline is each fold's own majority class, summed: `library` is 10 of 10 "an answer in
    // the pool", `shop` is 5 of 10, so 15 of 20 cases are the class a rule that learned nothing
    // would name. Reading it off the whole corpus instead would give 0.5 and hide that half the
    // fold is unlearnable.
    expect(held.baseline).toBe(0.75);
    expect(held.accuracy).toBe(0.5);
    expect(held.folds.map((fold) => fold.name)).toEqual(['library', 'shop']);
  });

  it('reports nothing rather than a reading when there is only one database', () => {
    const held = leaveOneDatabaseOut([one({ id: '1', db: 'shop' })], 'chars');
    expect(held).toEqual({ accuracy: 0, total: 0, baseline: 0, aimed: 0, folds: [] });
  });
});

describe('what the flags mean', () => {
  it('reads the artifact from the flag or the first position, and never from a flag value', () => {
    // `--arm select-cross` used to make `select-cross` the artifact, and the error named a file
    // instead of the missing flag.
    // The path is resolved against the root the caller named, not against the process's working
    // directory: a workflow step and a local run start in different places.
    expect(resolveSettings(['--artifact', 'a.json', '--arm', 'names'], '/repo')).toEqual({ artifact: '/repo/a.json', arm: 'names', json: false });
    expect(resolveSettings(['a.json', '--arm', 'names'], '/repo')).toMatchObject({ artifact: '/repo/a.json', arm: 'names' });
    expect(resolveSettings(['--artifact', '/abs/a.json', '--arm', 'names'], '/repo').artifact).toBe('/abs/a.json');
    expect(() => resolveSettings(['--arm', 'names'])).toThrow(/--artifact is required/);
    expect(() => resolveSettings(['a.json'])).toThrow(/--arm is required/);
    expect(resolveSettings(['a.json', '--arm', 'names', '--json']).json).toBe(true);
  });
});

describe('the lines a reader gets', () => {
  const settings = { artifact: 'a.json', arm: 'names', json: false };

  it('says a purchase can be aimed when a feature clears every criterion', () => {
    // Two databases, each half gap and half answer, separated perfectly by length. Every fold
    // learns the same rule from the other database, which is the only condition under which this
    // reading is a reading rather than a memory of the corpus.
    const ones = [
      one({ id: '1', db: 'a', recall: false, question: 'x'.repeat(30) }),
      one({ id: '2', db: 'a', recall: true, question: 'x' }),
      one({ id: '3', db: 'b', recall: false, question: 'x'.repeat(30) }),
      one({ id: '4', db: 'b', recall: true, question: 'x' }),
    ];
    const lines = reportLines(ones, { split: 'dev', model: 'm' }, settings, { missingAsked: 0, missingRecall: 0 });
    const text = lines.join('\n');
    expect(text).toContain('verdict: chars reads the stratum (AUC 1.000) and earns 50.00pp out of fold');
    expect(text).toContain('no answer in the pool: 2 (50.0%)');
    expect(text).toContain('the router would buy 50.0% of the corpus, and skip 50.0%');
    expect(REQUIRED_AUC).toBe(0.7);
    expect(REQUIRED_GAIN).toBe(0.03);
    expect(REQUIRED_BUY).toBe(0.8);
  });

  it('says a purchase cannot be aimed when a feature separates nothing', () => {
    // Constant features: every AUC is 0.5, the fitted rule buys everything, the gain is zero. The
    // verdict has to name all three criteria rather than the first one that failed.
    const ones = [
      one({ id: '1', db: 'a', recall: false, question: 'x'.repeat(5) }),
      one({ id: '2', db: 'a', recall: true, question: 'x'.repeat(5) }),
      one({ id: '3', db: 'b', recall: false, question: 'x'.repeat(5) }),
      one({ id: '4', db: 'b', recall: true, question: 'x'.repeat(5) }),
    ];
    const text = reportLines(ones, {}, settings, { missingAsked: 0, missingRecall: 0 }).join('\n');
    expect(text).toContain('verdict: no feature clears AUC 0.7, 3pp out of fold and a 80% buy ceiling at once');
    // On a constant feature both directions tie, the fit takes `>=` at the low cut, and the rule
    // therefore calls every case empty: it would buy the whole corpus, which is the clearest way
    // to fail the buy ceiling while looking like a router.
    expect(text).toContain('buying 100.0%');
  });

  it('refuses to report a held-out number for a corpus with one database', () => {
    // `0.00% against 0.00%` reads as a fitted rule that scored nothing; the truth is that no fold
    // could be left out. The sentence has to be the second one.
    const text = reportLines([one({ id: '1', recall: false })], {}, settings, { missingAsked: 0, missingRecall: 0 }).join('\n');
    expect(text).toContain('not measurable: the corpus holds one database, so no fold can be left out');
    expect(text).toContain('verdict: the read is in sample only and cannot be tested out of fold');
    expect(text).not.toContain('stump, held out      0.00%');
  });

  it('says what was dropped when the artifact could not describe every case', () => {
    const lines = reportLines([one({ id: '1', recall: true, truncated: true })], {}, settings, { missingAsked: 2, missingRecall: 1 });
    expect(lines.join('\n')).toContain('questions capped by the runner: 1; dropped 2 without asked, 1 without candidateRecall');
  });

  it('says there is nothing to route on when no case was usable', () => {
    const lines = reportLines([], {}, settings, { missingAsked: 3, missingRecall: 0 });
    expect(lines.join('\n')).toContain('no feature could be computed, so there is nothing to route on');
  });
});

describe('the command', () => {
  const artifact = {
    split: 'dev',
    model: 'm',
    cases: [
      { arm: 'names', id: '1', candidateRecall: false, asked: { db: 'shop', question: 'x'.repeat(30) } },
      { arm: 'names', id: '2', candidateRecall: true, asked: { db: 'shop', question: 'x' } },
    ],
  };

  it('prints the report and returns zero', () => {
    const root = mkdtempSync(join(tmpdir(), 'coverage-route-'));
    try {
      const file = join(root, 'artifact.json');
      writeFileSync(file, JSON.stringify(artifact));
      const lines: string[] = [];
      expect(main(['--artifact', file, '--arm', 'names'], root, (line) => lines.push(line))).toBe(0);
      expect(lines.join('\n')).toContain('routing "no answer in the pool" for names on 2 cases');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints the same reading as JSON when asked, with the counts a caller needs', () => {
    const root = mkdtempSync(join(tmpdir(), 'coverage-route-'));
    try {
      const file = join(root, 'artifact.json');
      writeFileSync(file, JSON.stringify(artifact));
      const lines: string[] = [];
      main(['--artifact', file, '--arm', 'names', '--json'], root, (line) => lines.push(line));
      const parsed = JSON.parse(lines.join('\n')) as { cases: number; gaps: number; arm: string };
      expect(parsed).toMatchObject({ cases: 2, gaps: 1, arm: 'names' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an artifact whose cases carry no asked field, and says which join failed', () => {
    const root = mkdtempSync(join(tmpdir(), 'coverage-route-'));
    try {
      const file = join(root, 'artifact.json');
      writeFileSync(file, JSON.stringify({ cases: [{ arm: 'names', id: '1', candidateRecall: true }] }));
      expect(() => main(['--artifact', file, '--arm', 'names'], root, () => undefined)).toThrow(/carries both asked and candidateRecall/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints a string that was thrown, rather than the word undefined', () => {
    const errors: string[] = [];
    const code = dispatch(
      '/eval/bird/coverage-route.ts',
      'file:///eval/bird/coverage-route.ts',
      [],
      '/repo',
      () => undefined,
      (line) => errors.push(line),
      () => {
        throw 'the artifact is a directory';
      },
    );
    expect(code).toBe(1);
    expect(errors).toEqual(['the artifact is a directory']);
  });

  it('prints a sentence rather than a stack trace when it is the entry point', () => {
    const errors: string[] = [];
    const code = dispatch('/eval/bird/coverage-route.ts', 'file:///eval/bird/coverage-route.ts', [], '/repo', () => undefined, (line) => errors.push(line));
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('--artifact is required');
  });

  it('does nothing when it was imported rather than run', () => {
    expect(dispatch(undefined, 'file:///eval/bird/coverage-route.ts', [], '/repo')).toBeUndefined();
    expect(dispatch('/other.ts', 'file:///eval/bird/coverage-route.ts', [], '/repo')).toBeUndefined();
  });
});
