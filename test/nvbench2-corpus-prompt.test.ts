/**
 * The replica instrument: the corpus's text, the corpus's input, and the reply it asks for.
 *
 * The assertions that matter here are the ones that make a replica a replica. A prompt that is *like*
 * the published one is not a replication, and the difference between the two is a reading nobody can
 * attribute — so the text is pinned by length, the input is pinned by exact string, and the reply
 * shapes are pinned by the four ways a model wraps the object the step contract asks for.
 */
import { describe, expect, it } from 'vitest';
import {
  CORPUS_BASIC,
  CORPUS_BASIC_EXAMPLES,
  CORPUS_BASIC_FULL,
  CORPUS_STEP,
  CORPUS_STEP_EXAMPLE,
  CORPUS_STEP_FULL,
  CORPUS_STEP_FULL_EXAMPLE,
  CORPUS_SYSTEM,
} from '../eval/nvbench2/corpus-text.js';
import {
  corpusInput,
  corpusPromptOf,
  finalOutputOf,
  parseModeOf,
  pyRepr,
  REPLICAS,
} from '../eval/nvbench2/corpus-prompt.js';

const ROW = {
  columns: ['authid', 'instid', 'paperid', 'authorder'],
  examples: { authid: [50, 55.5, 62], authorder: [1, 1.5, 3] },
  counts: { authid: 13, authorder: 3 },
  question: 'The average author order is displayed in a line chart.',
};

describe('the corpus text, pinned to its source', () => {
  /**
   * Length is the cheapest guard that catches an edit: a reworded clause changes the count, and the
   * count is what says the bytes are still `basic_prompt.py`'s. The numbers are the Python strings'
   * `len()` from `HKUSTDial/nvBench-2.0@main`.
   */
  it('carries every instruction string at the length the corpus wrote it', () => {
    expect(CORPUS_SYSTEM).toHaveLength(63);
    expect(CORPUS_BASIC).toHaveLength(330);
    expect(CORPUS_BASIC_EXAMPLES).toHaveLength(1361);
    expect(CORPUS_BASIC_FULL).toHaveLength(3560);
    expect(CORPUS_STEP).toHaveLength(3195);
    expect(CORPUS_STEP_EXAMPLE).toHaveLength(3382);
    expect(CORPUS_STEP_FULL).toHaveLength(8936);
    expect(CORPUS_STEP_FULL_EXAMPLE).toHaveLength(4897);
  });

  it('opens with the sentence that says how many charts to recommend', () => {
    expect(CORPUS_BASIC).toContain('please recommend 1 to 5 different charts');
    expect(CORPUS_STEP).toContain('generate 1 to 5 different visualization charts');
  });

  it('carries the output marker the corpus parses on', () => {
    expect(CORPUS_SYSTEM).toContain('You only answer with #OUTPUT.');
    expect(CORPUS_BASIC).toContain('#OUTPUT:[');
    expect(CORPUS_BASIC).toContain('{vega chart 1}');
  });

  it('carries all six steps of the step contract', () => {
    for (const step of ['Step 1:', 'Step 2:', 'Step 3:', 'Step 4:', 'Step 5:', 'Step 6:']) {
      expect(CORPUS_STEP).toContain(step);
    }
    expect(CORPUS_STEP).toContain('Output a chart list of all possible channel mappings');
  });

  it('states the five channel properties in the long basic form, and not in the short one', () => {
    // The clause that stops a reasoning tier from writing Vega-Lite's `"type"` into a channel, which
    // the reference's deep comparison then reads as a different chart. Measured: the short form read
    // 3.27 F1@3 on 750 dev questions, and 25% of its misses diverged first on an extra key.
    expect(CORPUS_BASIC_FULL).toContain('with only `field`, `aggregate`, `sort`, `bin` and `timeUnit`');
    expect(CORPUS_BASIC).not.toContain('timeUnit');
  });

  it('keeps the channel-type table in the long form only, which is what separates the two', () => {
    // The published script sends the short form; the table lives in `prompt`, the string the file
    // defines and does not concatenate. Their difference is the experiment `stepsFull` runs.
    expect(CORPUS_STEP).not.toContain('chart: [channel:type]');
    expect(CORPUS_STEP_FULL).toContain('chart: [channel:type]');
    expect(CORPUS_STEP_FULL).toContain('bar: [x:C/Q/T,y:Q,color:C]');
  });

  it('carries the worked answer the step contract shows, in its own fences', () => {
    expect(CORPUS_STEP_EXAMPLE).toContain('"thinking_steps"');
    expect(CORPUS_STEP_EXAMPLE).toContain('"final_output"');
    expect(CORPUS_STEP_EXAMPLE).toContain('```json');
  });

  it('names the four prompts, and reads each reply by the contract it asked for', () => {
    expect([...REPLICAS]).toEqual(['basic', 'basicFull', 'steps', 'stepsFull']);
    expect(parseModeOf('basic')).toBe('array');
    expect(parseModeOf('basicFull')).toBe('array');
    expect(parseModeOf('steps')).toBe('finalOutput');
    expect(parseModeOf('stepsFull')).toBe('finalOutput');
  });
});

describe('pyRepr, which is what makes the input the corpus printed', () => {
  it('prints a string single-quoted, a number bare, and the two constants as Python does', () => {
    expect(pyRepr('authid')).toBe("'authid'");
    expect(pyRepr(13)).toBe('13');
    expect(pyRepr(55.5)).toBe('55.5');
    expect(pyRepr(true)).toBe('True');
    expect(pyRepr(false)).toBe('False');
    expect(pyRepr(null)).toBe('None');
  });

  it('prints a list and a dict with the separators the corpus prints', () => {
    expect(pyRepr(['a', 'b'])).toBe("['a', 'b']");
    expect(pyRepr({ authid: 13 })).toBe("{'authid': 13}");
    expect(pyRepr({ authid: [50, 55.5] })).toBe("{'authid': [50, 55.5]}");
    expect(pyRepr([])).toBe('[]');
    expect(pyRepr({})).toBe('{}');
  });

  it('escapes the two characters a Python repr escapes', () => {
    expect(pyRepr("it's")).toBe("'it\\'s'");
    expect(pyRepr('a\\b')).toBe("'a\\\\b'");
  });

  it('prints a value that is not a Python type as None rather than throwing', () => {
    // `undefined` cannot arrive from parsed JSON; the case is here because a caller that builds a row
    // by hand can produce it, and a prompt builder that throws on one bad cell is a worse instrument
    // than one that renders it and lets the reading say what happened.
    expect(pyRepr(undefined)).toBe('None');
    expect(pyRepr(() => 1)).toBe('None');
  });
});

describe('the input block', () => {
  it('renders the three schema lines and the query, with the corpus line breaks', () => {
    expect(corpusInput(ROW)).toBe(
      "\n#INPUT:\nData Schema: ['authid', 'instid', 'paperid', 'authorder']\n" +
        "Value Example: {'authid': [50, 55.5, 62], 'authorder': [1, 1.5, 3]}\n" +
        "Unique Value Num: {'authid': 13, 'authorder': 3}\n" +
        'NL Query: The average author order is displayed in a line chart.\n',
    );
  });

  it('omits the distinct-count line when the row carries no counts', () => {
    const text = corpusInput({ ...ROW, counts: {} });
    expect(text).not.toContain('Unique Value Num');
    expect(text.trim().split('\n')).toHaveLength(4);
  });
});

describe('the two prompts', () => {
  it('sends the corpus system message and the corpus instruction followed by the input', () => {
    const [system, user] = corpusPromptOf('basic', ROW);
    expect(system).toBe(CORPUS_SYSTEM);
    expect(user).toBe(CORPUS_BASIC + CORPUS_BASIC_EXAMPLES + corpusInput(ROW));
  });

  it('sends the long basic instruction with the same worked charts and input', () => {
    const [system, user] = corpusPromptOf('basicFull', ROW);
    expect(system).toBe(CORPUS_SYSTEM);
    expect(user).toBe(CORPUS_BASIC_FULL + CORPUS_BASIC_EXAMPLES + corpusInput(ROW));
  });

  it('sends the short step instruction and its worked answer for the step method', () => {
    const [system, user] = corpusPromptOf('steps', ROW);
    expect(system).toBe(CORPUS_SYSTEM);
    expect(user).toBe(CORPUS_STEP + CORPUS_STEP_EXAMPLE + corpusInput(ROW));
  });

  it('sends the long step instruction with the example written for it', () => {
    const [system, user] = corpusPromptOf('stepsFull', ROW);
    expect(system).toBe(CORPUS_SYSTEM);
    expect(user).toBe(CORPUS_STEP_FULL + CORPUS_STEP_FULL_EXAMPLE + corpusInput(ROW));
    expect(user).toContain('"ambiguous": true');
  });

  it('ends every prompt with the query, so the instruction is a prefix a provider can cache', () => {
    for (const replica of REPLICAS) {
      const [, user] = corpusPromptOf(replica, ROW);
      expect(user.endsWith(`${ROW.question}\n`)).toBe(true);
    }
  });
});

describe('the reply the step contract asks for', () => {
  const OUTPUT = [{ mark: 'bar', encoding: { x: { field: 'authid' } } }];

  it('reads the array out of the object the contract names', () => {
    const reply = JSON.stringify({ thinking_steps: 'x', final_output: OUTPUT });
    expect(finalOutputOf(reply)).toEqual(OUTPUT);
  });

  it('reads an object inside a fence, which is how the corpus writes its own example', () => {
    const reply = 'Here it is:\n```json\n' + JSON.stringify({ final_output: OUTPUT }) + '\n```';
    expect(finalOutputOf(reply)).toEqual(OUTPUT);
  });

  it('reads the last fence, because a reply that quotes an example answers after it', () => {
    const quoted = '```json\n' + JSON.stringify({ final_output: [{ mark: 'line', encoding: {} }] }) + '\n```';
    const answer = '```json\n' + JSON.stringify({ final_output: OUTPUT }) + '\n```';
    expect(finalOutputOf(`${quoted}\nand here is mine:\n${answer}`)).toEqual(OUTPUT);
  });

  it('ignores an object whose final_output is not an array, and reads the one that is', () => {
    const wrong = '```json\n' + JSON.stringify({ final_output: { mark: 'bar' } }) + '\n```';
    const right = '```json\n' + JSON.stringify({ final_output: OUTPUT }) + '\n```';
    expect(finalOutputOf(wrong)).toBeUndefined();
    expect(finalOutputOf(`${wrong}\n${right}`)).toEqual(OUTPUT);
  });

  it('reads the second step contract, which ends at step_6 rather than at final_output', () => {
    // The corpus writes two step examples and they end differently; reading only the first cost one
    // dispatch — 750 paid calls recorded as 569 unparsed because the contract was right and the reader
    // was not.
    const reply = JSON.stringify({
      step_1: { answer: { column_list: [], filter_list: [] } },
      step_6: { reasoning: 'x', answer: OUTPUT },
    });
    expect(finalOutputOf(reply)).toEqual(OUTPUT);
    const fenced = '```json\n' + reply + '\n```';
    expect(finalOutputOf(fenced)).toEqual(OUTPUT);
  });

  it('prefers a named final_output when a reply carries both contracts', () => {
    const both = JSON.stringify({
      final_output: OUTPUT,
      step_6: { answer: [{ mark: 'line', encoding: {} }] },
    });
    expect(finalOutputOf(both)).toEqual(OUTPUT);
  });

  it('ignores an empty step_6 answer, which is a step written but not answered', () => {
    expect(finalOutputOf(JSON.stringify({ step_6: { answer: [] } }))).toBeUndefined();
    expect(finalOutputOf(JSON.stringify({ step_6: { reasoning: 'x' } }))).toBeUndefined();
    expect(finalOutputOf(JSON.stringify({ step_6: 'the last step' }))).toBeUndefined();
  });

  it('returns undefined for a reply that is not an object, or does not parse', () => {
    expect(finalOutputOf('I cannot answer that.')).toBeUndefined();
    expect(finalOutputOf('{ this is not json }')).toBeUndefined();
    expect(finalOutputOf(JSON.stringify({ step_1: { answer: [] } }))).toBeUndefined();
    expect(finalOutputOf('[]')).toBeUndefined();
  });
});
