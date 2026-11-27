/**
 * The clause census, pinned in the two directions it can be wrong.
 *
 * A census is arithmetic over names, so it has two ways to be wrong and only one of them is a
 * crash. The first is a part that is read wrongly — a `group by` counted as a projection, an alias
 * counted as a table — and the second is a partition that does not add up: one case in two buckets,
 * or a denominator taken from retained cases while the run's real denominator was larger. Both were
 * live defects under other instruments in this repository, so the cases here are of two kinds. The
 * unit cases pin one part at a time with a statement pair that differs in nothing else, which is
 * the only way a test can tell "the tables differ" from "the tables and everything after them
 * differ". The bookkeeping cases build a population by hand and then mutate one count, because a
 * gate that cannot be made to fire is a gate nobody has tested.
 *
 * Nothing here calls a model or a database: the instrument reads two strings, so the fixture is
 * two strings, and a case that would need SQLite to be wrong is a case this file cannot have.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CENSUS_BUCKETS,
  CENSUS_PARTS,
  DEFAULT_CENSUS_ARM,
  bucketFor,
  censusLines,
  censusPath,
  censusProblems,
  censusSentence,
  differingParts,
  isEntry,
  main,
  readCensusInputs,
  resolveCensusSettings,
  runCensus,
  tableDirection,
  tallyCensus,
  writeCensusArtifact,
} from '../eval/bird/census.js';
import type { CensusCase, CensusOutcome } from '../eval/bird/census.js';

/** A statement with all six parts present, so a variant of it can differ in exactly one. */
const GOLD =
  'select i.name, sum(o.qty) from items i join orders o on o.item_id = i.id where o.qty > 1 group by i.name order by sum(o.qty) desc limit 5';

describe('which part differs', () => {
  it('reads each of the six parts on a pair that differs in nothing else', () => {
    expect(differingParts(GOLD, GOLD)).toEqual([]);
    // A different relation, with the select list, the filter and the grain left alone.
    expect(differingParts('select count(*) from items', 'select count(*) from orders')).toEqual(['tables']);
    expect(differingParts(GOLD.replace('group by i.name', 'group by i.name, i.id'), GOLD)).toEqual(['grain']);
    // An aggregate carries its expression into the projection, which is why the precedence puts
    // `aggregate` before `projection`: the second difference is a consequence of the first.
    expect(differingParts(GOLD.replace('sum(o.qty)', 'count(o.qty)'), GOLD)).toEqual(['aggregate', 'projection']);
    expect(differingParts(GOLD.replace('limit 5', 'limit 6'), GOLD)).toEqual(['window']);
    expect(differingParts(GOLD.replace('i.name, sum', 'i.id, sum'), GOLD)).toEqual(['projection']);
    expect(differingParts(GOLD.replace('o.qty > 1', 'o.qty > 2'), GOLD)).toEqual(['filter']);
  });

  it('reads an alias as a spelling, not as a difference', () => {
    // The same instruction written with another alias and another quoting is one statement, and a
    // census that counted it would fill the projection bucket with the model's formatting.
    const respelled = 'SELECT "i"."name", SUM("o"."qty") FROM items AS i JOIN orders AS o ON o.item_id = i.id WHERE o.qty > 1 GROUP BY i.name ORDER BY SUM(o.qty) DESC LIMIT 5';
    expect(differingParts(respelled, GOLD)).toEqual([]);
  });
});

describe('the bucket a case lands in', () => {
  it('takes the first two-way split as the bucket', () => {
    expect(bucketFor(['tables', 'projection'], false)).toBe('tables');
    expect(bucketFor(['filter'], false)).toBe('filter');
  });

  it('separates a tie from a construct the parts do not model', () => {
    // `distinct` is not one of the six parts, so a statement that adds it differs in nothing the
    // census reads. Counting that as a "tie" would claim the engine was given the same statement.
    expect(bucketFor([], true)).toBe('tie');
    expect(bucketFor([], false)).toBe('unmodelled');
    expect(differingParts('select distinct count(*) from items', 'select count(*) from items')).toEqual([]);
  });
});

describe('which way the tables are wrong', () => {
  it('splits missing, extra and a different relation', () => {
    const both = 'select count(*) from items i join orders o on o.item_id = i.id';
    expect(tableDirection('select count(*) from items', both)).toBe('missing');
    expect(tableDirection(both, 'select count(*) from items')).toBe('extra');
    expect(tableDirection('select count(*) from warehouses w', both)).toBe('both');
  });

  it('refuses to name a direction for two statements that read the same tables', () => {
    // The function is public and the type has no "none" member, so a caller that asks the question
    // of an agreeing pair is asking for a reading that does not exist. Returning `extra` there
    // would be a wrong answer that compiles.
    expect(() => tableDirection(GOLD, GOLD)).toThrow(/only defined for two statements whose table sets differ/);
  });
});

/** The eight cases that fill one bucket each, on the pair above. */
function fixtureCases(): CensusCase[] {
  return [
    { id: '1', sql: 'select count(*) from orders', gold: 'select count(*) from items', asked: { difficulty: 'simple' } },
    { id: '2', sql: GOLD.replace('group by i.name', 'group by i.name, i.id'), gold: GOLD, asked: { difficulty: 'simple' } },
    { id: '3', sql: GOLD.replace('sum(o.qty)', 'count(o.qty)'), gold: GOLD, asked: { difficulty: 'moderate' } },
    { id: '4', sql: GOLD.replace('limit 5', 'limit 6'), gold: GOLD, asked: { difficulty: 'moderate' } },
    { id: '5', sql: GOLD.replace('i.name, sum', 'i.id, sum'), gold: GOLD, asked: { difficulty: 'moderate' } },
    { id: '6', sql: GOLD.replace('o.qty > 1', 'o.qty > 2'), gold: GOLD, asked: { difficulty: 'challenging' } },
    { id: '7', sql: GOLD, gold: GOLD, asked: { difficulty: 'challenging' } },
    { id: '8', sql: 'select distinct count(*) from items', gold: 'select count(*) from items' },
  ];
}

function fixtureOutcome(): CensusOutcome {
  return tallyCensus({ split: 'dev', arm: 'macsql-prompt', total: 10, passed: 2, cases: fixtureCases() });
}

describe('the tally', () => {
  it('gives each case one bucket and reconciles with the artifact totals', () => {
    const outcome = fixtureOutcome();
    expect(outcome.population).toBe(8);
    expect(outcome.compared).toBe(8);
    expect(outcome.buckets).toEqual({
      tables: 1,
      grain: 1,
      aggregate: 1,
      window: 1,
      projection: 1,
      filter: 1,
      tie: 1,
      unmodelled: 1,
      unretained: 0,
    });
    expect(outcome.problems).toEqual([]);
  });

  it('counts a case once per part in the union, and once in the bucket', () => {
    const outcome = tallyCensus({
      split: 'dev',
      arm: 'macsql-prompt',
      total: 2,
      passed: 1,
      cases: [{ id: '1', sql: GOLD.replace('sum(o.qty)', 'count(o.qty)'), gold: GOLD }],
    });
    // The aggregate change carries the projection with it: two parts differ, one bucket is used.
    expect(outcome.union.aggregate).toBe(1);
    expect(outcome.union.projection).toBe(1);
    expect(outcome.buckets.aggregate).toBe(1);
    expect(outcome.buckets.projection).toBe(0);
    // Nothing differs in exactly one part, so the population a single mechanism can address is
    // empty — which is the reading a "sole difference" column exists to make visible.
    expect(CENSUS_PARTS.reduce((sum, part) => sum + outcome.sole[part], 0)).toBe(0);
  });

  it('counts the sole-difference population and the table direction', () => {
    const outcome = tallyCensus({
      split: 'dev',
      arm: 'macsql-prompt',
      total: 3,
      passed: 0,
      cases: [
        { id: '1', sql: GOLD.replace('limit 5', 'limit 6'), gold: GOLD },
        { id: '2', sql: 'select count(*) from items', gold: 'select count(*) from items i join orders o on o.item_id = i.id' },
        { id: '3', sql: 'select count(*) from warehouses w', gold: 'select count(*) from items i join orders o on o.item_id = i.id' },
      ],
    });
    expect(outcome.sole.window).toBe(1);
    expect(outcome.buckets.window).toBe(1);
    expect(outcome.direction).toEqual({ missing: 1, extra: 0, both: 1 });
  });

  it('counts a case with no statement as unretained instead of dropping it', () => {
    const outcome = tallyCensus({
      split: 'dev',
      arm: 'macsql-prompt',
      total: 5,
      passed: 1,
      cases: [
        { id: '1', sql: undefined, gold: GOLD },
        { id: '2', sql: '   ', gold: GOLD },
        { id: '3', sql: GOLD, gold: undefined },
        { id: '4', sql: GOLD, gold: '  ' },
      ],
    });
    expect(outcome.buckets.unretained).toBe(4);
    expect(outcome.compared).toBe(0);
    expect(outcome.problems).toEqual([]);
  });
});

describe('the gates', () => {
  it('refuses a partition that does not add up to the population', () => {
    const outcome = fixtureOutcome();
    const problems = censusProblems({ ...outcome, buckets: { ...outcome.buckets, tables: 2 } });
    expect(problems.some((line) => line.includes('buckets sum to 9'))).toBe(true);
  });

  it('refuses a population that is not the artifact subtraction', () => {
    const outcome = fixtureOutcome();
    const problems = censusProblems({ ...outcome, population: 9 });
    expect(problems.some((line) => line.includes('is not the artifact\'s total minus its passed count'))).toBe(true);
  });

  it('refuses a compared count that does not cover the population', () => {
    const outcome = fixtureOutcome();
    const problems = censusProblems({ ...outcome, compared: 7 });
    expect(problems.some((line) => line.includes('compared and'))).toBe(true);
  });

  it('refuses table directions that do not sum to the tables bucket', () => {
    const outcome = fixtureOutcome();
    const problems = censusProblems({ ...outcome, direction: { missing: 0, extra: 0, both: 0 } });
    expect(problems.some((line) => line.includes('table directions sum to 0'))).toBe(true);
  });

  it('refuses a sole count above the population, or above its own bucket', () => {
    const outcome = fixtureOutcome();
    const overPopulation = censusProblems({ ...outcome, sole: { ...outcome.sole, filter: 9 } });
    expect(overPopulation.some((line) => line.includes('sole-difference cases exceed'))).toBe(true);
    const overBucket = censusProblems({ ...outcome, sole: { ...outcome.sole, window: 2 } });
    expect(overBucket.some((line) => line.includes('sole `window` is 2'))).toBe(true);
  });

  it('refuses a union count below the bucket it contains', () => {
    const outcome = fixtureOutcome();
    const problems = censusProblems({ ...outcome, union: { ...outcome.union, tables: 0 } });
    expect(problems.some((line) => line.includes('union `tables` is 0'))).toBe(true);
  });

  it('refuses a difficulty cross-tab that loses a case', () => {
    const outcome = fixtureOutcome();
    const problems = censusProblems({
      ...outcome,
      difficulty: { ...outcome.difficulty, extra: { ...outcome.buckets, tables: 1, grain: 0, aggregate: 0, window: 0, projection: 0, filter: 0, tie: 0, unmodelled: 0, unretained: 0 } },
    });
    expect(problems.some((line) => line.includes('difficulty cross-tab sums to 9'))).toBe(true);
  });
});

describe('the report', () => {
  it('prints a row per bucket, the table direction, the sole population and the difficulty split', () => {
    const lines = censusLines(fixtureOutcome()).join('\n');
    expect(lines).toContain('tables');
    expect(lines).toContain('missing 0 · extra 0 · both 1');
    expect(lines).toContain('of wrong');
    expect(lines).toContain('pp of split');
    expect(lines).toContain('only one part differs: 5 of 8 — tables 1, grain 1, window 1, projection 1, filter 1');
    expect(lines).toContain('differs in a part, each case counted once per part');
    expect(lines).toContain('challenging');
    // The last case declares no difficulty, and a corpus that does not label a question must not
    // make the cross-tab lose it.
    expect(lines).toContain('unstated');
  });

  it('says so when nothing differs in one part alone, and when a case carried no statement', () => {
    const outcome = tallyCensus({
      split: 'dev',
      arm: 'macsql-prompt',
      total: 2,
      passed: 0,
      cases: [
        { id: '1', sql: GOLD.replace('sum(o.qty)', 'count(o.qty)'), gold: GOLD, asked: { difficulty: 'simple' } },
        { id: '2', sql: undefined, gold: GOLD },
      ],
    });
    const lines = censusLines(outcome);
    expect(lines.some((line) => line.includes('only one part differs: 0 of 2'))).toBe(true);
    expect(lines.some((line) => line.includes('carried no statement'))).toBe(true);
    // A case in a residual bucket is listed under that bucket's own name: a row that printed only
    // the six parts would show a total of one and no entry, which reads as a lost case.
    expect(lines.some((line) => line.includes('unretained 1'))).toBe(true);
  });

  it('prints a zero population without dividing by it', () => {
    const outcome = tallyCensus({ split: 'dev', arm: 'macsql-prompt', total: 3, passed: 3, cases: [] });
    const lines = censusLines(outcome);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('0.0% of wrong');
    expect(censusSentence(outcome)).toBe('no unpassed case to read');
  });

  it('prints a zero-split denominator without dividing by it', () => {
    const outcome = tallyCensus({ split: 'dev', arm: 'macsql-prompt', total: 0, passed: 0, cases: [] });
    expect(censusLines(outcome).join('\n')).toContain('0.00pp of split');
  });

  it('summarises the largest bucket in one sentence that states what it is not', () => {
    const sentence = censusSentence(fixtureOutcome());
    expect(sentence).toContain('8 unpassed case(s)');
    expect(sentence).toContain('differ from the gold first in');
    expect(sentence).toContain('a difference is not a defect');
  });
});

describe('the artifact it reads', () => {
  it('takes the totals from the arms block and the cases from this arm only', () => {
    const input = readCensusInputs(
      {
        split: 'dev',
        arms: [
          { arm: 'macsql-prompt', passed: 2, total: 10 },
          { arm: 'select', passed: 0, total: 1 },
        ],
        cases: [
          { arm: 'macsql-prompt', id: 1, passed: true, sql: GOLD, gold: GOLD },
          { arm: 'macsql-prompt', id: 2, passed: false, sql: GOLD, gold: GOLD, asked: { difficulty: 'simple' } },
          { arm: 'select', id: 3, passed: false, sql: GOLD, gold: GOLD },
        ],
      },
      'macsql-prompt',
    );
    expect(input.total).toBe(10);
    expect(input.passed).toBe(2);
    expect(input.cases).toEqual([{ id: '2', sql: GOLD, gold: GOLD, asked: { difficulty: 'simple' } }]);
    expect(input.split).toBe('dev');
  });

  it('counts the cases when the artifact carries no arms block', () => {
    const input = readCensusInputs(
      {
        cases: [
          { arm: 'macsql-prompt', id: 1, passed: true, sql: GOLD, gold: GOLD },
          { arm: 'macsql-prompt', id: 2, passed: false, sql: GOLD, gold: GOLD },
        ],
      },
      'macsql-prompt',
    );
    expect(input.total).toBe(2);
    expect(input.passed).toBe(1);
    // An artifact without a split is not silently labelled with one: the reader has to see that the
    // name came from nothing.
    expect(input.split).toBe('unknown');
  });

  it('reads a file the way the run writes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'census-'));
    const artifact = join(dir, 'artifact.json');
    writeFileSync(
      artifact,
      JSON.stringify({
        split: 'dev',
        generatedAt: '2026-11-27T00:00:00Z',
        arms: [{ arm: 'macsql-prompt', passed: 1, total: 2 }],
        cases: [
          { arm: 'macsql-prompt', id: 1, passed: true, sql: GOLD, gold: GOLD },
          { arm: 'macsql-prompt', id: 2, passed: false, sql: GOLD.replace('limit 5', 'limit 6'), gold: GOLD },
        ],
      }),
    );
    const outcome = await runCensus({ root: dir, artifact, arm: 'macsql-prompt' });
    expect(outcome.population).toBe(1);
    expect(outcome.buckets.window).toBe(1);
    expect(outcome.source).toEqual({ path: artifact, generatedAt: '2026-11-27T00:00:00Z' });
  });
});

describe('where it writes', () => {
  it('names the artifact by arm and split, with the arm made safe for a filename', () => {
    expect(censusPath({ root: '/tmp/x', arm: 'select+mixed:rule', split: 'dev' })).toBe('/tmp/x/eval/out/census-select+mixed_rule-dev.json');
  });

  it('refuses to let a second population take the name of the first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'census-'));
    const first = fixtureOutcome();
    const settings = { root: dir, artifact: '/a/first.json', arm: 'macsql-prompt' };
    const path = writeCensusArtifact(settings, { ...first, source: { path: '/a/first.json', generatedAt: 'one' } });
    expect(JSON.parse(readFileSync(path, 'utf8')).source.generatedAt).toBe('one');
    // The same artifact twice is a re-run, not a second population.
    expect(() => writeCensusArtifact(settings, { ...first, source: { path: '/a/first.json', generatedAt: 'one' } })).not.toThrow();
    expect(() => writeCensusArtifact(settings, { ...first, source: { path: '/a/second.json', generatedAt: 'two' } })).toThrow(
      /already holds a census of \/a\/first\.json/,
    );
  });

  it('writes where it is told when the default name is taken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'census-'));
    const outcome = { ...fixtureOutcome(), source: { path: '/a/second.json', generatedAt: 'two' } };
    const path = writeCensusArtifact({ root: dir, artifact: '/a/second.json', arm: 'macsql-prompt', out: join(dir, 'other.json') }, outcome);
    expect(path).toBe(join(dir, 'other.json'));
    expect(JSON.parse(readFileSync(path, 'utf8')).population).toBe(8);
  });

  it('names the default artifact when the caller names none, and resolves --out against the root', () => {
    const env = { BIRD_DATA: '/tmp/data' };
    const settings = resolveCensusSettings([], '/repo', env);
    expect(settings.artifact).toBe(join('/repo', 'eval', 'out', 'bird-eval.json'));
    expect(settings.arm).toBe(DEFAULT_CENSUS_ARM);
    const named = resolveCensusSettings(['--artifact', '/a.json', '--arm', 'select', '--out', 'x.json'], '/repo', env);
    expect(named).toEqual({ root: '/repo', artifact: '/a.json', arm: 'select', out: '/repo/x.json' });
  });

  it('refuses an argument it does not take, and a flag with no value', () => {
    const env = {};
    expect(() => resolveCensusSettings(['--split', 'dev'], '/repo', env)).toThrow(/unrecognized argument --split/);
    expect(() => resolveCensusSettings(['--arm'], '/repo', env)).toThrow(/--arm needs a value/);
    expect(() => resolveCensusSettings(['--arm', '--out'], '/repo', env)).toThrow(/--arm needs a value/);
  });
});

describe('the command', () => {
  it('prints the census, writes it, and returns zero when the gates hold', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'census-'));
    const artifact = join(dir, 'artifact.json');
    writeFileSync(
      artifact,
      JSON.stringify({
        split: 'dev',
        generatedAt: '2026-11-27T00:00:00Z',
        arms: [{ arm: 'macsql-prompt', passed: 1, total: 2 }],
        cases: [
          { arm: 'macsql-prompt', id: 1, passed: true, sql: GOLD, gold: GOLD },
          { arm: 'macsql-prompt', id: 2, passed: false, sql: GOLD.replace('o.qty > 1', 'o.qty > 2'), gold: GOLD },
        ],
      }),
    );
    const code = await main(['--artifact', artifact], dir, {});
    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(join(dir, 'eval', 'out', 'census-macsql-prompt-dev.json'), 'utf8')) as CensusOutcome;
    expect(written.buckets.filter).toBe(1);
  });

  it('returns one when the artifact carries more unpassed cases than it retains', async () => {
    // A capped artifact is a partial population, and a census of it would be a share of the wrong
    // denominator: the gate says so and the command exits non-zero rather than publishing it.
    const dir = mkdtempSync(join(tmpdir(), 'census-'));
    const artifact = join(dir, 'artifact.json');
    writeFileSync(
      artifact,
      JSON.stringify({
        split: 'dev',
        arms: [{ arm: 'macsql-prompt', passed: 1, total: 4 }],
        cases: [
          { arm: 'macsql-prompt', id: 1, passed: true, sql: GOLD, gold: GOLD },
          { arm: 'macsql-prompt', id: 2, passed: false, sql: GOLD.replace('limit 5', 'limit 6'), gold: GOLD },
        ],
      }),
    );
    expect(await main(['--artifact', artifact], dir, {})).toBe(1);
  });

  it('knows whether it was asked to run', () => {
    expect(isEntry(undefined, 'file:///x')).toBe(false);
    expect(isEntry('/x/y.ts', 'file:///x/y.ts')).toBe(true);
    expect(isEntry('/x/y.ts', 'file:///x/z.ts')).toBe(false);
  });
});

describe('the shape of the report itself', () => {
  it('keeps every bucket in one list, so a new part cannot be added without a column', () => {
    expect(CENSUS_BUCKETS).toEqual(['tables', 'grain', 'aggregate', 'window', 'projection', 'filter', 'tie', 'unmodelled']);
    expect(CENSUS_PARTS).toHaveLength(6);
  });
});
