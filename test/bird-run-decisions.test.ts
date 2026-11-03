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
  assertPoolShared,
  assertSelectorAnswered,
  reusePool,
  poolReadOf,
  spendOf,
  assertReconcileFired,
  assertDissentFired,
  assertDissentRule,
  assertSampleBlockFired,
  dissentFunnel,
  reconcileFunnel,
  sampleBlockFunnel,
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
    // The profile cache lives *inside* the dataset, for the reason the value-examples cache does:
    // it is a description of these files. One directory for every dataset let a test fixture's
    // `shop` answer for the corpus's, and the reading that came back was the fixture's schema
    // rendered onto a question it never had — a wrong card, published green.
    expect(mini.profileCache).toBe('/repo/eval/.cache/bird/minidev/MINIDEV/.profiles');

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
      { BIRD_ARMS: 'names, metadata', BIRD_AA: 'names', BIRD_LIMIT: '12', BIRD_CONCURRENCY: '3' },
      ['--dry-run'],
      '/repo',
    );
    // The duplicate is appended under `#2` so it keeps its own row: the parser is the only
    // thing standing between a typo and an arm that silently runs twice for nothing.
    expect(settings.arms).toEqual(['names', 'metadata', 'names#2']);
    expect(settings.limit).toBe(12);
    expect(settings.dryRun).toBe(true);
    expect(settings.concurrency).toBe(3);
  });

  it('leaves the sample size undecided when nothing asks for one, instead of copying the split', () => {
    // The copy was a row count (500 for Mini-Dev's 498 questions) and every default run declared
    // a request the split could not satisfy; `resolveLimit` decides against the file it reads.
    expect(resolveSettings({}, [], '/repo').limit).toBeUndefined();
    expect(resolveSettings({ BIRD_SPLIT: 'dev' }, [], '/repo').limit).toBeUndefined();
  });

  it('refuses a sample size that is not a whole number of questions', () => {
    expect(() => resolveSettings({ BIRD_LIMIT: '0' }, [], '/repo')).toThrow(/not a question count/);
    expect(() => resolveSettings({ BIRD_LIMIT: 'lots' }, [], '/repo')).toThrow(/not a question count/);
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
      // The card that was sent, as the row's prompt-size column reads it. An arm that makes no
      // choice sends the card `schemaFor` builds, so the read returns the same empty frame.
      cardOf: () => ({ schema: [] }),
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

  it('says how much of the bill each kind of call is', () => {
    // A four-call arm is a purchase of three things: a statement, a selector's judgement, and
    // the extra draws. Reporting the price as one number makes "the selector is worth its
    // tokens" an argument; reporting it per call makes it a column.
    const priced = (id: string, passed: boolean): CaseRun => ({
      ...outcome(id, passed),
      calls: 2,
      tokens: {
        prompt: 130,
        completion: 20,
        chars: 400,
        unbilled: 0,
        byPurpose: {
          generate: { calls: 1, prompt: 100, completion: 18, chars: 380, unbilled: 0 },
          select: { calls: 1, prompt: 30, completion: 2, chars: 20, unbilled: 0 },
        },
      },
    });
    const row = armReportRow(preparedWith([question(1, 'simple')]), resolveArm('select') as Arm, [priced('1', true)], 'select');
    expect(row.tokens?.byPurpose?.generate?.prompt).toBe(100);
    expect(row.tokens?.byPurpose?.select).toMatchObject({ calls: 1, prompt: 30, completion: 2 });
  });

  it('publishes a metered cost with no purpose breakdown, and keeps the breakdown absent', () => {
    // The two halves of the same column. `byPurpose` was only ever read on an artifact that
    // had one — `byPurpose: { generate, select }` was in every test ever written for this row
    // — so the case the branch exists for was the one nobody exercised: a provider that
    // reports a usage block and no purpose split. That is the older artifact and the plain
    // endpoint both, and reporting `byPurpose: {}` there would claim a breakdown of nothing.
    const flat: CaseRun = {
      ...outcome('1', true),
      tokens: { prompt: 100, completion: 10, chars: 400, unbilled: 0 },
    };
    const row = armReportRow(preparedWith([question(1, 'simple')]), resolveArm('names') as Arm, [flat], 'names');
    expect(row.tokens).toMatchObject({ prompt: 100, completion: 10, chars: 400 });
    expect(row.tokens?.byPurpose).toBeUndefined();
  });

  it('sums what the endpoint dropped over the cases that carried one, and only those', () => {
    // A mixed run: one case was charged for a `temperature` the endpoint accepted and ignored,
    // the other asked for no sampling at all and therefore reported nothing. Summing over
    // every run would need a zero for the second, which is a claim about a request that never
    // named the parameter; the field is absent on that case for the same reason it is absent
    // from a report where no case carried one.
    const charged: CaseRun = { ...outcome('1', true), samplingOmitted: { temperature: 1 } };
    const plain: CaseRun = outcome('2', true);
    const row = armReportRow(preparedWith([question(1, 'simple')]), resolveArm('names') as Arm, [charged, plain], 'names');
    expect(row.samplingOmitted).toEqual({ temperature: 1 });
    const clean = armReportRow(preparedWith([question(1, 'simple')]), resolveArm('names') as Arm, [plain], 'names');
    expect(clean.samplingOmitted).toBeUndefined();
  });

  it('refuses to publish a cost whose calls do not say what they were for', () => {
    // An unattributed call is a cost with no owner: it inflates the total and belongs to no
    // row of the table the total is read against. The run fails rather than publishing a
    // share whose denominator contains calls nobody can name.
    const anonymous: CaseRun = {
      ...outcome('1', true),
      calls: 1,
      tokens: {
        prompt: 10,
        completion: 1,
        chars: 20,
        unbilled: 0,
        byPurpose: { unlabelled: { calls: 1, prompt: 10, completion: 1, chars: 20, unbilled: 0 } },
      },
    };
    expect(() => armReportRow(preparedWith([question(1, 'simple')]), resolveArm('select') as Arm, [anonymous], 'select')).toThrow(
      /do not say what they were for/,
    );
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

  it('carries what the value block put on the card, so a stratum can be cut from the artifact', () => {
    // The first dispatch of the narrowed block published the arm-level funnel and not the record:
    // `sampleBlock` said 511 of 1,532 cases carried a value, and the artifact could not say which
    // 511 — so the only way to ask "did it work where it fired" was to reconstruct the block's
    // presence from the per-case prompt tokens. That reconstruction worked and it should not have
    // been necessary: a funnel says how many, a row says which.
    const rows = caseRows(
      new Map<string, readonly CaseRun[]>([
        ['inline+evidence+samples-gold', [bare({ sampleBlock: { columns: 1 } }), bare({ id: '2', sampleBlock: { columns: 0 } })]],
      ]),
    );
    expect(rows[0]?.sampleBlock).toEqual({ columns: 1 });
    // A zero is a measured zero — the rule ran and kept nothing — so it is published rather than
    // dropped as falsy.
    expect(rows[1]?.sampleBlock).toEqual({ columns: 0 });
    // An arm with no sampler carries no record at all, which is a different claim from a zero.
    expect(caseRows(new Map<string, readonly CaseRun[]>([['names', [bare()]]]))[0]).not.toHaveProperty('sampleBlock');
  });

  it('carries what the reconcile turn did, so a paired reading names the cases and not just the count', () => {
    // The fifth dispatch published the funnel and not the record, so "514 replies restated a
    // candidate" could not be turned into "these are the cases a paraphrase cost us": a share
    // describes the arm, a row describes the case, and a pair of arms is tested on the second.
    const rows = caseRows(
      new Map<string, readonly CaseRun[]>([
        [
          'select-cross-pooled-reconcile-novel',
          [
            bare({ reconcile: { returned: true, novel: true, executable: true, adopted: true } }),
            bare({ id: '2', reconcile: { returned: true, novel: false, executable: true, adopted: false } }),
          ],
        ],
      ]),
    );
    expect(rows[0]?.reconcile).toEqual({ returned: true, novel: true, executable: true, adopted: true });
    expect(rows[1]?.reconcile).toEqual({ returned: true, novel: false, executable: true, adopted: false });
    // An arm with no reconcile turn carries no record: an absent turn is not a turn that failed.
    expect(caseRows(new Map<string, readonly CaseRun[]>([['select-cross', [bare()]]]))[0]).not.toHaveProperty('reconcile');
  });
});

/**
 * A pooled arm that did not read the pool is its parent under another name.
 *
 * The failure this guards is arithmetic, not a crash: an arm that quietly generated its own
 * candidates spends four calls instead of one and reports a pool it never read. The suite could
 * see that in a delta nobody could attribute, which is how two arms in round 44 came to publish
 * +2.17pp and +2.50pp against a parent whose pool they had drawn themselves.
 */
describe('a shared pool has to be the same pool', () => {
  const row = (id: string, recall: boolean): CaseRun => ({
    id,
    passed: recall,
    predicted: 'select 1',
    reason: 'values',
    strict: false,
    attempts: 3,
    calls: 1,
    candidateRecall: recall,
  });

  it('accepts two arms that read the same candidates case for case', () => {
    const source = [row('1', true), row('2', false), row('3', true)];
    expect(() => assertPoolShared('pooled', source, source, 1)).not.toThrow();
  });

  it('refuses an arm whose ceiling disagrees with the pool it names', () => {
    // One case is enough: a shared pool is not a rate, it is an identity.
    const source = [row('1', true), row('2', false)];
    const pooled = [row('1', false), row('2', false)];
    expect(() => assertPoolShared('pooled', pooled, source, 1)).toThrow(/generated its own candidates/);
  });

  it('names the cases that disagree, so the reader can open them', () => {
    // The count alone cannot separate a pool that was regenerated from a pool that was read and
    // then half-lost. `41410112996` died on three cases and the message named none of them.
    const source = [row('1', true), row('2', false)];
    const pooled = [row('1', false), row('2', false)];
    expect(() => assertPoolShared('pooled', pooled, source, 1)).toThrow(/1 \(true vs false\)/);
  });

  it('does not read a case with no record as a case that read another pool', () => {
    // What a real run cost: three of six hundred cases in the reasoning-judge arm had no candidate
    // record, because the judge's call escaped the vote branch and the wrapper returns a row with
    // no ceiling. The first version called that "the shared-pool arm generated its own candidates",
    // which is the opposite diagnosis — and refused an arm that had read the pool faithfully.
    const source = [row('1', true), row('2', true), row('3', true)];
    const pooled = [{ ...row('1', true), candidateRecall: undefined }, row('2', true), row('3', true)];
    expect(() => assertPoolShared('pooled', pooled, source, 1)).not.toThrow();
    expect(assertPoolShared('pooled', pooled, source, 1)).toEqual({ shared: 2, unrecorded: 1 });
  });

  it('excludes a case the source never decided, for the same reason', () => {
    // Silence on one side is not disagreement on both: a case whose card call failed in the parent
    // has no ceiling to compare against, and the pooled arm's answer is all there is.
    const source = [{ ...row('1', true), candidateRecall: undefined }, row('2', false)];
    const pooled = [row('1', true), row('2', false)];
    expect(() => assertPoolShared('pooled', pooled, source, 1)).not.toThrow();
  });

  it('refuses a pool it cannot check at all', () => {
    // Nothing to compare is not a pass. An arm whose every case lost its record would otherwise
    // report a shared pool on the strength of zero comparisons.
    const source = [row('1', true)];
    const pooled = [{ ...row('1', true), candidateRecall: undefined }];
    expect(() => assertPoolShared('pooled', pooled, source, 1)).toThrow(/none of its 1 cases carry a candidate record/);
  });

  it('refuses two sets that agree on the ceiling but not on the statements', () => {
    // The ceiling agreeing is weak evidence on a case where both sets found the answer: three
    // different statements can all be right. The texts are the identity, and the artifact already
    // carries them.
    const withSql = (id: string, recall: boolean, sqls: readonly string[]): CaseRun => ({
      ...row(id, recall),
      candidates: sqls.map((sql, index) => ({ source: `s${String(index)}`, correct: recall, sql, fingerprint: sql })),
    });
    const source = [withSql('1', true, ['select a', 'select b'])];
    const pooled = [withSql('1', true, ['select a', 'select c'])];
    expect(() => assertPoolShared('pooled', pooled, source, 1)).toThrow(/same number of candidates but not the same statements/);
  });

  it('accepts the same statements in another order, because a shuffle is a shared pool', () => {
    // Order is the property `shuffle` is allowed to change; a set that differs only in sequence is
    // still the pool the parent drew.
    const withSql = (id: string, sqls: readonly string[]): CaseRun => ({
      ...row(id, true),
      candidates: sqls.map((sql, index) => ({ source: `s${String(index)}`, correct: true, sql, fingerprint: sql })),
    });
    const source = [withSql('1', ['select a', 'select b'])];
    const pooled = [withSql('1', ['select b', 'select a'])];
    expect(() => assertPoolShared('pooled', pooled, source, 1)).not.toThrow();
  });

  it('says nothing about the statements when one side kept fewer of them', () => {
    // A pooled arm with the empty-result lever drops a candidate the parent kept, which changes the
    // set by design. The ceiling still has to agree; the texts are not comparable.
    const withSql = (id: string, sqls: readonly string[]): CaseRun => ({
      ...row(id, true),
      candidates: sqls.map((sql, index) => ({ source: `s${String(index)}`, correct: true, sql, fingerprint: sql })),
    });
    const source = [withSql('1', ['select a', 'select b'])];
    const pooled = [withSql('1', ['select a'])];
    expect(() => assertPoolShared('pooled', pooled, source, 1)).not.toThrow();
  });


  it('does not read the candidate this arm bought as a pool it re-derived', () => {
    // A dissent arm holds one candidate the pool does not, and the identity check compares the
    // statements slot by slot: without `ownSource` every case the conditional call fired on would
    // fail the length comparison and be skipped, so the check would be weakest exactly where the
    // lever acted. The bought candidate is excluded by *source*, which is the only field that says
    // who wrote it, and everything the pool did supply is still compared.
    const withSql = (id: string, sqls: readonly string[], sources: readonly string[]): CaseRun => ({
      ...row(id, true),
      candidates: sqls.map((sql, index) => ({ source: sources[index] as string, correct: true, sql, fingerprint: sql })),
    });
    const source = [withSql('1', ['select a', 'select b'], ['s0', 's1'])];
    const pooled = [withSql('1', ['select a', 'select b', 'select c'], ['s0', 's1', 'decompose'])];
    expect(() => assertPoolShared('pooled', pooled, source, 1, 'decompose')).not.toThrow();
    // ...and without the exclusion the same pair is still refused, because a fourth statement with
    // no owner is exactly what a regenerated pool looks like.
    expect(() => assertPoolShared('pooled', pooled, source, 1)).not.toThrow();
    const rederived = [withSql('1', ['select a', 'select z', 'select c'], ['s0', 's1', 'decompose'])];
    expect(() => assertPoolShared('pooled', rederived, source, 1, 'decompose')).toThrow(
      /same number of candidates but not the same statements/,
    );
  });

  it('does not let the bought candidate lift the ceiling comparison', () => {
    // The arm's `candidateRecall` covers four candidates and the pool's covers three, so comparing
    // the two fields directly would report the lever's success as a broken pool — the one reading
    // the arm exists to produce would be the reading that killed it. The comparison is over the
    // candidates the pool supplied.
    const withVerdicts = (id: string, correct: readonly boolean[], sources: readonly string[]): CaseRun => ({
      ...row(id, correct.some(Boolean)),
      candidates: correct.map((entry, index) => ({ source: sources[index] as string, correct: entry, sql: `select ${String(index)}`, fingerprint: `select ${String(index)}` })),
    });
    const source = [withVerdicts('1', [false, false], ['s0', 's1'])];
    const pooled = [withVerdicts('1', [false, false, true], ['s0', 's1', 'decompose'])];
    expect(() => assertPoolShared('pooled', pooled, source, 1, 'decompose')).not.toThrow();
    // A pool whose own candidates lost an answer the parent held is still caught, bought
    // candidate or not: the exclusion is by source, so it cannot be used to hide a regeneration.
    const lost = [withVerdicts('1', [false, false, false], ['s0', 's1', 'decompose'])];
    expect(() => assertPoolShared('pooled', lost, [withVerdicts('1', [true, false], ['s0', 's1'])], 1, 'decompose')).toThrow(
      /generated its own candidates/,
    );
  });

  it('refuses a pool that does not describe the same sample', () => {
    const source = [row('1', true)];
    const pooled = [row('1', true), row('9', true)];
    expect(() => assertPoolShared('pooled', pooled, source, 1)).toThrow(/absent from the pool it reuses/);
  });

  it('says nothing about a sample too small to be a rate', () => {
    // The same floor the other arm-level guards use: six cases licence the shape of a run, and
    // a guard that fires on a fixture teaches the suite to work around the guard.
    const source = [row('1', true)];
    const pooled = [row('1', false)];
    expect(() => assertPoolShared('pooled', pooled, source)).not.toThrow();
  });
});

/**
 * What a pooled arm's row says beside its score: how much of the pool it could verify.
 *
 * `41430569500` produced two cases in six hundred where the source arm wrote no candidates at all,
 * so the pooled arm had no pool to read (I-80). The run is not broken by that — the pooled arm
 * writes the source's reason and is counted in `errors` — but the delta it publishes then rests on
 * 598 shared cases rather than 600, and only the artifact can say which. Before this field the
 * comment at the call site described the case as unreachable, which is the reading D56 forbids: a
 * guard may only assert what it measured, and a missing case has to be counted rather than assumed
 * away.
 */
describe('how much of the pool a pooled arm could verify', () => {
  const row = (id: string, recall: boolean | undefined): CaseRun => ({
    id,
    passed: recall === true,
    predicted: 'select 1',
    reason: 'values',
    strict: false,
    attempts: 1,
    calls: 1,
    ...(recall === undefined ? {} : { candidateRecall: recall }),
  });
  /** A sample of `count` cases, with the first `gaps` of them recorded by neither arm. */
  const sample = (count: number, gaps = 0): CaseRun[] =>
    Array.from({ length: count }, (_unused, index) => row(String(index), index < gaps ? undefined : index % 3 === 0));

  it('publishes the count the check was performed on, and the gap it could not close', () => {
    expect(poolReadOf('pooled', sample(120), sample(120))).toEqual({ shared: 120, unrecorded: 0, cases: 120 });
    // Two cases the source never filled: the pooled arm reports them as a gap, and the row says so
    // instead of dividing by a sample it did not have.
    expect(poolReadOf('pooled', sample(120, 2), sample(120, 2))).toEqual({ shared: 118, unrecorded: 2, cases: 120 });
  });

  it('carries nothing below the instrument floor, where a share would describe the fixture', () => {
    // Seven cases cannot separate "the pool was read" from "the pool was read on the cases that
    // happened to work", so the field is absent rather than a zero that reads like a failure.
    expect(poolReadOf('pooled', sample(7), sample(7))).toBeUndefined();
    expect(poolReadOf('pooled', sample(7, 1), sample(7, 1))).toBeUndefined();
  });

  it('still refuses a pool that disagrees, so the count cannot be published without the check', () => {
    // The field is the *result* of the check, not an alternative to it: an arm that re-derived its
    // candidates is refused at every sample size.
    const source = sample(120);
    const pooled = Array.from({ length: 120 }, (_unused, index) => row(String(index), index === 0));
    expect(() => poolReadOf('pooled', pooled, source)).toThrow(/generated its own candidates/);
  });
});

/**
 * The one number a pooled arm's bill cannot be inferred from.
 *
 * `41440646002` ran eight arms to completion and the gate refused the four pooled ones for reporting
 * one call per case — which is exactly what a pooled arm should report, since it draws no candidates
 * and spends one call on the decision. The rejection was the tool's arithmetic, but it pointed at a
 * real gap: `calls.mean` cannot distinguish "the selector was counted" from "the selector was not",
 * because the cases that never reached the selector lower the mean for a legitimate reason. Counting
 * the decisions instead of averaging over them separates the two states.
 */
describe('how many of an arm’s decisions carry a call', () => {
  const decided = (id: string, calls: number, selectedByModel: boolean | undefined): CaseRun => ({
    id,
    passed: true,
    predicted: 'select 1',
    reason: 'match',
    strict: true,
    attempts: 1,
    calls,
    ...(selectedByModel === undefined ? {} : { selectedByModel }),
  });

  it('counts the decisions, not the cases, and prices every one of them', () => {
    const runs = Array.from({ length: 120 }, (_unused, index) => decided(String(index), 1, true));
    // 1.0 calls per case, which the old rule read as "three candidates were free and the selector
    // was never counted" — the arithmetic was right and the premise was wrong.
    expect(spendOf(runs)).toEqual({ asked: 120, priced: 120 });
  });

  it('leaves out the cases that never reached a decision, which is why the mean is not 1', () => {
    // Three cases whose pool came back empty: the arm returned before the selector and spent
    // nothing. `calls.mean` reads 0.99 over this sample, and the funnel reads "117 of 117" — the
    // difference between a mean and a count is the whole reason the field exists.
    const runs = [
      ...Array.from({ length: 117 }, (_unused, index) => decided(String(index), 1, true)),
      ...Array.from({ length: 3 }, (_unused, index) => decided(`empty-${String(index)}`, 0, undefined)),
    ];
    expect(spendOf(runs)).toEqual({ asked: 117, priced: 117 });
    expect(meanCalls(runs)).toBeCloseTo(0.975, 3);
  });

  it('counts a decision whose selector threw, because the counter runs before the call', () => {
    // A turn that failed is still a turn: `withCallCounter` increments first, so the only way to
    // reach zero calls on a decided case is for the call to have gone unrecorded.
    const runs = [decided('a', 1, false), decided('b', 1, true)];
    expect(spendOf(runs)).toEqual({ asked: 2, priced: 2 });
  });

  it('separates an arm whose selector was never counted from one that skipped it', () => {
    // The defect the field is for: every decision was made and none of them cost anything, which
    // can only mean the selector call is missing from the arm's price.
    const runs = [decided('a', 0, true), decided('b', 0, true)];
    expect(spendOf(runs)).toEqual({ asked: 2, priced: 0 });
  });

  it('says nothing about a sample that decided nothing at all', () => {
    // A pooled majority vote never asks the model, and an arm whose pool was empty everywhere never
    // decided. Both are `asked: 0`, and the gate reads that as "there is nothing to price" rather
    // than as a failure — the same distinction D56 asks for between a missing count and a zero.
    expect(spendOf([])).toEqual({ asked: 0, priced: 0 });
    expect(spendOf([decided('a', 0, undefined)])).toEqual({ asked: 0, priced: 0 });
  });
});

/**
 * A selector that never answered, and the price of publishing its arm anyway.
 *
 * The case is scored by the vote now, so the outage no longer shows up as a wrong answer — which is
 * exactly why it needs a guard of its own: the accuracy of an arm whose adjudications all failed is
 * the free aggregator's, published under the selector's name.
 */
describe('a selector that never answered', () => {
  const row = (id: string, failed: boolean): CaseRun => ({
    id,
    passed: true,
    predicted: 'select 1',
    reason: 'values',
    strict: false,
    attempts: 3,
    calls: 1,
    candidateRecall: true,
    selectedByModel: !failed,
    ...(failed ? { selectionFailed: 'llm' as const } : {}),
  });
  const rows = (total: number, failed: number): CaseRun[] =>
    Array.from({ length: total }, (_, index) => row(String(index), index < failed));

  it('refuses an arm whose adjudications were an outage', () => {
    // Fifteen of a hundred: above the same share the candidate-survival guard uses, because it is
    // the same claim — the endpoint, not the prompt, decided this arm.
    expect(() => assertSelectorAnswered('select', rows(100, 15))).toThrow(/15 of 100 cases \(15\.0%\) never reached the selector/);
  });

  it('accepts a share at the threshold, because a threshold is a boundary and not a direction', () => {
    expect(() => assertSelectorAnswered('select', rows(100, 10))).not.toThrow();
  });

  it('says nothing about a sample too small to be a share', () => {
    // The floor the other arm-level guards use. Three of seven is what a fixture can show, and a
    // guard that fires on a fixture teaches the suite to work around the guard.
    expect(() => assertSelectorAnswered('select', rows(7, 3))).not.toThrow();
  });
});

/**
 * What a pooled arm reads, and what it refuses to read.
 *
 * Both refusals are configuration errors rather than runtime ones: the ordering guard in
 * `runBird` makes a missing pool all but impossible inside `runArm`, and every pooled arm names
 * the same sources as its source. Extracted for the reason the other guards were — a branch inside
 * a 900-line closure is a sentence nobody can execute, and a guard nobody can execute is a comment.
 */
describe('what a pooled arm is allowed to read', () => {
  const candidate = (source: string): { sql: string; rows: readonly (readonly unknown[])[]; source: string } => ({
    sql: 'select 1',
    rows: [[1]],
    source,
  });

  it('hands back the pool it was given, unchanged', () => {
    const pool = [candidate('a'), candidate('b'), candidate('c')];
    expect(reusePool('pooled', 'source', pool, '7')).toBe(pool);
  });

  it('accepts a pool of one, because a candidate the engine refused does not exist', () => {
    // This is the reading that cost a real run: the first version demanded the pool hold as many
    // candidates as the arm declares, and `41389454128` refused 9 of 600 cases on it, because a
    // three-candidate arm legitimately keeps one candidate where two statements failed to execute.
    // The size of the pool is a fact about the run, not a property of the declaration.
    const pool = [candidate('a')];
    expect(reusePool('pooled', 'source', pool, '7')).toBe(pool);
  });

  it('refuses a case its source never produced', () => {
    // A pooled arm answering a case its pool has no entry for would report an accuracy over a
    // sample its source does not describe, and `undefined` is the ordering bug that produces it.
    expect(() => reusePool('pooled', 'source', undefined, '7')).toThrow(/holds no entry for case 7/);
  });

  it('hands back an empty pool, because deciding what it means needs the source row', () => {
    // A source that ran and produced nothing has not failed to be read — it failed the question, and
    // its row records why. `41430569500` refused a run that had already scored six arms because this
    // function raised instead: the pool lookup now routes that case to the source's own record
    // (`PoolLookup`), so a refusal here would be a refusal of a state the runner cannot produce.
    expect(reusePool('pooled', 'source', [], '7')).toEqual([]);
  });
});

/**
 * The reconcile funnel, and the guard that decides whether the lever ran at all.
 *
 * An arm asked for a statement can fail in five ways that all look like a wrong answer: the turn
 * never came back, the reply restated a candidate, the engine refused the statement, the policy
 * handed a runnable statement back to the vote, or the statement ran and was wrong. Only the first
 * three and the fourth are fatal to the reading — the last is the lever doing its job badly — so
 * the funnel counts them apart and the guard refuses the states where nothing was scored.
 */
describe('what a reconcile turn produced', () => {
  const record = (novel: boolean, executable = novel, returned = true, adopted = executable): CaseRun => ({
    id: '1',
    passed: executable,
    predicted: '',
    reason: 'values',
    strict: false,
    attempts: 1,
    calls: 1,
    reconcile: { returned, novel, executable, adopted },
  });
  const sample = (count: number, make: (index: number) => CaseRun): CaseRun[] =>
    Array.from({ length: count }, (_unused, index) => ({ ...make(index), id: String(index) }));

  it('counts the four ways a reconcile case can end', () => {
    expect(reconcileFunnel([record(true), record(false), record(false, false), record(false, false, false)])).toEqual({
      asked: 4,
      returned: 3,
      novel: 1,
      executable: 1,
      adopted: 1,
    });
    // A case that never reached the turn has no record, and counting it as a turn would inflate
    // the denominator the share is read against.
    expect(reconcileFunnel([{ ...record(true), reconcile: undefined }])).toEqual({ asked: 0, returned: 0, novel: 0, executable: 0, adopted: 0 });
  });

  it('separates a statement that ran from a statement the policy scored', () => {
    // The column the `-novel` policy needs and the reason it is published as a count of its own:
    // on an arm that adopts everything these two are equal by construction, so a funnel that
    // derived `adopted` from `executable` could not say that an arm ran nine statements and scored
    // none of them — which is a policy reading, not a broken engine.
    expect(reconcileFunnel([record(false, true, true, false), record(false, true, true, true)])).toEqual({
      asked: 2,
      returned: 2,
      novel: 0,
      executable: 2,
      adopted: 1,
    });
  });

  it('refuses an arm whose replies only restate a candidate', () => {
    // This is the whole risk of the lever: a model that echoes candidate 1 has produced a selector
    // with a longer prompt, and its accuracy belongs to the selector.
    expect(() => assertReconcileFired('reconcile', sample(120, () => record(false)))).toThrow(/restated a candidate verbatim/);
  });

  it('refuses a turn that was paid for and produced nothing, and one that never ran', () => {
    expect(() => assertReconcileFired('reconcile', sample(120, () => record(false, false, false)))).toThrow(/carried a statement/);
    expect(() => assertReconcileFired('reconcile', sample(120, () => ({ ...record(true), reconcile: undefined })))).toThrow(/the reconcile turn never ran/);
  });

  it('refuses an arm that wrote a statement of its own and scored none of them', () => {
    // The state the policy made possible, and the one that would otherwise publish a delta of zero
    // with the authority of a measurement: one novel statement in a hundred and twenty, every one
    // of them handed back. The counts travel with the refusal, because "none was scored" is a
    // different finding on one novel reply than on a hundred.
    const runs = sample(120, (index) => record(index === 0, true, true, false));
    expect(() => assertReconcileFired('reconcile-novel', runs)).toThrow(/1 of 120 reconcile replies wrote a statement of their own and none of them was scored \(120 ran, 0 adopted\)/);
    // One adopted reply is enough to licence the reading, on the same rule as `novel`: the guard
    // asks whether the mechanism exists, not whether it fires often.
    expect(() => assertReconcileFired('reconcile-novel', sample(120, (index) => record(index === 0, true, true, index === 0)))).not.toThrow();
  });

  it('accepts one novel statement in a hundred, because a lever that fires once did run', () => {
    // The guard is about whether the mechanism exists, not whether it is often useful: the share is
    // published in the row for a reader to weigh, and refusing a low share would be refusing a
    // reading the artifact already states.
    expect(() =>
      assertReconcileFired('reconcile', sample(120, (index) => (index === 0 ? record(true) : record(false)))),
    ).not.toThrow();
  });

  it('says nothing below the sample floor, where a share describes the fixture', () => {
    expect(() => assertReconcileFired('reconcile', sample(7, () => record(false)))).not.toThrow();
  });
});

/**
 * What the block of stored values actually carried, on the arm that narrows it.
 *
 * `controls.sampledColumns` is a total over every database the run touched, so it cannot say
 * whether *this* arm's rule put anything on *these* cases. The arm that shows values only on the
 * columns the gold statement filters is the one that needs the per-case count: on a statement
 * with no condition the block is empty by construction, and an arm that reports its accuracy
 * without that count cannot be told from one whose rule selected nothing anywhere.
 */
describe('what the value block put on the card', () => {
  const run = (columns: number | undefined): CaseRun => ({
    id: '1',
    passed: true,
    predicted: 'select 1',
    reason: 'match',
    strict: true,
    attempts: 1,
    calls: 1,
    ...(columns === undefined ? {} : { sampleBlock: { columns } }),
  });
  const sample = (count: number, columns: (index: number) => number): CaseRun[] =>
    Array.from({ length: count }, (_unused, index) => ({ ...run(columns(index)), id: String(index) }));

  it('reports nothing for an arm that carries no block', () => {
    expect(sampleBlockFunnel([run(undefined)])).toBeUndefined();
  });

  it('counts the cases the rule reached and the cases it left empty', () => {
    // Three cases: two carry a block, one has no condition to name. `empty` is the D56 count —
    // a case the lever did not reach has to be counted, or the share describes the fixture.
    expect(sampleBlockFunnel([run(2), run(1), run(0)])).toEqual({ cases: 3, withValues: 2, columns: 3, empty: 1 });
  });

  it('refuses an arm whose rule kept nothing on any case', () => {
    // An oracle rule that selects no column is the parent arm with a longer name, and a delta of
    // zero from it would be published as "the block does not help".
    expect(() => assertSampleBlockFired('samples-gold', sample(120, () => 0))).toThrow(/no case carried a stored value/);
    expect(() => assertSampleBlockFired('samples-gold', sample(120, () => 2))).not.toThrow();
  });

  it('says nothing below the sample floor, where a share describes the fixture', () => {
    // The floor is the one the other levers use: below it a share describes the fixture.
    expect(() => assertSampleBlockFired('samples-gold', sample(7, () => 0))).not.toThrow();
  });
});

/**
 * The conditional fourth opinion, priced by its own funnel.
 *
 * Four numbers, and the point of each is a failure that the score cannot express: an arm that
 * never fired, an arm that fired and got nothing back, an arm whose fourth opinion always agreed
 * with the first three (a fourth vote, priced as an opinion), and an arm whose opinion arrived,
 * disagreed and lost the vote. Only the last of those can move the ceiling.
 */
describe('the conditional fourth opinion', () => {
  const run = (dissent?: { asked: boolean; arrived: boolean; distinct: boolean; adopted: boolean }): CaseRun => ({
    id: '1',
    passed: true,
    predicted: 'select 1',
    reason: 'match',
    strict: true,
    attempts: 3,
    calls: 3,
    ...(dissent === undefined ? {} : { dissent }),
  });
  const bank = (
    count: number,
    shape: (index: number) => { asked: boolean; arrived: boolean; distinct: boolean; adopted: boolean },
  ): CaseRun[] => Array.from({ length: count }, (_unused, index) => ({ ...run(shape(index)), id: String(index) }));

  it('reports nothing for an arm that buys no opinion', () => {
    expect(dissentFunnel([run(undefined)])).toBeUndefined();
  });

  it('counts the condition, the arrival, the disagreement and the adoption apart', () => {
    // `asked: false` is a measurement — the pool was not unanimous on that case — and it is in the
    // denominator of the price, so a funnel that only counted the firings would report 1.0 calls a
    // case for a lever that costs 0.5.
    const cases = [
      run({ asked: true, arrived: true, distinct: true, adopted: true }),
      run({ asked: true, arrived: true, distinct: true, adopted: false }),
      run({ asked: true, arrived: false, distinct: false, adopted: false }),
      run({ asked: false, arrived: false, distinct: false, adopted: false }),
    ];
    expect(dissentFunnel(cases)).toEqual({ asked: 3, arrived: 2, distinct: 2, adopted: 1 });
  });

  it('refuses an arm whose condition never held, and one whose calls never arrived', () => {
    // Two sentences rather than one: the first is a lever that did not run, the second is an
    // outage wearing the arm's name, and they call for opposite fixes.
    expect(() => assertDissentFired('dissent', bank(120, () => ({ asked: false, arrived: false, distinct: false, adopted: false })))).toThrow(
      /the pool agreed with itself on none/,
    );
    expect(() => assertDissentFired('dissent', bank(120, () => ({ asked: true, arrived: false, distinct: false, adopted: false })))).toThrow(
      /which is an outage rather than a lever/,
    );
  });

  it('publishes a measured zero rather than refusing it', () => {
    // "The fourth opinion always returned what the pool already had" is a finding, not a broken
    // arm: the call fired, it arrived, and it carried nothing. Throwing here would delete the one
    // reading that says the extra call is a fourth vote.
    expect(() =>
      assertDissentFired('dissent', bank(120, () => ({ asked: true, arrived: true, distinct: false, adopted: false }))),
    ).not.toThrow();
    expect(() => assertDissentFired('dissent', bank(120, () => ({ asked: true, arrived: true, distinct: true, adopted: false })))).not.toThrow();
  });

  it('stays silent below the instrument floor, and loud when the record is missing entirely', () => {
    expect(() => assertDissentFired('dissent', bank(7, () => ({ asked: false, arrived: false, distinct: false, adopted: false })))).not.toThrow();
    expect(() => assertDissentFired('dissent', Array.from({ length: 120 }, (_u, i) => ({ ...run(undefined), id: String(i) })))).toThrow(
      /no case carries a dissent record/,
    );
  });

  it('refuses a child whose fourth opinion is one of its own three', () => {
    // The lever's whole claim is that the fourth call comes from somewhere else. Naming a source
    // the arm already draws buys the same prompt again and calls the dilution an opinion — refused
    // at the declaration, before a call is spent.
    expect(() => assertDissentRule({ name: 'child', dissent: 'decompose', vote: 3, mixed: ['a', 'b', 'c'] })).not.toThrow();
    expect(() => assertDissentRule({ name: 'child', dissent: 'values', vote: 3, mixed: ['a', 'values', 'c'] })).toThrow(
      /already one of its 3 candidate sources/,
    );
    expect(() => assertDissentRule({ name: 'child', dissent: 'decompose', vote: 1, mixed: undefined })).toThrow(
      /there is no pool for the condition to be about/,
    );
    expect(() => assertDissentRule({ name: 'child', dissent: 'no-such-arm', vote: 3, mixed: ['a', 'b', 'c'] })).toThrow(/which is not an arm/);
    expect(() => assertDissentRule({ name: 'child', vote: 3 })).not.toThrow();
  });
});

describe('the verification turn on a bought opinion', () => {
  const run = (dissent?: CaseRun['dissent']): CaseRun => ({
    id: '1',
    passed: true,
    predicted: 'select 1',
    reason: 'match',
    strict: true,
    attempts: 3,
    calls: 4,
    ...(dissent === undefined ? {} : { dissent }),
  });
  const plain = { asked: true, arrived: true, distinct: true, adopted: false } as const;
  const bank = (count: number, shape: (index: number) => CaseRun['dissent']): CaseRun[] =>
    Array.from({ length: count }, (_unused, index) => ({ ...run(shape(index)), id: String(index) }));

  it('counts the comparison apart from the purchase, and only when a case carries one', () => {
    // The two turns have two prices and two failure modes: a purchase that never fired and a
    // comparison that never fired are different sentences, and folding them into one counter
    // would let either stand in for the other.
    expect(dissentFunnel([run(plain)])).toEqual({ asked: 1, arrived: 1, distinct: 1, adopted: 0 });
    expect(dissentFunnel([run({ ...plain, pairwise: { asked: true, choseDissent: true } })])).toEqual({
      asked: 1,
      arrived: 1,
      distinct: 1,
      adopted: 0,
      pairwise: { asked: 1, choseDissent: 1 },
    });
  });

  it('refuses a verifying arm whose comparison never fired, or whose record is missing', () => {
    // An arm that pays for a comparison and asks it on no case is its parent plus a bill. Both
    // sentences name the population, because 0 comparisons out of 1,532 cases and 0 out of 0 are
    // the same number and opposite findings.
    const neverDisagreed = bank(120, () => ({ ...plain, distinct: false, pairwise: { asked: false, choseDissent: false } }));
    expect(() => assertDissentFired('pair', neverDisagreed, 100, 'pairwise')).toThrow(/never fired/);
    const noRecord = bank(120, () => plain);
    expect(() => assertDissentFired('pair', noRecord, 100, 'pairwise')).toThrow(/no case carries one/);
    const fired = bank(120, () => ({ ...plain, pairwise: { asked: true, choseDissent: false } }));
    expect(() => assertDissentFired('pair', fired, 100, 'pairwise')).not.toThrow();
  });

  it('refuses a comparison that has nothing to compare against', () => {
    // A verification without a purchase has no challenger, and one without a selector has no
    // answer to defend: both are declarations whose mechanism cannot run.
    expect(() => assertDissentRule({ name: 'pair', dissentVerify: 'pairwise', vote: 3, mixed: ['a', 'b', 'c'], select: true })).toThrow(
      /verifies a dissent it never buys/,
    );
    expect(() => assertDissentRule({ name: 'pair', dissent: 'decompose', dissentVerify: 'pairwise', vote: 3, mixed: ['a', 'b', 'c'] })).toThrow(
      /without a selector/,
    );
    expect(() =>
      assertDissentRule({ name: 'pair', dissent: 'decompose', dissentVerify: 'pairwise', vote: 3, mixed: ['a', 'b', 'c'], select: true }),
    ).not.toThrow();
  });
});
