/**
 * The per-question export a paired pricing dispatch reads before it spends a model call.
 *
 * Z.35 requires the pre-dispatch preparation: gold from the real SQL (gold-fields.ts), a real
 * semantic provider, and the gained/lost buckets exported per question — not a headline delta. This
 * module assembles one auditable row per question from three inputs already in the repository's
 * hands: the exact arm (`values.ts`), the semantic arm (`semantic-values.ts`), and the canonical gold
 * field set extracted from the gold SQL. `classifyCase` (r216) does the six-bucket split; this file
 * owns the canonicalisation that keeps all three in one `table.column` space and the rendering that
 * makes a row readable in a report.
 *
 * Everything here is deterministic and offline. The CLI at the bottom runs the deterministic hash
 * embedding over the cached BIRD dev split as a **harness proof**: it proves the export pipeline is
 * wired and the buckets are non-degenerate, but its numbers are a lexical stand-in and must never be
 * quoted as a semantic-gain accuracy claim. A priced reading needs a real paired dispatch through
 * the Org-secret workflow and a McNemar test on the same-question discordant pairs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseProfile } from '@agentix-e/nl2charts-ai';
import {
  classifyCase,
  summarizeClassifications,
  type FieldRef,
  type PairSummary,
} from './value-pair-harness.js';
import { canonicalColumn, extractGoldFields } from './gold-fields.js';

/** One question's auditable pairing row. */
export interface GoldPairRow {
  readonly questionId: number;
  readonly question: string;
  /** Canonical gold keys from the SQL, the coverage denominator. */
  readonly goldKeys: readonly string[];
  readonly goldCount: number;
  /** Canonical keys each arm returned, kept for audit. */
  readonly exactKeys: readonly string[];
  readonly semanticKeys: readonly string[];
  readonly classification: ReturnType<typeof classifyCase>['classification'];
}

/**
 * Map retrieval-arm fields into the canonical profile space.
 *
 * Both arms carry the profile spelling already when built from a profile, but a caller may hand in
 * a lower-cased or aliased field. Resolving each through the profile keeps a `County name` and a
 * `County Name` from being scored as two different fields; a field with no profile row is kept
 * lower-cased, the same honest fallback `gold-fields.ts` uses for a CTE column.
 */
function canonicalizeFields(fields: readonly FieldRef[], profile: DatabaseProfile): FieldRef[] {
  const out: FieldRef[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    const resolved = canonicalColumn(field.table, field.column, profile);
    const canonical = resolved ?? { table: field.table.toLowerCase(), column: field.column.toLowerCase() };
    const key = `${canonical.table}\u0000${canonical.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonical);
  }
  return out;
}

/**
 * Assemble one auditable row: canonical gold from the SQL, canonicalised arms, six-bucket split.
 */
export function buildGoldPairRow(
  questionId: number,
  question: string,
  goldSql: string,
  profile: DatabaseProfile,
  exact: readonly FieldRef[],
  semantic: readonly FieldRef[],
): GoldPairRow {
  const gold = extractGoldFields(goldSql, profile);
  const exactCanonical = canonicalizeFields(exact, profile);
  const semanticCanonical = canonicalizeFields(semantic, profile);
  const row = classifyCase(questionId, exactCanonical, semanticCanonical, gold);
  const key = (field: FieldRef) => `${field.table}.${field.column}`;
  return {
    questionId,
    question,
    goldKeys: gold.map(key),
    goldCount: row.goldCount,
    exactKeys: exactCanonical.map(key),
    semanticKeys: semanticCanonical.map(key),
    classification: row.classification,
  };
}

/** Aggregate rows with the r216 summariser. */
export function toSummary(rows: readonly GoldPairRow[]): PairSummary {
  return summarizeClassifications(rows.map((row) => ({
    questionId: row.questionId,
    goldCount: row.goldCount,
    classification: row.classification,
  })));
}

/** A compact, stable, human-readable export of the confirmed/spurious split, per question. */
export function renderGoldPairRows(rows: readonly GoldPairRow[], maxRows = 50): string {
  const lines = ['question_id\tquestion\tconfirmed_gain\tspurious_gain\tconfirmed_loss'];
  for (const row of rows.slice(0, maxRows)) {
    const c = row.classification;
    lines.push([
      String(row.questionId),
      row.question.replace(/\t/g, ' '),
      c.semanticGainedConfirmed.join(','),
      c.semanticGainedSpurious.join(','),
      c.semanticLostConfirmed.join(','),
    ].join('\t'));
  }
  return lines.join('\n');
}

/** One cached dev question, the shape BIRD ships. */
export interface DevQuestion {
  readonly question_id: number;
  readonly question: string;
  readonly db_id: string;
  readonly SQL: string;
}

/** First space-delimited word of a column name, lower-cased; empty for an empty name. */
function firstWord(column: string): string {
  const lowered = column.toLowerCase();
  const space = lowered.indexOf(' ');
  return space === -1 ? lowered : lowered.slice(0, space);
}

/**
 * The two offline lexical arms for one question.
 *
 * Deliberately coarse: this harness proves the export wiring and the bucket split, not that
 * semantic retrieval beats exact retrieval. Both arms are stand-ins over the profile vocabulary;
 * a real pair is dispatched separately with a hosted provider through the Org-secret workflow.
 */
export function harnessArms(question: string, profile: DatabaseProfile): {
  exact: FieldRef[]; semantic: FieldRef[];
} {
  const needle = question.toLowerCase();
  const exact = profile.columns
    .filter((column) => needle.includes(column.column.toLowerCase()))
    .map((column) => ({ table: column.table, column: column.column }));
  const semantic = profile.columns
    .filter((column) => (column.kind === 'categorical' || column.kind === 'other')
      && needle.includes(firstWord(column.column)))
    .slice(0, 3)
    .map((column) => ({ table: column.table, column: column.column }));
  return { exact, semantic };
}

/** The harness proof note — pinned so no reader can mistake these numbers for a price. */
export const HARNESS_NOTE = 'HARNESS PROOF ONLY — lexical stand-in arms, not a priced semantic-gain '
  + 'reading. No number here may be quoted as an accuracy claim. Pricing needs a real paired dispatch.';

/**
 * Assemble the harness proof over cached questions with an injected profile loader.
 *
 * The loader is injected so the assembly is testable without filesystem I/O; `main` supplies the
 * real cache reader. This is the whole data path — a caller that wants a priced reading replaces
 * `harnessArms` with a real semantic provider, not this function.
 */
export function harnessOutput(
  dev: readonly DevQuestion[],
  loadProfile: (dbId: string) => DatabaseProfile,
  limit: number,
): { note: string; summary: PairSummary; rows: GoldPairRow[] } {
  const profiles = new Map<string, DatabaseProfile>();
  const rows: GoldPairRow[] = [];
  for (const item of dev.slice(0, limit)) {
    let profile = profiles.get(item.db_id);
    if (profile === undefined) {
      profile = loadProfile(item.db_id);
      profiles.set(item.db_id, profile);
    }
    const { exact, semantic } = harnessArms(item.question, profile);
    rows.push(buildGoldPairRow(item.question_id, item.question, item.SQL, profile, exact, semantic));
  }
  return { note: HARNESS_NOTE, summary: toSummary(rows), rows };
}

/**
 * I/O seam for the CLI. Reader and logger are injected so this wrapper is testable end-to-end with
 * real in-memory strings — no mock of the algorithm, no filesystem dependency in a unit test.
 */
export function runHarness(
  read: (path: string) => string,
  log: (text: string) => void,
  limit: number,
): void {
  const cache = join('eval', '.cache', 'bird');
  const dev = JSON.parse(read(join(cache, 'dev', 'dev_20240627', 'dev.json'))) as DevQuestion[];
  const output = harnessOutput(dev, (dbId) => JSON.parse(
    read(join(cache, 'profiles', `${dbId}.json`)),
  ) as DatabaseProfile, limit);
  log(JSON.stringify(output, null, 2));
}

/** CLI entry: real filesystem reader and stdout logger; every decision lives in the pure functions. */
export function main(): void {
  const limit = Number(process.env.GOLD_PAIR_LIMIT ?? '60');
  runHarness((path) => readFileSync(join(process.cwd(), path), 'utf8'), (text) => console.log(text), limit);
}

/** Whether this module is being run as the CLI rather than imported. */
export function isEntryPoint(argv1: string | undefined): boolean {
  return argv1 !== undefined && argv1.endsWith('gold-pairing.ts');
}

if (isEntryPoint(process.argv[1])) {
  main();
}
