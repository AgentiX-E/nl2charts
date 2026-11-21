/**
 * Which leaderboards this repository can put a number on, and which it cannot — as data a gate reads.
 *
 * Every claim of the form "we are 10.9pp behind the leader" rests on two facts that are usually
 * prose: the corpus was scored, and the metric the leaderboard ranks by was computed. Prose rots.
 * A number is copied into a document from a run three rounds old, the harness that produced it is
 * deleted, and the sentence survives the thing it described. This file is the other way round: each
 * benchmark is a row with the corpus it is scored on, the metrics it is ranked by, a status, and a
 * reading that a machine resolves. `pnpm bench:coverage` refuses a row that claims a reading the
 * repository cannot resolve, and refuses a missing row for a leaderboard the plan names — so the
 * table in the documentation and the state of the code cannot drift apart without a red build.
 *
 * The three statuses are deliberately about *evidence*, not about effort:
 *
 *   - `measured` — a number exists in this repository, at the file and path cited. The gate resolves
 *     it and refuses the row if the value is not a finite number.
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
export type Status = 'measured' | 'instrumented' | 'absent';

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
  /** Why there is no number, and what would produce one. Required unless `measured`. */
  readonly gap: string;
}

export const BENCHMARKS: readonly Benchmark[] = [
  {
    id: 'wikisql',
    domain: 'text2sql',
    name: 'WikiSQL (test)',
    source: 'https://github.com/salesforce/WikiSQL',
    corpus: '80,654 question/table pairs over 24,241 tables, single-table, one condition per query',
    metrics: ['EX'],
    status: 'absent',
    gap:
      'The corpus is not vendored and no harness reads it. It is also the benchmark this pipeline is '
      + 'least shaped for: every WikiSQL question is single-table and single-condition, so the schema '
      + 'card, the join graph and the linker — the three mechanisms this repository has priced — have '
      + 'nothing to do. Building it means a second adapter (its tables are JSON, not SQLite) and a '
      + 'flattening of the question into the same prompt contract; the number would then measure a '
      + 'capability this product does not sell.',
  },
  {
    id: 'spider-dev',
    domain: 'text2sql',
    name: 'Spider 1.0 dev (EM and EX)',
    source: 'https://yale-lily.github.io/spider',
    corpus: '1,034 dev questions over 20 databases; 200 databases and 10,181 questions in the corpus',
    metrics: ['EM', 'EX'],
    status: 'absent',
    gap:
      'Spider needs an exact-match reading as well as an execution one, and this repository has only '
      + 'the execution judge: `eval/bird/compare.ts` compares result sets through the same driver BIRD '
      + 'uses, and `arms[].exactMatchRate` is a normalised string match over generated statements, not '
      + 'Spider\'s component-wise clause match. Building it means vendoring the 1,034-question dev set '
      + 'with its SQLite files, porting the official evaluator\'s clause decomposition, and re-pricing '
      + 'every floor — a split is a coordinate, and a number moved across splits is not a reading.',
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
      path: ['floors', 'minidev', 'select'],
      kind: 'floor',
      unit: 'percent',
      note: 'the floor a rerun may not fall below; `select-mixed` is not run on this split',
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
      file: 'eval/baseline/bird.json',
      path: ['floors', 'dev', 'select-mixed'],
      kind: 'floor',
      unit: 'percent',
      note: 'the floor; the published reading on this split is 62.34% in run 41296610389',
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
    status: 'instrumented',
    gap:
      'The metric is implemented and tested (`eval/bird/ves.ts`, `pnpm bench:bird:ves`) and the oracle '
      + 'now reports microsecond timings, but no dispatch has produced a number: a timed run needs the '
      + 'dev databases fetched and every statement re-executed several times. It is instrumented rather '
      + 'than absent because the only thing missing is a run, and a run has a price.',
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
    status: 'absent',
    gap:
      'The corpus is public on Hugging Face and no harness here reads it. Two things differ from '
      + 'Text2Vis: one query has a *set* of valid visualizations, so the reading is precision and recall '
      + 'over that set rather than top-1, and the mark vocabulary is Vega-Lite specifications rather '
      + 'than this repository\'s eleven-mark contract. Building it means an adapter from Vega-Lite to '
      + 'the mark contract plus a set-valued scorer; the leaderboard is trained-model territory '
      + '(Step-NL2VIS 81.50 F1@3), which is the same wall as BIRD\'s.',
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
      'The dataset is deliberately private (it is released through a leaderboard, to keep it out of '
      + 'training corpora), so it cannot be vendored the way BIRD and Text2Vis are. Its task is also a '
      + 'different contract: the system emits Python code into a marked region of a notebook, and the '
      + 'reading intercepts the plotting calls to compare displayed data. Building it means a submission '
      + 'path rather than a local harness, and a code-emitting mode this product does not ship.',
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
    if (row.status === 'measured') {
      if (row.reading === undefined) {
        issues.push(`${row.id}: measured with no reading to check`);
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
  }
  for (const id of REQUIRED) if (!seen.has(id)) issues.push(`${id}: required leaderboard is missing`);
  return issues;
}

/** The table, as the lines a workflow log prints and a document quotes. */
export function describeCoverage(rows: readonly Benchmark[], read: Reader): string[] {
  const lines: string[] = [];
  for (const domain of ['text2sql', 'text2viz'] as const) {
    for (const row of rows.filter((entry) => entry.domain === domain)) {
      const value = row.reading === undefined ? undefined : resolveReading(row.reading, read);
      const shown = value === undefined ? '—' : `${value}`;
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
  log(`COVERAGE: ${measured} of ${BENCHMARKS.length} leaderboards carry a number; `
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
