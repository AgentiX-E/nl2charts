/**
 * The BIRD runner, driven end to end on a dataset it has never seen.
 *
 * The runner used to be one 1,100-line `main()` that read `process.env` at import time,
 * exited through `process.exitCode`, and could only be observed by spending a model run
 * on the real benchmark. That made every guard in it — schema fidelity, the gold controls,
 * the failure-share refusal, the gate — a claim with no test behind it: the artifact from
 * `40718786687` was the only evidence the code path had executed at all.
 *
 * So this file builds a BIRD-shaped dataset in a temporary directory (questions, tables,
 * description CSV, a real SQLite file), points the runner at a real HTTP endpoint that
 * speaks the OpenAI chat shape, and asserts what came out. The oracle is the real Python
 * process. Nothing here is a mock: the harness is exercised through the same three
 * interfaces it has in production — a data directory, an endpoint, and a database.
 *
 * Small on purpose. Every dataset-level guard in the runner is gated on a sample size
 * (`assertRepairPathFired` and its two siblings return early below 100 cases), so six
 * questions licence the shape of the run without licensing a claim about a rate — which
 * is exactly the rule those guards exist to enforce.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CHAIN_QUESTIONS, MINI_DB, MINI_GOLD, MINI_QUESTIONS, writeChainBirdDataset, writeMiniBirdDataset } from './helpers/bird-dataset.js';
import { startEndpoint } from './helpers/endpoint.js';
import type { EndpointRequest } from './helpers/endpoint.js';
import { assertSamplesRan, assertSecondModel, judgeModelName, main, resolveSettings } from '../eval/bird/run.js';
import { INTENT_RULE } from '../eval/bird/intent.js';

const root = mkdtempSync(join(tmpdir(), 'nl2charts-bird-run-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Where `BIRD_DATA` points: the directory BIRD ships under `MINIDEV/`. */
const data = join(root, 'MINIDEV');

/** The fixture's questions, under the names this file has always used. */
const QUESTIONS = MINI_QUESTIONS;
/** The statement a well-behaved model writes for each question. */
const GOLD = MINI_GOLD;

writeMiniBirdDataset(data);

/** What the model answers when the prompt asks for the semantics of a schema. */
const DEFINITIONS = [
  '- items.price: the list price of one unit, in yuan',
  '- items.name: the label the store sells the item under',
  '- orders.qty: how many units the order contains',
].join('\n');

function fenced(sql: string): string {
  return '```sql\n' + sql + '\n```';
}

/**
 * How one scenario answers.
 *
 * `first` is the answer to a question asked for the first time; a turn that names what
 * went wrong always gets the gold statement, because that is what a repaired model would
 * write and it keeps the repair funnel legible. `fail` decides a status, which is how the
 * endpoint goes down for exactly one kind of request.
 */
interface Plan {
  readonly first?: (question: string) => string | undefined;
  readonly fail?: (request: EndpointRequest) => number | undefined;
  readonly delayMs?: (request: EndpointRequest) => number | undefined;
  /** Prefix `STEP n:` lines, the shape the decompose prompt asks for. */
  readonly steps?: boolean;
  /** Questions whose second attempt keeps the first answer, for a repair that never lands. */
  readonly stubborn?: readonly string[];
  /**
   * A statement returned whenever the prompt offers the question's literal values.
   *
   * That block belongs to one source of a mixed set, which is how one candidate can be made
   * wrong while its two siblings stay right — the only way to see whether the runner records
   * the truth *per candidate* or just copies the set-wide recall.
   */
  readonly whenValues?: string;
  readonly definitions?: string;
  /**
   * The answer to a column-choice prompt, keyed on the question it asks about.
   *
   * Absent means an empty reply, which is the arm's own fallback case: nothing resolved, so the
   * whole card is sent and the artifact says `decided: false`.
   */
  readonly columns?: (question: string) => string;
  /**
   * The statement a reconcile arm writes after reading the result groups.
   *
   * Absent means the gold statement, which restates a candidate on every case where the model was
   * right — the null case of the lever, and the one the funnel has to report as `novel: 0`.
   */
  readonly reconcile?: (question: string) => string;
  /**
   * The statement the decomposition prompt is answered with.
   *
   * Absent means the gold statement, which is the lever's null case: the fourth opinion arrives,
   * is correct, and agrees with the pool it was bought for. Answering *differently* is what makes
   * `distinct` observable, and answering correctly where the pool was wrong is the only way the
   * ceiling can be seen rising.
   */
  readonly decompose?: (question: string) => string;
  /**
   * Which candidate slot the selector returns, keyed on the question.
   *
   * `1` is what every other scenario uses. A dissent arm can hold a fourth candidate, so a slot
   * number above three is what says whether the bought opinion was ever adopted — a reading the
   * funnel would otherwise report as a permanent zero with nothing behind it.
   */
  readonly selectIndex?: (question: string) => number;
  /**
   * Which of the two statements the pairwise turn picks, keyed on the question.
   *
   * `1` keeps the pool's answer and `2` takes the challenger. A verifying arm asks this question
   * only on the cases where the bought opinion disagrees, so the number says whether the turn
   * changed the answer — the reading its funnel reports as `choseDissent`.
   */
  readonly pairPick?: (question: string) => number;
  /**
   * The answer to the audit turn: what the statement left out, then a statement.
   *
   * Absent means the model reports nothing missing and repeats the gold statement, which is
   * the mechanism's null case — it spent the call and changed nothing.
   */
  readonly audit?: (question: string) => string;
  /**
   * The statements to answer with, when the scenario points the runner at another fixture.
   *
   * The default map is built from `MINI_QUESTIONS`, and a scenario that writes the chain dataset
   * asks questions it does not hold. Without this the endpoint says "no gold statement planned",
   * which is the file being honest about a fixture it was not told about — so the fixture is
   * announced instead of the map being widened for every scenario.
   */
  readonly gold?: Readonly<Record<string, string>>;
  /**
   * The reply a prompt that asks for a query object gets, keyed on the question.
   *
   * Separate from `first` because the intent source is asked with the same question text as the
   * three prompts beside it and answered in a different vocabulary: one entry for both would make
   * the pair indistinguishable, and the reading is precisely that the vocabulary — not the question
   * and not the card — is what changed.
   */
  readonly intent?: (question: string) => string;
}

/**
 * The endpoint's answer, keyed on what the prompt is asking for.
 *
 * Every branch here is a different request shape the runner can send: a statement, a
 * selection, a repair turn, an empty-result turn, a semantics request. Keying on the
 * prompt is what makes one endpoint serve all of them.
 */
function replyFor(request: EndpointRequest, plan: Plan): { status?: number; content: string; delayMs?: number } {
  const delayMs = plan.delayMs?.(request);
  const status = plan.fail?.(request);
  if (status !== undefined) return { status, content: '{"error":"unavailable"}', ...(delayMs === undefined ? {} : { delayMs }) };
  const prompt = request.prompt;
  // The golds this scenario answers with. A scenario that points the runner at another fixture
  // brings its own statements; every other scenario reads the module-level map, so this is the
  // same lookup it always was.
  const golds: Readonly<Record<string, string>> = plan.gold ?? GOLD;
  const send = (content: string): { content: string; delayMs?: number } =>
    delayMs === undefined ? { content } : { content, delayMs };
  // The selector. Its reply is a bare number by contract (`parseSelection`), so a SQL
  // block here would be counted as "the selector did not answer".
  if (prompt.includes('which candidate statement answers the question')) {
    const asked = Object.keys(golds).find((entry) => prompt.includes(entry)) ?? '';
    return send(String(plan.selectIndex?.(asked) ?? 1));
  }
  // The pairwise selector asks a different question over two candidates and reads a
  // different answer, so the same `1` would be counted as an unreadable reply.
  if (prompt.includes('Two statements were written for the same question')) {
    const asked = Object.keys(golds).find((entry) => prompt.includes(entry)) ?? '';
    return send(String(plan.pairPick?.(asked) ?? 1));
  }
  // The reconcile turn. Read before the statement branches below, because its prompt carries the
  // question verbatim and would otherwise be answered as a first attempt.
  if (prompt.includes('Write the statement that answers the question')) {
    const asked = Object.keys(golds).find((entry) => prompt.includes(entry)) ?? '';
    return send(fenced(plan.reconcile?.(asked) ?? golds[asked] ?? 'select 1'));
  }
  // The column choice. Read before the question lookup below, because its prompt carries the
  // question verbatim and would otherwise be answered with a statement.
  if (prompt.includes('You choose the columns a SQL query will need')) {
    const asked = Object.keys(golds).find((entry) => prompt.includes(entry));
    return send(plan.columns?.(asked ?? '') ?? '');
  }
  // The audit turn. Read before the statement branches because its prompt carries the
  // question verbatim and would otherwise be answered as a first attempt.
  if (prompt.includes('Check it against the question before rewriting')) {
    const audited = Object.keys(golds).find((entry) => prompt.includes(entry)) ?? '';
    // Without a plan the audit reports nothing missing and repeats the statement it was
    // handed, which the prompt quotes verbatim: the turn costs its call and changes nothing,
    // and that is the null case the control case has to be measurable against.
    const given = /The statement being checked: ([\s\S]*)$/.exec(prompt)?.[1]?.trim() ?? 'select 1';
    return send(plan.audit?.(audited) ?? `MISSING: none\n${fenced(given)}`);
  }
  // The intent source. Its prompt carries the question verbatim like every other generation
  // prompt, so it is read before the question lookup below; the marker is the rule itself, which is
  // the only text in the harness that asks for an object instead of a statement.
  if (prompt.includes('Instead of a statement, reply with one JSON object')) {
    const asked = Object.keys(golds).find((entry) => prompt.includes(entry)) ?? '';
    return send(plan.intent?.(asked) ?? '{"from":"items","select":[{"expr":"count(*)"}]}');
  }
  const question = Object.keys(golds).find((entry) => prompt.includes(entry));
  if (question === undefined) return send(plan.definitions ?? DEFINITIONS);
  // A turn that names what went wrong: the empty-result diagnosis, the blind control, the
  // engine's own message, or the shape guard's. All of them are second attempts.
  const second =
    prompt.includes('returned no rows') ||
    prompt.includes('Write the statement for this question again') ||
    prompt.includes('no such table') ||
    prompt.includes('but the statement returned');
  if (plan.whenValues !== undefined && prompt.includes('Values in this database named by the question:')) {
    return send(fenced(plan.whenValues));
  }
  const gold = golds[question];
  // `GOLD` is built from `QUESTIONS`, so a question without an entry is a defect in this
  // file and not a case to handle: failing here keeps the fixture honest.
  if (gold === undefined) throw new Error(`no gold statement planned for ${question}`);
  if (second) {
    const stubborn = plan.stubborn?.includes(question) === true;
    return send(fenced(stubborn ? (plan.first?.(question) ?? gold) : gold));
  }
  // The decomposition prompt asks the same question by a different method, so its answer is a
  // separate plan entry rather than a separate branch: it still goes through the STEP prefix and
  // the guard bookkeeping below, which is where the two decomposition readings come from. A
  // scenario without the entry answers as it always did, which is the lever's null case — the
  // fourth opinion arrives and agrees with the pool it was bought for.
  const answer = (plan.decompose !== undefined && prompt.includes('Work in two parts.')
    ? plan.decompose(question)
    : undefined) ?? plan.first?.(question) ?? gold;
  const body = plan.steps === true ? `STEP 1: ${answer}\nSTEP 2: select 1\n\n` + fenced(answer) : fenced(answer);
  return send(body);
}

interface Scenario {
  readonly plan: Plan;
  readonly env: Record<string, string | undefined>;
  readonly argv?: readonly string[];
  readonly out?: string;
}

interface ScenarioResult {
  readonly code: number;
  readonly report: Record<string, unknown>;
  readonly requests: readonly EndpointRequest[];
  readonly printed: readonly string[];
}

/** Run the CLI exactly as the workflow does, and hand back what it wrote and said. */
async function run(options: Scenario): Promise<ScenarioResult> {
  const endpoint = await startEndpoint({ reply: (request) => replyFor(request, options.plan) });
  const out = options.out ?? join(root, `out-${String(Math.random()).slice(2, 8)}.json`);
  const env = {
    BIRD_DATA: data,
    BIRD_DBS: 'shop',
    BIRD_OUT: out,
    LLM_BASE_URL: endpoint.url,
    LLM_API_KEY: 'test-key',
    LLM_MODEL: 'stub-model',
    ...options.env,
  };
  const printed: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  try {
    const code = await main(env, options.argv ?? [], root);
    const report = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    return { code, report, requests: endpoint.requests, printed };
  } finally {
    log.mockRestore();
    error.mockRestore();
    await endpoint.close();
  }
}

/** Every question answered correctly. */
const correct = (question: string): string | undefined => GOLD[question];
/** Every question answered with a statement that runs and is wrong. */
const wrong = (): string => 'select 1';
/** Every question answered with a statement that returns no rows at all. */
const empty = (): string => 'select * from items where id > 100';
/** Every question answered with a statement the engine refuses once. */
const broken = (): string => 'select count(*) from itemz';
/**
 * A statement that runs, returns rows, and answers no question in the fixture.
 *
 * `select 1` would be right on any question whose gold counts a single row, which makes it useless
 * as the "one wrong candidate" a mixed set is built around. `-1` is not a count, a sum, or a name.
 */
const IMPOSSIBLE = 'select -1 as impossible';

describe('a dry run', () => {
  it('previews the arms it was asked for and calls no model', async () => {
    const result = await run({
      plan: { first: correct },
      argv: ['--dry-run'],
      env: { BIRD_ARMS: 'names,inline+evidence' },
    });
    expect(result.code).toBe(0);
    // No arm ran and no semantics were generated: a dry run is a prompt preview, and a
    // model call here would make "dry" mean "cheap" rather than "no model".
    expect(result.requests).toHaveLength(0);
    expect(result.report.arms).toEqual([]);
    expect(result.report.model).toBeNull();
    expect(result.report.split).toBe('minidev');
    const prompts = result.report.prompts as { id: number; arms: { arm: string; chars: number; prompt: string }[] }[];
    expect(prompts).toHaveLength(3);
    // The arms in the preview are the ones the run was told to score. The old code
    // rendered the head of the chain whatever `BIRD_ARMS` said, so a dry run of a new
    // lever put two unrelated prompts in the artifact.
    expect(prompts[0]?.arms.map((entry) => entry.arm)).toEqual(['names', 'inline+evidence']);
    expect(prompts[0]?.arms[0]?.prompt).toContain(QUESTIONS[0]?.question ?? '');
    expect(prompts[0]?.arms[0]?.chars).toBeGreaterThan(0);
    const controls = result.report.controls as { schemaChecked: number; schemaMissingTotal: number };
    // Schema fidelity is checked against the database, not against the table file.
    expect(controls.schemaChecked).toBe(6);
    expect(controls.schemaMissingTotal).toBe(0);
    expect(
      result.printed.some((line) => line.startsWith(`dry run: gold runnable ${QUESTIONS.length}/${QUESTIONS.length}`)),
    ).toBe(true);
  });
});

/**
 * Mini-Dev's own shape, at three rows: a file that carries more rows than questions.
 *
 * The benchmark file holds 500 rows for 498 ids (137 and 138 appear twice, byte for byte), and
 * the runner's sample size used to be the *row* count. Once `available` became a question count,
 * every default run declared `requested: 500` against `available: 498`, and the floor gate — whose
 * job is to notice a shrunken sample — failed the build on a sample that had not shrunk
 * (run 41169457147). Three rows and two questions put that arithmetic in a test.
 */
describe('a split whose file repeats a question', () => {
  const dir = join(root, 'REPEAT');
  writeMiniBirdDataset(dir);
  const [only, repeated] = MINI_QUESTIONS;
  if (only === undefined || repeated === undefined) throw new Error('the fixture needs two questions to repeat one');

  beforeAll(() => {
    // The same record twice, which is what a byte-for-byte repeat is: a file that names one
    // question twice with *different* content is refused by `distinctQuestions` instead.
    const record = (entry: typeof only): Record<string, unknown> => ({
      question_id: entry.id,
      db_id: MINI_DB,
      question: entry.question,
      evidence: '',
      SQL: entry.sql,
      difficulty: entry.difficulty,
    });
    writeFileSync(join(dir, 'mini_dev_sqlite.json'), JSON.stringify([record(only), record(repeated), record(repeated)]));
  });

  it('asks for as many questions as the file holds, not as many rows as it carries', async () => {
    // One arm: the chain's default includes a retrieval arm, and a dry run of an input the
    // fixture does not have would fail for a reason that has nothing to do with the sample size.
    const result = await run({ plan: {}, argv: ['--dry-run'], env: { BIRD_DATA: dir, BIRD_ARMS: 'names' } });
    expect(result.code).toBe(0);
    const selection = result.report.selection as {
      rows: number;
      available: number;
      requested: number;
      sampled: boolean;
      repeats: number[];
      scored: number;
    };
    expect(selection.rows).toBe(3);
    expect(selection.available).toBe(2);
    // The declaration equals the pool: nothing was asked for, and the split decides.
    expect(selection.requested).toBe(2);
    expect(selection.sampled).toBe(false);
    expect(selection.repeats).toEqual([repeated.id]);
  });

  it('refuses a declared sample larger than the split instead of publishing it', async () => {
    // 500 on this split is the shape of the defect itself: a number copied from somewhere other
    // than the file, carried into the artifact as a claim about a pool that does not exist.
    await expect(
      run({ plan: {}, argv: ['--dry-run'], env: { BIRD_DATA: dir, BIRD_ARMS: 'names', BIRD_LIMIT: '500' } }),
    ).rejects.toThrow(
      /more questions than this split holds \(2\)/,
    );
  });
});

describe('a full run', () => {
  it('scores each arm, pairs them, and passes its own gate', async () => {
    const result = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'names,metadata' } });
    expect(result.code).toBe(0);
    const arms = result.report.arms as { arm: string; passed: number; total: number; accuracy: number; calls: { mean: number }; format?: { replies: number; fenced: string } }[];
    expect(arms.map((entry) => entry.arm)).toEqual(['names', 'metadata']);
    // Every gold statement is answerable from the schema, so a correct model scores all of them.
    for (const arm of arms) {
      expect(arm.passed).toBe(QUESTIONS.length);
      expect(arm.total).toBe(QUESTIONS.length);
      expect(arm.accuracy).toBe(1);
      expect(arm.calls.mean).toBe(1);
    }
    // The shape every reply had, aggregated per arm. The fixture answers in a fenced block, so
    // the dimension that a different backbone would move first is reported as held — and the
    // row is refused by `assertReportComplete` if it is not carried at all.
    for (const arm of arms) {
      expect(arm.format).toEqual({ replies: QUESTIONS.length, fenced: 'always', index: 'never', steps: 'never', named: 'never' });
    }
    // One lever apart, so the pair is an ablation and not a comparison of levels.
    const ablations = result.report.ablations as Record<string, { delta: number; cost: { extraCallsPerCase: number } }>;
    expect(Object.keys(ablations)).toEqual(['names -> metadata']);
    expect(ablations['names -> metadata']?.delta).toBe(0);
    // Metadata costs no call, so the pair has no price per call to report — the field is
    // absent rather than infinite.
    expect(ablations['names -> metadata']?.cost).toEqual({ extraCallsPerCase: 0 });
    const gold = result.report.gold as { executed: number; runnable: number; runnableRate: number };
    expect(gold).toMatchObject({ executed: QUESTIONS.length, runnable: QUESTIONS.length, runnableRate: 1 });
    const controls = result.report.controls as {
      selfConsistency: number;
      negativeFalseMatches: number;
      tablesInPrompts: number;
      tablesTotal: number;
      emptyGoldExcluded: number;
    };
    // Both controls, on a dataset where they can fail: the gold ran twice and agreed with
    // itself, and no gold matched an empty result.
    expect(controls.selfConsistency).toBe(1);
    expect(controls.negativeFalseMatches).toBe(0);
    expect(controls.emptyGoldExcluded).toBe(0);
    expect(controls.tablesInPrompts).toBe(controls.tablesTotal);
    // Per-case rows, because a per-arm total cannot be stratified.
    const cases = result.report.cases as { arm: string; id: string; passed: boolean }[];
    expect(cases).toHaveLength(QUESTIONS.length * 2);
    expect(cases.filter((row) => row.arm === 'names')).toHaveLength(QUESTIONS.length);
    const failures = result.report.failures as Record<string, unknown[]>;
    expect(failures.names).toEqual([]);
    expect(result.printed.some((line) => line.startsWith('gates: gold runnable'))).toBe(true);
    // `metadata+evidence` carries the dataset's evidence and notes; `names` carries neither.
    expect(result.report.armsRequested).toEqual(['names', 'metadata']);
  });

  it('records what the endpoint billed beside what it charged in calls', async () => {
    // The two units a cost claim can be made in, both measured: `calls` is what the harness asked
    // for and `tokens` is what came back. A report with one and not the other is a report whose
    // cost cannot be checked against a provider's invoice.
    const result = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'inline+evidence' } });
    const [row] = result.report.arms as { arm: string; calls: { mean: number }; tokens: { prompt: number; completion: number; chars: number; unbilled: number } }[];
    // The stub endpoint prices every answer at seven prompt tokens and three completion tokens,
    // one call per case: a mean that differs from that is a meter reading the wrong request.
    expect(row?.tokens).toMatchObject({ prompt: 7, completion: 3, unbilled: 0 });
    // One call per case, so the characters are the length of the prompts the stub saw.
    expect(row?.tokens.chars).toBeGreaterThan(0);
    const cases = result.report.cases as {
      arm: string;
      tokens?: { prompt: number; completion: number; chars: number; unbilled: number };
    }[];
    expect(cases.every((entry) => entry.tokens?.prompt === 7 && entry.tokens.completion === 3 && entry.tokens.unbilled === 0)).toBe(true);
    // The characters are counted from the same requests: four calls, so a case's character count
    // is four times the length of a prompt the stub saw, never zero.
    expect(cases.every((entry) => (entry.tokens?.chars ?? 0) > 0)).toBe(true);
  });

  it('sends the join closure on the prune arm, and says what it billed', async () => {
    // The one arm whose card is decided per question. It runs here for the reason the whole
    // benchmark exists: a lever that is never executed is a lever nobody has measured, and this
    // one changes the prompt on every case it touches.
    const result = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'select-prune' } });
    const [row] = result.report.arms as {
      arm: string;
      passed: number;
      total: number;
      calls: { mean: number };
      promptChars: { mean: number };
      tokens: { prompt: number; completion: number; chars: number; unbilled: number };
    }[];
    expect(row?.arm).toBe('select-prune');
    expect(row?.passed).toBe(QUESTIONS.length);
    // Three samples and a selector, the same budget as its parent.
    expect(row?.calls.mean).toBe(4);
    // Four calls at seven prompt tokens each: the meter is reading the whole case, not the last
    // call, which is the mistake a per-call total would make invisible.
    expect(row?.tokens).toMatchObject({ prompt: 28, completion: 12, unbilled: 0 });
    expect(row?.tokens.chars).toBeGreaterThan(0);
    expect(row?.promptChars.mean).toBeGreaterThan(0);
  });

  it('records an A/A duplicate as the harness\'s own noise and keeps both rows', async () => {
    const result = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'names', BIRD_AA: 'names' } });
    expect(result.code).toBe(0);
    const arms = result.report.arms as { arm: string }[];
    // Keyed by the requested name: keying by the resolved arm let the duplicate overwrite
    // the original, and the pair then compared an arm with itself.
    expect(arms.map((entry) => entry.arm)).toEqual(['names', 'names#2']);
    const aa = result.report.aa as { arm: string; delta: number; onlyFirst: number; onlySecond: number; p: number };
    expect(aa).toMatchObject({ arm: 'names', delta: 0, onlyFirst: 0, onlySecond: 0, p: 1 });
    expect(result.printed.some((line) => line.startsWith('A/A names:'))).toBe(true);
    // A zero delta is not a zero-noise floor: the line has to say what difference the same
    // cases could have detected, or the reader takes "0.0pp" as the resolution.
    expect(result.printed.some((line) => line.startsWith('A/A names:') && /resolves \d/.test(line))).toBe(true);
  });

  it('refuses to publish a run whose arms see no signal', async () => {
    const result = await run({ plan: { first: () => wrong() }, env: { BIRD_ARMS: 'names' } });
    // The gate is a threshold, not a report: a run that trips one must fail CI, and the
    // exit code is what CI reads.
    expect(result.code).toBe(1);
    expect(result.printed.some((line) => line.includes('GATE FAILED: best arm accuracy 0.0%'))).toBe(true);
    const arms = result.report.arms as { passed: number; errors: { execution: number; values: number } }[];
    expect(arms[0]?.passed).toBe(0);
    // `select 1` runs and returns a row, so this is a wrong answer and not a failure.
    expect(arms[0]?.errors.execution).toBe(0);
  });
});

describe('a sampling arm', () => {
  it('records which candidate held the answer, one verdict per candidate', async () => {
    // One source of the mixed set (the one that carries the question's literal values) is
    // made to answer wrongly while its two siblings answer correctly. That is the only shape
    // in which the record can be seen to be per candidate rather than a set-wide recall
    // copied three times, and it is the shape the cross-vendor run needed: 75 losses whose
    // address the artifact could not name.
    const result = await run({
      plan: { whenValues: IMPOSSIBLE },
      env: { BIRD_ARMS: 'select-mixed' },
    });
    const cases = result.report.cases as {
      id: string;
      passed: boolean;
      candidateRecall?: boolean;
      winnerSource?: string;
      candidates?: { source: string; correct: boolean }[];
    }[];
    const recorded = cases.filter((row) => row.candidates !== undefined);
    expect(recorded).toHaveLength(QUESTIONS.length);
    for (const row of recorded) {
      expect(row.candidates?.map((verdict) => verdict.source)).toEqual(['inline+evidence', 'metadata+evidence', 'values']);
      // The ceiling and the record are the same population: a case whose recall is true must
      // name a correct candidate, and one whose recall is false must name none.
      expect(row.candidates?.some((verdict) => verdict.correct)).toBe(row.candidateRecall);
    }
    // The pen question names a stored literal, so its `values` candidate carried the wrong
    // statement while the other two answered it.
    const pen = recorded.find((row) => row.id === '7');
    expect(pen?.candidates?.map((verdict) => verdict.correct)).toEqual([true, true, false]);
    expect(pen?.candidateRecall).toBe(true);
    expect(pen?.passed).toBe(true);
    expect(pen?.winnerSource).toBe('inline+evidence');
  });

  it('counts a candidate the guard refused instead of letting the set shrink quietly', async () => {
    // A candidate that never arrives is not a candidate that was wrong: the set is smaller,
    // the case still answers, and the ceiling falls for a reason that is not in the arm. The
    // guard rejects a write, so this is the `engine` side of `candidateFailures` — the side a
    // real endpoint outage never exercises, and the side that used to share a cell with
    // "the reply carried no statement".
    const result = await run({
      plan: { whenValues: 'delete from items' },
      env: { BIRD_ARMS: 'select-mixed' },
    });
    const arms = result.report.arms as {
      candidateFailures?: { llm: number; engine: number; unparsed: number };
      candidateSurvival?: Record<string, { generated: number; survived: number }>;
    }[];
    // The oracle opens every database read-only, so the write is refused by the engine and
    // counted as `engine`: the split that tells "the endpoint refused" from "the engine did".
    expect(arms[0]?.candidateFailures).toMatchObject({ llm: 0, engine: 1, unparsed: 0 });
    // ...and the arm says which source it came from, which a merged count cannot: a cross arm
    // that loses the second model on every question is a different finding from one that loses
    // its own prompt.
    expect(arms[0]?.candidateSurvival?.values).toEqual({ generated: QUESTIONS.length, survived: QUESTIONS.length - 1 });
    const cases = result.report.cases as {
      id: string;
      passed: boolean;
      candidates?: { source: string; correct: boolean }[];
    }[];
    const pen = cases.find((row) => row.id === '7');
    // The record is the set that survived: two sources, both of them correct, so the case is
    // decided by the candidates that arrived rather than by the one that did not.
    expect((pen?.candidates ?? []).map(({ source, correct }) => ({ source, correct }))).toEqual([
      { source: 'inline+evidence', correct: true },
      { source: 'metadata+evidence', correct: true },
    ]);
    expect(pen?.passed).toBe(true);
    // Every other question kept its three candidates.
    expect(cases.filter((row) => row.candidates?.length === 2)).toHaveLength(1);
  });

  it('writes no candidate record for an arm that generates once', async () => {
    const result = await run({ plan: {}, env: { BIRD_ARMS: 'names' } });
    const cases = result.report.cases as { candidates?: unknown }[];
    // One candidate is not a set: `passed` already says what happened, and a record of one
    // would invite a reader to compute a loss that cannot exist.
    expect(cases.every((row) => row.candidates === undefined)).toBe(true);
  });

  it('spends the empty-result turn on the model that wrote the statement, not on the primary', async () => {
    // The defect this covers was silent: on a cross arm the turn was always sent to the primary
    // provider, so the reasoning model's empty result was rewritten by the chat model. Nothing
    // failed and the arm's score moved, which is worse than an error. The reply below writes an
    // empty statement on the second endpoint and the correct one on the retry, so `recovered`
    // can only reach every case if the retry reached *that* endpoint.
    const second = await startEndpoint({
      reply: (request) => {
        if (request.prompt.includes('which candidate statement answers the question')) return '1';
        if (request.prompt.includes('ran without error and returned no rows')) {
          const asked = Object.keys(GOLD).find((entry) => request.prompt.includes(entry)) ?? '';
          return fenced(correct(asked) ?? empty());
        }
        return fenced(empty());
      },
    });
    try {
      const result = await run({
        plan: { first: () => empty() },
        env: {
          BIRD_ARMS: 'select-cross-empty',
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
        },
      });
      expect(result.code).toBe(0);
      const retriedOnSecond = second.requests.filter((request) => request.prompt.includes('ran without error and returned no rows'));
      expect(retriedOnSecond.length).toBe(QUESTIONS.length);
      const retriedOnPrimary = result.requests.filter((request) => request.prompt.includes('ran without error and returned no rows'));
      expect(retriedOnPrimary).toHaveLength(0);
      const arms = result.report.arms as { arm: string; emptyRetry: { fired: number; recovered: number } }[];
      expect(arms[0]?.arm).toBe('select-cross-empty');
      expect(arms[0]?.emptyRetry.fired).toBe(QUESTIONS.length);
      expect(arms[0]?.emptyRetry.recovered).toBe(QUESTIONS.length);
    } finally {
      await second.close();
    }
  });

  it('spends the turn on an arm that generates once, where there is no source to inherit', async () => {
    // The author of the statement is the arm itself on a single-candidate arm: there is no
    // second source to parse and no hint override to look up. The branch is one line, and the
    // version of this fix that only worked on mixed arms would have passed every other test.
    const result = await run({
      plan: { first: () => empty() },
      env: { BIRD_ARMS: 'inline+evidence,inline+evidence+empty' },
    });
    expect(result.code, result.printed.join('\n')).toBe(0);
    const arms = result.report.arms as { arm: string; emptyRetry?: { mode: string; fired: number; recovered: number } }[];
    const retried = arms.find((arm) => arm.arm === 'inline+evidence+empty');
    expect(retried?.emptyRetry?.mode).toBe('diagnosed');
    expect(retried?.emptyRetry?.fired).toBe(QUESTIONS.length);
    expect(retried?.emptyRetry?.recovered).toBe(QUESTIONS.length);
  });

  it('spends one turn on a candidate set that came back empty, and adopts the answer', async () => {
    const result = await run({ plan: { first: () => empty() }, env: { BIRD_ARMS: 'select-mixed+empty' } });
    expect(result.code).toBe(0);
    const arms = result.report.arms as {
      arm: string;
      passed: number;
      vote: number;
      selector: string;
      selectorDecided: number;
      selectorTotal: number;
      candidateRecall: number;
      emptyRetry: { mode: string; dropped: number; fired: number; recovered: number };
    }[];
    const arm = arms[0];
    expect(arm?.arm).toBe('select-mixed+empty');
    // Three candidates, all empty, so the drop had nothing to drop and the turn fired on
    // every case — the state where a zero-row statement is the only signal left.
    expect(arm?.emptyRetry.mode).toBe('diagnosed');
    expect(arm?.emptyRetry.dropped).toBe(0);
    expect(arm?.emptyRetry.fired).toBe(QUESTIONS.length);
    // The replacement returned rows, so it was adopted: without this the arm paid a call
    // per case and kept the statement it knew was wrong.
    expect(arm?.emptyRetry.recovered).toBe(QUESTIONS.length);
    expect(arm?.passed).toBe(QUESTIONS.length);
    expect(arm?.selector).toBe('model');
    // The selector answered with an index every time, which is a fact about the prompt and
    // not about the model's judgement.
    expect(arm?.selectorDecided).toBe(QUESTIONS.length);
    expect(arm?.selectorTotal).toBe(QUESTIONS.length);
    expect(arm?.candidateRecall).toBe(0);
    const cases = result.report.cases as { candidateRecall?: boolean }[];
    expect(cases.every((row) => row.candidateRecall === false)).toBe(true);
    const mixed = result.report.mixedCandidatePrompts as { arm: string; withAllDistinct: number; questions: number }[];
    // The three sources are distinct prompts on at least some questions, which is the
    // claim a mixed arm makes; how many is reported rather than assumed.
    expect(mixed[0]?.arm).toBe('select-mixed+empty');
    expect(mixed[0]?.questions).toBe(QUESTIONS.length);
    // At least the one question that names a stored literal, which is the whole reason the
    // trio is allowed to call itself three prompts.
    expect(mixed[0]?.withAllDistinct).toBeGreaterThan(0);
  });
});

describe('the blind control for the empty-result turn', () => {
  /**
   * The arm this repository has never run.
   *
   * `select-mixed+empty-blind` was declared, filed on demand and named in three documents, and
   * no test had ever executed it: the catalogue entry was the only evidence it existed. It is
   * the control that separates the words of the extra call from the call itself, so a control
   * that cannot be shown to run is a control that prices nothing.
   */
  it('spends the same call and says nothing about the empty result', async () => {
    const result = await run({ plan: { first: () => empty() }, env: { BIRD_ARMS: 'select-mixed+empty-blind' } });
    expect(result.code, result.printed.join('\n')).toBe(0);
    const retries = result.requests.filter((request) => request.prompt.includes('Write the statement for this question again'));
    expect(retries.length).toBe(QUESTIONS.length);
    // Nothing about the previous result reached the model: no diagnosis, no row count, no values.
    expect(retries[0]?.prompt).not.toContain('returned no rows');
    expect(retries[0]?.prompt).not.toContain('Its values were looked up');
    const arms = result.report.arms as { emptyRetry: { mode: string; fired: number; recovered: number } }[];
    expect(arms[0]?.emptyRetry.mode).toBe('blind');
    expect(arms[0]?.emptyRetry.fired).toBe(QUESTIONS.length);
    expect(arms[0]?.emptyRetry.recovered).toBe(QUESTIONS.length);
  });
});

describe('the value lookup behind a zero-row case', () => {
  /** The question whose card certainly shows `items.name`, which is the column the lookup reads. */
  const NAMED = 'How many distinct item names are there?';
  /** Every question but that one answered correctly, so the run keeps its signal above the gate. */
  const others = (question: string): string => GOLD[question] ?? 'select 1';

  /**
   * The arm's whole claim, in the state the lookup exists for.
   *
   * One candidate returned nothing because the column does not store the case the statement
   * asked for — the fixture holds `pen` and the statement says `Pen`. The lookup settles that
   * without a model, so the turn must not be spent: a lever that paid for a call it did not
   * need would look identical in the score column and wrong in the cost column.
   */
  it('grounds a case-mismatched literal and adopts it without spending the turn', async () => {
    const result = await run({
      plan: { first: (question) => (question === NAMED ? "select name from items where name = 'Pen'" : others(question)) },
      env: { BIRD_ARMS: 'select-mixed+values' },
    });
    expect(result.code, result.printed.join('\n')).toBe(0);
    const arms = result.report.arms as {
      arm: string;
      emptyRetry: { mode: string; fired: number; recovered: number; grounded: number; adoptedFree: number; probeQueries: number };
    }[];
    const arm = arms[0];
    expect(arm?.arm).toBe('select-mixed+values');
    expect(arm?.emptyRetry.mode).toBe('values');
    expect(arm?.emptyRetry.grounded).toBe(1);
    expect(arm?.emptyRetry.adoptedFree).toBe(1);
    expect(arm?.emptyRetry.recovered).toBe(1);
    // The one case the lookup answered paid no call for it.
    expect(arm?.emptyRetry.fired).toBe(0);
    expect(arm?.emptyRetry.probeQueries).toBeGreaterThan(0);
    // Nothing about an empty result was said to the model, because nothing needed saying.
    expect(result.requests.filter((request) => request.prompt.includes('Its values were looked up in the database'))).toHaveLength(0);
    const cases = result.report.cases as { emptyProbe?: { grounded: boolean; adoptedFree: boolean } }[];
    expect(cases.filter((row) => row.emptyProbe?.adoptedFree === true)).toHaveLength(1);
  });

  /**
   * The 96.2% that never trigger, as an equality rather than a claim.
   *
   * Every question here is answered correctly on the first draw, so no candidate returns
   * nothing and the lookup has no state to act on. The arm is then required to be its parent:
   * same statements, same calls, same verdicts, question for question. A trigger that leaked
   * into the normal path — one extra query that changed a prompt, one call charged on a case
   * that did not need it — would show up here and nowhere else, because both arms score the
   * same and the score is what every other reading looks at.
   */
  it('leaves a case that never triggers exactly as its parent left it', async () => {
    const result = await run({ plan: {}, env: { BIRD_ARMS: 'select-mixed,select-mixed+values' } });
    expect(result.code, result.printed.join('\n')).toBe(0);
    const cases = result.report.cases as { arm: string; id: string; passed: boolean; calls: number; emptyProbe?: unknown }[];
    const parent = new Map(cases.filter((row) => row.arm === 'select-mixed').map((row) => [row.id, row]));
    const child = cases.filter((row) => row.arm === 'select-mixed+values');
    expect(child.length).toBe(parent.size);
    for (const row of child) {
      const twin = parent.get(row.id);
      expect(twin, row.id).toBeDefined();
      expect(row.passed, row.id).toBe(twin?.passed);
      expect(row.calls, row.id).toBe(twin?.calls);
      // And nothing about the lookup was recorded, because nothing ran.
      expect(row.emptyProbe, row.id).toBeUndefined();
    }
    const arms = result.report.arms as { emptyRetry?: { fired: number; probeQueries: number } }[];
    expect(arms.every((arm) => arm.emptyRetry === undefined || (arm.emptyRetry.fired === 0 && arm.emptyRetry.probeQueries === 0))).toBe(true);
  });

  it('quotes the values the column holds when the literal is only part of one', async () => {
    const result = await run({
      plan: { first: () => "select name from items where name = 'pe'" },
      env: { BIRD_ARMS: 'select-mixed+values' },
    });
    expect(result.code, result.printed.join('\n')).toBe(0);
    const retries = result.requests.filter((request) => request.prompt.includes('Its values were looked up in the database'));
    expect(retries.length).toBeGreaterThan(0);
    // The question that names the column gets the column's own value quoted back; the ones whose
    // card does not show `name` have nothing to quote and fall back to the diagnosed message.
    const quoted = retries.find((request) => request.prompt.includes('items.name'));
    expect(quoted?.prompt).toContain("'pen'");
    expect(quoted?.prompt).toContain('is not a value of');
    const arms = result.report.arms as { emptyRetry: { fired: number; grounded: number; adoptedFree: number; literalGaps: number } }[];
    expect(arms[0]?.emptyRetry.grounded).toBe(0);
    expect(arms[0]?.emptyRetry.adoptedFree).toBe(0);
    expect(arms[0]?.emptyRetry.fired).toBeGreaterThan(0);
    expect(arms[0]?.emptyRetry.literalGaps).toBeGreaterThan(0);
  });

  it('says a value is absent when no row holds it', async () => {
    const result = await run({
      plan: { first: () => "select name from items where name = 'zzz'" },
      env: { BIRD_ARMS: 'select-mixed+values' },
    });
    expect(result.code, result.printed.join('\n')).toBe(0);
    const retries = result.requests.filter((request) => request.prompt.includes('Its values were looked up in the database'));
    const absent = retries.find((request) => request.prompt.includes('contains no value with'));
    expect(absent?.prompt).toContain('items.name');
  });

  it('keeps the grounded statement when it still returns nothing, and asks for one rewrite', async () => {
    const result = await run({
      plan: { first: (question) => (question === NAMED ? "select name from items where name = 'Pen' and price > 999" : others(question)) },
      env: { BIRD_ARMS: 'select-mixed+values' },
    });
    expect(result.code, result.printed.join('\n')).toBe(0);
    const retries = result.requests.filter((request) => request.prompt.includes('Its values were looked up in the database'));
    expect(retries).toHaveLength(1);
    // The statement the model is asked to repair is the grounded one, not the one with the
    // spelling the database does not hold.
    expect(retries[0]?.prompt).toContain("name = 'pen'");
    const arms = result.report.arms as { emptyRetry: { grounded: number; adoptedFree: number; fired: number } }[];
    expect(arms[0]?.emptyRetry.grounded).toBe(1);
    expect(arms[0]?.emptyRetry.adoptedFree).toBe(0);
    expect(arms[0]?.emptyRetry.fired).toBe(1);
  });
});

describe('the audit arm', () => {
  it('names what the statement left out, rewrites it, and reports the call it spent', async () => {
    const result = await run({
      plan: {
        first: () => wrong(),
        // One named condition per case, and the gold statement as the rewrite: the reply shape
        // the prompt asks for, answered the way a model that found the mistake would.
        audit: (question) =>
          `MISSING: the question filters on a column the statement never mentions\n${fenced(GOLD[question] ?? 'select 1')}`,
      },
      env: { BIRD_ARMS: 'inline+evidence,inline+evidence+audit' },
    });
    expect(result.code).toBe(0);
    const arms = result.report.arms as {
      arm: string;
      passed: number;
      audit?: { fired: number; named: number; rewritten: number; extraCallsPerCase: number };
      tokens?: { byPurpose?: Record<string, { calls: number }> };
    }[];
    const parent = arms.find((arm) => arm.arm === 'inline+evidence');
    const audit = arms.find((arm) => arm.arm === 'inline+evidence+audit');
    // The parent answered nothing correctly; the audited arm answered everything, because the
    // rewrite it was handed is the statement that answers the question.
    expect(parent?.passed).toBe(0);
    expect(audit?.passed).toBe(QUESTIONS.length);
    // The funnel is the measurement: the turn fired on every question, named one condition
    // each, and changed the statement every time.
    expect(audit?.audit).toEqual({
      fired: QUESTIONS.length,
      named: QUESTIONS.length,
      rewritten: QUESTIONS.length,
      extraCallsPerCase: 1,
    });
    // The price is a column, not a guess: the audit call is billed under its own purpose, at
    // one call a case (the report divides the run's calls by its cases).
    expect(audit?.tokens?.byPurpose?.audit?.calls).toBe(1);
    expect(parent?.tokens?.byPurpose?.audit).toBeUndefined();
  });

  it('keeps the statement when the audit names nothing, and says it changed nothing', async () => {
    // The control the reading needs: the same call on the same cases with a reply that reports
    // no omission. Accuracy must not move, or the gain would be the second draw rather than
    // the audit.
    // One question answered correctly, so the run has a signal to publish: a pair where both
    // arms answered nothing is refused by the harness before any lever can be read.
    const first = Object.keys(GOLD)[0] ?? '';
    const result = await run({
      plan: { first: (question) => (question === first ? GOLD[question] : wrong()) },
      env: { BIRD_ARMS: 'inline+evidence,inline+evidence+audit' },
    });
    expect(result.code).toBe(0);
    const arms = result.report.arms as {
      arm: string;
      passed: number;
      audit?: { fired: number; named: number; rewritten: number; extraCallsPerCase: number };
    }[];
    const parent = arms.find((arm) => arm.arm === 'inline+evidence');
    const audit = arms.find((arm) => arm.arm === 'inline+evidence+audit');
    // The call was spent and nothing moved: same accuracy as the parent, because the reply
    // reported no omission and repeated the statement it was given.
    expect(audit?.passed).toBe(parent?.passed);
    expect(audit?.audit).toEqual({
      fired: QUESTIONS.length,
      named: 0,
      rewritten: 0,
      extraCallsPerCase: 1,
    });
  });
});

describe('a repair arm', () => {
  it('lets the engine refuse a statement and reports the repair instead of a crash', async () => {
    const result = await run({ plan: { first: () => broken() }, env: { BIRD_ARMS: 'inline+repair' } });
    expect(result.code).toBe(0);
    const arms = result.report.arms as {
      arm: string;
      passed: number;
      repair: { total: number; repaired: number; fixedByRepair: number; stillFailing: number; meanAttempts: number };
      calls: { mean: number };
      errors: { execution: number };
    }[];
    const arm = arms[0];
    expect(arm?.arm).toBe('inline+repair');
    // Every case needed exactly one repair turn, and the funnel says so: proof that the
    // execute hook reached the loop rather than the statement being accepted blindly.
    expect(arm?.repair.total).toBe(QUESTIONS.length);
    expect(arm?.repair.repaired).toBe(QUESTIONS.length);
    expect(arm?.repair.fixedByRepair).toBe(QUESTIONS.length);
    expect(arm?.repair.stillFailing).toBe(0);
    expect(arm?.repair.meanAttempts).toBe(2);
    expect(arm?.passed).toBe(QUESTIONS.length);
    expect(arm?.errors.execution).toBe(0);
    // Two calls per case: the statement that failed and the one that replaced it.
    expect(arm?.calls.mean).toBe(2);
  });
});

describe('inputs an arm needs and does not have', () => {
  it('refuses a retrieval arm when the training split was never fetched', async () => {
    await expect(run({ plan: { first: correct }, env: { BIRD_ARMS: 'inline+retrieval' } })).rejects.toThrow(
      /need the BIRD training split/,
    );
  });

  it('refuses a cross-model arm when no second model is configured', async () => {
    await expect(run({ plan: { first: correct }, env: { BIRD_ARMS: 'select-cross' } })).rejects.toThrow(
      /BIRD_SECOND_MODEL.*generate two candidates where it promised three/,
    );
  });

  it('refuses a judge swap without a second key, and says it would judge with the first', () => {
    // Written as its own case because the two sentences differ and the difference is the
    // whole point: one arm would generate fewer candidates, the other would silently
    // judge itself.
    const settings = resolveSettings({ BIRD_DATA: data }, [], root);
    expect(() => assertSecondModel(settings, { draws: false, judges: true })).toThrow(
      /asks the second model to judge.*judged by the primary model while claiming a swap/,
    );
    expect(() => assertSecondModel(settings, { draws: false, judges: false })).not.toThrow();
  });

  it('names only the variable that is actually missing, and names both when both are', () => {
    // The first version of this guard said "this arm needs a second model", which sent me
    // looking at the workflow's model input when the key was what was absent. A sentence
    // that cannot say which of two settings is missing costs a CI run to find out.
    const base = resolveSettings({ BIRD_DATA: data }, [], root);
    const withModel = { ...base, second: { model: 'glm-4.5', baseUrl: '', apiKey: '' } };
    expect(() => assertSecondModel(withModel, { draws: true, judges: false })).toThrow(
      /but a second key \(BIRD_SECOND_API_KEY or ZHIPU_API_KEY\) is not set/,
    );
    expect(() => assertSecondModel(withModel, { draws: true, judges: false })).not.toThrow(
      /BIRD_SECOND_MODEL is not set/,
    );
    const withKey = { ...base, second: { model: '', baseUrl: '', apiKey: 'k' } };
    expect(() => assertSecondModel(withKey, { draws: false, judges: true })).toThrow(
      /but BIRD_SECOND_MODEL is not set/,
    );
    expect(() => assertSecondModel(withKey, { draws: false, judges: true })).not.toThrow(
      /second key/,
    );
    const neither = { ...base, second: { model: '', baseUrl: '', apiKey: '' } };
    expect(() => assertSecondModel(neither, { draws: true, judges: false })).toThrow(
      /BIRD_SECOND_MODEL and a second key/,
    );
    const both = { ...base, second: { model: 'glm-4.5', baseUrl: '', apiKey: 'k' } };
    expect(() => assertSecondModel(both, { draws: true, judges: true })).not.toThrow();
  });

  it('refuses a database it has no questions for', async () => {
    await expect(run({ plan: { first: correct }, env: { BIRD_DBS: 'nowhere', BIRD_ARMS: 'names' } })).rejects.toThrow(
      /no questions for nowhere/,
    );
  });

  it('refuses an arm that is not in the table', async () => {
    await expect(run({ plan: { first: correct }, env: { BIRD_ARMS: 'names,not-an-arm' } })).rejects.toThrow(/unknown arm/);
  });
});

describe('retrieval and the second model, when they are configured', () => {
  const trainFile = join(root, 'eval', '.cache', 'bird', 'train', 'train.json');

  it('renders retrieved neighbours once and reports the corpus it read them from', async () => {
    mkdirSync(join(root, 'eval', '.cache', 'bird', 'train'), { recursive: true });
    writeFileSync(
      trainFile,
      JSON.stringify([
        { db_id: 'other', question: 'How many items are there in total?', evidence: 'count of items', SQL: 'select count(*) from items' },
        { db_id: 'other', question: 'What is the average item price?', evidence: 'mean of price', SQL: 'select avg(price) from items' },
      ]),
    );
    const result = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'inline+retrieval' } });
    expect(result.code).toBe(0);
    const controls = result.report.controls as { retrievalCorpus: number; retrievedBlocks: number };
    expect(controls.retrievalCorpus).toBe(2);
    // A block per question that shares a word with the corpus, which on this fixture is
    // most of them: the count is what tells "retrieved nothing" from "did not help".
    expect(controls.retrievedBlocks).toBeGreaterThan(0);
    const prompts = result.requests.filter((request) => request.prompt.includes(QUESTIONS[0]?.question ?? ''));
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]?.prompt).toContain('How many items are there in total?');
  });

  it('attaches worked examples to the prompt, and counts the cases that carried one', async () => {
    // The examples arrive *on top of* the dataset's hint, which is the configuration CHASE-SQL
    // describes and the one `inline+icl` (retrieval instead of the hint) never measured. The
    // artifact has to say how many of the cases carried a block: an arm whose neighbours landed on
    // a third of the split is a blend of two prompts, and its accuracy is a number about neither.
    mkdirSync(join(root, 'eval', '.cache', 'bird', 'train'), { recursive: true });
    writeFileSync(
      trainFile,
      JSON.stringify([
        { db_id: 'other', question: 'How many items are there in total?', evidence: 'count of items', SQL: 'select count(*) from items' },
        { db_id: 'other', question: 'What is the average item price?', evidence: 'mean of price', SQL: 'select avg(price) from items' },
      ]),
    );
    const result = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'metadata+evidence+icl' } });
    expect(result.code).toBe(0);
    const arms = result.report.arms as { arm: string; demonstrations?: { cases: number; blocks: number; examples: number } }[];
    const funnel = arms[0]?.demonstrations;
    expect(funnel?.cases).toBe(QUESTIONS.length);
    expect(funnel?.blocks).toBeGreaterThan(0);
    // The examples and the card's own join lines are in the same prompt: this is the stacking, not
    // the replacement `inline+icl` priced.
    const prompt = result.requests.find((request) => request.prompt.includes(QUESTIONS[0]?.question ?? ''))?.prompt ?? '';
    expect(prompt).toContain('select count(*) from items');
    expect(prompt).toContain('join:');
  });

  it('publishes an examples arm whose blocks never arrived as a zero funnel', async () => {
    // The training split is there and none of its rows carries a statement, so `requires: 'sql'`
    // drops every neighbour: the arm is its parent with a longer prompt. The guard refuses this on
    // a bank of a hundred cases; here the split has seven, the guard is silent by its own floor, and
    // what the artifact must still say is the zero — `blocks: 0` beside `cases: 7` is the reading
    // that stops "the examples did not help" from being inferred from a prompt that never carried
    // one. BIRD's train split really does hold rows with no SQL.
    mkdirSync(join(root, 'eval', '.cache', 'bird', 'train'), { recursive: true });
    writeFileSync(
      trainFile,
      JSON.stringify([{ db_id: 'other', question: 'How many items are there in total?', evidence: 'count of items' }]),
    );
    const result = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'metadata+evidence+icl' } });
    expect(result.code).toBe(0);
    const arms = result.report.arms as { arm: string; demonstrations?: { cases: number; blocks: number; examples: number } }[];
    expect(arms[0]?.demonstrations).toEqual({ cases: QUESTIONS.length, blocks: 0, examples: 0, rewritten: 0 });
    const prompt = result.requests.find((request) => request.prompt.includes(QUESTIONS[0]?.question ?? ''))?.prompt ?? '';
    expect(prompt).not.toContain('Question: How many items are there in total?');
  });

  it('masks the schema out of the worked examples, and counts the ones it rewrote', async () => {
    // `I-83` read the stacked examples as two-sided: 30 fewer wrong-width statements and fifteen
    // new execution errors naming another schema's columns and functions. The masked arm is the
    // answer, and it is one lever only if the same retrieval produced the same examples — so the
    // artifact has to publish how many of them the masker actually changed. A transform that
    // matches nothing sends the parent's prompt and reports the parent's accuracy.
    mkdirSync(join(root, 'eval', '.cache', 'bird', 'train'), { recursive: true });
    writeFileSync(
      trainFile,
      JSON.stringify([
        { db_id: 'other', question: 'How many items are there in total?', evidence: 'count of items', SQL: 'select count(*) from items' },
        { db_id: 'another', question: 'When was each item published?', evidence: 'year of publishing', SQL: 'select YEAR(published) from items' },
      ]),
    );
    const result = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'metadata+evidence+icl-masked' } });
    expect(result.code).toBe(0);
    const arms = result.report.arms as {
      arm: string;
      demonstrations?: { cases: number; blocks: number; examples: number; rewritten: number };
    }[];
    const funnel = arms[0]?.demonstrations;
    expect(funnel?.blocks).toBeGreaterThan(0);
    // Every example that arrived was rewritten, because every example carries a name to replace.
    expect(funnel?.rewritten).toBe(funnel?.examples);
    const prompt = result.requests.find((request) => request.prompt.includes(QUESTIONS[0]?.question ?? ''))?.prompt ?? '';
    // Both halves of the `I-83` failure table: the name that does not exist here, and the function
    // this engine does not have.
    expect(prompt).toContain('SQL: select count(*) from table_1');
    expect(prompt).toContain("strftime('%Y', column_1)");
    expect(prompt).not.toContain('from items');
    expect(prompt).not.toContain('YEAR(');
    // ...and the block says what a placeholder is, because `table_1` is a valid table name and the
    // cheapest thing to do with an example is copy it.
    expect(prompt).toContain('renamed to table_1');
    expect(prompt).toContain('join:');
  });

  it('draws a candidate from the second endpoint and labels each candidate with its source', async () => {
    const second = await startEndpoint({ reply: (request) => replyFor(request, { first: correct }) });
    try {
      const result = await run({
        plan: { first: correct },
        env: {
          BIRD_ARMS: 'select-tagged',
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
        },
      });
      expect(result.code).toBe(0);
      expect(result.report.secondModel).toBe('second-model');
      const arms = result.report.arms as { arm: string; sources?: Record<string, number>; candidateFailures?: unknown }[];
      // One candidate of three comes from the second model, and the artifact says so per
      // case: a cross arm whose candidates cannot be attributed measured nothing.
      expect(arms[0]?.sources).toMatchObject({ 'inline+evidence@second': QUESTIONS.length });
      expect(arms[0]?.candidateFailures).toBeUndefined();
      // Both endpoints were spoken to, and each with its own key.
      expect(second.requests.length).toBeGreaterThan(0);
      expect(second.requests[0]?.authorization).toBe('Bearer second-key');
    } finally {
      await second.close();
    }
  });
});

/**
 * The pooled arm, which is an instrument rather than a lever.
 *
 * Every arm in this file draws its own candidates, so two arms that differ in one lever also
 * differ in their pool — and at 600 questions the pool's own displacement was measured at 1.3 to
 * 3.3pp, which is the size of the effects being chased. A pooled arm reads the candidates another
 * arm already drew, so the only thing that differs between it and its source is what it does with
 * them. The three assertions below are the whole contract: it generates nothing (one call, not
 * four), it reads the same set (the same ceiling), and it scores exactly what the source scored
 * (because with the same judge and the same instruction there is nothing left to differ).
 */
describe('a pooled arm reads the pool instead of drawing one', () => {
  const crossEnv = (secondUrl: string): Record<string, string> => ({
    BIRD_SECOND_MODEL: 'second-model',
    BIRD_SECOND_BASE_URL: secondUrl,
    BIRD_SECOND_API_KEY: 'second-key',
  });

  it('spends one call per case, draws nothing, and scores exactly what the arm it names scored', async () => {
    const second = await startEndpoint({ reply: (request) => replyFor(request, { first: correct }) });
    try {
      const result = await run({
        plan: { first: correct },
        env: { BIRD_ARMS: 'select-cross,select-cross-pooled', ...crossEnv(second.url) },
      });
      expect(result.code).toBe(0);
      const arms = result.report.arms as {
        arm: string;
        pool?: string;
        calls: { mean: number };
        passed: number;
        total: number;
        candidateRecall?: number;
        spend?: { asked: number; priced: number };
      }[];
      const parent = arms.find((entry) => entry.arm === 'select-cross');
      const pooled = arms.find((entry) => entry.arm === 'select-cross-pooled');
      expect(parent).toBeDefined();
      expect(pooled).toBeDefined();
      // The row says which pool it read: a one-call arm beside a four-call parent reads as a
      // saving unless the artifact states that the candidates were somebody else's.
      expect(pooled?.pool).toBe('select-cross');
      expect(parent?.calls.mean).toBe(4);
      expect(pooled?.calls.mean).toBe(1);
      // ...and the decision carried that call. `calls.mean` of 1 is also what an arm reports when it
      // never counted a selector and never reached one, so the pair of counts is what makes the
      // number a price rather than an arithmetic coincidence (I-81: four pooled rows were refused by
      // the gate for reporting this exact figure).
      expect(pooled?.spend).toEqual({ asked: QUESTIONS.length, priced: QUESTIONS.length });
      // The generating arm reports the same pair over the same cases: its four calls per case are the
      // three candidates and one decision, and every decision was priced.
      expect(parent?.spend).toEqual({ asked: QUESTIONS.length, priced: QUESTIONS.length });
      // The second endpoint answered exactly the parent's one cross candidate per case and not
      // one more: a pooled arm that drew its own would double this count.
      expect(second.requests).toHaveLength(QUESTIONS.length);
      // Same pool, same judge, same instruction — so the same score, case for case. If this
      // equality fails the pooling is broken, and every judge-swap delta taken on a shared pool
      // would be measuring something other than the judge.
      expect(pooled?.candidateRecall).toBe(parent?.candidateRecall);
      expect(pooled?.passed).toBe(parent?.passed);
      expect(pooled?.total).toBe(parent?.total);
    } finally {
      await second.close();
    }
  });

  it('refuses to run before the arm whose pool it names', async () => {
    // The failure mode this replaces is silent: a pooled arm that ran first would find no pool,
    // and the version of this that generated its own candidates looked entirely healthy while
    // being its parent under a new name.
    await expect(
      run({ plan: { first: correct }, env: { BIRD_ARMS: 'select-cross-pooled,select-cross', ...crossEnv('http://127.0.0.1:1/v1') } }),
    ).rejects.toThrow(/not scheduled before it/);
  });
});

/**
 * Who decides, on a pool nobody in the comparison drew.
 *
 * The pair `select-cross` / `vote-cross` asked this and could not answer it: both arms draw
 * their own candidates, and the pool's own displacement at 600 questions (measured twice,
 * 1.3 to 3.3pp) is the size of the effect being chased. On a shared pool the candidates, the
 * rows and the order are the same objects, so the only thing that can differ is the decision.
 *
 * The scenario is built to make the two decisions disagree, which is the only way the
 * measurement can be wrong and be seen to be wrong: the second model writes a statement that
 * runs and is wrong, the two primary prompts write the gold one, and the selector is answered
 * with `1` — the slot the second model holds. The modal group is therefore right and the
 * selector wrong on every case, and an arm that reported otherwise would be reading a
 * different pool than it names.
 */
describe('the decision, with the pool held fixed', () => {
  it('keeps the candidate record when the selector call never comes back', async () => {
    // The defect `41410112996` exposed by accident: the adjudication was the one call in the vote
    // branch with no catch, so a refusal from the endpoint erased the whole case — including the
    // ceiling — and the shared-pool assertion read that silence as "this arm generated its own
    // candidates". The vote had already decided the case; the arm has to be scored by it, with the
    // failed call counted, so the artifact says "the lever did not run here" and not "the pool was
    // different".
    const target = QUESTIONS[2]?.question ?? '';
    const second = await startEndpoint({ reply: (request) => replyFor(request, { first: correct }) });
    try {
      const result = await run({
        plan: {
          first: correct,
          // Only the first question's first adjudication fails: on `select-cross` that is the source
          // arm, and the pooled arm behind it reads the same pool with a live endpoint.
          fail: (request) =>
            request.prompt.includes(target) && request.prompt.includes('which candidate statement answers the question') ? 500 : undefined,
        },
        env: {
          BIRD_ARMS: 'select-cross,select-cross-pooled',
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
          BIRD_LLM_RETRIES: '1',
          BIRD_CONCURRENCY: '1',
        },
      });
      expect(result.code).toBe(0);
      const arms = result.report.arms as {
        arm: string;
        passed: number;
        total: number;
        candidateRecall?: number;
        selectorDecided?: number;
        selectorTotal?: number;
        selectorFailed?: number;
      }[];
      const [cross, pooled] = arms;
      expect(cross?.selectorFailed).toBe(1);
      // Every case still carries a decision: one of them came from the vote.
      expect(cross?.selectorTotal).toBe(QUESTIONS.length);
      expect(cross?.selectorDecided).toBe(QUESTIONS.length - 1);
      // The pool held the answer on every question, and the failed adjudication does not change it.
      expect(cross?.candidateRecall).toBe(QUESTIONS.length);
      expect(pooled?.candidateRecall).toBe(cross?.candidateRecall);
      // Scored by the statement the vote chose, so a lever that did not run is not charged as a
      // wrong answer: the candidates were right on every case.
      expect(cross?.passed).toBe(cross?.total);
      // And the line an operator reads says it, next to the accuracy it qualifies.
      expect(result.printed.some((line) => line.includes('select-failed 1'))).toBe(true);
    } finally {
      await second.close();
    }
  });

  it('keeps it when the empty-result turn never comes back either', async () => {
    // The same bare call one line later: the turn is optional by construction, so a refusal from
    // the endpoint is a lever that did not run — the original statement stands, and the ceiling the
    // arm is judged on survives. There is no pool to blame here, but the case is just as lost.
    const target = QUESTIONS[2]?.question ?? '';
    const refused = (request: EndpointRequest): boolean =>
      request.prompt.includes(target) && request.prompt.includes('returned no rows');
    // The empty result belongs to the second model's candidate on this fixture, so the turn it pays
    // for is sent to that endpoint: both have to refuse for the lever's call to be the failing one.
    const second = await startEndpoint({
      reply: (request) => (refused(request) ? { status: 500, content: '{"error":"unavailable"}' } : replyFor(request, { first: empty })),
    });
    try {
      const result = await run({
        plan: { first: empty, fail: (request) => (refused(request) ? 500 : undefined) },
        env: {
          BIRD_ARMS: 'select-cross-empty',
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
          BIRD_LLM_RETRIES: '1',
          BIRD_CONCURRENCY: '1',
        },
      });
      expect(result.code).toBe(0);
      const arms = result.report.arms as {
        retryFailed?: number;
        candidateRecall?: number;
        emptyRetry?: { fired: number; recovered: number };
      }[];
      // One turn refused out of seven. The turn was attempted on every case and recovered on the
      // other six, so the funnel and the new counter have to survive side by side or the lever
      // reads as untried rather than as one call that did not arrive.
      expect(arms[0]?.retryFailed).toBe(1);
      expect(arms[0]?.emptyRetry?.fired).toBe(QUESTIONS.length);
      expect(arms[0]?.emptyRetry?.recovered).toBe(QUESTIONS.length - 1);
      // Every candidate returned nothing, so the ceiling is zero — and it is recorded rather than
      // lost, which is the whole point of catching the turn.
      expect(arms[0]?.candidateRecall).toBe(0);
    } finally {
      await second.close();
    }
  });

  it('records a case the source arm could not fill, instead of refusing the run', async () => {
    // `41430569500` is the run that found this: `select-mixed` produced no candidates for two of six
    // hundred cases — every sample for those questions died at the engine — and the pooled arm's
    // guard raised a plain Error, which is filed as a harness bug and refused a measurement of six
    // arms that had already been scored. A gap in the sample is not a bug in the runner: the pooled
    // arm has nothing to read, and the honest row is the one the source wrote, under its own kind.
    const target = QUESTIONS[3]?.question ?? '';
    // Two of the three candidates come from the primary endpoint and one from the second, so *both*
    // have to write a statement no engine will run for the pool to be empty. Leaving the primary on
    // the gold statement was the first version of this test and it proved nothing: two surviving
    // candidates are a pool of two, the case answered correctly, and the assert passed for a reason
    // unrelated to the defect.
    const plan: Plan = { first: (question) => (question === target ? broken() : correct(question)) };
    const second = await startEndpoint({ reply: (request) => replyFor(request, plan) });
    try {
      const result = await run({
        plan,
        env: {
          BIRD_ARMS: 'select-cross,select-cross-pooled,select-cross-pooled-vote',
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
          BIRD_CONCURRENCY: '1',
        },
      });
      expect(result.code).toBe(0);
      const arms = result.report.arms as {
        arm: string;
        passed: number;
        total: number;
        firstError?: string;
        errors?: { other: number; harness: number };
      }[];
      const byName = new Map(arms.map((entry) => [entry.arm, entry]));
      // The source records the question as a failure it could not answer, and does not file it as a
      // runner bug: the arm still describes a full sample, one case short.
      expect(byName.get('select-cross')?.errors).toMatchObject({ harness: 0, other: 1 });
      expect(byName.get('select-cross')?.firstError).toBe('no sample survived guard and execution');
      expect(byName.get('select-cross')?.passed).toBe(QUESTIONS.length - 1);
      // The pooled arms read that same case and report the same gap, carrying the source's reason
      // rather than a reason of their own.
      for (const name of ['select-cross-pooled', 'select-cross-pooled-vote']) {
        expect(byName.get(name)?.errors).toMatchObject({ harness: 0, other: 1 });
        expect(byName.get(name)?.firstError).toContain('pool: select-cross produced no candidates for this case');
        expect(byName.get(name)?.firstError).toContain('no sample survived guard and execution');
      }
      // And the sample is still the whole sample: a pooled arm that dropped the case would be
      // reporting a rate over a subset it never declared.
      expect(byName.get('select-cross-pooled')?.total).toBe(QUESTIONS.length);
      expect(byName.get('select-cross-pooled-vote')?.total).toBe(QUESTIONS.length);
    } finally {
      await second.close();
    }
  });

  it('takes the modal result in no calls, where the selector takes the first slot in one', async () => {
    const second = await startEndpoint({ reply: (request) => replyFor(request, { first: wrong }) });
    try {
      const result = await run({
        plan: { first: correct },
        env: {
          BIRD_ARMS: 'select-cross,select-cross-pooled,select-cross-pooled-vote,select-cross-pooled-agree',
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
        },
      });
      expect(result.code).toBe(0);
      const arms = result.report.arms as { arm: string; calls: { mean: number }; passed: number; total: number; candidateRecall?: number }[];
      const byName = new Map(arms.map((entry) => [entry.arm, entry]));
      const pooled = byName.get('select-cross-pooled');
      const vote = byName.get('select-cross-pooled-vote');
      expect(pooled?.passed).toBe(0);
      expect(vote?.passed).toBe(vote?.total);
      // Both arms read the same set, so the ceiling cannot be what separates them.
      expect(vote?.candidateRecall).toBe(pooled?.candidateRecall);
      // The count costs nothing: it reads rows that were already computed.
      expect(pooled?.calls.mean).toBe(1);
      expect(vote?.calls.mean).toBe(0);
      // The agreeing pair is the fact the selector was never given, and it has to reach the
      // prompt — a mark computed and dropped is the defect `agreesWith` was added to fix.
      const selections = result.requests.filter((request) => request.prompt.includes('which candidate statement answers the question'));
      const marked = selections.find((request) => request.prompt.includes('same result as candidate'));
      expect(marked?.prompt).toContain('returned 2 distinct results');
      expect(marked?.prompt).toContain('same result as candidate 2');
      // The arms that did not ask for the marks keep the prompt they were measured with: the
      // delta between the pair has to be the marks and nothing else.
      expect(selections.some((request) => !request.prompt.includes('distinct results'))).toBe(true);
    } finally {
      await second.close();
    }
  });
});

describe('the second model as a judge', () => {
  it('falls back to the primary endpoint when the second model has no endpoint of its own', async () => {
    // A provider pair can be two keys against one gateway, which is what a run does when
    // the harness is pointed at a proxy. The fallback is the only reason that works, and
    // it was never executed: every test that configured a second model also gave it a URL.
    const result = await run({
      plan: { first: correct },
      env: {
        BIRD_ARMS: 'select-cross',
        BIRD_SECOND_MODEL: 'second-model',
        BIRD_SECOND_API_KEY: 'second-key',
      },
    });
    expect(result.code).toBe(0);
    const fromSecondKey = result.requests.filter((request) => request.authorization === 'Bearer second-key');
    expect(fromSecondKey.length).toBeGreaterThan(0);
    // One candidate of three per case, drawn with the second key against the primary URL.
    expect(fromSecondKey).toHaveLength(QUESTIONS.length);
  });

  it('judges the candidate set with the second model and names the judge in the artifact', async () => {
    const second = await startEndpoint({ reply: (request) => replyFor(request, { first: correct }) });
    try {
      const result = await run({
        plan: { first: correct },
        env: {
          BIRD_ARMS: 'select-cross-judge',
          BIRD_SECOND_MODEL: 'judge-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
        },
      });
      expect(result.code).toBe(0);
      // A judge swap is the one experiment whose result is unreadable without the name of
      // the judge, so the artifact carries it at the top level and on the arm row.
      expect(result.report.judgeModel).toBe('judge-model');
      expect(result.report.secondModel).toBe('judge-model');
      const arms = result.report.arms as { arm: string; judge?: string; selectorDecided?: number; selectorTotal?: number }[];
      expect(arms[0]?.arm).toBe('select-cross-judge');
      expect(arms[0]?.judge).toBe('second');
      // The selector is the second provider here, and it answered every case: a judge whose
      // calls are not counted as the arm's price would understate what the swap costs.
      expect(arms[0]?.selectorDecided).toBe(QUESTIONS.length);
      expect(arms[0]?.selectorTotal).toBe(QUESTIONS.length);
      expect(second.requests.some((request) => request.prompt.includes('which candidate statement answers the question'))).toBe(true);
    } finally {
      await second.close();
    }
  });

  it('asks a reasoning judge in the shape it can answer, and reads the number from the last line', async () => {
    // The instruction a chat judge gets — "the number and nothing else" — is the one a reasoning
    // endpoint either ignores (its prose used to be an undecided vote) or obeys at the cost of the
    // deliberation it was bought for. This arm asks it to think and fixes where the answer ends,
    // and the reply below is the shape that instruction produces: a sentence of reasoning, then
    // the number alone. `selectorDecided` is the assertion that the reader found it.
    const second = await startEndpoint({
      reply: (request) => {
        if (request.prompt.includes('which candidate statement answers the question')) {
          return 'Candidate 1 groups by the column the question asks about; candidate 2 does not.\n1';
        }
        return replyFor(request, { first: correct });
      },
    });
    try {
      const result = await run({
        plan: { first: correct },
        env: {
          BIRD_ARMS: 'select-cross-judge-reasoning',
          BIRD_SECOND_MODEL: 'deepseek-reasoner',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
        },
      });
      expect(result.code).toBe(0);
      const judged = second.requests.filter((request) => request.prompt.includes('which candidate statement answers the question'));
      expect(judged.length).toBe(QUESTIONS.length);
      expect(judged[0]?.prompt).toContain('alone on the final line');
      expect(judged[0]?.prompt).not.toContain('and nothing else');
      const arms = result.report.arms as {
        arm: string;
        selectorDecided?: number;
        selectorTotal?: number;
        samplingOmitted?: Record<string, number>;
      }[];
      expect(arms[0]?.arm).toBe('select-cross-judge-reasoning');
      // Every reply was read: the format change is what makes the judge's answer count.
      expect(arms[0]?.selectorDecided).toBe(QUESTIONS.length);
      expect(arms[0]?.selectorTotal).toBe(QUESTIONS.length);
      // The endpoint did not honour the sampling field, and the artifact says so rather than
      // printing a temperature the judge never sampled at.
      expect(arms[0]?.samplingOmitted).toEqual({ temperature: expect.any(Number) });
    } finally {
      await second.close();
    }
  });

  it('leaves the chat judge on the instruction it was measured with', async () => {
    const second = await startEndpoint({ reply: (request) => replyFor(request, { first: correct }) });
    try {
      const result = await run({
        plan: { first: correct },
        env: {
          BIRD_ARMS: 'select-cross-judge',
          BIRD_SECOND_MODEL: 'chat-judge',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
        },
      });
      expect(result.code).toBe(0);
      const judged = second.requests.filter((request) => request.prompt.includes('which candidate statement answers the question'));
      expect(judged[0]?.prompt).toContain('and nothing else');
      expect(judged[0]?.prompt).not.toContain('final line');
      const arms = result.report.arms as { samplingOmitted?: Record<string, number> }[];
      expect(arms[0]?.samplingOmitted).toBeUndefined();
    } finally {
      await second.close();
    }
  });

  it('removes the linker hint from one source and leaves the other prompts alone', async () => {
    // `Likely columns` is our linker's answer to "which columns matter", printed in front of a
    // model that was bought to answer exactly that. The arm removes it from the second model's
    // prompt only; the two primary candidates keep theirs, which is what makes the delta the
    // hint rather than a shorter prompt.
    const second = await startEndpoint({ reply: (request) => replyFor(request, { first: correct }) });
    try {
      const result = await run({
        plan: { first: correct },
        env: {
          BIRD_ARMS: 'select-cross-unhinted',
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
        },
      });
      expect(result.code).toBe(0);
      const secondDraws = second.requests.filter((request) => request.prompt.includes('You translate questions into one read-only SQL statement'));
      expect(secondDraws.length).toBe(QUESTIONS.length);
      expect(secondDraws.every((request) => !request.prompt.includes('Likely columns'))).toBe(true);
      const primaryDraws = result.requests.filter(
        (request) =>
          request.authorization === 'Bearer test-key' && request.prompt.includes('You translate questions into one read-only SQL statement'),
      );
      expect(primaryDraws.some((request) => request.prompt.includes('Likely columns'))).toBe(true);
    } finally {
      await second.close();
    }
  });

  it('names no judge when no arm asks for one, even with a second model configured', () => {
    // `judgeModel` answers "who judged", not "who could have". A report that named a
    // configured model would make a judge swap look like it happened.
    expect(judgeModelName(['select-cross'], { model: 'glm-4.5' })).toBeNull();
    expect(judgeModelName(['names', 'inline+evidence'], { model: 'glm-4.5' })).toBeNull();
    expect(judgeModelName(['select-cross-judge'], { model: 'glm-4.5' })).toBe('glm-4.5');
    // A judged arm with no configured model reaches the guard before it reaches the
    // report, so the empty string here is a value the guard has already refused.
    expect(judgeModelName(['select-cross-judge'], { model: '' })).toBe('');
  });
});

describe('the same candidates in one SQL style', () => {
  /**
   * The gold statement, written the way a model with opinions about layout writes it.
   *
   * Every change here is style and nothing else: spacing, a space before the parenthesis, a
   * trailing semicolon. If the canonical arm executes the selector's copy instead of the
   * model's, the answer is unchanged — so the only thing that can betray a leak is what the
   * artifact records as the statement that ran.
   */
  const styled = (question: string): string | undefined => {
    const gold = GOLD[question];
    return gold === undefined ? undefined : `${gold.replace('(', ' ( ').replace(')', ' ) ')}  ;`;
  };

  it('shows the selector one style and runs the statement the model wrote', async () => {
    const second = await startEndpoint({ reply: (request) => replyFor(request, { first: styled }) });
    try {
      const result = await run({
        plan: { first: styled },
        env: {
          BIRD_ARMS: 'select-cross-canon',
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
        },
      });
      expect(result.code).toBe(0);
      const selector = result.requests.filter((request) => request.prompt.includes('which candidate statement answers the question'));
      expect(selector.length).toBe(QUESTIONS.length);
      // The style channel is closed in what the judge reads: keyword case normalised, the
      // gap before the parenthesis gone, the trailing semicolon gone. Asserted across every
      // selection request rather than the first, because the questions are scored in a pool
      // and which one reaches the endpoint first is a race, not a fact.
      expect(selector.every((request) => !request.prompt.includes('count ( * )'))).toBe(true);
      expect(selector.every((request) => !request.prompt.includes(');'))).toBe(true);
      const counting = selector.filter((request) => request.prompt.includes('SELECT COUNT(*) FROM items'));
      expect(counting.length).toBeGreaterThan(0);
      // Three candidates from three prompts and two models, written identically here on
      // purpose: after canonicalisation they are the same line, which is the whole point —
      // nothing in the text says who wrote it.
      const lines = (counting[0]?.prompt ?? '').split('\n').filter((line) => /^\d\. SELECT COUNT\(\*\) FROM items$/u.test(line));
      expect(lines).toHaveLength(3);
      // ...and the arm still answers every question, and still records the set it chose
      // from: the winner is taken by index out of the untouched candidate list, so the
      // canonical text is a display transformation and not a rewrite of the prediction
      // (`readableCandidates` pins that contract in `bird-canonical.test.ts`).
      const cases = result.report.cases as { id: string; passed: boolean; candidates?: unknown }[];
      const first = cases.find((row) => row.id === '1');
      expect(first?.passed).toBe(true);
      expect(cases.every((row) => row.passed)).toBe(true);
      // The candidate record still describes the set, because the winner is taken by index
      // from the untouched set rather than from the copy the judge read.
      const firstCandidates = (first?.candidates ?? []) as { source: string; correct: boolean; sql?: string; fingerprint?: string }[];
      expect(firstCandidates.map(({ source, correct }) => ({ source, correct }))).toEqual([
        { source: 'inline+evidence@second', correct: true },
        { source: 'metadata+evidence', correct: true },
        { source: 'values', correct: true },
      ]);
      // And it carries what each candidate said and what it returned. Both are load-bearing for
      // a different instrument: without the statement a verdict cannot be re-read, and without
      // the fingerprint two candidates that agreed look exactly like two that did not, so
      // `bench:bird:consensus` would have nothing to count. Pinned here so that narrowing the
      // record has to break a test rather than silently unprice a harness.
      expect(firstCandidates.every((candidate) => (candidate.sql ?? '').length > 0)).toBe(true);
      expect(firstCandidates.every((candidate) => /^[0-9a-f]{16}$/u.test(candidate.fingerprint ?? ''))).toBe(true);
      // Three candidates that returned the same thing share a fingerprint; this bank answers
      // every question with one statement, so agreement is total and the set is unanimous.
      expect(new Set(firstCandidates.map((candidate) => candidate.fingerprint)).size).toBe(1);
    } finally {
      await second.close();
    }
  });

  it('leaves the statement alone on an arm that does not ask for one style', async () => {
    // The control for the test above: same endpoint, same styled statements, no lever, and
    // the judge sees exactly what the model wrote.
    const second = await startEndpoint({ reply: (request) => replyFor(request, { first: styled }) });
    try {
      const result = await run({
        plan: { first: styled },
        env: {
          BIRD_ARMS: 'select-cross',
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
        },
      });
      expect(result.code).toBe(0);
      const selector = result.requests.filter((request) => request.prompt.includes('which candidate statement answers the question'));
      // Every request carries the model's own layout, semicolon and all — the same style the
      // arm above removes.
      expect(selector.length).toBe(QUESTIONS.length);
      expect(selector.every((request) => request.prompt.includes(' ( '))).toBe(true);
      expect(selector.some((request) => request.prompt.includes('count ( * )'))).toBe(true);
      expect(selector.every((request) => !request.prompt.includes('SELECT COUNT(*)'))).toBe(true);
    } finally {
      await second.close();
    }
  });
});

/**
 * The same three candidates, in an order that does not follow authorship.
 *
 * `CROSS_SOURCES` puts the second model's statement in slot zero on every question, so every arm
 * measured so far has authorship and position perfectly collinear: `@second` is returned 52.6%
 * of the time and that number is compatible with "the judge prefers this author" and with "the
 * judge prefers slot zero". The shuffled arm permutes the order by question id and changes
 * nothing else, which makes the per-candidate `winnerSource` able to tell the two apart.
 *
 * The order is a published rule, so it is re-implemented here from the description instead of
 * imported: a test that calls the same function it is checking would agree with a broken runner.
 */
describe('the same candidates in an order that does not follow authorship', () => {
  /** FNV-1a over `${id}#${i}`, then Fisher-Yates — the rule the arm documents. */
  const expectedOrder = (id: number): number[] => {
    const hash = (text: string): number => {
      let value = 2166136261;
      for (const character of text) {
        value ^= character.charCodeAt(0);
        value = Math.imul(value, 16777619);
      }
      return value >>> 0;
    };
    const order = [0, 1, 2];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = hash(`${String(id)}#${String(i)}`) % (i + 1);
      const swap = order[i] as number;
      order[i] = order[j] as number;
      order[j] = swap;
    }
    return order;
  };

  /** The only candidate with a space before the parenthesis, written by the second model. */
  const styled = (question: string): string | undefined => {
    const gold = GOLD[question];
    return gold === undefined ? undefined : gold.replace('(', ' ( ').replace(')', ' ) ');
  };

  const candidateRows = (prompt: string): string[] =>
    prompt
      .split('\n')
      .filter((line) => /^\d\. /u.test(line))
      .map((line) => line.replace(/^\d\. /u, '').trim());

  it('moves the second model out of slot zero, and the arm still answers every question', async () => {
    const second = await startEndpoint({ reply: (request) => replyFor(request, { first: styled }) });
    try {
      const result = await run({
        plan: { first: (question) => GOLD[question] },
        env: {
          BIRD_ARMS: 'select-cross,select-cross-shuffled',
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
        },
      });
      expect(result.code).toBe(0);
      const selector = result.requests.filter((request) => request.prompt.includes('which candidate statement answers the question'));
      // Two arms, every question, one selection call each.
      expect(selector.length).toBe(QUESTIONS.length * 2);

      const slotsByQuestion = new Map<string, number[]>();
      for (const request of selector) {
        const asked = QUESTIONS.find((question) => request.prompt.includes(question.question));
        expect(asked, request.prompt.slice(0, 120)).toBeDefined();
        const rows = candidateRows(request.prompt);
        expect(rows).toHaveLength(3);
        // The same set in both arms: a permutation cannot add, drop or rewrite a statement.
        expect(rows.filter((row) => row.includes(' ( '))).toHaveLength(1);
        const slot = rows.findIndex((row) => row.includes(' ( '));
        expect(slot).toBeGreaterThanOrEqual(0);
        const slots = slotsByQuestion.get(asked?.question ?? '') ?? [];
        slots.push(slot);
        slotsByQuestion.set(asked?.question ?? '', slots);
      }
      expect(slotsByQuestion.size).toBe(QUESTIONS.length);

      let moved = 0;
      for (const question of QUESTIONS) {
        const slots = (slotsByQuestion.get(question.question) ?? []).slice().sort((left, right) => left - right);
        const shuffledSlot = expectedOrder(question.id).indexOf(0);
        // One arm keeps the author in slot zero by construction; the other puts it where the
        // permutation says. Compared as a multiset, because the order the two arms reach the
        // endpoint in is a race and not a fact.
        expect(slots, question.question).toEqual([0, shuffledSlot].sort((left, right) => left - right));
        if (shuffledSlot !== 0) moved += 1;
      }
      // A permutation that never moves anything is not a control: on this fixture five of the
      // seven questions relocate the second model's statement, so the arm has something to say.
      expect(moved).toBe(5);

      const cases = result.report.cases as { arm: string; id: string; passed: boolean; candidates?: { source: string; correct: boolean }[] }[];
      expect(cases.every((row) => row.passed)).toBe(true);

      // The artifact has to carry the position, not just the author, or the reading after the
      // run is the same collinear one this arm exists to break. Entry `i` of `candidates` is
      // slot `i` of the prompt, so author (the `source`) crossed with the index is the record.
      const counting = (arm: string): { source: string; correct: boolean }[] =>
        (cases.find((row) => row.arm === arm && row.id === '1')?.candidates ?? []) as { source: string; correct: boolean }[];
      expect(counting('select-cross').map((entry) => entry.source)).toEqual(['inline+evidence@second', 'metadata+evidence', 'values']);
      expect(counting('select-cross-shuffled')[expectedOrder(1).indexOf(0)]?.source).toBe('inline+evidence@second');
      // ...and the truth travels with the member rather than with the slot: all three answer
      // this question in the fixture, so a permutation that rewrote the verdicts would show up
      // as a `correct` that moved with the position.
      expect(counting('select-cross-shuffled').every((entry) => entry.correct)).toBe(true);
    } finally {
      await second.close();
    }
  });
});

describe('the artifact', () => {
  it('records the harness settings that a difference between runs could come from', async () => {
    const result = await run({
      plan: { first: correct },
      env: {
        BIRD_ARMS: 'names',
        BIRD_LLM_TIMEOUT_MS: '12345',
        BIRD_CONCURRENCY: '2',
        BIRD_LLM_RETRIES: '4',
        BIRD_LIMIT: '4',
      },
    });
    expect(result.code).toBe(0);
    expect(result.report.run).toEqual({ timeoutMs: 12345, concurrency: 2, retries: 4 });
    const selection = result.report.selection as { requested: number; scored: number; available: number; databases: string[]; strategy: string };
    // A sample is declared as a sample: the limit is in the artifact beside the number it
    // produced, so a 4-question run cannot be read as a 500-question one.
    expect(selection).toMatchObject({ requested: 4, scored: 4, available: QUESTIONS.length, databases: ['shop'] });
    // ...and its difficulty mix is in the artifact, beside the split's. The fixture is
    // 2 / 3 / 2, so a proportionally allocated sample of four is 1 / 2 / 1; equal allocation
    // would have given 2 / 2 / 0 and an accuracy over a mix the split does not have.
    expect(selection).toMatchObject({
      mix: { sample: { simple: 1, moderate: 2, challenging: 1 }, available: { simple: 2, moderate: 3, challenging: 2 } },
    });
    expect(String(selection.strategy)).toMatch(/proportional to the split difficulty mix/);
    const split = result.report.split;
    expect(split).toBe('minidev');
    expect((result.report.selection as { split: string }).split).toBe(split);
    // The arm's own metadata reached the prompt: `names` has no notes, and the control
    // counts what the schema claims rather than what the file says.
    const controls = result.report.controls as { semanticsDatabases: number; semanticsMeanChars: number };
    expect(controls.semanticsDatabases).toBe(1);
    expect(controls.semanticsMeanChars).toBeGreaterThan(0);
  });

  it('writes the artifact before it returns, so a gate failure still has one to read', async () => {
    const out = join(root, 'gate-failure.json');
    const result = await run({ plan: { first: () => wrong() }, env: { BIRD_ARMS: 'names' }, out });
    expect(result.code).toBe(1);
    const written = JSON.parse(readFileSync(resolve(out), 'utf8')) as { arms: unknown[] };
    expect(written.arms).toHaveLength(1);
  });
});

describe('levers that need their input to be present', () => {
  it('puts the stored values of bounded columns on the card, and counts what it put there', async () => {
    const result = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'inline+evidence+samples' } });
    expect(result.code).toBe(0);
    const controls = result.report.controls as { sampledColumns: number; sampledValues: number };
    // An arm that asks for samples and gets none is its parent renamed, so the count is a
    // control and not a statistic: the fixture's `name` column holds two spellings.
    expect(controls.sampledColumns).toBeGreaterThan(0);
    expect(controls.sampledValues).toBeGreaterThan(0);
    const arms = result.report.arms as { arm: string; passed: number }[];
    expect(arms[0]?.passed).toBe(QUESTIONS.length);
  });

  it('cuts the dataset descriptions down to the columns the inline arm reached', async () => {
    const result = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'inline-definitions,dataset-subset' } });
    expect(result.code).toBe(0);
    const controls = result.report.controls as { subsetComments: number; inlineSchemaComments: number; inlineAttached: number };
    // The inline arm has our definitions on its column lines and nothing else; the subset
    // arm keeps the dataset's own notes for exactly those columns. Both numbers are in the
    // artifact so "the two arms differ in the author of the text" can be checked from it.
    expect(controls.inlineAttached).toBeGreaterThan(0);
    expect(controls.inlineSchemaComments).toBe(controls.inlineAttached);
    expect(controls.subsetComments).toBeGreaterThan(0);
    const arms = result.report.arms as { arm: string; passed: number }[];
    expect(arms.map((entry) => entry.arm)).toEqual(['inline-definitions', 'dataset-subset']);
  });

  it('repairs a statement whose shape is wrong even though the engine accepted it', async () => {
    // The engine reports nothing here: `select * from items` runs and answers "how many
    // items are there" with three rows, so the shape guard is the only thing that can see it.
    // One question keeps answering the same way, so the run also reports a case whose
    // repair never landed — a funnel with only successes cannot price a failure.
    const stubborn = QUESTIONS[4]?.question ?? '';
    const result = await run({
      plan: { first: () => 'select * from items', stubborn: [stubborn] },
      env: { BIRD_ARMS: 'inline+shape' },
    });
    expect(result.code).toBe(0);
    const arms = result.report.arms as {
      arm: string;
      passed: number;
      repair: { total: number; repaired: number; fixedByRepair: number; stillFailing: number };
      errors: { shape: number };
      topErrors: [string, number][];
      firstError?: string;
    }[];
    const arm = arms[0];
    expect(arm?.repair.total).toBe(QUESTIONS.length);
    expect(arm?.repair.repaired).toBe(QUESTIONS.length);
    expect(arm?.repair.fixedByRepair).toBe(QUESTIONS.length - 1);
    expect(arm?.repair.stillFailing).toBe(1);
    expect(arm?.passed).toBe(QUESTIONS.length - 1);
    // The refusal is reported as a shape failure, not as an execution one: the statement
    // ran, and saying the engine rejected it would name something it never saw.
    expect(arm?.errors.shape).toBe(1);
    // ...and the message that produced it survives into the artifact, ungrouped, because
    // `topErrors` replaces digits and the diagnosis needs the row count.
    expect(arm?.topErrors[0]?.[0]).toContain('shape: the question asks for a single value');
    expect(arm?.firstError).toContain('shape:');
  });

  it('marks a statement the engine rejected as an execution failure, on an arm that cannot repair', async () => {
    const result = await run({ plan: { first: () => 'select count(*) from itemz' }, env: { BIRD_ARMS: 'names' } });
    // Every case is a wrong answer, so the gate refuses the run — but the artifact is
    // written first, and it has to say *why* the answers are wrong.
    expect(result.code).toBe(1);
    const arms = result.report.arms as { errors: { execution: number }; passed: number; topErrors: [string, number][] }[];
    expect(arms[0]?.errors.execution).toBe(QUESTIONS.length);
    expect(arms[0]?.passed).toBe(0);
    expect(arms[0]?.topErrors[0]?.[0]).toMatch(/^execution: /);
  });

  it('compares two candidates one pair at a time when the arm asks for it', async () => {
    const result = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'select-pair' } });
    expect(result.code).toBe(0);
    const arms = result.report.arms as { passed: number; selectorDecided: number }[];
    // Same candidates, same count, k-1 comparisons instead of one ranking: the selector
    // answered, so the comparison path is the one that ran.
    expect(arms[0]?.selectorDecided).toBe(QUESTIONS.length);
    expect(arms[0]?.passed).toBe(QUESTIONS.length);
  });

  it('counts the steps of a decomposed candidate inside a sampling arm', async () => {
    // `select-mixed+dc` takes its fourth candidate from a decomposition, so the funnel has
    // to be counted per candidate rather than per case: one in four asks for steps.
    const result = await run({ plan: { first: correct, steps: true }, env: { BIRD_ARMS: 'select-mixed+dc' } });
    expect(result.code).toBe(0);
    const arms = result.report.arms as {
      decomposition?: { asked: number; fired: number; meanSteps: number };
      candidateRecall: number;
    }[];
    expect(arms[0]?.decomposition?.asked).toBe(QUESTIONS.length);
    expect(arms[0]?.decomposition?.meanSteps).toBeGreaterThan(0);
    expect(arms[0]?.candidateRecall).toBe(QUESTIONS.length);
  });

  it('records the candidates that never arrived beside the ceiling they shrank', async () => {
    // One of three samples is refused on every case. The other two survive, so the arm
    // still scores — and the artifact has to separate "a candidate was wrong" from "a
    // candidate never existed", because the ceiling is taken over the set that did.
    const seen = new Map<string, number>();
    const target = QUESTIONS[4]?.question ?? '';
    const result = await run({
      plan: {
        first: correct,
        // Exactly one candidate of the 21 never arrives. Above ten percent the guard that
        // prices the ceiling refuses the arm, which is the point: a set that lost a third
        // of its candidates is not a measurement of the prompts.
        fail: (request) => {
          const question = Object.keys(GOLD).find((entry) => request.prompt.includes(entry));
          if (question === undefined) return undefined;
          const count = (seen.get(question) ?? 0) + 1;
          seen.set(question, count);
          return question === target && count === 2 ? 500 : undefined;
        },
      },
      env: { BIRD_ARMS: 'vote', BIRD_LLM_RETRIES: '1', BIRD_CONCURRENCY: '1' },
    });
    expect(result.code).toBe(0);
    const arms = result.report.arms as {
      passed: number;
      candidateFailures?: { llm: number; engine: number; unparsed: number; attempted: number };
    }[];
    expect(arms[0]?.candidateFailures).toEqual({ llm: 1, engine: 0, unparsed: 0, attempted: QUESTIONS.length * 3 });
    expect(arms[0]?.passed).toBe(QUESTIONS.length);
  });

  it('counts the steps a decomposed reply wrote, not the instruction it was given', async () => {
    const result = await run({ plan: { first: correct, steps: true }, env: { BIRD_ARMS: 'decompose' } });
    expect(result.code).toBe(0);
    const arms = result.report.arms as {
      arm: string;
      decomposition?: { asked: number; fired: number; share: number; meanSteps: number };
    }[];
    const funnel = arms[0]?.decomposition;
    expect(funnel?.asked).toBe(QUESTIONS.length);
    // Two STEP lines per reply, and every reply carried them: a prompt that asks for steps
    // and gets none is the plain generator with a longer instruction.
    expect(funnel?.fired).toBe(QUESTIONS.length);
    expect(funnel?.share).toBe(1);
    expect(funnel?.meanSteps).toBe(2);
  });
});

describe('an endpoint that is down for one kind of request', () => {
  it('scores an unanswerable selector by the vote, and keeps the ceiling it could not use', async () => {
    // Everything else works: only the selector is refused, and only on the first three questions.
    // This used to escape the vote branch, which erased the case — including the record of what the
    // candidates held — and refused the run at the failure-share gate. The vote had already decided
    // those cases, so they are scored by it and counted separately: an outage is a fact about the
    // endpoint, and a case is a fact about the question, and only one of them was lost.
    const result = await run({
      plan: {
        first: correct,
        fail: (request) =>
          request.prompt.includes('which candidate statement answers the question') &&
          QUESTIONS.slice(0, 3).some((entry) => request.prompt.includes(entry.question))
            ? 500
            : undefined,
      },
      env: { BIRD_ARMS: 'select', BIRD_LLM_RETRIES: '1', BIRD_CONCURRENCY: '1' },
    });
    expect(result.code).toBe(0);
    const arms = result.report.arms as {
      passed: number;
      total: number;
      candidateRecall?: number;
      selectorDecided?: number;
      selectorTotal?: number;
      selectorFailed?: number;
    }[];
    expect(arms[0]?.selectorFailed).toBe(3);
    expect(arms[0]?.selectorDecided).toBe(QUESTIONS.length - 3);
    // The record survives, which is the point: the ceiling is a property of the candidate set, not
    // of the call that failed to read it.
    expect(arms[0]?.candidateRecall).toBe(QUESTIONS.length);
    expect(arms[0]?.passed).toBe(QUESTIONS.length);
    // ...and the line says how much of the accuracy the lever was absent for.
    expect(result.printed.some((line) => line.includes('select-failed 3'))).toBe(true);
  });

  it('records a case whose card never arrived as a failure, not as a crash', async () => {
    // The card is the first call an arm makes, and it was built *outside* the wrapper whose whole
    // job is "one case cannot take the run down" — so a refused card escaped the per-case worker and
    // ended the run with a provider stack trace. It is inside the wrapper now, which means the case
    // is a recorded `llm` failure and the share guard decides what to do with it: on a seven-case
    // fixture one failure is 14.3%, above the 10% this harness treats as an outage, so the arm is
    // refused with the guard's own sentence instead of the provider's.
    const target = QUESTIONS[1]?.question ?? '';
    await expect(
      run({
        plan: {
          first: correct,
          columns: () => 'items.price',
          fail: (request) => (request.prompt.includes('You choose the columns') && request.prompt.includes(target) ? 500 : undefined),
        },
        env: { BIRD_ARMS: 'inline+evidence+llm-select', BIRD_DEFINITIONS_FORCE: '1', BIRD_LLM_RETRIES: '1', BIRD_CONCURRENCY: '1' },
      }),
    ).rejects.toThrow(/arm inline\+evidence\+llm-select: 1 of 7 calls \(14\.3%\) failed at the model, above the 10%/);
  });

  it('refuses a voting arm whose every sample failed at the model', async () => {
    await expect(
      run({
        plan: { fail: () => 500 },
        env: { BIRD_ARMS: 'vote', BIRD_LLM_RETRIES: '1' },
      }),
    ).rejects.toThrow(/every case failed before reaching the database/);
  });

  it('blames the deadline only when every failure is a timeout', async () => {
    // A glm-4.5 run once reported 88% "model failures" that were this deadline. The
    // sentence has to name it, because the fix is a different one from a dead key.
    await expect(
      run({
        // Six of seven questions are answered too slowly, so the failure guard sees an
        // outage below 100% and has to explain it.
        plan: {
          first: correct,
          delayMs: (request) =>
            QUESTIONS.slice(0, 6).some((entry) => request.prompt.includes(entry.question)) ? 400 : undefined,
        },
        env: { BIRD_ARMS: 'names', BIRD_LLM_TIMEOUT_MS: '50', BIRD_LLM_RETRIES: '1' },
      }),
    ).rejects.toThrow(/BIRD_LLM_TIMEOUT_MS.*shorter than the model needs/s);
  });

});

describe('a semantics request that never answers', () => {
  it('carries on with an empty definition block instead of failing the run', async () => {
    // The definitions are an input, and a missing one makes the arm its parent rather than
    // producing a wrong number: the artifact records zero, and the run still finishes.
    const result = await run({
      plan: {
        first: correct,
        fail: (request) =>
          Object.keys(GOLD).some((entry) => request.prompt.includes(entry)) ||
          request.prompt.includes('which candidate statement')
            ? undefined
            : 500,
      },
      // Forced, because the prompt hash is cached on disk: without it this run would read
      // the text an earlier scenario generated and never reach the endpoint at all.
      env: { BIRD_ARMS: 'inline-definitions', BIRD_LLM_RETRIES: '1', BIRD_DEFINITIONS_FORCE: '1' },
    });
    expect(result.code).toBe(0);
    const controls = result.report.controls as {
      synthesizedDefinitionDatabases: number;
      inlineAttached: number;
      definitionsProvenance: Record<string, { source: string }>;
    };
    expect(controls.synthesizedDefinitionDatabases).toBe(0);
    expect(controls.inlineAttached).toBe(0);
    // ...and the failure is in the artifact. Without it the provenance map has no key for
    // the database and a reader cannot tell a decline from an arm that never needed one.
    expect(controls.definitionsProvenance.shop?.source).toMatch(/^failed: /);
  });
});

describe('pinned definitions', () => {
  const pinnedFile = join(root, 'eval', 'baseline', 'definitions.minidev.json');

  it('uses the pinned text, and says it did', async () => {
    mkdirSync(join(root, 'eval', 'baseline'), { recursive: true });
    writeFileSync(
      pinnedFile,
      JSON.stringify({ definitions: { shop: '- items.price: the pinned sentence for the price' } }),
    );
    const result = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'inline-definitions' } });
    expect(result.code).toBe(0);
    const controls = result.report.controls as {
      definitionsProvenance: Record<string, { hash: string; cached: boolean; source: string }>;
      synthesizedDefinitions: Record<string, string>;
    };
    // Regenerating the text per run moved an arm by 5.1pp and made every delta on it a
    // joint measurement of prompt and text. Pinned is the way out, and it is recorded.
    expect(controls.definitionsProvenance.shop).toEqual({ hash: 'pinned', cached: true, source: 'pinned' });
    expect(controls.synthesizedDefinitions.shop).toContain('pinned sentence');
  });

  it('refuses a pinned file that has no entry for a database under test', async () => {
    // The clobbered pin is restored before the test ends. It was not, and the next test in this
    // file that needed synthesis — several describes later — failed with "no entry for shop",
    // which reads as a defect in the runner rather than in the fixture. A test that mutates a
    // file the rest of the file reads is a test whose isolation is an accident of ordering.
    const previous = readFileSync(pinnedFile, 'utf8');
    try {
      writeFileSync(pinnedFile, JSON.stringify({ definitions: { other: '- a sentence for a database nobody runs' } }));
      await expect(run({ plan: { first: correct }, env: { BIRD_ARMS: 'inline-definitions' } })).rejects.toThrow(
        /pinned definitions have no entry for shop/,
      );
    } finally {
      writeFileSync(pinnedFile, previous);
    }
  });

  it('regenerates them when the run is told to, and reaches the model for it', async () => {
    const result = await run({
      plan: { first: correct },
      env: { BIRD_ARMS: 'inline-definitions', BIRD_DEFINITIONS_FORCE: '1' },
    });
    expect(result.code).toBe(0);
    const controls = result.report.controls as {
      definitionsProvenance: Record<string, { source: string; hash: string }>;
    };
    expect(controls.definitionsProvenance.shop?.source).toBe('generated');
    expect(controls.definitionsProvenance.shop?.hash).not.toBe('pinned');
  });
});

describe('a cache it cannot read', () => {
  it('treats a corrupt value index as a miss rather than failing the run', async () => {
    // The cache is an optimisation. A run that refuses to start because of one is a
    // harness that made its own shortcut a precondition.
    const cacheFile = join(root, 'eval', '.cache', 'bird', 'values', 'shop.json');
    mkdirSync(join(root, 'eval', '.cache', 'bird', 'values'), { recursive: true });
    writeFileSync(cacheFile, '{"not":"an index"}');
    // The pinned file left by the previous block has no entry for `shop`, and this run is
    // about the value cache, so it regenerates instead.
    const result = await run({
      plan: { first: correct },
      env: { BIRD_ARMS: 'values', BIRD_DEFINITIONS_FORCE: '1' },
    });
    expect(result.code).toBe(0);
    const controls = result.report.controls as { valueMatches: number };
    // The question that names `pen` is the one a value block can be built for.
    expect(controls.valueMatches).toBe(1);
  });
});

describe('a gold statement that does not run', () => {
  it('excludes the case and counts it, instead of scoring it as a model failure', async () => {
    // The claim this harness rests on: every gold statement is executed before a model is
    // called. A gold that cannot run is a defect in the dataset, and scoring it would
    // report the defect as an accuracy.
    const brokenData = join(root, 'BROKEN');
    mkdirSync(brokenData, { recursive: true });
    writeFileSync(
      join(brokenData, 'mini_dev_sqlite.json'),
      JSON.stringify([
        ...QUESTIONS.slice(0, 2).map((entry) => ({
          question_id: entry.id,
          db_id: 'shop',
          question: entry.question,
          evidence: '',
          SQL: entry.sql,
          difficulty: entry.difficulty,
        })),
        // A statement against a table no fixture has: the shape of a dataset defect, not of
        // a model failure.
        {
          question_id: 99,
          db_id: 'shop',
          question: 'How many invoices are there?',
          evidence: '',
          SQL: 'select count(*) from invoices',
          difficulty: 'simple',
        },
      ]),
    );
    writeFileSync(join(brokenData, 'dev_tables.json'), readFileSync(join(data, 'dev_tables.json')));
    const result = await run({
      plan: { first: correct },
      env: {
        BIRD_DATA: brokenData,
        BIRD_DATABASES: join(data, 'dev_databases'),
        BIRD_ARMS: 'names',
      },
    });
    // Two of three golds ran, so the gate refuses the run: 66.7% is below the 98% a
    // benchmark needs before its accuracy means anything.
    expect(result.code).toBe(1);
    const gold = result.report.gold as {
      executed: number;
      runnable: number;
      runnableRate: number;
      unrunnable: { id: number; db: string; error: string }[];
    };
    expect(gold).toMatchObject({ executed: 3, runnable: 2 });
    expect(gold.runnableRate).toBeCloseTo(2 / 3, 6);
    expect(gold.unrunnable).toHaveLength(1);
    expect(gold.unrunnable[0]?.id).toBe(99);
    expect(gold.unrunnable[0]?.error).toContain('no such table');
    // ...and the exclusion is visible in the controls too, where a stratum join reads it.
    const controls = result.report.controls as { emptyGoldExcluded: number; selfConsistency: number };
    expect(controls.emptyGoldExcluded).toBe(0);
    expect(controls.selfConsistency).toBe(1);
    expect(result.printed.some((line) => line.includes('gold runnable rate 66.7% is below 98%'))).toBe(true);
  });
});

describe('a repair that never lands', () => {
  it('reports the engine\'s refusal as an execution failure, not as a wrong statement', async () => {
    const result = await run({
      plan: { first: () => 'select count(*) from itemz', stubborn: Object.keys(GOLD) },
      // The pinned file written earlier in this file has no entry for `shop`; this run is
      // about the repair funnel, so it regenerates its definitions instead.
      env: { BIRD_ARMS: 'inline+repair', BIRD_DEFINITIONS_FORCE: '1' },
    });
    expect(result.code).toBe(1);
    const arms = result.report.arms as {
      passed: number;
      errors: { execution: number };
      repair: { repaired: number; fixedByRepair: number; stillNotExecuting: number };
      firstError?: string;
    }[];
    // Three repairs were spent and the statement still does not run, so the case is an
    // execution failure: calling it a wrong answer would hide a broken generator behind a
    // score.
    expect(arms[0]?.errors.execution).toBe(QUESTIONS.length);
    expect(arms[0]?.repair.stillNotExecuting).toBe(QUESTIONS.length);
    expect(arms[0]?.repair.fixedByRepair).toBe(0);
    expect(arms[0]?.firstError).toContain('no such table');
  });

  it('reports a statement the guard refused as a guard failure', async () => {
    const result = await run({
      plan: { first: () => 'delete from items', stubborn: Object.keys(GOLD) },
      env: { BIRD_ARMS: 'inline+repair', BIRD_DEFINITIONS_FORCE: '1' },
    });
    expect(result.code).toBe(1);
    const arms = result.report.arms as { errors: { guard: number }; passed: number }[];
    // The prompt is not the problem here: the guard is the thing that stopped it, and the
    // error class says so.
    expect(arms[0]?.errors.guard).toBe(QUESTIONS.length);
    expect(arms[0]?.passed).toBe(0);
  });
});

describe('a dataset that disagrees with its database', () => {
  it('reports the columns it advertised and could not find, and refuses the run', async () => {
    // The failure this guard exists for: the first external run advertised BIRD's humanised
    // names instead of the original ones and 155 of 200 cases died on "no such column". It
    // looked exactly like a model that cannot write SQL.
    const suspect = join(root, 'SUSPECT');
    mkdirSync(suspect, { recursive: true });
    writeFileSync(
      join(suspect, 'mini_dev_sqlite.json'),
      JSON.stringify(
        QUESTIONS.slice(0, 2).map((entry) => ({
          question_id: entry.id,
          db_id: 'shop',
          question: entry.question,
          evidence: '',
          SQL: entry.sql,
          difficulty: entry.difficulty,
        })),
      ),
    );
    const tables = JSON.parse(readFileSync(join(data, 'dev_tables.json'), 'utf8')) as Record<string, unknown>[];
    const shop = tables[0] as {
      column_names: [number, string][];
      column_names_original: [number, string][];
      column_types: string[];
      foreign_keys: [number, number][];
    };
    // One column that only the table file knows about.
    shop.column_names = [[-1, '*'], [0, 'id'], [0, 'name'], [0, 'price'], [0, 'colour'], [1, 'id'], [1, 'item_id'], [1, 'qty']];
    shop.column_names_original = [...shop.column_names];
    shop.column_types = ['text', 'integer', 'text', 'real', 'text', 'integer', 'integer', 'integer'];
    shop.foreign_keys = [[5, 1]];
    writeFileSync(join(suspect, 'dev_tables.json'), JSON.stringify(tables));
    const result = await run({
      plan: { first: correct },
      env: { BIRD_DATA: suspect, BIRD_DATABASES: join(data, 'dev_databases'), BIRD_ARMS: 'names' },
    });
    expect(result.code).toBe(1);
    const controls = result.report.controls as {
      schemaChecked: number;
      schemaMissingTotal: number;
      schemaMissing: { db: string; table: string; column: string }[];
    };
    expect(controls.schemaMissingTotal).toBe(1);
    expect(controls.schemaMissing[0]).toEqual({ db: 'shop', table: 'items', column: 'colour' });
    expect(controls.schemaChecked).toBe(7);
    expect(
      result.printed.some((line) => line.includes('1 of 7 advertised columns do not exist in the database')),
    ).toBe(true);
  });

  it('counts a gold that answers with no rows, which every published split has none of', async () => {
    // `emptyRetry` rests on the claim that no BIRD question has an empty gold result. The
    // count is in the artifact so that claim is measured on every run, not assumed: here
    // the fixture deliberately contains one, and it shows up.
    const empty = join(root, 'EMPTYGOLD');
    mkdirSync(empty, { recursive: true });
    writeFileSync(
      join(empty, 'mini_dev_sqlite.json'),
      JSON.stringify([
        ...QUESTIONS.slice(0, 2).map((entry) => ({
          question_id: entry.id,
          db_id: 'shop',
          question: entry.question,
          evidence: '',
          SQL: entry.sql,
          difficulty: entry.difficulty,
        })),
        {
          question_id: 98,
          db_id: 'shop',
          question: 'Which items are out of stock?',
          evidence: '',
          SQL: 'select id, name from items where id > 100',
          difficulty: 'simple',
        },
      ]),
    );
    writeFileSync(join(empty, 'dev_tables.json'), readFileSync(join(data, 'dev_tables.json')));
    const result = await run({
      plan: { first: correct },
      env: { BIRD_DATA: empty, BIRD_DATABASES: join(data, 'dev_databases'), BIRD_ARMS: 'names' },
    });
    expect(result.code).toBe(0);
    const controls = result.report.controls as { emptyGoldExcluded: number; negativeChecked: number };
    expect(controls.emptyGoldExcluded).toBe(1);
    // The negative control only runs over golds that returned something: an empty gold
    // cannot be told apart from an empty statement.
    expect(controls.negativeChecked).toBe(2);
  });

  it('refuses a database the table file does not describe', async () => {
    await expect(
      run({ plan: { first: correct }, env: { BIRD_DBS: 'shop,nowhere', BIRD_ARMS: 'names' } }),
    ).rejects.toThrow(/dev_tables.json has no entry for nowhere/);
  });
});

describe('a voting arm whose statements never execute', () => {
  it('reports that no sample survived, and does not call the endpoint an outage', async () => {
    // Three samples, three statements the engine refuses. Nothing reached the database — but
    // the model answered every call, so this is not an outage: the arm scores zero and the
    // gate refuses it, and the error class says `other` rather than `llm`.
    const result = await run({
      plan: { first: () => 'select count(*) from itemz' },
      env: { BIRD_ARMS: 'vote', BIRD_DEFINITIONS_FORCE: '1' },
    });
    expect(result.code).toBe(1);
    const arms = result.report.arms as { passed: number; errors: { other: number; llm: number }; candidateRecall: number }[];
    expect(arms[0]?.passed).toBe(0);
    expect(arms[0]?.errors.other).toBe(QUESTIONS.length);
    expect(arms[0]?.errors.llm).toBe(0);
    // The ceiling is zero because the set was empty, not because the statements were wrong.
    expect(arms[0]?.candidateRecall).toBe(0);
  });
});

/**
 * A question file that names one question twice.
 *
 * Mini-Dev is such a file: ids 137 and 138 appear twice, byte for byte, so 500 rows are 498
 * questions. The runner scored the repeats as two questions for as long as the file has been read
 * as a list, which weights one arbitrary question twice and makes the denominator a property of
 * the file layout. This drives the whole harness to show the two facts that follow: the duplicate
 * is asked once, and the artifact says how many rows it read and what it collapsed.
 */
describe('a question file that carries a duplicate row', () => {
  it('asks it once and prints the shape of the file above the rates', async () => {
    const file = join(data, 'mini_dev_sqlite.json');
    const rows = JSON.parse(readFileSync(file, 'utf8')) as { question_id: number }[];
    // Two repeats, appended exactly as Mini-Dev appends its own: the same record again.
    writeFileSync(file, JSON.stringify([...rows, rows[0], rows[3]]));
    try {
      const result = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'names' } });
      const selection = result.report.selection as {
        rows: number;
        available: number;
        repeats: number[];
        scored: number;
        requested: number;
        sampled: boolean;
      };
      expect(selection.rows).toBe(QUESTIONS.length + 2);
      expect(selection.available).toBe(QUESTIONS.length);
      expect(selection.repeats).toEqual([1, 4]);
      // One case per question, not per row: the duplicate is not asked a second time.
      expect(selection.scored).toBe(QUESTIONS.length);
      expect((result.report.cases as unknown[]).length).toBe(QUESTIONS.length);
      // A whole-pool run, not a sample: the two counts `scored < available` used to conflate are
      // separate fields now, and this run is the case where they disagree without sampling.
      expect(selection.sampled).toBe(false);
      expect(result.printed.some((line) => line.startsWith(`minidev: ${String(QUESTIONS.length + 2)} row(s), ${String(QUESTIONS.length)} question(s)`))).toBe(true);
      expect(result.printed.some((line) => line.includes('1, 4 repeat byte-for-byte and are counted once'))).toBe(true);
    } finally {
      writeFileSync(file, JSON.stringify(rows));
    }
  });
});

/**
 * A sampled run of an arm whose prompts are built from several sources.
 *
 * `assertMixedFeasible` refuses a whole-split run whose candidates are never distinct — an arm that
 * pays three times for one opinion — and on a sample it returns a note instead, because a share of
 * a sample describes the sample. That distinction used to be drawn from `cases.length`, so a full
 * run that lost two cases to a refused gold statement was read as a sample and the refusal never
 * fired. `selected.length` is the question the guard actually asks.
 */
describe('a sample of an arm that builds several candidates', () => {
  it('records that the run sampled the split, and says the degeneracy share describes the sample', async () => {
    const result = await run({
      plan: { first: correct },
      env: { BIRD_ARMS: 'select-mixed', BIRD_LIMIT: '4', BIRD_DEFINITIONS_FORCE: '1' },
    });
    const selection = result.report.selection as { requested: number; scored: number; available: number; sampled: boolean };
    expect(selection.requested).toBe(4);
    expect(selection.scored).toBe(4);
    expect(selection.available).toBe(QUESTIONS.length);
    expect(selection.sampled).toBe(true);
    const mixed = result.report.mixedCandidatePrompts as { arm: string; sampled: boolean; note?: string }[];
    expect(mixed[0]?.sampled).toBe(true);
    expect(mixed[0]?.note).toContain('this run sampled the split');
  });
});

/**
 * The arm that lets the model name the columns, driven through the endpoint.
 *
 * Two numbers make this arm admissible and neither can be asserted from a schema object: the
 * choice is charged as a call (the selector's own metering bug was exactly this, caught by the
 * gate on the next run), and the prompt the model then reads is the reduced card. The second is
 * read off the requests the endpoint actually received, because "the card was reduced" is a claim
 * about text a model saw.
 */
describe('an arm where the model chooses the columns', () => {
  /** The arm rows, as the artifact states them. */
  interface Row {
    readonly arm: string;
    readonly calls: { readonly mean: number };
    readonly columnSelection?: {
      readonly cases: number;
      readonly decided: number;
      readonly cardShare: number;
      readonly restored?: number;
    };
    readonly tokens?: { readonly byPurpose?: Readonly<Record<string, { readonly calls: number }>> };
  }
  /** The schema card line a table would have, in the renderer's own format. */
  const tableLine = (prompt: string, table: string): boolean => new RegExp('^' + table + '\\(', 'm').test(prompt);
  /** The generation prompts, as opposed to the choice prompts that also carry the question. */
  const generatePrompts = (requests: readonly EndpointRequest[], question: string): string[] =>
    requests.map((request) => request.prompt).filter((prompt) => prompt.includes(question) && !prompt.includes('You choose the columns'));

  it('charges the choice as one call and sends the card it produced', async () => {
    const question = QUESTIONS[0]?.question ?? '';
    // One arm per run: both arms send the same question, so a shared request log cannot say
    // which of them sent the prompt that still names `orders`.
    const lever = await run({
      plan: { first: correct, columns: () => 'items.price' },
      env: { BIRD_ARMS: 'inline+evidence+llm-select', BIRD_DEFINITIONS_FORCE: '1' },
    });
    expect(lever.code).toBe(0);
    const row = (lever.report.arms as Row[])[0];
    // The lever's own call, counted where the generation it precedes is counted.
    expect(row?.calls.mean).toBe(2);
    // ...and filed under its own purpose, so the arm's bill can be read per kind of call.
    expect(row?.tokens?.byPurpose?.columns?.calls).toBe(1);
    expect(row?.columnSelection).toMatchObject({ cases: QUESTIONS.length, decided: QUESTIONS.length });
    expect(row?.columnSelection?.cardShare).toBeLessThan(1);
    // The card the model read is the one the choice produced: `orders` is gone from the prompt.
    const reduced = generatePrompts(lever.requests, question);
    expect(reduced.length).toBeGreaterThan(0);
    expect(reduced.some((prompt) => tableLine(prompt, 'items'))).toBe(true);
    expect(reduced.some((prompt) => tableLine(prompt, 'orders'))).toBe(false);

    const parent = await run({
      plan: { first: correct },
      env: { BIRD_ARMS: 'inline+evidence', BIRD_DEFINITIONS_FORCE: '1' },
    });
    const parentRow = (parent.report.arms as Row[])[0];
    expect(parentRow?.calls.mean).toBe(1);
    // The same questions on the parent still send both tables, so the reduction above belongs to
    // the choice rather than to the fixture.
    expect(generatePrompts(parent.requests, question).some((prompt) => tableLine(prompt, 'orders'))).toBe(true);
  });

  it('sends the whole card and says so when no name resolves', async () => {
    const question = QUESTIONS[0]?.question ?? '';
    const result = await run({
      plan: { first: correct, columns: () => 'I am not sure, please decide.' },
      env: { BIRD_ARMS: 'inline+evidence+llm-select', BIRD_DEFINITIONS_FORCE: '1' },
    });
    expect(result.code).toBe(0);
    const row = (result.report.arms as Row[])[0];
    expect(row?.columnSelection).toMatchObject({ cases: QUESTIONS.length, decided: 0, cardShare: 1 });
    const prompts = generatePrompts(result.requests, question);
    expect(prompts.some((prompt) => tableLine(prompt, 'orders'))).toBe(true);
    // Two calls either way: a reply that resolves nothing is not a call refunded.
    expect(row?.calls.mean).toBe(2);
  });

  it('keeps the table the same reply deletes above, and reports the columns it put back', async () => {
    const question = QUESTIONS[0]?.question ?? '';
    // The same reply, the same call: only the application rule differs, which is the whole claim
    // the pair makes. `items.price` above removed `orders` from the prompt; here it keeps it.
    const result = await run({
      plan: { first: correct, columns: () => 'items.price' },
      env: { BIRD_ARMS: 'inline+evidence+llm-select-dense', BIRD_DEFINITIONS_FORCE: '1' },
    });
    expect(result.code).toBe(0);
    const row = (result.report.arms as Row[])[0];
    expect(generatePrompts(result.requests, question).some((prompt) => tableLine(prompt, 'orders'))).toBe(true);
    expect(row?.calls.mean).toBe(2);
    expect(row?.columnSelection?.cardShare).toBeLessThan(1);
    // Three columns of `orders` on each of seven questions: the safety net is counted, not asserted
    // to exist. The fixture's tables are all narrower than the floor, so this number is the
    // dropped-table half of the rule and the pad loop is priced by the unit cases instead.
    expect(row?.columnSelection?.restored).toBe(3 * QUESTIONS.length);
  });

  it('previews the card before the choice, and labels it as such', async () => {
    // A dry run spends no calls, so it cannot show the card a model would choose. Presenting the
    // unpruned card as the sent prompt would be the drift the runner exists to prevent.
    const result = await run({
      plan: { first: correct },
      argv: ['--dry-run'],
      env: { BIRD_ARMS: 'inline+evidence+llm-select' },
    });
    expect(result.code).toBe(0);
    expect(result.requests).toHaveLength(0);
    const prompts = result.report.prompts as { arms: { arm: string; card?: string }[] }[];
    expect(prompts[0]?.arms[0]?.card).toBe('before-column-selection');
  });
});

/**
 * The two samplers, driven through the endpoint, on the same questions.
 *
 * The lever is one card field away from the parent, so what has to be shown is that the two
 * rules put *different* information on that field: our profiler shows a categorical column and
 * stops, the competitor's rule also shows a small numeric dictionary, marks nullability and
 * drops keys. Neither claim can be read off a schema object — they are claims about the text a
 * model received — so the assertions read the request log.
 */
describe('an arm whose card carries the competitor\'s value examples', () => {
  /** The arm rows, as the artifact states them. */
  interface Row {
    readonly arm: string;
    readonly calls: { readonly mean: number };
    readonly tokens?: { readonly prompt?: { readonly mean: number } };
  }
  /** The line a table occupies on the card, in the renderer's own format. */
  const tableLineOf = (prompt: string, table: string): string | undefined =>
    prompt.split('\n').find((line) => line.startsWith(`${table}(`));

  it('shows a small numeric dictionary the profiler never shows', async () => {
    const question = QUESTIONS[0]?.question ?? '';
    const result = await run({
      plan: { first: correct },
      env: { BIRD_ARMS: 'inline+evidence+samples,inline+evidence+samples-wide', BIRD_DEFINITIONS_FORCE: '1' },
    });
    expect(result.code).toBe(0);
    const prompts = result.requests.map((request) => request.prompt).filter((prompt) => prompt.includes(question));
    const items = prompts.map((prompt) => tableLineOf(prompt, 'items')).filter((line): line is string => line !== undefined);
    expect(items.length).toBeGreaterThan(0);
    // `price` has two distinct values in the fixture, which their rule shows and ours does not:
    // the profile calls a numeric column a measure and keeps a range instead of a dictionary.
    expect(items.some((line) => /price DOUBLE \[1\.5\|3\.25\]/.test(line))).toBe(true);
    // The categorical column is on both cards, so the lever is the rule and not the bracket.
    expect(items.some((line) => /name VARCHAR \[pen\|cup\]/.test(line))).toBe(true);
    expect(items.filter((line) => /name VARCHAR \[pen\|cup\]/.test(line))).toHaveLength(items.length);
    // The two arms cost the same number of calls: this is a prompt lever, not a plan.
    const rows = result.report.arms as Row[];
    expect(rows.map((row) => row.calls.mean)).toEqual([1, 1]);
  });

  it('keeps a primary key off the card, as their selector does', async () => {
    const question = QUESTIONS[0]?.question ?? '';
    const result = await run({
      plan: { first: correct },
      env: { BIRD_ARMS: 'inline+evidence+samples-wide', BIRD_DEFINITIONS_FORCE: '1' },
    });
    expect(result.code).toBe(0);
    const prompt = result.requests.map((request) => request.prompt).find((text) => text.includes(question));
    expect(prompt).toBeDefined();
    const items = tableLineOf(prompt as string, 'items') as string;
    // `items.id` is the primary key: their rule skips keys by identity, and a key's values are
    // identifiers rather than a dictionary.
    expect(items).not.toContain('id INTEGER [');
    // The foreign key on the other side of the join is skipped the same way.
    const orders = tableLineOf(prompt as string, 'orders') as string;
    expect(orders).not.toContain('item_id INTEGER [');
    expect(orders).toContain('qty BIGINT [');
  });

  it('refuses to publish a samples arm whose card carries none', () => {
    // An empty block is the parent renamed, and a delta of 0.0pp with every gate green is the
    // shape this repository keeps finding. The gate is a pure function of the count the runner
    // took, so it is asserted directly: driving an empty block through a run would mean a
    // database the sampler cannot read, which the runner refuses several steps earlier.
    expect(() => assertSamplesRan('inline+evidence+samples', { columns: 0, values: 0 })).toThrow('its parent renamed');
    // A block with columns but no values is the same shape: a bracket rendered empty says
    // nothing and costs the characters of a bracket.
    expect(() => assertSamplesRan('inline+evidence+samples', { columns: 3, values: 0 })).toThrow('its parent renamed');
    expect(() => assertSamplesRan('inline+evidence+samples', { columns: 3, values: 9 })).not.toThrow();
  });
});

describe('the agreement the selector cannot compute', () => {
  /** The selector's requests, identified by the sentence only it is asked. */
  const selectorPrompts = (requests: readonly EndpointRequest[]): string[] =>
    requests.map((request) => request.prompt).filter((prompt) => prompt.includes('which candidate statement answers the question'));

  it('marks the duplicate on the arm that shows it and leaves its parent untouched', async () => {
    // Every source answers correctly, so all three candidates return the same rows: the shape
    // in which the universe of marks is "1 distinct result". The parent is run against the same
    // plan for the same reason — the claim is that the prompts differ by the marks and by
    // nothing else, which needs both prompts in the same test.
    const marked = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'select-mixed+agree' } });
    const plain = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'select-mixed' } });
    expect(marked.code).toBe(0);
    expect(plain.code).toBe(0);

    const withMarks = selectorPrompts(marked.requests);
    const without = selectorPrompts(plain.requests);
    expect(withMarks).toHaveLength(QUESTIONS.length);
    expect(without).toHaveLength(QUESTIONS.length);

    // The header counts the distinct results, the duplicate is pointed at the candidate it
    // duplicates, and the third candidate carries no mark — the absence is half the signal.
    expect(withMarks[0]).toContain('These 3 candidates returned 1 distinct results; identical results are marked.');
    expect(withMarks[0]).toContain('same result as candidate 1');
    expect(withMarks[0]).not.toContain('same result as candidate 2');
    expect(withMarks[0]).toContain('Agreement is evidence, not proof');

    // The parent is the control: same candidates, same count, same calls, no marks. If this
    // ever prints the block, the arm is no longer one lever from `select-mixed`.
    expect(without[0]).not.toContain('distinct results');
    expect(without[0]).not.toContain('Agreement is evidence');
  });

  it('spends no call on the marks and keeps the same four-call price', async () => {
    const result = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'select-mixed+agree' } });
    expect(result.code).toBe(0);
    const arms = result.report.arms as {
      arm: string;
      total: number;
      tokens?: { byPurpose?: Record<string, { calls: number }> };
    }[];
    const row = arms[0];
    expect(row?.arm).toBe('select-mixed+agree');
    // Three generations and one selector per case, and no third kind of call: the marks are
    // computed from rows the arm had already executed. An arm that charges for them would be
    // charging for reading its own artifact.
    expect(row?.total).toBe(QUESTIONS.length);
    // Three generations and one selector per case, and no third kind of call: the marks are
    // computed from rows the arm had already executed. An arm that charged for them would be
    // charging for reading its own artifact.
    expect(row?.tokens?.byPurpose).toMatchObject({ generate: { calls: 3 }, select: { calls: 1 } });
    expect(Object.keys(row?.tokens?.byPurpose ?? {}).sort()).toEqual(['generate', 'select']);
  });
});

/**
 * The engine's answer, delivered to the model that wrote the statement.
 *
 * `select-cross` executes each candidate after the fact, so a statement the engine refuses is
 * dropped and the ceiling falls by one without any model being told why. `sourceRepairs` is the
 * channel that closes that loop, and it is per source because the whole question behind it is
 * whether a stronger model does more with the same feedback than a weaker one. A declaration is
 * not a mechanism, so the assertion is not "the arm carries the field" but "the retry request
 * arrived at one endpoint and not the other".
 */
describe('the repair turn, granted per source', () => {
  const target = QUESTIONS[0]?.question ?? '';
  const brokenSql = 'select count(*) from itemz';

  /** An endpoint that writes a statement the engine refuses, then the gold one when told why. */
  const replyingSecond = async (): Promise<Awaited<ReturnType<typeof startEndpoint>>> =>
    startEndpoint({
      reply: (request) => {
        if (request.prompt.includes('which candidate statement answers the question')) return '1';
        // A turn that names the engine's message: the repair. Answering it correctly is what
        // makes the correction visible in the score rather than only in the request count.
        if (request.prompt.includes('no such table')) {
          const asked = Object.keys(GOLD).find((entry) => request.prompt.includes(entry)) ?? '';
          return fenced(GOLD[asked] ?? 'select 1');
        }
        const asked = Object.keys(GOLD).find((entry) => request.prompt.includes(entry));
        if (asked === undefined) return DEFINITIONS;
        return fenced(asked === target ? brokenSql : (GOLD[asked] ?? 'select 1'));
      },
    });

  it('sends the retry to the reasoning model and to no other candidate', async () => {
    const second = await replyingSecond();
    try {
      const result = await run({
        plan: { first: correct },
        env: {
          BIRD_ARMS: 'select-cross-repair-second',
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
        },
      });
      expect(result.code).toBe(0);
      // One repair in the whole run, and it went to the endpoint whose source was named.
      const repairsHere = second.requests.filter((request) => request.prompt.includes('no such table'));
      const repairsThere = result.requests.filter((request) => request.prompt.includes('no such table'));
      expect(repairsHere).toHaveLength(1);
      expect(repairsThere).toHaveLength(0);
      // The candidate survived because it was rewritten, not because the first statement ran:
      // the arm's ceiling is what a repair is worth, and it can only rise if the retry landed.
      const arms = result.report.arms as { arm: string; candidateRecall: number }[];
      expect(arms[0]?.candidateRecall).toBe(QUESTIONS.length);
    } finally {
      await second.close();
    }
  });

  it('reaches the other two candidates when the arm grants it to all of them', async () => {
    // The same failure with a wider grant: two primary-endpoint candidates now also see the
    // engine's message. Without this case, a `sourceRepairs` lookup that only matched the second
    // endpoint would look identical to a working one.
    const second = await replyingSecond();
    try {
      const result = await run({
        plan: { first: () => brokenSql },
        env: {
          BIRD_ARMS: 'select-cross-repair-all',
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
        },
      });
      expect(result.code).toBe(0);
      const repairsThere = result.requests.filter((request) => request.prompt.includes('no such table'));
      // Two primary sources fail on every question, so the primary endpoint must have been told
      // why on at least one of them — and the count is per question, not per arm.
      expect(repairsThere.length).toBeGreaterThanOrEqual(QUESTIONS.length);
    } finally {
      await second.close();
    }
  });
});

/**
 * Reconcile: the same pool and the same one call, asked for a statement instead of an index.
 *
 * The lever's premise is narrow and testable: an index cannot name an answer none of the candidates
 * contains, and on this pool the correct statement is in the set on 70.5% of cases while the arm
 * scores 64%. So the three things the suite has to pin are (1) a statement that runs becomes the
 * answer, (2) a statement that does not run leaves the vote's answer standing and is reported, and
 * (3) a turn that never came back is an outage rather than a disagreement — the same three-way
 * distinction the adjudication fix taught the selector.
 */
describe('the reconcile arm', () => {
  const arms = 'select-cross,select-cross-pooled,select-cross-pooled-reconcile';

  it('answers with the statement the model wrote, and says it was new', async () => {
    // `count(items.id)` returns the same rows as the gold `count(*)` on this fixture and appears in
    // none of the candidates, which is exactly the shape the lever exists for: a correct statement
    // nobody wrote. Counting rows is `judgeOfficial`, so the arm passes on a statement it composed.
    const second = await startEndpoint({ reply: (request) => replyFor(request, { first: correct }) });
    try {
      const result = await run({
        // Every reply is a statement no candidate wrote and every one runs: the first case is the
        // shape the lever exists for (a count written another way), and the rest are the gold
        // statement wrapped in a subquery so the reply is novel without being wrong — a lever
        // measured on statements that do not answer the question would be measuring nothing.
        plan: {
          first: correct,
          reconcile: (question) => (question === (QUESTIONS[0]?.question ?? '') ? 'select count(items.id) from items' : `select * from (${GOLD[question] ?? 'select 1'}) as reconciled`),
        },
        env: {
          BIRD_ARMS: arms,
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
          BIRD_CONCURRENCY: '1',
        },
      });
      expect(result.code, result.printed.join('\n')).toBe(0);
      const byName = new Map(
        (result.report.arms as { arm: string; passed: number; calls: { mean: number }; reconcile?: Record<string, number>; sources?: Record<string, number> }[]).map(
          (entry) => [entry.arm, entry],
        ),
      );
      const arm = byName.get('select-cross-pooled-reconcile');
      // Seven cases, seven statements written, seven of them new, all seven executed and adopted.
      expect(arm?.reconcile).toEqual({ policy: 'always', asked: QUESTIONS.length, returned: QUESTIONS.length, novel: QUESTIONS.length, executable: QUESTIONS.length, adopted: QUESTIONS.length });
      // One call per case: the same price as the selector it replaces, which is what makes the pair
      // a comparison of output formats rather than of budgets.
      expect(arm?.calls.mean).toBe(1);
      // The tally says where the answers came from, and the reconciler is a source in it.
      expect(arm?.sources?.['reconcile']).toBe(QUESTIONS.length);
      if (arm !== undefined) expect(arm.passed).toBeGreaterThan(0);
    } finally {
      await second.close();
    }
  });

  it('keeps the vote\'s answer when the statement it wrote cannot run, and reports the loss', async () => {
    // A statement the engine refuses is not an answer. Falling back to the modal result is the
    // honest reading — the arm still answered — but an artifact that showed only the score would
    // make "reconciled and could not run" indistinguishable from "reconciled, ran, and was wrong".
    const second = await startEndpoint({ reply: (request) => replyFor(request, { first: correct }) });
    try {
      const result = await run({
        plan: { first: correct, reconcile: broken },
        env: {
          BIRD_ARMS: arms,
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
          BIRD_CONCURRENCY: '1',
        },
      });
      expect(result.code).toBe(0);
      const byName = new Map(
        (result.report.arms as { arm: string; passed: number; reconcile?: Record<string, number>; errors?: { execution: number } }[]).map((entry) => [entry.arm, entry]),
      );
      const arm = byName.get('select-cross-pooled-reconcile');
      expect(arm?.reconcile).toEqual({ policy: 'always', asked: QUESTIONS.length, returned: QUESTIONS.length, novel: QUESTIONS.length, executable: 0, adopted: 0 });
      // The candidates were all correct, so the vote still answers every case: the fallback is not
      // a penalty, it is the free rule standing in for a statement that could not be run.
      expect(arm?.passed).toBe(QUESTIONS.length);
    } finally {
      await second.close();
    }
  });

  it('counts a reconcile turn that never came back as an outage, not as a disagreement', async () => {
    // The endpoint refuses the reconcile prompt only. The case is still answered — by the vote, which
    // is what the arm would have fallen back to anyway — and `selectionFailed` says the paid half of
    // the arm did not run. Without it, an endpoint that refuses every reconcile call would publish
    // the free aggregator's accuracy under a lever's name.
    const second = await startEndpoint({ reply: (request) => replyFor(request, { first: correct }) });
    try {
      const result = await run({
        plan: {
          first: correct,
          fail: (request) => (request.prompt.includes('Write the statement that answers the question') ? 503 : undefined),
        },
        env: {
          BIRD_ARMS: arms,
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
          BIRD_CONCURRENCY: '1',
          // Seven refusals with the provider's backoff cost twenty seconds and measure nothing the
          // three assertions below need; the retry path has its own suite.
          BIRD_LLM_RETRIES: '0',
        },
      });
      expect(result.code).toBe(0);
      const arms2 = result.report.arms as { arm: string; passed: number; reconcile?: Record<string, number> }[];
      const arm = arms2.find((entry) => entry.arm === 'select-cross-pooled-reconcile');
      expect(arm?.reconcile).toEqual({ policy: 'always', asked: QUESTIONS.length, returned: 0, novel: 0, executable: 0, adopted: 0 });
      // The outage is the endpoint's, and the arm says so in the column that exists for it: every
      // case still answered (by the vote), and every paid turn reported as one that did not run.
      expect(result.printed.some((line) => line.startsWith('select-cross-pooled-reconcile') && line.includes(`select-failed ${String(QUESTIONS.length)}`))).toBe(true);
      expect(arm?.passed).toBe(QUESTIONS.length);
    } finally {
      await second.close();
    }
  });

  it('hands a restatement back to the vote, and prices the statements nobody wrote', async () => {
    // The fifth dispatch's loss, staged on seven cases: the second model's candidate is wrong, the
    // vote answers with the primary's two, and the reconcile turn restates the wrong one. An arm
    // that adopts whatever it can run replaces a correct answer with a paraphrase of a candidate it
    // had already outvoted — which is what `41453395203` read as 359 of 600 against the free
    // count's 380, with 514 of its 600 replies restating a candidate. The `-novel` arm is the same
    // prompt and the same call with the restatements handed back, so the distance between the two
    // rows is the policy and nothing else.
    const plan = { first: correct, reconcile: () => IMPOSSIBLE };
    const second = await startEndpoint({ reply: (request) => replyFor(request, { first: () => IMPOSSIBLE }) });
    try {
      const result = await run({
        plan,
        env: {
          BIRD_ARMS: `${arms},select-cross-pooled-reconcile-novel`,
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
          BIRD_CONCURRENCY: '1',
        },
      });
      expect(result.code, result.printed.join('\n')).toBe(0);
      const byName = new Map(
        (
          result.report.arms as {
            arm: string;
            passed: number;
            spend?: Record<string, number>;
            sources?: Record<string, number>;
            reconcile?: Record<string, number>;
          }[]
        ).map((entry) => [entry.arm, entry]),
      );
      const always = byName.get('select-cross-pooled-reconcile');
      const novel = byName.get('select-cross-pooled-reconcile-novel');
      // Neither arm wrote a statement of its own — every reply restated the second model's
      // candidate — so the two funnels differ in exactly one column.
      const restated = { asked: QUESTIONS.length, returned: QUESTIONS.length, novel: 0, executable: QUESTIONS.length };
      expect(always?.reconcile, 'the adopting arm scores every reply it can run').toEqual({ ...restated, policy: 'always', adopted: QUESTIONS.length });
      expect(novel?.reconcile, 'the handing-back arm scores none of them').toEqual({ ...restated, policy: 'novel', adopted: 0 });
      // The policy is the whole difference in the score: the adopting arm overwrites seven correct
      // answers, the handing-back arm keeps them, and no candidate, prompt or call changed.
      expect(always?.passed).toBe(0);
      expect(novel?.passed).toBe(QUESTIONS.length);
      expect(always?.sources?.['reconcile']).toBe(QUESTIONS.length);
      expect(novel?.sources?.['reconcile']).toBe(0);
      // A handed-back reply is still a call that was spent: the bill must not follow the policy, or
      // the arm would look cheaper for having wasted the turn.
      expect(novel?.spend).toEqual({ asked: QUESTIONS.length, priced: QUESTIONS.length });
      // And the per-case rows say which cases, because a funnel can only say how many — the archive
      // is what a later reading needs to pair a case's outcome with the reply that produced it.
      const rows = (result.report.cases as { arm: string; id: string; passed: boolean; reconcile?: Record<string, boolean> }[]).filter(
        (row) => row.arm === 'select-cross-pooled-reconcile-novel',
      );
      expect(rows).toHaveLength(QUESTIONS.length);
      for (const row of rows) {
        expect(row.reconcile).toEqual({ returned: true, novel: false, executable: true, adopted: false });
        expect(row.passed).toBe(true);
      }
    } finally {
      await second.close();
    }
  });
});

/**
 * The value block narrowed to the columns the gold statement filters on.
 *
 * The block measured +38.4% characters a case when every profiled column carried one and +1.4%
 * when only the filtered columns do, so the rule that decides the set is the difference between a
 * block that can be afforded and one that cannot. Two claims need a real run: that the narrowed
 * card carries the bracket on the filtered column and on no other, and that the artifact counts
 * the cases where the rule kept nothing — a statement with no condition has no column to narrow
 * to, and an arm that reported its accuracy without that count could not be told from one whose
 * rule selected nothing anywhere.
 *
 * The chain fixture is the one that can show it: its third question filters `cities.name` to a
 * stored spelling, so the block has a column to reach, and its first two questions filter on
 * nothing, so the empty case is populated by the same run.
 */
describe('a value block narrowed to the columns the statement filters on', () => {
  const chainRoot = mkdtempSync(join(tmpdir(), 'bird-samples-gold-'));
  afterAll(() => {
    rmSync(chainRoot, { recursive: true, force: true });
  });
  const chainData = writeChainBirdDataset(chainRoot);
  const chainGold: Readonly<Record<string, string>> = Object.fromEntries(
    CHAIN_QUESTIONS.map((entry) => [entry.question, entry.sql]),
  );
  /** The line a table occupies on the card, in the renderer's own format. */
  const tableLineOf = (prompt: string, table: string): string | undefined =>
    prompt.split('\n').find((line) => line.startsWith(`${table}(`));

  it('keeps the bracket on the filtered column and drops it from the rest', async () => {
    const result = await run({
      plan: { gold: chainGold },
      env: {
        BIRD_DATA: chainData,
        BIRD_ARMS: 'inline+evidence+samples,inline+evidence+samples-gold',
        BIRD_DEFINITIONS_FORCE: '1',
      },
    });
    expect(result.code).toBe(0);
    const asked = CHAIN_QUESTIONS[2]?.question as string;
    // One prompt per arm for that question: the parent sends every profiled column's values, the
    // narrowed arm only the one its statement filters on.
    const prompts = result.requests.map((request) => request.prompt).filter((prompt) => prompt.includes(asked));
    const items = prompts.map((prompt) => tableLineOf(prompt, 'items')).filter((line): line is string => line !== undefined);
    const cities = prompts.map((prompt) => tableLineOf(prompt, 'cities')).filter((line): line is string => line !== undefined);
    expect(items.length).toBeGreaterThan(0);
    expect(cities.length).toBeGreaterThan(0);
    // `cities.name` is the filtered column, so both cards show it: the lever is the *set*, not
    // the bracket, and an arm that also narrowed this column away would be measuring nothing.
    expect(cities.every((line) => line.includes('name VARCHAR ['))).toBe(true);
    // `items.name` is profiled and not filtered. The parent shows it, the narrowed arm does not —
    // read as "one card carries the bracket and one does not" rather than as a value list, because
    // the claim is about which columns carry a bracket and not about the order inside it.
    expect(items.some((line) => line.includes('name VARCHAR ['))).toBe(true);
    expect(items.some((line) => !line.includes('name VARCHAR ['))).toBe(true);

    const rows = result.report.arms as {
      readonly arm: string;
      readonly sampleBlock?: { readonly cases: number; readonly withValues: number; readonly columns: number; readonly empty: number };
    }[];
    const byName = new Map(rows.map((row) => [row.arm, row]));
    // Every case of the run is counted, and the two with no condition are the empty column — the
    // count D56 asks for, because "the rule kept nothing" and "the rule was not measured" are the
    // same number and opposite findings.
    expect(byName.get('inline+evidence+samples-gold')?.sampleBlock).toEqual({ cases: 3, withValues: 1, columns: 1, empty: 2 });
    // The parent's block is the same sampler over every profiled column: the two rows differ in
    // one number, and it is the one the cost claim is about.
    const parent = byName.get('inline+evidence+samples')?.sampleBlock;
    expect(parent?.cases).toBe(3);
    expect(parent?.columns ?? 0).toBeGreaterThan(1);
  });
});

/**
 * A mixed candidate set draws its blocks from its sources, not from the arm list.
 *
 * `select-samples` takes its third candidate from `inline+evidence+samples`, and the run's block
 * loaders used to ask `BIRD_ARMS` which blocks to build. No arm in that list declares `samples`,
 * so the profile's value lists were never attached, the third prompt came out byte-identical to
 * the first, and `assertMixedFeasible` refused the whole run on 1,532 questions for an arm that
 * was in fact three prompts. The narrow question was the defect; this scenario is the reading
 * that catches it, because it needs the third prompt to carry a bracket it can only get from a
 * block that was loaded.
 *
 * The chain fixture is the one with a stored spelling on a profiled column: `items.name` and
 * `cities.name` both carry one, so every question in it can show the third prompt.
 */
describe('a mixed set whose third source carries a block of its own', () => {
  const mixedRoot = mkdtempSync(join(tmpdir(), 'bird-mixed-blocks-'));
  afterAll(() => {
    rmSync(mixedRoot, { recursive: true, force: true });
  });
  const mixedData = writeChainBirdDataset(mixedRoot);
  const mixedGold: Readonly<Record<string, string>> = Object.fromEntries(
    CHAIN_QUESTIONS.map((entry) => [entry.question, entry.sql]),
  );

  it('sends each candidate on the card of its own source, which is what the arm claims', async () => {
    // The failure this pairs with: `select-mixed` called itself three prompts while the run built
    // one card and printed all three on it, so `metadata+evidence` — descriptions as a block, joins
    // listed — arrived as a copy of `inline+evidence`. The card is the difference, and it is
    // visible in the prompt: the inline card carries its descriptions on the column line, the
    // plain card carries joins underneath.
    // The mini fixture rather than the chain one: `select-mixed`'s third source is the value index,
    // which only differs on a question that names a literal, and this fixture has one (`pen`).
    const result = await run({ plan: { gold: GOLD }, env: { BIRD_ARMS: 'select-mixed' } });
    expect(result.code).toBe(0);
    const asked = QUESTIONS[0]?.question as string;
    const prompts = result.requests.filter((request) => request.prompt.includes(asked)).map((request) => request.prompt);
    expect(prompts.some((prompt) => prompt.includes('name VARCHAR -- '))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes('join: orders.item_id = items.id'))).toBe(true);
  });

  it('loads the block its source asks for, so three sources are three prompts', async () => {
    const result = await run({
      plan: { gold: mixedGold },
      env: { BIRD_DATA: mixedData, BIRD_ARMS: 'select-samples', BIRD_DEFINITIONS_FORCE: '1' },
    });
    expect(result.code).toBe(0);
    const mixed = result.report.mixedCandidatePrompts as {
      arm: string;
      sources: readonly string[];
      questions: number;
      withAllDistinct: number;
      degenerate: number;
    }[];
    expect(mixed[0]?.arm).toBe('select-samples');
    expect(mixed[0]?.sources).toContain('inline+evidence+samples');
    // Three prompts, three distinct, on every case: a share below the case count here is the
    // symptom the loader produced, and the guard above it only fires at zero.
    expect(mixed[0]?.withAllDistinct).toBe(CHAIN_QUESTIONS.length);
    expect(mixed[0]?.degenerate).toBe(0);
    // The bracket is what a loaded block looks like in a prompt, and only one of the three
    // sources can put it there: a card printed without it is the two-prompt arm.
    const bracketed = result.requests.filter((request) => request.prompt.includes('name VARCHAR ['));
    expect(bracketed.length).toBeGreaterThanOrEqual(CHAIN_QUESTIONS.length);
    expect(bracketed.length).toBeLessThan(result.requests.length);
    // The block reached the case through one of three candidates, which is what the
    // pre-registered criterion for this arm reads: `withValues` counts cases, `columns` the
    // widest candidate's bracket.
    const rows = result.report.arms as {
      readonly arm: string;
      readonly sampleBlock?: { readonly cases: number; readonly withValues: number };
      readonly promptChars: { readonly mean: number };
    }[];
    expect(rows[0]?.sampleBlock?.cases).toBe(CHAIN_QUESTIONS.length);
    expect(rows[0]?.sampleBlock?.withValues).toBe(CHAIN_QUESTIONS.length);
    // The cost column reads the widest candidate, not the arm's own card: the sampled prompt is
    // longer by its brackets, and a column that priced the parent's card would report the two arms
    // as equally expensive while one of them sends values on a third of its calls.
    const plain = await run({ plan: { gold: mixedGold }, env: { BIRD_DATA: mixedData, BIRD_ARMS: 'inline+evidence', BIRD_DEFINITIONS_FORCE: '1' } });
    const plainRow = (plain.report.arms as { readonly promptChars: { readonly mean: number } }[])[0];
    expect(rows[0]?.promptChars.mean ?? 0).toBeGreaterThan(plainRow?.promptChars.mean ?? 0);
  });
});

/**
 * One more opinion, bought only where the pool agreed with itself.
 *
 * The lever's price is a share, not a call, so the reading needs two facts that no accuracy can
 * carry: which cases the condition held on, and whether the bought statement said anything the
 * pool did not. Both are per case in the artifact; this scenario makes them both nonzero and both
 * zero on purpose.
 */
/**
 * The fourth candidate is a query object, and the runner renders it.
 *
 * The lever's claim is narrow and has to be visible end to end or it is a prompt change: the model
 * is asked for the same query in a closed vocabulary, the statement that reaches the database is
 * the renderer's, and a reply the vocabulary cannot express is a candidate that never arrived with
 * a name attached. All three are assertions here, and the third is the one an accuracy could never
 * show — a refused candidate and a wrong candidate lower the ceiling identically.
 *
 * The one-lever claim is also an assertion: the intent prompt is the `inline+evidence` prompt with
 * one rule line inserted, and removing that line has to give back the parent byte for byte. A
 * prompt builder that quietly dropped a note or reordered the card would still produce a run, and
 * the delta would then be about two changes.
 */
describe('the fourth candidate is a query object, rendered into a statement', () => {
  const countable = QUESTIONS[6]?.question as string; // "How many orders are there for the pen?"
  const unexpressible = QUESTIONS[5]?.question as string; // "What is the average item price?"
  const MARKER = 'Instead of a statement, reply with one JSON object';

  /** One answer the grammar can express and the renderer must therefore produce. */
  const expressible = JSON.stringify({ from: 'orders', select: [{ expr: 'count(*)' }], where: [{ column: 'item_id', op: '=', value: 1 }] });
  /** A call the closed grammar does not have: refused by name, not rendered into something else. */
  const unexpressibleReply = JSON.stringify({ from: 'items', select: [{ expr: 'median(price)' }] });

  it('renders the fourth candidate from a query object, and counts what the vocabularies asked for', async () => {
    const result = await run({
      plan: {
        first: correct,
        intent: (question) => (question === countable ? expressible : question === unexpressible ? unexpressibleReply : expressible),
      },
      env: { BIRD_ARMS: 'select-intent' },
    });
    expect(result.code).toBe(0);
    const row = (result.report.arms as {
      readonly arm: string;
      readonly intent?: {
        readonly asked: number;
        readonly rendered: number;
        readonly share: number;
        readonly refused: Record<string, number>;
        readonly refusedCases?: readonly { readonly case: string; readonly read: string; readonly detail: string }[];
      };
      readonly calls: { readonly mean: number };
      readonly sources?: readonly { readonly source: string; readonly selected: number }[];
      readonly candidateSurvival?: Record<string, { readonly generated: number; readonly survived: number }>;
    }[])[0];
    // Seven questions asked, six rendered, one refused and named. The refusal is the reading the
    // grammar is designed from: a wider grammar is a decision taken from this histogram, not from
    // reading SQL.
    expect(row?.intent?.asked).toBe(QUESTIONS.length);
    expect(row?.intent?.rendered).toBe(QUESTIONS.length - 1);
    expect(row?.intent?.share).toBeCloseTo((QUESTIONS.length - 1) / QUESTIONS.length, 10);
    expect(row?.intent?.refused).toEqual({ 'unsupported-function': 1 });
    // The histogram named the family and the sentence names the construct, and the case id is what
    // makes the sentence actionable: a reader can open that reply, and a run whose refusals are all
    // `bad-identifier` is a different week of work from one whose refusals are all `bad-expression`.
    expect(row?.intent?.refusedCases).toEqual([
      { case: String(QUESTIONS[5]?.id), read: 'unsupported-function', detail: expect.stringContaining('median') as unknown as string },
    ]);
    // The call the fourth candidate costs is published with the arm, not inferred: four
    // generations and one selection, on every case.
    expect(row?.calls.mean ?? 0).toBeGreaterThan(4.9);
    expect(row?.candidateSurvival?.['intent']).toEqual({
      generated: QUESTIONS.length,
      survived: QUESTIONS.length - 1,
    });
    // The statement in the artifact is the renderer's text, not the model's: keywords upper case,
    // one line, no fence. A candidate recorded verbatim would mean the reply was executed.
    const cases = result.report.cases as readonly {
      readonly arm?: string;
      readonly id?: string;
      readonly winnerSource?: string;
      readonly candidates?: readonly { readonly source?: string; readonly sql?: string }[];
    }[];
    const rendered = cases
      .filter((entry) => entry.arm === 'select-intent')
      .flatMap((entry) => entry.candidates ?? [])
      .filter((candidate) => candidate.source === 'intent')
      .map((candidate) => candidate.sql);
    expect(rendered.length).toBe(QUESTIONS.length - 1);
    expect(rendered).toContain('SELECT count(*) FROM orders WHERE item_id = 1');
    expect(rendered.every((sql) => sql?.startsWith('SELECT ') === true)).toBe(true);
  });

  it('sends the parent prompt with one rule line inserted, and nothing else', async () => {
    const mixed = await run({
      plan: {
        first: correct,
        intent: () => expressible,
      },
      env: { BIRD_ARMS: 'select-intent' },
    });
    const plain = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'inline+evidence' } });
    expect(mixed.code).toBe(0);
    expect(plain.code).toBe(0);
    // Per question: the intent prompt with the rule removed must equal the parent's prompt. The
    // rule is one note in the rules block, so the removal is the whole difference.
    for (const question of Object.keys(GOLD)) {
      const parent = plain.requests.map((request) => request.prompt).find((prompt) => prompt.includes(question) && !prompt.includes(MARKER));
      const intent = mixed.requests.map((request) => request.prompt).find((prompt) => prompt.includes(question) && prompt.includes(MARKER));
      expect(parent, question).toBeDefined();
      expect(intent, question).toBeDefined();
      expect(intent?.replace(`${INTENT_RULE}\n`, ''), question).toBe(parent);
    }
  });

  it('refuses the arm on its own, because the reader it needs is the candidate path', async () => {
    // The dispatch that would otherwise publish a JSON reply read by a statement reader: refused
    // before a single call, with a sentence that names the arm to run instead.
    await expect(run({ plan: { first: correct }, env: { BIRD_ARMS: 'intent' } })).rejects.toThrow(/candidate-source path/);
  });
});

describe('a fourth opinion bought only on the cases the pool agreed', () => {
  const unanimousButWrong = QUESTIONS[3]?.question as string; // "What is the largest quantity…"
  const correct = (question: string): string => GOLD[question] as string;

  it('spends the call where the three agree, and lifts the ceiling where they agree and are wrong', async () => {
    // The second model is wrong on one question and right on the rest, so `select-cross` draws a
    // pool that is unanimous on six cases and split on one. On the split one no call is spent; on
    // the six the decompose prompt is asked; and on the one where every candidate is wrong the
    // decomposition is the only statement holding the answer — the state the ceiling test is about.
    const second = await startEndpoint({
      reply: (request) => {
        const asked = Object.keys(GOLD).find((entry) => request.prompt.includes(entry));
        return fenced(asked === unanimousButWrong ? 'select 1' : correct(asked ?? ''));
      },
    });
    try {
      const result = await run({
        plan: {
          // Both primary-model candidates follow this, so the pool is unanimous on every case.
          first: (question) => (question === unanimousButWrong ? 'select 1' : correct(question)),
          // The fourth opinion: right where the pool was wrong, and a runnable but different
          // statement everywhere else — the only way `distinct` can be nonzero on every case.
          decompose: (question) => (question === unanimousButWrong ? correct(question) : 'select 1'),
          // One case adopts it — the case it was right about — so `adopted` is a measured one
          // rather than a zero with no path, and the adoption is not a deliberate regression the
          // run's own gate would refuse to publish.
          selectIndex: (question) => (question === unanimousButWrong ? 4 : 1),
        },
        env: {
          BIRD_ARMS: 'select-cross,select-cross-pooled,select-cross-pooled-dissent',
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
        },
      });
      expect(result.code, result.printed.join('\n')).toBe(0);

      const rows = result.report.arms as {
        readonly arm: string;
        readonly dissent?: { readonly asked: number; readonly arrived: number; readonly distinct: number; readonly adopted: number };
      }[];
      const byName = new Map(rows.map((row) => [row.arm, row]));
      // Every case was unanimous, so the condition held on all of them; six are cases where the
      // dissent differed from a right pool and one where it differed from a wrong one.
      expect(byName.get('select-cross-pooled-dissent')?.dissent).toEqual({ asked: 7, arrived: 7, distinct: 7, adopted: 1 });
      // The parent buys nothing, so it publishes no funnel: an absent field is "no call was
      // possible", which is a different statement from a funnel of zeros.
      expect(byName.get('select-cross-pooled')).not.toHaveProperty('dissent');

      // The decomposition was asked once per case — the price of the lever is the `asked` share,
      // and on a fixture where the pool is unanimous everywhere that share is one call a case.
      const decompositions = second.requests.filter((request) => request.prompt.includes('Work in two parts.'));
      const onPrimary = result.requests.filter((request) => request.prompt.includes('Work in two parts.'));
      expect(onPrimary).toHaveLength(QUESTIONS.length);
      expect(decompositions).toHaveLength(0);

      // The ceiling: the case where all three agreed on a wrong answer holds a right one only
      // after the fourth opinion arrived. This is the whole reason the lever exists, and it is a
      // per-case fact rather than a share.
      const cases = result.report.cases as { arm: string; id: string; candidateRecall?: boolean; dissent?: { adopted: boolean } }[];
      const recallOf = (arm: string, id: string): boolean | undefined =>
        cases.find((entry) => entry.arm === arm && entry.id === id)?.candidateRecall;
      const wrongIndex = String(QUESTIONS.findIndex((entry) => entry.question === unanimousButWrong) + 1);
      expect(recallOf('select-cross-pooled', wrongIndex)).toBe(false);
      expect(recallOf('select-cross-pooled-dissent', wrongIndex)).toBe(true);
      // ...and the case that adopted the fourth opinion is the one the selector was told to take.
      expect(cases.find((entry) => entry.arm === 'select-cross-pooled-dissent' && entry.id === wrongIndex)?.dissent?.adopted).toBe(true);
    } finally {
      await second.close();
    }
  });
});

describe('a dissent call that never lands', () => {
  it('counts an outage and an engine refusal apart, and leaves the pool answering', async () => {
    // Two ways the bought call can fail, and they are different facts: the endpoint refused to
    // answer one, and the engine refused to run the other. Both leave the pool's decision standing
    // — a case must not be lost because its *fourth* opinion failed — and both are counted where
    // they happened rather than read afterwards as a lever that did nothing.
    const unreachable = QUESTIONS[1]?.question as string;
    const unrunnable = QUESTIONS[2]?.question as string;
    // The second model answers correctly on every case, so the pool is unanimous everywhere and
    // the only thing that can fail is the call this scenario is about.
    const second = await startEndpoint({
      reply: (request) => fenced(GOLD[Object.keys(GOLD).find((entry) => request.prompt.includes(entry)) ?? ''] ?? 'select 1'),
    });
    let result: ScenarioResult;
    try {
      result = await run({
        plan: {
          first: (question) => GOLD[question] as string,
          decompose: (question) => (question === unrunnable ? 'select * from no_such_table' : (GOLD[question] as string)),
          fail: (request) => (request.prompt.includes('Work in two parts.') && request.prompt.includes(unreachable) ? 500 : undefined),
        },
        env: {
          BIRD_ARMS: 'select-cross,select-cross-pooled-dissent',
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
          BIRD_LLM_RETRIES: '1',
        },
      });
    } finally {
      await second.close();
    }
    expect(result.code, result.printed.join('\n')).toBe(0);
    const rows = result.report.arms as {
      readonly arm: string;
      readonly dissent?: { readonly asked: number; readonly arrived: number; readonly distinct: number; readonly adopted: number };
      readonly candidateFailures?: { readonly llm: number; readonly engine: number };
      readonly passed: number;
      readonly total: number;
    }[];
    const child = rows.find((row) => row.arm === 'select-cross-pooled-dissent');
    // Every case was unanimous, so every case paid for the call; five of the seven came back
    // runnable, and none of them said anything the pool had not already said.
    expect(child?.dissent).toEqual({ asked: 7, arrived: 5, distinct: 0, adopted: 0 });
    expect(child?.candidateFailures?.llm).toBe(1);
    expect(child?.candidateFailures?.engine).toBe(1);
    // The pool still answered every case: a failed fourth opinion is not a failed question.
    const child2 = rows.find((row) => row.arm === 'select-cross-pooled-dissent');
    expect(child2?.passed).toBe(child2?.total);
    expect(child2?.total).toBe(7);
  });
});

describe('the bought opinion put to the selector instead of in front of it', () => {
  it('asks one comparison only where the bought statement disagrees, and can take it', async () => {
    // `41551887197` showed the four-candidate prompt reading the bought opinion and not using it:
    // conversion fell 2.5 points while the ceiling rose 27 cases. This arm keeps the parent's
    // three-candidate prompt byte for byte and spends one more call only on the disagreements, so
    // the record has to say three things — that the comparison was asked, that it fired only where
    // there was something to decide, and that it sometimes changed the answer.
    const wrongEverywhere = QUESTIONS[4]?.question as string;
    const second = await startEndpoint({
      reply: (request) => {
        const asked = Object.keys(GOLD).find((entry) => request.prompt.includes(entry));
        return fenced(asked === wrongEverywhere ? 'select 1' : (GOLD[asked ?? ''] ?? 'select 1'));
      },
    });
    try {
      const result = await run({
        plan: {
          // The pool agrees with itself everywhere, and on one case it agrees on the wrong answer.
          first: (question) => (question === wrongEverywhere ? 'select 1' : (GOLD[question] as string)),
          // The bought opinion: holds the answer where the pool was wrong, and says something else
          // everywhere else — so `distinct` is true on every case and the comparison is asked on all
          // of them, which is the branch the funnel has to survive.
          // `select 99` rather than `select 2`: the fixture's smallest count is 2, and a challenger
          // that happens to return the pool's rows would make `distinct` false on that case — which
          // is a real state, and not the one this scenario is about.
          decompose: (question) => (question === wrongEverywhere ? (GOLD[question] as string) : 'select 99'),
          // The comparison takes the challenger only where the challenger is right.
          pairPick: (question) => (question === wrongEverywhere ? 2 : 1),
        },
        env: {
          BIRD_ARMS: 'select-cross,select-cross-pooled,select-cross-pooled-dissent-pair',
          BIRD_SECOND_MODEL: 'second-model',
          BIRD_SECOND_BASE_URL: second.url,
          BIRD_SECOND_API_KEY: 'second-key',
        },
      });
      expect(result.code, result.printed.join('\n')).toBe(0);
      const rows = result.report.arms as {
        readonly arm: string;
        readonly passed: number;
        readonly dissent?: {
          readonly asked: number;
          readonly arrived: number;
          readonly distinct: number;
          readonly adopted: number;
          readonly pairwise?: { readonly asked: number; readonly choseDissent: number };
        };
      }[];
      const child = rows.find((row) => row.arm === 'select-cross-pooled-dissent-pair');
      expect(child?.dissent).toEqual({ asked: 7, arrived: 7, distinct: 7, adopted: 1, pairwise: { asked: 7, choseDissent: 1 } });
      // The arm is one case better than the parent it shares a prompt with, and the case is the one
      // where the bought opinion was right: the comparison turn is the whole difference.
      const parent = rows.find((row) => row.arm === 'select-cross-pooled');
      expect(parent?.passed).toBe(QUESTIONS.length - 1);
      expect(child?.passed).toBe(QUESTIONS.length);
      // The selector read three candidates: four prompts per case on the arm that showed it four,
      // three here — plus exactly one comparison per disagreement and nothing else.
      const comparisons = result.requests.filter((request) => request.prompt.includes('Two statements were written for the same question'));
      expect(comparisons).toHaveLength(QUESTIONS.length);
    } finally {
      await second.close();
    }
  });
});
