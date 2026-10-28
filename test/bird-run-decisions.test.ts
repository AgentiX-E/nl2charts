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
  databasesFromManifest,
  databasesFromQuestions,
  evaluateGate,
  meanCalls,
  offeredCandidates,
  pairedComparisons,
  resolveLayout,
  resolveSettings,
  secondModelRoles,
} from '../eval/bird/run.js';
import type { CaseRun } from '../eval/bird/run.js';

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
