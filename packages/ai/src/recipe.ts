/**
 * The prompt a product sends, named as one object.
 *
 * `template.ts` closed the skeleton and `pipeline.ts` closed the builder; the *combination* had no
 * owner. `macsql-prompt` — the arm that won BIRD dev — is a template **and** the dataset's evidence
 * **and** descriptions on the card **and** no column hint, and that combination existed only in the
 * arm table, which is a benchmark's declaration. The product built its prompt by hand, two fields at
 * a time, so the best combination the experiment had found was not the prompt the product sent and
 * nothing would have noticed the two diverging.
 *
 * A recipe is what the prompt is made of; a payload is what one question fills it with. The long
 * form — the readings and the refused dialect — is in `docs/benchmarks.md` and
 * `docs/guide/05-natural-language.md`.
 *
 * ## The card width is part of the combination
 *
 * It was not, and that was a defect with a diagnostic shape rather than a cosmetic one. The width
 * lived only in the payload, so `resolveShipment({ dialect })` — the call this package's own guide
 * documents — reached the builders with no width, and both of them default to **40 column lines**.
 * The reading that put `macsql-prompt` here was taken at **400**. On BIRD dev the difference is not
 * academic: at 40 lines 22 of the 75 tables in the corpus never reach the prompt and 415 of 798
 * columns are cut, so 587 of the 1,532 questions are asked about a schema missing a table their gold
 * statement reads. A caller following the documentation therefore sent a prompt nobody had measured,
 * and no test compared the two because the test that would have done it passed `schemaLines: 400`
 * by hand — the workaround was in the assertion.
 *
 * The fix is that a recipe states the width its reading used, and a payload may still override it
 * (an instrument that prices a different width has to be able to say so). `bench:bird:reach` is the
 * instrument that makes the difference measurable rather than argued, and its gate refuses a card
 * that hides a table a gold statement reads.
 */
import type { PromptOptions } from './pipeline.js';
import { assertTemplateCarries } from './template.js';
import type { PromptTemplate } from './template.js';

/** The shipped prompts, by name. Adding one is adding a line here and a reading behind it. */
export type SqlRecipeName = 'shipped-sql' | 'assembled';

/**
 * One prompt, as the combination of levers that produces it.
 *
 * A field is here only if a shipped recipe sets it: none of `definitions`, `values`, `notes` or the
 * decomposition switches is on in either recipe, and an interface that can state a lever the
 * product never turns invites turning it without a reading. Evidence is always passed, so it is not
 * a field — a switch for it would be a branch no recipe takes.
 */
export interface SqlRecipe {
  readonly name: SqlRecipeName;
  /** The benchmark arm this recipe is, in `eval/bird/run.ts`. Absent on a fallback. */
  readonly arm?: string;
  /** The whole prompt, when the recipe is one. Absent means the assembled skeleton. */
  readonly template?: PromptTemplate;
  readonly descriptions: boolean;
  readonly foreignKeys: boolean;
  readonly samples: boolean;
  /**
   * Every column of every table, in the unit `renderMacSqlCard` counts.
   *
   * A recipe is a combination and the width is one of its levers: the same skeleton and the same
   * evidence produce the measured prompt at 400 lines and an unmeasured one at the builders' own
   * default of 40, because the card is where every table the model can read is written. 400 is not a
   * budget anyone tuned — it is the value the reading was taken at, and on BIRD's eleven databases
   * it truncates nothing (the widest schema in the corpus is 199 columns). Stating it here means the
   * object that names the prompt also names the prompt's size, so a caller who passes no payload
   * cannot silently send a smaller card than the reading describes.
   */
  readonly schemaLines: number;
  /** Whether a column hint goes in front of the card, in the user message. */
  readonly linking: boolean;
  /** The dialects the prompt can state, spelled as the prompt spells them. Empty means any. */
  readonly dialects: readonly string[];
  /** The reading that put this combination here. Printed by `bench:bird:recipe`. */
  readonly reading: string;
}

/**
 * The prompt BIRD dev was won with: MAC-SQL's skeleton, this project's card, the dataset's hint.
 *
 * Run `44991167518`, 1,532 dev questions, one endpoint: 1,010 answers (65.93%) against the assembled
 * prompt's 980 (63.97%), paired 119:89, +1.96pp, exact McNemar p = 0.0441, at 40% of the cache-miss
 * tokens (134 a case against 587) for one call. `linking: false` is part of the reading: the arm was
 * measured with the hint off, against `inline+evidence-nolink`.
 */
export const SHIPPED_SQL: SqlRecipe = {
  name: 'shipped-sql',
  arm: 'macsql-prompt',
  template: 'macsql-bird',
  // The template renders type and description on one column line, so descriptions are on by
  // construction; a template card with no prose would be the card this project would not ship.
  descriptions: true,
  foreignKeys: false,
  samples: false,
  schemaLines: 400,
  linking: false,
  dialects: ['SQLite'],
  reading:
    'BIRD dev 1,532 questions, run 44991167518: 1,010 = 65.93% against the assembled prompt 980 = 63.97%, ' +
    'paired 119:89, +1.96pp, exact McNemar p = 0.0441, 95% CI [+0.12, +3.80]; 134 cache-miss tokens a case ' +
    'against 587, one call a case',
};

/**
 * The skeleton that can state any dialect, kept as a named fallback.
 *
 * It is what the product sent before the reading above, and it is what a PostgreSQL or DuckDB caller
 * still gets: the two shipped prompts differ in the skeleton, not in whether one of them can answer.
 */
export const ASSEMBLED_SQL: SqlRecipe = {
  name: 'assembled',
  descriptions: false,
  foreignKeys: false,
  samples: false,
  schemaLines: 400,
  linking: true,
  dialects: [],
  reading: 'the assembled skeleton at the caller\'s dialect, with the dataset hint and the column hint on',
};

/** Every shipped recipe, in the order a report should print them. */
export const SQL_RECIPES: readonly SqlRecipe[] = [SHIPPED_SQL, ASSEMBLED_SQL];

/**
 * The recipe a name refers to, or a throw naming the ones that exist.
 *
 * `undefined` would push the refusal to the first case that uses it, and the message would be about
 * a prompt rather than about the name the caller typed.
 */
export function findSqlRecipe(name: string): SqlRecipe {
  const found = SQL_RECIPES.find((recipe) => recipe.name === name);
  if (found === undefined) {
    throw new Error(`no SQL recipe named '${name}'; the shipped ones are ${SQL_RECIPES.map((recipe) => recipe.name).join(', ')}`);
  }
  return found;
}

/** What one question fills the recipe with. */
export interface RecipePayload {
  /** The dialect the caller runs on. Omitted means the recipe's own, or none. */
  readonly dialect?: string;
  /** The dataset's hint for this question, verbatim. Absent or blank means no block. */
  readonly evidence?: string;
  /**
   * Card lines, overriding the recipe's own.
   *
   * Omitted keeps the recipe's width, which is the width its reading was taken at. It is an override
   * rather than the only source of the number: a caller who passes no payload must still send the
   * card that was measured, and before this field existed they did not.
   */
  readonly schemaLines?: number;
}

/** A recipe resolved against one payload: what the pipeline is handed, and what it was chosen by. */
export interface ResolvedPrompt {
  readonly options: PromptOptions;
  readonly recipe: SqlRecipeName;
  /** Whether a column hint goes in front of the card. */
  readonly linking: boolean;
  /** The recipe asked for, when it could not state the caller's dialect. */
  readonly fellBackFrom?: SqlRecipeName;
}

/**
 * Whether a recipe can state this dialect.
 *
 * Case-insensitive because the two vocabularies differ by case and nothing else: this package spells
 * the template's `SQLite`, and every runner in `packages/node` reports `sqlite`. An absent dialect is
 * not a match — a caller that named none has not asked for SQLite.
 */
function states(recipe: SqlRecipe, dialect: string | undefined): boolean {
  if (dialect === undefined || dialect.trim().length === 0) return false;
  return recipe.dialects.some((name) => name.toLowerCase() === dialect.trim().toLowerCase());
}

/**
 * The exact `PromptOptions` a recipe produces for one payload.
 *
 * The recipe is written after the payload, so a caller cannot override the combination it asked for
 * by passing a field: the combination *is* the argument. A dialect the prompt cannot state throws
 * here rather than producing a prompt that says SQLite at the top and PostgreSQL at the bottom.
 */
export function resolvePrompt(recipe: SqlRecipe, payload: RecipePayload = {}): PromptOptions {
  const requested = payload.dialect === undefined || payload.dialect.trim().length === 0 ? undefined : payload.dialect.trim();
  // The recipe's own spelling, not the caller's: a prompt written in `sqlite` is a prompt written in
  // a dialect no documentation names.
  const stated = requested === undefined ? undefined : recipe.dialects.find((name) => name.toLowerCase() === requested.toLowerCase());
  if (recipe.dialects.length > 0 && stated === undefined) {
    throw new Error(
      `SQL recipe '${recipe.name}' states ${recipe.dialects.join(', ')} in the prompt itself and was asked for ` +
        `${requested === undefined ? 'no dialect' : `'${requested}'`}; ` +
        'resolveShipment picks a recipe the dialect can be written in, or name the recipe whose skeleton can state it',
    );
  }
  const dialect = recipe.dialects.length === 0 ? requested : stated;
  const evidence = payload.evidence === undefined || payload.evidence.trim().length === 0 ? undefined : payload.evidence;
  const options: PromptOptions = {
    ...(dialect === undefined ? {} : { dialect }),
    descriptions: recipe.descriptions,
    foreignKeys: recipe.foreignKeys,
    samples: recipe.samples,
    // The recipe's width, unless the caller priced another one. The payload keeps the override
    // because an instrument that measures a different card has to be able to say so, and the shipped
    // path is the one that must not have to remember a number that lives in the recipe.
    schemaLines: payload.schemaLines ?? recipe.schemaLines,
    ...(evidence === undefined ? {} : { evidence }),
    ...(recipe.template === undefined ? {} : { template: recipe.template }),
  };
  // The refusal `buildSqlPrompt` makes, at the moment the object is built: the two layers must not
  // be able to disagree about which levers a skeleton can carry.
  if (recipe.template !== undefined) assertTemplateCarries({ ...options, template: recipe.template });
  return options;
}

/**
 * The prompt to send: the preferred recipe if the dialect fits, the assembled one if it does not.
 *
 * One function rather than a rule in each caller, because "which recipe" has to be decided the same
 * way in the product and in the instrument that checks the product. The fallback is a step down in
 * what the prompt claims, not a silent substitution: the result names both recipes.
 */
export function resolveShipment(payload: RecipePayload = {}, preferred: SqlRecipeName = 'shipped-sql'): ResolvedPrompt {
  const wanted = findSqlRecipe(preferred);
  if (wanted.dialects.length === 0 || states(wanted, payload.dialect)) {
    return { options: resolvePrompt(wanted, payload), recipe: wanted.name, linking: wanted.linking };
  }
  const fallback = findSqlRecipe('assembled');
  return {
    options: resolvePrompt(fallback, payload),
    recipe: fallback.name,
    linking: fallback.linking,
    fellBackFrom: wanted.name,
  };
}
