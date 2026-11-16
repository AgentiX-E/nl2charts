/**
 * The AskData rebuild, tested on what it is allowed to claim.
 *
 * The module has two halves and they fail differently. The value index and the field reader are
 * pure, so their tests are exact; the five-variant loop spends calls, so its tests are about the
 * count and about what the *next* prompt says — which is the only part of a looping prompt a unit
 * test can hold without a model.
 *
 * Nothing here asserts an accuracy. A rebuild of a paper-only system may not be reported as the
 * paper's number (`docs/benchmarks.md`, *Which of them can be copied at all*), and the arguments
 * below are the ones the arm's own run has to settle.
 */
import { describe, expect, it } from 'vitest';
import type { DatabaseProfile, LlmMessage, SchemaTable } from '@agentix-e/nl2charts-ai';
import {
  RESEMBLANCE,
  VARIANTS,
  buildValueShards,
  cardForVariant,
  fieldKey,
  keepFields,
  linkByAlignment,
  literalsOf,
  missingLiterals,
  revisionNote,
} from '../eval/bird/askdata.js';

const CARDS: readonly SchemaTable[] = [
  {
    table: 'cards',
    columns: [
      { name: 'id', type: 'INTEGER' },
      { name: 'power', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
    ],
  },
  {
    table: 'sets',
    columns: [
      { name: 'setCode', type: 'TEXT', comment: 'Three-letter set code.' },
      { name: 'releaseDate', type: 'TEXT' },
    ],
  },
];

const PROFILE: DatabaseProfile = {
  database: 'card_games',
  tables: [],
  columns: [
    { table: 'cards', column: 'power', values: ['∞', '*', '1', '2'] },
    { table: 'cards', column: 'name', values: ['Banned Item', 'Fresno County Office Of Education'] },
    { table: 'sets', column: 'setCode', values: ['M10', 'ZEN'] },
  ],
} as unknown as DatabaseProfile;

describe('the value index resolves a literal to the fields that store it', () => {
  it('matches a value spelled with different case, which exact equality cannot', () => {
    const shards = buildValueShards(PROFILE);
    expect(shards.holding('Fresno County Office of Education')).toEqual([
      { table: 'cards', column: 'name', value: 'Fresno County Office Of Education' },
    ]);
  });

  it('refuses a prefix of a stored value, because a partial match is a guessed column', () => {
    const shards = buildValueShards(PROFILE);
    // Four of nine shingles: `'Banned'` resembles `'Banned Item'` at 0.44, under the threshold.
    expect(shards.holding('Banned')).toEqual([]);
  });

  it('accepts the same prefix when the caller lowers the threshold, so the refusal is the parameter', () => {
    const shards = buildValueShards(PROFILE);
    expect(shards.holding('Banned', { minScore: 0.4 }).map((hit) => hit.value)).toContain('Banned Item');
  });

  it('reads a two-character value as one shingle, because a code is a value too', () => {
    const shards = buildValueShards(PROFILE);
    expect(shards.holding('M10')).toEqual([{ table: 'sets', column: 'setCode', value: 'M10' }]);
  });

  it('caps the sample per column, so a wide column cannot outvote a narrow one', () => {
    const wide: DatabaseProfile = {
      database: 'wide',
      tables: [],
      columns: [
        { table: 't', column: 'a', values: ['alpha', 'beta'] },
        { table: 't', column: 'b', values: ['gamma', 'delta'] },
      ],
    } as unknown as DatabaseProfile;
    const shards = buildValueShards(wide, 1);
    expect(shards.holding('beta')).toEqual([]);
    expect(shards.holding('alpha').length).toBe(1);
  });

  it('returns nothing for an empty literal rather than the whole index', () => {
    const shards = buildValueShards(PROFILE);
    expect(shards.holding('')).toEqual([]);
    expect(shards.holding('   ')).toEqual([]);
  });

  it('caps the number of holdings one literal can add to a card', () => {
    const many: DatabaseProfile = {
      database: 'many',
      tables: [],
      columns: Array.from({ length: 12 }, (_, index) => ({ table: `t${index}`, column: 'code', values: ['same'] })),
    } as unknown as DatabaseProfile;
    expect(buildValueShards(many).holding('same')).toHaveLength(8);
    expect(buildValueShards(many).holding('same', { max: 3 })).toHaveLength(3);
  });
});

describe('the literal reader reads values and not syntax', () => {
  it('reads a quoted value, including the doubled-quote escape', () => {
    expect(literalsOf("select * from t where a = 'O''Brien'")).toEqual(["O'Brien"]);
  });

  it('reads a quoted number, because the column that stores a year is text', () => {
    expect(literalsOf("select * from t where year = '2019'")).toEqual(['2019']);
  });

  it('does not read a comment, a quoted identifier or a backticked name as a literal', () => {
    const sql = "select `Name`, \"Power\" from t -- it's a comment\nwhere a = 'x' /* 'y' */";
    expect(literalsOf(sql)).toEqual(['x']);
  });

  it('reads several literals in the order they appear', () => {
    expect(literalsOf("select * from t where a in ('one', 'two') and b = 'three'")).toEqual(['one', 'two', 'three']);
  });

  it('returns nothing for a statement that constrains no value', () => {
    expect(literalsOf('select count(*) from t')).toEqual([]);
  });
});

describe('a card is narrowed to the fields a statement read', () => {
  it('keeps the columns a qualified statement named and drops the rest of the table', () => {
    const kept = keepFields(CARDS, [fieldKey('cards', 'power')]);
    expect(kept).toEqual([{ table: 'cards', columns: [{ name: 'power', type: 'TEXT' }] }]);
  });

  it('drops a table that kept no column', () => {
    expect(keepFields(CARDS, [fieldKey('cards', 'id')]).map((table) => table.table)).toEqual(['cards']);
  });

  it('keeps a column the statement wrote without its table', () => {
    const kept = keepFields(CARDS, ['\u0000setcode']);
    expect(kept.map((table) => table.table)).toEqual(['sets']);
  });

  it('treats a name case-insensitively in both spellings', () => {
    expect(fieldKey('Cards', 'POWER')).toBe('cards\u0000power');
    expect(keepFields(CARDS, [fieldKey('CARDS', 'Power')])).toHaveLength(1);
  });
});

describe('the five variants are the paper’s five, and they are distinct prompts', () => {
  it('carries exactly five, in the paper’s order', () => {
    expect(VARIANTS.map((variant) => variant.name)).toEqual([
      'focused-minimal',
      'focused-maximal',
      'full-minimal',
      'full-maximal',
      'focused-full',
    ]);
  });

  it('has no two variants that could send the same prompt', () => {
    const pairs = new Set(VARIANTS.map((variant) => `${variant.scope}/${variant.profile}`));
    expect(pairs.size).toBe(5);
  });

  it('uses the full card on the two full-scope variants and the link on the other three', () => {
    const linked = [{ table: 'cards', column: 'power' }];
    expect(cardForVariant(VARIANTS[2] as never, CARDS, linked).flatMap((table) => table.columns)).toHaveLength(5);
    expect(cardForVariant(VARIANTS[4] as never, CARDS, linked)).toEqual([
      { table: 'cards', columns: [{ name: 'power', type: 'TEXT' }] },
    ]);
  });

  it('falls back to the full card when the link found nothing, because recall beats precision', () => {
    expect(cardForVariant(VARIANTS[0] as never, CARDS, [])).toEqual(CARDS);
  });
});

describe('a literal no referenced field can hold is the paper’s step 2.d', () => {
  const shards = buildValueShards(PROFILE);

  it('leaves a literal alone when a referenced field stores it', () => {
    const out = missingLiterals({ fields: [fieldKey('cards', 'name')], literals: ['Banned Item'] }, shards);
    expect(out).toEqual({ fields: [], literals: [], unresolved: [] });
  });

  it('names the fields when the statement constrains the value on the wrong column', () => {
    const out = missingLiterals(
      { fields: [fieldKey('cards', 'power')], literals: ['Fresno County Office of Education'] },
      shards,
    );
    expect(out.literals).toEqual(['Fresno County Office of Education']);
    expect(out.fields).toEqual([
      { table: 'cards', column: 'name', value: 'Fresno County Office Of Education' },
    ]);
  });

  it('resolves a bare reference to the field that holds the literal', () => {
    const out = missingLiterals({ fields: ['\u0000name'], literals: ['Banned Item'] }, shards);
    expect(out.literals).toEqual([]);
  });

  it('reports a literal no field stores instead of attaching it to a near column', () => {
    const out = missingLiterals({ fields: [fieldKey('cards', 'power')], literals: ['Zendikar'] }, shards);
    expect(out.literals).toEqual([]);
    expect(out.unresolved).toEqual(['Zendikar']);
  });

  it('ignores an empty literal, which is a malformed statement rather than a value', () => {
    expect(missingLiterals({ fields: [], literals: [''] }, shards)).toEqual({ fields: [], literals: [], unresolved: [] });
  });
});

describe('the revision note says what was wrong and what to use instead', () => {
  it('quotes the statement, the literal and up to eight fields', () => {
    const note = revisionNote(
      "select count(*) from cards where power = '*'",
      ["*"],
      Array.from({ length: 10 }, (_, index) => ({ table: `t${index}`, column: 'c', value: 'x' })),
    );
    expect(note).toContain("where power = '*'");
    expect(note).toContain("'*'");
    expect(note).toContain('t0.c');
    expect(note).toContain('t7.c');
    expect(note).not.toContain('t8.c');
  });

  it('names each field once even when two values land in it', () => {
    const note = revisionNote('select 1', ['a', 'b'], [
      { table: 't', column: 'c', value: 'a' },
      { table: 't', column: 'c', value: 'b' },
    ]);
    expect(note.split('t.c').length - 1).toBe(1);
  });
});

describe('the loop sends five prompts, and one more only when a literal has nowhere to live', () => {
  const shards = buildValueShards(PROFILE);

  const scripted = (replies: readonly string[]): { generate: (messages: readonly LlmMessage[]) => Promise<string>; sent: string[] } => {
    const sent: string[] = [];
    let index = 0;
    return {
      sent,
      generate: async (messages: readonly LlmMessage[]) => {
        sent.push(messages.map((message) => message.content).join('\n'));
        const reply = replies[Math.min(index, replies.length - 1)] as string;
        index += 1;
        return reply;
      },
    };
  };

  it('unions the fields of the five statements into one card', async () => {
    const replies = [
      '```sql\nselect power from cards\n```',
      '```sql\nselect setCode from sets\n```',
      '```sql\nselect name from cards\n```',
      '```sql\nselect releaseDate from sets\n```',
      '```sql\nselect id from cards\n```',
    ];
    const { generate } = scripted(replies);
    const alignment = await linkByAlignment({
      question: 'how many banned cards are in the ZEN set',
      schema: CARDS,
      prompt: { definitions: 'cards.power is a text column.' },
      shards,
      generate,
    });
    expect(alignment.calls).toBe(5);
    expect(alignment.variants).toHaveLength(5);
    // Unqualified selections arrive as bare names, which is what the card reader resolves: the key
    // of a field a statement named without its table has no table in it.
    expect(new Set(alignment.fields)).toEqual(
      new Set(['\u0000power', '\u0000setcode', '\u0000name', '\u0000releasedate', '\u0000id']),
    );
    // And the union narrows the card to exactly those five columns, which is the card the arm's
    // three candidates are then written against.
    const narrowed = keepFields(CARDS, alignment.fields);
    expect(narrowed.flatMap((table) => table.columns.map((column) => column.name)).sort()).toEqual([
      'id',
      'name',
      'power',
      'releaseDate',
      'setCode',
    ]);
  });

  it('spends no sixth call when every literal the statement wrote has a field', async () => {
    const { generate, sent } = scripted(["```sql\nselect name from cards where name = 'Banned Item'\n```"]);
    const alignment = await linkByAlignment({
      question: 'which card is called Banned Item',
      schema: CARDS,
      prompt: {},
      shards,
      generate,
    });
    expect(alignment.calls).toBe(5);
    expect(sent).toHaveLength(5);
    expect(alignment.variants.every((variant) => variant.revisions === 0)).toBe(true);
  });

  it('asks for one rewrite when the literal lives in a field the statement never read', async () => {
    const replies = [
      "```sql\nselect count(*) from cards where power = 'Banned Item'\n```",
      "```sql\nselect count(*) from cards where name = 'Banned Item'\n```",
    ];
    const { generate, sent } = scripted(replies);
    const alignment = await linkByAlignment({
      question: 'how many cards are called Banned Item',
      schema: CARDS,
      prompt: {},
      shards,
      generate,
    });
    // Five variants, and only the first of them needed the rewrite: the second reply stopped the
    // loop by resolving the literal, which is what the step is for.
    expect(alignment.calls).toBe(6);
    expect(alignment.variants[0]?.revisions).toBe(1);
    expect(alignment.variants[0]?.sql).toContain('name');
    const revision = sent[1] as string;
    expect(revision).toContain('Fields of this database that do store it: cards.name');
    // The revision carries the widened card: the suggestion is only usable if the field is on it.
    expect(revision).toContain('name TEXT');
  });

  it('stops at the retry bound instead of looping on a literal it cannot resolve', async () => {
    const { generate } = scripted(["```sql\nselect count(*) from cards where power = 'Banned Item'\n```"]);
    const alignment = await linkByAlignment({
      question: 'how many cards are called Banned Item',
      schema: CARDS,
      prompt: {},
      shards,
      generate,
      maxRetry: 2,
    });
    // Five variants, one of which spent three attempts (the first plus two retries) on the same
    // statement. A bound that is a parameter is a bound a caller can price.
    // Every variant spends the bound, because the script hands every prompt the same statement: the
    // cost of a linker that never resolves its literal is 5 x 3 calls, and that is the number the
    // arm's own budget has to survive.
    expect(alignment.calls).toBe(15);
    expect(alignment.variants.every((variant) => variant.revisions === 2)).toBe(true);
  });

  it('reports a literal that no field stores and does not ask for a rewrite', async () => {
    const { generate } = scripted(["```sql\nselect count(*) from cards where power = 'Zendikar'\n```"]);
    const alignment = await linkByAlignment({
      question: 'how many cards are from Zendikar',
      schema: CARDS,
      prompt: {},
      shards,
      generate,
    });
    expect(alignment.calls).toBe(5);
    expect(alignment.variants[0]?.unresolved).toEqual(['Zendikar']);
  });

  it('sends the minimal variant no definition block and the full variant both blocks', async () => {
    const { generate, sent } = scripted(['```sql\nselect 1\n```']);
    await linkByAlignment({
      question: 'list the setCode of every card',
      schema: CARDS,
      prompt: { definitions: 'cards.power is a text column.', evidence: 'power is not numeric.' },
      shards,
      generate,
    });
    const focusedMinimal = sent[0] as string;
    const focusedFull = sent[4] as string;
    expect(focusedMinimal).not.toContain('Semantics:');
    expect(focusedMinimal).not.toContain('Evidence:');
    expect(focusedFull).toContain('Semantics:');
    expect(focusedFull).toContain('Evidence:');
    // The focused card is narrower than the full one on the same question, which is the whole
    // difference between variants (a) and (c).
    expect(focusedMinimal).not.toContain('releaseDate');
    expect(sent[2]).toContain('releaseDate');
  });

  it('keeps the arm’s own notes when a variant adds the revision', async () => {
    const { generate, sent } = scripted(["```sql\nselect count(*) from cards where power = 'Banned Item'\n```"]);
    await linkByAlignment({
      question: 'how many cards are called Banned Item',
      schema: CARDS,
      prompt: { notes: ['Use only the filters the question states.'] },
      shards,
      generate,
    });
    const revision = sent[1] as string;
    expect(revision).toContain('Use only the filters the question states.');
    expect(revision).toContain('Rewrite the statement');
  });

  it('runs the variants it was given, so a caller can price one at a time', async () => {
    const { generate } = scripted(['```sql\nselect 1\n```']);
    const alignment = await linkByAlignment({
      question: 'how many cards',
      schema: CARDS,
      prompt: {},
      shards,
      generate,
      variants: [VARIANTS[2] as never],
    });
    expect(alignment.calls).toBe(1);
    expect(alignment.variants.map((variant) => variant.variant)).toEqual(['full-minimal']);
  });
});

describe('the resemblance threshold is stated rather than tuned', () => {
  it('is the value the module documents', () => {
    expect(RESEMBLANCE).toBe(0.6);
  });
});
