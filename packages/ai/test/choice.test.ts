import { describe, expect, it } from 'vitest';
import {
  buildChartChoicePrompt,
  CHART_CHOICE_INSTRUCTION,
  chartChoiceBudget,
  createChartAdvisor,
  parseChartChoice,
  type ChartChoiceOption,
} from '../src/choice.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/provider.js';

/**
 * One closed list, one word out.
 *
 * Three things are pinned here, and each of them is a way the feature could be wrong without looking
 * wrong: the prompt (a run paid for 1,470 answers to *this* text), the reader (a sentence is not a
 * name), and the three reply states — named, named nothing, unreachable — which have three different
 * repairs and must not collapse into one.
 */
const OPTIONS: readonly ChartChoiceOption[] = [
  { name: 'bar', gloss: 'categories compared by the length of a bar' },
  { name: 'line', gloss: 'a value over time, joined into a line' },
];

/** A provider that answers once from a fixed reply and records what it was asked. */
function scripted(reply: Partial<LlmResponse> | Error, capabilities?: LlmProvider['capabilities']): {
  readonly provider: LlmProvider;
  readonly seen: LlmRequest[];
} {
  const seen: LlmRequest[] = [];
  const provider: LlmProvider = {
    id: 'scripted',
    model: 'scripted-large',
    ...(capabilities === undefined ? {} : { capabilities }),
    async complete(request: LlmRequest): Promise<LlmResponse> {
      seen.push(request);
      if (reply instanceof Error) throw reply;
      return { text: reply.text ?? 'bar', model: 'scripted-large', usage: reply.usage, finishReason: reply.finishReason };
    },
  };
  return { provider, seen };
}

describe('the prompt', () => {
  it('is the instruction and the list, then the question on its own turn', () => {
    const [system, user] = buildChartChoicePrompt(OPTIONS, 'Revenue by month');
    expect(system).toBe([...CHART_CHOICE_INSTRUCTION, 'bar — categories compared by the length of a bar\nline — a value over time, joined into a line'].join('\n'));
    expect(user).toBe('Revenue by month');
  });

  it('separates a name from its gloss with the em dash the arm uses', () => {
    const [system] = buildChartChoicePrompt(OPTIONS, 'q');
    expect(system).toContain('bar — categories');
    // A hyphen or a colon would be a different prompt, and the cached answers belong to this one.
    expect(system).not.toContain('bar - ');
    expect(system).not.toContain('bar: ');
  });

  it('does not end with a newline, so the list is the last thing read', () => {
    const [system] = buildChartChoicePrompt(OPTIONS, 'q');
    expect(system.endsWith('line')).toBe(true);
  });

  it('forbids a sentence as an answer', () => {
    const [system] = buildChartChoicePrompt(OPTIONS, 'q');
    expect(system).toContain('exactly one name');
    expect(system).toContain('nothing else');
  });

  it('withholds the table, which is the whole comparison against the rule table', () => {
    const [system] = buildChartChoicePrompt(OPTIONS, 'q');
    expect(system).toContain('no table, no result, no rows');
  });
});

describe('the reader', () => {
  it('takes an exact name', () => {
    expect(parseChartChoice('bar', OPTIONS)).toBe('bar');
  });

  it('takes a name in the case the endpoint chose', () => {
    expect(parseChartChoice('Line', OPTIONS)).toBe('line');
    expect(parseChartChoice('BAR', OPTIONS)).toBe('bar');
  });

  it('takes the punctuation a chat endpoint adds on its own', () => {
    for (const reply of ['  bar  ', '`bar`', '"bar"', "'bar'", 'bar.', '**bar**', '_bar_', 'bar\n']) {
      expect(parseChartChoice(reply, OPTIONS), reply).toBe('bar');
    }
  });

  it('takes a fenced reply, which is formatting rather than a different answer', () => {
    expect(parseChartChoice('```\nline\n```', OPTIONS)).toBe('line');
    expect(parseChartChoice('```text\nline\n```', OPTIONS)).toBe('line');
  });

  it('refuses a sentence that contains a name', () => {
    // Reading a paragraph for the name it mentions would be this file choosing for the model.
    expect(parseChartChoice('A bar chart is best here.', OPTIONS)).toBeUndefined();
    expect(parseChartChoice('I would use bar', OPTIONS)).toBeUndefined();
  });

  it('refuses a name the list does not carry', () => {
    expect(parseChartChoice('donut', OPTIONS)).toBeUndefined();
  });

  it('refuses an empty reply', () => {
    expect(parseChartChoice('', OPTIONS)).toBeUndefined();
    expect(parseChartChoice('   ', OPTIONS)).toBeUndefined();
  });
});

describe('the advisor', () => {
  it('asks with no sampling temperature other than zero, and the token cap the corpus measured', async () => {
    const { provider, seen } = scripted({ text: 'bar' });
    await createChartAdvisor(provider)('Revenue by month', OPTIONS);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.temperature).toBe(0);
    expect(seen[0]?.maxTokens).toBe(96);
    expect(seen[0]?.purpose).toBe('select');
    expect(seen[0]?.messages.map((message) => message.role)).toEqual(['system', 'user']);
  });

  it('leaves the cap off an endpoint that thinks aloud, rather than cutting the thought', async () => {
    const { provider, seen } = scripted({ text: 'bar' }, { thinksAloud: true } as LlmProvider['capabilities']);
    await createChartAdvisor(provider)('q', OPTIONS);
    expect(seen[0]?.maxTokens).toBeUndefined();
    expect(chartChoiceBudget(provider)).toBeUndefined();
  });

  it('returns the name it read', async () => {
    const { provider } = scripted({ text: ' Line ' });
    expect(await createChartAdvisor(provider)('q', OPTIONS)).toBe('line');
  });

  it('returns nothing for a reply that named nothing, which is a decline and not an error', async () => {
    const { provider } = scripted({ text: 'None of these fit.' });
    expect(await createChartAdvisor(provider)('q', OPTIONS)).toBeUndefined();
  });

  it('discards a reply cut at the cap, even when its first word was a name', async () => {
    // A prefix of an answer is not an answer: at `maxTokens: 32` a cut landed just after `Pie Chart.`
    // and scoring it published 860 instead of 857.
    const { provider } = scripted({ text: 'bar and then a sentence that wa', finishReason: 'length' });
    const advisor = createChartAdvisor(provider);
    expect(await advisor('q', OPTIONS)).toBeUndefined();
    expect(advisor.usage().truncated).toBe(1);
  });

  it('survives an unreachable endpoint, because a chart is not allowed to fail for one', async () => {
    const { provider } = scripted(new Error('connect ECONNREFUSED'));
    const advisor = createChartAdvisor(provider);
    expect(await advisor('q', OPTIONS)).toBeUndefined();
    // The call was spent, and the meter says so — "declined" and "unreachable" are different facts.
    expect(advisor.usage()).toEqual({ calls: 1, promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, truncated: 0 });
  });

  it('meters what the calls cost, so a feature can be priced rather than estimated', async () => {
    const { provider } = scripted({
      text: 'bar',
      usage: { promptTokens: 180, completionTokens: 2, cachedPromptTokens: 176 },
    });
    const advisor = createChartAdvisor(provider);
    await advisor('q', OPTIONS);
    await advisor('q', OPTIONS);
    expect(advisor.usage()).toEqual({ calls: 2, promptTokens: 360, completionTokens: 4, cachedPromptTokens: 352, truncated: 0 });
  });

  it('honours a caller who overrides the cap and asks for no temperature at all', async () => {
    const { provider, seen } = scripted({ text: 'bar' });
    await createChartAdvisor(provider, { maxTokens: 8, temperature: null })('q', OPTIONS);
    expect(seen[0]?.maxTokens).toBe(8);
    expect(seen[0]?.temperature).toBeNull();
  });
});
