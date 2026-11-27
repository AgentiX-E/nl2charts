/**
 * The reach instrument, pinned where it can be wrong without crashing.
 *
 * Reach answers one question — was the gold's table on the card — and it can be wrong in four ways
 * that all produce a plausible number:
 *
 * 1. **The card is read as the schema.** A reading built from the schema's own table list reports
 *    every table present at every width, which is the number this instrument exists to replace. So
 *    the parsing cases use text, not schemas, and one of them asserts that a cut card is short.
 * 2. **A name the statement defines is counted as a table.** BIRD's dev gold defines CTEs; counting
 *    one makes the case permanently short and blames the card for a name no card can print.
 * 3. **A column the statement does arithmetic on is counted as hidden.** `T4.min_time_in_seconds`
 *    resolves to `pitstops` because the gold reuses `T4` in two scopes; no width brings that column
 *    back, so it is counted apart rather than against the card.
 * 4. **The gate is compared with the wrong subject.** The artifact's control is a statement about
 *    the width the run was measured at, so a reading at another width must not be checked against
 *    it — and a reading at that width that hides a table, while the control claims nothing was
 *    truncated, is the disagreement that hid this repository's card-budget defect for months.
 *
 * The bookkeeping cases build a report by hand and then mutate one count, because a gate that cannot
 * be made to fire is a gate nobody has tested. Nothing here calls a model or a database.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BIRD_SCHEMA_LINES } from '../eval/bird/prompt-shape.js';
import { CHAIN_QUESTIONS, MINI_DB, writeChainBirdDataset } from './helpers/bird-dataset.js';
import {
  goldRefs,
  percent,
  reachLines,
  reachPath,
  reachProblems,
  reachSentence,
  readCard,
  isEntry,
  main,
  readReachControl,
  readReachQuestions,
  resolveReachSettings,
  runReach,
  startIfEntry,
  tallyReading,
  tallyReach,
  writeReachArtifact,
} from '../eval/bird/reach.js';
import type { CardShape, ReachBudget, ReachQuestion, ReachReading, ReachReport } from '../eval/bird/reach.js';
import { resolveLayout } from '../eval/bird/run.js';
import { SHIPPED_SQL, resolvePrompt, resolveShipment } from '../packages/ai/src/index.js';

/** A card as the template prints it: a header per table, then one line per column. */
function card(spec: Record<string, readonly string[]>): string {
  return Object.entries(spec)
    .map(([table, columns]) => [`# Table: ${table}`, '[', ...columns.map((column) => `  (${column}, BIGINT. prose.),`), ']'].join('\n'))
    .join('\n');
}

function schemas(spec: Record<string, Record<string, readonly string[]>>): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  for (const [db, tables] of Object.entries(spec)) {
    out.set(
      db,
      new Map(Object.entries(tables).map(([table, columns]) => [table.toLowerCase(), new Set(columns.map((column) => column.toLowerCase()))])),
    );
  }
  return out;
}

function budget(lines: number, cards: Record<string, string>, known?: ReturnType<typeof schemas>): ReachBudget {
  const rendered = new Map<string, CardShape>();
  for (const [db, text] of Object.entries(cards)) rendered.set(db, readCard(text));
  return { lines, cards: rendered, schemas: known ?? schemas({}) };
}

function reading(over: Partial<ReachReading> = {}): ReachReading {
  return {
    lines: 400,
    questions: 10,
    tables: 3,
    columns: 12,
    hiddenTables: 0,
    questionsHiding: 0,
    hiddenColumns: 0,
    questionsHidingColumn: 0,
    unmodelledColumns: 0,
    ownNames: 0,
    ...over,
  };
}

function report(over: Partial<Omit<ReachReport, 'problems'>> = {}): Omit<ReachReport, 'problems'> {
  return {
    split: 'dev',
    arm: 'macsql-prompt',
    readings: [reading()],
    schemaTables: 3,
    schemaColumns: 12,
    control: { schemaLines: 400, tablesInPrompts: 3, tablesTotal: 3, truncated: false },
    source: { path: 'eval/out/bird-eval.json', generatedAt: '2026-01-01T00:00:00Z' },
    ...over,
  };
}

describe('reading a rendered card back', () => {
  it('names the tables and columns the card prints', () => {
    const shape = readCard(card({ orders: ['id', 'total'], items: ['sku'] }));
    expect([...shape.tables.keys()]).toEqual(['orders', 'items']);
    expect([...shape.tables.get('orders')!]).toEqual(['id', 'total']);
    expect(shape.tables.get('items')!.has('sku')).toBe(true);
  });

  it('reports a table the width cut as absent rather than as empty', () => {
    // The property the instrument exists for: a card built from the schema would answer `orders`,
    // `items` and `stock` here. The rendered text answers what arrived.
    const shape = readCard(card({ orders: ['id'] }));
    expect(shape.tables.has('stock')).toBe(false);
    expect(shape.tables.size).toBe(1);
  });

  it('folds case, because the schema spells `PostHistory` and the card may not', () => {
    const shape = readCard(card({ PostHistory: ['Id'] }));
    expect([...shape.tables.keys()]).toEqual(['posthistory']);
    expect(shape.tables.get('posthistory')!.has('id')).toBe(true);
  });

  it('reads an empty card as no tables rather than throwing', () => {
    expect(readCard('').tables.size).toBe(0);
    expect(readCard('no table here').tables.size).toBe(0);
  });

  it('keeps a column line before any header out of the card', () => {
    // A parser that attributed a stray `(x, ...)` line to whatever it saw last would invent a column
    // on the previous table, which reads as a card that is more complete than it is.
    const shape = readCard(['  (orphan, BIGINT. prose.),', '# Table: orders', '  (id, BIGINT. prose.),'].join('\n'));
    expect(shape.tables.size).toBe(1);
    expect([...shape.tables.get('orders')!]).toEqual(['id']);
  });
});

describe('what a gold statement reads', () => {
  it('resolves an alias to the table it names', () => {
    const refs = goldRefs('select t1.id from orders as t1 where t1.total > 1');
    expect(refs.tables).toEqual(['orders']);
    // Both references, in the order the statement writes them: the select list names one and the
    // filter names the other, and a reading that reported only the filter would miss the column the
    // answer is projected from.
    expect(refs.columns).toEqual([
      { table: 'orders', column: 'id' },
      { table: 'orders', column: 'total' },
    ]);
  });

  it('drops a name the statement defines, and counts it', () => {
    // A CTE is not a table: counting one would make every such case permanently short of the card.
    const refs = goldRefs('with fastest as (select id from results) select fastest.id from fastest');
    expect(refs.tables).toEqual(['results']);
    expect(refs.ownNames).toBe(1);
  });

  it('counts one table once however many times the statement joins it', () => {
    const refs = goldRefs('select t1.id from orders t1 join orders t2 on t1.id = t2.id');
    expect(refs.tables).toEqual(['orders']);
  });

  it('leaves a bare identifier unattributed', () => {
    // `id` may belong to any of the joined tables; guessing would put a column on a card that cannot
    // express the statement, and the ceiling it is used as would then be a ceiling over nothing.
    const refs = goldRefs('select id from orders');
    expect(refs.columns).toEqual([]);
  });
});

describe('what one width hid', () => {
  const questions: ReachQuestion[] = [
    { id: '1', db: 'shop', gold: 'select t1.id from orders t1 join items t2 on t1.id = t2.id' },
    { id: '2', db: 'shop', gold: 'select t1.id from stock t1' },
  ];
  const known = schemas({ shop: { orders: ['id', 'total'], items: ['id'], stock: ['id'] } });

  it('counts a pair per question and a question once', () => {
    const cut = budget(40, { shop: card({ orders: ['id', 'total'] }) }, known);
    const readingOf = tallyReading(cut, questions);
    // Question 1 hides `items`, question 2 hides `stock`: two pairs, two questions.
    expect(readingOf.hiddenTables).toBe(2);
    expect(readingOf.questionsHiding).toBe(2);
    expect(readingOf.tables).toBe(1);
  });

  it('does not double-count a hidden table’s columns as hidden columns', () => {
    // The column of a table that never arrived is part of the same loss; counting it twice makes the
    // report read as if two things went wrong.
    const cut = budget(40, { shop: card({ orders: ['id'] }) }, known);
    const widened: ReachQuestion[] = [
      { id: '1', db: 'shop', gold: 'select t1.total from orders t1 join items t2 on t1.id = t2.id' },
      { id: '2', db: 'shop', gold: 'select t1.id from stock t1' },
    ];
    const readingOf = tallyReading(cut, widened);
    expect(readingOf.hiddenTables).toBe(2);
    // `orders.total` was cut from a table that did arrive, and `items` never arrived at all — one
    // column, because the columns of the missing table belong to the missing table's own count.
    expect(readingOf.hiddenColumns).toBe(1);
    expect(readingOf.questionsHidingColumn).toBe(1);
    expect(tallyReading(cut, questions).hiddenColumns).toBe(0);
  });

  it('counts a column the schema never had apart from a column the width cut', () => {
    const odd: ReachQuestion[] = [{ id: '3', db: 'shop', gold: 'select t1.total from orders t1 where t1.nowhere > 1' }];
    const full = budget(400, { shop: card({ orders: ['id'] }) }, known);
    const readingOf = tallyReading(full, odd);
    expect(readingOf.hiddenColumns).toBe(1);
    expect(readingOf.unmodelledColumns).toBe(1);
  });

  it('reads a width that prints every table as hiding nothing', () => {
    const full = budget(400, { shop: card({ orders: ['id', 'total'], items: ['id'], stock: ['id'] }) }, known);
    const readingOf = tallyReading(full, questions);
    expect(readingOf.hiddenTables).toBe(0);
    expect(readingOf.hiddenColumns).toBe(0);
    expect(readingOf.tables).toBe(3);
  });
});

describe('the arithmetic a reach report has to satisfy', () => {
  it('accepts a report whose control and reading agree', () => {
    expect(reachProblems(report())).toEqual([]);
  });

  it('refuses a reading with no question to read', () => {
    const problems = reachProblems(report({ readings: [reading({ questions: 0 })] }));
    expect(problems.join(' ')).toContain('has no question to read');
  });

  it('refuses a card that prints more tables than the schemas hold', () => {
    const problems = reachProblems(report({ readings: [reading({ tables: 4 })] }));
    expect(problems.join(' ')).toContain('more than the 3 the schemas hold');
  });

  it('refuses a card that prints more columns than the schemas hold', () => {
    const problems = reachProblems(report({ readings: [reading({ columns: 13 })] }));
    expect(problems.join(' ')).toContain('more than the 12 the schemas hold');
  });

  it('refuses more hidden questions than questions', () => {
    const problems = reachProblems(report({ readings: [reading({ hiddenTables: 12, questionsHiding: 11, questions: 10 })] }));
    expect(problems.join(' ')).toContain('questions hide a table of 10 asked');
  });

  it('refuses hidden pairs that no question accounts for', () => {
    const problems = reachProblems(report({ readings: [reading({ hiddenTables: 1, questionsHiding: 0 })] }));
    expect(problems.join(' ')).toContain('which cannot both be zero or both not');
  });

  it('refuses a wider card that hides more than a narrower one', () => {
    const problems = reachProblems(
      report({
        readings: [reading({ lines: 40, hiddenTables: 1, questionsHiding: 1 }), reading({ lines: 400, hiddenTables: 2, questionsHiding: 1 })],
      }),
    );
    expect(problems.join(' ')).toContain('a wider card cannot hide more');
  });

  it('refuses more questions hiding a column than questions', () => {
    const problems = reachProblems(report({ readings: [reading({ questionsHidingColumn: 11 })] }));
    expect(problems.join(' ')).toContain('questions hide a column of 10 asked');
  });

  it('refuses a wider card that hides more columns', () => {
    // The column check is separate from the table check because a width can cut a table in half and
    // still print its header: the two monotonicities fail independently.
    const problems = reachProblems(
      report({
        readings: [reading({ lines: 40, hiddenColumns: 1, questionsHidingColumn: 1 }), reading({ lines: 400, hiddenColumns: 2, questionsHidingColumn: 1 })],
      }),
    );
    expect(problems.join(' ')).toContain('2 columns and 40 lines hide 1');
  });

  it('refuses a control width no reading was taken at', () => {
    const problems = reachProblems(report({ control: { schemaLines: 200, truncated: false } }));
    expect(problems.join(' ')).toContain('the gate has nothing to compare');
  });

  it('refuses a control that claims completeness while the reading hides a table', () => {
    // The gate that would have caught this repository's card-budget defect: the artifact said 75 of
    // 75 tables arrived, at a width where 22 of them cannot.
    const problems = reachProblems(report({ readings: [reading({ hiddenTables: 3, questionsHiding: 2 })], control: { schemaLines: 400, tablesInPrompts: 75, tablesTotal: 75, truncated: false } }));
    expect(problems.join(' ')).toContain('the control and the card disagree');
  });

  it('does not compare a truncated control with a reading at its width', () => {
    // A run that admits truncation is not claiming the card was complete, so a hidden table there is
    // the truncation doing its job rather than a disagreement.
    const clean = report({ readings: [reading({ hiddenTables: 3, questionsHiding: 2 })], control: { schemaLines: 400, tablesInPrompts: 60, tablesTotal: 75, truncated: true } });
    expect(reachProblems(clean)).toEqual([]);
  });

  it('does not compare an unstated width with any reading', () => {
    const clean = report({ readings: [reading({ hiddenTables: 3, questionsHiding: 2 })], control: { truncated: false } });
    expect(reachProblems(clean)).toEqual([]);
  });
});

describe('printing a reach report', () => {
  const twoWidths = report({
    readings: [reading({ lines: 40, tables: 2, columns: 6, hiddenTables: 5, questionsHiding: 4, hiddenColumns: 2, questionsHidingColumn: 3, questions: 10 }), reading()],
  });

  it('prints one line per width with its shares', () => {
    const lines = reachLines({ ...twoWidths, problems: [] });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('2 of 3 tables');
    expect(lines[0]).toContain('hides 5 gold table(s) over 4 of 10 question(s) (40.00%)');
    expect(lines[1]).toContain('hides 0 gold table(s) over 0 of 10 question(s) (0.00%)');
  });

  it('names a column no schema holds only when there is one', () => {
    const withOdd = reachLines({ ...twoWidths, problems: [], readings: [reading({ unmodelledColumns: 2 })] });
    expect(withOdd[0]).toContain('2 column(s) no schema holds');
    expect(reachLines({ ...twoWidths, problems: [] })[0]).not.toContain('no schema holds');
  });

  it('says what a clean width means, and what it does not', () => {
    const sentence = reachSentence({ ...twoWidths, problems: [] });
    expect(sentence).toContain('hid no table a gold statement reads');
    expect(sentence).toContain('a decision, not a retrieval');
    expect(sentence).toContain('nothing here was executed');
  });

  it('says a hidden table cannot be joined when one is hidden', () => {
    const hidden = reachSentence({ ...twoWidths, problems: [], readings: [reading({ hiddenTables: 4, questionsHiding: 2 })] });
    expect(hidden).toContain('hid 4 gold table(s)');
    expect(hidden).toContain('cannot be joined');
  });

  it('reports an empty report as no widths read', () => {
    expect(reachSentence({ ...twoWidths, problems: [], readings: [] })).toBe('no width was read');
  });

  it('prints an undefined share rather than dividing by zero', () => {
    // `NaN%` in a report is read as a rendering bug and hides the real one: a population of zero.
    expect(percent(1, 0)).toBe('n/a');
    expect(percent(1, 4)).toBe('25.00%');
  });
});

describe('the artifact, read for what it says about its own card', () => {
  const artifact = {
    split: 'dev',
    generatedAt: '2026-01-01T00:00:00Z',
    controls: { schemaLines: 400, tablesInPrompts: 75, tablesTotal: 75, truncatedPrompts: [] },
    cases: [
      { arm: 'macsql-prompt', id: 1, gold: 'select 1 from a', asked: { db: 'shop' } },
      { arm: 'other', id: 2, gold: 'select 1 from a', asked: { db: 'shop' } },
      { arm: 'macsql-prompt', id: 3, asked: { db: 'shop' } },
      { arm: 'macsql-prompt', id: 4, gold: 'select 1 from a', asked: {} },
    ],
  };

  it('keeps only the arm’s cases that carry a gold and a database', () => {
    // A case with no gold has nothing to be reached, and one with no database has no card: both would
    // be counted as hiding nothing, which inflates the denominator of the share.
    expect(readReachQuestions(artifact, 'macsql-prompt').map((question) => question.id)).toEqual(['1']);
  });

  it('reads the control, and turns a truncation list into a fact', () => {
    expect(readReachControl(artifact)).toEqual({ schemaLines: 400, tablesInPrompts: 75, tablesTotal: 75, truncated: false });
    expect(readReachControl({ cases: [], controls: { truncatedPrompts: [{ db: 'x', shown: 1, total: 2 }] } }).truncated).toBe(true);
  });

  it('reads an artifact with no controls as an unstated card', () => {
    expect(readReachControl({ cases: [] })).toEqual({ truncated: false });
  });

  it('names its file after the arm and the split', () => {
    expect(reachPath({ root: '/tmp/x', arm: 'select+mixed:rule', split: 'dev' })).toBe('/tmp/x/eval/out/reach-select+mixed_rule-dev.json');
  });

  it('defaults the comparison to the width the builders default to', () => {
    const settings = resolveReachSettings(['--artifact', 'a.json'], '/tmp/x', {});
    expect(settings.compare).toBe(40);
    expect(settings.arm).toBe('macsql-prompt');
    expect(settings.budget).toBeUndefined();
    expect(settings.artifact).toBe('/tmp/x/a.json');
    const layout = resolveLayout({}, '/tmp/x');
    expect(settings.layout.split).toBe(layout.split);
  });

  it('takes a width from the caller, and a comparison width too', () => {
    const settings = resolveReachSettings(['--budget', '400', '--compare', '120', '--arm', 'x', '--out', 'o.json'], '/tmp/x', {});
    expect(settings.budget).toBe(400);
    expect(settings.compare).toBe(120);
    expect(settings.arm).toBe('x');
    expect(settings.out).toBe('/tmp/x/o.json');
  });

  it('refuses an argument it does not read, a value it was not given, and a width that is not a width', () => {
    // Three refusals rather than three defaults: an option nobody reads is how a run measures a
    // prompt nobody sends.
    expect(() => resolveReachSettings(['--nope', '1'], '/tmp/x', {})).toThrow(/unrecognized argument --nope/);
    expect(() => resolveReachSettings(['--budget'], '/tmp/x', {})).toThrow(/--budget needs a value/);
    expect(() => resolveReachSettings(['--budget', '0'], '/tmp/x', {})).toThrow(/positive whole number/);
    expect(() => resolveReachSettings(['--compare', 'forty'], '/tmp/x', {})).toThrow(/positive whole number/);
  });

  it('writes the report, and refuses to replace one taken on another artifact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reach-'));
    const settings = { root: dir, artifact: join(dir, 'a.json'), arm: 'macsql-prompt', layout: resolveLayout({}, dir), compare: 40, out: join(dir, 'reach.json') };
    const clean = { ...report(), problems: [] as string[] };
    const path = writeReachArtifact(settings, clean);
    expect(JSON.parse(readFileSync(path, 'utf8')).arm).toBe('macsql-prompt');
    // The same source twice is the same population: an idempotent re-run must not be refused.
    expect(writeReachArtifact(settings, clean)).toBe(path);
    const other = { ...clean, source: { path: join(dir, 'b.json'), generatedAt: '2026-01-02T00:00:00Z' } };
    expect(() => writeReachArtifact(settings, other)).toThrow(/refusing to replace it/);
    expect(() => writeReachArtifact({ ...settings, out: join(dir, 'fresh.json') }, other)).not.toThrow();
  });
});

describe('the instrument, run against a dataset small enough to write', () => {
  /** The chain fixture: `items — orders — warehouses — cities`, eleven columns over four tables. */
  function chain(): { dir: string; artifact: string } {
    const dir = mkdtempSync(join(tmpdir(), 'reach-'));
    writeChainBirdDataset(dir);
    const artifact = join(dir, 'artifact.json');
    writeFileSync(
      artifact,
      JSON.stringify({
        split: 'minidev',
        generatedAt: '2026-01-01T00:00:00Z',
        controls: { schemaLines: 400, tablesInPrompts: 4, tablesTotal: 4, truncatedPrompts: [] },
        cases: [{ arm: 'macsql-prompt', id: 3, gold: CHAIN_QUESTIONS[2]!.sql, asked: { db: MINI_DB } }],
      }),
    );
    return { dir, artifact };
  }

  it('renders each width from the dataset and counts what it hid', async () => {
    const { dir, artifact } = chain();
    const report = await runReach({
      root: dir,
      artifact,
      arm: 'macsql-prompt',
      layout: resolveLayout({ BIRD_DATA: dir }, dir),
      budget: 400,
      compare: 2,
      out: join(dir, 'reach.json'),
    });
    // The third question reads `orders`, `warehouses` and `cities`; at two column lines only `items`
    // arrives, so all three are hidden, and at 400 all four tables print.
    expect(report.readings.map((one) => one.lines)).toEqual([2, 400]);
    expect(report.readings.map((one) => one.hiddenTables)).toEqual([3, 0]);
    expect(report.readings[1]!.tables).toBe(4);
    expect(report.schemaTables).toBe(4);
    expect(report.schemaColumns).toBe(11);
    expect(report.problems).toEqual([]);
  });

  it('takes its measured width from the artifact when the caller does not name one', async () => {
    const { dir, artifact } = chain();
    const report = await runReach({ root: dir, artifact, arm: 'macsql-prompt', layout: resolveLayout({ BIRD_DATA: dir }, dir), compare: 2, out: join(dir, 'reach.json') });
    expect(report.readings.map((one) => one.lines)).toEqual([2, 400]);
    expect(report.readings[1]!.hiddenTables).toBe(0);
  });

  it('runs from the command line, writes the report, and exits zero', async () => {
    const { dir, artifact } = chain();
    const code = await main(['--artifact', artifact, '--compare', '2'], dir, { BIRD_DATA: dir });
    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(join(dir, 'eval', 'out', 'reach-macsql-prompt-minidev.json'), 'utf8')) as ReachReport;
    expect(written.readings).toHaveLength(2);
  });

  it('exits non-zero when the artifact says its card was complete at a width that hides a table', async () => {
    // The gate, through the command a reader would run: a control that names two lines as complete is
    // a claim the reading contradicts, and the command refuses to publish it as a clean report.
    const { dir, artifact } = chain();
    const body = JSON.parse(readFileSync(artifact, 'utf8'));
    body.controls.schemaLines = 2;
    writeFileSync(artifact, JSON.stringify(body));
    const code = await main(['--artifact', artifact], dir, { BIRD_DATA: dir });
    expect(code).toBe(1);
  });

  it('refuses an artifact whose database the manifest does not carry', async () => {
    // A card cannot be rendered from a manifest that has no entry for the database, and a reading that
    // skipped the case would report a cleaner card than the run sent.
    const { dir, artifact } = chain();
    const body = JSON.parse(readFileSync(artifact, 'utf8'));
    body.cases[0].asked.db = 'absent';
    writeFileSync(artifact, JSON.stringify(body));
    await expect(
      runReach({ root: dir, artifact, arm: 'macsql-prompt', layout: resolveLayout({ BIRD_DATA: dir }, dir), compare: 2, out: join(dir, 'reach.json') }),
    ).rejects.toThrow(/has no entry for absent/);
  });

  it('falls back to the builders’ default width when neither the caller nor the artifact names one', async () => {
    // An artifact from before the control carried a width, which is every artifact this repository
    // published until this round. The comparison width is then the only width it can price, and the
    // split falls back to the dataset the layout was resolved from.
    const { dir, artifact } = chain();
    const body = JSON.parse(readFileSync(artifact, 'utf8'));
    delete body.controls;
    delete body.split;
    delete body.generatedAt;
    writeFileSync(artifact, JSON.stringify(body));
    const report = await runReach({ root: dir, artifact, arm: 'macsql-prompt', layout: resolveLayout({ BIRD_DATA: dir }, dir), compare: 2, out: join(dir, 'reach.json') });
    // 400 is the width every arm runs at, so it is the width assumed when the artifact cannot say:
    // assuming the comparison width would report the shipped card as the measured one.
    expect(report.readings.map((one) => one.lines)).toEqual([2, 400]);
    expect(report.split).toBe('minidev');
    expect(report.source.generatedAt).toBeUndefined();
  });

  it('prints an artifact that states no control as unstated, from the command line', async () => {
    const { dir, artifact } = chain();
    const body = JSON.parse(readFileSync(artifact, 'utf8'));
    delete body.controls;
    writeFileSync(artifact, JSON.stringify(body));
    expect(await main(['--artifact', artifact], dir, { BIRD_DATA: dir })).toBe(0);
  });

  it('prints a truncated control as truncated, and does not read it as a disagreement', async () => {
    const { dir, artifact } = chain();
    const body = JSON.parse(readFileSync(artifact, 'utf8'));
    body.controls = { schemaLines: 400, tablesInPrompts: 3, tablesTotal: 4, truncatedPrompts: [{ db: MINI_DB, shown: 3, total: 4 }] };
    writeFileSync(artifact, JSON.stringify(body));
    expect(await main(['--artifact', artifact], dir, { BIRD_DATA: dir })).toBe(0);
  });

  it('refuses to replace a file that names no source at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reach-'));
    const out = join(dir, 'reach.json');
    writeFileSync(out, '{}');
    const settings = { root: dir, artifact: join(dir, 'a.json'), arm: 'macsql-prompt', layout: resolveLayout({}, dir), compare: 40, out };
    expect(() => writeReachArtifact(settings, { ...report(), problems: [] })).toThrow(/another artifact.*no timestamp/);
  });

  it('knows whether it was asked to run, and runs only when it was', async () => {
    expect(isEntry(undefined, 'file:///x')).toBe(false);
    expect(isEntry('/x/y.ts', 'file:///x/y.ts')).toBe(true);
    expect(isEntry('/x/y.ts', 'file:///x/z.ts')).toBe(false);
    // Imported, not run: the false path is the one every other test in this file takes, and the true
    // path is taken here so the line that decides it is not the one line nothing executes.
    const before = process.exitCode;
    await startIfEntry('/x/y.ts', 'file:///x/z.ts', async () => 7);
    expect(process.exitCode).toBe(before);
    await startIfEntry('/x/y.ts', 'file:///x/y.ts', async () => 7);
    expect(process.exitCode).toBe(7);
    process.exitCode = before;
  });
});

describe('the shipment the reach reading belongs to', () => {
  it('carries the card width its reading was taken at', () => {
    // The defect this instrument found, pinned where it started: the shipped recipe left the width to
    // the caller, the builders default to 40, and every reading in `docs/benchmarks.md` was taken at
    // 400. A caller who followed the guide sent a card that hides 22 of BIRD dev's 75 tables.
    expect(SHIPPED_SQL.schemaLines).toBe(BIRD_SCHEMA_LINES);
    expect(resolvePrompt(SHIPPED_SQL, { dialect: 'sqlite' }).schemaLines).toBe(BIRD_SCHEMA_LINES);
    expect(resolveShipment({ dialect: 'SQLite' }).options.schemaLines).toBe(BIRD_SCHEMA_LINES);
  });

  it('lets an instrument price another width without changing the recipe', () => {
    expect(resolveShipment({ dialect: 'SQLite', schemaLines: 40 }).options.schemaLines).toBe(40);
    expect(SHIPPED_SQL.schemaLines).toBe(BIRD_SCHEMA_LINES);
  });
});

describe('the two widths, over a corpus shaped like the one that found the defect', () => {
  it('hides more at 40 than at 400, and the gate says which is which', () => {
    const known = schemas({ shop: { orders: ['id', 'total'], items: ['id'], stock: ['id'] } });
    const questions: ReachQuestion[] = [{ id: '1', db: 'shop', gold: 'select t1.id from orders t1 join stock t2 on t1.id = t2.id' }];
    const assembled = tallyReach({
      split: 'dev',
      arm: 'macsql-prompt',
      questions,
      budgets: [
        budget(400, { shop: card({ orders: ['id', 'total'], items: ['id'], stock: ['id'] }) }, known),
        budget(40, { shop: card({ orders: ['id', 'total'], items: ['id'] }) }, known),
      ],
      schemaTables: 3,
      schemaColumns: 4,
      control: { schemaLines: 400, tablesInPrompts: 3, tablesTotal: 3, truncated: false },
      source: { path: 'a.json' },
    });
    expect(assembled.readings.map((one) => one.hiddenTables)).toEqual([1, 0]);
    expect(assembled.problems).toEqual([]);
  });
});
