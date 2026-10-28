import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  coverageForQuestion,
  EXAMPLE_LIMIT,
  noteExample,
  coverageOf,
  goldReferences,
  main,
  measureRecall,
  prepareRecall,
  recallLines,
  recallProblems,
  renderAsk,
  resolveRecallSettings,
  runRecall,
  summariseCoverage,
  writeRecallArtifact,
} from '../eval/bird/recall.js';
import { MINI_DB, writeMiniBirdDataset } from './helpers/bird-dataset.js';

const schema = [
  {
    table: 'students',
    columns: [
      { name: 'StudentID', type: 'INTEGER' },
      { name: 'StudentName', type: 'TEXT' },
      { name: 'id', type: 'INTEGER' },
    ],
  },
  {
    table: 'schools',
    columns: [
      { name: 'SchoolID', type: 'INTEGER' },
      { name: 'SchoolName', type: 'TEXT' },
    ],
  },
];

const names = (sql: string): string[] =>
  goldReferences(sql, schema).map((reference) => (reference.column === undefined ? reference.table : `${reference.table}.${reference.column}`));

describe('reading the identifiers a gold statement needs', () => {
  it('resolves aliases to the table they were bound to', () => {
    const references = names('SELECT s.StudentName, c.SchoolName FROM students s JOIN schools c ON s.StudentID = c.SchoolID');
    expect(references).toContain('students.StudentName');
    expect(references).toContain('schools.SchoolName');
    expect(references).toContain('students.StudentID');
  });

  it('ignores keywords, functions and literals', () => {
    // A literal that happens to spell a column name is the case that would silently
    // inflate coverage.
    const references = names("SELECT COUNT(*) FROM students WHERE StudentName = 'StudentName' AND id > 3");
    expect(references).toEqual(['students', 'students.StudentName', 'students.id']);
  });

  it('keeps a bare column with no table, because the statement did not say which one', () => {
    const references = goldReferences('SELECT SchoolName FROM schools', schema).filter((entry) => entry.column !== undefined);
    expect(references).toEqual([{ table: 'schools', column: 'SchoolName' }]);
  });

  it('drops identifiers the schema does not contain', () => {
    const references = names('SELECT StudentName, Nickname FROM students');
    expect(references).not.toContain('students.Nickname');
  });

  it('counts a table once even when it is joined twice', () => {
    const references = names('SELECT a.StudentID FROM students a JOIN students b ON a.StudentID = b.StudentID');
    expect(references.filter((name) => name === 'students')).toHaveLength(1);
  });
});

describe('checking whether the prompt shows them', () => {
  it('matches whole identifiers, so `id` is not satisfied by `student_id`', () => {
    // The failure this prevents: a schema that renders `student_id` counted as covering a
    // gold `id`, which would report coverage the model does not have.
    const coverage = coverageOf('students(student_id INTEGER, StudentName TEXT)', [{ table: 'students', column: 'id' }]);
    expect(coverage.covered).toBe(0);
    expect(coverage.completeQuestions).toBe(0);
  });

  it('matches regardless of case, because both sides are SQL', () => {
    expect(coverageOf('STUDENTS(STUDENTNAME TEXT)', [{ table: 'students', column: 'StudentName' }]).covered).toBe(1);
  });

  it('reports the identifiers it could not find', () => {
    const coverage = coverageOf('students(StudentID INTEGER)', [
      { table: 'students', column: 'StudentID' },
      { table: 'schools', column: 'SchoolName' },
    ]);
    expect(coverage.covered).toBe(1);
    expect(coverage.missing).toEqual([{ table: 'schools', column: 'SchoolName' }]);
  });
});

describe('summarising a split', () => {
  it('counts questions, not identifiers, for the completeness rate', () => {
    const summary = summariseCoverage([
      { total: 2, referenced: 2, covered: 2, completeQuestions: 1, missing: [] },
      { total: 2, referenced: 2, covered: 1, completeQuestions: 0, missing: [{ table: 'schools', column: 'SchoolName' }] },
    ]);
    expect(summary.questions).toBe(2);
    expect(summary.complete).toBe(1);
    expect(summary.completeRate).toBe(0.5);
    expect(summary.referenceRate).toBe(0.75);
  });

  it('ranks the identifiers that go missing most often', () => {
    const summary = summariseCoverage([
      { total: 1, referenced: 1, covered: 0, completeQuestions: 0, missing: [{ table: 'a', column: 'x' }] },
      { total: 1, referenced: 1, covered: 0, completeQuestions: 0, missing: [{ table: 'a', column: 'x' }] },
      { total: 1, referenced: 1, covered: 0, completeQuestions: 0, missing: [{ table: 'b', column: 'y' }] },
    ]);
    expect(summary.byMissing[0]).toEqual({ identifier: 'a.x', questions: 2 });
  });

  it('has no division by zero on an empty split', () => {
    const summary = summariseCoverage([]);
    expect(summary.completeRate).toBe(0);
    expect(summary.referenceRate).toBe(0);
  });
});

describe('the prompt a ceiling is measured on', () => {
  const shop = [
    {
      table: 'items',
      columns: [
        { name: 'id', type: 'INTEGER' },
        { name: 'name', type: 'TEXT' },
        { name: 'price', type: 'REAL' },
      ],
    },
    {
      table: 'orders',
      columns: [
        { name: 'id', type: 'INTEGER' },
        { name: 'item_id', type: 'INTEGER' },
        { name: 'qty', type: 'INTEGER' },
      ],
    },
  ];

  it('renders both messages, because the linking hint is in the user turn', () => {
    const { prompt, linked } = renderAsk({ question: 'What is the price of each item?', evidence: '' }, shop);
    expect(linked.length).toBeGreaterThan(0);
    expect(prompt).toContain('Likely columns:');
    expect(prompt).toContain('What is the price of each item?');
    // The card the arms send, at the arms' line budget rather than the 40-line default.
    expect(prompt).toContain('items(id INTEGER, name TEXT, price REAL)');
  });

  it('renders the sentence the pipeline sends when the linker matched nothing', () => {
    // The defect this pins: the first version appended *nothing* here, so the ceiling was
    // measured on a prompt the pipeline never sends.
    const { prompt, linked } = renderAsk({ question: 'zzz qqq', evidence: '' }, shop);
    expect(linked).toEqual([]);
    expect(prompt).toContain('No column matched; use the schema above.');
  });

  it('passes the dataset hint through when the dataset has one', () => {
    expect(renderAsk({ question: 'items', evidence: 'items are stock keeping units' }, shop).prompt).toContain('stock keeping units');
    expect(renderAsk({ question: 'items', evidence: '   ' }, shop).prompt).not.toContain('Business terms');
  });

  it('measures coverage of that same rendering', () => {
    const coverage = coverageForQuestion({ question: 'How many items?', evidence: '', SQL: 'select count(*) from items' }, shop);
    expect(coverage.covered).toBe(coverage.referenced);
    expect(coverage.completeQuestions).toBe(1);
  });
});

describe('measuring a split', () => {
  /** The seven-question fixture, as the layout sees it. */
  function split(limit?: number, questions?: readonly Record<string, unknown>[]): { env: Record<string, string>; root: string } {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'recall-')));
    if (questions !== undefined) writeFileSync(join(data, 'mini_dev_sqlite.json'), JSON.stringify(questions));
    const root = mkdtempSync(join(tmpdir(), 'recall-root-'));
    return { env: { BIRD_DATA: data, ...(limit === undefined ? {} : { BIRD_LIMIT: String(limit) }) }, root };
  }

  it('measures every question in the split and finds the gold identifiers visible', () => {
    const { env, root } = split();
    const outcome = runRecall(resolveRecallSettings(env, root));
    expect(outcome.offered).toBe(7);
    expect(outcome.measured).toBe(7);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.summary.completeRate).toBe(1);
    expect(outcome.problems).toEqual([]);
  });

  it('reads the dataset once, then measures without touching the disk again', () => {
    // The two halves are separate so the measurement is a function of what was read: a
    // second call on the same prepared split has to produce the same numbers.
    const { env, root } = split();
    const prepared = prepareRecall(resolveRecallSettings(env, root));
    const first = measureRecall(prepared);
    const second = measureRecall(prepared);
    expect(second).toEqual(first);
    expect(prepared.questions).toHaveLength(7);
  });

  it('bounds what the loop looks at, not what it manages to measure', () => {
    // The defect this pins: the limit used to count measured rows, so a split with three
    // undescribed databases examined three questions more than anyone asked for.
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'recall-limit-')));
    const questions = JSON.parse(readFileSync(join(data, 'mini_dev_sqlite.json'), 'utf8')) as Record<string, unknown>[];
    questions.splice(0, 0, { question_id: 90, db_id: 'ghost', question: 'q', evidence: '', SQL: 'select 1', difficulty: 'simple' });
    writeFileSync(join(data, 'mini_dev_sqlite.json'), JSON.stringify(questions));
    const outcome = runRecall(resolveRecallSettings({ BIRD_DATA: data, BIRD_LIMIT: '1' }, mkdtempSync(join(tmpdir(), 'recall-root-'))));
    expect(outcome.examined).toBe(1);
    expect(outcome.measured).toBe(0);
    expect(outcome.skipped).toEqual([{ db: 'ghost', questions: 1 }]);
  });

  it('narrows to the first N questions when asked', () => {
    const { env, root } = split(3);
    const outcome = runRecall(resolveRecallSettings(env, root));
    expect(outcome.examined).toBe(3);
    expect(outcome.measured).toBe(3);
    expect(outcome.offered).toBe(7);
  });

  it('reports the databases it could not measure instead of quietly shrinking the split', () => {
    const questions = [
      { question_id: 1, db_id: MINI_DB, question: 'How many items are there?', evidence: '', SQL: 'select count(*) from items', difficulty: 'simple' },
      { question_id: 2, db_id: 'ghost', question: 'Anything', evidence: '', SQL: 'select 1', difficulty: 'simple' },
      { question_id: 3, db_id: 'ghost', question: 'Anything else', evidence: '', SQL: 'select 1', difficulty: 'simple' },
    ];
    const { env, root } = split(undefined, questions);
    const outcome = runRecall(resolveRecallSettings(env, root));
    expect(outcome.measured).toBe(1);
    expect(outcome.skipped).toEqual([{ db: 'ghost', questions: 2 }]);
    expect(recallLines(outcome)[0]).toBe(
      'recall minidev: 1 questions measured of 3 offered, 2 skipped for missing table manifests (ghost)',
    );
    // A rate over a subset is still a rate, but the line above is where its denominator is.
    expect(outcome.problems).toEqual([]);
  });

  it('refuses to call an empty measurement a pass', () => {
    const { env, root } = split(undefined, []);
    const outcome = runRecall(resolveRecallSettings(env, root));
    expect(outcome.problems).toEqual(['nothing was measured: the split offers no question']);
    expect(recallLines(outcome).at(-1)).toBe('  FAILED nothing was measured: the split offers no question');
  });

  it('names the databases when the split asks only about ones it cannot describe', () => {
    const questions = [{ question_id: 1, db_id: 'ghost', question: 'q', evidence: '', SQL: 'select 1', difficulty: 'simple' }];
    const { env, root } = split(undefined, questions);
    const outcome = runRecall(resolveRecallSettings(env, root));
    expect(outcome.problems).toEqual([
      'nothing was measured: every database it names is missing from dev_tables.json (ghost)',
    ]);
  });

  it('names the missing identifiers when the prompt hides one', () => {
    // A gold statement naming a column the schema does not carry is the shape of the
    // failure this gate exists for; `students.Nickname` is not in the fixture.
    const problems = recallProblems(
      summariseCoverage([{ total: 2, referenced: 2, covered: 1, completeQuestions: 0, missing: [{ table: 'items', column: 'nickname' }] }]),
      1,
      [],
    );
    expect(problems).toEqual(['1 of 1 prompts hide at least one identifier the gold statement needs (worst: items.nickname)']);
  });
});

describe('the artifact and the entry', () => {
  it('records the verdict, so a failing run leaves a failing artifact', () => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'recall-art-')));
    writeFileSync(join(data, 'mini_dev_sqlite.json'), '[]');
    const root = mkdtempSync(join(tmpdir(), 'recall-art-root-'));
    const settings = resolveRecallSettings({ BIRD_DATA: data }, root);
    const outcome = runRecall(settings);
    const path = writeRecallArtifact(settings, outcome);
    expect(path).toBe(join(root, 'eval/out/recall-minidev.json'));
    const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(written.passed).toBe(false);
    expect(written.measured).toBe(0);
    expect(written.problems).toHaveLength(1);
  });

  it('writes the artifact before it fails, so a red run cannot leave last week’s green one', async () => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'recall-main-')));
    writeFileSync(join(data, 'mini_dev_sqlite.json'), '[]');
    const root = mkdtempSync(join(tmpdir(), 'recall-main-root-'));
    await expect(main({ BIRD_DATA: data }, root)).rejects.toThrow(/nothing was measured/);
    const written = JSON.parse(readFileSync(join(root, 'eval/out/recall-minidev.json'), 'utf8')) as Record<string, unknown>;
    expect(written.passed).toBe(false);
  });

  it('passes and prints when every identifier is visible', async () => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'recall-ok-')));
    const root = mkdtempSync(join(tmpdir(), 'recall-ok-root-'));
    await main({ BIRD_DATA: data }, root);
    const written = JSON.parse(readFileSync(join(root, 'eval/out/recall-minidev.json'), 'utf8')) as Record<string, unknown>;
    expect(written.passed).toBe(true);
    expect(written.completeRate).toBe(1);
  });

  it('is executable as a script, which is how the workflow calls it', () => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'recall-cli-')));
    const root = mkdtempSync(join(tmpdir(), 'recall-cli-root-'));
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(process.cwd(), 'eval/bird/recall.ts')], {
      cwd: process.cwd(),
      env: { ...process.env, BIRD_DATA: data, BIRD_OUT: join(root, 'bird-eval.json') },
      encoding: 'utf8',
    });
    expect(result.stderr).not.toContain('Error');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('every gold identifier visible: 7/7 (100.0%)');
  });
});

describe('the edges the fixture cannot reach', () => {
  const schema = [
    { table: 'items', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }] },
    { table: 'orders', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'item_id', type: 'INTEGER' }] },
  ];

  it('says nothing about a qualifier the statement never bound', () => {
    // `z.nickname` names neither a table nor a column of this schema: `z` is not bound by
    // any FROM/JOIN clause and `nickname` is not a column anywhere, so the only reference
    // the statement really makes is to `items`.
    expect(goldReferences('SELECT z.nickname FROM items', schema)).toEqual([{ table: 'items' }]);
  });

  it('keys a missing table by its name, not by an empty column', () => {
    const summary = summariseCoverage([{ total: 1, referenced: 1, covered: 0, completeQuestions: 0, missing: [{ table: 'items' }] }]);
    expect(summary.byMissing).toEqual([{ identifier: 'items', questions: 1 }]);
  });

  it('breaks a tie by identifier, so the ranking is stable between runs', () => {
    const summary = summariseCoverage([
      { total: 2, referenced: 2, covered: 0, completeQuestions: 0, missing: [{ table: 'b', column: 'y' }, { table: 'a', column: 'x' }] },
    ]);
    expect(summary.byMissing.map((entry) => entry.identifier)).toEqual(['a.x', 'b.y']);
  });

  it('prints the identifiers that go missing, so a red gate names its cause', () => {
    const outcome = {
      split: 'dev',
      summary: summariseCoverage([{ total: 1, referenced: 1, covered: 0, completeQuestions: 0, missing: [{ table: 'items', column: 'name' }] }]),
      offered: 1,
      examined: 1,
      measured: 1,
      skipped: [],
      examples: [],
      problems: [],
    };
    expect(recallLines(outcome)).toContain('  missing items.name in 1 questions');
  });

  it('keeps three identifiers per example, and stops at the limit', () => {
    const missing = [
      { table: 'a', column: 'one' },
      { table: 'a', column: 'two' },
      { table: 'a', column: 'three' },
      { table: 'a', column: 'four' },
    ];
    const examples: { id: number; missing: readonly { table: string; column?: string }[] }[] = [];
    noteExample(examples, 1, { total: 4, referenced: 4, covered: 0, completeQuestions: 0, missing });
    expect(examples).toEqual([{ id: 1, missing: missing.slice(0, 3) }]);
    // A question with nothing missing contributes no example...
    noteExample(examples, 2, { total: 1, referenced: 1, covered: 1, completeQuestions: 1, missing: [] });
    expect(examples).toHaveLength(1);
    // ...and the list stops at EXAMPLE_LIMIT, so a broken split cannot write a book.
    for (let id = 3; id <= EXAMPLE_LIMIT + 3; id += 1) {
      noteExample(examples, id, { total: 1, referenced: 1, covered: 0, completeQuestions: 0, missing: [{ table: 'a', column: 'one' }] });
    }
    expect(examples).toHaveLength(EXAMPLE_LIMIT);
  });
});
