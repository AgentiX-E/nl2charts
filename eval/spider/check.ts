/**
 * Can a Spider checkout be scored at all?
 *
 * Spider's exact match is not a string comparison: `process_sql.get_sql` resolves every column
 * against a `Schema` built from a live SQLite database, and the reference's `evaluate()` parses the
 * gold and the prediction through that same schema. So `dev.json` alone is not the corpus — the
 * twenty `.sqlite` files are, and the coverage table's claim that Spider needs "a fetcher, then a
 * clause decomposition" was the wrong shape of cost.
 *
 * This file is the gate that would receive the corpus. It answers three questions and refuses on any
 * of them:
 *
 *   1. every `db_id` in `dev.json` has a database on disk;
 *   2. every gold statement parses against that database — a gold that does not parse is a question
 *      no system can be credited for, and the reference scores it 0 in silence;
 *   3. a gold judged against itself reads 1, over the whole split, with a fresh parse on each side.
 *
 * The third is not ceremony: `Evaluator.eval_partial_match` mutates the label it is handed
 * (`eval_sel` calls `label_sel.remove(...)`), so a harness that parses the gold once and reuses it
 * reads 279 of 734 identical pairs as 0 — measured on the schema export described in
 * `docs/benchmarks.md`. Parsing both sides per comparison is what makes the number mean anything.
 *
 *   tsx eval/spider/check.ts --spider <dir>   # a checkout: dev.json + database/<db>/<db>.sqlite
 *   tsx eval/spider/check.ts --self-test      # the checks above, on a corpus the test builds
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isEntry } from '../entry.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const JUDGE = join(ROOT, 'eval/spider/judge.py');

/** How the judge is started. A parameter, because a test asserts the flags it gets. */
export interface JudgeOptions {
  readonly python: string;
  readonly script: string;
}

/** How this tool starts the judge, read at call time so a test can point it elsewhere. */
export function pythonOptions(): JudgeOptions {
  return { python: process.env.PYTHON ?? 'python3', script: JUDGE };
}

/** One line of `dev.json`, in the two fields a check reads. */
export interface DevQuestion {
  readonly db_id: string;
  readonly query: string;
  readonly question?: string;
}

/** What a corpus says about itself. */
export interface CorpusReading {
  readonly databases: number;
  readonly questions: number;
  /** Golds the judge could not parse. A non-zero count makes the split unusable, not "hard". */
  readonly goldErrors: number;
  /** Golds that read exact match against themselves. Must equal `questions`. */
  readonly agreement: number;
  readonly firstError: string | undefined;
}

export function parseDev(text: string): DevQuestion[] {
  const rows = JSON.parse(text) as unknown;
  if (!Array.isArray(rows)) throw new Error('dev.json is not an array');
  return rows.map((row, index) => {
    const entry = row as Partial<DevQuestion>;
    if (typeof entry.db_id !== 'string' || typeof entry.query !== 'string') {
      throw new Error(`dev.json entry ${String(index)} has no db_id/query`);
    }
    return { db_id: entry.db_id, query: entry.query, question: entry.question };
  });
}

/** The judge's answer for one pair. `error` is a broken request, which must not read as a 0. */
export interface Verdict {
  readonly em?: number;
  readonly gold?: string;
  readonly pred?: string;
  readonly error?: string;
  /**
   * Why the reference refused a prediction, in its own words.
   *
   * `pred: 'error'` is a count; this is the classification. `eval/spider/normalize.ts` maps the
   * vocabulary this field carries onto refusal classes, so a prompt rule or a repair is chosen from
   * what the parser said rather than from a reading of 1,034 statements.
   */
  readonly reason?: string;
}

export function judgeAll(
  pairs: readonly { readonly db: string; readonly pred: string; readonly gold: string }[],
  options: JudgeOptions = pythonOptions(),
): Verdict[] {
  if (pairs.length === 0) return [];
  const input = `${pairs.map((pair) => JSON.stringify(pair)).join('\n')}\n`;
  const run = spawnSync(options.python, [options.script], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.error !== undefined) {
    throw new Error(`could not start the judge: ${run.error.message}`);
  }
  if (run.status !== 0) {
    throw new Error(`the judge exited ${String(run.status)}: ${String(run.stderr).slice(0, 400)}`);
  }
  const lines = run.stdout.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length !== pairs.length) {
    throw new Error(`the judge answered ${String(lines.length)} of ${String(pairs.length)} pairs`);
  }
  return lines.map((line) => JSON.parse(line) as Verdict);
}

/**
 * Read the corpus, or say which part of it is missing.
 *
 * A missing database is named rather than counted: "19 of 20 databases" is a number a reader can
 * mistake for progress, and the split cannot be scored at 19/20.
 */
export async function validate(corpus: string, options: JudgeOptions = pythonOptions()): Promise<CorpusReading> {
  const questions = join(corpus, 'dev.json');
  if (!existsSync(questions)) {
    throw new Error(`no dev.json in ${corpus}: a Spider checkout has dev.json beside database/`);
  }
  const rows = parseDev(readFileSync(questions, 'utf8'));
  const databases = [...new Set(rows.map((row) => row.db_id))].sort();
  const paths = new Map<string, string>();
  for (const name of databases) {
    const path = join(corpus, 'database', name, `${name}.sqlite`);
    if (!existsSync(path)) throw new Error(`database ${name} is missing: expected ${path}`);
    paths.set(name, path);
  }
  const verdicts = judgeAll(
    rows.map((row) => ({ db: paths.get(row.db_id) as string, pred: row.query, gold: row.query })),
    options,
  );
  const goldErrors = verdicts.filter((verdict) => verdict.gold === 'error').length;
  const agreement = verdicts.filter((verdict) => verdict.em === 1).length;
  const broken = verdicts.findIndex((verdict) => verdict.gold === 'error');
  const first = broken === -1 ? undefined : rows[broken];
  return {
    databases: databases.length,
    questions: rows.length,
    goldErrors,
    agreement,
    firstError: first === undefined ? undefined : `${first.db_id}: ${first.query.slice(0, 120)}`,
  };
}

/** Everything the reading has to satisfy for a split to be scorable. */
export function problemsOf(reading: CorpusReading): string[] {
  const problems: string[] = [];
  if (reading.questions === 0) problems.push('the split has no questions');
  if (reading.goldErrors > 0) {
    problems.push(`${String(reading.goldErrors)} of ${String(reading.questions)} golds do not parse`
      + `${reading.firstError === undefined ? '' : `, first at ${reading.firstError}`}`);
  }
  if (reading.agreement !== reading.questions) {
    problems.push(`${String(reading.agreement)} of ${String(reading.questions)} golds read exact match against themselves`);
  }
  return problems;
}

export function reportLines(reading: CorpusReading): string[] {
  return [
    `spider corpus: ${String(reading.databases)} databases, ${String(reading.questions)} questions`,
    `spider corpus: gold  ${String(reading.questions - reading.goldErrors)} / ${String(reading.questions)} parsed`,
    `spider corpus: self  ${String(reading.agreement)} / ${String(reading.questions)} read exact match against themselves`,
  ];
}

/** One claim, and what it found. `undefined` means it held. */
export function mismatch(name: string, got: unknown, want: unknown): string | undefined {
  return JSON.stringify(got) === JSON.stringify(want)
    ? undefined
    : `${name}: got ${String(got)}, want ${String(want)}`;
}

/** The sentence a refusal gets, whether or not it was thrown as an `Error`. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the self-test prints, and the exit code it implies. A parameter, so a failure is testable. */
export function reportSelfTest(problems: readonly string[], log: (line: string) => void): number {
  for (const problem of problems) log(`spider self-test: ${problem}`);
  log(`spider self-test: ${problems.length === 0 ? 'ok' : 'FAILED'}`);
  return problems.length === 0 ? 0 : 1;
}

/** The claims, checked without a corpus: a six-line dev set and a database the test writes. */
export function selfTest(): string[] {
  const problems: string[] = [];
  const rows = parseDev('[{"db_id":"a","query":"SELECT 1"},{"db_id":"a","query":"SELECT 2","question":"q"}]');
  // A filter rather than a branch: the self-test's failure path is, by construction, the one path a
  // green run never takes, and a branch nothing takes is a branch the coverage ledger cannot defend.
  const check = (name: string, got: unknown, want: unknown): void => {
    problems.push(...[mismatch(name, got, want)].filter((problem): problem is string => problem !== undefined));
  };
  check('parseDev keeps two questions', rows.length, 2);
  check('parseDev keeps the question text', (rows[0] as DevQuestion).question, undefined);
  check('an entry without db_id is refused', catchOf(() => parseDev('[{"query":"SELECT 1"}]')), 'dev.json entry 0 has no db_id/query');
  check('a non-array is refused', catchOf(() => parseDev('{"dev":[]}')), 'dev.json is not an array');
  check('a clean reading has no problem', problemsOf({ databases: 1, questions: 2, goldErrors: 0, agreement: 2, firstError: undefined }), []);
  check('an unparsed gold is a problem that names it', problemsOf({ databases: 1, questions: 2, goldErrors: 1, agreement: 1, firstError: 'a: SELECT x' }), [
    '1 of 2 golds do not parse, first at a: SELECT x',
    '1 of 2 golds read exact match against themselves',
  ]);
  // One problem, not two: an empty split has no agreement to be short of, and reporting "0 of 0"
  // beside it would be the 0/0-is-perfection mistake this repository has already paid for once.
  check('an empty split is refused rather than read as 0%', problemsOf({ databases: 0, questions: 0, goldErrors: 0, agreement: 0, firstError: undefined }), [
    'the split has no questions',
  ]);
  check('an empty pair list starts no judge', judgeAll([]), []);
  // A refusal that is not an `Error` still has to read as a message rather than as `[object Object]`.
  const throwNumber = (): never => { throw 42; };
  check('a thrown non-Error is reported as itself', catchOf(throwNumber), '42');
  check('messageOf reads an Error by its message', messageOf(new Error('boom')), 'boom');
  check('a corpus with no first error names none', problemsOf({ databases: 1, questions: 2, goldErrors: 1, agreement: 1, firstError: undefined })[0], '1 of 2 golds do not parse');
  return problems;
}

function catchOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export interface Settings {
  readonly spider: string | undefined;
  readonly selfTest: boolean;
}

export function resolveSettings(argv: readonly string[]): Settings {
  let spider: string | undefined;
  let selfTest = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (flag === '--spider') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--spider needs a directory');
      spider = value;
      index += 1;
    } else if (flag === '--self-test') {
      selfTest = true;
    } else {
      throw new Error(`unexpected argument ${flag}`);
    }
  }
  return { spider, selfTest };
}

/**
 * The tool. Exit codes are part of its contract: 0 the corpus is scorable, 1 it is not, 2 it could
 * not be read at all — a distinction a workflow needs, because "not scorable" is a property of the
 * corpus and "could not be read" is a property of the invocation.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  options: JudgeOptions = pythonOptions(),
): Promise<number> {
  try {
    const settings = resolveSettings(argv);
    if (settings.selfTest) {
      return reportSelfTest(selfTest(), log);
    }
    if (settings.spider === undefined) {
      throw new Error('--spider <dir> is required: this check reads a corpus, and there is no default one');
    }
    const reading = await validate(settings.spider, options);
    for (const line of reportLines(reading)) log(line);
    const problems = problemsOf(reading);
    for (const problem of problems) log(`spider corpus: ${problem}`);
    return problems.length === 0 ? 0 : 1;
  } catch (error) {
    log(`spider: ${messageOf(error)}`);
    return 2;
  }
}

/** The workflow's way in, with the same guard as the other instruments. */
export async function entryCheck(
  argv1: string | undefined,
  moduleUrl: string,
  log: (line: string) => void,
  argv: readonly string[] = [],
): Promise<number | undefined> {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  return main(argv, log);
}

/**
 * What a tool does with the code it computed: nothing when it was only imported, and the process's
 * exit code when it ran. A function, because the alternative is a branch inside a `.then` that no
 * test can enter — the shape `eval/entry.ts` documents.
 */
export function entryTail(code: number | undefined, set: (value: number) => void = (value) => { process.exitCode = value; }): void {
  if (code !== undefined) set(code);
}

void entryCheck(process.argv[1], import.meta.url, (line) => process.stdout.write(`${line}\n`),
  process.argv.slice(2)).then((code) => entryTail(code));
