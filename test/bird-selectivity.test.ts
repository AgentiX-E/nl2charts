/**
 * What the linker can recall, and what no linker of this kind could.
 *
 * The card ceiling arm measured +11.09pp by keeping a different set of fields, and the shipped
 * linker names 31.0% of the fields the gold statement names. A number like that invites one of two
 * reads — "the linker is broken" or "the information is not there" — and they lead to opposite
 * next steps: fix the ranker, or change what it is allowed to look at. The instrument in this file
 * separates them, and it does so without a single model call.
 *
 * The cases below pin each of the three variables on fixtures small enough that the expected answer
 * can be derived by hand: a column reached only through an alias, one reached only through a stored
 * value, one that a twelve-column cut removes and an unbounded budget keeps, and one nothing
 * reaches.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MODE_RECALLERS,
  RECALL_MODES,
  withCommentAliases,
  SELECTIVITY_BUDGETS,
  UNBOUNDED,
  isEntry,
  main,
  resolveSelectivitySettings,
  runSelectivity,
  selectivityLines,
  selectivityOf,
  selectivityPath,
  selectivityProblems,
  tallySelectivity,
  writeSelectivityArtifact,
} from '../eval/bird/selectivity.js';
import type { SelectivityCase, SelectivitySettings, SelectivityTally } from '../eval/bird/selectivity.js';
import { writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();

const column = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: 'TEXT', ...extra });

/** `items` with one column reachable only through an alias and one only through a value. */
const ITEMS = [
  {
    table: 'items',
    columns: [
      column('id', { type: 'INT' }),
      column('name', { samples: ['pen', 'cup'] }),
      column('price', { aliases: ['cost'] }),
    ],
  },
];

/** The cell one case reports for a selector at a budget. */
const cellOf = (one: SelectivityCase, mode: (typeof RECALL_MODES)[number], topK: number) =>
  one.cells.find((cell) => cell.mode === mode && cell.topK === topK);

describe('the four information sources, one at a time', () => {
  /** "cost of the pen": `cost` is an alias, `pen` is a stored value, and neither a column name nor
   *  the table name appears. Three sources, three separate answers. */
  const QUESTION = 'What is the cost of the pen?';
  const SQL = 'select price, name from items';
  const outcome = selectivityOf(QUESTION, SQL, ITEMS);

  it('opens exactly one recaller per single-source mode', () => {
    expect(MODE_RECALLERS.alias).toEqual(['alias']);
    expect(MODE_RECALLERS.value).toEqual(['value']);
    expect(MODE_RECALLERS.name).toEqual(['name']);
    expect(MODE_RECALLERS.table).toEqual(['table']);
  });

  it('reaches the aliased column through the alias', () => {
    expect(cellOf(outcome, 'alias', 12)?.linked).toBe(1);
  });

  it('reaches the stored value through the value index', () => {
    expect(cellOf(outcome, 'value', 12)?.linked).toBe(1);
  });

  it('reaches neither through names, because neither name is in the question', () => {
    expect(cellOf(outcome, 'name', 12)?.linked).toBe(0);
  });

  it('reaches nothing through the table, because the question never names it', () => {
    expect(cellOf(outcome, 'table', 12)?.linked).toBe(0);
  });

  it('reaches both when the shipped set opens them together', () => {
    const shipped = cellOf(outcome, 'shipped', 12);
    expect(shipped?.linked).toBe(2);
    expect(shipped?.total).toBe(2);
    expect(shipped?.covered).toBe(1);
    expect(shipped?.spare).toBe(0);
  });

  it('counts both fields as reached and neither pile as a miss', () => {
    expect(outcome.total).toBe(2);
    expect(outcome.linked).toBe(2);
    expect(outcome.cut).toBe(0);
    expect(outcome.unreachable).toBe(0);
  });
});

describe('the budget, which is a slice and not a linker', () => {
  /** Twenty columns that all match the question's one token, so the ranker cannot separate them and
   *  the tie-break is the column name. The gold field is the last of the twenty. */
  const WIDE = [
    {
      table: 'tickets',
      columns: Array.from({ length: 20 }, (_, index) => column(`${String.fromCharCode(97 + index)}_amount`)),
    },
  ];
  const QUESTION = 'What is the total amount?';
  // The last column the tie-break produces: twenty names share one token, so the order is the name,
  // and the twentieth is the one a twelve-column cut cannot reach.
  const SQL = 'select t_amount from tickets';
  const outcome = selectivityOf(QUESTION, SQL, WIDE);

  it('cuts the field the twelve-column budget cannot reach', () => {
    expect(cellOf(outcome, 'all', 12)?.linked).toBe(0);
    expect(outcome.linked).toBe(0);
    // The field is not out of reach, it is out of budget: the same recallers keep it uncut.
    expect(outcome.cut).toBe(1);
    expect(outcome.unreachable).toBe(0);
  });

  it('keeps it when the budget is not a slice, and shows what the card grew to', () => {
    const ceiling = cellOf(outcome, 'all', UNBOUNDED);
    expect(ceiling?.linked).toBe(1);
    expect(ceiling?.kept).toBe(20);
  });

  it('prices two budgets, the shipped one first', () => {
    expect([...SELECTIVITY_BUDGETS]).toEqual([12, UNBOUNDED]);
  });
});

describe('the field no recaller can reach', () => {
  it('counts a field whose name, alias, value and table are all absent as unreachable', () => {
    const outcome = selectivityOf('How many cups are there?', 'select price from items', [
      {
        table: 'items',
        columns: [column('id', { type: 'INT' }), column('name', { samples: ['pen'] }), column('price')],
      },
    ]);
    expect(outcome.total).toBe(1);
    expect(outcome.linked).toBe(0);
    expect(outcome.cut).toBe(0);
    expect(outcome.unreachable).toBe(1);
  });

  it('does not count an abstention as a miss', () => {
    const outcome = selectivityOf('How many items are there?', 'select count(*) from items', ITEMS);
    expect(outcome.total).toBe(0);
    expect(outcome.unreachable).toBe(0);
    expect(outcome.linked).toBe(0);
  });

  it('splits every gold field into exactly one of the three piles', () => {
    const outcome = selectivityOf('What is the cost of the pen?', 'select price, name, id from items', ITEMS);
    expect(outcome.total).toBe(3);
    expect(outcome.linked + outcome.cut + outcome.unreachable).toBe(outcome.total);
    // `id` is the field nothing reaches, on the same card where two are reached.
    expect(outcome.unreachable).toBe(1);
  });
});


describe('the curated comment, which the alias recaller has never been given', () => {
  const NOTED = [
    {
      table: 'items',
      columns: [
        column('name', { comment: 'what the shop calls it' }),
        column('price', { comment: 'what it costs' }),
        column('id', { type: 'INT' }),
      ],
    },
  ];

  it('offers each comment to the alias recaller and leaves the rest alone', () => {
    const shaped = withCommentAliases(NOTED);
    expect(shaped[0]?.columns[0]?.aliases).toEqual(['what the shop calls it']);
    // A column with no comment is passed through, not given an empty alias.
    expect(shaped[0]?.columns[2]?.aliases).toBeUndefined();
    expect(shaped[0]?.columns[2]?.name).toBe('id');
  });

  it('keeps an alias the card already carried', () => {
    const shaped = withCommentAliases([
      { table: 'items', columns: [column('price', { comment: 'what it costs', aliases: ['cost'] })] },
    ]);
    expect(shaped[0]?.columns[0]?.aliases).toEqual(['cost', 'what it costs']);
  });

  it('reaches a column whose name is absent but whose comment names the word', () => {
    // "What does it cost?" — `costs` is in the comment and nowhere else.
    const outcome = selectivityOf('What does it cost?', 'select price from items', NOTED);
    expect(cellOf(outcome, 'alias', 12)?.linked).toBe(0);
    expect(cellOf(outcome, 'comment', 12)?.linked).toBe(1);
    // The comment is the difference between the four recallers with and without it.
    expect(cellOf(outcome, 'all', 12)?.linked).toBe(0);
  });

  it('reaches nothing extra on a card that carries no comment', () => {
    const outcome = selectivityOf('What is the cost of the pen?', 'select price, name from items', ITEMS);
    expect(cellOf(outcome, 'comment', UNBOUNDED)?.linked).toBe(cellOf(outcome, 'all', UNBOUNDED)?.linked);
  });
});

describe('the tally over cases', () => {
  const cases: readonly SelectivityCase[] = [
    selectivityOf('What is the cost of the pen?', 'select price, name from items', ITEMS),
    selectivityOf('How many cups are there?', 'select price from items', ITEMS),
  ];

  it('keeps one cell per mode and budget, in a fixed order', () => {
    const tally = tallySelectivity(cases);
    expect(tally.cells.length).toBe(RECALL_MODES.length * SELECTIVITY_BUDGETS.length);
    expect(tally.cells.map((entry) => entry.mode)).toEqual(RECALL_MODES.flatMap((mode) => [mode, mode]));
    expect(tally.cells[0]?.topK).toBe(12);
    expect(tally.cells[1]?.topK).toBe(UNBOUNDED);
  });

  it('adds the piles over cases rather than averaging them', () => {
    const tally = tallySelectivity(cases);
    expect(tally.cases).toBe(2);
    expect(tally.total).toBe(3);
    expect(tally.linked).toBe(2);
    expect(tally.cut).toBe(0);
    expect(tally.unreachable).toBe(1);
  });

  it('averages the width a card would show and sums the fields it reaches', () => {
    const tally = tallySelectivity(cases);
    const shipped = tally.cells.find((entry) => entry.mode === 'shipped' && entry.topK === 12);
    expect(shipped?.kept).toBe(1);
    expect(shipped?.linked).toBe(2);
    expect(shipped?.covered).toBe(1);
    expect(shipped?.spare).toBe(0);
  });
});

describe('the report', () => {
  const tally = tallySelectivity([
    selectivityOf('What is the cost of the pen?', 'select price, name from items', ITEMS),
  ]);

  it('prints a row per selector and budget, with the shares a reader compares', () => {
    const lines = selectivityLines(tally);
    const text = lines.join('\n');
    expect(text).toContain('| selector |');
    expect(text).toContain('shipped');
    // Two rows per mode, one per budget.
    expect(lines.filter((line) => line.startsWith('| shipped |')).length).toBe(2);
  });

  it('names the ceiling and both piles rather than leaving the reader to subtract', () => {
    const text = selectivityLines(tally).join('\n');
    expect(text).toMatch(/Token matching reaches/);
    expect(text).toMatch(/no recaller at any budget/);
  });

  it('shows the two budgets as a number and as the absence of one', () => {
    const lines = selectivityLines(tally);
    expect(lines.some((line) => line.startsWith('| shipped | 12 |'))).toBe(true);
    expect(lines.some((line) => line.startsWith('| shipped | none |'))).toBe(true);
  });
});

describe('the guards', () => {
  const healthy = tallySelectivity([
    selectivityOf('What is the cost of the pen?', 'select price, name from items', ITEMS),
  ]);

  it('passes a tally whose piles add up', () => {
    expect(selectivityProblems(healthy)).toEqual([]);
  });

  it('refuses a report with no cases, because a share of nothing is not a share', () => {
    const empty: SelectivityTally = { ...healthy, cases: 0 };
    expect(selectivityProblems(empty).join('\n')).toMatch(/no cases/);
  });

  it('refuses piles that do not add up to the fields the statements named', () => {
    const broken: SelectivityTally = { ...healthy, unreachable: healthy.unreachable + 1 };
    expect(selectivityProblems(broken).join('\n')).toMatch(/do not add up/);
  });

  it('refuses a ceiling below a slice, which would mean the budget was never uncut', () => {
    const cells = healthy.cells.map((cell) =>
      cell.mode === 'comment' && cell.topK === UNBOUNDED ? { ...cell, linked: 0 } : cell,
    );
    expect(selectivityProblems({ ...healthy, cells }).join('\n')).toMatch(/ceiling is below a slice/);
  });

  it('refuses a report with no uncut ceiling to price against', () => {
    const cells = healthy.cells.filter((cell) => cell.topK !== UNBOUNDED);
    expect(selectivityProblems({ ...healthy, cells }).join('\n')).toMatch(/no uncut ceiling/);
  });

  it('refuses a card whose every field is unreachable, which is a reader that is not wired', () => {
    const broken: SelectivityTally = { ...healthy, linked: 0, cut: 0, unreachable: healthy.total };
    expect(selectivityProblems(broken).join('\n')).toMatch(/not wired/);
  });

  it('refuses a corpus that named no field at all', () => {
    const broken: SelectivityTally = { ...healthy, total: 0, linked: 0, cut: 0, unreachable: 0 };
    expect(selectivityProblems(broken).join('\n')).toMatch(/named no field/);
  });
});

describe('where the measurement reads and writes', () => {
  it('takes the arm from the flag and the path from the argument', () => {
    const settings = resolveSelectivitySettings({ BIRD_SPLIT: 'minidev' }, ['report.json', '--arm', 'select-cross'], ROOT);
    expect([settings.arm, settings.report, settings.strict]).toEqual(['select-cross', 'report.json', false]);
  });

  it('defaults to the arm the chain runs and the pipeline ships', () => {
    // The same default the card instrument uses, for the same reason: a bare invocation must not
    // measure a run that did not happen and print its zeros as a reading.
    expect(resolveSelectivitySettings({}, ['report.json', '--strict'], ROOT).arm).toBe('metadata+evidence');
    expect(resolveSelectivitySettings({}, ['report.json', '--strict'], ROOT).strict).toBe(true);
  });

  it('refuses a flag without a value and a run without a report', () => {
    expect(() => resolveSelectivitySettings({}, ['report.json', '--arm'], ROOT)).toThrow('--arm needs a name');
    expect(() => resolveSelectivitySettings({}, ['--arm', 'select'], ROOT)).toThrow('usage: selectivity.ts');
  });

  it('names its artifact after the arm', () => {
    const settings = resolveSelectivitySettings({}, ['report.json', '--arm', 'select-mixed+dc'], ROOT);
    expect(selectivityPath(settings).endsWith('selectivity-select-mixed+dc.json')).toBe(true);
  });
});

/** A layout over a freshly written fixture, and one report row per question id. */
function settingsFor(data: string, ids: readonly number[], arm = 'select') {
  const dir = mkdtempSync(join(tmpdir(), 'selectivity-'));
  const path = join(dir, 'bird-eval.json');
  writeFileSync(
    path,
    JSON.stringify({
      split: 'minidev',
      cases: ids.map((id) => ({ arm, id: String(id), passed: false, reason: 'values', calls: 4 })),
      controls: { synthesizedDefinitions: { shop: '' } },
    }),
  );
  return {
    report: path,
    layout: {
      split: 'minidev',
      questionsFile: join(data, 'mini_dev_sqlite.json'),
      tablesFile: join(data, 'dev_tables.json'),
      descriptionsRoot: join(data, 'dev_databases'),
      profileCache: join(data, '.profiles'),
      exampleCache: join(data, '.value-examples'),
      out: join(dir, 'out.json'),
    },
    arm,
    out: dir,
    strict: true,
  } as unknown as SelectivitySettings;
}

describe('a measurement over a real split', () => {
  const dataset = (): string => writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'selectivity-data-')));

  it('reads every case once, even when the question file holds it twice', async () => {
    const outcome = await runSelectivity(settingsFor(dataset(), [2, 2, 1]));
    expect(outcome.cases.map((one) => one.id)).toEqual(['2', '1']);
    expect(outcome.tally.cases).toBe(2);
    expect(outcome.problems).toEqual([]);
  });

  it('reaches the summed column through its name and the counted table not at all', async () => {
    const outcome = await runSelectivity(settingsFor(dataset(), [2, 1]));
    const [summed, counted] = outcome.cases;
    expect(summed?.total).toBe(1);
    expect(summed?.linked).toBe(1);
    // `select count(*)` names no column of the table it counts from: an abstention, not a miss.
    expect(counted?.total).toBe(0);
  });

  it('counts a column the table recaller has to reach as cut rather than unreachable', async () => {
    // "How many orders are there for the pen?" reads `orders.item_id`, and no word of that name or
    // of its values is in the question — but the word `orders` is, so the table recaller reaches the
    // column and the shipped set does not. It is the one case in this fixture where the difference
    // between `all` and `shipped` is observable.
    const outcome = await runSelectivity(settingsFor(dataset(), [7]));
    const one = outcome.cases[0];
    expect(one?.total).toBe(1);
    expect(one?.linked).toBe(0);
    expect(one?.cut).toBe(1);
    expect(one?.unreachable).toBe(0);
  });

  it('drops a case the question file does not have', async () => {
    const outcome = await runSelectivity(settingsFor(dataset(), [999]));
    expect(outcome.drops.unknownQuestion).toBe(1);
    expect(outcome.problems.join('\n')).toContain('could not be read');
  });

  it('names an arm whose prompt it cannot rebuild instead of pricing an empty card', async () => {
    const outcome = await runSelectivity(settingsFor(dataset(), [1], 'inline+retrieval'));
    expect(outcome.drops.unrenderable).toBe(1);
    expect(outcome.problems.join('\n')).toContain('unrenderable');
  });

  it('counts every case and says why when the arm name is not one the runner has', async () => {
    const outcome = await runSelectivity(settingsFor(dataset(), [1, 2], 'no-such-arm'));
    expect(outcome.drops.unknownArm).toBe(2);
    expect(outcome.problems.join('\n')).toContain('unknown arm');
  });

  it('treats a report with no definitions as a gap rather than a card', async () => {
    const data = dataset();
    const settings = settingsFor(data, [1]);
    writeFileSync(
      settings.report,
      JSON.stringify({ split: 'minidev', cases: [{ arm: 'select', id: '1', passed: false, reason: 'values', calls: 4 }] }),
    );
    const outcome = await runSelectivity(settings);
    expect(outcome.drops.definitionGap).toBe(1);
    expect(outcome.cases).toHaveLength(0);
  });

  it('writes its artifact with the piles and the cells the report prints', async () => {
    const settings = settingsFor(dataset(), [2]);
    const outcome = await runSelectivity(settings);
    const path = writeSelectivityArtifact(settings, outcome);
    const written = JSON.parse(readFileSync(path, 'utf8')) as { tally: SelectivityTally };
    expect(written.tally.total).toBe(1);
    expect(written.tally.linked).toBe(1);
    expect(written.tally.cells).toHaveLength(RECALL_MODES.length * SELECTIVITY_BUDGETS.length);
  });
});

describe('the entry point', () => {
  it('exits zero and prints the table when the measurement holds', async () => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'selectivity-main-')));
    const dir = mkdtempSync(join(tmpdir(), 'selectivity-main-out-'));
    const report = join(dir, 'bird-eval.json');
    writeFileSync(
      report,
      JSON.stringify({
        split: 'minidev',
        cases: [{ arm: 'select', id: '2', passed: false, reason: 'values', calls: 4 }],
        controls: { synthesizedDefinitions: { shop: '' } },
      }),
    );
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    try {
      const code = await main([report, '--arm', 'select', '--strict'], ROOT, {
        BIRD_SPLIT: 'minidev',
        BIRD_DATA: data,
        BIRD_OUT: join(dir, 'out.json'),
      });
      expect(code).toBe(0);
      expect(printed.join('\n')).toContain('| selector |');
      expect(printed.join('\n')).toContain('wrote ');
    } finally {
      log.mockRestore();
    }
  });

  it('exits one under strict when the measurement does not hold, and zero when it is not strict', async () => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'selectivity-bad-')));
    const dir = mkdtempSync(join(tmpdir(), 'selectivity-bad-out-'));
    const report = join(dir, 'bird-eval.json');
    // Question 1 is `count(*)`: one case, no field named, so the corpus cannot support a share.
    writeFileSync(
      report,
      JSON.stringify({
        split: 'minidev',
        cases: [{ arm: 'select', id: '1', passed: false, reason: 'values', calls: 4 }],
        controls: { synthesizedDefinitions: { shop: '' } },
      }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const env = { BIRD_SPLIT: 'minidev', BIRD_DATA: data, BIRD_OUT: join(dir, 'out.json') };
      expect(await main([report, '--arm', 'select', '--strict'], ROOT, env)).toBe(1);
      expect(await main([report, '--arm', 'select'], ROOT, env)).toBe(0);
      expect(error.mock.calls.length).toBeGreaterThan(0);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('is not the entry point when it was not invoked as one', () => {
    expect(isEntry(undefined, import.meta.url)).toBe(false);
  });
});

describe('the cases an artifact mixes together', () => {
  it('reads only the arm it was asked for, out of a report that holds several', async () => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'selectivity-mixed-')));
    const settings = settingsFor(data, [1, 2]);
    writeFileSync(
      settings.report,
      JSON.stringify({
        split: 'minidev',
        cases: [
          { arm: 'select', id: '2', passed: false, reason: 'values', calls: 4 },
          { arm: 'names', id: '1', passed: true, reason: 'match', calls: 1 },
          { arm: 'names', id: '2', passed: true, reason: 'match', calls: 1 },
        ],
        controls: { synthesizedDefinitions: { shop: '' } },
      }),
    );
    const outcome = await runSelectivity(settings);
    // Two rows for `names`, one for `select`: a reader pointed at the wrong arm has to see the arm's
    // own cases rather than every case in the file.
    expect(outcome.cases.map((one) => one.id)).toEqual(['2']);
    expect(outcome.problems).toEqual([]);
  });

  it('carries the curated notes onto the card for an arm that shows them', async () => {
    // `metadata+evidence` is the arm whose card carries the curated comments, and it is the arm the
    // pipeline ships. Reading it is what makes `comment` a priced mode rather than a proposal.
    const outcome = await runSelectivity(settingsFor(writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'selectivity-notes-'))), [2], 'metadata+evidence'));
    expect(outcome.cases).toHaveLength(1);
    expect(outcome.drops.definitionGap).toBe(0);
  });
});

describe('a tally whose rows were written by something else', () => {
  it('skips a case that does not carry a cell for a selector', () => {
    const one = selectivityOf('What is the cost of the pen?', 'select price, name from items', ITEMS);
    const partial: SelectivityCase = { ...one, cells: one.cells.filter((cell) => cell.mode !== 'table') };
    const tally = tallySelectivity([one, partial]);
    const table = tally.cells.find((cell) => cell.mode === 'table');
    // One case counted, not two: a missing cell is missing, not zero.
    expect(table?.kept).toBe(one.cells.find((cell) => cell.mode === 'table')?.kept);
    expect(tally.cases).toBe(2);
  });

  it('prints a sentence with no ceiling rather than throwing, and the guard refuses it', () => {
    const empty: SelectivityTally = { cases: 1, cells: [], linked: 1, cut: 0, unreachable: 0, total: 1 };
    const text = selectivityLines(empty).join('\n');
    expect(text).toMatch(/Token matching reaches/);
    expect(selectivityProblems(empty).join('\n')).toMatch(/no uncut ceiling/);
  });
});

describe('the entry point as a process', () => {
  it('runs as a script and exits zero on a measurement that holds', () => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'selectivity-proc-')));
    const dir = mkdtempSync(join(tmpdir(), 'selectivity-proc-out-'));
    const report = join(dir, 'bird-eval.json');
    writeFileSync(
      report,
      JSON.stringify({
        split: 'minidev',
        cases: [{ arm: 'select', id: '2', passed: false, reason: 'values', calls: 4 }],
        controls: { synthesizedDefinitions: { shop: '' } },
      }),
    );
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(ROOT, 'eval/bird/selectivity.ts'), report, '--arm', 'select', '--strict'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, BIRD_SPLIT: 'minidev', BIRD_DATA: data, BIRD_OUT: join(dir, 'out.json') },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('| selector |');
  });
});

describe('the edges of reading a report', () => {
  const dataset = (): string => writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'selectivity-edge-')));

  it('counts nothing to drop when an unknown arm is asked for a report with no cases', async () => {
    const settings = settingsFor(dataset(), [1], 'no-such-arm');
    writeFileSync(settings.report, JSON.stringify({ split: 'minidev' }));
    const outcome = await runSelectivity(settings);
    expect(outcome.drops.unknownArm).toBe(0);
    // Nothing was dropped because nothing was read; the report is refused for having no cases.
    expect(outcome.problems.join('\n')).toContain('no cases');
  });

  it('counts nothing to drop when an unrenderable arm is asked for a report with no cases', async () => {
    const settings = settingsFor(dataset(), [1], 'inline+retrieval');
    writeFileSync(settings.report, JSON.stringify({ split: 'minidev' }));
    const outcome = await runSelectivity(settings);
    expect(outcome.drops.unrenderable).toBe(0);
    expect(outcome.problems.join('\n')).toContain('no cases');
  });

  it('reads one database s notes once for two cases on that database', async () => {
    // Two cases, one cache: the second must not re-read the same description files.
    const outcome = await runSelectivity(settingsFor(dataset(), [1, 2], 'metadata+evidence'));
    expect(outcome.cases).toHaveLength(2);
    expect(outcome.drops.definitionGap).toBe(0);
  });

  it('renders a card with no definitions text for an arm that does not take them inline', async () => {
    const settings = settingsFor(dataset(), [2], 'metadata+evidence');
    writeFileSync(
      settings.report,
      JSON.stringify({
        split: 'minidev',
        cases: [{ arm: 'metadata+evidence', id: '2', passed: false, reason: 'values', calls: 4 }],
      }),
    );
    const outcome = await runSelectivity(settings);
    expect(outcome.cases).toHaveLength(1);
    expect(outcome.drops.definitionGap).toBe(0);
  });
});
