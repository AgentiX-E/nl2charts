/**
 * The corpus's input contract, and the two prompts that read it.
 *
 * ## Why the input is replicated as well as the instruction
 *
 * `corpus-text.ts` carries the corpus's instructions. They are not enough on their own: both of the
 * corpus's prompting baselines read the table as
 *
 * ```
 * #INPUT:
 * Data Schema: ['authid', 'instid', 'paperid', 'authorder']
 * Value Example: {'authid': [50, 55.5, 62], ...}
 * Unique Value Num: {'authid': 13, ...}
 * NL Query: The average author order is displayed in a line chart ...
 * ```
 *
 * and this repository's own prompt reads it as `authid (quantitative), ...`. Those are different
 * observations of the same table: three sample values and a distinct count tell a model which column
 * is a measure and which is an identifier, and the type word tells it which string this repository's
 * type map chose. Feeding the corpus's instruction to our column list would test a system the corpus
 * never ran, so the pair travels together — instruction and input are one instrument.
 *
 * ## Why the rendering is Python's `repr` and not JSON
 *
 * The corpus builds its input with f-strings over Python objects, so its arrays print as `['a', 'b']`
 * and its dicts as `{'a': 1}`. A JSON rendering (`["a", "b"]`, `{"a": 1}`) says the same thing in
 * different bytes, and a byte-level difference is exactly what a replication is trying not to have.
 * `pyRepr` therefore reproduces the shape of `repr` for the types a schema can hold, with one
 * deliberate simplification: a string is always single-quoted with its own quotes escaped, where
 * Python would switch to double quotes when a string contains a single quote. The corpus's schemas are
 * column names and sampled values, and none of them contain a quote — a limitation stated here rather
 * than discovered later.
 *
 * ## What a replica is not
 *
 * A replica is not a rule. The rules in `arm.ts` are additive clauses over one instruction, and the
 * ablation compares arms that differ by exactly one of them; a replica replaces the instruction and
 * the input wholesale, so it is a different instrument rather than a wider one. Keeping it out of
 * `RULES` is what keeps `metrics.json`'s `readings` a table of comparable arms.
 */
import {
  CORPUS_BASIC,
  CORPUS_BASIC_EXAMPLES,
  CORPUS_BASIC_FULL,
  CORPUS_STEP,
  CORPUS_STEP_EXAMPLE,
  CORPUS_STEP_FULL,
  CORPUS_STEP_FULL_EXAMPLE,
  CORPUS_SYSTEM,
} from './corpus-text.js';
import type { SplitRow } from './check.js';

/**
 * Which of the corpus's prompts a run sends.
 *
 * `basic` and `steps` are the two strings `prompt_experiment/*.py` actually concatenate, and they are
 * the two that matters for attribution: `basic` sends `simple_prompt` with its examples, which never
 * says which keys an `encoding` may carry, while `basicFull` sends `prompt`, which does — 3.27 against
 * 29.49 on the same model, so a replication that stopped at the shorter one would have recorded the
 * corpus's instruction as a model failure. `stepsFull` is the long form of the six steps, which that
 * script defines and does not send, and the only one of the four that states the channel-type table;
 * it reads 25.63, which is +0.51 over `steps` and inside the noise, so the second step contract is a
 * choice rather than an improvement. All four are measured in `metrics.json` `replicas`.
 */
export const REPLICAS = ['basic', 'basicFull', 'steps', 'stepsFull'] as const;
export type Replica = (typeof REPLICAS)[number];

/** The instruction and worked example each replica sends, before the table is appended. */
const INSTRUCTION: Readonly<Record<Replica, string>> = {
  basic: CORPUS_BASIC + CORPUS_BASIC_EXAMPLES,
  basicFull: CORPUS_BASIC_FULL + CORPUS_BASIC_EXAMPLES,
  steps: CORPUS_STEP + CORPUS_STEP_EXAMPLE,
  stepsFull: CORPUS_STEP_FULL + CORPUS_STEP_FULL_EXAMPLE,
};

/**
 * How a replica's reply is read.
 *
 * The two step variants ask for the same object and are read the same way; the basic one asks for a
 * bare array. This is a property of the prompt, so it is derived from it rather than passed beside it:
 * a caller that pairs the wrong reader with a prompt would score a correct answer as unreadable.
 */
export function parseModeOf(replica: Replica): 'array' | 'finalOutput' {
  return replica === 'basic' || replica === 'basicFull' ? 'array' : 'finalOutput';
}

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One value as Python would print it.
 *
 * The recursion is the whole function: a schema is strings, numbers and lists of them nested one
 * level into a dict, and every level prints the same way. `undefined` is not a Python value and cannot
 * reach here from parsed JSON, so it is mapped to `None` rather than given a branch of its own.
 */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (isRecordLike(value)) {
    const entries = Object.entries(value).map(([key, inner]) => `${pyRepr(key)}: ${pyRepr(inner)}`);
    return `{${entries.join(', ')}}`;
  }
  return 'None';
}

/**
 * The `#INPUT:` block, exactly as `basic_prompt.py` and `step_prompt.py` build it.
 *
 * The leading newline and the trailing one are the corpus's, not decoration: their input string is
 * concatenated to the prompt with no separator, and dropping the leading newline would join
 * `#OUTPUT:[ ...]` to `#INPUT:` on one line.
 *
 * `Unique Value Num` is omitted when the row's schema did not carry the counts, because a line saying
 * `{}` claims the corpus said something it did not.
 */
export function corpusInput(row: Pick<SplitRow, 'columns' | 'examples' | 'counts' | 'question'>): string {
  const lines = [
    '#INPUT:',
    `Data Schema: ${pyRepr([...row.columns])}`,
    `Value Example: ${pyRepr(row.examples)}`,
    ...(Object.keys(row.counts).length === 0 ? [] : [`Unique Value Num: ${pyRepr(row.counts)}`]),
    `NL Query: ${row.question}`,
  ];
  return `\n${lines.join('\n')}\n`;
}

/**
 * The two messages one replica sends.
 *
 * The system half is the corpus's `sys_content`, and everything else is the user half in the corpus's
 * own order. Their code concatenates all of it into one string; the split is the only difference, and
 * it exists so that a provider's prefix cache can see the instruction as a prefix rather than as an
 * accident of position.
 */
export function corpusPromptOf(
  replica: Replica,
  row: Pick<SplitRow, 'columns' | 'examples' | 'counts' | 'question'>,
): readonly [string, string] {
  return [CORPUS_SYSTEM, INSTRUCTION[replica] + corpusInput(row)];
}

/**
 * The charts a `steps` replica wrote, from the object it was asked for.
 *
 * The corpus ships **two** step contracts, and they end differently:
 *
 * - `simple_step_example` names the array in a top-level `final_output`;
 * - `step_example`, the worked answer for the long instruction, ends at `step_6.answer`, because the
 *   sixth step *is* the chart list.
 *
 * Both are read here. Missing the second cost one dispatch: the long step replica answered all 750
 * questions, paid for them, and scored 0.00 with 569 replies recorded as unparsed — the contract was
 * right and the reader was wrong. A body of zero is not a reading until the parser has been shown the
 * shape the prompt actually asks for.
 *
 * Four wrappings are therefore read: the fenced object, a bare object, and either of those behind
 * prose. The last fence is tried first because a reply that quotes the instruction's own example
 * before answering puts its answer last.
 */
export function finalOutputOf(text: string): unknown[] | undefined {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gu)].map((match) => match[1] ?? '');
  const candidates = [...fenced.reverse(), text];
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end < start) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch {
      continue;
    }
    if (!isRecordLike(parsed)) continue;
    const output = parsed['final_output'];
    if (Array.isArray(output)) return output;
    const sixth = parsed['step_6'];
    if (isRecordLike(sixth) && Array.isArray(sixth['answer']) && sixth['answer'].length > 0) {
      return sixth['answer'];
    }
  }
  return undefined;
}
