import { describe, expect, it } from 'vitest';
import { buildValueIndex, findValues, normalizeValue, renderValues } from '../eval/bird/values.js';
import type { DatabaseProfile } from '@agentix-e/nl2charts-ai';

const profile: DatabaseProfile = {
  db: 'card_games',
  columns: [
    { table: 'legalities', column: 'status', kind: 'categorical', values: ['Banned', 'Legal', 'Restricted'] },
    { table: 'sets', column: 'type', kind: 'categorical', values: ['core', 'expansion'] },
    { table: 'cards', column: 'name', kind: 'categorical', values: ['Abundance', 'Ancestor\'s Chosen'] },
    { table: 'cards', column: 'number', kind: 'numeric', min: '1', max: '500' },
  ],
};

describe('value index', () => {
  const index = buildValueIndex(profile);

  it('keys values by the form a question would use', () => {
    expect(normalizeValue('  Banned ')).toBe('banned');
    expect(index.has('banned')).toBe(true);
    expect(index.has('legal')).toBe(true);
  });

  it('records the value as stored, not as matched', () => {
    const match = findValues(index, 'How many cards are Banned?')[0];
    expect(match?.value).toBe('Banned');
  });

  it('skips values too short or too common to be evidence', () => {
    const small = buildValueIndex({ db: 'x', columns: [{ table: 't', column: 'c', kind: 'categorical', values: ['on', 'the'] }] });
    expect(small.size).toBe(0);
  });
});

describe('matching', () => {
  const index = buildValueIndex(profile);

  it('finds a value the question names, with its column', () => {
    const matches = findValues(index, 'How many cards are Banned?');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.table).toBe('legalities');
    expect(matches[0]?.column).toBe('status');
  });

  it('drops a token that lives in more than one column instead of guessing', () => {
    // A word stored in two columns cannot be attached to one of them without a coin
    // flip the model would have to undo, and a wrong literal is worse than none.
    const ambiguous = buildValueIndex({
      db: 'x',
      columns: [
        { table: 'legalities', column: 'status', kind: 'categorical', values: ['Banned'] },
        { table: 'sets', column: 'type', kind: 'categorical', values: ['Banned'] },
      ],
    });
    expect(findValues(ambiguous, 'List the Banned cards')).toEqual([]);
  });

  it('keeps a token that lives in exactly one column', () => {
    const single = buildValueIndex({
      db: 'x',
      columns: [
        { table: 'legalities', column: 'status', kind: 'categorical', values: ['Banned'] },
        { table: 'sets', column: 'type', kind: 'categorical', values: ['core'] },
      ],
    });
    expect(findValues(single, 'List the Banned cards')[0]?.column).toBe('status');
  });

  it('keeps question order, so the rendered block reads like the question', () => {
    const two = buildValueIndex({
      db: 'x',
      columns: [
        { table: 'a', column: 'c1', kind: 'categorical', values: ['Zulu'] },
        { table: 'b', column: 'c2', kind: 'categorical', values: ['Alpha'] },
      ],
    });
    const matches = findValues(two, 'Compare Zulu with Alpha');
    expect(matches.map((match) => match.value)).toEqual(['Zulu', 'Alpha']);
  });

  it('does not repeat a column for two tokens that land in it', () => {
    const twice = buildValueIndex({ db: 'x', columns: [{ table: 'a', column: 'c', kind: 'categorical', values: ['Zulu', 'Alpha'] }] });
    expect(findValues(twice, 'Zulu and Alpha')).toHaveLength(1);
  });

  it('respects the cap', () => {
    const many = buildValueIndex({
      db: 'x',
      columns: Array.from({ length: 12 }, (_, index) => ({
        table: `t${String(index)}`,
        column: 'c',
        kind: 'categorical' as const,
        values: [`v${String(index)}alue`],
      })),
    });
    const question = Array.from({ length: 12 }, (_, index) => `v${String(index)}alue`).join(' ');
    expect(findValues(many, question, 3)).toHaveLength(3);
  });

  it('finds nothing in a question that names no stored value', () => {
    expect(findValues(index, 'How many cards are there?')).toEqual([]);
  });
});

describe('rendering', () => {
  const index = buildValueIndex(profile);

  it('names the column and quotes the value', () => {
    const text = renderValues(findValues(index, 'How many cards are Banned?'));
    expect(text).toContain('legalities.status');
    expect(text).toContain("'Banned'");
  });

  it('renders nothing at all when there is no match', () => {
    // A heading over an empty list is an invitation to invent the values.
    expect(renderValues([])).toBe('');
  });

  it('is deterministic', () => {
    const question = 'Which cards are Restricted in the core set?';
    expect(renderValues(findValues(index, question))).toBe(renderValues(findValues(index, question)));
  });
});
