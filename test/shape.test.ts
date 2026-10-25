import { describe, expect, it } from 'vitest';
import { expectedShape, shapeFailure, shapeMismatch } from '../eval/bird/shape.js';

describe('which questions want one value', () => {
  it('recognises the phrasings BIRD uses', () => {
    expect(expectedShape('How many schools are in Los Angeles?')).toBe('scalar');
    expect(expectedShape('What is the total number of students?')).toBe('scalar');
    expect(expectedShape('What percentage of members are female?')).toBe('scalar');
    expect(expectedShape('What is the ratio of students to teachers?')).toBe('scalar');
    expect(expectedShape('What is the average age of students?')).toBe('scalar');
  });

  it('leaves a request for rows alone', () => {
    // "How many" plus "list all" is a list; the plural request wins, because a guard that
    // fires here would push the model to aggregate a question that wanted rows.
    expect(expectedShape('List all schools with how many students they have')).toBe('any');
    expect(expectedShape('What are the names of students in class 1A?')).toBe('any');
    expect(expectedShape('Show the top 5 schools by enrollment')).toBe('any');
    expect(expectedShape('Which schools are in Los Angeles?')).toBe('any');
  });

  it('says nothing about a question it does not recognise', () => {
    expect(expectedShape('Find students whose grade improved')).toBe('any');
  });
});

describe('when a result has the wrong shape', () => {
  const one = [[42]];
  const manyRows = [[1], [2], [3]];
  const manyColumns = [[1, 'a', 'b']];

  it('accepts one row and one column', () => {
    expect(shapeMismatch('How many schools are there?', one)).toBe(false);
  });

  it('rejects many rows for a scalar question', () => {
    expect(shapeMismatch('How many schools are there?', manyRows)).toBe(true);
  });

  it('rejects one row with several columns', () => {
    // A record where a value was asked for: the count is there, but so is everything else.
    expect(shapeMismatch('How many schools are there?', manyColumns)).toBe(true);
  });

  it('does not call an empty result a shape error', () => {
    // "Nothing matched" has the right shape; telling the model to aggregate differently
    // would be advice about a question with no rows.
    expect(shapeMismatch('How many schools are there?', [])).toBe(false);
  });

  it('never applies to a question that wanted rows', () => {
    expect(shapeMismatch('List all schools', manyRows)).toBe(false);
  });

  it('describes the mismatch with the numbers the model needs', () => {
    const message = shapeFailure(manyColumns);
    expect(message).toContain('shape:');
    expect(message).toContain('1 row(s) and 3 column(s)');
    // The diagnoser keys off this prefix; the test pins that contract.
    expect(message.startsWith('shape:')).toBe(true);
  });
});
