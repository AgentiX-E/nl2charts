/**
 * The identity between the prompt the product sends and the prompt the experiment priced.
 *
 * The instrument compares two prompts per case, and the failure it exists to catch is silent:
 * the arm table and the shipped recipe are separate declarations, so an edit to either one keeps
 * both working and only the product's accuracy moves. So the tests here are of three kinds:
 *
 * - the *comparison itself*, on a real dataset — the fixture's seven questions through the real
 *   `buildAskMessages`, with the arm's prompt on one side and the product's on the other;
 * - the *detection*, because an instrument that can only say "identical" is a tautology: an arm
 *   that is not the shipped one must come back with differences, and the first one must be
 *   reported with the offset it was found at;
 * - the *refusals*, which are the ways this could measure the wrong thing: comparing a template
 *   arm against the assembled fallback, or comparing a recipe that names no arm at all.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveShipment, SHIPPED_SQL } from '@agentix-e/nl2charts-ai';
import type { SchemaTable } from '@agentix-e/nl2charts-ai';
import { buildSchema, loadDescriptions, loadQuestions, loadTables } from '../eval/bird/data.js';
import type { BirdQuestion } from '../eval/bird/data.js';
import { armForRecipe, compareCase, firstDifference, isEntry, main, recipeLines, resolveRecipeSettings, runRecipe, RUNNER_DIALECT } from '../eval/bird/recipe.js';
import type { MessageDiff, RecipeCase } from '../eval/bird/recipe.js';
import { resolveArm } from '../eval/bird/run.js';
import { MINI_DB, writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();

/** A difference, or a throw naming the case that had none. Keeps the union out of every test. */
function differenceOf(verdict: RecipeCase): MessageDiff {
  if (verdict.equal) throw new Error(`q${verdict.id} is identical and a difference was expected`);
  return verdict.diff;
}

/** The difference as a string, for an assertion message that has to say why it failed. */
function differenceIn(verdict: RecipeCase): string {
  return verdict.equal ? 'identical' : `${verdict.diff.side} at ${String(verdict.diff.at)}`;
}

/** The fixture dataset, with the evidence one case needs to make the hint block non-empty. */
function dataset(): string {
  return writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'recipe-')), {
    evidence: { 7: 'The pen is item number one; `item_id` holds the item it names.' },
  });
}

/** The layout an instrument reads: the same four files and nothing else. */
function layoutFor(data: string) {
  return {
    split: 'minidev' as const,
    data,
    questionsFile: join(data, 'mini_dev_sqlite.json'),
    tablesFile: join(data, 'dev_tables.json'),
    descriptionsRoot: join(data, 'dev_databases'),
    databaseRoot: join(data, 'dev_databases'),
    out: join(data, 'out.json'),
  };
}

/** The run's own card: notes attached once per database, `descriptions` deciding to print them. */
function schemaOf(data: string): readonly SchemaTable[] {
  const tables = loadTables(join(data, 'dev_tables.json'));
  const table = tables.get(MINI_DB);
  if (table === undefined) throw new Error('the fixture ships no shop table');
  const notes = loadDescriptions(join(data, 'dev_databases', MINI_DB, 'database_description'), table.tableNames);
  return buildSchema(table, notes, { withNotes: true });
}

function questionOf(data: string, id: number): BirdQuestion {
  const found = loadQuestions(join(data, 'mini_dev_sqlite.json')).find((question) => question.question_id === id);
  if (found === undefined) throw new Error(`the fixture ships no question ${id}`);
  return found;
}

describe('finding where two prompts part', () => {
  it('reports nothing for two identical strings', () => {
    expect(firstDifference('one prompt', 'one prompt')).toBeUndefined();
  });

  it('reports the offset and both windows, with newlines escaped', () => {
    const found = firstDifference('Rules:\nSchema:\nitems(id)', 'Rules:\nSchema:\norders(id)');
    expect(found?.at).toBe('Rules:\nSchema:\n'.length);
    // The window starts forty characters before the difference, so near the beginning of a short
    // prompt it is the whole prompt and the escaped newline sits inside it.
    expect(found?.arm).toContain('\\nitems(');
    expect(found?.shipped).toContain('\\norders(');
  });

  it('finds a difference that is only a suffix', () => {
    // The shorter string is a prefix of the longer one: a loop bounded by the shorter length
    // would say "identical" for a prompt missing its last block, which is a whole block.
    const found = firstDifference('Rules and schema', 'Rules and schema and evidence');
    expect(found?.at).toBe('Rules and schema'.length);
    expect(found?.shipped.endsWith(' and evidence')).toBe(true);
  });
});

describe('the arm and the shipped recipe, per case', () => {
  const data = dataset();
  const arm = resolveArm('macsql-prompt');

  it('sends the same prompt from both sides on every case of a split', () => {
    expect(arm).toBeDefined();
    for (const question of loadQuestions(join(data, 'mini_dev_sqlite.json'))) {
      const verdict = compareCase(arm as never, question, schemaOf(data));
      expect(verdict.equal, `q${verdict.id}: ${differenceIn(verdict)}`).toBe(true);
    }
  });

  it('canonicalises the dialect a runner reports', () => {
    // The product passes what the runner says — `sqlite` — and the arm sends `SQLite`. If the
    // comparison passed both sides the capital, it would never exercise the canonicalisation.
    const shipped = resolveShipment({ dialect: RUNNER_DIALECT, evidence: 'a hint' });
    expect(shipped.options.dialect).toBe('SQLite');
  });

  it('reports a difference when the arm is not the shipped prompt', () => {
    const other = resolveArm('inline+evidence');
    const diff = differenceOf(compareCase(other as never, questionOf(data, 1), schemaOf(data)));
    expect(diff.side).toBe('system');
    expect(diff.at).toBe(0);
  });

  it('names a difference in the user turn when the system prompts agree', () => {
    // The hint lives in the user message, so an arm that sends the same skeleton with the hint on
    // differs from the recipe by the second message and by nothing else. Reported as a system
    // difference it would send a reader looking through 4,600 tokens of template for a word that
    // is not in them.
    const hinting = { ...(resolveArm('macsql-prompt') as object), linking: true } as never;
    const diff = differenceOf(compareCase(hinting, questionOf(data, 1), schemaOf(data)));
    expect(diff.side).toBe('user');
    expect(diff.shipped.startsWith('Use the schema above.')).toBe(true);
  });

  it('compares a question with no evidence field at all', () => {
    // BIRD's own file always carries `evidence`, as an empty string where there is none; a caller
    // that builds a question without the field is the same prompt, and the payload must not
    // differ by a key that renders to nothing.
    const { evidence: _dropped, ...rest } = questionOf(data, 1);
    const verdict = compareCase(arm as never, rest as never, schemaOf(data));
    expect(verdict.equal).toBe(true);
  });

  it('refuses to compare a template arm against the assembled fallback', () => {
    // The arm is the template; the fallback is the assembled skeleton. Comparing them would
    // report every case as drift, and a report nobody can act on is worse than a refusal.
    expect(() => compareCase(arm as never, questionOf(data, 1), schemaOf(data), 'postgres')).toThrow(/resolved to 'assembled'/);
  });
});

describe('which arm a recipe is', () => {
  it('takes the arm the recipe was measured as', () => {
    expect(armForRecipe(SHIPPED_SQL)).toBe('macsql-prompt');
    expect(armForRecipe(SHIPPED_SQL, 'inline+evidence')).toBe('inline+evidence');
  });

  it('refuses a recipe that names no arm and no name', () => {
    expect(() => armForRecipe({ ...SHIPPED_SQL, arm: undefined })).toThrow(/names no arm/);
  });

  it('resolves the settings the runner will use', () => {
    const data = dataset();
    const env = { BIRD_SPLIT: 'minidev', BIRD_DATA: data };
    expect(resolveRecipeSettings(env, [], ROOT).arm).toBe('macsql-prompt');
    expect(resolveRecipeSettings(env, ['--arm', 'select'], ROOT).arm).toBe('select');
    expect(() => resolveRecipeSettings(env, ['--arm'], ROOT)).toThrow(/--arm needs a name/);
  });
});

describe('a reading over a split', () => {
  const outcome = (arm: string) => runRecipe({ layout: layoutFor(dataset()) as never, arm });

  it('counts every case once and finds no difference', () => {
    const read = outcome('macsql-prompt');
    expect(read.cases).toBe(7);
    expect(read.equal).toBe(7);
    expect(read.differs).toEqual([]);
    expect(read.problems).toEqual([]);
  });

  it('names the arm it compared when that is not the one the recipe is', () => {
    // The reading is still a valid comparison — it just is not a comparison of the shipped
    // prompt — and an instrument that stayed quiet would let a green run mean the wrong thing.
    const read = outcome('inline+evidence');
    expect(read.differs).toHaveLength(7);
    expect(read.shown).toBe(5);
    expect(read.problems.join('\n')).toContain("compared 'inline+evidence'");
  });

  it('prints the reading, the count and the fallback', () => {
    const lines = recipeLines(outcome('macsql-prompt')).join('\n');
    expect(lines).toContain('7 cases');
    expect(lines).toContain('identical: 7 / 7');
    expect(lines).toContain('the product sends the prompt the experiment priced');
    expect(lines).toContain('fallback: postgres -> assembled (left shipped-sql)');
  });

  it('refuses an arm that is not in the table', () => {
    expect(() => outcome('no-such-arm')).toThrow(/no arm named 'no-such-arm'/);
  });

  it('refuses a question whose database has no table manifest entry', () => {
    // A card cannot be built from a database that is not in `dev_tables.json`, and comparing
    // prompts built from two different cards would report a difference that is about the fixtures.
    const data = dataset();
    writeFileSync(join(data, 'dev_tables.json'), JSON.stringify([]));
    expect(() => runRecipe({ layout: layoutFor(data) as never, arm: 'macsql-prompt' })).toThrow(/no entry for shop/);
  });

  it('prints where the first five differences are', () => {
    const lines = recipeLines(outcome('inline+evidence')).join('\n');
    expect(lines).toContain('differs: 7');
    expect(lines).toContain('q1 (shop) system at 0');
  });
});

describe('the entry point', () => {
  it('exits zero when every case is identical', async () => {
    const data = dataset();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const code = await main([], ROOT, { BIRD_SPLIT: 'minidev', BIRD_DATA: data });
      expect(code).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  it('exits non-zero when a case differs', async () => {
    const data = dataset();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const code = await main(['--arm', 'inline+evidence'], ROOT, { BIRD_SPLIT: 'minidev', BIRD_DATA: data });
      expect(code).toBe(1);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('is the entry point when it was invoked as one', () => {
    expect(isEntry(new URL(import.meta.url).pathname, import.meta.url)).toBe(true);
    expect(isEntry(undefined, import.meta.url)).toBe(false);
    expect(isEntry('/somewhere/else.ts', import.meta.url)).toBe(false);
  });
});
