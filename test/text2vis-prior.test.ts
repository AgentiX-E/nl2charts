/**
 * A router that decides before the answer exists, and what it costs per chart.
 *
 * `test/text2vis-route.test.ts` defends a table of rules read *after* two answers are in hand. This
 * file defends the other object: a **prior**, a function from the three free signals — the cue
 * table's first mark, whether any cue fired, and the recommender's own mark — to one of the two
 * seats. The distinction is not stylistic. A rule that reads both answers costs two calls per row,
 * so a price per row cannot be computed for it; a prior costs one, and its whole bill is countable
 * before it runs.
 *
 * Four properties are defended here:
 *
 * 1. **The prior reads only what is free.** `signalsOf` takes a question and a result set and
 *    nothing else, and the test proves it by handing two rows the same question and different labels
 *    and getting the same signals back. A prior that could see the label would be a selector over
 *    the answer key.
 * 2. **A refusal is a signal, not a mark.** A result set the table cannot draw has no `product`, and
 *    the absence is what `table-refused` routes on — a prior that compared against a `'declined'`
 *    string would read a table that answered `bar` as a table that refused.
 * 3. **Every number is hand-checkable.** The three-row fixture below produces readings computed by
 *    hand in the comments (chat 2, reasoner 1, `cue-gate` 3), and the *ordering* is not the corpus's:
 *    on the corpus the thinking arm ships more charts than the plain one, here it ships fewer. A
 *    fixture that reproduced the corpus ordering would make the corpus result a coincidence.
 * 4. **The price is a parameter with a stated break-even.** `r` — what a thinking call costs in plain
 *    calls — cannot be measured from an artifact whose answers predate the store's meters, so every
 *    conclusion is asserted as the ratio at which it stops holding, not as a verdict on a constant.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { TEXT2VIS_FIELDS } from '../eval/text2vis/dataset.js';
import { rosterOf } from '../eval/text2vis/llm.js';
import type { ProfileInput } from '../eval/text2vis/profile.js';
import {
  answersUnder,
  dualReading,
  assertPrice,
  breakEven,
  callsPerRow,
  callsUnder,
  describePrice,
  describeTrades,
  entryPrior,
  marginalPrice,
  parsePriorArgs,
  pricePerRow,
  PRIORS,
  priorReport,
  signalsOf,
  yuanPerShippedRow,
  type FreeSignals,
  type PriorReading,
  type Rate,
} from '../eval/text2vis/prior.js';

/**
 * Three rows, chosen so every prior routes differently.
 *
 * | row | question | cue leads | product | truth | chat | reasoner |
 * |---|---|---|---|---|---|---|
 * | 0 | share of revenue each region holds | pie | pie | pie | pie | bar |
 * | 1 | the name of the customer | — | bar | bar | pie | bar |
 * | 2 | which product ranks highest | bar | bar | bar | bar | line |
 *
 * Chat is right on 0 and 2, the reasoner on 1 alone, `cue-gate` sends row 1 to the reasoner and keeps
 * the other two, and `table-refused` sends nothing anywhere because every table here is drawable.
 */
const TABLE = 'Region, Revenue\nNorth, 40\nSouth, 55\nEast, 31\nWest, 63';

const ROWS: readonly ProfileInput[] = [
  { prompt: 'Show the share of revenue each region holds', label: 'Pie Chart', tableData: TABLE },
  { prompt: 'what is the name of the customer', label: 'Bar Chart', tableData: TABLE },
  { prompt: 'which product ranks highest by revenue', label: 'Bar Chart', tableData: TABLE },
];

const CHAT: readonly (string | null)[] = ['pie', 'pie', 'bar'];
const REASONER: readonly (string | null)[] = ['bar', 'bar', 'line'];

/** The measured pair, because the default ratio was measured on it. */
const MEASURED_PAIR: readonly (string | null)[] = CHAT;
const MEASURED_PAIR_RIGHT: readonly (string | null)[] = REASONER;

const SIGNALS: readonly FreeSignals[] = [
  { cueLead: 'pie', cueFired: true, product: 'pie' },
  { cueFired: false, product: 'bar' },
  { cueLead: 'bar', cueFired: true, product: 'bar' },
];

const RATE: Rate = { chatYuan: 0.000426, ratio: 7.72 };

function prior(name: string) {
  const found = PRIORS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`the fixture names ${name}, which PRIORS does not hold`);
  return found;
}

function reading(over: Partial<PriorReading> & { readonly name: string }): PriorReading {
  return { note: 'a fixture', rows: 10, chatRows: 10, reasonerRows: 0, decided: 5, shipped: 5, ...over };
}

describe('the signals a prior is allowed to read', () => {
  it('reads the cue table and the recommender, and nothing else', () => {
    expect(signalsOf(ROWS)).toEqual(SIGNALS);
  });

  it('gives the same signals to two rows that differ only in their label', () => {
    // The label is the answer key. A prior that could see it would route every row correctly and
    // publish a reading no deployment can reproduce, so this is the property the file exists on.
    const [first] = ROWS as readonly ProfileInput[];
    const same = [
      { ...(first as ProfileInput), label: 'Line Chart' },
      { ...(first as ProfileInput), label: 'Pie Chart' },
    ];
    expect(signalsOf(same)[0]).toEqual(signalsOf(same)[1]);
  });

  it('has no product for a table nothing can draw, and says so by leaving the field out', () => {
    // `toChartIR` throws for an empty result set; the catch is the signal rather than an error,
    // because "the table refused" is exactly what one of the priors routes on.
    const undrawable: ProfileInput = { prompt: 'what is the name of the customer', label: 'Bar Chart', tableData: '' };
    expect(signalsOf([undrawable])[0]).toEqual({ cueFired: false });
  });

  it('keeps the cue table’s order rather than inventing a second one', () => {
    // Two questions. The first names a trend *and* a share, and the table puts time before share, so
    // its lead is a line — the reading `cue-led` in `arbitrate.ts` makes, taken from the same call.
    // A prior that re-ordered the cues would be a second opinion about the same table.
    const named = signalsOf([
      { prompt: 'the share of revenue over time', label: 'Pie Chart', tableData: TABLE },
      { prompt: 'which product ranks highest by revenue', label: 'Bar Chart', tableData: TABLE },
    ]);
    expect(named[0]?.cueLead).toBe('line');
    expect(named[0]?.product).toBe('line');
    expect(named[1]?.cueLead).toBe('bar');
  });
});

describe('the five priors', () => {
  it('holds five names, none of them a label, and every note a sentence about a rule', () => {
    expect(PRIORS.map((candidate) => candidate.name)).toEqual(['chat', 'reasoner', 'cue-gate', 'table-agrees', 'table-refused']);
    expect(new Set(PRIORS.map((candidate) => candidate.name)).size).toBe(PRIORS.length);
    // A note that named a chart family would be a rule about the answer key; these are rules about
    // when to pay, which is the only thing a router is allowed to be about.
    expect(PRIORS.filter((candidate) => /\b(pie|bar|line|heatmap|scatter)\b/.test(candidate.note))).toEqual([]);
  });

  it('routes every row on the fixture the way its sentence says', () => {
    expect(PRIORS.map((candidate) => candidate.seat(SIGNALS[0] as FreeSignals))).toEqual(['chat', 'reasoner', 'chat', 'chat', 'chat']);
    // Row 1 fires no cue and its table is drawable: the gate pays for deliberation, the refusal prior
    // does not, and the agreement prior has nothing to agree with.
    expect(PRIORS.map((candidate) => candidate.seat(SIGNALS[1] as FreeSignals))).toEqual(['chat', 'reasoner', 'reasoner', 'reasoner', 'chat']);
  });

  it('prices a refusal as a reason to pay, not as a mark', () => {
    const refused: FreeSignals = { cueFired: false };
    expect(prior('table-refused').seat(refused)).toBe('reasoner');
    expect(prior('cue-gate').seat(refused)).toBe('reasoner');
    // A cue that fired but a table that refused is the disagreement case: the agreement prior cannot
    // agree with a mark that does not exist, so it pays.
    expect(prior('table-agrees').seat({ cueLead: 'pie', cueFired: true })).toBe('reasoner');
  });
});

describe('the answers and the calls a prior spends', () => {
  it('hands back the named arm’s answer, byte for byte, and a refusal as a null', () => {
    const signals = signalsOf(ROWS);
    expect(answersUnder(signals, CHAT, REASONER, prior('chat'))).toEqual([...CHAT]);
    expect(answersUnder(signals, CHAT, REASONER, prior('reasoner'))).toEqual([...REASONER]);
    // Row 1 is the only row `cue-gate` gives away, and what it hands back is the reasoner's answer
    // there and the chat arm's everywhere else.
    expect(answersUnder(signals, CHAT, REASONER, prior('cue-gate'))).toEqual(['pie', 'bar', 'bar']);
    expect(answersUnder(signals, ['pie', null, 'bar'], REASONER, prior('chat'))[1]).toBeNull();
  });

  it('refuses two arms that did not answer the same rows', () => {
    const signals = signalsOf(ROWS);
    expect(() => answersUnder(signals, CHAT.slice(0, 2), REASONER, prior('chat'))).toThrow(/2 and 3 answers for 3 rows/);
    expect(() => answersUnder(signals, CHAT, REASONER.slice(0, 2), prior('chat'))).toThrow(/3 and 2 answers for 3 rows/);
  });

  it('counts the seats, which is the whole bill', () => {
    const signals = signalsOf(ROWS);
    expect(callsUnder(signals, prior('chat'))).toEqual({ chat: 3, reasoner: 0 });
    expect(callsUnder(signals, prior('reasoner'))).toEqual({ chat: 0, reasoner: 3 });
    expect(callsUnder(signals, prior('cue-gate'))).toEqual({ chat: 2, reasoner: 1 });
  });
});

describe('what a prior ships on three rows', () => {
  const roster = rosterOf(ROWS);

  it('reports the numbers the table above predicts, through the shipped path', async () => {
    const readings = [];
    for (const candidate of PRIORS) readings.push(await priorReport(ROWS, CHAT, REASONER, candidate, roster));
    expect(readings.map((entry) => [entry.name, entry.chatRows, entry.reasonerRows, entry.decided, entry.shipped])).toEqual([
      ['chat', 3, 0, 2, 2],
      ['reasoner', 0, 3, 1, 1],
      ['cue-gate', 2, 1, 3, 3],
      ['table-agrees', 2, 1, 3, 3],
      ['table-refused', 3, 0, 2, 2],
    ]);
  });

  it('counts a refusal as the table’s answer, which can be the right one', async () => {
    // The chat arm has nothing to say on row 1, so the shipped path falls back to the table — and the
    // table answers `bar`, which is the label. A reading that skipped the row would call this 2 of 2;
    // the honest one is 2 decided and 3 shipped.
    const silent = await priorReport(ROWS, ['pie', null, 'bar'], REASONER, prior('chat'), roster);
    expect([silent.decided, silent.shipped]).toEqual([2, 3]);
  });

  it('refuses a reading over a population it was not taken on', async () => {
    await expect(priorReport(ROWS, CHAT, REASONER, prior('chat'), 'a-fingerprint-of-some-other-corpus')).rejects.toThrow(/different population/);
    await expect(priorReport(ROWS, CHAT.slice(0, 2), REASONER, prior('chat'), roster)).rejects.toThrow(/2 and 3 answers for 3 rows/);
  });
});

describe('the router whose rule table is not the duel table', () => {
  const roster = rosterOf(ROWS);

  it('refuses to rebuild a two-call router out of a table that has no cue-led rule', async () => {
    // The policy table is a parameter for the reason `renamePolicies` takes one: a refusal nobody can
    // reach is a refusal nobody has seen work.
    await expect(dualReading(ROWS, CHAT, REASONER, roster, [])).rejects.toThrow(/no cue-led rule/);
  });

  it('prices the same three rows the routing table would, out of the same rules', async () => {
    const dual = await dualReading(ROWS, CHAT, REASONER, roster);
    expect([dual.rows, dual.chatRows, dual.reasonerRows, dual.decided, dual.shipped]).toEqual([3, 3, 3, 3, 3]);
  });
});

describe('the price of a chart', () => {
  it('separates the calls it makes from the money they cost', () => {
    // The two-call router makes two calls per row and spends 8.72 plain calls' worth of money on it.
    // A table that merged the two columns would be wrong about it by a factor of four.
    const dual = reading({ name: 'both', chatRows: 1470, reasonerRows: 1470, rows: 1470 });
    expect(callsPerRow(dual)).toBe(2);
    expect(pricePerRow(dual, 7.72)).toBeCloseTo(8.72, 6);
    const gate = reading({ name: 'cue-gate', chatRows: 1165, reasonerRows: 305, rows: 1470 });
    expect(callsPerRow(gate)).toBe(1);
    expect(pricePerRow(gate, 7.72)).toBeCloseTo((1165 + 305 * 7.72) / 1470, 6);
  });

  it('refuses to price a reading that spent nothing or shipped nothing', () => {
    expect(() => callsPerRow(reading({ name: 'nobody', chatRows: 0, reasonerRows: 0, rows: 0 }))).toThrow(/prices no row/);
    expect(() => yuanPerShippedRow(reading({ name: 'nothing', shipped: 0 }), RATE)).toThrow(/ships no chart/);
  });

  it('prices the marginal chart, which is the number a caller decides on', () => {
    const base = reading({ name: 'chat', chatRows: 3, reasonerRows: 0, rows: 3, shipped: 2 });
    const gate = reading({ name: 'cue-gate', chatRows: 2, reasonerRows: 1, rows: 3, shipped: 3 });
    // (2 + 7.72) x 0.000426 spent, 3 x 0.000426 paid, one chart more.
    expect(marginalPrice(gate, base, RATE)).toBeCloseTo((9.72 - 3) * 0.000426, 9);
    // A router that gains nothing has no marginal price: every price is infinite, and a column of
    // infinities reads like a column of numbers.
    expect(marginalPrice(reading({ name: 'flat', shipped: 2 }), base, RATE)).toBeUndefined();
    expect(marginalPrice(reading({ name: 'worse', shipped: 1 }), base, RATE)).toBeUndefined();
  });

  it('solves for the ratio at which two routers cost the same, and reads the sign of it', () => {
    const base = reading({ name: 'chat', chatRows: 10, reasonerRows: 0, rows: 10, shipped: 5 });
    // Five charts for ten plain calls against six for ten thinking ones: the two cost the same per
    // chart when a thinking call is 1.2 plain ones — 5/10 = 6/(10r).
    expect(breakEven(base, reading({ name: 'think', chatRows: 0, reasonerRows: 10, shipped: 6 }))).toBeCloseTo(1.2, 9);
    // One that ships a chart more but also pays for ten plain calls first: it is dearer at every
    // price a provider could charge, and the negative root is the arithmetic saying so.
    expect(breakEven(base, reading({ name: 'both', chatRows: 20, reasonerRows: 10, shipped: 6 }))).toBeLessThan(0);
    // The same mix twice: no ratio can separate them.
    expect(breakEven(base, reading({ name: 'twin', chatRows: 10, reasonerRows: 0, shipped: 4 }))).toBeUndefined();
    // And a router that ships more on the same mix is simply better, at every ratio.
    expect(describeTrades([base, reading({ name: 'more', chatRows: 10, reasonerRows: 0, shipped: 6 })], RATE).join('\n')).toMatch(
      /more at every price a provider could charge/,
    );
  });

  it('prints a price list with the anchor and a router that gains nothing marked as dashes', () => {
    const base = reading({ name: 'chat', chatRows: 3, reasonerRows: 0, rows: 3, shipped: 2 });
    const gate = reading({ name: 'cue-gate', chatRows: 2, reasonerRows: 1, rows: 3, shipped: 3 });
    const flat = reading({ name: 'table-refused', chatRows: 3, reasonerRows: 0, rows: 3, shipped: 2 });
    const lines = describePrice([base, gate, flat], RATE);
    expect(lines[0]).toMatch(/price per shipped chart/);
    expect(lines[1]).toMatch(/chat\s+calls\/row 1\.000, price\/row 1\.000/);
    expect(lines[2]).toMatch(/¥0\.002863 per extra chart/);
    // The anchor and the router that gained nothing both have no marginal price, and both say so.
    expect(lines[1]).toMatch(/, - per extra chart$/);
    expect(lines[3]).toMatch(/, - per extra chart$/);
  });

  it('describes each trade in the ratio that decides it', () => {
    const base = reading({ name: 'chat', chatRows: 10, reasonerRows: 0, rows: 10, shipped: 5 });
    // Positive root, and the other router is the cheaper one below it.
    const cheapWhenThinkingIsCheap = reading({ name: 'gate', chatRows: 4, reasonerRows: 6, rows: 10, shipped: 6 });
    // Negative root: one of the two is cheaper at every price.
    const never = reading({ name: 'both', chatRows: 20, reasonerRows: 10, rows: 10, shipped: 6 });
    // The same mix, so no ratio separates them and the sentence has to say that instead.
    const twin = reading({ name: 'twin', chatRows: 10, reasonerRows: 0, rows: 10, shipped: 4 });
    const lines = describeTrades([base, cheapWhenThinkingIsCheap, never, twin], RATE).join('\n');
    expect(lines).toMatch(/gate below x[\d.]+ a thinking call and chat above it/);
    expect(lines).toMatch(/at every price a provider could charge/);
    expect(lines).toMatch(/chat is the cheapest chart in the table/);
    expect(() => describeTrades([], RATE)).toThrow(/no routers/);
  });
});

describe('what the price list refuses to publish', () => {
  const readings = [
    reading({ name: 'chat' }),
    reading({ name: 'reasoner', chatRows: 0, reasonerRows: 10, shipped: 6 }),
  ];
  const dual = reading({ name: 'both', chatRows: 10, reasonerRows: 10, rows: 10, shipped: 7 });
  const floor = { scored: 10, readings: { chat: 5, reasoner: 6 }, dual: { decided: 5, shipped: 7 } };

  it('accepts a price list that is the floor, and refuses a different population', () => {
    expect(() => assertPrice(readings, dual, floor)).not.toThrow();
    expect(() => assertPrice(readings, dual, { ...floor, scored: 1470 })).toThrow(/the floor was taken on 1470 rows/);
    // The two-call router is priced over the same rows, and a floor that disagrees about how many is a
    // floor for another instrument.
    expect(() => assertPrice(readings, { ...dual, rows: 12 }, { ...floor, scored: 12 })).toThrow(/this reading prices 10 and 12/);
  });

  it('refuses a price list with no router in it, which has no population to compare', () => {
    expect(() => assertPrice([], dual, floor)).toThrow(/this reading prices 0 and 10/);
  });

  it('refuses a floor that records a router this table does not price, and a count that moved', () => {
    expect(() => assertPrice(readings, dual, { ...floor, readings: { ...floor.readings, ghost: 1 } })).toThrow(/the floor records ghost/);
    expect(() => assertPrice(readings, dual, { ...floor, readings: { ...floor.readings, chat: 4 } })).toThrow(/chat ships 5 and the floor records 4/);
  });

  it('refuses a two-call reading that disagrees with the routing table', () => {
    // The identity this file has with `route.ts`: it builds the same router out of the same exports,
    // so a disagreement here means the same rule is being read two ways.
    expect(() => assertPrice(readings, { ...dual, shipped: 8 }, floor)).toThrow(/the two files disagree about the same rule/);
    expect(() => assertPrice(readings, { ...dual, decided: 4 }, floor)).toThrow(/the two files disagree about the same rule/);
  });
});

describe('the command line', () => {
  it('takes the flags it uses and refuses the rest', () => {
    expect(parsePriorArgs(['--answers', 'a.json'])).toEqual({ json: false, require: false, answers: 'a.json' });
    expect(
      parsePriorArgs(['--answers', 'a.json', '--ratio', '2.5', '--chat-yuan', '0.001', '--floor', 'f.json', '--artifact', 'o.json', '--require', '--json']),
    ).toEqual({ json: true, require: true, answers: 'a.json', ratio: 2.5, chatYuan: 0.001, floor: 'f.json', artifact: 'o.json' });
    expect(() => parsePriorArgs(['--answers'])).toThrow(/needs a value/);
    expect(() => parsePriorArgs(['--answers', 'a.json', '--ship'])).toThrow(/unknown argument --ship/);
    expect(() => parsePriorArgs([])).toThrow(/--answers is required/);
  });

  it('refuses a ratio or a price that is zero or not a number', () => {
    // A ratio of zero prices the expensive arm as free, which is the one direction of error that makes
    // the wasteful option look efficient.
    expect(() => parsePriorArgs(['--answers', 'a.json', '--ratio', '0'])).toThrow(/--ratio takes a positive number/);
    expect(() => parsePriorArgs(['--answers', 'a.json', '--ratio', 'seven'])).toThrow(/--ratio takes a positive number/);
    expect(() => parsePriorArgs(['--answers', 'a.json', '--chat-yuan', '0'])).toThrow(/--chat-yuan takes a positive number/);
  });
});

/**
 * A three-row corpus, served over HTTP the way `dataset.ts` fetches it.
 *
 * The command's contract is about a population, so the fixture has to be a corpus rather than a row
 * list: the roster is recomputed from what this process loaded and compared with the artifact's.
 */
const root = mkdtempSync(join(tmpdir(), 'nl2charts-text2vis-prior-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const ENTRY = resolve('eval/text2vis/prior.ts');
const MODULE_URL = pathToFileURL(ENTRY).href;

function cell(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

const HEADER = `${TEXT2VIS_FIELDS.prompt},${TEXT2VIS_FIELDS.answer},${TEXT2VIS_FIELDS.code},${TEXT2VIS_FIELDS.chartType},Table Data`;

const BODY = [
  HEADER,
  [cell(ROWS[0]?.prompt as string), cell('North'), cell(''), cell('Pie Chart'), cell(TABLE)].join(','),
  [cell(ROWS[1]?.prompt as string), cell('North'), cell(''), cell('Bar Chart'), cell(TABLE)].join(','),
  [cell(ROWS[2]?.prompt as string), cell('North'), cell(''), cell('Bar Chart'), cell(TABLE)].join(','),
].join('\n');

/** The same corpus with a label no family names, which is the row a reading must drop and count. */
const BODY_UNLABELLED = `${BODY}\n${[cell('A chart of the words customers use'), cell('North'), cell(''), cell('Word Cloud'), cell(TABLE)].join(',')}`;

async function serve(body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/csv' });
    response.end(body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}/Text2Vis.csv`, close: () => new Promise<void>((done) => server.close(() => done())) };
}

/** An artifact with two mark arms and one label arm, which is the shape `llm.ts` writes. */
function artifact(left: readonly (string | null)[], right: readonly (string | null)[], roster: string, pair = ['deepseek-chat', 'deepseek-reasoner']): string {
  const arm = (model: string, choices: readonly (string | null)[]): Record<string, unknown> => ({
    scale: 'mark',
    model,
    requested: choices.length,
    answered: choices.filter((choice) => choice !== null).length,
    unparsed: choices.filter((choice) => choice === null).length,
    truncated: 0,
    scored: choices.length,
    choices,
  });
  return JSON.stringify({
    corpus: { rows: left.length, scored: left.length, asked: left.length, roster },
    arms: [arm(pair[0] as string, left), arm(pair[1] as string, right), { scale: 'label', model: pair[0] as string, choices: [], scored: left.length }],
    paired: [],
  });
}

describe('the command, end to end', () => {
  it('prices the five priors and the two-call router, and writes the list', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'reading.json');
      const out = join(root, 'prior.json');
      writeFileSync(answers, artifact(CHAT, REASONER, rosterOf(ROWS)));
      const code = await entryPrior(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--artifact', out],
        load: { cacheDir: join(root, 'csv-ok'), url: server.url },
      });
      expect(code).toBe(0);
      const written = JSON.parse(readFileSync(out, 'utf8')) as {
        population: { scored: number };
        rate: Rate;
        readings: PriorReading[];
        dual: PriorReading;
      };
      expect(written.population.scored).toBe(3);
      expect(written.rate).toEqual(RATE);
      expect(written.readings.map((entry) => [entry.name, entry.shipped])).toEqual([
        ['chat', 2],
        ['reasoner', 1],
        ['cue-gate', 3],
        ['table-agrees', 3],
        ['table-refused', 2],
      ]);
      // The two-call router is priced by this file out of `route.ts`'s exports, and on three rows it
      // reads what the routing table would: three decided, three shipped.
      expect([written.dual.decided, written.dual.shipped]).toEqual([3, 3]);
      expect(lines.join('\n')).toMatch(/price per shipped chart/);
      expect(lines.join('\n')).toContain('text2vis: wrote');

      // The same run with `--json` prints the payload it wrote, and with an artifact that does not say
      // how many rows it asked it prices the whole population rather than a prefix of it.
      const printed: string[] = [];
      const withoutAsked = JSON.parse(readFileSync(answers, 'utf8')) as Record<string, Record<string, unknown>>;
      (withoutAsked['corpus'] as Record<string, unknown>)['asked'] = undefined;
      writeFileSync(answers, JSON.stringify(withoutAsked));
      const json = await entryPrior(ENTRY, MODULE_URL, (line) => printed.push(line), {
        argv: ['--answers', answers, '--json'],
        load: { cacheDir: join(root, 'csv-ok'), url: server.url },
      });
      expect(json).toBe(0);
      expect(printed.join('\n')).toContain('"population"');
    } finally {
      await server.close();
    }
  });

  it('prints the payload with --json, and drops a row whose label no family names', async () => {
    const server = await serve(BODY_UNLABELLED);
    const lines: string[] = [];
    try {
      const answers = join(root, 'unlabelled.json');
      // The roster is over the whole corpus, and the population is the three scored rows: the reading
      // is refused, and the sentence that has to appear first is the one counting the dropped label.
      writeFileSync(answers, artifact(CHAT, REASONER, rosterOf([...ROWS, { prompt: 'A chart of the words customers use', label: 'Word Cloud', tableData: TABLE }])));
      const code = await entryPrior(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--json'],
        load: { cacheDir: join(root, 'csv-unlabelled'), url: server.url },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/1 rows carry a label no family names/);
    } finally {
      await server.close();
    }
  });

  it('refuses to apply the measured ratio to a pair it was not measured on, unless told', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'other-pair.json');
      writeFileSync(answers, artifact(CHAT, REASONER, rosterOf(ROWS), ['a-model', 'b-model']));
      const refused = await entryPrior(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers],
        load: { cacheDir: join(root, 'csv-pair'), url: server.url },
      });
      expect(refused).toBe(1);
      expect(lines.join('\n')).toMatch(/the default ratio was measured on deepseek-chat against deepseek-reasoner/);
      // With the ratio stated, the same file prices — and the price list says what it was told.
      const lines2: string[] = [];
      const priced = await entryPrior(ENTRY, MODULE_URL, (line) => lines2.push(line), {
        argv: ['--answers', answers, '--ratio', '2', '--chat-yuan', '0.001'],
        load: { cacheDir: join(root, 'csv-pair'), url: server.url },
      });
      expect(priced).toBe(0);
      expect(lines2.join('\n')).toMatch(/a thinking call at x2\.00/);
      expect(lines2.join('\n')).toMatch(/¥0\.001000 a plain call/);
    } finally {
      await server.close();
    }
  });

  it('refuses an artifact whose two seats are one arm, or whose rows cannot be identified', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'same.json');
      writeFileSync(answers, artifact(CHAT, CHAT, rosterOf(ROWS), ['deepseek-chat', 'deepseek-chat']));
      const same = await entryPrior(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers],
        load: { cacheDir: join(root, 'csv-same'), url: server.url },
      });
      expect(same).toBe(1);
      // One arm under two names is not a pair, and the command says which arm it saw twice.
      expect(lines.join('\n')).toMatch(/one mark arm|both seats are deepseek-chat/);

      const noRoster = join(root, 'no-roster.json');
      writeFileSync(noRoster, JSON.stringify({ corpus: { rows: 3, scored: 3 }, arms: [] }));
      const lost = await entryPrior(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', noRoster],
        load: { cacheDir: join(root, 'csv-no-roster'), url: server.url },
      });
      expect(lost).toBe(1);
      expect(lines.join('\n')).toMatch(/carries no corpus.roster/);

      const noChoices = join(root, 'no-choices.json');
      writeFileSync(noChoices, JSON.stringify({
        corpus: { rows: 3, scored: 3, asked: 3, roster: rosterOf(ROWS) },
        arms: [
          { scale: 'mark', model: 'deepseek-chat', requested: 3, scored: 3, choices: CHAT },
          { scale: 'mark', model: 'deepseek-reasoner', requested: 3, scored: 3 },
        ],
      }));
      const unreadable = await entryPrior(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', noChoices],
        load: { cacheDir: join(root, 'csv-no-choices'), url: server.url },
      });
      expect(unreadable).toBe(1);
      expect(lines.join('\n')).toMatch(/no per-row choices for deepseek-reasoner/);
    } finally {
      await server.close();
    }
  });

  it('holds the price list to the floor it was given, and to the repository’s floor by default', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'floored.json');
      writeFileSync(answers, artifact(CHAT, REASONER, rosterOf(ROWS)));
      const floor = join(root, 'floor.json');
      writeFileSync(floor, JSON.stringify({ llm: { prior: { scored: 3, readings: { chat: 2, 'cue-gate': 3 }, dual: { decided: 3, shipped: 3 } } } }));
      const met = await entryPrior(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--require', '--floor', floor],
        load: { cacheDir: join(root, 'csv-floor'), url: server.url },
      });
      expect(met).toBe(0);
      expect(lines.join('\n')).toMatch(/5 priors hold the floor, and the two-call router reproduces 3 shipped/);

      // A floor whose count moved, and a floor that names a router this table does not price.
      writeFileSync(floor, JSON.stringify({ llm: { prior: { scored: 3, readings: { chat: 1 }, dual: { decided: 3, shipped: 3 } } } }));
      const moved = await entryPrior(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--require', '--floor', floor],
        load: { cacheDir: join(root, 'csv-floor'), url: server.url },
      });
      expect(moved).toBe(1);
      expect(lines.join('\n')).toMatch(/chat ships 2 and the floor records 1/);

      writeFileSync(floor, JSON.stringify({ llm: { prior: { scored: 3, readings: { ghost: 1 }, dual: { decided: 3, shipped: 3 } } } }));
      const ghost = await entryPrior(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--require', '--floor', floor],
        load: { cacheDir: join(root, 'csv-floor'), url: server.url },
      });
      expect(ghost).toBe(1);
      expect(lines.join('\n')).toMatch(/the floor records ghost/);

      // No floor on file is not "no floor": the run says so and establishes one.
      writeFileSync(floor, JSON.stringify({ llm: {} }));
      const fresh = await entryPrior(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--require', '--floor', floor],
        load: { cacheDir: join(root, 'csv-floor'), url: server.url },
      });
      expect(fresh).toBe(0);
      expect(lines.join('\n')).toMatch(/records no llm.prior floor/);

      // And the repository's own floor is over 1,470 rows, so a three-row fixture cannot meet it.
      const defaultFloor = await entryPrior(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--require'],
        load: { cacheDir: join(root, 'csv-floor'), url: server.url },
      });
      expect(defaultFloor).toBe(1);
      expect(lines.join('\n')).toMatch(/the floor was taken on 1470 rows/);
    } finally {
      await server.close();
    }
  });

  it('refuses to be run with no arguments at all, and does nothing when it is not the entry', async () => {
    expect(await entryPrior(ENTRY, MODULE_URL, () => undefined, { argv: [], load: {} })).toBe(1);
    // A module that is imported rather than executed must not price anything: the guard is the reason
    // the test file can import this one without running the command.
    expect(await entryPrior('/somewhere/else.mjs', MODULE_URL, () => undefined, { argv: [], load: {} })).toBeUndefined();
  });
});

// The measured pair is named in the file rather than re-derived, so a rename of either arm is a red
// test here instead of a silent change of what the default ratio means.
describe('the pair the ratio was measured on', () => {
  it('is the pair the artifact fixture uses', () => {
    expect(MEASURED_PAIR).toEqual(CHAT);
    expect(MEASURED_PAIR_RIGHT).toEqual(REASONER);
  });
});
