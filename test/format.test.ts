import { describe, expect, it } from 'vitest';
import {
  buildConditionAuditFeedback,
  buildSelectionPrompt,
  countNamedConditions,
  countSteps,
  createPipeline,
  formatProfile,
  parseChoiceToken,
  parseSelection,
  replyShape,
  toCandidate,
} from '@agentix-e/nl2charts-ai';
import type { FormatProfile, LlmProvider, ReplyShape, SchemaTable } from '@agentix-e/nl2charts-ai';

/**
 * The format contract: what a reply looks like, and how a reader survives decoration.
 *
 * Every case below is a shape a model this repository has not benchmarked produced, or is
 * the shape that must still be rejected so that "the model chose" and "the model ignored
 * the instruction" stay different numbers.
 */

const schema: readonly SchemaTable[] = [
  { table: 't', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'label', type: 'TEXT' }] },
];

function provider(reply: string): LlmProvider {
  return { id: 'test', model: 'test-model', async complete() { return { text: reply, model: 'test-model' }; } };
}

describe('parseChoiceToken', () => {
  it('reads a bare choice', () => {
    expect(parseChoiceToken('2')).toBe(2);
    expect(parseChoiceToken('  3 \n')).toBe(3);
  });

  it('reads a choice a model emphasised or punctuated', () => {
    expect(parseChoiceToken('**2**')).toBe(2);
    expect(parseChoiceToken('`2`')).toBe(2);
    expect(parseChoiceToken('2.')).toBe(2);
    expect(parseChoiceToken('# 2')).toBe(2);
  });

  it('reads a choice a model labelled', () => {
    expect(parseChoiceToken('Option 2')).toBe(2);
    expect(parseChoiceToken('option #3')).toBe(3);
    expect(parseChoiceToken('Choice: 2.')).toBe(2);
    expect(parseChoiceToken('Answer - 4')).toBe(4);
    expect(parseChoiceToken('candidate 2')).toBe(2);
    expect(parseChoiceToken('Selection 1')).toBe(1);
  });

  it('refuses prose that happens to contain a number', () => {
    expect(parseChoiceToken('The answer is 2 because the filter excludes it')).toBeNull();
    expect(parseChoiceToken('I considered options 2 and 3, choosing 2')).toBeNull();
  });

  it('refuses a statement that happens to contain a number', () => {
    expect(parseChoiceToken('SELECT * FROM t LIMIT 2')).toBeNull();
  });

  it('refuses nothing at all, and a number too long to be a slot', () => {
    expect(parseChoiceToken('')).toBeNull();
    expect(parseChoiceToken('   ')).toBeNull();
    expect(parseChoiceToken('100')).toBeNull();
  });
});

describe('parseSelection', () => {
  it('applies the choice to the list it was offered', () => {
    expect(parseSelection('Option 2', 3)).toBe(1);
    expect(parseSelection('**1**', 3)).toBe(0);
  });

  it('refuses a choice outside the list rather than clamping it', () => {
    expect(parseSelection('9', 3)).toBe(-1);
    expect(parseSelection('0', 3)).toBe(-1);
  });

  it('still refuses prose, so an ignored instruction is not counted as a choice', () => {
    expect(parseSelection('The best candidate is the second one.', 3)).toBe(-1);
  });
});

describe('countNamedConditions with decoration', () => {
  it('counts a bulleted, bolded line as the prefix it was told to write', () => {
    expect(countNamedConditions('- **MISSING:** t.label = \'x\'')).toBe(1);
    expect(countNamedConditions('* MISSING: a join on t.id')).toBe(1);
  });

  it('counts a full-width colon', () => {
    expect(countNamedConditions('MISSING： t.label = \'x\'')).toBe(1);
  });

  it('reads a bolded none as nothing to report', () => {
    expect(countNamedConditions('**MISSING:** none')).toBe(0);
    expect(countNamedConditions('**MISSING**: **none**')).toBe(0);
  });

  it('does not count the word inside a fenced statement', () => {
    expect(countNamedConditions('MISSING: a\n```sql\nSELECT missing_reason FROM t\n```')).toBe(1);
  });

  it('does not count an empty line', () => {
    expect(countNamedConditions('MISSING:')).toBe(0);
  });
});

describe('countSteps with decoration', () => {
  it('counts a bare label', () => {
    expect(countSteps('STEP 1: SELECT 1\nSTEP 2: SELECT 2')).toBe(2);
  });

  it('counts an ordered-list label', () => {
    expect(countSteps('1. STEP 1: SELECT 1\n2. STEP 2: SELECT 2')).toBe(2);
  });

  it('counts a bolded label', () => {
    expect(countSteps('**STEP 1:** SELECT 1\n**STEP 2:** SELECT 2')).toBe(2);
  });

  it('counts a bulleted label, and does not count a numbered line without one', () => {
    expect(countSteps('- STEP 1: SELECT 1')).toBe(1);
    expect(countSteps('1. SELECT 1\n2. SELECT 2')).toBe(0);
  });
});

describe('replyShape', () => {
  it('reads all four dimensions off one reply', () => {
    const text = ['MISSING: t.label = \'x\'', 'MISSING: a join on t.id', 'STEP 1: SELECT id FROM t', '```sql', 'SELECT id FROM t', '```'].join('\n');
    expect(replyShape(text)).toEqual({ fenced: true, index: false, steps: 1, named: 2 });
  });

  it('reads a bare choice as an index and not as a fence', () => {
    expect(replyShape('Option 2')).toEqual({ fenced: false, index: true, steps: 0, named: 0 });
  });

  it('reads a statement with no fence, which is the reply a reader cannot use', () => {
    expect(replyShape('SELECT id FROM t')).toEqual({ fenced: false, index: false, steps: 0, named: 0 });
  });
});

describe('formatProfile', () => {
  const shape = (over: Partial<ReplyShape> = {}): ReplyShape => ({ fenced: false, index: false, steps: 0, named: 0, ...over });

  it('reports no evidence as no verdict', () => {
    const profile = formatProfile([]);
    expect(profile.replies).toBe(0);
    expect([profile.fenced, profile.index, profile.steps, profile.named]).toEqual(['sometimes', 'sometimes', 'sometimes', 'sometimes']);
  });

  it('withholds a verdict below three replies', () => {
    expect(formatProfile([shape({ fenced: true }), shape({ fenced: true })]).fenced).toBe('sometimes');
  });

  it('calls a dimension always at nine in ten and sometimes below it', () => {
    const nine = Array.from({ length: 10 }, (_, i) => shape({ fenced: i < 9 }));
    expect(formatProfile(nine).fenced).toBe('always');
    const eight = Array.from({ length: 10 }, (_, i) => shape({ fenced: i < 8 }));
    expect(formatProfile(eight).fenced).toBe('sometimes');
  });

  it('calls a dimension never when no reply held it', () => {
    const profile = formatProfile([shape(), shape(), shape()]);
    expect(profile.fenced).toBe('never');
    expect(profile.steps).toBe('never');
  });

  it('counts a step dimension as held when a reply wrote any step at all', () => {
    const profile = formatProfile([shape({ steps: 1 }), shape({ steps: 4 }), shape({ steps: 2 })]);
    expect(profile.steps).toBe('always');
  });

  it('keeps the four dimensions independent', () => {
    const profile: FormatProfile = formatProfile([shape({ fenced: true }), shape({ fenced: true }), shape({ fenced: true, index: true })]);
    expect(profile.fenced).toBe('always');
    expect(profile.index).toBe('sometimes');
    expect(profile.named).toBe('never');
  });
});

describe('the shape an ask reports', () => {
  it('records the reply the prompt produced, not the statement it parsed', async () => {
    const pipeline = createPipeline({ provider: provider('Here you go:\n```sql\nSELECT id FROM t\n```') });
    const result = await pipeline.ask({ question: 'ids', schema });
    expect(result.sql).toBe('SELECT id FROM t');
    expect(result.shape).toEqual({ fenced: true, index: false, steps: 0, named: 0 });
  });

  it('records an unfenced reply as unfenced, which is the reading a profile exists for', async () => {
    const pipeline = createPipeline({ provider: provider('SELECT id FROM t') });
    const result = await pipeline.ask({ question: 'ids', schema });
    expect(result.shape?.fenced).toBe(false);
  });

  it('counts the steps of a decomposed reply', async () => {
    const pipeline = createPipeline({
      provider: provider('STEP 1: SELECT id FROM t\n```sql\nSELECT id FROM t\n```'),
      decompose: true,
    });
    const result = await pipeline.ask({ question: 'ids', schema });
    expect(result.shape?.steps).toBe(1);
    expect(result.decomposedSteps).toBe(1);
  });
});

describe('the boundaries the readers tolerate', () => {
  it('truncates a long statement in the audit prompt instead of sending it whole', () => {
    const long = `SELECT ${'x'.repeat(700)}`;
    const text = buildConditionAuditFeedback('q', long);
    expect(text).toContain(`${long.slice(0, 599)}…`);
    expect(text).not.toContain('x'.repeat(700));
  });

  it('sends a short statement whole', () => {
    expect(buildConditionAuditFeedback('q', 'SELECT 1')).toContain('The statement being checked: SELECT 1');
  });

  it('renders a candidate with no rows as zero columns instead of crashing', () => {
    expect(toCandidate({ sql: 'SELECT 1 WHERE 0', rows: [] })).toEqual({ sql: 'SELECT 1 WHERE 0', rows: 0, columns: 0, preview: '[]' });
  });

  it('renders a candidate with no source without an empty tag', () => {
    const prompt = buildSelectionPrompt('how many', [{ sql: 'SELECT 1', rows: 1, columns: 1, preview: '[[1]]' }]);
    expect(prompt).toContain('1. SELECT 1');
    expect(prompt).not.toContain('[]');
  });
});
