/**
 * The gate, and the three bars it is judged by.
 *
 * The property under test is not "does the rule fire" — it is that a gate can only be adopted by
 * clearing precision, recall and cost *at the same time*, and that the label it is scored against
 * is one it cannot read. Both halves are worth pinning: a gate with 0.9 precision that fires on
 * every case is the ungated audit that already lost, and a gate that could see the label is a
 * table fitted to its own denominator.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FILTER_CUES,
  GATES,
  MAX_FIRE_SHARE,
  REQUIRED_PRECISION,
  REQUIRED_RECALL,
  clears,
  dispatch,
  filterCue,
  gateCases,
  gateInputs,
  main,
  namedColumns,
  reportLines,
  resolveSettings,
  schemasFor,
  scoreGate,
} from '../eval/bird/condition-gate.js';
import type { GateCase, GateSchema } from '../eval/bird/condition-gate.js';

const schema: GateSchema = { columns: ['school', 'county', 'enrollment', 'rate'] };

const one = (over: Partial<GateCase> = {}): GateCase => ({
  id: '1',
  db: 'shop',
  question: 'how many schools are in the county',
  evidence: '',
  sql: 'select count(*) from schools where county = \'x\'',
  missing: 0,
  stated: 1,
  ...over,
});

describe('the words a question uses to state a filter', () => {
  it('finds a comparison word wherever it sits, and in either case', () => {
    expect(filterCue('how many schools have at least 100 students')).toBe('at least');
    expect(filterCue('How Many Schools Have At Least 100 Students')).toBe('at least');
    expect(filterCue('list the counties between 2010 and 2012')).toBe('between');
  });

  it('reports the first cue in the list rather than the first in the sentence', () => {
    // The list is ordered by how specific the cue is, and the caller uses the answer as a label in
    // a report: an order that depended on where the words fell would print a different cue for two
    // questions that state the same comparison.
    expect(filterCue('only schools with more than 10 students')).toBe('only');
  });

  it('finds nothing in a question that states no comparison', () => {
    expect(filterCue('how many schools are there')).toBeUndefined();
    expect(filterCue('')).toBeUndefined();
  });

  it('keeps the cue list small and free of duplicates, because a gate that grows is a gate fitted', () => {
    expect(new Set(FILTER_CUES).size).toBe(FILTER_CUES.length);
    expect(FILTER_CUES.length).toBeLessThanOrEqual(30);
  });
});

describe('the columns a question names', () => {
  it('matches a column on whole words, not on substrings', () => {
    // `county` inside `country` is the false positive this rule exists to avoid: a question about
    // countries would fire the gate on a column called county and send a case to the audit.
    expect(namedColumns('how many countries are there', { columns: ['county'] })).toEqual([]);
    expect(namedColumns('how many counties are there', { columns: ['county'] })).toEqual(['county']);
  });

  it('reads an underscored column through the spaces a question writes', () => {
    expect(namedColumns('what is the free meal count', { columns: ['free_meal_count'] })).toEqual(['free_meal_count']);
  });

  it('accepts a plural question about a singular column', () => {
    expect(namedColumns('how many schools are in alameda', { columns: ['school'] })).toEqual(['school']);
  });

  it('names each column once even when the question repeats it', () => {
    const named = namedColumns('schools with school type x, school type y', { columns: ['school'] });
    expect(named).toEqual(['school']);
  });
});

describe('a gate reads the question and the statement, and nothing else', () => {
  it('reads the statement\'s filter columns from the same reader the census uses', () => {
    const inputs = gateInputs(one({ sql: 'select count(*) from schools where county = \'x\'' }), schema);
    expect(inputs.conditionColumns).toEqual(['county']);
    expect(inputs.named).toEqual(['school', 'county']);
    // The label is on the case and not on the inputs: there is no field here a gate could reach
    // it through, which is the property the whole reading rests on.
    expect(inputs).not.toHaveProperty('missing');
  });

  it('fires each gate on exactly the shape its name describes', () => {
    const empty = gateInputs(one({ sql: 'select count(*) from schools' }), schema);
    const filtered = gateInputs(one({ sql: 'select count(*) from schools where county = \'x\'' }), schema);
    const byName = new Map(GATES.map((gate) => [gate.name, gate]));
    expect(byName.get('no-where')?.fires(empty)).toBe(true);
    expect(byName.get('no-where')?.fires(filtered)).toBe(false);
    expect(byName.get('cue')?.fires(gateInputs(one({ question: 'schools with at least 10 students' }), schema))).toBe(true);
    expect(byName.get('cue')?.fires(gateInputs(one({ question: 'how many schools' }), schema))).toBe(false);
    // `enrollment` is named by the question and filtered by nothing.
    expect(byName.get('named')?.fires(gateInputs(one({ question: 'average enrollment' }), schema))).toBe(true);
    expect(byName.get('cue-and-named')?.fires(gateInputs(one({ question: 'average enrollment at least 10' }), schema))).toBe(true);
    expect(byName.get('cue-and-named')?.fires(gateInputs(one({ question: 'average enrollment' }), schema))).toBe(false);
  });
});

describe('scoring a gate', () => {
  const gate = GATES.find((entry) => entry.name === 'cue');
  if (gate === undefined) throw new Error('the cue gate is the one these cases are about');

  it('counts fires, hits, precision and recall against the labelled population', () => {
    const cases = [
      one({ id: '1', db: 'a', question: 'at least 10', missing: 2 }),
      one({ id: '2', db: 'a', question: 'at least 10', missing: 0 }),
      one({ id: '3', db: 'b', question: 'how many', missing: 1 }),
      one({ id: '4', db: 'b', question: 'at least 10', missing: 0 }),
    ];
    const score = scoreGate(gate, cases, new Map([['a', schema], ['b', schema]]));
    expect(score.fired).toBe(3);
    expect(score.hit).toBe(1);
    expect(score.precision).toBeCloseTo(1 / 3, 10);
    // Two cases carry a missing condition (ids 1 and 3) and the gate reaches one of them.
    expect(score.recall).toBe(0.5);
  });

  it('reports a precision of zero, not a NaN, when a gate never fires', () => {
    const score = scoreGate(gate, [one({ question: 'how many' })], new Map([['shop', schema]]));
    expect(score.fired).toBe(0);
    expect(score.precision).toBe(0);
    expect(score.worstFold).toBe(1);
  });

  it('keeps the per-database folds, worst first-class, because one corpus is not eleven', () => {
    const cases = [
      one({ id: '1', db: 'a', question: 'at least 10', missing: 1 }),
      one({ id: '2', db: 'b', question: 'at least 10', missing: 0 }),
      one({ id: '3', db: 'b', question: 'at least 10', missing: 0 }),
    ];
    const score = scoreGate(gate, cases, new Map([['a', schema], ['b', schema]]));
    expect(score.folds).toEqual([
      { db: 'b', fired: 2, hit: 0 },
      { db: 'a', fired: 1, hit: 1 },
    ]);
    expect(score.worstFold).toBe(0);
  });

  it('skips a case whose database the schema index does not hold, rather than scoring it', () => {
    // A case the gate cannot read is not a case the gate refused: counting it as a miss would make
    // a corpus with one unwired database look like a gate with low precision.
    const score = scoreGate(gate, [one({ db: 'missing', question: 'at least 10', missing: 1 })], new Map());
    expect(score.fired).toBe(0);
  });

  it('requires all three bars at once', () => {
    const good = { name: 'x', note: '', fired: 40, hit: 30, precision: 0.75, recall: 0.5, folds: [], worstFold: 0.6 };
    expect(clears(good, 400)).toBe(true);
    expect(clears({ ...good, precision: 0.45 }, 400)).toBe(false);
    expect(clears({ ...good, recall: 0.39 }, 400)).toBe(false);
    // The same gate over a corpus it buys half of: 40 of 80 fires is not a gate, it is the arm that
    // already lost with a nicer name.
    expect(clears(good, 80)).toBe(false);
    expect(clears(good, 0)).toBe(false);
    expect(REQUIRED_PRECISION).toBe(0.5);
    expect(REQUIRED_RECALL).toBe(0.4);
    expect(MAX_FIRE_SHARE).toBe(0.25);
  });
});

describe('joining the artifact to the split', () => {
  const gold = new Map([
    ['1', { SQL: 'select count(*) from schools where county = \'x\'', db: 'shop', question: 'q', evidence: 'e' }],
    ['2', { SQL: 'select count(*) from schools where county = \'x\'', db: 'shop', question: 'q', evidence: 'e' }],
  ]);

  it('keeps a case with both sql and asked, and counts the ones it had to drop', () => {
    const joined = gateCases(
      {
        cases: [
          { arm: 'names', id: '1', sql: 'select count(*) from schools', asked: { db: 'shop', question: 'how many schools' } },
          { arm: 'names', id: '2', sql: 'select 1' },
          { arm: 'names', id: '3', sql: 'select 1', asked: { db: 'shop', question: 'q' } },
          { arm: 'names', id: '4', sql: '', asked: { db: 'shop', question: 'q' } },
          { arm: 'other', id: '1', sql: 'select 1', asked: { db: 'shop', question: 'q' } },
        ],
      },
      'names',
      gold,
    );
    expect(joined.cases.map((entry) => entry.id)).toEqual(['1']);
    expect(joined.missingAsked).toBe(1);
    expect(joined.unknownQuestion).toBe(1);
    expect(joined.missingSql).toBe(1);
    // The label is the gold's conditions against the statement: `county` is written by the gold and
    // named by nothing in `select count(*) from schools`.
    expect(joined.cases[0]?.missing).toBe(1);
    expect(joined.cases[0]?.stated).toBe(1);
  });

  it('falls back to the split\'s database when the case did not record one', () => {
    const joined = gateCases(
      { cases: [{ arm: 'names', id: '1', sql: 'select 1', asked: { question: 'q' } }] },
      'names',
      gold,
    );
    expect(joined.cases[0]?.db).toBe('shop');
    expect(joined.cases[0]?.evidence).toBe('e');
  });

  it('counts a repeated case once, because the second row is the same measurement', () => {
    // The runner writes one row per case per arm; a duplicate is a broken file rather than a second
    // reading, and counting it would weight one question twice in every gate below.
    const joined = gateCases(
      {
        cases: [
          { arm: 'names', id: '1', sql: 'select 1', asked: { db: 'shop', question: 'q' } },
          { arm: 'names', id: '1', sql: 'select 1', asked: { db: 'shop', question: 'q' } },
        ],
      },
      'names',
      gold,
    );
    expect(joined.cases).toHaveLength(1);
  });

  it('prints the reading as JSON when asked, so another tool can read it without parsing a table', () => {
    const lines: string[] = [];
    const code = main(
      ['--artifact', '/workspace/tmp/diverse/bird-eval.json', '--arm', 'select-cross', '--json'],
      '/workspace/nl2charts',
      (line) => lines.push(line),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as { cases: number; scores: { name: string }[]; lines: string[] };
    expect(parsed.cases).toBe(600);
    expect(parsed.scores).toHaveLength(6);
    expect(parsed.lines[0]).toContain('gating the condition audit');
  });

  it('reads nothing, rather than failing, from an artifact with no cases key', () => {
    expect(gateCases({ split: 'dev' }, 'names', gold)).toEqual({ cases: [], missingSql: 0, missingAsked: 0, unknownQuestion: 0 });
  });
});

describe('the report', () => {
  const cases = [
    one({ id: '1', question: 'at least 10', missing: 1 }),
    one({ id: '2', question: 'how many', missing: 0 }),
  ];
  const scores = GATES.map((gate) => scoreGate(gate, cases, new Map([['shop', schema]])));

  it('prints the population, the cue share, the table and the bars', () => {
    const text = reportLines(cases, scores, { split: 'dev', model: 'm' }, 'names', {
      missingSql: 0,
      missingAsked: 0,
      unknownQuestion: 0,
    }).join('\n');
    expect(text).toContain('gating the condition audit for names on 2 cases (dev, m)');
    expect(text).toContain('names no column of a gold condition: 1 (50.0%)');
    // The half of the population whose question states no comparison is the finding that explains
    // why no lexical gate reaches it.
    expect(text).toContain('of those, 1 state a comparison word (100.0%)');
    expect(text).toContain('bars, registered before the run: precision >= 50%, recall >= 40%, fires on <= 25% of the corpus');
  });

  it('says no gate clears, and names the best one, rather than printing a silent table', () => {
    const text = reportLines(cases, scores, {}, 'names', { missingSql: 0, missingAsked: 0, unknownQuestion: 0 }).join('\n');
    expect(text).toContain('verdict: no gate clears all three bars');
    expect(text).toContain('the audit stays unpriced rather than dispatched');
  });

  it('says a gate clears when one does, and names its precision, recall and bill', () => {
    // Eight cases and one fire: a gate has to be *rare* as well as right, so the fixture has a
    // corpus big enough for its bill to be a bill.
    const many = [
      ...cases,
      ...Array.from({ length: 6 }, (_, index) => one({ id: String(index + 3), question: 'how many', missing: 0 })),
    ];
    const good = { name: 'named', note: '', fired: 1, hit: 1, precision: 1, recall: 1, folds: [], worstFold: 1 };
    const text = reportLines(many, [good], {}, 'names', { missingSql: 0, missingAsked: 0, unknownQuestion: 0 }).join('\n');
    expect(text).toContain('verdict: named clears all three');
    expect(text).toContain('it buys 12.5% of the corpus');
  });

  it('refuses to read anything from a corpus with no cases', () => {
    const text = reportLines([], [], {}, 'names', { missingSql: 0, missingAsked: 0, unknownQuestion: 0 }).join('\n');
    expect(text).toContain('verdict: no case carried the fields a gate needs');
    expect(text).not.toContain('bars, registered before the run');
  });

  it('counts the drops so an empty table cannot be mistaken for a clean one', () => {
    const text = reportLines(cases, scores, {}, 'names', { missingSql: 2, missingAsked: 3, unknownQuestion: 1 }).join('\n');
    expect(text).toContain('dropped 3 without asked, 2 without sql, 1 the split does not hold');
  });
});

describe('the harness around the reading', () => {
  it('resolves the artifact against the root it was given, and refuses a missing flag', () => {
    expect(resolveSettings(['--artifact', 'a.json', '--arm', 'names'], '/repo')).toMatchObject({ artifact: '/repo/a.json', arm: 'names' });
    expect(resolveSettings(['a.json', '--arm', 'names'], '/repo').artifact).toBe('/repo/a.json');
    expect(() => resolveSettings(['--arm', 'names'], '/repo')).toThrow(/--artifact is required/);
    expect(() => resolveSettings(['--artifact', 'a.json'], '/repo')).toThrow(/--arm is required/);
  });

  it('builds a schema of column names per database', () => {
    // A two-table file rather than the corpus: the reading depends on the corpus being present and
    // a plan-time test must not, or the gate is only testable on a machine that has the split.
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    const file = join(dir, 'tables.json');
    writeFileSync(
      file,
      JSON.stringify([
        { db_id: 'shop', table_names: ['School', 'Rate'], column_names: [[-1, '*'], [0, 'Name'], [1, 'Rate']] },
      ]),
    );
    try {
      const schemas = schemasFor({ split: 'minidev', tablesFile: file } as never);
      expect([...schemas.keys()]).toEqual(['shop']);
      expect([...(schemas.get('shop')?.columns ?? [])].sort()).toEqual(['name', 'rate']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints a thrown string rather than a stack trace when it is the entry point', () => {
    const errors: string[] = [];
    const code = dispatch(
      '/eval/bird/condition-gate.ts',
      'file:///eval/bird/condition-gate.ts',
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

  it('does nothing when it is imported rather than run', () => {
    expect(dispatch(undefined, 'file:///eval/bird/condition-gate.ts', [], '/repo')).toBeUndefined();
    expect(dispatch('/other.ts', 'file:///eval/bird/condition-gate.ts', [], '/repo')).toBeUndefined();
  });

  it('refuses a run whose artifact holds no case for the arm, instead of printing a zero table', () => {
    const lines: string[] = [];
    expect(() =>
      main(['--artifact', '/workspace/tmp/diverse/bird-eval.json', '--arm', 'no-such-arm'], '/workspace/nl2charts', (line) => lines.push(line)),
    ).toThrow(/nothing to gate/);
  });
});
