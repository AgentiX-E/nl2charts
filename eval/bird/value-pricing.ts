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
import {
  createHashEmbeddingProvider,
  createHttpEmbeddingProvider,
  type DatabaseProfile,
  type EmbeddingProvider,
} from '@agentix-e/nl2charts-ai';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { buildFusedValueBlock } from './fused-values.js';
import { goldKeys } from './gold-fields.js';
import { buildValueIndex, findValues, type ValueMatch } from './values.js';
import { billOf } from '../price.js';

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

/**
 * The lexical arm the product actually ships — delegated, never reimplemented.
 *
 * Rounds 215-219 priced the fused arm against a hand-written stand-in that required the question
 * to name both the column and the value. The real product (`eval/bird/run.ts`, the `values` arm)
 * resolves a question token to a stored value with `findValues(buildValueIndex(profile), question)`.
 * On the real dev split the stand-in missed 228 of the 253 questions the product arm grounds — a
 * straw man that inflated the fused arm's apparent gain. This function is the single source of the
 * lexical baseline; `runPricing` must call it so a price can never be taken against a weaker arm.
 */
export function shippedLexicalArm(profile: DatabaseProfile, question: string): ValueMatch[] {
  return findValues(buildValueIndex(profile), question);
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
    // The baseline is the product's own `values` arm — the same function `run.ts` uses to build
    // the shipped prompt. Never reimplement it here: a lexical stand-in that is weaker than the
    // product would inflate the fused arm's apparent gain (see `shippedLexicalArm`).
    const lexical = shippedLexicalArm(profile, item.question);
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
 * A conservative input-token ceiling for one priced question.
 *
 * Each case embeds a profile's value vocabulary once (`buildSemanticIndex`) and the question once
 * (`searchSemanticValues`). The vocabulary is capped by the semantic index's own sample limit, so
 * four thousand tokens sits above every case this repository has rendered offline. The number is a
 * bound used to *refuse* an over-budget dispatch before it spends anything: an over-estimate
 * refuses a little early, an under-estimate is the failure mode that costs money.
 */
export const PRICING_PER_CASE_TOKENS = 4000;

/** What `questions` cases would cost at the per-case bound, or undefined when the model has no price. */
export function projectedPricingYuan(questions: number, model: string): number | undefined {
  const per = billOf(model, { promptTokens: PRICING_PER_CASE_TOKENS, completionTokens: 0 });
  return per === undefined ? undefined : per * questions;
}

/**
 * Refuse a hosted pricing dispatch whose projected cost exceeds the authorised yuan ceiling.
 *
 * The local hash provider has no row in the price table and no ceiling; it is a zero-cost harness
 * proof and must not be blocked. A hosted model *with* a ceiling but *without* a price row is
 * refused loudly: a dispatch that intended to spend real money cannot be costed, and the whole point
 * of the price table is that "no price on file" is printed before the bill, not after it.
 */
export function enforceCostCeiling(model: string, questions: number, ceiling: number | undefined): void {
  const projected = projectedPricingYuan(questions, model);
  if (projected === undefined) {
    if (ceiling !== undefined) {
      throw new Error(
        `no price on file for ${model}; a hosted dispatch must be costed before it spends tokens`,
      );
    }
    return;
  }
  if (ceiling !== undefined && projected > ceiling) {
    throw new Error(
      `projected pricing cost ${projected.toFixed(4)} yuan for ${String(questions)} questions `
      + `exceeds the ${String(ceiling)} yuan ceiling; refusing before any embed call`,
    );
  }
}

/**
 * Choose the embedding provider from the environment — the seam the Org-secret workflow uses.
 *
 * With no hosted configuration this is the deterministic hash provider, so the CLI runs with no
 * key and the reading is a HARNESS PROOF. With a full hosted configuration (base URL + model) it
 * builds an OpenAI-compatible HTTP provider; the key is read from the environment by the caller
 * and passed in `env`, never stored here. A *partial* hosted configuration is refused rather than
 * silently falling back to hash: a dispatch that intended a real provider but lost one variable
 * must fail loudly, not quietly price a straw man and report it as a real reading.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const baseUrl = env.PRICING_EMBEDDING_BASE_URL;
  const model = env.PRICING_EMBEDDING_MODEL;
  const apiKey = env.PRICING_EMBEDDING_API_KEY;
  const hasBase = baseUrl !== undefined && baseUrl !== '';
  const hasModel = model !== undefined && model !== '';
  const hasKey = apiKey !== undefined && apiKey !== '';
  // No hosted signal at all: the deterministic local provider.
  if (!hasBase && !hasModel && !hasKey) return createHashEmbeddingProvider();
  // Any hosted signal means the caller intended a real provider. A partial one is refused, not
  // downgraded: a dispatch that lost one variable must not quietly price a straw man as real.
  if (!hasBase || !hasModel) {
    throw new Error(
      'PRICING_EMBEDDING_BASE_URL and PRICING_EMBEDDING_MODEL must be set together; '
      + 'a partial hosted config is refused rather than downgraded to the hash provider',
    );
  }
  return createHttpEmbeddingProvider({ baseUrl, model, apiKey });
}

/**
 * CLI entry. The provider is chosen from the environment by `providerFromEnv`: hash by default
 * so the command runs with no key, hosted when the Org-secret workflow injects the variables.
 * Keeping provider construction out of `runPricing` is what makes that substitution one line.
 */
export async function main(
  read: (path: string) => string = fsReader,
  log: (text: string) => void = stdoutLogger,
): Promise<void> {
  const limit = Number(process.env.VALUE_PRICING_LIMIT ?? '60');
  const rawCeiling = process.env.VALUE_PRICING_ACCEPT_COST;
  const ceiling = rawCeiling === undefined || rawCeiling === '' ? undefined : Number(rawCeiling);
  if (ceiling !== undefined && (!Number.isFinite(ceiling) || ceiling <= 0)) {
    throw new Error(`VALUE_PRICING_ACCEPT_COST must be a positive number of yuan, got ${rawCeiling}`);
  }
  const provider = providerFromEnv();
  // Enforced before `runPricing` issues a single embed call: an over-budget or unpriceable hosted
  // dispatch spends nothing. The hash provider has no price row, so a harness proof is never blocked.
  enforceCostCeiling(provider.model, limit, ceiling);
  await runPricing(read, log, provider, limit);
}

if (isEntryPoint(process.argv[1])) {
  void main();
}
