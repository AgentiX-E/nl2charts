/**
 * What the prompt would have had to say, pinned on the five classes and the gate.
 *
 * The classification is the whole instrument: an instrument that reports "eleven per cent of
 * the failures needed a value the prompt does not spell" is only worth reading if the reader
 * can check what it counted, so every rule here is pinned by a case that names the rule. The
 * end-to-end cases run the real `loadQuestions`, the real `buildSchema` and the runner's own
 * `promptFor`, because the claim is about the prompt that was sent: a stubbed prompt would
 * agree with whatever this file was written to expect.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTables } from '../eval/bird/data.js';
import {
  classifyInformation,
  digitRuns,
  informationExamples,
  informationLines,
  informationPath,
  informationProblems,
  isEntry,
  main,
  promptForCase,
  renderableArm,
  resolveInfoSettings,
  runInformation,
  skeleton,
  tallyInformation,
  writeInformationArtifact,
} from '../eval/bird/information.js';
import type { InfoOutcome, InfoTally } from '../eval/bird/information.js';
import { resolveArm } from '../eval/bird/run.js';
import { writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();

/** A prompt that spells one value verbatim, one only in another case, one only as digits. */
const PROMPT = [
  'You translate questions into one read-only SQL statement.',
  'How many pens are there in the Munich store on 2019/8/20?',
  'items(id INT, name TEXT -- sold as pen or cup., grade TEXT -- a high school grade band.)',
].join('\n');

function classify(sql: string, question = 'How many pens are there in the Munich store on 2019/8/20?') {
  return classifyInformation(PROMPT, question, sql);
}

describe('the digits and the skeleton of a value', () => {
  it('reads digit runs as numbers, so a padded month and a bare one are one run', () => {
    expect(digitRuns('2012-08-25')).toEqual([2012, 8, 25]);
    expect(digitRuns('no digits here')).toEqual([]);
  });

  it('drop separators, so two notations share one skeleton', () => {
    expect(skeleton('K-9')).toBe('k9');
    expect(skeleton('2012-08-25')).toBe('20120825');
  });
});

describe('the class a filter value lands in', () => {
  it('calls a value the prompt spells verbatim `spelled`', () => {
    const verdict = classify("select count(*) from items where name = 'pen'");
    expect(verdict.cls).toBe('spelled');
    expect(verdict.values).toEqual([{ column: 'name', value: 'pen', cls: 'spelled' }]);
  });

  it('calls a value the prompt spells only in another case `casing`', () => {
    // The question says "pens"; the store says "Pen". This is the class a sample closes, and
    // the one that decides whether stored values are worth shipping.
    expect(classify("select count(*) from items where name = 'Pen'").cls).toBe('casing');
  });

  it('calls a date the prompt writes with other separators `notation`', () => {
    const verdict = classify("select count(*) from items where day = '2019-08-20'");
    expect(verdict.cls).toBe('notation');
  });

  it('calls a permuted date `notation` when every number in it is in the question', () => {
    // Nothing in this prompt writes the date in the store's order, so the only rule that can
    // save it is the one that reads the numbers out of the question.
    const asked = 'How many pens were sold on 20/8/2019?';
    expect(classifyInformation(asked, asked, "select 1 where d = '2019-08-20'").cls).toBe('notation');
  });

  it('calls a date `absent` when the digits are in neither order', () => {
    // Every digit of 1993-11-12 is missing from the question, and the prompt holds no run of
    // them either: the model would have had to know the date.
    const asked = 'How many pens were sold on 20/8/2019?';
    expect(classifyInformation(asked, asked, "select 1 where d = '1993-11-12'").cls).toBe('absent');
  });

  it('calls a value spelled without its punctuation `notation`', () => {
    expect(classify("select 1 where grade = 'High-School'").values[0]).toEqual({ column: 'grade', value: 'High-School', cls: 'notation' });
  });

  it('calls a value the prompt never mentions `absent`', () => {
    expect(classify("select count(*) from items where name = 'zebra'").cls).toBe('absent');
  });

  it('reports `none` when the gold compares against no string value', () => {
    expect(classify('select count(*) from items where price > 2').cls).toBe('none');
  });

  it('takes the worst class, because one missing value is the finding', () => {
    const verdict = classify("select 1 where name = 'pen' and brand = 'zebra'");
    expect(verdict.cls).toBe('absent');
    expect(verdict.values.map((entry) => entry.cls)).toEqual(['spelled', 'absent']);
  });

  it('leaves the right-hand side of a pattern operator alone', () => {
    // `like` is a pattern the statement derives from the question; it is not a stored value.
    expect(classify("select 1 from items where name like 'ze%'").cls).toBe('none');
    expect(classify("select 1 from items where name glob 'ze*'").cls).toBe('none');
    expect(classify("select 1 from items where name not like 'ze%'").cls).toBe('none');
  });

  it('leaves a format mask alone, because it is syntax rather than a value', () => {
    // A `%` in a value is a pattern, whatever operator it arrives with.
    expect(classify("select 1 from items where day in ('2019%', '2018%')").cls).toBe('none');
  });

  it('skips an empty literal, which is a comparison against the empty string', () => {
    expect(classify("select 1 from items where name <> ''").cls).toBe('none');
  });
});

describe('the tally', () => {
  it('counts every class and reports how many cases the axis applies to', () => {
    const tally = tallyInformation(['spelled', 'casing', 'notation', 'absent', 'none']);
    expect(tally).toEqual({
      total: 5,
      examined: 4,
      classes: { spelled: 1, casing: 1, notation: 1, absent: 1, none: 1 },
    });
  });

  it('reads an empty input as an empty tally rather than a division by zero', () => {
    expect(tallyInformation([]).total).toBe(0);
  });
});

describe('the lines a reader sees', () => {
  const tally: InfoTally = { total: 10, examined: 8, classes: { spelled: 5, casing: 2, notation: 0, absent: 1, none: 2 } };

  it('names the reachable set in absolute cases, not only as a share', () => {
    const lines = informationLines(tally);
    expect(lines[0]).toBe('what the prompt would have had to say');
    expect(lines.join('\n')).toContain('a stored-value sample can reach at most 3 of them (30.0%)');
  });

  it('does not divide by zero when nothing was read', () => {
    const empty = tallyInformation([]);
    expect(informationLines(empty).join('\n')).toContain('0.0%');
  });
});

describe('the gate the instrument can be', () => {
  const tally = tallyInformation(['spelled']);

  it('passes a measurement that read a prompt for every case', () => {
    expect(informationProblems({ tally, definitionGap: 0, unrenderable: 0 })).toEqual([]);
  });

  it('fails when nothing was read', () => {
    expect(informationProblems({ tally: tallyInformation([]), definitionGap: 0, unrenderable: 0 })[0]).toContain('nothing about the prompt');
  });

  it('does not restate a drop as an empty population', () => {
    // One root cause, not two symptoms.
    const named = informationProblems({ tally: tallyInformation([]), definitionGap: 2, unrenderable: 0 });
    expect(named).toHaveLength(1);
    expect(named[0]).toContain('not the card that was sent');
  });

  it('fails when a case is in a database whose definitions the artifact does not carry', () => {
    expect(informationProblems({ tally, definitionGap: 2, unrenderable: 0 })[0]).toContain('not the card that was sent');
  });

  it('fails when the arm needs a block the artifact does not keep', () => {
    expect(informationProblems({ tally, definitionGap: 0, unrenderable: 3 })[0]).toContain('a block the artifact does not keep');
  });
});

describe('which arms this instrument may measure', () => {
  it('renders an arm whose prompt is the card and the question', () => {
    expect(renderableArm(resolveArm('select') as never)).toBe(true);
  });

  it('refuses an arm whose evidence is synthesized', () => {
    expect(renderableArm(resolveArm('synthetic') as never)).toBe(false);
  });

  it('refuses an arm that draws on matched values', () => {
    expect(renderableArm(resolveArm('values') as never)).toBe(false);
  });

  it('refuses an arm that draws on worked examples', () => {
    expect(renderableArm(resolveArm('inline+icl') as never)).toBe(false);
  });

  it('refuses an arm whose evidence is retrieved, which the artifact keeps only a count of', () => {
    // `inline+retrieval` was accepted until this round. `promptFor` then dropped the evidence
    // block without saying so, so an instrument would have measured a prompt the model never
    // saw — the exact failure the check exists to prevent — and reported it as the prompt that
    // was sent. No gate ran the arm, which is why the hole survived.
    expect(renderableArm(resolveArm('inline+retrieval') as never)).toBe(false);
  });

  it('refuses an arm whose prompt carries a decomposition', () => {
    expect(renderableArm(resolveArm('decompose') as never)).toBe(false);
  });
});

function dataset(): string {
  const dir = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'info-')));
  const file = join(dir, 'mini_dev_sqlite.json');
  const questions = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
  // Five questions, one per class, so the end-to-end tally is a reading of the rules rather
  // than of the fixture's accidents.
  const extra = [
    { question_id: 101, db_id: 'shop', question: 'How many pens are there?', evidence: '', SQL: "select count(*) from items where name = 'pen'", difficulty: 'simple' },
    { question_id: 102, db_id: 'shop', question: 'How many pens are there?', evidence: '', SQL: "select count(*) from items where name = 'Pen'", difficulty: 'simple' },
    { question_id: 103, db_id: 'shop', question: 'How many items were sold on 2020/1/2?', evidence: '', SQL: "select count(*) from items where day = '2020-01-02'", difficulty: 'simple' },
    { question_id: 104, db_id: 'shop', question: 'How many pens are there?', evidence: '', SQL: "select count(*) from items where name = 'zebra'", difficulty: 'simple' },
    { question_id: 105, db_id: 'shop', question: 'How many items are there?', evidence: '', SQL: 'select count(*) from items', difficulty: 'simple' },
  ];
  writeFileSync(file, JSON.stringify([...questions, ...extra]));
  return dir;
}

function reportBody(ids: readonly number[], overrides: Record<string, unknown> = {}, arm = 'select'): unknown {
  return {
    split: 'minidev',
    cases: ids.map((id) => ({ arm, id: String(id), candidateRecall: false, reason: 'values' })),
    controls: { synthesizedDefinitions: { shop: 'items.name: the label the store sells under.' } },
    ...overrides,
  };
}

function settingsFor(data: string, body: unknown, argv: readonly string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'info-report-'));
  const path = join(dir, 'bird-eval.json');
  writeFileSync(path, JSON.stringify(body));
  return resolveInfoSettings({ BIRD_SPLIT: 'minidev', BIRD_DATA: data, BIRD_OUT: join(dir, 'out.json') }, [path, '--arm', 'select', ...argv], ROOT);
}

describe('rendering the prompt an arm sends', () => {
  it('carries the question and the definitions the run placed on the card', () => {
    const data = dataset();
    const settings = settingsFor(data, reportBody([101]));
    const table = loadTables(join(data, 'dev_tables.json')).get('shop');
    const question = JSON.parse(readFileSync(join(data, 'mini_dev_sqlite.json'), 'utf8')).find(
      (entry: { question_id: number }) => entry.question_id === 101,
    );
    const prompt = promptForCase(resolveArm('select') as never, question, 'items.name: the label the store sells under.', table as never);
    expect(prompt).toContain('How many pens are there?');
    expect(prompt).toContain('the label the store sells under');
    expect(settings.arm).toBe('select');
  });
});

describe('the measurement over an artifact', () => {
  it('lands one case per class and reads the definitions from the artifact', async () => {
    const outcome = await runInformation(settingsFor(dataset(), reportBody([101, 102, 103, 104, 105])));
    expect(outcome.rows.map((row) => row.cls)).toEqual(['spelled', 'casing', 'notation', 'absent', 'none']);
    expect(outcome.tally.examined).toBe(4);
    expect(outcome.problems).toEqual([]);
  });

  it('drops a case whose question the split does not have', async () => {
    const outcome = await runInformation(settingsFor(dataset(), reportBody([101, 999])));
    expect(outcome.drops.unknownQuestion).toBe(1);
    expect(outcome.rows).toHaveLength(1);
  });

  it('refuses to measure an inline arm whose definitions the artifact dropped', async () => {
    // The card would be rendered without the text that was on it, so the class would be about a
    // prompt nobody sent. Loud, and absolute: one such case fails the gate.
    const outcome = await runInformation(
      settingsFor(dataset(), reportBody([101], { controls: { synthesizedDefinitions: {} } })),
    );
    expect(outcome.drops.definitionGap).toBe(1);
    expect(outcome.problems.join('\n')).toContain('not the card that was sent');
  });

  it('drops every case and says why when the arm is not renderable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'info-report-'));
    const path = join(dir, 'bird-eval.json');
    writeFileSync(path, JSON.stringify(reportBody([101], {}, 'values')));
    const settings = resolveInfoSettings(
      { BIRD_SPLIT: 'minidev', BIRD_DATA: dataset(), BIRD_OUT: join(dir, 'out.json') },
      [path, '--arm', 'values'],
      ROOT,
    );
    const outcome = await runInformation(settings);
    expect(outcome.drops.unrenderable).toBe(1);
    expect(outcome.problems.join('\n')).toContain('a block the artifact does not keep');
  });

  it('does not divide by zero when no case lacked an answer', async () => {
    // A run whose candidate set always held an answer is a legitimate zero — nothing to
    // attribute — unlike a report with no rows at all, which is refused before this point.
    const body = { split: 'minidev', cases: [{ arm: 'select', id: '101', candidateRecall: true, reason: 'values' }], controls: {} };
    const outcome = await runInformation(settingsFor(dataset(), body));
    expect(outcome.tally.total).toBe(0);
    expect(outcome.problems[0]).toContain('nothing about the prompt');
  });

  it('refuses a report that predates the cases field', async () => {
    await expect(runInformation(settingsFor(dataset(), { split: 'minidev' }))).rejects.toThrow(
      /holds no cases, so arm select cannot be measured/,
    );
  });

  it('refuses an arm the artifact does not hold', async () => {
    const settings = settingsFor(dataset(), reportBody([101]));
    await expect(runInformation({ ...settings, arm: 'select-cross' })).rejects.toThrow(
      /has no arm select-cross; it holds select/,
    );
  });

  it('drops a case whose database the table manifest does not describe', async () => {
    const data = dataset();
    const file = join(data, 'mini_dev_sqlite.json');
    const questions = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
    writeFileSync(file, JSON.stringify([...questions, { question_id: 106, db_id: 'gone', question: 'x', evidence: '', SQL: "select 1 where a = 'b'", difficulty: 'simple' }]));
    const outcome = await runInformation(settingsFor(data, reportBody([106])));
    expect(outcome.drops.definitionGap).toBe(1);
  });

  it('counts every case and says why when the arm name is not one the runner has', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'info-report-'));
    const path = join(dir, 'bird-eval.json');
    writeFileSync(path, JSON.stringify(reportBody([101], {}, 'no-such-arm')));
    const settings = resolveInfoSettings(
      { BIRD_SPLIT: 'minidev', BIRD_DATA: dataset(), BIRD_OUT: join(dir, 'out.json') },
      [path, '--arm', 'no-such-arm'],
      ROOT,
    );
    const outcome = await runInformation(settings);
    expect(outcome.drops.unknownArm).toBe(1);
    expect(outcome.rows).toEqual([]);
  });
});

describe('the settings', () => {
  it('defaults to the arm the chain runs and the pipeline ships', () => {
    const dir = mkdtempSync(join(tmpdir(), 'info-settings-'));
    const path = join(dir, 'bird-eval.json');
    writeFileSync(path, '{}');
    expect(resolveInfoSettings({ BIRD_OUT: join(dir, 'o.json') }, [path], ROOT).arm).toBe('metadata+evidence');
  });

  it('reads --arm and --strict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'info-settings-'));
    const path = join(dir, 'bird-eval.json');
    writeFileSync(path, '{}');
    const settings = resolveInfoSettings({ BIRD_OUT: join(dir, 'o.json') }, [path, '--arm', 'select', '--strict'], ROOT);
    expect(settings.arm).toBe('select');
    expect(settings.strict).toBe(true);
  });

  it('refuses --arm with no name after it', () => {
    expect(() => resolveInfoSettings({}, ['report.json', '--arm'], ROOT)).toThrow('--arm needs a name');
  });

  it('refuses to run without a report', () => {
    expect(() => resolveInfoSettings({}, ['--strict'], ROOT)).toThrow('usage: information.ts');
  });
});

describe('the artifact', () => {
  const outcome: InfoOutcome = {
    split: 'minidev',
    arm: 'select',
    rows: [
      { id: '2', reason: 'values', cls: 'casing', values: [{ column: 'name', value: 'Pen', cls: 'casing' }] },
      { id: '3', reason: 'values', cls: 'spelled', values: [{ column: 'name', value: 'pen', cls: 'spelled' }] },
    ],
    tally: tallyInformation(['casing', 'spelled']),
    drops: { unknownQuestion: 0, unknownArm: 0, definitionGap: 0, unrenderable: 0 },
    problems: [],
  };

  it('names a file after the arm it measured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'info-artifact-'));
    const settings = resolveInfoSettings({ BIRD_OUT: join(dir, 'bird-eval.json') }, [join(dir, 'r.json'), '--arm', 'select-cross'], ROOT);
    expect(informationPath(settings).endsWith('information-select-cross.json')).toBe(true);
    expect(writeInformationArtifact(settings, outcome).endsWith('information-select-cross.json')).toBe(true);
  });

  it('prints the cases behind the classes, and only those', () => {
    const lines = informationExamples(outcome);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('casing');
    expect(lines[0]).toContain('name=Pen');
  });

  it('exits zero on a clean measurement and one under --strict when the instrument failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'info-main-'));
    const path = join(dir, 'bird-eval.json');
    const datasetDir = dataset();
    const env = { BIRD_SPLIT: 'minidev', BIRD_DATA: datasetDir, BIRD_OUT: join(dir, 'out.json') };
    writeFileSync(path, JSON.stringify(reportBody([101])));
    expect(await main([path, '--arm', 'select'], ROOT, env)).toBe(0);
    // Two cases, one of them in a class this instrument has to name: the printed report carries
    // the case, because a share a reader cannot check is a share a reader has to trust.
    writeFileSync(path, JSON.stringify(reportBody([101, 102])));
    expect(await main([path, '--arm', 'select'], ROOT, env)).toBe(0);
    writeFileSync(path, JSON.stringify(reportBody([101], { controls: {} })));
    expect(await main([path, '--arm', 'select'], ROOT, env)).toBe(0);
    expect(await main([path, '--arm', 'select', '--strict'], ROOT, env)).toBe(1);
  });

  it('knows when it is the program being run', () => {
    expect(isEntry(new URL('../eval/bird/information.ts', import.meta.url).pathname, new URL('../eval/bird/information.ts', import.meta.url).href)).toBe(true);
    expect(isEntry(undefined, 'file:///x')).toBe(false);
  });
});
