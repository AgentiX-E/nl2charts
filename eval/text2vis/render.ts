/**
 * The pixel half: `ChartIR` → PNG, with no browser anywhere in the path.
 *
 * Two of the four criteria in the public NL2Vis benchmark are stated about the picture — a readability
 * score and a correctness score, both given by a judge that looks at the figure — and this repository
 * had no way to produce the figure. It emits a `ChartIR`, and `compileToMatplotlib` turns that into
 * source, so the missing piece was never a renderer: it was the act of *running* the source and
 * catching what it saved. That is what this file does, and it is deliberately the smallest thing that
 * can: a job list, a worker that calls `exec` on the source the compiler emitted, and a count.
 *
 * **What the count means, and what it does not.** `rendered` is not an accuracy reading. It says the
 * product produced an IR, the IR reached Python, and Python saved a file — three steps whose failures
 * have three different repairs, and the report keeps them apart for exactly that reason:
 *
 * | outcome | meaning | whose defect |
 * | --- | --- | --- |
 * | `rendered` | the figure exists | — |
 * | `refused` | the compiler declined the IR, with a code | the contract's edge, priced |
 * | `declined` | the product answered no chart at all | the recommender's (`profile.ts` counts it too) |
 * | `failed` | the source ran and raised | **this repository's** |
 *
 * A non-zero `failed` is a bug and the report refuses to publish: the source is emitted by
 * `compileToMatplotlib` from an IR the contract accepted, so a Python exception means the emitter and
 * the contract disagree — which is the class of defect that a reading about *charts* would never show.
 *
 * **Why the whole corpus and not a sample.** Rendering is deterministic and costs no tokens, so the
 * whole 1,470-row reading is cheaper than a justification for sampling it. The one thing it does cost
 * is time, and the report carries that too: the p50 and p95 of a single figure, which is the number a
 * caller asking "can this run per request" actually needs.
 */
import { compileToMatplotlib, recommendChart, toChartIR, type RecommendableMark } from '@agentix-e/nl2charts-chart';
import type { ChartIR } from '@agentix-e/nl2charts-spec';
import { Nl2ChartsError } from '@agentix-e/nl2charts-spec';
import { applyExitCode, isEntry, loadText2Vis, type LoadOptions } from './dataset.js';
import { meltWide } from '@agentix-e/nl2charts-chart';
import { parseResultSet, profileInputs, profilesOf, typedRows, type ProfileInput } from './profile.js';
import { familyOfLabel, percentiles } from './rule.js';

/** One chart to draw: the source the compiler emitted, and the row it came from. */
export interface ChartJob {
  /** The row's position in the corpus, which is the only stable name a result set has. */
  readonly id: string;
  readonly mark: RecommendableMark;
  readonly code: string;
}

/**
 * One chart the reading could not produce, and which of the three reasons it was.
 *
 * `code` is the error code of `@agentix-e/nl2charts-spec` where one applies, so a refusal can be
 * counted without matching a sentence: `NL2C_E_NOT_SUPPORTED` is the contract's edge (a mark this
 * compiler does not paint, an IR missing a channel), `NL2C_E_INVALID_IR` is a linter error, and
 * `profile:none` / `profile:refused` are the two ways the recommender answers nothing.
 */
export interface ChartRefusal {
  readonly id: string;
  readonly mark: RecommendableMark | 'declined';
  readonly code: string;
  readonly reason: string;
}

/** What the worker reported for one job. */
export interface ChartVerdict {
  readonly id: string;
  readonly ok: boolean;
  readonly ms?: number;
  readonly bytes?: number;
  readonly error?: string;
}

export interface ChartJobs {
  readonly jobs: readonly ChartJob[];
  readonly refusals: readonly ChartRefusal[];
}

/** The code an error carries, or `internal` for one this layer never throws. */
function codeOf(error: unknown): string {
  return error instanceof Nl2ChartsError ? error.code : 'internal';
}

/**
 * The sentence an error carries, or the value's own spelling.
 *
 * Exported because three instruments in this directory print the reason a row failed, and the one
 * defect worth not repeating is a log line that reads `Error: Error: ...` because each caller wrote
 * its own extractor.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turn corpus rows into the list of charts to draw.
 *
 * The recommender is asked *before* `toChartIR` so that "the product answered nothing" stays a
 * separate bucket from "the compiler refused the answer": both are counts a reader has to be able to
 * subtract, and `toChartIR` folds the first into an exception that reads like the second. `profile.ts`
 * publishes the same two counts on its own path, and the two have to agree — the reading here would
 * otherwise be about a recommender the product does not ship.
 */
export function chartJobs(rows: readonly ProfileInput[]): ChartJobs {
  const jobs: ChartJob[] = [];
  const refusals: ChartRefusal[] = [];
  rows.forEach((row, index) => {
    const id = String(index);
    const set = parseResultSet(row.tableData);
    // Read once, because both the melt and `toChartIR` need the typed cells and a second call is a
    // second answer to the same question.
    const typed = typedRows(set);
    // A table that is wide in time is answered by the reshape before any column is profiled. Without
    // this check the recommender would refuse it — its period columns are competing measures to every
    // admission rule — and the reading would report the product declining a table it now draws, which
    // is a number about this harness rather than about the product.
    if (meltWide(typed, set.columns) === undefined) {
      const profiles = profilesOf(set);
      if (profiles.length === 0) {
        refusals.push({ id, mark: 'declined', code: 'profile:none', reason: 'the table would not profile' });
        return;
      }
      const choice = recommendChart(row.prompt, profiles, { rows: set.rows.length });
      if (choice.recommendations[0] === undefined) {
        refusals.push({ id, mark: 'declined', code: 'profile:refused', reason: 'every admission rule refused the table' });
        return;
      }
    }
    // `toChartIR` is not wrapped: every way it throws needs a result set `profilesOf` would have
    // answered with no columns, or a recommendation this function has just read — so a catch here
    // would be a branch no row reaches, and a coverage number would be the only thing that ever ran
    // it. An exception from it is a defect in the product and belongs in the reading as a failure.
    // `set.columns` because the table's order is what the query selected, and a record's key order
    // is not: a year column named `2016` enumerates first and became the category axis of 389 rows.
    const ir: ChartIR = toChartIR(row.prompt, typed, { columns: set.columns });
    try {
      // The mark the figure was drawn as, not the one the recommender ranked first: for a melted
      // table they are two different facts, and the report is a table about figures.
      // `ir.mark` is one of the marks `toChartIR` can answer with, all of which are recommendable;
      // the contract's type is wider than the pipeline's because a hand-written IR may name any mark.
      jobs.push({ id, mark: ir.mark as RecommendableMark, code: compileToMatplotlib(ir) });
    } catch (error) {
      refusals.push({ id, mark: ir.mark as RecommendableMark, code: codeOf(error), reason: messageOf(error) });
    }
  });
  return { jobs, refusals };
}

/** One mark's line in the report. */
export interface MarkReading {
  readonly mark: RecommendableMark | 'declined';
  /** Rows this bucket holds: a chart for a mark the product answered, a row for `declined`. */
  readonly rows: number;
  readonly rendered: number;
  readonly refused: number;
  readonly declined: number;
  readonly failed: number;
}

export interface RenderReport {
  /** Rows the corpus labels with a chart family, which is the denominator throughout. */
  readonly scored: number;
  readonly charts: number;
  readonly rendered: number;
  readonly failed: number;
  readonly refused: number;
  readonly declined: number;
  readonly byMark: readonly MarkReading[];
  readonly refusalCodes: readonly { readonly code: string; readonly n: number }[];
  /** The first few failures, with their messages: enough to name the defect, not the whole log. */
  readonly failures: readonly { readonly id: string; readonly mark: string; readonly error: string }[];
  /** Milliseconds per figure, as the worker measured them. */
  readonly latency: { readonly p50: number; readonly p95: number; readonly max: number };
  /** Bytes per PNG, which is what a caller pays to keep one. */
  readonly bytes: { readonly p50: number; readonly p95: number; readonly total: number };
}

const FAILURES_KEPT = 10;

/**
 * Fold the three lists into the report, and refuse to fold them when they do not add up.
 *
 * The identity is the instrument, as it is in `rule.ts` and `profile.ts`: every scored row is a
 * rendered figure, a refusal, a decline, or a failure, and a report whose counters miss one is a
 * share over the wrong denominator. The assertion runs here rather than in the caller because a
 * second pass could disagree with this one about what a row is.
 */
export function summarize(
  scored: number,
  charts: ChartJobs,
  verdicts: readonly ChartVerdict[],
): RenderReport {
  // A mutable tally per mark, published through a readonly view: the counters are accumulated here
  // and nowhere else, so the report cannot be edited after it is checked.
  const byMark = new Map<RecommendableMark | 'declined', { mark: RecommendableMark | 'declined'; rows: number; rendered: number; refused: number; declined: number; failed: number }>();
  const reading = (mark: RecommendableMark | 'declined'): { rows: number; rendered: number; refused: number; declined: number; failed: number } => {
    const found = byMark.get(mark);
    if (found !== undefined) return found;
    const created = { mark, rows: 0, rendered: 0, refused: 0, declined: 0, failed: 0 };
    byMark.set(mark, created);
    return created;
  };
  const verdictOf = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
  const failures: { id: string; mark: string; error: string }[] = [];
  const latencies: number[] = [];
  const sizes: number[] = [];
  let rendered = 0;
  let failed = 0;
  for (const job of charts.jobs) {
    const entry = reading(job.mark);
    entry.rows += 1;
    const verdict = verdictOf.get(job.id);
    if (verdict === undefined) {
      throw new Error(`render report: no verdict for row ${job.id}, so the worker lost a job`);
    }
    if (verdict.ok) {
      entry.rendered += 1;
      rendered += 1;
      if (verdict.ms !== undefined) latencies.push(verdict.ms);
      if (verdict.bytes !== undefined) sizes.push(verdict.bytes);
      continue;
    }
    entry.failed += 1;
    failed += 1;
    if (failures.length < FAILURES_KEPT) {
      failures.push({ id: job.id, mark: job.mark, error: verdict.error ?? 'no message' });
    }
  }
  const codes = new Map<string, number>();
  for (const refusal of charts.refusals) {
    const entry = reading(refusal.mark);
    entry.rows += 1;
    codes.set(refusal.code, (codes.get(refusal.code) ?? 0) + 1);
    if (refusal.mark === 'declined') {
      entry.declined += 1;
    } else {
      entry.refused += 1;
    }
  }
  const declined = charts.refusals.filter((refusal) => refusal.mark === 'declined').length;
  const refused = charts.refusals.length - declined;
  const report: RenderReport = {
    scored,
    charts: charts.jobs.length,
    rendered,
    failed,
    refused,
    declined,
    byMark: [...byMark.values()].sort((left, right) => right.rows - left.rows),
    refusalCodes: [...codes.entries()]
      .map(([code, n]) => ({ code, n }))
      .sort((left, right) => right.n - left.n),
    failures,
    latency: [...latencies].length === 0 ? { p50: 0, p95: 0, max: 0 } : percentiles(latencies),
    bytes: {
      p50: sizes.length === 0 ? 0 : percentiles(sizes).p50,
      p95: sizes.length === 0 ? 0 : percentiles(sizes).p95,
      total: sizes.reduce((sum, size) => sum + size, 0),
    },
  };
  assertRenderReport(report);
  return report;
}

/**
 * The arithmetic a render report can be wrong about, refused rather than published.
 *
 * Two assertions and one prohibition. The first is the identity that makes the shares mean
 * something; the second is that every mark line adds up to the whole, because a mark that fell out of
 * the table is a corpus counted twice or not at all. The prohibition is `internal`: a refusal with no
 * error code is an exception this layer never throws, which is a bug in the emitter wearing a
 * refusal's clothes.
 */
export function assertRenderReport(report: RenderReport): void {
  const total = report.rendered + report.failed + report.refused + report.declined;
  if (total !== report.scored) {
    throw new Error(
      `render report: ${String(report.rendered)} rendered + ${String(report.failed)} failed + ` +
        `${String(report.refused)} refused + ${String(report.declined)} declined is not ` +
        `${String(report.scored)} scored, so a row fell out of the counters`,
    );
  }
  for (const mark of report.byMark) {
    const sum = mark.rendered + mark.failed + mark.refused + mark.declined;
    if (sum !== mark.rows) {
      throw new Error(`render report: mark ${mark.mark} counts ${String(sum)} outcomes for ${String(mark.rows)} rows`);
    }
  }
  if (report.refusalCodes.some((entry) => entry.code === 'internal')) {
    throw new Error('render report: a chart was refused by an exception this layer never throws, which is a defect in the emitter');
  }
  if (report.failed > 0 && report.failures.length === 0) {
    throw new Error(`render report: ${String(report.failed)} charts failed and not one message was kept`);
  }
}

export interface RenderOptions {
  /** Where the PNGs are written. Removed by the caller unless someone is going to look at them. */
  readonly outDir: string;
  /** The interpreter. `python3` by default; a variable so a workflow can point at a venv. */
  readonly python?: string;
  /** The worker script. Defaults to the one next to this file. */
  readonly worker?: string;
  /** A budget for the whole batch, in milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * Run every job through one worker process and collect its verdicts.
 *
 * One process for the whole batch, because importing matplotlib costs more than drawing one figure:
 * a process per chart would make the reading measure the interpreter's start-up time. The protocol is
 * line-oriented in both directions, so a job that writes to stdout cannot corrupt the stream — the
 * source never sees this process's handles, only the worker's.
 *
 * A worker that exits early is an error rather than a shorter report: the caller would otherwise
 * count the missing verdicts as nothing at all, which is the failure mode `summarize` refuses.
 */
export async function renderJobs(
  jobs: readonly ChartJob[],
  options: RenderOptions,
): Promise<readonly ChartVerdict[]> {
  if (jobs.length === 0) return [];
  const { spawn } = await import('node:child_process');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const worker = options.worker ?? fileURLToPath(new URL('./render_worker.py', import.meta.url));
  const python = options.python ?? process.env.TEXT2VIS_PYTHON ?? 'python3';
  const child = spawn(python, [worker], { stdio: ['pipe', 'pipe', 'pipe'] });
  const verdicts = new Map<string, ChartVerdict>();
  let pending = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split('\n');
    // `split` never returns an empty array, so the last element always exists and a `?? ''` here
    // would be a branch no chunk reaches.
    pending = lines.pop() as string;
    for (const line of lines) {
      if (line.trim() === '') continue;
      const verdict = JSON.parse(line) as ChartVerdict;
      verdicts.set(verdict.id, verdict);
    }
  });
  // A worker that dies early closes the pipe, and writing to a closed pipe is an EPIPE this process
  // would otherwise crash on before it could report the exit code that explains it.
  child.stdin.on('error', () => undefined);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const budget = options.timeoutMs ?? 900_000;
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, budget);
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  for (const job of jobs) {
    child.stdin.write(`${JSON.stringify({ id: job.id, png: join(options.outDir, `${job.id}.png`), code: job.code })}\n`);
  }
  child.stdin.end();
  const code = await exit;
  clearTimeout(timer);
  if (pending.trim() !== '') {
    const verdict = JSON.parse(pending) as ChartVerdict;
    verdicts.set(verdict.id, verdict);
  }
  if (code !== 0) {
    throw new Error(`render worker exited with ${String(code)}: ${stderr.split('\n').slice(-3).join(' ').trim()}`);
  }
  // The jobs are returned in the order they were handed over, so a report reads the same way twice.
  return jobs.map((job) => {
    const verdict = verdicts.get(job.id);
    if (verdict === undefined) {
      throw new Error(`render worker produced no verdict for row ${job.id} (stderr: ${stderr.slice(0, 200)})`);
    }
    return verdict;
  });
}

export interface RenderArgs {
  readonly artifact?: string;
  readonly outDir: string;
  readonly keep: boolean;
  readonly json: boolean;
}

export function parseRenderArgs(argv: readonly string[]): RenderArgs {
  let artifact: string | undefined;
  let outDir = 'eval/.cache/text2vis/png';
  let keep = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--keep') {
      keep = true;
      continue;
    }
    if (flag === '--artifact' || flag === '--out') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a path`);
      if (flag === '--artifact') artifact = value;
      else outDir = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${flag}: this command renders the product's charts, and takes --json, --keep, --artifact <path> and --out <dir>`);
  }
  return { outDir, keep, json, ...(artifact === undefined ? {} : { artifact }) };
}

/** The lines the log prints, one fact each. */
export function describeRender(report: RenderReport): readonly string[] {
  const share = (part: number): string => `${((part / report.scored) * 100).toFixed(2)}%`;
  const lines = [
    `text2vis: rendered ${String(report.rendered)}/${String(report.scored)} (${share(report.rendered)}) in ${report.latency.p50.toFixed(1)} ms p50 / ${report.latency.p95.toFixed(1)} ms p95`,
    `  refusals ${String(report.refused)} (${share(report.refused)}), declined ${String(report.declined)} (${share(report.declined)}), failed ${String(report.failed)}`,
    `  refusal codes: ${report.refusalCodes.map((entry) => `${entry.code} ${String(entry.n)}`).join(', ')}`,
    `  png p50 ${String(report.bytes.p50)} B, p95 ${String(report.bytes.p95)} B, total ${(report.bytes.total / 1_048_576).toFixed(1)} MiB`,
  ];
  for (const mark of report.byMark) {
    lines.push(
      `  ${mark.mark}: ${String(mark.rows)} rows, ${String(mark.rendered)} rendered, ` +
        `${String(mark.refused)} refused, ${String(mark.declined)} declined, ${String(mark.failed)} failed`,
    );
  }
  for (const failure of report.failures) {
    lines.push(`  FAILED row ${failure.id} (${failure.mark}): ${failure.error}`);
  }
  return lines;
}

/**
 * Render the whole corpus and publish one report.
 *
 * The PNG directory is removed unless `--keep` was passed: 1,470 figures are about fifty megabytes,
 * and a reading that keeps them by default turns every run into disk pressure for pictures nobody
 * opens. `--keep` exists for the one caller that does open them — the judge.
 */
export async function entryRender(
  argv1: string | undefined,
  moduleUrl: string,
  log: (line: string) => void,
  options: { readonly argv?: readonly string[]; readonly load?: LoadOptions; readonly python?: string; readonly worker?: string } = {},
): Promise<number | undefined> {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  try {
    const args = parseRenderArgs(options.argv ?? []);
    const { corpus, source, path } = await loadText2Vis(options.load);
    log(`text2vis: ${source} ${path}`);
    // The denominator is the rows the corpus labels with a chart family — the same set `profile.ts`
    // scores — because a row whose label names no chart has nothing for a figure to be right about.
    const inputs = profileInputs(corpus).filter((input) => familyOfLabel(input.label) !== undefined);
    const { jobs, refusals } = chartJobs(inputs);
    const { mkdir, rm } = await import('node:fs/promises');
    await mkdir(args.outDir, { recursive: true });
    // The two seams are passed through rather than spread conditionally: `renderJobs` defaults each
    // of them, and a spread's two branches would be two shapes of one call.
    const verdicts = await renderJobs(jobs, {
      outDir: args.outDir,
      python: options.python,
      worker: options.worker,
    });
    const report = summarize(inputs.length, { jobs, refusals }, verdicts);
    if (!args.keep) await rm(args.outDir, { recursive: true, force: true });
    if (args.json) {
      log(JSON.stringify(report, null, 2));
    } else {
      for (const line of describeRender(report)) log(line);
    }
    if (args.artifact !== undefined) {
      const { writeFile, rename } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(args.artifact), { recursive: true });
      await writeFile(`${args.artifact}.part`, `${JSON.stringify(report, null, 2)}\n`);
      await rename(`${args.artifact}.part`, args.artifact);
      log(`text2vis: wrote ${args.artifact}`);
    }
    return report.failed === 0 ? 0 : 1;
  } catch (error) {
    log(`text2vis: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

void entryRender(process.argv[1], import.meta.url, (line) => process.stdout.write(`${line}\n`), {
  argv: process.argv.slice(2),
}).then((code) => applyExitCode(code, process));
