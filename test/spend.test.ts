/**
 * The spend gate, held to the run it was written after.
 *
 * `45090651019` cost ¥110.08 (¥124 on the provider's page, the difference being the retries an
 * artifact never records) and returned 975/1,532, which is 2.09 points *below* the same arm on a
 * model that costs 1/45th as much. Four things were wrong, and each is a test here:
 *
 * 1. **A model with no price on file can be dispatched.** `bench:bill` printed "no price on file
 *    for deepseek-v4-pro" on a reading that had already been billed, so the one command this
 *    repository uses to answer "what did that cost" could not answer it. The gate refuses an
 *    unpriced model outright: a route with no arithmetic is not a cheap route.
 * 2. **Thinking mode is a default, not a decision.** 94.0% of that run's completion tokens were
 *    reasoning, and the same mode had already been rejected by `ship.ts` at 5+ points of tariff.
 *    The gate refuses a thinking model unless the caller states the gain it expects, and the
 *    statement is checked against `DEFAULT_SHIPMENT_POLICY.tokenTariff`.
 * 3. **Money was projected from a price, not from a measurement.** The estimate was ¥35-55 and the
 *    bill was three times that. The gate will not project a run of more than `PROBE_LIMIT`
 *    questions without a measured cost basis, and it charges `SAFETY_MULTIPLE` on top of it
 *    because the basis was measured on whatever prompt that run sent.
 * 4. **The scale was never priced before it was bought.** Above `BUDGET_YUAN` the gate demands a
 *    basis measured on *this* dispatch rather than a row measured on another arm.
 *
 * ## Why the numbers in this file are tables and not formulas
 *
 * `multiple` on a thinking model is a ratio of two measured bills, and it is quoted with the run
 * ids that produced it. The tariff is not re-derived here either: it is
 * `DEFAULT_SHIPMENT_POLICY.tokenTariff`, so a change to what a point of accuracy costs changes
 * this gate in the same commit as the shipment gate.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SHIPMENT_POLICY, adjudicateDecision } from '@agentix-e/nl2charts-ai';
import { PRICES } from '../eval/price.js';
import {
  adjudicateSpend,
  BUDGET_YUAN,
  CODES,
  LEDGER_PATH,
  main,
  MIN_BASIS_CASES,
  PROBE_LIMIT,
  readLedger,
  recordRow,
  requiredPp,
  RETIRED,
  SAFETY_MULTIPLE,
  selfTest,
  spendLines,
  THINKING,
  TOKEN_TARIFF,
  writeRow,
  type Ledger,
  type SpendArtifact,
} from '../eval/bird/spend.js';

/**
 * An artifact in the shape `bird-dev` writes.
 *
 * Constructed rather than downloaded: the numbers this file asserts are arithmetic on token
 * counts, and a 6.9 MB download per test run would buy nothing an object literal does not. Every
 * field the gate reads is present, and `arms[].servedModels` is filled the way a real run fills
 * it, because the gate refuses a row it cannot attribute.
 */
function reading(
  model: string,
  arms: Record<string, { prompt: number; completion: number; cached?: number; reasoning?: number }>,
  options: { cases?: number; run?: string; served?: string } = {},
): SpendArtifact {
  const cases = [];
  const served: Record<string, number> = {};
  const perArm = options.cases ?? MIN_BASIS_CASES;
  for (const [arm, tokens] of Object.entries(arms)) {
    served[options.served ?? model] = (served[options.served ?? model] ?? 0) + perArm;
    for (let index = 0; index < perArm; index += 1) {
      cases.push({ arm, tokens: { cached: 0, reasoning: 0, ...tokens } });
    }
  }
  return {
    model,
    cases,
    arms: Object.keys(arms).map((arm) => ({ arm, servedModels: served })),
    provenance: { run: options.run ?? '45000000000', workflow: 'bird-dev' },
    generatedAt: '2026-11-22T05:57:05.047Z',
  };
}

/** A ledger row in the shape `--record` writes. */
function row(tokens: { prompt: number; completion: number; cached?: number }, cases = 1532) {
  return {
    prompt: tokens.prompt,
    completion: tokens.completion,
    cached: tokens.cached ?? 0,
    cases,
    arm: 'an-arm',
    run: '45000000000',
    asOf: '2026-11-22',
    served: ['deepseek-flash'],
  };
}

describe('the tariff a thinking model has to beat', () => {
  it('is the shipment policy tariff on extra cost, floored by the smallest gain worth a switch', () => {
    // 5 points per 1x extra cost, from `DEFAULT_SHIPMENT_POLICY`. Asserted at the anchors rather
    // than at a decorated figure, so a change to either input moves this number.
    expect(requiredPp(1)).toBe(DEFAULT_SHIPMENT_POLICY.minDeltaPp);
    expect(requiredPp(2)).toBe(TOKEN_TARIFF);
    expect(requiredPp(4)).toBe(TOKEN_TARIFF * 3);
    expect(requiredPp(8)).toBe(TOKEN_TARIFF * 7);
    // The measured multiple of thinking mode on `deepseek-flash`: ¥0.010670 a case against
    // ¥0.001578 on the same arm (`macsql-prompt`), runs 45040430602 against 44991167518.
    expect(requiredPp(6.76)).toBeCloseTo(28.8, 6);
  });

  it('agrees with the shipment gate number for number', () => {
    // Two producers of one tariff: this file prices a dispatch, `packages/ai` prices a candidate
    // that has already been measured. A different curve in either would let a dispatch buy what
    // the ledger refuses to ship, so the agreement is asserted rather than assumed.
    for (const multiple of [1, 1.5, 2, 4, 6.76, 45.5]) {
      const verdict = adjudicateDecision({
        run: '44991167518',
        dataset: 'bird-dev',
        incumbent: { arm: 'assembled', correct: 500, total: 1000, tokensPerCase: 1 },
        challenger: { arm: 'macsql-prompt', correct: 500, total: 1000, tokensPerCase: multiple },
        paired: { onlyChallenger: 10, onlyIncumbent: 10 },
        note: 'a ratio and nothing else',
        p: 0.01,
        ci: { low: 0.5, high: 2 },
      });
      expect(verdict.requiredPp).toBeCloseTo(requiredPp(multiple), 9);
    }
  });

  it('is quoted for every thinking model the repository has measured', () => {
    for (const [model, entry] of Object.entries(THINKING)) {
      expect(PRICES[model], `${model} has no price row, so its multiple prices nothing`).toBeDefined();
      expect(entry.multiple).toBeGreaterThan(1);
      expect(entry.run).toMatch(/^\d{8,}$/);
    }
  });
});

describe('a dispatch that must not leave', () => {
  it('refuses the retired base and says what it cost', () => {
    const verdict = adjudicateSpend({ model: 'deepseek-v4-pro', limit: 100 }, { ledger: { rows: {} } });
    expect(verdict.code).toBe('retired');
    expect(verdict.ok).toBe(false);
    // The refusal is only useful if it carries the evidence: a run id, the delta, and the money.
    expect(verdict.message).toContain('45090651019');
    expect(verdict.message).toContain('-2.09pp');
    expect(verdict.message).toContain('¥110.08');
  });

  it('refuses a model no price row can cost', () => {
    const verdict = adjudicateSpend({ model: 'gpt-9-omniscient', limit: 100 }, { ledger: { rows: {} } });
    expect(verdict.code).toBe('unpriced');
    expect(verdict.message).toContain('gpt-9-omniscient');
    expect(verdict.message).toContain('eval/price.ts');
  });

  it('refuses a limit no run can have', () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(adjudicateSpend({ model: 'deepseek-chat', limit }, { ledger: { rows: {} } }).code).toBe('bad-limit');
    }
  });
});

describe('a thinking model', () => {
  const ledger: Ledger = {
    rows: {
      'deepseek-flash': row({ prompt: 3972, completion: 1285, cached: 3678 }),
    },
  };

  it('is refused until the caller states the gain it expects', () => {
    const verdict = adjudicateSpend({ model: 'deepseek-flash', limit: 100 }, { ledger });
    expect(verdict.code).toBe('thinking-undocumented');
    // The message has to name the number the caller would have to declare, or the refusal reads
    // as a ban and the next round spends an afternoon arguing with it.
    expect(verdict.message).toContain('28.8pp');
  });

  it('is refused when the stated gain is below what the price demands', () => {
    const verdict = adjudicateSpend({ model: 'deepseek-flash', limit: 100, acceptThinkingPp: 4 }, { ledger });
    expect(verdict.code).toBe('thinking-too-cheap');
    expect(verdict.message).toContain('28.8pp');
  });

  it('is allowed when the stated gain clears the tariff', () => {
    // Reachable on purpose: a gate whose only observed outcome is a refusal has never had its
    // allowance read, and this is the smallest run the repository could honestly justify.
    const verdict = adjudicateSpend({ model: 'deepseek-flash', limit: 100, acceptThinkingPp: 30 }, { ledger });
    expect(verdict.code).toBe('ok');
    expect(verdict.ok).toBe(true);
    expect(verdict.projection?.perCase).toBeCloseTo(0.011015, 6);
  });
});

describe('the cost basis', () => {
  it('is not required below the probe limit, because the run is the probe', () => {
    const verdict = adjudicateSpend({ model: 'deepseek-chat', limit: PROBE_LIMIT }, { ledger: { rows: {} } });
    expect(verdict.code).toBe('ok');
    // No basis and no projection: the gate says so rather than inventing a number.
    expect(verdict.projection).toBeUndefined();
    expect(verdict.message).toContain('probe');
  });

  it('is required above it, and the refusal names both ways to get one', () => {
    const verdict = adjudicateSpend({ model: 'deepseek-chat', limit: PROBE_LIMIT + 1 }, { ledger: { rows: {} } });
    expect(verdict.code).toBe('no-cost-basis');
    expect(verdict.message).toContain('--record');
    expect(verdict.message).toContain('--probe');
  });

  it('refuses a ledger row too thin to average', () => {
    const thin = adjudicateSpend(
      { model: 'deepseek-chat', limit: 1534 },
      {
        ledger: {
          rows: {
            'deepseek-chat': row({ prompt: 3137, completion: 147 }, MIN_BASIS_CASES - 1),
          },
        },
      },
    );
    expect(thin.code).toBe('no-cost-basis');
  });

  it('refuses a probe measured on another model', () => {
    // This is the shape of the mistake: an artifact from a cheap run offered as evidence for an
    // expensive one. Its token counts would silently price the wrong endpoint.
    const verdict = adjudicateSpend(
      { model: 'deepseek-chat', limit: 1534 },
      {
        ledger: { rows: {} },
        probe: reading('deepseek-flash', {
          arm: { prompt: 3972, completion: 1285 },
        }),
      },
    );
    expect(verdict.code).toBe('artifact-model-mismatch');
    expect(verdict.message).toContain('deepseek-flash');
  });

  it('refuses a probe with too few cases to be an average', () => {
    const verdict = adjudicateSpend(
      { model: 'deepseek-chat', limit: 1534 },
      {
        ledger: { rows: {} },
        probe: reading('deepseek-chat', { arm: { prompt: 3694, completion: 134 } }, { cases: 10 }),
      },
    );
    expect(verdict.code).toBe('artifact-too-thin');
    expect(verdict.message).toContain(String(MIN_BASIS_CASES));
  });

  it('charges the safety multiple, and says that it did', () => {
    const basis = reading('deepseek-chat', {
      arm: { prompt: 3694, completion: 134, cached: 3511 },
    });
    const verdict = adjudicateSpend({ model: 'deepseek-chat', limit: 600 }, { ledger: { rows: {} }, probe: basis });
    const perCase = ((3694 - 3511) * 2 + 3511 * 0.04 + 134 * 8) / 1_000_000;
    expect(verdict.projection?.perCase).toBeCloseTo(perCase, 9);
    expect(verdict.projection?.safety).toBe(SAFETY_MULTIPLE);
    expect(verdict.projection?.total).toBeCloseTo(perCase * 600 * SAFETY_MULTIPLE, 6);
    expect(verdict.message).toContain('×1.5');
  });

  it('keeps the worst arm in the artifact, not the mean over arms', () => {
    // A build that reads a bigger card is the build a dispatch has to be able to afford; averaging
    // it against a lean arm would price a run nobody sends.
    const verdict = adjudicateSpend(
      { model: 'deepseek-chat', limit: 600 },
      {
        ledger: { rows: {} },
        probe: reading('deepseek-chat', {
          lean: { prompt: 3137, completion: 147, cached: 2548 },
          fat: { prompt: 12000, completion: 900, cached: 1000 },
        }),
      },
    );
    expect(verdict.projection?.basis.arm).toBe('fat');
  });
});

describe('a run above the budget', () => {
  // ¥0.08 a case, which is `deepseek-chat` at ten times the prompt: the ladder is exercised at a
  // size the real ledger would reach after a prompt change, not at a number invented for the test.
  const expensive: Ledger = {
    rows: { 'deepseek-chat': row({ prompt: 10_000, completion: 7_500 }) },
  };
  const probe = reading('deepseek-chat', {
    arm: { prompt: 10_000, completion: 7_500 },
  });

  it('refuses a projection from the ledger, which measured another arm', () => {
    const verdict = adjudicateSpend({ model: 'deepseek-chat', limit: 1534 }, { ledger: expensive });
    expect(verdict.code).toBe('over-budget-no-probe');
    expect(verdict.projection?.total).toBeGreaterThan(BUDGET_YUAN);
    expect(verdict.message).toContain('--probe');
  });

  it('accepts a ledger row as the basis when it measured an arm this dispatch runs', () => {
    // The question the check asks is "was this basis measured on the prompt being paid for", and a
    // ledger row carries the arm it was measured on. A CI dispatch cannot pass a probe artifact at
    // all, so before this route existed an expensive run measured on its own arm last week was
    // refused for not having been measured on it this week — and the alternatives to a gate that
    // can be satisfied are a gate that is bypassed and a gate that is deleted.
    const measured = adjudicateSpend(
      { model: 'deepseek-chat', limit: 1534, arms: ['macsql-bird-os', 'an-arm'] },
      { ledger: expensive },
    );
    expect(measured.code).toBe('accept-cost-missing');
    // The projection it prints is the number to copy into --accept-cost rather than to guess.
    const accepted = adjudicateSpend(
      { model: 'deepseek-chat', limit: 1534, arms: ['an-arm'], acceptCostYuan: Math.ceil(measured.projection?.total ?? 0) },
      { ledger: expensive },
    );
    expect(accepted.code).toBe('ok');
    expect(accepted.projection?.basis.source).toBe('ledger');
  });

  it('still refuses a ledger row measured on an arm the dispatch does not run', () => {
    const verdict = adjudicateSpend({ model: 'deepseek-chat', limit: 1534, arms: ['another-arm'] }, { ledger: expensive });
    expect(verdict.code).toBe('over-budget-no-probe');
    expect(verdict.message).toContain('an-arm');
  });

  it('refuses a probe-priced run whose ceiling nobody accepted', () => {
    const verdict = adjudicateSpend({ model: 'deepseek-chat', limit: 1534 }, { ledger: { rows: {} }, probe });
    expect(verdict.code).toBe('accept-cost-missing');
    expect(verdict.message).toContain('--accept-cost');
  });

  it('refuses an accepted ceiling below the projection', () => {
    const verdict = adjudicateSpend(
      { model: 'deepseek-chat', limit: 1534, acceptCostYuan: 100 },
      { ledger: { rows: {} }, probe },
    );
    expect(verdict.code).toBe('accept-cost-too-low');
    // The projection is printed so the caller can copy a number instead of guessing one.
    expect(verdict.message).toContain('184.08');
  });

  it('lets a run through once the ceiling covers it', () => {
    const verdict = adjudicateSpend(
      { model: 'deepseek-chat', limit: 1534, acceptCostYuan: 200 },
      { ledger: { rows: {} }, probe },
    );
    expect(verdict.code).toBe('ok');
    expect(verdict.projection?.total).toBeCloseTo(0.08 * 1534 * SAFETY_MULTIPLE, 6);
  });
});

describe('recording a basis', () => {
  it('takes the worst arm and attributes the row to its run', () => {
    const recorded = recordRow(
      reading(
        'deepseek-chat',
        {
          lean: { prompt: 3137, completion: 147, cached: 2548 },
          fat: { prompt: 12000, completion: 900 },
        },
        { run: '44991167518' },
      ),
      'deepseek-chat',
    );
    expect('code' in recorded).toBe(false);
    if ('code' in recorded) return;
    expect(recorded.row.arm).toBe('fat');
    expect(recorded.row.run).toBe('44991167518');
    expect(recorded.row.asOf).toBe('2026-11-22');
    expect(recorded.row.cases).toBe(MIN_BASIS_CASES * 2);
    expect(recorded.row.prompt).toBe(12_000);
  });

  it('refuses an artifact that answers as another model', () => {
    const recorded = recordRow(reading('deepseek-flash', { arm: { prompt: 1, completion: 1 } }), 'deepseek-chat');
    expect('code' in recorded && recorded.code).toBe('artifact-model-mismatch');
  });

  it('refuses an artifact with no run behind it', () => {
    const orphan = {
      ...reading('deepseek-chat', { arm: { prompt: 1, completion: 1 } }),
      provenance: {},
    };
    const recorded = recordRow(orphan, 'deepseek-chat');
    expect('code' in recorded && recorded.code).toBe('artifact-unattributed');
  });

  it('refuses an artifact too thin to average', () => {
    const recorded = recordRow(
      reading('deepseek-chat', { arm: { prompt: 1, completion: 1 } }, { cases: 3 }),
      'deepseek-chat',
    );
    expect('code' in recorded && recorded.code).toBe('artifact-too-thin');
  });
});

describe('the shipped ledger', () => {
  const ledger = readLedger();

  it('prices only models price.ts can cost', () => {
    for (const [model, entry] of Object.entries(ledger.rows)) {
      expect(PRICES[model], `${model} is in the spend ledger with no price row`).toBeDefined();
      expect(entry.cases).toBeGreaterThanOrEqual(MIN_BASIS_CASES);
      expect(entry.run).toMatch(/^\d{8,}$/);
      expect(entry.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.arm).not.toBe('');
    }
  });

  it('lets the default dispatch through without a probe', () => {
    // The gate is worth nothing if the run this repository sends every day cannot pass it: the
    // first version of a spend gate that refuses the work is a gate that gets `|| true` on it.
    const verdict = adjudicateSpend({ model: 'deepseek-chat', limit: 1534 }, { ledger });
    expect(verdict.code).toBe('ok');
    expect(verdict.projection?.total).toBeCloseTo(0.00245592 * 1534 * SAFETY_MULTIPLE, 5);
    expect(verdict.projection?.total).toBeLessThan(BUDGET_YUAN);
  });

  it('still refuses the retired base, before it prices anything', () => {
    const verdict = adjudicateSpend(
      {
        model: 'deepseek-v4-pro',
        limit: 1534,
        acceptCostYuan: 500,
        acceptThinkingPp: 40,
      },
      { ledger },
    );
    expect(verdict.code).toBe('retired');
  });

  it('still refuses thinking mode on the model that answers every day', () => {
    const verdict = adjudicateSpend({ model: 'deepseek-flash', limit: 1534 }, { ledger });
    expect(verdict.code).toBe('thinking-undocumented');
  });
});

describe('the command line', () => {
  const run = (...args: string[]) =>
    spawnSync('npx', ['tsx', 'eval/bird/spend.ts', ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 120_000,
    });

  it('exits non-zero and names the refusal', () => {
    const result = run('--model', 'deepseek-v4-pro', '--limit', '100');
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('retired');
  });

  it('exits zero on a dispatch the ledger can price', () => {
    const result = run('--model', 'deepseek-chat', '--limit', '100');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok');
  });

  it('records an artifact into a ledger it is pointed at', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-record-'));
    try {
      const artifact = join(dir, 'bird-eval.json');
      writeFileSync(
        artifact,
        JSON.stringify(
          reading('deepseek-chat', { arm: { prompt: 3694, completion: 134, cached: 3511 } }, { run: '44991167518' }),
        ),
      );
      const ledgerPath = join(dir, 'per-case.json');
      const result = run('--record', artifact, '--model', 'deepseek-chat', '--ledger', ledgerPath);
      expect(result.status).toBe(0);
      const written = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      expect(written.rows['deepseek-chat'].run).toBe('44991167518');
      expect(written.rows['deepseek-chat'].prompt).toBe(3694);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints the same verdict the function returns', () => {
    const verdict = adjudicateSpend({ model: 'deepseek-chat', limit: 100 }, { ledger: readLedger() });
    expect(spendLines(verdict).join('\n')).toContain(verdict.code);
  });

  it('exposes every code it can return', () => {
    // A code that appears in a message but not in `CODES` is a code the report groups under
    // "other", which is how a refusal becomes invisible in a summary.
    expect(new Set(CODES).size).toBe(CODES.length);
    expect(CODES).toContain('ok');
    expect(LEDGER_PATH).toBe('eval/spend/per-case.json');
    expect(Object.keys(RETIRED)).toContain('deepseek-v4-pro');
  });
});

describe('the command line, in process', () => {
  // Driven in process rather than through a subprocess: a child's coverage is not collected, and
  // the argument parsing is what decides which refusal a dispatch prints. The subprocess tests
  // above exist for the entry guard, which only a real invocation reaches.
  const lines = () => {
    const seen: string[] = [];
    return { seen, log: (line: string) => seen.push(line) };
  };

  it('refuses a dispatch with no model, or with an empty one', () => {
    for (const argv of [[], ['--model', ''], ['--model', '', '--limit', '100']]) {
      const sink = lines();
      expect(main(argv, sink.log)).toBe(2);
      expect(sink.seen.join('\n')).toContain('--model is required');
    }
  });

  it('refuses a dispatch with no limit', () => {
    const sink = lines();
    expect(main(['--model', 'deepseek-chat'], sink.log)).toBe(2);
    expect(sink.seen.join('\n')).toContain('--limit is required');
  });

  it('prints the verdict and exits on it', () => {
    const ok = lines();
    expect(main(['--model', 'deepseek-chat', '--limit', '100'], ok.log)).toBe(0);
    expect(ok.seen.join('\n')).toContain('spend: ok');

    const refused = lines();
    expect(main(['--model', 'deepseek-v4-pro', '--limit', '100'], refused.log)).toBe(1);
    expect(refused.seen.join('\n')).toContain('spend: retired');
  });

  it('reads the arm list off the command line and hands it to the gate', () => {
    // Without this the flag would be parsed into nothing and a dispatch above the budget would keep
    // printing "pass --probe" at a workflow that has no way to pass one.
    const dir = mkdtempSync(join(tmpdir(), 'spend-arms-'));
    try {
      const ledgerPath = join(dir, 'per-case.json');
      writeFileSync(
        ledgerPath,
        JSON.stringify({ rows: { 'deepseek-chat': { ...row({ prompt: 10_000, completion: 7_500 }), arm: 'an-arm' } } }),
      );
      const missing = lines();
      expect(main(['--model', 'deepseek-chat', '--limit', '1534', '--ledger', ledgerPath, '--arms', 'a,an-arm,b'], missing.log)).toBe(1);
      expect(missing.seen.join('\n')).toContain('spend: accept-cost-missing');

      const accepted = lines();
      const argv = ['--model', 'deepseek-chat', '--limit', '1534', '--ledger', ledgerPath, '--arms', 'an-arm', '--accept-cost', '200'];
      expect(main(argv, accepted.log)).toBe(0);
      expect(accepted.seen.join('\n')).toContain('spend: ok');

      // A flag given an empty value names no arm, which is the same as not passing it: the gate
      // then has nothing to match the ledger row against and refuses for the original reason.
      const empty = lines();
      expect(main(['--model', 'deepseek-chat', '--limit', '1534', '--ledger', ledgerPath, '--arms', '', '--accept-cost', '200'], empty.log)).toBe(1);
      expect(empty.seen.join('\n')).toContain('spend: over-budget-no-probe');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prices a probe it is handed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-probe-'));
    try {
      const path = join(dir, 'probe.json');
      writeFileSync(
        path,
        JSON.stringify(
          reading('deepseek-chat', {
            arm: { prompt: 3694, completion: 134, cached: 3511 },
          }),
        ),
      );
      const sink = lines();
      const code = main(
        ['--model', 'deepseek-chat', '--limit', '600', '--probe', path, '--ledger', join(dir, 'none.json')],
        sink.log,
      );
      expect(code).toBe(0);
      expect(sink.seen.join('\n')).toContain('basis: probe arm arm');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records in process, and refuses a record it cannot attribute', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-main-'));
    try {
      const artifact = join(dir, 'bird-eval.json');
      writeFileSync(
        artifact,
        JSON.stringify(
          reading(
            'deepseek-chat',
            {
              arm: {
                prompt: 3694,
                completion: 134,
                cached: 3511,
                reasoning: 40,
              },
            },
            { run: '44991167518' },
          ),
        ),
      );
      const ledgerPath = join(dir, 'per-case.json');
      const sink = lines();
      expect(main(['--record', artifact, '--model', 'deepseek-chat', '--ledger', ledgerPath], sink.log)).toBe(0);
      expect(sink.seen.join('\n')).toContain('recorded deepseek-chat from run 44991167518');
      // A thinking artifact keeps the reasoning count: it is the number that says why a mode is
      // expensive, and a row without it prices the mode as if it were the chat one.
      expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).rows['deepseek-chat'].reasoning).toBe(40);

      const orphan = join(dir, 'orphan.json');
      writeFileSync(
        orphan,
        JSON.stringify({
          ...JSON.parse(readFileSync(artifact, 'utf8')),
          provenance: {},
        }),
      );
      const refused = lines();
      expect(main(['--record', orphan, '--model', 'deepseek-chat', '--ledger', ledgerPath], refused.log)).toBe(1);
      expect(refused.seen.join('\n')).toContain('artifact-unattributed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs its own self-test, and reports one that fails', () => {
    const passing = lines();
    expect(main(['--self-test'], passing.log)).toBe(0);
    expect(passing.seen.join('\n')).toContain('assertions');

    const failing = lines();
    expect(
      main(['--self-test'], failing.log, () => ({
        problems: ['a check nobody fixed'],
        assertions: 1,
      })),
    ).toBe(1);
    expect(failing.seen.join('\n')).toContain('FAILED a check nobody fixed');
  });
});

describe('the ledger file', () => {
  it('is empty when nothing has been measured, and keeps its note when a row is added', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-ledger-'));
    try {
      const path = join(dir, 'per-case.json');
      expect(readLedger(path).rows).toEqual({});
      const first = writeRow(row({ prompt: 100, completion: 10 }), 'deepseek-chat', path);
      expect(first.note).toBeDefined();
      const second = writeRow(row({ prompt: 200, completion: 20 }), 'deepseek-flash', path);
      // The note is written once and preserved: it explains every row, and a second write that
      // dropped it would leave a table of unexplained numbers.
      expect(second.note).toBe(first.note);
      expect(Object.keys(second.rows)).toEqual(['deepseek-chat', 'deepseek-flash']);
      expect(second.rows['deepseek-chat']?.prompt).toBe(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an artifact whose arms are each too thin even when the total is not', () => {
    // 60 cases over two arms of 30: the total clears the floor and no arm does. Averaging the
    // artifact would pass a row whose per-arm mean rests on 30 cases.
    const half = MIN_BASIS_CASES - 20;
    const verdict = adjudicateSpend(
      { model: 'deepseek-chat', limit: 600 },
      {
        ledger: { rows: {} },
        probe: reading(
          'deepseek-chat',
          {
            left: { prompt: 3000, completion: 100 },
            right: { prompt: 3000, completion: 100 },
          },
          { cases: half },
        ),
      },
    );
    expect(verdict.code).toBe('artifact-too-thin');
    expect(verdict.message).toContain('no arm');
  });

  it('records a row with no served model when the artifact does not say who answered', () => {
    const recorded = recordRow(
      {
        ...reading('deepseek-chat', { arm: { prompt: 3000, completion: 100 } }),
        arms: undefined,
      },
      'deepseek-chat',
    );
    expect('row' in recorded && recorded.row.served).toEqual([]);
  });

  it('holds every refusal the self-test claims to make', () => {
    const { problems, assertions } = selfTest();
    expect(problems).toEqual([]);
    expect(assertions).toBe(12);
  });

  it('reads a ledger written before rows existed as empty rather than crashing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-norows-'));
    try {
      const path = join(dir, 'per-case.json');
      writeFileSync(path, JSON.stringify({ note: 'a file from before the first measurement' }));
      expect(readLedger(path).rows).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an artifact that is missing pieces', () => {
  it('counts an unnamed arm and an unmeasured case instead of throwing', () => {
    // Real artifacts have aged: `tokens` arrived in one round, `arm` naming in another. A gate
    // that throws on the older shape is a gate nobody can run against the archive.
    const aged: SpendArtifact = {
      model: 'deepseek-chat',
      cases: Array.from({ length: MIN_BASIS_CASES }, () => ({ tokens: {} })),
      provenance: { run: '44991167518' },
      generatedAt: '2026-11-22T05:57:05.047Z',
    };
    const recorded = recordRow(aged, 'deepseek-chat');
    expect('row' in recorded && recorded.row.arm).toBe('unnamed');
    expect('row' in recorded && recorded.row.prompt).toBe(0);
  });

  it('refuses an artifact with no cases field at all', () => {
    const verdict = adjudicateSpend({ model: 'deepseek-chat', limit: 600 }, { probe: { model: 'deepseek-chat' } });
    expect(verdict.code).toBe('artifact-too-thin');
  });

  it('refuses to record arms whose model has no price row', () => {
    const recorded = recordRow(reading('gpt-9', { arm: { prompt: 1, completion: 1 } }), 'gpt-9');
    expect('code' in recorded && recorded.code).toBe('unpriced');
  });
});

describe('the flags that carry a declaration', () => {
  const lines = () => {
    const seen: string[] = [];
    return { seen, log: (line: string) => seen.push(line) };
  };

  it('passes the thinking declaration and the ceiling through to the verdict', () => {
    const sink = lines();
    const code = main(
      ['--model', 'deepseek-flash', '--limit', '600', '--accept-thinking', '30', '--accept-cost', '1000'],
      sink.log,
    );
    // The ledger prices this arm, so 600 questions clears the budget once a ceiling is stated: the
    // two flags have to survive argument parsing or the run is refused as undeclared.
    expect(code).toBe(0);
    expect(sink.seen.join('\n')).toContain('spend: ok');
  });
});
