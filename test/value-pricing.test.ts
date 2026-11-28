import { describe, expect, it, vi } from 'vitest';
import { createHashEmbeddingProvider, type DatabaseProfile } from '@agentix-e/nl2charts-ai';
import type { ValueMatch } from '../eval/bird/values.js';
import {
  armCoversGold,
  buildPricedCase,
  fsReader,
  isEntryPoint,
  main,
  priceArms,
  renderPricing,
  runPricing,
  stdoutLogger,
  type PricedCase,
} from '../eval/bird/value-pricing.js';

/**
 * Test fixtures are hand-written in the exact shapes the four upstream instruments emit:
 * `goldKeys` (SQL -> canonical table.column), `ValueMatch` (lexical arm), `SemanticHit`
 * (semantic arm via an injected provider), and `mcnemarExact` (paired discordance).
 * The hash provider is a real deterministic algorithm, not a mock of the algorithm under test.
 */
const profile: DatabaseProfile = {
  db: 'card_games',
  columns: [
    { table: 'legalities', column: 'status', kind: 'categorical', values: ['Banned', 'Legal', 'Restricted'] },
    { table: 'cards', column: 'name', kind: 'categorical', values: ['Abundance', 'Ancestor Chosen'] },
  ],
};

const lex = (table: string, column: string, value: string): ValueMatch => ({ table, column, value });

/** One priced case: `covered` is the set of gold fields an arm retrieved. */
function priced(id: number, gold: string[], lexical: string[], semantic: string[]): PricedCase {
  return {
    question_id: id,
    question: `q${id}`,
    gold,
    lexical,
    semantic,
  };
}

describe('armCoversGold (TDD red until the module exists)', () => {
  it('is true only when an arm retrieved every gold field', () => {
    expect(armCoversGold(['legalities.status', 'cards.name'], ['legalities.status', 'cards.name'])).toBe(true);
  });

  it('is false when a gold field is missing', () => {
    expect(armCoversGold(['legalities.status', 'cards.name'], ['legalities.status'])).toBe(false);
  });

  it('treats extra non-gold fields as harmless — coverage, not precision', () => {
    expect(armCoversGold(['legalities.status'], ['legalities.status', 'cards.name'])).toBe(true);
  });

  it('a question with no gold fields is not counted as covered — it cannot discriminate', () => {
    expect(armCoversGold([], [])).toBe(false);
  });
});

describe('priceArms (paired, question-level McNemar)', () => {
  it('counts only discordant pairs: fused-only vs lexical-only full coverage', () => {
    // b=2 fused-only, c=1 lexical-only, a=1 both, d=1 neither.
    const report = priceArms([
      priced(1, ['g.a'], ['g.a'], ['g.a']), // both
      priced(2, ['g.a'], [], ['g.a']), // fused-only
      priced(3, ['g.a'], ['g.a'], []), // lexical-only
      priced(4, ['g.a'], [], ['g.a']), // fused-only
      priced(5, ['g.a'], [], []), // neither
    ]);
    expect(report.questions).toBe(5);
    expect(report.bothFull).toBe(1);
    expect(report.fusedOnly).toBe(2);
    expect(report.lexicalOnly).toBe(1);
    expect(report.neitherFull).toBe(1);
    expect(report.discordant).toBe(3);
  });

  it('a no-gold question is excluded from every bucket and from the denominator', () => {
    const report = priceArms([
      priced(1, [], [], []),
      priced(2, ['g.a'], ['g.a'], []),
    ]);
    expect(report.questions).toBe(1);
    expect(report.lexicalOnly).toBe(1);
  });

  it('McNemar exact p is computed on the discordant pair', () => {
    const balanced = priceArms([
      priced(1, ['g.a'], ['g.a'], []),
      priced(2, ['g.a'], [], ['g.a']),
    ]);
    // b=1 c=1 -> p=1 (a perfectly balanced discordance is the null).
    expect(balanced.mcnemarP).toBe(1);
    const skewed = priceArms([
      priced(1, ['g.a'], [], ['g.a']),
      priced(2, ['g.a'], [], ['g.a']),
      priced(3, ['g.a'], [], ['g.a']),
      priced(4, ['g.a'], ['g.a'], []),
    ]);
    // b=3 c=1 -> two-sided exact p = 2*P(X<=1 | n=4) = 2*(1+4)/16 = 0.625.
    expect(skewed.mcnemarP).toBeCloseTo(0.625, 6);
  });

  it('no discordant pairs gives p=1, not NaN', () => {
    const report = priceArms([priced(1, ['g.a'], ['g.a'], ['g.a'])]);
    expect(report.discordant).toBe(0);
    expect(report.mcnemarP).toBe(1);
  });

  it('reports field-level coverage for each arm as evidence, never as the price', () => {
    const report = priceArms([
      priced(1, ['g.a', 'g.b'], ['g.a'], ['g.a', 'g.b']),
    ]);
    expect(report.lexicalCoverage).toBeCloseTo(0.5, 6);
    expect(report.semanticCoverage).toBeCloseTo(1, 6);
    expect(report.confirmedGain).toBe(1);
  });

  it('an empty case set is a clean zero report', () => {
    const report = priceArms([]);
    expect(report.questions).toBe(0);
    expect(report.mcnemarP).toBe(1);
    expect(report.lexicalCoverage).toBe(0);
    expect(report.semanticCoverage).toBe(0);
    expect(report.confirmedGain).toBe(0);
  });
});

describe('buildPricedCase (async, real hash provider)', () => {
  it('extracts canonical gold from SQL and both arms from the injected provider', async () => {
    const sql = "SELECT status FROM legalities WHERE status = 'Banned'";
    const lexical: ValueMatch[] = [lex('legalities', 'status', 'Banned')];
    const result = await buildPricedCase(
      { question_id: 7, question: 'what is the banned status', db_id: 'card_games', SQL: sql },
      profile,
      lexical,
      createHashEmbeddingProvider(),
    );
    expect(result.question_id).toBe(7);
    expect(result.gold).toContain('legalities.status');
    expect(result.lexical).toContain('legalities.status');
    // The semantic arm contributes only canonical fields beyond the lexical arm. With a hash
    // provider the two may coincide (both tokenise "status"), in which case the arm is empty —
    // the contract is that whatever it returns is a canonical table.column outside `lexical`.
    for (const field of result.semantic) {
      expect(field).toContain('.');
      expect(result.lexical).not.toContain(field);
    }
  });

  it('propagates an aborted signal rather than returning a partial case', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(buildPricedCase(
      { question_id: 1, question: 'banned status', db_id: 'card_games', SQL: 'SELECT status FROM legalities' },
      profile,
      [lex('legalities', 'status', 'Banned')],
      createHashEmbeddingProvider(),
      { signal: controller.signal },
    )).rejects.toThrow();
  });
});

describe('runPricing (CLI seam, injected reader/logger)', () => {
  const dev = [
    {
      question_id: 1,
      question: 'banned status',
      db_id: 'card_games',
      SQL: "SELECT status FROM legalities WHERE status = 'Banned'",
    },
  ];

  it('runs end to end with in-memory reader/logger — no gitignored cache, CI-safe', async () => {
    const logs: string[] = [];
    const cache: Record<string, string> = {
      'dev.json': JSON.stringify(dev),
      'card_games.json': JSON.stringify(profile),
    };
    await runPricing(
      (path) => {
        const key = path.endsWith('dev.json') ? 'dev.json' : 'card_games.json';
        return cache[key] as string;
      },
      (text) => logs.push(text),
      createHashEmbeddingProvider(),
      10,
    );
    const report = JSON.parse(logs[0] as string) as { note: string; questions: number };
    expect(report.questions).toBe(1);
    expect(report.note).toContain('PRICING');
    expect(report.note).toContain('NOT an accuracy claim');
  });

  it('honours the limit', async () => {
    const logs: string[] = [];
    await runPricing(
      () => JSON.stringify(dev),
      (text) => logs.push(text),
      createHashEmbeddingProvider(),
      0,
    );
    expect((JSON.parse(logs[0] as string) as { questions: number }).questions).toBe(0);
  });
});

describe('renderPricing', () => {
  it('renders the note, the discordant pair and the McNemar p in a readable form', () => {
    const report = priceArms([
      priced(1, ['g.a'], [], ['g.a']),
      priced(2, ['g.a'], [], ['g.a']),
      priced(3, ['g.a'], ['g.a'], []),
    ]);
    const text = renderPricing(report);
    expect(text).toContain('PRICING');
    expect(text).toContain('discordant');
    expect(text).toContain('McNemar');
    expect(text).toContain('NOT an accuracy claim');
  });
});

describe('CLI seams (coverage of the I/O entry without the gitignored cache)', () => {
  it('isEntryPoint recognises only the CLI argv', () => {
    expect(isEntryPoint('/workspace/nl2charts/eval/bird/value-pricing.ts')).toBe(true);
    expect(isEntryPoint('some-other.ts')).toBe(false);
    expect(isEntryPoint(undefined)).toBe(false);
  });

  it('fsReader reads a real file relative to cwd', () => {
    // package.json is present in cwd; this exercises the real filesystem seam without the cache.
    expect(fsReader('package.json')).toContain('"name"');
  });

  it('stdoutLogger writes to the console', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      stdoutLogger('pricing-line');
      expect(spy).toHaveBeenCalledWith('pricing-line');
    } finally {
      spy.mockRestore();
    }
  });

  it('main runs end to end with injected reader/logger (hash provider, no key)', async () => {
    const logs: string[] = [];
    const profileFile = JSON.stringify(profile);
    const devFile = JSON.stringify([{
      question_id: 1, question: 'banned status', db_id: 'card_games',
      SQL: "SELECT status FROM legalities WHERE status = 'Banned'",
    }]);
    const reader = (path: string) => (path.endsWith('dev.json') ? devFile : profileFile);
    const collect = (text: string) => logs.push(text);
    const previous = process.env.VALUE_PRICING_LIMIT;
    try {
      delete process.env.VALUE_PRICING_LIMIT;
      await main(reader, collect); // exercises the ?? '60' default branch
      process.env.VALUE_PRICING_LIMIT = '2';
      await main(reader, collect); // exercises the explicit-limit branch
    } finally {
      if (previous === undefined) delete process.env.VALUE_PRICING_LIMIT;
      else process.env.VALUE_PRICING_LIMIT = previous;
    }
    expect(logs).toHaveLength(2);
    expect((JSON.parse(logs[0] as string) as { questions: number }).questions).toBe(1);
    expect((JSON.parse(logs[1] as string) as { questions: number }).questions).toBe(1);
  });
});
