/**
 * AskData's schema linking, rebuilt from the paper that describes it.
 *
 * The system is `arXiv:2505.19988` (*Automatic Metadata Extraction for Text-to-SQL*, AT&T CDO),
 * which held the top BIRD row from Sept 2024 and was still #1 when it was written; the leaderboard
 * row this repository files under `AskData` reads dev 78.49% / test 83.40% (that reading is dated in
 * `eval/competitors/intake.json`). No release exists and none has appeared: the arXiv page carries
 * no artifact link, a repository search for the system name returns unrelated products, and the one
 * repository whose description names the method is a stub. So this is a rebuild, not a replication,
 * and nothing here may be published as their number — see `docs/benchmarks.md`, *Which of them can
 * be copied at all*.
 *
 * What the paper pins down, and this file implements:
 *
 * 1. Section 3, step 1: "For every field f, fetch N distinct values" and index them so a *literal*
 *    can be resolved to the fields that store it. Their N is 10,000 and their index is an LSH over
 *    shingles (`datasketch`, `kshingle`). The closest thing this repository had was
 *    `values.ts`, which resolves a token that *equals* a stored value — deliberately narrow, and
 *    the wrong width for this step, because the linker's job is to resolve `'Fresno County Office
 *    of Education'` against a column whose values are `'Fresno County Office Of Education'`.
 * 2. Section 3, step 2: five schema variants, each generating one statement, and the union of the
 *    fields those statements reference is the linked schema. The five are (a) focused + minimal
 *    profile, (b) focused + maximal, (c) full + minimal, (d) full + maximal, (e) focused + full.
 *    Their reason for linking by *task alignment* rather than by column selection is worth keeping
 *    in view: an LLM is bad at "which columns are relevant" and good at writing SQL.
 * 3. Section 3, step 2.d–2.e: a literal that no referenced field can hold is not silently accepted.
 *    The fields that do hold it are added to the schema and the model is asked to rewrite the
 *    statement with one of them, up to `MaxRetry` times.
 * 4. Section 3: "recall is better than precision" — the union is taken across variants, and a
 *    narrowing that would empty the card returns the card instead.
 *
 * What it does not pin down, and what a rebuild therefore has to declare: the prompt text, the
 * embedding model behind their FAISS index over long summaries, the value of `MaxRetry`, and the
 * order in which the metadata is fused and truncated. The prompts here are the repository's own
 * (`buildAskMessages`), the summary index is absent, `MaxRetry` is a parameter, and the report says
 * all three out loud rather than implying a code-faithful run.
 *
 * The reading that put this in the queue rather than ahead of it: the paper's own ablation prices
 * *their* linking at +2.0pp without hints and +1.8pp with them (61.2 → 63.2 and 71.2 → 73.0 on
 * Mini-Dev, 500 questions, GPT-4o), against +6.2pp for perfect linking. A faithful rebuild of the
 * mechanism can therefore be worth about two points on this endpoint, and the arm's judgement
 * criteria are written to find out whether it is worth more as a pipeline than its parts.
 */
import { buildAskMessages, extractSql, linkSchema } from '@agentix-e/nl2charts-ai';
import type { DatabaseProfile, LlmMessage, SchemaTable } from '@agentix-e/nl2charts-ai';
import { referencedFields } from './statement.js';

/**
 * One field of a card, keyed the way `referencedFields` keys it: table, then lowercased column.
 *
 * The key carries a NUL rather than a dot because BIRD's column names contain dots, parentheses and
 * slashes; a separator that can occur in a name is the defect that makes `frpm.Academic Year` and
 * `frpm."Academic Year"` two different fields.
 */
export type FieldKey = string;

export function fieldKey(table: string, column: string): FieldKey {
  return `${table.toLowerCase()}\u0000${column.toLowerCase()}`;
}

/** A field that stores a value, with the value it stores. */
export interface Holding {
  readonly table: string;
  readonly column: string;
  readonly value: string;
}

/**
 * The value index the linker resolves literals against.
 *
 * Built from the same profile the card's sampled values come from, over up to `limit` distinct
 * values per column, which is this repository's stand-in for their "N=10,000 per field". Shingles
 * are three characters, the size `kshingle` uses and the size that makes `Office Of` and
 * `Office of` one shingle set after lowercasing — the case that motivates the step.
 */
export interface ValueShards {
  /** Fields whose stored values resemble the literal, best first, at most `max`. */
  holding(literal: string, options?: { readonly minScore?: number; readonly max?: number }): readonly Holding[];
}

const SHINGLE = 3;
/** Their paper samples 10,000 distinct values per field; so does the index. */
export const VALUE_SAMPLE_LIMIT = 10_000;
/**
 * Two values are "the same value spelled differently" above this Jaccard resemblance.
 *
 * 0.6 is not a tuned number: it is the point where one word of three survives, so `'Fresno County
 * Office of Education'` and `'Fresno County Office Of Education'` score 1.0 (the shingle sets are
 * identical once lowercased) while `'Fresno'` against `'Fresno County'` scores 0.5 and is refused.
 * A wrong column is worse than an unresolved literal, which is the same rule `values.ts` states.
 */
export const RESEMBLANCE = 0.6;

function shingles(value: string): string[] {
  const text = value.toLowerCase().replace(/\s+/g, ' ').trim();
  if (text.length <= SHINGLE) return text.length === 0 ? [] : [text];
  const out: string[] = [];
  for (let index = 0; index + SHINGLE <= text.length; index += 1) out.push(text.slice(index, index + SHINGLE));
  return out;
}

function resemblance(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const shingle of left) if (right.has(shingle)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Index one database's sampled values by shingle.
 *
 * The inverted index exists for the same reason their LSH does: a scan of every value per literal
 * is 10,000 comparisons per column per variant, and the five-variant loop asks the question five
 * times. Candidates come from the rarest shingle of the literal, and every candidate is then scored
 * exactly, so the index decides *what to compare* and nothing about the answer.
 */
export function buildValueShards(profile: DatabaseProfile, limit = VALUE_SAMPLE_LIMIT): ValueShards {
  interface Entry {
    readonly table: string;
    readonly column: string;
    readonly value: string;
    readonly shingles: ReadonlySet<string>;
  }
  const entries: Entry[] = [];
  const byShingle = new Map<string, number[]>();
  for (const column of profile.columns) {
    const values = (column.values ?? []).slice(0, limit);
    for (const value of values) {
      const set = new Set(shingles(value));
      if (set.size === 0) continue;
      const position = entries.length;
      entries.push({ table: column.table, column: column.column, value, shingles: set });
      for (const shingle of set) {
        const bucket = byShingle.get(shingle);
        if (bucket === undefined) byShingle.set(shingle, [position]);
        else bucket.push(position);
      }
    }
  }
  return {
    holding(literal, options = {}) {
      const minScore = options.minScore ?? RESEMBLANCE;
      const max = options.max ?? 8;
      const set = new Set(shingles(literal));
      if (set.size === 0) return [];
      // The rarest shingle names the smallest bucket to score; ties go to the longer shingle, which
      // is the one that discriminates between `'Banned'` and `'Banned Item'`.
      let best: number[] | undefined;
      for (const shingle of set) {
        const bucket = byShingle.get(shingle);
        if (bucket === undefined) continue;
        if (best === undefined || bucket.length < best.length) best = bucket;
      }
      if (best === undefined) return [];
      const scored: { entry: Entry; score: number }[] = [];
      for (const position of best) {
        const entry = entries[position] as Entry;
        const score = resemblance(set, entry.shingles);
        if (score >= minScore) scored.push({ entry, score });
      }
      scored.sort((left, right) => right.score - left.score || left.entry.value.localeCompare(right.entry.value));
      return scored.slice(0, max).map(({ entry }) => ({ table: entry.table, column: entry.column, value: entry.value }));
    },
  };
}

/**
 * The paper's five schema variants, in its order.
 *
 * `scope` is which card the statement is written against; `profile` is how much of the field
 * metadata it carries. `minimal` is the short summary (their word) and `maximal` the long one; this
 * repository's card has one definitions level, so minimal is "names and types", maximal is "names,
 * types and the attached definition", and full adds the dataset's own hint — the closest available
 * reading of "SME metadata along with the maximal profile".
 */
export interface Variant {
  readonly name: string;
  readonly scope: 'focused' | 'full';
  readonly profile: 'minimal' | 'maximal' | 'full';
}

export const VARIANTS: readonly Variant[] = [
  { name: 'focused-minimal', scope: 'focused', profile: 'minimal' },
  { name: 'focused-maximal', scope: 'focused', profile: 'maximal' },
  { name: 'full-minimal', scope: 'full', profile: 'minimal' },
  { name: 'full-maximal', scope: 'full', profile: 'maximal' },
  { name: 'focused-full', scope: 'focused', profile: 'full' },
];

/** The card a variant writes against: the focused link, or every table. */
export function cardForVariant(
  variant: Variant,
  base: readonly SchemaTable[],
  linked: readonly { readonly table: string; readonly column: string }[],
): readonly SchemaTable[] {
  if (variant.scope === 'full') return base;
  const kept = keepFields(
    base,
    linked.map((column) => fieldKey(column.table, column.column)),
  );
  // Recall over precision: a focused card that came back empty is the full card, not an empty
  // prompt. Their sentence, and the reason the union can be taken without a guard later.
  return kept.length === 0 ? base : kept;
}

/**
 * The card restricted to `keys`, with a table that keeps no column dropped.
 *
 * An empty result is returned as an empty array and the *caller* decides what that means; this
 * function is also used inside the revision loop, where "nothing outside the statement holds the
 * literal" is a fact worth seeing rather than papering over.
 */
export function keepFields(schema: readonly SchemaTable[], keys: Iterable<FieldKey>): readonly SchemaTable[] {
  const wanted = new Set(keys);
  const out: SchemaTable[] = [];
  for (const table of schema) {
    // A bare name in `wanted` is a statement that wrote the column without its table; it keeps that
    // column wherever the card has one, because the card is what the model is reading.
    const columns = table.columns.filter(
      (column) => wanted.has(fieldKey(table.table, column.name)) || wanted.has(`\u0000${column.name.toLowerCase()}`),
    );
    if (columns.length === 0) continue;
    out.push({ ...table, columns });
  }
  return out;
}

/**
 * The string literals a statement constrains on.
 *
 * Same rule as `values.ts` for what counts: a quoted span, including the doubled-quote escape, and
 * a span that is a number in quotes is still a literal because BIRD stores years and codes as text.
 * Comments and quoted identifiers are not literals and are not read here — `referencedFields` owns
 * that problem for identifiers.
 */
export function literalsOf(sql: string): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === '-' && sql[index + 1] === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (char === '"' || char === '`') {
      let cursor = index + 1;
      while (cursor < sql.length && sql[cursor] !== char) cursor += 1;
      index = cursor + 1;
      continue;
    }
    if (char === "'") {
      let cursor = index + 1;
      let text = '';
      while (cursor < sql.length) {
        if (sql[cursor] === "'") {
          if (sql[cursor + 1] === "'") {
            text += "'";
            cursor += 2;
            continue;
          }
          break;
        }
        text += sql[cursor];
        cursor += 1;
      }
      out.push(text);
      index = cursor + 1;
      continue;
    }
    index += 1;
  }
  return out;
}

/** What one variant's statement contributed. */
export interface VariantOutcome {
  readonly variant: string;
  readonly sql: string;
  readonly fields: readonly FieldKey[];
  readonly literals: readonly string[];
  /** Revisions the model was asked for, because a literal had no field to live in. */
  readonly revisions: number;
  /** Literals that no field of the database stores; the step reports them and does not guess. */
  readonly unresolved: readonly string[];
}

/**
 * Which literals of a statement no referenced field can hold, and which fields could.
 *
 * The paper's step 2.d: for each literal, find the fields that store it; if none of them is in the
 * statement, the statement is constraining a value in a column that does not contain it. A literal
 * that no field stores at all is reported as unresolved and never guessed — the shards' threshold
 * is deliberately conservative for that reason.
 */
export function missingLiterals(
  statement: { readonly fields: readonly FieldKey[]; readonly literals: readonly string[] },
  shards: ValueShards,
): { readonly fields: readonly Holding[]; readonly literals: readonly string[]; readonly unresolved: readonly string[] } {
  const referenced = new Set(statement.fields);
  const add: Holding[] = [];
  const missing: string[] = [];
  const unresolved: string[] = [];
  for (const literal of statement.literals) {
    if (literal.trim().length === 0) continue;
    const holdings = shards.holding(literal);
    if (holdings.length === 0) {
      unresolved.push(literal);
      continue;
    }
    if (
      holdings.some(
        (holding) =>
          referenced.has(fieldKey(holding.table, holding.column)) ||
          referenced.has(`\u0000${holding.column.toLowerCase()}`),
      )
    ) {
      continue;
    }
    missing.push(literal);
    add.push(...holdings);
  }
  return { fields: add, literals: missing, unresolved };
}

/**
 * The sentence that asks for the rewrite, and the reason it is a sentence on the card rather than a
 * new prompt shape: the statement being rewritten has to arrive with the schema it was written
 * against, or the rewrite reads as a fresh question and the whole statement is redrawn.
 */
export function revisionNote(sql: string, literals: readonly string[], fields: readonly Holding[]): string {
  const places = [...new Set(fields.map((field) => `${field.table}.${field.column}`))].slice(0, 8);
  const values = literals.map((literal) => `'${literal}'`).join(', ');
  return [
    `The statement ${sql} constrains ${values}, and no field it references stores that value.`,
    `Fields of this database that do store it: ${places.join(', ')}.`,
    'Rewrite the statement so the constraint is on one of those fields, keeping every other condition.',
  ].join(' ');
}

export interface AlignmentRequest {
  readonly question: string;
  /** The card the arm would have sent without a linker. */
  readonly schema: readonly SchemaTable[];
  /** The prompt options the arm sends, minus the three a variant decides for itself. */
  readonly prompt: Record<string, unknown>;
  readonly shards: ValueShards;
  /** One completion per prompt, returning the reply text. The caller owns the meter. */
  readonly generate: (messages: readonly LlmMessage[]) => Promise<string>;
  readonly topK?: number;
  readonly maxRetry?: number;
  /** Variants to run; the whole list by default, and a parameter so a test can price each one. */
  readonly variants?: readonly Variant[];
}

export interface Alignment {
  readonly fields: readonly FieldKey[];
  readonly variants: readonly VariantOutcome[];
  /** Prompts sent, which is the cost of the linking stage and not of the arm. */
  readonly calls: number;
}

/**
 * Link a question by running the paper's five variants and unioning what their statements read.
 *
 * The linking prompt is the *generation* prompt — that is the whole idea of task alignment, and a
 * second prompt builder here would be a second thing to keep in agreement with the card. What the
 * variants vary is the card in front of it and how much metadata it carries.
 */
export async function linkByAlignment(request: AlignmentRequest): Promise<Alignment> {
  const variants = request.variants ?? VARIANTS;
  const maxRetry = request.maxRetry ?? 2;
  // The focused card is this repository's three-recaller linker, which is what `linking: true` sends
  // on every other arm. It is a *base* for two of the five variants and not a candidate for the
  // answer's schema, which is why it is computed once and never unions into the result.
  const linked = linkSchema(request.question, request.schema, request.topK ?? 12);
  // A bare identifier is a field only if the card has a column of that name. `referencedFields`
  // does not know SQL's keywords — `select`, `count` and `from` arrive as bare identifiers — and a
  // union that carried them would narrow the card to nothing on the first statement.
  const columns = new Set<string>();
  for (const table of request.schema) for (const column of table.columns) columns.add(column.name.toLowerCase());
  const outcomes: VariantOutcome[] = [];
  const union = new Set<FieldKey>();
  let calls = 0;
  for (const variant of variants) {
    let card = cardForVariant(variant, request.schema, linked);
    let previous: { readonly sql: string; readonly fields: readonly FieldKey[] } | undefined;
    let revisions = 0;
    let unresolved: readonly string[] = [];
    let sql = '';
    let fields: readonly FieldKey[] = [];
    let literals: readonly string[] = [];
    for (let attempt = 0; ; attempt += 1) {
      const prompt: Record<string, unknown> = { ...request.prompt };
      // The profile a variant carries. `minimal` removes both blocks rather than shortening them,
      // because a shortened definition is a different prompt that nobody measured.
      delete prompt.definitions;
      delete prompt.evidence;
      delete prompt.values;
      if (variant.profile !== 'minimal' && request.prompt.definitions !== undefined) {
        prompt.definitions = request.prompt.definitions;
      }
      if (variant.profile === 'full' && request.prompt.evidence !== undefined) {
        prompt.evidence = request.prompt.evidence;
      }
      if (previous !== undefined) {
        const holdings = missingLiterals({ fields: previous.fields, literals }, request.shards);
        prompt.notes = [
          ...((request.prompt.notes as readonly string[] | undefined) ?? []),
          revisionNote(previous.sql, holdings.literals, holdings.fields),
        ];
      }
      const built = buildAskMessages({
        question: request.question,
        schema: card,
        linking: false,
        prompt: prompt as never,
      });
      calls += 1;
      const reply = await request.generate(built.messages);
      sql = extractSql(reply);
      const read = referencedFields(sql);
      // A qualified pair resolves to `table\u0000column`; a bare identifier has no table until the
      // card is read, so it is kept with an empty table — the shape a card-wide column name has,
      // and the reason `keepFields` compares the column half as well as the whole key.
      fields = [
        ...read.qualified.map((field) => fieldKey(field.table, field.column)),
        ...read.bare.filter((name) => columns.has(name.toLowerCase())).map((name) => `\u0000${name.toLowerCase()}`),
      ];
      literals = literalsOf(sql);
      const holdings = missingLiterals({ fields, literals }, request.shards);
      unresolved = holdings.unresolved;
      if (holdings.literals.length === 0 || attempt >= maxRetry) break;
      revisions += 1;
      const widened = keepFields(request.schema, [...fields, ...holdings.fields.map((field) => fieldKey(field.table, field.column))]);
      card = widened.length === 0 ? request.schema : widened;
      previous = { sql, fields };
    }
    for (const key of fields) union.add(key);
    outcomes.push({ variant: variant.name, sql, fields, literals, revisions, unresolved });
  }
  return { fields: [...union], variants: outcomes, calls };
}
