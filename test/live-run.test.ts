/**
 * The live evaluation, driven end to end on a real DuckDB and a real endpoint.
 *
 * This harness used to run at import time: building the warehouse, executing 210 gold
 * statements, and throwing on the first broken case all happened before anything could
 * observe it. Its three gates were unreachable code from a test's point of view, and its
 * negative control read `cases[0]` through a cast that would have compared against
 * `undefined` in a run with no cases — a control that passes by not existing.
 *
 * Everything below runs the real thing: DuckDB in process, the fixture SQL from the
 * repository, and an HTTP endpoint that answers with the gold statement (or refuses to).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDuckDbEngine } from '@agentix-e/nl2charts-node';
import type { Engine } from '@agentix-e/nl2charts-core';
import type { ResultSet } from '@agentix-e/nl2charts-devkit';
import { startEndpoint } from './helpers/endpoint.js';
import { liveCases } from '../eval/live/cases.js';
import {
  LIVE_ARMS,
  executeGold,
  fixtureStatements,
  liveGate,
  liveLines,
  liveReport,
  main,
  negativeControl,
  openFixture,
  resolveLiveSettings,
  runLive,
  selectCases,
} from '../eval/live/run.js';
import type { LiveArmResult, LiveSettings } from '../eval/live/run.js';

const root = mkdtempSync(join(tmpdir(), 'nl2charts-live-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Three cases are enough to exercise a path; the full set is a measurement, not a test. */
const LIMIT = 3;
const CASES = liveCases().slice(0, LIMIT);

/** The repository, which is where the fixture and the case set live. */
const REPO = process.cwd();

const settings = (overrides: Partial<LiveSettings> = {}): LiveSettings => ({
  ...resolveLiveSettings({}, [], REPO),
  concurrency: 2,
  repeats: 1,
  limit: LIMIT,
  out: join(root, 'live.json'),
  ...overrides,
});

function fenced(sql: string): string {
  return '```sql\n' + sql + '\n```';
}

/** The endpoint's answer: the gold statement when the prompt asks one of the three cases. */
function replyFor(prompt: string, correct: boolean): string {
  const match = CASES.find((testCase) => prompt.includes(testCase.question));
  if (match === undefined) return 'no column hint for this question';
  return fenced(correct ? match.goldSql : 'select 1');
}

describe('the fixture', () => {
  it('is split into statements, not into fragments', () => {
    const parts = fixtureStatements('create table a (x int);\n\n  select 1 ;\n');
    expect(parts).toEqual(['create table a (x int)', 'select 1']);
  });

  it('keeps a comment attached to the statement it explains', () => {
    const [first] = fixtureStatements('-- why this table exists\ncreate table a (x int);');
    expect(first).toContain('-- why this table exists');
  });
});

describe('settings', () => {
  it('defaults to the full case set, three repeats, and the documented tolerances', () => {
    const resolved = resolveLiveSettings({}, [], root);
    expect(resolved.limit).toBe(0);
    expect(resolved.repeats).toBe(3);
    expect(resolved.concurrency).toBe(6);
    expect(resolved.dryRun).toBe(false);
    expect(resolved.floor).toBe(0.5);
    expect(resolved.tolerance).toBe(0.05);
    expect(resolved.out).toBe(join(root, 'eval/out/live-eval.json'));
    expect(resolved.fixture).toBe(join(root, 'eval/fixtures/semantic.sql'));
    expect(resolved.fixture.endsWith('eval/fixtures/semantic.sql')).toBe(true);
  });

  it('reads the dataset knobs from the environment', () => {
    const resolved = resolveLiveSettings({ LIVE_LIMIT: '5', LIVE_REPEATS: '2', LIVE_FIXTURE: '/tmp/f.sql' }, ['--dry-run'], root);
    expect(resolved.limit).toBe(5);
    expect(resolved.repeats).toBe(2);
    expect(resolved.fixture).toBe('/tmp/f.sql');
    expect(resolved.dryRun).toBe(true);
  });

  it('refuses a repeat count of zero and a negative limit', () => {
    expect(() => resolveLiveSettings({ LIVE_REPEATS: '0' }, [], root)).toThrow(/LIVE_REPEATS/);
    expect(() => resolveLiveSettings({ LIVE_LIMIT: '-1' }, [], root)).toThrow(/LIVE_LIMIT/);
  });

  it('takes a prefix of the generated cases, in generation order', () => {
    expect(selectCases(settings({ limit: 0 })).length).toBe(liveCases().length);
    expect(selectCases(settings({ limit: 4 })).map((entry) => entry.id)).toEqual(
      liveCases()
        .slice(0, 4)
        .map((entry) => entry.id),
    );
  });
});

describe('the gold statements', () => {
  it('attribute a broken gold query to its case instead of to the model', async () => {
    const engine: Engine = await createDuckDbEngine();
    try {
      const fixture = readFileSync(settings().fixture, 'utf8');
      for (const statement of fixtureStatements(fixture)) await engine.run(statement);
      const broken = [{ ...(CASES[0] as (typeof CASES)[number]), id: 'broken', goldSql: 'select * from nowhere' }];
      await expect(
        executeGold(async (sql) => {
          const result = await engine.run(sql);
          return { columns: result.columns, rows: result.rows };
        }, broken),
      ).rejects.toThrow(/case broken has a broken gold query/);
    } finally {
      await engine.close();
    }
  });
});

describe('a gold statement that returns nothing', () => {
  it('is reported as a broken case, because it scores every answer wrong', async () => {
    const engine = await createDuckDbEngine();
    try {
      for (const statement of fixtureStatements(readFileSync(settings().fixture, 'utf8'))) await engine.run(statement);
      const hollow = [{ ...(CASES[0] as (typeof CASES)[number]), id: 'hollow', goldSql: 'select * from orders where 1 = 0' }];
      await expect(
        executeGold(async (sql) => {
          const result = await engine.run(sql);
          return { columns: result.columns, rows: result.rows };
        }, hollow),
      ).rejects.toThrow(/case hollow has a broken gold query: gold query returned no rows/);
    } finally {
      await engine.close();
    }
  });

  it('reports a fixture it cannot read instead of a run of zero cases', async () => {
    const engine = await createDuckDbEngine();
    try {
      await expect(openFixture(settings({ fixture: join(root, 'absent.sql') }), engine, CASES)).rejects.toThrow(/ENOENT/);
    } finally {
      await engine.close();
    }
  });
});

describe('the negative control', () => {
  const gold = new Map<string, ResultSet>([['a', { columns: ['n'], rows: [{ n: 3 }] }]]);
  const empty: ResultSet = { columns: ['n'], rows: [] };

  it('holds when an empty result does not match the gold', () => {
    expect(negativeControl(gold, [{ id: 'a' } as never], empty)).toBe(1);
  });

  it('fails when the judge calls an empty result a match', () => {
    const hollow = new Map<string, ResultSet>([['a', { columns: ['n'], rows: [] }]]);
    expect(() => negativeControl(hollow, [{ id: 'a' } as never], empty)).toThrow(/an empty result matched a gold result/);
  });

  it('refuses a run with no cases instead of passing vacuously', () => {
    expect(() => negativeControl(gold, [], empty)).toThrow(/no cases/);
  });

  it('refuses a first case with no gold result', () => {
    expect(() => negativeControl(new Map(), [{ id: 'a' } as never], empty)).toThrow(/no gold result/);
  });
});

describe('a run against a real warehouse', () => {
  it('opens the fixture, runs every gold statement, and refuses an empty case list', async () => {
    const engine = await createDuckDbEngine();
    try {
      await expect(openFixture(settings(), engine, [])).rejects.toThrow(/no cases/);
      const opened = await openFixture(settings(), engine, CASES);
      try {
        expect(opened.gold.size).toBe(LIMIT);
        expect(opened.empty.rows).toHaveLength(0);
      } finally {
        await opened.close();
      }
    } finally {
      await engine.close();
    }
  });

  it('scores every arm and pairs the two levers against the baseline', async () => {
    const endpoint = await startEndpoint({ reply: (request) => replyFor(request.prompt, true) });
    const engine = await createDuckDbEngine();
    try {
      const provider = (await import('@agentix-e/nl2charts-ai')).createHttpProvider({
        baseUrl: endpoint.url,
        apiKey: 'test-key',
        model: 'stub-model',
      });
      const outcome = await runLive(settings(), { engine, provider, cases: CASES });
      expect(outcome.results.map((result) => result.arm)).toEqual(LIVE_ARMS.map((arm) => arm.name));
      for (const result of outcome.results) expect(result.summary.accuracy).toBe(1);
      expect(outcome.controls).toEqual({ oracle: 1, empty: 0 });
      const ablations = outcome.report.ablations as Record<string, { delta: number; p: number }>;
      // Identical arms: no case moved, and the exact test says so.
      expect(ablations.valueProfiling?.delta).toBe(0);
      expect(ablations.repair?.delta).toBe(0);
      expect(liveGate(settings(), outcome.results)).toEqual([]);
    } finally {
      await engine.close();
      await endpoint.close();
    }
  });
});

describe('the command line', () => {
  interface Printed {
    readonly code: number;
    readonly out: readonly string[];
    readonly err: readonly string[];
    readonly report: Record<string, unknown>;
    readonly artifact: string;
  }

  async function run(options: {
    readonly correct?: boolean;
    readonly env?: Record<string, string | undefined>;
    readonly argv?: readonly string[];
  } = {}): Promise<Printed> {
    const endpoint = await startEndpoint({
      reply: (request) => replyFor(request.prompt, options.correct ?? true),
    });
    const artifact = join(root, `live-${String(Math.random()).slice(2, 8)}.json`);
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => out.push(String(line)));
    const error = vi.spyOn(console, 'error').mockImplementation((line: unknown) => err.push(String(line)));
    try {
      const code = await main(
        {
          LIVE_OUT: artifact,
          LIVE_LIMIT: String(LIMIT),
          LIVE_REPEATS: '1',
          LIVE_CONCURRENCY: '2',
          LLM_BASE_URL: endpoint.url,
          LLM_API_KEY: 'test-key',
          LLM_MODEL: 'stub-model',
          ...options.env,
        },
        options.argv ?? [],
        REPO,
      );
      let report: Record<string, unknown> = {};
      try {
        report = JSON.parse(readFileSync(artifact, 'utf8')) as Record<string, unknown>;
      } catch {
        report = {};
      }
      return { code, out, err, report, artifact };
    } finally {
      log.mockRestore();
      error.mockRestore();
      await endpoint.close();
    }
  }

  it('validates the case set in a dry run and calls no model', async () => {
    const printed = await run({ argv: ['--dry-run'] });
    expect(printed.code).toBe(0);
    expect(printed.out.join('\n')).toContain(`live eval: ${String(LIMIT)} cases, ${String(LIMIT)} gold queries executed`);
    expect(printed.out.join('\n')).toContain('no model was called');
    expect(printed.report).toEqual({});
  });

  it('writes the artifact, prints the arms, and passes its own gates when the model is right', async () => {
    const printed = await run();
    expect(printed.code).toBe(0);
    expect(printed.report.cases).toBe(LIMIT);
    expect(printed.report.controls).toEqual({ oracle: 1, empty: 0 });
    expect((printed.report.arms as unknown[]).length).toBe(3);
    expect(printed.out.join('\n')).toContain('[names] exact 100.0%');
    expect(printed.out.join('\n')).toContain('value profiling:');
    expect(printed.err).toEqual([]);
  });

  it('fails the floor gate, keeps the artifact, and says which gate it failed', async () => {
    const printed = await run({ correct: false });
    expect(printed.code).toBe(1);
    // The artifact is written before the gates run, so a failing run still has one to read.
    expect(printed.report.cases).toBe(LIMIT);
    expect(printed.err.join('\n')).toContain('GATE FAILED: live accuracy 0.0% is below the 50% floor');
  });

  it('refuses to run without a key rather than calling an endpoint with an empty one', async () => {
    await expect(run({ env: { LLM_API_KEY: '', DEEPSEEK_API_KEY: '' } })).rejects.toThrow(
      /DEEPSEEK_API_KEY is required/,
    );
  });
});

describe('a report without one of its arms', () => {
  it('refuses to pair against an arm that did not run', () => {
    const outcome = {
      report: {},
      results: [
        {
          arm: 'names',
          summary: { arm: 'names', passed: 1, total: 1, accuracy: 1, outcomes: [{ id: 'a', passed: true }] },
          wilson: { low: 0, high: 1 },
          repeats: 1,
          flips: 0,
          cases: [],
          byIntent: {},
        },
      ],
      gold: 1,
      controls: { oracle: 1, empty: 0 },
    };
    expect(() => liveReport(settings(), outcome, CASES)).toThrow(/the run has no 'samples' arm to pair/);
  });
});

describe('an endpoint that never answers', () => {
  it('scores every arm at zero and records the reason per repeat', async () => {
    const endpoint = await startEndpoint({ reply: () => ({ status: 503, content: '{"error":"unavailable"}' }) });
    const engine = await createDuckDbEngine();
    try {
      const provider = (await import('@agentix-e/nl2charts-ai')).createHttpProvider({
        baseUrl: endpoint.url,
        apiKey: 'k',
        model: 'stub-model',
      });
      const outcome = await runLive(settings({ repeats: 1 }), { engine, provider, cases: CASES.slice(0, 1) });
      for (const result of outcome.results) {
        expect(result.summary.accuracy).toBe(0);
        expect(result.cases[0]?.error).toBeDefined();
      }
      const failures = outcome.report.failures as Record<string, { error?: string }[]>;
      expect(failures.names?.[0]?.error).toContain('503');
      expect(liveGate(settings(), outcome.results)).toContain('live accuracy 0.0% is below the 50% floor');
    } finally {
      await engine.close();
      await endpoint.close();
    }
  }, 60_000);
});

describe('the gate', () => {
  const result = (arm: string, passed: number, total: number): LiveArmResult => ({
    arm,
    summary: {
      arm,
      passed,
      total,
      accuracy: total === 0 ? 0 : passed / total,
      outcomes: Array.from({ length: total }, (_unused, index) => ({ id: `c${String(index)}`, passed: index < passed })),
    },
    wilson: { low: 0, high: 1 },
    repeats: 1,
    flips: 0,
    cases: [],
    byIntent: {},
  });

  it('names every arm when the run is missing one', () => {
    expect(liveGate(settings(), [result('names', 1, 1)])).toEqual([
      'the run is missing an arm: it has names',
    ]);
  });

  it('fails a samples arm that trails the baseline by more than the tolerance', () => {
    const problems = liveGate(settings(), [result('names', 10, 10), result('samples', 5, 10), result('repair', 10, 10)]);
    expect(problems).toEqual(['schema samples regressed accuracy by more than 5pp']);
  });

  it('fails a repair arm that trails the baseline by more than the tolerance', () => {
    const problems = liveGate(settings(), [result('names', 10, 10), result('samples', 10, 10), result('repair', 5, 10)]);
    expect(problems).toEqual(['the repair loop regressed accuracy by more than 5pp']);
  });

  it('passes a run whose arms are within tolerance of each other', () => {
    expect(liveGate(settings(), [result('names', 10, 10), result('samples', 10, 10), result('repair', 10, 10)])).toEqual([]);
  });
});

describe('the log lines', () => {
  it('reports both pairings with their exact p value', async () => {
    const endpoint = await startEndpoint({ reply: (request) => replyFor(request.prompt, true) });
    const engine = await createDuckDbEngine();
    try {
      const provider = (await import('@agentix-e/nl2charts-ai')).createHttpProvider({
        baseUrl: endpoint.url,
        apiKey: 'test-key',
        model: 'stub-model',
      });
      const outcome = await runLive(settings(), { engine, provider, cases: CASES });
      const text = liveLines(outcome).join('\n');
      expect(text).toContain('[names] exact 100.0% (3/3)');
      expect(text).toContain('repeats per case: 1');
      expect(text).toContain('value profiling: 0.0pp');
      expect(text).toContain('p=1.0000');
    } finally {
      await engine.close();
      await endpoint.close();
    }
  });

  it('names the intents that did not reach the baseline', async () => {
    const endpoint = await startEndpoint({ reply: (request) => replyFor(request.prompt, false) });
    const engine = await createDuckDbEngine();
    try {
      const provider = (await import('@agentix-e/nl2charts-ai')).createHttpProvider({
        baseUrl: endpoint.url,
        apiKey: 'test-key',
        model: 'stub-model',
      });
      const outcome = await runLive(settings(), { engine, provider, cases: CASES });
      const text = liveLines(outcome).join('\n');
      // Every case failed, so every intent appears with its score under it.
      expect(text).toContain('revenue_by_region                0/3');
    } finally {
      await engine.close();
      await endpoint.close();
    }
  });
});
