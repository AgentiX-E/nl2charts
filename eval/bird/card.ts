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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachDefinitions, buildAskMessages, renderSchemaCard } from '@agentix-e/nl2charts-ai';
import type { PromptOptions, Recaller, SchemaTable } from '@agentix-e/nl2charts-ai';
import { buildSchema, loadQuestions, loadTables } from './data.js';
import type { BirdQuestion, BirdTable } from './data.js';
import type { CaseRecord } from './gap.js';
import { promptFor, renderableArm, resolveArm, resolveLayout } from './run.js';
import type { Arm, BirdLayout } from './run.js';
import { definesOwnName, tableRefs } from './statement.js';

/** How much of a case's gold tables a proposal keeps. */
export const COVERAGES = ['all', 'some', 'none'] as const;
export type Coverage = (typeof COVERAGES)[number];

/**
 * The recallers the product uses, and the set this instrument also prices.
 *
 * The second adds `table`, which is what a question that names an entity and none of its
 * columns needs. Keeping both lists here rather than deriving one from the other means the
 * report always shows the shipped number next to the candidate, which is the comparison a
 * reader has to make before an arm is worth a run.
 */
export const SHIPPED_RECALLERS: readonly Recaller[] = ['name', 'alias', 'value'];
export const CANDIDATE_RECALLERS: readonly Recaller[] = ['name', 'alias', 'value', 'table'];

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

/** The tables a linker keeps, at the budget the prompt can afford. */
export function linkedTables(question: string, schema: readonly SchemaTable[], recallers: readonly Recaller[]): Set<string> {
  const linked = buildAskMessages({ question, schema, linking: true, recallers }).linked;
  return new Set(linked.map((column) => column.table.toLowerCase()));
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
  const sum = { calls: 0, tables: 0, goldTables: 0, goldChars: 0, spareChars: 0, shippedKept: 0, candidateKept: 0, cardShare: 0, spareShare: 0 };
  for (const row of rows) {
    for (const key of Object.keys(total) as (keyof PromptCost)[]) total[key] += row.cost[key];
    shipped[row.shipped] += 1;
    candidate[row.candidate] += 1;
    sum.calls += row.calls;
    sum.tables += row.tables;
    sum.goldTables += row.goldTables;
    sum.goldChars += row.goldChars;
    sum.spareChars += row.spareChars;
    sum.shippedKept += row.shippedTables;
    sum.candidateKept += row.candidateTables;
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
  };
}

/**
 * The lines a reader sees.
 *
 * Absolute counts first, shares second: "eleven per cent" of a prompt is not a work item until
 * it is a number of characters per question and a number of calls.
 */
export function cardLines(tally: CardTally): string[] {
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
  return { report: path, layout, arm: named ?? 'select-cross', out: dirname(layout.out), strict: argv.includes('--strict') };
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
  readonly problems: readonly string[];
}

/** A report as this instrument reads it. */
export interface CardReportShape {
  readonly split?: string;
  readonly cases?: readonly CaseRecord[];
  readonly controls?: { readonly synthesizedDefinitions?: Readonly<Record<string, string>> };
}

/** One case's two messages, built by the function the pipeline sends. */
export function promptOf(
  arm: Arm,
  question: BirdQuestion,
  definitions: string,
  tables: BirdTable,
): { system: string; user: string; schema: readonly SchemaTable[] } {
  const card = attachDefinitions(buildSchema(tables, new Map(), { withNotes: false }), definitions);
  const schema = card.schema as SchemaTable[];
  const options = promptFor(arm, question, {});
  const built = buildAskMessages({
    question: question.question,
    schema,
    prompt: options,
    linking: arm.linking,
    samples: arm.samples === true,
  });
  return {
    system: built.messages[0]?.content ?? '',
    user: built.messages[1]?.content ?? '',
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
  const drops = { unknownQuestion: 0, unknownArm: 0, definitionGap: 0, unrenderable: 0 };
  const cases = (report.cases ?? []).filter((row) => row.arm === settings.arm);
  const seen = new Set<string>();
  if (arm === undefined) {
    drops.unknownArm = cases.length;
  } else if (!renderableArm(arm)) {
    drops.unrenderable = cases.length;
  } else {
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
      const built = promptOf(arm, question, text ?? '', table);
      // `costOf` throws rather than returning a sentinel: a prompt these builders produced
      // always decomposes, the end-to-end tests below assert that on a real split, and a case
      // silently dropped for a reason nobody can act on is worse than a loud failure.
      const cost = costOf(built.system, built.user, question.question);
      const chars = tableChars(built.schema, promptFor(arm, question, {}));
      const gold = goldTables(question.SQL);
      const shipped = linkedTables(question.question, built.schema, SHIPPED_RECALLERS);
      const candidate = linkedTables(question.question, built.schema, CANDIDATE_RECALLERS);
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
      });
    }
  }
  const tally = tallyCards(rows);
  const problems = cardProblems({
    tally,
    definitionGap: drops.definitionGap,
    unrenderable: drops.unrenderable + drops.unknownArm,
  });
  return { split: settings.layout.split, arm: settings.arm, rows, tally, drops, problems };
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
  for (const line of cardLines(outcome.tally)) console.log(line);
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
