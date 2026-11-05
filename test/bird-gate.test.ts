/**
 * The question-side gate, tested on questions rather than on numbers.
 *
 * Every assertion here is about a signal doing the thing its name says: `named-entity` must not fire
 * on the words a question capitalises for grammar, `quoted-literal` must read a quote and not a
 * possessive, `no-predicate` must read a statement's predicates rather than look for the word
 * `where` in a literal. The one number the file pins is the *shape* of the verdict, because the
 * verdict is the deliverable: a gate whose ceiling is under the split's resolution must be reported
 * as unreadable rather than as "no effect", and a gate outside the cost budget must say by how much.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COST_BUDGET_PP,
  DEFAULT_RESOLUTION_PP,
  GATE_SIGNALS,
  gateCases,
  main,
  gateLines,
  gateProblems,
  namedEntities,
  priceGate,
  quotedLiterals,
  resolveGateSettings,
} from '../eval/bird/gate.js';
import type { GateCase, GateReport } from '../eval/bird/gate.js';
import type { BirdQuestion } from '../eval/bird/data.js';
import type { RewriteArtifact } from '../eval/bird/rewrite.js';

const question = (overrides: Partial<BirdQuestion> = {}): BirdQuestion => ({
  question_id: 1,
  db_id: 'shop',
  question: 'How many schools in merged Alameda have fewer than 100 test takers?',
  evidence: '',
  SQL: "select count(*) from schools where status = 'Merged' and county = 'Alameda' and takers < 100",
  difficulty: 'simple',
  ...overrides,
});

describe('namedEntities', () => {
  it('reads a capitalised phrase and keeps its words together', () => {
    expect(namedEntities('Which school in Contra Costa has the highest number of test takers?')).toEqual(['Contra Costa']);
  });

  it('drops the words a question capitalises for grammar', () => {
    const phrases = namedEntities('What Is The Capital Of France');
    expect(phrases).not.toContain('What');
    expect(phrases).toContain('France');
  });

  it('keeps a name that begins the question', () => {
    expect(namedEntities('Alameda County has how many schools')).toEqual(['Alameda County']);
  });

  it('drops a phrase that is only grammar words', () => {
    expect(namedEntities('How Many Of The')).toEqual([]);
  });

  it('reads one phrase per run of capitalised words', () => {
    expect(namedEntities('Compare Los Angeles County with Fresno Unified')).toEqual(['Los Angeles County', 'Fresno Unified']);
  });
});

describe('quotedLiterals', () => {
  it('reads both quote styles and keeps the value', () => {
    expect(quotedLiterals(`the school called "Lincoln High" and 'Oak Grove'`)).toEqual(['Lincoln High', 'Oak Grove']);
  });

  it('reads nothing from a question that quotes nothing', () => {
    expect(quotedLiterals('how many schools are there')).toEqual([]);
  });
});

describe('the signals', () => {
  const signal = (name: string): (typeof GATE_SIGNALS)[number] => {
    const found = GATE_SIGNALS.find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`no signal ${name}`);
    return found;
  };

  it('fires on a named entity the statement never mentions', () => {
    const cues = signal('named-entity').cues('schools in Contra Costa', 'select 1 from schools', []);
    expect(cues).toEqual(['Contra Costa']);
  });

  it('cannot tell a shortened value from an omission, which is the whole problem', () => {
    // `Alameda` is what the column stores for the question's "Alameda County". The restriction is
    // written; the phrase is not. This fires, and it is one of the two reasons the gate's precision
    // is 25% on dev rather than the 80% a repair would need.
    expect(signal('named-entity').cues('schools in Alameda County', "select 1 from schools where county = 'Alameda'", [])).toEqual(['Alameda County']);
  });

  it('fires on a quoted literal the statement never mentions', () => {
    expect(signal('quoted-literal').cues(`the school named 'Oak Grove'`, 'select 1 from schools', [])).toEqual(['Oak Grove']);
  });

  it('reads a statement with no predicate as no predicate', () => {
    expect(signal('no-predicate').cues('anything', 'select 1 from t', [])).toEqual(['no predicate']);
    expect(signal('no-predicate').cues('anything', "select 1 from t where a = 'where'", ['a = 1'])).toEqual([]);
  });

  it('needs both a cue and an empty statement for the cue signal', () => {
    expect(signal('cue-without-predicate').cues('schools with more than 100 takers', 'select 1 from t', [])).toEqual(['more than']);
    expect(signal('cue-without-predicate').cues('schools with more than 100 takers', 'select 1 from t', ['takers > 100'])).toEqual([]);
    expect(signal('cue-without-predicate').cues('all schools', 'select 1 from t', [])).toEqual([]);
  });
});

describe('gateCases', () => {
  it('survives an artifact that kept neither a failure row nor any case', () => {
    expect(gateCases({}, 'a', [question()])).toEqual([]);
  });

  it('skips a case whose question the split does not hold', () => {
    const artifact: RewriteArtifact = { cases: [{ id: '9', arm: 'a', passed: false, predicted: 'select 1' }] };
    expect(gateCases(artifact, 'a', [question()])).toEqual([]);
  });

  it('joins the arm, the question and the statement, and files the gaps', () => {
    const artifact: RewriteArtifact = {
      cases: [
        { id: '1', arm: 'a', passed: false, predicted: 'select count(*) from schools' },
        { id: '1', arm: 'b', passed: true, predicted: 'select 1' },
        { id: '2', arm: 'a', passed: false },
      ],
    };
    const cases = gateCases(artifact, 'a', [question(), question({ question_id: 2 })]);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.kinds).toContain('absent');
  });
});

describe('priceGate', () => {
  const caseOf = (id: string, sql: string, kinds: readonly string[]): GateCase => ({ id, question: 'schools in Contra Costa', sql, kinds });

  it('counts fires, reach and precision for every signal', () => {
    const priced = priceGate([caseOf('1', 'select 1 from t', ['absent']), caseOf('2', "select 1 from t where county = 'Contra Costa'", [])], 10, 2.93);
    const named = priced.readings.find((reading) => reading.signal === 'named-entity');
    expect(named).toMatchObject({ fires: 1, reached: 1, reachedAbsent: 1, precision: 100, costPp: 50 });
    expect(named?.ceilingPp).toBe(50);
    const noPredicate = priced.readings.find((reading) => reading.signal === 'no-predicate');
    expect(noPredicate).toMatchObject({ fires: 1, reached: 1, precision: 100 });
  });

  it('reports zeros rather than dividing by zero on an empty corpus', () => {
    const priced = priceGate([], 10, 2.93);
    expect(priced.scored).toBe(0);
    expect(priced.readings.every((reading) => reading.precision === 0 && reading.costPp === 0)).toBe(true);
  });

  it('counts a case once per kind, because the kinds are not exclusive', () => {
    const priced = priceGate([caseOf('1', 'select 1 from t', ['absent', 'substituted'])], 10, 2.93);
    expect(priced).toMatchObject({ absent: 1, substituted: 1, unstated: 0 });
  });
});

describe('gateProblems', () => {
  const base: Omit<GateReport, 'problems'> = { split: 'dev', arm: 'a', scored: 4, absent: 1, substituted: 0, unstated: 0, budgetPp: 10, resolutionPp: 2.93, readings: [] };

  it('refuses a corpus with no statement to price', () => {
    expect(gateProblems({ ...base, scored: 0 })[0]).toContain('no case carried a statement');
  });

  it('refuses a corpus that contradicts the census', () => {
    expect(gateProblems({ ...base, absent: 0 })[0]).toContain('contradicts the census');
  });

  it('refuses a signal that fires on every question', () => {
    const problems = gateProblems({
      ...base,
      readings: [{ signal: 'x', claim: '', fires: 4, reached: 1, reachedAbsent: 1, ceilingPp: 25, precision: 25, costPp: 100 }],
    });
    expect(problems.join(' ')).toContain('fires on every question');
  });

  it('passes a readable gate', () => {
    expect(gateProblems(base)).toEqual([]);
  });
});

describe('the verdict the report prints', () => {
  const reading = (signal: string, reached: number, costPp: number, precision = 50) => ({
    signal,
    claim: '',
    fires: 10,
    reached,
    reachedAbsent: reached,
    ceilingPp: reached / 10,
    precision,
    costPp,
  });
  const report = (readings: GateReport['readings'], resolutionPp = 2.93): GateReport => ({
    split: 'dev',
    arm: 'a',
    scored: 100,
    absent: 10,
    substituted: 0,
    unstated: 0,
    budgetPp: COST_BUDGET_PP,
    resolutionPp,
    readings,
    problems: [],
  });

  it('names the cost multiple when the widest reach is outside the budget', () => {
    const lines = gateLines(report([reading('wide', 40, 60), reading('narrow', 5, 2)]));
    expect(lines.join('\n')).toContain('6.0× the pre-registered budget');
  });

  it('says unreadable when the widest gate inside the budget has a ceiling under the resolution', () => {
    const lines = gateLines(report([reading('wide', 40, 60), reading('narrow', 5, 2)])).join('\n');
    expect(lines).toContain('below the resolution');
    expect(lines).toContain('not dispatched');
  });

  it('says readable when the ceiling clears the resolution', () => {
    const lines = gateLines(report([reading('narrow', 60, 4)])).join('\n');
    expect(lines).toContain('could produce a readable result');
  });

  it('says nothing can be built when no signal fits the budget', () => {
    const lines = gateLines(report([reading('wide', 40, 60)])).join('\n');
    expect(lines).toContain('no signal fits the budget');
  });

  it('prints a failure line for a problem', () => {
    expect(gateLines({ ...report([]), problems: ['GATE: nope'] }).join('\n')).toContain('FAILED GATE: nope');
  });
});

describe('resolveGateSettings', () => {
  it('reads the two flags and defaults the resolution to the dev published one', () => {
    const settings = resolveGateSettings(['--artifact', 'a.json', '--arm', 'x'], '/tmp/root', {});
    expect(settings).toMatchObject({ artifact: 'a.json', arm: 'x', resolution: DEFAULT_RESOLUTION_PP });
  });

  it('takes a resolution when one is stated', () => {
    expect(resolveGateSettings(['--artifact', 'a', '--arm', 'x', '--resolution', '2.3'], '/tmp/root', {}).resolution).toBe(2.3);
  });

  it('refuses a resolution that is not a positive number', () => {
    expect(() => resolveGateSettings(['--artifact', 'a', '--arm', 'x', '--resolution', '0'], '/tmp/root', {})).toThrow(/positive number/);
  });

  it('requires the artifact and the arm', () => {
    expect(() => resolveGateSettings([], '/tmp/root', {})).toThrow(/--artifact is required/);
    expect(() => resolveGateSettings(['--artifact', 'a'], '/tmp/root', {})).toThrow(/--arm is required/);
  });

  it('refuses an argument it does not know', () => {
    expect(() => resolveGateSettings(['--arm', 'x', '--artefact', 'a'], '/tmp/root', {})).toThrow(/unrecognized argument/);
  });
});

describe('the entry, run the way a workflow runs it', () => {
  const rootOf = (): string => {
    const base = mkdtempSync(join(tmpdir(), 'nl2charts-gate-'));
    const data = join(base, 'eval/.cache/bird/minidev/MINIDEV');
    mkdirSync(data, { recursive: true });
    writeFileSync(
      join(data, 'mini_dev_sqlite.json'),
      JSON.stringify([
        { question_id: 1, db_id: 'shop', question: 'schools in Contra Costa', evidence: '', SQL: "select count(*) from schools where county = 'Contra Costa'", difficulty: 'simple' },
        { question_id: 2, db_id: 'shop', question: 'how many schools', evidence: '', SQL: 'select count(*) from schools', difficulty: 'simple' },
      ]),
    );
    return base;
  };

  it('prices a gate end to end and exits zero', () => {
    const base = rootOf();
    const artifact = join(base, 'artifact.json');
    writeFileSync(
      artifact,
      JSON.stringify({
        split: 'minidev',
        cases: [
          { id: '1', arm: 'a', passed: false, predicted: 'select count(*) from schools' },
          { id: '2', arm: 'a', passed: true, predicted: "select count(*) from schools where county = 'Contra Costa'" },
        ],
      }),
    );
    expect(main(['--artifact', artifact, '--arm', 'a'], base, {})).toBe(0);
  });

  it('takes the split from the environment when the artifact names none', () => {
    const base = rootOf();
    const artifact = join(base, 'artifact.json');
    writeFileSync(artifact, JSON.stringify({ cases: [{ id: '1', arm: 'a', passed: false, predicted: 'select 1' }] }));
    expect(main(['--artifact', artifact, '--arm', 'a'], base, { BIRD_SPLIT: 'minidev' })).toBe(0);
  });

  it('exits non-zero for a corpus that carries no statement at all', () => {
    const base = rootOf();
    const artifact = join(base, 'artifact.json');
    writeFileSync(artifact, JSON.stringify({ split: 'minidev', cases: [] }));
    expect(main(['--artifact', artifact, '--arm', 'a'], base, {})).toBe(1);
  });
});
