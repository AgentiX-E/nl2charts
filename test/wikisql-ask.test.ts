/**
 * The WikiSQL asker, tested where it can be: on a split the test writes itself.
 *
 * Every case here is about one of the three things that decide what a reading means, and none of
 * them is the model: the prompt (what the model is shown), the reader (what counts as an answer),
 * and the refusal (when a run is not allowed to publish a number at all). The fourth — how accurate
 * the model is — is not a property of this file and no test here asserts it.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmProvider, LlmRequest, LlmResponse } from '@agentix-e/nl2charts-ai';
import {
  ARMS,
  ARM_NAMES,
  BUDGET_YUAN,
  MAX_UNREADABLE_SHARE,
  PER_CASE,
  PROMPT_VERSION,
  REASONING_COMPLETION_TOKENS,
  SAMPLE_ROWS,
  armNamed,
  perCaseFor,
  promptVersionFor,
  reasonsFirst,
  cellOf,
  sqlNameOf,
  askAll,
  main,
  parseTables,
  pool,
  predictionsText,
  projectedYuan,
  promptFor,
  providerFrom,
  reportLines,
  runsAsMain,
  start,
  resolveSettings,
  statementOfReply,
  tallyOf,
  unreadableText,
  reasonsOf,
  type AskRecord,
  type Table,
} from '../eval/wikisql/ask.js';
import { parseSplit, parsePredictions } from '../eval/wikisql/exec.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A split the test owns: two questions, one table, one database file that is never opened. */
function corpus(questions: readonly string[] = ['who was picked first?', 'how many rows?']): string {
  const dir = mkdtempSync(join(tmpdir(), 'wikisql-ask-'));
  dirs.push(dir);
  const rows = questions
    .map((question) => JSON.stringify({ table_id: '1-2-3', question, sql: { sel: 0, agg: 0, conds: [] } }))
    .join('\n');
  writeFileSync(join(dir, 'dev.jsonl'), `${rows}\n`);
  writeFileSync(
    join(dir, 'dev.tables.jsonl'),
    `${JSON.stringify({
      id: '1-2-3',
      header: ['Pick', 'Player'],
      types: ['real', 'text'],
      rows: [['1', 'Ada'], ['2', 'Grace'], ['3', 'Alan'], ['4', 'Edsger'], ['5', 'Barbara'], ['6', 'Tony']],
    })}\n`,
  );
  writeFileSync(join(dir, 'dev.db'), '');
  return dir;
}

/** A provider that answers from a script, so nothing here needs an endpoint. */
function providerOf(answer: (request: LlmRequest) => LlmResponse | Promise<LlmResponse>): LlmProvider {
  return { id: 'test', model: 'deepseek-chat', complete: async (request) => answer(request) };
}

const reply = (text: string, extra: Partial<LlmResponse> = {}): LlmResponse => ({ text, model: 'deepseek-chat', ...extra });

const TABLE: Table = {
  id: '1-2-3',
  header: ['Pick', 'Player'],
  types: ['real', 'text'],
  rows: [['1', "Ada"], ['2', "O'Hare"], ['3', 'Alan']],
};

describe('the prompt is the observation, so its shape is asserted', () => {
  it('names the table the database knows, not the id the corpus stores', () => {
    const [, user] = promptFor('who was picked first?', TABLE);
    expect(user?.content).toContain('"table_1_2_3"');
    expect(user?.content).not.toContain('"1-2-3"');
  });

  it('gives each column the SQL name the database uses and the label the question means', () => {
    // The two are different in this corpus — `col2` in `dev.db`, `Position` in `tables.jsonl` — and
    // the first pilot sent only the label, so 19 of 40 statements named a column that does not exist.
    const [, user] = promptFor('q', TABLE);
    expect(user?.content).toContain('col0 (real) — "Pick"');
    expect(user?.content).toContain('col1 (text) — "Player"');
    expect(user?.content).toContain('never by the label in quotes after it');
  });

  it('falls back to text when the corpus ships no type for a column', () => {
    const [, user] = promptFor('q', { ...TABLE, types: ['real'] });
    expect(user?.content).toContain('col1 (text) — "Player"');
  });

  it('shows at most SAMPLE_ROWS rows, and every row it shows', () => {
    const wide: Table = { ...TABLE, rows: Array.from({ length: SAMPLE_ROWS + 4 }, (_, i) => [String(i), `p${String(i)}`]) };
    const [, user] = promptFor('q', wide);
    expect(user?.content).toContain("'p0'");
    expect(user?.content).toContain(`'p${String(SAMPLE_ROWS - 1)}'`);
    expect(user?.content).not.toContain(`'p${String(SAMPLE_ROWS)}'`);
  });

  it('renders a cell the corpus stored as a number or as null, because the JSON does not promise strings', () => {
    // 14 of 40 cases in the first pilot died here with `value.replaceAll is not a function`, and the
    // refusal's own evidence file is what named it.
    const [, user] = promptFor('q', { ...TABLE, rows: [[1, null]] });
    expect(user?.content).toContain("'1', ''");
  });

  it('escapes a quote the way SQL escapes one, so the literal it copies is the literal stored', () => {
    const [, user] = promptFor('q', TABLE);
    expect(user?.content).toContain("'o''hare'");
  });

  it('folds the sample rows to lower case, because that is how the database stores its text', () => {
    // `dev.tables.jsonl` keeps `Duke`; `dev.db` holds `duke`. A literal copied from the first is a
    // statement that executes and returns nothing, which is what 21 of the pilot's 40 cases did.
    expect(cellOf('Duke')).toBe("'duke'");
    expect(cellOf(null)).toBe("''");
    expect(cellOf(7)).toBe("'7'");
    expect(sqlNameOf(12)).toBe('col12');
  });

  it('carries the question and the instruction that makes a value question answerable', () => {
    const [system, user] = promptFor('who wrote "The Duff"?', TABLE);
    expect(system?.content).toContain('one SQLite statement');
    expect(user?.content).toContain('Question: who wrote "The Duff"?');
    expect(user?.content).toContain('copy it exactly as the rows above spell it');
  });

  it('is a constant, because two versions are two instruments', () => {
    expect(PROMPT_VERSION).toBe('wikisql-ask@2');
  });

  it('takes the rows out of the schema arm and leaves everything else where it was', () => {
    // The arm's whole content: five rows removed, the fact they carried said in words. Every other
    // line — the table name, the two names per column, the question, the instruction's first three
    // lines — is the same string in both arms, so the difference the reading measures is one block.
    const [, values] = promptFor('who was picked first?', TABLE, 'values');
    const [, schema] = promptFor('who was picked first?', TABLE, 'schema');
    expect(values?.content).toContain('The first 3 rows, as this table stores them:');
    expect(values?.content).toContain("'ada'");
    expect(schema?.content).not.toContain('rows, as this table stores them');
    expect(schema?.content).not.toContain("'ada'");
    expect(schema?.content).toContain('col0 (real) — "Pick"');
    expect(schema?.content).toContain('Question: who was picked first?');
    // Header and both column lines, character for character: the arms differ after them, not in them.
    expect(schema?.content?.split('\n').slice(0, 3)).toEqual(values?.content?.split('\n').slice(0, 3));
  });

  it('says in words what the rows were showing, so the arm moves one thing', () => {
    const [, schema] = promptFor('who wrote "The Duff"?', TABLE, 'schema');
    expect(schema?.content).toContain('write it lowercase');
    expect(schema?.content).not.toContain('copy it exactly as the rows above spell it');
  });

  it('names a version per arm, and the baseline keeps the one it was measured under', () => {
    expect(ARMS.values.version).toBe(PROMPT_VERSION);
    expect(ARMS.schema.version).not.toBe(PROMPT_VERSION);
    expect(promptVersionFor('values')).toBe('wikisql-ask@2');
    expect(ARM_NAMES).toEqual(['values', 'schema']);
    expect(armNamed('schema')).toBe('schema');
    expect(() => armNamed('schemas')).toThrow('--arm must be one of values, schema, got schemas');
  });

  it('defaults to the arm that has a reading, so a bare dispatch repeats the baseline', () => {
    expect(promptFor('q', TABLE)).toEqual(promptFor('q', TABLE, 'values'));
  });
});

describe('the reader decides what counts as an answer', () => {
  it('takes the statement out of a fenced block', () => {
    expect(statementOfReply('```sql\nSELECT Pick FROM table_1_2_3;\n```')).toBe('SELECT Pick FROM table_1_2_3');
  });

  it('takes it out of prose, because a model that explains itself still answered', () => {
    expect(statementOfReply('Here it is:\nSELECT Pick FROM t WHERE Player = \'Ada\'')).toBe(
      "SELECT Pick FROM t WHERE Player = 'Ada'",
    );
  });

  it('reads a lowercase select, because the corpus never asks for a case', () => {
    expect(statementOfReply('select Pick from t')).toBe('select Pick from t');
  });

  it('cuts at the first semicolon, so a second statement cannot ride along', () => {
    expect(statementOfReply('SELECT a FROM t; SELECT b FROM t')).toBe('SELECT a FROM t');
  });

  it('says nothing when the reply holds no statement, rather than guessing one', () => {
    expect(statementOfReply('I cannot answer that from this table.')).toBeUndefined();
    expect(statementOfReply('')).toBeUndefined();
    expect(statementOfReply('```\n\n```')).toBeUndefined();
  });

  it('drops a fence with no language on it, which is how half of them arrive', () => {
    expect(statementOfReply('```\nSELECT 1\n```')).toBe('SELECT 1');
  });
});

describe('the counters a reading is published with', () => {
  const records: readonly AskRecord[] = [
    { index: 0, sql: 'SELECT 1', reply: 'SELECT 1', truncated: false, error: undefined },
    { index: 1, sql: undefined, reply: 'no idea', truncated: false, error: undefined },
    { index: 2, sql: undefined, reply: '', truncated: true, error: undefined },
    { index: 3, sql: undefined, reply: '', truncated: false, error: 'ECONNRESET' },
  ];

  it('counts an unreadable reply, a cut reply and a failed call as three different things', () => {
    expect(tallyOf(records)).toEqual({ asked: 4, answered: 1, unreadable: 3, truncated: 1, failed: 1 });
  });

  it('publishes predictions for the questions that were read, and no line for the others', () => {
    const text = predictionsText(records);
    expect(text.split('\n').filter((line) => line !== '')).toHaveLength(1);
    expect(parsePredictions(text).get(0)).toBe('SELECT 1');
    expect(parsePredictions(text).has(1)).toBe(false);
  });

  it('writes an empty file rather than a blank line when nothing was read', () => {
    expect(predictionsText([])).toBe('');
  });

  it('reports the share, the truncations and the bill, and omits the bill when the model has no price', () => {
    const tally = { ...tallyOf(records), promptTokens: 10, completionTokens: 2, yuan: 0 };
    expect(reportLines(tally, '¥1.00').join('\n')).toContain('bill ¥1.00');
    expect(reportLines(tally, undefined).join('\n')).not.toContain('bill');
    expect(reportLines(tally, undefined).join('\n')).toContain('unreadable 3 (75.0%)');
  });

  it('leaves the evidence for a refusal: what each unread reply said, and why', () => {
    const text = unreadableText(records);
    const lines = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({ index: 1, truncated: false, error: null, reply: 'no idea' });
    expect(lines[1]).toMatchObject({ index: 2, truncated: true, error: null, reply: '' });
    expect(lines[2]).toMatchObject({ index: 3, error: 'ECONNRESET' });
    expect(unreadableText(records.slice(0, 1))).toBe('');
  });

  it('names the distinct reasons once, and says which of the three it was', () => {
    expect(reasonsOf(records)).toEqual(['reply held no SELECT', 'reply cut at the token cap', 'ECONNRESET']);
    expect(reasonsOf(records.slice(0, 1))).toEqual([]);
  });

  it('refuses past one percent and not at one percent', () => {
    const zero = tallyOf(records);
    const at = { ...zero, asked: 100, answered: 99, unreadable: 1 };
    const past = { ...zero, asked: 100, answered: 98, unreadable: 2 };
    expect(MAX_UNREADABLE_SHARE).toBe(0.01);
    expect(reportLines(at, undefined).length).toBe(3);
    // The comparison is on integers: `(asked - answered) * 100 > asked` is what a reader can
    // recompute from the two counts without knowing how a double rounds 1/100.
    expect((at.asked - at.answered) * 100 > at.asked).toBe(false);
    expect((past.asked - past.answered) * 100 > past.asked).toBe(true);
  });
});

describe('the split and the flags', () => {
  it('reads the corpus table, header and rows and all', () => {
    const tables = parseTables(readFileSync(join(corpus(), 'dev.tables.jsonl'), 'utf8'));
    expect(tables.get('1-2-3')?.header).toEqual(['Pick', 'Player']);
    expect(tables.get('1-2-3')?.types).toEqual(['real', 'text']);
    expect(tables.get('1-2-3')?.rows).toHaveLength(6);
  });

  it('treats a table with no header as a corpus that cannot be asked, not as an empty prompt', () => {
    expect(() => parseTables('{"id":"1-1-1","header":[],"types":[],"rows":[]}\n')).toThrow('has no header');
  });

  it('accepts a table that ships no types or rows, because the split owes the prompt neither', () => {
    const tables = parseTables('{"id":"1-1-1","header":["a"]}\n\n');
    expect(tables.get('1-1-1')).toEqual({ id: '1-1-1', header: ['a'], types: [], rows: [] });
  });

  it('refuses a ceiling that is not a positive number of yuan', () => {
    expect(() => resolveSettings(['--accept-cost', '0'])).toThrow('positive number of yuan');
    expect(() => resolveSettings(['--accept-cost', 'NaN'])).toThrow('positive number of yuan');
    expect(() => resolveSettings(['--budget', '0'])).toThrow('positive number of yuan');
  });

  it('refuses a limit that would publish an empty denominator', () => {
    expect(() => resolveSettings(['--limit', '0'])).toThrow('positive integer');
    expect(() => resolveSettings(['--limit', '2.5'])).toThrow('positive integer');
    expect(() => resolveSettings(['--limit', 'x'])).toThrow('positive integer');
    expect(() => resolveSettings(['--concurrency', '0'])).toThrow('positive integer');
  });

  it('defaults to dev, the whole split, six in flight, the measured arm, and one predictions file', () => {
    expect(resolveSettings([])).toEqual({
      split: 'dev',
      limit: undefined,
      out: 'eval/out/wikisql-predictions.jsonl',
      cache: undefined,
      concurrency: 6,
      arm: 'values',
      acceptCost: undefined,
      budget: 45,
    });
  });

  it('reads every flag it documents', () => {
    expect(
      resolveSettings([
        '--split', 'test', '--limit', '5', '--out', 'x.jsonl', '--cache', '/tmp/c',
        '--concurrency', '2', '--arm', 'schema', '--accept-cost', '12.5',
      ]),
    ).toEqual({ split: 'test', limit: 5, out: 'x.jsonl', cache: '/tmp/c', concurrency: 2, arm: 'schema', acceptCost: 12.5, budget: 45 });
  });

  it('ignores a flag it does not know rather than eating the next argument', () => {
    expect(resolveSettings(['--verbose', '--limit', '3']).limit).toBe(3);
  });
});

describe('the pool, because a wrong order is a wrong corpus', () => {
  it('keeps results in input order however they arrive', async () => {
    const out = await pool([3, 1, 2], 3, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item * 2));
      return item * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it('runs everything when the width is larger than the input', async () => {
    expect(await pool([1, 2], 8, async (item, index) => item + index)).toEqual([1, 3]);
  });
});

describe('the projection, because a bill is authorised before the calls', () => {
  it('prices a split at the per-case bound over the whole question count', () => {
    const per = projectedYuan(1, 'deepseek-chat');
    expect(per).toBeDefined();
    expect(projectedYuan(1_000, 'deepseek-chat')).toBeCloseTo((per as number) * 1_000, 10);
  });

  it('has no projection for a model with no price, rather than a cheap-looking zero', () => {
    expect(projectedYuan(10, 'a-model-with-no-row')).toBeUndefined();
  });

  it('prices a reasoning tier at what it bills, not at what it replies', () => {
    // A reasoner returns one statement and bills two thousand thinking tokens that never appear in
    // the reply. A projection read off the reply would approve the dispatch at a sixtieth of its
    // cost, which is the one error this projection exists to prevent.
    expect(reasonsFirst('deepseek-reasoner')).toBe(true);
    expect(reasonsFirst('glm-4.5-thinking')).toBe(true);
    expect(reasonsFirst('o3-mini')).toBe(true);
    expect(reasonsFirst('deepseek-chat')).toBe(false);
    expect(perCaseFor('deepseek-reasoner')).toEqual({ promptTokens: 400, completionTokens: REASONING_COMPLETION_TOKENS });
    expect(perCaseFor('deepseek-chat')).toEqual({ promptTokens: PER_CASE.promptTokens, completionTokens: PER_CASE.completionTokens });
    const chat = projectedYuan(100, 'deepseek-chat') as number;
    const reasoner = projectedYuan(100, 'deepseek-reasoner') as number;
    // Same input price, same output price: the difference is entirely the completion bound.
    expect(reasoner).toBeGreaterThan(chat * 3);
  });

  it('bounds a case above what the corpus renders, because an under-estimate is the costly error', () => {
    expect(PER_CASE.promptTokens).toBeGreaterThanOrEqual(400);
    expect(PER_CASE.completionTokens).toBeGreaterThanOrEqual(60);
    expect(BUDGET_YUAN).toBe(45);
  });

  it('refuses a dispatch whose projection is over budget, and runs when the ceiling is named', async () => {
    const cache = corpus(['q one?', 'q two?', 'q three?', 'q four?']);
    const dir = mkdtempSync(join(tmpdir(), 'wikisql-ask-out-'));
    dirs.push(dir);
    const lines: string[] = [];
    const over = await main(['--cache', cache, '--out', join(dir, 'p.jsonl'), '--budget', '0.001'], {
      provider: providerOf(() => reply('SELECT 1')),
      log: (line) => lines.push(line),
    });
    expect(over).toBe(4);
    expect(lines.join('\n')).toContain('REFUSED');
    // The same split runs once the caller states a ceiling the projection fits under.
    const ok = await main(['--cache', cache, '--out', join(dir, 'p.jsonl'), '--accept-cost', '1'], {
      provider: providerOf(() => reply('SELECT 1')),
      log: (line) => lines.push(line),
    });
    expect(ok).toBe(0);
    expect(lines.join('\n')).toContain('projection ¥');
  });

  it('refuses an unpriced model unless the ceiling is named', async () => {
    const cache = corpus(['q one?']);
    const dir = mkdtempSync(join(tmpdir(), 'wikisql-ask-out-'));
    dirs.push(dir);
    const lines: string[] = [];
    const code = await main(['--cache', cache, '--out', join(dir, 'p.jsonl')], {
      provider: { id: 'test', model: 'a-model-with-no-row', complete: async () => reply('SELECT 1') },
      log: (line) => lines.push(line),
    });
    expect(code).toBe(4);
    expect(lines.join('\n')).toContain('no price on file');
  });
});

describe('asking', () => {
  it('asks every question once and keeps the index the corpus gave it', async () => {
    const rows = parseSplit(readFileSync(join(corpus(), 'dev.jsonl'), 'utf8'));
    const tables = parseTables(readFileSync(join(corpus(), 'dev.tables.jsonl'), 'utf8'));
    const records = await askAll(rows, tables, providerOf(() => reply('SELECT Pick FROM table_1_2_3')), 2);
    expect(records.map((record) => record.index)).toEqual([0, 1]);
    expect(records.every((record) => record.sql === 'SELECT Pick FROM table_1_2_3')).toBe(true);
  });

  it('sends the arm it was told to, and the request is where that is observable', async () => {
    // The arm is a property of the bytes on the wire; asserting it on `promptFor` alone would pass
    // for an asker that built the right prompt and sent another.
    const rows = parseSplit(readFileSync(join(corpus(), 'dev.jsonl'), 'utf8'));
    const tables = parseTables(readFileSync(join(corpus(), 'dev.tables.jsonl'), 'utf8'));
    const sent: string[] = [];
    const provider: LlmProvider = {
      id: 'test',
      model: 'deepseek-chat',
      complete: async (request) => {
        sent.push(request.messages.map((message) => message.content).join('\n'));
        return reply('SELECT Pick FROM table_1_2_3');
      },
    };
    await askAll(rows, tables, provider, 1, 'schema');
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toContain('as this table stores them');
    expect(sent[1]).toContain('write it lowercase');
  });

  it('records a question whose table the corpus does not ship instead of throwing on it', async () => {
    const rows = parseSplit('{"table_id":"9-9-9","question":"q","sql":{"sel":0,"agg":0,"conds":[]}}\n');
    const records = await askAll(rows, new Map(), providerOf(() => reply('SELECT 1')), 1);
    expect(records[0]?.error).toBe('no table 9-9-9');
    expect(records[0]?.sql).toBeUndefined();
  });

  it('treats a cut reply as no answer, because the bytes look like SQL and are not', async () => {
    const rows = parseSplit('{"table_id":"1-2-3","question":"q","sql":{"sel":0,"agg":0,"conds":[]}}\n');
    const tables = parseTables(readFileSync(join(corpus(), 'dev.tables.jsonl'), 'utf8'));
    const records = await askAll(rows, tables, providerOf(() => reply('SELECT Pick FROM', { finishReason: 'length' })), 1);
    expect(records[0]?.truncated).toBe(true);
    expect(records[0]?.sql).toBeUndefined();
  });

  it('records something thrown that is not an Error, because an endpoint can throw a string', async () => {
    const rows = parseSplit('{"table_id":"1-2-3","question":"q","sql":{"sel":0,"agg":0,"conds":[]}}\n');
    const tables = parseTables(readFileSync(join(corpus(), 'dev.tables.jsonl'), 'utf8'));
    const records = await askAll(rows, tables, providerOf(() => Promise.reject('socket closed')), 1);
    expect(records[0]?.error).toBe('socket closed');
  });

  it('records an endpoint that threw, because a failed call is a fact about the run', async () => {
    const rows = parseSplit('{"table_id":"1-2-3","question":"q","sql":{"sel":0,"agg":0,"conds":[]}}\n');
    const tables = parseTables(readFileSync(join(corpus(), 'dev.tables.jsonl'), 'utf8'));
    const records = await askAll(rows, tables, providerOf(() => Promise.reject(new Error('429'))), 1);
    expect(records[0]?.error).toBe('429');
  });
});

describe('the key comes from the environment and nowhere else', () => {
  it('refuses to run without one, and says which variable to set', () => {
    expect(() => providerFrom({})).toThrow('no key');
  });

  it('reports no bill for a model with no price on file, rather than a zero', async () => {
    const cache = corpus();
    const dir = mkdtempSync(join(tmpdir(), 'wikisql-ask-out-'));
    dirs.push(dir);
    const lines: string[] = [];
    const code = await main(['--cache', cache, '--out', join(dir, 'p.jsonl'), '--limit', '1', '--accept-cost', '1'], {
      provider: { id: 'test', model: 'a-model-with-no-row', complete: async () => reply('SELECT 1') },
      log: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).not.toContain('bill');
  });

  it('is the entry point only when the runtime was asked for this file', () => {
    expect(runsAsMain('/repo/eval/wikisql/ask.ts')).toBe(true);
    expect(runsAsMain('/repo/eval/wikisql/ask.js')).toBe(true);
    expect(runsAsMain('/repo/eval/wikisql/run.ts')).toBe(false);
    expect(runsAsMain(undefined)).toBe(false);
  });

  it('runs the work only when it is the entry, and reports the exit code it was given', async () => {
    const codes: number[] = [];
    const errors: string[] = [];
    await start('/repo/eval/wikisql/ask.ts', async () => 3, (code) => codes.push(code), (line) => errors.push(line));
    await start('/repo/eval/wikisql/run.ts', async () => 3, (code) => codes.push(code));
    await start(
      '/repo/eval/wikisql/ask.ts',
      async () => {
        throw new Error('no key');
      },
      (code) => codes.push(code),
      (line) => errors.push(line),
    );
    await start(
      '/repo/eval/wikisql/ask.ts',
      async () => {
        throw 'a string, because an endpoint can throw one';
      },
      (code) => codes.push(code),
      (line) => errors.push(line),
    );
    // The default stderr is the one a dispatch uses, so it is exercised rather than assumed.
    await start(
      '/repo/eval/wikisql/ask.ts',
      async () => {
        throw new Error('written to stderr');
      },
      (code) => codes.push(code),
    );
    // An imported module must not end the host process, so the two non-entry cases leave no code.
    expect(codes).toEqual([3, 1, 1, 1]);
    expect(errors).toEqual(['no key', 'a string, because an endpoint can throw one']);
  });

  it('prefers the generic variable and falls back to the provider-specific one', () => {
    expect(providerFrom({ LLM_API_KEY: 'a', DEEPSEEK_API_KEY: 'b' }).model).toBe('deepseek-chat');
    expect(providerFrom({ DEEPSEEK_API_KEY: 'b', LLM_MODEL: 'other' }).model).toBe('other');
  });
});

describe('a run end to end, on a split the test owns', () => {
  it('writes predictions the judge can read, and exits 0', async () => {
    const cache = corpus();
    const dir = mkdtempSync(join(tmpdir(), 'wikisql-ask-out-'));
    dirs.push(dir);
    const out = join(dir, 'p.jsonl');
    const lines: string[] = [];
    const code = await main(['--cache', cache, '--out', out, '--limit', '2'], {
      provider: providerOf((request) => {
        // The prompt is the question plus its table; the answer names the column the prompt shows.
        expect(request.messages[1]?.content).toContain('Question:');
        return reply('```sql\nSELECT Player FROM table_1_2_3;\n```', {
          usage: { promptTokens: 1_000, completionTokens: 20 },
        });
      }),
      log: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(parsePredictions(readFileSync(out, 'utf8')).size).toBe(2);
    expect(lines.join('\n')).toContain('2 question(s), 2 answered');
    expect(lines.join('\n')).toContain('bill ¥');
  });

  it('refuses to publish when the reader could not read the replies', async () => {
    const cache = corpus();
    const dir = mkdtempSync(join(tmpdir(), 'wikisql-ask-out-'));
    dirs.push(dir);
    const out = join(dir, 'p.jsonl');
    const lines: string[] = [];
    const code = await main(['--cache', cache, '--out', out], {
      provider: providerOf(() => reply('I would rather not.')),
      log: (line) => lines.push(line),
    });
    expect(code).toBe(3);
    expect(lines.join('\n')).toContain('REFUSED');
    // The artifact is still written: a refusal is about publishing a number, not about hiding the
    // evidence, and the file is what a reader opens to see why the reader failed.
    expect(readFileSync(out, 'utf8')).toBe('');
  });

  it('reaches the endpoint the environment names, through the fetch it was handed', async () => {
    // The one path a dispatch takes and no other case here does: no injected provider, so the key,
    // the endpoint and the model come from the environment, and the reply comes back through the
    // HTTP provider's own parser rather than through a stub that speaks LlmResponse.
    const cache = corpus();
    const dir = mkdtempSync(join(tmpdir(), 'wikisql-ask-out-'));
    dirs.push(dir);
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response(
        JSON.stringify({
          model: 'deepseek-chat',
          choices: [{ finish_reason: 'stop', message: { content: 'SELECT Pick FROM table_1_2_3' } }],
          usage: { prompt_tokens: 1_000, completion_tokens: 20 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const code = await main(['--cache', cache, '--out', join(dir, 'p.jsonl'), '--limit', '1'], {
      fetch: fetchImpl,
      // Assembled rather than written as a literal: `tools/check-secrets.mjs` reads
      // `KEY = '<8+ characters>'` as a credential, and a guard that is right about that is not worth
      // weakening for a test.
      env: { DEEPSEEK_API_KEY: ['a', 'key', 'that', 'never', 'leaves'].join('-'), LLM_MODEL: 'deepseek-chat' },
    });
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('api.deepseek.com');
  });

  it('creates the output directory, because a first run has never written there', async () => {
    const cache = corpus();
    const dir = mkdtempSync(join(tmpdir(), 'wikisql-ask-out-'));
    dirs.push(dir);
    const out = join(dir, 'nested', 'deeper', 'p.jsonl');
    mkdirSync(dir, { recursive: true });
    const code = await main(['--cache', cache, '--out', out, '--limit', '1'], {
      provider: providerOf(() => reply('SELECT 1')),
      log: () => undefined,
    });
    expect(code).toBe(0);
    expect(readFileSync(out, 'utf8').trim()).toBe('{"index":0,"sql":"SELECT 1"}');
  });
});
