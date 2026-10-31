/**
 * Reading the shapes competitors actually write.
 *
 * Every case here is a file that has been produced by one of the pinned pipelines or by BIRD's own
 * evaluation harness, minus the size. The point of the parser is the denominator, so the tests are
 * mostly about what it refuses to lose: an entry with no statement, a statement against the wrong
 * database, an id that is not in the split, and a file that names questions by text.
 */
import { describe, expect, it } from 'vitest';
import { parsePredictions, splitBirdPayload } from '../eval/competitors/predictions.js';
import type { PredictionQuestion } from '../eval/competitors/predictions.js';

const questions: readonly PredictionQuestion[] = [
  { id: 1, question: 'How many items are there?', db: 'shop' },
  { id: 2, question: 'What is the total price of every item?', db: 'shop' },
  { id: 3, question: 'How many orders are there?', db: 'shop' },
];

const payload = (sql: string, db = 'shop'): string => `${sql}\t----- bird -----\t${db}`;

describe('the official payload carries the database as well as the statement', () => {
  it('splits a payload with the separator into a statement and a database', () => {
    expect(splitBirdPayload(payload('select 1'))).toEqual({ sql: 'select 1', db: 'shop' });
  });

  it('treats a payload with no separator as a bare statement', () => {
    expect(splitBirdPayload('  select 1  ')).toEqual({ sql: 'select 1' });
  });

  it('drops a separator with nothing after it rather than recording an empty database', () => {
    expect(splitBirdPayload('select 1\t----- bird -----\t  ')).toEqual({ sql: 'select 1' });
  });
});

describe('the map shape: CHESS writes question id to payload', () => {
  it('reads every entry', () => {
    const ledger = parsePredictions(
      JSON.stringify({ 1: payload('select count(*) from items'), 2: payload('select sum(price) from items') }),
      questions,
    );
    expect(ledger.predictions).toEqual([
      { id: 1, sql: 'select count(*) from items', db: 'shop' },
      { id: 2, sql: 'select sum(price) from items', db: 'shop' },
    ]);
    expect(ledger.answered).toBe(2);
    expect(ledger.missing).toEqual([3]);
  });

  it('records an entry that is present and blank as blank, not as missing', () => {
    const ledger = parsePredictions(JSON.stringify({ 1: '', 2: null }), questions);
    expect(ledger.empty).toEqual([1, 2]);
    expect(ledger.missing).toEqual([3]);
    expect(ledger.answered).toBe(0);
  });

  it('reports a key that is not a question id instead of quietly using it', () => {
    const ledger = parsePredictions(JSON.stringify({ 'question one': payload('select 1') }), questions);
    expect(ledger.drops).toEqual([{ where: 'key "question one"', why: 'is not a question id' }]);
    expect(ledger.answered).toBe(0);
  });

  it('records a statement written against another database', () => {
    const ledger = parsePredictions(JSON.stringify({ 1: payload('select count(*) from items', 'other') }), questions);
    expect(ledger.databaseMismatch).toEqual([{ id: 1, declared: 'other', expected: 'shop' }]);
    expect(ledger.predictions[0]?.db).toBe('other');
  });
});

describe('the record shape: MAC-SQL appends JSON Lines', () => {
  const line = (record: Record<string, unknown>): string => JSON.stringify(record);

  it('reads idx, query, db_id and pred', () => {
    const text = [
      line({ idx: 1, query: 'How many items are there?', db_id: 'shop', pred: 'select count(*) from items' }),
      line({ idx: 2, query: 'What is the total price of every item?', db_id: 'shop', pred: 'select sum(price) from items' }),
    ].join('\n');
    const ledger = parsePredictions(text, questions);
    expect(ledger.predictions.map((prediction) => prediction.id)).toEqual([1, 2]);
    expect(ledger.answered).toBe(2);
  });

  it('accepts a numeric id written as a string, and the alternate field names', () => {
    const text = [
      line({ question_id: '1', SQL: 'select count(*) from items' }),
      line({ id: 2, sql: 'select sum(price) from items', db: 'shop' }),
    ].join('\n');
    expect(parsePredictions(text, questions).predictions).toHaveLength(2);
  });

  it('keeps the last answer when a resumed run appends the same question twice', () => {
    const text = [
      line({ idx: 1, pred: 'select 1' }),
      line({ idx: 1, pred: 'select count(*) from items' }),
    ].join('\n');
    const ledger = parsePredictions(text, questions);
    expect(ledger.predictions).toEqual([{ id: 1, sql: 'select count(*) from items' }]);
    expect(ledger.duplicates).toEqual([1]);
  });

  it('drops a repeated answer that was blank on the retry, rather than reviving the first', () => {
    const text = [line({ idx: 1, pred: 'select 1' }), line({ idx: 1, pred: '' })].join('\n');
    const ledger = parsePredictions(text, questions);
    expect(ledger.predictions).toEqual([]);
    expect(ledger.empty).toEqual([1]);
  });

  it('reports a line that is not JSON and a line that is not a record, with their numbers', () => {
    const text = ['not json at all', '42', line({ idx: 1, pred: 'select 1' })].join('\n');
    const ledger = parsePredictions(text, questions);
    expect(ledger.drops).toEqual([
      { where: 'line 1', why: 'is not JSON' },
      { where: 'line 2', why: 'is not a record' },
    ]);
    expect(ledger.answered).toBe(1);
  });

  it('records a record that names no question', () => {
    const ledger = parsePredictions(line({ pred: 'select 1' }), questions);
    expect(ledger.drops).toEqual([{ where: 'record', why: 'names no question' }]);
  });

  it('records an id that is not in the split instead of counting it as answered', () => {
    const ledger = parsePredictions(line({ idx: 99, pred: 'select 1' }), questions);
    expect(ledger.unknown).toEqual([99]);
    expect(ledger.answered).toBe(0);
  });

  it('resolves a record by its question text when it carries no id', () => {
    const ledger = parsePredictions(line({ query: 'How many orders are there?', pred: 'select count(*) from orders' }), questions);
    expect(ledger.predictions).toEqual([{ id: 3, sql: 'select count(*) from orders' }]);
  });
});

describe('the official shape: BIRD writes [question, payload] pairs', () => {
  it('resolves each pair by its question text', () => {
    const text = JSON.stringify([
      ['How many items are there?', payload('select count(*) from items')],
      ['What is the total price of every item?', payload('select sum(price) from items')],
    ]);
    const ledger = parsePredictions(text, questions);
    expect(ledger.predictions.map((prediction) => prediction.id)).toEqual([1, 2]);
    expect(ledger.missing).toEqual([3]);
  });

  it('refuses to guess at a question text that is not in the split', () => {
    const ledger = parsePredictions(JSON.stringify([['How many warehouses are there?', payload('select 1')]]), questions);
    expect(ledger.drops[0]?.why).toContain('names a question that is not in this split');
    expect(ledger.drops[0]?.why).toContain('How many warehouses');
  });

  it('refuses a text that names two questions in the split', () => {
    const twins: readonly PredictionQuestion[] = [
      { id: 1, question: 'How many?', db: 'shop' },
      { id: 2, question: 'How many?', db: 'shop' },
    ];
    const ledger = parsePredictions(JSON.stringify([['How many?', payload('select 1')]]), twins);
    expect(ledger.drops).toEqual([
      { where: 'entry 0', why: 'names a question text that is not unique in this split' },
    ]);
  });

  it('reads an array of records as records, and drops anything else with its position', () => {
    const text = JSON.stringify([{ idx: 1, pred: 'select 1' }, 'stray', ['only a question']]);
    const ledger = parsePredictions(text, questions);
    expect(ledger.answered).toBe(1);
    expect(ledger.drops).toEqual([
      { where: 'entry 1', why: 'is neither a pair nor a record' },
      { where: 'entry 2', why: 'is not a [question, prediction] pair' },
    ]);
  });
});

describe('a file that cannot have been written by a run', () => {
  it('is reported as empty rather than as zero answered', () => {
    const ledger = parsePredictions('   \n', questions);
    expect(ledger.drops).toEqual([{ where: 'file', why: 'is empty' }]);
    expect(ledger.declared).toBe(3);
    expect(ledger.missing).toEqual([1, 2, 3]);
  });

  it('is reported as unreadable when it is JSON but not a container', () => {
    const ledger = parsePredictions('"select 1"', questions);
    expect(ledger.drops).toEqual([{ where: 'file', why: 'is JSON but neither an array nor an object' }]);
  });
});

describe('the denominator is the split, not the file', () => {
  it('counts a question twice-listed once, and a blank question as blank', () => {
    const ledger = parsePredictions(
      JSON.stringify({ 1: payload('select 1'), 1.5: payload('select 2'), 2: '', 3: payload('select 3') }),
      questions,
    );
    expect(ledger.declared).toBe(3);
    expect(ledger.answered).toBe(2);
    expect(ledger.empty).toEqual([2]);
    expect(ledger.drops).toEqual([{ where: 'key "1.5"', why: 'is not a question id' }]);
  });
});

describe('the record shapes a JSON Lines file can hold', () => {
  it('skips a blank line between records rather than dropping the file', () => {
    const text = [
      JSON.stringify({ idx: 1, pred: 'select count(*) from items' }),
      '',
      JSON.stringify({ idx: 2, pred: 'select sum(price) from items' }),
    ].join('\n');
    const ledger = parsePredictions(text, questions);
    expect(ledger.answered).toBe(2);
    expect(ledger.drops).toEqual([]);
  });

  it('reads an id-keyed file against a question set that carries no text', () => {
    // A set built from ids alone cannot be matched by text, and does not need to be: the map shape
    // names the id directly. The parser has to be able to see a question with no text at all.
    const idsOnly: readonly PredictionQuestion[] = [{ id: 1, db: 'shop' }, { id: 2, db: 'shop' }];
    const ledger = parsePredictions(JSON.stringify({ 1: payload('select count(*) from items') }), idsOnly);
    expect(ledger.predictions.map((prediction) => prediction.id)).toEqual([1]);
    expect(ledger.missing).toEqual([2]);
    expect(ledger.drops).toEqual([]);
  });
});

describe('a pipeline that numbers its answers by row', () => {
  // The ids a BIRD split actually carries: a row-numbered file cannot have written these.
  const numbered: readonly PredictionQuestion[] = [
    { id: 36, question: 'How many items are there?', db: 'shop' },
    { id: 112, question: 'What is the total price of every item?', db: 'shop' },
    { id: 140, question: 'How many orders are there?', db: 'shop' },
  ];
  const ids = numbered.map((question) => question.id);

  it('reads a position back through the numbering it was given', () => {
    const text = [
      JSON.stringify({ idx: 0, pred: 'select count(*) from items' }),
      JSON.stringify({ idx: 2, pred: 'select count(*) from orders' }),
    ].join('\n');
    const ledger = parsePredictions(text, numbered, ids);
    expect(ledger.predictions).toEqual([
      { id: 36, sql: 'select count(*) from items' },
      { id: 140, sql: 'select count(*) from orders' },
    ]);
    expect(ledger.renumbered).toEqual([36, 140]);
    expect(ledger.unknown).toEqual([]);
    expect(ledger.missing).toEqual([112]);
  });

  it('lets the declared numbering govern even where the position is also a question id', () => {
    // Every number here is both a position and a question id, and the two readings disagree:
    // reading by id lands on "How many orders", by position on "How many items". Reading each
    // record under whichever numbering resolves it would make the pairing depend on which ids are
    // small, so the same file would pair differently against a different subset.
    const collide: readonly PredictionQuestion[] = [
      { id: 0, question: 'How many items are there?', db: 'shop' },
      { id: 1, question: 'What is the total price of every item?', db: 'shop' },
      { id: 2, question: 'How many orders are there?', db: 'shop' },
    ];
    const ledger = parsePredictions(JSON.stringify({ 2: payload('select count(*) from items') }), collide, [1, 2, 0]);
    expect(ledger.predictions.map((prediction) => prediction.id)).toEqual([0]);
    expect(ledger.renumbered).toEqual([0]);
  });

  it('reports a number beyond the numbering as unknown rather than clamping it', () => {
    const ledger = parsePredictions(JSON.stringify({ 3: payload('select 1') }), numbered, ids);
    expect(ledger.unknown).toEqual([3]);
    expect(ledger.answered).toBe(0);
  });

  it('checks the database the record declares against the question the position names', () => {
    const ledger = parsePredictions(JSON.stringify({ 0: payload('select 1', 'warehouse') }), numbered, ids);
    expect(ledger.databaseMismatch).toEqual([{ id: 36, declared: 'warehouse', expected: 'shop' }]);
  });

  it('reads a file with no map as ids, because that is what it claims to hold', () => {
    const ledger = parsePredictions(JSON.stringify({ 0: payload('select 1') }), numbered);
    expect(ledger.unknown).toEqual([0]);
    expect(ledger.renumbered).toEqual([]);
  });
});
