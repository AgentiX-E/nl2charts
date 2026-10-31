/**
 * Scoring a competitor's statements with our executor and our judge.
 *
 * The end-to-end cases run a real SQLite file through the real oracle, because the whole point of
 * this tool is that the rows a competitor's statement returns are compared with the rows the gold
 * returns — a stubbed result set would agree with whatever the judge was written to expect.
 *
 * The assertions are about three refusals: no accuracy when a coordinate fails, no denominator
 * smaller than the question set, and no size for a delta the design cannot resolve.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BirdLayout } from '../eval/bird/run.js';
import { resolveLayout } from '../eval/bird/run.js';
import { EXECUTOR, JUDGE } from '../eval/competitors/coordinates.js';
import {
  armOutcomes,
  isEntry,
  main,
  resolveScoreSettings,
  scoreLines,
  scoreRun,
  writeScoreArtifact,
} from '../eval/competitors/score.js';
import { silentRun } from '../eval/competitors/score.js';
import type { ScoreOutcome, ScoreSettings } from '../eval/competitors/score.js';
import { parsePredictions } from '../eval/competitors/predictions.js';
import { MINI_DB, MINI_QUESTIONS, writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();
const ARM = 'metadata+evidence';
const COMMIT = '3d6e835f858d26885d21d4bc0215aeecf855efbe';

/** Five of the seven fixture questions right: enough to make a paired comparison say something. */
const OURS_PASSED = [1, 2, 3, 4, 7];
/** Four right, and one of the four is a question this harness gets wrong. */
const THEIRS_CORRECT = [1, 2, 3, 6];

interface Fixture {
  readonly dir: string;
  readonly layout: BirdLayout;
  readonly env: Record<string, string>;
  readonly report: string;
  readonly coordinates: string;
}

const payload = (sql: string, db = MINI_DB): string => `${sql}\t----- bird -----\t${db}`;

function predictionsFor(correct: readonly number[]): string {
  const body: Record<string, string> = {};
  for (const question of MINI_QUESTIONS) {
    const gold = question.sql;
    if (correct.includes(question.id)) {
      body[String(question.id)] = payload(gold);
      continue;
    }
    // A statement that runs and returns the wrong rows: the difference between "wrong" and "did
    // not answer" is the difference between two fixes, so the fixture keeps them apart.
    body[String(question.id)] = payload('select count(*) from items');
  }
  // Two questions the competitor did not answer, in the two ways that happen.
  body['7'] = payload('   ');
  delete body['5'];
  return JSON.stringify(body, null, 2);
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'competitors-'));
  writeMiniBirdDataset(dir);
  const env = {
    BIRD_SPLIT: 'minidev',
    BIRD_DATA: dir,
    BIRD_DATABASES: join(dir, 'dev_databases'),
    BIRD_OUT: join(dir, 'bird-eval.json'),
  };
  const layout = resolveLayout(env, ROOT);
  const report = layout.out;
  const passed = new Set(OURS_PASSED);
  writeFileSync(
    report,
    JSON.stringify({
      split: 'minidev',
      model: 'deepseek-chat',
      arms: [{ arm: ARM, total: MINI_QUESTIONS.length }],
      cases: MINI_QUESTIONS.map((question) => ({
        arm: ARM,
        id: String(question.id),
        passed: passed.has(question.id),
      })),
    }),
  );
  const coordinates = join(dir, 'coordinates.json');
  writeFileSync(
    coordinates,
    JSON.stringify({
      competitor: 'chess',
      repo: 'ShayanTalaei/CHESS',
      commit: COMMIT,
      split: 'minidev',
      questionIds: MINI_QUESTIONS.map((question) => question.id),
      model: 'deepseek-chat',
      endpoint: 'https://api.deepseek.com',
      prompt: 'competitor',
      executor: EXECUTOR,
      judge: JUDGE,
    }),
  );
  return { dir, layout, env, report, coordinates };
}

const settingsFor = (base: Fixture, predictions: string, over: Partial<ScoreSettings> = {}): ScoreSettings => ({
  predictions,
  coordinates: base.coordinates,
  report: base.report,
  arm: ARM,
  model: 'deepseek-chat',
  endpoint: 'https://api.deepseek.com',
  effect: 0.02,
  out: join(base.dir, 'out', 'chess.json'),
  layout: base.layout,
  ...over,
});

/** Rewrites the coordinates to declare the question set the report actually holds. */
function extendCoordinates(base: Fixture, questionIds: readonly number[]): void {
  const body = JSON.parse(readFileSync(base.coordinates, 'utf8')) as Record<string, unknown>;
  writeFileSync(base.coordinates, JSON.stringify({ ...body, questionIds }));
}

const writePredictions = (base: Fixture, text: string): string => {
  const path = join(base.dir, 'predictions.json');
  writeFileSync(path, text);
  return path;
};

describe('scoring a predictions file against the split gold', () => {
  it('counts the whole question set, with an unanswered question counted wrong', async () => {
    const base = fixture();
    const path = writePredictions(base, predictionsFor(THEIRS_CORRECT));
    const outcome = await scoreRun(settingsFor(base, path));
    expect(outcome.comparable).toBe(true);
    expect(outcome.ledger.declared).toBe(7);
    expect(outcome.ledger.answered).toBe(5);
    expect(outcome.ledger.empty).toEqual([7]);
    expect(outcome.ledger.missing).toEqual([5]);
    expect(outcome.execution?.judged).toBe(7);
    expect(outcome.execution?.passed).toBe(4);
    expect(outcome.execution?.accuracy).toBeCloseTo(4 / 7, 6);
    // Question 6's wrong statement still runs: "wrong" and "did not run" are different findings.
    expect(outcome.execution?.executable).toBe(5);
    expect(outcome.problems).toEqual([]);
  });

  it('pairs the two runs case by case and reports the sign with its resolution', async () => {
    const base = fixture();
    const path = writePredictions(base, predictionsFor(THEIRS_CORRECT));
    const outcome = await scoreRun(settingsFor(base, path));
    expect(outcome.paired).toMatchObject({ competitorOnly: 1, oursOnly: 2, both: 3, neither: 1 });
    expect(outcome.paired?.delta).toBeCloseTo(1 / 7, 6);
    // Fourteen points on seven questions is still inside the MDE: three discordant pairs on seven
    // cases put the resolution at 69pp at 80% power, which is the whole reason this tool prints
    // one. A fourteen-point gap and a zero are the same reading on this many questions.
    expect(outcome.paired?.resolves).toBe(false);
    expect(outcome.paired?.mde).toBeCloseTo(0.6932, 3);
  });

  it('writes an artifact that carries the coordinates beside the number', async () => {
    const base = fixture();
    const path = writePredictions(base, predictionsFor(THEIRS_CORRECT));
    const settings = settingsFor(base, path);
    const outcome = await scoreRun(settings);
    const written = writeScoreArtifact(settings, outcome);
    const body = JSON.parse(readFileSync(written, 'utf8')) as Record<string, any>;
    expect(body.competitor.commit).toBe(COMMIT);
    expect(body.competitor.model).toBe('deepseek-chat');
    expect(body.reference.arm).toBe(ARM);
    expect(body.comparable).toBe(true);
    expect(body.execution.passed).toBe(4);
    expect(body.violations).toEqual([]);
    // No map was declared, so the artifact says so rather than leaving the field out: a reader
    // has to be able to tell "read by id" from "the writer forgot".
    expect(body.idMap).toBeNull();
  });
});

describe('a coordinate that does not hold produces no accuracy at all', () => {
  it('refuses the run and still reports what the file contained', async () => {
    const base = fixture();
    const path = writePredictions(base, predictionsFor(THEIRS_CORRECT));
    const coordinates = join(base.dir, 'wrong-model.json');
    writeFileSync(
      coordinates,
      readFileSync(base.coordinates, 'utf8').replace('"deepseek-chat"', '"gpt-4o"'),
    );
    const outcome = await scoreRun(settingsFor(base, path, { coordinates }));
    expect(outcome.comparable).toBe(false);
    expect(outcome.execution).toBeUndefined();
    expect(outcome.violations[0]).toContain('model "gpt-4o" against "deepseek-chat"');
    const lines = scoreLines(outcome);
    expect(lines.some((line) => line.includes('NOT COMPARABLE'))).toBe(true);
    expect(lines.some((line) => line.includes('no accuracy: the coordinates above do not hold'))).toBe(true);
    const code = await main(
      ['--predictions', path, '--coordinates', coordinates, '--report', base.report, '--model', 'deepseek-chat', '--endpoint', 'https://api.deepseek.com', '--out', join(base.dir, 'out', 'refused.json')],
      ROOT,
      base.env,
    );
    expect(code).toBe(1);
  });

  it('refuses a report measured with a different model than the comparison declares', async () => {
    const base = fixture();
    const report = JSON.parse(readFileSync(base.report, 'utf8')) as Record<string, unknown>;
    writeFileSync(base.report, JSON.stringify({ ...report, model: 'gpt-4o' }));
    const path = writePredictions(base, predictionsFor(THEIRS_CORRECT));
    const outcome = await scoreRun(settingsFor(base, path));
    expect(outcome.problems[0]).toContain('was produced by gpt-4o, and this comparison declares deepseek-chat');
    expect(outcome.execution?.passed).toBe(4);
  });
});

describe('the cases a comparison has to leave out, and why', () => {
  it('drops a question whose gold the engine refuses from both denominators', async () => {
    const base = fixture();
    const questions = JSON.parse(readFileSync(base.layout.questionsFile, 'utf8')) as Record<string, unknown>[];
    questions.push({ question_id: 8, db_id: MINI_DB, question: 'A question nobody can answer?', evidence: '', SQL: 'select * from missing_table', difficulty: 'simple' });
    writeFileSync(base.layout.questionsFile, JSON.stringify(questions));
    const report = JSON.parse(readFileSync(base.report, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      base.report,
      JSON.stringify({
        ...report,
        cases: [...(report.cases as unknown[]), { arm: ARM, id: '8', passed: false }],
      }),
    );
    extendCoordinates(base, [...MINI_QUESTIONS.map((question) => question.id), 8]);
    const path = writePredictions(base, predictionsFor(THEIRS_CORRECT));
    const outcome = await scoreRun(settingsFor(base, path));
    expect(outcome.execution?.goldFailed).toBe(1);
    expect(outcome.execution?.judged).toBe(7);
    expect(outcome.ledger.declared).toBe(8);
  });

  it('says so when the judge calls an empty result a match for the gold', async () => {
    const base = fixture();
    const questions = JSON.parse(readFileSync(base.layout.questionsFile, 'utf8')) as Record<string, unknown>[];
    questions.push({ question_id: 9, db_id: MINI_DB, question: 'Nothing at all?', evidence: '', SQL: 'select * from items where 1 = 0', difficulty: 'simple' });
    writeFileSync(base.layout.questionsFile, JSON.stringify(questions));
    const report = JSON.parse(readFileSync(base.report, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      base.report,
      JSON.stringify({ ...report, cases: [...(report.cases as unknown[]), { arm: ARM, id: '9', passed: false }] }),
    );
    extendCoordinates(base, [...MINI_QUESTIONS.map((question) => question.id), 9]);
    const path = writePredictions(base, predictionsFor(THEIRS_CORRECT));
    const outcome = await scoreRun(settingsFor(base, path));
    expect(outcome.comparable).toBe(true);
    expect(outcome.problems[0]).toContain('calls the gold a match for an empty result');
  });

  it('reports that nothing could be judged when every gold fails', async () => {
    const base = fixture();
    const dir = mkdtempSync(join(tmpdir(), 'competitors-broken-'));
    writeMiniBirdDataset(dir);
    const questions = JSON.parse(readFileSync(join(dir, 'mini_dev_sqlite.json'), 'utf8')) as Record<string, unknown>[];
    for (const question of questions) question.SQL = 'select * from nowhere';
    writeFileSync(join(dir, 'mini_dev_sqlite.json'), JSON.stringify(questions));
    const layout = resolveLayout(
      { BIRD_SPLIT: 'minidev', BIRD_DATA: dir, BIRD_DATABASES: join(dir, 'dev_databases'), BIRD_OUT: base.report },
      ROOT,
    );
    const path = writePredictions(base, predictionsFor(THEIRS_CORRECT));
    const outcome = await scoreRun(settingsFor(base, path, { layout }));
    expect(outcome.execution).toBeUndefined();
    expect(outcome.problems).toEqual(['no question could be judged: every gold statement failed to run']);
    const lines = scoreLines(outcome);
    expect(lines.some((line) => line.includes('no accuracy: nothing was judged'))).toBe(true);
  });
});

describe('a file that holds nothing is missing input, not a zero', () => {
  it('refuses to score a predictions file with no records at all', async () => {
    const base = fixture();
    const path = writePredictions(base, '');
    const outcome = await scoreRun(settingsFor(base, path));
    // The first `full` dispatch published exactly this: a green job, a zero-byte file and a
    // sixty-point gap read as significant. Nothing was answered because nothing was written.
    expect(outcome.execution).toBeUndefined();
    expect(outcome.paired).toBeUndefined();
    expect(outcome.problems).toEqual([
      `${path} holds no records at all: the pipeline wrote nothing, so this is a missing input rather than a measurement of zero`,
    ]);
    const lines = scoreLines(outcome);
    expect(lines.some((line) => line.includes('unreadable file: is empty'))).toBe(true);
    expect(lines.some((line) => line.includes('no accuracy: nothing was judged'))).toBe(true);
    const code = await main(
      [
        '--predictions', path,
        '--coordinates', base.coordinates,
        '--report', base.report,
        '--model', 'deepseek-chat',
        '--endpoint', 'https://api.deepseek.com',
        '--out', join(base.dir, 'out', 'empty.json'),
      ],
      ROOT,
      base.env,
    );
    expect(code).toBe(1);
  });

  it('still scores a run whose every answer came back blank', async () => {
    // This pipeline ran and the model returned nothing for every question, which is a measurement
    // of zero. The difference from the case above is that there are records: the file says
    // "nothing here", rather than not existing.
    const base = fixture();
    const body = Object.fromEntries(MINI_QUESTIONS.map((question) => [String(question.id), '   ']));
    const path = writePredictions(base, JSON.stringify(body));
    const outcome = await scoreRun(settingsFor(base, path));
    expect(outcome.execution?.judged).toBe(7);
    expect(outcome.execution?.accuracy).toBe(0);
    expect(outcome.ledger.empty).toHaveLength(7);
    expect(outcome.problems).toEqual([]);
  });

  it('refuses a file whose every statement is numbered differently from the question set', async () => {
    // The mirror of the case above: records exist, and not one of them names a question in this
    // set. Scoring it would publish 0% for a run that answered seven questions correctly.
    const base = fixture();
    const body = Object.fromEntries(
      MINI_QUESTIONS.map((question, position) => [String(100 + position), payload(question.sql)]),
    );
    const path = writePredictions(base, JSON.stringify(body));
    const outcome = await scoreRun(settingsFor(base, path));
    expect(outcome.execution).toBeUndefined();
    expect(outcome.ledger.answered).toBe(0);
    expect(outcome.ledger.unknown).toHaveLength(7);
    expect(outcome.problems).toEqual([
      `${path} holds 7 statement(s) and not one names a question in this set: the numbering does not match, so a rate from it would be a rate about nothing`,
    ]);
    expect(scoreLines(outcome).some((line) => line.includes('no accuracy: nothing was judged'))).toBe(true);
  });

  it('refuses a file whose records name questions this split does not hold', async () => {
    const base = fixture();
    const path = writePredictions(base, JSON.stringify([['A question nobody asked?', payload('select 1')]]));
    const outcome = await scoreRun(settingsFor(base, path));
    expect(outcome.execution).toBeUndefined();
    expect(outcome.ledger.unknown).toEqual([]);
    expect(outcome.ledger.drops[0]?.why).toContain('names a question that is not in this split');
    expect(outcome.problems).toEqual([
      `${path} holds nothing that could be attributed to a question in this set, so there is nothing to measure`,
    ]);
  });

  it('does not read an empty question set as a silent file, because nothing was asked', () => {
    // The guard above fires on the answer counts, and an empty set has none of them. Confusing the
    // two would replace "the split offers no question" with a message about the pipeline.
    expect(silentRun(parsePredictions('', []))).toBeUndefined();
  });
});

describe('a pipeline that numbers its answers by row', () => {
  /** The same statements, keyed by the row they answer instead of by the question's own id. */
  function byPosition(correct: readonly number[]): string {
    const body: Record<string, string> = {};
    MINI_QUESTIONS.forEach((question, position) => {
      body[String(position)] = payload(correct.includes(question.id) ? question.sql : 'select count(*) from items');
    });
    return JSON.stringify(body, null, 2);
  }

  const idMapFor = (base: Fixture): string => {
    const path = join(base.dir, 'id-map.json');
    writeFileSync(path, JSON.stringify(MINI_QUESTIONS.map((question) => ({ question_id: question.id }))));
    return path;
  };

  it('scores the positions through the numbering it was given, and says so', async () => {
    const base = fixture();
    const idMap = idMapFor(base);
    const path = writePredictions(base, byPosition(THEIRS_CORRECT));
    const outcome = await scoreRun(settingsFor(base, path, { idMap }));
    expect(outcome.ledger.answered).toBe(7);
    expect(outcome.ledger.unknown).toEqual([]);
    expect(outcome.ledger.renumbered).toEqual(MINI_QUESTIONS.map((question) => question.id));
    expect(outcome.execution?.passed).toBe(THEIRS_CORRECT.length);
    expect(outcome.idMap?.ids).toEqual(MINI_QUESTIONS.map((question) => question.id));
    const lines = scoreLines(outcome);
    expect(lines.some((line) => line.includes(`numbering: read through ${idMap}, 7 positions`))).toBe(true);
    expect(lines.some((line) => line.includes('7 statement(s) resolved by position'))).toBe(true);
  });

  it('writes the numbering into the artifact, because a score read through a different map is a different score', async () => {
    const base = fixture();
    const idMap = idMapFor(base);
    const path = writePredictions(base, byPosition(THEIRS_CORRECT));
    const settings = settingsFor(base, path, { idMap });
    const written = writeScoreArtifact(settings, await scoreRun(settings));
    const body = JSON.parse(readFileSync(written, 'utf8')) as Record<string, any>;
    expect(body.idMap.path).toBe(idMap);
    expect(body.idMap.ids).toEqual(MINI_QUESTIONS.map((question) => question.id));
    expect(body.ledger.renumbered).toEqual(MINI_QUESTIONS.map((question) => question.id));
    expect(body.execution.passed).toBe(THEIRS_CORRECT.length);
  });

  it('refuses an empty map instead of reading every statement as an unknown id', async () => {
    const base = fixture();
    const path = writePredictions(base, byPosition(THEIRS_CORRECT));
    const empty = join(base.dir, 'empty-map.json');
    writeFileSync(empty, '[]');
    await expect(scoreRun(settingsFor(base, path, { idMap: empty }))).rejects.toThrow(/holds no positions/);
  });
});

describe('the reading puts the provenance above the number', () => {
  it('reports an inside-MDE delta as a sign, with the questions the effect would need', () => {
    const outcome: ScoreOutcome = {
      run: {
        competitor: 'chess',
        repo: 'ShayanTalaei/CHESS',
        commit: COMMIT,
        split: 'minidev',
        questionIds: [1, 2, 3],
        model: 'deepseek-chat',
        endpoint: 'https://api.deepseek.com',
        prompt: 'competitor',
        executor: EXECUTOR,
        judge: JUDGE,
      },
      reference: { arm: ARM, split: 'minidev', questionIds: [1, 2, 3], model: 'deepseek-chat', endpoint: 'https://api.deepseek.com' },
      ledger: {
        predictions: [],
        declared: 498,
        answered: 470,
        missing: [],
        empty: [],
        duplicates: [],
        unknown: [],
        renumbered: [],
        databaseMismatch: [{ id: 4, declared: 'other', expected: 'shop' }],
        drops: [{ where: 'line 9', why: 'is not JSON' }],
      },
      comparable: true,
      violations: [],
      execution: { judged: 498, goldFailed: 2, executable: 460, passed: 300, accuracy: 0.6024, interval: { low: 0.5591, high: 0.6445 } },
      paired: { competitorOnly: 21, oursOnly: 23, both: 279, neither: 175, delta: 0.004, mde: 0.019, p: 0.88, resolves: false, needed: 1764 },
      problems: [],
    };
    const lines = scoreLines(outcome);
    expect(lines[0]).toBe('');
    expect(lines[1]).toContain('chess @ 3d6e835f858d');
    expect(lines.some((line) => line.includes('answered: 470/498 (94.38%)'))).toBe(true);
    expect(lines.some((line) => line.includes('declared database disagrees with the question on 1 cases'))).toBe(true);
    expect(lines.some((line) => line.includes('unreadable line 9: is not JSON'))).toBe(true);
    expect(lines.some((line) => line.includes('2 gold statements refused'))).toBe(true);
    expect(lines.some((line) => line.includes('accuracy: 60.24% on 498 questions'))).toBe(true);
    expect(lines.some((line) => line.includes('inside the MDE: this run reads a sign, not a size'))).toBe(true);
    expect(lines.some((line) => line.includes('needs 1764 questions, and it has 498'))).toBe(true);
  });

  it('reports an outside-MDE delta as a size', () => {
    const lines = scoreLines({
      run: {
        competitor: 'chess',
        repo: 'a/b',
        commit: COMMIT,
        split: 'minidev',
        questionIds: [1],
        model: 'deepseek-chat',
        endpoint: 'https://api.deepseek.com',
        prompt: 'competitor',
        executor: EXECUTOR,
        judge: JUDGE,
      },
      reference: { arm: ARM, split: 'minidev', questionIds: [1], model: 'deepseek-chat', endpoint: 'https://api.deepseek.com' },
      ledger: { predictions: [], declared: 1, answered: 1, missing: [], empty: [], duplicates: [], unknown: [], renumbered: [], databaseMismatch: [], drops: [] },
      comparable: true,
      violations: [],
      execution: { judged: 1, goldFailed: 0, executable: 1, passed: 1, accuracy: 1, interval: { low: 0.2, high: 1 } },
      paired: { competitorOnly: 0, oursOnly: 3, both: 10, neither: 0, delta: 0.23, mde: 0.05, p: 0.25, resolves: true, needed: 40 },
      problems: ['something the operator should read'],
    });
    expect(lines.some((line) => line.includes('outside the design'))).toBe(true);
    expect(lines.some((line) => line.includes('it has a size: 23.00pp'))).toBe(true);
    expect(lines.some((line) => line.includes('PROBLEM  something the operator should read'))).toBe(true);
  });
});

describe('the command line', () => {
  it('needs a predictions file and a coordinates file', () => {
    expect(() => resolveScoreSettings({}, [], ROOT)).toThrow(/usage: score.ts/);
  });

  it('refuses to infer the model coordinate from anywhere but the environment', () => {
    const base = ['--predictions', 'p.json', '--coordinates', 'c.json'];
    expect(() => resolveScoreSettings({}, base, ROOT)).toThrow(/names the coordinate under test/);
    expect(() => resolveScoreSettings({ LLM_MODEL: 'deepseek-chat' }, base, ROOT)).toThrow(/names the host that served the calls/);
    expect(() =>
      resolveScoreSettings({ LLM_MODEL: 'deepseek-chat', LLM_BASE_URL: 'https://api.deepseek.com' }, base, ROOT),
    ).not.toThrow();
  });

  it('refuses an effect that is not a positive difference', () => {
    const argv = ['--predictions', 'p.json', '--coordinates', 'c.json', '--model', 'm', '--endpoint', 'e', '--effect', '0'];
    expect(() => resolveScoreSettings({}, argv, ROOT)).toThrow(/--effect must be a positive/);
    expect(() => resolveScoreSettings({}, [...argv.slice(0, -1), 'banana'], ROOT)).toThrow(/--effect must be a positive/);
  });

  it('refuses a flag with no value', () => {
    expect(() => resolveScoreSettings({}, ['--predictions'], ROOT)).toThrow(/--predictions needs a value/);
    expect(() =>
      resolveScoreSettings({}, ['--predictions', 'p.json', '--coordinates', 'c.json', '--model', 'm', '--endpoint', 'e', '--id-map'], ROOT),
    ).toThrow(/--id-map needs a value/);
  });

  it('carries the numbering flag into the settings, and leaves it unset when it is not declared', () => {
    const base = ['--predictions', 'p.json', '--coordinates', 'c.json', '--model', 'm', '--endpoint', 'e'];
    expect(resolveScoreSettings({}, [...base, '--id-map', 'ids.json'], ROOT).idMap).toBe('ids.json');
    expect(resolveScoreSettings({}, base, ROOT).idMap).toBeUndefined();
  });

  it('derives the artifact path from the predictions file when none is given', () => {
    const settings = resolveScoreSettings(
      {},
      ['--predictions', '/tmp/mac-sql/predict_dev.json', '--coordinates', 'c.json', '--model', 'm', '--endpoint', 'e'],
      ROOT,
    );
    expect(settings.out.endsWith('competitors/predict_dev.json')).toBe(true);
  });

  it('refuses a report with no cases, because a comparison needs our rows too', () => {
    expect(() => armOutcomes({ cases: undefined }, ARM, 'r.json')).toThrow(/holds no cases/);
    expect(() => armOutcomes({ cases: [{ arm: 'other', id: '1', passed: true }] }, ARM, 'r.json')).toThrow(/has no arm metadata\+evidence/);
  });
});

describe('a clean run, through the command line', () => {
  it('returns zero and writes the artifact where it was asked to', async () => {
    const base = fixture();
    const path = writePredictions(base, predictionsFor(THEIRS_CORRECT));
    const out = join(base.dir, 'out', 'clean.json');
    const code = await main(
      [
        '--predictions', path,
        '--coordinates', base.coordinates,
        '--report', base.report,
        '--model', 'deepseek-chat',
        '--endpoint', 'https://api.deepseek.com',
        '--out', out,
      ],
      ROOT,
      base.env,
    );
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).comparable).toBe(true);
  });

  it('matches only the module that is being run, not the module that is being imported', () => {
    expect(isEntry(undefined, 'file:///a/score.ts')).toBe(false);
    expect(isEntry('/a/score.ts', 'file:///a/other.ts')).toBe(false);
    expect(isEntry('/a/score.ts', 'file:///a/score.ts')).toBe(true);
  });
});

describe('the report and the split can disagree, and then nothing is measured', () => {
  it('falls back to the layout split and to the declared model when the report omits them', async () => {
    const base = fixture();
    const report = JSON.parse(readFileSync(base.report, 'utf8')) as Record<string, unknown>;
    delete report.model;
    delete report.split;
    writeFileSync(base.report, JSON.stringify(report));
    const path = writePredictions(base, predictionsFor(THEIRS_CORRECT));
    const outcome = await scoreRun(settingsFor(base, path));
    expect(outcome.reference.split).toBe('minidev');
    expect(outcome.problems).toEqual([]);
    expect(outcome.execution?.passed).toBe(4);
  });

  it('scores nothing when the report names questions the split does not hold', async () => {
    const base = fixture();
    const report = JSON.parse(readFileSync(base.report, 'utf8')) as Record<string, unknown>;
    const ids = MINI_QUESTIONS.map((question) => question.id + 900);
    writeFileSync(
      base.report,
      JSON.stringify({ ...report, cases: ids.map((id) => ({ arm: ARM, id: String(id), passed: true })) }),
    );
    extendCoordinates(base, ids);
    const path = writePredictions(base, predictionsFor(THEIRS_CORRECT));
    const outcome = await scoreRun(settingsFor(base, path));
    expect(outcome.ledger.declared).toBe(0);
    expect(outcome.problems).toEqual(['no question could be judged: every gold statement failed to run']);
    const lines = scoreLines(outcome);
    expect(lines.some((line) => line.includes('answered: 0/0 (0.00%)'))).toBe(true);
  });

  it('reports an id outside the split and a repeated answer beside the accuracy', async () => {
    const base = fixture();
    const path = writePredictions(
      base,
      [
        JSON.stringify({ idx: 1, pred: 'select count(*) from items' }),
        JSON.stringify({ idx: 1, pred: 'select count(*) from items' }),
        JSON.stringify({ idx: 99, pred: 'select 1' }),
      ].join('\n'),
    );
    const outcome = await scoreRun(settingsFor(base, path));
    expect(outcome.ledger.unknown).toEqual([99]);
    expect(outcome.ledger.duplicates).toEqual([1]);
    const lines = scoreLines(outcome);
    expect(lines.some((line) => line.includes('1 unknown id'))).toBe(true);
    expect(lines.some((line) => line.includes('1 repeated (last kept)'))).toBe(true);
  });

  it('exits non-zero when a comparable run still has a problem to read', async () => {
    const base = fixture();
    const report = JSON.parse(readFileSync(base.report, 'utf8')) as Record<string, unknown>;
    // Our report says gpt-4o produced it while the comparison declares deepseek-chat: the number
    // is computable and the provenance is wrong, which is a failure with a reading attached.
    writeFileSync(base.report, JSON.stringify({ ...report, model: 'gpt-4o' }));
    const path = writePredictions(base, predictionsFor(THEIRS_CORRECT));
    const code = await main(
      [
        '--predictions', path,
        '--coordinates', base.coordinates,
        '--report', base.report,
        '--model', 'deepseek-chat',
        '--endpoint', 'https://api.deepseek.com',
        '--out', join(base.dir, 'out', 'problem.json'),
      ],
      ROOT,
      base.env,
    );
    expect(code).toBe(1);
  });
});
