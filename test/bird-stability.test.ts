/**
 * The noise probe, driven end to end on a dataset it has never seen.
 *
 * `stability.ts` exists to answer one question — does the same prompt produce the same
 * answer? — and until now the only way to read its answer was to spend a model run on the
 * real split. That made three of its claims untested: that an unknown arm name is refused,
 * that an unanswered call is not the same event as a wrong answer, and that a case whose
 * gold does not run is excluded rather than scored. Each of those is now a test.
 *
 * The apparatus is the same one the runner's end-to-end test uses: a BIRD-shaped dataset in
 * a temporary directory, a real Python oracle, and a real HTTP endpoint that decides its
 * answers. Nothing here stubs the function under test.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MINI_GOLD, MINI_QUESTIONS, writeMiniBirdDataset } from './helpers/bird-dataset.js';
import { startEndpoint } from './helpers/endpoint.js';
import type { EndpointRequest } from './helpers/endpoint.js';
import {
  main,
  pickArm,
  resolveStabilitySettings,
  stabilityReport,
  stabilitySummary,
} from '../eval/bird/stability.js';
import { ARMS } from '../eval/bird/run.js';

const root = mkdtempSync(join(tmpdir(), 'nl2charts-stability-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const data = writeMiniBirdDataset(join(root, 'MINIDEV'));

/** A second split whose second question cannot run, for the exclusion path. */
const broken = join(root, 'BROKEN');
writeMiniBirdDataset(broken);
writeFileSync(
  join(broken, 'mini_dev_sqlite.json'),
  JSON.stringify(
    MINI_QUESTIONS.slice(0, 2).map((entry) => ({
      question_id: entry.id,
      db_id: 'shop',
      question: entry.question,
      evidence: '',
      SQL: entry.id === 2 ? 'select count(*) from nothing_here' : entry.sql,
      difficulty: entry.difficulty,
    })),
  ),
);

function fenced(sql: string): string {
  return '```sql\n' + sql + '\n```';
}

/** What a linker turn gets when the endpoint has no hint to give. */
const NO_HINT = 'no column hint for this question';

/** How one run answers: a statement per question, or a status, or both by index. */
interface Plan {
  readonly answer?: (question: string, attempt: number) => string;
  readonly status?: number;
}

function replyFor(request: EndpointRequest, plan: Plan): { status?: number; content: string } {
  if (plan.status !== undefined) return { status: plan.status, content: '{"error":"unavailable"}' };
  const question = Object.keys(MINI_GOLD).find((entry) => request.prompt.includes(entry));
  if (question === undefined) return { content: NO_HINT };
  const gold = MINI_GOLD[question] as string;
  const answer = plan.answer?.(question, requestCount.current(question)) ?? gold;
  requestCount.bump(question);
  return { content: fenced(answer) };
}

/**
 * How many times this endpoint has been asked about each question.
 *
 * The probe asks the same case several times; an endpoint that wants to answer differently
 * on the second attempt needs to know which attempt it is on.
 */
const requestCount = (() => {
  const seen = new Map<string, number>();
  return {
    current(question: string): number {
      return seen.get(question) ?? 0;
    },
    bump(question: string): void {
      seen.set(question, (seen.get(question) ?? 0) + 1);
    },
    reset(): void {
      seen.clear();
    },
  };
})();

interface ScenarioResult {
  readonly code: number;
  readonly report: Record<string, unknown>;
  readonly requests: readonly EndpointRequest[];
  readonly printed: readonly string[];
  readonly artifact: string;
}

async function run(options: {
  readonly plan?: Plan;
  readonly env?: Record<string, string | undefined>;
  readonly argv?: readonly string[];
} = {}): Promise<ScenarioResult> {
  requestCount.reset();
  const endpoint = await startEndpoint({ reply: (request) => replyFor(request, options.plan ?? {}) });
  const artifact = join(root, `stability-${String(Math.random()).slice(2, 8)}.json`);
  const env = {
    BIRD_DATA: data,
    BIRD_STABILITY_OUT: artifact,
    BIRD_STABILITY_LIMIT: '7',
    BIRD_STABILITY_REPEATS: '2',
    BIRD_CONCURRENCY: '4',
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
    let report: Record<string, unknown> = {};
    try {
      report = JSON.parse(readFileSync(artifact, 'utf8')) as Record<string, unknown>;
    } catch {
      report = {};
    }
    return { code, report, requests: endpoint.requests, printed, artifact };
  } finally {
    log.mockRestore();
    error.mockRestore();
    await endpoint.close();
  }
}

describe('the arm a name refers to', () => {
  it('resolves a name from the arm table', () => {
    expect(pickArm('names').name).toBe('names');
  });

  it('falls back to the documented default when nothing names an arm', () => {
    expect(pickArm(undefined).name).toBe('metadata+evidence');
  });

  it('refuses an unknown name instead of measuring a different arm', () => {
    // The fallback here used to be `?? ARMS[2]`: a typo produced a complete artifact that
    // named the arm it did not measure. A refusal is the only honest answer.
    expect(() => pickArm('metdata+evidence')).toThrow(/no arm named 'metdata\+evidence'; known arms: names, /);
  });

  it('lists every arm the harness can run, so the error is actionable', () => {
    const message = (() => {
      try {
        pickArm('nope');
      } catch (error) {
        return error instanceof Error ? error.message : '';
      }
      return '';
    })();
    for (const arm of ARMS) expect(message).toContain(arm.name);
  });
});

describe('settings', () => {
  it('defaults to the split the runner defaults to, and reads the count names', () => {
    const settings = resolveStabilitySettings({}, [], root);
    expect(settings.layout.split).toBe('minidev');
    expect(settings.limit).toBe(60);
    expect(settings.repeats).toBe(3);
    expect(settings.concurrency).toBe(8);
    expect(settings.out).toBe(join(root, 'eval/out/bird-stability.json'));
    expect(settings.dryRun).toBe(false);
  });

  it('takes the dataset, the repeats and the arm from the environment', () => {
    const settings = resolveStabilitySettings(
      { BIRD_DATA: data, BIRD_STABILITY_REPEATS: '5', BIRD_STABILITY_ARM: 'names', BIRD_STABILITY_OUT: '/tmp/x.json' },
      ['--dry-run'],
      root,
    );
    expect(settings.layout.data).toBe(data);
    expect(settings.repeats).toBe(5);
    expect(settings.arm.name).toBe('names');
    expect(settings.out).toBe('/tmp/x.json');
    expect(settings.dryRun).toBe(true);
  });

  it('refuses a count that is not a positive integer rather than running zero repeats', () => {
    // `Number('')` is 0 and `Number('three')` is NaN: both used to flow into the loop, and a
    // probe with no repeats reports a flip rate of 0 for a model it never asked anything.
    expect(() => resolveStabilitySettings({ BIRD_STABILITY_REPEATS: '0' }, [], root)).toThrow(/BIRD_STABILITY_REPEATS/);
    expect(() => resolveStabilitySettings({ BIRD_STABILITY_LIMIT: 'three' }, [], root)).toThrow(/BIRD_STABILITY_LIMIT/);
    expect(() => resolveStabilitySettings({ BIRD_CONCURRENCY: '-1' }, [], root)).toThrow(/BIRD_CONCURRENCY/);
  });
});

describe('a dry run', () => {
  it('runs the gold statements, counts the cases, and calls no model', async () => {
    const result = await run({ argv: ['--dry-run'] });
    expect(result.code).toBe(0);
    expect(result.requests).toHaveLength(0);
    expect(result.printed.join('\n')).toContain('dry run: 7 cases x 2 repeats, gold runnable 7, arm metadata+evidence');
    expect(result.report).toEqual({});
  });
});

describe('a full run', () => {
  it('writes the probe artifact and finds no noise in a model that always answers the same way', async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.report.cases).toBe(MINI_QUESTIONS.length);
    expect(result.report.repeats).toBe(2);
    expect(result.report.flips).toBe(0);
    expect(result.report.flipRate).toBe(0);
    expect(result.report.majorityAccuracy).toBe(1);
    expect(result.report.firstRunAccuracy).toBe(1);
    expect(result.report.absoluteDifference).toBe(0);
    expect(result.report.outages).toBe(0);
    expect(result.report.dataset).toBe('bird-mini-dev');
  });

  it('counts a case that disagrees with itself, and how far one run is from the majority', async () => {
    // The second attempt answers with a statement that runs and is wrong on one question.
    const result = await run({
      plan: {
        answer: (question, attempt) =>
          attempt === 1 && question === 'How many items are there?' ? 'select 1' : (MINI_GOLD[question] as string),
      },
    });
    expect(result.report.cases).toBe(MINI_QUESTIONS.length);
    expect(result.report.flips).toBe(1);
    expect(result.report.flipRate).toBeCloseTo(1 / MINI_QUESTIONS.length, 10);
    // Two repeats and one pass is not a majority (`> repeats / 2`), so the case counts as
    // unstable rather than as correct.
    expect(result.report.majorityAccuracy).toBeCloseTo((MINI_QUESTIONS.length - 1) / MINI_QUESTIONS.length, 10);
    expect(result.report.firstRunAccuracy).toBe(1);
    expect(result.report.absoluteDifference).toBeCloseTo(1 / MINI_QUESTIONS.length, 10);
  });

  it('reports an endpoint that never answers as lost calls, not as the model changing its mind', async () => {
    const result = await run({ plan: { status: 503 } });
    expect(result.code).toBe(0);
    expect(result.report.outages).toBe(MINI_QUESTIONS.length * 2);
    expect(result.report.outageRate).toBe(1);
    expect(result.report.majorityAccuracy).toBe(0);
    expect(result.report.flips).toBe(0);
    expect((result.report.outageSamples as string[]).length).toBeGreaterThan(0);
    expect(result.printed.join('\n')).toContain('unanswered repeat(s)');
  });

  it('scores a statement the engine refused as a wrong answer and counts it separately', async () => {
    const result = await run({ plan: { answer: () => 'select count(*) from itemz' } });
    expect(result.report.engineFailures).toBe(MINI_QUESTIONS.length * 2);
    // The call reached the model and came back: that is not an outage.
    expect(result.report.outages).toBe(0);
    expect(result.report.majorityAccuracy).toBe(0);
    expect(result.printed.join('\n')).toContain('rejected statement(s)');
  });

  it('excludes a question whose gold statement does not run, and says how many it dropped', async () => {
    const result = await run({ env: { BIRD_DATA: broken } });
    expect(result.code).toBe(0);
    expect(result.report.cases).toBe(1);
    expect(result.report.unrunnable).toBe(1);
    expect(result.report.gold).toBe(1);
  });
});

/** Settings for a report with no run behind it; the split is the only field it reads. */
function settingsForReport(split: 'minidev' | 'dev') {
  return { ...resolveStabilitySettings({ BIRD_SPLIT: split }, [], root) };
}

describe('a harness that cannot start', () => {
  it('refuses an unknown arm name before it spends a call, and writes no artifact', async () => {
    await expect(run({ env: { BIRD_STABILITY_ARM: 'metdata+evidence' } })).rejects.toThrow(
      /no arm named 'metdata\+evidence'/,
    );
  });

  it('refuses a dataset that is not there', async () => {
    await expect(run({ env: { BIRD_DATA: join(root, 'absent') } })).rejects.toThrow(/ENOENT|no such file/);
  });
});

describe('a dataset that lists a database it does not describe', () => {
  it('runs the questions it can and leaves the rest out', async () => {
    // A manifest is a list of database names; the table file is what describes them. They are
    // written by different steps, and a split that names a database with no table entry used
    // to crash the probe on `schemas.get(db) as SchemaTable[]` instead of skipping it.
    const partial = join(root, 'PARTIAL');
    writeMiniBirdDataset(partial);
    writeFileSync(join(partial, 'manifest.json'), JSON.stringify({ databases: [{ db: 'shop' }, { db: 'ghost' }] }));
    const result = await run({ env: { BIRD_DATA: partial } });
    expect(result.code).toBe(0);
    expect(result.report.cases).toBe(MINI_QUESTIONS.length);
  });
});

describe('the report for a run that scored nothing', () => {
  it('reports zero rates instead of dividing by an empty run', () => {
    // Every case can be excluded when its gold does not run, and a report is still written:
    // `0 / 0` would make every rate NaN, which serialises to `null` and reads as "unknown"
    // rather than "nothing was measurable".
    const prepared = { settings: settingsForReport('dev'), cases: [], gold: new Map(), unrunnable: 4 };
    const report = stabilityReport(prepared.settings, prepared, []);
    expect(report).toMatchObject({
      dataset: 'bird-dev',
      cases: 0,
      flips: 0,
      flipRate: 0,
      majorityAccuracy: 0,
      firstRunAccuracy: 0,
      absoluteDifference: 0,
      outageRate: 0,
      unrunnable: 4,
      gold: 0,
    });
  });
});

describe('the summary line', () => {
  it('says nothing about failures when there are none', () => {
    const line = stabilitySummary({
      cases: 7,
      repeats: 3,
      flips: 0,
      flipRate: 0,
      majorityAccuracy: 1,
      firstRunAccuracy: 1,
      outages: 0,
      engineFailures: 0,
    });
    expect(line).toBe('stability: 7 cases x 3; self-flips 0 (0.0%); majority 100.0% vs single 100.0%');
  });

  it('names both kinds of failure, because they are different facts', () => {
    const line = stabilitySummary({
      cases: 7,
      repeats: 3,
      flips: 2,
      flipRate: 2 / 7,
      majorityAccuracy: 0.5,
      firstRunAccuracy: 0.75,
      outages: 3,
      engineFailures: 1,
    });
    expect(line).toContain('self-flips 2 (28.6%)');
    expect(line).toContain('3 unanswered repeat(s)');
    expect(line).toContain('1 rejected statement(s)');
  });
});
