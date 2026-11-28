/**
 * Fuse the two value-retrieval arms into one prompt block the product already knows how to read.
 *
 * The `values` arm shipped with a lexical index (`findValues`): it matches a word in the question
 * to a *stored* value, drops an ambiguous word that lands in more than one column, and keeps at
 * most one hit per word. That is precise but blind to a value the question only paraphrases. The
 * semantic index added in r215 (`buildSemanticIndex` / `searchSemanticValues`) can recall such a
 * value by embedding similarity, but until this module it was consumed only by tests — a reader
 * could not get its hits onto a SQL prompt.
 *
 * This module is that wiring, and nothing more. It does not change the product package, does not
 * turn the semantic arm on by default, and does not claim an accuracy gain. It produces the same
 * heading-free `- table.column stores 'value'` lines `renderValues` has always produced, so the
 * one prompt seam (`PromptOptions.values`) consumes either arm's output byte for byte. The gain,
 * if any, is a question for a paired dispatch with a priced provider; this is the harness that
 * makes such a dispatch possible without rewriting the generator.
 */

import type { DatabaseProfile, EmbeddingProvider } from '@agentix-e/nl2charts-ai';
import { buildSemanticIndex, searchSemanticValues, type SemanticHit } from './semantic-values.js';
import type { ValueMatch } from './values.js';

/** One line of the fused block, tagged so an auditor can see which arm supplied it. */
export interface FusedValue {
  readonly table: string;
  readonly column: string;
  readonly value: string;
  readonly source: 'lexical' | 'semantic';
  /** 1 for an exact lexical hit; the cosine score for a semantic hit. */
  readonly score: number;
}

export interface FuseOptions {
  /** At most this many semantic hits per table.column; lexical hits are never capped. */
  readonly perColumn?: number;
}

export interface BuildOptions {
  readonly k?: number;
  readonly minScore?: number;
  readonly perColumn?: number;
  readonly maxChars?: number;
  readonly signal?: AbortSignal;
}

export interface FusedValueBlock {
  readonly text: string;
  readonly rows: readonly FusedValue[];
  readonly lexicalCount: number;
  readonly semanticCount: number;
  readonly fusedCount: number;
}

/** Identity of a value line. The same value found by both arms is one line, not two. */
function identity(value: FusedValue): string {
  return `${value.table}\u0000${value.column}\u0000${value.value}`;
}

/** Field key for the per-column cap, identical to the semantic index's own cap. */
function fieldKey(value: FusedValue): string {
  return `${value.table}\u0000${value.column}`;
}

/**
 * Merge a lexical arm's exact hits with a semantic arm's similarity hits.
 *
 * Provenance is decided before ordering: a value named exactly in the question is `lexical`, even
 * when the semantic arm also found it, because the exact reading is the one the prompt should
 * claim. Lexical rows keep their input order (the lexical index already applies its ambiguity
 * guard); semantic rows are sorted by descending score and broken by identity for reproducibility,
 * then capped per column so one prolific column cannot crowd out the rest.
 */
export function fuseValues(
  lexical: readonly ValueMatch[],
  semantic: readonly SemanticHit[],
  options: FuseOptions = {},
): FusedValue[] {
  const perColumn = options.perColumn ?? 1;
  const seen = new Set<string>();
  const rows: FusedValue[] = [];

  for (const match of lexical) {
    const row: FusedValue = {
      table: match.table,
      column: match.column,
      value: match.value,
      source: 'lexical',
      score: 1,
    };
    const key = identity(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }

  const candidates: FusedValue[] = [];
  for (const hit of semantic) {
    // A column-name hit carries no stored value; it is not a grounding line. The semantic search
    // already applies perColumn, but the cap is repeated here so a caller that supplies hits from
    // another source cannot smuggle a flooded column into the block.
    if (hit.field.value === undefined) continue;
    candidates.push({
      table: hit.field.table,
      column: hit.field.column,
      value: hit.field.value,
      source: 'semantic',
      score: hit.score,
    });
  }
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const left = identity(a);
    const right = identity(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });

  const used = new Map<string, number>();
  for (const row of candidates) {
    const key = identity(row);
    if (seen.has(key)) continue;
    const field = fieldKey(row);
    if ((used.get(field) ?? 0) >= perColumn) continue;
    seen.add(key);
    used.set(field, (used.get(field) ?? 0) + 1);
    rows.push(row);
  }
  return rows;
}

/** Render fused values as the same heading-free lines the product's `values` seam expects. */
export function renderFusedValues(rows: readonly FusedValue[], maxChars = 700): string {
  const lines: string[] = [];
  let used = 0;
  for (const row of rows) {
    const line = `- ${row.table}.${row.column} stores '${row.value}'`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * Run both arms on a question and fuse them, with the semantic arm's provider injected.
 *
 * The lexical hits are supplied by the caller (the real `values` arm reads them from its cached
 * `ValueIndex`); the semantic index is built here from the profile so the caller needs only a
 * profile and a provider. `buildSemanticIndex` owns the provider/model/dimension contract, so a
 * mismatched or drifted provider is rejected before any line is produced.
 */
export async function buildFusedValueBlock(
  question: string,
  profile: DatabaseProfile,
  lexical: readonly ValueMatch[],
  provider: EmbeddingProvider,
  options: BuildOptions = {},
): Promise<FusedValueBlock> {
  const index = await buildSemanticIndex(profile, provider, {
    signal: options.signal,
  });
  const hits = await searchSemanticValues(index, question, provider, {
    k: options.k,
    minScore: options.minScore,
    perColumn: options.perColumn,
    signal: options.signal,
  });
  const rows = fuseValues(lexical, hits, { perColumn: options.perColumn });
  const text = renderFusedValues(rows, options.maxChars);
  const lexicalCount = rows.filter((row) => row.source === 'lexical').length;
  return {
    text,
    rows,
    lexicalCount,
    semanticCount: rows.length - lexicalCount,
    fusedCount: rows.length,
  };
}
