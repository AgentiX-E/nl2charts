/**
 * The zero-shot arm: one call per question, `k` Vega-Lite fragments back, scored by the ported judge.
 *
 * ## Why this arm exists and what it is comparable with
 *
 * Every Text2Viz number this repository has published is a reading about *mark choice* — an answer of
 * one word against eleven options. nvBench 2.0 asks a different question: a table and a sentence in,
 * a **set** of Vega-Lite specifications out, scored on the fields, the aggregates and the filters that
 * make one chart the same chart as another. No number here could be placed on that leaderboard, and
 * the gap was recorded as a method gap (ADR 0001).
 *
 * The comparable configuration is the corpus's own **prompting** baseline, ≈58.96 F1@3, not the 81.50
 * a system trained on the benchmark reads. So this arm sends a table and a question and asks for
 * charts, and nothing about it is fitted to the corpus: no few-shot examples taken from the split, no
 * schema linking against the gold fields, no repair loop over the judge.
 *
 * ## What the prompt promises, and why every promise is enforced twice
 *
 * A reply is a JSON array of chart fragments. The parser is strict on purpose — an entry whose mark is
 * not in `SPEC_MARKS` is not a chart this repository can compare, and reading a paragraph for the
 * nearest mark would be this file choosing instead of the model. Three tolerances are allowed because
 * they are formatting rather than content: a code fence, prose around the array, and a reply that
 * names fewer charts than asked for.
 *
 * The `k` is a *scoring* parameter (3 and 5), and asking for `k` in one call is a deliberate choice
 * against asking `k` times: one call per question costs a third of the prompt three times over, and
 * the corpus's own questions have two to five valid answers, so the model is being asked what it
 * already knows rather than sampled.
 *
 * ## The filter is part of the answer
 *
 * 778 of dev's 2,321 golds carry a `transform`, and the judge compares transforms. A model that names
 * the right fields and forgets `"authorder" >= 2` produced a different chart, and the arm does not
 * paper over that by dropping the channel before comparing: the instruction says to emit the filter,
 * and the reading says how often it did.
 *
 * ## Cost
 *
 * One call per question, `k` fragments out, temperature 0, answers content-addressed on the exact
 * request. A second dispatch of an unchanged prompt costs nothing, which is what makes a prompt edit
 * affordable to measure rather than argue about.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHttpProvider, withCallCounter, type LlmProvider } from '@agentix-e/nl2charts-ai';
import { billOf, formatYuan, type TokenCounts } from '../price.js';
import { cacheKey, openStore, type CacheIdentity, type ContentStore } from '../text2vis/content-store.js';
import { runIfEntry } from '../entry.js';
import { parseSplit, resolveTypes, type SplitRow } from './check.js';
import { factsOf, type GoldFacts } from './facts.js';
import { readingOf, type Case, type Chart, type FieldTypes, type Reading } from './judge.js';

/**
 * Bumped when the instruction, the mark list or the reply format changes meaning.
 *
 * The text is hashed into the answer's key, so a changed sentence is already a miss; this number
 * covers what a hash cannot see — a reply format whose *meaning* changed while its bytes did not.
 */
export const PROMPT_VERSION = 1;

/** The marks the corpus uses, which is also the list the model is offered. */
export const SPEC_MARKS = ['bar', 'line', 'point', 'rect', 'arc', 'boxplot'] as const;
export type SpecMark = (typeof SPEC_MARKS)[number];

/** Channels the judge compares. A channel outside this list is not a channel the reference reads. */
export const SPEC_CHANNELS = ['x', 'y', 'theta', 'color', 'size'] as const;

/** Aggregates that appear in the corpus. A model may name any of them. */
export const SPEC_AGGREGATES = ['count', 'sum', 'mean', 'min', 'max'] as const;

/** The identity of one answer: what was said to which model, under which prompt. */
function identityOf(system: string, user: string, model: string, maxTokens: number): CacheIdentity {
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    model,
    thinking: undefined,
    maxTokens,
    temperature: 0,
  };
}

/**
 * The instruction, and the table it is about.
 *
 * The two messages are separate for the reason `eval/text2vis/llm.ts` gives: the system half is
 * byte-identical across the run, so a provider's prefix cache is a discount rather than a hope. The
 * fields are listed with the type map's own word for each one, because the reference reverses axes by
 * type and a model that guesses a type produces a chart the corpus calls transposed.
 */
export function buildSpecPrompt(
  row: Pick<SplitRow, 'question'>,
  types: FieldTypes,
  k: number,
): readonly [string, string] {
  const system = [
    'You write Vega-Lite specifications that answer questions about one table.',
    `Return a JSON array of at most ${String(k)} charts, most likely first. Every element has exactly these keys:`,
    '"mark", "encoding", and "transform" only when the question restricts the rows.',
    `"mark" is one of: ${SPEC_MARKS.join(', ')}.`,
    `"encoding" maps channels (${SPEC_CHANNELS.join(', ')}) to objects of the form {"field": "...", "aggregate": "..."}.`,
    'Use the column names exactly as they appear in the table. Name an aggregate',
    `(${SPEC_AGGREGATES.join(', ')}) whenever the question asks for a count, a total, or an average.`,
    'When the question restricts the data, add "transform": [{"filter": {"field": "...", "gte": 2}}]',
    'using one of equal, lt, lte, gt, gte, range, oneOf.',
    'Answer with the array and nothing else: no prose, no code fence, no explanation.',
  ].join('\n');
  const fields = Object.entries(types)
    .map(([name, kind]) => `${name} (${kind})`)
    .join(', ');
  const user = [`Table columns: ${fields}`, `Question: ${row.question}`].join('\n');
  return [system, user];
}

/** The same array without its repeats, in the order the model wrote them. */
function dedupe(charts: readonly Chart[]): Chart[] {
  const seen = new Set<string>();
  const out: Chart[] = [];
  for (const chart of charts) {
    const canonical = JSON.stringify(chart);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(chart);
  }
  return out;
}

/** Whether one channel is a channel the reference can compare: a field, an aggregate, or both. */
function channelOk(value: unknown): boolean {
  if (!isRecordLike(value)) return false;
  const field = value['field'];
  const aggregate = value['aggregate'];
  if (field !== undefined && typeof field !== 'string') return false;
  if (aggregate !== undefined && typeof aggregate !== 'string') return false;
  return field !== undefined || aggregate !== undefined;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One candidate chart, or `undefined` when the entry is not a chart.
 *
 * Only three keys survive: `mark`, `encoding`, `transform`. The judge compares the keys it knows and
 * then every key it does not, so a reply carrying a `"title"` or a `"width"` would be unequal to a
 * gold describing the same chart. Dropping them is not generosity; it is refusing to score
 * typography, which is the reduction ADR 0001 states.
 */
export function chartOf(entry: unknown): Chart | undefined {
  if (!isRecordLike(entry)) return undefined;
  const mark = entry['mark'];
  if (typeof mark !== 'string' || !(SPEC_MARKS as readonly string[]).includes(mark)) return undefined;
  const encoding = entry['encoding'];
  if (!isRecordLike(encoding)) return undefined;
  const kept: Record<string, unknown> = {};
  for (const channel of SPEC_CHANNELS) {
    const value = encoding[channel];
    if (value === undefined) continue;
    if (!channelOk(value)) return undefined;
    kept[channel] = value;
  }
  if (Object.keys(kept).length === 0) return undefined;
  const chart: Record<string, unknown> = { mark, encoding: kept };
  const transform = entry['transform'];
  if (Array.isArray(transform) && transform.length > 0) chart['transform'] = transform;
  return chart;
}

/**
 * The candidate list a reply is worth, or an empty list when the reply is not one.
 *
 * The array is found rather than demanded at position zero: a chat endpoint that wraps JSON in a
 * sentence is answering the question, and refusing it would score the wrapper. What is *not* found
 * for it is a second array — the first `[` and the last `]` are the only pair tried, so a reply
 * containing two answers is read as one malformed answer rather than as two.
 */
export function parseSpecs(text: string, k: number): Chart[] {
  if (k <= 0) return [];
  const cleaned = text
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/, '')
    .trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  // A slice that starts at `[` and parses is an array by construction, so there is no branch here
  // for the non-array case: a reply whose brackets do not enclose valid JSON never reaches this line.
  const charts: Chart[] = [];
  for (const entry of parsed as unknown[]) {
    const chart = chartOf(entry);
    if (chart !== undefined) charts.push(chart);
  }
  return dedupe(charts).slice(0, k);
}

/** One stored answer: what the model wrote, and what the call was billed for. */
export interface StoredAnswer {
  readonly version: number;
  readonly model: string;
  readonly reply: string;
  readonly truncated: boolean;
  readonly usage?: TokenCounts;
}

/**
 * A stored answer, if the parsed file is one — every field checked rather than trusted.
 *
 * `expectModel` is optional because a store is also read without an expectation, and the model that
 * wrote the entry is then read *from* the entry rather than compared with nothing.
 */
export function answerOf(parsed: unknown, expectModel?: string): StoredAnswer | undefined {
  if (!isRecordLike(parsed)) return undefined;
  if (parsed['version'] !== PROMPT_VERSION) return undefined;
  const model = parsed['model'];
  if (typeof model !== 'string') return undefined;
  if (expectModel !== undefined && model !== expectModel) return undefined;
  if (typeof parsed['reply'] !== 'string' || typeof parsed['truncated'] !== 'boolean') return undefined;
  const usage = parsed['usage'];
  if (usage === undefined) {
    return { version: PROMPT_VERSION, model, reply: parsed['reply'], truncated: parsed['truncated'] };
  }
  if (!isRecordLike(usage)) return undefined;
  const prompt = usage['promptTokens'];
  const completion = usage['completionTokens'];
  if (typeof prompt !== 'number' || typeof completion !== 'number') return undefined;
  const cached = usage['cachedPromptTokens'];
  return {
    version: PROMPT_VERSION,
    model,
    reply: parsed['reply'],
    truncated: parsed['truncated'],
    usage: {
      promptTokens: prompt,
      completionTokens: completion,
      ...(typeof cached === 'number' ? { cachedPromptTokens: cached } : {}),
    },
  };
}

/** One question, after the arm has answered it. */
export interface AnsweredRow {
  readonly index: number;
  readonly charts: readonly Chart[];
  /** True when the endpoint said the reply hit its budget. A truncated reply is not an answer. */
  readonly truncated: boolean;
  /** True when nothing in the reply was a chart. */
  readonly unparsed: boolean;
  readonly replayed: boolean;
  /** True when this row cost an endpoint call. A row whose table had no type map cost none. */
  readonly called: boolean;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/** What the arm costs and what it read. */
export interface ArmReport {
  readonly split: string;
  readonly model: string;
  readonly k: number;
  readonly promptVersion: number;
  readonly questions: number;
  readonly asked: number;
  readonly replayed: number;
  readonly unparsed: number;
  readonly truncated: number;
  readonly reading: Reading;
  readonly facts: GoldFacts;
  readonly cost: {
    readonly calls: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly yuan: number | undefined;
  };
}

/** The answer to one question, from the store or from the endpoint. */
async function answerOne(
  provider: LlmProvider,
  row: SplitRow,
  types: FieldTypes,
  options: { readonly k: number; readonly maxTokens: number; readonly cache?: ContentStore<StoredAnswer> },
): Promise<AnsweredRow> {
  const [system, user] = buildSpecPrompt(row, types, options.k);
  const key = cacheKey(identityOf(system, user, provider.model, options.maxTokens), PROMPT_VERSION);
  const cached = options.cache?.get(key, { model: provider.model });
  if (cached !== undefined) {
    return {
      index: row.index,
      charts: cached.truncated ? [] : parseSpecs(cached.reply, options.k),
      truncated: cached.truncated,
      unparsed: !cached.truncated && parseSpecs(cached.reply, options.k).length === 0,
      replayed: true,
      called: false,
      promptTokens: cached.usage?.promptTokens ?? 0,
      completionTokens: cached.usage?.completionTokens ?? 0,
    };
  }
  const response = await provider.complete({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    maxTokens: options.maxTokens,
    temperature: 0,
  });
  const reply = response.text;
  const truncated = response.finishReason === 'length';
  const charts = truncated ? [] : parseSpecs(reply, options.k);
  const usage: TokenCounts = {
    promptTokens: response.usage?.promptTokens ?? 0,
    completionTokens: response.usage?.completionTokens ?? 0,
    ...(response.usage?.cachedPromptTokens === undefined
      ? {}
      : { cachedPromptTokens: response.usage.cachedPromptTokens }),
  };
  options.cache?.put(key, { version: PROMPT_VERSION, model: provider.model, reply, truncated, usage });
  return {
    index: row.index,
    charts,
    truncated,
    unparsed: !truncated && charts.length === 0,
    replayed: false,
    called: true,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
  };
}

/** Run `jobs` with at most `limit` in flight, preserving order in the result. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.min(limit, items.length));
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const at = next;
      next += 1;
      if (at >= items.length) return;
      out[at] = await run(items[at] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Everything the arm needs, so that a test can hand it a provider and a directory. */
export interface ArmOptions {
  readonly split: string;
  readonly rows: readonly SplitRow[];
  readonly types: Readonly<Record<string, FieldTypes>>;
  readonly provider: LlmProvider;
  readonly k: number;
  readonly maxTokens: number;
  readonly concurrency: number;
  readonly cache?: ContentStore<StoredAnswer>;
  readonly limit?: number;
}

/**
 * Ask every question, judge the answers, and report what it cost.
 *
 * A question whose table has no type map is answered with no charts rather than skipped: the judge
 * reverses axes by field type, so scoring it would read a missing map as a wrong answer. The count is
 * in `unparsed` beside the rest, and a run where that count is large is a run about the corpus.
 */
export async function runArm(options: ArmOptions): Promise<ArmReport> {
  const asked = options.limit === undefined ? options.rows : options.rows.slice(0, options.limit);
  // One entry per question, produced together with the answer it scores. Written this way so that no
  // lookup by index is needed: `mapLimit` preserves the order it was given, and a `answers[at] ?? []`
  // would be a branch no input can reach — one answer per question, by construction.
  const answered = await mapLimit(asked, options.concurrency, async (row) => {
    const types = options.types[row.csv];
    const answer: AnsweredRow = types === undefined
      ? {
          index: row.index,
          charts: [],
          truncated: false,
          unparsed: true,
          replayed: false,
          called: false,
          promptTokens: 0,
          completionTokens: 0,
        }
      : await answerOne(options.provider, row, types, {
          k: options.k,
          maxTokens: options.maxTokens,
          ...(options.cache === undefined ? {} : { cache: options.cache }),
        });
    return {
      answer,
      scored: { predictions: answer.charts, golds: row.golds, types: types ?? {} } satisfies Case,
    };
  });
  const answers = answered.map((entry) => entry.answer);
  const cases: Case[] = answered.map((entry) => entry.scored);
  const reading = readingOf(cases, [1, 3, 5]);
  const promptTokens = answers.reduce((sum, answer) => sum + answer.promptTokens, 0);
  const completionTokens = answers.reduce((sum, answer) => sum + answer.completionTokens, 0);
  const bill = billOf(options.provider.model, { promptTokens, completionTokens });
  return {
    split: options.split,
    model: options.provider.model,
    k: options.k,
    promptVersion: PROMPT_VERSION,
    questions: asked.length,
    asked: asked.length,
    replayed: answers.filter((answer) => answer.replayed).length,
    unparsed: answers.filter((answer) => answer.unparsed).length,
    truncated: answers.filter((answer) => answer.truncated).length,
    reading,
    facts: factsOf(asked),
    cost: {
      calls: answers.filter((answer) => answer.called).length,
      promptTokens,
      completionTokens,
      yuan: bill,
    },
  };
}

/** The provider the command line builds, or a sentence saying which variable is missing. */
export function providerFromEnv(env: Readonly<Record<string, string | undefined>>): LlmProvider {
  const baseUrl = env['LLM_BASE_URL'];
  const apiKey = env['LLM_API_KEY'];
  const model = env['NVBENCH2_MODEL'] ?? 'deepseek-chat';
  if (baseUrl === undefined || baseUrl === '') throw new Error('LLM_BASE_URL is not set');
  if (apiKey === undefined || apiKey === '') throw new Error('LLM_API_KEY is not set');
  return createHttpProvider({ baseUrl, apiKey, model });
}

/** How the arm is invoked, and what a bad invocation refuses to do. */
export function parseArgs(argv: readonly string[]): {
  split: string;
  cache: string;
  artifact: string | undefined;
  limit: number | undefined;
  k: number;
  concurrency: number;
  maxTokens: number;
} {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const cache = value('--cache') ?? 'eval/.cache/nvbench2';
  const split = value('--split') ?? 'dev';
  const rawLimit = value('--limit');
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`--limit ${String(rawLimit)} is not a positive whole number`);
  }
  const k = Number(value('--k') ?? '3');
  if (!Number.isInteger(k) || k <= 0) throw new Error(`--k ${String(value('--k'))} is not a positive whole number`);
  return {
    split,
    cache,
    artifact: value('--artifact'),
    limit,
    k,
    concurrency: Number(value('--concurrency') ?? '6'),
    maxTokens: Number(value('--max-tokens') ?? '900'),
  };
}

/** The digest of a split's questions, so an artifact says which corpus answered it. */
export function splitDigest(rows: readonly SplitRow[]): string {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(`${row.csv}\u0000${row.question}\u0000${JSON.stringify(row.golds)}\n`);
  return hash.digest('hex');
}

/**
 * One line for a job log: the reading, the price, and the count it was taken over.
 *
 * The price is `unpriced` rather than `¥0.00` when the model is not on `eval/price.ts`'s table, for
 * the reason `eval/bill.ts` gives: a zero would read as a free run and a missing row is a missing row.
 */
export function summaryLine(report: ArmReport): string {
  const f1 = report.reading.f1[3];
  const reading = f1 === undefined ? '—' : f1.toFixed(4);
  const price = report.cost.yuan === undefined ? 'unpriced' : formatYuan(report.cost.yuan);
  return `nvbench2 arm: ${report.split} F1@3 ${reading} · ${String(report.asked)} asked · ${String(report.cost.calls)} calls · ${price}`;
}

/** Read the corpus and ask it. The thin half, kept separate so the thick half can be tested. */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: { readonly provider?: LlmProvider } = {},
): Promise<number> {
  const args = parseArgs(argv);
  const cacheDir = args.cache;
  const rows = parseSplit(readFileSync(`${cacheDir}/${args.split}.json`, 'utf8'));
  const types = resolveTypes(JSON.parse(readFileSync(`${cacheDir}/metadata.json`, 'utf8')));
  const store = openStore<StoredAnswer>(`${cacheDir}/answers`, PROMPT_VERSION, (parsed, expect) =>
    answerOf(parsed, expect?.model),
  );
  const meter = withCallCounter(deps.provider ?? providerFromEnv(env));
  const report = await runArm({
    split: args.split,
    rows,
    types,
    provider: meter.provider,
    k: args.k,
    maxTokens: args.maxTokens,
    concurrency: args.concurrency,
    cache: store,
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  });
  const payload = {
    ...report,
    digest: splitDigest(rows),
    cache: { hits: store.hits, misses: store.misses, corrupt: store.corrupt, entries: store.size() },
  };
  const text = JSON.stringify(payload, null, 1);
  if (args.artifact === undefined) process.stdout.write(`${text}\n`);
  else {
    mkdirSync(dirname(args.artifact), { recursive: true });
    writeFileSync(args.artifact, `${text}\n`);
    process.stdout.write(`${summaryLine(report)}\n`);
  }
  return 0;
}

// The guard returns the work rather than branching at module scope, so importing this file cannot
// start a run and running it cannot be forgotten (see `eval/entry.ts`).
runIfEntry(process.argv[1], import.meta.url, () => main(process.argv.slice(2), process.env));
