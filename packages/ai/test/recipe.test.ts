/**
 * The shipped prompt as one object, and the four ways it can be resolved wrong.
 *
 * A recipe is small enough to look obviously correct, which is why every field is read here rather
 * than trusted: a `linking` that flipped would send a hint the measured arm never sent, a dialect
 * that was passed through uncanonicalised would write `sqlite` into a prompt whose examples are
 * `SQLite`, and a fallback that did not name itself would turn a prompt change into a mystery in
 * an accuracy table. The last test is the one that matters most: the recipe must produce the two
 * messages the measured arm produced, from a declaration written out by hand here.
 */
import { describe, expect, it } from 'vitest';
import type { SchemaTable } from '../src/linking.js';
import { buildAskMessages, buildSqlPrompt } from '../src/pipeline.js';
import { ASSEMBLED_SQL, findSqlRecipe, resolvePrompt, resolveShipment, SHIPPED_SQL, SQL_RECIPES } from '../src/recipe.js';

const schema: readonly SchemaTable[] = [
  {
    table: 'orders',
    columns: [
      { name: 'id', type: 'INTEGER', comment: 'the order id' },
      { name: 'status', type: 'TEXT', comment: 'where the order is in the pipeline' },
    ],
    foreignKeys: ['orders.customer_id = customers.id'],
  },
];

const question = 'How many orders are still open?';
const evidence = 'Open means `status` is not closed.';

describe('the shipped recipe', () => {
  it('states the combination the arm was measured with', () => {
    expect(SHIPPED_SQL).toMatchObject({
      name: 'shipped-sql',
      arm: 'macsql-prompt',
      template: 'macsql-bird',
      descriptions: true,
      foreignKeys: false,
      samples: false,
      linking: false,
      dialects: ['SQLite'],
    });
  });

  it('carries the reading that put it there', () => {
    // The provenance is part of the object rather than a comment, because the report prints it:
    // a recipe whose justification lives only in a doc is a recipe nobody re-checks.
    expect(SHIPPED_SQL.reading).toContain('65.93%');
    expect(SHIPPED_SQL.reading).toContain('p = 0.0441');
  });

  it('keeps the assembled skeleton as a named fallback', () => {
    expect(SQL_RECIPES.map((recipe) => recipe.name)).toEqual(['shipped-sql', 'assembled']);
    expect(ASSEMBLED_SQL.template).toBeUndefined();
    expect(ASSEMBLED_SQL.linking).toBe(true);
    // Empty means "whatever the caller asks for", which is the whole reason it can catch a
    // dialect the template cannot state.
    expect(ASSEMBLED_SQL.dialects).toEqual([]);
  });
});

describe('resolving a recipe against one question', () => {
  it('renders the whole template with the evidence in its slot', () => {
    const options = resolvePrompt(SHIPPED_SQL, { dialect: 'sqlite', evidence });
    const prompt = buildSqlPrompt(question, schema, options);
    expect(prompt).toContain('【Constraints】');
    expect(prompt).toContain('【Evidence】');
    expect(prompt).toContain(evidence);
    expect(prompt).toContain('Decompose the question into sub questions');
    // The template is the whole prompt: the assembled skeleton's own opening line is gone.
    expect(prompt).not.toContain('You translate questions into one read-only SQL statement.');
  });

  it('spells the dialect the way the prompt does, not the way the runner does', () => {
    expect(resolvePrompt(SHIPPED_SQL, { dialect: 'sqlite' }).dialect).toBe('SQLite');
    expect(resolvePrompt(SHIPPED_SQL, { dialect: '  SQLite  ' }).dialect).toBe('SQLite');
  });

  it('refuses a dialect the prompt cannot state', () => {
    // A prompt whose instruction says SQLite and whose examples are SQLite, asked for PostgreSQL,
    // is a prompt that contradicts itself — and it would be sent, silently, if this returned.
    expect(() => resolvePrompt(SHIPPED_SQL, { dialect: 'postgres' })).toThrow(/states SQLite.*asked for 'postgres'/s);
  });

  it('refuses to guess a dialect the caller did not name', () => {
    expect(() => resolvePrompt(SHIPPED_SQL, {})).toThrow(/asked for no dialect/);
    expect(() => resolvePrompt(SHIPPED_SQL, { dialect: '   ' })).toThrow(/asked for no dialect/);
  });

  it('drops a blank evidence block rather than sending an empty heading', () => {
    const options = resolvePrompt(SHIPPED_SQL, { dialect: 'sqlite', evidence: '   ' });
    expect(options.evidence).toBeUndefined();
    // The template states `None` in that slot, which is the block's absence as a fact rather than
    // an empty heading the model has to interpret.
    expect(buildSqlPrompt(question, schema, options)).toContain('【Evidence】\nNone');
  });

  it('takes the card width from the payload', () => {
    expect(resolvePrompt(SHIPPED_SQL, { dialect: 'sqlite', schemaLines: 1 }).schemaLines).toBe(1);
    expect(resolvePrompt(SHIPPED_SQL, { dialect: 'sqlite' }).schemaLines).toBeUndefined();
    const wide = buildSqlPrompt(question, schema, resolvePrompt(SHIPPED_SQL, { dialect: 'sqlite', schemaLines: 1 }));
    const narrow = buildSqlPrompt(question, schema, resolvePrompt(SHIPPED_SQL, { dialect: 'sqlite', schemaLines: 2 }));
    expect(wide.length).toBeLessThan(narrow.length);
  });

  it('leaves the assembled recipe in the caller’s own dialect', () => {
    const options = resolvePrompt(ASSEMBLED_SQL, { dialect: 'postgres', evidence });
    expect(options.template).toBeUndefined();
    expect(options.dialect).toBe('postgres');
    expect(buildSqlPrompt(question, schema, options)).toContain('Write postgres SQL.');
  });
});

describe('choosing which recipe answers', () => {
  it('ships the template when the dialect is the one it states', () => {
    const shipped = resolveShipment({ dialect: 'sqlite', evidence });
    expect(shipped.recipe).toBe('shipped-sql');
    expect(shipped.linking).toBe(false);
    expect(shipped.fellBackFrom).toBeUndefined();
  });

  it('falls back for a dialect the template cannot state, and says so', () => {
    // `fellBackFrom` is the field that keeps a reader from explaining an accuracy delta by the
    // model when the prompt changed skeleton under them.
    const shipped = resolveShipment({ dialect: 'mysql', evidence });
    expect(shipped.recipe).toBe('assembled');
    expect(shipped.fellBackFrom).toBe('shipped-sql');
    expect(shipped.linking).toBe(true);
    expect(shipped.options.dialect).toBe('mysql');
  });

  it('falls back when the caller named no dialect at all', () => {
    // No dialect is not SQLite: a caller that named none has not asked for it, and inventing it
    // here would ship the template to a database nobody checked.
    expect(resolveShipment({}).recipe).toBe('assembled');
    expect(resolveShipment({}, 'assembled').fellBackFrom).toBeUndefined();
  });
});

describe('looking a recipe up by name', () => {
  it('finds both', () => {
    expect(findSqlRecipe('shipped-sql')).toBe(SHIPPED_SQL);
    expect(findSqlRecipe('assembled')).toBe(ASSEMBLED_SQL);
  });

  it('refuses a name that is not one, and lists the ones that are', () => {
    expect(() => findSqlRecipe('macsql')).toThrow(/no SQL recipe named 'macsql'; the shipped ones are shipped-sql, assembled/);
  });
});

describe('the recipe against the declaration it was measured as', () => {
  it('produces the two messages the arm sends', () => {
    /**
     * The arm, written out by hand the way `eval/bird/run.ts` declares `macsql-prompt`: the
     * template, the dataset's evidence, descriptions on the card, no hint, one call. The recipe
     * has to produce exactly this — not "an equivalent prompt" — because `bench:bird:recipe`
     * compares the two over a whole split, and a mismatch here would be reported there as drift
     * on every case with a message about offsets rather than about this line.
     *
     * The dialect is the runner's spelling on one side and the prompt's on the other on purpose:
     * that difference is what `resolvePrompt` exists to erase.
     */
    const armPrompt = {
      dialect: 'SQLite',
      descriptions: true,
      foreignKeys: false,
      samples: false,
      schemaLines: 400,
      evidence,
      template: 'macsql-bird' as const,
    };
    const fromArm = buildAskMessages({ question, schema, prompt: armPrompt, linking: false });
    const fromRecipe = buildAskMessages({ question, schema, prompt: resolvePrompt(SHIPPED_SQL, { dialect: 'sqlite', evidence, schemaLines: 400 }), linking: SHIPPED_SQL.linking });
    expect(fromRecipe.messages).toEqual(fromArm.messages);
    // ...and the hint is absent for the same reason on both sides, which is a different message
    // rather than a different system prompt: `linking: false` writes `Use the schema above.`
    expect(fromRecipe.messages[1].content).toBe(`Use the schema above.\n${question}`);
    expect(fromRecipe.linked).toEqual([]);
  });
});
