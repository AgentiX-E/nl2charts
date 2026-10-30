/**
 * What the prompt costs, pinned on the arithmetic and on the gate.
 *
 * Two things are being checked here, and they fail differently. The arithmetic is pure and is
 * pinned value by value: a block that is charged to the wrong heading would move every share in
 * the report without failing anything downstream. The end-to-end cases run the real
 * `loadQuestions`, the real `buildSchema` and the real `buildAskMessages`, because the claim is
 * about the prompt that was sent — a stub would agree with whatever this file expected.
 *
 * The gate is the other half: this instrument has no target, since a card that is most of the
 * prompt is a fact about the card and a generous spare share is a ceiling rather than a goal.
 * What can be wrong is the instrument, and the cases below drive each of its four absolute
 * failures.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_RECALLERS,
  SHIPPED_RECALLERS,
  cardLines,
  cardPath,
  cardProblems,
  costOf,
  coverage,
  goldTables,
  isEntry,
  linkedTables,
  main,
  resolveCardSettings,
  runCard,
  tableChars,
  tallyCards,
  writeCardArtifact,
} from '../eval/bird/card.js';
import type { CardRow, CardTally } from '../eval/bird/card.js';
import { resolveArm } from '../eval/bird/run.js';
import { writeMiniBirdDataset } from './helpers/bird-dataset.js';
import { loadTables } from '../eval/bird/data.js';
import { promptOf } from '../eval/bird/card.js';

const loadTablesFor = (data: string) => loadTables(join(data, 'dev_tables.json')).get('shop');

const ROOT = process.cwd();

/** A prompt shaped the way `buildSqlPrompt` shapes one, with a context block. */
const SYSTEM = [
  'You translate questions into one read-only SQL statement.',
  'Rules: SELECT only.',
  'Schema:',
  'items(id INT, name TEXT)',
  'Evidence: pen is a name',
  'Question: How many pens are there?',
].join('\n');
const USER = 'Likely columns: items.name\nHow many pens are there?';
const QUESTION = 'How many pens are there?';

const TABLE = (name: string, columns: readonly string[]) => ({
  table: name,
  columns: columns.map((column) => ({ name: column, type: 'TEXT' })),
});

function settingsFor(data: string, overrides: Record<string, unknown> = {}, arm = 'select') {
  const dir = mkdtempSync(join(tmpdir(), 'card-'));
  const path = join(dir, 'bird-eval.json');
  writeFileSync(path, JSON.stringify({ split: 'minidev', cases: [], controls: {}, ...overrides }));
  return { report: path, layout: { split: 'minidev', questionsFile: join(data, 'mini_dev_sqlite.json'), tablesFile: join(data, 'dev_tables.json'), out: join(dir, 'out.json') }, arm, out: dir, strict: true } as never;
}

/** One report row per question, with a known call count. */
function reportBody(ids: readonly number[], overrides: Record<string, unknown> = {}, arm = 'select'): Record<string, unknown> {
  return {
    split: 'minidev',
    cases: ids.map((id) => ({ arm, id: String(id), passed: false, reason: 'values', calls: 4 })),
    controls: { synthesizedDefinitions: { shop: '' } },
    ...overrides,
  };
}

describe('splitting a prompt into the blocks that spent it', () => {
  it('charges rules, card, context and question to their own headings', () => {
    const cost = costOf(SYSTEM, USER, QUESTION);
    expect(cost).toEqual({
      system: SYSTEM.length,
      user: USER.length,
      rules: 'You translate questions into one read-only SQL statement.\nRules: SELECT only.'.length,
      card: 'items(id INT, name TEXT)'.length,
      context: '\nEvidence: pen is a name'.length,
      hint: 'Likely columns: items.name\n'.length,
      question: QUESTION.length,
    });
  });

  it('leaves the context empty when the card runs straight into the question', () => {
    const plain = 'Rules: SELECT only.\nSchema:\nitems(id INT)\nQuestion: how many?';
    expect(costOf(plain, 'how many?', 'how many?')).toMatchObject({ card: 'items(id INT)'.length, context: 0 });
  });

  it('reads every context heading the prompt can place after the card', () => {
    for (const heading of ['\nSemantics:\nthe grain of items', '\nEvidence: pen', '\nInterpretation: a count', '\nPlan:\nscan items']) {
      const system = `Rules: SELECT only.\nSchema:\nitems(id INT)${heading}\nQuestion: how many?`;
      expect(costOf(system, 'how many?', 'how many?')?.context).toBe(heading.length);
    }
  });

  it('refuses a prompt that is not the one the pipeline sends', () => {
    // A prompt that does not end with the question it was built for is not the prompt the
    // pipeline sends, so a share computed from it would be about a different prompt. Refusing
    // loudly is the instrument's own gate; a sentinel would let a report publish a share
    // measured from a prompt nobody received.
    expect(() => costOf(`${SYSTEM} and one more line`, USER, QUESTION)).toThrow('does not end with its question');
    expect(() => costOf(SYSTEM, 'a hint and nothing else', QUESTION)).toThrow('user turn does not end');
    expect(() => costOf('no heading at all', USER, QUESTION)).toThrow('no "\\nQuestion: " heading');
    expect(() => costOf('no card here\nQuestion: how many?', 'how many?', 'how many?')).toThrow('no schema card');
  });
});

describe('the characters each table costs', () => {
  it('renders one table at a time and charges it the separator', () => {
    const chars = tableChars([TABLE('Items', ['id', 'name']), TABLE('orders', ['id'])], {});
    expect([...chars.keys()]).toEqual(['items', 'orders']);
    expect(chars.get('items')).toBe('items(id TEXT, name TEXT)'.length + 1);
    expect(chars.get('orders')).toBe('orders(id TEXT)'.length + 1);
  });

  it('spends more characters on a table with descriptions', () => {
    const plain = tableChars([TABLE('items', ['id'])], { descriptions: false }).get('items') ?? 0;
    const noted = tableChars([{ table: 'items', columns: [{ name: 'id', type: 'TEXT', comment: 'the key' }] }], {
      descriptions: true,
    }).get('items') ?? 0;
    expect(noted).toBeGreaterThan(plain);
  });
});

describe('what the gold statement reads and what a proposal keeps', () => {
  it('reads the tables a statement joins, and none it quotes', () => {
    expect([...goldTables("select count(*) from items i join orders o on o.item_id = i.id where i.name = 'from orders'")].sort()).toEqual([
      'items',
      'orders',
    ]);
  });

  it('calls a proposal that keeps every gold table `all`, one that keeps none `none`', () => {
    expect(coverage(new Set(['items', 'orders']), new Set(['items', 'orders', 'extra']))).toBe('all');
    expect(coverage(new Set(['items', 'orders']), new Set(['items']))).toBe('some');
    expect(coverage(new Set(['items']), new Set(['orders']))).toBe('none');
    expect(coverage(new Set(), new Set())).toBe('all');
  });

  it('finds nothing with the shipped recallers when a question names only its table', () => {
    // The bug this round fixed is on the other side: the linker saw column names only, so a
    // question that names an entity and no column of it matched nothing at all.
    const schema = [TABLE('customers', ['customer_id', 'segment'])];
    expect(linkedTables('how many customers are there', schema, SHIPPED_RECALLERS).size).toBe(0);
    expect([...linkedTables('how many customers are there', schema, CANDIDATE_RECALLERS)]).toEqual(['customers']);
  });

  it('finds the column a question names with either set', () => {
    const schema = [TABLE('orders', ['revenue', 'region'])];
    expect([...linkedTables('revenue by region', schema, SHIPPED_RECALLERS)]).toEqual(['orders']);
  });
});

function row(overrides: Partial<CardRow> = {}): CardRow {
  return {
    id: '1',
    calls: 4,
    cost: { system: 100, user: 20, rules: 10, card: 80, context: 5, hint: 5, question: 15 },
    tables: 2,
    goldTables: 1,
    goldChars: 20,
    spareChars: 60,
    shipped: 'none',
    candidate: 'all',
    shippedTables: 0,
    candidateTables: 2,
    ...overrides,
  };
}

describe('the sums a reader acts on', () => {
  it('adds the blocks, counts the coverages and means the shares over cases', () => {
    const tally = tallyCards([row(), row({ shipped: 'all', spareChars: 0 })]);
    expect(tally.total).toBe(2);
    expect(tally.calls).toBe(8);
    expect(tally.cost.card).toBe(160);
    expect(tally.shipped).toEqual({ all: 1, some: 0, none: 1 });
    expect(tally.candidate).toEqual({ all: 2, some: 0, none: 0 });
    expect(tally.cardShare).toBeCloseTo(80 / 120, 6);
    expect(tally.spareShare).toBeCloseTo((60 / 80) / 2, 6);
  });

  it('takes the mean share over cases rather than over characters', () => {
    // A database with a wide card would otherwise decide the number, and the question the
    // report answers is about a typical prompt.
    const wide = row({ cost: { system: 1000, user: 100, rules: 10, card: 900, context: 0, hint: 10, question: 90 } });
    const narrow = row({ cost: { system: 100, user: 10, rules: 10, card: 70, context: 0, hint: 5, question: 5 } });
    const tally = tallyCards([wide, narrow]);
    expect(tally.cardShare).toBeCloseTo((900 / 1100 + 70 / 110) / 2, 6);
  });

  it('does not divide by zero on an empty population', () => {
    const tally = tallyCards([]);
    expect(tally.total).toBe(0);
    expect(tally.cardShare).toBe(0);
    expect(() => cardLines(tally)).not.toThrow();
  });
});

describe('the lines a reader sees', () => {
  it('prints characters per call, per case and the ceiling', () => {
    const lines = cardLines(tallyCards([row()])).join('\n');
    // One line per block, then the two readings: what a call costs, and what a linker that
    // never errs could stop paying for.
    for (const block of ['rules', 'schema', 'context', 'hint', 'question']) {
      expect(lines).toContain(block);
    }
    expect(lines).toContain('per case');
    expect(lines).toContain('a linker that never errs removes');
    expect(lines).toContain('the shipped linker keeps');
    expect(lines).toContain('with the table recaller');
  });

  it('says which side of the trade the two proposals are on', () => {
    const tally: CardTally = tallyCards([row({ shipped: 'none', candidate: 'all' })]);
    const lines = cardLines(tally).join('\n');
    expect(lines).toContain('all of the gold\'s 0');
    expect(lines).toContain('none of it 1');
  });
});

describe('the four ways the instrument can be wrong', () => {
  it('passes a measurement that read its cases', () => {
    expect(cardProblems({ tally: tallyCards([row()]), definitionGap: 0, unrenderable: 0 })).toEqual([]);
  });

  it('fails when nothing was read', () => {
    expect(cardProblems({ tally: tallyCards([]), definitionGap: 0, unrenderable: 0 })[0]).toContain(
      'no case could be read',
    );
  });

  it('fails when a case is in a database whose definitions the artifact dropped', () => {
    expect(cardProblems({ tally: tallyCards([row()]), definitionGap: 1, unrenderable: 0 })[0]).toContain(
      'not the card that was sent',
    );
  });

  it('fails when the arm needs a block the artifact does not keep', () => {
    expect(cardProblems({ tally: tallyCards([row()]), definitionGap: 0, unrenderable: 2 })[0]).toContain(
      'not the one that was sent',
    );
  });

});

describe('where the measurement reads and writes', () => {
  it('takes the arm from the flag and the path from the argument', () => {
    const settings = resolveCardSettings({ BIRD_SPLIT: 'minidev' }, ['report.json', '--arm', 'select-cross'], ROOT);
    expect([settings.arm, settings.report, settings.strict]).toEqual(['select-cross', 'report.json', false]);
  });

  it('defaults to the arm the gates run', () => {
    expect(resolveCardSettings({}, ['report.json', '--strict'], ROOT).arm).toBe('select-cross');
  });

  it('refuses a flag without a value and a run without a report', () => {
    expect(() => resolveCardSettings({}, ['report.json', '--arm'], ROOT)).toThrow('--arm needs a name');
    expect(() => resolveCardSettings({}, ['--arm', 'select'], ROOT)).toThrow('usage: card.ts');
  });

  it('names its artifact after the arm', () => {
    const settings = resolveCardSettings({}, ['report.json', '--arm', 'select-mixed+dc'], ROOT);
    // The arm name is kept as it is written — `+` and `-` both survive — because a report a
    // reader cannot match to its arm is a report about an arm nobody can find.
    expect(cardPath(settings).endsWith('card-select-mixed+dc.json')).toBe(true);
  });
});

describe('a measurement over a real split', () => {
  const dataset = (): string => writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'card-data-')));

  it('reads every case once, even when the question file holds it twice', async () => {
    const data = dataset();
    // Mini-Dev writes questions 137 and 138 twice; the denominator this report publishes must
    // not count either of them twice.
    const outcome = await runCard(settingsFor(data, reportBody([1, 1, 2])));
    expect(outcome.rows).toHaveLength(2);
    expect(outcome.tally.total).toBe(2);
    expect(outcome.problems).toEqual([]);
  });

  it('charges the card and finds the gold table with the candidate recallers only', async () => {
    const outcome = await runCard(settingsFor(dataset(), reportBody([1])));
    const first = outcome.rows[0];
    expect(first?.cost.card).toBeGreaterThan(0);
    expect(first?.tables).toBe(2);
    // "How many items are there?" — the table is named and no column of it is, which is the
    // shape the shipped recallers miss.
    expect(first?.shipped).toBe('none');
    expect(first?.candidate).toBe('all');
  });

  it('drops a case whose database the manifest does not describe', async () => {
    const data = dataset();
    const file = join(data, 'mini_dev_sqlite.json');
    const questions = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
    writeFileSync(
      file,
      JSON.stringify([...questions, { question_id: 106, db_id: 'gone', question: 'x', evidence: '', SQL: 'select 1', difficulty: 'simple' }]),
    );
    const outcome = await runCard(settingsFor(data, reportBody([106])));
    expect(outcome.drops.definitionGap).toBe(1);
    expect(outcome.problems.join('\n')).toContain('not the card that was sent');
  });

  it('drops a case the question file does not have', async () => {
    const outcome = await runCard(settingsFor(dataset(), reportBody([999])));
    expect(outcome.drops.unknownQuestion).toBe(1);
  });

  it('refuses an arm whose prompt it cannot rebuild, by name', async () => {
    const outcome = await runCard(settingsFor(dataset(), reportBody([1], {}, 'inline+retrieval'), 'inline+retrieval'));
    expect(outcome.drops.unrenderable).toBe(1);
    expect(outcome.problems).toHaveLength(1);
    expect(outcome.problems[0]).toContain('not the one that was sent');
  });

  it('counts every case and says why when the arm name is not one the runner has', async () => {
    const outcome = await runCard(settingsFor(dataset(), reportBody([1, 2], {}, 'no-such-arm'), 'no-such-arm'));
    expect(outcome.drops.unknownArm).toBe(2);
    expect(outcome.problems).toHaveLength(1);
    expect(outcome.problems[0]).toContain('not the one that was sent');
  });

  it('writes its artifact next to the run it measured', async () => {
    const settings = settingsFor(dataset(), reportBody([1]));
    const outcome = await runCard(settings);
    const path = writeCardArtifact(settings, outcome);
    expect(JSON.parse(readFileSync(path, 'utf8')).tally.total).toBe(1);
  });

  it('exits zero on a clean measurement and one under --strict when the instrument failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-main-'));
    const data = dataset();
    const path = join(dir, 'bird-eval.json');
    const env = { BIRD_SPLIT: 'minidev', BIRD_DATA: data, BIRD_OUT: join(dir, 'out.json') };
    writeFileSync(path, JSON.stringify(reportBody([1])));
    expect(await main([path, '--arm', 'select'], ROOT, env)).toBe(0);
    writeFileSync(path, JSON.stringify(reportBody([])));
    expect(await main([path, '--arm', 'select'], ROOT, env)).toBe(0);
    expect(await main([path, '--arm', 'select', '--strict'], ROOT, env)).toBe(1);
  });

  it('is its own entry point only when it was run as one', () => {
    expect(isEntry(undefined, 'file:///x')).toBe(false);
    expect(isEntry('/x', 'file:///x')).toBe(true);
  });

  it('does not treat an arm it cannot name as renderable', () => {
    expect(resolveArm('select')).toBeDefined();
    expect(resolveArm('inline+retrieval')?.evidence).toBe('retrieved');
  });
});

describe('the paths a real report can take', () => {
  it('charges a card that costs nothing without dividing by zero', () => {
    // A table with no columns would cost nothing, and a share over nothing is not a number.
    const empty = row({ cost: { system: 10, user: 5, rules: 5, card: 0, context: 0, hint: 2, question: 3 }, spareChars: 0 });
    expect(tallyCards([empty]).spareShare).toBe(0);
  });

  it('sends two messages, and the second one carries the hint and the question', async () => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'card-data-')));
    const tables = loadTablesFor(data);
    const question = JSON.parse(readFileSync(join(data, 'mini_dev_sqlite.json'), 'utf8'))[0];
    const built = promptOf(resolveArm('select') as never, question, '', tables as never);
    // The system message holds the card; the user message holds the linker's hint. An
    // instrument that measured only the first would miss a block the model reads — and in this
    // fixture the hint is the sentence that says nothing matched, because "How many items are
    // there?" names the table and no column of it. That is the same defect the table recaller
    // was added for, visible in the smallest possible prompt.
    expect(built.system).toContain('Schema:');
    expect(built.user.endsWith(question.question)).toBe(true);
    expect(built.user.startsWith('No column matched; use the schema above.')).toBe(true);
  });

  it('reads a report that keeps no cases at all', async () => {
    const outcome = await runCard(settingsFor(writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'card-data-'))), {}));
    expect(outcome.tally.total).toBe(0);
    expect(outcome.problems[0]).toContain('no case could be read');
  });

  it('renders an arm whose definitions are a block rather than the card', async () => {
    // `names` carries structural definitions, so a database without synthesized text is still
    // renderable: the card was never built from that text.
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'card-data-')));
    const outcome = await runCard(settingsFor(data, reportBody([1], { controls: {} }, 'names'), 'names'));
    expect(outcome.tally.total).toBe(1);
    expect(outcome.drops.definitionGap).toBe(0);
  });

  it('charges nothing for a gold table the card does not describe', async () => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'card-data-')));
    const file = join(data, 'mini_dev_sqlite.json');
    const questions = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
    writeFileSync(
      file,
      JSON.stringify([
        ...questions,
        { question_id: 108, db_id: 'shop', question: 'How many ghosts are there?', evidence: '', SQL: 'select 1 from ghost', difficulty: 'simple' },
      ]),
    );
    const outcome = await runCard(settingsFor(data, reportBody([108])));
    // A statement that reads a table the manifest does not describe is a corpus defect, not a
    // card defect; the cost of that table is zero and the row says so rather than throwing.
    expect(outcome.rows[0]?.goldChars).toBe(0);
    expect(outcome.rows[0]?.shipped).toBe('none');
  });

  it('assumes one call for a case that does not say how many it made', async () => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'card-data-')));
    const dir = mkdtempSync(join(tmpdir(), 'card-'));
    const path = join(dir, 'bird-eval.json');
    writeFileSync(
      path,
      JSON.stringify({
        cases: [{ arm: 'select', id: '1', passed: false }],
        controls: { synthesizedDefinitions: { shop: '' } },
      }),
    );
    const outcome = await runCard({
      report: path,
      layout: { split: 'minidev', questionsFile: join(data, 'mini_dev_sqlite.json'), tablesFile: join(data, 'dev_tables.json'), out: join(dir, 'out.json') },
      arm: 'select',
      out: dir,
      strict: true,
    } as never);
    expect(outcome.rows[0]?.calls).toBe(1);
    expect(outcome.tally.calls).toBe(1);
  });
});
