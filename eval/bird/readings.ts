/**
 * The numbers a reader quotes, derived from counts instead of typed into prose.
 *
 * Four times now a document in this repository has disagreed with the artifact it describes: a rate
 * that moved from 45.0 to 40.3 between two runs, a difference across runs written as a difference
 * between arms, a pool over two artifacts printed as if it were the pool over three, and a command
 * that no document could run. Every one of those was a hand-typed number in a Markdown file, and
 * every one survived review because a plausible number is indistinguishable from a correct one by
 * reading.
 *
 * So the tables stop being typed. `eval/baseline/readings.json` records the only thing that cannot
 * be derived — the discordant counts of each pair in each run — and every number in the tables is
 * computed from them at gate time. A cell that says 13/19 and a pooled line that says −0.69pp
 * cannot disagree with each other, because neither is stored.
 *
 * Two properties are worth stating, because they are what makes the derivation checkable rather
 * than merely automatic:
 *
 * - The derivation does not re-implement statistics. Per-reading p comes from `mcnemarExact`, the
 *   pool from `poolPair`, the same functions the artifact comparison prints, so a table generated
 *   here and a table printed by `bench:bird:compare --pair` are the same arithmetic.
 * - The ledger stores counts and nothing else. A pooled estimate written into the ledger would be a
 *   second source of truth and the first thing to drift; there is no field for one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mcnemarExact } from '@agentix-e/nl2charts-devkit';
import { isEntry, poolPair } from './compare.js';
import { pairOutcome } from './pair.js';
import type { PairReading, PooledReading } from './compare.js';
import type { PairArtifact } from './pair.js';

/** One run, and how many questions it put both arms of every pair to. */
export interface LedgerRun {
  /** Short key a view labels a column with, when it asks for keys rather than identifiers. */
  readonly key: string;
  /** The run identifier — the number in `GITHUB_RUN_ID`, which is what an artifact is filed under. */
  readonly id: string;
  readonly examined: number;
  /**
   * The split the run was read on.
   *
   * Asserted per run rather than per view, because a view's premise is not something it can be
   * trusted to state about itself: the pool adds up two readings, and two readings on different
   * splits are not two estimates of one quantity. Nine readings of 496 questions are worth more
   * than one reading of 1,532 of them, and neither is evidence about the other's population.
   */
  readonly split: string;
}

/** A set of runs read as one table, and what its pooled column is called. */
export interface LedgerView {
  readonly id: string;
  /**
   * Header of the pooled column: `pooled`, `four-run pooled`, `seven-run pooled`.
   *
   * The file may leave this out when the label is only a count: writing `four-run pooled` for a
   * view of four runs is a second copy of the number, and a second copy is what drifts. Left out,
   * the label is derived from the number of runs the view reads — and written out, it is checked
   * against that number, so a label cannot count a different number of runs than the row lists.
   */
  readonly pooled: string;
  readonly runs: readonly string[];
  /**
   * `id` labels a column with the run identifier, `key` with the letter. Seven columns of thirteen
   * digits push a table past the width of a page, so the long views use letters and the short ones
   * spell the identifier out.
   */
  readonly labelRuns?: 'id' | 'key';
  /**
   * Whether a cell spells the per-run p beside the counts.
   *
   * The long view prints counts only: seven cells each carrying `, p = 0.3771` is a row a reader
   * has to scroll, and the p a reader acts on in that table is the pooled one. The short views keep
   * it, because their argument is about what a single run did.
   */
  readonly cells?: 'counts' | 'counts-p';
}

/** One run's reading of one pair: the only numbers in this file that are not computed. */
export interface LedgerReading {
  readonly wins: number;
  readonly losses: number;
}

export interface LedgerPair {
  readonly left: string;
  readonly right: string;
  /** Keyed by run key. A pair a run did not score simply has no entry. */
  readonly readings: Readonly<Record<string, LedgerReading>>;
}

/**
 * A number quoted in prose, and the view and pair it must equal.
 *
 * Generated tables cover tables; the sentences around them still quote numbers, and a sentence is
 * not a block that can be replaced wholesale. A claim is the string the sentence has to contain,
 * built from the same derivation — so a stale `+3.10pp ± 1.02` in a paragraph fails the gate
 * exactly like a stale cell does.
 */
export interface LedgerClaim {
  readonly file: string;
  readonly view: string;
  readonly pair: readonly [string, string];
  /** Template with `{pooled}`, `{interval}`, `{verdict}`, `{q}` and `{significant}` placeholders. */
  readonly template: string;
}

/**
 * A document this ledger owns, and the blocks it is supposed to carry.
 *
 * The list of views is explicit rather than inferred from what the file happens to contain. A
 * table whose markers were deleted is a document that silently stopped being checked, and that is
 * the failure this file exists to make impossible: a missing block is a red build, not a table
 * that quietly turned back into prose.
 */
export interface DocEntry {
  readonly file: string;
  readonly views: readonly string[];
}

export interface ReadingsLedger {
  readonly corpus: string;
  readonly note?: string;
  /** Files whose generated blocks and claims this ledger owns. */
  readonly docs: readonly DocEntry[];
  readonly runs: readonly LedgerRun[];
  readonly views: readonly LedgerView[];
  readonly pairs: readonly LedgerPair[];
  readonly claims: readonly LedgerClaim[];
}

/** One run's reading of one pair, as the table prints it. */
export interface Cell {
  readonly run: string;
  readonly wins: number;
  readonly losses: number;
  readonly p: number;
  readonly deltaPp: number;
}

export interface ViewRow {
  readonly left: string;
  readonly right: string;
  /** One entry per column, in the view's run order; `undefined` when the run did not score the pair. */
  readonly cells: readonly (Cell | undefined)[];
  readonly pooled: PooledReading;
}

export interface DerivedView {
  readonly view: LedgerView;
  readonly rows: readonly ViewRow[];
  /** Pairs with no reading at all in this view — dropped from the table, and said out loud. */
  readonly unscored: readonly string[];
}

const MINUS = '\u2212';

function fail(message: string): never {
  throw new Error(`readings ledger: ${message}`);
}

function object(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(`${what} is not an object`);
  return raw as Record<string, unknown>;
}

function list(raw: unknown, what: string): unknown[] {
  if (!Array.isArray(raw)) fail(`${what} is not an array`);
  return raw;
}

function text(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') fail(`${what} is not a non-empty string`);
  return raw;
}

function count(raw: unknown, what: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) fail(`${what} is not a whole count`);
  return raw;
}

function pairName(pair: { left: string; right: string }): string {
  return `${pair.left} → ${pair.right}`;
}

/**
 * A count as a word, for the places a number is part of a sentence rather than of a formula.
 *
 * Only the range a table of runs can plausibly reach is spelled; beyond it the digits are their own
 * answer, and a repository that runs a benchmark twenty-one times has a different problem.
 */
const COUNT_WORDS = [
  'no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
] as const;

function wordOf(count: number): string {
  return COUNT_WORDS[count] ?? String(count);
}

/**
 * Read the ledger, and refuse the shapes that would make a table mean something other than it says.
 *
 * Every check here is one that a plausible-looking ledger could fail silently: a reading for a run
 * the view does not show would be dropped from the pool without a word, and a pair whose readings
 * exceed the questions it was scored on would print a difference larger than the corpus allows.
 */
export function parseLedger(raw: unknown): ReadingsLedger {
  const ledger = object(raw, 'the ledger');
  const corpus = text(ledger.corpus, 'corpus');
  const runs = list(ledger.runs, 'runs').map((item, index) => {
    const run = object(item, `runs[${String(index)}]`);
    const examined = count(run.examined, `runs[${String(index)}].examined`);
    const key = text(run.key, `runs[${String(index)}].key`);
    if (examined === 0) fail(`run ${key} examined no question, so it is not a reading`);
    return { key, id: text(run.id, `runs[${String(index)}].id`), examined, split: text(run.split, `runs[${String(index)}].split`) };
  });
  const keys = new Set<string>();
  for (const run of runs) {
    if (keys.has(run.key)) fail(`run key ${run.key} appears twice`);
    keys.add(run.key);
  }
  const splitOf = new Map(runs.map((run) => [run.key, run.split]));
  const views = list(ledger.views, 'views').map((item, index) => {
    const view = object(item, `views[${String(index)}]`);
    const id = text(view.id, `views[${String(index)}].id`);
    const members = list(view.runs, `views[${String(index)}].runs`).map((key, at) => text(key, `views[${String(index)}].runs[${String(at)}]`));
    for (const key of members) if (!keys.has(key)) fail(`view ${id} names run ${key}, which is not in runs`);
    if (new Set(members).size !== members.length) fail(`view ${id} lists a run twice, so one run would be counted as two readings`);
    if (members.length === 0) fail(`view ${id} has no runs, so there is nothing to pool`);
    const rawLabel = view.labelRuns ?? 'id';
    if (rawLabel !== 'id' && rawLabel !== 'key') fail(`view ${id} labels runs with ${String(rawLabel)}, which is neither id nor key`);
    const labelRuns: 'id' | 'key' = rawLabel;
    const rawCells = view.cells ?? 'counts-p';
    if (rawCells !== 'counts' && rawCells !== 'counts-p') fail(`view ${id} prints cells as ${String(rawCells)}, which is neither counts nor counts-p`);
    const cells: 'counts' | 'counts-p' = rawCells;
    // The view does not declare its split; it is inferred from the runs it reads and refused when
    // they disagree. A declared split is one more field a view can be wrong about, and the failure
    // it hides — a 496-question reading pooled with a 1,532-question one — reads on the page as a
    // narrower interval rather than as an error.
    const splits = [...new Set(members.map((key) => splitOf.get(key) as string))].sort();
    if (splits.length > 1) {
      fail(
        `view ${id} reads ${splits.join(' and ')}, and a pool across splits is a difference between corpora reported as a difference between arms`,
      );
    }
    const runWord = wordOf(members.length);
    const pooled = view.pooled === undefined ? `${runWord}-run pooled` : text(view.pooled, `views[${String(index)}].pooled`);
    const counted = /^([a-z]+)-run pooled$/.exec(pooled);
    if (counted !== null && counted[1] !== runWord) {
      fail(`view ${id} calls its pool "${pooled}" while it lists ${String(members.length)} runs`);
    }
    return { id, pooled, runs: members, labelRuns, cells };
  });
  const viewIds = new Set<string>();
  for (const view of views) {
    if (viewIds.has(view.id)) fail(`view ${view.id} appears twice`);
    viewIds.add(view.id);
  }
  const examinedOf = new Map(runs.map((run) => [run.key, run.examined]));
  const pairs = list(ledger.pairs, 'pairs').map((item, index) => {
    const pair = object(item, `pairs[${String(index)}]`);
    const left = text(pair.left, `pairs[${String(index)}].left`);
    const right = text(pair.right, `pairs[${String(index)}].right`);
    if (left === right) fail(`a pair whose two arms are both ${left} is not a comparison`);
    const raw = object(pair.readings, `pairs[${String(index)}].readings`);
    const readings: Record<string, LedgerReading> = {};
    for (const [key, entry] of Object.entries(raw)) {
      if (!keys.has(key)) fail(`pair ${left} → ${right} has a reading for run ${key}, which is not in runs`);
      const reading = object(entry, `pairs[${String(index)}].readings.${key}`);
      const wins = count(reading.wins, `pairs[${String(index)}].readings.${key}.wins`);
      const losses = count(reading.losses, `pairs[${String(index)}].readings.${key}.losses`);
      const examined = examinedOf.get(key) as number;
      if (wins + losses > examined) {
        fail(`${left} → ${right} in run ${key} claims ${String(wins + losses)} discordant cases out of ${String(examined)} questions`);
      }
      readings[key] = { wins, losses };
    }
    if (Object.keys(readings).length === 0) fail(`pair ${left} → ${right} has no reading in any run`);
    return { left, right, readings };
  });
  const pairKeys = new Set<string>();
  for (const pair of pairs) {
    const name = pairName(pair);
    if (pairKeys.has(name)) fail(`pair ${name} appears twice, and two rows for one pair is two numbers for one question`);
    pairKeys.add(name);
  }
  const claims = list(ledger.claims ?? [], 'claims').map((item, index) => {
    const claim = object(item, `claims[${String(index)}]`);
    const file = text(claim.file, `claims[${String(index)}].file`);
    const view = text(claim.view, `claims[${String(index)}].view`);
    if (!viewIds.has(view)) fail(`claim ${file} quotes view ${view}, which does not exist`);
    const pair = list(claim.pair, `claims[${String(index)}].pair`).map((name, at) => text(name, `claims[${String(index)}].pair[${String(at)}]`));
    if (pair.length !== 2) fail(`claim ${file} names ${String(pair.length)} arms, and a pair is two`);
    const name = `${pair[0] as string} → ${pair[1] as string}`;
    if (!pairKeys.has(name)) fail(`claim ${file} quotes pair ${name}, which is not in pairs`);
    return { file, view, pair: [pair[0] as string, pair[1] as string] as const, template: text(claim.template, `claims[${String(index)}].template`) };
  });
  const docs = list(ledger.docs, 'docs').map((item, index) => {
    const entry = object(item, `docs[${String(index)}]`);
    const file = text(entry.file, `docs[${String(index)}].file`);
    const views = list(entry.views, `docs[${String(index)}].views`).map((id, at) => text(id, `docs[${String(index)}].views[${String(at)}]`));
    for (const id of views) if (!viewIds.has(id)) fail(`${file} is said to carry view ${id}, which does not exist`);
    if (new Set(views).size !== views.length) fail(`${file} carries one view twice, so one block would be checked against two tables`);
    return { file, views };
  });
  if (docs.length === 0) fail('docs is empty, so nothing this ledger generates would be checked');
  if (new Set(docs.map((entry) => entry.file)).size !== docs.length) fail('a document appears twice in docs');
  return { corpus, ...(ledger.note === undefined ? {} : { note: text(ledger.note, 'note') }), docs, runs, views, pairs, claims };
}

/** The view, or a refusal naming the ones that exist. */
export function viewOf(ledger: ReadingsLedger, id: string): LedgerView {
  const view = ledger.views.find((item) => item.id === id);
  if (view === undefined) fail(`${id} is not a view: ${ledger.views.map((item) => item.id).join(', ')}`);
  return view;
}

/**
 * One view of the ledger: every pair, the runs it was read in, and the pool.
 *
 * The per-reading `p` is computed here rather than stored, from the same `mcnemarExact` the pair
 * instrument calls, so a table and the artifact it describes cannot disagree about a p-value.
 */
export function deriveView(ledger: ReadingsLedger, id: string): DerivedView {
  const view = viewOf(ledger, id);
  const examinedOf = new Map(ledger.runs.map((run) => [run.key, run.examined]));
  const rows: ViewRow[] = [];
  const unscored: string[] = [];
  for (const pair of ledger.pairs) {
    const cells = view.runs.map((key) => {
      const reading = pair.readings[key];
      if (reading === undefined) return undefined;
      const examined = examinedOf.get(key) as number;
      return {
        run: key,
        wins: reading.wins,
        losses: reading.losses,
        p: Number(mcnemarExact(reading.losses, reading.wins).toFixed(4)),
        deltaPp: Number((((reading.wins - reading.losses) / examined) * 100).toFixed(2)),
      };
    });
    const present = cells.filter((cell): cell is Cell => cell !== undefined);
    if (present.length === 0) {
      unscored.push(pairName(pair));
      continue;
    }
    const readings: PairReading[] = present.map((cell) => ({
      artifact: cell.run,
      examined: examinedOf.get(cell.run) as number,
      wins: cell.wins,
      losses: cell.losses,
      deltaPp: cell.deltaPp,
      p: cell.p,
    }));
    rows.push({ left: pair.left, right: pair.right, cells, pooled: poolPair(readings, pair.left, pair.right) });
  }
  return { view, rows, unscored };
}

function signed(pp: number): string {
  if (pp < 0) return `${MINUS}${Math.abs(pp).toFixed(2)}pp`;
  return `+${pp.toFixed(2)}pp`;
}

function headerOf(ledger: ReadingsLedger, view: LedgerView, key: string): string {
  if (view.labelRuns === 'key') return key;
  const run = ledger.runs.find((item) => item.key === key) as LedgerRun;
  return `\`${run.id}\``;
}

/** The table, as Markdown, with the p-value bolded where it clears 0.05. */
export function renderTable(ledger: ReadingsLedger, id: string): string[] {
  const derived = deriveView(ledger, id);
  const header = ['pair', ...derived.view.runs.map((key) => headerOf(ledger, derived.view, key)), derived.view.pooled, 'verdict', 'Q'];
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of derived.rows) {
    const cells = row.cells.map((cell) => {
      if (cell === undefined) return '—';
      const counts = `${String(cell.wins)}/${String(cell.losses)}`;
      const p = `p = ${cell.p.toFixed(4)}`;
      if (derived.view.cells === 'counts') return cell.p < 0.05 ? `**${counts}**` : counts;
      return `${counts}, ${cell.p < 0.05 ? `**${p}**` : p}`;
    });
    const estimate = `${signed(row.pooled.pooledPp)} ± ${row.pooled.pooledIntervalPp.toFixed(2)}`;
    const verdict = `**${row.pooled.verdict}**`;
    // A Q statistic is a test of whether two or more estimates agree. Over one reading there is
    // nothing to compare, and the number `poolPair` returns for that case (1, so that nothing is
    // red) is a placeholder rather than a p-value — printing it would claim a test was run.
    const q =
      row.pooled.readings.length < 2
        ? '—'
        : row.pooled.heterogeneityP < 0.05
          ? `**${row.pooled.heterogeneityP.toFixed(3)}**`
          : row.pooled.heterogeneityP.toFixed(3);
    lines.push(`| \`${row.left}\` → \`${row.right}\` | ${cells.join(' | ')} | ${row.pooled.verdict === 'established' ? `**${estimate}**` : estimate} | ${verdict} | ${q} |`);
  }
  // A widened interval is a different estimator, and a table that prints it without saying so
  // invites the reader to compare it with a fixed-effect interval beside it. Named per pair
  // rather than described in a footnote, because "some of these were widened" is not a reading.
  // A view reads the pairs it has readings for, and the table cannot say so by having fewer rows:
  // a dev-split dispatch that ran three of five arms would otherwise print a table that reads as a
  // table of everything. The declaration is in the ledger, so the silence is derived rather than
  // left to the reader to notice.
  if (derived.unscored.length > 0) {
    lines.push('');
    lines.push(`*Not read here: ${derived.unscored.map((name) => `\`${name.replace(' → ', '` → `')}\``).join(', ')}.*`);
  }
  const widened = derived.rows.filter((row) => row.pooled.tauSquaredPp2 > 0);
  if (widened.length > 0) {
    const named = widened
      .map((row) => `\`${row.left}\` → \`${row.right}\` (τ² = ${row.pooled.tauSquaredPp2.toFixed(2)} pp²)`)
      .join(', ');
    lines.push('');
    lines.push(`*Interval widened by DerSimonian–Laird for ${named}, because the label says those readings are not one number.*`);
  }
  return lines;
}

/** The markers a document uses to say "this region is generated". */
export function markers(id: string): { begin: string; end: string } {
  return { begin: `<!-- readings:begin ${id} -->`, end: `<!-- readings:end ${id} -->` };
}

/** Replace every generated region with what the ledger derives, leaving everything else alone. */
export function applyDoc(text: string, ledger: ReadingsLedger): string {
  let out = text;
  for (const view of ledger.views) {
    const { begin, end } = markers(view.id);
    const at = out.indexOf(begin);
    if (at === -1) continue;
    const close = out.indexOf(end, at + begin.length);
    if (close === -1) continue;
    const body = renderTable(ledger, view.id).join('\n');
    out = `${out.slice(0, at + begin.length)}\n${body}\n${out.slice(close)}`;
  }
  return out;
}

/**
 * Everything this file has to say about one document: its blocks, and the numbers its prose quotes.
 *
 * A problem names the file and the view, because the reader of a red build is looking for the line
 * to change and "a table is stale" is not it.
 */
/** A claim, with the string it has to find, or why it cannot be rendered at all. */
export interface RenderedClaim {
  readonly wanted: string;
  readonly row: ViewRow | undefined;
}

/**
 * The sentence a claim insists on.
 *
 * Rendered in one place so that the gate, a test and a reader are all looking at the same string:
 * a claim that was formatted one way in the check and another in the document would pass while
 * quoting a number nobody derived.
 */
export function renderClaim(ledger: ReadingsLedger, claim: LedgerClaim): RenderedClaim {
  const derived = deriveView(ledger, claim.view);
  const row = derived.rows.find((item) => item.left === claim.pair[0] && item.right === claim.pair[1]);
  if (row === undefined) return { wanted: '', row };
  const wanted = claim.template
    .replace('{pooled}', signed(row.pooled.pooledPp))
    .replace('{magnitude}', Math.abs(row.pooled.pooledPp).toFixed(2))
    .replace('{interval}', row.pooled.pooledIntervalPp.toFixed(2))
    .replace('{runs}', wordOf(row.pooled.readings.length))
    .replace('{verdict}', row.pooled.verdict)
    .replace('{q}', row.pooled.heterogeneityP.toFixed(3))
    .replace('{significant}', String(row.pooled.readingsSignificant));
  return { wanted, row };
}

/**
 * The document with every generated block removed.
 *
 * A claim is a statement about prose. Checked against the whole file it would be satisfied by the
 * table it sits under — every number in these paragraphs is also a cell — so a sentence could quote
 * a stale figure and pass because the table beside it was right. The blocks are cut first, and what
 * is left is what the sentence has to say on its own.
 */
export function stripBlocks(text: string, ledger: ReadingsLedger): string {
  let out = text;
  for (const view of ledger.views) {
    const { begin, end } = markers(view.id);
    const at = out.indexOf(begin);
    if (at === -1) continue;
    const close = out.indexOf(end, at + begin.length);
    if (close === -1) continue;
    out = `${out.slice(0, at)}${out.slice(close + end.length)}`;
  }
  return out;
}

export function checkDoc(text: string, file: string, ledger: ReadingsLedger): string[] {
  const problems: string[] = [];
  const entry = ledger.docs.find((item) => item.file === file);
  if (entry === undefined) return [`${file}: is not a document this ledger owns, so its numbers are not checked`];
  const prose = stripBlocks(text, ledger);
  for (const view of ledger.views) {
    const { begin, end } = markers(view.id);
    const declared = entry.views.includes(view.id);
    const begins = text.split(begin).length - 1;
    const ends = text.split(end).length - 1;
    if (!declared) {
      if (begins > 0 || ends > 0) problems.push(`${file}: carries a ${view.id} block, which this ledger does not list for this document`);
      continue;
    }
    if (begins !== 1 || ends !== 1) {
      problems.push(`${file}: ${view.id} markers appear ${String(begins)}× opening and ${String(ends)}× closing, and a block needs exactly one of each`);
      continue;
    }
    const at = text.indexOf(begin);
    const close = text.indexOf(end);
    if (close < at) {
      problems.push(`${file}: ${view.id} closes before it opens`);
      continue;
    }
    const body = text.slice(at + begin.length, close).trim();
    const expected = renderTable(ledger, view.id).join('\n');
    if (body !== expected) {
      const got = body.split('\n');
      const want = expected.split('\n');
      const line = want.findIndex((item, index) => got[index] !== item);
      problems.push(
        `${file}: ${view.id} is not what the ledger derives — line ${String(line + 1)} reads ${JSON.stringify(got[line] ?? '(nothing)')}, and the ledger gives ${JSON.stringify(want[line] as string)}`,
      );
    }
  }
  for (const claim of ledger.claims) {
    if (claim.file !== file) continue;
    const { wanted, row } = renderClaim(ledger, claim);
    if (row === undefined) {
      problems.push(`${file}: claims a number for ${claim.pair[0]} → ${claim.pair[1]}, which ${claim.view} does not read`);
      continue;
    }
    if (!prose.includes(wanted)) problems.push(`${file}: does not quote ${JSON.stringify(wanted)} for ${claim.pair[0]} → ${claim.pair[1]} in ${claim.view}`);
  }
  return problems;
}

/**
 * One run's counts, read out of the artifact rather than out of a table.
 *
 * The ledger's first seven rows were transcribed by hand from artifacts whose tables had already
 * been typed by hand, which is the drift this file exists to stop — one level up. Transcribing
 * cannot be eliminated in the ledger (it is the only place a count lives), but it can be *checked*:
 * point the tool at the artifact and it recomputes every pair from the per-case verdicts and says
 * whether the ledger agrees.
 */
export interface ArtifactCounts {
  readonly run: string | undefined;
  readonly pairs: readonly { left: string; right: string; examined: number; wins: number; losses: number }[];
}

export function countsOf(ledger: ReadingsLedger, artifact: unknown): ArtifactCounts {
  const raw = object(artifact, 'the artifact');
  const provenance = (raw.provenance ?? {}) as Record<string, unknown>;
  const run = typeof provenance.run === 'string' ? provenance.run : undefined;
  const pairs = ledger.pairs.map((pair) => {
    const outcome = pairOutcome(raw as PairArtifact, pair.left, pair.right);
    return { left: pair.left, right: pair.right, examined: outcome.examined, wins: outcome.wins, losses: outcome.losses };
  });
  return { run, pairs };
}

/**
 * Whether the ledger's row for an artifact is the row the artifact would write.
 *
 * A run the ledger does not carry is reported rather than ignored: an artifact nobody recorded is
 * a reading that will be missing from the next pool, and the moment to notice is when it exists.
 */
export function reconcile(ledger: ReadingsLedger, artifact: unknown): string[] {
  let counts: ArtifactCounts;
  try {
    counts = countsOf(ledger, artifact);
  } catch (error) {
    return [`the artifact cannot be read as a reading: ${(error as Error).message}`];
  }
  if (counts.run === undefined) return ['the artifact does not say which run it is, so it cannot be checked against the ledger'];
  const run = ledger.runs.find((item) => item.id === counts.run);
  if (run === undefined) return [`the ledger has no run ${counts.run}`];
  const problems: string[] = [];
  for (const counted of counts.pairs) {
    const pair = ledger.pairs.find((item) => item.left === counted.left && item.right === counted.right) as LedgerPair;
    const recorded = pair.readings[run.key];
    if (recorded === undefined) {
      problems.push(`run ${counts.run} is in the ledger but carries no reading of ${pairName(pair)}`);
      continue;
    }
    if (recorded.wins !== counted.wins || recorded.losses !== counted.losses) {
      problems.push(
        `${pairName(pair)} in run ${counts.run}: the ledger has ${String(recorded.wins)}/${String(recorded.losses)}, the artifact has ${String(counted.wins)}/${String(counted.losses)}`,
      );
    }
    if (counted.examined !== run.examined) {
      problems.push(`run ${counts.run} examined ${String(counted.examined)} questions in the artifact and ${String(run.examined)} in the ledger`);
    }
  }
  return problems;
}

export function main(argv: readonly string[] = process.argv.slice(2), root = process.cwd()): number {
  const write = argv.includes('--write');
  const from = argv.indexOf('--from');
  const known = new Set(['--write', '--check', '--from']);
  const unknown = argv.filter((item, index) => !known.has(item) && argv[index - 1] !== '--from');
  if (unknown.length > 0) throw new Error(`unrecognized argument ${unknown[0] as string}: this tool takes --check (default), --write, or --from <artifact.json>`);
  if (from !== -1 && argv[from + 1] === undefined) throw new Error('--from takes an artifact path');
  const ledger = parseLedger(JSON.parse(readFileSync(resolve(root, 'eval/baseline/readings.json'), 'utf8')) as unknown);
  if (from !== -1) {
    const artifact = JSON.parse(readFileSync(resolve(root, argv[from + 1] as string), 'utf8')) as unknown;
    const problems = reconcile(ledger, artifact);
    for (const problem of problems) console.log(`FAILED ${problem}`);
    if (problems.length === 0) console.log(`readings: this artifact and the ledger agree on ${String(ledger.pairs.length)} pair(s)`);
    return problems.length === 0 ? 0 : 1;
  }
  const problems: string[] = [];
  for (const entry of ledger.docs) {
    const path = resolve(root, entry.file);
    const before = readFileSync(path, 'utf8');
    const after = applyDoc(before, ledger);
    if (write) {
      if (after !== before) {
        writeFileSync(path, after);
        console.log(`${entry.file}: rewritten from the ledger`);
      }
      continue;
    }
    problems.push(...checkDoc(before, entry.file, ledger));
  }
  if (write) return 0;
  for (const problem of problems) console.log(`FAILED ${problem}`);
  const views = ledger.views.map((view) => `${view.id} (${String(view.runs.length)} runs)`).join(', ');
  console.log(`readings: ${String(ledger.pairs.length)} pairs · ${views} · ${String(ledger.docs.length)} documents derived from ${ledger.corpus}`);
  return problems.length === 0 ? 0 : 1;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
