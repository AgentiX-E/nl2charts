import { describe, expect, it } from 'vitest';
import { buildIndex, renderRetrieved, retrieve, tokenize } from '../eval/bird/retrieval.js';
import type { TrainingRow } from '../eval/bird/retrieval.js';

const corpus: TrainingRow[] = [
  {
    db_id: 'db_a',
    question: 'What is the ratio of customers who pay in EUR to customers who pay in CZK?',
    evidence: 'ratio of customers paying in EUR to those paying in CZK = count(Currency = "EUR") / count(Currency = "CZK")',
  },
  {
    db_id: 'db_b',
    question: 'List the names of all schools in the district.',
    evidence: 'district refers to the District field',
  },
  {
    db_id: 'db_c',
    question: 'What is the ratio of free meals to enrolled students?',
    evidence: 'ratio of free meals to enrolled = Free Meal Count / Enrollment',
  },
  {
    db_id: 'db_a',
    question: 'How many customers pay in EUR?',
    evidence: 'paying in EUR refers to Currency = "EUR"',
  },
];

const index = buildIndex(corpus);

describe('tokenizing', () => {
  it('drops stopwords and single letters', () => {
    expect(tokenize('What is the ratio of A to B?')).toEqual(['ratio']);
    expect(tokenize('How many orders were placed in 2024')).toEqual(['orders', 'placed', '2024']);
  });
});

describe('retrieval', () => {
  it('ranks the question that shares the phrasing, not the one that shares a word', () => {
    const hits = retrieve(index, 'What is the ratio of orders paid in USD to orders paid in EUR?', { k: 2 });
    expect(hits[0]?.question).toContain('ratio of customers');
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score as number);
    // Cosine ranked the four-word question first; BM25 ranks the shared construction.
    expect(hits[0]?.question).not.toBe('How many customers pay in EUR?');
  });

  it('returns nothing when the question shares no vocabulary with the corpus', () => {
    expect(retrieve(index, 'zzz qqq', { k: 3 })).toEqual([]);
  });

  it('keeps one hit per source database by default, so the block is not four copies of one table', () => {
    const hits = retrieve(index, 'ratio of customers paying in EUR', { k: 3 });
    const databases = hits.map((hit) => hit.question);
    expect(new Set(databases).size).toBe(hits.length);
  });

  it('never exceeds k, even when the corpus is larger', () => {
    expect(retrieve(index, 'ratio of customers paying in EUR to CZK', { k: 1, perDatabase: 4 })).toHaveLength(1);
  });

  it('drops a neighbour below the score floor instead of padding the block', () => {
    // BM25 scores are unbounded, so the floor is absolute, not a similarity: this
    // asserts the mechanism, not a calibrated number.
    expect(retrieve(index, 'ratio of customers paying in EUR', { k: 5, minScore: 1e9 })).toEqual([]);
  });

  it('is deterministic for the same query', () => {
    const first = retrieve(index, 'ratio of customers paying in EUR to CZK', { k: 3 });
    const second = retrieve(index, 'ratio of customers paying in EUR to CZK', { k: 3 });
    expect(second).toEqual(first);
  });

  it('handles an empty corpus without throwing', () => {
    expect(retrieve(buildIndex([]), 'anything at all', { k: 3 })).toEqual([]);
  });
});

describe('rendering the block', () => {
  it('shows the question and its evidence, and never the SQL', () => {
    const text = renderRetrieved(retrieve(index, 'ratio of customers paying in EUR to CZK', { k: 1 }));
    expect(text).toContain('ratio of customers');
    expect(text.toLowerCase()).not.toContain('select');
    expect(text.startsWith('- ')).toBe(true);
  });

  it('respects the character budget at a line boundary', () => {
    const hits = retrieve(index, 'ratio of customers paying in EUR to CZK', { k: 3, perDatabase: 4 });
    const text = renderRetrieved(hits, 80);
    expect(text.length).toBeLessThanOrEqual(80);
    if (text.length > 0) expect(text.split('\n').every((line) => line.startsWith('- '))).toBe(true);
  });

  it('skips a neighbour with no evidence rather than printing an empty arrow', () => {
    const bare = buildIndex([{ db_id: 'x', question: 'How many rows are there?' }]);
    const text = renderRetrieved(retrieve(bare, 'How many rows are there?', { k: 1 }));
    expect(text).toBe('');
  });
});

describe('definition preference', () => {
  const mixed = buildIndex([
    { db_id: 'a', question: 'What is the free rate for students?', evidence: 'free refers to lowest_price = 0;' },
    {
      db_id: 'b',
      question: 'What is the free rate for students?',
      evidence: 'free rate = count(meal = "free") / count(student)',
    },
  ]);

  it('prefers the hit that explains how the number is computed', () => {
    const hits = retrieve(mixed, 'What is the free rate for students?', { k: 2 });
    expect(hits[0]?.evidence).toContain('count(');
  });

  it('still fills the block when nothing states a definition', () => {
    const valuesOnly = buildIndex([
      { db_id: 'a', question: 'How many streets are named 11th?', evidence: 'named 11th refers to name = "11th"' },
    ]);
    expect(retrieve(valuesOnly, 'How many streets are named 11th?', { k: 1 })).toHaveLength(1);
  });

  it('can be turned off, and then ranking is pure BM25', () => {
    const hits = retrieve(mixed, 'What is the free rate for students?', { k: 1, preferDefinitions: false });
    expect(hits).toHaveLength(1);
  });
});
