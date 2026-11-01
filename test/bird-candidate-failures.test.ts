import { describe, expect, it } from 'vitest';
import { CANDIDATE_SQL_CAP, assertCandidateSurvival, candidateFailureTotals, candidateSurvivalBySource, candidateVerdicts, classifyCandidateFailure } from '../eval/bird/run.js';

/**
 * Three ways a candidate fails to exist, and three different repairs.
 *
 * `candidateFailures` used to have one cell for two mechanisms. A rerun put 440 of 4,596
 * candidates there, and 375 of the 380 cases that were missing a candidate were missing the
 * *second model's* statement — which reads as "the cross arm's ceiling is lower", when the cause
 * may be a statement the engine refused (the prompt wrote something unrunnable) or a reply the
 * parser could not read (the prompt produced nothing usable). The first is repaired by changing
 * the prompt, the second by changing extraction, and a merged counter recommends neither.
 *
 * The split is a *report*, not a second guard. Only `llm` fails a run: an endpoint that refuses a
 * tenth of the candidates is an infrastructure verdict, and the arm's number measures the key
 * rather than the idea. A statement the engine refused is the model's own output quality — an arm
 * whose every candidate was refused (a read-only database against a prompt that writes INSERTs) is
 * a 0% reading and has to survive to be reported. The first version of this change gated `engine`
 * at 10% and the suite refuted it immediately, which is why there is no `assertEngineSurvival`.
 */
const lostOf = (llm: number, engine: number, unparsed: number): { candidateFailures: { llm: number; engine: number; unparsed: number } } => ({
  candidateFailures: { llm, engine, unparsed },
});

/** 99 quiet cases plus one that carries the loss: 100 runs x 3 candidates = 300 attempts. */
const withLoss = (llm: number, engine: number, unparsed = 0) => [
  ...Array.from({ length: 99 }, () => lostOf(0, 0, 0)),
  lostOf(llm, engine, unparsed),
];

describe('the three ways a candidate can fail to arrive', () => {
  it('adds up the runs, and treats an absent record as no loss', () => {
    expect(candidateFailureTotals([])).toEqual({ llm: 0, engine: 0, unparsed: 0 });
    expect(candidateFailureTotals([lostOf(1, 2, 3), {}, lostOf(0, 1, 0)])).toEqual({ llm: 1, engine: 3, unparsed: 3 });
  });

  it('blames the endpoint for endpoint failures only', () => {
    // The whole point of the split: the same share of refusals means two different things, and the
    // guard that exists for the infrastructure verdict must not fire on the output-quality one.
    expect(() => assertCandidateSurvival('select-mixed', withLoss(0, 300), 3)).not.toThrow();
    expect(() => assertCandidateSurvival('select-mixed', withLoss(0, 0, 300), 3)).not.toThrow();
    expect(() => assertCandidateSurvival('select-mixed', withLoss(40, 0), 3)).toThrow(/never arrived from the model/);
  });

  it('counts endpoint losses that are spread across the run', () => {
    // 40 of 300 is 13.3%: the message carries both numbers, because a share alone does not say
    // whether the run lost one candidate three times or forty times.
    expect(() => assertCandidateSurvival('select-mixed', withLoss(40, 0), 3)).toThrow(/40 of 300 candidates \(13\.3%\)/);
  });

  it('resolves the boundary it enforces', () => {
    // 30/300 is exactly 10% and passes, 31/300 does not.
    expect(() => assertCandidateSurvival('a', withLoss(30, 0), 3)).not.toThrow();
    expect(() => assertCandidateSurvival('a', withLoss(31, 0), 3)).toThrow(/10\.3%/);
  });

  it('does not read a merged legacy counter as either half', () => {
    // An artifact written before the split carries `other` and no `engine`. Reading it as
    // `unparsed` would be an invention, so the missing halves total zero instead.
    const legacy = [{ candidateFailures: { llm: 2 } as unknown as { llm: number; engine: number; unparsed: number } }];
    expect(candidateFailureTotals(legacy)).toEqual({ llm: 2, engine: 0, unparsed: 0 });
  });

  it('says nothing about a run that attempted no candidates', () => {
    expect(() => assertCandidateSurvival('a', [], 3)).not.toThrow();
  });
});

describe('whose candidates never arrived', () => {
  const perSource = (generated: number, survived: number) => ({ generated, survived });

  it('sums each source across the run', () => {
    const runs = [
      { candidateSurvival: { 'inline+evidence@second': perSource(1, 0), 'metadata+evidence': perSource(1, 1) } },
      { candidateSurvival: { 'inline+evidence@second': perSource(1, 0), 'metadata+evidence': perSource(1, 1) } },
      {},
    ];
    expect(candidateSurvivalBySource(runs)).toEqual({
      'inline+evidence@second': { generated: 2, survived: 0 },
      'metadata+evidence': { generated: 2, survived: 2 },
    });
  });

  it('has no keys when nothing was recorded, rather than a zero', () => {
    // A zero would read as "we looked and it was nothing"; an empty record says the run did not
    // report survival at all, which is what a single-generation arm honestly did.
    expect(candidateSurvivalBySource([{}, {}])).toEqual({});
  });
});

describe('reading the mechanism off the error code', () => {
  it('calls a silent endpoint an endpoint failure', () => {
    expect(classifyCandidateFailure('NL2C_E_TIMEOUT')).toBe('llm');
    expect(classifyCandidateFailure('NL2C_E_LLM_UNAVAILABLE')).toBe('llm');
  });

  it('calls a refused request an endpoint failure too, because no statement was written', () => {
    // A batch that scores zero because a model name is wrong must not read as a model that
    // writes bad statements: nothing about the model's output was measured, because the call
    // never ran. This is the opposite of INVALID_RESPONSE, where the endpoint did answer.
    expect(classifyCandidateFailure('NL2C_E_LLM_REJECTED')).toBe('llm');
  });

  it('calls a statement that must not run an engine failure', () => {
    expect(classifyCandidateFailure('NL2C_E_GUARD_REJECTED')).toBe('engine');
    expect(classifyCandidateFailure('NL2C_E_ENGINE_FAILED')).toBe('engine');
  });

  it('does not call an unusable reply an outage', () => {
    // The endpoint answered. Counting this as `llm` would let a prompt that produces
    // unparseable replies fail the run with "the endpoint is down", which is the wrong repair
    // and the wrong owner.
    expect(classifyCandidateFailure('NL2C_E_LLM_INVALID_RESPONSE')).toBe('unparsed');
    expect(classifyCandidateFailure(undefined)).toBe('unparsed');
    expect(classifyCandidateFailure('NL2C_E_SOMETHING_NEW')).toBe('unparsed');
  });
});

/**
 * What a candidate record has to carry for the next instrument to read it.
 *
 * `bench:bird:consensus` prices selection rules from the artifact, which is only possible if the
 * record holds the statement and a fingerprint of the result. Both were added here, and both have
 * a failure mode that is silent rather than loud: a fingerprint computed from a second definition
 * of equality would let two candidates "agree" whose results the judge calls different, and a
 * statement truncated without saying so cannot be re-executed even though it looks as if it can.
 */
describe('the candidate record', () => {
  const rows = [[1]];
  const expected = [[1]];

  it('carries the statement, the verdict and a fingerprint of the result', () => {
    const [verdict] = candidateVerdicts([{ sql: 'SELECT 1', rows, source: 'values' }], expected);
    expect(verdict).toMatchObject({ source: 'values', correct: true, sql: 'SELECT 1' });
    expect(verdict?.fingerprint).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('gives two statements with the same result the same fingerprint, and different results different ones', () => {
    const verdicts = candidateVerdicts(
      [
        { sql: 'SELECT 1', rows: [[1]], source: 'a' },
        { sql: 'select 1 as x', rows: [[1]], source: 'b' },
        { sql: 'SELECT 2', rows: [[2]], source: 'c' },
      ],
      expected,
    );
    expect(verdicts[0]?.fingerprint).toBe(verdicts[1]?.fingerprint);
    expect(verdicts[0]?.fingerprint).not.toBe(verdicts[2]?.fingerprint);
    // ...and it follows the judge, not the text: the third statement is a mismatch, so the entry
    // is the reason the arm can tell "the candidates agreed" from "the candidates agreed on a
    // wrong answer".
    expect(verdicts.map((verdict) => verdict.correct)).toEqual([true, true, false]);
  });

  it('says when it had to truncate the statement', () => {
    const long = `SELECT '${'x'.repeat(CANDIDATE_SQL_CAP)}'`;
    const [verdict] = candidateVerdicts([{ sql: long, rows, source: 'a' }], expected);
    expect(verdict?.sql).toHaveLength(CANDIDATE_SQL_CAP);
    expect(verdict?.sqlClipped).toBe(true);
  });

  it('leaves a statement under the cap alone and does not claim truncation', () => {
    const [verdict] = candidateVerdicts([{ sql: 'SELECT 1', rows, source: 'a' }], expected);
    expect(verdict?.sqlClipped).toBeUndefined();
  });
});
