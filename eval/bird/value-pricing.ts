/**
 * The missing dispatch seam between the value-retrieval instruments and a priced reading.
 *
 * Rounds 215-218 built four instruments — semantic retrieval (`semantic-values.ts`), paired
 * bucketing (`value-pair-harness.ts`), gold extracted from the real SQL (`gold-fields.ts`), and
 * a fused block that reaches the generator prompt (`fused-values.ts`). Every one of them was
 * consumed only by tests. Z.37 #1 asks for a paired pricing dispatch of the lexical `values` arm
 * against the fused arm, but there was no entry point that runs the four instruments together on
 * real dev questions with a real provider injected. This module is that entry point, and nothing
 * more.
 *
 * The unit of the decision is the **question**, not the field. `classifyCase` already reports
 * field-level confirmed gains; those are evidence, not the price. The price is a McNemar test on
 * discordant questions: how many questions did the fused arm fully ground that the lexical arm
 * did not, and vice versa. `mcnemarExact` is the repository's audited two-sided exact test, used
 * unchanged. A question whose gold SQL names no resolvable field is excluded — it cannot
 * discriminate between arms and would only inflate the denominator.
 *
 * The module is deliberately honest about what it can and cannot price:
 *
 * - With the deterministic hash provider it is a **harness proof**: the wiring runs end to end
 *   on real cached SQL and real profiles, but a hash vector is a lexical stand-in, not a semantic
 *   model. The emitted note says so.
 * - With a hosted `EmbeddingProvider` injected by the Org-secret workflow it is a **priced
 *   reading**: the same code path, a real embedding space. Even then the number is a *grounding*
 *   price (did the retrieved fields cover what the gold SQL needs), not an execution-accuracy
 *   claim — prompt coverage is a necessary but not sufficient condition for correct SQL.
 *
 * No product package, default arm or shipped SQL is changed here. Promoting the fused arm into
 * `SHIPPED_SQL` remains a separate decision that requires this price to clear a pre-registered
 * threshold in a real dispatch.
 */
import { mcnemarExact } from '@agentix-e/nl2charts-devkit';
import type { DatabaseProfile, EmbeddingProvider } from '@agentix-e/nl2charts-ai';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { buildFusedValueBlock } from './fused-values.js';
import { goldKeys } from './gold-fields.js';
import type { ValueMatch } from './values.js';

/** The note pinned into every report so no reader quotes a harness proof as a price. */
export const PRICING_NOTE = 'PRICING RUN — paired question-level McNemar of lexical values vs fused '
  + 'value grounding. A hash-provider run is a HARNESS PROOF, NOT an accuracy claim; a hosted-provider '
  + 'run prices prompt grounding coverage, NOT execution accuracy. Promotion to SHIPPED_SQL needs a '
  + 'pre-registered threshold met in a real dispatch.';

/** One question priced on both arms. Fields are canonical `table.column` keys. */
export interface PricedCase {
  readonly question_id: number;
  readonly question: string;
  readonly gold: readonly string[];
  readonly lexical: readonly string[];
  readonly semantic: readonly string[];
}

export interface PriceOptions {
  readonly signal?: AbortSignal;
}

/**
 * Whether an arm retrieved every gold field of a question.
 *
 * A question with no gold fields returns false: it cannot be a discordant pair, and counting it
 * as "covered" on both arms would add an agreement row that carries no information. Extra fields
 * outside gold are harmless here — this is coverage, not precision; spurious fields are priced
 * by `value-pair-harness` separately.
 */
export function armCoversGold(gold: readonly string[], arm: readonly string[]): boolean {
  if (gold.length === 0) return false;
  const found = new Set(arm);
  return gold.every((field) => found.has(field));
}

/** Aggregate report of a paired pricing run. */
export interface PricingReport {
  readonly note: string;
  readonly questions: number;
  /** Both arms fully covered the gold. */
  readonly bothFull: number;
  /** Only the fused arm fully covered the gold (b). */
  readonly fusedOnly: number;
  /** Only the lexical arm fully covered the gold (c). */
  readonly lexicalOnly: number;
  /** Neither arm fully covered the gold. */
  readonly neitherFull: number;
  readonly discordant: number;
  /** Two-sided exact McNemar p over (fusedOnly, lexicalOnly); 1 when none. */
  readonly mcnemarP: number;
  /** Mean gold-field coverage of the lexical arm, over questions with gold. */
  readonly lexicalCoverage: number;
  /** Mean gold-field coverage of the fused arm, over questions with gold. */
  readonly semanticCoverage: number;
  /** Field-level confirmed gain (fused - lexical), summed over questions with gold. */
  readonly confirmedGain: number;
}

/**
 * Price a set of already-built cases. Pure: no provider, no I/O, fully auditable.
 *
 * The discordant pair is the price. Field coverages and confirmed gain are reported alongside
 * as evidence for *why* the pair moved, never substituted for it. A single coverage ratio is
 * exactly the "near-gold" reading r217 showed can flip sign under a wrong gold source, so it is
 * labelled evidence and computed against the same canonical gold the pair uses.
 */
export function priceArms(cases: readonly PricedCase[]): PricingReport {
  let bothFull = 0;
  let fusedOnly = 0;
  let lexicalOnly = 0;
  let neitherFull = 0;
  let goldTotal = 0;
  let lexicalHits = 0;
  let semanticHits = 0;
  let confirmedGain = 0;

  for (const item of cases) {
    if (item.gold.length === 0) continue;
    const lexicalFull = armCoversGold(item.gold, item.lexical);
    const semanticFull = armCoversGold(item.gold, item.semantic);
    if (lexicalFull && semanticFull) bothFull += 1;
    else if (!lexicalFull && semanticFull) fusedOnly += 1;
    else if (lexicalFull && !semanticFull) lexicalOnly += 1;
    else neitherFull += 1;

    const lexicalSet = new Set(item.lexical);
    const semanticSet = new Set(item.semantic);
    let lexicalHere = 0;
    let semanticHere = 0;
    for (const field of item.gold) {
      if (lexicalSet.has(field)) lexicalHere += 1;
      if (semanticSet.has(field)) semanticHere += 1;
    }
    goldTotal += item.gold.length;
    lexicalHits += lexicalHere;
    semanticHits += semanticHere;
    confirmedGain += semanticHere - lexicalHere;
  }

  const questions = bothFull + fusedOnly + lexicalOnly + neitherFull;
  const discordant = fusedOnly + lexicalOnly;
  return {
    note: PRICING_NOTE,
    questions,
    bothFull,
    fusedOnly,
    lexicalOnly,
    neitherFull,
    discordant,
    mcnemarP: mcnemarExact(fusedOnly, lexicalOnly),
    lexicalCoverage: goldTotal === 0 ? 0 : lexicalHits / goldTotal,
    semanticCoverage: goldTotal === 0 ? 0 : semanticHits / goldTotal,
    confirmedGain,
  };
}

/** The cached dev question shape BIRD ships. */
export interface DevQuestion {
  readonly question_id: number;
  readonly question: string;
  readonly db_id: string;
  readonly SQL: string;
}

/**
 * Build one priced case from a real dev question.
 *
 * Gold comes from the question's own SQL via `goldKeys` (canonical, profile-resolved), never from
 * question words. The lexical arm is supplied by the caller from the cached `ValueIndex`; the
 * fused arm runs `buildFusedValueBlock` with the injected provider and contributes only fields its
 * semantic component supplied that are not already lexical — so the two arms share one canonical
 * `table.column` space and the comparison is like-for-like.
 */
export async function buildPricedCase(
  item: DevQuestion,
  profile: DatabaseProfile,
  lexical: readonly ValueMatch[],
  provider: EmbeddingProvider,
  options: PriceOptions = {},
): Promise<PricedCase> {
  const gold = [...goldKeys(item.SQL, profile)].sort();
  const lexicalFields = [...new Set(lexical.map((match) => `${match.table}.${match.column}`))].sort();
  const block = await buildFusedValueBlock(item.question, profile, lexical, provider, {
    signal: options.signal,
  });
  const semanticFields = [
    ...new Set(
      block.rows
        .filter((row) => row.source === 'semantic')
        .map((row) => `${row.table}.${row.column}`),
    ),
  ]
    .filter((field) => !lexicalFields.includes(field))
    .sort();
  return {
    question_id: item.question_id,
    question: item.question,
    gold,
    lexical: lexicalFields,
    semantic: semanticFields,
  };
}

/** A human-readable rendering of the report, with the note on top. */
export function renderPricing(report: PricingReport): string {
  const lines = [
    report.note,
    `questions priced: ${String(report.questions)}`,
    `full coverage — both: ${String(report.bothFull)}  fused only: ${String(report.fusedOnly)}  `
      + `lexical only: ${String(report.lexicalOnly)}  neither: ${String(report.neitherFull)}`,
    `discordant pairs: ${String(report.discordant)}  McNemar exact p = ${report.mcnemarP.toFixed(4)}`,
    `field coverage — lexical: ${(report.lexicalCoverage * 100).toFixed(2)}%  `
      + `fused: ${(report.semanticCoverage * 100).toFixed(2)}%  `
      + `confirmed gain (fields): ${String(report.confirmedGain)}`,
  ];
  return lines.join('\n');
}

/** Real filesystem reader for the CLI, exported so its behaviour is testable without the cache. */
export function fsReader(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

/** The CLI seam: reader, logger and provider are injected — CI has no gitignored cache or key. */
export async function runPricing(
  read: (path: string) => string,
  log: (text: string) => void,
  provider: EmbeddingProvider,
  limit: number,
): Promise<void> {
  const cache = join('eval', '.cache', 'bird');
  const dev = JSON.parse(read(join(cache, 'dev', 'dev_20240627', 'dev.json'))) as DevQuestion[];
  const loadProfile = (dbId: string): DatabaseProfile => JSON.parse(
    read(join(cache, 'profiles', `${dbId}.json`)),
  ) as DatabaseProfile;
  const profiles = new Map<string, DatabaseProfile>();
  const cases: PricedCase[] = [];
  for (const item of dev.slice(0, limit)) {
    let profile = profiles.get(item.db_id);
    if (profile === undefined) {
      profile = loadProfile(item.db_id);
      profiles.set(item.db_id, profile);
    }
    // The lexical arm the product actually ships reads exact value matches from the profile.
    // Here the same profile vocabulary supplies them: a question word that equals a stored value.
    const needle = item.question.toLowerCase();
    const lexical: ValueMatch[] = profile.columns
      .filter((column) => needle.includes(column.column.toLowerCase()))
      .flatMap((column) => (column.values ?? [])
        .filter((value) => needle.includes(value.toLowerCase()))
        .map((value) => ({ table: column.table, column: column.column, value })));
    cases.push(await buildPricedCase(item, profile, lexical, provider));
  }
  const report = priceArms(cases);
  log(JSON.stringify(report, null, 2));
}

/** Whether this module is running as the CLI rather than imported. */
export function isEntryPoint(argv1: string | undefined): boolean {
  return argv1 !== undefined && argv1.endsWith('value-pricing.ts');
}

/** The real stdout logger, exported so its behaviour is testable like `fsReader`. */
export function stdoutLogger(text: string): void {
  console.log(text);
}

/**
 * CLI entry. The provider is chosen here (hash by default so the command runs with no key);
 * the Org-secret workflow injects a hosted provider by importing `runPricing` directly. Keeping
 * provider construction out of `runPricing` is what makes that substitution a one-line change.
 */
export async function main(
  read: (path: string) => string = fsReader,
  log: (text: string) => void = stdoutLogger,
): Promise<void> {
  const limit = Number(process.env.VALUE_PRICING_LIMIT ?? '60');
  const { createHashEmbeddingProvider } = await import('@agentix-e/nl2charts-ai');
  await runPricing(read, log, createHashEmbeddingProvider(), limit);
}

if (isEntryPoint(process.argv[1])) {
  void main();
}
