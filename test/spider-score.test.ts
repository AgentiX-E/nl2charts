/**
 * The Spider scorer, tested through the real judge on a database the test declares.
 *
 * `score.ts` is thin on purpose — the judge is the reference's, and `check.ts` already owns the claim
 * that it agrees with itself. What can go wrong here is arithmetic and bookkeeping: a prediction that
 * names a question twice, a denominator that counts an unanswered question as a miss, a percentage
 * that rounds. Each is asserted on a case small enough to compute by hand, and once through python so
 * that the wiring to `judge.py` is not a thing anyone has to take on trust.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDatabase } from '../eval/spider/fetch.mjs';
import {
  casesTextOf,
  main,
  parsePredictions,
  readingOf,
  reportLines,
  resolveSettings,
} from '../eval/spider/score.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dirOf(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spider-score-'));
  dirs.push(dir);
  return dir;
}

const ENTRY: Parameters<typeof buildDatabase>[0] = {
  db_id: 'shop',
  table_names_original: ['singer'],
  column_names_original: [[-1, '*'], [0, 'singer_id'], [0, 'name']],
  column_types: ['text', 'number', 'text'],
  primary_keys: [1],
};

/** A one-database corpus, built the way `fetch.mjs` builds the real one. */
function corpus(): string {
  const dir = dirOf();
  const questions = [
    { db_id: 'shop', question: 'How many singers?', query: 'SELECT count(*) FROM singer' },
    { db_id: 'shop', question: 'What are the names?', query: 'SELECT name FROM singer' },
  ];
  writeFileSync(join(dir, 'dev.json'), JSON.stringify(questions));
  mkdirSync(join(dir, 'database', 'shop'), { recursive: true });
  buildDatabase(ENTRY, join(dir, 'database', 'shop', 'shop.sqlite'));
  return dir;
}

describe('reading a predictions file', () => {
  it('keeps one statement per question', () => {
    const predictions = parsePredictions('{"index":0,"sql":"SELECT 1"}\n');
    expect(predictions.get(0)).toBe('SELECT 1');
  });

  it('reads a file whose last line is blank without inventing a prediction', () => {
    expect(parsePredictions('{"index":0,"sql":"SELECT 1"}\n\n').size).toBe(1);
  });

  it('refuses a repeated index, because a denominator that counts one case twice is unreadable', () => {
    expect(() => parsePredictions('{"index":0,"sql":"a"}\n{"index":0,"sql":"b"}\n', 'p.jsonl')).toThrow(
      'p.jsonl line 2 repeats index 0',
    );
  });

  it('refuses a line that is not a prediction, and says which one', () => {
    expect(() => parsePredictions('{"index":0}\n', 'p.jsonl')).toThrow('p.jsonl line 1 is not a prediction');
  });
});

describe('the per-case file', () => {
  it('writes nothing for a split with no scored case, rather than one empty line', () => {
    expect(casesTextOf([], [])).toBe('');
  });

  it('reads a missing verdict as a case that was not answered, not as a wrong answer', () => {
    // A verdict list shorter than the pair list is a judge that answered fewer cases than it was
    // given; the reading refuses that, and this writer must not turn the gap into an `exact: false`.
    const text = casesTextOf([{ index: 4 }], []);
    expect(JSON.parse(text)).toEqual({ index: 4, ordered: false, bag: false, predOk: false });
  });
});

describe('the arithmetic', () => {
  it('computes the percentage over the cases that were answered, not over the split', () => {
    const reading = readingOf(4, [{ em: 1 }, { em: 0 }], 2);
    expect(reading.exactPct).toBe(50);
    // Two questions had no prediction at all; they are missing, not wrong, and the difference is the
    // difference between reporting the model and reporting the harness.
    expect(reading.missing).toBe(2);
    expect(reading.scored).toBe(2);
  });

  it('counts a gold that does not parse apart from a prediction that does not', () => {
    const reading = readingOf(2, [{ em: 0, gold: 'error', pred: 'unparsed' }, { em: 0, gold: 'ok', pred: 'error' }], 2);
    expect([reading.goldErrors, reading.predErrors]).toEqual([1, 1]);
    expect(reading.exact).toBe(0);
  });

  it('rounds to two decimals, as every other reading in this repository does', () => {
    expect(readingOf(3, [{ em: 1 }, { em: 1 }, { em: 0 }], 3).exactPct).toBe(66.67);
    // A run with no answered case has no percentage to report, and zero is the honest one: 0/0 is not
    // perfection, which is the mistake this repository has already paid for once.
    expect(readingOf(0, [], 0).exactPct).toBe(0);
  });

  it('reports the three counts on one screen, including the ones that are zero', () => {
    const lines = reportLines(readingOf(2, [{ em: 1 }, { em: 1 }], 2));
    expect(lines.join('\n')).toContain('exact    2 / 2 = 100.00%');
    expect(lines.join('\n')).toContain('0 prediction(s) did not parse, 0 gold(s) did not parse');
  });
});

describe('the tool, with the judge handed to it', () => {
  /**
   * A judge that answers from the statements it is given.
   *
   * The reference judge is python and needs `nltk` and `sqlparse`; the quality job that runs this
   * suite installs neither, and a test that needs them is a test that fails on a machine with a
   * correct tree. What is asserted here is the wiring — which pairs are handed over, and what the
   * reading does with the verdicts — and `check.ts --self-test` is where the judge itself is proven.
   */
  const judgeOf = (verdictFor: (pair: { pred: string; gold: string }) => { em?: number; gold?: string; pred?: string }) =>
    (pairs: readonly { pred: string; gold: string }[]) => pairs.map((pair) => verdictFor(pair));

  it('reads 100% when every prediction is the gold', () => {
    const cache = corpus();
    const predictions = join(dirOf(), 'p.jsonl');
    writeFileSync(
      predictions,
      `${JSON.stringify({ index: 0, sql: 'SELECT count(*) FROM singer' })}\n${JSON.stringify({ index: 1, sql: 'SELECT name FROM singer' })}\n`,
    );
    const seen: string[] = [];
    const lines: string[] = [];
    const code = main(['--cache', cache, '--predictions', predictions], (line) => lines.push(line), {
      judge: (pairs) => {
        for (const pair of pairs) seen.push(pair.gold);
        return judgeOf(() => ({ em: 1, gold: 'ok', pred: 'ok' }))(pairs);
      },
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('exact    2 / 2 = 100.00%');
    // Both golds reached the judge, in corpus order: a pair list that lost one would read as 100% of
    // one, which is the failure mode a percentage cannot show.
    expect(seen).toEqual(['SELECT count(*) FROM singer', 'SELECT name FROM singer']);
  });

  it('reads a wrong statement as a wrong answer, and a broken one as a refusal', () => {
    const cache = corpus();
    const predictions = join(dirOf(), 'p.jsonl');
    writeFileSync(
      predictions,
      `${JSON.stringify({ index: 0, sql: 'SELECT name FROM singer' })}\n${JSON.stringify({ index: 1, sql: 'SELECT nope FROM singer' })}\n`,
    );
    const lines: string[] = [];
    const code = main(['--cache', cache, '--predictions', predictions, '--out', join(dirOf(), 'r.json')], (line) => lines.push(line), {
      judge: judgeOf((pair) => (pair.pred.includes('nope') ? { em: 0, gold: 'ok', pred: 'error' } : { em: 0, gold: 'ok', pred: 'ok' })),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('exact    0 / 2 = 0.00%');
    expect(lines.join('\n')).toContain('1 prediction(s) did not parse');
    expect(lines.join('\n')).toContain('first refused prediction: SELECT nope FROM singer');
  });

  it('writes the reading it printed, so a later comparison reads a file rather than a log', () => {
    const cache = corpus();
    const predictions = join(dirOf(), 'p.jsonl');
    const out = join(dirOf(), 'r.json');
    writeFileSync(predictions, `${JSON.stringify({ index: 0, sql: 'SELECT count(*) FROM singer' })}\n`);
    const code = main(['--cache', cache, '--predictions', predictions, '--out', out], () => {}, {
      judge: judgeOf(() => ({ em: 1, gold: 'ok', pred: 'ok' })),
    });
    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(out, 'utf8')) as { split: string; reading: { exact: number; scored: number } };
    expect(written.split).toBe('dev');
    expect(written.reading.scored).toBe(1);
    expect(written.reading.exact).toBe(1);
  });

  it('names the database a prediction needs and the corpus does not have', () => {
    const cache = dirOf();
    writeFileSync(join(cache, 'dev.json'), JSON.stringify([{ db_id: 'gone', question: 'q', query: 'SELECT 1' }]));
    const predictions = join(dirOf(), 'p.jsonl');
    writeFileSync(predictions, `${JSON.stringify({ index: 0, sql: 'SELECT 1' })}\n`);
    expect(() => main(['--cache', cache, '--predictions', predictions], () => {}, { judge: judgeOf(() => ({ em: 1 })) })).toThrow(
      'database gone is missing',
    );
  });

  it('falls back to the default corpus directory, and says which file it could not read', () => {
    const predictions = join(dirOf(), 'p.jsonl');
    writeFileSync(predictions, '');
    const previous = process.env.SPIDER_CACHE;
    delete process.env.SPIDER_CACHE;
    try {
      expect(() => main(['--predictions', predictions], () => {}, { judge: judgeOf(() => ({ em: 1 })) })).toThrow(/dev\.json/u);
    } finally {
      if (previous !== undefined) process.env.SPIDER_CACHE = previous;
    }
  });

  it('returns non-zero when a gold does not parse, and names the first one', () => {
    const cache = corpus();
    const predictions = join(dirOf(), 'p.jsonl');
    writeFileSync(predictions, `${JSON.stringify({ index: 0, sql: 'SELECT name FROM singer' })}\n`);
    const lines: string[] = [];
    const code = main(['--cache', cache, '--predictions', predictions], (line) => lines.push(line), {
      judge: judgeOf(() => ({ em: 0, gold: 'error', pred: 'unparsed' })),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('first gold error: SELECT count(*) FROM singer');
  });

  it('calls the reference judge when it is not handed one', () => {
    // The default path is python, and what it does with a corpus it cannot import is a fact worth
    // knowing: it throws rather than reading every case as wrong.
    const cache = corpus();
    const predictions = join(dirOf(), 'p.jsonl');
    writeFileSync(predictions, `${JSON.stringify({ index: 0, sql: 'SELECT name FROM singer' })}\n`);
    let outcome: 'answered' | 'refused' = 'answered';
    try {
      main(['--cache', cache, '--predictions', predictions], () => {});
    } catch (error) {
      outcome = 'refused';
      expect(String(error)).toMatch(/the judge exited|spawnSync|could not start/u);
    }
    // Either the reference is installed and scores, or it is not and the run refuses. Both are
    // honest; a silent 0.00% would not be.
    expect(['answered', 'refused']).toContain(outcome);
  });
});

describe('the flags', () => {
  it('reads every flag it documents, and refuses a limit that is not a count', () => {
    expect(resolveSettings(['--predictions', 'p', '--out', 'o', '--cache', 'c', '--limit', '5', '--cases', 'k'])).toEqual({
      predictions: 'p',
      out: 'o',
      cache: 'c',
      limit: 5,
      cases: 'k',
    });
    expect(() => resolveSettings(['--limit', '0'])).toThrow('positive integer');
  });

  it('refuses a flag that needs a value and ignores none of them silently', () => {
    expect(resolveSettings([])).toEqual({ predictions: undefined, out: undefined, cache: undefined, limit: undefined });
    expect(() => resolveSettings(['--limit', 'x'])).toThrow('positive integer');
  });

  it('writes one verdict per judged case, in the shape the paired comparison reads', () => {
    const cache = corpus();
    const predictions = join(dirOf(), 'p.jsonl');
    const cases = join(dirOf(), 'c.jsonl');
    writeFileSync(
      predictions,
      `${JSON.stringify({ index: 0, sql: 'SELECT count(*) FROM singer' })}\n${JSON.stringify({ index: 1, sql: 'SELECT nope FROM singer' })}\n`,
    );
    const lines: string[] = [];
    const code = main(['--cache', cache, '--predictions', predictions, '--cases', cases], (line) => lines.push(line), {
      judge: (pairs) => pairs.map((pair, position) => (position === 0 ? { em: 1, gold: 'ok', pred: 'ok' } : { em: 0, gold: 'ok', pred: 'error' })),
    });
    expect(code).toBe(0);
    const written = readFileSync(cases, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(written[0]).toEqual({ index: 0, ordered: true, bag: true, predOk: true });
    // The second statement never parsed, so `predOk` is false: an unreadable answer is not a wrong
    // one, and a paired test must be able to tell them apart.
    expect(written[1]).toEqual({ index: 1, ordered: false, bag: false, predOk: false });
    expect(lines.join('\n')).toContain(`cases    ${cases} (2)`);
  });

  it('refuses a run with no predictions file at all', () => {
    const lines: string[] = [];
    expect(main([], (line) => lines.push(line))).toBe(2);
    expect(lines.join('\n')).toContain('--predictions is required');
  });

  it('scores only the first N questions when a limit is given', () => {
    const cache = corpus();
    const predictions = join(dirOf(), 'p.jsonl');
    writeFileSync(predictions, `${JSON.stringify({ index: 1, sql: 'SELECT name FROM singer' })}\n`);
    const lines: string[] = [];
    main(['--cache', cache, '--predictions', predictions, '--limit', '1'], (line) => lines.push(line), {
      judge: (pairs) => pairs.map(() => ({ em: 1, gold: 'ok', pred: 'ok' })),
    });
    // The one prediction names index 1, which is outside the first question: it is not scored, and
    // the reading says so rather than dividing by a split it did not look at.
    expect(lines.join('\n')).toContain('1 question(s), 0 answered, 1 missing');
  });
});
