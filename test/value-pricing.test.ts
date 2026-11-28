import { describe, expect, it, vi } from 'vitest';
import { createHashEmbeddingProvider, type DatabaseProfile } from '@agentix-e/nl2charts-ai';
import { buildValueIndex, findValues, type ValueMatch } from '../eval/bird/values.js';
import {
  armCoversGold,
  buildPricedCase,
  fsReader,
  isEntryPoint,
  main,
  priceArms,
  providerFromEnv,
  renderPricing,
  runPricing,
  shippedLexicalArm,
  stdoutLogger,
  enforceCostCeiling,
  projectedPricingYuan,
  PRICING_PER_CASE_TOKENS,
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

describe('shippedLexicalArm (TDD red: baseline must equal the product arm)', () => {
  // The school profile mirrors the real dev fixture that exposed the straw-man baseline:
  // a question names the value "active" but never the column "StatusType".
  const schoolProfile: DatabaseProfile = {
    db: 'california_schools',
    columns: [
      { table: 'schools', column: 'StatusType', kind: 'categorical', values: ['Active', 'Merged', 'Closed'] },
      { table: 'schools', column: 'District', kind: 'categorical', values: ['Alameda', 'Hickman'] },
    ],
  };

  it('finds a value the old handwritten arm missed (question names a value, not a column)', () => {
    const question = 'Which active district has the highest score in Reading?';
    const arm = shippedLexicalArm(schoolProfile, question);
    expect(arm).toContainEqual(lex('schools', 'StatusType', 'Active'));
  });

  it('is exactly the product findValues over buildValueIndex — no parallel implementation', () => {
    const question = 'Give me the merged schools in Alameda';
    expect(shippedLexicalArm(schoolProfile, question)).toEqual(
      findValues(buildValueIndex(schoolProfile), question),
    );
  });

  it('honours ambiguity and stopword guards because it delegates, not reimplements', () => {
    // "the" is a stopword and must not be treated as a value; a token matching two columns is dropped.
    const ambiguous: DatabaseProfile = {
      db: 'x',
      columns: [
        { table: 'a', column: 'v', kind: 'categorical', values: ['Merged'] },
        { table: 'b', column: 'v', kind: 'categorical', values: ['Merged'] },
      ],
    };
    expect(shippedLexicalArm(ambiguous, 'the merged')).toEqual([]);
  });
});

describe('runPricing uses the product arm (TDD red: the price must not use a straw man)', () => {
  it('lexicalCoverage reflects values the shipped arm grounds, not the handwritten subset', async () => {
    const logs: string[] = [];
    const schoolProfile: DatabaseProfile = {
      db: 'california_schools',
      columns: [
        { table: 'schools', column: 'StatusType', kind: 'categorical', values: ['Active'] },
      ],
    };
    const dev = [{
      question_id: 15,
      question: 'Which active school has the highest score?',
      db_id: 'california_schools',
      // gold names schools.StatusType; the question never says "StatusType".
      SQL: "SELECT name FROM schools WHERE StatusType = 'Active'",
    }];
    await runPricing(
      (path) => (path.endsWith('dev.json') ? JSON.stringify(dev) : JSON.stringify(schoolProfile)),
      (text) => logs.push(text),
      createHashEmbeddingProvider(),
      10,
    );
    const report = JSON.parse(logs[0] as string) as { lexicalCoverage: number; gold: never };
    // The product arm resolves "active" -> schools.StatusType, so lexicalCoverage must be > 0.
    // The old handwritten arm required "StatusType" in the question and returned 0 here.
    expect(report.lexicalCoverage).toBeGreaterThan(0);
  });
});

describe('providerFromEnv (TDD red: the hosted dispatch seam)', () => {
  it('returns the deterministic hash provider when no hosted config is present', () => {
    const provider = providerFromEnv({});
    expect(provider.id).toBe('hash-local');
    expect(provider.model).toBe('fnv1a-bag-of-words');
  });

  it('builds an http provider from explicit hosted config (no key is sent by this call)', () => {
    const provider = providerFromEnv({
      PRICING_EMBEDDING_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
      PRICING_EMBEDDING_MODEL: 'embedding-3',
      PRICING_EMBEDDING_API_KEY: 'not-a-real-key',
    });
    expect(provider.id).toBe('http:https://open.bigmodel.cn/api/paas/v4');
    expect(provider.model).toBe('embedding-3');
  });

  it('refuses a hosted config missing the base URL or model rather than silently using hash', () => {
    expect(() => providerFromEnv({ PRICING_EMBEDDING_API_KEY: 'k' })).toThrow(/PRICING_EMBEDDING/);
    expect(() => providerFromEnv({ PRICING_EMBEDDING_BASE_URL: 'https://x' })).toThrow(/PRICING_EMBEDDING/);
  });
});

describe('cost ceiling (refuse an over-budget dispatch before spending a token)', () => {
  it('projects a conservative yuan bound from the per-case token ceiling and the priced model', () => {
    // Embeddings have no output tokens; the bound is input only. 60 questions at the per-case
    // ceiling, priced at embedding-3's ¥0.5/million, must be a small deterministic number.
    const projected = projectedPricingYuan(60, 'embedding-3');
    expect(projected).toBe((60 * PRICING_PER_CASE_TOKENS * 0.5) / 1_000_000);
    expect(projected).toBeGreaterThan(0);
    expect(projectedPricingYuan(60, 'a-model-nobody-priced')).toBeUndefined();
  });

  it('refuses a hosted run whose projection exceeds the authorised ceiling', () => {
    expect(() => enforceCostCeiling('embedding-3', 60, 0.0001)).toThrow(/cost|budget|ceiling/i);
  });

  it('allows a hosted run within the ceiling and skips an unpriced model loudly', () => {
    expect(() => enforceCostCeiling('embedding-3', 60, 100)).not.toThrow();
    // An unpriced model cannot be approved silently: printing "no price on file" after the bill is
    // the exact failure the price table exists to prevent.
    expect(() => enforceCostCeiling('a-model-nobody-priced', 60, 100)).toThrow(/price/i);
  });

  it('treats a local hash provider as zero-cost, so no ceiling is required', () => {
    // `hash:` ids have no row in the price table; the CLI must not block a harness proof on cost.
    expect(() => enforceCostCeiling('hash:local', 60, undefined)).not.toThrow();
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

  it('main refuses a non-positive or non-numeric cost ceiling before building any case', async () => {
    const reader = (path: string) => (path.endsWith('dev.json') ? '[]' : '{}');
    const previous = process.env.VALUE_PRICING_ACCEPT_COST;
    try {
      for (const bad of ['-1', 'abc', '0']) {
        process.env.VALUE_PRICING_ACCEPT_COST = bad;
        await expect(main(reader, () => {})).rejects.toThrow(/VALUE_PRICING_ACCEPT_COST/);
      }
    } finally {
      if (previous === undefined) delete process.env.VALUE_PRICING_ACCEPT_COST;
      else process.env.VALUE_PRICING_ACCEPT_COST = previous;
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
      process.env.VALUE_PRICING_ACCEPT_COST = '';
      await main(reader, collect); // exercises the empty-ceiling branch
    } finally {
      if (previous === undefined) delete process.env.VALUE_PRICING_LIMIT;
      else process.env.VALUE_PRICING_LIMIT = previous;
      delete process.env.VALUE_PRICING_ACCEPT_COST;
    }
    expect(logs).toHaveLength(3);
    for (const line of logs) expect((JSON.parse(line) as { questions: number }).questions).toBe(1);
  });
});
