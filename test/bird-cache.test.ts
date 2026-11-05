/**
 * The prefix measurement, on strings small enough to check by hand.
 *
 * Two things are being tested, and only one of them is arithmetic. The arithmetic is the longest
 * common prefix and the bill that follows from it. The other is the standing claim this harness
 * makes: that what it measures is the prompt the pipeline sends — one request per question, the
 * system turn plus the user turn, rendered by the same function the run calls. A test that only
 * exercised the prefix function would pass while the entry point priced a prompt nobody sends.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cacheBill,
  cacheLines,
  cacheMessages,
  cacheProblems,
  cacheRows,
  cacheTally,
  commonPrefixLength,
  isEntry,
  main,
  meteredCache,
  resolveCacheSettings,
  sharedPrefix,
} from '../eval/bird/cache.js';
import type { CacheRow, CacheTally } from '../eval/bird/cache.js';
import { writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = join(import.meta.dirname, '..');

describe('the longest prefix two messages share', () => {
  it('counts the characters before the first difference', () => {
    expect(commonPrefixLength('abcdef', 'abcxyz')).toBe(3);
    expect(commonPrefixLength('abc', 'abc')).toBe(3);
    expect(commonPrefixLength('abc', 'abd')).toBe(2);
    expect(commonPrefixLength('', 'abc')).toBe(0);
    expect(commonPrefixLength('abc', '')).toBe(0);
  });

  it('takes the prefix every message agrees on, not the first two', () => {
    expect(sharedPrefix([])).toBe('');
    expect(sharedPrefix(['abc'])).toBe('abc');
    expect(sharedPrefix(['abcdef', 'abcxyz', 'abq'])).toBe('ab');
    // A message that is a prefix of the others shortens the answer to itself: the third string
    // here is shorter than the pair above and settles it.
    expect(sharedPrefix(['abcdef', 'abc', 'abcdef'])).toBe('abc');
    expect(sharedPrefix(['a', 'b'])).toBe('');
  });
});

describe('the rows, one per database', () => {
  it('groups by database and averages the system turn over its questions', () => {
    const rows = cacheRows([
      { db: 'a', system: 'RULESCARD-q1', user: '-q1' },
      { db: 'a', system: 'RULESCARD-q2', user: '-q2' },
      { db: 'b', system: 'RULESx', user: '-q' },
    ]);
    // Widest first: the single-question database is 100% prefix, the two-question one is not.
    expect(rows).toEqual([
      { db: 'b', questions: 1, systemChars: 6, prefixChars: 6, share: 1 },
      { db: 'a', questions: 2, systemChars: 12, prefixChars: 11, share: Number((11 / 12).toFixed(4)) },
    ]);
  });

  it('sorts the widest prefix first, because that is the database worth caching', () => {
    const rows = cacheRows([
      { db: 'narrow', system: 'AAAAbbbb', user: '' },
      { db: 'wide', system: 'AAAAaaaa', user: '' },
    ]);
    expect(rows.map((row) => row.db)).toEqual(['narrow', 'wide']);
  });

  it('reports a zero share rather than dividing by an empty message', () => {
    expect(cacheRows([{ db: 'a', system: '', user: '' }])[0]?.share).toBe(0);
  });
});

describe('the tally', () => {
  it('measures the share against the whole request, not the system turn alone', () => {
    // The cache is keyed on the request. A message that is 90% stable but followed by a long
    // question is 50% cacheable, and a share taken over the system turn would say 90%.
    const messages = [
      { db: 'a', system: 'RULES-123456789', user: '?' },
      { db: 'a', system: 'RULES-123456780', user: '???' },
    ];
    const rows = cacheRows(messages);
    const tally = cacheTally(messages, rows);
    expect(tally.perDbChars).toBe(14);
    expect(tally.systemChars).toBe(15);
    expect(tally.userChars).toBe(2);
    // Fourteen characters of the fifteen-character card, over the seventeen the request sends.
    expect(tally.share).toBeCloseTo(28 / 34, 10);
  });

  it('separates the prefix every question shares from the one its database shares', () => {
    const messages = [
      { db: 'a', system: 'RULES-card-one', user: '?' },
      { db: 'b', system: 'RULES-other', user: '?' },
    ];
    const tally = cacheTally(messages, cacheRows(messages));
    expect(tally.globalChars).toBe(6);
    expect(tally.perDbChars).toBe(tally.systemChars);
  });

  it('says nothing about an empty split rather than dividing by zero', () => {
    expect(cacheTally([], [])).toEqual({ questions: 0, systemChars: 0, userChars: 0, globalChars: 0, perDbChars: 0, share: 0 });
  });

  it('charges no prefix to a message whose database it was given no row for', () => {
    // The two are built together by the entry point, so this is the defensive side: a caller that
    // passes rows from another measurement must not divide by a row that is not there.
    const tally = cacheTally([{ db: 'a', system: 'abc', user: 'q' }], []);
    expect(tally.perDbChars).toBe(0);
    expect(tally.share).toBe(0);
  });

  it('reports a zero share for a request that sends nothing', () => {
    expect(cacheTally([{ db: 'a', system: '', user: '' }], cacheRows([{ db: 'a', system: '', user: '' }])).share).toBe(0);
  });
});

describe('the bill', () => {
  it('charges list price when the endpoint reported no cache', () => {
    const bill = cacheBill({ promptTokens: 2000, generateTokens: 2000 }, 0.9);
    expect(bill.chargedTokens).toBe(2000);
    // 2000 * 0.9 at the cache rate plus the 200 that are not cacheable.
    expect(bill.ceilingTokens).toBe(380);
    expect(bill.savingShare).toBe(Number(((2000 - 380) / 2000).toFixed(4)));
    expect(bill.measuredShare).toBeUndefined();
  });

  it('charges the cache rate on what the endpoint said it served, and no more', () => {
    const bill = cacheBill({ promptTokens: 1000, generateTokens: 1000, cachedTokens: 400 }, 0.9);
    expect(bill.measuredShare).toBe(0.4);
    expect(bill.chargedTokens).toBe(640);
  });

  it('discounts only the call that carries the card', () => {
    // A selector call reads candidates and answers one digit: it has no prefix to cache, so a
    // ceiling that discounted it would be a discount on a prompt nobody sends. This is the
    // defect the first version had — it reported 83% where the truthful number is 64%.
    const split = cacheBill({ promptTokens: 2447, generateTokens: 2035 }, 0.853);
    expect(split.ceilingTokens).toBe(885);
    const whole = cacheBill({ promptTokens: 2447, generateTokens: 2447 }, 0.853);
    expect(whole.ceilingTokens).toBeLessThan(split.ceilingTokens);
  });

  it('assumes the whole prompt is generation when the artifact has no split', () => {
    expect(cacheBill({ promptTokens: 1000 }, 0.5).ceilingTokens).toBe(cacheBill({ promptTokens: 1000, generateTokens: 1000 }, 0.5).ceilingTokens);
    expect(cacheBill({ promptTokens: 1000 }, 0.5).generateTokens).toBeUndefined();
  });

  it('refuses to discount more tokens than were sent', () => {
    // An endpoint that over-reports is a meter problem, and the clamp is what keeps the bill from
    // going below the cache rate times the prompt while `cacheProblems` says why.
    const bill = cacheBill({ promptTokens: 100, cachedTokens: 500 }, 0.5);
    expect(bill.chargedTokens).toBe(10);
    expect(bill.cachedTokens).toBe(500);
  });

  it('reports no saving on a bill that is zero', () => {
    expect(cacheBill({ promptTokens: 0 }, 0.5).savingShare).toBe(0);
  });
});

describe('what would make the numbers wrong', () => {
  const tally: CacheTally = { questions: 10, systemChars: 100, userChars: 20, globalChars: 10, perDbChars: 80, share: 0.67 };

  it('fails a prefix longer than the message it prefixes', () => {
    const rows: CacheRow[] = [{ db: 'a', questions: 1, systemChars: 10, prefixChars: 11, share: 1.1 }];
    expect(cacheProblems(rows, tally, cacheBill({ promptTokens: 100 }, 0.5)).join(' ')).toContain('prefix longer than the message');
  });

  it('fails a discount on tokens that were never sent', () => {
    const rows: CacheRow[] = [{ db: 'a', questions: 1, systemChars: 10, prefixChars: 5, share: 0.5 }];
    const bill = cacheBill({ promptTokens: 100, cachedTokens: 200 }, 0.5);
    expect(cacheProblems(rows, tally, bill).join(' ')).toContain('tokens that were never sent');
  });

  it('fails a split with no bill at all, because a free prompt is not what happened', () => {
    const rows: CacheRow[] = [{ db: 'a', questions: 1, systemChars: 10, prefixChars: 5, share: 0.5 }];
    expect(cacheProblems(rows, tally, cacheBill({ promptTokens: 0 }, 0.5)).join(' ')).toContain('metered no prompt tokens');
  });

  it('passes a measurement that holds', () => {
    const rows: CacheRow[] = [{ db: 'a', questions: 1, systemChars: 10, prefixChars: 5, share: 0.5 }];
    expect(cacheProblems(rows, tally, cacheBill({ promptTokens: 100 }, 0.5))).toEqual([]);
  });
});

describe('the printed report', () => {
  const rows: CacheRow[] = [{ db: 'shop', questions: 7, systemChars: 100, prefixChars: 80, share: 0.8 }];
  const tally: CacheTally = { questions: 7, systemChars: 100, userChars: 25, globalChars: 10, perDbChars: 80, share: 0.64 };

  it('says the ceiling is not a measurement when the endpoint reported nothing', () => {
    const printed = cacheLines('minidev', 'names', rows, tally, cacheBill({ promptTokens: 400, generateTokens: 300 }, 0.64), []).join('\n');
    expect(printed).toContain('the discount above is a ceiling and not a measurement');
    expect(printed).toContain('none of it was billed at the cache rate');
    expect(printed).toContain('of which 64.0% are the same bytes');
  });

  it('names the gap between what the prefix is and what was billed when both were measured', () => {
    const printed = cacheLines('minidev', 'names', rows, tally, cacheBill({ promptTokens: 400, generateTokens: 300, cachedTokens: 40 }, 0.64), []).join('\n');
    expect(printed).toContain('40 of 400 prompt tokens cached (10.0%)');
    expect(printed).toContain('the difference is what the cache did not serve');
  });

  it('says there is nothing left to win when the endpoint already bills the prefix', () => {
    const printed = cacheLines('minidev', 'names', rows, tally, cacheBill({ promptTokens: 400, generateTokens: 300, cachedTokens: 250 }, 0.64), []).join('\n');
    expect(printed).toContain('nothing left in the order');
  });

  it('prints the failures under the table', () => {
    const printed = cacheLines('minidev', 'names', rows, tally, cacheBill({ promptTokens: 400 }, 0.64), ['CACHE: a problem']).join('\n');
    expect(printed).toContain('FAILED CACHE: a problem');
  });
});

describe('the arguments', () => {
  it('requires an artifact and an arm', () => {
    expect(() => resolveCacheSettings([], ROOT, {})).toThrow(/--artifact is required/);
    expect(() => resolveCacheSettings(['--artifact', 'a.json'], ROOT, {})).toThrow(/--arm is required/);
  });

  it('takes a rate between zero and one, and defaults to the vendor contract', () => {
    expect(resolveCacheSettings(['--artifact', 'a.json', '--arm', 'names'], ROOT, {}).rate).toBe(0.1);
    expect(resolveCacheSettings(['--artifact', 'a.json', '--arm', 'names', '--rate', '0.25'], ROOT, {}).rate).toBe(0.25);
    expect(() => resolveCacheSettings(['--artifact', 'a.json', '--arm', 'names', '--rate', '2'], ROOT, {})).toThrow(/between 0 and 1/);
    expect(() => resolveCacheSettings(['--artifact', 'a.json', '--arm', 'names', '--rate', 'free'], ROOT, {})).toThrow(/between 0 and 1/);
  });

  it('rejects an argument it does not take', () => {
    expect(() => resolveCacheSettings(['--artifact', 'a.json', '--arm', 'names', 'stray'], ROOT, {})).toThrow(/unrecognized argument stray/);
  });
});

describe('the prompts it measures', () => {
  it('refuses an arm that does not exist rather than measuring nothing', () => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'cache-arm-')));
    expect(() => cacheMessages('no-such-arm', {}, { split: 'minidev', questionsFile: join(data, 'mini_dev_sqlite.json'), tablesFile: join(data, 'dev_tables.json') } as never)).toThrow(
      /no arm called no-such-arm/,
    );
  });

  it('refuses an aggregate arm, which writes no prompt of its own', () => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'cache-agg-')));
    expect(() => cacheMessages('inline+retrieval', {}, { split: 'minidev', questionsFile: join(data, 'mini_dev_sqlite.json'), tablesFile: join(data, 'dev_tables.json') } as never)).toThrow(
      /is an aggregate, not a prompt/,
    );
  });

  it('renders one message per question for an arm that writes its own', () => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'cache-msg-')));
    const messages = cacheMessages('names', {}, { split: 'minidev', questionsFile: join(data, 'mini_dev_sqlite.json'), tablesFile: join(data, 'dev_tables.json') } as never);
    expect(messages).toHaveLength(7);
    expect(new Set(messages.map((message) => message.db))).toEqual(new Set(['shop']));
    expect(messages[0]?.system).toContain('items');
    expect(messages[0]?.user.length).toBeGreaterThan(0);
  });

  it('renders an arm that carries column notes, reading them once per database', () => {
    // The notes branch is a real one: `metadata+evidence` sends 798 curated notes, and an
    // instrument that rendered it without them would measure the parent's card under the child's
    // name — the defect `promptOf`'s own guards exist for.
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'cache-notes-')));
    const layout = { split: 'minidev', questionsFile: join(data, 'mini_dev_sqlite.json'), tablesFile: join(data, 'dev_tables.json'), descriptionsRoot: join(data, 'dev_databases') } as never;
    const messages = cacheMessages('metadata+evidence', {}, layout);
    expect(messages).toHaveLength(7);
    expect(messages[0]?.system.length).toBeGreaterThan(0);
  });

  it('refuses a question whose database the table file does not describe', () => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'cache-db-')));
    expect(() => cacheMessages('names', {}, { split: 'minidev', questionsFile: join(data, 'mini_dev_sqlite.json'), tablesFile: join(data, 'dev_tables.json'), } as never)).not.toThrow();
    // A table file that describes no database is the state this guard is for: the prompt would be
    // rendered against a schema nobody sent.
    writeFileSync(join(data, 'empty_tables.json'), JSON.stringify([]));
    expect(() =>
      cacheMessages('names', {}, { split: 'minidev', questionsFile: join(data, 'mini_dev_sqlite.json'), tablesFile: join(data, 'empty_tables.json') } as never),
    ).toThrow(/which the table file does not describe/);
  });
});

describe('where the cache figure comes from', () => {
  const artifact = {
    arms: [{ arm: 'a', tokens: { prompt: 676, byPurpose: { generate: { prompt: 676 } } } }],
    cases: [
      { arm: 'a', id: '1', tokens: { cached: 768 } },
      { arm: 'a', id: '2', tokens: { cached: 640 } },
      { arm: 'a', id: '3', tokens: {} },
      { arm: 'b', id: '4', tokens: { cached: 100 } },
    ],
  };

  it('prefers the summary row the run computed', () => {
    // Two sources for one number is the shape of every disagreement in this directory, so the
    // order is fixed rather than merged.
    const metered = meteredCache({ ...artifact, arms: [{ arm: 'a', tokens: { prompt: 676, cached: 484 } }] }, 'a');
    expect(metered.cachedTokens).toBe(484);
    expect(metered.from).toBe('summary');
  });

  it('carries the generation subtotal alongside the summary figure', () => {
    // The two columns arrive from the same run, so an artifact that reports both must yield
    // both: the bill discounts the generation calls only, and dropping the subtotal here would
    // silently fall back to discounting the whole prompt.
    const metered = meteredCache(
      { arms: [{ arm: 'a', tokens: { prompt: 676, cached: 484, byPurpose: { generate: { prompt: 500 }, select: { prompt: 176 } } } }] },
      'a',
    );
    expect(metered).toEqual({ promptTokens: 676, generateTokens: 500, cachedTokens: 484, from: 'summary' });
  });

  it('falls back to the per-case records an older artifact carries', () => {
    // Averaged over the cases that reported, not over every case: a case that said nothing has
    // not said it missed, and dividing by it would invent a discount nobody was billed.
    const metered = meteredCache(artifact, 'a');
    expect(metered.cachedTokens).toBe(704);
    expect(metered.from).toBe('cases');
    expect(metered.promptTokens).toBe(676);
    expect(metered.generateTokens).toBe(676);
  });

  it('carries no generation figure when the artifact has no purpose split', () => {
    // An artifact written before the meter split the bill: the cache figure is still readable and
    // the generation subtotal is not, which the bill then treats as the conservative whole prompt.
    const summary = meteredCache({ arms: [{ arm: 'a', tokens: { prompt: 676, cached: 400 } }] }, 'a');
    expect(summary.generateTokens).toBeUndefined();
    expect(summary.from).toBe('summary');
    const cases = meteredCache({ arms: [{ arm: 'a', tokens: { prompt: 676 } }], cases: [{ arm: 'a', id: '1', tokens: { cached: 300 } }] }, 'a');
    expect(cases.generateTokens).toBeUndefined();
    expect(cases.cachedTokens).toBe(300);
    expect(cases.from).toBe('cases');
  });

  it('reports a zero bill for an arm the artifact does not carry, and for one with no cases', () => {
    // Both are defensive sides: the entry point refuses a missing arm before it gets here, and the
    // reader still has to answer rather than invent a prompt.
    expect(meteredCache({ arms: [{ arm: 'a', tokens: { prompt: 10 } }] }, 'b')).toEqual({ promptTokens: 0, from: 'none' });
    expect(meteredCache({ arms: [{ arm: 'a', tokens: { prompt: 10, cached: 4 } }] }, 'a')).toEqual({ promptTokens: 10, cachedTokens: 4, from: 'summary' });
  });

  it('says nothing was measured when neither source carries a figure', () => {
    const metered = meteredCache({ arms: [{ arm: 'a', tokens: { prompt: 10 } }], cases: [{ arm: 'a', id: '1', tokens: {} }] }, 'a');
    expect(metered.cachedTokens).toBeUndefined();
    expect(metered.from).toBe('none');
  });

  it('reads an artifact with no arms table, and one whose split names no generation call', () => {
    // Both are shapes an older or a different writer can produce, and neither may throw: a
    // measurement that crashes on a missing summary column is a measurement nobody can run on
    // yesterday's artifact.
    expect(meteredCache({}, 'a')).toEqual({ promptTokens: 0, from: 'none' });
    const noGenerate = meteredCache({ arms: [{ arm: 'a', tokens: { prompt: 10, cached: 4, byPurpose: { select: { prompt: 3 } } } }] }, 'a');
    expect(noGenerate.generateTokens).toBeUndefined();
  });
});

describe('the entry point', () => {
  const run = (artifact: unknown): { code: number; printed: string } => {
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'cache-main-')));
    const dir = mkdtempSync(join(tmpdir(), 'cache-main-out-'));
    const file = join(dir, 'bird-eval.json');
    writeFileSync(file, JSON.stringify(artifact));
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    try {
      const code = main(['--artifact', file, '--arm', 'names'], ROOT, { BIRD_SPLIT: 'minidev', BIRD_DATA: data });
      return { code, printed: printed.join('\n') };
    } finally {
      log.mockRestore();
    }
  };

  it('prints the two levels and the ceiling for a real split', () => {
    const { code, printed } = run({ split: 'minidev', arms: [{ arm: 'names', tokens: { prompt: 900, byPurpose: { generate: { prompt: 700 }, select: { prompt: 200 } } } }] });
    expect(code).toBe(0);
    expect(printed).toContain('what the prompt repeats');
    // Seven questions about one database: every one of them sends the same card first.
    expect(printed).toMatch(/its own database:\s+\d+ of\s+\d+ chars/);
    expect(printed).toContain('the discount lands on the 700 tokens');
  });

  it('takes the definitions and the split block from the artifact when they are there', () => {
    const { code, printed } = run({
      split: 'minidev',
      controls: { synthesizedDefinitions: { shop: 'items(id, name, price); orders(id, item_id, qty)' } },
      arms: [{ arm: 'names', tokens: { prompt: 900 } }],
    });
    expect(code).toBe(0);
    // The definitions are rendered into the card, so the prefix is measured over the text the run
    // would actually send rather than over a card without them.
    expect(printed).toContain('what the prompt repeats');
  });

  it('takes the split from the environment when the artifact names none it knows', () => {
    const { code } = run({ split: 'train', arms: [{ arm: 'names', tokens: { prompt: 100 } }] });
    expect(code).toBe(0);
  });

  it('reads an artifact with no token column and one with no arms at all', () => {
    const { printed } = run({ split: 'minidev', arms: [{ arm: 'names' }] });
    expect(printed).toContain('metered no prompt tokens');
    // An artifact that names no arms at all: the split falls back to the environment and the arm
    // lookup says what is missing rather than reporting a prefix over nothing.
    expect(() => run({})).toThrow(/has no arm names/);
  });

  it('reads a run that reported a cache, and one that reported none', () => {
    const cached = run({ split: 'minidev', arms: [{ arm: 'names', tokens: { prompt: 900, cached: 400 } }] });
    expect(cached.printed).toContain('400 of 900 prompt tokens cached');
    const silent = run({ split: 'minidev', arms: [{ arm: 'names', tokens: { prompt: 900 } }] });
    expect(silent.printed).toContain('reported no cache field');
  });

  it('runs as a command and exits with what the measurement is worth', () => {
    // The guard is one line, and a guard only a command line can reach is a guard no test covers.
    // Running it the way the workflow runs it also holds the CLI contract: the artifact, the arm,
    // and an exit code a shell can branch on.
    const data = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'cache-cli-')));
    const dir = mkdtempSync(join(tmpdir(), 'cache-cli-out-'));
    const file = join(dir, 'bird-eval.json');
    writeFileSync(file, JSON.stringify({ split: 'minidev', arms: [{ arm: 'names', tokens: { prompt: 900, cached: 100 } }] }));
    const out = execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, 'eval/bird/cache.ts'), '--artifact', file, '--arm', 'names'], {
      env: { ...process.env, BIRD_SPLIT: 'minidev', BIRD_DATA: data },
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(out).toContain('what the prompt repeats');
    expect(out).toContain('100 of 900 prompt tokens cached');
  });

  it('is not the entry point when it was imported', () => {
    expect(isEntry(undefined, import.meta.url)).toBe(false);
    expect(isEntry(join(ROOT, 'eval/bird/cache.ts'), 'file:///nowhere')).toBe(false);
  });

  it('refuses an arm the artifact does not carry', () => {
    expect(() => run({ split: 'minidev', arms: [{ arm: 'other' }] })).toThrow(/has no arm names/);
  });

  it('exits non-zero when the measurement cannot be published', () => {
    const { code, printed } = run({ split: 'minidev', arms: [{ arm: 'names', tokens: { prompt: 100, cached: 900 } }] });
    expect(code).toBe(1);
    expect(printed).toContain('tokens that were never sent');
  });
});
