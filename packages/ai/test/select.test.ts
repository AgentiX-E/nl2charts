import { describe, expect, it } from 'vitest';
import { applySelection, buildSelectionPrompt, parseSelection } from '../src/select.js';
import type { Candidate } from '../src/select.js';

/**
 * The selector is the only part of the harness that decides between complete
 * answers, so its two failure modes matter more than its prompt wording: it must
 * never silently pick candidate 1 when it could not answer, and it must never count
 * a statement's text as an index.
 */
const candidates: Candidate[] = [
  { sql: 'SELECT COUNT(*) FROM orders', rows: 500, columns: 1, preview: '[[500]]' },
  { sql: 'SELECT COUNT(*) FROM orders WHERE status = "completed"', rows: 120, columns: 1, preview: '[[120]]' },
  { sql: 'SELECT id FROM orders', rows: 12, columns: 1, preview: '[[1], [2], [3]]' },
];

describe('selection prompt', () => {
  const prompt = buildSelectionPrompt('How many completed orders are there?', candidates);

  it('numbers every candidate from one, in the order given', () => {
    for (const [index, candidate] of candidates.entries()) {
      expect(prompt).toContain(`${String(index + 1)}. ${candidate.sql}`);
    }
  });

  it('shows the shape of each result, which is what a row count can decide', () => {
    expect(prompt).toContain('500 rows, 1 columns');
    expect(prompt).toContain('120 rows, 1 columns');
    expect(prompt).toContain('first rows: [[120]]');
  });

  it('states the rules that make the comparison falsifiable', () => {
    expect(prompt).toContain('already been executed');
    expect(prompt).toContain('row count that cannot answer the question');
    expect(prompt).toContain('nothing else');
  });

  it('renders a candidate with no rows without an empty preview line', () => {
    const empty = buildSelectionPrompt('q', [{ sql: 'SELECT 1 WHERE 0', rows: 0, columns: 1, preview: '' }]);
    expect(empty).not.toContain('first rows:');
    expect(empty).toContain('0 rows, 1 columns');
  });
});

describe('reading the answer', () => {
  it('accepts the forms a model actually writes', () => {
    expect(parseSelection('2', 3)).toBe(1);
    expect(parseSelection(' 2\n', 3)).toBe(1);
    expect(parseSelection('2.', 3)).toBe(1);
    expect(parseSelection('**2**', 3)).toBe(1);
    expect(parseSelection('Candidate 2', 3)).toBe(1);
    expect(parseSelection('candidate: 3', 3)).toBe(2);
  });

  it('rejects an index outside the list instead of clamping it', () => {
    // Clamping would turn a selector that answered "9" into a vote for candidate 3.
    expect(parseSelection('0', 3)).toBe(-1);
    expect(parseSelection('4', 3)).toBe(-1);
    expect(parseSelection('-1', 3)).toBe(-1);
  });

  it('rejects prose that happens to contain a number', () => {
    // A statement is not an index: parsing it as one would make a model that ignored
    // the instruction look like a model that chose.
    expect(parseSelection('SELECT COUNT(*) FROM orders LIMIT 2', 3)).toBe(-1);
    expect(parseSelection('I think candidate 2 is right because it filters', 3)).toBe(-1);
    expect(parseSelection('', 3)).toBe(-1);
  });

  it('reports when it could not decide, rather than absorbing the failure', () => {
    const decided = applySelection('3', candidates);
    expect(decided).toEqual({ index: 2, decided: true });
    const undecided = applySelection('not a number', candidates);
    expect(undecided).toEqual({ index: 0, decided: false });
  });

  it('is deterministic for the same reply', () => {
    expect(applySelection('2', candidates)).toEqual(applySelection('2', candidates));
  });
});
