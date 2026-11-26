/**
 * The 104 failures the residue instrument does not read, and the price of the two rewrites.
 *
 * Two kinds of case here. The unit cases pin the decisions that come from text — which population a
 * failure belongs to, where a refused name lives, and what a rule may edit — because each of them
 * has a wrong answer that looks right: a `column-count` failure read as a projection defect when the
 * rows differ too, a qualified name split at the last dot when the column's own name holds one, a
 * rewrite that parses and compares TEXT to INTEGER. The end-to-end cases run a real SQLite file
 * through the real oracle, because "the repair runs" and "the repair is right" are two counts and a
 * stub would agree with whatever the tool expected.
 *
 * The artifact's `error` field is produced by executing the statement, not written by hand: the
 * classification is a reading of the engine's own sentence, and a fixture that paraphrased it would
 * test this file against itself.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SHIPPED_SQL } from '@agentix-e/nl2charts-ai';
import {
  FAILURE_KINDS,
  REFUSAL_CLASSES,
  REFUSAL_RULES,
  censusLines,
  censusProblems,
  classifyRefusal,
  defaultRefusalArm,
  failureKindOf,
  isEntry,
  main,
  missingNameOf,
  nameSiteOf,
  refusalKindOf,
  refusalsPath,
  requalify,
  resolveRefusalSettings,
  runCensus,
  schemaFrom,
  tallyRefusals,
  writeRefusalArtifact,
  yearToStrftime,
} from '../eval/bird/refusals.js';
import type { ArtifactCase, Census, RefusalRow, SchemaOf } from '../eval/bird/refusals.js';
import { createOracle } from '../eval/bird/oracle.js';
import { tableRefs } from '../eval/bird/statement.js';
import { MINI_DB, writeMiniBirdDataset } from './helpers/bird-dataset.js';

interface PublishedBaseline {
  readonly asked: number;
  readonly passed: number;
  readonly failed: number;
  readonly kinds: { readonly values: number; readonly arity: number; readonly refused: number; readonly unanswered: number };
  readonly classes: readonly {
    readonly refusal: string;
    readonly cases: number;
    readonly attempted: number;
    readonly readable: number;
    readonly exact: number;
    readonly rule: string | null;
  }[];
  readonly repair: { readonly tried: number; readonly ran: number; readonly right: number; readonly deltaPp: number };
  readonly reading: { readonly asWritten: number; readonly asWrittenPct: number; readonly correct: number; readonly repairedPct: number };
  readonly invariant: { readonly passing: number; readonly changedByTheDateRule: number };
  readonly secondArm: { readonly refused: number; readonly unanswered: number };
}

const BASELINE = JSON.parse(readFileSync(new URL('../eval/baseline/bird-refusals.json', import.meta.url), 'utf8')) as PublishedBaseline;

const ARM = 'arms-under-test';

const row = (overrides: Partial<ArtifactCase> = {}): ArtifactCase => ({
  arm: ARM,
  id: 1,
  passed: false,
  reason: 'values',
  ...overrides,
});

const refusalRow = (overrides: Partial<RefusalRow> = {}): RefusalRow => ({
  id: '1',
  db: 'shop',
  message: 'execution: no such column: qty',
  kind: 'name',
  refusal: 'name-not-joined',
  readable: false,
  exact: false,
  ...overrides,
});

const schema = (tables: Readonly<Record<string, readonly string[]>>): SchemaOf => ({
  tables: Object.keys(tables),
  columnsOf: (name) => tables[name] ?? [],
});

describe('which population a failure belongs to', () => {
  it('reads a pass as a pass and the two judged reasons as the populations residue does and does not read', () => {
    expect(failureKindOf(row({ passed: true }))).toBe('passed');
    expect(failureKindOf(row({ reason: 'values' }))).toBe('values');
    // `row-count` is the same population: the residue tool's whole subject is a different number of
    // rows, so a taxonomy that split them would disagree with the instrument reading them.
    expect(failureKindOf(row({ reason: 'row-count' }))).toBe('values');
    expect(failureKindOf(row({ reason: 'column-count' }))).toBe('arity');
  });

  it('separates a refusal from an arm that produced no answer at all', () => {
    expect(failureKindOf(row({ reason: undefined, errorKind: 'execution' }))).toBe('refused');
    // A mixed selector whose three samples all refused guard and execution never reached the judge.
    // Crediting it with an attempt would put a refusal in a population that has none.
    expect(failureKindOf(row({ reason: undefined, errorKind: 'other' }))).toBe('unanswered');
  });

  it('refuses a failed case the artifact neither judged nor named', () => {
    // The one thing this file may not do is leave a failure in a bucket nothing prints.
    expect(() => failureKindOf(row({ reason: undefined }))).toThrow(/failed without a reason or an error kind/u);
  });
});

describe('the engine sentence, before the schema is consulted', () => {
  it('reads each refusal shape it can name', () => {
    expect(refusalKindOf('execution: OperationalError: no such column: T2.School')).toBe('name');
    expect(refusalKindOf('execution: OperationalError: no such table: schools')).toBe('name');
    expect(refusalKindOf('execution: OperationalError: no such function: YEAR')).toBe('date-function');
    expect(refusalKindOf('execution: OperationalError: no such function: DATEDIFF')).toBe('other-function');
    expect(refusalKindOf('execution: OperationalError: interrupted')).toBe('step-budget');
    expect(refusalKindOf('execution: ProgrammingError: You can only execute one statement at a time.')).toBe('statement-count');
    expect(refusalKindOf('execution: something nobody has seen')).toBe('other');
  });

  it('splits the name into a qualifier and a column, at the boundary the statement drew', () => {
    expect(missingNameOf('no such column: T2.School')).toEqual({ qualifier: 'T2', column: 'School' });
    // SQLite reports the name with its quotes stripped, so the message alone cannot say whether the
    // dot belongs to the qualifier or to the column. The statement can.
    expect(missingNameOf('no such column: d.v1.2', 'select d."v1.2" from data d')).toEqual({ qualifier: 'd', column: 'v1.2' });
    expect(missingNameOf('no such column: d.v1.2')).toEqual({ qualifier: 'd.v1', column: '2' });
  });

  it('reports a bare name without inventing a qualifier, and nothing at all for a message it cannot read', () => {
    expect(missingNameOf('no such column: link_to_event')).toEqual({ column: 'link_to_event' });
    expect(missingNameOf('no such column: NSLP Provision Status')).toEqual({ column: 'NSLP Provision Status' });
    expect(missingNameOf('near "FORM": syntax error')).toBeUndefined();
  });
});

describe('where a refused name lives', () => {
  const shop = schema({ items: ['id', 'name', 'price'], orders: ['id', 'item_id', 'qty'] });

  it('separates a wrong qualifier from a missing join from a name no table carries', () => {
    expect(nameSiteOf('name', ['items', 'orders'], shop)).toBe('read');
    expect(nameSiteOf('qty', ['items'], shop)).toBe('not-joined');
    expect(nameSiteOf('zzz', ['items', 'orders'], shop)).toBe('nowhere');
  });

  it('matches a name without regard to case, because SQLite does', () => {
    expect(nameSiteOf('QTY', ['items'], shop)).toBe('not-joined');
    expect(nameSiteOf('qty', ['ORDERS'], shop)).toBe('read');
  });

  it('finds nothing anywhere when the database declares no tables', () => {
    expect(nameSiteOf('qty', ['orders'], schema({}))).toBe('nowhere');
  });
});

describe('re-qualifying a name the engine refused', () => {
  const shop = schema({ items: ['id', 'name', 'price'], orders: ['id', 'item_id', 'qty'] });

  it('rewrites every occurrence to the one table the statement reads that owns the column', () => {
    const sql = 'select T3.qty from items as T1 join orders as T2 on T2.item_id = T1.id where T3.qty > 1';
    const rewritten = requalify(sql, { qualifier: 'T3', column: 'qty' }, tableRefs(sql), shop);
    expect(rewritten).toBe('select T2.qty from items as T1 join orders as T2 on T2.item_id = T1.id where T2.qty > 1');
  });

  it('keeps the quoting the model chose, so the diff is the qualifier alone', () => {
    // `School` is a column of `schools`, which the statement reads as T1; the model qualified it
    // with T2, which is `frpm`. The rewrite changes four characters and no others.
    const sql = 'select T2.`School` from schools as T1 join frpm as T2 on 1 = 1';
    const withSchools = schema({ frpm: ['CDSCode'], schools: ['CDSCode', 'School'] });
    expect(requalify(sql, { qualifier: 'T2', column: 'School' }, tableRefs(sql), withSchools)).toBe(
      'select T1.`School` from schools as T1 join frpm as T2 on 1 = 1',
    );
  });

  it('withholds the rewrite when two tables the statement reads own the name', () => {
    // `id` is in both, so which one the model meant is not decidable from the statement — and a
    // rewriter that guessed would be choosing the relation the model failed to choose.
    const sql = 'select T3.id from items as T1 join orders as T2 on 1 = 1';
    expect(requalify(sql, { qualifier: 'T3', column: 'id' }, tableRefs(sql), shop)).toBeUndefined();
  });

  it('withholds it for a bare name, a name no read table owns, and a qualifier that is already right', () => {
    const sql = 'select qty from items as T1';
    expect(requalify(sql, { column: 'qty' }, tableRefs(sql), shop)).toBeUndefined();
    expect(requalify(sql, { qualifier: 'T1', column: 'zzz' }, tableRefs(sql), shop)).toBeUndefined();
    const owned = 'select T2.qty from items as T1 join orders as T2 on 1 = 1';
    expect(requalify(owned, { qualifier: 'T2', column: 'qty' }, tableRefs(owned), shop)).toBeUndefined();
  });

  it('withholds it when the statement never writes the pair the engine complained about', () => {
    const sql = 'select name from items as T1';
    expect(requalify(sql, { qualifier: 'T9', column: 'name' }, tableRefs(sql), shop)).toBeUndefined();
  });

  it('quotes an alias that is not a bare word, because writing it bare would not name it', () => {
    const sql = 'select T9.qty from orders as "T 2"';
    expect(requalify(sql, { qualifier: 'T9', column: 'qty' }, tableRefs(sql), shop)).toBe('select "T 2".qty from orders as "T 2"');
  });
});

describe('the date dialect, and the cast that makes it a rewrite rather than a parse', () => {
  it('rewrites YEAR to the spelling BIRD\u2019s own golds use, as an integer', () => {
    expect(yearToStrftime('select year(CURRENT_TIMESTAMP) - year(dob) from drivers')).toBe(
      "select CAST(STRFTIME('%Y', CURRENT_TIMESTAMP) AS INTEGER) - CAST(STRFTIME('%Y', dob) AS INTEGER) from drivers",
    );
  });

  it('matches the argument by balanced parentheses, so a nested call keeps its own', () => {
    expect(yearToStrftime('select year(max(dob)) from drivers')).toBe("select CAST(STRFTIME('%Y', max(dob)) AS INTEGER) from drivers");
  });

  it('leaves a literal that mentions the function alone', () => {
    // `'year(x)'` is data: one repair in this repository was already refused for reading data as
    // syntax, and the literal scan is what keeps this one from repeating it.
    expect(yearToStrftime("select 1 where note = 'year(x)'")).toBe("select 1 where note = 'year(x)'");
  });

  it('does not count a parenthesis that belongs to a literal inside the argument', () => {
    expect(yearToStrftime("select year('a)b') from drivers")).toBe("select CAST(STRFTIME('%Y', 'a)b') AS INTEGER) from drivers");
  });

  it('leaves an unbalanced call exactly as it was', () => {
    expect(yearToStrftime('select year(dob from drivers')).toBe('select year(dob from drivers');
  });

  it('is identity when the statement never calls it, which is how a caller tells there is no repair', () => {
    expect(yearToStrftime('select count(*) from items')).toBe('select count(*) from items');
  });
});

describe('the three counts per class', () => {
  it('counts attempts apart from cases, so a rule that withheld half of a class is visible', () => {
    const tallies = tallyRefusals([
      refusalRow({ id: '1', refusal: 'name-misqualified', rule: 'requalify', readable: true, exact: true }),
      refusalRow({ id: '2', refusal: 'name-misqualified' }),
      refusalRow({ id: '3', refusal: 'name-not-joined' }),
    ]);
    expect(tallies.find((entry) => entry.refusal === 'name-misqualified')).toEqual({
      refusal: 'name-misqualified',
      cases: 2,
      attempted: 1,
      readable: 1,
      exact: 1,
    });
    // Every class is a row even when it is empty: a class that disappears from the table reads as a
    // class that does not exist, and `name-nowhere` is a real answer to "where else could it be".
    expect(tallies).toHaveLength(REFUSAL_CLASSES.length);
    expect(tallies.find((entry) => entry.refusal === 'name-nowhere')).toEqual({
      refusal: 'name-nowhere',
      cases: 0,
      attempted: 0,
      readable: 0,
      exact: 0,
    });
  });
});

describe('the report', () => {
  const census = (overrides: Partial<Census> = {}): Census => {
    const rows = overrides.rows ?? [
      refusalRow({ id: '1', refusal: 'name-misqualified', rule: 'requalify', readable: true, exact: false }),
      refusalRow({ id: '2', refusal: 'name-not-joined' }),
    ];
    return {
      split: 'dev',
      arm: ARM,
      asked: 10,
      passed: 8,
      kinds: { values: 0, arity: 0, refused: 2, unanswered: 0 },
      classes: tallyRefusals(rows),
      rows,
      drops: { goldFailed: 0, unretained: 0, unknownQuestion: 0, otherArm: 0 },
      problems: [],
      ...overrides,
    };
  };

  it('prints the population first, then every class, with an em dash where there is no rule', () => {
    const lines = censusLines(census());
    expect(lines[0]).toBe('refusals: 10 asked, 8 passed, 2 failed (values 0, arity 0, refused 2, unanswered 0)');
    expect(lines.join('\n')).toContain('name-misqualified     1  requalify      1     1      0');
    expect(lines.join('\n')).toContain('name-not-joined       1  \u2014              0     0      0');
    expect(lines.join('\n')).toContain('two rules reach 1 statement(s): 1 run, 0 right');
  });

  it('names a repair that ran and answered wrong, because that is the line a reader must not blur', () => {
    expect(censusLines(census()).join('\n')).toContain('ran and answered wrong: #1 name-misqualified');
  });

  it('names a statement a join away, which is the class this file refuses to rewrite', () => {
    const rows = [refusalRow({ id: '7', refusal: 'name-not-joined', message: 'execution: no such column: qty' })];
    expect(censusLines(census({ rows })).join('\n')).toContain('a join away, not a spelling: #7 execution: no such column: qty');
  });
});

describe('the problems a census can raise', () => {
  const base = (overrides: Partial<Census> = {}): Census => ({
    split: 'dev',
    arm: ARM,
    asked: 4,
    passed: 2,
    kinds: { values: 1, arity: 1, refused: 0, unanswered: 0 },
    classes: tallyRefusals([]),
    rows: [],
    drops: { goldFailed: 0, unretained: 0, unknownQuestion: 0, otherArm: 0 },
    problems: [],
    ...overrides,
  });

  it('says so when the artifact holds no refusal, rather than reporting a clean zero', () => {
    // The arm whose guard drops a refused candidate before the judge produces exactly this shape:
    // 0 refusals and 7 "no sample survived" cases. A tool that printed an empty table and exited 0
    // would have called that a measurement.
    expect(censusProblems(base())).toEqual(['REF: this artifact holds no refused case, so the taxonomy measured nothing']);
  });

  it('fails when the classes do not add up to the refusals, or the failures to the artifact', () => {
    const rows = [refusalRow({ id: '1' })];
    expect(censusProblems(base({ kinds: { values: 0, arity: 0, refused: 2, unanswered: 0 }, classes: tallyRefusals(rows) }))).toEqual([
      'REF: 1 classified + 0 dropped refusal(s) against 2 in the artifact',
    ]);
    // The taxonomy also has to account for every failure, not only the refused ones: this artifact
    // holds two failures and the kinds add up to one.
    expect(censusProblems(base({ kinds: { values: 0, arity: 0, refused: 1, unanswered: 0 }, classes: tallyRefusals(rows) }))).toEqual([
      'REF: 1 failure(s) in the taxonomy against 2 in the artifact',
    ]);
  });

  it('fails when a class reads more right answers than it ran', () => {
    const rows = [refusalRow({ id: '1', refusal: 'date-function', rule: 'year', readable: false, exact: true })];
    expect(censusProblems(base({ kinds: { values: 0, arity: 0, refused: 1, unanswered: 0 }, classes: tallyRefusals(rows) }))).toContain(
      'REF: date-function reads exact 1 of readable 0 of attempted 1',
    );
  });

  it('counts a class the census never tallied as zero rather than crashing on a table without it', () => {
    expect(censusProblems(base({ kinds: { values: 0, arity: 0, refused: 1, unanswered: 0 }, classes: [] }))).toEqual([
      'REF: 0 classified + 0 dropped refusal(s) against 1 in the artifact',
      'REF: 1 failure(s) in the taxonomy against 2 in the artifact',
    ]);
  });

  it('is silent when the numbers close, which is the only state a run may be read from', () => {
    const rows = [refusalRow({ id: '1', refusal: 'date-function', rule: 'year', readable: true, exact: true })];
    expect(censusProblems(base({ kinds: { values: 0, arity: 1, refused: 1, unanswered: 0 }, classes: tallyRefusals(rows) }))).toEqual([]);
  });
});

describe('the flags', () => {
  const env = { BIRD_SPLIT: 'dev', BIRD_DATA: '/tmp/data', BIRD_DATABASES: '/tmp/data/dev_databases' };

  it('measures the arm the product ships when nobody names one', () => {
    expect(resolveRefusalSettings([], '/root', env).arm).toBe(SHIPPED_SQL.arm);
    expect(defaultRefusalArm()).toBe('macsql-prompt');
  });

  it('refuses to invent a default when the shipped recipe names no arm', () => {
    // The assembled skeleton is a fallback, not a benchmark arm: a bare run against it has nothing
    // to measure, and a name made up here would describe an arm no artifact contains.
    expect(() => defaultRefusalArm({ ...SHIPPED_SQL, arm: undefined })).toThrow(/names no arm/u);
  });

  it('takes the artifact and the arm from the command line', () => {
    const settings = resolveRefusalSettings(['--artifact', '/tmp/a.json', '--arm', 'names'], '/root', env);
    expect(settings.artifact).toBe('/tmp/a.json');
    expect(settings.arm).toBe('names');
  });

  it('refuses a flag it does not read, and a flag with no value', () => {
    expect(() => resolveRefusalSettings(['--split', 'dev'], '/root', env)).toThrow(/unrecognized argument --split/u);
    expect(() => resolveRefusalSettings(['--arm'], '/root', env)).toThrow(/--arm needs a value/u);
    expect(() => resolveRefusalSettings(['--artifact', '--arm', 'x'], '/root', env)).toThrow(/needs a value/u);
  });
});

describe('the artifact name', () => {
  it('names the arm and the split, so neither replaces the other', () => {
    expect(refusalsPath({ root: '/root', arm: 'macsql-prompt', split: 'dev' })).toBe('/root/eval/out/refusals-macsql-prompt-dev.json');
    expect(refusalsPath({ root: '/root', arm: 'a/b', split: 'minidev' })).toBe('/root/eval/out/refusals-a_b-minidev.json');
    expect(refusalsPath({ root: '/root', arm: 'names', split: 'dev' })).not.toBe(refusalsPath({ root: '/root', arm: 'names', split: 'minidev' }));
  });
});

describe('the declared shape of a database', () => {
  it('skips the star row every manifest carries, which belongs to no table', () => {
    const table = {
      db_id: 'shop',
      tableNames: ['items'],
      tableNamesReadable: ['Items'],
      columnNames: [
        [-1, '*'],
        [0, 'id'],
        [0, 'Name'],
      ] as readonly (readonly [number, string])[],
      columnNamesReadable: [],
      columnTypes: [],
      foreignKeys: [],
    };
    const declared = schemaFrom(table);
    expect(declared.tables).toEqual(['items']);
    expect(declared.columnsOf('ITEMS')).toEqual(['id', 'Name']);
    expect(declared.columnsOf('orders')).toEqual([]);
  });

  it('ignores a column whose table index points past the table list', () => {
    // A truncated manifest is the shape a half-written fetch produces, and a column attributed to a
    // table that is not there would make every name look like it exists somewhere.
    const table = {
      db_id: 'shop',
      tableNames: ['items'],
      tableNamesReadable: ['Items'],
      columnNames: [
        [0, 'id'],
        [7, 'ghost'],
      ] as readonly (readonly [number, string])[],
      columnNamesReadable: [],
      columnTypes: [],
      foreignKeys: [],
    };
    expect(schemaFrom(table).columnsOf('items')).toEqual(['id']);
  });

  it('declares nothing for a database the manifest does not carry', () => {
    const declared = schemaFrom(undefined);
    expect(declared.tables).toEqual([]);
    expect(declared.columnsOf('anything')).toEqual([]);
  });
});

describe('an artifact against a real database', () => {
  interface Fixture {
    readonly dir: string;
    readonly artifact: string;
    readonly settings: ReturnType<typeof resolveRefusalSettings>;
  }

  const env = (data: string) => ({ BIRD_SPLIT: 'minidev', BIRD_DATA: data, BIRD_DATABASES: join(data, 'dev_databases') });

  /** The engine's own sentence for a statement, so the fixture's messages are not paraphrases. */
  const messageOf = (dir: string, sql: string): string => {
    const database = new DatabaseSync(join(dir, 'dev_databases', MINI_DB, `${MINI_DB}.sqlite`));
    try {
      database.exec(sql);
    } catch (error) {
      return `execution: ${(error as Error).message}`;
    } finally {
      database.close();
    }
    throw new Error(`${sql} was expected to be refused, so the fixture has no message for it`);
  };

  /**
   * A temporary split, its artifact, and the settings that read it.
   *
   * The cases arrive as a function of the directory because several of them carry the engine's own
   * message, which can only be produced by running the statement against the database this fixture
   * is about to write.
   */
  const fixture = (cases: readonly ArtifactCase[] | ((dir: string) => readonly ArtifactCase[])): Fixture => {
    const dir = mkdtempSync(join(tmpdir(), 'refusals-'));
    const data = writeMiniBirdDataset(dir);
    const artifact = join(dir, 'artifact.json');
    const rows = typeof cases === 'function' ? cases(dir) : cases;
    writeFileSync(artifact, JSON.stringify({ split: 'minidev', cases: rows }));
    return { dir, artifact, settings: resolveRefusalSettings(['--artifact', artifact, '--arm', ARM], dir, env(data)) };
  };

  it('counts the populations, classifies each refusal, and keeps the repairs apart from the wrong answers', async () => {
    const misqualified = 'select count(*) from items as T1 inner join orders as T2 on T2.item_id = T1.id where T3.item_id = 1';
    const dateCall = 'select count(*) from items where year(name) = 2020';
    const { settings } = fixture((dir) => [
      { arm: ARM, id: 1, passed: true },
      { arm: ARM, id: 2, passed: false, reason: 'values' },
      { arm: ARM, id: 3, passed: false, reason: 'column-count' },
      { arm: ARM, id: 7, passed: false, errorKind: 'execution', error: messageOf(dir, misqualified), sql: misqualified },
      { arm: ARM, id: 4, passed: false, errorKind: 'execution', error: messageOf(dir, 'select qty from items'), sql: 'select qty from items' },
      { arm: ARM, id: 5, passed: false, errorKind: 'execution', error: messageOf(dir, dateCall), sql: dateCall },
      { arm: ARM, id: 6, passed: false, errorKind: 'execution', error: 'execution: OperationalError: interrupted', sql: 'select 1' },
    ]);
    const census = await runCensus(settings);
    expect(census.asked).toBe(7);
    expect(census.passed).toBe(1);
    expect(census.kinds).toEqual({ values: 1, arity: 1, refused: 4, unanswered: 0 });
    expect(census.problems).toEqual([]);

    // The case whose qualifier was wrong is repaired to the table that owns the column and answers
    // the gold's question, because the model's only defect was where it put the name.
    const repaired = census.rows.find((entry) => entry.id === '7');
    expect(repaired?.refusal).toBe('name-misqualified');
    expect(repaired?.rule).toBe('requalify');
    expect(repaired?.readable).toBe(true);
    expect(repaired?.exact).toBe(true);

    const date = census.rows.find((entry) => entry.id === '5');
    expect(date?.refusal).toBe('date-function');
    expect(date?.readable).toBe(true);
    // It runs and it answers the wrong question, which is the count that keeps a rewrite from being
    // read as a fix.
    expect(date?.exact).toBe(false);

    const notJoined = census.rows.find((entry) => entry.id === '4');
    expect(notJoined?.refusal).toBe('name-not-joined');
    expect(notJoined?.rule).toBeUndefined();
    expect(notJoined?.readable).toBe(false);

    const budget = census.rows.find((entry) => entry.id === '6');
    expect(budget?.refusal).toBe('step-budget');
    expect(budget?.repaired).toBeUndefined();
  });

  it('never edits a statement the engine accepted, which is why the repaired reading cannot fall', async () => {
    // The passing statement is one the engine would refuse: it names a qualifier that is not bound
    // and calls a function that does not exist. A real artifact cannot hold this row, and that is
    // the point — if the `refused` gate were removed the census would classify and rewrite it, so
    // the case fails exactly when the invariant it protects is lost.
    const { settings } = fixture([
      {
        arm: ARM,
        id: 1,
        passed: true,
        errorKind: 'execution',
        error: 'execution: OperationalError: no such column: T3.qty',
        sql: 'select T3.qty from items as T1 join orders as T2 on 1 = 1 where year(name) > 1',
      },
    ]);
    const census = await runCensus(settings);
    expect(census.passed).toBe(1);
    expect(census.kinds).toEqual({ values: 0, arity: 0, refused: 0, unanswered: 0 });
    expect(census.rows).toEqual([]);
  });

  it('reports an arm with no refusal rather than an empty table, which is the shape a guard produces', async () => {
    const { settings } = fixture([{ arm: ARM, id: 1, passed: false, errorKind: 'other' }]);
    const census = await runCensus(settings);
    expect(census.kinds).toEqual({ values: 0, arity: 0, refused: 0, unanswered: 1 });
    expect(census.problems).toEqual(['REF: this artifact holds no refused case, so the taxonomy measured nothing']);
    expect(census.asked).toBe(1);
  });

  it('writes the artifact where the path says, and the entry point prints the same numbers', async () => {
    const misqualified = 'select count(*) from items as T1 inner join orders as T2 on T2.item_id = T1.id where T3.item_id = 1';
    const { artifact, settings } = fixture((dir) => [
      { arm: ARM, id: 7, passed: false, errorKind: 'execution', error: messageOf(dir, misqualified), sql: misqualified },
    ]);
    const census = await runCensus(settings);
    const path = writeRefusalArtifact(settings, census);
    expect(path).toBe(refusalsPath({ root: settings.root, arm: ARM, split: 'minidev' }));
    expect((JSON.parse(readFileSync(path, 'utf8')) as Census).rows[0]?.exact).toBe(true);

    const lines: string[] = [];
    const code = await main(['--artifact', artifact, '--arm', ARM], settings.root, env(settings.layout.data), (line) => lines.push(line));
    expect(code).toBe(0);
    expect(lines[0]).toBe(`refusals \u00b7 ${ARM} \u00b7 minidev`);
    expect(lines.join('\n')).toContain('name-misqualified     1  requalify      1     1      1');
  });

  it('reports a repair that the engine refused again, because one defect can hide another', async () => {
    // `T3.qty` is re-qualifiable and `T4.price` is not: the rewrite changes the first and the engine
    // still refuses the statement, which is a repair that reached nothing rather than a repair that
    // was wrong.
    const twoDefects = 'select T3.qty from items as T1 join orders as T2 on 1 = 1 where T4.price > 1';
    const { dir, settings } = fixture((base) => [
      { arm: ARM, id: 1, passed: false, errorKind: 'execution', error: messageOf(base, twoDefects), sql: twoDefects },
    ]);
    const census = await runCensus(settings);
    expect(census.rows[0]).toMatchObject({ refusal: 'name-misqualified', rule: 'requalify', readable: false, exact: false });
    expect(dir).toBe(settings.root);
  });

  it('drops what it cannot judge, and the arithmetic still closes', async () => {
    const { settings } = fixture([
      // A case for another arm is not this arm's population.
      { arm: 'another-arm', id: 1, passed: false, reason: 'values' },
      // A question the corpus does not carry, a refusal with no statement, and a gold the engine
      // refuses are the three ways a refusal can be unjudgeable, and each is named rather than lost.
      { arm: ARM, id: 99, passed: false, errorKind: 'execution', error: 'execution: OperationalError: no such column: qty', sql: 'select qty from items' },
      { arm: ARM, id: 2, passed: false, errorKind: 'execution', error: 'execution: OperationalError: no such column: qty', sql: '   ' },
      { arm: ARM, id: 3, passed: false, errorKind: 'execution', error: 'execution: OperationalError: no such column: qty', sql: 'select qty from items' },
      // A refusal whose message the artifact dropped: it is classified `other` rather than skipped,
      // because a bucket nothing prints is the defect this file exists to remove.
      { arm: ARM, id: 4, passed: false, errorKind: 'execution', sql: 'select qty from items' },
    ]);
    const questions = JSON.parse(readFileSync(settings.layout.questionsFile, 'utf8')) as { SQL: string }[];
    questions[2] = { ...questions[2], SQL: 'select nosuchcol from items' } as { SQL: string };
    writeFileSync(settings.layout.questionsFile, JSON.stringify(questions));

    const census = await runCensus(settings);
    expect(census.asked).toBe(4);
    expect(census.drops).toEqual({ goldFailed: 1, unretained: 1, unknownQuestion: 1, otherArm: 1 });
    expect(census.kinds).toEqual({ values: 0, arity: 0, refused: 4, unanswered: 0 });
    expect(census.rows).toHaveLength(1);
    expect(census.rows[0]).toMatchObject({ id: '4', refusal: 'other', readable: false });
    // One classified plus three dropped is the artifact's four, so the census may be read.
    expect(census.problems).toEqual([]);
  });

  it('exits non-zero when the census raises a problem about a corpus it did measure, and prints it', async () => {
    const { artifact, settings } = fixture([{ arm: ARM, id: 1, passed: false, errorKind: 'other' }]);
    const lines: string[] = [];
    const code = await main(['--artifact', artifact, '--arm', ARM], settings.root, env(settings.layout.data), (line) => lines.push(line));
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('REF: this artifact holds no refused case');
  });

  it('prints, and does not fail, for an arm the artifact never asked about', async () => {
    // A dev dispatch may leave the shipped arm out; that is a dispatch decision, and a build that
    // went red for it would be a red build about an arm list rather than about the pipeline.
    const { artifact, settings } = fixture([{ arm: 'another-arm', id: 1, passed: true }]);
    const lines: string[] = [];
    const code = await main(['--artifact', artifact, '--arm', ARM], settings.root, env(settings.layout.data), (line) => lines.push(line));
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain(`REF: this artifact holds no case for ${ARM}, so nothing was measured`);
  });

  it('classifies one refusal on its own, for a caller that already has the statement and the gold', async () => {
    const { dir, settings } = fixture([]);
    const oracle = createOracle(settings.layout.oracleScript, settings.layout.databaseRoot);
    try {
      const verdict = await classifyRefusal(
        { id: '7', db: MINI_DB, message: messageOf(dir, 'select qty from items'), sql: 'select qty from items', gold: 'select count(*) from items' },
        { oracle, schema: schema({ items: ['id', 'name', 'price'], orders: ['id', 'item_id', 'qty'] }) },
      );
      expect(verdict).toMatchObject({ refusal: 'name-not-joined', readable: false, exact: false });
      expect(verdict.rule).toBeUndefined();

      // A corpus whose gold the engine refuses has no reading to compare against, and the repair is
      // reported as running without being called right.
      const brokenGold = await classifyRefusal(
        {
          id: '7',
          db: MINI_DB,
          message: messageOf(dir, 'select T3.qty from items as T1 join orders as T2 on 1 = 1'),
          sql: 'select T3.qty from items as T1 join orders as T2 on 1 = 1',
          gold: 'select nosuchcol from items',
        },
        { oracle, schema: schema({ items: ['id', 'name', 'price'], orders: ['id', 'item_id', 'qty'] }) },
      );
      expect(brokenGold).toMatchObject({ refusal: 'name-misqualified', readable: true, exact: false });
    } finally {
      await oracle.close();
    }
  });
});

describe('the entry point', () => {
  it('runs as a program only when it is the program that was started', () => {
    const mine = 'file:///repo/eval/bird/refusals.ts';
    expect(isEntry('/repo/eval/bird/refusals.ts', mine)).toBe(true);
    expect(isEntry('/repo/eval/bird/residue.ts', mine)).toBe(false);
    expect(isEntry(undefined, mine)).toBe(false);
  });

  it('reads every class and every kind from one list, so a new one cannot be added to only one place', () => {
    expect([...REFUSAL_CLASSES].sort()).toEqual(Object.keys(REFUSAL_RULES).sort());
    expect(FAILURE_KINDS).toHaveLength(4);
  });
});

describe('the dev reading this repository publishes', () => {
  it('adds up: every failure in a kind, every refusal in a class, every gain from a repair', () => {
    expect(BASELINE.asked).toBe(1532);
    expect(BASELINE.passed).toBe(1010);
    expect(BASELINE.failed).toBe(BASELINE.asked - BASELINE.passed);
    expect(Object.values(BASELINE.kinds).reduce((sum, count) => sum + count, 0)).toBe(BASELINE.failed);
    expect(BASELINE.kinds.refused).toBe(28);
    // The 76 arity cases are the artifact's first failed check, not a second population: a reader
    // who added them to the 418 would count one defect twice.
    expect(BASELINE.kinds.values + BASELINE.kinds.arity + BASELINE.kinds.refused).toBe(522);
  });

  it('classifies every refusal the artifact holds, and names a rule only where a rule exists', () => {
    const total = (key: 'cases' | 'attempted' | 'readable' | 'exact') => BASELINE.classes.reduce((sum, row) => sum + row[key], 0);
    expect(total('cases')).toBe(BASELINE.kinds.refused);
    expect(total('attempted')).toBe(BASELINE.repair.tried);
    expect(total('readable')).toBe(BASELINE.repair.ran);
    expect(total('exact')).toBe(BASELINE.repair.right);
    for (const row of BASELINE.classes) {
      expect(row.exact).toBeLessThanOrEqual(row.readable);
      expect(row.readable).toBeLessThanOrEqual(row.attempted);
      expect(row.attempted).toBeLessThanOrEqual(row.cases);
      // A class that names a rule names one this file has; a class with no rule says so, because
      // the row is where a reader learns the class was considered and refused.
      expect(row.rule === null || row.rule === REFUSAL_RULES[row.refusal as keyof typeof REFUSAL_RULES]).toBe(true);
      if (row.cases > 0 && row.rule === null) expect(row.attempted).toBe(0);
    }
    // The one class worth more than every rule here added together is the one no rule may touch.
    expect(BASELINE.classes.find((row) => row.refusal === 'name-not-joined')?.cases).toBe(17);
    expect(BASELINE.classes.find((row) => row.refusal === 'name-not-joined')?.rule).toBeNull();
  });

  it('prices the repair against the reading it came from, and the price is small on purpose', () => {
    expect(BASELINE.reading.asWritten).toBe(BASELINE.passed);
    expect(BASELINE.reading.correct).toBe(BASELINE.reading.asWritten + BASELINE.repair.right);
    expect(BASELINE.reading.repairedPct).toBeCloseTo((100 * BASELINE.reading.correct) / BASELINE.asked, 2);
    expect(BASELINE.reading.asWrittenPct).toBeCloseTo((100 * BASELINE.reading.asWritten) / BASELINE.asked, 2);
    // The delta is computed from the counts, not from the two published percentages: 65.93 and
    // 66.12 differ by 0.19 of a point while three statements out of 1,532 is 0.20 — each percentage
    // is rounded to two places on its own, and subtracting two rounded numbers is the mistake this
    // repository already wrote down once.
    expect(BASELINE.repair.deltaPp).toBeCloseTo((100 * BASELINE.repair.right) / BASELINE.asked, 2);
    // Two decimal places of a 0.20pp gain, against 2.13pp for the same exercise on Spider: the
    // difference is the judge, and this is the number that says so.
    expect(BASELINE.repair.deltaPp).toBeLessThan(0.5);
  });

  it('publishes the invariant it is read under: no accepted statement is edited', () => {
    expect(BASELINE.invariant.passing).toBe(BASELINE.passed);
    expect(BASELINE.invariant.changedByTheDateRule).toBe(0);
  });

  it('keeps the second arm\'s zero explained, because a zero is a claim like any other', () => {
    // The selector's guard folds a refusal into "no sample survived", so its refusal count is 0 for
    // a reason that is not the absence of refusals. The census fails that run rather than printing
    // an empty table, and this row is what a reader has instead.
    expect(BASELINE.secondArm.refused).toBe(0);
    expect(BASELINE.secondArm.unanswered).toBe(7);
  });
});
