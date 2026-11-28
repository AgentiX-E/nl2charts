import { describe, expect, it } from 'vitest';
import type { DatabaseProfile } from '@agentix-e/nl2charts-ai';
import {
  buildGoldPairRow,
  harnessArms,
  harnessOutput,
  HARNESS_NOTE,
  isEntryPoint,
  main,
  renderGoldPairRows,
  runHarness,
  toSummary,
  type DevQuestion,
  type GoldPairRow,
} from '../eval/bird/gold-pairing.js';

/**
 * The gold-pairing row is the unit a future paired dispatch exports before it prices anything:
 * one question, the canonical gold fields from its SQL, the two retrieval arms, and the six-bucket
 * classification. These tests pin the assembly, not a score — the offline arms are deterministic
 * stand-ins and no number here may be quoted as a semantic-gain accuracy claim.
 */

const profile: DatabaseProfile = {
  db: 'frpm',
  columns: [
    { table: 'frpm', column: 'County Name', kind: 'categorical', values: ['Alameda'] },
    { table: 'frpm', column: 'Free Meal Count (K-12)', kind: 'numeric' },
    { table: 'frpm', column: 'Status', kind: 'categorical', values: ['Banned', 'Not Legal'] },
  ],
};

const field = (key: string) => {
  const [table, column] = key.split('.');
  return { table: table as string, column: column as string };
};

describe('buildGoldPairRow', () => {
  it('classifies a semantic-only gold field as a confirmed gain', () => {
    const row = buildGoldPairRow(
      1,
      'banned cards',
      'SELECT `Status` FROM frpm WHERE `Status` = \'Banned\'',
      profile,
      [],
      [field('frpm.Status')],
    );
    expect(row.classification.semanticGainedConfirmed).toEqual(['frpm.Status']);
    expect(row.goldCount).toBe(1);
  });

  it('classifies a semantic-only non-gold field as spurious', () => {
    const row = buildGoldPairRow(
      2,
      'free meals',
      'SELECT `County Name` FROM frpm',
      profile,
      [],
      [field('frpm.Status')],
    );
    expect(row.classification.semanticGainedSpurious).toEqual(['frpm.Status']);
    expect(row.classification.semanticGainedConfirmed).toEqual([]);
  });

  it('classifies an exact-only gold field as a confirmed loss', () => {
    const row = buildGoldPairRow(
      3,
      'county',
      'SELECT `County Name` FROM frpm',
      profile,
      [field('frpm.County Name')],
      [],
    );
    expect(row.classification.semanticLostConfirmed).toEqual(['frpm.County Name']);
  });

  it('records the question and canonical gold keys alongside the buckets', () => {
    const row = buildGoldPairRow(
      4,
      'county and status',
      'SELECT `County Name`, `Status` FROM frpm',
      profile,
      [field('frpm.County Name')],
      [field('frpm.Status')],
    );
    expect(row.questionId).toBe(4);
    expect(row.question).toBe('county and status');
    expect(row.goldKeys).toEqual(['frpm.County Name', 'frpm.Status']);
    expect(row.goldCount).toBe(2);
  });

  it('reports zero gold fields for a statement with no resolvable columns', () => {
    const row = buildGoldPairRow(5, 'constant', 'SELECT 1', profile, [], []);
    expect(row.goldCount).toBe(0);
    expect(row.goldKeys).toEqual([]);
  });

  it('keeps the exact and semantic key lists for audit', () => {
    const row = buildGoldPairRow(
      6,
      'x',
      'SELECT `County Name` FROM frpm',
      profile,
      [field('frpm.County Name')],
      [field('frpm.Status')],
    );
    expect(row.exactKeys).toEqual(['frpm.County Name']);
    expect(row.semanticKeys).toEqual(['frpm.Status']);
  });

  it('lower-cases an arm field with no profile row instead of dropping it', () => {
    const row = buildGoldPairRow(7, 'x', 'SELECT 1', profile, [], [field('CTE.Phantom')]);
    expect(row.semanticKeys).toEqual(['cte.phantom']);
  });

  it('deduplicates two arm fields that canonicalise to one canonical field', () => {
    const row = buildGoldPairRow(
      8, 'x', 'SELECT 1', profile,
      [field('FRPM.County Name'), field('frpm.county name')],
      [],
    );
    expect(row.exactKeys).toEqual(['frpm.County Name']);
  });
});

describe('renderGoldPairRows', () => {
  const row = (questionId: number, gained: string[]): GoldPairRow => ({
    questionId,
    question: `q${questionId}`,
    goldKeys: [],
    goldCount: 0,
    exactKeys: [],
    semanticKeys: [],
    classification: {
      semanticGainedConfirmed: gained,
      semanticGainedSpurious: [],
      semanticLostConfirmed: [],
      semanticLostSpurious: [],
      bothCorrect: [],
      bothWrong: [],
    },
  });

  it('renders one line per row with its confirmed gain', () => {
    const text = renderGoldPairRows([row(1, ['frpm.Status']), row(2, [])]);
    expect(text).toContain('q1');
    expect(text).toContain('frpm.Status');
    expect(text).toContain('q2');
  });

  it('caps the number of rows rendered', () => {
    const rows = [row(1, []), row(2, []), row(3, [])];
    const text = renderGoldPairRows(rows, 2);
    expect(text).toContain('q1');
    expect(text).toContain('q2');
    expect(text).not.toContain('q3');
  });

  it('returns a header-only block for no rows', () => {
    expect(renderGoldPairRows([])).toContain('question');
  });
});

describe('harnessArms', () => {
  it('returns only columns whose name appears in the question', () => {
    const arms = harnessArms('show the county name', profile);
    expect(arms.exact).toEqual([field('frpm.County Name')]);
  });

  it('restricts the semantic arm to categorical/other columns and caps it at three', () => {
    const arms = harnessArms('county status free meal', profile);
    // `Free Meal Count` is numeric: excluded from semantic; county/status are categorical.
    expect(arms.semantic.every((f) => f.column !== 'Free Meal Count (K-12)')).toBe(true);
    expect(arms.semantic.length).toBeLessThanOrEqual(3);
  });

  it('returns empty arms for a question naming no column', () => {
    expect(harnessArms('constant 1', profile)).toEqual({ exact: [], semantic: [] });
  });

  it('handles a profile with no columns', () => {
    expect(harnessArms('county', { db: 'empty', columns: [] })).toEqual({ exact: [], semantic: [] });
  });

  it('handles a column with an empty name without throwing', () => {
    const odd: DatabaseProfile = {
      db: 'odd',
      columns: [{ table: 't', column: '', kind: 'categorical' }],
    };
    expect(() => harnessArms('anything', odd)).not.toThrow();
  });
});

describe('harnessOutput', () => {
  const dev: DevQuestion[] = [
    { question_id: 1, question: 'banned status', db_id: 'frpm', SQL: 'SELECT `Status` FROM frpm' },
    { question_id: 2, question: 'banned status', db_id: 'frpm', SQL: 'SELECT `Status` FROM frpm' },
  ];

  it('loads each profile once and produces one row per question', () => {
    let loads = 0;
    const out = harnessOutput(dev, () => { loads += 1; return profile; }, 2);
    expect(out.rows.length).toBe(2);
    expect(loads).toBe(1);
    expect(out.summary.questions).toBe(2);
  });

  it('honours the limit', () => {
    const out = harnessOutput(dev, () => profile, 1);
    expect(out.rows.length).toBe(1);
  });

  it('pins the harness-proof note so numbers cannot be quoted as a price', () => {
    const out = harnessOutput(dev, () => profile, 1);
    expect(out.note).toBe(HARNESS_NOTE);
    expect(out.note).toContain('HARNESS PROOF ONLY');
  });
});

describe('runHarness', () => {
  it('reads cached files through the injected reader and emits a harness-proof JSON', () => {
    const devJson = JSON.stringify([
      { question_id: 1, question: 'banned status', db_id: 'frpm', SQL: 'SELECT `Status` FROM frpm' },
    ]);
    const profileJson = JSON.stringify(profile);
    const read = (path: string) => path.includes('dev.json') ? devJson : profileJson;
    let emitted = '';
    runHarness(read, (text) => { emitted = text; }, 1);
    const parsed = JSON.parse(emitted);
    expect(parsed.note).toBe(HARNESS_NOTE);
    expect(parsed.rows.length).toBe(1);
    expect(parsed.summary.questions).toBe(1);
  });
});

describe('CLI entry', () => {
  it('recognises its own entry point and rejects imports', () => {
    expect(isEntryPoint('/workspace/nl2charts/eval/bird/gold-pairing.ts')).toBe(true);
    expect(isEntryPoint(undefined)).toBe(false);
    expect(isEntryPoint('/some/other/test.ts')).toBe(false);
  });

  it('runs the real cached harness through the CLI entry', () => {
    // Real filesystem read of the cached dev split; console.log is captured by the test runner.
    expect(() => main()).not.toThrow();
  });
});

describe('toSummary', () => {
  it('aggregates rows into a six-bucket summary', () => {
    const rows = [
      buildGoldPairRow(1, 'a', 'SELECT `Status` FROM frpm', profile, [], [field('frpm.Status')]),
      buildGoldPairRow(2, 'b', 'SELECT `County Name` FROM frpm', profile, [field('frpm.County Name')], []),
    ];
    const summary = toSummary(rows);
    expect(summary.questions).toBe(2);
    expect(summary.semanticGainedConfirmed).toBe(1);
    expect(summary.semanticLostConfirmed).toBe(1);
    expect(summary.confirmedGain).toBe(0);
  });

  it('returns zeroed counters for no rows', () => {
    const summary = toSummary([]);
    expect(summary.questions).toBe(0);
    expect(summary.confirmedGain).toBe(0);
    expect(summary.semanticCoverage).toBe(0);
  });
});
