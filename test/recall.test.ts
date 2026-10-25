import { describe, expect, it } from 'vitest';
import { coverageOf, goldReferences, summariseCoverage } from '../eval/bird/recall.js';

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
