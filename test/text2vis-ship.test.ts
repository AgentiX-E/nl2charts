/**
 * The two instruments that price one decision, held to each other.
 *
 * `chart.assistedMark` is the shipped policy; `arbitrate.POLICIES['model-holds']` is the one the
 * 861-row reading was taken with. They were written in different packages, for different callers,
 * from the same sentence — "the model everywhere it spoke, the table where it did not" — and the
 * whole claim that the product reads 861 rests on their agreeing *row for row*. A policy that reads
 * well in a table and a product that behaves differently are two claims, and only one of them is
 * worth publishing.
 *
 * What is compared here, and why each one:
 *
 * - **the mark list**, name and gloss in order: the advice is a function of the list, so a gloss that
 *   differs is a different task for the same model. The arm's list is the one the answers were bought
 *   with; `chart`'s is the one the product sends. They are duplicated because of the layering rule and
 *   compared here because a comment cannot hold them together.
 * - **the prompt**, character for character: the arm's prompt is part of a cache key that 1,470
 *   answers hang off. Rewriting `eval/text2vis/llm.ts` to export it would invalidate all of them and
 *   cost ¥1.25 to re-learn what is already known; comparing the two strings costs nothing.
 * - **the reader**, over a set of replies chosen to hit every branch: exact, cased, quoted, fenced,
 *   a sentence, a name that is not on the list, empty.
 * - **the cap**, because a reply cut at 96 tokens and a reply that finished are read differently.
 * - **the route**, over synthetic rows: for every (table answer, model answer) pair, the product and
 *   the policy must name the same mark.
 */
import { describe, expect, it } from 'vitest';
import { assistedMark, MARK_GLOSS, MARK_OPTIONS } from '@agentix-e/nl2charts-chart';
import { chartChoiceBudget, buildChartChoicePrompt, parseChartChoice } from '@agentix-e/nl2charts-ai';
import { POLICIES, disputeOf } from '../eval/text2vis/arbitrate.js';
import { buildChoicePrompt, markOptions, parseChoice, replyBudget, type ChoiceOption } from '../eval/text2vis/llm.js';
import type { ProfileInput } from '../eval/text2vis/profile.js';

/** The policy the reading is about, looked up rather than restated. */
const MODEL_HOLDS = POLICIES.find((policy) => policy.name === 'model-holds');

/** One row of the corpus, as the arbitration reads it: a question, a label and a table. */
function row(prompt: string, chartType: string, tableData: string): ProfileInput {
  return { prompt, label: chartType, tableData };
}

const ROWS: readonly ProfileInput[] = [
  row('Revenue by country', 'Bar', 'country\tvalue\nUS\t5\nDE\t9\nFR\t2'),
  row('Revenue over the years', 'Line', 'year\tvalue\n2019\t3\n2020\t4\n2021\t8'),
  row('Share of revenue by country', 'Pie', 'country\tvalue\nUS\t50\nDE\t30\nFR\t20'),
  row('Total revenue', 'Gauge', 'value\n42'),
  row('Population by year', 'Line', 'entity\t2019\t2020\t2021\nOman\t1203\t1180\t1164\nQatar\t980\t1010\t1044'),
];

describe('the list the advice is chosen from', () => {
  it('is the arm s list, name for name and gloss for gloss', () => {
    expect(MARK_OPTIONS).toEqual(markOptions());
  });

  it('carries the same gloss for every mark, read off the table rather than the list', () => {
    for (const option of markOptions()) {
      expect(MARK_GLOSS[option.name as keyof typeof MARK_GLOSS], option.name).toBe(option.gloss);
    }
  });
});

describe('the prompt the advice is asked with', () => {
  it('is the arm s prompt, character for character', () => {
    for (const question of ['Revenue by country', 'How did revenue change?', '']) {
      expect(buildChartChoicePrompt(MARK_OPTIONS, question), question).toEqual(
        buildChoicePrompt(markOptions(), question),
      );
    }
  });

  it('is the same bytes for the label scale too, where the list is the corpus vocabulary', () => {
    // The property that matters is the builder, not the list: a second prompt shape would be a second
    // experiment, and the label arm's 41.22%-comparable reading was taken with this one.
    const labels: readonly ChoiceOption[] = [
      { name: 'Bar Chart', gloss: 'categories compared by the length of a bar' },
      { name: 'Area Chart', gloss: 'a value over time, filled to the axis' },
    ];
    expect(buildChartChoicePrompt(labels, 'q')).toEqual(buildChoicePrompt(labels, 'q'));
  });
});

describe('the reader', () => {
  const replies = [
    'bar',
    'Bar',
    ' BAR ',
    '`bar`',
    '"bar"',
    "'bar'",
    'bar.',
    '**bar**',
    '_bar_',
    '```\nbar\n```',
    '```text\nbar\n```',
    'A bar chart is best here.',
    'I would use bar',
    'donut',
    '',
    '   ',
    'pie pie',
  ];

  it('reads every reply the same way the arm reads it', () => {
    for (const reply of replies) {
      expect(parseChartChoice(reply, MARK_OPTIONS), reply).toBe(parseChoice(reply, markOptions()));
    }
    // The list is non-empty and the sample actually covers both outcomes, so the loop above is a
    // comparison rather than two functions agreeing on `undefined` fifteen times.
    expect(replies.map((reply) => parseChartChoice(reply, MARK_OPTIONS)).filter((name) => name !== undefined).length).toBeGreaterThan(5);
  });
});

describe('the cap a reply is cut at', () => {
  it('is the arm s, for both kinds of endpoint', () => {
    const chat = { id: 'a', model: 'm', async complete() { throw new Error('unused'); } } as never;
    const thinker = {
      id: 'b',
      model: 'm',
      capabilities: { thinksAloud: true },
      async complete() { throw new Error('unused'); },
    } as never;
    expect(chartChoiceBudget(chat)).toBe(replyBudget(chat));
    expect(chartChoiceBudget(thinker)).toBe(replyBudget(thinker));
    expect(chartChoiceBudget(chat)).toBe(96);
    expect(chartChoiceBudget(thinker)).toBeUndefined();
  });
});

describe('the route', () => {
  it('names the same mark the policy names, for every model answer the corpus can produce', async () => {
    expect(MODEL_HOLDS).toBeDefined();
    const answers: readonly (string | undefined)[] = [
      'bar',
      'line',
      'pie',
      'heatmap',
      'gauge',
      'scatter',
      undefined,
    ];
    let compared = 0;
    for (const input of ROWS) {
      for (const model of answers) {
        const dispute = disputeOf(input, model ?? null);
        const expected = MODEL_HOLDS?.choose(dispute).mark;
        const shipped = (await assistedMark(input.prompt, dispute.product.mark, async () => model)).mark;
        expect(shipped, `${input.prompt} vs ${String(model)}`).toBe(expected);
        compared += 1;
      }
    }
    expect(compared).toBe(ROWS.length * answers.length);
  });

  it('refuses a name outside the list before either instrument sees it', async () => {
    // `donut` is a real corpus label and not a mark this product draws. The arm's reader never writes
    // it, so an artifact carrying it was edited or written by another version — and the arbitration
    // refuses it rather than reading it as a decline, which would credit the row to whichever side
    // happened to decline.
    expect(() => disputeOf(ROWS[0] as ProfileInput, 'donut')).toThrow(/not one of the 11 marks/);
    const shipped = await assistedMark((ROWS[0] as ProfileInput).prompt, 'bar', async () => 'donut');
    expect(shipped).toEqual({ mark: 'bar', source: 'product', product: 'bar', fallback: 'unlisted' });
  });

  it('is the identity of the table when no advisor is configured, row for row', async () => {
    for (const input of ROWS) {
      const product = disputeOf(input, null).product.mark;
      expect(await assistedMark(input.prompt, product, undefined)).toEqual({
        mark: product,
        source: 'product',
        product,
      });
    }
  });
});
