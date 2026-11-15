import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resultKey } from '@agentix-e/nl2charts-devkit';
import { resultFingerprint } from '../eval/bird/run.js';
import {
  VARIANTS,
  correctedThreshold,
  dispatch,
  main,
  readArtifact,
  readCases,
  reportLines,
  resolveRulesSettings,
  verdict,
} from '../eval/bird/rules.js';
import type { ArmReading, RulesArtifact, RulesSettings } from '../eval/bird/rules.js';
import type { Recorded } from '../eval/bird/consensus.js';

const EMPTY = resultFingerprint([]);
const f = (rows: readonly (readonly unknown[])[]): string => resultFingerprint(rows);

/** One candidate, written out rather than compressed: a rule bank is read far more often than written. */
function cand(source: string, correct: boolean, sql: string | undefined, fingerprint: string | undefined): Recorded {
  return {
    source,
    correct,
    ...(sql === undefined ? {} : { sql }),
    ...(fingerprint === undefined ? {} : { fingerprint }),
  };
}

const settings = (over: Partial<RulesSettings> = {}): RulesSettings => ({
  artifact: 'unused.json',
  why: false,
  json: false,
  ...over,
});

/**
 * The three-candidate set the readings are shaped like: two candidates agree on a short wrong
 * result, and the right statement is the long one.
 *
 * Every variant separates here, which is what makes it the set that says what each rule means
 * rather than only that it ran.
 */
const TWO_AGREE: readonly Recorded[] = [
  cand('a', false, 'SELECT 1', f([[1]])),
  cand('b', true, 'SELECT 1 + 2 AS three', f([[3]])),
  cand('c', false, 'SELECT 2', f([[1]])),
];

/** The slot a named variant picks on a set. */
function pickOf(name: string, candidates: readonly Recorded[]): number {
  const variant = VARIANTS.find((entry) => entry.name === name);
  if (variant === undefined) throw new Error(`no variant named ${name}`);
  return variant.pick(candidates);
}

describe('the variants', () => {
  it('ships exactly the three rules the pipeline has', () => {
    expect(VARIANTS.filter((variant) => variant.shipped).map((variant) => variant.name)).toEqual([
      'first',
      'shortest',
      'modal',
    ]);
  });

  it('keeps its names unique, because a report column is a join key', () => {
    const names = VARIANTS.map((variant) => variant.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every variant a reason it is on the list', () => {
    for (const variant of VARIANTS) expect(variant.why.length).toBeGreaterThan(20);
  });

  it('reads the shipped rules through the instrument that is held to the pipeline', () => {
    // `consensus.pick` is the implementation a test holds to `chooseCandidateByRule`, so these
    // three slots have to be its slots and not a paraphrase of them.
    expect(pickOf('first', TWO_AGREE)).toBe(0);
    expect(pickOf('shortest', TWO_AGREE)).toBe(0);
    expect(pickOf('modal', TWO_AGREE)).toBe(0);
  });

  it('takes the long statement when the rule is the far end of the axis', () => {
    expect(pickOf('longest', TWO_AGREE)).toBe(1);
  });

  it('takes the second slot by length, tie broken by position', () => {
    expect(pickOf('second-shortest', TWO_AGREE)).toBe(2);
  });

  it('takes the second slot even when there is only one candidate', () => {
    const one = [cand('a', true, 'SELECT 1', f([[1]]))];
    expect(pickOf('second-shortest', one)).toBe(0);
  });

  it('measures the statement without its whitespace', () => {
    // The two are the same statement under every measure but characters; `nonspace` has to see
    // that, and the earliest slot wins the tie it creates.
    const padded = [
      cand('a', true, 'SELECT a FROM t WHERE x = 1', f([[1]])),
      cand('b', false, 'SELECT  b  FROM  t  WHERE  x  =  2', f([[2]])),
    ];
    expect(pickOf('nonspace', padded)).toBe(0);
  });

  it('counts tokens rather than characters', () => {
    const wide = [
      cand('a', true, 'SELECT a_very_long_column_name FROM t', f([[1]])),
      cand('b', false, 'SELECT a FROM t WHERE x IN (1, 2, 3)', f([[2]])),
    ];
    // Four tokens against nine: the long identifier loses on characters and wins on tokens.
    expect(pickOf('tokens', wide)).toBe(0);
    expect(pickOf('shortest', wide)).toBe(1);
  });

  it('counts identifiers rather than tokens', () => {
    const wide = [
      cand('a', true, 'SELECT a FROM t', f([[1]])),
      cand('b', false, 'SELECT a FROM t WHERE x = 1 AND y = 2', f([[2]])),
    ];
    expect(pickOf('identifiers', wide)).toBe(0);
  });

  it('elides quoted spans, so a long label is not a long statement', () => {
    const labelled = [
      cand('a', true, 'SELECT max("Percent (%) Eligible Free (K-12)") FROM t', f([[1]])),
      cand('b', false, 'SELECT max(x) FROM t WHERE y = 5', f([[2]])),
    ];
    // Fifty-seven characters against thirty; two versus thirty once the label is one span.
    expect(pickOf('shortest', labelled)).toBe(1);
    expect(pickOf('chars-no-quoted', labelled)).toBe(0);
  });

  it('elides an alias, because naming is what a model is most free to get wrong', () => {
    const aliased = [
      cand('a', true, 'SELECT a FROM t AS long_alias_name_here', f([[1]])),
      cand('b', false, 'SELECT aa FROM t', f([[2]])),
    ];
    expect(pickOf('chars-no-alias', aliased)).toBe(0);
  });

  it('ranks a blank statement last rather than first', () => {
    const blank = [
      cand('a', false, '   ', f([[1]])),
      cand('b', true, 'SELECT a FROM t', f([[2]])),
    ];
    // The blank one is shorter than every real statement, so a rule that ranked it by its length
    // would pick the candidate that wrote nothing — which is the defect the measurement caught.
    expect(pickOf('shortest', blank)).toBe(1);
    expect(pickOf('longest', blank)).toBe(1);
  });

  it('ranks a statement the artifact never kept last too', () => {
    const missing = [cand('a', true, undefined, f([[1]])), cand('b', false, 'SELECT b', f([[2]]))];
    expect(pickOf('shortest', missing)).toBe(1);
  });

  it('keeps the shortest statement inside the majority result, and falls back when there is none', () => {
    const disputed = [
      cand('a', false, 'SELECT 1', f([[1]])),
      cand('b', false, 'SELECT 11', f([[2]])),
      cand('c', true, 'SELECT 22', f([[3]])),
    ];
    // Three distinct results: no majority, so the fallback is the shipped rule, which picks `a`.
    expect(pickOf('modal-then-shortest', disputed)).toBe(0);
    // The same fallback read from the long end, which is the control on the tie-break.
    expect(pickOf('majority-longest', disputed)).toBe(1);
    // With two agreeing, the majority group is what the tie-break is applied inside.
    expect(pickOf('modal-then-shortest', TWO_AGREE)).toBe(0);
  });

  it('reads the statement the pool mostly says', () => {
    const pool = [
      cand('a', true, 'SELECT a FROM t JOIN u ON t.id = u.id WHERE x = 1', f([[1]])),
      cand('b', false, 'SELECT a FROM t', f([[2]])),
      cand('c', false, 'SELECT b FROM v', f([[3]])),
    ];
    // The first statement shares `select`/`from`/`a`/`t` twice; the others share almost nothing.
    expect(pickOf('central', pool)).toBe(0);
    expect(pickOf('superset', pool)).toBe(0);
  });

  it('counts a clause before it measures a statement', () => {
    const clauses = [
      cand('a', false, 'SELECT a FROM t', f([[1]])),
      cand('b', true, 'SELECT a FROM t JOIN u ON t.id = u.id WHERE x = 1', f([[2]])),
    ];
    expect(pickOf('clauses-then-shortest', clauses)).toBe(1);
    // Equal clause counts fall back to length, which is what keeps the rule a refinement.
    const same = [
      cand('a', true, 'SELECT a FROM t WHERE x = 1', f([[1]])),
      cand('b', false, 'SELECT long_name FROM t WHERE x = 2', f([[2]])),
    ];
    expect(pickOf('clauses-then-shortest', same)).toBe(0);
  });

  it('treats an empty result as no candidate at all', () => {
    const withEmpty = [cand('a', false, 'SELECT 1 WHERE 0', EMPTY), cand('b', true, 'SELECT a FROM t', f([[1]]))];
    expect(pickOf('first', withEmpty)).toBe(1);
    expect(pickOf('shortest', withEmpty)).toBe(1);
    expect(pickOf('longest', withEmpty)).toBe(1);
  });

  it('falls back to the whole set when every result is empty', () => {
    const allEmpty = [cand('a', false, 'SELECT 1 WHERE 0', EMPTY), cand('b', false, 'SELECT 22 WHERE 0', EMPTY)];
    expect(pickOf('first', allEmpty)).toBe(0);
    // Two statements of the same length: the earliest slot wins the tie, which is what keeps the
    // fallback a rule rather than a coin.
    expect(pickOf('shortest', allEmpty)).toBe(0);
  });

  it('cannot count a result the artifact never fingerprinted', () => {
    const legacy = [cand('a', true, 'SELECT a FROM t', undefined), cand('b', false, 'SELECT b FROM t', undefined)];
    // `modal` needs agreement, and two absent fingerprints are not agreement: the shipped rule
    // reports -1 rather than picking the first slot by accident.
    expect(pickOf('modal', legacy)).toBe(-1);
    expect(pickOf('shortest', legacy)).toBe(0);
  });

  it('ranks a statement with no text for it behind one that has text, from either end', () => {
    // The artifact did not keep this statement, and a statement there is no text for is neither
    // the shortest nor the longest: ranking it as either lets an omission win a contest it was
    // never entered in.
    const mixed = [cand('a', true, undefined, f([[1]])), cand('b', false, 'SELECT b FROM t', f([[2]]))];
    expect(pickOf('longest', mixed)).toBe(1);
    expect(pickOf('shortest', mixed)).toBe(1);
    expect(pickOf('second-shortest', mixed)).toBe(1);
    expect(pickOf('central', mixed)).toBe(1);
    expect(pickOf('superset', mixed)).toBe(1);
    expect(pickOf('clauses-then-shortest', mixed)).toBe(1);
  });

  it('falls back to the eligible set when no statement can be ranked', () => {
    // Both statements are missing, so the length axis has nothing to say and the earliest slot
    // answers — the same fallback the empty-result case uses, for the same reason.
    const neither = [cand('a', true, undefined, f([[1]])), cand('b', false, undefined, f([[2]]))];
    expect(pickOf('second-shortest', neither)).toBe(0);
    expect(pickOf('clauses-then-shortest', neither)).toBe(0);
  });

  it('counts zero tokens for a statement made only of quotes', () => {
    const quoted = [cand('a', true, '"""', f([[1]]))];
    expect(pickOf('tokens', quoted)).toBe(0);
  });

  it('counts zero identifiers for a statement made only of numbers', () => {
    const numeric = [cand('a', true, '1 + 2', f([[1]]))];
    expect(pickOf('identifiers', numeric)).toBe(0);
  });

  it('has no slot for an empty candidate set', () => {
    for (const variant of VARIANTS) expect(variant.pick([])).toBe(-1);
  });
});

describe('one artifact, every arm', () => {
  const artifact: RulesArtifact = {
    split: 'dev',
    model: 'deepseek-chat',
    cases: [
      { arm: 'arm-a', candidates: TWO_AGREE },
      { arm: 'arm-a', candidates: TWO_AGREE },
      // A question whose generation produced nothing: a miss in every column, not a rule failure.
      { arm: 'arm-a', candidates: [] },
      { arm: 'arm-b', candidates: [cand('a', true, 'SELECT 1', f([[1]]))] },
      // No arm name, so the row cannot be attributed and is not read.
      { candidates: TWO_AGREE },
    ],
  };

  it('drops a row that names no arm', () => {
    expect(readCases(artifact).map((row) => row.arm)).toEqual(['arm-a', 'arm-a', 'arm-a', 'arm-b']);
  });

  it('reads a candidate whose fields are absent or of the wrong type without inventing any', () => {
    const malformed = { cases: [{ arm: 'a', candidates: [{ source: 7, correct: 'yes', sql: null }] }] };
    const [row] = readCases(malformed);
    expect(row?.candidates[0]).toEqual({ source: '', correct: false });
  });

  it('prices every variant on every arm, over one denominator', () => {
    const readings = readArtifact(artifact);
    expect(readings.map((reading) => reading.arm)).toEqual(['arm-a', 'arm-b']);
    const first = readings[0] as ArmReading;
    expect(first.cases).toBe(3);
    // Two correct of three: the empty question is a miss rather than an exclusion.
    const shortest = first.scores.find((score) => score.name === 'shortest');
    expect(shortest).toMatchObject({ correct: 0, unavailable: 1 });
    expect(first.scores).toHaveLength(VARIANTS.length);
  });

  it('counts a question with no candidates as a miss in every column, never as an exclusion', () => {
    const readings = readArtifact({ cases: [{ arm: 'a', candidates: [] }] });
    for (const score of (readings[0] as ArmReading).scores) {
      expect(score.correct).toBe(0);
      expect(score.unavailable).toBe(1);
    }
  });

  it('pairs each unshipped variant against the shipped rule on the same questions', () => {
    const readings = readArtifact(artifact);
    const against = (readings[0] as ArmReading).against;
    expect(against.map((entry) => entry.name)).toEqual(VARIANTS.filter((variant) => !variant.shipped).map((v) => v.name));
    for (const entry of against) {
      expect(entry.wins + entry.losses + entry.both).toBeLessThanOrEqual(3);
    }
  });

  it('reads a candidate slot the artifact wrote as null, rather than throwing on it', () => {
    const [row] = readCases({ cases: [{ arm: 'a', candidates: [null] }] });
    expect(row?.candidates).toEqual([{ source: '', correct: false }]);
  });

  it('reads a case with no candidate list as a question that produced nothing', () => {
    const [row] = readCases({ cases: [{ arm: 'a' }] });
    expect(row?.candidates).toEqual([]);
  });

  it('returns nothing for an artifact with no cases at all', () => {
    expect(readArtifact({})).toEqual([]);
  });
});

/** An arm whose rows are `wins` questions the long rule answers and `wins + losses` rows in all. */
function armOf(wins: number, losses: number): readonly { readonly arm: string; readonly candidates: readonly Recorded[] }[] {
  const rows: { arm: string; candidates: readonly Recorded[] }[] = [];
  for (let index = 0; index < wins; index += 1) rows.push({ arm: 'a', candidates: TWO_AGREE });
  for (let index = 0; index < losses; index += 1) {
    rows.push({
      arm: 'a',
      candidates: [cand('a', false, 'SELECT 1', f([[1]])), cand('b', true, 'SELECT 1234567', f([[2]]))],
    });
  }
  return rows;
}

/** The right statement is also the shortest one, so every other reading of it loses. */
const SHORTEST_RIGHT: readonly Recorded[] = [
  cand('a', true, 'SELECT 1', f([[1]])),
  cand('b', false, 'SELECT 22', f([[2]])),
  cand('c', false, 'SELECT 333', f([[3]])),
];

describe('the verdict', () => {
  it('closes the space when nothing beats the shipped rule', () => {
    const cases = Array.from({ length: 4 }, () => ({ arm: 'a', candidates: SHORTEST_RIGHT }));
    expect(verdict(readArtifact({ cases })[0] as ArmReading)).toContain('the rule space is closed on this artifact');
  });

  it('refuses to call a lead a finding when the family can explain it', () => {
    // Six wins and no losses is p = 0.031: past the uncorrected bar and inside what twelve
    // variants cost, which is exactly the sentence this branch exists to print.
    const reading = readArtifact({ cases: armOf(6, 0).map((row) => ({ ...row })) })[0] as ArmReading;
    expect(verdict(reading)).toContain('unresolved, and not a dispatch');
  });

  it('owes a dispatch when a lead clears the family threshold', () => {
    const reading = readArtifact({ cases: armOf(10, 0).map((row) => ({ ...row })) })[0] as ArmReading;
    expect(verdict(reading)).toContain('a dispatch is owed');
  });

  it('names the bound it applied, so a reader can check the arithmetic', () => {
    expect(correctedThreshold()).toBeCloseTo(0.05 / 12, 10);
  });
});

describe('the report', () => {
  it('prints a row per variant, with the shipped ones marked', () => {
    const artifact: RulesArtifact = { split: 'dev', model: 'deepseek-chat', cases: armOf(2, 2).map((row) => ({ ...row })) };
    const lines = reportLines(readArtifact(artifact), settings(), artifact);
    expect(lines[0]).toBe('free-rule space on 4 questions per arm (dev, deepseek-chat)');
    expect(lines[1]).toContain('15 variants (3 shipped, 12 unshipped)');
    const rows = lines.filter((line) => line.startsWith('  *') || /^ {3}(agreement|length|structure)/.test(line));
    expect(rows).toHaveLength(VARIANTS.length);
    expect(lines.join('\n')).toContain('  *length     shortest');
  });

  it('names a split it does not have rather than an empty pair of brackets', () => {
    const artifact: RulesArtifact = { cases: armOf(1, 1).map((row) => ({ ...row })) };
    const lines = reportLines(readArtifact(artifact), settings(), artifact);
    expect(lines[0]).toBe('free-rule space on 2 questions per arm');
  });

  it('prints half a header rather than a dangling comma', () => {
    const artifact: RulesArtifact = { split: 'dev', cases: armOf(1, 1).map((row) => ({ ...row })) };
    const lines = reportLines(readArtifact(artifact), settings(), artifact);
    expect(lines[0]).toBe('free-rule space on 2 questions per arm (dev)');
  });

  it('prints the reason each variant is on the list only when asked', () => {
    const artifact: RulesArtifact = { cases: armOf(1, 1).map((row) => ({ ...row })) };
    const plain = reportLines(readArtifact(artifact), settings(), artifact);
    const argued = reportLines(readArtifact(artifact), settings({ why: true }), artifact);
    expect(argued.length).toBeGreaterThan(plain.length);
    expect(argued.join('\n')).toContain('the statement the pool mostly says');
  });

  it('prints a header and nothing else for an artifact with no arm', () => {
    // The caller refuses this artifact before printing, so the header is the only thing a report
    // built from nothing can say: zero questions rather than an exception from a missing row.
    const lines = reportLines([], settings(), {});
    expect(lines[0]).toBe('free-rule space on 0 questions per arm');
    expect(lines).toHaveLength(2);
  });

  it('prints the no-input count beside a score, because it is not a zero', () => {
    const artifact: RulesArtifact = {
      cases: [
        { arm: 'a', candidates: TWO_AGREE },
        { arm: 'a', candidates: [] },
      ],
    };
    const lines = reportLines(readArtifact(artifact), settings(), artifact);
    expect(lines.join('\n')).toContain('[1 no input]');
  });
});

describe('the command line', () => {
  it('requires an artifact, because it reads one rather than producing one', () => {
    expect(() => resolveRulesSettings([])).toThrow(/--artifact is required/);
  });

  it('refuses an argument it does not understand before anything else', () => {
    expect(() => resolveRulesSettings(['--artifact', 'x.json', '--deep'])).toThrow(/unrecognized argument --deep/);
  });

  it('reads the flags it does have', () => {
    expect(resolveRulesSettings(['--artifact', 'x.json', '--why', '--json'])).toEqual({
      artifact: 'x.json',
      why: true,
      json: true,
    });
  });

  it('treats a flag with no value as a missing artifact rather than as an empty path', () => {
    expect(() => resolveRulesSettings(['--artifact'])).toThrow(/--artifact is required/);
  });
});

describe('running it', () => {
  const scratch = (body: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'rules-'));
    const file = join(dir, 'bird-eval.json');
    writeFileSync(file, JSON.stringify(body));
    return file;
  };

  it('prints the report and returns zero', () => {
    const lines: string[] = [];
    const code = main(['--artifact', scratch({ cases: armOf(1, 1) })], process.cwd(), (line) => lines.push(line));
    expect(code).toBe(0);
    expect(lines[0]).toContain('free-rule space');
  });

  it('prints the reading as JSON when asked, so another tool can read it', () => {
    const lines: string[] = [];
    main(['--artifact', scratch({ split: 'dev', cases: armOf(1, 1) }), '--json'], process.cwd(), (line) => lines.push(line));
    const parsed = JSON.parse(lines.join('\n')) as { split: string; arms: { arm: string; scores: unknown[] }[] };
    expect(parsed.split).toBe('dev');
    expect(parsed.arms[0]?.scores).toHaveLength(VARIANTS.length);
  });

  it('refuses an artifact with no case it can attribute, instead of printing an empty table', () => {
    const file = scratch({ cases: [{ candidates: TWO_AGREE }] });
    expect(() => main(['--artifact', file], process.cwd(), () => undefined)).toThrow(/no case carrying an arm name/);
  });
});

describe('the entry check', () => {
  const self = pathToFileURL('/x/eval/bird/rules.ts').href;

  it('does nothing when the module was imported', () => {
    expect(dispatch(undefined, self, [], process.cwd(), () => undefined)).toBeUndefined();
  });

  it('does nothing when another file is the entry point', () => {
    expect(dispatch('/x/test/a.test.ts', self, [], process.cwd(), () => undefined)).toBeUndefined();
  });

  it('runs when it is the entry point', () => {
    const lines: string[] = [];
    const code = dispatch('/x/eval/bird/rules.ts', self, ['--artifact', 'a.json'], process.cwd(), (line) => lines.push(line), () => undefined, () => 0);
    expect(code).toBe(0);
    expect(lines).toEqual([]);
  });

  it('prints a message rather than a stack trace when the run throws', () => {
    const errors: string[] = [];
    const code = dispatch(
      '/x/eval/bird/rules.ts',
      self,
      [],
      process.cwd(),
      () => undefined,
      (line) => errors.push(line),
      () => {
        throw new Error('boom');
      },
    );
    expect(code).toBe(1);
    expect(errors).toEqual(['boom']);
  });

  it('stringifies something that is not an error', () => {
    const errors: string[] = [];
    dispatch(
      '/x/eval/bird/rules.ts',
      self,
      [],
      process.cwd(),
      () => undefined,
      (line) => errors.push(line),
      () => {
        throw 'plain';
      },
    );
    expect(errors).toEqual(['plain']);
  });
});

describe('the artifact is the only thing read', () => {
  it('does not need a fingerprint the run never wrote, and says so by scoring the rule as unable', () => {
    const legacy: RulesArtifact = {
      cases: [{ arm: 'a', candidates: [{ source: 'x', correct: true, sql: 'SELECT 1' }] }],
    };
    const reading = readArtifact(legacy)[0] as ArmReading;
    const modal = reading.scores.find((score) => score.name === 'modal');
    expect(modal).toMatchObject({ correct: 0, unavailable: 1 });
    // The length rules still answer, which is the point of reading only what is there.
    expect(reading.scores.find((score) => score.name === 'shortest')).toMatchObject({ correct: 1, unavailable: 0 });
  });

  it('reads a fingerprint as the judge wrote it, not as a second definition of a result', () => {
    expect(f([[1]])).toBe(resultFingerprint([[1]]));
    expect(resultKey([[1]] as never)).not.toBe(f([[1]]));
  });
});
