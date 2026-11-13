import { describe, expect, it } from 'vitest';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';
import { buildAskMessages, buildSqlPrompt, choosePromptProfile, createPipeline, extractSql } from '../src/pipeline.js';
import { linkSchema, renderName, renderSchemaCard, tokenizeQuestion } from '../src/linking.js';
import type { SchemaTable } from '../src/linking.js';
import { createReplayProvider, recordProvider } from '../src/replay.js';
import type { LlmProvider } from '../src/provider.js';
import type { RecordedCall } from '../src/replay.js';

const schema: SchemaTable[] = [
  {
    table: 'orders',
    columns: [
      { name: 'order_id', type: 'BIGINT' },
      { name: 'region', type: 'VARCHAR', samples: ['north', 'south'], aliases: ['area', 'territory'] },
      { name: 'revenue', type: 'DECIMAL', aliases: ['sales', 'amount'] },
      { name: 'order_date', type: 'DATE' },
    ],
  },
  { table: 'customers', columns: [{ name: 'customer_id', type: 'BIGINT' }, { name: 'segment', type: 'VARCHAR' }] },
];

describe('question tokenization', () => {
  it('drops stopwords and splits snake and camel case', () => {
    expect(tokenizeQuestion('Show the revenue by order_date for North')).toEqual(['revenue', 'order', 'date', 'north']);
    expect(tokenizeQuestion('orderId by customerSegment')).toEqual(['order', 'id', 'customer', 'segment']);
  });

  it('returns nothing for a pure stopword question', () => {
    expect(tokenizeQuestion('what is the')).toEqual([]);
  });
});

describe('the hint that travels with the question', () => {
  it('says which columns the linker chose, in the user turn', () => {
    const built = buildAskMessages({ question: 'revenue by region', schema, linking: true });
    expect(built.messages[1]?.content.startsWith('Likely columns: ')).toBe(true);
    expect(built.messages[1]?.content).toContain('orders.revenue');
    expect(built.messages[1]?.content.endsWith('revenue by region')).toBe(true);
  });

  it('says so when nothing matched, rather than sending an empty hint', () => {
    const built = buildAskMessages({ question: 'how many customers are there', schema, linking: true });
    expect(built.messages[1]?.content).toBe('No column matched; use the schema above.\nhow many customers are there');
  });

  it('lets a caller turn on a recaller the default set does not use', () => {
    const built = buildAskMessages({
      question: 'how many customers are there',
      schema,
      linking: true,
      recallers: ['name', 'table'],
    });
    expect(built.messages[1]?.content).toContain('customers.customer_id');
  });

  it('leaves the hint alone when linking is off', () => {
    const built = buildAskMessages({ question: 'revenue by region', schema, linking: false });
    expect(built.messages[1]?.content).toBe('Use the schema above.\nrevenue by region');
  });
});

describe('the hint when the linker is allowed to read the evidence', () => {
  const HINTLESS_QUESTION = 'what did they buy last year';

  it('names a column the question never mentions and the evidence does', () => {
    // The question says "they"; the evidence says "each customer segment". A hint built from the
    // question alone has nothing to rank, and the model is left to find `segment` in a card of six
    // columns — which on BIRD is a card of two hundred.
    const built = buildAskMessages({
      question: HINTLESS_QUESTION,
      schema,
      linking: true,
      linkEvidence: true,
      prompt: { dialect: 'SQLite', evidence: 'Consider the segment of each customer.' },
    });
    expect(built.messages[1]?.content).toContain('customers.segment');
    expect(built.messages[1]?.content.endsWith(HINTLESS_QUESTION)).toBe(true);
  });

  it('falls back to the question alone when the arm carries no evidence', () => {
    // An arm that sets the switch on a pipeline with no evidence must send what every other arm
    // sends: the switch says where to look, and there is nowhere else to look.
    const withSwitch = buildAskMessages({ question: 'revenue by region', schema, linking: true, linkEvidence: true });
    const without = buildAskMessages({ question: 'revenue by region', schema, linking: true });
    expect(withSwitch.messages[1]?.content).toBe(without.messages[1]?.content);
  });

  it('falls back when the evidence is present but empty', () => {
    // `evidence: '   '` is the shape a caller writes when the dataset has a field but no content.
    // Joining it would add a separator and nothing else, and a hint that differs by a space is a
    // second prompt with no second lever.
    const built = buildAskMessages({
      question: 'revenue by region',
      schema,
      linking: true,
      linkEvidence: true,
      prompt: { dialect: 'SQLite', evidence: '   ' },
    });
    expect(built.messages[1]?.content.startsWith('Likely columns: ')).toBe(true);
    expect(built.messages[1]?.content).not.toContain('  ');
  });

  it('does not read the evidence unless the arm asked for it', () => {
    // The default is the prompt every measured arm has sent. A linker that started reading the
    // evidence because it was in the prompt would change all of them at once, and each published
    // reading would describe a prompt nobody had run.
    const built = buildAskMessages({
      question: HINTLESS_QUESTION,
      schema,
      linking: true,
      prompt: { dialect: 'SQLite', evidence: 'Consider the segment of each customer.' },
    });
    expect(built.messages[1]?.content).toBe('No column matched; use the schema above.\nwhat did they buy last year');
  });

  it('sends no hint at all when linking is off, whatever the switch says', () => {
    const built = buildAskMessages({
      question: HINTLESS_QUESTION,
      schema,
      linking: false,
      linkEvidence: true,
      prompt: { dialect: 'SQLite', evidence: 'Consider the segment of each customer.' },
    });
    expect(built.messages[1]?.content).toBe('Use the schema above.\nwhat did they buy last year');
    expect(built.linked).toEqual([]);
  });
});

describe('schema linking', () => {
  it('ranks the measure and the dimension first', () => {
    const linked = linkSchema('revenue by region', schema);
    expect(linked.slice(0, 2).map((column) => column.column).sort()).toEqual(['region', 'revenue']);
  });

  it('uses aliases as a second recaller', () => {
    const linked = linkSchema('sales by territory', schema);
    const aliased = linked.filter((column) => column.recalledBy.includes('alias')).map((column) => column.column);
    expect(aliased.sort()).toEqual(['region', 'revenue']);
  });

  it('uses sample values as a third recaller', () => {
    const linked = linkSchema('north', schema);
    expect(linked[0]).toMatchObject({ table: 'orders', column: 'region', recalledBy: ['value'] });
  });

  it('scores a column matched by two recallers above one matched by one', () => {
    const linked = linkSchema('revenue sales', schema);
    const revenue = linked.find((column) => column.column === 'revenue');
    expect([...(revenue?.recalledBy ?? [])].sort()).toEqual(['alias', 'name']);
  });

  it('returns nothing when no token matches or the question is empty', () => {
    expect(linkSchema('unrelated words entirely', schema)).toEqual([]);
    expect(linkSchema('', schema)).toEqual([]);
    expect(linkSchema('what is the', schema)).toEqual([]);
  });

  /**
   * The recaller that reads a table name.
   *
   * Every candidate is a column, and the name recaller split the *column* name into tokens,
   * so the table half of `customers.customer_id` was invisible. A question that names its
   * entity and none of its columns — "how many customers are there", which is how a third of
   * BIRD's questions are written — matched nothing at all and the linker returned an empty
   * list, on a schema where the answer is one table away.
   *
   * It is a separate recaller rather than a wider `name`, because a table name is weaker
   * evidence than a column name: it says which table, not which column. Folding it into
   * `name` would have changed the hint every measured arm sends, and those measurements
   * would no longer be about the prompt they were taken on.
   */
  it('finds the table a question names and no column of it', () => {
    const linked = linkSchema('how many customers are there', schema, 12, ['table']);
    expect(linked.map((column) => `${column.table}.${column.column}`)).toEqual(['customers.customer_id', 'customers.segment']);
    expect(linked.every((column) => column.recalledBy.includes('table'))).toBe(true);
  });

  it('reads a singular question against a plural table name', () => {
    expect(linkSchema('how many customer', schema, 12, ['table']).map((column) => column.table)).toEqual([
      'customers',
      'customers',
    ]);
  });

  it('ignores a token too short to be a table name', () => {
    // `orders` starts with `or`, and matching on two letters would make every table whose
    // name begins with a stopword look named.
    expect(linkSchema('or', schema, 12, ['table'])).toEqual([]);
  });

  it('stacks the table recaller with the column one', () => {
    // One column scored by two independent recallers outranks a column scored by one, which is
    // the property that lets a pruned card keep both the table a question names and the column
    // it measures.
    const both = linkSchema('customers revenue', schema, 12, ['name', 'table']);
    expect(both.find((column) => column.column === 'revenue')?.recalledBy).toEqual(['name']);
    expect(both.filter((column) => column.table === 'customers')).toHaveLength(2);
    expect(both.filter((column) => column.table === 'customers').every((column) => column.recalledBy.includes('table'))).toBe(
      true,
    );
  });

  it('leaves the default recallers alone', () => {
    // The hint every measured arm sends is built from the default list. Adding `table` to it
    // would silently re-open every accuracy number this project has, so the default stays and
    // the new recaller is opt-in.
    expect(linkSchema('how many customers are there', schema)).toEqual([]);
  });

  it('honours the top-k limit', () => {
    expect(linkSchema('revenue by region', schema, 1)).toHaveLength(1);
  });

  it('renders a schema card with an optional line limit', () => {
    const card = renderSchemaCard(schema);
    expect(card.split('\n')).toHaveLength(2);
    expect(card).toContain('orders(order_id BIGINT');
    expect(renderSchemaCard(schema, 1).split('\n')).toHaveLength(1);
  });

  it('renders column comments and keeps samples optional', () => {
    const annotated = [{ table: 'orders', columns: [{ name: 'amount', type: 'DECIMAL', comment: 'order total', samples: ['1.00'] }] }];
    expect(renderSchemaCard(annotated)).toBe('orders(amount DECIMAL -- order total)');
    expect(renderSchemaCard(annotated, 40, { samples: true })).toBe('orders(amount DECIMAL [1.00] -- order total)');
  });

  it('adds enum samples only when asked', () => {
    const plain = renderSchemaCard(schema);
    const sampled = renderSchemaCard(schema, 40, { samples: true });
    expect(plain).not.toContain('[north|south]');
    expect(sampled).toContain('[north|south]');
    expect(sampled).toContain('order_id BIGINT');
  });
});

describe('sql extraction', () => {
  it('unwraps a fenced block', () => {
    expect(extractSql('here you go\n```sql\nSELECT 1\n```\n')).toBe('SELECT 1');
  });

  it('accepts an unfenced answer and an sql prefix', () => {
    expect(extractSql('SELECT 1')).toBe('SELECT 1');
    expect(extractSql('SQL: SELECT 1')).toBe('SELECT 1');
  });
});

describe('replay provider', () => {
  it('returns the recorded response for a matching prompt', async () => {
    const provider = createReplayProvider([{ match: 'revenue by region', response: 'SELECT region, sum(revenue) FROM orders GROUP BY 1' }]);
    const response = await provider.complete({ messages: [{ role: 'user', content: 'revenue by region' }] });
    expect(response.text).toContain('SELECT region');
    expect(response.usage?.promptTokens).toBeGreaterThan(0);
  });

  it('fails loudly when no fixture matches', async () => {
    const provider = createReplayProvider([]);
    await expect(provider.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_LLM_UNAVAILABLE',
    );
  });

  it('records calls made through a live provider', async () => {
    const sink: RecordedCall[] = [];
    const inner = createReplayProvider([{ match: 'x', response: 'SELECT 1' }]);
    const wrapped = recordProvider(inner, sink);
    await wrapped.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(sink).toHaveLength(1);
    expect(wrapped.id).toBe(inner.id);
  });
});

describe('question to guarded sql', () => {
  it('returns the first safe candidate with its linked columns', async () => {
    const provider = createReplayProvider([
      { match: 'revenue by region', response: '```sql\nSELECT region, sum(revenue) AS total FROM orders GROUP BY 1\n```' },
    ]);
    const pipeline = createPipeline({ provider });
    const result = await pipeline.ask({ question: 'revenue by region', schema });
    expect(result.attempts).toBe(1);
    expect(result.sql).toBe('SELECT region, sum(revenue) AS total FROM orders GROUP BY 1');
    expect(result.linked.length).toBeGreaterThan(0);
  });

  it('repairs a rejected candidate instead of returning it', async () => {
    const provider = createReplayProvider([
      { match: 'That statement was rejected', response: 'SELECT region FROM orders' },
      { match: 'revenue by region', response: 'DROP TABLE orders' },
    ]);
    const pipeline = createPipeline({ provider });
    const result = await pipeline.ask({ question: 'revenue by region', schema });
    expect(result.attempts).toBe(2);
    expect(result.sql).toBe('SELECT region FROM orders');
  });

  it('gives up after the repair budget and reports why', async () => {
    const stubborn: LlmProvider = {
      id: 'stubborn',
      model: 'stubborn',
      complete: async () => ({ text: 'DELETE FROM orders', model: 'stubborn' }),
    };
    const pipeline = createPipeline({ provider: stubborn, maxRepairs: 1 });
    await expect(pipeline.ask({ question: 'revenue by region', schema })).rejects.toSatisfy(
      (error: unknown) =>
        isNl2ChartsError(error) &&
        error.code === 'NL2C_E_GUARD_REJECTED' &&
        error.details.attempts === 2 &&
        typeof error.details.lastError === 'string',
    );
  });

  it('repairs an execution failure and returns the working statement', async () => {
    let calls = 0;
    const provider = createReplayProvider([
      { match: 'That statement was rejected', response: 'SELECT region FROM orders' },
      { match: 'revenue by region', response: 'SELECT region FROM missing_table' },
    ]);
    const pipeline = createPipeline({
      provider,
      execute: async (sql) => {
        calls += 1;
        if (sql.includes('missing_table')) throw new Error('Binder Error: table missing_table does not exist');
      },
    });
    const result = await pipeline.ask({ question: 'revenue by region', schema });
    expect(result.attempts).toBe(2);
    expect(result.sql).toBe('SELECT region FROM orders');
    expect(calls).toBe(2);
  });

  it('reports an execution failure as an engine error when the budget runs out', async () => {
    const provider = createReplayProvider([{ match: 'revenue by region', response: 'SELECT * FROM missing' }]);
    const pipeline = createPipeline({
      provider,
      maxRepairs: 0,
      execute: async () => {
        throw new Error('Binder Error');
      },
    });
    await expect(pipeline.ask({ question: 'revenue by region', schema })).rejects.toSatisfy(
      (error: unknown) =>
        isNl2ChartsError(error) && error.code === 'NL2C_E_ENGINE_FAILED' && error.details.attempts === 1,
    );
  });

  it('builds a prompt that states the read-only rules and the schema', async () => {
    const seen: string[] = [];
    const capturing: LlmProvider = {
      id: 'capture',
      model: 'capture',
      complete: async (request) => {
        seen.push(request.messages.map((message) => message.content).join('\n'));
        return { text: 'SELECT 1', model: 'capture' };
      },
    };
    await createPipeline({ provider: capturing }).ask({ question: 'unmatched words', schema });
    expect(seen[0]).toContain('SELECT only');
    expect(seen[0]).toContain('orders(order_id BIGINT');
    expect(seen[0]).toContain('No column matched');
  });
});

describe('prompt composition', () => {
  const schema = [
    {
      table: 'orders',
      columns: [
        { name: 'region', type: 'VARCHAR', samples: ['north', 'south'] },
        { name: 'percent (%) eligible', type: 'DOUBLE' },
      ],
      foreignKeys: ['orders.id = lines.order_id'],
    },
  ];

  it('keeps the boolean third argument working (A2 compatibility)', () => {
    expect(buildSqlPrompt('q', schema, true)).toContain('[north|south]');
    expect(buildSqlPrompt('q', schema, false)).not.toContain('[north|south]');
  });

  it('states the dialect when one is given', () => {
    expect(buildSqlPrompt('q', schema, { dialect: 'SQLite' })).toContain('Write SQLite SQL.');
  });

  it('adds evidence only when it is not blank', () => {
    expect(buildSqlPrompt('q', schema, { evidence: '  revenue excludes tax  ' })).toContain('Evidence: revenue excludes tax');
    expect(buildSqlPrompt('q', schema, { evidence: '   ' })).not.toContain('Evidence:');
    expect(buildSqlPrompt('q', schema, {})).not.toContain('Evidence:');
  });

  it('renders join hints and quoted identifiers when asked', () => {
    const prompt = buildSqlPrompt('q', schema, { foreignKeys: true, descriptions: false });
    expect(prompt).toContain('join: orders.id = lines.order_id');
    expect(prompt).toContain('"percent (%) eligible" DOUBLE');
  });

  it('drops comments when descriptions are off', () => {
    const withComment = [{ table: 't', columns: [{ name: 'a', type: 'BIGINT', comment: 'meaning' }] }];
    expect(buildSqlPrompt('q', withComment, {})).toContain('-- meaning');
    expect(buildSqlPrompt('q', withComment, { descriptions: false })).not.toContain('-- meaning');
  });

  it('honours a schema line budget', () => {
    const many = [
      { table: 'a', columns: [{ name: 'x', type: 'BIGINT' }], foreignKeys: ['a.x = b.x'] },
      { table: 'b', columns: [{ name: 'x', type: 'BIGINT' }] },
    ];
    expect(buildSqlPrompt('q', many, { foreignKeys: true, schemaLines: 1 })).not.toContain('b(x BIGINT)');
  });

  it('places semantics before evidence so the meaning is read before the values', () => {
    const prompt = buildSqlPrompt('q', schema, { definitions: '- orders: one row per order.', evidence: 'Data profile:' });
    expect(prompt).toContain('Semantics:\n- orders: one row per order.');
    expect(prompt.indexOf('Semantics:')).toBeGreaterThan(prompt.indexOf('Schema:'));
    expect(prompt.indexOf('Semantics:')).toBeLessThan(prompt.indexOf('Evidence:'));
    expect(prompt.indexOf('Evidence:')).toBeLessThan(prompt.indexOf('Question: q'));
  });

  it('adds semantics only when it is not blank', () => {
    expect(buildSqlPrompt('q', schema, { definitions: '   ' })).not.toContain('Semantics:');
    expect(buildSqlPrompt('q', schema, {})).not.toContain('Semantics:');
  });

  it('puts stored rows first among the data blocks, under the schema they describe', () => {
    const prompt = buildSqlPrompt('q', schema, {
      rowSamples: 'orders: id | status\n1 | shipped',
      definitions: '- orders: one row per order.',
      evidence: 'Data profile:',
    });
    expect(prompt).toContain('Rows in this database:\norders: id | status\n1 | shipped');
    // After the schema: the rows are a property of the tables above them. Before the evidence: a
    // block of stored values that arrived after a hint would read as counter-evidence to it.
    expect(prompt.indexOf('Rows in this database:')).toBeGreaterThan(prompt.indexOf('Schema:'));
    expect(prompt.indexOf('Rows in this database:')).toBeLessThan(prompt.indexOf('Evidence:'));
  });

  it('prints no rows block when the caller rendered nothing', () => {
    // A caller whose tables held no textual column renders the empty string rather than omitting
    // the field, so the heading must be owned here: a heading with nothing under it would read as
    // a table that stores no rows.
    expect(buildSqlPrompt('q', schema, { rowSamples: '   ' })).not.toContain('Rows in this database:');
    expect(buildSqlPrompt('q', schema, {})).not.toContain('Rows in this database:');
  });
});

describe('schema card quoting', () => {
  it('leaves a plain identifier alone and quotes everything else', () => {
    expect(renderName('amount')).toBe('amount');
    expect(renderName('total amount')).toBe('"total amount"');
    expect(renderName('say "hi"')).toBe('"say ""hi"""');
    expect(renderName('1col')).toBe('"1col"');
  });

  it('breaks a score tie by table name so the order is stable', () => {
    // Two candidates, each recalled once at rank 1 by a different recaller, so
    // their fused scores are equal: only the tie-break decides the order.
    const tied = linkSchema('revenue', [
      { table: 'z', columns: [{ name: 'revenue', type: 'DOUBLE' }] },
      { table: 'a', columns: [{ name: 'other', type: 'DOUBLE', aliases: ['revenue'] }] },
    ]);
    expect(tied.map((column) => `${column.table}.${column.column}`)).toEqual(['a.other', 'z.revenue']);
    expect(tied[0]?.score).toBeCloseTo(tied[1]?.score ?? 0, 12);
  });
});

describe('pipeline error mapping', () => {
  it('stringifies a non-Error thrown by the execute hook', async () => {
    const provider = createReplayProvider([{ match: 'revenue by region', response: 'SELECT * FROM orders' }]);
    const pipeline = createPipeline({
      provider,
      maxRepairs: 0,
      execute: async () => {
        throw 'Binder Error: unknown table';
      },
    });
    await expect(pipeline.ask({ question: 'revenue by region', schema })).rejects.toSatisfy(
      (error: unknown) =>
        isNl2ChartsError(error) && error.code === 'NL2C_E_ENGINE_FAILED' && String(error.details.lastError).includes('Binder Error'),
    );
  });
});

describe('schema-linking switch', () => {
  it('can be turned off, which also removes the hint from the user turn', async () => {
    const seen: string[] = [];
    const provider: LlmProvider = {
      id: 'capture',
      model: 'capture',
      complete: async (request) => {
        seen.push(request.messages.map((message) => message.content).join('\n---\n'));
        return { text: 'SELECT 1', model: 'capture' };
      },
    };
    const withLinking = createPipeline({ provider });
    await withLinking.ask({ question: 'revenue by region', schema });
    const withoutLinking = createPipeline({ provider, linking: false });
    const result = await withoutLinking.ask({ question: 'revenue by region', schema });
    expect(result.linked).toEqual([]);
    expect(seen[1]).not.toContain('Likely columns');
    expect(seen[1]).toContain('Use the schema above.');
    expect(seen[0]).toContain('Likely columns');
  });
});

describe('prompt profiles', () => {
  it('drops descriptions for a window question and adds window rules', () => {
    const profile = choosePromptProfile('Rank the drivers by points; ties share a rank.');
    expect(profile.descriptions).toBe(false);
    expect(profile.foreignKeys).toBe(false);
    expect(profile.notes.join(' ')).toContain('RANK');
  });

  it('drops descriptions for a ratio question and adds denominator rules', () => {
    const profile = choosePromptProfile('What fraction of heroes are taller than 180 cm?');
    expect(profile.descriptions).toBe(false);
    expect(profile.notes.join(' ')).toContain('NULLIF');
  });

  it('keeps metadata for a filter-and-aggregate question', () => {
    const profile = choosePromptProfile('How many orders were placed in the north region in 2024?');
    expect(profile.descriptions).toBe(true);
    expect(profile.foreignKeys).toBe(true);
    expect(profile.notes).toEqual([]);
  });

  it('is case insensitive and matches whole words only', () => {
    expect(choosePromptProfile('RANKING of drivers').descriptions).toBe(false);
    expect(choosePromptProfile('the shareholder name').descriptions).toBe(true);
    expect(choosePromptProfile('the ranking_notes column').descriptions).toBe(true);
  });

  it('renders profile notes as rules and keeps the schema compact', () => {
    const profile = choosePromptProfile('Rank publishers by hero count');
    const prompt = buildSqlPrompt('Rank publishers by hero count', [{ table: 'p', columns: [{ name: 'n', type: 'BIGINT', comment: 'meaning' }] }], {
      dialect: 'SQLite',
      ...profile,
    });
    expect(prompt).toContain('RANK');
    expect(prompt).not.toContain('-- meaning');
  });
});

describe('demonstrations from another schema', () => {
  const tiny: SchemaTable[] = [{ table: 'orders', columns: [{ name: 'id', type: 'INTEGER' }] }];

  it('renders the block above the question, under a heading that names the risk', () => {
    const prompt = buildSqlPrompt('How many orders?', tiny, {
      demonstrations: 'Question: How many rows?\nSQL: SELECT COUNT(*) FROM t',
    });
    expect(prompt).toContain('Examples from other databases');
    expect(prompt).toContain('SELECT COUNT(*) FROM t');
    expect(prompt.indexOf('Examples from other databases')).toBeLessThan(prompt.indexOf('Question: How many orders?'));
  });

  it('leaves no heading behind for an empty block', () => {
    // A heading over nothing invites the model to fill the gap.
    expect(buildSqlPrompt('q', tiny, { demonstrations: '   ' })).not.toContain('Examples from other databases');
  });

  it('keeps the examples below the schema, so the schema is read first', () => {
    const prompt = buildSqlPrompt('q', tiny, { demonstrations: 'Question: x\nSQL: SELECT 1' });
    expect(prompt.indexOf('Schema:')).toBeLessThan(prompt.indexOf('Examples from other databases'));
  });
});

describe('what a repair turn is told', () => {
  const tables: SchemaTable[] = [
    {
      table: 'students',
      columns: [
        { name: 'StudentID', type: 'INTEGER' },
        { name: 'StudentName', type: 'TEXT' },
      ],
    },
  ];

  /** Answers with the same statement, and records every message it was sent. */
  function fixed(sql: string): { provider: LlmProvider; seen: string[][] } {
    const seen: string[][] = [];
    return {
      seen,
      provider: {
        id: 'fixed',
        model: 'fixed',
        complete: async (request) => {
          seen.push(request.messages.map((message) => `${message.role}:${message.content}`));
          return { text: sql, model: 'fixed' };
        },
      },
    };
  }

  it('names the column that does not exist and the one that does', async () => {
    const { provider, seen } = fixed('SELECT StudentName FROM students WHERE StudentNickname = "x"');
    const pipeline = createPipeline({
      provider,
      maxRepairs: 1,
      prompt: { dialect: 'SQLite' },
      execute: async () => {
        throw new Error('no such column: StudentNickname');
      },
    });
    await expect(pipeline.ask({ question: 'students', schema: tables })).rejects.toBeDefined();

    const repairTurn = seen[1]?.at(-1) ?? '';
    expect(repairTurn).toContain('StudentNickname');
    // The old message was one sentence with the error pasted into it. The point of
    // this test is that the turn now contains something to act on: the engine's own
    // sentence and the column that exists.
    expect(repairTurn).toContain('no such column: StudentNickname');
    // Scoped by the statement's own FROM clause: the bare list under a table name is
    // what a person would say, and it is checkable against the schema above.
    expect(repairTurn).toContain('`students` has: StudentID, StudentName');
    expect(repairTurn).not.toContain('Return one SELECT statement only.');
  });

  it('records the class of every rejected attempt', async () => {
    // `DELETETE` is a misspelling, so the reply opens with a word the policy does not name as SQL
    // and is classified as prose rather than as an unsafe statement. That is a deliberate trade and
    // the class now says `shape`: the observed population of unreadable replies is prose (nine rows
    // across 7,440 case-scored rows in two artifacts), the theoretical one is a misspelled head
    // (none), and a model told "that reply contained no statement" writes one, while a model told
    // "your statement was unsafe" about prose spends the turn on a defect it does not have. The
    // statement itself is still carried on the failure, so the write attempt stays visible in the
    // artifact — only the sentence the model is given changed.
    const { provider } = fixed('DELETETE FROM students');
    const pipeline = createPipeline({ provider, maxRepairs: 2, prompt: { dialect: 'SQLite' } });
    const error = await pipeline.ask({ question: 'students', schema: tables }).catch((reason: unknown) => reason);
    const details = (error as { details: { failureClasses: string[]; lastSql: string } }).details;
    expect(details.failureClasses).toEqual(['shape', 'shape', 'shape']);
    expect(details.lastSql).toBe('DELETETE FROM students');
  });

  it('still calls a real write attempt what it is', async () => {
    // The other side of that trade, pinned: a head the policy does name is refused as a guard
    // rejection, because the reply *is* a statement and the refusal *is* about safety.
    const { provider } = fixed('DELETE FROM students');
    const pipeline = createPipeline({ provider, maxRepairs: 1, prompt: { dialect: 'SQLite' } });
    const error = await pipeline.ask({ question: 'students', schema: tables }).catch((reason: unknown) => reason);
    expect((error as { details: { failureClasses: string[] } }).details.failureClasses).toEqual(['guard', 'guard']);
  });

  it('spends three repairs by default, so four attempts in total', async () => {
    const { provider, seen } = fixed('DELETE FROM students');
    const pipeline = createPipeline({ provider, prompt: { dialect: 'SQLite' } });
    const error = await pipeline.ask({ question: 'students', schema: tables }).catch((reason: unknown) => reason);
    expect((error as { details: { attempts: number } }).details.attempts).toBe(4);
    // One first attempt plus three repair turns, each of which was sent to the model.
    expect(seen).toHaveLength(4);
  });

  it('honours a caller who asks for fewer', async () => {
    const { provider, seen } = fixed('DELETE FROM students');
    const pipeline = createPipeline({ provider, maxRepairs: 1 });
    await pipeline.ask({ question: 'students', schema: tables }).catch(() => undefined);
    expect(seen).toHaveLength(2);
  });

  it('reports the diagnosis of the statement it gave up on, not just the count', async () => {
    const { provider } = fixed('SELECT Nickname FROM students');
    const pipeline = createPipeline({
      provider,
      maxRepairs: 0,
      prompt: { dialect: 'SQLite' },
      execute: async () => {
        throw new Error('no such column: Nickname');
      },
    });
    const error = (await pipeline.ask({ question: 'students', schema: tables }).catch((reason: unknown) => reason)) as {
      details: { diagnoses: string[]; lastSql: string };
    };
    expect(error.details.lastSql).toContain('Nickname');
    expect(error.details.diagnoses[0]).toContain('no such column: Nickname');
  });
});
