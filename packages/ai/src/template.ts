/**
 * A prompt that is the whole prompt, not one more lever on ours.
 *
 * Every instruction this project has added to its own prompt has been a *rule*: one sentence
 * appended to a list of four, measured against an arm that is the same prompt without it. That
 * design can price a rule but cannot price a prompt: the fifteen arms in `eval/bird/run.ts`
 * share `buildSqlPrompt`'s skeleton — rules, card, blocks, `Question:` — and a competitor's
 * lead can sit in the skeleton itself.
 *
 * MAC-SQL is the case that made this worth building. On the same endpoint and the same 1,532
 * dev questions it scored 4.90pp above this project's prompt (p = 3.4 × 10⁻⁶), while its card
 * rule applied here *lost* 3.43pp (p = 0.0241), its decomposition is already a source here, and
 * its refiner fires on 6.7% of dev. The parts of it that had been priced were the parts that
 * did not pay. What had never been run beside ours is the thing it actually sends: a short
 * constraint list, two worked examples, and an output shape where the model answers each
 * sub-question with its own statement and the last one is the answer.
 *
 * ## What this reproduces, and what it does not
 *
 * The information is theirs, the wording is ours. MAC-SQL carries no licence file, so its text
 * is not copied: the five constraints are stated in this project's voice, the two worked
 * examples are the corpus's own questions and statements (BIRD and Spider are public datasets),
 * and the section markers are kept because the examples and the input block have to be in one
 * format for the examples to teach anything. Three differences are deliberate and are each a
 * thing this project would not ship:
 *
 * - **The card carries the column type.** MAC-SQL's list format is `(name, description. Value
 *   examples: …)` and drops the declared type; ours is `(name, TYPE. description. …)`. A prompt
 *   that hides the type would be measured on an information deficit this project does not have,
 *   and the arm that lost to it would be reporting a self-inflicted wound.
 * - **The value examples are not compiled.** Their selector profiles every column and puts up to
 *   six stored values on each line. That block is a separate lever here (`samples-wide`, +2.02pp
 *   for +74.9% of the prompt), so an arm that carried it inside the template would be two
 *   changes in one reading. The renderer prints the examples only for the columns a caller
 *   already attached them to.
 * - **No selector.** Their pipeline prunes the card with a model call before this prompt runs;
 *   that rule is `card.ts` here and it lost 3.43pp, so the template is measured on the full card.
 *
 * The output shape is reproduced exactly, because it is the part the reader depends on: each
 * sub-question is written as a plain `Sub question <n>:` line, each statement in its own fence,
 * and the answer is the last fence. `parseDecomposed` reads that shape; `extractSql` would read
 * the first fence and return sub-question one, which is executable, plausible and answers a
 * different question — which is why `readStatement` exists and why the template is a property of
 * the prompt rather than of the arm.
 */

import type { SchemaTable } from './linking.js';

/** The templates a caller can ask for instead of the assembled prompt. */
export type PromptTemplate = 'macsql-bird';

/**
 * The constraints MAC-SQL's BIRD template states, in this project's voice.
 *
 * Five rules, and each one is a projection of a failure this repository has measured: the extra
 * projection column (`column-count`, the largest bucket in the model comparison), the table the
 * statement joins and never reads, the `MAX` that forces a second pass over the join, the
 * comparison against `NULL` that returns no rows, and the `ORDER BY` without `GROUP BY` that
 * returns one row per duplicate. Their wording is not copied; their list is.
 */
export const MACSQL_CONSTRAINTS: readonly string[] = [
  'In `SELECT <column>`, select only the columns the question asks for — no column and no value it does not mention.',
  'In `FROM <table>` or `JOIN <table>`, include only the tables the question needs.',
  'When the answer is a maximum or a minimum, join the table first and then apply `SELECT MAX(<column>)` or `SELECT MIN(<column>)`.',
  'When a column holds `None`, prefer `JOIN <table>` or `WHERE <column> IS NOT NULL` over a comparison with `NULL`.',
  'When the answer orders by a column (`ORDER BY <column> ASC|DESC`), add `GROUP BY <column>` before it so each value appears once.',
];

/**
 * The first worked example: one question, its evidence, and the two statements it decomposes to.
 *
 * This is BIRD's own question and the schema it is written for, so it teaches a value spelling
 * (`Charter School (Y/N)` = 1) and a ratio defined in the evidence rather than in the schema —
 * the two things a rule cannot state as compactly as an example.
 */
const EXAMPLE_ONE = [
  '【Database schema】',
  '# Table: frpm',
  '[',
  "  (CDSCode, CDSCode. Value examples: ['01100170109835', '01100170112607'].),",
  '  (Charter School (Y/N), Charter School (Y/N). Value examples: [1, 0, None]. And 0: N;. 1: Y),',
  '  (Enrollment (Ages 5-17), Enrollment (Ages 5-17). Value examples: [5271.0, 4734.0].),',
  '  (Free Meal Count (Ages 5-17), Free Meal Count (Ages 5-17). Value examples: [3864.0, 2637.0]. And eligible free rate = Free Meal Count / Enrollment)',
  ']',
  '# Table: satscores',
  '[',
  "  (cds, California Department Schools. Value examples: ['10101080000000', '10101080109991'].),",
  "  (sname, school name. Value examples: ['None', 'Middle College High', 'John F. Kennedy High', 'Independence High', 'Foothill High'].),",
  '  (NumTstTakr, Number of Test Takers in this school. Value examples: [24305, 4942, 1, 0, 280]. And number of test takers in each school),',
  '  (AvgScrMath, average scores in Math. Value examples: [699, 698, 289, None, 492]. And average scores in Math),',
  '  (NumGE1500, Number of Test Takers Whose Total SAT Scores Are Greater or Equal to 1500. Value examples: [5837, 2125, 0, None, 191]. And Excellence Rate = NumGE1500 / NumTstTakr)',
  ']',
  '【Foreign keys】',
  'frpm.`CDSCode` = satscores.`cds`',
  '【Question】',
  'List school names of charter schools with an SAT excellence rate over the average.',
  '【Evidence】',
  'Charter schools refers to `Charter School (Y/N)` = 1 in the table frpm; Excellence rate = NumGE1500 / NumTstTakr',
  '',
  'Sub question 1: What is the average SAT excellence rate of charter schools?',
  'SQL',
  '```sql',
  'SELECT AVG(CAST(T2.`NumGE1500` AS REAL) / T2.`NumTstTakr`)',
  '    FROM frpm AS T1',
  '    INNER JOIN satscores AS T2',
  '    ON T1.`CDSCode` = T2.`cds`',
  '    WHERE T1.`Charter School (Y/N)` = 1',
  '```',
  '',
  'Sub question 2: Which charter schools have an SAT excellence rate above that average, and what are their names?',
  'SQL',
  '```sql',
  'SELECT T2.`sname`',
  '  FROM frpm AS T1',
  '  INNER JOIN satscores AS T2',
  '  ON T1.`CDSCode` = T2.`cds`',
  '  WHERE T2.`sname` IS NOT NULL',
  '  AND T1.`Charter School (Y/N)` = 1',
  '  AND CAST(T2.`NumGE1500` AS REAL) / T2.`NumTstTakr` > (',
  '    SELECT AVG(CAST(T4.`NumGE1500` AS REAL) / T4.`NumTstTakr`)',
  '    FROM frpm AS T3',
  '    INNER JOIN satscores AS T4',
  '    ON T3.`CDSCode` = T4.`cds`',
  '    WHERE T3.`Charter School (Y/N)` = 1',
  '  )',
  '```',
  '',
  'Question Solved.',
].join('\n');

/**
 * The second worked example, and the one that teaches the join-then-order rule.
 *
 * It is the question the constraints' `ORDER BY` clause exists for: three tables, two hops, and
 * an answer decided by which order the two keys are applied in. The `LIMIT 1` in the last
 * sub-question is the shape the caller's own arm has to beat, not an accident of the example.
 */
const EXAMPLE_TWO = [
  '【Database schema】',
  '# Table: account',
  '[',
  '  (account_id, the id of the account. Value examples: [11382, 11362, 2, 1, 2367].),',
  '  (district_id, location of branch. Value examples: [77, 76, 2, 1, 39].),',
  "  (frequency, frequency of the account. Value examples: ['POPLATEK MESICNE', 'POPLATEK TYDNE', 'POPLATEK PO OBRATU'].),",
  "  (date, the creation date of the account. Value examples: ['1997-12-29', '1997-12-28'].)",
  ']',
  '# Table: client',
  '[',
  '  (client_id, the unique number. Value examples: [13998, 13971, 2, 1, 2839].),',
  "  (gender, gender. Value examples: ['M', 'F']. And F: female. M: male),",
  "  (birth_date, birth date. Value examples: ['1987-09-27', '1986-08-13'].),",
  '  (district_id, location of branch. Value examples: [77, 76, 2, 1, 39].)',
  ']',
  '# Table: district',
  '[',
  '  (district_id, location of branch. Value examples: [77, 76, 2, 1, 39].),',
  "  (A4, number of inhabitants. Value examples: ['95907', '95616', '94812'].),",
  '  (A11, average salary. Value examples: [12541, 11277, 8114].)',
  ']',
  '【Foreign keys】',
  'account.`district_id` = district.`district_id`',
  'client.`district_id` = district.`district_id`',
  '【Question】',
  'What is the gender of the youngest client who opened account in the lowest average salary branch?',
  '【Evidence】',
  'Later birthdate refers to younger age; A11 refers to average salary',
  '',
  'Sub question 1: Which district has the lowest average salary?',
  'SQL',
  '```sql',
  'SELECT `district_id`',
  '  FROM district',
  '  ORDER BY `A11` ASC',
  '  LIMIT 1',
  '```',
  '',
  'Sub question 2: Who is the youngest client holding an account in that district?',
  'SQL',
  '```sql',
  'SELECT T1.`client_id`',
  '  FROM client AS T1',
  '  INNER JOIN district AS T2',
  '  ON T1.`district_id` = T2.`district_id`',
  '  ORDER BY T2.`A11` ASC, T1.`birth_date` DESC ',
  '  LIMIT 1',
  '```',
  '',
  'Sub question 3: What is the gender of that client?',
  'SQL',
  '```sql',
  'SELECT T1.`gender`',
  '  FROM client AS T1',
  '  INNER JOIN district AS T2',
  '  ON T1.`district_id` = T2.`district_id`',
  '  ORDER BY T2.`A11` ASC, T1.`birth_date` DESC ',
  '  LIMIT 1 ',
  '```',
  '',
  'Question Solved.',
].join('\n');

/**
 * The card in the format the examples are written in.
 *
 * The heading is `# Table: <name>` and each column is one bracketed line, because the two
 * worked examples above are written that way and an example teaches a format as well as a
 * method. `TYPE` is the one addition to their line (their format states no type), and value
 * examples appear only where the caller attached them: compiling them is a lever of its own
 * here (`samples-wide`), and a template that compiled them would be two changes in one arm.
 *
 * A column with neither a description nor samples still gets its line: a table whose every line
 * is empty of prose is still a table, and dropping the line would make the arm's card a
 * different card from the one its parent sends.
 */
function stop(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

export function renderMacSqlCard(
  schema: readonly SchemaTable[],
  options: { readonly descriptions?: boolean; readonly samples?: boolean; readonly limit?: number } = {},
): string {
  const withDescriptions = options.descriptions !== false;
  // The same budget the assembled prompt gives its card, counted the only way this format can
  // count it: one line per column. It was not honoured at first, and the omission is the reason
  // the first clean reading of the template was confounded — the arm sent 12,668 characters of
  // prompt against the parent's 2,604, because `schemaLines: 40` reached `buildSqlPrompt` and the
  // template rendered every column of every table. A template is not exempt from a card budget,
  // and an option a caller sets and nothing reads is the defect this module's own guard exists for.
  const limit = options.limit ?? 40;
  let written = 0;
  const blocks: string[] = [];
  for (const table of schema) {
    if (written >= limit) break;
    const lines = table.columns.slice(0, Math.max(0, limit - written)).map((column) => {
      const parts: string[] = [];
      if (withDescriptions && column.comment !== undefined && column.comment.trim().length > 0) parts.push(column.comment.trim());
      if (options.samples === true && column.samples !== undefined && column.samples.length > 0) {
        parts.push(`Value examples: [${column.samples.join(', ')}]`);
      }
      // The sentence ends with a full stop in their format, and the trailing comma belongs to the
      // list rather than to the sentence: `(name, desc.),` is what their own renderer produces.
      // Their renderer appends the stop unconditionally, which turns a description that already
      // ends in one into `order..`; a prompt is read by a model and paid for by the token, so the
      // stop is added only when it is missing.
      const body = [`${column.name},`, stop(column.type), ...parts.map(stop)].join(' ');
      return `  (${body})`;
    });
    if (lines.length === 0) break;
    written += lines.length;
    blocks.push([`# Table: ${table.table}`, '[', lines.join(',\n'), ']'].join('\n'));
  }
  return blocks.join('\n');
}

/**
 * Every join hint in the card, in the spelling their examples use.
 *
 * `foreignKeys` is rendered per table because that is where the loader put it; the template has
 * one block for the whole database, and a block that repeated the table name would read as two
 * hints for two tables. An empty list renders `None` rather than an empty block, which is what
 * their template does with a database that declares no key: the heading stays, so the model is
 * never left wondering whether the section was omitted by accident.
 */
export function renderMacSqlForeignKeys(schema: readonly SchemaTable[]): string {
  const hints = schema.flatMap((table) => table.foreignKeys ?? []);
  return hints.length === 0 ? 'None' : hints.join('\n');
}

/** What a caller supplies; the rest of the prompt is fixed text. */
export interface MacSqlPromptInput {
  readonly question: string;
  readonly schema: readonly SchemaTable[];
  readonly evidence?: string;
  readonly descriptions?: boolean;
  readonly samples?: boolean;
  /** Column lines the card may spend; the assembled prompt's `schemaLines` means the same thing. */
  readonly schemaLines?: number;
}

/**
 * The whole prompt MAC-SQL's BIRD template is, with our card in its slot.
 *
 * The assembly is a concatenation rather than a `format` over a template string, because a
 * template string with four placeholders is a second language to validate: a placeholder the
 * caller forgot leaves `{desc_str}` in a prompt and the model reads it as an instruction, and
 * nothing on the way out checks for it. Concatenation cannot leave a placeholder behind.
 */
export function renderMacSqlBirdPrompt(input: MacSqlPromptInput): string {
  return [
    'Given a 【Database schema】 description, a 【Evidence】 note and a 【Question】, write SQLite SQL that answers the question, and understand the database and the evidence before you write it.',
    'Work by decomposition: split the question into the sub-questions it is built from and write the statement that answers each, then write the statement that answers the question itself. The last statement is the answer.',
    '',
    '【Constraints】',
    ...MACSQL_CONSTRAINTS.map((rule) => `- ${rule}`),
    '',
    '==========',
    '',
    EXAMPLE_ONE,
    '',
    '==========',
    '',
    EXAMPLE_TWO,
    '',
    '==========',
    '',
    '【Database schema】',
    renderMacSqlCard(input.schema, {
      ...(input.descriptions === undefined ? {} : { descriptions: input.descriptions }),
      ...(input.samples === undefined ? {} : { samples: input.samples }),
      ...(input.schemaLines === undefined ? {} : { limit: input.schemaLines }),
    }),
    '【Foreign keys】',
    renderMacSqlForeignKeys(input.schema),
    '【Question】',
    input.question,
    '【Evidence】',
    input.evidence !== undefined && input.evidence.trim().length > 0 ? input.evidence.trim() : 'None',
    '',
    'Decompose the question into sub questions, considering 【Constraints】, and generate the SQL after thinking step by step:',
  ].join('\n');
}

/**
 * The options the template cannot carry, and the reason each one has to be refused.
 *
 * A template owns the whole prompt, so an option that only exists in the assembled one is not
 * "ignored" — it is a lever the caller believes is on. Silently dropping it is the failure class
 * this repository has paid for twice (`emptyRetry` wired to a hook that never fired, `values`
 * read by a harness and never passed down), and both times the reading looked like a mechanism
 * that simply did not help. Throwing turns that into a stack trace at the first call.
 *
 * `evidence`, `descriptions`, `samples` and `foreignKeys` are absent from this list on purpose:
 * the template has a slot for the first and honours the other three in its card.
 */
export const TEMPLATE_CONFLICTS: readonly string[] = ['definitions', 'demonstrations', 'values', 'rowSamples', 'plan', 'interpretation', 'decompose', 'reasoning', 'notes'];

/**
 * Refuse a prompt that asks for the template and a lever the template has no slot for.
 *
 * The check is exported so a caller can ask before it builds anything — the harness asserts the
 * same rule at arm declaration, and the two must not be able to disagree about which levers are
 * incompatible.
 */
export function assertTemplateCarries(options: {
  readonly template: PromptTemplate;
  readonly definitions?: string;
  readonly demonstrations?: string;
  readonly values?: string;
  readonly rowSamples?: string;
  readonly plan?: string;
  readonly interpretation?: string;
  readonly decompose?: boolean;
  readonly reasoning?: 'sql-like';
  readonly notes?: readonly string[];
  readonly dialect?: string;
}): void {
  const conflicts: string[] = [];
  for (const key of TEMPLATE_CONFLICTS) {
    const value = (options as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    // An empty block is not a block: the enumerator above omits a block whose text is empty, so a
    // caller that passes `''` is asking for nothing rather than for something the template drops.
    if (value === '') continue;
    // A boolean lever set to `false` is a lever that is off, and `buildAskMessages` sets
    // `decompose` on every call (`input.decompose === true || input.prompt?.decompose === true`),
    // so a template prompt arriving through the message builder carries `decompose: false` whether
    // or not anyone asked for a decomposition. Reading that as a conflict made every case of the
    // first `macsql-prompt` dispatch fail inside the harness: 600 rows at 0.0%, no call spent, and
    // a guard two layers away reporting a missing format profile. The test that would have caught
    // it goes through `buildAskMessages`, not `buildSqlPrompt`, and exists now.
    if (value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    conflicts.push(key);
  }
  // The template states its dialect in the instruction and in the examples, so a caller asking for
  // another one is asking for a prompt that contradicts itself. `SQLite` is what both examples are.
  if (options.dialect !== undefined && options.dialect !== 'SQLite') conflicts.push('dialect');
  if (conflicts.length > 0) {
    throw new Error(
      `prompt template '${options.template}' is the whole prompt and has no slot for ${conflicts.join(', ')}; ` +
        'drop the option or use the assembled prompt',
    );
  }
}
