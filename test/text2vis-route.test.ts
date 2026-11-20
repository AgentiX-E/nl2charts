/**
 * Routing between two models, decided without looking at the label.
 *
 * `arbitrate.ts` prices six rules over the disagreement between the rule table and one model arm.
 * This file prices the same six rules over the disagreement between **two** arms — `deepseek-chat`
 * and `deepseek-reasoner`, one dispatch, one corpus — because the question the previous round left
 * open is not "which arm reads this corpus better" (875 against 861, McNemar p = 0.30) but "is there
 * a rule that reads the *disagreement* better than either arm alone".
 *
 * Four properties are defended here:
 *
 * 1. **The rule table is the same six rules.** `DUEL_POLICIES` reuses the `choose` functions of
 *    `POLICIES` by reference and only renames them, so a change to a rule is a change in one place.
 *    A second copy of `cue-led` would be a second definition of what the cue table leads with, and
 *    the two tables would then be able to disagree about a row neither of them changed.
 * 2. **A routed answer is one of the two answers.** `routeChoices` returns the mark an arm actually
 *    said, or `null` for a refusal — never a hybrid — because a third mark is an answer neither arm
 *    gave and the arbitration's identity would refuse it.
 * 3. **Every policy's score is a sum of three counts.** `hit === agreeHit + keptRight + givenRight`,
 *    asserted against the scorer's own `top1`, so a rule cannot be credited for a row it did not
 *    route.
 * 4. **The fixture is not the corpus.** The eight rows below are hand-built and the winner they
 *    produce is *not* the corpus's winner (`cue-any` beats `cue-led` here and loses there), so a
 *    number in this file that matches the corpus would be a coincidence rather than a test.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  arbitrateDisputes,
  describeArbitration,
  disputeOf,
  POLICIES,
  type Dispute,
  type Policy,
} from '../eval/text2vis/arbitrate.js';
import { TEXT2VIS_FIELDS } from '../eval/text2vis/dataset.js';
import { rosterOf } from '../eval/text2vis/llm.js';
import { DUEL_POLICIES, duelOf, duelReport, entryRoute, parseRouteArgs, renamePolicies, routeChoices, shippedPair } from '../eval/text2vis/route.js';
import type { ProfileInput } from '../eval/text2vis/profile.js';
import type { ChartFamily } from '../eval/text2vis/rule.js';

/** A row with a question and a label; the table is not read by anything in this file. */
function row(prompt: string, label: string): ProfileInput {
  return { prompt, label, tableData: '' };
}

/**
 * Eight rows, and the two arms' answers on each.
 *
 * | row | question | cue leads | cue names | truth | chat | reasoner | what it is |
 * |---|---|---|---|---|---|---|---|
 * | 0 | trend over time | line | line, bar | line | line | line | both right, nothing to decide |
 * | 1 | share of orders | pie | pie, bar | pie | pie | bar | chat right, and the leading cue says so too |
 * | 2 | share of revenue over time, by region | line | line, bar, pie | pie | pie | bar | chat right on a cue it named *third* |
 * | 3 | which ranks highest | bar | bar | bar | — | bar | chat refused, the reasoner did not |
 * | 4 | trend over time | line | line, bar | pie | line | pie | the reasoner right against a loud cue |
 * | 5 | which ranks highest | bar | bar | bar | bar | — | the reasoner unreadable |
 * | 6 | share of revenue over time, by region | line | line, bar, pie | line | bar | line | the reasoner right, though a cue named chat's answer |
 * | 7 | the name of the customer | — | — | bar | bar | pie | neither cue answers: the fallback row |
 */
const TRUTH: readonly ChartFamily[] = ['line', 'pie', 'pie', 'bar', 'pie', 'bar', 'line', 'bar'];

const ROWS: readonly ProfileInput[] = [
  row('what is the trend of revenue over time?', 'Line Chart'),
  row('show the share of orders by status', 'Pie Chart'),
  row('the share of revenue over time, by region', 'Pie Chart'),
  row('which product ranks highest by revenue', 'Bar Chart'),
  row('what is the trend of revenue over time?', 'Pie Chart'),
  row('which product ranks highest by revenue', 'Bar Chart'),
  row('the share of revenue over time, by region', 'Line Chart'),
  row('what is the name of the customer', 'Bar Chart'),
];

/** The seat `Dispute.product` holds is the arm that answers without thinking. */
const CHAT: readonly (string | null)[] = ['line', 'pie', 'pie', null, 'line', 'bar', 'bar', 'bar'];
const REASONER: readonly (string | null)[] = ['line', 'bar', 'bar', 'bar', 'pie', null, 'line', 'pie'];

const DISPUTES: readonly Dispute[] = ROWS.map((entry, index) =>
  duelOf(entry, CHAT[index] ?? null, REASONER[index] ?? null),
);

function policy(name: string, policies: readonly Policy[] = DUEL_POLICIES): Policy {
  const found = policies.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no policy ${name}`);
  return found;
}

/** The scorer's own reading of one policy, plus the decomposition it must equal. */
function price(name: string) {
  const report = arbitrateDisputes(ROWS, DISPUTES, 'chat vs reasoner', [policy(name)]);
  return report.policies[0] as ReturnType<typeof arbitrateDisputes>['policies'][number];
}

describe('the seat the first arm sits in', () => {
  it('builds a dispute from two answers and the cue table, and reads a null as a refusal', () => {
    const dispute = duelOf(ROWS[2] as ProfileInput, 'pie', 'bar');
    expect(dispute.product.mark).toBe('pie');
    expect(dispute.product.families[0]).toBe('pie');
    expect(dispute.model).toBe('bar');
    expect(dispute.cueLead).toBe('line');
    expect(dispute.cueNamed).toEqual(['line', 'bar', 'pie']);
    // A `null` is an arm that answered nothing, which the policies must be able to tell apart from
    // an arm that answered *something*; `undefined` is that distinction and `null` is not.
    expect(duelOf(ROWS[2] as ProfileInput, 'pie', null).model).toBeUndefined();
    expect(duelOf(ROWS[2] as ProfileInput, null, 'pie').product.mark).toBe('declined');
    expect(duelOf(ROWS[2] as ProfileInput, null, null).model).toBeUndefined();
  });

  it('refuses a mark the product cannot draw, because the artifact is a file', () => {
    // The arm's parser only ever writes a name it was offered, so a foreign name means the file was
    // edited or written by another version. Carried through, `donut` scores as a refusal (its family
    // list is empty) and the table would credit the row to whichever side happened to decline it.
    expect(() => duelOf(ROWS[0] as ProfileInput, 'donut', 'line')).toThrow(/not one of the/);
    expect(() => duelOf(ROWS[0] as ProfileInput, 'line', 'waterfall')).toThrow(/not one of the/);
  });

  it('refuses a dispute that hides the label, which is the property the type cannot enforce', () => {
    // Erased types do not stop a field from being *carried*: a `Dispute` with an `expected` would
    // compile, and every policy that read it would be reading the answer key.
    for (const dispute of DISPUTES) expect(Object.keys(dispute).sort()).toEqual(['cueLead', 'cueNamed', 'model', 'product']);
  });
});

describe('the rule table, reused rather than copied', () => {
  it('prices the same six rules as the product-versus-model table', () => {
    // Identity by reference, not by name: a rule that is re-implemented here is a second definition of
    // the same sentence, and the two tables would then be able to disagree about one row.
    expect(DUEL_POLICIES).toHaveLength(POLICIES.length);
    for (const duel of DUEL_POLICIES) {
      const source = POLICIES.find((candidate) => candidate.name === sourceNameOf(duel.name));
      expect(source, `no source rule for ${duel.name}`).toBeDefined();
      expect(duel.choose).toBe(source?.choose);
      expect(duel.note.length).toBeGreaterThan(20);
    }
  });

  it('names the two arms rather than the product and the model', () => {
    expect(DUEL_POLICIES.map((entry) => entry.name)).toEqual([
      'chat',
      'reasoner',
      'cue-led',
      'cue-any',
      'chat-holds',
      'reasoner-holds',
    ]);
    expect(DUEL_POLICIES.some((entry) => /product/.test(entry.note))).toBe(false);
  });
});

/** The `POLICIES` name each duel policy reuses. Written here so the mapping is checked, not assumed. */
function sourceNameOf(name: string): string {
  return { chat: 'product', reasoner: 'model', 'chat-holds': 'product-holds', 'reasoner-holds': 'model-holds' }[name] ?? name;
}

describe('what each rule reads on eight rows', () => {
  it('reads the two arms as they are, then prices the rules that route between them', () => {
    // chat: rows 0, 1, 2, 5, 7. reasoner: rows 0, 3, 4, 6.
    expect(price('chat').hit).toBe(5);
    expect(price('reasoner').hit).toBe(4);
    // cue-led keeps the chat answer only where the *leading* cue names it -- rows 0, 1 and 5, of
    // which 0, 1 and 5 are right, and row 4, which is wrong -- and gives the rest to the reasoner,
    // of which 3 and 6 are right and 7 is not. Five, from three rows kept and four given.
    expect(price('cue-led').hit).toBe(5);
    // cue-any keeps every row where *any* cue named the chat answer, which on this fixture adds row 2
    // (right) and row 6 (wrong), and drops row 4 (wrong). It lands on the same five, having routed
    // two rows the other way: a fixture where the two rules tie is exactly why the corpus result is
    // not a foregone conclusion of a fixture.
    expect(price('cue-any').hit).toBe(5);
    expect([price('cue-led').changed, price('cue-any').changed]).toEqual([4, 2]);
    // The two "holds" rules are an arm plus a refusal rule, and the refusal is worth a row each way:
    // chat wins row 3 where the reasoner had nothing to say, and the reasoner wins row 5 where chat
    // did. This is the only rule on the fixture that beats both arms.
    expect(price('chat-holds').hit).toBe(6);
    expect(price('reasoner-holds').hit).toBe(5);
  });

  it('scores every policy as the sum of the rows it routed, not as a number of its own', () => {
    const report = arbitrateDisputes(ROWS, DISPUTES, 'chat vs reasoner');
    expect(report.agreement).toEqual({ agree: 1, agreeHit: 1, disagree: 7, productRight: 4, modelRight: 3 });
    // Every row is right by one arm or the other, which is what a hand-built fixture is for: the
    // ceiling is 8, and every policy below it is a rule losing a row it could have had.
    expect(report.oracle.hit).toBe(8);
    for (const reading of report.policies) {
      // The identity `arbitrate.ts` states for one pair of answerers holds for any pair: the rows
      // nobody had to route, plus the rows kept from the left arm that were right, plus the rows
      // given to the right arm that were right.
      expect(reading.hit, reading.name).toBe(report.agreement.agreeHit + reading.keptRight + reading.givenRight);
      expect(reading.kept + reading.given).toBe(report.agreement.disagree);
    }
  });

  it('counts the rows a rule moved, and refuses to call a same-answer row a change', () => {
    // `cue-any` moves two rows away from the left arm -- 3 and 7 -- and leaves the other six alone
    // because it *kept* the left answer, which is not a change however the rule got there. `chat-holds`
    // moves exactly the one row the left arm refused.
    expect(price('cue-any').changed).toBe(2);
    expect(price('chat-holds').changed).toBe(1);
    expect(price('chat').changed).toBe(0);
    // The two arms disagree on seven of the eight rows: row 0 is the only one they answer together.
    expect(price('reasoner').changed).toBe(7);
  });

  it('prints one line per rule, with the direction of its disagreement stated in rows', () => {
    const lines = describeArbitration(arbitrateDisputes(ROWS, DISPUTES, 'chat vs reasoner'));
    expect(lines.join('\n')).toMatch(/cue-any/);
    // The reading is refused before it is published when the arithmetic does not close, so a printed
    // table is a table whose identity already held.
    expect(lines.length).toBeGreaterThan(6);
  });
});

describe('the answers a routed reading hands to the shipping path', () => {
  it('answers one mark per row, taken from one of the two arms', () => {
    const choices = routeChoices(DISPUTES, policy('cue-any'));
    expect(choices).toHaveLength(ROWS.length);
    for (const [index, choice] of choices.entries()) {
      if (choice !== null) expect([CHAT[index], REASONER[index]]).toContain(choice);
    }
    // Row 3: chat refused and the rule takes the reasoner's answer, which is a string rather than the
    // `null` the artifact uses for "named nothing" — the two vocabularies meet here and nowhere else.
    expect(choices[3]).toBe('bar');
    // Row 7: the reasoner answered `pie` and the rule took it; a row where the rule kept the left
    // answer is the left answer, byte for byte.
    expect(choices[7]).toBe('pie');
    expect(routeChoices(DISPUTES, policy('chat'))).toEqual([...CHAT]);
    expect(routeChoices(DISPUTES, policy('reasoner'))).toEqual([...REASONER]);
  });

  it('writes a refusal as a null, which is what the store and the scorer read', () => {
    const silent: readonly Dispute[] = DISPUTES.map((dispute) => ({ ...dispute, product: { mark: 'declined', families: [] }, model: undefined }));
    expect(routeChoices(silent, policy('chat'))).toEqual(ROWS.map(() => null));
  });
});

describe('what the routing refused to publish', () => {
  it('refuses a population and a set of disputes that are not the same rows', () => {
    expect(() => arbitrateDisputes(ROWS, DISPUTES.slice(0, 3), 'chat vs reasoner')).toThrow(/8 rows and 3 disputes/);
  });

  it('refuses an empty population rather than publishing 0 of 0', () => {
    expect(() => arbitrateDisputes([], [], 'chat vs reasoner')).toThrow(/population is empty/);
  });

  it('refuses a row whose label no family names', () => {
    const odd = [...ROWS.slice(0, 7), row('what is the name of the customer', 'Word Cloud')];
    expect(() => arbitrateDisputes(odd, DISPUTES, 'chat vs reasoner')).toThrow(/label no family names/);
  });

  it('refuses to route the same row two ways at once, which is a policy that answered neither arm', () => {
    // A policy is allowed to answer only what one of the two said: `arbitrateDisputes` checks the
    // routed lead against both and refuses a third mark. This test is the guard's own guard — it
    // proves the refusal fires, so a future rule cannot quietly introduce a hybrid answer.
    const hybrid: Policy = { name: 'hybrid', note: 'answers a mark neither arm gave', choose: () => ({ mark: 'heatmap', families: ['heatmap'] }) };
    expect(() => arbitrateDisputes(ROWS, DISPUTES, 'chat vs reasoner', [hybrid])).toThrow(/neither system claimed/);
  });

  it('holds the names a caller can ask for, and no near-misses', () => {
    // The name is the interface: a typo must resolve to nothing rather than silently to whichever rule
    // happens to sort first, because a table printed under the wrong heading is a reading about a rule
    // nobody ran.
    expect(DUEL_POLICIES.find((entry) => entry.name === 'cue-lead')).toBeUndefined();
    expect(DUEL_POLICIES.find((entry) => entry.name === 'cue-led')).toBeDefined();
    expect(new Set(DUEL_POLICIES.map((entry) => entry.name)).size).toBe(DUEL_POLICIES.length);
  });
});

describe('two shipped readings, paired rather than subtracted', () => {
  it('scores each side the way the shipped path scores it, and counts the rows they differ on', () => {
    // Six rows. The left charts are right on 0, 2 and 4; the right charts on 0, 3 and 5. So one row is
    // right on both, two are left-only, two are right-only, and one is wrong on both: a gain of zero
    // that a difference of shares would have called a tie for the wrong reason.
    const pair = shippedPair(ROWS, ['line', 'bar', 'pie', 'line', 'pie', 'bar', 'bar', 'line'], ['line', 'bar', 'pie', 'bar', 'pie', 'line', 'pie', 'pie']);
    expect(pair).toEqual({ both: 3, leftOnly: 1, rightOnly: 1, neither: 3, p: 1 });
  });

  it('refuses two readings that are not over the same rows', () => {
    expect(() => shippedPair(ROWS, ['line'], ['line'])).toThrow(/marks for 8 rows/);
  });

  it('reads a refusal as a wrong chart rather than skipping the row', () => {
    // `declined` is a mark the shipped path can receive (a row the table answered), and its family list
    // is empty: counting it as anything but wrong would publish a share over the rows that had an
    // answer, which is the defect the arm's own population check exists for.
    const pair = shippedPair(ROWS.slice(0, 2), ['declined', 'pie'], ['declined', 'pie']);
    expect(pair).toEqual({ both: 1, leftOnly: 0, rightOnly: 0, neither: 1, p: 1 });
  });
});

describe('a row is a row, whichever seat it is in', () => {
  it('reads the same dispute the one-arm table would have built for the same answer', () => {
    // `disputeOf` computes the product from the pipeline; `duelOf` is handed the left arm's answer.
    // On a row where the two happen to agree, the two constructors must produce the same dispute —
    // otherwise the duel would be pricing a different question than the one-arm table.
    const product = disputeOf(ROWS[0] as ProfileInput, 'line');
    const duel = duelOf(ROWS[0] as ProfileInput, 'line', 'line');
    expect(duel.cueLead).toBe(product.cueLead);
    expect(duel.cueNamed).toEqual(product.cueNamed);
    expect(duel.model).toBe(product.model);
    expect(TRUTH[0]).toBe('line');
  });
});


/**
 * A two-row corpus, served over HTTP the way `dataset.ts` fetches it.
 *
 * The command's contract is about the *population*, so the fixture has to be a corpus rather than a row
 * list: the roster it computes and the roster the artifact carries are compared, and that comparison is
 * half of what the command refuses.
 */
const root = mkdtempSync(join(tmpdir(), 'nl2charts-text2vis-route-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const ENTRY = resolve('eval/text2vis/route.ts');
const MODULE_URL = pathToFileURL(ENTRY).href;

function cell(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

const TABLE = 'Region, Revenue\nNorth, 40\nSouth, 55\nEast, 31\nWest, 63';
const BODY = [
  `${TEXT2VIS_FIELDS.prompt},${TEXT2VIS_FIELDS.answer},${TEXT2VIS_FIELDS.code},${TEXT2VIS_FIELDS.chartType},Table Data`,
  [cell('Show the share of revenue each region holds'), cell('North'), cell(''), cell('Pie Chart'), cell(TABLE)].join(','),
  [cell('Compare revenue by region'), cell('North'), cell(''), cell('Bar Chart'), cell(TABLE)].join(','),
].join('\n');

const BODY_UNLABELLED = [
  `${TEXT2VIS_FIELDS.prompt},${TEXT2VIS_FIELDS.answer},${TEXT2VIS_FIELDS.code},${TEXT2VIS_FIELDS.chartType},Table Data`,
  [cell('Show the share of revenue each region holds'), cell('North'), cell(''), cell('Pie Chart'), cell(TABLE)].join(','),
  [cell('Compare revenue by region'), cell('North'), cell(''), cell('Bar Chart'), cell(TABLE)].join(','),
  [cell('A chart of the words customers use'), cell('North'), cell(''), cell('Word Cloud'), cell(TABLE)].join(','),
].join('\n');

const SERVED: readonly ProfileInput[] = [
  { prompt: 'Show the share of revenue each region holds', label: 'Pie Chart', tableData: TABLE },
  { prompt: 'Compare revenue by region', label: 'Bar Chart', tableData: TABLE },
];

async function serve(body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/csv' });
    response.end(body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}/Text2Vis.csv`, close: () => new Promise<void>((done) => server.close(() => done())) };
}

/** An artifact with two mark arms and a label arm, which is the shape `llm.ts` writes. */
function artifact(left: readonly (string | null)[], right: readonly (string | null)[], roster: string): string {
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
    corpus: { rows: 2, scored: 2, asked: 2, roster },
    arms: [arm('a-model', left), arm('b-model', right), { scale: 'label', model: 'a-model', choices: [null, null], scored: 2 }],
    paired: [],
  });
}

describe('the command line', () => {
  it('takes the flags it uses and refuses anything else', () => {
    expect(parseRouteArgs(['--answers', 'a.json'])).toEqual({ json: false, require: false, ship: false, answers: 'a.json' });
    expect(
      parseRouteArgs([
        '--answers', 'a.json', '--left', 'x', '--right', 'y', '--floor', 'f.json', '--repair', 'r.json', '--ship', '--require', '--json', '--artifact', 'o.json',
      ]),
    ).toEqual({
      json: true,
      require: true,
      ship: true,
      answers: 'a.json',
      left: 'x',
      right: 'y',
      floor: 'f.json',
      repair: 'r.json',
      artifact: 'o.json',
    });
    // A flag with no value, an unknown flag, and no artifact at all: the first two would silently read
    // the next flag as a path, and the third would price last week's file.
    expect(() => parseRouteArgs(['--answers'])).toThrow(/needs a value/);
    expect(() => parseRouteArgs(['--answers', 'a.json', '--model', 'x'])).toThrow(/unknown argument --model/);
    expect(() => parseRouteArgs([])).toThrow(/--answers is required/);
  });
});

describe('the command, end to end', () => {
  it('prices the two arms it was handed and writes the table', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'reading.json');
      const out = join(root, 'route.json');
      writeFileSync(answers, artifact(['pie', 'bar'], ['pie', 'pie'], rosterOf(SERVED)));
      const code = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--artifact', out],
        load: { cacheDir: join(root, 'csv-ok'), url: server.url },
      });
      expect(code).toBe(0);
      const written = JSON.parse(readFileSync(out, 'utf8')) as { model: string; population: { scored: number }; policies: { name: string }[] };
      expect(written.model).toBe('a-model + b-model');
      expect(written.population.scored).toBe(2);
      expect(written.policies.map((entry) => entry.name)).toContain('cue-led');
      expect(lines.join('\n')).toContain('text2vis: wrote');
      // The two seats are named: a table that does not say which answer sat in which seat is a table of
      // six rules about nobody.
      expect(lines.join('\n')).toContain('a-model + b-model');
    } finally {
      await server.close();
    }
  });

  it('prices what a caller receives, for each answer set, with --ship', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'shipping.json');
      writeFileSync(answers, artifact(['pie', 'bar'], ['pie', 'pie'], rosterOf(SERVED)));
      const code = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--ship'],
        load: { cacheDir: join(root, 'csv-ship'), url: server.url },
      });
      expect(code).toBe(0);
      const text = lines.join('\n');
      expect(text).toMatch(/a-model: decided \d+, shipped \d+/);
      expect(text).toMatch(/b-model: decided \d+, shipped \d+/);
      // The third line is the routed answers, and its name is the rule rather than an arm: it is not a
      // model, and calling it one would put a policy in a table of endpoints.
      expect(text).toMatch(/cue-any|cue-led/);
      expect(text).toContain('McNemar');
    } finally {
      await server.close();
    }
  });

  it('refuses a file with one arm, because a route between an arm and itself is not a reading', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'one-arm.json');
      writeFileSync(answers, JSON.stringify({
        corpus: { rows: 2, scored: 2, asked: 2, roster: rosterOf(SERVED) },
        arms: [{ scale: 'mark', model: 'only', requested: 2, scored: 2, choices: ['pie', 'bar'] }],
      }));
      const code = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers],
        load: { cacheDir: join(root, 'csv-one'), url: server.url },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/one mark arm/);
    } finally {
      await server.close();
    }
  });

  it('refuses an artifact whose rows are not the rows on disk', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'stale.json');
      writeFileSync(answers, artifact(['pie', 'bar'], ['pie', 'pie'], 'a-fingerprint-of-some-other-corpus'));
      const code = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers],
        load: { cacheDir: join(root, 'csv-stale'), url: server.url },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/different population/);
    } finally {
      await server.close();
    }
  });

  it('refuses an arm with no per-row answers, and names the arm', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'no-choices.json');
      writeFileSync(answers, JSON.stringify({
        corpus: { rows: 2, scored: 2, asked: 2, roster: rosterOf(SERVED) },
        arms: [
          { scale: 'mark', model: 'a-model', requested: 2, scored: 2, choices: ['pie', 'bar'] },
          { scale: 'mark', model: 'b-model', requested: 2, scored: 2 },
        ],
      }));
      const code = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--right', 'b-model'],
        load: { cacheDir: join(root, 'csv-no-choices'), url: server.url },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/no per-row choices for b-model/);
    } finally {
      await server.close();
    }
  });

  it('holds the reading to the floor it was given, and says so when the floor is below it', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'floored.json');
      writeFileSync(answers, artifact(['pie', 'bar'], ['pie', 'pie'], rosterOf(SERVED)));
      const floor = join(root, 'floor.json');
      writeFileSync(floor, JSON.stringify({ llm: { duel: { scored: 2, best: 'cue-any', mark: 1 } } }));
      const met = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--require', '--floor', floor],
        load: { cacheDir: join(root, 'csv-floor'), url: server.url },
      });
      expect(met).toBe(0);
      expect(lines.join('\n')).toMatch(/holds the floor/);
      // A floor above the reading is a regression, and the message has to say which rule and by how
      // much — a bare "below floor" leaves a reader to re-derive the number.
      writeFileSync(floor, JSON.stringify({ llm: { duel: { scored: 2, best: 'cue-any', mark: 3 } } }));
      const missed = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--require', '--floor', floor],
        load: { cacheDir: join(root, 'csv-floor'), url: server.url },
      });
      expect(missed).toBe(1);
      expect(lines.join('\n')).toMatch(/reads \d+ and the floor is 3/);
    } finally {
      await server.close();
    }
  });

  it('says a floor file without a duel is not a floor, rather than passing silently', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'unfloored.json');
      writeFileSync(answers, artifact(['pie', 'bar'], ['pie', 'pie'], rosterOf(SERVED)));
      const floor = join(root, 'no-duel.json');
      writeFileSync(floor, JSON.stringify({ llm: { arms: {} } }));
      const code = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--require', '--floor', floor],
        load: { cacheDir: join(root, 'csv-unfloored'), url: server.url },
      });
      expect(code).toBe(0);
      expect(lines.join('\n')).toMatch(/records no llm.duel floor/);
    } finally {
      await server.close();
    }
  });
});

describe('the floor a routing reading is held to', () => {
  it('refuses a reading over another population, another rule, or a lower number', async () => {
    const report = arbitrateDisputes(ROWS, DISPUTES, 'chat vs reasoner', DUEL_POLICIES);
    const { assertDuel } = await import('../eval/text2vis/route.js');
    expect(() => assertDuel({ ...report, population: { scored: 8, roster: 'r' } }, { scored: 9, best: 'cue-any', mark: 1 })).toThrow(/another instrument/);
    expect(() => assertDuel({ ...report, population: { scored: 8, roster: 'r' } }, { scored: 8, best: 'nope', mark: 1 })).toThrow(/does not price/);
    expect(() => assertDuel({ ...report, population: { scored: 8, roster: 'r' } }, { scored: 8, best: 'cue-any', mark: 99 })).toThrow(/regression in the routing table/);
    expect(() =>
      assertDuel({ ...report, population: { scored: 8, roster: 'r' } }, { scored: 8, best: 'cue-any', mark: 1, policies: { 'cue-led': 4 } }),
    ).toThrow(/cue-led reads 5 and the floor records 4/);
  });
});


describe('what the refusals are for', () => {
  it('refuses a rename table that names a rule the source does not have', () => {
    // Six names over five implementations reads as six rules and prices as five: the missing one is
    // `undefined` on the first row it is asked, which is a crash inside a table rather than a message.
    expect(() => renamePolicies([{ from: 'nope', name: 'x', note: 'a rule nobody wrote' }])).toThrow(/there is no nope policy to rename/);
  });

  it('refuses two answer lists that are not one per row, and names both lengths', () => {
    expect(() => duelReport(ROWS, CHAT, REASONER.slice(0, 6), 'chat + reasoner', 'r')).toThrow(/8 and 6 answers for 8 rows/);
  });
});

describe('the seats, the arm and the repair file the command was handed', () => {
  it('refuses a named arm the artifact does not have', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'named.json');
      writeFileSync(answers, artifact(['pie', 'bar'], ['pie', 'pie'], rosterOf(SERVED)));
      const code = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--left', 'ghost-model'],
        load: { cacheDir: join(root, 'csv-named'), url: server.url },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/no ghost-model mark arm/);
    } finally {
      await server.close();
    }
  });

  it('refuses the same arm in both seats', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'same.json');
      writeFileSync(answers, artifact(['pie', 'bar'], ['pie', 'pie'], rosterOf(SERVED)));
      const code = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--left', 'a-model', '--right', 'a-model'],
        load: { cacheDir: join(root, 'csv-same'), url: server.url },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/both seats are a-model/);
    } finally {
      await server.close();
    }
  });

  it('asks the shipping path for the second question when a repair file is given, and checks it', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'repaired.json');
      writeFileSync(answers, artifact(['pie', 'bar'], ['pie', 'pie'], rosterOf(SERVED)));
      const repair = join(root, 'repair.json');
      // No row refused a first answer in this fixture, so the second question is an empty map — which
      // is the point: the file is read, held to the roster, and then asked for nothing.
      writeFileSync(repair, JSON.stringify({ population: { roster: rosterOf(SERVED) }, rows: [] }));
      const code = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--ship', '--repair', repair],
        load: { cacheDir: join(root, 'csv-repair'), url: server.url },
      });
      expect(code).toBe(0);
      expect(lines.join('\n')).toMatch(/a-model: decided/);

      // A repair file with no roster, and one written for another corpus: both are files whose answers
      // cannot be placed, and placing them anyway would answer a row nobody asked about.
      writeFileSync(repair, JSON.stringify({ rows: [] }));
      const noRoster = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--ship', '--repair', repair],
        load: { cacheDir: join(root, 'csv-repair'), url: server.url },
      });
      expect(noRoster).toBe(1);
      expect(lines.join('\n')).toMatch(/carries no population.roster/);

      writeFileSync(repair, JSON.stringify({ population: { roster: 'a-fingerprint-of-some-other-corpus' }, rows: [] }));
      const foreign = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--ship', '--repair', repair],
        load: { cacheDir: join(root, 'csv-repair'), url: server.url },
      });
      expect(foreign).toBe(1);
      expect(lines.join('\n')).toMatch(/answered a different population/);
    } finally {
      await server.close();
    }
  });

  it('refuses a floor that records a rule this table does not price', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'ghost-rule.json');
      writeFileSync(answers, artifact(['pie', 'bar'], ['pie', 'pie'], rosterOf(SERVED)));
      const floor = join(root, 'ghost-floor.json');
      writeFileSync(floor, JSON.stringify({ llm: { duel: { scored: 2, best: 'cue-any', mark: 1, policies: { ghost: 1 } } } }));
      const code = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--require', '--floor', floor],
        load: { cacheDir: join(root, 'csv-ghost'), url: server.url },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/the floor records ghost, which this table does not price/);
    } finally {
      await server.close();
    }
  });
});


describe('the files a command can be handed and should not price', () => {
  it('refuses a file with no arms at all, before it asks which seat is which', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'no-arms.json');
      writeFileSync(answers, JSON.stringify({ corpus: { rows: 2, scored: 2, asked: 2, roster: rosterOf(SERVED) } }));
      const code = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers],
        load: { cacheDir: join(root, 'csv-no-arms'), url: server.url },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/no mark-scale arm/);
    } finally {
      await server.close();
    }
  });

  it('refuses a file with no fingerprint, because its rows cannot be identified', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'no-roster.json');
      writeFileSync(answers, JSON.stringify({ corpus: { rows: 2, scored: 2, asked: 2 }, arms: [] }));
      const code = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers],
        load: { cacheDir: join(root, 'csv-no-roster'), url: server.url },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/carries no corpus.roster/);
    } finally {
      await server.close();
    }
  });

  it('keeps the rows the corpus dropped out of the population, and says how many', async () => {
    const server = await serve(BODY_UNLABELLED);
    const lines: string[] = [];
    try {
      const answers = join(root, 'dropped.json');
      const corpus: readonly ProfileInput[] = [
        ...SERVED,
        { prompt: 'A chart of the words customers use', label: 'Word Cloud', tableData: TABLE },
      ];
      writeFileSync(answers, artifact(['pie', 'bar'], ['pie', 'pie'], rosterOf(corpus)));
      const code = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers],
        load: { cacheDir: join(root, 'csv-dropped'), url: server.url },
      });
      expect(code).toBe(1);
      // The roster is over the whole corpus while the population is the two scored rows, so this run is
      // refused as a population mismatch — and the sentence that matters is the one saying a label was
      // dropped, because a silently smaller population is a share nobody can reproduce.
      expect(lines.join('\n')).toMatch(/1 rows carry a label no family names/);
    } finally {
      await server.close();
    }
  });

  it('prices every scored row when the artifact does not say how many it asked', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'no-asked.json');
      const parsed = JSON.parse(artifact(['pie', 'bar'], ['pie', 'pie'], rosterOf(SERVED))) as Record<string, unknown>;
      (parsed['corpus'] as Record<string, unknown>)['asked'] = undefined;
      writeFileSync(answers, JSON.stringify(parsed));
      const code = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--json'],
        load: { cacheDir: join(root, 'csv-no-asked'), url: server.url },
      });
      expect(code).toBe(0);
      // `--json` prints the payload the artifact would hold, which is how a reader gets the table without
      // writing a file; the population comes from the corpus when the artifact does not claim a prefix.
      expect(lines.join('\n')).toContain('"population"');
    } finally {
      await server.close();
    }
  });

  it('holds the reading to the default floor when no floor was named, and that floor is another corpus', async () => {
    const server = await serve(BODY);
    const lines: string[] = [];
    try {
      const answers = join(root, 'default-floor.json');
      writeFileSync(answers, artifact(['pie', 'bar'], ['pie', 'pie'], rosterOf(SERVED)));
      const code = await entryRoute(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', answers, '--require'],
        load: { cacheDir: join(root, 'csv-default-floor'), url: server.url },
      });
      // The repository's floor is over 1,470 rows, so a two-row fixture cannot meet it — and that is the
      // assertion: `--require` with no path is not "no floor", it is the recorded one.
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/the floor was taken on 1470 rows/);
    } finally {
      await server.close();
    }
  });

  it('refuses to be run with no arguments at all', async () => {
    const code = await entryRoute(ENTRY, MODULE_URL, () => undefined, {});
    expect(code).toBe(1);
  });
});
