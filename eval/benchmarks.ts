/**
 * Which leaderboards this repository can put a number on, and which it cannot — as data a gate reads.
 *
 * Every claim of the form "we are 16.15pp behind the leader" rests on two facts that are usually
 * prose: the corpus was scored, and the metric the leaderboard ranks by was computed. Prose rots.
 * A number is copied into a document from a run three rounds old, the harness that produced it is
 * deleted, and the sentence survives the thing it described. This file is the other way round: each
 * benchmark is a row with the corpus it is scored on, the metrics it is ranked by, a status, and a
 * reading that a machine resolves. `pnpm bench:coverage` refuses a row that claims a reading the
 * repository cannot resolve, and refuses a missing row for a leaderboard the plan names — so the
 * table in the documentation and the state of the code cannot drift apart without a red build.
 *
 * The four statuses are deliberately about *evidence*, not about effort:
 *
 *   - `measured` — a number exists in this repository, at the file and path cited, over the
 *     denominator the leaderboard reports. The gate resolves it and refuses the row if the value is
 *     not a finite number.
 *   - `partial` — a number exists, but over a narrower denominator than the leaderboard's. The row
 *     must say which, because this repository has already published one reading taken on 600
 *     questions beside a leaderboard number taken on 1,532 and called the difference a capability
 *     gap. A subset reading is a real reading; it is not that row.
 *   - `instrumented` — the metric and the harness exist, but no dispatch has produced a number. That
 *     is a different absence from "we never built it", and a plan written from this table has to be
 *     able to tell them apart: one needs a run, the other needs a corpus.
 *   - `absent` — the corpus is not in this repository and no harness reads it. The row must say what
 *     building it would take, because "not measured" is not a plan.
 *
 * The row set is checked against `REQUIRED`, the leaderboards the project plan commits to. Removing
 * a row is therefore a failing build rather than a quiet edit, which is the property a coverage
 * table needs if it is going to be read as a coverage table.
 */
import { readFileSync } from 'node:fs';
import { isEntry } from './entry.js';

export type Domain = 'text2sql' | 'text2viz';
export type Status = 'measured' | 'partial' | 'instrumented' | 'absent';

/** A number in this repository, and what kind of number it is. */
export interface Reading {
  /** File the number lives in, relative to the repository root. */
  readonly file: string;
  /** Path into that file. `#name=value` picks the array element whose `name` equals `value`. */
  readonly path: readonly string[];
  /** `run` is an observed value, `floor` is the minimum a rerun may land on, `census` is a count. */
  readonly kind: 'run' | 'floor' | 'census';
  /**
   * What the number counts. A reading in percent is bounded by 100; a count of figures is not, and
   * inferring the unit from the size of the number is how 664 became "664 percent" the first time
   * this table was written. Absent means percent, which is what a leaderboard row almost always is.
   */
  readonly unit?: 'percent' | 'count';
  readonly note: string;
}

export interface Benchmark {
  readonly id: string;
  readonly domain: Domain;
  readonly name: string;
  readonly source: string;
  readonly corpus: string;
  readonly metrics: readonly string[];
  readonly status: Status;
  readonly reading?: Reading;
  /** Present iff the reading covers fewer questions than the leaderboard's denominator. */
  readonly narrowed?: Narrowed;
  /** Why there is no number, and what would produce one. Required unless `measured`/`partial`. */
  readonly gap: string;
}

/**
 * The denominator a reading was taken on, when it is not the leaderboard's.
 *
 * A rate is a claim about a set of questions, so a rate over 600 of 1,532 is a different claim and
 * not a smaller version of the same one. This repository has already paid for that lesson: 63.67%
 * on the 600-question subset sat in a report beside 62.34% on the full split as if the two were
 * ordered, and a reader comparing them read a sampling difference as progress. The field exists so
 * the sentence "56.56% R-VES" cannot be written without the number of questions it is about.
 */
export interface Narrowed {
  readonly scored: number;
  readonly of: number;
  readonly why: string;
}

export const BENCHMARKS: readonly Benchmark[] = [
  {
    id: 'wikisql',
    domain: 'text2sql',
    name: 'WikiSQL dev (EX)',
    source: 'https://github.com/salesforce/WikiSQL',
    corpus: '8,421 dev questions over 2,630 tables of one SQLite file: single-table, one condition per query',
    metrics: ['EX'],
    status: 'measured',
    reading: {
      file: 'eval/baseline/wikisql.json',
      path: ['exactPct'],
      kind: 'run',
      unit: 'percent',
      note: 'one call a question, no candidate set and no repair loop; `exact` and `bag` are the same '
        + 'count (7,183), so the leaderboard\'s ordered comparison costs nothing here; 14 statements '
        + 'did not execute and stay in the denominator',
    },
    gap:
      'The number is dev, a chat-tier model and no training. Every published WikiSQL figure above 90% '
      + 'is a fine-tuned system on test (SeaD+EG 93.0), so this row is comparable to a zero-shot '
      + 'baseline and not to the leaderboard\'s top: the honest statement is "85.30% single-call on '
      + 'dev", with the model and the split attached, and the leaderboard comparison written against '
      + 'the systems that trained nothing. Two rendering defects were found before this reading and '
      + 'are recorded in `docs/benchmarks.md`: the corpus\'s databases name their columns `col0…` '
      + 'while its JSON names them `Pick…`, and store their text folded while the JSON keeps the '
      + 'page\'s case. Sending the JSON\'s names and case scored 0 of 40 on a pilot; sending the '
      + 'engine\'s scored 35 of 40, and the full split followed from there.',
  },
  {
    id: 'spider-dev',
    domain: 'text2sql',
    name: 'Spider 1.0 dev (EM and EX)',
    source: 'https://yale-lily.github.io/spider',
    corpus: '1,034 dev questions over 20 databases; 200 databases and 10,181 questions in the corpus',
    metrics: ['EM', 'EX'],
    status: 'measured',
    reading: {
      file: 'eval/baseline/spider.json',
      path: ['exactAfterNormalize'],
      kind: 'run',
      unit: 'percent',
      note: 'one call a question, chat tier, the `grammar` prompt, and the dialect the reference reads: '
        + '59.77% as written (618 of 1,034) and 61.90% after `eval/spider/normalize.ts` repairs four '
        + 'spellings the grammar does not have and no other. The 45 statements the grammar arm still '
        + 'had refused were eight mechanical classes, not a missing idea — 21 `<>`, 11 self-aliases, '
        + '4 `INNER JOIN`, 3 `CAST`, and 6 that no repair can reach — and the 22 of them that were '
        + 'right are why this number is cited rather than the prompt one. Refusals stay in the '
        + 'denominator at both readings, because Spider scores them zero',
    },
    gap:
      'The corpus is the databases, not the question file — `process_sql.get_sql` resolves every '
      + 'column through a `Schema` built from a live SQLite file — and the twenty `.sqlite` files '
      + 'ship only inside a 350 MB `spider_data.zip` this repository cannot reach. Four routes to '
      + 'that archive failed; the fifth is `eval/spider/fetch.mjs`, which takes the corpus\'s own '
      + '`tables.json` (810,971 B, fetched and pinned by sha256) and builds one database per '
      + 'database it declares. `get_schema` reads the catalogue — table names, column names, column '
      + 'order — and never a row, so a skeleton has the same schema as the official file, and the '
      + 'proof is the check `eval/spider/check.ts` already ran: **1,034 of 1,034 dev golds parse and '
      + 'read exact match against themselves** on 4.4 MB instead of 350 MB. An earlier round '
      + 'concluded rebuilding was impossible because one public schema export normalises '
      + 'identifiers (`PetType` arrives as `pet_type`, and 300 of 1,034 golds stop parsing); that '
      + 'finding stands against that export and does not generalise to the corpus\'s own. What is '
      + 'still missing is a reading: `eval/spider/ask.ts` asks the schema-only arm and '
      + '`eval/spider/score.ts` scores with the reference judge, both tested, neither dispatched.',
  },
  {
    id: 'bird-mini-dev',
    domain: 'text2sql',
    name: 'BIRD Mini-Dev (EX)',
    source: 'https://bird-bench.github.io/',
    corpus: '498 questions over 11 SQLite databases, the split CI runs on every commit',
    metrics: ['EX'],
    status: 'measured',
    reading: {
      file: 'eval/baseline/bird.json',
      path: ['floors', 'minidev', 'macsql-prompt'],
      kind: 'floor',
      unit: 'percent',
      note: 'the floor a rerun may not fall below, taken on `macsql-prompt` — the arm the product '
        + 'sends. Until round 200 this row cited `select` and said why: no Mini-Dev reading of the '
        + 'shipped arm existed, because the only way to run one arm was to edit the chain and push. '
        + 'It exists now (64.31% on 496 questions, run 45846766964, dispatched with one arm and no '
        + 'control), so the number a reader quotes is the one the product would have produced',
    },
    gap: '',
  },
  {
    id: 'bird-dev',
    domain: 'text2sql',
    name: 'BIRD dev (EX)',
    source: 'https://bird-bench.github.io/',
    corpus: '1,532 scored questions over 11 databases, the split the published leaderboard reports',
    metrics: ['EX'],
    status: 'measured',
    reading: {
      file: 'eval/baseline/bird-ves.json',
      path: ['ex'],
      kind: 'run',
      unit: 'percent',
      note: 'the arm that ships, on the denominator the leaderboard reports: `macsql-prompt`, 1,010 '
        + 'of 1,532 in run 44991167518 — 12.56pp behind the field top (AskData 78.49, training-free, '
        + 'GPT-4o, 8+ calls) and 7.27pp behind the top trained system (SQLConductor 73.2), which are '
        + 'two different claims. This row cited `select-mixed`\'s floor (62.5) and its 62.34 reading '
        + 'until this round, which was a true number about a true arm and the wrong arm: a leaderboard '
        + 'row is what a caller gets, `select-mixed` is the best of the selection family and does not '
        + 'ship, and the R-VES row beside this one has always been the shipped arm — the two rows '
        + 'disagreed about which arm this project sends, and nothing failed. `bird.json`\'s '
        + '`shippedBySplit` is that question as a field now, tied by tests to `SHIPPED_SQL`, to the '
        + 'ledger and to the reading here',
    },
    gap: '',
  },
  {
    id: 'bird-dev-rves',
    domain: 'text2sql',
    name: 'BIRD dev (R-VES)',
    source: 'https://bird-bench.github.io/',
    corpus: 'the same 1,532 questions, ranked by the reward-weighted efficiency score',
    metrics: ['R-VES'],
    status: 'measured',
    reading: {
      file: 'eval/baseline/bird-ves.json',
      path: ['rves'],
      kind: 'run',
      unit: 'percent',
      note: 'the arm that ships, over the denominator the leaderboard reports: 59.81% over 1,532 '
        + 'questions, 1,010 of them answered correctly, three full runs landing 59.81 / 59.56 / '
        + '59.87, five timings a statement trimmed by median absolute deviation. It replaces a '
        + '600-question reading of `select-cross` (56.63) that this row carried as `partial` for two '
        + 'rounds, because the full-split version of the same measurement read 0.00% and exited 0: '
        + '`eval/bird/ves.ts` resolved the predicted statement from a `candidates` list that only a '
        + 'multi-candidate arm writes, never from the `sql` every artifact writes per case, so 1,010 '
        + 'correct answers arrived statement-less and were scored wrong. The floor on this corpus is '
        + '62.21 (every prediction replaced by its own gold): 3.72pp of the 6.12pp between EX 65.93 '
        + 'and this reading is the reward table\'s step at tau = 1, and 2.40pp is the shipped '
        + 'statements running slower than the gold they are equal to. That floor applies to every '
        + 'row on the leaderboard too, which is why the gap there is 2.92pp and here 6.12pp — a '
        + 'statement-speed difference, not a scoring one. §R-VES in docs/benchmarks.md.',
    },
    gap: '',
  },
  {
    id: 'text2vis',
    domain: 'text2viz',
    name: 'Text2Vis (top-1)',
    source: 'https://github.com/mizanurr/Text2Vis',
    corpus: '1,985 rows, 1,470 scored after unmapped labels; the product\'s own scorer',
    metrics: ['top-1'],
    status: 'measured',
    reading: {
      file: 'eval/text2vis/baseline.json',
      path: ['top1'],
      kind: 'run',
      unit: 'count',
      note: 'the shipped rule table; the model arms and the arbitration are recorded beside it',
    },
    gap: '',
  },
  {
    id: 'text2vis-render',
    domain: 'text2viz',
    name: 'Text2Vis (render validity)',
    source: 'https://github.com/mizanurr/Text2Vis',
    corpus: 'the same rows, counted by figures that reach a PNG with no exception',
    metrics: ['validity'],
    status: 'measured',
    reading: {
      file: 'eval/text2vis/baseline.json',
      path: ['render', 'rendered'],
      kind: 'census',
      unit: 'count',
      note: 'a count of figures, floored as (rendered >= this, failed == 0)',
    },
    gap: '',
  },
  {
    id: 'nvbench2',
    domain: 'text2viz',
    name: 'nvBench 2.0 (F1@k under ambiguity)',
    source: 'https://nvbench2.github.io/ (arXiv:2503.12880)',
    corpus: '7,878 queries and 24,076 visualizations over 780 tables in 153 domains',
    metrics: ['F1@3', 'F1@5'],
    status: 'measured',
    reading: {
      file: 'eval/nvbench2/metrics.json',
      path: ['arms', 'selected', 'published', 'f1@3'],
      kind: 'run',
      note: 'F1@3 over the 750-question dev split on deepseek-reasoner with `count,corpus,corpus2,steps`: '
        + '32.23, against 26.28 for the chat tier with the same rules. The corpus supplied the control '
        + 'rather than a comparison: its own prompts, sent byte for byte on the same model, read 29.49 '
        + '(full basic, -2.74, 95% [-4.91, -0.46]) and 25.63 (six steps), so the 29.5 points between its '
        + 'published 58.96 and its own prompt re-read here belong to the model tier and not to the '
        + 'prompt. Ceiling 84.96. The 751-question **test** split holds four readings and the four '
        + 'pairs they make: the same arm twice (-0.08, 95% [-1.25, 1.08], the resolution), the shipped '
        + 'chat rules against the runner-up they beat on dev (+3.84, 95% [1.89, 6.01]), the tiers on '
        + 'one rule list (+6.63, 95% [4.60, 8.64]) and the tiers as each one ships (+2.71, 95% [0.74, '
        + '4.72], at 8.2x the bill). The third is a mechanism and the fourth is the product: the shipped '
        + 'chat arm is 3.84 points above the one the same-rules comparison held fixed, so the tier\'s '
        + 'advantage narrows to 2.71 and its pessimistic end falls under the resolution — which is why '
        + 'the default stays on the chat tier',
    },
    gap:
      'Measured, and the number is a prompt arm rather than a trained system. `eval/nvbench2/'
      + 'fetch.mjs` pulls the two splits and the 803-table archive from jsDelivr (22 MB, pinned by '
      + 'digest; the 27.5 MB train split answers 403 there and is not needed). `eval/nvbench2/'
      + 'metadata.py` rebuilds the `raw_data/nvbench_metadata.json` the reference imports at module '
      + 'scope, which the checkout does not ship — and it rebuilds it from a rule the corpus itself '
      + 'demonstrates: read every column and type it by name and dtype, dropping nothing. The '
      + 'checkout\'s own filter stage cannot be what produced the checkout\'s data, because it would '
      + 'remove 42 fields that the shipped `table_schema` still lists (`formula_1`.number is 804 of 842 '
      + 'rows empty, `cre_Doc_Template_Mgt`.document_id holds ids like `16514113`, `college_2`.name '
      + 'holds `Álvarez`). Measured against `column_examples` — min/median/max for a quantitative column '
      + '— the map agrees on **8,952 of 8,952** field decisions, with 0 of 10,830 gold field references '
      + 'left untyped (the filtered rebuild left 243). `eval/nvbench2/judge.ts` is the port and '
      + '`eval/nvbench2/diff.py` is the evidence: the vendored reference and the port produce the same '
      + 'digest over all 1,501 preprocessed gold charts and the same F1@1/3/5 on both splits. The one '
      + 'number worth quoting before any model runs is **818 of 1,501 golds are transpose-equivalent** '
      + '(381 dev, 437 test) — that is how much of the reading the type map decides. Ten arms price '
      + 'the prompt in `metrics.json`, and every claim of a gain between them now carries a paired '
      + 'bootstrap interval: the ask sweep is inside the noise, `steps` clears it (+3.90, 95% '
      + '[1.99, 5.80] over 750 questions) and is worth nothing measurable on the reasoning tier, where '
      + 'the decomposition is already happening. Four more arms send the corpus\'s own prompts instead '
      + '(`metrics.json` `replicas`), which is what turns "our prompt may be the problem" into a '
      + 'measurement: none of the four reads above the shipped arm, and the corpus\'s full basic prompt '
      + 'reads 29.49, so the part of the gap a prompt explains is small and known. The wall the misses '
      + 'still hit is which column a sentence means (794 of 1,534 misses part on `field`), and what '
      + 'separates this arm from the leaderboard is now model strength and a step-trained decoder rather '
      + 'than the prompt: a *prompted* Qwen3-235B-Step reads 77.78 F1@5 and Step-NL2VIS 81.50 F1@3 with '
      + 'SFT.',
  },
  {
    id: 'viscodebench',
    domain: 'text2viz',
    name: 'VisCodeBench (seven metrics)',
    source: 'https://github.com/SAIPLL/VisCodeBench (arXiv:2611.02353)',
    corpus: '2,672 samples: GitHub-T2V 843, arXiv-T2V 805, OWID-T2V 1,024',
    metrics: ['execution', 'chart content', 'displayed data similarity', 'accessibility'],
    status: 'absent',
    gap:
      'Not a fetch problem, which is what this row said for two rounds and was wrong about: the sample '
      + 'inputs are downloadable from the leaderboard (Codabench competition 16125) and the scoring '
      + 'engine `t2v_eval` is public and LLM-independent — it monkey-patches matplotlib, seaborn, pandas '
      + 'and geopandas, logs the series each call draws to `series.jsonl`, and compares two log '
      + 'directories. What is private is the reference solutions, and that is the whole submission path: '
      + 'log the displayed data locally, upload the zip, let their server score it. So the two real '
      + 'costs are engineering, not money. (1) A code-emitting mode: the contract is Python written into '
      + 'a marked region of a notebook, not a chart spec, and this product emits specifications. (2) A '
      + 'submission path: a Codabench entry, a Docker run of 2,672 generated programs, and retries where '
      + 'the program raises. The money is generation only — no judge model exists in this metric, which '
      + 'is why the estimate is a token count rather than a judgement: 2,672 samples at 3–6k prompt and '
      + '300–800 completion tokens is ¥21–53 at deepseek-chat prices, and a 300-sample stratified pilot '
      + 'that measures tokens a sample and the execution-failure rate is ¥3–6. `accessibility` is the '
      + 'one metric that needs no reference at all (`calculate_accessibility_score(image_path)`), so a '
      + 'pilot can report it locally before any submission exists.',
  },
];

/** The leaderboards the plan commits to. A row removed from `BENCHMARKS` fails the gate. */
export const REQUIRED: readonly string[] = [
  'wikisql',
  'spider-dev',
  'bird-mini-dev',
  'bird-dev',
  'bird-dev-rves',
  'text2vis',
  'text2vis-render',
  'nvbench2',
  'viscodebench',
];

/** How a `read` function gets a file's text. Injected so the gate is testable without disk. */
export type Reader = (file: string) => unknown;

/**
 * The number a reading cites, or `undefined` when the path does not resolve to one.
 *
 * `#key=value` is the one piece of syntax beyond plain descent: an artifact's arm rows are an array,
 * and an arm is identified by its `arm` field rather than by its position, which changes whenever a
 * dispatch asks for a different set of arms.
 */
export function resolveReading(reading: Reading, read: Reader): number | undefined {
  let cursor: unknown;
  try {
    cursor = read(reading.file);
  } catch {
    return undefined;
  }
  for (const step of reading.path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    const selector = /^#([^=]+)=(.+)$/.exec(step);
    if (selector !== null) {
      if (!Array.isArray(cursor)) return undefined;
      const [, key, wanted] = selector;
      cursor = (cursor as Record<string, unknown>[]).find((row) => String(row[key as string]) === wanted);
      continue;
    }
    if (Array.isArray(cursor)) {
      const index = Number(step);
      if (!Number.isInteger(index)) return undefined;
      cursor = cursor[index];
      continue;
    }
    cursor = (cursor as Record<string, unknown>)[step];
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : undefined;
}

/** Everything wrong with a row set. An empty array is the only passing answer. */
export function checkCoverage(rows: readonly Benchmark[], read: Reader): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) issues.push(`${row.id}: duplicate id`);
    seen.add(row.id);
    if (row.metrics.length === 0) issues.push(`${row.id}: names no metric`);
    if (row.status === 'measured' || row.status === 'partial') {
      if (row.reading === undefined) {
        issues.push(`${row.id}: ${row.status} with no reading to check`);
        continue;
      }
      const value = resolveReading(row.reading, read);
      if (value === undefined) {
        issues.push(`${row.id}: reads no number at ${row.reading.file} ${row.reading.path.join('.')}`);
        continue;
      }
      if (row.reading.unit !== 'count' && (value < 0 || value > 100)) {
        issues.push(`${row.id}: ${value} is not a percentage`);
      }
    } else {
      if (row.reading !== undefined) issues.push(`${row.id}: ${row.status} but cites a reading`);
      if (row.gap.trim().length < 60) issues.push(`${row.id}: ${row.status} with no reason a reader can act on`);
    }
    // The denominator, in both directions. A full reading that also claims to be a subset is a row
    // whose two sentences disagree; a subset reading that does not name its size is the shape that
    // put 63.67% beside 62.34% as though they were ordered.
    if (row.status === 'partial') {
      const narrowed = row.narrowed;
      if (narrowed === undefined) {
        issues.push(`${row.id}: partial with no denominator, so a reader cannot tell what the number is about`);
      } else if (!(narrowed.scored > 0) || !(narrowed.of > 0)) {
        issues.push(`${row.id}: ${narrowed.scored} of ${narrowed.of} is not a denominator`);
      } else if (narrowed.scored >= narrowed.of) {
        issues.push(`${row.id}: ${narrowed.scored} of ${narrowed.of} is the whole split, which is what measured means`);
      } else if (narrowed.why.trim().length < 40) {
        issues.push(`${row.id}: narrowed to ${narrowed.scored} of ${narrowed.of} with no reason a reader can act on`);
      }
    } else if (row.narrowed !== undefined) {
      issues.push(`${row.id}: ${row.status} but names a narrower denominator`);
    }
  }
  for (const id of REQUIRED) if (!seen.has(id)) issues.push(`${id}: required leaderboard is missing`);
  return issues;
}

/**
 * Which kind of number a line printed.
 *
 * A log line is what a reader quotes into a document, and the number on it means three different
 * things: a `run` is an observation, a `floor` is the minimum a rerun may land on, a `census`/`count`
 * is a tally. `bird-mini-dev` cites the floor (56) while a run of the same split reads 56.6, and
 * printing either without the word that says which is which is how the two get confused. `bird-dev`
 * used to be the other example — a floor of 62.5 beside a reading of 62.34 — and it is a run now,
 * because the row that answers "what does this project score on this leaderboard" may not be a
 * threshold on an arm the product does not send.
 */
function qualifier(reading: Reading): string {
  if (reading.kind === 'floor') return ' (floor)';
  if (reading.kind === 'census' || reading.unit === 'count') return ' (count)';
  return '';
}

/** The table, as the lines a workflow log prints and a document quotes. */
export function describeCoverage(rows: readonly Benchmark[], read: Reader): string[] {
  const lines: string[] = [];
  for (const domain of ['text2sql', 'text2viz'] as const) {
    for (const row of rows.filter((entry) => entry.domain === domain)) {
      const reading = row.reading;
      const value = reading === undefined ? undefined : resolveReading(reading, read);
      // A partial reading carries its denominator on the line, because the line is what gets quoted:
      // "56.56% R-VES" and "56.56% R-VES over 600 of 1,532 questions" are different claims, and only
      // the second one is true.
      const denominator = row.narrowed === undefined ? '' : ` (${row.narrowed.scored} of ${row.narrowed.of})`;
      const shown = reading === undefined || value === undefined ? '—' : `${value}${qualifier(reading)}${denominator}`;
      lines.push(`COVERAGE ${domain} ${row.id}: ${row.status}, ${row.metrics.join('/')} = ${shown}`);
    }
  }
  return lines;
}

/** Run the gate. `--require` is the default; the flag exists so the workflow reads as a check. */
export async function main(
  argv: readonly string[] = [],
  read: Reader = (file) => JSON.parse(readFileSync(file, 'utf8')) as unknown,
  log: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  const quiet = argv.includes('--quiet');
  if (!quiet) for (const line of describeCoverage(BENCHMARKS, read)) log(line);
  const issues = checkCoverage(BENCHMARKS, read);
  for (const issue of issues) log(`COVERAGE: ${issue}`);
  const measured = BENCHMARKS.filter((row) => row.status === 'measured').length;
  const partial = BENCHMARKS.filter((row) => row.status === 'partial').length;
  log(`COVERAGE: ${measured} of ${BENCHMARKS.length} leaderboards carry a number over the leaderboard's `
    + `own denominator, ${partial} more over a narrower one; `
    + `${REQUIRED.filter((id) => !BENCHMARKS.some((row) => row.id === id)).length} required rows missing`);
  return issues.length === 0 ? 0 : 1;
}

/**
 * The workflow's way in: print the table, refuse a row that claims what the repository cannot show.
 *
 * Written with the same guard as the other instruments so that importing this file in a test cannot
 * start a check, and running it cannot be forgotten.
 */
export async function entryCoverage(
  argv1: string | undefined,
  moduleUrl: string,
  log: (line: string) => void,
  argv: readonly string[] = [],
): Promise<number | undefined> {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  return main(argv, undefined, log);
}

void entryCoverage(process.argv[1], import.meta.url, (line) => process.stdout.write(`${line}\n`),
  process.argv.slice(2)).then((code) => {
  if (code !== undefined) process.exitCode = code;
});
