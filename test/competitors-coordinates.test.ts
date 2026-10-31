/**
 * The five coordinates, checked against the table in the documentation.
 *
 * The assertions here are mostly about *messages*, because a coordinate check that says "not
 * comparable" is a check a reader will work around. Each message has to name the coordinate, both
 * values and the cost, so that the fix is obvious from the log of a run nobody watched.
 */
import { describe, expect, it } from 'vitest';
import {
  COORDINATE_CHECKS,
  COMPETITOR_PROMPT,
  EXECUTOR,
  JUDGE,
  assertComparable,
  coordinateViolations,
  describeRun,
  endpointHost,
  isPinnedCommit,
  parseCoordinates,
  questionSetHash,
} from '../eval/competitors/coordinates.js';
import type { ReferenceCoordinates, RunCoordinates } from '../eval/competitors/coordinates.js';

const COMMIT = '3d6e835f858d26885d21d4bc0215aeecf855efbe';

const reference: ReferenceCoordinates = {
  arm: 'metadata+evidence',
  split: 'minidev',
  questionIds: [1, 2, 3, 4, 5],
  model: 'deepseek-chat',
  endpoint: 'https://api.deepseek.com',
};

const run = (over: Partial<RunCoordinates> = {}): RunCoordinates => ({
  competitor: 'chess',
  repo: 'ShayanTalaei/CHESS',
  commit: COMMIT,
  split: 'minidev',
  questionIds: [1, 2, 3, 4, 5],
  model: 'deepseek-chat',
  endpoint: 'https://api.deepseek.com/v1',
  prompt: COMPETITOR_PROMPT,
  executor: EXECUTOR,
  judge: JUDGE,
  ...over,
});

describe('the question set has a content, not only a count', () => {
  it('hashes the same set the same way whatever order it is given in', () => {
    expect(questionSetHash([3, 1, 2])).toBe(questionSetHash([1, 2, 3]));
    expect(questionSetHash([1, 1, 2])).toBe(questionSetHash([1, 2]));
  });

  it('separates two sets with the same size and different content', () => {
    expect(questionSetHash([1, 2, 3])).not.toBe(questionSetHash([1, 2, 4]));
  });

  it('reports a size-and-hash pair, because the size alone has no content', () => {
    const [violation] = coordinateViolations(run({ questionIds: [1, 2, 6] }), reference);
    expect(violation).toContain('question set: 3 questions (hash');
    expect(violation).toContain('against 5 questions');
    expect(violation).toContain('a sample that is easier for one pipeline');
  });
});

describe('a pin is a sha, and a branch is not', () => {
  it('accepts forty lowercase hex characters and nothing else', () => {
    expect(isPinnedCommit(COMMIT)).toBe(true);
    expect(isPinnedCommit('main')).toBe(false);
    expect(isPinnedCommit(COMMIT.slice(0, 12))).toBe(false);
    expect(isPinnedCommit(COMMIT.toUpperCase())).toBe(false);
  });

  it('refuses a checkout that is not the pin, naming the consequence', () => {
    const [violation] = coordinateViolations(run({ commit: 'main' }), reference);
    expect(violation).toBe(
      'commit: chess: commit "main" is not a 40-character sha — a competitor that moves under a number makes the number unreproducible',
    );
  });
});

describe('the model coordinate holds the host as well as the name', () => {
  it('reads the host out of an endpoint with a path, and is insensitive to the scheme', () => {
    expect(endpointHost('https://api.deepseek.com/v1')).toBe('api.deepseek.com');
    expect(endpointHost('api.deepseek.com')).toBe('api.deepseek.com');
    expect(endpointHost('HTTP://API.DeepSeek.COM:443/v1/')).toBe('api.deepseek.com:443');
  });

  it('treats a different host on the same model name as a different coordinate', () => {
    const [violation] = coordinateViolations(run({ endpoint: 'https://api.openai.com/v1' }), reference);
    expect(violation).toContain('endpoint api.openai.com against api.deepseek.com');
    expect(violation).toContain('a stronger backbone, or a different host, read as a better method');
  });

  it('names both halves when both halves moved', () => {
    const [violation] = coordinateViolations(
      run({ model: 'gpt-4o', endpoint: 'https://api.openai.com/v1' }),
      reference,
    );
    expect(violation).toContain('model "gpt-4o" against "deepseek-chat", and endpoint api.openai.com');
  });

  it('passes when only the path of the same host differs', () => {
    expect(coordinateViolations(run({ endpoint: 'https://api.deepseek.com' }), reference)).toEqual([]);
  });
});

describe('a comparable run has no violations, and every other run has its own', () => {
  it('holds all five coordinates for a run that pinned its code and used their prompt', () => {
    expect(coordinateViolations(run(), reference)).toEqual([]);
    expect(assertComparable(run(), reference).competitor).toBe('chess');
  });

  it('refuses a split that is not the reference split, before it looks at the questions', () => {
    const [violation] = coordinateViolations(run({ split: 'dev' }), reference);
    expect(violation).toBe(
      'question set: split "dev" against "minidev" — a sample that is easier for one pipeline',
    );
  });

  it('refuses our own prompt wearing a competitor name', () => {
    const [violation] = coordinateViolations(run({ prompt: 'ours:select' }), reference);
    expect(violation).toContain('prompt "ours:select"');
    expect(violation).toContain("a competitor's number has to come from the competitor's templates");
  });

  it('refuses a second executor and a second judge', () => {
    expect(coordinateViolations(run({ executor: 'their-executor' }), reference)).toEqual([
      'executor: executor "their-executor" against "eval/bird/oracle.py" — dialect differences read as errors',
    ]);
    expect(coordinateViolations(run({ judge: 'exact-string-match' }), reference)).toEqual([
      'judge: judge "exact-string-match" against "judgeOfficial" — two judges, two scores, one table',
    ]);
  });

  it('reports every violation rather than the first, so one push can fix them all', () => {
    const violations = coordinateViolations(
      run({ commit: 'main', split: 'dev', model: 'gpt-4o', prompt: 'ours:select', judge: 'strict' }),
      reference,
    );
    expect(violations).toHaveLength(5);
    expect(assertComparable.length).toBe(2);
    expect(() => assertComparable(run({ judge: 'strict' }), reference)).toThrow(/not comparable against arm metadata\+evidence/);
  });

  it('has one check per coordinate, in the order the documentation lists them', () => {
    expect(COORDINATE_CHECKS.map((check) => check.coordinate)).toEqual([
      'commit',
      'question set',
      'model',
      'prompt',
      'executor',
      'judge',
    ]);
  });
});

describe('reading a coordinates file', () => {
  const body = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      competitor: 'chess',
      repo: 'ShayanTalaei/CHESS',
      commit: COMMIT,
      split: 'minidev',
      questionIds: [1, 2],
      model: 'deepseek-chat',
      endpoint: 'https://api.deepseek.com',
      prompt: COMPETITOR_PROMPT,
      executor: EXECUTOR,
      judge: JUDGE,
      ...over,
    });

  it('reads a written file into the record the checks take', () => {
    expect(parseCoordinates(body(), 'c.json').questionIds).toEqual([1, 2]);
  });

  it('refuses a file that is not an object', () => {
    expect(() => parseCoordinates('[1,2]', 'c.json')).toThrow(/c.json is not a coordinates object/);
    expect(() => parseCoordinates('null', 'c.json')).toThrow(/not a coordinates object/);
  });

  it('refuses a missing coordinate instead of defaulting it', () => {
    expect(() => parseCoordinates(body({ model: undefined }), 'c.json')).toThrow(/missing the model coordinate/);
    expect(() => parseCoordinates(body({ competitor: '' }), 'c.json')).toThrow(/missing the competitor coordinate/);
  });

  it('refuses a run that declares no question set, because it measured nothing', () => {
    expect(() => parseCoordinates(body({ questionIds: [] }), 'c.json')).toThrow(/measured nothing/);
    expect(() => parseCoordinates(body({ questionIds: 'all' }), 'c.json')).toThrow(/measured nothing/);
  });

  it('describes a run in four lines that carry every coordinate a reader needs', () => {
    const lines = describeRun(run());
    expect(lines[0]).toBe('chess @ 3d6e835f858d (ShayanTalaei/CHESS)');
    expect(lines[1]).toContain('question set: minidev, 5 questions (hash');
    expect(lines[2]).toBe('  model: deepseek-chat at api.deepseek.com');
    expect(lines[3]).toBe('  prompt: competitor, executor: eval/bird/oracle.py, judge: judgeOfficial');
  });
});
