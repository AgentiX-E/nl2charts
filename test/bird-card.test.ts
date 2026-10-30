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
import { describe, expect, it, vi } from 'vitest';
import {
  billedLines,
  billedTotal,
  billedProblems,
  billedRows,
  purposeLines,
  purposeRows,
  cardLines,
  cardPath,
  cardProblems,
  costOf,
  coverage,
  goldTables,
  isEntry,
  main,
  resolveCardSettings,
  runCard,
  tableChars,
  tallyCards,
  writeCardArtifact,
} from '../eval/bird/card.js';
import type { CardRow, CardTally } from '../eval/bird/card.js';
import { resolveArm } from '../eval/bird/run.js';
import { writeChainBirdDataset, writeMiniBirdDataset } from './helpers/bird-dataset.js';
import { loadDescriptions, loadTables } from '../eval/bird/data.js';
import { promptOf } from '../eval/bird/card.js';

const loadTablesFor = (data: string) => {
  const table = loadTables(join(data, 'dev_tables.json')).get('shop');
  // A fixture that ships no table renders no prompt, and a test that compares two prompts it
  // could not build is a test that passes for the wrong reason.
  if (table === undefined) throw new Error('the fixture ships no shop table');
  return table;
};

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
  return { report: path, layout: { split: 'minidev', questionsFile: join(data, 'mini_dev_sqlite.json'), tablesFile: join(data, 'dev_tables.json'), descriptionsRoot: join(data, 'dev_databases'), out: join(dir, 'out.json') }, arm, out: dir, strict: true } as never;
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

  it('does not count a table the statement defines itself', () => {
    // A CTE is a table of the statement's own making: the card cannot show it, so counting it would
    // make the case permanently short of `all` and read as a linker failure rather than a reading
    // about a name the database never had.
    expect([...goldTables('with recent as (select 1), older as (select 2) select * from recent join older join items')].sort()).toEqual([
      'items',
    ]);
  });

  it('calls a proposal that keeps every gold table `all`, one that keeps none `none`', () => {
    expect(coverage(new Set(['items', 'orders']), new Set(['items', 'orders', 'extra']))).toBe('all');
    expect(coverage(new Set(['items', 'orders']), new Set(['items']))).toBe('some');
    expect(coverage(new Set(['items']), new Set(['orders']))).toBe('none');
    expect(coverage(new Set(), new Set())).toBe('all');
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
    carded: 'all',
    cardedKept: 1,
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

describe('what the provider billed', () => {
  const armRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    arm: 'select',
    calls: { mean: 4, max: 4 },
    tokens: { prompt: 3_200, completion: 200, chars: 12_000, unbilled: 0 },
    ...overrides,
  });

  it('turns per-case sums into per-call means, because a call is the unit the lever is priced in', () => {
    const [row] = billedRows({ arms: [armRow()] });
    // 12,000 characters over four calls is 3,000 a call; 3,200 tokens over four is 800, so the
    // ratio is 3.75 characters per token — the calibration the character instruments cannot get
    // on their own. Both means come from the same four calls: a ratio taken across two different
    // requests would have no tokenizer behind it.
    expect(row).toMatchObject({ arm: 'select', calls: 4, charsPerCall: 3_000, promptTokensPerCall: 800, charsPerToken: 3.75 });
    expect(row?.unmetered).toBe(false);
  });

  it('says "not metered" for an artifact written before the meter existed', () => {
    const [row] = billedRows({ arms: [armRow({ tokens: undefined })] });
    expect(row?.unmetered).toBe(true);
    expect(billedLines([row!]).join('\n')).toContain('not metered');
  });

  it('prints no table at all for a report with no arms', () => {
    expect(billedRows({})).toEqual([]);
    expect(billedLines([])).toEqual([]);
  });

  it('skips an arm the artifact did not name', () => {
    expect(billedRows({ arms: [{ calls: { mean: 1 } }] })).toEqual([]);
  });

  it('fails an arm that made calls the artifact never metered', () => {
    const problems = billedProblems(billedRows({ arms: [armRow({ tokens: undefined })] }));
    expect(problems[0]).toContain('did not meter');
  });

  it('fails an arm that reports calls and zero tokens', () => {
    // The failure the gate exists for: a meter that did not run reads exactly like free work.
    const problems = billedProblems(billedRows({ arms: [armRow({ tokens: { prompt: 0, completion: 0, chars: 0, unbilled: 0 } })] }));
    expect(problems[0]).toContain('zero prompt tokens');
  });

  it('fails an answer that arrived without a usage block', () => {
    const problems = billedProblems(billedRows({ arms: [armRow({ tokens: { prompt: 3_200, completion: 200, chars: 12_000, unbilled: 2 } })] }));
    expect(problems[0]).toContain('select (2)');
    expect(problems[0]).toContain('unknown');
  });

  it('fails a character count that cannot be the same text as the token count', () => {
    // Below half a character per token there is no tokenizer: the two columns describe different
    // requests, which is the one disagreement neither number shows on its own.
    const problems = billedProblems(billedRows({ arms: [armRow({ tokens: { prompt: 3_200, completion: 0, chars: 1_000, unbilled: 0 } })] }));
    expect(problems[0]).toContain('different prompts');
  });

  it('says what each kind of call cost, and what share of the bill it is', () => {
    // A four-call arm buys three things and the artifact used to price them as one number. The
    // selector is the call whose price is easiest to hide: it answers one digit to a prompt
    // nobody else reads, so "the selector should earn its tokens" had no column to argue with.
    const rows = purposeRows({
      arms: [
        armRow({
          tokens: {
            prompt: 3_200,
            completion: 200,
            chars: 12_000,
            unbilled: 0,
            byPurpose: {
              generate: { calls: 1, prompt: 2_400, completion: 180, chars: 9_000 },
              select: { calls: 1, prompt: 800, completion: 20, chars: 3_000 },
            },
          },
        }),
      ],
    });
    expect(rows[0]).toMatchObject({ arm: 'select', purpose: 'generate', calls: 1, promptTokensPerCase: 2_400, share: 0.75 });
    expect(rows[1]).toMatchObject({ arm: 'select', purpose: 'select', promptTokensPerCase: 800, share: 0.25 });
    // The two shares are the whole bill, because the artifact's two buckets are its two calls.
    expect(rows.reduce((total, row) => total + row.share, 0)).toBeCloseTo(1, 6);
    expect(purposeLines(rows).join('\n')).toContain('selector');
  });

  it('prints no purpose table for an artifact written before the split', () => {
    expect(purposeRows({ arms: [armRow()] })).toEqual([]);
    expect(purposeLines([])).toEqual([]);
  });

  it('fails a bill whose parts do not add up to the whole', () => {
    // The split is taken at the same point as the total, so a disagreement means one of them is
    // being recounted somewhere else — and a share divided by a total it does not add up to is
    // not a share.
    const problems = billedProblems(
      billedRows({
        arms: [
          armRow({
            tokens: {
              prompt: 3_200,
              completion: 200,
              chars: 12_000,
              unbilled: 0,
              byPurpose: { generate: { calls: 1, prompt: 2_400, completion: 180, chars: 9_000 } },
            },
          }),
        ],
      }),
    );
    expect(problems[0]).toContain('do not add up');
  });

  it('fails a bill with a call that does not say what it was for', () => {
    // An unattributed call inflates the total and belongs to no row: the share of every other
    // bucket is then taken over money nobody can name.
    const problems = billedProblems(
      billedRows({
        arms: [
          armRow({
            tokens: {
              prompt: 3_200,
              completion: 200,
              chars: 12_000,
              unbilled: 0,
              byPurpose: {
                generate: { calls: 1, prompt: 2_400, completion: 180, chars: 9_000 },
                unlabelled: { calls: 1, prompt: 800, completion: 20, chars: 3_000 },
              },
            },
          }),
        ],
      }),
    );
    expect(problems[0]).toContain('do not say what they were for');
  });

  it('skips a split whose arm the artifact did not name', () => {
    // The same rule `billedRows` follows, for the same reason: a row with no arm has no arm to put
    // a share under, and inventing one would attribute a cost to whichever arm the reader guessed.
    expect(purposeRows({ arms: [{ tokens: { prompt: 10, byPurpose: { generate: { calls: 1, prompt: 10 } } } }] })).toEqual([]);
  });

  it('reads a bucket the artifact left incomplete as zero rather than as a missing row', () => {
    // An artifact written by a version that reported the split without both fields is a bucket with
    // unknown numbers, not an arm whose cost vanished. Reporting it as zero keeps the sum honest and
    // leaves the total to fail the add-up check if the omission was real.
    const [row] = purposeRows({ arms: [{ arm: 'select', tokens: { prompt: 100, byPurpose: { retry: {} } } }] });
    expect(row).toMatchObject({ purpose: 'retry', calls: 0, promptTokensPerCase: 0, share: 0 });
  });

  it('takes the share over the arm total, and orders the split by what it costs', () => {
    // Two buckets whose shares are taken over a total of zero would divide by nothing; the order is
    // the reason the table reads as a bill rather than as an inventory.
    const rows = purposeRows({
      arms: [
        {
          arm: 'select',
          tokens: {
            prompt: 0,
            byPurpose: { retry: { calls: 1, prompt: 0 }, generate: { calls: 1, prompt: 0 } },
          },
        },
      ],
    });
    expect(rows.map((row) => row.purpose)).toEqual(['generate', 'retry']);
    expect(rows.every((row) => row.share === 0)).toBe(true);
  });

  it('reads a split written without a per-case total as zero rather than as a division by nothing', () => {
    // An artifact can carry the split and not the total it was taken over — a hand-written fixture,
    // or a version boundary. The share is unknown, not infinite, and the add-up check below is what
    // refuses the column if the omission was real.
    const [row] = purposeRows({ arms: [{ arm: 'select', tokens: { byPurpose: { generate: { calls: 1, prompt: 40 } } } }] });
    expect(row).toMatchObject({ purpose: 'generate', promptTokensPerCase: 40, share: 0 });
  });

  it('counts a bucket with no token field as zero when it checks the split', () => {
    const problems = billedProblems(
      billedRows({
        arms: [
          armRow({
            tokens: {
              prompt: 3_200,
              completion: 200,
              chars: 12_000,
              unbilled: 0,
              byPurpose: { generate: { calls: 1 }, select: { calls: 1, prompt: 3_000 } },
            },
          }),
        ],
      }),
    );
    expect(problems[0]).toContain('do not add up');
  });

  it('publishes a report whose calls, tokens and characters agree', () => {
    expect(billedProblems(billedRows({ arms: [armRow()] }))).toEqual([]);
  });

  it('reports no per-call cost for an arm the artifact gave no call count', () => {
    // Not an error: an arm that never ran has no denominator, and dividing by a substituted one
    // would invent a cost per call.
    const [row] = billedRows({ arms: [{ arm: 'names', tokens: { prompt: 0, completion: 0, chars: 0, unbilled: 0 } }] });
    expect(row).toMatchObject({ calls: 0, charsPerCall: 0, promptTokensPerCall: 0, charsPerToken: 0 });
    expect(billedLines([row!]).join('\n')).toContain(' - ');
  });

  it('reports no character count when the meter did not count characters', () => {
    // A report written before the meter counted characters still has calls and tokens: the token
    // column is readable and the ratio is not, and saying so is better than a ratio of zero.
    const [row] = billedRows({ arms: [{ arm: 'names', calls: { mean: 2 }, tokens: { prompt: 100, completion: 10, unbilled: 0 } }] });
    expect(row).toMatchObject({ charsPerCall: 0, promptTokensPerCall: 50, charsPerToken: 0 });
  });

  it('carries the billed arms into the measurement it publishes', () => {
    const rows = billedRows({ arms: [armRow(), armRow({ arm: 'select-prune', tokens: { prompt: 2_800, completion: 190, chars: 10_400, unbilled: 0 } })] });
    expect(rows.map((row) => row.arm)).toEqual(['select', 'select-prune']);
    const lines = billedLines(rows).join('\n');
    expect(lines).toContain('select-prune');
    expect(lines).toContain('chars/token');
  });

  it('adds the arms up, because a push pays for all of them', () => {
    // The number the per-arm table left to the reader: 2,540 + 1,716 = 4,256 tokens a question
    // to run these two arms once. It is what a cut has to move, and it was nowhere in print.
    const rows = billedRows({
      arms: [
        armRow({ arm: 'select', tokens: { prompt: 2_540, completion: 150, chars: 9_600, unbilled: 0 } }),
        armRow({ arm: 'metadata+evidence', tokens: { prompt: 1_716, completion: 60, chars: 7_197, unbilled: 0 } }),
      ],
    });
    expect(billedTotal(rows)).toBe(4_256);
    expect(billedLines(rows).join('\n')).toContain('chain: 4256 prompt tokens a question over 2 arms');
  });

  it('prints no chain line when no arm was metered', () => {
    // Zero is not a bill of nothing: an artifact written before the meter existed has no token
    // column, and a chain line reading `0` would be a claim about money nobody counted.
    const rows = billedRows({ arms: [{ arm: 'names', calls: { mean: 1 } }] });
    expect(billedTotal(rows)).toBe(0);
    expect(billedLines(rows).join('\n')).not.toContain('chain:');
  });
});

describe('where the measurement reads and writes', () => {
  it('takes the arm from the flag and the path from the argument', () => {
    const settings = resolveCardSettings({ BIRD_SPLIT: 'minidev' }, ['report.json', '--arm', 'select-cross'], ROOT);
    expect([settings.arm, settings.report, settings.strict]).toEqual(['select-cross', 'report.json', false]);
  });

  it('defaults to the arm the chain runs and the pipeline ships', () => {
    // It used to default to `select-cross`, which no chain contains: a bare invocation then
    // measured a run that had not happened and printed the zeros as a reading.
    expect(resolveCardSettings({}, ['report.json', '--strict'], ROOT).arm).toBe('metadata+evidence');
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

describe('the entry point', () => {
  it('exits zero and prints both tables when the measurement holds', async () => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'card-main-')));
    const dir = mkdtempSync(join(tmpdir(), 'card-main-out-'));
    const report = join(dir, 'bird-eval.json');
    writeFileSync(report, JSON.stringify(reportBody([1, 2], { arms: [{ arm: 'select', calls: { mean: 4 }, promptChars: { mean: 3_200 }, tokens: { prompt: 900, completion: 60, unbilled: 0 } }] })));
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    try {
      const code = await main([report, '--arm', 'select', '--strict'], ROOT, { BIRD_SPLIT: 'minidev', BIRD_DATA: data, BIRD_OUT: join(dir, 'out.json') });
      expect(code).toBe(0);
      expect(printed.join('\n')).toContain('what the provider billed');
    } finally {
      log.mockRestore();
    }
  });

  it('is not the entry point when it was not invoked as one', () => {
    expect(isEntry(undefined, import.meta.url)).toBe(false);
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

  it('reads a report that carries no controls block at all', async () => {
    // An artifact from before the block existed, or one written by a dry run: the definitions are
    // then empty rather than missing, and an inline arm's cases are dropped for the reason the
    // drop names instead of throwing halfway through a measurement.
    const outcome = await runCard(settingsFor(dataset(), reportBody([1], { controls: undefined })));
    expect(outcome.drops.definitionGap).toBe(1);
    expect(outcome.problems[0]).toContain('not the card that was sent');
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
    // A measurement that ran and failed is a finding: zero without `--strict`, one with it.
    writeFileSync(path, JSON.stringify(reportBody([1], { controls: undefined })));
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

describe('whether the card an arm sends still holds the gold tables', () => {
  const chain = (): string => writeChainBirdDataset(mkdtempSync(join(tmpdir(), 'card-chain-')));
  const pruned = (data: string, id: number) =>
    runCard(settingsFor(data, reportBody([id], {}, 'select-prune'), 'select-prune'));

  it('reports the tables the card shows, not the ones the linker named', async () => {
    // "How many items are there?" names a table and no column of it, so the shipped recallers name
    // nothing and the rule falls back to the whole card. The linker saw none of the gold's tables
    // and the model is still shown all of them: a report that published the linker's coverage as
    // the card's would call that case a loss it never took.
    const [first] = (await runCard(settingsFor(chain(), reportBody([1])))).rows;
    expect(first?.shipped).toBe('none');
    expect(first?.carded).toBe('all');
    expect(first?.cardedKept).toBe(first?.goldTables);
  });

  it('charges a dropped gold table to the card, and names the coverage it lost', async () => {
    // The third question reads `warehouses`, which is one join beyond the two tables a card cut to
    // one join of `items` keeps. The parent sends the same schema the linker named; the pruned arm
    // sends a card that cannot answer the question, and the report has to say so in a column of its
    // own rather than folding it into the linker's coverage.
    const data = chain();
    const parent = (await runCard(settingsFor(data, reportBody([3])))).rows[0];
    const smaller = (await pruned(data, 3)).rows[0];
    expect(smaller?.carded).toBe('some');
    expect(smaller?.cardedKept).toBeLessThan(parent?.cardedKept ?? 0);
    expect(smaller?.tables).toBeLessThan(parent?.tables ?? 0);
  });

  it('counts the coverages of the card it sends beside the ones the linker reached', () => {
    const tally = tallyCards([row({ carded: 'all' }), row({ carded: 'some', goldTables: 2 })]);
    expect(tally.carded).toEqual({ all: 1, some: 1, none: 0 });
    expect(cardLines(tally).join('\n')).toContain('the card this arm sends keeps');
  });
});

describe('the paths a real report can take', () => {
  it('refuses to price an arm whose prompt carries column notes it was never given', () => {
    // `metadata+evidence` is the cheapest arm on the frontier — one call carrying 798 curated
    // notes — and every arm used to be rendered from a schema built with `withNotes: false`.
    // The 1,774 tokens that arm costs were the provider's count, never this file's, which is
    // the defect: a cost instrument blind to the largest block of the prompt it is pricing.
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'card-data-')));
    const tables = loadTablesFor(data);
    const question = JSON.parse(readFileSync(join(data, 'mini_dev_sqlite.json'), 'utf8'))[0];
    expect(() => promptOf(resolveArm('metadata+evidence') as never, question, '', tables as never)).toThrow(/not the one sent/);
  });

  it('charges the notes to the card once it is given them', () => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'card-data-')));
    const tables = loadTablesFor(data);
    const question = JSON.parse(readFileSync(join(data, 'mini_dev_sqlite.json'), 'utf8'))[0];
    const notes = loadDescriptions(join(data, 'dev_databases', 'shop', 'database_description'), tables.tableNames);
    const arm = resolveArm('metadata+evidence') as never;
    // The same arm twice, so the difference is the notes rather than the arm: an empty map is a
    // schema with the lever off, and the two prompts then differ by exactly the comments.
    const without = promptOf(arm, question, '', tables as never, new Map());
    const noted = promptOf(arm, question, '', tables as never, notes);
    expect(without.system).not.toContain('list price of one unit');
    expect(noted.system).toContain('list price of one unit');
    expect(noted.system.length - without.system.length).toBeGreaterThan(50);
    expect(costOf(noted.system, noted.user, question.question).card).toBeGreaterThan(
      costOf(without.system, without.user, question.question).card,
    );
  });

  it('renders the notes an arm sends, reading each database once', async () => {
    // The whole report used to be priced from cards built without the dataset's notes, which is
    // the one block the cheapest arm is mostly made of. Two cases in one database also pin the
    // cache: the descriptions are read per database, not per case.
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'card-data-')));
    const outcome = await runCard(settingsFor(data, reportBody([1, 2], {}, 'metadata+evidence'), 'metadata+evidence'));
    expect(outcome.rows).toHaveLength(2);
    expect(outcome.rows.every((entry) => entry.cost.card > 0)).toBe(true);
    expect(outcome.drops).toEqual({ unknownQuestion: 0, unknownArm: 0, definitionGap: 0, unrenderable: 0 });
  });

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

  it('refuses an arm the artifact does not hold, by naming the ones it does', async () => {
    // The defect this closes: the filter returned nothing, the table printed zeros, and in
    // non-strict mode the step passed. `select-cross` is the arm five workflow steps used to
    // read, and no chain contains it.
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'card-data-')));
    await expect(runCard(settingsFor(data, reportBody([1], {}, 'select'), 'select-cross'))).rejects.toThrow(
      /has no arm select-cross; it holds select/,
    );
  });

  it('refuses a report that keeps no cases at all instead of reading a zero', async () => {
    // This used to return a tally of zero and a problem that only `--strict` turned into a
    // failure, which is how five workflow steps measured nothing for as long as they existed.
    await expect(
      runCard(settingsFor(writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'card-data-'))), {})),
    ).rejects.toThrow(/holds no cases, so arm select cannot be measured/);
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
      layout: { split: 'minidev', questionsFile: join(data, 'mini_dev_sqlite.json'), tablesFile: join(data, 'dev_tables.json'), descriptionsRoot: join(data, 'dev_databases'), out: join(dir, 'out.json') },
      arm: 'select',
      out: dir,
      strict: true,
    } as never);
    expect(outcome.rows[0]?.calls).toBe(1);
    expect(outcome.tally.calls).toBe(1);
  });
});
