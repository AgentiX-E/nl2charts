/**
 * What the prompt costs, and what a smaller card could cost instead.
 *
 * The plan's token work started from a question nobody had asked: how many characters does the
 * product send per question, and which block sends them? The answer is one number with a
 * structure behind it — the schema card is the prompt — and the structure is what makes the
 * next lever arguable rather than plausible.
 *
 * Three measurements, all with zero model calls:
 *
 * 1. **Where the bytes go.** The prompt is two messages: a system message built by
 *    `buildSqlPrompt` (rules, card, context, question) and a user message carrying the linker's
 *    hint and the question again. Both are rendered here by `buildAskMessages`, the function the
 *    pipeline sends, so the measurement is of the prompt that was sent rather than a copy of it.
 * 2. **The ceiling for a smaller card.** For every case, the tables the gold statement touches
 *    are compared with the tables the card shows. The difference is what a linker that never
 *    errs would remove — an oracle, named as one, and the only way to price the lever before
 *    spending a run on it.
 * 3. **What the linker that ships would remove.** `linkSchema` with the recallers the product
 *    uses, and with the table recaller added, against the same oracle. A lever whose ceiling is
 *    large and whose coverage is small is a linker problem, not a card problem, and the two
 *    numbers together say which.
 *
 * The unit is characters, not tokens. A token count would need the provider, and this
 * instrument's whole point is that it runs without one; characters are proportional to tokens
 * for English text and the ratio is not assumed anywhere.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachDefinitions, buildAskMessages, renderSchemaCard } from '@agentix-e/nl2charts-ai';
import type { DatabaseProfile, PromptOptions, Recaller, SchemaTable } from '@agentix-e/nl2charts-ai';
import { conditionColumns } from './conditions.js';
import { buildSchema, loadDescriptions, loadQuestions, loadTables } from './data.js';
import type { BirdQuestion, BirdTable, ColumnNote } from './data.js';
import type { CaseRecord } from './gap.js';
import { graphOf } from './join-graph.js';
import { SHIPPED_ARM, requireArm } from './presence.js';
import { CANDIDATE_RECALLERS, SHIPPED_RECALLERS, linkedTables, pruneSchema } from './prune.js';
import { promptFor, renderableArm, resolveArm, resolveLayout } from './run.js';
import type { Arm, BirdLayout } from './run.js';
import { attachSamples, narrowSamples, sampleValuesOf } from './samples.js';
import { definesOwnName, referencedFields, tableRefs } from './statement.js';
import { EXAMPLE_RULE, exampleMapOf } from './value-examples.js';
import type { ExampleSet } from './value-examples.js';

/** How much of a case's gold tables a proposal keeps. */
export const COVERAGES = ['all', 'some', 'none'] as const;
export type Coverage = (typeof COVERAGES)[number];


/** The character cost of one prompt, split by the block that spent it. */
export interface PromptCost {
  readonly system: number;
  readonly user: number;
  readonly rules: number;
  readonly card: number;
  readonly context: number;
  readonly hint: number;
  readonly question: number;
}

/** The question is echoed in both messages, so it is measured once and attributed once. */
const QUESTION_HEADING = '\nQuestion: ';

/**
 * Split one prompt into the blocks that spent its characters.
 *
 * The marks are the ones `buildSqlPrompt` writes, and the two checks at the end are what make
 * this a measurement rather than a guess: the system message must end with the question it was
 * built for, and the user message must too. A prompt that fails either is not the prompt the
 * pipeline sends, and every share computed from it would be about a different prompt.
 */
export function costOf(system: string, user: string, question: string): PromptCost {
  const at = system.indexOf(QUESTION_HEADING);
  if (at === -1) throw new Error(`card: the prompt has no ${JSON.stringify(QUESTION_HEADING)} heading`);
  if (!system.endsWith(QUESTION_HEADING + question)) throw new Error('card: the prompt does not end with its question');
  if (!user.endsWith(question)) throw new Error('card: the user turn does not end with the question');
  const head = system.slice(0, at);
  const schemaAt = head.indexOf('\nSchema:\n');
  if (schemaAt === -1) throw new Error('card: the prompt has no schema card');
  const rules = head.slice(0, schemaAt);
  const rest = head.slice(schemaAt + '\nSchema:\n'.length);
  // The card ends where the first context block begins. Every block `buildSqlPrompt` can write
  // after the card starts with its own heading, and the question heading is the fallback.
  const contextAt = CONTEXT_HEADS.map((heading) => rest.indexOf(heading)).filter((index) => index !== -1).sort((a, b) => a - b)[0];
  const card = contextAt === undefined ? rest : rest.slice(0, contextAt);
  const context = contextAt === undefined ? '' : rest.slice(contextAt);
  return {
    system: system.length,
    user: user.length,
    rules: rules.length,
    card: card.length,
    context: context.length,
    hint: user.length - question.length,
    question: question.length,
  };
}

/** The headings `buildSqlPrompt` can place between the card and the question. */
const CONTEXT_HEADS = [
  '\nSemantics:\n',
  '\nEvidence: ',
  '\nInterpretation: ',
  '\nPlan:\n',
  '\nValues in this database named by the question:\n',
  '\nExamples from other databases',
] as const;

/**
 * The characters each table costs in a card rendered with these options.
 *
 * Rendered one table at a time by the function that renders the whole card, so the per-table
 * numbers are the render's own and not a second implementation of it. The trailing newline is
 * charged to the table because the card joins its lines with one.
 */
export function tableChars(schema: readonly SchemaTable[], options: PromptOptions): Map<string, number> {
  const byTable = new Map<string, number>();
  const limit = options.schemaLines ?? 40;
  for (const table of schema) {
    byTable.set(table.table.toLowerCase(), renderSchemaCard([table], limit, options).length + 1);
  }
  return byTable;
}

/**
 * The tables a gold statement reads, lower-cased because a card may spell them otherwise.
 *
 * A CTE is not a table. `with a as (select ...), b as (select ...) select * from a join b` reads
 * one table that is not written here at all, and counting `a` and `b` would make the coverage of
 * that case permanently short of `all` — a defect in the instrument that reads as a linker failure.
 * Names the statement defines itself are left out; `classifyGold` in the join instrument is where
 * the distinction is also reported rather than only applied.
 */
export function goldTables(sql: string): Set<string> {
  return new Set(
    tableRefs(sql)
      .map((ref) => ref.table.toLowerCase())
      .filter((name) => !definesOwnName(sql, name)),
  );
}

/** How much of the gold's table set a proposal keeps. */
export function coverage(gold: ReadonlySet<string>, kept: ReadonlySet<string>): Coverage {
  const hit = [...gold].filter((table) => kept.has(table)).length;
  if (hit === gold.size) return 'all';
  return hit === 0 ? 'none' : 'some';
}

/**
 * One field, spelled the way both sides can compare it.
 *
 * The pair rather than the name, because `id` exists on most of BIRD's tables and a set of names
 * would report a perfect linker for naming the wrong table's `id`. Case-folded because a card may
 * spell a column `Qty` and a gold statement `qty`.
 */
export function fieldKey(table: string, column: string): string {
  return `${table.toLowerCase()}\u0000${column.toLowerCase()}`;
}

/**
 * What a field-level rule would keep of a case, and what it would cost.
 *
 * `total` counts the fields the gold statement names that this card can actually offer: a name the
 * card does not have is not a field of the card, so a rule cannot keep it or lose it. `linked` is how
 * many of them the shipped linker names. `spare` is the other direction — the linked fields the gold
 * never names — and it is the price side: a filter keeps them, pays for them, and gains nothing.
 *
 * `total` of zero is not a miss. `count(*)` names no column of the table it counts from, a
 * `select 1` names no table, and both are cases where the extractor abstained rather than failed;
 * the tally keeps them in their own bucket so an abstention is never read as a linker error.
 */
export interface FieldCoverage {
  readonly total: number;
  readonly linked: number;
  readonly spare: number;
  readonly coverage: Coverage;
}

/**
 * The fields a gold statement names, restricted to the ones a card can offer.
 *
 * Two forms, two rules. A qualified pair names its table and is kept if that table is one the
 * statement reads and has that column. A bare name belongs to every table the statement reads that
 * has a column of that name — the same over-keeping the card ceiling uses, and for the same reason:
 * the linker cannot tell them apart either, and under-counting here would make a realizable rule's
 * coverage look worse than it is while making its risk look smaller.
 */
export function goldFieldKeys(sql: string, schema: readonly SchemaTable[]): Set<string> {
  const read = new Set(tableRefs(sql).map((ref) => ref.table.toLowerCase()));
  const columns = new Map<string, Set<string>>();
  for (const table of schema) {
    columns.set(table.table.toLowerCase(), new Set(table.columns.map((column) => column.name.toLowerCase())));
  }
  const keys = new Set<string>();
  const add = (table: string, column: string): void => {
    const known = columns.get(table);
    if (known === undefined || !known.has(column)) return;
    keys.add(fieldKey(table, column));
  };
  const fields = referencedFields(sql);
  for (const field of fields.qualified) {
    if (read.has(field.table)) add(field.table, field.column);
  }
  for (const name of fields.bare) {
    for (const table of read) add(table, name);
  }
  return keys;
}

/**
 * The fields a linker names, in the same spelling `goldFieldKeys` produces.
 *
 * One path, and it is the prompt's: `buildAskMessages` is what the arm sends, so a linker read here
 * is the linker the question will meet. `topK` is passed through rather than re-implemented — the
 * curve in `FIELD_TOPS` is the same function at a larger budget, not a second linker that could
 * disagree with the first about which columns a question is about.
 */
export function linkedFieldKeys(
  question: string,
  schema: readonly SchemaTable[],
  recallers: readonly Recaller[],
  topK = 12,
): Set<string> {
  const linked = buildAskMessages({ question, schema, linking: true, recallers, topK }).linked;
  return new Set(linked.map((column) => fieldKey(column.table, column.column)));
}

/**
 * The linker budgets a card rule could be built at, from the shipped one up.
 *
 * The ceiling arm removed 93.5% of the card while losing nothing the gold reads, and the shipped
 * linker names 31% of the gold's fields — so the question a filter has to answer is not "is the card
 * too big" but "at what budget does the linker name enough of the fields". This is that budget, and
 * the reading is a frontier: recall against the fields kept, not a single number.
 */
export const FIELD_TOPS = [12, 24, 48, 96] as const;

/** What one budget would keep, over the cases an arm ran. */
export interface FieldBudget {
  readonly topK: number;
  /** The fields named per case, averaged. The card a rule would send is roughly this wide. */
  readonly kept: number;
  /** How many of the gold's fields the linker names at this budget, summed. */
  readonly linked: number;
  /** The cases where every field the gold names is named, at this budget. */
  readonly covered: number;
}

/** How many of the gold's fields a proposal names, and what it would keep that the gold never names. */
export function fieldCoverage(gold: ReadonlySet<string>, linked: ReadonlySet<string>): FieldCoverage {
  if (gold.size === 0) return { total: 0, linked: 0, spare: linked.size, coverage: 'none' };
  let hit = 0;
  for (const key of gold) if (linked.has(key)) hit += 1;
  let spare = 0;
  for (const key of linked) if (!gold.has(key)) spare += 1;
  return { total: gold.size, linked: hit, spare, coverage: hit === gold.size ? 'all' : hit === 0 ? 'none' : 'some' };
}

/** What one case costs, and what each proposal would keep of it. */
export interface CardRow {
  readonly id: string;
  readonly calls: number;
  readonly cost: PromptCost;
  readonly tables: number;
  readonly goldTables: number;
  readonly goldChars: number;
  /** The card's characters that belong to tables the gold statement never reads. */
  readonly spareChars: number;
  readonly shipped: Coverage;
  readonly candidate: Coverage;
  readonly shippedTables: number;
  readonly candidateTables: number;
  /**
   * What the card this arm sends keeps of the gold's tables.
   *
   * `shipped` and `candidate` are about the *linker*: how many of the gold's tables the recallers
   * named. An arm that removes tables changes the answer, and the removed table is the risk the
   * lever is priced on — a card that lost a table the gold reads cannot be asked about it. Reported
   * separately rather than folded in, so a linker that named nothing and a rule that dropped
   * something are two numbers instead of one ambiguous one.
   */
  readonly carded: Coverage;
  /** The gold's tables the card shows, counted rather than bucketed. */
  readonly cardedKept: number;
  /**
   * The same question one level down, at the field rather than the table.
   *
   * Tables are the unit a linker is documented in and fields are the unit the card is priced in: the
   * ceiling arm showed 93.5% of the columns can go while nothing the gold reads is lost, and a rule
   * that keeps whole tables cannot reach that. This is the count that says whether a field-level rule
   * exists at all — the linker's recall of the gold's fields, and the fields it names that the gold
   * never does.
   */
  readonly fields: FieldCoverage;
}

export interface CardTally {
  readonly total: number;
  readonly calls: number;
  readonly cost: PromptCost;
  /** The case-weighted mean of a per-case share, because a case is the unit of work. */
  readonly cardShare: number;
  readonly spareShare: number;
  readonly goldChars: number;
  readonly spareChars: number;
  readonly tables: number;
  readonly goldTables: number;
  readonly shipped: Readonly<Record<Coverage, number>>;
  readonly candidate: Readonly<Record<Coverage, number>>;
  readonly shippedKept: number;
  readonly candidateKept: number;
  readonly carded: Readonly<Record<Coverage, number>>;
  readonly cardedKept: number;
  /** The gold's fields the linker named, summed; the denominator is `fieldTotal`. */
  readonly fieldTotal: number;
  readonly fieldLinked: number;
  readonly fieldSpare: number;
  /** Field-level coverage, over the cases that name a field at all. `fieldEmpty` holds the rest. */
  readonly fieldCoverage: Readonly<Record<Coverage, number>>;
  readonly fieldEmpty: number;
}

/**
 * The sums, and the two shares a reader can act on.
 *
 * The shares are means over cases rather than ratios of sums: a database with a wide card would
 * otherwise dominate the number, and the question "how much of a typical prompt is the card" is
 * about a typical prompt.
 */
export function tallyCards(rows: readonly CardRow[]): CardTally {
  const zero = (): Record<Coverage, number> => ({ all: 0, some: 0, none: 0 });
  const total: { -readonly [K in keyof PromptCost]: number } = {
    system: 0,
    user: 0,
    rules: 0,
    card: 0,
    context: 0,
    hint: 0,
    question: 0,
  };
  const shipped = zero();
  const candidate = zero();
  const carded = zero();
  const fieldCovered = zero();
  const sum = { calls: 0, tables: 0, goldTables: 0, goldChars: 0, spareChars: 0, shippedKept: 0, candidateKept: 0, cardedKept: 0, cardShare: 0, spareShare: 0, fieldTotal: 0, fieldLinked: 0, fieldSpare: 0, fieldEmpty: 0 };
  for (const row of rows) {
    for (const key of Object.keys(total) as (keyof PromptCost)[]) total[key] += row.cost[key];
    shipped[row.shipped] += 1;
    candidate[row.candidate] += 1;
    carded[row.carded] += 1;
    sum.calls += row.calls;
    sum.tables += row.tables;
    sum.goldTables += row.goldTables;
    sum.goldChars += row.goldChars;
    sum.spareChars += row.spareChars;
    sum.shippedKept += row.shippedTables;
    sum.candidateKept += row.candidateTables;
    sum.cardedKept += row.cardedKept;
    sum.fieldTotal += row.fields.total;
    sum.fieldLinked += row.fields.linked;
    sum.fieldSpare += row.fields.spare;
    // An abstention is not a miss: `count(*)` names no field of the table it counts from, and
    // bucketing those cases as `none` would publish the extractor's limits as a linker failure.
    if (row.fields.total === 0) sum.fieldEmpty += 1;
    else fieldCovered[row.fields.coverage] += 1;
    const cardTotal = row.cost.card === 0 ? 1 : row.cost.card;
    sum.cardShare += row.cost.card / (row.cost.system + row.cost.user);
    sum.spareShare += row.spareChars / cardTotal;
  }
  const n = rows.length === 0 ? 1 : rows.length;
  return {
    total: rows.length,
    calls: sum.calls,
    cost: total,
    cardShare: sum.cardShare / n,
    spareShare: sum.spareShare / n,
    goldChars: sum.goldChars,
    spareChars: sum.spareChars,
    tables: sum.tables,
    goldTables: sum.goldTables,
    shipped,
    candidate,
    shippedKept: sum.shippedKept,
    candidateKept: sum.candidateKept,
    carded,
    cardedKept: sum.cardedKept,
    fieldTotal: sum.fieldTotal,
    fieldLinked: sum.fieldLinked,
    fieldSpare: sum.fieldSpare,
    fieldCoverage: fieldCovered,
    fieldEmpty: sum.fieldEmpty,
  };
}

/**
 * The lines a reader sees.
 *
 * Absolute counts first, shares second: "eleven per cent" of a prompt is not a work item until
 * it is a number of characters per question and a number of calls.
 */
export function cardLines(tally: CardTally, budget: readonly FieldBudget[] = []): string[] {
  const n = tally.total === 0 ? 1 : tally.total;
  const per = (value: number): number => Math.round(value / n);
  const pct = (value: number, of: number): string => (of === 0 ? '0.0%' : `${((value / of) * 100).toFixed(1)}%`);
  const sent = tally.cost.system + tally.cost.user;
  const out = ['what the prompt costs, and what a smaller card would save', ''];
  out.push(`  ${'rules'.padEnd(10)} ${String(per(tally.cost.rules)).padStart(6)} chars  ${pct(tally.cost.rules, sent).padStart(6)}`);
  out.push(`  ${'schema'.padEnd(10)} ${String(per(tally.cost.card)).padStart(6)} chars  ${pct(tally.cost.card, sent).padStart(6)}`);
  out.push(`  ${'context'.padEnd(10)} ${String(per(tally.cost.context)).padStart(6)} chars  ${pct(tally.cost.context, sent).padStart(6)}`);
  out.push(`  ${'hint'.padEnd(10)} ${String(per(tally.cost.hint)).padStart(6)} chars  ${pct(tally.cost.hint, sent).padStart(6)}`);
  out.push(`  ${'question'.padEnd(10)} ${String(per(tally.cost.question)).padStart(6)} chars  ${pct(tally.cost.question, sent).padStart(6)}`);
  out.push(`  ${'per call'.padEnd(10)} ${String(per(sent)).padStart(6)} chars  ${pct(tally.cost.card, sent)} of it is the card`);
  out.push(
    `  ${'per case'.padEnd(10)} ${String(per(sent * (tally.calls / n))).padStart(6)} chars  over ${(tally.calls / n).toFixed(2)} calls`,
  );
  out.push('');
  out.push(`  the card shows ${(tally.tables / n).toFixed(1)} tables; the gold statement reads ${(tally.goldTables / n).toFixed(1)}`);
  out.push(
    `  ${pct(tally.goldChars, tally.goldChars + tally.spareChars)} of the card belongs to a table the gold reads, so a linker that never errs removes ${pct(tally.spareChars, tally.goldChars + tally.spareChars)} of it`,
  );
  out.push(
    `  the shipped linker keeps ${(tally.shippedKept / n).toFixed(1)} tables: all of the gold's ${String(tally.shipped.all)}, some of it ${String(tally.shipped.some)}, none of it ${String(tally.shipped.none)}`,
  );
  out.push(
    `  with the table recaller  keeps ${(tally.candidateKept / n).toFixed(1)} tables: all of the gold's ${String(tally.candidate.all)}, some of it ${String(tally.candidate.some)}, none of it ${String(tally.candidate.none)}`,
  );
  // The card is the lever. A rule that removes tables is priced on what it removed, and the two
  // lines above cannot say it: they are about the linker, and the linker is the same on both arms.
  out.push(
    `  the card this arm sends keeps ${(tally.cardedKept / n).toFixed(1)} of the gold's ${(tally.goldTables / n).toFixed(1)} tables: all ${String(tally.carded.all)}, some ${String(tally.carded.some)}, none ${String(tally.carded.none)}`,
  );
  // The unit the card is priced in. The ceiling arm removed 93.5% of the columns while losing nothing
  // the gold reads, and a table-level rule cannot reach that: most of those columns belong to tables
  // the gold *does* read. This is the count a field-level rule has to be argued against, and the
  // second line is its price — the fields it would keep and pay for, which the gold never names.
  out.push(
    `  the shipped linker names ${(tally.fieldLinked / n).toFixed(1)} of the gold's ${(tally.fieldTotal / n).toFixed(1)} fields (${pct(tally.fieldLinked, tally.fieldTotal)}): all of them on ${String(tally.fieldCoverage.all)} cases, some on ${String(tally.fieldCoverage.some)}, none on ${String(tally.fieldCoverage.none)}; ${String(tally.fieldEmpty)} name no field`,
  );
  out.push(`  it also names ${(tally.fieldSpare / n).toFixed(1)} fields the gold never does, which a field rule would keep and pay for`);
  // The frontier, when one was measured. A single budget says what the linker does; the curve says
  // whether the budget is what limits it, which is the difference between raising `topK` and
  // replacing the recallers.
  for (const entry of budget) {
    out.push(
      `  at ${String(entry.topK).padStart(2)} fields: ${pct(entry.linked, tally.fieldTotal)} of the gold's fields, keeping ${entry.kept.toFixed(1)} fields and covering every one of them on ${String(entry.covered)} cases`,
    );
  }
  return out;
}

/**
 * Whether the measurement is worth publishing.
 *
 * There is no target share: a card that is most of the prompt is a fact about the card, not a
 * defect, and the sparing share is a ceiling rather than a goal. What can be wrong is the
 * instrument, and it can be wrong in three ways, all absolute:
 *
 * 1. Nothing was read — an empty population, or an artifact whose `cases` predate `calls`.
 * 2. A case was dropped, because the artifact does not carry the definitions the card was built
 *    from or because the arm's prompt needs a block the artifact does not keep.
 * 3. The prompt rebuilt here is not the one that was sent: it does not end with its question.
 */
export function cardProblems(input: {
  readonly tally: CardTally;
  readonly definitionGap: number;
  readonly unrenderable: number;
}): string[] {
  const problems: string[] = [];
  // One root cause, not two symptoms: when every case was dropped the drop is the diagnosis,
  // and "nothing was read" would only restate it.
  if (input.tally.total === 0 && input.definitionGap === 0 && input.unrenderable === 0) {
    problems.push('CARD: no case could be read, so nothing about the prompt was measured');
  }
  if (input.definitionGap > 0) {
    problems.push(
      `CARD: ${String(input.definitionGap)} case(s) are in a database whose synthesized definitions the artifact does not carry, so the card rendered for them is not the card that was sent`,
    );
  }
  if (input.unrenderable > 0) {
    problems.push(
      `CARD: ${String(input.unrenderable)} case(s) belong to an arm whose prompt needs a block the artifact does not keep, so the prompt this tool renders is not the one that was sent`,
    );
  }
  // The field line is the fourth way this instrument can be wrong, and it is the quietest: an
  // extractor that stopped recognising gold statements publishes a recall of zero, which reads as
  // "the linker names nothing" rather than "the reader is broken". Both thresholds are absolute and
  // deliberately loose — a real corpus has some `count(*)`, not half of them.
  if (input.tally.total > 0 && input.tally.fieldTotal === 0) {
    problems.push('CARD: the field reader named no field on any case, so the field recall is a broken reader rather than a linker measurement');
  }
  if (input.tally.total > 0 && input.tally.fieldEmpty * 2 > input.tally.total) {
    problems.push(
      `CARD: ${String(input.tally.fieldEmpty)} of ${String(input.tally.total)} cases name no field, which is more abstentions than a corpus of statements can produce — the field reader is not being read`,
    );
  }
  return problems;
}

/** One arm's cost in the endpoint's own unit, as the artifact recorded it. */
export interface BilledRow {
  readonly arm: string;
  /** Mean calls per case, which is the denominator of every per-call number below. */
  readonly calls: number;
  /** Mean characters per call, counted from the requests the endpoint answered. */
  readonly charsPerCall: number;
  readonly promptTokensPerCall: number;
  readonly completionTokensPerCase: number;
  /** Answers that arrived without a usage block: calls whose cost is unknown, not zero. */
  readonly unbilled: number;
  /**
   * Characters per prompt token.
   *
   * The calibration the zero-call instruments cannot get on their own. They count characters
   * because they never touch a provider; the ratio is what turns that count into an estimate of
   * what a request costs, and a ratio outside the range any tokenizer produces is the one way the
   * two measurements can disagree loudly rather than quietly.
   */
  readonly charsPerToken: number;
  /** True when the artifact has no token column at all: nothing was metered. */
  readonly unmetered: boolean;
  /** The case total the per-purpose split is checked against. */
  readonly promptTokensPerCase: number;
  /** The same cost split by what each call was for. Absent on an artifact written before it. */
  readonly byPurpose?: Readonly<Record<string, { readonly calls?: number; readonly prompt?: number }>>;
}

/** A report as this instrument reads it, for the cost table. */
export interface BilledReportShape {
  readonly arms?: readonly {
    readonly arm?: string;
    readonly calls?: { readonly mean?: number };
    readonly tokens?: {
      readonly prompt?: number;
      readonly completion?: number;
      readonly chars?: number;
      readonly unbilled?: number;
      readonly byPurpose?: Readonly<Record<string, { readonly calls?: number; readonly prompt?: number }>>;
    };
  }[];
}

/**
 * What each arm was billed, per call.
 *
 * Absent is not zero. An artifact written before the meter existed carries no `tokens`, and a
 * provider that answers without a usage block carries `unbilled` — both are states in which the
 * cost column means nothing, and both are reported rather than filled in with zeros. The third
 * state, a report with calls and a token column of zeros, is the one that would otherwise read as
 * free work, and it is what `billedProblems` fails on.
 */
export function billedRows(report: BilledReportShape): BilledRow[] {
  const rows: BilledRow[] = [];
  for (const arm of report.arms ?? []) {
    const name = arm.arm;
    if (name === undefined) continue;
    const calls = arm.calls?.mean ?? 0;
    const tokens = arm.tokens;
    const promptTokens = tokens?.prompt ?? 0;
    // Both per-call means come from the same calls: the characters are the text of the requests
    // the meter saw, not the system message this tool rebuilds. That is the only pairing under
    // which "characters per token" is a fact about a request rather than about two of them.
    const perCall = calls > 0 ? promptTokens / calls : 0;
    const perCallChars = calls > 0 ? (tokens?.chars ?? 0) / calls : 0;
    rows.push({
      arm: name,
      calls,
      charsPerCall: Math.round(perCallChars),
      promptTokensPerCall: Math.round(perCall),
      completionTokensPerCase: tokens?.completion ?? 0,
      unbilled: tokens?.unbilled ?? 0,
      charsPerToken: perCall > 0 ? Number((perCallChars / perCall).toFixed(2)) : 0,
      unmetered: tokens === undefined,
      promptTokensPerCase: promptTokens,
      ...(tokens?.byPurpose === undefined ? {} : { byPurpose: tokens.byPurpose }),
    });
  }
  return rows;
}

/** The billed table, printed under the character table because it is the same cost in another unit. */
export function billedLines(rows: readonly BilledRow[]): string[] {
  if (rows.length === 0) return [];
  const out = ['', 'what the provider billed, per case and per call', ''];
  out.push(`  ${'arm'.padEnd(22)} ${'calls'.padStart(6)} ${'chars/call'.padStart(11)} ${'tokens/call'.padStart(12)} ${'chars/token'.padStart(12)} ${'completion'.padStart(11)} ${'unbilled'.padStart(9)}`);
  for (const row of rows) {
    out.push(
      `  ${row.arm.padEnd(22)} ${row.calls.toFixed(2).padStart(6)} ${String(row.charsPerCall).padStart(11)} ` +
        `${(row.unmetered ? 'not metered' : String(row.promptTokensPerCall)).padStart(12)} ` +
        `${(row.charsPerToken === 0 ? '-' : row.charsPerToken.toFixed(2)).padStart(12)} ` +
        `${String(row.completionTokensPerCase).padStart(11)} ${String(row.unbilled).padStart(9)}`,
    );
  }
  const total = billedTotal(rows);
  if (total > 0) {
    // The one number the table left to the reader. A push pays for every arm in the chain, so
    // the sum is the bill; leaving it as an exercise is how the chain grew to 23,840 prompt
    // tokens a question one arm at a time without any single step looking expensive.
    out.push('', `  chain: ${String(total)} prompt tokens a question over ${String(rows.length)} arms`);
  }
  return out;
}

/**
 * What the arms in one report cost a question, summed.
 *
 * `promptTokensPerCase` is already an average over the cases the arm scored, so the sum is the
 * per-question bill of running this chain once — which is what a push buys. It is deliberately
 * a sum over arms and not over calls: two arms with different prompts are two runs.
 */
export function billedTotal(rows: readonly BilledRow[]): number {
  return rows.reduce((total, row) => total + row.promptTokensPerCase, 0);
}

/**
 * What each kind of call cost, and what share of the arm's bill it is.
 *
 * The split exists because a four-call arm buys three different things — a statement, a
 * selector's judgement, and extra draws — and a single number makes "the selector earns its
 * tokens" an opinion. The share is taken over the case total the meter wrote beside it, so the
 * two columns check each other; `billedProblems` fails a split that does not add up.
 */
export interface PurposeRow {
  readonly arm: string;
  readonly purpose: string;
  readonly calls: number;
  readonly promptTokensPerCase: number;
  /** This purpose's prompt tokens over the arm's per-case total, 0..1. Zero when that is zero. */
  readonly share: number;
}

/** Every arm's split, largest first, so the table reads like the bill it describes. */
export function purposeRows(report: BilledReportShape): PurposeRow[] {
  const rows: PurposeRow[] = [];
  for (const arm of report.arms ?? []) {
    const name = arm.arm;
    const split = arm.tokens?.byPurpose;
    if (name === undefined || split === undefined) continue;
    const total = arm.tokens?.prompt ?? 0;
    for (const [purpose, usage] of Object.entries(split)) {
      const prompt = usage.prompt ?? 0;
      rows.push({
        arm: name,
        purpose,
        calls: usage.calls ?? 0,
        promptTokensPerCase: prompt,
        share: total > 0 ? Number((prompt / total).toFixed(4)) : 0,
      });
    }
  }
  // Arm, then cost, then name: two buckets that cost the same still print in one order, so a diff of
  // two artifacts is a diff of measurements rather than of insertion order.
  return rows.sort(
    (left, right) =>
      left.arm.localeCompare(right.arm) ||
      right.promptTokensPerCase - left.promptTokensPerCase ||
      left.purpose.localeCompare(right.purpose),
  );
}

/** The split table, printed under the billed table because it explains one row of it. */
export function purposeLines(rows: readonly PurposeRow[]): string[] {
  if (rows.length === 0) return [];
  const out = ['', 'what each kind of call cost, per case', ''];
  out.push(`  ${'arm'.padEnd(22)} ${'call'.padStart(12)} ${'calls'.padStart(6)} ${'tokens'.padStart(9)} ${'share'.padStart(8)}`);
  for (const row of rows) {
    out.push(
      `  ${row.arm.padEnd(22)} ${row.purpose.padStart(12)} ${row.calls.toFixed(2).padStart(6)} ` +
        `${String(row.promptTokensPerCase).padStart(9)} ${`${(row.share * 100).toFixed(1)}%`.padStart(8)}`,
    );
  }
  // The rows above are only actionable if the reader knows which of them is a purchase rather
  // than a requirement: a statement has to be written, a judgement has to earn its place.
  out.push('', "  'select' and 'compare' are the selector's calls: they read the candidates and answer one digit.");
  return out;
}

/**
 * Whether the billed column can be published.
 *
 * Three absolute failures, none of them a target: a report that made calls and metered none, a
 * provider that answered without a price, and a character count that cannot be the same text as
 * the token count it is paired with. A ratio below half a character per token means the two
 * columns describe different requests — the only way these two measurements can contradict each
 * other without either of them looking wrong on its own.
 */
export function billedProblems(rows: readonly BilledRow[]): string[] {
  const problems: string[] = [];
  const unmetered = rows.filter((row) => row.calls > 0 && row.unmetered).map((row) => row.arm);
  if (unmetered.length > 0) {
    problems.push(
      `CARD: ${unmetered.join(', ')} made calls the artifact did not meter, so the token column would publish a measurement of nothing`,
    );
  }
  const silent = rows.filter((row) => !row.unmetered && row.calls > 0 && row.promptTokensPerCall === 0).map((row) => row.arm);
  if (silent.length > 0) {
    problems.push(`CARD: ${silent.join(', ')} reports calls and zero prompt tokens, which is a meter that did not run rather than a free request`);
  }
  const unbilled = rows.filter((row) => row.unbilled > 0);
  if (unbilled.length > 0) {
    problems.push(
      `CARD: ${unbilled.map((row) => `${row.arm} (${String(row.unbilled)})`).join(', ')} answered without a usage block, so the cost of those calls is unknown and the column understates it`,
    );
  }
  const impossible = rows.filter((row) => !row.unmetered && row.charsPerToken > 0 && row.charsPerToken < 0.5).map((row) => row.arm);
  if (impossible.length > 0) {
    problems.push(
      `CARD: ${impossible.join(', ')} reports fewer than half a character per token, so the character count and the token count describe different prompts`,
    );
  }
  // Two failures of the split, and neither is a target. A call with no purpose inflates the whole
  // and belongs to no row, so every other bucket's share is taken over money nobody can name. A
  // split that does not add up to the total means one of the two is recounted somewhere else, and
  // a share divided by a total it does not add up to is not a share.
  const anonymous = rows
    .map((row) => ({ arm: row.arm, calls: row.byPurpose?.unlabelled?.calls ?? 0 }))
    .filter((entry) => entry.calls > 0);
  if (anonymous.length > 0) {
    problems.push(
      `CARD: ${anonymous.map((entry) => `${entry.arm} (${String(entry.calls)})`).join(', ')} spend calls that do not say what they were for, so every share of the bill is taken over money nobody can name`,
    );
  }
  const wrongSplit = rows.filter((row) => {
    if (row.byPurpose === undefined) return false;
    const sum = Object.values(row.byPurpose).reduce((total, part) => total + (part.prompt ?? 0), 0);
    return Math.abs(sum - row.promptTokensPerCase) > Math.max(1, row.promptTokensPerCase * 0.02);
  });
  if (wrongSplit.length > 0) {
    problems.push(
      `CARD: ${wrongSplit.map((row) => row.arm).join(', ')} report per-purpose splits that do not add up to the case total, so a share of them would be a share of the wrong number`,
    );
  }
  return problems;
}

/** Where a measurement reads and writes. */
export interface CardSettings {
  readonly report: string;
  readonly layout: BirdLayout;
  readonly arm: string;
  readonly out: string;
  readonly strict: boolean;
}

export function resolveCardSettings(
  env: Record<string, string | undefined>,
  argv: readonly string[],
  root: string,
): CardSettings {
  const flag = argv.indexOf('--arm');
  const named = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && named === undefined) throw new Error('--arm needs a name');
  const consumed = flag === -1 ? [] : [flag, flag + 1];
  const path = argv.find((item, index) => !item.startsWith('--') && !consumed.includes(index));
  if (path === undefined) throw new Error('usage: card.ts <report.json> [--arm <name>] [--strict]');
  const layout = resolveLayout(env, root);
  return { report: path, layout, arm: named ?? SHIPPED_ARM, out: dirname(layout.out), strict: argv.includes('--strict') };
}

export interface CardDrops {
  readonly unknownQuestion: number;
  readonly unknownArm: number;
  readonly definitionGap: number;
  readonly unrenderable: number;
}

export interface CardOutcome {
  readonly split: string;
  readonly arm: string;
  readonly rows: readonly CardRow[];
  readonly tally: CardTally;
  readonly drops: CardDrops;
  /** Every arm the artifact billed, not only the one this invocation measured. */
  readonly billed: readonly BilledRow[];
  /** How much of each arm's bill each kind of call is. Empty on an artifact written before the split. */
  readonly purposes: readonly PurposeRow[];
  /**
   * The linker budget frontier: the same recallers at `FIELD_TOPS`, over the same cases.
   *
   * A filter's viability is a ratio of two things this table holds — how many gold fields the linker
   * names, and how many fields it names at all — so publishing either alone would let a reader pick
   * the half that flatters a proposal.
   */
  readonly fieldBudget: readonly FieldBudget[];
  readonly problems: readonly string[];
}

/** A report as this instrument reads it. */
export interface CardReportShape {
  readonly split?: string;
  readonly cases?: readonly CaseRecord[];
  readonly controls?: { readonly synthesizedDefinitions?: Readonly<Record<string, string>> };
}

/**
 * The stored values an arm's card carries, read from the cache the run fills.
 *
 * Two rules, two caches, and one identity: `samples: 'profile'` is the profiler's top spellings
 * of every categorical column, `samples: 'example'` is MAC-SQL's rule over every non-key column.
 * Neither is derivable here — a profile needs a database and this instrument has none — so a
 * missing cache throws instead of returning an empty map. An empty map renders a card without a
 * block, which is the parent's card, which is the defect this function exists to remove.
 *
 * The example cache carries the rule that wrote it, so a stale block is refused rather than
 * priced: the run would have rebuilt it, and the difference between the two rules is exactly the
 * thing a price is supposed to attribute.
 */
export function storedValuesFor(
  arm: Pick<Arm, 'name' | 'samples'>,
  db: string,
  layout: BirdLayout,
): Map<string, readonly string[]> | undefined {
  if (arm.samples === undefined) return undefined;
  if (arm.samples === 'profile') {
    const file = join(layout.profileCache, `${db}.json`);
    if (!existsSync(file)) {
      throw new Error(`arm ${arm.name} carries the profiled values on its card and there is no profile for ${db} at ${file}`);
    }
    return sampleValuesOf(JSON.parse(readFileSync(file, 'utf8')) as DatabaseProfile);
  }
  const file = join(layout.exampleCache, `${db}.json`);
  if (!existsSync(file)) {
    throw new Error(`arm ${arm.name} carries the competitor's examples on its card and there is no example set for ${db} at ${file}`);
  }
  const set = JSON.parse(readFileSync(file, 'utf8')) as ExampleSet;
  if (set.rule !== EXAMPLE_RULE) {
    throw new Error(`the example set for ${db} was written by ${String(set.rule)} and this instrument prices ${EXAMPLE_RULE}, so the block it would measure is not the one sent`);
  }
  return exampleMapOf(set);
}

/**
 * The same block, read once per database.
 *
 * Two instruments render a card from the same arm — `card` and `join` — and both need the block
 * or neither prices the arm it was given. One reader is what keeps them from disagreeing about
 * which card an arm sends, which is the shape of every defect in this file's history.
 */
export function blockReader(
  arm: Pick<Arm, 'name' | 'samples'>,
  layout: BirdLayout,
): (db: string) => Map<string, readonly string[]> | undefined {
  const cache = new Map<string, Map<string, readonly string[]> | undefined>();
  return (db: string) => {
    if (!cache.has(db)) cache.set(db, storedValuesFor(arm, db, layout));
    return cache.get(db);
  };
}

/** One case's two messages, built by the function the pipeline sends. */
export function promptOf(
  arm: Arm,
  question: BirdQuestion,
  definitions: string,
  tables: BirdTable,
  notes?: Map<string, Map<string, ColumnNote>>,
  values?: ReadonlyMap<string, readonly string[]>,
): { system: string; user: string; schema: readonly SchemaTable[] } {
  const options = promptFor(arm, question, {});
  // Which arms take their column comments from the dataset, and which from a generated
  // definition block. `select` renders comments too — they are the definitions
  // `attachDefinitions` wrote — so `descriptions` alone is the wrong test: it is true for both,
  // and reading it here would demand dataset notes for a prompt that never carries them.
  const sendsNotes = options.descriptions === true && arm.notes === true && arm.definitions !== 'inline' && arm.definitions !== 'dataset-subset';
  // An arm that sends column notes and an instrument that was handed none would measure a
  // prompt nobody sends — the defect this file exists to catch, in the one place it survived:
  // `metadata+evidence` is the cheapest arm on the frontier at 798 curated notes, and the card
  // report was pricing it without them.
  if (sendsNotes && notes === undefined) {
    throw new Error(`arm ${arm.name} sends column notes and this instrument was given none, so the prompt it would measure is not the one sent`);
  }
  // Where the comments come from, decided the way the run decides it: `schemaFor` attaches the
  // generated definitions only for the arms that ask for them, and the rest carry the dataset's
  // own notes or nothing. Attaching them to every arm was the second half of the same defect —
  // it made `metadata+evidence` pay for a definition block its prompt never contains.
  const withDefinitions = arm.definitions === 'inline' || arm.definitions === 'dataset-subset';
  const base = buildSchema(tables, notes ?? new Map(), { withNotes: sendsNotes });
  const card = withDefinitions ? attachDefinitions(base, definitions) : { schema: base };
  // The block is a lever, so it has to be on the card this instrument renders or the arm is
  // priced as its parent. It was not: `promptOf` never attached the values, `buildAskMessages`
  // was told `samples` and found nothing to render, and `bench:bird:card` reported
  // `inline+evidence+samples-gold` at the parent's characters to the tenth of a character. The
  // guard is the same shape as the one above it — a card that is missing the block its arm
  // declares is not the card that was sent, and an instrument that silently prices it is
  // measuring a prompt nobody sends.
  if (arm.samples !== undefined && values === undefined) {
    throw new Error(`arm ${arm.name} carries the stored values on its card and this instrument was given none, so the prompt it would measure is not the one sent`);
  }
  // The narrowing is the arm's, applied the way the run applies it: on the gold's filtered
  // columns for the oracle arm, on everything the profile kept for the rest.
  const wanted = arm.sampleColumns === 'gold' ? conditionColumns(question.SQL) : undefined;
  const block = values === undefined ? undefined : wanted === undefined ? values : narrowSamples(values, wanted);
  // Before the prune, because the run layers the block on the resolved card and prunes after it.
  const layered = block === undefined ? (card.schema as SchemaTable[]) : attachSamples(card.schema as SchemaTable[], block);
  // The prune arm sends the closure, so this instrument has to render the closure. Rebuilding
  // the whole card for it would measure a prompt nobody sends — the same defect the two
  // `information` fixes were about — and would report the arm as its parent with a longer name.
  const pruned =
    arm.prune === undefined
      ? layered
      : (pruneSchema({ schema: layered, question: question.question, graph: graphOf(tables), hops: arm.prune })
          .schema as SchemaTable[]);
  const schema = pruned;
  const built = buildAskMessages({
    question: question.question,
    schema,
    prompt: options,
    linking: arm.linking,
    samples: arm.samples !== undefined,
  });
  // Two messages by the builder's own return type, so there is nothing to fall back to: a
  // `?? ''` here would have been a branch no prompt can reach (ADR-219).
  return {
    system: built.messages[0].content,
    user: built.messages[1].content,
    schema,
  };
}

export async function runCard(settings: CardSettings): Promise<CardOutcome> {
  const report = JSON.parse(readFileSync(settings.report, 'utf8')) as CardReportShape;
  const arm = resolveArm(settings.arm);
  const questions = loadQuestions(settings.layout.questionsFile);
  const tables = loadTables(settings.layout.tablesFile);
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));
  const definitions = report.controls?.synthesizedDefinitions ?? {};
  const rows: CardRow[] = [];
  const curve = FIELD_TOPS.map((topK) => ({ topK, kept: 0, linked: 0, covered: 0 }));
  const drops = { unknownQuestion: 0, unknownArm: 0, definitionGap: 0, unrenderable: 0 };
  // Before the filter: an arm that is not in the artifact produces an empty table, and an empty
  // table prints as zeros in the same columns a measured zero would.
  const cases = requireArm(report.cases, settings.arm, settings.report).filter((row) => row.arm === settings.arm);
  // One database's descriptions, read once. The card report used to render every arm without
  // them, which made the cheapest arm on the frontier — a single call carrying 798 curated
  // notes — the one arm whose prompt this instrument could not price.
  const noteCache = new Map<string, Map<string, Map<string, ColumnNote>>>();
  const notesFor = (db: string, table: BirdTable): Map<string, Map<string, ColumnNote>> => {
    const cached = noteCache.get(db);
    if (cached !== undefined) return cached;
    const loaded = loadDescriptions(join(settings.layout.descriptionsRoot, db, 'database_description'), table.tableNames);
    noteCache.set(db, loaded);
    return loaded;
  };
  const seen = new Set<string>();
  if (arm === undefined) {
    drops.unknownArm = cases.length;
  } else if (!renderableArm(arm)) {
    drops.unrenderable = cases.length;
  } else {
    // One block per database, read once: a card arm carries the same block on every question of
    // one database, and reading the same file 498 times would make the instrument's cost the
    // corpus's size.
    const valuesFor = blockReader(arm, settings.layout);
    for (const row of cases) {
      const id = String(row.id);
      // A case appears once per arm; the split's own question file is what holds a duplicate
      // twice, and counting it twice would inflate the denominator this report publishes.
      if (seen.has(id)) continue;
      seen.add(id);
      const question = byId.get(id);
      if (question === undefined) {
        drops.unknownQuestion += 1;
        continue;
      }
      const table = tables.get(question.db_id);
      const text = definitions[question.db_id];
      if (table === undefined || (text === undefined && arm.definitions === 'inline')) {
        drops.definitionGap += 1;
        continue;
      }
      const built = promptOf(
        arm,
        question,
        text ?? '',
        table,
        arm.notes === true ? notesFor(question.db_id, table) : undefined,
        valuesFor(question.db_id),
      );
      // `costOf` throws rather than returning a sentinel: a prompt these builders produced
      // always decomposes, the end-to-end tests below assert that on a real split, and a case
      // silently dropped for a reason nobody can act on is worse than a loud failure.
      const cost = costOf(built.system, built.user, question.question);
      const chars = tableChars(built.schema, promptFor(arm, question, {}));
      const gold = goldTables(question.SQL);
      const shipped = linkedTables(question.question, built.schema, SHIPPED_RECALLERS);
      const candidate = linkedTables(question.question, built.schema, CANDIDATE_RECALLERS);
      // The same question one level down. Read from the card this arm renders, not from the plain
      // schema: the fields a rule could keep are the fields the prompt shows, and an instrument that
      // counted against a card the arm does not send would price a prompt nobody sends (ADR-219).
      const goldFields = goldFieldKeys(question.SQL, built.schema);
      const linked = linkedFieldKeys(question.question, built.schema, SHIPPED_RECALLERS);
      const fields = fieldCoverage(goldFields, linked);
      // The frontier, one budget at a time. The shipped budget reuses the set just built, so the
      // anchor of the curve is the same reading as the row rather than a second call that could
      // drift from it.
      for (const budget of curve) {
        const keys = budget.topK === 12 ? linked : linkedFieldKeys(question.question, built.schema, SHIPPED_RECALLERS, budget.topK);
        budget.kept += keys.size;
        budget.linked += fieldCoverage(goldFields, keys).linked;
        if (goldFields.size > 0 && [...goldFields].every((key) => keys.has(key))) budget.covered += 1;
      }
      // The tables the prompt shows are the keys of `chars`: one entry per table in the schema this
      // arm rendered, whatever rule produced it.
      const shown = new Set(chars.keys());
      let goldChars = 0;
      for (const name of gold) goldChars += chars.get(name) ?? 0;
      const total = [...chars.values()].reduce((sum, value) => sum + value, 0);
      rows.push({
        id,
        calls: typeof row.calls === 'number' ? row.calls : 1,
        cost,
        tables: chars.size,
        goldTables: gold.size,
        goldChars,
        spareChars: Math.max(0, total - goldChars),
        shipped: coverage(gold, shipped),
        candidate: coverage(gold, candidate),
        shippedTables: shipped.size,
        candidateTables: candidate.size,
        carded: coverage(gold, shown),
        cardedKept: [...gold].filter((name) => shown.has(name)).length,
        fields,
      });
    }
  }
  const tally = tallyCards(rows);
  const billed = billedRows(report as BilledReportShape);
  const problems = [
    ...cardProblems({
      tally,
      definitionGap: drops.definitionGap,
      unrenderable: drops.unrenderable + drops.unknownArm,
    }),
    ...billedProblems(billed),
  ];
  // Means over cases for the two quantities a reader compares, sums for the two they add: a frontier
  // is read as "at 24 the linker names 5.1 fields and 41% of the gold's", and both halves are per case.
  const n = rows.length === 0 ? 1 : rows.length;
  const fieldBudget = curve.map((budget) => ({
    topK: budget.topK,
    kept: budget.kept / n,
    linked: budget.linked,
    covered: budget.covered,
  }));
  return { split: settings.layout.split, arm: settings.arm, rows, tally, drops, billed, purposes: purposeRows(report as BilledReportShape), fieldBudget, problems };
}

export function cardPath(settings: CardSettings): string {
  return join(settings.out, `card-${settings.arm.replace(/[^a-z0-9+_-]/gi, '-')}.json`);
}

export function writeCardArtifact(settings: CardSettings, outcome: CardOutcome): string {
  const path = cardPath(settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(outcome, null, 2));
  return path;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const settings = resolveCardSettings(env, argv, root);
  const outcome = await runCard(settings);
  for (const line of cardLines(outcome.tally, outcome.fieldBudget)) console.log(line);
  for (const line of billedLines(outcome.billed)) console.log(line);
  for (const line of purposeLines(outcome.purposes)) console.log(line);
  console.log(
    `\n  dropped: ${String(outcome.drops.unknownQuestion)} unknown question, ${String(outcome.drops.definitionGap)} without definitions, ` +
      `${String(outcome.drops.unrenderable)} unrenderable arm, ${String(outcome.drops.unknownArm)} unknown arm`,
  );
  const path = writeCardArtifact(settings, outcome);
  console.log(`\nwrote ${path}`);
  for (const problem of outcome.problems) console.error(problem);
  if (outcome.problems.length === 0) return 0;
  return settings.strict ? 1 : 0;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
