/**
 * The layer under `filter-narrow`, through the classifier and through the entry.
 *
 * `values-gap` files 76 dev questions as "the statement ran and returned nothing". That is a
 * shape, not a cause, and the cause decides whether there is work in the bucket at all: a value
 * written in another case is a repair, and a column that stores something else entirely is a
 * schema-linking failure that no edit to the literal can reach. The unit cases pin the four
 * kinds against literal/column pairs, because that is exactly the input the classifier has.
 *
 * The end-to-end case runs a real SQLite file through the real oracle subprocess, because the
 * tool's denominator is "cases the engine returned no rows for" and a stubbed result set would
 * agree with whatever the tool was written to expect.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  absenceLines,
  absenceProblems,
  DEFAULT_LITERAL_GAP_ARM,
  isEntry,
  literalGapPath,
  main,
  resolveLiteralGapSettings,
  runLiteralGap,
  tallyAbsences,
  writeLiteralGapArtifact,
} from '../eval/bird/literal-gap.js';
import { ABSENCE_KINDS, classifyAbsence } from '../eval/bird/literal-repair.js';
import { MINI_DB, writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();

describe('classifying why a literal is not in the column it is compared against', () => {
  it('says nothing when the column already stores the literal', () => {
    expect(classifyAbsence('Legal', ['Legal', 'Banned'])).toBeUndefined();
  });

  it('names a case difference only when exactly one spelling matches ignoring case', () => {
    expect(classifyAbsence('legal', ['Legal', 'Banned'])).toEqual({ kind: 'case', replacement: 'Legal' });
    // Two spellings that both match ignoring case is a guess, and a guess is not a repair.
    expect(classifyAbsence('legal', ['Legal', 'LEGAL'])).toEqual({ kind: 'absent' });
  });

  it('names a leading-zero difference for a number the column stores padded', () => {
    expect(classifyAbsence('40', ['0040', '0728'])).toEqual({ kind: 'padding', replacement: '0040' });
    // Two padded spellings of the same number is two answers: the edit refuses rather than picks.
    expect(classifyAbsence('40', ['0040', '00040'])).toEqual({ kind: 'absent' });
    // `400` and `0040` are not the same number, and the padding rule must not equate them.
    expect(classifyAbsence('400', ['0040'])).toEqual({ kind: 'absent' });
    // A literal that is not a number is never a padding case, even when a column holds digits.
    expect(classifyAbsence('40a', ['0040'])).toEqual({ kind: 'absent' });
  });

  it('names a parenthetical the column appends, and only when one value carries it', () => {
    expect(classifyAbsence('High Schools', ['High Schools (Public)', 'Junior High Schools (Public)'])).toEqual({
      kind: 'parenthetical',
      replacement: 'High Schools (Public)',
    });
    // Two values built on the same stem is a guess about which one the question meant.
    expect(
      classifyAbsence('High Schools', ['High Schools (Public)', 'High Schools (Private)']),
    ).toEqual({ kind: 'absent' });
  });

  it('does not read a parenthetical as a prefix match, because a prefix is not a label', () => {
    // `Continuation` is a prefix of both values and equals neither: a rule that accepted it would
    // turn "continuation schools" into "continuation high schools" and answer another question.
    expect(classifyAbsence('Continuation', ['Continuation School (Public)', 'Continuation High Schools'])).toEqual({
      kind: 'absent',
    });
  });

  it('calls a literal the column has nothing like absent, which is the bucket that is not a literal', () => {
    expect(classifyAbsence('Contra Costa', ['Alameda', 'Fresno'])).toEqual({ kind: 'absent' });
    expect(classifyAbsence('Contra Costa', [])).toEqual({ kind: 'absent' });
  });

  it('prefers the case edit over the other kinds, because it is the one the pipeline ships', () => {
    // `0040` also contains `40`, and a classifier that reached for padding first would report a
    // different edit than the rule that actually runs.
    expect(classifyAbsence('0040', ['0040'.toLowerCase(), '0041'])).toBeUndefined();
    // Both the case edit and the parenthetical edit reach `Legal (Public)`; the shipped one wins.
    expect(classifyAbsence('legal', ['Legal', 'Legal (Public)'])).toEqual({ kind: 'case', replacement: 'Legal' });
  });
});

describe('totalling the kinds', () => {
  it('counts each kind and reports the repairable share as the three literal kinds', () => {
    const tally = tallyAbsences(['case', 'case', 'padding', 'parenthetical', 'absent', 'absent', 'absent']);
    expect(tally.total).toBe(7);
    expect(tally.kinds).toEqual({ case: 2, padding: 1, parenthetical: 1, absent: 3 });
    expect(tally.repairable).toBe(4);
  });

  it('reads an empty tally as zero rather than as a division by zero', () => {
    const tally = tallyAbsences([]);
    // The printed form of an empty tally says "0 of 0" and not "0.0%", because a share of nothing
    // is not a measured zero.
    expect(absenceLines(tally).at(-1)).toBe('  repairable by an edit to the literal: 0 of 0');
    expect(tally.total).toBe(0);
    expect(tally.repairable).toBe(0);
    expect(ABSENCE_KINDS.every((kind) => tally.kinds[kind] === 0)).toBe(true);
  });
});

describe('the report', () => {
  it('prints one line per kind with its share, and the repairable ceiling under it', () => {
    const lines = absenceLines(tallyAbsences(['case', 'case', 'padding', 'absent', 'absent']));
    expect(lines[0]).toContain('case');
    expect(lines.join('\n')).toContain('repairable by an edit to the literal: 3 of 5');
  });

  it('fails when a domain read failed, because a literal priced against no values is not a reading', () => {
    expect(absenceProblems(tallyAbsences(['case', 'absent']), 0)).toEqual([]);
    expect(absenceProblems(tallyAbsences(['case', 'absent']), 2)).toEqual([
      'LGAP: 2 comparison site(s) could not be read against their column, so the split is over a set the caller did not choose',
    ]);
  });

  it('fails when the bucket is empty, since a zero over zero prints as a ratio', () => {
    expect(absenceProblems(tallyAbsences([]), 0)).toEqual([
      'LGAP: no case in this artifact returned no rows, so there is nothing to split',
    ]);
  });
});

describe('the tool, end to end', () => {
  /**
   * One case per state the loop can reach, so the denominator is asserted rather than assumed.
   *
   * The seven states are the ones a caller cannot see from the report: a case the arm answered, a
   * failure the judge filed under another bucket, a `values` failure with no statement, a question
   * the split does not hold, a gold the engine refuses, a prediction the engine refuses, and a
   * `values` failure whose statement returned rows. Every one of them shrinks the denominator if it
   * is counted and inflates a share if it is not, which is why they are tested and not just named.
   */
  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lgap-'));
    writeMiniBirdDataset(dir);
    // A column whose only stored value is the empty string: `createDomainReader` drops it, so the
    // reader has no values to classify the literal against even though the column exists.
    const writer = new DatabaseSync(join(dir, 'dev_databases', MINI_DB, `${MINI_DB}.sqlite`));
    writer.exec("create table blank (label text); insert into blank values (''), ('');");
    writer.close();
    // The dataset's questions, plus one whose gold the engine cannot parse.
    const questions = JSON.parse(readFileSync(join(dir, 'mini_dev_sqlite.json'), 'utf8')) as unknown[];
    questions.push({ question_id: 98, db_id: MINI_DB, question: 'A question with no runnable gold', evidence: '', SQL: 'select * from table_that_is_not_there', difficulty: 'simple' });
    writeFileSync(join(dir, 'mini_dev_sqlite.json'), `${JSON.stringify(questions)}\n`);
    const artifact = {
      split: 'minidev',
      cases: [
        { arm: 'a', id: 1, passed: true, sql: 'select id from items' },
        { arm: 'a', id: 2, passed: false, reason: 'column-count', sql: 'select id from items' },
        { arm: 'a', id: 3, passed: false, reason: 'values', sql: '' },
        { arm: 'a', id: 99, passed: false, reason: 'values', sql: 'select id from items' },
        { arm: 'a', id: 98, passed: false, reason: 'values', sql: 'select id from items' },
        { arm: 'a', id: 4, passed: false, reason: 'values', sql: 'select * from table_that_is_not_there' },
        { arm: 'a', id: 5, passed: false, reason: 'values', sql: "select id from items where name = 'pen'" },
        // Returns nothing, no string literal: the rows are excluded by a contradiction.
        { arm: 'a', id: 6, passed: false, reason: 'values', sql: 'select id from orders where item_id = 1 and 1 = 0' },
        // Returns nothing, and the column it filters holds only blanks: the site is real, its column
        // is named, and no value can be read back for it — the state the gate exists for.
        { arm: 'a', id: 6, passed: false, reason: 'values', sql: "select label from blank where label = 'x'" },
        // Returns nothing, and the literal is one the column already stores.
        { arm: 'a', id: 3, passed: false, reason: 'values', sql: "select id from items where name = 'pen' and 1 = 0" },
        // Returns nothing, and the column has nothing like the literal: `absent`.
        { arm: 'a', id: 7, passed: false, reason: 'values', sql: "select id from orders where item_id = 'pen'" },
        { arm: 'b', id: 3, passed: false, reason: 'values', sql: 'select id from orders where item_id = 0' },
      ],
    };
    writeFileSync(join(dir, 'bird-eval.json'), `${JSON.stringify(artifact)}\n`);
    return dir;
  }

  const settingsFor = (dir: string) =>
    resolveLiteralGapSettings(['--artifact', join(dir, 'bird-eval.json'), '--arm', 'a'], dir, {
      ...process.env,
      BIRD_SPLIT: 'minidev',
      BIRD_DATA: dir,
    });

  it('counts every state that shrinks the denominator, and names each one', async () => {
    const outcome = await runLiteralGap(settingsFor(fixture()));
    expect(outcome.drops).toEqual({
      passed: 1,
      otherArm: 1,
      otherReason: 1,
      unretained: 1,
      unknownQuestion: 1,
      goldFailed: 1,
      engineRefused: 1,
      notEmpty: 1,
    });
    // Four cases returned rows-less statements: two carry a literal site, one compares a column the
    // statement does not read, and one compares a literal the column already stores.
    expect(outcome.narrowCases).toBe(4);
    expect(outcome.unread).toBe(1);
    expect(outcome.tally.kinds.absent).toBe(1);
    expect(outcome.tally.total).toBe(1);
  });

  it('fails the build on a site it could not read, because that site was priced against nothing', async () => {
    const dir = fixture();
    const settings = settingsFor(dir);
    const outcome = await runLiteralGap(settings);
    expect(outcome.problems).toEqual([
      'LGAP: 1 comparison site(s) could not be read against their column, so the split is over a set the caller did not choose',
    ]);
    expect(await main(['--artifact', join(dir, 'bird-eval.json'), '--arm', 'a'], dir, { ...process.env, BIRD_SPLIT: 'minidev', BIRD_DATA: dir })).toBe(1);
  });

  it('reads the split the artifact declares, not the one the environment names', async () => {
    // A caller running with BIRD_SPLIT=dev against a Mini-Dev artifact must be served the artifact's
    // own databases: the alternative reads one split's statements against another's files and
    // classifies every column against the wrong table.
    const dir = fixture();
    const settings = resolveLiteralGapSettings(['--artifact', join(dir, 'bird-eval.json'), '--arm', 'a'], dir, {
      ...process.env,
      BIRD_SPLIT: 'dev',
      BIRD_DATA: dir,
    });
    const outcome = await runLiteralGap(settings);
    expect(outcome.split).toBe('minidev');
  });

  it('exits zero on a split where every site could be read', async () => {
    const dir = fixture();
    // Drop the case whose column cannot be read, leaving a split every site of which is classifiable.
    const artifact = JSON.parse(readFileSync(join(dir, 'bird-eval.json'), 'utf8')) as { cases: unknown[] };
    artifact.cases = (artifact.cases as { sql?: string }[]).filter((row) => !row.sql?.includes('blank'));
    writeFileSync(join(dir, 'bird-eval.json'), `${JSON.stringify(artifact)}\n`);
    expect(await main(['--artifact', join(dir, 'bird-eval.json'), '--arm', 'a'], dir, { ...process.env, BIRD_SPLIT: 'minidev', BIRD_DATA: dir })).toBe(0);
  });

  it('writes the artifact it prints, named by the arm so two arms do not overwrite each other', async () => {
    const dir = fixture();
    expect(literalGapPath({ split: 'minidev', root: dir, arm: 'a' }).endsWith('literal-gap-a.json')).toBe(true);
    expect(literalGapPath({ split: 'minidev', root: dir, arm: 'select-mixed' }).endsWith('literal-gap-select-mixed.json')).toBe(true);
    const settings = settingsFor(dir);
    const outcome = await runLiteralGap(settings);
    const path = writeLiteralGapArtifact(settings, outcome);
    const written = JSON.parse(readFileSync(path, 'utf8')) as { arm: string; tally: { total: number } };
    expect(written.arm).toBe('a');
    expect(written.tally.total).toBe(outcome.tally.total);
  });

  it('refuses an argument it does not take, and accepts the ones it does', () => {
    expect(() => resolveLiteralGapSettings(['--arm'], '.', {})).toThrow(/--arm/);
    expect(() => resolveLiteralGapSettings(['--arm', '--artifact'], '.', {})).toThrow(/needs a value/);
    // Neither flag: the artifact defaults to where a run writes one, and the arm to the shipped one.
    const bare = resolveLiteralGapSettings([], '.', {});
    expect(bare.arm).toBe(DEFAULT_LITERAL_GAP_ARM);
    expect(bare.artifact.endsWith('bird-eval.json')).toBe(true);
    expect(() => resolveLiteralGapSettings(['--nope'], '.', {})).toThrow(/unrecognized argument --nope/);
    expect(isEntry(undefined, 'file:///x')).toBe(false);
    expect(MINI_DB).toBe('shop');
    expect(ROOT.length).toBeGreaterThan(0);
  });
});
