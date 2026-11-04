import { describe, expect, it } from 'vitest';
import { INTENT_FUNCTIONS, INTENT_OPERATORS } from '@agentix-e/nl2charts-core/semantic';
import { INTENT_RULE, INTENT_SAMPLES_PER_REASON, intentFunnel, intentPayload, readIntentReply } from '../eval/bird/intent.js';

/**
 * The reader half of the fourth candidate source.
 *
 * Two things are being tested and they fail differently. The *extractor* has to find the object a
 * model actually wrote — prose around it, a fence around it, braces inside its strings — because
 * every one of those is a shape a real reply takes and a regex that misses it reports a format
 * failure the model did not commit. The *reader* has to turn that object into a statement or into a
 * named refusal, and the refusal's name is the only actionable number in the artifact.
 */

const OBJECT = {
  from: 'orders',
  select: [{ expr: 'count(*)' }],
};

describe('the rule and the compiler promise the same thing', () => {
  it('names the functions the renderer will accept, and no others', () => {
    for (const name of INTENT_FUNCTIONS) expect(INTENT_RULE).toContain(name);
  });

  it('names the keys the reader requires', () => {
    for (const key of ['from', 'select', 'where', 'joins', 'groupBy', 'orderBy', 'limit']) {
      expect(INTENT_RULE).toContain(`"${key}"`);
    }
  });

  it('states the operator vocabulary it will be judged against', () => {
    // `is null` and `in` are the two shapes a model reaches for and a renderer cannot guess; both
    // are in the contract, so both have to be readable in the rule.
    for (const operator of ['<>', 'like', 'in', 'is null']) expect(INTENT_OPERATORS).toContain(operator);
    expect(INTENT_RULE.length).toBeLessThan(1_200);
  });
});

describe('the object is found wherever the reply put it', () => {
  it('reads a bare object', () => {
    expect(intentPayload('{"a":1}')).toBe('{"a":1}');
  });

  it('reads through a fence, with or without a language tag', () => {
    expect(intentPayload('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(intentPayload('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('reads through the prose a model puts before the object', () => {
    expect(intentPayload('Here is the query:\n{"a":1}\nThat is all.')).toBe('{"a":1}');
  });

  it('keeps a brace that lives inside a string', () => {
    expect(intentPayload('{"expr":"strftime(\'%Y}\', d)"}')).toBe('{"expr":"strftime(\'%Y}\', d)"}');
  });

  it('keeps a brace that lives inside an escaped quote', () => {
    expect(intentPayload('{"a":"say \\"}\\" now"}')).toBe('{"a":"say \\"}\\" now"}');
  });

  it('stops at the first balanced object, so a second one cannot be swallowed', () => {
    expect(intentPayload('{"a":1} {"b":2}')).toBe('{"a":1}');
  });

  it('reports no object when the reply carries none, or an unbalanced one', () => {
    expect(intentPayload('SELECT count(*) FROM orders')).toBeUndefined();
    expect(intentPayload('{"a": {"b": 1}')).toBeUndefined();
    expect(intentPayload('{"a": "unterminated}')).toBeUndefined();
    expect(intentPayload('')).toBeUndefined();
  });

  it('falls back to the whole reply when the fence is empty', () => {
    expect(intentPayload('```json\n\n```\n{"a":1}')).toBe('{"a":1}');
  });
});

describe('a reply becomes a statement or a named refusal', () => {
  it('renders the statement the object describes', () => {
    expect(readIntentReply(JSON.stringify(OBJECT))).toEqual({ ok: true, sql: 'SELECT count(*) FROM orders' });
  });

  it('renders from a fenced reply with prose around it', () => {
    const reply = ['Sure. The query is:', '```json', JSON.stringify(OBJECT, null, 2), '```', 'It counts the rows.'].join('\n');
    expect(readIntentReply(reply)).toEqual({ ok: true, sql: 'SELECT count(*) FROM orders' });
  });

  it('refuses a reply with no object, and says so as a format failure', () => {
    expect(readIntentReply('SELECT count(*) FROM orders')).toMatchObject({ ok: false, reason: 'no-object' });
  });

  it('refuses an object that is not json, and keeps the parser message', () => {
    const refused = readIntentReply('{"from": orders, "select": []}');
    expect(refused).toMatchObject({ ok: false, reason: 'not-json' });
    expect(refused.ok ? '' : refused.detail.length).toBeGreaterThan(0);
  });

  it('passes the compiler refusal through by name, which is the histogram the grammar is read from', () => {
    expect(readIntentReply('{"select":[{"expr":"a"}]}')).toMatchObject({ ok: false, reason: 'missing-from' });
    expect(readIntentReply('{"from":"orders","select":[{"expr":"median(a)"}]}')).toMatchObject({
      ok: false,
      reason: 'unsupported-function',
    });
    expect(readIntentReply('{"from":"orders","select":[{"expr":"a"}],"where":[{"column":"a","op":"~","value":1}]}')).toMatchObject({
      ok: false,
      reason: 'bad-operator',
    });
  });

  it('keeps an apostrophe inside a value without ending the statement', () => {
    const read = readIntentReply(
      JSON.stringify({ ...OBJECT, where: [{ column: 'name', op: '=', value: "O'Brien" }] }),
    );
    expect(read).toEqual({ ok: true, sql: "SELECT count(*) FROM orders WHERE name = 'O''Brien'" });
  });
});

describe('the funnel separates the two things a refusal can mean', () => {
  it('is zero-shaped on no records, rather than a division by zero', () => {
    expect(intentFunnel([])).toEqual({ asked: 0, rendered: 0, share: 0, refused: {}, refusedSamples: [] });
  });

  it('counts what rendered and shares it over what was asked', () => {
    const funnel = intentFunnel([{ read: 'ok' }, { read: 'ok' }, { read: 'no-object' }, { read: 'ok' }]);
    expect(funnel.asked).toBe(4);
    expect(funnel.rendered).toBe(3);
    expect(funnel.share).toBeCloseTo(0.75, 10);
    expect(funnel.refused).toEqual({ 'no-object': 1 });
  });

  it('orders the refusals by frequency, then by name, so the biggest gap reads first', () => {
    const funnel = intentFunnel([
      { read: 'unsupported-function' },
      { read: 'no-object' },
      { read: 'unsupported-function' },
      { read: 'bad-identifier' },
      { read: 'unsupported-function' },
      { read: 'bad-identifier' },
      { read: 'not-json' },
    ]);
    // The last two share a count, so the order between them is decided by name and not by the
    // order the replies happened to arrive in — otherwise the printed list would move between runs
    // of the same artifact.
    expect(Object.keys(funnel.refused)).toEqual(['unsupported-function', 'bad-identifier', 'no-object', 'not-json']);
    expect(funnel.refused['unsupported-function']).toBe(3);
    expect(funnel.share).toBe(0);
  });
});

describe('a refusal kept its sentence, not only its name', () => {
  it('keeps the first few refusals of each name, with where they were', () => {
    const records = [
      { read: 'ok' as const },
      { read: 'bad-expression' as const, detail: 'one' },
      { read: 'bad-identifier' as const, detail: 'two' },
      { read: 'bad-expression' as const, detail: 'three' },
      { read: 'bad-expression' as const, detail: 'four' },
      { read: 'bad-expression' as const, detail: 'five' },
    ];
    const funnel = intentFunnel(records);
    expect(funnel.refused).toEqual({ 'bad-expression': 4, 'bad-identifier': 1 });
    // `at` is the position in the record list, which is what lets a caller print the case id: the
    // histogram said `bad-expression 4` and nothing about which four, and a name is a family.
    expect(funnel.refusedSamples.map((sample) => [sample.at, sample.read, sample.detail])).toEqual([
      [1, 'bad-expression', 'one'],
      [2, 'bad-identifier', 'two'],
      [3, 'bad-expression', 'three'],
      [4, 'bad-expression', 'four'],
    ]);
    expect(funnel.refusedSamples.filter((sample) => sample.read === 'bad-expression')).toHaveLength(INTENT_SAMPLES_PER_REASON);
  });

  it('keeps nothing for a run whose every reply rendered', () => {
    expect(intentFunnel([{ read: 'ok' }, { read: 'ok' }]).refusedSamples).toEqual([]);
  });

  it('says an empty detail as an empty string rather than as undefined', () => {
    // The artifact is read by scripts; a missing field and a field holding nothing are different
    // JSON, and only one of them prints.
    expect(intentFunnel([{ read: 'no-object' }]).refusedSamples).toEqual([{ at: 0, read: 'no-object', detail: '' }]);
  });
});

describe('the schema reaches the reader, which is where a quoted name is safe', () => {
  const COLUMNS = ['frpm.CDSCode', 'frpm.County Name', 'CDSCode', 'County Name'];

  it('renders the column the corpus spells with a space in it', () => {
    const reply = JSON.stringify({
      from: 'frpm',
      select: [{ expr: '"County Name"' }],
      where: [{ column: 'CDSCode', op: '=', value: 1 }],
    });
    expect(readIntentReply(reply, { columns: COLUMNS })).toEqual({
      ok: true,
      sql: 'SELECT "County Name" FROM frpm WHERE CDSCode = 1',
    });
  });

  it('refuses a name the schema does not have, by the name of the family it belongs to', () => {
    const reply = JSON.stringify({ from: 'frpm', select: [{ expr: '"County Nam"' }] });
    const read = readIntentReply(reply, { columns: COLUMNS });
    expect(read).toMatchObject({ ok: false, reason: 'unknown-identifier' });
    expect(read.ok ? '' : read.detail).toContain('County Nam');
  });

  it('renders without a schema, and says so by rendering rather than by refusing', () => {
    // The option is what a caller with a catalog passes and a caller with a string does not; the
    // difference has to be visible in behaviour, or a test could not tell which path ran.
    const reply = JSON.stringify({ from: 'frpm', select: [{ expr: '"County Nam"' }] });
    expect(readIntentReply(reply)).toMatchObject({ ok: true, sql: 'SELECT "County Nam" FROM frpm' });
  });
});
