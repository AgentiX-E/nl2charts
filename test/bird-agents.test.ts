/**
 * The three agents, pinned where they can be wrong.
 *
 * Every claim in `agents.ts` is a claim about *their* source, so each is tested against the
 * sentence it came from: the selector's thresholds including the floor division, the refiner's
 * three conditions in their order, the five-row window on the NULL scan, and the two diagnostics
 * that are one string for every case. The predicates are tested twice — as functions, and by
 * executing real SQLite through the oracle — because a model of a rule that runs on a fixture
 * nobody wrote the rule for is a model of nothing.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AGENT_RULE,
  FABRICATED,
  NULL_WINDOW,
  REFINE_TEMPLATE_CHARS,
  SELECTOR_LIMITS,
  agentsLines,
  agentsPath,
  agentsProblems,
  countsOf,
  damagePoints,
  diagnosticOf,
  isEntry,
  main,
  reachPoints,
  resolveAgentsSettings,
  runAgents,
  selectsSchema,
  shapeOf,
  triggerOf,
  writeAgents,
} from '../eval/bird/agents.js';
import type { AgentTally, ExecutedShape, Population } from '../eval/bird/agents.js';
import { loadTables } from '../eval/bird/data.js';
import { createOracle } from '../eval/bird/oracle.js';
import { writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();

const shape = (parts: Partial<ExecutedShape>): ExecutedShape => ({
  error: null,
  rows: 1,
  nullInWindow: false,
  ...parts,
});

const population = (total: number, byTrigger: Population['byTrigger'], fired: readonly string[] = []): Population => ({
  total,
  byTrigger,
  fired,
});

const tally = (parts: Partial<AgentTally>): AgentTally => ({
  cases: 100,
  failures: { total: 40, byTrigger: { error: 0, empty: 0, null: 0, none: 40 }, reasons: { error: {}, empty: {}, null: {}, none: {} }, fired: [] },
  gold: population(100, { error: 0, empty: 0, null: 0, none: 100 }),
  reachable: 0,
  invisible: 40,
  specific: 0,
  constant: 0,
  ...parts,
});

describe('the rule this file was written from', () => {
  it('names the pin, so a predicate cannot drift from the source it models', () => {
    expect(AGENT_RULE).toBe('mac-sql@31a9df5e');
    // Two constants that are theirs and not ours: the window `_execute_sql` returns and the
    // characters of `refiner_template` that are not placeholders.
    expect(NULL_WINDOW).toBe(5);
    expect(REFINE_TEMPLATE_CHARS).toBe(1_046);
    expect(SELECTOR_LIMITS).toEqual({ average: 6, total: 30 });
  });
});

describe("the selector's condition", () => {
  it('does not run on a database that is already small', () => {
    // Both thresholds exactly met and nothing beyond them.
    expect(selectsSchema({ columns: 30, tables: 5 })).toBe(false);
  });

  it('runs as soon as either threshold is passed', () => {
    expect(selectsSchema({ columns: 31, tables: 5 })).toBe(true);
    expect(selectsSchema({ columns: 30, tables: 4 })).toBe(true);
  });

  it('compares the floor of the mean, because the source divides with `//`', () => {
    // Thirteen columns over two tables is 6.5 a table: over the threshold under a real mean, and
    // 6 under theirs. A model of the rule that averaged in floating point would report a selector
    // call on this database that never happens — and the total has to stay under 30 for the
    // average to be the deciding term at all, which is why the case is shaped this way.
    expect(selectsSchema({ columns: 13, tables: 2 })).toBe(false);
    expect(selectsSchema({ columns: 14, tables: 2 })).toBe(true);
    // Where the total dominates, the average cannot rescue it: 41 columns is over 30 whatever the
    // tables are.
    expect(selectsSchema({ columns: 41, tables: 7 })).toBe(true);
  });

  it('has nothing to select in an empty database', () => {
    // Their `//` would raise here; a database with no tables has no schedule to compress.
    expect(selectsSchema({ columns: 0, tables: 0 })).toBe(false);
  });

  it('counts columns the way the manifest does, skipping the `*` row', () => {
    const table = loadTables(join(fixture(), 'dev_tables.json')).get('shop');
    expect(table).toBeDefined();
    expect(countsOf(table as never)).toEqual({ columns: 6, tables: 2 });
  });
});

describe("the refiner's condition", () => {
  it('fires on an error first, because nothing else can be said about a statement that did not run', () => {
    expect(triggerOf(shape({ error: 'no such column: nope', rows: 0, nullInWindow: true }))).toBe('error');
  });

  it('fires on a statement that ran and returned nothing', () => {
    expect(triggerOf(shape({ rows: 0 }))).toBe('empty');
  });

  it('fires on a NULL in the first five rows', () => {
    expect(triggerOf(shape({ rows: 5, nullInWindow: true }))).toBe('null');
  });

  it('does not fire on a NULL nobody sees, because the window is five rows', () => {
    // `_is_need_refine` scans `result[:5]`; a NULL in the sixth row is invisible to it. The
    // shape here is what the oracle reports for six rows, so the window is the only thing that
    // decides — a model that scanned every row would report fires that never happen.
    const result = { ok: true, columns: ['a'], rows: [[1], [2], [3], [4], [5], [null]], ms: 1 };
    expect(shapeOf(result).nullInWindow).toBe(false);
    expect(triggerOf(shapeOf(result))).toBe('none');
    const five = { ok: true, columns: ['a'], rows: [[1], [2], [3], [4], [null]], ms: 1 };
    expect(shapeOf(five).nullInWindow).toBe(true);
    expect(triggerOf(shapeOf(five))).toBe('null');
  });

  it('reads a refusal without a message as a refusal', () => {
    expect(shapeOf({ ok: false, columns: [], rows: [], ms: 1 }).error).toBe('the engine refused it without a message');
    expect(shapeOf({ ok: false, columns: [], rows: [], error: 'no such table: x', ms: 1 }).error).toBe('no such table: x');
  });

  it("sends the engine's words for an error and one constant otherwise", () => {
    expect(diagnosticOf('error', 'no such column: nope')).toEqual({ text: 'no such column: nope', specific: true });
    // An error whose text was dropped is still the specific trigger: what it says is unknown, but
    // it is the only one of the three that says anything about the case at all.
    expect(diagnosticOf('error', null)).toEqual({ text: '', specific: true });
    // The empty turn's message is theirs, and it is the same sentence whoever asked.
    expect(diagnosticOf('empty', null)).toEqual({ text: 'no data selected', specific: false });
    // The NULL turn's message is theirs too, and it is not merely contentless: it instructs the
    // model to remove rows from a result that was not wrong.
    expect(diagnosticOf('null', null)).toEqual({
      text: 'exist None value, you can add `NOT NULL` in SQL',
      specific: false,
    });
    expect(FABRICATED.null).toContain('NOT NULL');
  });
});

describe('the ceiling and the floor', () => {
  it('reads the ceiling as reachable failures over the questions scored', () => {
    expect(reachPoints(tally({ cases: 496, reachable: 54 }))).toBeCloseTo(10.89, 2);
    expect(reachPoints(tally({ cases: 0, reachable: 0 }))).toBe(0);
  });

  it('reads the damage floor over gold, and only over the two fabricated triggers', () => {
    const gold = population(496, { error: 0, empty: 0, null: 9, none: 487 });
    expect(damagePoints(tally({ gold }))).toBeCloseTo(1.81, 2);
    // No gold result is empty on BIRD, so the empty trigger cannot damage — which is the whole
    // reason `inline+evidence+empty` is a safe arm and the NULL trigger is not.
    expect(damagePoints(tally({ gold: population(10, { error: 0, empty: 2, null: 0, none: 8 }) }))).toBe(20);
    expect(damagePoints(tally({ gold: population(0, { error: 0, empty: 0, null: 0, none: 0 }) }))).toBe(0);
  });

  it('refuses to publish a count that measured nothing', () => {
    const drops = { unknownArm: 0, unknownQuestion: 0, noStatement: 0, unreadable: 0 };
    expect(agentsProblems({ tally: tally({}), drops, arm: 'a', truncated: [] })).toEqual([]);
    // An arm the artifact does not carry: no agent was counted, and a report of zeros would read
    // as a measurement.
    expect(agentsProblems({ tally: tally({}), drops: { ...drops, unknownArm: 1 }, arm: 'a', truncated: [] })).toHaveLength(1);
    // A truncated failure list turns the ceiling into a floor on the ceiling, which is a
    // different claim and has to be labelled.
    expect(agentsProblems({ tally: tally({}), drops, arm: 'a', truncated: ['a'] }).join('|')).toContain('truncated');
    // No statement at all, and no unknown arm to explain it: the instrument ran and read nothing.
    const empty = tally({ failures: { total: 0, byTrigger: { error: 0, empty: 0, null: 0, none: 0 }, reasons: { error: {}, empty: {}, null: {}, none: {} }, fired: [] } });
    expect(agentsProblems({ tally: empty, drops, arm: 'a', truncated: [] })).toHaveLength(1);
    // A gold population with no rows leaves the floor without a denominator.
    expect(
      agentsProblems({ tally: tally({ gold: population(0, { error: 0, empty: 0, null: 0, none: 0 }) }), drops, arm: 'a', truncated: [] }),
    ).toHaveLength(1);
  });
});

/** A dataset on disk, reused by the end-to-end cases. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agents-data-'));
  writeMiniBirdDataset(dir);
  return dir;
}

/**
 * One case per condition, on the mini fixture's own tables.
 *
 * `count(*)` cannot produce an empty result, so the empty case projects a column that matches
 * nothing; the NULL case uses `nullif`, which is the shape that made the BIRD gold statements
 * fire in the first place.
 */
const STATEMENTS: Readonly<Record<string, string>> = {
  empty: "select name from items where name = 'zebra'",
  null: "select nullif(name, 'pen') from items",
  error: 'select nope from items',
  none: 'select name from items',
};

const body = (arm: string, ids: readonly number[], passed: readonly number[]): unknown => ({
  split: 'minidev',
  // `reason` is read from the case record, which is the census: the failure list repeats it, and
  // reading the copy would make one of the two authoritative by accident.
  cases: ids.map((id) => ({ arm, id: String(id), passed: passed.includes(id), reason: id === 5 ? 'column-count' : 'values' })),
  failures: {
    [arm]: [
      { id: '2', predicted: STATEMENTS.empty, reason: 'values' },
      { id: '3', predicted: STATEMENTS.null, reason: 'values' },
      { id: '4', predicted: STATEMENTS.error, reason: 'values' },
      { id: '5', predicted: STATEMENTS.none, reason: 'column-count' },
    ],
  },
  failureSample: { cap: 2_000, total: { [arm]: 5 }, truncated: [] },
  controls: { synthesizedDefinitions: { shop: 'items.name: the label the store sells under.' } },
});

const settingsFor = (data: string, report: unknown, extra: readonly string[] = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-report-'));
  const path = join(dir, 'bird-eval.json');
  writeFileSync(path, JSON.stringify(report));
  return resolveAgentsSettings(
    { BIRD_SPLIT: 'minidev', BIRD_DATA: data, BIRD_OUT: join(dir, 'out.json') },
    [path, '--arm', 'inline+evidence', ...extra],
    ROOT,
  );
};

describe('one corpus, read through the oracle', () => {
  const data = fixture();
  const oracle = createOracle(resolve('eval/bird/oracle.py'), join(data, 'dev_databases'));
  afterAll(async () => {
    await oracle.close();
  });

  it('counts each condition once, and the cases that fire nothing apart', async () => {
    // Seven questions: 1 and 7 passed (no statement retained), 2..5 fail with one condition
    // each, and 6 fails with no statement at all.
    const settings = settingsFor(data, body('inline+evidence', [1, 2, 3, 4, 5, 6, 7], [1, 7]));
    const outcome = await runAgents(settings, oracle);
    expect(outcome.problems).toEqual([]);
    expect(outcome.tally.cases).toBe(7);
    expect(outcome.tally.failures.byTrigger).toEqual({ error: 1, empty: 1, null: 1, none: 1 });
    expect(outcome.tally.failures.total).toBe(4);
    expect(outcome.tally.failures.fired).toHaveLength(3);
    expect(outcome.tally.reachable).toBe(3);
    expect(outcome.tally.invisible).toBe(1);
    expect(outcome.tally.specific).toBe(1);
    expect(outcome.tally.constant).toBe(2);
    // The failure that was not retained cannot be classified, and it says so rather than
    // counting as invisible.
    expect(outcome.drops.noStatement).toBe(1);
    // The fixture's gold statements all return rows without NULLs.
    expect(outcome.tally.gold.byTrigger).toEqual({ error: 0, empty: 0, null: 0, none: 7 });
    expect(damagePoints(outcome.tally)).toBe(0);
  });

  it('labels the failure reason next to the condition that fired', async () => {
    const outcome = await runAgents(settingsFor(data, body('inline+evidence', [1, 2, 3, 4, 5], [1])), oracle);
    // A failure that cannot be seen and a failure that can are different work items, and the
    // reason they failed is a third axis: 4 of the 5 statements ran clean.
    expect(outcome.tally.failures.reasons.none).toEqual({ 'column-count': 1 });
    expect(outcome.tally.failures.reasons.empty).toEqual({ values: 1 });
  });

  it('prices a fire at the card plus the statement plus their template', async () => {
    const outcome = await runAgents(settingsFor(data, body('inline+evidence', [1, 2, 3, 4, 5], [1])), oracle);
    expect(outcome.cost.extraCallsPerCase).toBeCloseTo(3 / 5, 6);
    // A refine call re-sends the card, so it cannot be cheaper than a generation call. The
    // threshold is their constant alone: any fire costs at least the template that carries it.
    expect(outcome.cost.charsPerCall).toBeGreaterThan(REFINE_TEMPLATE_CHARS);
    expect(outcome.cost.charsPerCase).toBeCloseTo(outcome.cost.charsPerCall * (3 / 5), 6);
  });

  it('reports the selector as not firing on a database that is already small', async () => {
    const outcome = await runAgents(settingsFor(data, body('inline+evidence', [1, 2, 3, 4, 5], [1])), oracle);
    // Six columns over two tables: their `_is_need_prune` returns false and the whole card is
    // sent. On Mini-Dev it fires on 9 of 11 databases, which is why this counter exists.
    expect(outcome.selector).toEqual({ databases: 1, selecting: 0, questions: 5, selected: 0 });
  });

  it('reports the selector as firing when the manifest is wide enough', async () => {
    const wide = fixture();
    const manifest = join(wide, 'dev_tables.json');
    const tables = JSON.parse(readFileSync(manifest, 'utf8')) as {
      column_names: [number, string][];
      column_names_original: [number, string][];
      column_types: string[];
    }[];
    // Thirty columns over two tables is 15 a table: over their threshold, so the selector would
    // run and the card would be compressed to six columns a table. The columns are manifest-only
    // because what decides the predicate is the manifest's own count.
    const entry = tables[0] as (typeof tables)[number];
    for (let index = 0; index < 30; index += 1) {
      entry.column_names.push([0, `extra_${String(index)}`]);
      entry.column_names_original.push([0, `extra_${String(index)}`]);
      entry.column_types.push('text');
    }
    writeFileSync(manifest, JSON.stringify(tables));
    const outcome = await runAgents(settingsFor(wide, body('inline+evidence', [1, 2, 3, 4, 5], [1])), oracle);
    expect(outcome.selector).toEqual({ databases: 1, selecting: 1, questions: 5, selected: 5 });
  });

  it('counts a gold result that fires, which is a correct answer asking to be rewritten', async () => {
    const nullish = fixture();
    const file = join(nullish, 'mini_dev_sqlite.json');
    const questions = JSON.parse(readFileSync(file, 'utf8')) as { question_id: number; SQL: string }[];
    // The shape the real corpus produced nine times: a correct answer whose first five rows hold
    // a NULL because the question asks for a conditional, not because anything is wrong.
    const target = questions.find((entry) => entry.question_id === 3);
    (target as { SQL: string }).SQL = "select nullif(name, 'pen') from items";
    writeFileSync(file, JSON.stringify(questions));
    const outcome = await runAgents(settingsFor(nullish, body('inline+evidence', [1, 2, 3, 4, 5], [1])), oracle);
    expect(outcome.tally.gold.byTrigger.null).toBe(1);
    expect(outcome.tally.gold.fired).toEqual(['3']);
    expect(damagePoints(outcome.tally)).toBeCloseTo(20, 6);
  });

  it('counts a gold statement the engine refuses apart from a trigger', async () => {
    const broken = fixture();
    const file = join(broken, 'mini_dev_sqlite.json');
    const questions = JSON.parse(readFileSync(file, 'utf8')) as { question_id: number; SQL: string }[];
    // A gold statement that does not run is a corpus fact, not a fire: counting it as one would
    // inflate the damage floor with cases where no answer exists at all.
    const target = questions.find((entry) => entry.question_id === 7);
    expect(target).toBeDefined();
    (target as { SQL: string }).SQL = 'select nope from items';
    writeFileSync(file, JSON.stringify(questions));
    const outcome = await runAgents(settingsFor(broken, body('inline+evidence', [1, 2, 7], [1])), oracle);
    expect(outcome.drops.unreadable).toBe(1);
    expect(outcome.tally.gold.total).toBe(2);
    expect(outcome.tally.gold.byTrigger.error).toBe(0);
  });

  it('reads a partial artifact for what it says, and names the case it could not place', async () => {
    const ghost = fixture();
    const file = join(ghost, 'mini_dev_sqlite.json');
    const questions = JSON.parse(readFileSync(file, 'utf8')) as unknown as Record<string, unknown>[];
    // A question whose database is not in the manifest, which is what a split shipped without one
    // of its databases looks like. The case is counted rather than skipped in silence.
    questions.push({ question_id: 99, db_id: 'ghost', question: 'How many?', evidence: '', SQL: 'select 1', difficulty: 'simple' });
    writeFileSync(file, JSON.stringify(questions));
    const outcome = await runAgents(
      settingsFor(ghost, {
        // No `split`, no `controls`, no `failureSample`: a report from a runner that predates
        // them must measure, not crash, and the defaults have to be the layout's own.
        cases: [
          { arm: 'inline+evidence', id: '2', passed: false },
          { arm: 'inline+evidence', id: '99', passed: false },
        ],
        failures: { 'inline+evidence': [{ id: '2', predicted: STATEMENTS.empty }] },
      }),
      oracle,
    );
    expect(outcome.split).toBe('minidev');
    expect(outcome.drops.unknownQuestion).toBe(1);
    // A case that failed without a reason is a failure with no classification, not a pass.
    expect(outcome.tally.failures.reasons.empty).toEqual({ unknown: 1 });
    expect(outcome.tally.gold.total).toBe(1);
    expect(outcome.problems).toEqual([]);
  });

  it('writes a report whose name carries the arm, and prints it', async () => {
    const settings = settingsFor(data, body('inline+evidence', [1, 2, 3, 4, 5], [1]));
    const outcome = await runAgents(settings, oracle);
    const path = writeAgents(settings, outcome);
    expect(path).toBe(agentsPath(settings));
    expect(path.endsWith('agents-inline+evidence.json')).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(JSON.stringify(outcome)));
    const lines = agentsLines(outcome).join('\n');
    expect(lines).toContain('selector: fires on 0 of 1 databases');
    expect(lines).toContain('reach: 3 case(s) fire');
    expect(lines).toContain('invisible: 1 failure(s) fire nothing');
    expect(lines).toContain('damage floor: 0.00pp');
  });

  it('counts nothing, and says so, for an arm the artifact does not carry', async () => {
    const settings = settingsFor(data, body('names', [1, 2], [1]));
    const outcome = await runAgents(settings, oracle);
    expect(outcome.tally.cases).toBe(0);
    expect(outcome.problems).toHaveLength(1);
    expect(outcome.cost).toEqual({ firesPerCase: 0, extraCallsPerCase: 0, charsPerCall: 0, charsPerCase: 0 });
    expect(reachPoints(outcome.tally)).toBe(0);
    // A report with no case list at all: the same absence, one layer further back.
    const absent = await runAgents(settingsFor(data, {}), oracle);
    expect(absent.tally.cases).toBe(0);
    expect(absent.split).toBe('minidev');
    expect(absent.problems).toHaveLength(1);
  });

  it('runs as a tool, and fails only when asked to be strict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-cli-'));
    const path = join(dir, 'bird-eval.json');
    writeFileSync(path, JSON.stringify(body('inline+evidence', [1, 2, 3, 4, 5], [1])));
    const env = { BIRD_SPLIT: 'minidev', BIRD_DATA: data, BIRD_OUT: join(dir, 'out.json') };
    expect(await main([path, '--arm', 'inline+evidence'], ROOT, env)).toBe(0);
    const unknown = join(dir, 'unknown.json');
    writeFileSync(unknown, JSON.stringify(body('names', [1], [1])));
    expect(await main([unknown, '--arm', 'inline+evidence'], ROOT, env)).toBe(0);
    expect(await main([unknown, '--arm', 'inline+evidence', '--strict'], ROOT, env)).toBe(1);
  });
});

describe('the settings', () => {
  it('defaults the arm and refuses the ways a report can be unnamed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-settings-'));
    const path = join(dir, 'bird-eval.json');
    writeFileSync(path, JSON.stringify({}));
    expect(resolveAgentsSettings({ BIRD_OUT: join(dir, 'o.json') }, [path], ROOT).arm).toBe('inline+evidence');
    expect(() => resolveAgentsSettings({}, [path, '--arm', 'not-an-arm'], ROOT)).toThrow('unknown arm');
    expect(() => resolveAgentsSettings({}, ['report.json', '--arm'], ROOT)).toThrow('--arm needs a name');
    expect(() => resolveAgentsSettings({}, ['--strict'], ROOT)).toThrow('usage: agents.ts');
    // A flag's value is not the report: `--arm inline+evidence` must not be read as a path.
    const settings = resolveAgentsSettings({}, [path, '--strict', '--arm', 'select'], ROOT);
    expect(settings.arm).toBe('select');
    expect(settings.report).toBe(path);
    expect(settings.strict).toBe(true);
  });

  it('knows the module it was started as', async () => {
    const module_ = { pathname: resolve('eval/bird/agents.ts'), href: pathToFileURL(resolve('eval/bird/agents.ts')).href };
    expect(isEntry(module_.pathname, module_.href)).toBe(true);
    expect(isEntry(undefined, 'file:///x')).toBe(false);
  });
});
