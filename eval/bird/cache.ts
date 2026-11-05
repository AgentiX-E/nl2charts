/**
 * What the prompt is made of that the endpoint could have served from its cache.
 *
 * The cost page this project already has (`bench:bird:card`) splits a prompt into rules, schema,
 * context, hint and question, and `bench:bird:card`'s purpose table splits the bill by what each
 * call was for. Neither answers the question a budget asks: **how much of what we send is the
 * same text we sent a moment ago?** A provider that caches prefixes bills that part at a fraction
 * of the list price, and a prompt whose stable text sits at the front is cheap to run even when
 * it is long. A prompt whose stable text is interleaved with the question is not, at any length.
 *
 * That is a property of the prompt's *order*, not of its size, and it is measurable without a
 * model: render the messages this arm sends, group them, and take the longest common prefix. The
 * measurement is exact because the same function that writes the prompt for a call writes it here.
 *
 * ## Two levels, because caches have two
 *
 * A prefix cache is keyed on the bytes of the request. Two questions about the same database
 * share the rules block *and* the schema card; two questions about different databases share only
 * the rules. Both are real hits — a server that keeps a per-database warm prefix and one that
 * keeps a per-deployment one are different deployments — so both are reported, and neither is
 * summed into the other.
 *
 * ## What this file does not do
 *
 * It does not claim a saving. A prefix that is byte-identical *could* be served from a cache; the
 * endpoint decides, and the artifact says what it decided in `tokens.cached`. So the report prints
 * the ceiling beside the measurement, and the verdict is written against the measurement: a
 * ceiling nobody reached is an argument for changing the deployment, not evidence of a discount.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { loadDescriptions, loadQuestions, loadTables } from './data.js';
import type { ColumnNote } from './data.js';
import { blockReader, promptOf } from './card.js';
import { renderableArm, resolveArm, resolveLayout } from './run.js';
import type { BirdLayout } from './run.js';

/** The fraction of the list price a prefix-cached prompt token is billed at, by contract. */
export const DEFAULT_CACHE_RATE = 0.1;

/** The longest prefix two strings share, in characters. */
export function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

/** The longest prefix every string in the list shares. Empty for an empty list. */
export function sharedPrefix(strings: readonly string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0] as string;
  for (const text of strings) {
    const length = commonPrefixLength(prefix, text);
    if (length === prefix.length && length < text.length) continue;
    prefix = prefix.slice(0, length);
  }
  return prefix;
}

/** One message as this instrument reads it: the database it asks about and the system turn. */
export interface CacheMessage {
  readonly db: string;
  readonly system: string;
  /** The user turn, which carries the question and therefore never repeats. */
  readonly user: string;
}

export interface CacheRow {
  readonly db: string;
  readonly questions: number;
  /** Mean system-message characters per question of this database. */
  readonly systemChars: number;
  /** The bytes every one of those questions sends first, in characters. */
  readonly prefixChars: number;
  /** `prefixChars` over `systemChars`, 0..1. */
  readonly share: number;
}

/**
 * The shared prefix of each database's questions, and what share of the message it is.
 *
 * Rounded the way every other table in this repository rounds, so two runs of the same artifact
 * print the same numbers: characters are integers and the share carries four places.
 */
export function cacheRows(messages: readonly CacheMessage[]): CacheRow[] {
  const byDb = new Map<string, string[]>();
  for (const message of messages) byDb.set(message.db, [...(byDb.get(message.db) ?? []), message.system]);
  const rows: CacheRow[] = [];
  for (const [db, systems] of byDb) {
    const mean = systems.reduce((total, system) => total + system.length, 0) / systems.length;
    const prefix = sharedPrefix(systems).length;
    rows.push({
      db,
      questions: systems.length,
      systemChars: Math.round(mean),
      prefixChars: prefix,
      share: mean === 0 ? 0 : Number((prefix / mean).toFixed(4)),
    });
  }
  // Widest first: the database whose card dominates its prompt is the one worth moving to a cache.
  return rows.sort((left, right) => right.share - left.share || left.db.localeCompare(right.db));
}

export interface CacheTally {
  readonly questions: number;
  /** Mean system-message characters per question, over the whole split. */
  readonly systemChars: number;
  /** Mean user-turn characters per question: the question and its hint, never repeated. */
  readonly userChars: number;
  /** Mean characters that repeat across every question of the whole split. */
  readonly globalChars: number;
  /** Mean characters that repeat within the question's own database, this row included. */
  readonly perDbChars: number;
  /**
   * `perDbChars` over the characters **one generation call** sends.
   *
   * Not over the system message: a cache is keyed on the request, and the request is the system
   * turn plus the user turn. A share of the system turn alone would price a prompt nobody sends
   * — and the user turn is where the question is, which is exactly the part that cannot repeat.
   */
  readonly share: number;
}

/**
 * The two levels, averaged over questions rather than over databases.
 *
 * Averaged by question because that is what a bill is: a database with forty questions and one
 * with four contribute to the bill in that proportion, and a mean over databases would let the
 * small one speak as loudly as the large one.
 */
export function cacheTally(messages: readonly CacheMessage[], rows: readonly CacheRow[]): CacheTally {
  if (messages.length === 0) return { questions: 0, systemChars: 0, userChars: 0, globalChars: 0, perDbChars: 0, share: 0 };
  const globalChars = sharedPrefix(messages.map((message) => message.system)).length;
  const rowOf = new Map(rows.map((row) => [row.db, row]));
  let system = 0;
  let user = 0;
  let perDb = 0;
  for (const message of messages) {
    system += message.system.length;
    user += message.user.length;
    perDb += rowOf.get(message.db)?.prefixChars ?? 0;
  }
  const sent = system + user;
  return {
    questions: messages.length,
    systemChars: Math.round(system / messages.length),
    userChars: Math.round(user / messages.length),
    globalChars,
    perDbChars: Math.round(perDb / messages.length),
    share: sent === 0 ? 0 : Number(perDb / sent),
  };
}

export interface CacheBill {
  /** The prompt tokens the artifact metered for this arm, per case. */
  readonly promptTokens: number;
  /** The part of them one generation call spent. Absent when the artifact has no purpose split. */
  readonly generateTokens?: number;
  /** The tokens the endpoint said it served from its cache. Absent when nothing was reported. */
  readonly cachedTokens?: number;
  /** The share of the prompt the endpoint actually billed at the cache rate, 0..1. */
  readonly measuredShare?: number;
  /** What the bill was, in prompt tokens at list price, this measurement included. */
  readonly chargedTokens: number;
  /** What the same prompt would cost if the cacheable prefix were cached every time. */
  readonly ceilingTokens: number;
  /** `chargedTokens - ceilingTokens`, as a share of the charged bill. */
  readonly savingShare: number;
}

/**
 * The bill, in the only unit that does not need a price list: prompt tokens.
 *
 * Two numbers, and they answer different questions. `chargedTokens` is what the run actually paid,
 * with whatever cache the endpoint gave it — it is `prompt - cached + cached * rate`, so a run that
 * reports no cache is charged the list price and a run that reports everything is charged the
 * cache rate. `ceilingTokens` is what the same prompt would pay if every byte of its stable prefix
 * were cached, which is the best the deployment can do without changing the text.
 *
 * The ceiling only discounts the **generation** call, and that is the correction this function
 * exists to make twice. A cartesian product of the whole prompt with the prefix share prices a
 * selector call as if it carried the card; it does not — the selector reads the candidates and
 * answers one digit. On `select-mixed` that inflated the ceiling's saving from 63% to 83%, and the
 * difference is the instrument pricing a prompt nobody sends.
 *
 * `promptTokens` is the artifact's own per-case column, so the two are comparable with every other
 * cost figure in `docs/benchmarks.md` rather than in a unit invented here.
 */
export function cacheBill(
  metered: { readonly promptTokens: number; readonly generateTokens?: number; readonly cachedTokens?: number },
  prefixShare: number,
  rate = DEFAULT_CACHE_RATE,
): CacheBill {
  const prompt = metered.promptTokens;
  const cached = metered.cachedTokens === undefined ? 0 : Math.min(metered.cachedTokens, prompt);
  // Without a purpose split the conservative reading is that every token is generation: it
  // overstates the ceiling rather than discounting a call that never carried the card.
  const generate = metered.generateTokens === undefined ? prompt : metered.generateTokens;
  const charged = prompt - cached + cached * rate;
  const cacheable = generate * prefixShare;
  const ceiling = prompt - cacheable + cacheable * rate;
  return {
    promptTokens: prompt,
    ...(metered.generateTokens === undefined ? {} : { generateTokens: metered.generateTokens }),
    ...(metered.cachedTokens === undefined ? {} : { cachedTokens: metered.cachedTokens }),
    ...(metered.cachedTokens === undefined || prompt === 0
      ? {}
      : { measuredShare: Number((metered.cachedTokens / prompt).toFixed(4)) }),
    chargedTokens: Math.round(charged),
    ceilingTokens: Math.round(ceiling),
    savingShare: charged === 0 ? 0 : Number(((charged - ceiling) / charged).toFixed(4)),
  };
}

/**
 * What would make these numbers wrong.
 *
 * Three absolute failures and no target. A share above one means the prefix is longer than the
 * message it is a prefix of, which cannot happen and can only be an instrument reading two
 * different prompts. A cache count above the prompt it discounts would make `chargedTokens`
 * smaller than the cache rate times the prompt — a discount on tokens that were never sent. A bill
 * with no metered tokens is not a free prompt but an arm that never called the model.
 */
export function cacheProblems(rows: readonly CacheRow[], tally: CacheTally, bill: CacheBill): string[] {
  const problems: string[] = [];
  const impossible = rows.filter((row) => row.share > 1 || row.prefixChars > row.systemChars);
  if (impossible.length > 0) {
    problems.push(
      `CACHE: ${impossible.map((row) => row.db).join(', ')} report a prefix longer than the message it prefixes, so the two were not measured from the same text`,
    );
  }
  if (bill.cachedTokens !== undefined && bill.cachedTokens > bill.promptTokens) {
    problems.push(
      `CACHE: the endpoint reported ${String(bill.cachedTokens)} cached prompt tokens against ${String(bill.promptTokens)} sent, so the discount applies to tokens that were never sent`,
    );
  }
  if (tally.questions > 0 && bill.promptTokens === 0) {
    problems.push('CACHE: the artifact metered no prompt tokens, so there is no bill to compare a cache against');
  }
  return problems;
}

/** A percentage with one decimal. Every field this prints was measured; none of them is optional. */
function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

export function cacheLines(
  split: string,
  arm: string,
  rows: readonly CacheRow[],
  tally: CacheTally,
  bill: CacheBill,
  problems: readonly string[],
): string[] {
  const lines = [`what the prompt repeats, and what repeating it is worth (${split}, ${arm})`, ''];
  lines.push(`  ${'database'.padEnd(22)} ${'q'.padStart(4)} ${'system'.padStart(8)} ${'prefix'.padStart(8)} ${'share'.padStart(7)}`);
  for (const row of rows) {
    lines.push(
      `  ${row.db.padEnd(22)} ${String(row.questions).padStart(4)} ${String(row.systemChars).padStart(8)} ` +
        `${String(row.prefixChars).padStart(8)} ${percent(row.share).padStart(7)}`,
    );
  }
  lines.push('');
  lines.push(`  every question:    ${String(tally.globalChars).padStart(6)} of ${String(tally.systemChars).padStart(6)} chars are sent by all ${String(tally.questions)} of them`);
  lines.push(`  its own database:  ${String(tally.perDbChars).padStart(6)} of ${String(tally.systemChars).padStart(6)} chars are sent by every question of that database`);
  lines.push(
    `  one generation call sends ${String(tally.systemChars + tally.userChars)} chars, of which ${percent(tally.share)} are the same bytes as the call before it`,
  );
  lines.push('');
  lines.push(`  prompt tokens a case, at list price:   ${String(bill.chargedTokens).padStart(6)}`);
  lines.push(`  if that prefix were always cached:     ${String(bill.ceilingTokens).padStart(6)}  — ${percent(bill.savingShare)} off`);
  if (bill.generateTokens !== undefined) {
    lines.push(
      `  the discount lands on the ${String(bill.generateTokens)} tokens the generation call sends; the selector's do not carry the card`,
    );
  }
  lines.push(
    bill.measuredShare === undefined
      ? '  the endpoint reported no cache field on this run, so the discount above is a ceiling and not a measurement'
      : `  the endpoint reported ${String(bill.cachedTokens)} of ${String(bill.promptTokens)} prompt tokens cached (${percent(bill.measuredShare)})`,
  );
  // The verdict is written against the measurement, not the ceiling: a prefix nobody cached is an
  // argument about the deployment, and calling it a saving would publish a discount no bill shows.
  if (bill.measuredShare === undefined || bill.measuredShare === 0) {
    lines.push(
      `  verdict: ${percent(tally.share)} of every request is already the same bytes as the request before it, and none of it was billed at the cache rate`,
    );
  } else if (tally.share - bill.measuredShare > 0.05) {
    lines.push(
      `  verdict: the prefix is ${percent(tally.share)} of the request and ${percent(bill.measuredShare)} was billed at the cache rate — the difference is what the cache did not serve, which on a cold prefix is every database's first question`,
    );
  } else {
    lines.push(`  verdict: the endpoint is already billing the prefix at the cache rate, so there is nothing left in the order`);
  }
  for (const problem of problems) lines.push(`  FAILED ${problem}`);
  return lines;
}

export interface CacheSettings {
  readonly artifact: string;
  readonly arm: string;
  /** The cache rate the bill is priced at, per prompt token. */
  readonly rate: number;
}

export function resolveCacheSettings(argv: readonly string[], root: string, env: Record<string, string | undefined>): CacheSettings & { readonly out: string } {
  const takesValue = new Set(['--artifact', '--arm', '--rate']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (takesValue.has(token)) {
      index += 1;
      continue;
    }
    throw new Error(`unrecognized argument ${token}: this harness takes --artifact <path>, --arm <name> and --rate <fraction>`);
  }
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const artifact = flag('--artifact');
  const arm = flag('--arm');
  if (artifact === undefined) throw new Error('--artifact is required: the bill is read from a run that already happened');
  if (arm === undefined) throw new Error('--arm is required: a prefix is a property of one arm\u2019s prompt');
  const rawRate = flag('--rate');
  const rate = rawRate === undefined ? DEFAULT_CACHE_RATE : Number(rawRate);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1) {
    throw new Error(`--rate takes a fraction of the list price between 0 and 1, not ${String(rawRate)}`);
  }
  return { artifact, arm, rate, out: resolveLayout(env, root).out };
}

/** A run as this instrument reads it. */
export interface CacheArtifact {
  readonly split?: string;
  readonly controls?: { readonly synthesizedDefinitions?: Readonly<Record<string, string>> };
  readonly arms?: readonly {
    readonly arm?: string;
    readonly total?: number;
    readonly tokens?: {
      readonly prompt?: number;
      readonly cached?: number;
      readonly byPurpose?: Readonly<Record<string, { readonly prompt?: number }>>;
    };
  }[];
  readonly cases?: readonly { readonly arm?: string; readonly id?: string | number; readonly tokens?: { readonly cached?: number } }[];
}

/**
 * The messages this arm would send, one per question, built by the function the pipeline sends.
 *
 * The same `promptOf` that `bench:bird:card` renders with, fed the same blocks: two readers of one
 * arm's prompt would measure two prompts, which is the defect that function's own history is about.
 * An arm that is not renderable here is refused rather than priced as its parent — a card missing
 * the block its arm declares is a prompt nobody sends, and its prefix would be a shorter one.
 */
export function cacheMessages(armName: string, artifact: CacheArtifact, layout: BirdLayout): CacheMessage[] {
  const arm = resolveArm(armName);
  if (arm === undefined) throw new Error(`${layout.split}: there is no arm called ${armName}`);
  if (!renderableArm(arm)) throw new Error(`arm ${armName} is an aggregate, not a prompt: only an arm that writes its own messages has a prefix`);
  const questions = loadQuestions(layout.questionsFile);
  const tables = loadTables(layout.tablesFile);
  const definitions = artifact.controls?.synthesizedDefinitions ?? {};
  const valuesFor = blockReader(arm, layout);
  const noteCache = new Map<string, Map<string, Map<string, ColumnNote>>>();
  return questions.map((question) => {
    const db = question.db_id;
    const table = tables.get(db);
    if (table === undefined) throw new Error(`question ${String(question.question_id)} asks about ${db}, which the table file does not describe`);
    let notes: Map<string, Map<string, ColumnNote>> | undefined;
    if (arm.notes === true) {
      notes = noteCache.get(db);
      if (notes === undefined) {
        notes = loadDescriptions(join(layout.descriptionsRoot, db, 'database_description'), table.tableNames);
        noteCache.set(db, notes);
      }
    }
    const built = promptOf(arm, question, definitions[db] ?? '', table, notes, valuesFor(db));
    return { db, system: built.system, user: built.user };
  });
}

/**
 * The cache figure for one arm, from the summary row or — when that row predates the field — from
 * the per-case records it summarises.
 *
 * Two sources for one number is the shape of every disagreement in this directory, so the order is
 * fixed rather than merged: the summary row is what the run computed, and the cases are only read
 * when the row has nothing. What the cases give is the same quantity — a mean over the cases that
 * reported, not over every case — because a case that reported nothing has not said it missed.
 */
export function meteredCache(
  artifact: CacheArtifact,
  arm: string,
): { readonly promptTokens: number; readonly generateTokens?: number; readonly cachedTokens?: number; readonly from: 'summary' | 'cases' | 'none' } {
  const arms = artifact.arms === undefined ? [] : artifact.arms;
  const row = arms.find((entry) => entry.arm === arm);
  // Written out rather than as one optional chain: a chain reports three branches for one
  // question, and a reader of the coverage report cannot tell which of them is the interesting
  // one. The question is "did this row carry a figure", and that is one `if`.
  const tokens = row === undefined ? undefined : row.tokens;
  const promptTokens = tokens !== undefined && tokens.prompt !== undefined ? tokens.prompt : 0;
  const generateTokens = tokens === undefined ? undefined : (tokens.byPurpose === undefined ? undefined : tokens.byPurpose.generate?.prompt);
  const summary = tokens === undefined ? undefined : tokens.cached;
  if (summary !== undefined) {
    return { promptTokens, ...(generateTokens === undefined ? {} : { generateTokens }), cachedTokens: summary, from: 'summary' };
  }
  const cases = artifact.cases === undefined ? [] : artifact.cases;
  const reported = cases.filter((entry) => entry.arm === arm && entry.tokens !== undefined && entry.tokens.cached !== undefined);
  if (reported.length === 0) return { promptTokens, ...(generateTokens === undefined ? {} : { generateTokens }), from: 'none' };
  // The filter above is the guarantee these carry a figure; reading it again here would be a
  // `?? 0` for a case that cannot exist, and a branch no test can reach.
  const values = reported.map((entry) => entry.tokens?.cached as number);
  const total = values.reduce((sum, value) => sum + value, 0);
  return { promptTokens, ...(generateTokens === undefined ? {} : { generateTokens }), cachedTokens: Math.round(total / reported.length), from: 'cases' };
}

export function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): number {
  const settings = resolveCacheSettings(argv, root, env);
  const artifact = JSON.parse(readFileSync(settings.artifact, 'utf8')) as CacheArtifact;
  const split = artifact.split === 'dev' || artifact.split === 'minidev' ? artifact.split : undefined;
  const layout = resolveLayout(split === undefined ? env : { ...env, BIRD_SPLIT: split }, root);
  const row = (artifact.arms ?? []).find((entry) => entry.arm === settings.arm);
  if (row === undefined) throw new Error(`${settings.artifact} has no arm ${settings.arm}, so there is no prompt to measure`);
  const messages = cacheMessages(settings.arm, artifact, layout);
  const rows = cacheRows(messages);
  const tally = cacheTally(messages, rows);
  const metered = meteredCache(artifact, settings.arm);
  const bill = cacheBill(
    { promptTokens: metered.promptTokens, ...(metered.generateTokens === undefined ? {} : { generateTokens: metered.generateTokens }), ...(metered.cachedTokens === undefined ? {} : { cachedTokens: metered.cachedTokens }) },
    tally.share,
    settings.rate,
  );
  const problems = cacheProblems(rows, tally, bill);
  for (const line of cacheLines(layout.split, settings.arm, rows, tally, bill, problems)) console.log(line);
  return problems.length === 0 ? 0 : 1;
}

/**
 * Whether this file was run rather than imported.
 *
 * Exported so the branch can be tested: the other entry points in this directory carry the same
 * helper, and a guard that only a command line can reach is a guard no test covers.
 */
export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
