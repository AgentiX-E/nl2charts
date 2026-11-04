import { describe, expect, it } from 'vitest';
import {
  buildEmptyResultFeedback,
  buildValueGapFeedback,
  EMPTY_BLIND_MESSAGE,
  emptyRetryMessages,
  VALUE_GAP_LITERALS,
  VALUE_GAP_VALUES,
} from '../src/empty.js';
import type { ValueGap } from '../src/empty.js';

const STATEMENT = "SELECT name FROM cards WHERE name = 'benalish knight'";

describe('the turn that quotes what the database holds', () => {
  it('names the literal, the column, and the spelling the column stores', () => {
    const gap: ValueGap = { literal: 'benalish knight', column: 'cards.name', kind: 'case', values: ['Benalish Knight'] };
    const feedback = buildValueGapFeedback(STATEMENT, [gap]);
    expect(feedback).toContain('cards.name');
    expect(feedback).toContain("'Benalish Knight'");
    expect(feedback).toContain('returned no rows');
    // The statement is still shown, because the rewrite is an edit of it and not a new attempt.
    expect(feedback).toContain(STATEMENT);
  });

  it('distinguishes a longer stored value from a differently cased one', () => {
    const partial = buildValueGapFeedback(STATEMENT, [
      { literal: 'benalish knight', column: 'cards.name', kind: 'partial', values: ['Benalish Knight (Fellwar Stone)'] },
    ]);
    const cased = buildValueGapFeedback(STATEMENT, [
      { literal: 'benalish knight', column: 'cards.name', kind: 'case', values: ['Benalish Knight'] },
    ]);
    expect(partial).not.toBe(cased);
    expect(partial).toContain('is not a value of');
    expect(cased).toContain('in that case');
  });

  it('says a value is absent without quoting one, because there is none to quote', () => {
    const feedback = buildValueGapFeedback(STATEMENT, [
      { literal: 'atlantis', column: 'cards.name', kind: 'absent', values: [] },
    ]);
    expect(feedback).toContain('contains no value with');
    expect(feedback).not.toMatch(/stores\s*\./);
  });

  it('falls back to the diagnosed message when the lookup found nothing to say', () => {
    expect(buildValueGapFeedback(STATEMENT, [])).toBe(buildEmptyResultFeedback(STATEMENT));
  });

  it('describes a literal once, even when two sites compared it with one column', () => {
    const gap: ValueGap = { literal: 'x', column: 'cards.name', kind: 'partial', values: ['xa'] };
    const feedback = buildValueGapFeedback(STATEMENT, [gap, gap]);
    expect(feedback.match(/cards\.name/g)).toHaveLength(1);
  });

  it('keeps two gaps on one column, because they are two different literals', () => {
    const feedback = buildValueGapFeedback(STATEMENT, [
      { literal: 'x', column: 'cards.name', kind: 'partial', values: ['xa'] },
      { literal: 'y', column: 'cards.name', kind: 'partial', values: ['ya'] },
    ]);
    expect(feedback).toContain("'x'");
    expect(feedback).toContain("'y'");
  });

  it(`describes at most ${VALUE_GAP_LITERALS} literals, and says nothing about the rest`, () => {
    const gaps: ValueGap[] = Array.from({ length: VALUE_GAP_LITERALS + 1 }, (_unused, index) => ({
      literal: `lit${index}`,
      column: 'cards.name',
      kind: 'partial',
      values: [`value${index}`],
    }));
    const feedback = buildValueGapFeedback(STATEMENT, gaps);
    expect(feedback).toContain('lit0');
    expect(feedback).not.toContain(`'lit${VALUE_GAP_LITERALS}'`);
  });

  it(`quotes at most ${VALUE_GAP_VALUES} values per gap`, () => {
    const values = ['v1', 'v2', 'v3', 'v4', 'v5'];
    const feedback = buildValueGapFeedback(STATEMENT, [{ literal: 'v', column: 'cards.name', kind: 'partial', values }]);
    expect(feedback).toContain("'v4'");
    expect(feedback).not.toContain("'v5'");
  });

  it('clips a value the size of a document instead of spending the message on it', () => {
    const huge = 'z'.repeat(4000);
    const feedback = buildValueGapFeedback(STATEMENT, [{ literal: 'q', column: 'cards.name', kind: 'partial', values: [huge] }]);
    expect(feedback).toContain('…');
    expect(feedback.length).toBeLessThan(900);
  });

  it('stays inside the feedback budget at its worst case', () => {
    const gaps: ValueGap[] = Array.from({ length: VALUE_GAP_LITERALS }, (_unused, index) => ({
      literal: `${index}${'l'.repeat(200)}`,
      column: `a_reasonably_long_table_name.a_reasonably_long_column_name_${index}`,
      kind: 'partial' as const,
      values: Array.from({ length: VALUE_GAP_VALUES }, (_none, value) => `${value}${'v'.repeat(200)}`),
    }));
    const feedback = buildValueGapFeedback(`SELECT ${'column, '.repeat(200)}1 FROM cards`, gaps);
    expect(feedback.length).toBeLessThanOrEqual(900);
  });

  it('is deterministic, so two runs on one case see the same bytes', () => {
    const gap: ValueGap = { literal: 'benalish knight', column: 'cards.name', kind: 'case', values: ['Benalish Knight'] };
    expect(buildValueGapFeedback(STATEMENT, [gap])).toBe(buildValueGapFeedback(STATEMENT, [gap]));
  });
});

describe('the messages the three modes append', () => {
  it('carries the retrieved value in the values mode and not in the blind control', () => {
    const gap: ValueGap = { literal: 'benalish knight', column: 'cards.name', kind: 'case', values: ['Benalish Knight'] };
    const values = emptyRetryMessages('values', STATEMENT, STATEMENT, [gap]);
    const blind = emptyRetryMessages('blind', STATEMENT, STATEMENT, [gap]);
    expect(values[1]?.content).toContain('Benalish Knight');
    expect(blind[1]?.content).toBe(EMPTY_BLIND_MESSAGE);
  });

  it('keeps the previous statement as the assistant turn in every mode', () => {
    for (const mode of ['diagnosed', 'blind', 'values'] as const) {
      const messages = emptyRetryMessages(mode, STATEMENT, STATEMENT);
      expect(messages[0]).toEqual({ role: 'assistant', content: STATEMENT });
      expect(messages[1]?.role).toBe('user');
    }
  });

  it('says what an empty lookup means rather than saying nothing', () => {
    const messages = emptyRetryMessages('values', STATEMENT, STATEMENT, []);
    expect(messages[1]?.content).toBe(buildEmptyResultFeedback(STATEMENT));
  });
});
