/**
 * The selection instrument: which rule kept the answer, read from a file instead of a run.
 *
 * The claim this file has to support is narrow: *each column is a function of data the artifact
 * already holds, and the columns differ exactly where the rules differ*. That means three kinds of
 * test and no others:
 *
 * - a bank where the rules are made to disagree on purpose, so a harness whose columns were all
 *   copies of one rule would fail rather than print a tidy table;
 * - a bank where they must agree, because the disagreement tests are worthless without a control
 *   that says the columns are not simply different numbers;
 * - the refusals. `shortest` without statements and `modal` without fingerprints are *absent
 *   inputs*, not losing rules, and an artifact written before this instrument existed is the
 *   commonest thing it will ever be pointed at. Scoring those as zero would publish "consensus
 *   loses 62 points" about a file that never recorded a result.
 *
 * One pair of numbers is pinned by construction rather than by name: `oracle` here plus the
 * `unrecorded` count equals `pool.ts`'s ceiling on the same artifact. The two instruments were
 * written to answer different questions from the same rows, and this is the arithmetic that says
 * they still are.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CALL_FREE,
  DEFAULT_MARGIN_PP,
  RULE_ORDER,
  dispatch,
  main,
  pair,
  pick,
  readCorpus,
  reportLines,
  resolveConsensusSettings,
} from '../eval/bird/consensus.js';
import type { ConsensusArtifact, ConsensusSettings, Recorded } from '../eval/bird/consensus.js';
import { readPools } from '../eval/bird/pool.js';

type Row = NonNullable<ConsensusArtifact['cases']>[number];

/**
 * One candidate written as a compact string: `source:correct:sql:fingerprint`.
 *
 * A bank that reads as a table is the only kind that stays reviewable when the rules multiply.
 */
function candidate(spec: string): NonNullable<Row['candidates']>[number] {
  const [source, correct, sql, fingerprint] = spec.split(':');
  return {
    source,
    correct: correct === 'yes',
    ...(sql === undefined || sql === '-' ? {} : { sql }),
    ...(fingerprint === undefined || fingerprint === '-' ? {} : { fingerprint }),
  };
}

function one(arm: string, id: number, passed: boolean, specs: readonly string[] = []): Row {
  return { arm, id: String(id), passed, ...(specs.length === 0 ? {} : { candidates: specs.map(candidate) }) };
}

function artifact(cases: Row[]): ConsensusArtifact {
  return { split: 'dev', model: 'deepseek-chat', cases };
}

const settings = (over: Partial<ConsensusSettings> = {}): ConsensusSettings => ({
  artifact: 'unused.json',
  margin: DEFAULT_MARGIN_PP,
  json: false,
  ...over,
});

const dirs: string[] = [];
function scratch(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-'));
  dirs.push(dir);
  const file = join(dir, 'bird-eval.json');
  writeFileSync(file, JSON.stringify(body));
  return file;
}
afterEach(() => {
  dirs.length = 0;
});

const run = (body: unknown, args: readonly string[] = []): string[] => {
  const lines: string[] = [];
  main(['--artifact', scratch(body), ...args], process.cwd(), (line) => lines.push(line));
  return lines;
};

describe('one rule, one index', () => {
  const set: readonly Recorded[] = [
    { source: 'a', correct: false, sql: 'SELECT a_long_statement', fingerprint: 'aaa' },
    { source: 'b', correct: true, sql: 'SELECT b', fingerprint: 'bbb' },
    { source: 'c', correct: false, sql: 'SELECT c', fingerprint: 'bbb' },
  ];

  it('takes the first slot for the rules that have no opinion', () => {
    expect(pick('first', set)).toBe(0);
    expect(pick('model', set)).toBe(0);
    expect(pick('oracle', set)).toBe(0);
  });

  it('takes the shortest statement, not the first one', () => {
    expect(pick('shortest', set)).toBe(1);
  });

  it('takes the result the most candidates agree on', () => {
    // b and c share a fingerprint; a does not. The modal pick is b because it comes first among
    // the two that agree, which is the tie-break the arm's own order would have produced.
    expect(pick('modal', set)).toBe(1);
  });

  it('has no pick for an empty set', () => {
    for (const rule of RULE_ORDER) expect(pick(rule, [])).toBe(-1);
  });

  it('cannot score the shortest rule when no candidate kept its statement', () => {
    const unrecorded: readonly Recorded[] = [
      { source: 'a', correct: true, fingerprint: 'aaa' },
      { source: 'b', correct: false, fingerprint: 'bbb' },
    ];
    expect(pick('shortest', unrecorded)).toBe(-1);
  });

  it('treats a missing statement as the longest, so a candidate never wins by omission', () => {
    const partial: readonly Recorded[] = [
      { source: 'a', correct: false },
      { source: 'b', correct: true, sql: 'SELECT b' },
    ];
    expect(pick('shortest', partial)).toBe(1);
  });

  it('cannot score the modal rule when no candidate carries a fingerprint', () => {
    const prints: readonly Recorded[] = [
      { source: 'a', correct: true, sql: 'SELECT a' },
      { source: 'b', correct: false, sql: 'SELECT b' },
    ];
    expect(pick('modal', prints)).toBe(-1);
  });

  it('skips a candidate with no fingerprint when counting agreement', () => {
    const mixed: readonly Recorded[] = [
      { source: 'a', correct: false, fingerprint: 'aaa' },
      { source: 'b', correct: true, fingerprint: 'bbb' },
      { source: 'c', correct: true },
    ];
    expect(pick('modal', mixed)).toBe(0);
  });
});

describe('the reading', () => {
  /**
   * A bank built so every rule lands on a different question.
   *
   * Question 1: every rule is right — the control that keeps the differences honest.
   * Question 2: only the shortest one is right.
   * Question 3: only the modal result and the shortest one are right; the selector was wrong.
   * Question 4: only the selector was right, and it names no correct candidate — the hole.
   * Question 5: nobody is right.
   * Question 6: all three candidates agree on a wrong result — the correlated error.
   */
  const bank = artifact([
    { ...one('select-mixed', 1, true, ['a:yes:SELECT 1:111', 'b:no:SELECT 22:222', 'c:no:SELECT 333:333']) },
    one('select-mixed', 2, true, ['a:no:SELECT 1234567:111', 'b:yes:SELECT 2:222', 'c:no:SELECT 33333333:333']),
    one('select-mixed', 3, false, ['a:no:SELECT 11111:999', 'b:yes:SELECT 22:777', 'c:yes:SELECT 333:777']),
    { ...one('select-mixed', 4, true, ['a:no:SELECT 1:111', 'b:no:SELECT 2:222', 'c:no:SELECT 3:333']), winnerSource: 'a' },
    one('select-mixed', 5, false, ['a:no:SELECT 111:111', 'b:no:SELECT 2222:222', 'c:no:SELECT 33:333']),
    one('select-mixed', 6, false, ['a:no:SELECT 1:999', 'b:no:SELECT 22:999', 'c:no:SELECT 333:999']),
  ]);

  it('scores each rule on the questions it is the only winner of', () => {
    const corpus = readCorpus(bank);
    const arm = corpus.reading[0];
    const score = (rule: string): number => (arm?.scores.find((entry) => entry.rule === rule) as { correct: number }).correct;
    expect(score('first')).toBe(1);
    expect(score('shortest')).toBe(3);
    expect(score('modal')).toBe(2);
    expect(score('model')).toBe(3);
    expect(score('oracle')).toBe(3);
  });

  it('pairs each call-free rule against the selector on the same questions', () => {
    const arm = readCorpus(bank).reading[0];
    const paired = arm?.against.find((entry) => entry.rule === 'modal');
    // Question 3 is the one modal wins; questions 2 and 4 are the ones the selector wins.
    expect(paired).toMatchObject({ wins: 1, losses: 2, both: 1 });
    expect(typeof paired?.p).toBe('number');
  });

  it('counts unanimity and how often a unanimous set is wrong', () => {
    const arm = readCorpus(bank).reading[0];
    // Question 6 is the only one where all three fingerprints agree.
    expect(arm?.unanimous).toBe(1);
    expect(arm?.unanimousWrong).toBe(1);
    expect(arm?.unmeasured).toBe(0);
  });

  it('reports a passed question with no correct candidate as a hole, not as a ceiling', () => {
    const arm = readCorpus(bank).reading[0];
    expect(arm?.unrecorded).toBe(1);
    expect(arm?.cases).toBe(6);
  });

  it('keeps a question whose candidates all died in the denominator', () => {
    const corpus = readCorpus(artifact([one('select', 1, true, ['select:yes:SELECT 1:111']), one('select', 2, false, [])]));
    const arm = corpus.reading[0];
    expect(arm?.cases).toBe(2);
    expect(arm?.scores.find((entry) => entry.rule === 'first')).toMatchObject({ correct: 1, unavailable: 1 });
  });

  it('scores every rule over the arm cases, so two columns can be compared', () => {
    // The regression: `first` was a share of the questions that produced a candidate (1) while the
    // selector's was a share of the questions the arm ran (2), and the printed difference between
    // the columns then disagreed in sign with the paired test on the same rows — 100% against 50%
    // here, and one win / one loss in the pairing.
    const body = { split: 'dev', cases: [one('select', 1, true, ['a:yes:SELECT 1:111', 'b:no:SELECT 2:222']), one('select', 2, false, [])] };
    const lines = run(body);
    const row = lines.find((line) => line.startsWith('  select ')) as string;
    expect(row).toMatch(/select\s+2\s+50\.00%/);
    // Both rules answered one of the two, and it was the same one, so neither won nor lost.
    expect(lines.join('\n')).toContain('first     50.00% against the selector: won 0 / lost 0 (both 1');
    expect(lines.join('\n')).toContain('1 of them counted as misses for want of input');
  });

  it('agrees with the pool instrument on the ceiling, by the size of the holes it refuses to repair', () => {
    const corpus = readCorpus(bank);
    const pools = readPools(bank);
    const arm = corpus.reading[0];
    const ceiling = arm?.scores.find((entry) => entry.rule === 'oracle') as { correct: number };
    expect(ceiling.correct + (arm?.unrecorded ?? 0)).toBe(pools.arms[0]?.ceiling.size);
  });

  it('names a one-call arm instead of reading it as an arm whose rules all failed', () => {
    const corpus = readCorpus(artifact([one('names', 1, true), one('select-mixed', 1, true, ['a:yes:SELECT 1:111', 'b:yes:SELECT 2:222'])]));
    expect(corpus.single).toEqual(['names']);
    expect(corpus.reading.map((entry) => entry.arm)).toEqual(['select-mixed']);
  });

  it('keeps only the questions every arm with a candidate set ran', () => {
    const corpus = readCorpus(
      artifact([
        one('select-mixed', 1, true, ['a:yes:SELECT 1:111', 'b:no:SELECT 2:222']),
        one('select-mixed', 2, false, ['a:no:SELECT 1:111', 'b:no:SELECT 2:222']),
        one('select-cross', 1, false, ['a:no:SELECT 1:111', 'b:no:SELECT 2:222']),
      ]),
    );
    expect(corpus.ids).toEqual(['1']);
    expect(corpus.reading.map((entry) => entry.cases)).toEqual([1, 1]);
  });

  it('counts the recorded statements and fingerprints so a reader can see what replays', () => {
    const corpus = readCorpus(bank);
    expect(corpus.records).toBe(18);
    expect(corpus.statements).toBe(18);
    expect(corpus.fingerprints).toBe(18);
  });

  it('falls back to the arm name when a candidate forgot its source', () => {
    const corpus = readCorpus({ cases: [{ arm: 'select-mixed', id: 1, passed: true, candidates: [{ correct: true }, { source: '', correct: false }] }] });
    expect(corpus.reading[0]?.cases).toBe(1);
    expect(corpus.reading[0]?.scores.find((entry) => entry.rule === 'first')?.correct).toBe(1);
  });

  it('drops rows it cannot name', () => {
    const corpus = readCorpus({ cases: [{ id: undefined, arm: 'select-mixed', passed: true }, { id: '1', arm: '', passed: true }] });
    expect(corpus.reading).toEqual([]);
    expect(corpus.ids).toEqual([]);
  });

  it('returns an empty corpus for an artifact with no cases', () => {
    expect(readCorpus({})).toMatchObject({ reading: [], ids: [], single: [], records: 0 });
    expect(readCorpus({ cases: [] }).reading).toEqual([]);
  });
});

describe('pairing two readings', () => {
  it('counts the questions only one side got', () => {
    expect(pair([true, true, false, false], [true, false, true, false])).toEqual({ wins: 1, losses: 1, both: 1, p: 1 });
  });

  it('refuses to pair two different question sets', () => {
    expect(() => pair([true], [true, false])).toThrow(/same questions/);
  });
});

describe('the report', () => {
  it('prints a column per rule and a line per arm', () => {
    const lines = run({
      split: 'dev',
      model: 'deepseek-chat',
      cases: [
        one('select-mixed', 1, true, ['a:yes:SELECT 1:111', 'b:no:SELECT 222:222', 'c:no:SELECT 33:333']),
        one('select-mixed', 2, false, ['a:no:SELECT 1:444', 'b:no:SELECT 222:555', 'c:no:SELECT 33:666']),
      ],
    });
    const header = lines.find((line) => line.includes('arm') && line.includes('model'));
    expect(header).toContain('first');
    expect(header).toContain('shortest');
    expect(header).toContain('modal');
    expect(lines.join('\n')).toMatch(/select-mixed: the ceiling is/);
  });

  it('says which input a rule is missing rather than scoring it as zero', () => {
    const lines = run({
      split: 'dev',
      cases: [one('select-mixed', 1, true, ['a:yes', 'b:no'])],
    });
    const text = lines.join('\n');
    expect(text).toContain('cannot be scored: the artifact carries no statements');
    expect(text).toContain('cannot be scored: the artifact carries no result fingerprints');
    expect(text).not.toMatch(/shortest\s+0\.00%/);
  });

  it('prints a dash, not a zero, in the column of a rule it cannot score', () => {
    const lines = run({ split: 'dev', cases: [one('select-mixed', 1, true, ['a:yes', 'b:no'])] });
    const row = lines.find((line) => line.startsWith('  select-mixed ')) as string;
    expect(row).toContain('—');
  });

  it('refuses to call a 10pp lead established when two discordant pairs produced it', () => {
    // Seventeen questions every rule answers, two the selector alone answered (its record names no
    // correct candidate, which is the point), and one nobody answered: a 10pp gap on twenty.
    //
    // This bank used to assert "the fourth call is earning its price", and that assertion was the
    // defect: the gap rests on two discordant pairs, the artifact resolves 19.80pp from them, and
    // a 10pp difference inside a 19.80pp resolution is not a difference this run measured. The
    // margin (2.30pp) is not the binding number here, and printing it as one is what made a
    // 600-question sample quotable against a 1,532-question threshold.
    const body = {
      split: 'dev',
      cases: [
        ...Array.from({ length: 17 }, (_, index) => one('select-mixed', index + 1, true, ['a:yes:SELECT 1:111', 'b:no:SELECT 22:222', 'c:no:SELECT 333:333'])),
        one('select-mixed', 18, true, ['a:no:SELECT 1:444', 'b:no:SELECT 22:555', 'c:no:SELECT 333:666']),
        one('select-mixed', 19, true, ['a:no:SELECT 1:777', 'b:no:SELECT 22:888', 'c:no:SELECT 333:999']),
        one('select-mixed', 20, false, ['a:no:SELECT 1:121', 'b:no:SELECT 22:131', 'c:no:SELECT 333:141']),
      ],
    };
    const lines = run(body).join('\n');
    expect(lines).toContain('first is 10.00pp behind the selector on select-mixed');
    expect(lines).toContain('this artifact resolves only 19.81pp');
    expect(lines).toContain('the size of that lead is not measured by this run');
    expect(lines).not.toContain('earning its price');
    // A margin above the 10pp gap says the same gap is inside the caller's line — and the third
    // sentence appears only when the stated margin is also finer than the evidence.
    expect(run(body, ['--margin', '12']).join('\n')).toContain('the stated margin is finer than the evidence');
  });

  it('accepts the selector when a gap inside the margin is also inside the resolution', () => {
    // 200 questions, the selector 20 ahead, 20 discordant pairs: the artifact resolves 6.26pp, so a
    // 25pp margin is coarser than both the gap (20pp) and the resolution, and the call it buys is
    // measurably worthless.
    const cases = [
      ...Array.from({ length: 160 }, (_, index) => one('select-mixed', index + 1, true, ['a:yes:SELECT 1:111', 'b:no:SELECT 22:222'])),
      ...Array.from({ length: 20 }, (_, index) => one('select-mixed', 161 + index, true, ['a:no:SELECT 1:444', 'b:no:SELECT 22:555'])),
      ...Array.from({ length: 20 }, (_, index) => one('select-mixed', 181 + index, false, ['a:no:SELECT 1:777', 'b:no:SELECT 22:888'])),
    ];
    expect(run({ split: 'dev', cases }, ['--margin', '25']).join('\n')).toContain('the fourth call buys less than the split can resolve');
    // And at the pre-registered 2.30pp the same bank earns its price, because the gap clears both
    // numbers: 20pp observed against a 6.26pp resolution.
    expect(run({ split: 'dev', cases }).join('\n')).toContain('beyond the 6.26pp this artifact resolves — the fourth call is earning its price');
  });

  it('says when a free rule is ahead, rather than printing a negative gap', () => {
    // Two questions where the first candidate was right and the selector took another one: an
    // artifact can improve by deleting a call, and the sentence has to be able to say so. Two
    // questions cannot resolve anything — one discordant pair is a 100pp resolution — and the
    // verdict says that too rather than letting "50pp ahead" stand on its own.
    const body = {
      split: 'dev',
      cases: [
        one('select-mixed', 1, false, ['a:yes:SELECT 1:111', 'b:no:SELECT 22:222', 'c:no:SELECT 333:333']),
        one('select-mixed', 2, true, ['a:yes:SELECT 1:444', 'b:no:SELECT 22:555', 'c:no:SELECT 333:666']),
      ],
    };
    const lines = run(body).join('\n');
    expect(lines).toContain('50.00pp ahead of it');
    expect(lines).toContain('this artifact resolves only 100.00pp');
  });

  it('spends no call on three of the five rules', () => {
    expect(CALL_FREE).toEqual(['first', 'shortest', 'modal']);
    expect(RULE_ORDER).toEqual(['first', 'shortest', 'modal', 'model', 'oracle']);
  });

  it('says so when no call-free rule can be scored at all', () => {
    const lines = run({ split: 'dev', cases: [one('select-mixed', 1, true, ['a:yes', 'b:no'])] });
    expect(lines.join('\n')).toContain('first is');
  });

  it('prints the holes it refuses to repair', () => {
    const lines = run({ split: 'dev', cases: [one('select-mixed', 1, true, ['a:no:SELECT 1:111', 'b:no:SELECT 2:222'])] });
    expect(lines.join('\n')).toContain('name no correct candidate in their record');
  });

  it('reports agreement it could not measure instead of a zero', () => {
    const lines = run({ split: 'dev', cases: [one('select-mixed', 1, true, ['a:yes', 'b:no'])] });
    expect(lines.join('\n')).toContain('agreement unmeasured on 1 question(s)');
  });

  it('counts the questions where agreement is undefined, so the arithmetic closes', () => {
    // A question with one candidate is neither unanimous nor divided. `41356370371`'s dev artifact
    // had 5 of them on `select-mixed`, and they were simply absent from the column: a reader
    // adding `unanimous`, `unmeasured` and the divided rows could not reach the case count.
    const cases = [
      one('select-mixed', 1, true, ['a:yes:SELECT 1:111']),
      one('select-mixed', 2, true, []),
      one('select-mixed', 3, true, ['a:yes:SELECT 1:111', 'b:yes:SELECT 22:111']),
      one('select-mixed', 4, true, ['a:yes', 'b:no']),
      one('select-mixed', 5, true, ['a:no:SELECT 1:111', 'b:yes:SELECT 22:222']),
    ];
    const arm = (readCorpus({ split: 'dev', cases }).reading[0] as NonNullable<ReturnType<typeof readCorpus>['reading'][number]>);
    expect(arm.cases).toBe(5);
    expect(arm.agreementSkipped).toBe(2);
    expect(arm.unmeasured).toBe(1);
    expect(arm.unanimous).toBe(1);
    expect(arm.unanimous + arm.unmeasured + arm.agreementSkipped).toBeLessThanOrEqual(arm.cases);
    const lines = run({ split: 'dev', cases }).join('\n');
    expect(lines).toContain('agreement not applicable on 2 question(s): fewer than two candidates');
  });

  it('prints the resolution its own pairing supports beside the stated margin', () => {
    // The margin is the caller's number and the resolution is the artifact's, and the report says
    // both: a criterion line that printed only the first made a 600-question sample look like it
    // had been judged at the 1,532-question threshold.
    const cases = [
      ...Array.from({ length: 160 }, (_, index) => one('select-mixed', index + 1, true, ['a:yes:SELECT 1:111', 'b:no:SELECT 22:222'])),
      ...Array.from({ length: 20 }, (_, index) => one('select-mixed', 161 + index, true, ['a:no:SELECT 1:444', 'b:no:SELECT 22:555'])),
      ...Array.from({ length: 20 }, (_, index) => one('select-mixed', 181 + index, false, ['a:no:SELECT 1:777', 'b:no:SELECT 22:888'])),
    ];
    const lines = run({ split: 'dev', cases }).join('\n');
    expect(lines).toContain("criterion: a call-free rule replaces the selector when it scores within 2.30pp of it (this artifact's own pairing on select-mixed resolves 6.26pp)");
  });

  it('limits itself to the arm it was asked for', () => {
    const body = {
      split: 'dev',
      cases: [
        one('select-mixed', 1, true, ['a:yes:SELECT 1:111', 'b:no:SELECT 2:222']),
        one('select-cross', 1, false, ['a:no:SELECT 1:111', 'b:no:SELECT 2:222']),
      ],
    };
    const lines = run(body, ['--arm', 'select-cross']);
    expect(lines.join('\n')).toContain('select-cross');
    expect(lines.find((line) => line.startsWith('  select-mixed'))).toBeUndefined();
  });

  it('refuses an arm the artifact does not have', () => {
    expect(() => run({ split: 'dev', cases: [one('select-mixed', 1, true, ['a:yes:SELECT 1:111', 'b:no:SELECT 2:222'])] }, ['--arm', 'select-cross'])).toThrow(
      /no candidate set for arm select-cross/,
    );
  });

  it('refuses an artifact that keeps no candidate set', () => {
    expect(() => run({ split: 'dev', cases: [one('names', 1, true)] })).toThrow(/keeps no candidate set/);
  });

  it('prints machine-readable output when asked', () => {
    const lines = run({ split: 'dev', cases: [one('select-mixed', 1, true, ['a:yes:SELECT 1:111', 'b:no:SELECT 2:222'])] }, ['--json']);
    const parsed = JSON.parse(lines[0] as string) as { cases: number; arms: { arm: string }[] };
    expect(parsed.cases).toBe(1);
    expect(parsed.arms[0]?.arm).toBe('select-mixed');
  });

  it('names the split and the model it read', () => {
    const lines = reportLines(readCorpus(artifact([one('select-mixed', 1, true, ['a:yes:SELECT 1:111', 'b:no:SELECT 2:222'])])), settings(), {
      split: 'dev',
      model: 'deepseek-chat',
    });
    expect(lines[0]).toBe('selection rules on 1 questions (dev, deepseek-chat)');
  });

  it('names an artifact that does not say which split it is', () => {
    const lines = reportLines(readCorpus(artifact([one('select-mixed', 1, true, ['a:yes:SELECT 1:111', 'b:no:SELECT 2:222'])])), settings(), {});
    expect(lines[0]).toContain('unknown');
  });

  it('says every arm kept a candidate set when none was excluded', () => {
    const lines = reportLines(readCorpus(artifact([one('select-mixed', 1, true, ['a:yes:SELECT 1:111', 'b:no:SELECT 2:222'])])), settings(), { split: 'dev' });
    expect(lines[1]).toBe('every arm in this artifact kept a candidate set');
  });
});

describe('arguments', () => {
  it('requires an artifact', () => {
    expect(() => resolveConsensusSettings([])).toThrow(/--artifact is required/);
  });

  it('refuses an argument it does not know, and names it', () => {
    expect(() => resolveConsensusSettings(['--artifact', 'x.json', '--strict'])).toThrow(/unrecognized argument --strict/);
  });

  it('names the unknown argument before complaining about a missing one', () => {
    // The defect `pool.ts` records: a positional path was ignored, and the error was about a flag
    // the caller had supplied. Naming the token ends it in one sentence.
    expect(() => resolveConsensusSettings(['x.json'])).toThrow(/unrecognized argument x\.json/);
  });

  it('defaults the margin to the dev split resolution', () => {
    expect(resolveConsensusSettings(['--artifact', 'x.json']).margin).toBe(DEFAULT_MARGIN_PP);
  });

  it('refuses a margin that is not a positive number', () => {
    expect(() => resolveConsensusSettings(['--artifact', 'x.json', '--margin', '0'])).toThrow(/positive number/);
    expect(() => resolveConsensusSettings(['--artifact', 'x.json', '--margin', 'wide'])).toThrow(/positive number/);
  });

  it('refuses an empty arm name', () => {
    expect(() => resolveConsensusSettings(['--artifact', 'x.json', '--arm', ''])).toThrow(/arm name/);
  });

  it('reads the flags it was given', () => {
    expect(resolveConsensusSettings(['--artifact', 'x.json', '--json', '--arm', 'select', '--margin', '3'])).toEqual({
      artifact: 'x.json',
      margin: 3,
      arm: 'select',
      json: true,
    });
  });
});

describe('the entry point', () => {
  const quiet = (): void => undefined;

  it('does nothing when another module is the entry point', () => {
    expect(dispatch(undefined, 'file:///self.js', [], process.cwd(), quiet)).toBeUndefined();
    expect(dispatch('/other.js', 'file:///self.js', [], process.cwd(), quiet)).toBeUndefined();
  });

  it('runs when it is the entry point', () => {
    const lines: string[] = [];
    const file = scratch({ split: 'dev', cases: [one('select-mixed', 1, true, ['a:yes:SELECT 1:111', 'b:no:SELECT 2:222'])] });
    const code = dispatch('/self.js', 'file:///self.js', ['--artifact', file], process.cwd(), (line) => lines.push(line), quiet);
    expect(code).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('turns a thrown error into a sentence and an exit code', () => {
    const errors: string[] = [];
    const code = dispatch('/self.js', 'file:///self.js', [], process.cwd(), quiet, (line) => errors.push(line));
    expect(code).toBe(1);
    expect(errors[0]).toMatch(/--artifact is required/);
  });

  it('prints a non-error thrown value as itself', () => {
    const errors: string[] = [];
    const code = dispatch(
      '/self.js',
      'file:///self.js',
      [],
      process.cwd(),
      quiet,
      (line) => errors.push(line),
      () => {
        throw 'a string';
      },
    );
    expect(code).toBe(1);
    expect(errors[0]).toBe('a string');
  });
});
