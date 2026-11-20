/**
 * The shipped reading, and the six ways it could be better than the instrument earned.
 *
 * `text2vis-ship.test.ts` compares the product's route with the arbitration policy on synthetic rows.
 * This file prices the *report*: the counts behind each rate, the divergence guard, and the command a
 * workflow runs. Every assertion here is a defect that would otherwise publish a plausible number —
 * a reason counted twice, a rate over zero rows, a chart that is neither of the two answers, a
 * population scored against answers given to different questions.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { POLICIES, type Policy } from '../eval/text2vis/arbitrate.js';
import { rosterOf } from '../eval/text2vis/llm.js';
import { familyOfLabel } from '../eval/text2vis/rule.js';
import { parseResultSet, profileAnswer, typedRows, type ProfileInput } from '../eval/text2vis/profile.js';
import { TEXT2VIS_FIELDS } from '../eval/text2vis/dataset.js';
import {
  answerKey,
  artifactAdvisor,
  chartAdvisor,
  assertShip,
  countsOf,
  describeShip,
  entryShip,
  messageOf,
  parseShipArgs,
  repairAdvisor,
  repairAnswers,
  repairAsks,
  refusalBill,
  routedBy,
  shipReport,
  type ShipCounts,
  type RefusalBill,
  type ShipReport,
} from '../eval/text2vis/ship.js';
import { admittedOptions, MARK_OPTIONS, type MarkOption } from '@agentix-e/nl2charts-chart';

const root = mkdtempSync(join(tmpdir(), 'nl2charts-ship-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ENTRY = resolve('eval/text2vis/ship.ts');
const MODULE_URL = pathToFileURL(ENTRY).href;

/** One row of the corpus: a question, a label, and the table the query returned. */
function row(prompt: string, chartType: string, tableData: string): ProfileInput {
  return { prompt, label: chartType, tableData };
}

const ROWS: readonly ProfileInput[] = [
  row('Revenue by country', 'Bar', 'country,value\nUS,5\nDE,9\nFR,2'),
  row('Revenue over the years', 'Line', 'year,value\n2019,3\n2020,4\n2021,8'),
  row('Share of revenue by country', 'Pie', 'country,value\nUS,50\nDE,30\nFR,20'),
  row('Total revenue', 'Gauge', 'value\n42'),
  // A table whose columns are a timeline: the chart is a line and the advisor is never asked.
  row('Population by year', 'Line', 'entity,2019,2020,2021\nOman,1203,1180,1164\nQatar,980,1010,1044'),
  // One measure and no axis: the model may say `bar`, and the chart cannot hold it.
  row('Average order value', 'Gauge', 'value\n7'),
];

/** The same answers the arm writes, one per row. */
const CHOICES: readonly (string | null)[] = ['bar', 'line', 'pie', null, 'bar', 'bar'];

function counts(over: Partial<ShipCounts> = {}): ShipCounts {
  return {
    hit: 1,
    share: 0.5,
    fromModel: 1,
    repaired: 0,
    fromProduct: 1,
    reasons: { 'no-advice': 1, unavailable: 0, unlisted: 0, 'not-admitted': 0, unchartable: 0 },
    ...over,
  };
}

function report(over: Partial<ShipReport> = {}): ShipReport {
  return {
    model: 'a-model',
    population: { scored: 2, roster: 'a-roster' },
    decided: counts(),
    shipped: counts(),
    changed: 0,
    marks: ['bar', 'line'],
    divergence: [],
    refusals: [],
    ...over,
  };
}

describe('the counts behind a rate', () => {
  it('scores the marks it is given and splits them by who decided', () => {
    // Six rows, and the six answers are the marks the corpus names — so a reading that scores them has
    // to be six, and a reading that scores four is a reading about a different population.
    const marks = ['bar', 'line', 'pie', 'declined', 'bar', 'bar'] as const;
    const decisions = [
      { mark: 'bar' as const, source: 'model' as const, product: 'bar' as const },
      { mark: 'line' as const, source: 'model' as const, product: 'line' as const },
      { mark: 'pie' as const, source: 'product' as const, product: 'pie' as const, reason: 'no-advice' as const },
      { mark: 'declined' as const, source: 'product' as const, product: 'declined' as const, reason: 'unchartable' as const },
      { mark: 'bar' as const, source: 'model' as const, product: 'bar' as const },
      { mark: 'bar' as const, source: 'model' as const, product: 'bar' as const },
    ];
    const scored = countsOf(ROWS, [...marks], decisions);
    // Three of the six labels are answered with the mark the corpus names: the two gauge rows took a
    // bar and the time-wide row took a bar, and none of those three is a hit.
    expect(scored.hit).toBe(3);
    expect(scored.fromModel).toBe(4);
    expect(scored.fromProduct).toBe(2);
    expect(scored.reasons).toMatchObject({ 'no-advice': 1, unchartable: 1 });
  });

  it('refuses a pass whose three lists are not the same length', () => {
    expect(() => countsOf(ROWS, ['bar'], [])).toThrow(/6 rows, 1 marks and 0 decisions/);
  });

  it('refuses a table-decided row with no reason, which is a row the report cannot explain', () => {
    expect(() =>
      countsOf(ROWS, ['bar', 'line', 'pie', 'declined', 'bar', 'bar'], [
        { mark: 'bar', source: 'product', product: 'bar' },
        { mark: 'line', source: 'model', product: 'line' },
        { mark: 'pie', source: 'model', product: 'pie' },
        { mark: 'declined', source: 'model', product: 'declined' },
        { mark: 'bar', source: 'model', product: 'bar' },
        { mark: 'bar', source: 'model', product: 'bar' },
      ]),
    ).toThrow(/table-decided row carries no reason/);
  });
});

describe('the shipped report', () => {
  const roster = rosterOf(ROWS);

  it('reads the decision and the chart over one population', async () => {
    const shipped = await shipReport(ROWS, CHOICES, 'a-model', { roster });
    assertShip(shipped);
    expect(shipped.population.scored).toBe(6);
    expect(shipped.decided.fromModel).toBe(5);
    // One row is vetoed: the one-measure table cannot hold the bar. The wide table is no longer skipped
    // — the reshape holds a bar, so the model's answer is drawn — and this fixture is one of the rows
    // that trade *loses*: it is labelled `Line` and the model answered `bar`. Five of the six labels are
    // hit rather than six, which is the 6-in-144 half of the corpus's 20-gained / 6-lost measurement
    // stated where a reader can see it.
    expect(shipped.shipped.fromModel).toBe(4);
    expect(shipped.shipped.reasons['not-admitted']).toBe(1);
    expect(shipped.shipped.hit).toBe(5);
    expect(shipped.divergence).toEqual([]);
  });

  it('refuses an empty population, because a share over nothing is not a reading', async () => {
    await expect(shipReport([], [], 'a-model', { roster: '' })).rejects.toThrow(/population is empty/);
  });

  it('refuses an answer list that is not one per row', async () => {
    await expect(shipReport(ROWS, ['bar'], 'a-model', { roster })).rejects.toThrow(/answers for 1 rows and the population has 6/);
  });

  it('refuses answers given to a different population', async () => {
    await expect(shipReport(ROWS, CHOICES, 'a-model', { roster: 'something-else' })).rejects.toThrow(
      /answered a different population/,
    );
  });

  it('refuses a table with no model-holds policy, rather than inventing one', async () => {
    const others: readonly Policy[] = POLICIES.filter((policy) => policy.name !== 'model-holds');
    await expect(shipReport(ROWS, CHOICES, 'a-model', { roster }, { policies: others })).rejects.toThrow(
      /no model-holds policy/,
    );
  });

  it('names the rows where the shipped decision and the policy disagree', async () => {
    // A policy that always answers `bar` is not the shipped rule, and the report must say which rows
    // prove it rather than publishing a total that looks like agreement.
    const liar: Policy = { name: 'model-holds', note: 'a decoy', choose: () => ({ mark: 'bar', families: ['bar'] }) };
    const shipped = await shipReport(ROWS, CHOICES, 'a-model', { roster }, { policies: [liar] });
    expect(shipped.divergence.length).toBeGreaterThan(0);
    expect(() => assertShip(shipped)).toThrow(/where the shipped decision and model-holds disagree/);
  });

  it('prints the two readings and the agreement, so a reader does not have to infer it', async () => {
    const shipped = await shipReport(ROWS, CHOICES, 'a-model', { roster });
    const text = describeShip(shipped).join('\n');
    expect(text).toContain('decided');
    expect(text).toContain('shipped');
    expect(text).toContain('route agrees with model-holds on 6 of 6 rows');
    expect(text).toContain('changed');
  });
});

describe('the arithmetic a reader could not reproduce', () => {
  it('passes a report that is internally consistent', () => {
    expect(() => assertShip(report())).not.toThrow();
  });

  it('refuses a reading whose per-row marks are not one per row', () => {
    // The marks are what pairs this reading with another one row by row, so a short list is not a
    // cosmetic gap: it is a comparison that would silently skip the rows it never reached.
    expect(() => assertShip(report({ marks: ['bar'] }))).toThrow(/per-row marks and a population of 2/);
    expect(() => assertShip(report({ marks: ['bar', 'line', 'pie'] }))).toThrow(/per-row marks and a population of 2/);
  });

  it('refuses a split that does not cover the population', () => {
    expect(() => assertShip(report({ decided: counts({ fromModel: 0, fromProduct: 1 }) }))).toThrow(
      /over a population of 2/,
    );
  });

  it('refuses a reason total that is not the table s own count', () => {
    expect(() =>
      assertShip(report({ shipped: counts({ fromModel: 0, fromProduct: 2, reasons: { 'no-advice': 1, unavailable: 0, unlisted: 0, 'not-admitted': 0, unchartable: 0 } }) })),
    ).toThrow(/counted 1 reasons over 2 table rows/);
  });

  it('refuses more hits than rows', () => {
    expect(() =>
      assertShip(
        report({
          shipped: counts({
            hit: 3,
            fromModel: 0,
            fromProduct: 2,
            reasons: { 'no-advice': 2, unavailable: 0, unlisted: 0, 'not-admitted': 0, unchartable: 0 },
          }),
        }),
      ),
    ).toThrow(/3 hits over 2 rows/);
  });

  it('refuses a share above one', () => {
    expect(() => assertShip(report({ decided: counts({ share: 1.5 }) }))).toThrow(/share above one/);
  });

  it('refuses more changed rows than vetoes could explain', () => {
    // A chart that differs from the decision without a veto is a third answer nobody produced.
    expect(() =>
      assertShip(
        report({
          shipped: counts({ fromModel: 0, fromProduct: 2, reasons: { 'no-advice': 2, unavailable: 0, unlisted: 0, 'not-admitted': 0, unchartable: 0 } }),
          changed: 2,
        }),
      ),
    ).toThrow(/2 rows differ from the decision and only 0 were vetoed/);
  });
});

describe('the advisor over an artifact', () => {
  it('answers the row it was asked about, and refuses to drift', async () => {
    const decide = artifactAdvisor(ROWS, CHOICES);
    // Six rows, six answers, in order.
    expect(await decide((ROWS[0] as ProfileInput).prompt)).toBe('bar');
    await expect(decide('a question nobody asked')).rejects.toThrow(/answer 1 belongs to/);
  });

  it('refuses an answer it does not have, rather than reading past the end', async () => {
    const decide = artifactAdvisor(ROWS.slice(0, 1), ['bar']);
    expect(await decide((ROWS[0] as ProfileInput).prompt)).toBe('bar');
    await expect(decide('another question')).rejects.toThrow(/which is not a row it was given/);
  });

  it('reads a null answer as "the model named nothing"', async () => {
    const decide = artifactAdvisor(ROWS, CHOICES);
    for (let index = 0; index < 3; index += 1) await decide((ROWS[index] as ProfileInput).prompt);
    // The fourth row's answer is `null`, and `null` is not a mark — it is a refusal, which the product
    // has an answer for.
    expect(await decide((ROWS[3] as ProfileInput).prompt)).toBeUndefined();
  });
});

describe('the advisor the chart pass uses', () => {
  it('finds the answer by question, so a skipped row does not shift the rest', async () => {
    // The chart pass asks again on the rows its first answer could not draw, so its call sequence is
    // not the row sequence. Looking the row up by its question is the only reading that survives that.
    const ask = chartAdvisor(ROWS, CHOICES);
    expect(await ask((ROWS[2] as ProfileInput).prompt)).toBe('pie');
    expect(await ask((ROWS[5] as ProfileInput).prompt)).toBe('bar');
    expect(await ask((ROWS[3] as ProfileInput).prompt)).toBeUndefined();
  });

  it('refuses a question it was not given a row for', async () => {
    const ask = chartAdvisor(ROWS, CHOICES);
    await expect(ask('a question nobody asked')).rejects.toThrow(/which is not a row of this population/);
  });
});

describe('which answer a chart took', () => {
  it('says same when the chart is the decision', () => {
    expect(routedBy(0, 'bar', 'line', 'bar')).toBe('same');
  });

  it('says table when a veto replaced the decision', () => {
    expect(routedBy(0, 'bar', 'line', 'line')).toBe('table');
  });

  it('refuses a third answer, which no rule in this system can produce', () => {
    // The arbitration guards the same property for a policy; this is the shipped path, which is the one
    // a caller can receive. Unreachable through `assistedChartIR` today, and exactly why it is a pure
    // function: a branch nothing can reach through the product is a branch only a test can hold.
    expect(() => routedBy(7, 'bar', 'line', 'pie')).toThrow(
      /row 7 decided bar, shipped pie, and the table answers line/,
    );
  });
});

describe('a message for anything thrown', () => {
  it('reads an Error and a thrown string the same way a log line needs', () => {
    expect(messageOf(new Error('connect ECONNREFUSED'))).toBe('connect ECONNREFUSED');
    expect(messageOf('a bare string')).toBe('a bare string');
    expect(messageOf(undefined)).toBe('undefined');
  });
});

describe('the command line', () => {
  it('takes the three flags and the one it cannot default', () => {
    expect(parseShipArgs(['--answers', 'a.json', '--artifact', 'out.json', '--model', 'm', '--json'])).toEqual({
      json: true,
      answers: 'a.json',
      artifact: 'out.json',
      model: 'm',
    });
  });

  it('refuses a missing --answers rather than guessing which artifact', () => {
    expect(() => parseShipArgs([])).toThrow(/--answers is required/);
  });

  it('refuses a flag it does not use', () => {
    expect(() => parseShipArgs(['--answers', 'a.json', '--live'])).toThrow(/unknown argument --live/);
  });

  it('refuses a value that is another flag', () => {
    expect(() => parseShipArgs(['--answers', '--json'])).toThrow(/--answers needs a path or a name/);
  });

  it('reads --artifact and --model independently of each other', () => {
    expect(parseShipArgs(['--answers', 'a.json', '--model', 'm'])).toEqual({ json: false, answers: 'a.json', model: 'm' });
    expect(parseShipArgs(['--answers', 'a.json', '--artifact', 'o.json'])).toEqual({
      json: false,
      answers: 'a.json',
      artifact: 'o.json',
    });
  });
});

/** A CSV cell holding a whole table, quoted with real newlines. */
function cell(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

const HEADER = `${TEXT2VIS_FIELDS.prompt},${TEXT2VIS_FIELDS.answer},${TEXT2VIS_FIELDS.code},${TEXT2VIS_FIELDS.chartType},Table Data`;

const CORPUS_ROWS: readonly (readonly [string, string, string])[] = [
  ['Revenue by country', 'Bar', 'country,value\nUS,5\nDE,9'],
  ['Revenue over the years', 'Line', 'year,value\n2019,3\n2020,4\n2021,8'],
  ['Total revenue', 'Gauge', 'value\n42'],
  // A label no family names. The arm drops these before asking, and the command must count the drop
  // rather than score them.
  ['Revenue as a waterfall', 'Waterfall', 'stage,value\nstart,10\nend,4'],
  // A table no mark can hold: one text column is neither an axis nor a measure.
  ['Which region', 'Bar', 'region\nNorth\nSouth'],
];

/** The rows the arm would have asked about: the ones whose label names a family. */
const SCORED_ROWS = CORPUS_ROWS.filter(([, label]) => familyOfLabel(label) !== undefined);

const CSV = [
  HEADER,
  ...CORPUS_ROWS.map(([prompt, label, table]) => `${cell(prompt)},code,SELECT 1,${label},${cell(table)}`),
].join('\n');

async function serve(body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/csv' });
    response.end(body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/Text2Vis.csv`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** The artifact the arm writes, trimmed to the fields this command reads. */
function artifact(over: Record<string, unknown> = {}): string {
  const path = join(root, `answers-${String(Date.now())}-${String(Math.random()).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      corpus: { roster: rosterOf(SCORED_ROWS.map(([prompt, label, table]) => row(prompt, label, table))) },
      arms: [{ model: 'a-model', scale: 'mark', choices: ['bar', 'line', 'gauge', 'bar'] }],
      ...over,
    }),
  );
  return path;
}

describe('the command', () => {
  it('refuses a run with no arguments, rather than guessing an artifact', async () => {
    const lines: string[] = [];
    const code = await entryShip(ENTRY, MODULE_URL, (line) => lines.push(line), {});
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('--answers is required');
  });

  it('does nothing when it is not the entry module, so importing it has no effect', async () => {
    expect(await entryShip('/somewhere/else.ts', MODULE_URL, () => undefined, {})).toBeUndefined();
  });

  it('prices the shipped path and writes the report it printed', async () => {
    const served = await serve(CSV);
    try {
      const lines: string[] = [];
      const out = join(root, 'ship.json');
      const code = await entryShip(
        ENTRY,
        MODULE_URL,
        (line) => lines.push(line),
        {
          argv: ['--answers', artifact(), '--artifact', out, '--json'],
          load: { url: served.url, cacheDir: join(root, 'corpus') },
        } as never,
      );
      expect(code).toBe(0);
      // `--json` prints the payload a machine reads, and the file beside it is the same payload.
      expect(lines.join('\n')).toContain('"divergence"');
      expect(lines.join('\n')).toContain('shipped path on 4 rows');
      // The Waterfall row is dropped before the population is formed, and said out loud.
      expect(lines.join('\n')).toContain('1 rows carry a label no family names');
      expect(lines.join('\n')).toContain('wrote');
    } finally {
      await served.close();
    }
  });

  it('exits 1 when the artifact carries no roster, rather than scoring unidentified rows', async () => {
    const served = await serve(CSV);
    try {
      const lines: string[] = [];
      const code = await entryShip(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', artifact({ corpus: {} })],
        load: { url: served.url, cacheDir: join(root, 'corpus') },
      } as never);
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('carries no corpus.roster');
    } finally {
      await served.close();
    }
  });

  it('exits 1 when the artifact has no mark-scale arm', async () => {
    const served = await serve(CSV);
    try {
      const lines: string[] = [];
      const code = await entryShip(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', artifact({ arms: [{ model: 'a-model', scale: 'label' }] })],
        load: { url: served.url, cacheDir: join(root, 'corpus') },
      } as never);
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('no mark-scale arm');
    } finally {
      await served.close();
    }
  });

  it('exits 1 when the model named in --model has no arm', async () => {
    const served = await serve(CSV);
    try {
      const lines: string[] = [];
      const code = await entryShip(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', artifact(), '--model', 'another-model'],
        load: { url: served.url, cacheDir: join(root, 'corpus') },
      } as never);
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('has no another-model mark arm');
    } finally {
      await served.close();
    }
  });

  it('answers a prefix when the artifact records how many rows it asked', async () => {
    const served = await serve(CSV);
    try {
      const lines: string[] = [];
      const code = await entryShip(ENTRY, MODULE_URL, (line) => lines.push(line), {
        // The roster is the fingerprint of the rows the answers were given to, so a prefix is a
        // *different* fingerprint — the guard that stops a two-row reading being scored as a four-row
        // one is the same one that stops last week's artifact being scored against this week's corpus.
        argv: [
          '--answers',
          artifact({
            corpus: {
              roster: rosterOf(SCORED_ROWS.slice(0, 2).map(([prompt, label, table]) => row(prompt, label, table))),
              asked: 2,
            },
            arms: [{ model: 'a-model', scale: 'mark', choices: ['bar', 'line'] }],
          }),
        ],
        load: { url: served.url, cacheDir: join(root, 'corpus') },
      } as never);
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('shipped path on 2 rows');
    } finally {
      await served.close();
    }
  });

  it('exits 1 when the artifact carries no arms at all', async () => {
    const served = await serve(CSV);
    try {
      const lines: string[] = [];
      const code = await entryShip(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', artifact({ arms: undefined })],
        load: { url: served.url, cacheDir: join(root, 'corpus') },
      } as never);
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('no mark-scale arm');
    } finally {
      await served.close();
    }
  });

  it('exits 1 when the arm carries no per-row choices', async () => {
    const served = await serve(CSV);
    try {
      const lines: string[] = [];
      const code = await entryShip(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', artifact({ arms: [{ model: 'a-model', scale: 'mark' }] })],
        load: { url: served.url, cacheDir: join(root, 'corpus') },
      } as never);
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('carries no per-row choices');
    } finally {
      await served.close();
    }
  });

  it('exits 1 when the answers belong to a different population', async () => {
    const served = await serve(CSV);
    try {
      const lines: string[] = [];
      const code = await entryShip(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', artifact({ corpus: { roster: 'deadbeef' } })],
        load: { url: served.url, cacheDir: join(root, 'corpus') },
      } as never);
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('answered a different population');
    } finally {
      await served.close();
    }
  });
});

describe('the reading against the product s own answer', () => {
  it('reproduces the table s score when the artifact holds the table s marks', async () => {
    // The degenerate case, and the one that proves the plumbing: when the "model" says exactly what the
    // table says, the shipped route must read the table's number, and every row must agree.
    const rows = CORPUS_ROWS.map(([prompt, label, table]) => row(prompt, label, table));
    const choices = rows.map((input) => {
      const mark = profileAnswer(input.prompt, input.tableData).mark;
      return mark === 'declined' ? null : mark;
    });
    const shipped = await shipReport(rows, choices, 'product-as-model', { roster: rosterOf(rows) });
    assertShip(shipped);
    expect(shipped.divergence).toEqual([]);
    expect(shipped.decided.hit).toBe(3);
    expect(shipped.shipped.hit).toBe(3);
  });
});

/**
 * The list `ship.ts` will offer for a row: the marks its own result set can hold.
 *
 * Computed through `parseResultSet` and `typedRows`, exactly as the chart pass does, because an
 * admitted set derived from hand-written rows is a different table — and the first version of these
 * tests did that, produced four keys that matched nothing, and was refused by the very check it was
 * trying to exercise.
 */
function listFor(prompt: string, table: string): readonly MarkOption[] {
  const set = parseResultSet(table);
  return admittedOptions(prompt, typedRows(set), { columns: set.columns });
}

describe('the second answers, replayed', () => {
  /** The choices that make the repair fire: `boxplot` is on the roster and refused by these tables. */
  const REFUSED: readonly (string | null)[] = ['boxplot', 'boxplot', 'pie', null, 'bar', 'bar'];

  it('keys an answer by its question and its list, because that is what the two questions differ in', () => {
    const short = listFor('Revenue by country', 'country,value\nUS,5\nDE,9\nFR,2');
    expect(answerKey('q', short)).toBe(`q\u0000${short.map((option) => option.name).join(',')}`);
    expect(answerKey('q', short)).not.toBe(answerKey('q', [{ name: 'bar' }]));
    expect(answerKey('q', short)).not.toBe(answerKey('r', short));
  });

  it('reads question one from the arm and question two from the file', async () => {
    const short = listFor('Revenue by country', 'country,value\nUS,5\nDE,9\nFR,2');
    const answers = new Map([[answerKey('Revenue by country', short), 'pie']]);
    const missing: string[] = [];
    const advisor = repairAdvisor(async () => 'bar', answers, missing);
    expect(await advisor('Revenue by country', MARK_OPTIONS)).toBe('bar');
    expect(await advisor('Revenue by country', short)).toBe('pie');
    expect(missing).toEqual([]);
    // A question two nobody answered is recorded rather than thrown: `assistedChartIR` catches what an
    // advisor throws, and a repair that is not on disk must be a refusal to publish, not a fallback.
    expect(await advisor('another question', short)).toBeUndefined();
    expect(missing).toEqual([answerKey('another question', short)]);
  });

  it('records exactly the questions the chart pass will ask, by asking it', async () => {
    const { refused, asks } = await repairAsks(ROWS, REFUSED);
    // Three rows are refused: two name `boxplot` on a table that holds four marks, and one names `bar`
    // on a gauge table that holds only `gauge`. The first two are asked; the third is not, because a
    // question with one possible answer is not a question. The wide table is not among them: its long
    // form holds a bar, so the model's answer is drawn rather than refused.
    expect(refused).toBe(3);
    expect(asks.map((ask) => ask.row)).toEqual([0, 1]);
    for (const ask of asks) expect(ask.options).toHaveLength(4);
  });

  it('reads a repair file, and refuses the three files that cannot be placed', () => {
    const short = listFor('Revenue by country', 'country,value\nUS,5\nDE,9\nFR,2').map((option) => option.name);
    const good = { rows: [{ question: 'Revenue by country', options: short, choice: 'pie' }] };
    expect(repairAnswers(good).get(answerKey('Revenue by country', short.map((name) => ({ name }))))).toBe('pie');
    expect(() => repairAnswers(null)).toThrow(/is not an object/);
    expect(() => repairAnswers({})).toThrow(/carries no rows array/);
    expect(() => repairAnswers({ rows: [null] })).toThrow(/row that is not an object/);
    expect(() => repairAnswers({ rows: [{ options: short, choice: 'pie' }] })).toThrow(/without a question/);
    expect(() => repairAnswers({ rows: [{ question: 'q', choice: 'pie' }] })).toThrow(/without an option list/);
    expect(() => repairAnswers({ rows: [{ question: 'q', options: ['bar'], choice: 7 }] })).toThrow(/not a name/);
    expect(() =>
      repairAnswers({
        rows: [
          { question: 'q', options: ['bar'], choice: 'bar' },
          { question: 'q', options: ['bar'], choice: 'pie' },
        ],
      }),
    ).toThrow(/twice, and the two answers differ/);
    // The same answer twice is a file two runs appended to, and it is still one answer.
    expect(repairAnswers({ rows: [{ question: 'q', options: ['bar'] }, { question: 'q', options: ['bar'] }] }).size).toBe(1);
  });

  it('draws the model s second answer, and counts the row as a repair rather than as a first answer', async () => {
    const roster = rosterOf(ROWS);
    const plain = await shipReport(ROWS, REFUSED, 'a-model', { roster });
    const short = listFor('Revenue by country', 'country,value\nUS,5\nDE,9\nFR,2');
    const answers = new Map([
      [answerKey((ROWS[0] as ProfileInput).prompt, short), 'pie'],
      [answerKey((ROWS[1] as ProfileInput).prompt, listFor((ROWS[1] as ProfileInput).prompt, (ROWS[1] as ProfileInput).tableData)), 'line'],
    ]);
    const repaired = await shipReport(ROWS, REFUSED, 'a-model', { roster }, { repair: answers });
    assertShip(repaired);
    expect(repaired.decided).toEqual(plain.decided);
    expect(repaired.shipped.repaired).toBe(2);
    expect(repaired.shipped.fromProduct).toBe(plain.shipped.fromProduct - 2);
    // The gauge table holds one mark, so its refused row is not repairable and stays a veto: the
    // second question is not asked where it has only one possible answer.
    expect(repaired.shipped.reasons['not-admitted']).toBe(1);
    // A repair is a chart that is not the decision, so it is a changed row — and the count is checked
    // against the vetoes plus the repairs rather than against the vetoes alone.
    expect(repaired.changed).toBe(plain.changed);
    expect(describeShip(repaired).join('\n')).toContain('2 repaired');
  });

  it('refuses to publish when a second question has no answer on disk', async () => {
    await expect(
      shipReport(ROWS, REFUSED, 'a-model', { roster: rosterOf(ROWS) }, { repair: new Map() }),
    ).rejects.toThrow(/second question\(s\) have no answer in the repair artifact/);
  });

  it('counts a repair apart from a first answer, and refuses a total that hides it', () => {
    const decisions = [
      { mark: 'pie' as const, source: 'model' as const, product: 'bar' as const, repaired: true as const },
      { mark: 'line' as const, source: 'model' as const, product: 'line' as const },
      { mark: 'pie' as const, source: 'product' as const, product: 'pie' as const, reason: 'no-advice' as const },
      { mark: 'declined' as const, source: 'product' as const, product: 'declined' as const, reason: 'unchartable' as const },
      { mark: 'bar' as const, source: 'model' as const, product: 'bar' as const },
      { mark: 'bar' as const, source: 'model' as const, product: 'bar' as const },
    ];
    const counted = countsOf(ROWS, ['pie', 'line', 'pie', 'declined', 'bar', 'bar'], decisions);
    expect(counted.repaired).toBe(1);
    expect(counted.fromModel).toBe(3);
    expect(counted.fromProduct).toBe(2);
  });

  it('lets a repair explain a changed row, and only within its own count', () => {
    expect(() => assertShip(report({ changed: 0 }))).not.toThrow();
    expect(() =>
      assertShip(report({ shipped: counts({ repaired: 0, fromModel: 1, fromProduct: 1 }), changed: 1 })),
    ).toThrow(/only 0 were vetoed and 0 repaired/);
  });

  it('refuses a fifth answer even when a repair was attempted', () => {
    expect(() => routedBy(3, 'bar', 'line', 'pie', false)).toThrow(/a chart may only be one of the two/);
    expect(routedBy(3, 'bar', 'line', 'pie', true)).toBe('repair');
    // A repair that landed on the table s own answer is still a repair: it was asked, and it was paid for.
    expect(routedBy(3, 'bar', 'line', 'line', true)).toBe('repair');
  });

  it('takes --repair on the command line, and refuses a value that is another flag', () => {
    expect(parseShipArgs(['--answers', 'a.json', '--repair', 'r.json'])).toEqual({
      json: false,
      answers: 'a.json',
      repair: 'r.json',
    });
    expect(() => parseShipArgs(['--answers', 'a.json', '--repair', '--json'])).toThrow(/--repair needs a path or a name/);
  });
});

describe('the command, with a repair on disk', () => {
  const CHOICES_WITH_REFUSAL = ['boxplot', 'line', 'gauge', 'bar'];

  function repairFile(over: Record<string, unknown> = {}): string {
    const short = listFor('Revenue by country', 'country,value\nUS,5\nDE,9\nFR,2').map((option) => option.name);
    const path = join(root, `repair-${String(Date.now())}-${String(Math.random()).slice(2)}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        population: { roster: rosterOf(SCORED_ROWS.map(([prompt, label, table]) => row(prompt, label, table))) },
        rows: [{ question: 'Revenue by country', options: short, choice: 'pie' }],
        ...over,
      }),
    );
    return path;
  }

  it('draws the repaired chart and says how many rows it repaired', async () => {
    const served = await serve(CSV);
    try {
      const lines: string[] = [];
      const code = await entryShip(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', artifact({ arms: [{ model: 'a-model', scale: 'mark', choices: CHOICES_WITH_REFUSAL }] }), '--repair', repairFile()],
        load: { url: served.url, cacheDir: join(root, 'corpus') },
      } as never);
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('1 repaired');
    } finally {
      await served.close();
    }
  });

  it('exits 1 when the repair file answers a different population', async () => {
    const served = await serve(CSV);
    try {
      const lines: string[] = [];
      const code = await entryShip(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', artifact({ arms: [{ model: 'a-model', scale: 'mark', choices: CHOICES_WITH_REFUSAL }] }), '--repair', repairFile({ population: { roster: 'somebody-else' } })],
        load: { url: served.url, cacheDir: join(root, 'corpus') },
      } as never);
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('answered a different population');
    } finally {
      await served.close();
    }
  });

  it('exits 1 when the repair file does not say which rows it answered', async () => {
    const served = await serve(CSV);
    try {
      const lines: string[] = [];
      const code = await entryShip(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', artifact({ arms: [{ model: 'a-model', scale: 'mark', choices: CHOICES_WITH_REFUSAL }] }), '--repair', repairFile({ population: {} })],
        load: { url: served.url, cacheDir: join(root, 'corpus') },
      } as never);
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('carries no population.roster');
    } finally {
      await served.close();
    }
  });

  it('exits 1 when the repair file cannot be read at all', async () => {
    const served = await serve(CSV);
    try {
      const lines: string[] = [];
      const code = await entryShip(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', artifact({ arms: [{ model: 'a-model', scale: 'mark', choices: CHOICES_WITH_REFUSAL }] }), '--repair', join(root, 'no-such-file.json')],
        load: { url: served.url, cacheDir: join(root, 'corpus') },
      } as never);
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('is not readable JSON');
    } finally {
      await served.close();
    }
  });
});

/**
 * The bill is what a derivation has to beat, so its arithmetic is asserted rather than printed.
 *
 * The fixture is three rows where the model named a mark the table refuses: two labelled `Scatter` on
 * a table with one measure (the shape 27 of the corpus's 33 owed scatter rows have), and one labelled
 * `Bar` where the model said `gauge`. The first two are owed — a scatter label is a family `scatter`
 * covers — and the third is not, which is the column that stops the bill from reading like an
 * opportunity: 60 of the corpus's 109 refused rows are owed, and the bill has to say which is which.
 */
describe('the bill for the rows the table answered instead', () => {
  const BILL_ROWS: readonly ProfileInput[] = [
    row('Correlate the two temperatures', 'Scatter', 'country,value\nUS,5\nDE,9\nFR,2'),
    row('Correlate the two rates', 'Scatter', 'country,value\nUS,1\nDE,2\nFR,3'),
    row('Which country is highest', 'Bar', 'country,value\nUS,5\nDE,9\nFR,2'),
  ];
  const BILL_CHOICES: readonly (string | null)[] = ['scatter', 'scatter', 'gauge'];

  it('counts one line per mark the table refused, and owes only the families the label names', async () => {
    const shipped = await shipReport(BILL_ROWS, BILL_CHOICES, 'a-model', { roster: rosterOf(BILL_ROWS) });
    const bill = shipped.refusals;
    expect(bill.map((line) => [line.mark, line.rows, line.owed])).toEqual([
      ['scatter', 2, 2],
      ['gauge', 1, 0],
    ]);
    // What the table drew on the owed rows, which is the picture a derivation has to beat.
    expect(bill[0]?.instead.reduce((sum, one) => sum + one.rows, 0)).toBe(2);
    expect(bill[0]?.instead.every((one) => one.mark !== 'scatter')).toBe(true);
    // Nothing was drawn for a row no label asked about.
    expect(bill[1]?.instead).toEqual([]);
  });

  it('orders a tie by name, because a bill read twice must be the same bill', async () => {
    // Two marks refused once each, and one of them drawn two different ways on two rows: the two sorts
    // in `refusalBill` both tie, and a tie broken by insertion order would print a different table for
    // the same artifact depending on which row was read first.
    const tied: readonly ProfileInput[] = [
      row('Correlate revenue', 'Scatter', 'country,value\nUS,5\nDE,9\nFR,2'),
      row('Correlate revenue over time', 'Scatter', 'year,value\n2019,3\n2020,4\n2021,8'),
      row('Spread of revenue', 'Boxplot', 'country,value\nUS,1\nDE,2\nFR,3'),
      row('Spread of the rates', 'Boxplot', 'country,value\nUS,4\nDE,5\nFR,6'),
    ];
    const shipped = await shipReport(tied, ['scatter', 'scatter', 'boxplot', 'boxplot'], 'a-model', {
      roster: rosterOf(tied),
    });
    expect(shipped.refusals.map((line) => [line.mark, line.rows, line.owed])).toEqual([
      ['boxplot', 2, 2],
      ['scatter', 2, 2],
    ]);
    expect(shipped.refusals[1]?.instead.map((one) => one.mark)).toEqual(['bar', 'line']);
  });

  it('refuses three lists that cannot be billed together', () => {
    expect(() => refusalBill(BILL_ROWS, BILL_CHOICES.slice(0, 2), [])).toThrow(/cannot be billed together/);
  });

  it('refuses a refused row with no answer on disk, which is the model deciding by silence', () => {
    const decisions = [{ mark: 'bar', source: 'product', product: 'bar', reason: 'not-admitted' }] as const;
    expect(() => refusalBill([BILL_ROWS[0] as ProfileInput], [null], [...decisions])).toThrow(/no answer is on disk/);
  });

  it('refuses a bill that lost a row, and one whose substitutions do not add up', () => {
    // The bill is the audit trail of the vetoes, so a row that is refused and not billed is a row
    // nobody can price — and `not-admitted` is the number that says how many there should be.
    const short: RefusalBill = { mark: 'scatter', rows: 1, owed: 1, instead: [{ mark: 'bar', rows: 1 }] };
    expect(() =>
      assertShip(
        report({
          shipped: counts({ fromModel: 0, fromProduct: 2, reasons: { 'no-advice': 0, unavailable: 0, unlisted: 0, 'not-admitted': 2, unchartable: 0 } }),
          refusals: [short],
        }),
      ),
    ).toThrow(/the refusal bill covers 1 rows and the shipped reading counted 2 refused/);
    expect(() =>
      assertShip(
        report({
          shipped: counts({ fromModel: 1, fromProduct: 1, reasons: { 'no-advice': 0, unavailable: 0, unlisted: 0, 'not-admitted': 1, unchartable: 0 } }),
          refusals: [{ mark: 'scatter', rows: 1, owed: 1, instead: [] }],
        }),
      ),
    ).toThrow(/1 owed and 0 substitutions/);
  });

  it('prints the bill only when there is one', async () => {
    // A report with no refusals must not grow an empty table: five lines that say "nothing" read like
    // a measurement of nothing.
    expect(describeShip(report()).some((line) => line.includes('what the table answered instead'))).toBe(false);
    const shipped = await shipReport(BILL_ROWS, BILL_CHOICES, 'a-model', { roster: rosterOf(BILL_ROWS) });
    const printed = describeShip(shipped).join('\n');
    expect(printed).toContain('what the table answered instead');
    expect(printed).toMatch(/scatter\s+2\s+2/);
    expect(printed).toContain('nothing: the label never asked for it');
  });
});
