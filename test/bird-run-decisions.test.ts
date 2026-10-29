/**
 * The runner's decisions, made without a database or a model.
 *
 * `bird-run-e2e.test.ts` drives the whole harness; this file pins the parts whose truth is
 * a comparison rather than a run — where a path points, what a setting resolves to, and
 * what the gate says about a report. They were inside the same 1,100-line function as the
 * arm loop until this round, so the only way to ask "does the gate fire on a 97% gold rate"
 * was to find a dataset that produced one.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  armReportRow,
  armSummaryLine,
  caseRows,
  databasesFromManifest,
  databasesFromQuestions,
  evaluateGate,
  meanCalls,
  offeredCandidates,
  pairedComparisons,
  resolveLayout,
  resolveArm,
  resolveSettings,
  secondModelRoles,
} from '../eval/bird/run.js';
import type { Arm, CaseRun, PreparedRun } from '../eval/bird/run.js';

describe('where a run points', () => {
  it('derives every path from the split, and lets the environment move each one', () => {
    const mini = resolveLayout({}, '/repo');
    expect(mini.split).toBe('minidev');
    expect(mini.data).toBe('/repo/eval/.cache/bird/minidev/MINIDEV');
    expect(mini.questionsFile).toBe('/repo/eval/.cache/bird/minidev/MINIDEV/mini_dev_sqlite.json');
    expect(mini.databaseRoot).toBe('/repo/eval/.cache/bird/minidev/MINIDEV/dev_databases');
    // The description CSV lives under the data directory even when the databases do not,
    // which is why it is a separate field rather than a join at each call site.
    expect(mini.descriptionsRoot).toBe('/repo/eval/.cache/bird/minidev/MINIDEV/dev_databases');
    expect(mini.out).toBe('/repo/eval/out/bird-eval.json');

    // The dev split renames the question file and moves the directory; everything else in
    // the layout is the same shape.
    const dev = resolveLayout({ BIRD_SPLIT: 'dev' }, '/repo');
    expect(dev.data).toBe('/repo/eval/.cache/bird/dev/dev_20240627');
    expect(dev.questionsFile).toBe('/repo/eval/.cache/bird/dev/dev_20240627/dev.json');

    const moved = resolveLayout(
      { BIRD_DATA: '/data', BIRD_DATABASES: '/dbs', BIRD_OUT: '/out.json' },
      '/repo',
    );
    expect(moved.questionsFile).toBe('/data/mini_dev_sqlite.json');
    expect(moved.databaseRoot).toBe('/dbs');
    expect(moved.descriptionsRoot).toBe('/data/dev_databases');
    expect(moved.out).toBe('/out.json');
    // The oracle is harness code, not dataset: it stays next to this file whatever the
    // dataset is, or a run against an external directory could not execute anything.
    expect(moved.oracleScript.endsWith('/eval/bird/oracle.py')).toBe(true);
  });
});

describe('which databases a run covers', () => {
  it('reports no databases rather than throwing when there is no manifest at all', () => {
    // The runner falls back to the questions file, so a missing manifest is a state and
    // not an error: the splits that ship one are the derived ones.
    expect(databasesFromManifest('/does/not/exist')).toEqual([]);
  });

  it('falls back to the databases the questions name, and survives a missing questions file', () => {
    expect(databasesFromQuestions('/does/not/exist.json')).toEqual([]);
  });

  it('prefers BIRD_DBS, then the manifest, then the questions', () => {
    const explicit = resolveSettings({ BIRD_DBS: ' a , b ,, c ' }, [], '/repo');
    // Trimmed and de-blanked: a trailing comma in a workflow input used to add an empty
    // database name, and the run then failed looking for a directory called ''.
    expect(explicit.dbs).toEqual(['a', 'b', 'c']);

    const empty = resolveSettings({}, [], '/repo');
    // Nothing behind this root, so both readers report nothing and the list is empty; the
    // run then says "no questions for " instead of failing inside the loader.
    expect(empty.dbs).toEqual([]);
  });
});

describe('what a run was told to do', () => {
  it('reads the arm chain, the A/A duplicate and the sample size', () => {
    const settings = resolveSettings(
      { BIRD_ARMS: 'names, metadata', BIRD_AA: 'names', BIRD_LIMIT: '12.7', BIRD_CONCURRENCY: '3' },
      ['--dry-run'],
      '/repo',
    );
    // The duplicate is appended under `#2` so it keeps its own row: the parser is the only
    // thing standing between a typo and an arm that silently runs twice for nothing.
    expect(settings.arms).toEqual(['names', 'metadata', 'names#2']);
    // `12.7` is floored, not rounded: a limit is a count of questions.
    expect(settings.limit).toBe(12);
    expect(settings.dryRun).toBe(true);
    expect(settings.concurrency).toBe(3);
  });

  it('falls back to the split\'s published size when the limit is missing or nonsense', () => {
    expect(resolveSettings({}, [], '/repo').limit).toBe(500);
    expect(resolveSettings({ BIRD_SPLIT: 'dev' }, [], '/repo').limit).toBe(1534);
    expect(resolveSettings({ BIRD_LIMIT: '0' }, [], '/repo').limit).toBe(500);
    expect(resolveSettings({ BIRD_LIMIT: 'lots' }, [], '/repo').limit).toBe(500);
  });

  it('carries the harness knobs a difference between two runs could come from', () => {
    const settings = resolveSettings(
      {
        BIRD_LLM_TIMEOUT_MS: '9000',
        BIRD_LLM_RETRIES: '1',
        BIRD_LLM_RETRY_DELAY_MS: '5',
        BIRD_VALUES_FORCE: '1',
        BIRD_DEFINITIONS_FORCE: '1',
      },
      [],
      '/repo',
    );
    expect(settings).toMatchObject({
      timeoutMs: 9000,
      retries: 1,
      retryDelayMs: 5,
      valuesForce: true,
      definitionsForce: true,
    });
    // Defaults are the published ones, so a report that omits them can be read back.
    const defaults = resolveSettings({}, [], '/repo');
    expect(defaults).toMatchObject({ timeoutMs: 60000, retries: 3, retryDelayMs: 1000, valuesForce: false });
    expect(defaults.model).toBe('deepseek-chat');
  });

  it('takes the second model from its own variables, and the key from either name', () => {
    const second = resolveSettings(
      { BIRD_SECOND_MODEL: 'glm', BIRD_SECOND_BASE_URL: 'https://second/v1', ZHIPU_API_KEY: 'z' },
      [],
      '/repo',
    );
    // The key falls back to the org secret's name: two names for one credential, and a
    // run that needs it must not fail because the other one was set.
    expect(second.second).toEqual({ model: 'glm', baseUrl: 'https://second/v1', apiKey: 'z' });
    const own = resolveSettings({ BIRD_SECOND_API_KEY: 'b', ZHIPU_API_KEY: 'z' }, [], '/repo');
    expect(own.second.apiKey).toBe('b');
  });
});

describe('who needs the second model', () => {
  it('separates an arm that draws a candidate from one that swaps the judge', () => {
    // The two roles produce different sentences when the model is missing, so they are
    // read separately and not collapsed into "this run needs a second model".
    expect(secondModelRoles(['select-cross'])).toEqual({ draws: true, judges: false });
    expect(secondModelRoles(['select-cross-judge'])).toEqual({ draws: true, judges: true });
    expect(secondModelRoles(['names', 'inline+evidence'])).toEqual({ draws: false, judges: false });
  });
});

describe('the candidates a selector may see', () => {
  const rows = (count: number): { rows: number[] }[] => Array.from({ length: count }, (_, index) => ({ rows: index === 0 ? [] : [1] }));

  it('offers everything when empty results are not being dropped', () => {
    const offered = offeredCandidates(rows(3), false);
    expect(offered.dropped).toBe(0);
    expect(offered.offered).toHaveLength(3);
  });

  it('drops a candidate that returned nothing, and counts what it dropped', () => {
    const offered = offeredCandidates(rows(3), true);
    expect(offered.dropped).toBe(1);
    expect(offered.offered).toHaveLength(2);
  });

  it('keeps the whole set when every candidate is empty', () => {
    // Removing every candidate would leave nothing to select from, and the arm would report
    // a selector failure where the truth is that the whole set came back empty.
    const all = [{ rows: [] }, { rows: [] }];
    const offered = offeredCandidates(all, true);
    expect(offered.dropped).toBe(0);
    expect(offered.offered).toHaveLength(2);
  });
});

describe('what a call cost', () => {
  it('reports one call per case when there are no cases, not a division by zero', () => {
    // An arm with no scored cases still gets a row; the alternative is `NaN` in an artifact.
    expect(meanCalls([])).toBe(1);
    expect(meanCalls([{ calls: 1 }, { calls: 3 }])).toBe(2);
  });
});

describe('the paired comparisons', () => {
  const run = (id: string, passed: boolean): CaseRun => ({
    id,
    passed,
    predicted: 'select 1',
    reason: 'values',
    strict: false,
    attempts: 1,
    calls: 1,
  });

  it('reports only the pairs whose both arms ran', () => {
    const outcomes = new Map<string, readonly CaseRun[]>([
      ['names', [run('1', true), run('2', false)]],
      ['metadata', [run('1', true), run('2', true)]],
    ]);
    const { comparisons, ablations, aa } = pairedComparisons(outcomes);
    // `names -> metadata` is one lever apart, so it is an ablation; the level comparisons
    // are absent because neither of their arms ran.
    expect(Object.keys(ablations)).toEqual(['names -> metadata']);
    expect(ablations['names -> metadata']).toMatchObject({ delta: 0.5, onlyFirst: 0, onlySecond: 1 });
    expect(Object.keys(comparisons)).toEqual([]);
    expect(aa).toBeUndefined();
  });

  it('reports a level comparison separately from a one-lever ablation', () => {
    // Mixing the two tables would let a two-lever difference borrow the authority of a
    // one-lever experiment, which is why they are keyed apart.
    const outcomes = new Map<string, readonly CaseRun[]>([
      ['inline+evidence', [run('1', false), run('2', false)]],
      ['values', [run('1', true), run('2', false)]],
    ]);
    const { comparisons, ablations } = pairedComparisons(outcomes);
    expect(Object.keys(comparisons)).toEqual(['inline+evidence -> values']);
    expect(comparisons['inline+evidence -> values']).toMatchObject({ onlyFirst: 0, onlySecond: 1 });
    expect(Object.keys(ablations)).toEqual(['inline+evidence -> values']);
  });

  it('reads an A/A pair from the duplicate label, and ignores a duplicate whose base is missing', () => {
    const paired = pairedComparisons(
      new Map<string, readonly CaseRun[]>([
        ['names', [run('1', true), run('2', false)]],
        ['names#2', [run('1', true), run('2', true)]],
      ]),
    );
    // Same arm, same data, same prompt, twice: the delta is the harness's own noise.
    expect(paired.aa).toMatchObject({ arm: 'names', delta: 0.5, onlyFirst: 0, onlySecond: 1 });

    const orphan = pairedComparisons(new Map<string, readonly CaseRun[]>([['names#2', [run('1', true)]]]));
    // A duplicate without its base says nothing, and must not report a comparison against
    // an arm that did not run.
    expect(orphan.aa).toBeUndefined();
  });
});

describe('what a delta is resolved to', () => {
  const run = (id: string, passed: boolean): CaseRun => ({
    id,
    passed,
    predicted: 'select 1',
    reason: 'values',
    strict: false,
    attempts: 1,
    calls: 1,
  });

  it('carries the interval and the smallest difference the cases could detect', () => {
    // p alone cannot separate "no effect" from "no measurement". Two cases with one
    // discordant pair resolve nothing, and the row says so instead of quoting a delta.
    const { ablations } = pairedComparisons(
      new Map<string, readonly CaseRun[]>([
        ['names', [run('1', true), run('2', false)]],
        ['metadata', [run('1', true), run('2', true)]],
      ]),
    );
    expect(ablations['names -> metadata']).toMatchObject({
      delta: 0.5,
      ci: { low: -0.48, high: 1.48 },
      discordantShare: 0.5,
      // Capped at the whole range: a design that can only detect "everything" resolves nothing.
      mde: 1,
    });
  });

  it('does not read two arms that agreed on every case as a resolved question', () => {
    const cases = Array.from({ length: 20 }, (_, index) => run(String(index), true));
    const { comparisons } = pairedComparisons(
      new Map<string, readonly CaseRun[]>([
        ['inline+evidence', cases],
        ['select', cases],
      ]),
    );
    // Zero discordant pairs: the rule of three puts the 95% bound on the discordance rate
    // at 3/20, so the design still cannot exclude a 24pp difference.
    expect(comparisons['inline+evidence -> select']).toMatchObject({
      delta: 0,
      ci: { low: -0.1697, high: 0.1697 },
      discordantShare: 0.15,
      mde: 0.2426,
    });
  });

  it('states the resolution of the A/A pair, because every other delta is read against it', () => {
    const paired = pairedComparisons(
      new Map<string, readonly CaseRun[]>([
        ['names', [run('1', true), run('2', false)]],
        ['names#2', [run('1', true), run('2', true)]],
      ]),
    );
    expect(paired.aa).toMatchObject({ delta: 0.5, discordantShare: 0.5, mde: 1 });
  });

  it('sizes the run a 2pp claim would need from the discordance the pair showed', () => {
    // The cross-vendor pair as measured: 120 cases, 1 before and 4 after. 818 is the number
    // that decides the next dispatch, and it is computed from this artifact rather than
    // quoted from a document.
    const first = Array.from({ length: 120 }, (_, index) => run(String(index), index !== 1 && index !== 2 && index !== 3 && index !== 4));
    const second = Array.from({ length: 120 }, (_, index) => run(String(index), index !== 0));
    const { comparisons } = pairedComparisons(
      new Map<string, readonly CaseRun[]>([
        ['inline+evidence', first],
        ['select', second],
      ]),
    );
    expect(comparisons['inline+evidence -> select']).toMatchObject({
      onlyFirst: 1,
      onlySecond: 4,
      mde: 0.0522,
      discordantShare: 0.0417,
      casesForClaim: 818,
    });
  });
});

describe('the gate', () => {
  const report = (
    gold: Record<string, unknown> = {},
    controls: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    gold: { runnableRate: 1, ...gold },
    controls: {
      selfConsistency: 1,
      negativeFalseMatches: 0,
      schemaMissingTotal: 0,
      schemaChecked: 6,
      truncatedPrompts: [],
      ...controls,
    },
    arms: [
      { arm: 'names', accuracy: 0.5 },
      { arm: 'metadata', accuracy: 0.55 },
    ],
  });

  it('passes a run whose controls hold and whose best arm sees a signal', () => {
    expect(evaluateGate(report())).toEqual([]);
  });

  it('fails a gold set that does not run', () => {
    expect(evaluateGate(report({ runnableRate: 0.9 }))).toEqual(['gold runnable rate 90.0% is below 98%']);
  });

  it('fails a judge that does not agree with itself', () => {
    expect(evaluateGate(report({}, { selfConsistency: 0.99 }))).toEqual(['self-consistency 99.0% is not 100%']);
  });

  it('fails a negative control that matched', () => {
    expect(evaluateGate(report({}, { negativeFalseMatches: 2 }))).toEqual([
      '2 negative control(s) matched a gold result',
    ]);
  });

  it('fails a prompt that advertises a column the database does not have', () => {
    expect(evaluateGate(report({}, { schemaMissingTotal: 3 }))).toEqual([
      '3 of 6 advertised columns do not exist in the database',
    ]);
  });

  it('fails a schema card that silently dropped a table', () => {
    // The card is truncated by a character budget, and a model cannot query a table it was
    // never shown: 155 of 200 cases once died on "no such column" for this reason.
    expect(evaluateGate(report({}, { truncatedPrompts: [{ db: 'shop', shown: 1, total: 2 }] }))).toEqual([
      'schema card truncated for shop (1/2)',
    ]);
  });

  it('fails a run whose best arm is indistinguishable from guessing', () => {
    expect(
      evaluateGate({ ...report(), arms: [{ arm: 'names', accuracy: 0.04 }] }),
    ).toEqual(['best arm accuracy 4.0% is not above 5%: the harness sees no signal']);
  });

  it('fails a last arm that trails the first by more than five points', () => {
    expect(
      evaluateGate({
        ...report(),
        arms: [
          { arm: 'names', accuracy: 0.6 },
          { arm: 'metadata', accuracy: 0.5 },
        ],
      }),
    ).toEqual(['metadata trails names by more than 5pp, which is a regression not a result']);
  });

  it('does not call a judge swap that loses ground a regression', () => {
    // The arm exists to price the judge, so a large negative delta is the answer rather than
    // a defect: `40828283888` read 54.7% against 60.7% and the gate refused to publish the
    // one number the experiment was run for. Outages are caught by their own guards.
    expect(
      evaluateGate({
        ...report(),
        arms: [
          { arm: 'select-cross', accuracy: 0.607 },
          { arm: 'select-cross-judge', accuracy: 0.547 },
        ],
      }),
    ).toEqual([]);
    // The same gap between two arms that share a judge is still a regression.
    expect(
      evaluateGate({
        ...report(),
        arms: [
          { arm: 'select-cross', accuracy: 0.607 },
          { arm: 'select-mixed', accuracy: 0.547 },
        ],
      }),
    ).toEqual(['select-mixed trails select-cross by more than 5pp, which is a regression not a result']);
  });

  it('reports every problem it found, not only the first', () => {
    // A run that trips three thresholds should not have to be fixed three times.
    expect(evaluateGate(report({ runnableRate: 0.5 }, { selfConsistency: 0.5, schemaMissingTotal: 1 }))).toHaveLength(3);
  });
});

describe('the dataset a run reads', () => {
  it('names the databases a manifest lists when there is one', () => {
    // The manifest is what makes widening a dataset one command instead of two edits that
    // can drift, so reading it is the primary path and the questions are the fallback.
    const directory = mkdtempSync(join(tmpdir(), 'nl2charts-manifest-'));
    try {
      writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ databases: [{ db: 'shop' }, { db: 'music' }] }));
      expect(databasesFromManifest(directory)).toEqual(['shop', 'music']);
      writeFileSync(join(directory, 'manifest.json'), JSON.stringify({}));
      // A manifest without a database list is a partial fetch, not a crash.
      expect(databasesFromManifest(directory)).toEqual([]);
      writeFileSync(join(directory, 'manifest.json'), 'not json');
      expect(databasesFromManifest(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/**
 * What a row and a line say, read without running anything.
 *
 * `armSummaryLine` and `armReportRow` are what a reader sees after a run and what the
 * artifact carries; every branch in them is a decision about a *label* — whether to print
 * a recall column, whether to name a judge, whether to admit that a case's difficulty is
 * unknown. They were only ever reached through a full run, which means the arms the
 * default list does not contain had their labels written by code no test could choose.
 */
describe('what an arm row says about itself', () => {
  const outcome = (id: string, passed: boolean): CaseRun => ({
    id,
    passed,
    predicted: 'select 1',
    reason: 'values',
    strict: false,
    attempts: 1,
    calls: 1,
  });
  const question = (id: number, difficulty: 'simple' | 'moderate' | 'challenging') => ({
    question_id: id,
    db_id: 'shop',
    question: `question ${id}`,
    evidence: '',
    SQL: 'select 1',
    difficulty,
  });
  const preparedWith = (cases: readonly ReturnType<typeof question>[]): PreparedRun =>
    ({
      cases,
      schemaFor: () => [],
      blocksFor: () => ({}),
    }) as unknown as PreparedRun;

  it('leaves the recall column off an arm that generates once', () => {
    // `names` draws one statement, so a ceiling would be a column that always reads 100%
    // and a selector loss that is always zero. The column is absent, not zero.
    const line = armSummaryLine('names', resolveArm('names') as Arm, [outcome('1', true), outcome('2', false)]);
    expect(line).toContain('1/2  50.0%');
    expect(line).toContain('strict 0');
    expect(line).not.toContain('recall@');
  });

  it('prints the ceiling on the arm that samples, and names the vote it measured', () => {
    const runs: CaseRun[] = [
      // The first case kept the answer it had; the second threw one away, which is the
      // only kind of case a selector loss can be counted on.
      { ...outcome('1', true), candidateRecall: true, agreement: 0.66 },
      { ...outcome('2', false), candidateRecall: true, agreement: 0.33 },
    ];
    const line = armSummaryLine('select-cross', resolveArm('select-cross') as Arm, runs);
    // The ceiling is 100% — both candidate sets contained a match — and the arm kept half.
    expect(line).toContain('samples 3');
    expect(line).toContain('recall@3 100.0% (lost 1)');
  });

  it('files a case the dataset does not describe under unknown', () => {
    // A run row whose question is not in `cases` is a defect upstream, but the row still
    // has to land somewhere: an unlabelled bucket is honest, and dropping it would make
    // the difficulty table sum to less than the arm's own total.
    const row = armReportRow(preparedWith([question(1, 'simple')]), resolveArm('names') as Arm, [outcome('99', true)], 'names');
    expect(row.byDifficulty).toEqual({ unknown: { passed: 1, total: 1 } });
  });

  it('counts a run that carries a message but no kind as an unclassified error', () => {
    // `errorKind` is set by the arm loop; a case that failed the way the loop does not
    // expect still has a message, and the four counters must add up to the failures.
    const row = armReportRow(preparedWith([question(1, 'simple'), question(2, 'moderate')]), resolveArm('names') as Arm, [
      { ...outcome('1', false), error: 'boom' },
      { ...outcome('2', false), error: 'the engine refused', errorKind: 'execution' },
      outcome('3', true),
    ], 'names');
    expect(row.errors).toMatchObject({ execution: 1, guard: 0, llm: 0, other: 1 });
    expect(row.firstError).toBe('boom');
    expect(row.llmFailureShare).toBe(0);
  });

  it('names a judge only on the arm that has one, and says which one', () => {
    const cross = armReportRow(preparedWith([question(1, 'simple')]), resolveArm('select-cross') as Arm, [outcome('1', true)], 'select-cross');
    expect(cross.vote).toBe(3);
    expect(cross.judge).toBeUndefined();
    expect(cross.selector).toBe('model');
    const judged = armReportRow(
      preparedWith([question(1, 'simple')]),
      resolveArm('select-cross-judge') as Arm,
      [outcome('1', true)],
      'select-cross-judge',
    );
    expect(judged.judge).toBe('second');
  });

  it('admits that the prompt size excludes a block written at call time', () => {
    // A size that silently leaves out the plan it added would report the arm as cheap.
    const charsOf = (row: unknown): { excludes?: readonly string[] } =>
      (row as { promptChars: { excludes?: readonly string[] } }).promptChars;
    for (const name of ['plan', 'interpret']) {
      const row = armReportRow(preparedWith([question(1, 'simple')]), resolveArm(name) as Arm, [outcome('1', true)], name);
      expect(charsOf(row).excludes).toEqual(['plan/interpretation written at call time']);
    }
    const plain = armReportRow(preparedWith([question(1, 'simple')]), resolveArm('names') as Arm, [outcome('1', true)], 'names');
    expect(charsOf(plain).excludes).toBeUndefined();
  });

  it('prices a lever that spends extra calls by the point it buys per call', () => {
    // A voting arm costs three calls where the arm it is compared to costs one, and the
    // pair is the only place the per-call price exists: without it a +6pp lever and a
    // +6pp lever that costs three times as much look the same in the artifact.
    const called = (id: string, passed: boolean, calls: number): CaseRun => ({
      ...outcome(id, passed),
      calls,
    });
    const { ablations } = pairedComparisons(
      new Map<string, readonly CaseRun[]>([
        ['inline+evidence', [called('1', false, 1), called('2', false, 1)]],
        ['vote', [called('1', true, 3), called('2', true, 3)]],
      ]),
    );
    const priced = ablations['inline+evidence -> vote'] as {
      cost: { extraCallsPerCase: number; ppPerExtraCall?: number };
    };
    expect(priced.cost.extraCallsPerCase).toBe(2);
    expect(priced.cost.ppPerExtraCall).toBe(50);
  });

  it('prices a lever that costs a call and leaves a free one unpriced', () => {
    // A placement lever spends nothing extra; dividing its delta by zero extra calls would
    // call it infinitely efficient, which is a different claim from "it is free".
    const outcomes = new Map<string, readonly CaseRun[]>([
      ['names', [outcome('1', false), outcome('2', false)]],
      ['definitions', [outcome('1', true), outcome('2', false)]],
    ]);
    const { ablations } = pairedComparisons(outcomes);
    const priced = ablations['names -> definitions'] as { cost: { extraCallsPerCase: number; ppPerExtraCall?: number } };
    expect(priced.cost.extraCallsPerCase).toBe(0);
    expect(priced.cost.ppPerExtraCall).toBeUndefined();
  });
});

/**
 * The per-case rows, which are the only place a reader can ask why one case cost less.
 *
 * `select-mixed` spent three calls on two of 120 questions while `select-cross` spent
 * four, and the artifact could not say why: `reason: 'values'` with `candidateRecall:
 * false` is what a zero-candidate case looks like *and* what a surviving-candidates-but-
 * wrong case looks like. The two are different problems — statements the engine refused
 * versus statements that ran and were wrong — and telling them apart needed one field.
 */
describe('the per-case rows an artifact carries', () => {
  const bare = (over: Partial<CaseRun> = {}): CaseRun => ({
    id: '1',
    passed: false,
    predicted: '',
    reason: 'values',
    strict: false,
    attempts: 3,
    calls: 3,
    ...over,
  });

  it('says why a case has no candidate, not only that it has none', () => {
    const rows = caseRows(
      new Map<string, readonly CaseRun[]>([
        ['select-mixed', [bare(), bare({ error: 'no sample survived guard and execution', errorKind: 'other' })]],
      ]),
    );
    // A case that ran and was wrong carries neither field: an absent error is not an
    // error with an empty message.
    expect(rows[0]).not.toHaveProperty('errorKind');
    expect(rows[0]).not.toHaveProperty('error');
    expect(rows[1]?.errorKind).toBe('other');
    expect(rows[1]?.error).toBe('no sample survived guard and execution');
  });

  it('truncates a long message so one row cannot dominate the artifact', () => {
    const rows = caseRows(new Map<string, readonly CaseRun[]>([['names', [bare({ error: 'x'.repeat(400) })]]]));
    expect(rows[0]?.error).toHaveLength(160);
  });

  it('keeps the ceiling per case, because a paired outcome can be tested and a share cannot', () => {
    const rows = caseRows(
      new Map<string, readonly CaseRun[]>([
        ['select-mixed', [bare({ candidateRecall: true }), bare({ id: '2' })]],
      ]),
    );
    expect(rows[0]?.candidateRecall).toBe(true);
    expect(rows[1]).not.toHaveProperty('candidateRecall');
    expect(rows.map((row) => row.arm)).toEqual(['select-mixed', 'select-mixed']);
  });
});
