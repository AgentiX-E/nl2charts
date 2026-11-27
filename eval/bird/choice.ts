/**
 * What a wrong statement reads instead of the table the gold reads.
 *
 * `reach` closed one hypothesis last round: at the width every arm runs at, no table is hidden,
 * so the 136 cases whose statement never touches a gold table are not a retrieval failure. What it
 * could not say is what those statements *did* read. This module answers that, and it answers it
 * for free — the two statements are already in the artifact, the schema is the dataset's manifest,
 * and nothing here executes or calls a model.
 *
 * ## Two readings, because "wrong table" is two different mistakes
 *
 * A statement that reads `cards` where the gold reads `card_games` made a **choice between two
 * tables the same question could plausibly name**. A statement that reads `frpm` where the gold
 * reads `schools` made a choice the schema does not offer a reason for. The two need different
 * fixes — disambiguation versus coverage — and the size of each is a number:
 *
 * 1. **Kind** — for every extra table the statement reads, the distance from that table to the
 *    gold table it displaced, in the join graph. One declared hop is `neighbour`; one hop that
 *    only exists because the two tables carry a column of the same name is `sibling`; two hops is
 *    still `neighbour` at distance 2; beyond that is `distant`. The graph is the same one
 *    `join-graph.ts` builds for the prompt, at the same two sources, so a table this calls a
 *    neighbour is one the card's own join hints call a neighbour. When nothing was displaced the
 *    distance has no target and the extra table is `redundant`, never `distant` — a superset that
 *    took a longer route to a table the statement did read.
 * 2. **Position** — where the gold table sat in the card the statement was written against, and
 *    where it would sit if the card's tables were ordered by how many of the question's words each
 *    table can account for. A position is a property of the card, not a cause of the error:
 *    every table arrived at the measured width. It is measured because it is the *only* lever that
 *    costs no tokens — same tables, same columns, same characters, one permutation — and a lever
 *    with no population is not worth a dispatch.
 *
 * ## The third number: a word the card says belongs to a table the statement did not read
 *
 * `tokenizeQuestion` and `namesTable` are the product's own rules, imported rather than copied, so
 * "the question names this table" means here what it means in the linker. A token that draws from
 * a table the gold reads and from no table the statement reads is a **refutation the card already
 * carried**: the statement read the schema, and the schema said this word lives over there. Those
 * tokens are counted per case, because they are the population a hint costs one line to reach and
 * the population no hint can reach is the one that needs a different table in the schema.
 *
 * ## What none of this is
 *
 * A difference is not a defect, and a position is not a cause. Two statements can answer one
 * question while reading different tables — a join implied by a foreign key, a subquery flattened
 * into a join — and nothing here executes, so nothing here can tell those apart from a loss. Every
 * sentence this module prints says *differs*, never *wrong*, and every count is over the cases the
 * judge did not pass, which is a population the artifact already defined.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { namesTable, tokenizeQuestion } from '@agentix-e/nl2charts-ai';
import { loadTables, type BirdTable } from './data.js';
import { joinGraphOf, type EdgeSource } from './join-graph.js';
import { resolveLayout } from './run.js';
import { goldRefs } from './reach.js';

/**
 * How far the table a statement reads is from the table it displaced.
 *
 * `neighbour` is one hop in the graph the manifest declares; `sibling` is one hop that only the
 * shared-column source adds — a join BIRD's own statements write and several of its manifests fail
 * to describe; `distant` is everything beyond two hops. The order is the precedence: a table that
 * is both is counted as the stronger relation, because the manifest is evidence and a shared column
 * is a hint. This ordering is only over distances that had a target: a superset and an unmodelled
 * name are counted apart, never as a distant join.
 */
export const CHOICE_KINDS = ['neighbour', 'sibling', 'distant'] as const;
export type ChoiceKind = (typeof CHOICE_KINDS)[number];

/** Extra table with no displaced gold table: the statement read every gold table and one more. A
 * join distance has no target then, so this is not `distant` — the statement took a redundant
 * route, which is a rewrite question rather than a linking one. On the canonical dev run all 38
 * cases the earlier reading called `distant` were this shape; zero displaced a gold table and sat
 * beyond two hops.
 */
export const CHOICE_REDUNDANT = 'redundant';

/** A swap the schema cannot place: the statement reads a name the database does not carry. */
export const CHOICE_UNCARDED = 'uncarded';

/** Every bucket a case or a swap can land in: three distances, then the two non-distances. */
export const CHOICE_CASE_KINDS = [...CHOICE_KINDS, CHOICE_REDUNDANT, CHOICE_UNCARDED] as const;

/** How far a walk may go before a table stops being a neighbour. */
export const NEIGHBOUR_HOPS = 2;

/** The schema a choice is read against, as the two graphs plus the order the card prints. */
export interface ChoiceSchema {
  /** The tables in the order `buildSchema` emits them, which is the order the card prints them. */
  readonly order: readonly string[];
  /** Edges the dataset declares. */
  readonly declared: ReadonlyMap<string, readonly string[]>;
  /** Declared edges plus the ones a shared column name implies. */
  readonly shared: ReadonlyMap<string, readonly string[]>;
  /** Lowercased column names per table, for the join hints a card renders. */
  readonly columns: ReadonlyMap<string, readonly string[]>;
}

/**
 * The schema of one database, from the manifest alone.
 *
 * `order` is the manifest's own table order and not a sorted copy: the card prints the list
 * `buildSchema` returns, so a position measured here is a position a reader of the prompt can
 * count to. Sorting it here would make the reading describe a card nobody sends.
 */
export function choiceSchemaOf(table: BirdTable, source: EdgeSource = 'shared'): ChoiceSchema {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const name of table.tableNames) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    order.push(key);
  }
  const columns = new Map<string, string[]>();
  table.columnNames.forEach(([owner, name]) => {
    if (owner < 0 || name === '*') return;
    const ownerName = table.tableNames[owner]?.toLowerCase();
    if (ownerName === undefined) return;
    const list = columns.get(ownerName) ?? [];
    list.push(name.toLowerCase());
    columns.set(ownerName, list);
  });
  return {
    order,
    declared: joinGraphOf(table, 'manifest').adjacency,
    shared: joinGraphOf(table, source).adjacency,
    columns,
  };
}

/** Distance in hops from `from` to any of `targets`, or `undefined` past `NEIGHBOUR_HOPS`. */
export function hopsTo(
  adjacency: ReadonlyMap<string, readonly string[]>,
  from: string,
  targets: ReadonlySet<string>,
  limit = NEIGHBOUR_HOPS,
): number | undefined {
  if (targets.has(from)) return 0;
  const seen = new Set<string>([from]);
  let frontier = [from];
  for (let hop = 1; hop <= limit; hop += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbour of adjacency.get(node) ?? []) {
        if (seen.has(neighbour)) continue;
        if (targets.has(neighbour)) return hop;
        seen.add(neighbour);
        next.push(neighbour);
      }
    }
    if (next.length === 0) return undefined;
    frontier = next;
  }
  return undefined;
}

/** One extra table a statement reads, and how it relates to the tables it displaced. */
export interface ChoiceSwap {
  readonly extra: string;
  /** Hops to the nearest displaced table over declared edges, when there is one within the limit. */
  readonly declared: number | undefined;
  /** The same over the shared-column graph, which is a superset of the declared one. */
  readonly shared: number | undefined;
  readonly kind: ChoiceKind | typeof CHOICE_REDUNDANT | typeof CHOICE_UNCARDED;
}

/**
 * The strongest relation between one extra table and the gold tables it displaced.
 *
 * A name on the card that displaced no gold table is `redundant`, not `distant`: a distance to an
 * empty set reads as unreachable, but the statement read every gold table and one more, so there
 * is no join it failed to find. A name the card does not carry is `uncarded` rather than `distant`:
 * the statement read something the schema does not have (a derived-table alias that reached the
 * `from` clause, a table spelled from the humanised labels), and calling that "far from the gold"
 * would fold a schema-reading defect into a join-distance bucket.
 */
export function swapOf(extra: string, missing: ReadonlySet<string>, schema: ChoiceSchema): ChoiceSwap {
  if (!schema.order.includes(extra)) {
    return { extra, declared: undefined, shared: undefined, kind: CHOICE_UNCARDED };
  }
  // No displaced table: a distance measured to an empty set would read as `distant`, claiming the
  // statement read a table two hops from gold when in fact it read every gold table and one more.
  if (missing.size === 0) {
    return { extra, declared: undefined, shared: undefined, kind: CHOICE_REDUNDANT };
  }
  const declared = hopsTo(schema.declared, extra, missing);
  const shared = hopsTo(schema.shared, extra, missing);
  if (declared === 1) return { extra, declared, shared, kind: 'neighbour' };
  if (shared === 1) return { extra, declared, shared, kind: 'sibling' };
  if (declared !== undefined) return { extra, declared, shared, kind: 'neighbour' };
  return { extra, declared, shared, kind: 'distant' };
}

/**
 * The one kind a case is counted under.
 *
 * A case that reads two extra tables of different kinds is counted as the strongest one: if any of
 * them is a declared neighbour, the statement was one join away from the gold and that is the fact
 * a mechanism addresses. The partition is over cases, so the counts add up; the per-swap counts are
 * reported beside it for the reader who wants the other reading.
 */
export function kindOf(swaps: readonly ChoiceSwap[]): ChoiceKind | typeof CHOICE_REDUNDANT | typeof CHOICE_UNCARDED {
  for (const kind of CHOICE_CASE_KINDS) {
    if (swaps.some((swap) => swap.kind === kind)) return kind;
  }
  return CHOICE_UNCARDED;
}

/**
 * How many of the question's words one table can account for.
 *
 * A token counts once, whether it names the table or one of its columns: the reading answers "how
 * much of this question does this table speak to", and a table whose name matches three words is
 * not three times as likely as one whose column matches one. Ties are kept in card order by the
 * caller, so the ordering is a permutation of the card and never a reordering of equals by chance.
 */
export function matchScore(question: readonly string[], table: string, schema: ChoiceSchema): number {
  const names = new Set(tokenizeQuestion(table));
  for (const column of schema.columns.get(table) ?? []) for (const token of tokenizeQuestion(column)) names.add(token);
  let score = 0;
  for (const token of question) {
    if (names.has(token) || namesTable(token, table)) score += 1;
  }
  return score;
}

/** The card's tables ordered by how much of the question each speaks to, ties in card order. */
export function focusOrder(question: readonly string[], schema: ChoiceSchema): readonly string[] {
  return schema.order
    .map((table, index) => ({ table, index, score: matchScore(question, table, schema) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.table);
}

/**
 * The words the card says belong to a table the statement did not read.
 *
 * A token qualifies when it draws from at least one table the statement displaced and from no
 * table the statement read. That is the shape of a refutation a reader can act on without knowing
 * the answer: the prompt listed the columns, one of them carries the word, and the statement does
 * not read the table it is on. Words that both sides carry are excluded on purpose — a hint that
 * says "the question names `name`" about a column every table has is noise, and a hint that fires
 * on noise is a hint the model learns to ignore.
 */
export function exclusiveTokens(
  question: readonly string[],
  missing: readonly string[],
  read: readonly string[],
  schema: ChoiceSchema,
): string[] {
  const draws = (table: string, token: string): boolean => {
    if (namesTable(token, table)) return true;
    return (schema.columns.get(table) ?? []).some((column) => tokenizeQuestion(column).includes(token));
  };
  const exclusive: string[] = [];
  for (const token of new Set(question)) {
    if (!missing.some((table) => draws(table, token))) continue;
    if (read.some((table) => draws(table, token))) continue;
    exclusive.push(token);
  }
  return exclusive.sort();
}

/** Where one gold table sat in the card, before and after the ordering a mechanism would apply. */
export interface ChoicePosition {
  readonly db: string;
  readonly table: string;
  /** 1-based index in the card as printed, or `undefined` when the card does not print it. */
  readonly before: number | undefined;
  /** 1-based index under `focusOrder`, when the table is on the card at all. */
  readonly after: number | undefined;
  readonly tables: number;
  readonly score: number;
}

/** One case, as the artifact writes it, restricted to what a choice reads. */
export interface ChoiceCase {
  readonly id: string;
  readonly db: string;
  readonly question: string;
  readonly sql?: string;
  readonly gold?: string;
}

export interface ChoiceInput {
  readonly split: string;
  readonly arm: string;
  readonly total: number;
  readonly passed: number;
  readonly cases: readonly ChoiceCase[];
  readonly source?: ChoiceSource;
}

/** The artifact a choice was read on. The timestamp is what tells two dispatches of one split apart. */
export interface ChoiceSource {
  readonly path: string;
  readonly generatedAt?: string;
}

/** Positions at the windows a reader counts to: the first table, the first three, the first five. */
export const CHOICE_WINDOWS = [1, 3, 5] as const;

export interface ChoiceWindow {
  readonly at: number;
  /** Gold tables at or before this position in the card as printed. */
  readonly before: number;
  /** The same under `focusOrder`. */
  readonly after: number;
  /** Gold tables that were past the window and are inside it after the reordering. */
  readonly moved: number;
  /** Gold tables that were inside the window and are past it after the reordering. */
  readonly lost: number;
}

export interface ChoiceOutcome {
  readonly split: string;
  readonly arm: string;
  readonly total: number;
  readonly passed: number;
  /** Cases the judge did not pass: the population every count below is over. */
  readonly population: number;
  /** Cases that carried both statements, which is the only population the reading can see. */
  readonly compared: number;
  /** Cases the artifact kept no statement for. Counted, never dropped. */
  readonly unretained: number;
  /** Compared cases whose prediction reads exactly the gold's tables. */
  readonly sameTables: number;
  /** Compared cases whose table sets differ, split by direction of travel. */
  readonly direction: Readonly<Record<'missing' | 'extra' | 'both', number>>;
  /** Cases that read at least one table the gold does not: the population of a swap. */
  readonly casesWithExtra: number;
  /** One kind per such case, by precedence. Sums to `casesWithExtra`. */
  readonly kinds: Readonly<Record<ChoiceKind | typeof CHOICE_REDUNDANT | typeof CHOICE_UNCARDED, number>>;
  /** Extra-table records, a case counted once per table it reads and the gold does not. */
  readonly swaps: number;
  readonly swapKinds: Readonly<Record<ChoiceKind | typeof CHOICE_REDUNDANT | typeof CHOICE_UNCARDED, number>>;
  /** Cases carrying a word the card says lives on a table the statement did not read. */
  readonly namedCases: number;
  readonly namedTokens: number;
  /** One record per (case, displaced gold table) pair the card prints. */
  readonly positions: readonly ChoicePosition[];
  /** Displaced gold tables over every compared case, which `positions` plus `uncarded` must equal. */
  readonly displaced: number;
  /** Cases whose database the manifest does not describe. A manifest gap, counted not dropped. */
  readonly unschema: number;
  /** Displaced gold tables the card does not print. Zero at every width `reach` measures clean. */
  readonly uncarded: number;
  readonly windows: readonly ChoiceWindow[];
  /** Median 1-based position of a displaced gold table, before and after. */
  readonly medianBefore: number;
  readonly medianAfter: number;
  readonly source: ChoiceSource;
  readonly problems: readonly string[];
}

const emptyKinds = (): Record<ChoiceKind | typeof CHOICE_REDUNDANT | typeof CHOICE_UNCARDED, number> => ({
  neighbour: 0,
  sibling: 0,
  distant: 0,
  redundant: 0,
  uncarded: 0,
});

/** The table direction of one case: which side reads a table the other does not. */
export function choiceDirection(
  mine: readonly string[],
  theirs: readonly string[],
): 'missing' | 'extra' | 'both' | undefined {
  const read = new Set(mine);
  const gold = new Set(theirs);
  const missing = [...gold].some((table) => !read.has(table));
  const extra = [...read].some((table) => !gold.has(table));
  if (!missing && !extra) return undefined;
  if (missing && extra) return 'both';
  return missing ? 'missing' : 'extra';
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2 : (sorted[middle] as number);
};

export function tallyChoice(input: ChoiceInput, schemas: ReadonlyMap<string, ChoiceSchema>): ChoiceOutcome {
  const direction: Record<'missing' | 'extra' | 'both', number> = { missing: 0, extra: 0, both: 0 };
  const kinds = emptyKinds();
  const swapKinds = emptyKinds();
  const positions: ChoicePosition[] = [];
  let compared = 0;
  let unretained = 0;
  let sameTables = 0;
  let casesWithExtra = 0;
  let swaps = 0;
  let namedCases = 0;
  let namedTokens = 0;
  let uncardedPositions = 0;
  let displaced = 0;
  let unschema = 0;
  const before: number[] = [];
  const after: number[] = [];

  for (const item of input.cases) {
    if (item.sql === undefined || item.sql.trim() === '' || item.gold === undefined || item.gold.trim() === '') {
      unretained += 1;
      continue;
    }
    compared += 1;
    const mine = goldRefs(item.sql).tables;
    const theirs = goldRefs(item.gold).tables;
    const travel = choiceDirection(mine, theirs);
    const schema = schemas.get(item.db.toLowerCase());
    // A database the manifest does not describe is a manifest gap, not a statement that reads
    // every table. Leaving it in `compared` and out of everything else is what makes the gate
    // `sameTables + travel + unschema === compared` able to say so.
    if (schema === undefined) {
      unschema += 1;
      continue;
    }
    if (travel === undefined) {
      sameTables += 1;
      continue;
    }
    direction[travel] += 1;
    const read = new Set(mine);
    const gold = new Set(theirs);
    const missing = theirs.filter((table) => !read.has(table));
    const extras = mine.filter((table) => !gold.has(table));
    if (extras.length > 0) {
      casesWithExtra += 1;
      const missingSet = new Set(missing);
      const records = extras.map((extra) => swapOf(extra, missingSet, schema));
      swaps += records.length;
      for (const record of records) swapKinds[record.kind] += 1;
      kinds[kindOf(records)] += 1;
      const question = tokenizeQuestion(item.question);
      const exclusive = exclusiveTokens(question, missing, mine, schema);
      if (exclusive.length > 0) {
        namedCases += 1;
        namedTokens += exclusive.length;
      }
    }
    displaced += missing.length;
    for (const table of missing) {
      const index = schema.order.indexOf(table);
      if (index < 0) {
        uncardedPositions += 1;
        continue;
      }
      const focus = focusOrder(tokenizeQuestion(item.question), schema);
      const position: ChoicePosition = {
        db: item.db.toLowerCase(),
        table,
        before: index + 1,
        after: focus.indexOf(table) + 1,
        tables: schema.order.length,
        score: matchScore(tokenizeQuestion(item.question), table, schema),
      };
      positions.push(position);
      before.push(position.before as number);
      after.push(position.after as number);
    }
  }

  const windows: ChoiceWindow[] = CHOICE_WINDOWS.map((at) => {
    const inside = (value: number | undefined): boolean => value !== undefined && value <= at;
    return {
      at,
      before: positions.filter((position) => inside(position.before)).length,
      after: positions.filter((position) => inside(position.after)).length,
      moved: positions.filter((position) => !inside(position.before) && inside(position.after)).length,
      lost: positions.filter((position) => inside(position.before) && !inside(position.after)).length,
    };
  });

  const outcome: ChoiceOutcome = {
    split: input.split,
    arm: input.arm,
    total: input.total,
    passed: input.passed,
    population: input.total - input.passed,
    compared,
    unretained,
    sameTables,
    direction,
    casesWithExtra,
    kinds,
    swaps,
    swapKinds,
    namedCases,
    namedTokens,
    positions,
    displaced,
    unschema,
    uncarded: uncardedPositions,
    windows,
    medianBefore: median(before),
    medianAfter: median(after),
    source: input.source ?? { path: '' },
    problems: [],
  };
  return { ...outcome, problems: choiceProblems(outcome) };
}

/**
 * The arithmetic impossibilities, each of which has been a real reading elsewhere in this repository.
 *
 * A partition that does not sum to its population, a sub-count that exceeds its parent, a position
 * outside the card, an ordering that is not a permutation, and a window count that claims more
 * table promotions than there were tables outside the window: every one of these produces a number
 * that reads like a finding and is produced by a bug.
 */
export function choiceProblems(outcome: ChoiceOutcome): readonly string[] {
  const problems: string[] = [];
  const kindSum = CHOICE_KINDS.reduce(
    (total, kind) => total + outcome.kinds[kind],
    outcome.kinds[CHOICE_REDUNDANT] + outcome.kinds[CHOICE_UNCARDED],
  );
  if (kindSum !== outcome.casesWithExtra) {
    problems.push(`case kinds sum to ${String(kindSum)} but ${String(outcome.casesWithExtra)} case(s) read an extra table`);
  }
  const swapSum = CHOICE_KINDS.reduce(
    (total, kind) => total + outcome.swapKinds[kind],
    outcome.swapKinds[CHOICE_REDUNDANT] + outcome.swapKinds[CHOICE_UNCARDED],
  );
  if (swapSum !== outcome.swaps) {
    problems.push(`swap kinds sum to ${String(swapSum)} but the reading counted ${String(outcome.swaps)} extra table(s)`);
  }
  if (outcome.casesWithExtra !== outcome.direction.extra + outcome.direction.both) {
    problems.push(
      `${String(outcome.casesWithExtra)} case(s) read an extra table, but the directions say ` +
        `${String(outcome.direction.extra)} extra and ${String(outcome.direction.both)} both`,
    );
  }
  if (outcome.compared + outcome.unretained !== outcome.population) {
    problems.push(
      `${String(outcome.compared)} compared and ${String(outcome.unretained)} unretained do not add up to the ${String(outcome.population)} unpassed case(s)`,
    );
  }
  const travel = outcome.direction.missing + outcome.direction.extra + outcome.direction.both;
  if (outcome.sameTables + travel + outcome.unschema !== outcome.compared) {
    problems.push(
      `${String(outcome.sameTables)} same-table, ${String(travel)} differing and ${String(outcome.unschema)} unmodelled case(s) ` +
        `do not add up to the ${String(outcome.compared)} compared`,
    );
  }
  if (outcome.population !== outcome.total - outcome.passed) {
    problems.push(
      `population ${String(outcome.population)} is not the artifact's total minus its passed count (${String(outcome.total)} - ${String(outcome.passed)})`,
    );
  }
  for (const position of outcome.positions) {
    if (position.before === undefined || position.before < 1 || position.before > position.tables) {
      problems.push(`${position.db}.${position.table} is at position ${String(position.before)} of ${String(position.tables)}`);
    }
    if (position.after === undefined || position.after < 1 || position.after > position.tables) {
      problems.push(`${position.db}.${position.table} is at position ${String(position.after)} of ${String(position.tables)} under the focus order`);
    }
  }
  const kept = outcome.positions.length + outcome.uncarded;
  if (kept !== outcome.displaced) {
    problems.push(
      `${String(kept)} position(s) recorded (${String(outcome.positions.length)} on the card, ${String(outcome.uncarded)} off it) ` +
        `but the cases displaced ${String(outcome.displaced)} gold table(s)`,
    );
  }
  for (const window of outcome.windows) {
    if (window.moved > outcome.positions.length - window.before) {
      problems.push(
        `window ${String(window.at)} promotes ${String(window.moved)} table(s) from outside, but only ` +
          `${String(outcome.positions.length - window.before)} sat outside it`,
      );
    }
    if (window.lost > window.before) {
      problems.push(`window ${String(window.at)} loses ${String(window.lost)} table(s) it never had inside it`);
    }
    if (window.moved + window.lost > window.before + window.after) {
      problems.push(
        `window ${String(window.at)} moves ${String(window.moved)} in and ${String(window.lost)} out, more than the ${String(outcome.positions.length)} position(s) recorded`,
      );
    }
    if (window.before > outcome.positions.length || window.after > outcome.positions.length) {
      problems.push(
        `window ${String(window.at)} counts ${String(window.before)} before and ${String(window.after)} after, above the ${String(outcome.positions.length)} position(s) recorded`,
      );
    }
  }
  return problems;
}

const percent = (count: number, base: number): string => `${((count / base) * 100).toFixed(1)}%`;

/** The report, as lines a terminal and a document can both read. */
export function choiceLines(outcome: ChoiceOutcome): readonly string[] {
  const lines: string[] = [];
  const base = outcome.casesWithExtra === 0 ? 1 : outcome.casesWithExtra;
  lines.push(`  the table the statement read instead, one case per row (${CHOICE_CASE_KINDS.join(' > ')}):`);
  for (const kind of CHOICE_KINDS) {
    lines.push(
      `    ${kind.padEnd(9)} ${String(outcome.kinds[kind]).padStart(4)}  ${percent(outcome.kinds[kind], base).padStart(6)} of ` +
        `${String(outcome.casesWithExtra)}  ${String(outcome.swapKinds[kind]).padStart(4)} extra table(s)`,
    );
  }
  if (outcome.kinds[CHOICE_REDUNDANT] > 0) {
    lines.push(
      `    ${CHOICE_REDUNDANT.padEnd(9)} ${String(outcome.kinds[CHOICE_REDUNDANT]).padStart(4)}  ${percent(outcome.kinds[CHOICE_REDUNDANT], base).padStart(6)} of ` +
        `${String(outcome.casesWithExtra)}  no gold table displaced — not a distance`,
    );
  }
  if (outcome.kinds[CHOICE_UNCARDED] > 0) {
    lines.push(`    ${CHOICE_UNCARDED.padEnd(9)} ${String(outcome.kinds[CHOICE_UNCARDED]).padStart(4)}  a name the database does not carry`);
  }
  lines.push(
    `  ${String(outcome.positions.length)} displaced gold table(s) over ${String(outcome.compared - outcome.sameTables)} case(s); ` +
      `median position ${String(outcome.medianBefore)} of the card, ${String(outcome.medianAfter)} under the focus order`,
  );
  for (const window of outcome.windows) {
    lines.push(
      `    top ${String(window.at).padStart(2)}  ${String(window.before).padStart(4)} -> ${String(window.after).padStart(4)}` +
        `   +${String(window.moved)} in, -${String(window.lost)} out`,
    );
  }
  lines.push(
    `  ${String(outcome.namedCases)} case(s) carry ${String(outcome.namedTokens)} word(s) the card says live only on a table the statement did not read`,
  );
  if (outcome.uncarded > 0) {
    lines.push(`  ${String(outcome.uncarded)} displaced table(s) are not on the card at all`);
  }
  return lines;
}

/** One sentence a document can quote without re-deriving what a kind means. */
export function choiceSentence(outcome: ChoiceOutcome): string {
  if (outcome.casesWithExtra === 0) return 'no statement read a table the gold does not, so there is no choice to read';
  const top = CHOICE_CASE_KINDS.reduce(
    (best, kind) => (outcome.kinds[kind] > outcome.kinds[best] ? kind : best),
    CHOICE_CASE_KINDS[0],
  );
  const relation =
    top === CHOICE_REDUNDANT || top === CHOICE_UNCARDED
      ? `held the gold's tables and one more that displaced none (\`${top}\`)`
      : `read a table \`${top}\` to the one they displaced`;
  return (
    `${String(outcome.casesWithExtra)} statement(s) read a table the gold does not: ` +
    `${String(outcome.kinds[top])} (${percent(outcome.kinds[top], outcome.casesWithExtra)}) ${relation}; ` +
    `a difference is not a defect — nothing here was executed`
  );
}

/** What a choice needs: the artifact, and the manifest for the two graphs and the card order. */
export interface ChoiceSettings {
  readonly root: string;
  readonly artifact: string;
  readonly arm: string;
  readonly tables: string;
  readonly out?: string;
}

export const DEFAULT_CHOICE_ARM = 'macsql-prompt';

export function resolveChoiceSettings(
  argv: readonly string[],
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): ChoiceSettings {
  const takesValue = new Set(['--artifact', '--arm', '--out', '--tables']);
  let artifact: string | undefined;
  let arm: string | undefined;
  let out: string | undefined;
  let tables: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!takesValue.has(token)) {
      throw new Error(`unrecognized argument ${token}: this harness takes --artifact, --arm, --tables and --out`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
    if (token === '--artifact') artifact = value;
    else if (token === '--tables') tables = value;
    else if (token === '--out') out = value;
    else arm = value;
    index += 1;
  }
  const layout = resolveLayout(env, root);
  const settings: ChoiceSettings = {
    root,
    artifact: artifact ?? layout.out,
    arm: arm ?? DEFAULT_CHOICE_ARM,
    tables: tables ?? layout.tablesFile,
  };
  return out === undefined ? settings : { ...settings, out: resolve(root, out) };
}

/** Where a reading goes, named by arm and split so two populations never replace each other. */
export function choicePath(settings: { readonly root: string; readonly arm: string; readonly split: string }): string {
  const safe = settings.arm.replace(/[^a-z0-9+-]/gi, '_');
  return join(settings.root, 'eval', 'out', `choice-${safe}-${settings.split}.json`);
}

/** The artifact a choice reads: the fields it needs, so a wider artifact still validates. */
export interface ChoiceArtifact {
  readonly split?: string;
  readonly generatedAt?: string;
  readonly arms?: readonly { readonly arm: string; readonly passed: number; readonly total: number }[];
  readonly cases: readonly {
    readonly arm: string;
    readonly id: string | number;
    readonly passed: boolean;
    readonly sql?: string;
    readonly gold?: string;
    readonly asked?: { readonly db?: string; readonly question?: string };
  }[];
}

/**
 * The arm's unpassed cases that name a database and a question.
 *
 * A case without either is left out of the reading rather than scored against an empty string: an
 * artifact that dropped `asked` would otherwise read as 522 statements that displaced every table
 * in the database, with a `distant` count to match. The exclusion is a count, and the gate refuses
 * a population that does not reconcile.
 */
export function readChoiceInputs(artifact: ChoiceArtifact, arm: string, source?: ChoiceSource): ChoiceInput {
  const mine = artifact.cases.filter((row) => row.arm === arm);
  const cases: ChoiceCase[] = [];
  for (const row of mine) {
    if (row.passed) continue;
    const db = row.asked?.db;
    const question = row.asked?.question;
    if (db === undefined || question === undefined) continue;
    cases.push({ id: String(row.id), db: db.toLowerCase(), question, sql: row.sql, gold: row.gold });
  }
  const declared = artifact.arms?.find((row) => row.arm === arm);
  return {
    split: artifact.split ?? 'unknown',
    arm,
    total: declared?.total ?? mine.length,
    passed: declared?.passed ?? mine.filter((row) => row.passed).length,
    cases,
    source: source ?? { path: '', generatedAt: artifact.generatedAt },
  };
}

export function schemasOf(tables: ReadonlyMap<string, BirdTable>): Map<string, ChoiceSchema> {
  const schemas = new Map<string, ChoiceSchema>();
  for (const [db, table] of tables) schemas.set(db.toLowerCase(), choiceSchemaOf(table));
  return schemas;
}

export async function runChoice(settings: ChoiceSettings): Promise<ChoiceOutcome> {
  const body = JSON.parse(readFileSync(settings.artifact, 'utf8')) as ChoiceArtifact;
  const input = readChoiceInputs(body, settings.arm, { path: settings.artifact, generatedAt: body.generatedAt });
  return tallyChoice(input, schemasOf(loadTables(settings.tables)));
}

/**
 * Write the reading, and refuse to replace one taken on a different artifact.
 *
 * `census` earned this rule the hard way: a split has two populations the moment a second dispatch
 * of the same arm exists, and an artifact named for the split alone silently became the second one
 * while the document quoting it described the first.
 */
export function writeChoiceArtifact(settings: ChoiceSettings, outcome: ChoiceOutcome): string {
  const path = settings.out ?? choicePath({ root: settings.root, arm: outcome.arm, split: outcome.split });
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as { source?: ChoiceSource };
    const same = existing.source?.generatedAt === outcome.source.generatedAt;
    if (!same) {
      throw new Error(
        `${path} already holds a reading of ${existing.source?.path ?? 'another artifact'} (${existing.source?.generatedAt ?? 'no timestamp'}); ` +
          `refusing to replace it with ${outcome.source.path} — read the first one under its own name`,
      );
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(outcome, null, 2)}\n`);
  return path;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

export async function startIfEntry(
  argv1: string | undefined,
  moduleUrl: string,
  run: () => Promise<number>,
): Promise<number | undefined> {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  return run();
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const settings = resolveChoiceSettings(argv, root, env);
  const outcome = await runChoice(settings);
  const path = writeChoiceArtifact(settings, outcome);
  const base = outcome.total === 0 ? 1 : outcome.total;
  console.log(
    `choice · ${outcome.arm} · ${outcome.split} · ${String(outcome.population)} wrong of ${String(outcome.total)} (${percent(outcome.population, base)})`,
  );
  for (const line of choiceLines(outcome)) console.log(line);
  console.log(`  ${choiceSentence(outcome)}`);
  console.log(`  written to ${path}`);
  for (const problem of outcome.problems) console.log(`  ${problem}`);
  return outcome.problems.length === 0 ? 0 : 1;
}

/**
 * The entry every harness file in this directory shares: run when asked, otherwise do nothing.
 *
 * Exported rather than written at module scope so the branch that sets the exit code is reachable
 * from a test — `reach` learned this the hard way, leaving an `if (isEntry(...))` that no test could
 * enter and a coverage number that only looked honest.
 */
export async function entrypoint(argv1: string | undefined, moduleUrl: string, run: () => Promise<number>): Promise<void> {
  const started = await startIfEntry(argv1, moduleUrl, run);
  if (started !== undefined) process.exitCode = started;
}

await entrypoint(process.argv[1], import.meta.url, async () => main());
