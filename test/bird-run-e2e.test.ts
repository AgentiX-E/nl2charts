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
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MINI_GOLD, MINI_QUESTIONS, writeMiniBirdDataset } from './helpers/bird-dataset.js';
import { startEndpoint } from './helpers/endpoint.js';
import type { EndpointRequest } from './helpers/endpoint.js';
import { assertSecondModel, judgeModelName, main, resolveSettings } from '../eval/bird/run.js';

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
  const send = (content: string): { content: string; delayMs?: number } =>
    delayMs === undefined ? { content } : { content, delayMs };
  // The selector. Its reply is a bare number by contract (`parseSelection`), so a SQL
  // block here would be counted as "the selector did not answer".
  if (prompt.includes('which candidate statement answers the question')) return send('1');
  // The pairwise selector asks a different question over two candidates and reads a
  // different answer, so the same `1` would be counted as an unreadable reply.
  if (prompt.includes('Two statements were written for the same question')) return send('1');
  const question = Object.keys(GOLD).find((entry) => prompt.includes(entry));
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
  const gold = GOLD[question];
  // `GOLD` is built from `QUESTIONS`, so a question without an entry is a defect in this
  // file and not a case to handle: failing here keeps the fixture honest.
  if (gold === undefined) throw new Error(`no gold statement planned for ${question}`);
  if (second) {
    const stubborn = plan.stubborn?.includes(question) === true;
    return send(fenced(stubborn ? (plan.first?.(question) ?? gold) : gold));
  }
  const answer = plan.first?.(question) ?? gold;
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

describe('a full run', () => {
  it('scores each arm, pairs them, and passes its own gate', async () => {
    const result = await run({ plan: { first: correct }, env: { BIRD_ARMS: 'names,metadata' } });
    expect(result.code).toBe(0);
    const arms = result.report.arms as { arm: string; passed: number; total: number; accuracy: number; calls: { mean: number } }[];
    expect(arms.map((entry) => entry.arm)).toEqual(['names', 'metadata']);
    // Every gold statement is answerable from the schema, so a correct model scores all of them.
    for (const arm of arms) {
      expect(arm.passed).toBe(QUESTIONS.length);
      expect(arm.total).toBe(QUESTIONS.length);
      expect(arm.accuracy).toBe(1);
      expect(arm.calls.mean).toBe(1);
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
      plan: { whenValues: 'select -1 as impossible' },
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
    // guard rejects a write, so this is the `other` side of `candidateFailures` — the side a
    // real endpoint outage never exercises.
    const result = await run({
      plan: { whenValues: 'delete from items' },
      env: { BIRD_ARMS: 'select-mixed' },
    });
    const arms = result.report.arms as { candidateFailures?: { llm: number; other: number } }[];
    // The oracle opens every database read-only, so the write is refused by the engine and
    // counted as `other`: the split that tells "the endpoint refused" from "the engine did".
    expect(arms[0]?.candidateFailures).toMatchObject({ llm: 0, other: 1 });
    const cases = result.report.cases as {
      id: string;
      passed: boolean;
      candidates?: { source: string; correct: boolean }[];
    }[];
    const pen = cases.find((row) => row.id === '7');
    // The record is the set that survived: two sources, both of them correct, so the case is
    // decided by the candidates that arrived rather than by the one that did not.
    expect(pen?.candidates).toEqual([
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
      expect(first?.candidates).toEqual([
        { source: 'inline+evidence@second', correct: true },
        { source: 'metadata+evidence', correct: true },
        { source: 'values', correct: true },
      ]);
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
      candidateFailures?: { llm: number; other: number; attempted: number };
    }[];
    expect(arms[0]?.candidateFailures).toEqual({ llm: 1, other: 0, attempted: QUESTIONS.length * 3 });
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
  it('records a selector call that never answered as the arm\'s own failure, not as a wrong answer', async () => {
    // Everything else works: only the selector is refused, and only on the first three
    // questions. A run where *every* case failed is refused earlier, by the guard whose
    // sentence is "this is not an accuracy of zero; it is a run that did not happen".
    await expect(
      run({
        plan: {
          first: correct,
          fail: (request) =>
            request.prompt.includes('which candidate statement answers the question') &&
            QUESTIONS.slice(0, 3).some((entry) => request.prompt.includes(entry.question))
              ? 500
              : undefined,
        },
        env: { BIRD_ARMS: 'select', BIRD_LLM_RETRIES: '1' },
      }),
      // The escaped error became a recorded `llm` failure, and the failure-share guard then
      // refuses the arm at 10% rather than at 100%: three cases out of seven is an endpoint
      // that was busy, and the accuracy would be a function of when it was measured.
    ).rejects.toThrow(/3 of 7 calls \(42\.9%\) failed at the model, above the 10%/);
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
    writeFileSync(pinnedFile, JSON.stringify({ definitions: { other: '- a sentence for a database nobody runs' } }));
    await expect(run({ plan: { first: correct }, env: { BIRD_ARMS: 'inline-definitions' } })).rejects.toThrow(
      /pinned definitions have no entry for shop/,
    );
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
