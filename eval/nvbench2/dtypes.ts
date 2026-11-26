/**
 * Which kind of column the golds put on which channel.
 *
 * The `misplaced` bucket is the second-largest of the test split's field-first misses: 151 of 465
 * replies name a column a gold names, on a channel no gold puts it on. That is an assignment error,
 * not a choice error, so no rule about *which* column to pick can fix it — what is missing is a rule
 * about which kind of column a channel accepts. This module is the count that rule is allowed to
 * cite, and it is computed from the corpus rather than remembered.
 *
 * The split answers it sharply. Channel by channel, over both splits:
 *
 * - `color` is a categorical column in **every** encoding that names one — a measure on color is not
 *   a rare disagreement with the golds, it is a category error;
 * - `theta` and `size` are quantitative in every encoding, and `size` is aggregated in all of them;
 * - `x` never carries an aggregate, over three and a half thousand encodings;
 * - `y` is where an aggregate goes when there is one, and it is a category in a third of its uses
 *   (a horizontal bar), so `y` alone does not decide.
 *
 * Counts, never rates, and the denominator travels with them (`encodings`) because a share whose
 * denominator is unstated is how a rule about 5 of 6 encodings reads like a rule about all of them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSplit, resolveTypes, type SplitRow } from './check.js';
import type { FieldTypes } from './judge.js';

/** What a channel's encodings are made of, per split or pooled. */
export interface DtypeFacts {
  /** Field encodings counted, which is the denominator of every share here. */
  readonly encodings: number;
  /** Of those, the ones whose field the type map does not name — a fact about the map, not the rule. */
  readonly unknown: number;
  /** Channel → dtype → encodings. */
  readonly channels: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Channel → encodings that name an aggregate there. */
  readonly aggregated: Readonly<Record<string, number>>;
  /** Channel → encodings that name no aggregate. */
  readonly raw: Readonly<Record<string, number>>;
}

/** One channel's encoding, reduced to the three things the counts need. */
interface Encoding {
  readonly channel: string;
  readonly field: string;
  readonly aggregated: boolean;
}

/** Every encoding a chart carries, in the order it lists them. A bare string channel is a field. */
function encodingsOf(chart: Readonly<Record<string, unknown>>): Encoding[] {
  const encoding = chart['encoding'];
  if (typeof encoding !== 'object' || encoding === null || Array.isArray(encoding)) return [];
  const out: Encoding[] = [];
  for (const [channel, spec] of Object.entries(encoding as Record<string, unknown>)) {
    if (typeof spec === 'string') {
      out.push({ channel, field: spec, aggregated: false });
      continue;
    }
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) continue;
    const field = (spec as Record<string, unknown>)['field'];
    if (typeof field !== 'string') continue;
    const aggregate = (spec as Record<string, unknown>)['aggregate'];
    out.push({ channel, field, aggregated: typeof aggregate === 'string' && aggregate.length > 0 });
  }
  return out;
}

/**
 * A column's dtype, as the type map states it.
 *
 * The corpus's golds and its type map do not always agree on case (`PaperId` against `paperid`), and a
 * lookup that misses would report the encoding as untyped — which reads as a rule about the corpus
 * when it is a rule about string comparison. So the exact key is tried first and a case-folded match
 * second, and a genuine miss is counted in `unknown` rather than dropped.
 */
export function dtypeOf(types: FieldTypes, field: string): string {
  const exact = types[field];
  if (typeof exact === 'string') return exact;
  const folded = field.toLowerCase();
  for (const [name, dtype] of Object.entries(types)) {
    if (name.toLowerCase() === folded && typeof dtype === 'string') return dtype;
  }
  return 'unknown';
}

/** The counts, over whatever rows are handed in. Pure: no file, no clock, no environment. */
export function dtypesOf(rows: readonly SplitRow[], types: Readonly<Record<string, FieldTypes>>): DtypeFacts {
  const channels: Record<string, Record<string, number>> = {};
  const aggregated: Record<string, number> = {};
  const raw: Record<string, number> = {};
  let encodings = 0;
  let unknown = 0;

  for (const row of rows) {
    const table = types[row.csv] ?? {};
    for (const chart of row.golds) {
      if (typeof chart !== 'object' || chart === null || Array.isArray(chart)) continue;
      for (const encoding of encodingsOf(chart as Readonly<Record<string, unknown>>)) {
        const dtype = dtypeOf(table, encoding.field);
        const byDtype = (channels[encoding.channel] ??= {});
        byDtype[dtype] = (byDtype[dtype] ?? 0) + 1;
        const bucket = encoding.aggregated ? aggregated : raw;
        bucket[encoding.channel] = (bucket[encoding.channel] ?? 0) + 1;
        encodings += 1;
        if (dtype === 'unknown') unknown += 1;
      }
    }
  }

  return { encodings, unknown, channels, aggregated, raw };
}

/** The share a channel gives one dtype, as a fraction of that channel's own encodings. */
export function shareOf(facts: DtypeFacts, channel: string, dtype: string): number {
  const byDtype = facts.channels[channel] ?? {};
  const total = Object.values(byDtype).reduce((sum, count) => sum + count, 0);
  return total === 0 ? 0 : (byDtype[dtype] ?? 0) / total;
}

/** One line a log can carry, so a run states the shape the rule is about before it spends anything. */
export function dtypesLine(facts: DtypeFacts): string {
  const parts = Object.keys(facts.channels).sort().map((channel) => {
    const byDtype = facts.channels[channel] ?? {};
    const total = Object.values(byDtype).reduce((sum, count) => sum + count, 0);
    const categorical = byDtype['category'] ?? 0;
    const quantitative = byDtype['quantitative'] ?? 0;
    const named = categorical >= quantitative
      ? `category ${String(categorical)}/${String(total)}`
      : `quantitative ${String(quantitative)}/${String(total)}`;
    const withAggregate = facts.aggregated[channel] ?? 0;
    return `${channel}: ${named}, aggregate ${String(withAggregate)}/${String(total)}`;
  });
  return `gold channels: ${String(facts.encodings)} encoding(s), ${String(facts.unknown)} untyped · ${parts.join(' · ')}`;
}

/** Where the corpus and its type map live, and how to read them. Injected so the CLI is testable. */
export interface MainDeps {
  readonly readText?: (path: string) => string;
  readonly log?: (line: string) => void;
}

/** The flags this tool documents. */
export interface MainOptions {
  readonly split: string;
  readonly cache: string;
}

/** `--split dev --cache eval/.cache/nvbench2`, and nothing else: a tool with no state has no config. */
export function parseArgs(argv: readonly string[]): MainOptions {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  return { split: value('--split') ?? 'dev', cache: value('--cache') ?? 'eval/.cache/nvbench2' };
}

/**
 * Print the channel table of a split, then stop.
 *
 * Read-only and offline: it opens the split and the type map the metadata step built, and it makes no
 * request. The JSON it prints is what `metrics.json` records under `dtypes`, so a rule that cites a
 * count cites something a reader can rebuild for nothing.
 */
export function main(argv: readonly string[], deps: MainDeps = {}): number {
  const readText = deps.readText ?? ((path: string): string => readFileSync(path, 'utf8'));
  const log = deps.log ?? ((line: string): void => { process.stdout.write(`${line}\n`); });
  const options = parseArgs(argv);

  const splitPath = join(options.cache, `${options.split}.json`);
  let rows: SplitRow[];
  try {
    rows = parseSplit(readText(splitPath));
  } catch (error) {
    throw new Error(`cannot read ${splitPath}: ${(error as Error).message} — run \`node eval/nvbench2/fetch.mjs\` first`);
  }
  const metadataPath = join(options.cache, 'metadata.json');
  let types: Readonly<Record<string, FieldTypes>>;
  try {
    types = resolveTypes(JSON.parse(readText(metadataPath)));
  } catch (error) {
    throw new Error(`cannot read ${metadataPath}: ${(error as Error).message} — run \`pnpm bench:nvbench2:metadata\``);
  }

  const facts = dtypesOf(rows, types);
  log(dtypesLine(facts));
  log(JSON.stringify(facts, null, 2));
  return facts.encodings === 0 ? 2 : 0;
}

/** Whether this module was run rather than imported, which is the only thing the entry checks. */
export function runsAsMain(argv1: string | undefined): boolean {
  return argv1?.endsWith('dtypes.ts') === true || argv1?.endsWith('dtypes.js') === true;
}

if (runsAsMain(process.argv[1])) process.exitCode = main(process.argv.slice(2));
