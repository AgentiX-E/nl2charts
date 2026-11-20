/**
 * Arbitration: choosing between two answers without looking at the label.
 *
 * The 991-row union this repository measured is not a policy — it is what a selector could reach if it
 * knew, row by row, which of the two systems was right, and knowing that is the label. So the only
 * thing worth building is a rule that reads the *answers* and the *question*, and the only thing worth
 * measuring is how much of the 519-row disagreement such a rule can route correctly.
 *
 * Three properties are defended here, and each of them is a way of publishing a better number than the
 * instrument earned:
 *
 * 1. **A policy cannot see the label.** `Dispute` carries the product's answer, the cue table's lead
 *    and the model's answer — and nothing else. The test asserts the shape at runtime, so a field
 *    added later (an `expected`, a `correct`) fails here rather than in a review.
 * 2. **Every policy's score is a sum of three counts**, `agreed hits + rows it kept from the product +
 *    rows it took from the model`. The scorer's own `top1` is asserted to equal that sum, so a policy
 *    that returns an answer neither system gave is refused instead of being credited.
 * 3. **A reading of a different population is refused.** The artifact names its rows by fingerprint,
 *    and the arbitration recomputes it from the corpus it loaded: the answers and the rows they are
 *    attached to cannot drift apart, which is the defect the model arm itself found twice.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { RecommendableMark } from '@agentix-e/nl2charts-chart';
import { TEXT2VIS_FIELDS } from '../eval/text2vis/dataset.js';
import {
  assertArbitration,
  arbitrate,
  arbitrateDisputes,
  describeArbitration,
  disputeOf,
  entryArbitrate,
  parseArbitrateArgs,
  type Dispute,
  type PolicyReading,
} from '../eval/text2vis/arbitrate.js';
import { rosterOf } from '../eval/text2vis/llm.js';
import { profileAnswer, type ChartAnswer, type ProfileInput } from '../eval/text2vis/profile.js';
import type { ChartFamily } from '../eval/text2vis/rule.js';

const root = mkdtempSync(join(tmpdir(), 'nl2charts-text2vis-arbitrate-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const ENTRY = resolve('eval/text2vis/arbitrate.ts');
const MODULE_URL = pathToFileURL(ENTRY).href;

function answer(mark: RecommendableMark | 'declined'): ChartAnswer {
  return mark === 'declined' ? { mark: 'declined', families: [] } : { mark, families: [mark] };
}

/**
 * Eight rows, each one a case the policy has to survive.
 *
 * The fixture is hand-built rather than read off the corpus for one reason: a fixture the product
 * produced would make the policies' expected counts a consequence of whatever the product happens to
 * answer, and a test that recomputes its own expectation cannot fail. Here the counts are on the page.
 *
 * | row | truth | product | model | cue leads | cues name | what it is |
 * |---|---|---|---|---|---|---|
 * | 0 | bar | bar | bar | bar | bar | both right, nothing to decide |
 * | 1 | line | bar | line | line | line | the model right, the product's cue loud |
 * | 2 | pie | bar | line | line | line, bar | both wrong, and one cue named the product's mark |
 * | 3 | line | — | line | line | line | the product refused, the model did not |
 * | 4 | pie | pie | line | pie | pie, bar | the product right, the model wrong |
 * | 5 | bar | bar | — | bar | bar | the model unreadable, the product wrong |
 * | 6 | pie | bar | pie | bar | bar | the model right on a row the cue pointed elsewhere |
 * | 7 | line | line | line | line | line, bar | both right again |
 */
const TRUTH: readonly ChartFamily[] = ['bar', 'line', 'pie', 'line', 'pie', 'bar', 'pie', 'line'];

function dispute(
  productMark: RecommendableMark | 'declined',
  modelMark: RecommendableMark | undefined,
  cueLead: RecommendableMark | undefined,
  cueNamed: readonly RecommendableMark[],
  asked = 'compare the values by region',
): Dispute {
  return { product: answer(productMark), model: modelMark, cueLead, cueNamed, asked };
}

const DISPUTES: readonly Dispute[] = [
  dispute('bar', 'bar', 'bar', ['bar']),
  dispute('bar', 'line', 'line', ['line']),
  dispute('bar', 'line', 'line', ['line', 'bar']),
  dispute('declined', 'line', 'line', ['line']),
  dispute('pie', 'line', 'pie', ['pie', 'bar']),
  dispute('bar', undefined, 'bar', ['bar']),
  dispute('bar', 'pie', 'bar', ['bar']),
  dispute('line', 'line', 'line', ['line', 'bar']),
];

/**
 * The rows whose labels carry the truth above, and nothing else.
 *
 * `arbitrateDisputes` takes a population and the disputes computed from it, aligned by index. The
 * labels are the truth — that is what makes the rows a population rather than a list — and the
 * prompts are filler here, because the dispute each one would produce is handed in directly.
 */
const LABEL_OF: Readonly<Record<string, string>> = { bar: 'Bar Chart', line: 'Line Chart', pie: 'Pie Chart' };

const ROWS: readonly ProfileInput[] = TRUTH.map((family, index) => ({
  prompt: `Question ${String(index)}`,
  label: LABEL_OF[family] as string,
  tableData: '',
}));

function policyOf(readings: readonly PolicyReading[], name: string): PolicyReading {
  const found = readings.find((reading) => reading.name === name);
  if (found === undefined) throw new Error(`no policy ${name}`);
  return found;
}

describe('the dispute a policy is allowed to see', () => {
  it('carries the answers and the question, and no way to look up the truth', () => {
    // The guarantee is a type, but a type is erased at run time and a field named `expected` would
    // compile. This is the assertion that a field cannot be added quietly — and `asked` was added
    // deliberately: it is the question, not the answer key, and the one thing that reads it is
    // `markAnswer`, which needs the wording to know a `bar` answer to a histogram question ships bins.
    // A policy that reached for it would be reading the question the product read, which is not the
    // label and was never hidden.
    expect(Object.keys(DISPUTES[0] as Dispute).sort()).toEqual(['asked', 'cueLead', 'cueNamed', 'model', 'product']);
  });

  it('reads the product, the cues and the model off one row', () => {
    const row: ProfileInput = {
      prompt: 'Show the share of revenue each region holds',
      label: 'Pie Chart',
      tableData: 'Region, Revenue\nNorth, 40\nSouth, 55\nEast, 31\nWest, 63',
    };
    const seen = disputeOf(row, 'pie');
    // The product's answer is `profileAnswer`, the published path: a second call into
    // `recommendChart` here would be a second reading of the same question.
    expect(seen.product).toEqual(profileAnswer(row.prompt, row.tableData));
    expect(seen.product.families.length).toBeGreaterThan(0);
    // The cue table leads with the mark the question asked for, which is the signal the policy reads.
    expect(seen.cueLead).toBe('pie');
    expect(seen.cueNamed[0]).toBe('pie');
    expect(seen.model).toBe('pie');
    // A reply that named nothing offered is not a mark, and it must not become the string `null`.
    expect(disputeOf(row, null).model).toBeUndefined();
  });

  it('has no lead when no cue fires, which is a fact and not an empty string', () => {
    const row: ProfileInput = { prompt: 'What happened', label: 'Bar Chart', tableData: 'A, B\n1, 2' };
    expect(disputeOf(row, 'bar').cueLead).toBeUndefined();
    expect(disputeOf(row, 'bar').cueNamed).toEqual([]);
  });

  it('refuses a name the arm never offered, because the artifact is an external file', () => {
    // The arm's reader only writes a name it was given, so a foreign name means the file was edited or
    // written by another version. Carried instead of refused, `donut` would become a policy answer
    // whose family list is empty — which the scorer reads as *declined*, reclassifying the row as a
    // refusal and crediting it to whichever side happened to decline.
    const row: ProfileInput = { prompt: 'Show revenue', label: 'Bar Chart', tableData: 'A, B\n1, 2' };
    expect(() => disputeOf(row, 'donut')).toThrow(/not one of the 11 marks/);
    expect(() => disputeOf(row, 'Bar')).toThrow(/not one of the 11 marks/);
    // The two states the artifact can actually hold are still accepted.
    expect(disputeOf(row, 'bar').model).toBe('bar');
    expect(disputeOf(row, null).model).toBeUndefined();
  });
});

describe('the policies', () => {
  const report = arbitrateDisputes(ROWS, DISPUTES, 'a-model');

  it('counts the population once, and the disagreement inside it', () => {
    expect(report.population.scored).toBe(8);
    // Rows 0 and 7 are where both systems lead with the same answer. Agreement is a statement about
    // the answers, not about the truth: a row both systems answer the same way and both get wrong is
    // a row no policy can win, and it is counted as agreement rather than as a decision either way.
    expect(report.agreement).toEqual({ agree: 2, agreeHit: 2, disagree: 6, productRight: 2, modelRight: 3 });
    // Nothing can beat keeping every row the product was right about and taking every row the model
    // was, which is the union and not a policy. Seven of eight: row 2 is the row no rule can win,
    // because both systems answer it the same wrong way and the key is the only thing that knows.
    expect(report.oracle).toEqual({ hit: 7, share: 7 / 8 });
  });

  it('prices the two baselines against the fixture and not against each other', () => {
    // The product is right on four rows: the two agreements and two of the six disputes — row 4,
    // where it read a pie question and said pie, and row 5, where the model was unreadable and the
    // product happened to be right. A fixture that had no such row would let a policy look better
    // than it is by routing every unreadable row away from the product for free.
    const product = policyOf(report.policies, 'product');
    expect(product.hit).toBe(4);
    expect(product.kept).toBe(6);
    expect(product.given).toBe(0);
    const model = policyOf(report.policies, 'model');
    expect(model.hit).toBe(5);
    expect(model.kept).toBe(0);
    expect(model.given).toBe(6);
    // Three rows the product missed and the model got, two rows the product got and the model missed
    // — row 4 (pie against line) and row 5 (bar against nothing).
    expect(model.gained).toBe(3);
    expect(model.lost).toBe(2);
  });

  it('routes the rows rather than rescores them, and the scorer agrees with the routing', () => {
    // `cue-any` keeps the product wherever a cue named its mark. Row 2 is the case that separates it
    // from `cue-led`: the cue *named* bar but led with line, so `cue-any` keeps a wrong answer and
    // `cue-led` takes the model's — which is also wrong, but it is a different decision.
    const any = policyOf(report.policies, 'cue-any');
    expect(any.kept).toBe(4);
    expect(any.keptRight).toBe(2);
    expect(any.given).toBe(2);
    expect(any.givenRight).toBe(2);
    expect(any.hit).toBe(6);
    const led = policyOf(report.policies, 'cue-led');
    expect(led.kept).toBe(3);
    expect(led.keptRight).toBe(2);
    expect(led.given).toBe(3);
    expect(led.hit).toBe(6);
    // The identity the report is built on: every hit is an agreed hit, a row kept from the product,
    // or a row taken from the model.
    for (const reading of report.policies) {
      expect(reading.hit).toBe(report.agreement.agreeHit + reading.keptRight + reading.givenRight);
      expect(reading.kept + reading.given).toBe(report.agreement.disagree);
    }
  });

  it('prices the two fallbacks by the rows where one side had nothing to say', () => {
    // `product-holds` keeps the product except where it refused, so it takes row 3 from the model.
    // `product-holds` keeps the product except where it refused, so it takes row 3 from the model and
    // pays nothing for it: the product had nothing to say there.
    const holds = policyOf(report.policies, 'product-holds');
    expect(holds.kept).toBe(5);
    expect(holds.keptRight).toBe(2);
    expect(holds.given).toBe(1);
    expect(holds.givenRight).toBe(1);
    expect(holds.hit).toBe(5);
    // `model-holds` takes the model except where it was unreadable, so it keeps row 5 — and row 5 is
    // the row the fallback *pays* on: the product was right and the model said nothing. So it reads
    // 6, one more than the model-only policy it is a repair of, which is the whole case for a
    // fallback and the reason a fixture needs a row where the weaker system is right.
    const modelHolds = policyOf(report.policies, 'model-holds');
    expect(modelHolds.kept).toBe(1);
    expect(modelHolds.keptRight).toBe(1);
    expect(modelHolds.hit).toBe(6);
    expect(modelHolds.hit).toBe(policyOf(report.policies, 'model').hit + 1);
    // Three policies tie at 6, and the tie is broken by how much of the product's behaviour each one
    // disturbs: `cue-any` changes two rows, `cue-led` three, `model-holds` five.
    expect(policyOf(report.policies, 'cue-any').changed).toBe(2);
    expect(policyOf(report.policies, 'cue-led').changed).toBe(3);
    expect(policyOf(report.policies, 'model-holds').changed).toBe(5);
    expect(policyOf(report.policies, 'model').changed).toBe(6);
    expect(report.best).toBe('cue-any');
  });

  it('publishes where each policy stands per family, and the sums hold', () => {
    for (const reading of report.policies) {
      expect(reading.perFamily.reduce((sum, cell) => sum + cell.n, 0)).toBe(report.population.scored);
      expect(reading.perFamily.reduce((sum, cell) => sum + cell.hit, 0)).toBe(reading.hit);
    }
    const pie = policyOf(report.policies, 'product').perFamily.find((cell) => cell.family === 'pie');
    // Three pie rows, and the product answers one of them.
    expect(pie).toEqual({ family: 'pie', n: 3, hit: 1 });
  });

  it('prices a change against the product with the discordant pairs', () => {
    // `gained - lost === hit - product.hit` for every policy: the two counts are the same delta seen
    // from the rows rather than from the totals.
    const product = policyOf(report.policies, 'product');
    for (const reading of report.policies) {
      expect(reading.gained - reading.lost).toBe(reading.hit - product.hit);
    }
  });

  it('refuses a report whose arithmetic a reader could not reproduce', () => {
    const sound = arbitrateDisputes(ROWS, DISPUTES, 'a-model');
    expect(() => assertArbitration(sound)).not.toThrow();
    // A policy credited with a row it did not route.
    const inflated = {
      ...sound,
      policies: sound.policies.map((reading) =>
        reading.name === 'product' ? { ...reading, hit: reading.hit + 1 } : reading,
      ),
    };
    expect(() => assertArbitration(inflated)).toThrow(/not the agreed hits plus the rows it routed/);
    // A report whose rows do not add up to the population.
    expect(() => assertArbitration({ ...sound, population: { ...sound.population, scored: 9 } })).toThrow(
      /agreement does not cover the population/,
    );
    // A `best` that is not the best, which is how a policy table reads better than it is.
    expect(() => assertArbitration({ ...sound, best: 'product' })).toThrow(/does not hold the highest reading/);
    // Per-family cells that do not sum to the total.
    const wrongCells = {
      ...sound,
      policies: sound.policies.map((reading) =>
        reading.name === 'model' ? { ...reading, perFamily: [] } : reading,
      ),
    };
    expect(() => assertArbitration(wrongCells)).toThrow(/per-family cells summing to 0 and 8 rows/);
    // A ceiling that is not the union.
    expect(() => assertArbitration({ ...sound, oracle: { hit: 8, share: 1 } })).toThrow(/is not the agreed hits plus the rows each system won alone/);
    // A table with no product baseline has nothing to price a gain against.
    expect(() => assertArbitration({ ...sound, policies: sound.policies.filter((reading) => reading.name !== 'product') })).toThrow(
      /no product baseline/,
    );
    // A policy credited with routing fewer rows than were in dispute.
    const shortRouted = sound.policies.map((reading) => (reading.name === 'cue-any' ? { ...reading, kept: 1 } : reading));
    expect(() => assertArbitration({ ...sound, policies: shortRouted })).toThrow(/routed 3 of the 6 rows in dispute/);
    // A gain that does not match the total it claims to explain.
    const miscounted = sound.policies.map((reading) => (reading.name === 'cue-led' ? { ...reading, gained: 9 } : reading));
    expect(() => assertArbitration({ ...sound, policies: miscounted })).toThrow(/which is not the 2 its total moved/);
    // Per-family cells that sum to the population but disagree with the total hits.
    const wrongHitCells = sound.policies.map((reading) =>
      reading.name === 'model' ? { ...reading, perFamily: [{ family: 'bar' as const, n: 8, hit: 0 }] } : reading,
    );
    expect(() => assertArbitration({ ...sound, policies: wrongHitCells })).toThrow(/per-family hits summing to 0 and 5 hits/);
  });

  it('refuses a population that is not aligned with the disputes read off it', () => {
    expect(() => arbitrateDisputes(ROWS, DISPUTES.slice(1), 'a-model')).toThrow(/8 rows and 7 disputes/);
    // A label no family names is not a population the two scales could score, and the corpus filter
    // is supposed to have removed it before this point. If one arrives here, the truth column has a
    // hole in it and every count downstream is a share of the wrong denominator.
    const holed = [{ ...(ROWS[0] as ProfileInput), label: 'Waterfall' }, ...ROWS.slice(1)];
    expect(() => arbitrateDisputes(holed, DISPUTES, 'a-model')).toThrow(/row 0 carries a label no family names/);
  });

  it('refuses a candidate rule that answers something neither system said', () => {
    // The guard that makes the table a routing table: a policy may only choose one of the two answers.
    // A rule that returned a third mark would be scored as if it had arbitrated, and its hits would
    // be hits the product cannot produce and the model was never asked for.
    const rogue = { name: 'rogue', note: 'answers radar on every row', choose: () => answer('radar') };
    expect(() => arbitrateDisputes(ROWS, DISPUTES, 'a-model', [rogue])).toThrow(/may only route a row to one of the two answers/);
    // And a candidate that *does* route can be priced without editing the shipped table, which is why
    // the parameter exists: one rule in, one reading out, and the same two baselines beside it if the
    // caller asks for them. This one trusts the product exactly where the cue leads with a line.
    const candidate = {
      name: 'line-first',
      note: 'trust the product where the cue table leads with a line',
      choose: (dispute: Dispute) =>
        dispute.cueLead === 'line' ? dispute.product : dispute.model === undefined ? answer('declined') : answer(dispute.model),
    };
    const only = arbitrateDisputes(ROWS, DISPUTES, 'a-model', [candidate]);
    expect(only.policies.map((reading) => reading.name)).toEqual(['line-first']);
    expect(only.policies[0]?.hit).toBe(2 + (only.policies[0]?.keptRight ?? 0) + (only.policies[0]?.givenRight ?? 0));
  });

  it('prints a line per policy, and the ceiling above them', () => {
    const lines = describeArbitration(report);
    const text = lines.join('\n');
    expect(text).toContain('product');
    expect(text).toContain('model');
    // The line a reader needs most: the ceiling, and how far the best policy is from it. Seven of the
    // eight rows are reachable by some rule that knows which system to believe; the best policy here
    // reaches six, so one row is the price of not having the key.
    expect(text).toContain('arbitration on 8 rows against a-model');
    expect(text).toContain('ceiling');
    expect(text).toMatch(/ceiling\s+7 \(87\.50%\)/);
    expect(text).not.toContain('+-');
    // The sign belongs to the net, not to one of its halves. `gained` counts rows won and is never
    // negative, so a sign read off it printed `+-1` for every policy that lost a row; the product's
    // own line reads `+0`, and a policy that gives up one row reads `-1`.
    expect(text).toMatch(/vs product \+0 \(/);
    expect(text).toMatch(/vs product \+1 \(/);
    const pieFirst = {
      name: 'pie-first',
      note: 'trust the model wherever a pie cue fired',
      choose: (seen: Dispute): ChartAnswer =>
        seen.model === undefined || !seen.cueNamed.includes('pie') ? seen.product : answer(seen.model),
    };
    const worse = arbitrateDisputes(ROWS, DISPUTES, 'a-model', [pieFirst]);
    expect(worse.policies[0]?.hit).toBe(3);
    expect(describeArbitration(worse).join('\n')).toMatch(/vs product -1 \(/);
  });
});

describe('the population the answers belong to', () => {
  const rowOf = (prompt: string, label: string, tableData: string): ProfileInput => ({ prompt, label, tableData });
  const rows = [
    rowOf('How has revenue changed over time?', 'Line Chart', 'Date, Revenue\n2019, 10\n2020, 14'),
    rowOf('Compare revenue by region', 'Bar Chart', 'Region, Revenue\nNorth, 40\nSouth, 55'),
  ];

  it('names the rows it answered by a fingerprint that a second reader can recompute', () => {
    expect(rosterOf(rows)).toBe(rosterOf(rows.map((row) => ({ ...row }))));
    expect(rosterOf(rows)).not.toBe(rosterOf([rows[1] as ProfileInput, rows[0] as ProfileInput]));
    expect(rosterOf([{ ...rows[0], label: 'Area Chart' } as ProfileInput, rows[1] as ProfileInput])).not.toBe(rosterOf(rows));
    // A prompt edit is a different row: the answers were given to the old wording.
    expect(rosterOf([{ ...rows[0], prompt: 'How did revenue change?' } as ProfileInput, rows[1] as ProfileInput])).not.toBe(
      rosterOf(rows),
    );
  });

  it('refuses to arbitrate over an artifact that answered a different population', () => {
    expect(() => arbitrate(rows, ['bar', 'bar'], 'a-model', { roster: 'not-the-roster' })).toThrow(/different population/);
    const reading = arbitrate(rows, ['bar', 'bar'], 'a-model', { roster: rosterOf(rows) });
    expect(reading.population.roster).toBe(rosterOf(rows));
    expect(reading.population.scored).toBe(2);
  });

  it('refuses a population of nothing, which would publish 0 / 0 as a share', () => {
    expect(() => arbitrateDisputes([], [], 'a-model')).toThrow(/the population is empty/);
    expect(() => arbitrate([], [], 'a-model', { roster: rosterOf([]) })).toThrow(/the population is empty/);
  });

  it('refuses an answer list that is not one per row', () => {
    expect(() => arbitrate(rows, ['bar'], 'a-model', { roster: rosterOf(rows) })).toThrow(/answers for 1 rows/);
  });
});

describe('the command line', () => {
  it('takes the artifact, the reading and a model, and refuses a sample', () => {
    // `--answers` has no default: an invocation that forgot it is told so, rather than pricing the
    // answers of whatever happens to sit at a path this file chose.
    expect(() => parseArbitrateArgs([])).toThrow(/--answers is required/);
    expect(parseArbitrateArgs(['--json', '--answers', 'a.json', '--artifact', 'b.json', '--model', 'm'])).toEqual({
      json: true,
      answers: 'a.json',
      artifact: 'b.json',
      model: 'm',
    });
    expect(parseArbitrateArgs(['--answers', 'a.json'])).toEqual({ json: false, answers: 'a.json' });
    // `--limit` is not a flag this command has: the population is the artifact's, and a sample here
    // would score the answers against rows they were not given.
    expect(() => parseArbitrateArgs(['--limit', '20'])).toThrow(/asks nothing to a model/);
    expect(() => parseArbitrateArgs(['--answers'])).toThrow(/needs a path/);
  });
});

function cell(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

const HEADER = `${TEXT2VIS_FIELDS.prompt},${TEXT2VIS_FIELDS.answer},${TEXT2VIS_FIELDS.code},${TEXT2VIS_FIELDS.chartType},Table Data`;
const BODY = [
  HEADER,
  [
    cell('Show the share of revenue each region holds'),
    cell('North'),
    cell(''),
    cell('Pie Chart'),
    cell('Region, Revenue\nNorth, 40\nSouth, 55\nEast, 31\nWest, 63'),
  ].join(','),
  [
    cell('Compare revenue by region'),
    cell('North'),
    cell(''),
    cell('Bar Chart'),
    cell('Region, Revenue\nNorth, 40\nSouth, 55\nEast, 31\nWest, 63'),
  ].join(','),
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

const SERVED_ROWS: readonly ProfileInput[] = [
  {
    prompt: 'Show the share of revenue each region holds',
    label: 'Pie Chart',
    tableData: 'Region, Revenue\nNorth, 40\nSouth, 55\nEast, 31\nWest, 63',
  },
  {
    prompt: 'Compare revenue by region',
    label: 'Bar Chart',
    tableData: 'Region, Revenue\nNorth, 40\nSouth, 55\nEast, 31\nWest, 63',
  },
];

function artifact(choices: readonly (string | null)[], roster: string): string {
  return JSON.stringify({
    corpus: { rows: 2, scored: 2, asked: 2, roster },
    arms: [
      { scale: 'mark', model: 'a-model', requested: 2, answered: 2, unparsed: 0, truncated: 0, scored: 2, choices },
      { scale: 'label', model: 'a-model', requested: 2, answered: 2, unparsed: 0, truncated: 0, scored: 2, choices: [null, null] },
    ],
    paired: [],
  });
}

describe('the command, end to end', () => {
  it('prices the artifact it was handed and writes the table', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'reading.json');
      const out = join(root, 'arbitration.json');
      writeFileSync(answers, artifact(['pie', 'bar'], rosterOf(SERVED_ROWS)));
      const code = await entryArbitrate(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--artifact', out],
        load: { cacheDir: join(root, 'served'), url: server.url },
      });
      expect(code).toBe(0);
      const written = JSON.parse(readFileSync(out, 'utf8')) as {
        model: string;
        population: { scored: number };
        policies: PolicyReading[];
        best: string;
      };
      expect(written.model).toBe('a-model');
      expect(written.population.scored).toBe(2);
      expect(written.policies.map((reading) => reading.name)).toContain('cue-led');
      expect(lines.join('\n')).toContain('text2vis: wrote');
    } finally {
      await server.close();
    }
  });

  it('refuses an artifact whose rows are not the rows on disk', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'stale.json');
      writeFileSync(answers, artifact(['pie', 'bar'], 'a-fingerprint-of-some-other-corpus'));
      const code = await entryArbitrate(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers],
        load: { cacheDir: join(root, 'stale-corpus'), url: server.url },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/different population/);
    } finally {
      await server.close();
    }
  });

  it('refuses an artifact with no mark-scale arm to arbitrate with', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'label-only.json');
      writeFileSync(
        answers,
        JSON.stringify({
          corpus: { rows: 2, scored: 2, asked: 2, roster: rosterOf(SERVED_ROWS) },
          arms: [{ scale: 'label', model: 'a-model', requested: 2, choices: ['Pie Chart', 'Bar Chart'] }],
          paired: [],
        }),
      );
      const code = await entryArbitrate(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers],
        load: { cacheDir: join(root, 'label-only-corpus'), url: server.url },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/no mark-scale arm/);
      // An artifact with no arms at all is the same refusal by a shorter route: a report written
      // before the arms column existed names no scale, so there is nothing to arbitrate against.
      const bare = join(root, 'no-arms.json');
      writeFileSync(bare, JSON.stringify({ corpus: { rows: 2, scored: 2, asked: 2, roster: rosterOf(SERVED_ROWS) } }));
      expect(
        await entryArbitrate(ENTRY, MODULE_URL, (line) => lines.push(line), {
          argv: ['--answers', bare],
          load: { cacheDir: join(root, 'no-arms-corpus'), url: server.url },
        }),
      ).toBe(1);
      expect(lines.join('\n')).toMatch(/no mark-scale arm/);
    } finally {
      await server.close();
    }
  });

  it('refuses an artifact that cannot say which rows it answered', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const bare = join(root, 'no-roster.json');
      writeFileSync(bare, JSON.stringify({ arms: [{ scale: 'mark', model: 'a-model', choices: ['pie', 'bar'] }] }));
      expect(
        await entryArbitrate(ENTRY, MODULE_URL, (line) => lines.push(line), {
          argv: ['--answers', bare],
          load: { cacheDir: join(root, 'no-roster-corpus'), url: server.url },
        }),
      ).toBe(1);
      expect(lines.join('\n')).toMatch(/carries no corpus\.roster/);
      // An artifact written before the answers travelled with the report: valid JSON, a mark arm, and
      // nothing to route.
      const choiceless = join(root, 'no-choices.json');
      writeFileSync(
        choiceless,
        JSON.stringify({ corpus: { roster: rosterOf(SERVED_ROWS), asked: 2 }, arms: [{ scale: 'mark', model: 'a-model' }] }),
      );
      expect(
        await entryArbitrate(ENTRY, MODULE_URL, (line) => lines.push(line), {
          argv: ['--answers', choiceless],
          load: { cacheDir: join(root, 'no-choices-corpus'), url: server.url },
        }),
      ).toBe(1);
      expect(lines.join('\n')).toMatch(/carries no per-row choices/);
      // A hand-edited artifact whose column is not a column of answers.
      const ragged = join(root, 'ragged.json');
      writeFileSync(
        ragged,
        JSON.stringify({ corpus: { roster: rosterOf(SERVED_ROWS), asked: 2 }, arms: [{ scale: 'mark', model: 'a-model', choices: ['pie', 3] }] }),
      );
      expect(
        await entryArbitrate(ENTRY, MODULE_URL, (line) => lines.push(line), {
          argv: ['--answers', ragged],
          load: { cacheDir: join(root, 'ragged-corpus'), url: server.url },
        }),
      ).toBe(1);
      expect(lines.join('\n')).toMatch(/carries no per-row choices/);
      // A truncated download reads as a syntax error, and a syntax error is not a table.
      const broken = join(root, 'broken.json');
      writeFileSync(broken, '{"corpus":');
      expect(
        await entryArbitrate(ENTRY, MODULE_URL, (line) => lines.push(line), {
          argv: ['--answers', broken],
          load: { cacheDir: join(root, 'broken-corpus'), url: server.url },
        }),
      ).toBe(1);
      expect(lines.join('\n')).toContain('text2vis: ');
    } finally {
      await server.close();
    }
  });

  it('falls back to the whole scored population when the artifact does not say how many it asked', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'no-asked.json');
      writeFileSync(answers, JSON.stringify({ corpus: { roster: rosterOf(SERVED_ROWS) }, arms: [{ scale: 'mark', model: 'a-model', choices: ['pie', 'bar'] }] }));
      expect(
        await entryArbitrate(ENTRY, MODULE_URL, (line) => lines.push(line), {
          argv: ['--answers', answers],
          load: { cacheDir: join(root, 'no-asked-corpus'), url: server.url },
        }),
      ).toBe(0);
      expect(lines.join('\n')).toContain('arbitration on 2 rows');
    } finally {
      await server.close();
    }
  });

  it('says how many labels it left out of the population', async () => {
    // A row whose label names no family is not in any population: both scales are blind to it, so
    // arbitrating over it would be scoring two answers against a question neither can be right about.
    const server = await serve(
      [
        BODY,
        [cell('Draw the flows between stages'), cell('10'), cell(''), cell('Waterfall'), cell('Region, Revenue\nNorth, 40')].join(','),
      ].join('\n'),
    );
    const lines: string[] = [];
    try {
      const answers = join(root, 'dropped.json');
      writeFileSync(answers, artifact(['pie', 'bar'], rosterOf(SERVED_ROWS)));
      expect(
        await entryArbitrate(ENTRY, MODULE_URL, (line) => lines.push(line), {
          argv: ['--answers', answers],
          load: { cacheDir: join(root, 'dropped-corpus'), url: server.url },
        }),
      ).toBe(0);
      expect(lines.join('\n')).toContain('1 rows carry a label no family names');
    } finally {
      await server.close();
    }
  });

  it('says which flag is missing when it is invoked with no arguments at all', async () => {
    const lines: string[] = [];
    // No options object: the command line is `process.argv.slice(2)` only when a caller has not
    // supplied one, and an empty line has to be an explanation rather than a guess.
    const code = await entryArbitrate(ENTRY, MODULE_URL, (line) => lines.push(line));
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/--answers is required/);
  });

  it('reports a transport that throws a string as a string', async () => {
    const lines: string[] = [];
    const answers = join(root, 'string-throw.json');
    writeFileSync(answers, artifact(['pie', 'bar'], rosterOf(SERVED_ROWS)));
    const code = await entryArbitrate(ENTRY, MODULE_URL, (line) => lines.push(line), {
      argv: ['--answers', answers],
      load: {
        cacheDir: join(root, 'empty-cache'),
        url: 'http://127.0.0.1:1/Text2Vis.csv',
        fetchImpl: (() => {
          throw 'the network is a string';
        }) as unknown as typeof fetch,
      },
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('the network is a string');
  });

  it('reads the corpus from the cache variable every other eval command uses', async () => {
    // No `load` option: the path comes from `TEXT2VIS_CACHE`, which is the variable a workflow sets.
    // A command that reached for the network here would download 6.7 MB to re-derive a corpus the
    // caller already has.
    const dir = join(root, 'env-cache');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Text2Vis.csv'), BODY);
    const lines: string[] = [];
    const answers = join(root, 'env-answers.json');
    writeFileSync(answers, artifact(['pie', 'bar'], rosterOf(SERVED_ROWS)));
    const saved = process.env.TEXT2VIS_CACHE;
    process.env.TEXT2VIS_CACHE = dir;
    try {
      const code = await entryArbitrate(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--json'],
      });
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('text2vis: cache');
      // `--json` prints the report itself, which is what a caller without an artifact path reads.
      const printed = JSON.parse(lines.find((line) => line.startsWith('{')) as string) as { best: string };
      expect(printed.best).toBeTruthy();
    } finally {
      if (saved === undefined) delete process.env.TEXT2VIS_CACHE;
      else process.env.TEXT2VIS_CACHE = saved;
    }
  });

  it('names the model when the artifact holds more than one', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'two-models.json');
      const payload = JSON.parse(artifact(['pie', 'bar'], rosterOf(SERVED_ROWS))) as {
        arms: Record<string, unknown>[];
      };
      payload.arms.push({ scale: 'mark', model: 'b-model', requested: 2, choices: ['line', 'line'] });
      writeFileSync(answers, JSON.stringify(payload));
      const code = await entryArbitrate(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--model', 'b-model'],
        load: { cacheDir: join(root, 'two-models-corpus'), url: server.url },
      });
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('b-model');
      const missing = await entryArbitrate(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--model', 'c-model'],
        load: { cacheDir: join(root, 'two-models-corpus'), url: server.url },
      });
      expect(missing).toBe(1);
      expect(lines.join('\n')).toMatch(/no c-model mark arm/);
    } finally {
      await server.close();
    }
  });
});
