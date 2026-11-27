/**
 * The choice reading, pinned where it can be wrong without crashing.
 *
 * Three things can go wrong here and only one of them throws. The graph can be read at the wrong
 * source (a shared column counted as a declared key, which would turn a guess into evidence), the
 * position can be measured against a list the card does not print (a sorted copy instead of the
 * manifest's order), and the partition can fail to add up (a case in two kinds, a displaced table
 * counted twice, a window that promotes more tables than sat outside it). The unit cases pin one
 * of those at a time with a fixture small enough to count by hand; the bookkeeping cases build an
 * outcome and mutate one count, because a gate that cannot be made to fire is a gate nobody tested.
 *
 * The fixture is a five-table database with a declared chain `items — orders — customers — regions`
 * and one table that is joined to nothing but shares a column name with `regions`. That shape is
 * what lets one fixture produce all three kinds: a declared neighbour, a shared-column sibling, and
 * a table the schema offers no path to.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHOICE_KINDS,
  CHOICE_UNCARDED,
  CHOICE_WINDOWS,
  DEFAULT_CHOICE_ARM,
  choiceDirection,
  choiceLines,
  choicePath,
  choiceProblems,
  choiceSchemaOf,
  choiceSentence,
  entrypoint,
  exclusiveTokens,
  focusOrder,
  hopsTo,
  isEntry,
  kindOf,
  main,
  matchScore,
  readChoiceInputs,
  resolveChoiceSettings,
  runChoice,
  schemasOf,
  startIfEntry,
  swapOf,
  tallyChoice,
  writeChoiceArtifact,
} from '../eval/bird/choice.js';
import type { ChoiceCase, ChoiceOutcome, ChoiceSchema } from '../eval/bird/choice.js';
import type { BirdTable } from '../eval/bird/data.js';

/**
 * Five tables, four of them on a declared chain and one joined to nothing.
 *
 * `audit_log` carries `code`, which `regions` also carries, so the shared-column source adds an
 * edge the manifest does not declare — the only way a test can tell `sibling` from `neighbour`.
 */
const SHOP: BirdTable = {
  db_id: 'shop',
  tableNames: ['items', 'orders', 'customers', 'regions', 'audit_log'],
  tableNamesReadable: ['items', 'orders', 'customers', 'regions', 'audit log'],
  columnNames: [
    [-1, '*'],
    [0, 'id'],
    [0, 'name'],
    [0, 'price'],
    [1, 'id'],
    [1, 'item_id'],
    [1, 'customer_id'],
    [1, 'qty'],
    [2, 'id'],
    [2, 'name'],
    [2, 'region_id'],
    [3, 'id'],
    [3, 'name'],
    [3, 'code'],
    [4, 'id'],
    [4, 'code'],
  ],
  columnNamesReadable: [
    [-1, '*'],
    [0, 'id'],
    [0, 'name'],
    [0, 'price'],
    [1, 'id'],
    [1, 'item_id'],
    [1, 'customer_id'],
    [1, 'qty'],
    [2, 'id'],
    [2, 'name'],
    [2, 'region_id'],
    [3, 'id'],
    [3, 'name'],
    [3, 'code'],
    [4, 'id'],
    [4, 'code'],
  ],
  columnTypes: ['text', 'integer', 'text', 'real', 'integer', 'integer', 'integer', 'integer', 'integer', 'text', 'integer', 'integer', 'text', 'text', 'integer', 'text'],
  foreignKeys: [
    [5, 1],
    [6, 8],
    [10, 11],
  ],
};

const SCHEMA = choiceSchemaOf(SHOP);

/** A statement that reads exactly one table, so a pair differs in the relation and nothing else. */
const from = (table: string): string => `select count(*) from ${table}`;

const cases = (...rows: readonly ChoiceCase[]): readonly ChoiceCase[] => rows;

const tally = (rows: readonly ChoiceCase[], schemas = new Map([['shop', SCHEMA]])): ChoiceOutcome =>
  tallyChoice({ split: 'dev', arm: 'arm', total: rows.length, passed: 0, cases: rows }, schemas);

describe('the schema a choice is read against', () => {
  it('keeps the manifest order, which is the order the card prints', () => {
    expect(SCHEMA.order).toEqual(['items', 'orders', 'customers', 'regions', 'audit_log']);
  });

  it('reads columns per table, skipping the star and any unnamed owner', () => {
    expect(SCHEMA.columns.get('orders')).toEqual(['id', 'item_id', 'customer_id', 'qty']);
    expect([...(SCHEMA.columns.get('-1') ?? [])]).toEqual([]);
  });

  it('keeps the declared edges apart from the ones a shared column adds', () => {
    expect(SCHEMA.declared.get('items')).toEqual(['orders']);
    expect(SCHEMA.shared.get('audit_log')).toEqual(['regions']);
    expect(SCHEMA.declared.get('audit_log')).toEqual([]);
  });

  it('does not print one table twice, whatever the manifest spells', () => {
    const doubled = choiceSchemaOf({ ...SHOP, tableNames: ['items', 'Items', 'orders'] });
    expect(doubled.order).toEqual(['items', 'orders']);
  });
});

describe('how far one table is from another', () => {
  it('counts hops, and stops at the limit rather than at the end of the graph', () => {
    const targets = new Set(['items']);
    expect(hopsTo(SCHEMA.declared, 'items', targets)).toBe(0);
    expect(hopsTo(SCHEMA.declared, 'orders', targets)).toBe(1);
    expect(hopsTo(SCHEMA.declared, 'customers', targets)).toBe(2);
    // Three declared joins away is past `NEIGHBOUR_HOPS`, which is the claim the kind makes.
    expect(hopsTo(SCHEMA.declared, 'regions', targets)).toBeUndefined();
    expect(hopsTo(SCHEMA.declared, 'regions', targets, 3)).toBe(3);
  });

  it('answers undefined for a name the graph does not have, and for a component of its own', () => {
    expect(hopsTo(SCHEMA.declared, 'nowhere', new Set(['items']))).toBeUndefined();
    expect(hopsTo(SCHEMA.declared, 'audit_log', new Set(['items']))).toBeUndefined();
  });
});

describe('the kind of a swap', () => {
  it('calls a declared neighbour a neighbour', () => {
    const swap = swapOf('orders', new Set(['items']), SCHEMA);
    expect(swap).toMatchObject({ extra: 'orders', declared: 1, kind: 'neighbour' });
  });

  it('calls a shared column a sibling, because the manifest does not declare it', () => {
    const swap = swapOf('audit_log', new Set(['regions']), SCHEMA);
    expect(swap).toMatchObject({ extra: 'audit_log', declared: undefined, shared: 1, kind: 'sibling' });
  });

  it('calls two declared joins a neighbour at distance two, and nothing further', () => {
    expect(swapOf('customers', new Set(['items']), SCHEMA).kind).toBe('neighbour');
    expect(swapOf('customers', new Set(['items']), SCHEMA).declared).toBe(2);
    expect(swapOf('audit_log', new Set(['items']), SCHEMA)).toMatchObject({ kind: 'distant', declared: undefined });
  });

  it('refuses to call a name the card does not carry distant', () => {
    // A derived-table alias that reached the `from` clause is a schema-reading defect, and folding
    // it into "far from the gold" would report it as a join choice.
    expect(swapOf('d1', new Set(['items']), SCHEMA)).toMatchObject({ kind: CHOICE_UNCARDED, declared: undefined });
  });
});

describe('the one kind a case is counted under', () => {
  it('takes the strongest relation the statement offered', () => {
    const neighbour = swapOf('orders', new Set(['items']), SCHEMA);
    const distant = swapOf('audit_log', new Set(['items']), SCHEMA);
    expect(kindOf([distant, neighbour])).toBe('neighbour');
    expect(kindOf([distant])).toBe('distant');
    expect(kindOf([])).toBe(CHOICE_UNCARDED);
  });
});

describe('how much of a question a table speaks to', () => {
  it('counts a token once, whether it names the table or one of its columns', () => {
    expect(matchScore(['qty'], 'orders', SCHEMA)).toBe(1);
    expect(matchScore(['order', 'qty'], 'orders', SCHEMA)).toBe(2);
    // A word no name carries scores nothing, which is what keeps the ordering a permutation.
    expect(matchScore(['weather'], 'orders', SCHEMA)).toBe(0);
  });

  it('orders by that count and breaks ties in card order', () => {
    expect(focusOrder(['regions'], SCHEMA)).toEqual(['regions', 'items', 'orders', 'customers', 'audit_log']);
    // No word matches anything: the card is returned unchanged, not shuffled.
    expect(focusOrder(['weather'], SCHEMA)).toEqual([...SCHEMA.order]);
  });

  it('returns a permutation of the card, never a subset', () => {
    const ordered = focusOrder(['orders', 'customers', 'qty'], SCHEMA);
    expect([...ordered].sort()).toEqual([...SCHEMA.order].sort());
  });
});

describe('a word the card says is somewhere the statement did not look', () => {
  it('names a token that draws from a displaced table and from nothing the statement read', () => {
    // `qty` lives on `orders` only, and the statement read `items`.
    expect(exclusiveTokens(['qty', 'items'], ['orders'], ['items'], SCHEMA)).toEqual(['qty']);
  });

  it('drops a word both sides carry, because a hint that fires on every table is noise', () => {
    // `name` is a column of `items` and of `customers`; a statement reading one of them is not
    // refuted by the other.
    expect(exclusiveTokens(['name'], ['customers'], ['items'], SCHEMA)).toEqual([]);
  });

  it('counts a token that names the table itself, not only its columns', () => {
    // `audit` is a prefix of the table name and passes the product's four-character floor; `log`
    // does not, and the floor is why: a two- or three-letter prefix would make `or` name `orders`.
    expect(exclusiveTokens(['audit', 'log'], ['audit_log'], ['items'], SCHEMA)).toEqual(['audit']);
    expect(exclusiveTokens(['regions'], ['regions'], ['items'], SCHEMA)).toEqual(['regions']);
  });

  it('reads a table the manifest gave no columns to as a name and nothing else', () => {
    // Some manifests list a table with no column rows of its own. The match is then the name
    // alone, and the exclusive reading can still name the table while naming none of its columns.
    const bare: ChoiceSchema = { ...SCHEMA, columns: new Map([['items', ['id']]]) };
    expect(matchScore(['orders', 'qty'], 'orders', bare)).toBe(1);
    expect(exclusiveTokens(['qty'], ['orders'], ['items'], bare)).toEqual([]);
    expect(exclusiveTokens(['orders'], ['orders'], ['items'], bare)).toEqual(['orders']);
  });

  it('sorts what it returns and answers an empty list for an empty question', () => {
    expect(exclusiveTokens(['qty', 'price'], ['orders'], ['items'], SCHEMA)).toEqual(['qty']);
    expect(exclusiveTokens([], ['orders'], ['items'], SCHEMA)).toEqual([]);
  });
});

describe('the direction of a table difference', () => {
  it('says which side reads a table the other does not', () => {
    expect(choiceDirection(['items'], ['items'])).toBeUndefined();
    expect(choiceDirection(['items'], ['items', 'orders'])).toBe('missing');
    expect(choiceDirection(['items', 'orders'], ['items'])).toBe('extra');
    expect(choiceDirection(['items', 'orders'], ['items', 'customers'])).toBe('both');
  });
});

describe('a population counted by hand', () => {
  it('lands each case in one kind and keeps the counts reconciling', () => {
    const outcome = tally(
      cases(
        { id: '1', db: 'shop', question: 'how many items', sql: from('items'), gold: from('items') },
        { id: '2', db: 'shop', question: 'how many items', sql: from('orders'), gold: from('items') },
        { id: '3', db: 'shop', question: 'which regions', sql: from('audit_log'), gold: from('regions') },
        { id: '4', db: 'shop', question: 'how many', sql: from('audit_log'), gold: from('items') },
        { id: '5', db: 'shop', question: 'how many', sql: from('items'), gold: from('items') },
      ),
    );
    expect(outcome.compared).toBe(5);
    expect(outcome.sameTables).toBe(2);
    expect(outcome.casesWithExtra).toBe(3);
    expect(outcome.kinds).toEqual({ neighbour: 1, sibling: 1, distant: 1, uncarded: 0 });
    expect(outcome.swaps).toBe(3);
    expect(outcome.problems).toEqual([]);
  });

  it('counts a case the artifact kept no statement for, and refuses to score it', () => {
    const outcome = tally(
      cases(
        { id: '1', db: 'shop', question: 'q', sql: '   ', gold: from('items') },
        { id: '2', db: 'shop', question: 'q' },
      ),
    );
    expect(outcome.unretained).toBe(2);
    expect(outcome.compared).toBe(0);
    expect(outcome.problems).toEqual([]);
  });

  it('reads a database the manifest does not describe as a manifest gap', () => {
    const outcome = tally(cases({ id: '1', db: 'elsewhere', question: 'q', sql: from('items'), gold: from('orders') }));
    expect(outcome.unschema).toBe(1);
    expect(outcome.compared).toBe(1);
    expect(outcome.sameTables).toBe(0);
    expect(outcome.problems).toEqual([]);
  });

  it('records a position for every displaced table the card prints', () => {
    const outcome = tally(cases({ id: '1', db: 'shop', question: 'how many orders', sql: from('items'), gold: from('orders') }));
    expect(outcome.displaced).toBe(1);
    expect(outcome.positions).toHaveLength(1);
    expect(outcome.positions[0]).toMatchObject({ db: 'shop', table: 'orders', before: 2, tables: 5 });
    // `orders` is named by the question, so the focus order lifts it to the first line.
    expect(outcome.positions[0]?.after).toBe(1);
    expect(outcome.positions[0]?.score).toBe(1);
  });

  it('counts a displaced table the card does not print rather than placing it at zero', () => {
    const outcome = tally(cases({ id: '1', db: 'shop', question: 'q', sql: from('items'), gold: from('items', ) }));
    expect(outcome.uncarded).toBe(0);
    const withUnknown = tally(cases({ id: '1', db: 'shop', question: 'q', sql: from('orders'), gold: 'select count(*) from ghost' }));
    expect(withUnknown.uncarded).toBe(1);
    expect(withUnknown.positions).toHaveLength(0);
    expect(withUnknown.problems).toEqual([]);
  });

  it('reads the windows over the positions it recorded, before and after the ordering', () => {
    const rows: ChoiceCase[] = [];
    for (const table of ['orders', 'customers', 'regions', 'audit_log']) {
      rows.push({ id: table, db: 'shop', question: 'how many', sql: from('items'), gold: from(table) });
    }
    const outcome = tally(cases(...rows));
    expect(outcome.positions).toHaveLength(4);
    const top3 = outcome.windows.find((window) => window.at === 3);
    // `items, orders, customers` are the first three lines; `regions` and `audit_log` are past it.
    expect(top3?.before).toBe(2);
    // Nothing in the question names a table, so the ordering is the card's own and nothing moves.
    expect(top3?.after).toBe(2);
    expect(top3?.moved).toBe(0);
    expect(outcome.windows.map((window) => window.at)).toEqual([...CHOICE_WINDOWS]);
  });

  it('takes the median of an even count as the midpoint of the two middle positions', () => {
    const rows: ChoiceCase[] = ['orders', 'customers', 'regions', 'audit_log'].map((table) => ({
      id: table,
      db: 'shop',
      question: 'how many',
      sql: from('items'),
      gold: from(table),
    }));
    const outcome = tally(cases(...rows));
    // Positions 2, 3, 4, 5: the median is 3.5, not a position and not rounded.
    expect(outcome.medianBefore).toBe(3.5);
  });

  it('answers a zero median when nothing was displaced, rather than failing on an empty list', () => {
    const outcome = tally(cases({ id: '1', db: 'shop', question: 'q', sql: from('items'), gold: from('items') }));
    expect(outcome.medianBefore).toBe(0);
    expect(outcome.positions).toHaveLength(0);
    expect(outcome.problems).toEqual([]);
  });
});

describe('the gates', () => {
  const base = (): ChoiceOutcome =>
    tally(
      cases(
        { id: '1', db: 'shop', question: 'how many orders', sql: from('orders'), gold: from('items') },
        { id: '2', db: 'shop', question: 'q', sql: from('items'), gold: from('items') },
      ),
    );

  it('accepts a reading that adds up', () => {
    expect(base().problems).toEqual([]);
  });

  it('refuses case kinds that do not sum to the cases that read an extra table', () => {
    const outcome = base();
    const broken = { ...outcome, kinds: { ...outcome.kinds, distant: outcome.kinds.distant + 1 } };
    expect(choiceProblems(broken).join(' ')).toContain('case kinds sum to');
  });

  it('refuses swap kinds that do not sum to the extra tables counted', () => {
    const outcome = base();
    const broken = { ...outcome, swaps: outcome.swaps + 1 };
    expect(choiceProblems(broken).join(' ')).toContain('swap kinds sum to');
  });

  it('refuses a case with an extra table that the directions do not account for', () => {
    const outcome = base();
    const broken = { ...outcome, casesWithExtra: outcome.casesWithExtra + 1 };
    expect(choiceProblems(broken).join(' ')).toContain('read an extra table, but the directions say');
  });

  it('refuses compared and unretained counts that do not add up to the population', () => {
    const outcome = base();
    const broken = { ...outcome, unretained: 1 };
    expect(choiceProblems(broken).join(' ')).toContain('do not add up to the');
  });

  it('refuses same-table, differing and unmodelled counts that do not sum to compared', () => {
    const outcome = base();
    const broken = { ...outcome, unschema: 1 };
    expect(choiceProblems(broken).join(' ')).toContain('do not add up to the 2 compared');
  });

  it('refuses a population that is not the artifact total minus its passed count', () => {
    const outcome = base();
    const broken = { ...outcome, total: 5 };
    expect(choiceProblems(broken).join(' ')).toContain("not the artifact's total minus its passed count");
  });

  it('refuses a position outside the card, before or after the ordering', () => {
    const outcome = base();
    const position = outcome.positions[0];
    if (position === undefined) throw new Error('the fixture displaces one table');
    expect(choiceProblems({ ...outcome, positions: [{ ...position, before: 0 }, position] }).join(' ')).toContain(
      'is at position 0 of 5',
    );
    expect(choiceProblems({ ...outcome, positions: [{ ...position, after: 9 }, position] }).join(' ')).toContain(
      'under the focus order',
    );
  });

  it('refuses a displacement count the positions do not account for', () => {
    const outcome = base();
    const broken = { ...outcome, displaced: outcome.displaced + 1 };
    expect(choiceProblems(broken).join(' ')).toContain('but the cases displaced');
  });

  it('refuses a window that promotes more tables than sat outside it', () => {
    const outcome = base();
    const windows = outcome.windows.map((window) => (window.at === 1 ? { ...window, before: 0, moved: 9 } : window));
    expect(choiceProblems({ ...outcome, windows }).join(' ')).toContain('promotes 9 table(s) from outside');
  });

  it('refuses a window that loses more tables than it ever had inside it', () => {
    const outcome = base();
    const windows = outcome.windows.map((window) => (window.at === 1 ? { ...window, before: 0, after: 0, moved: 0, lost: 1 } : window));
    expect(choiceProblems({ ...outcome, windows }).join(' ')).toContain('loses 1 table(s) it never had inside it');
  });

  it('refuses a window count above the positions recorded', () => {
    const outcome = base();
    const windows = outcome.windows.map((window) => (window.at === 5 ? { ...window, before: 9 } : window));
    expect(choiceProblems({ ...outcome, windows }).join(' ')).toContain('above the 1 position(s) recorded');
  });
});

describe('the report', () => {
  it('names every kind, then the positions and the windows', () => {
    const outcome = tally(cases({ id: '1', db: 'shop', question: 'q', sql: from('orders'), gold: from('items') }));
    const lines = choiceLines(outcome).join('\n');
    for (const kind of CHOICE_KINDS) expect(lines).toContain(kind);
    expect(lines).toContain('displaced gold table(s)');
    expect(lines).toContain('top  1');
    expect(lines).toContain('word(s) the card says live only on a table the statement did not read');
  });

  it('prints a zero share for an empty population instead of dividing by it', () => {
    const outcome = tally(cases({ id: '1', db: 'shop', question: 'q', sql: from('items'), gold: from('items') }));
    expect(outcome.casesWithExtra).toBe(0);
    expect(choiceLines(outcome).join('\n')).toContain('0.0% of 0');
  });

  it('prints the uncarded count only when there is one', () => {
    const none = tally(cases({ id: '1', db: 'shop', question: 'q', sql: from('orders'), gold: from('items') }));
    expect(choiceLines(none).join('\n')).not.toContain('are not on the card at all');
    const some = tally(cases({ id: '1', db: 'shop', question: 'q', sql: from('orders'), gold: 'select count(*) from ghost' }), new Map([['shop', SCHEMA]]));
    expect(choiceLines(some).join('\n')).toContain('are not on the card at all');
  });

  it('names the uncarded kind in the report, because a schema defect is not a distance', () => {
    const outcome = tally(cases({ id: '1', db: 'shop', question: 'q', sql: from('d1'), gold: from('items') }));
    expect(choiceLines(outcome).join('\n')).toContain(CHOICE_UNCARDED);
  });

  it('quotes one sentence, and says when there was nothing to read', () => {
    const outcome = tally(cases({ id: '1', db: 'shop', question: 'q', sql: from('items'), gold: from('items') }));
    expect(choiceSentence(outcome)).toBe('no statement read a table the gold does not, so there is no choice to read');
    const read = tally(cases({ id: '1', db: 'shop', question: 'q', sql: from('orders'), gold: from('items') }));
    expect(choiceSentence(read)).toContain('read a table the gold does not');
    expect(choiceSentence(read)).toContain('a difference is not a defect');
  });

  it('breaks a tie between kinds by the order they are declared in', () => {
    // One neighbour and one distant, each counted once: the sentence names the first declared.
    const outcome = tally(
      cases(
        { id: '1', db: 'shop', question: 'q', sql: from('orders'), gold: from('items') },
        { id: '2', db: 'shop', question: 'q', sql: from('audit_log'), gold: from('items') },
      ),
    );
    expect(outcome.kinds.neighbour).toBe(1);
    expect(outcome.kinds.distant).toBe(1);
    expect(choiceSentence(outcome)).toContain('read a table `neighbour`');
  });

  it('names a later kind when it strictly outnumbers the first one', () => {
    const outcome = tally(
      cases(
        { id: '1', db: 'shop', question: 'q', sql: from('orders'), gold: from('items') },
        { id: '2', db: 'shop', question: 'q', sql: from('audit_log'), gold: from('items') },
        { id: '3', db: 'shop', question: 'q', sql: from('audit_log'), gold: from('customers') },
      ),
    );
    expect(outcome.kinds).toMatchObject({ neighbour: 1, distant: 2 });
    expect(choiceSentence(outcome)).toContain('read a table `distant`');
  });
});

describe('the artifact a reading is taken on', () => {
  const artifact = {
    split: 'dev',
    generatedAt: '2026-11-27T00:00:00Z',
    arms: [{ arm: 'arm', passed: 1, total: 3 }],
    cases: [
      { arm: 'arm', id: 1, passed: false, sql: from('items'), gold: from('orders'), asked: { db: 'shop', question: 'how many orders' } },
      { arm: 'arm', id: 2, passed: true, sql: from('items'), gold: from('orders'), asked: { db: 'shop', question: 'q' } },
      { arm: 'other', id: 3, passed: false, sql: from('items'), gold: from('orders'), asked: { db: 'shop', question: 'q' } },
      { arm: 'arm', id: 4, passed: false, sql: from('items'), gold: from('orders') },
    ],
  };

  it('reads one arm, its unpassed cases, and the totals the arm row declares', () => {
    const input = readChoiceInputs(artifact, 'arm');
    expect(input.total).toBe(3);
    expect(input.passed).toBe(1);
    expect(input.cases).toHaveLength(1);
    // A case that names no database is left out of the reading, not scored against an empty one.
    expect(input.cases[0]?.db).toBe('shop');
  });

  it('falls back to counting the cases when the artifact declares no arm row', () => {
    const input = readChoiceInputs({ ...artifact, arms: undefined }, 'arm');
    expect(input.total).toBe(3);
    expect(input.passed).toBe(1);
  });

  it('carries the artifact path and timestamp, so two dispatches cannot be confused', () => {
    const input = readChoiceInputs(artifact, 'arm', { path: 'somewhere.json', generatedAt: '2026-11-27T00:00:00Z' });
    expect(input.source).toEqual({ path: 'somewhere.json', generatedAt: '2026-11-27T00:00:00Z' });
    expect(readChoiceInputs(artifact, 'arm').source).toEqual({ path: '', generatedAt: '2026-11-27T00:00:00Z' });
  });

  it('reads a split it does not recognize rather than inventing one', () => {
    expect(readChoiceInputs({ ...artifact, split: undefined }, 'arm').split).toBe('unknown');
  });
});

describe('the command line', () => {
  it('defaults to the layout’s artifact and manifest, and to the shipped arm', () => {
    const settings = resolveChoiceSettings([], '/repo', { BIRD_SPLIT: 'dev' });
    expect(settings.arm).toBe(DEFAULT_CHOICE_ARM);
    expect(settings.artifact.endsWith(join('eval', 'out', 'bird-eval.json'))).toBe(true);
    expect(settings.tables.endsWith('dev_tables.json')).toBe(true);
    expect(settings.out).toBeUndefined();
  });

  it('takes an artifact, an arm, a manifest and a destination', () => {
    const settings = resolveChoiceSettings(['--artifact', 'a.json', '--arm', 'x', '--tables', 't.json', '--out', 'o.json'], '/repo', {});
    expect(settings).toMatchObject({ arm: 'x', artifact: 'a.json', tables: 't.json', out: '/repo/o.json' });
  });

  it('refuses a flag it does not have, and a flag with no value', () => {
    expect(() => resolveChoiceSettings(['--nope', 'x'], '/repo', {})).toThrow('unrecognized argument --nope');
    expect(() => resolveChoiceSettings(['--arm'], '/repo', {})).toThrow('--arm needs a value');
    expect(() => resolveChoiceSettings(['--arm', '--out', 'x'], '/repo', {})).toThrow('--arm needs a value');
  });

  it('names the destination by arm and split, with the arm made safe for a path', () => {
    expect(choicePath({ root: '/repo', arm: 'macsql-prompt', split: 'dev' })).toBe(join('/repo', 'eval', 'out', 'choice-macsql-prompt-dev.json'));
    expect(choicePath({ root: '/repo', arm: 'a/b c', split: 'dev' })).toBe(join('/repo', 'eval', 'out', 'choice-a_b_c-dev.json'));
  });

  it('sets the exit code only when the module was the entry', async () => {
    await entrypoint('/x/other.ts', 'file:///x/y.ts', async () => 3);
    expect(process.exitCode).toBeUndefined();
    await entrypoint('/x/y.ts', 'file:///x/y.ts', async () => 3);
    expect(process.exitCode).toBe(3);
    process.exitCode = undefined;
  });

  it('knows whether it was asked to run', async () => {
    expect(isEntry(undefined, 'file:///x')).toBe(false);
    expect(isEntry('/x/y.ts', 'file:///x/y.ts')).toBe(true);
    expect(isEntry('/x/y.ts', 'file:///x/z.ts')).toBe(false);
    expect(await startIfEntry('/x/y.ts', 'file:///x/z.ts', async () => 7)).toBeUndefined();
    expect(await startIfEntry('/x/y.ts', 'file:///x/y.ts', async () => 7)).toBe(7);
  });
});

describe('the instrument, run against a dataset small enough to write', () => {
  const manifest = [
    {
      db_id: 'shop',
      table_names: SHOP.tableNamesReadable,
      table_names_original: SHOP.tableNames,
      column_names: SHOP.columnNamesReadable,
      column_names_original: SHOP.columnNames,
      column_types: SHOP.columnTypes,
      foreign_keys: SHOP.foreignKeys,
    },
  ];

  const write = (dir: string, body: unknown): string => {
    const path = join(dir, 'artifact.json');
    writeFileSync(path, JSON.stringify(body));
    const tables = join(dir, 'dev_tables.json');
    writeFileSync(tables, JSON.stringify(manifest));
    return path;
  };

  it('writes a reading and exits zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'choice-'));
    const artifact = write(dir, {
      split: 'dev',
      generatedAt: '2026-11-27T00:00:00Z',
      arms: [{ arm: 'macsql-prompt', passed: 1, total: 2 }],
      cases: [
        { arm: 'macsql-prompt', id: 1, passed: true, sql: from('items'), gold: from('items'), asked: { db: 'shop', question: 'q' } },
        { arm: 'macsql-prompt', id: 2, passed: false, sql: from('orders'), gold: from('items'), asked: { db: 'shop', question: 'how many items' } },
      ],
    });
    const tables = join(dir, 'dev_tables.json');
    expect(await main(['--artifact', artifact, '--tables', tables], dir, {})).toBe(0);
    const written = JSON.parse(readFileSync(join(dir, 'eval', 'out', 'choice-macsql-prompt-dev.json'), 'utf8')) as ChoiceOutcome;
    expect(written.kinds.neighbour).toBe(1);
    expect(written.source.generatedAt).toBe('2026-11-27T00:00:00Z');
  });

  it('exits one when the artifact carries more unpassed cases than it retains', async () => {
    // A capped artifact is a partial population, so its shares are shares of the wrong denominator.
    const dir = mkdtempSync(join(tmpdir(), 'choice-'));
    const artifact = write(dir, {
      split: 'dev',
      arms: [{ arm: 'macsql-prompt', passed: 1, total: 4 }],
      cases: [
        { arm: 'macsql-prompt', id: 1, passed: true, sql: from('items'), gold: from('items'), asked: { db: 'shop', question: 'q' } },
        { arm: 'macsql-prompt', id: 2, passed: false, sql: from('orders'), gold: from('items'), asked: { db: 'shop', question: 'q' } },
      ],
    });
    expect(await main(['--artifact', artifact, '--tables', join(dir, 'dev_tables.json')], dir, {})).toBe(1);
  });

  it('refuses to overwrite a reading taken on another artifact, and allows the same one again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'choice-'));
    const settings = { root: dir, artifact: 'a.json', arm: 'arm', tables: 't.json' };
    const outcome = tally(cases({ id: '1', db: 'shop', question: 'q', sql: from('orders'), gold: from('items') }));
    const first = writeChoiceArtifact({ ...settings, split: 'dev' } as never, { ...outcome, source: { path: 'a.json', generatedAt: 'one' } });
    expect(() => writeChoiceArtifact({ ...settings, split: 'dev' } as never, { ...outcome, source: { path: 'b.json', generatedAt: 'two' } })).toThrow(
      'refusing to replace it',
    );
    expect(writeChoiceArtifact({ ...settings, split: 'dev' } as never, { ...outcome, source: { path: 'a.json', generatedAt: 'one' } })).toBe(first);
  });

  it('refuses a file it cannot attribute, because an unattributed number is the thing to avoid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'choice-'));
    const path = join(dir, 'unattributed.json');
    writeFileSync(path, JSON.stringify({ population: 3 }));
    const outcome = tally(cases({ id: '1', db: 'shop', question: 'q', sql: from('orders'), gold: from('items') }));
    expect(() =>
      writeChoiceArtifact({ root: dir, artifact: 'a.json', arm: 'arm', tables: 't.json', out: path }, { ...outcome, source: { path: 'a.json', generatedAt: 'one' } }),
    ).toThrow('another artifact');
  });

  it('runs on an empty population without dividing by it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'choice-'));
    const artifact = write(dir, { split: 'dev', arms: [{ arm: 'macsql-prompt', passed: 0, total: 0 }], cases: [] });
    expect(await main(['--artifact', artifact, '--tables', join(dir, 'dev_tables.json')], dir, {})).toBe(0);
  });

  it('reads the manifest with readable names when the original ones are missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'choice-'));
    const artifact = write(dir, {
      split: 'dev',
      arms: [{ arm: 'macsql-prompt', passed: 0, total: 1 }],
      cases: [
        { arm: 'macsql-prompt', id: 1, passed: false, sql: from('orders'), gold: from('items'), asked: { db: 'shop', question: 'q' } },
      ],
    });
    writeFileSync(
      join(dir, 'dev_tables.json'),
      JSON.stringify([{ ...manifest[0], table_names_original: undefined, column_names_original: undefined }]),
    );
    const outcome = await runChoice({ root: dir, artifact, arm: 'macsql-prompt', tables: join(dir, 'dev_tables.json') });
    expect(outcome.kinds.neighbour).toBe(1);
    expect(schemasOf(new Map([['shop', SHOP]])).get('shop')?.order).toEqual(SCHEMA.order);
  });
});
