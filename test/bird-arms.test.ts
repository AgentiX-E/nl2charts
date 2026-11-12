import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSqlPrompt } from '@agentix-e/nl2charts-ai';
import { entryExit, isEntry, main, needsTrainingSplit, requestedArms } from '../eval/bird/needs-train.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARMS,
  COMPARISONS,
  DUO_SOURCES,
  MIXED_SOURCES,
  CROSS_SOURCES,
  BALANCED_SOURCES,
  DEFAULT_ARMS,
  DEV_ARMS,
  ON_DEMAND_ARMS,
  PAIRS,
  armsInEffect,
  armsNeedRetrieval,
  assertArmProducedResults,
  assertFailureRate,
  createFailureBreaker,
  failureLabel,
  failureTally,
  outageDecided,
  assertHarnessClean,
  escapeKind,
  assertMixedFeasible,
  assertMixedSources,
  assertCandidateSurvival,
  assertDecompositionFired,
  assertEmptyRetryFired,
  assertRepairPathFired,
  assertCardRule,
  narrowFields,
  assertUniqueArmLabels,
  decompositionFunnel,
  declaresDecomposition,
  DC_SOURCES,
  MIXED_DC_SOURCES,
  SAMPLED_SOURCES,
  auditFunnel,
  assertAuditFired,
  groundingFunnel,
  assertGroundingFired,
  emptyRetryFunnel,
  offeredCandidates,
  candidateCeiling,
  parseArms,
  parseLimit,
  resolveLimit,
  parseMixedSource,
  promptFor,
  PROJECTION_RULE,
  readPinnedDefinitions,
  repairAccounting,
  resolveArm,
  winnerSources,
} from '../eval/bird/run.js';
import type { Arm } from '../eval/bird/run.js';
import type { BirdQuestion } from '../eval/bird/data.js';

/**
 * The value of an ablation is the invariant, not the run. These tests pin the
 * invariant: two arms in a pair differ by exactly one lever, so an accuracy
 * delta cannot be attributed to anything else. A future edit that adds a second
 * change to a pair turns this red before it turns the benchmark unreadable.
 */
const LEVERS = ['notes', 'evidence', 'repairs', 'linking', 'linkEvidence', 'profile', 'definitions', 'focus', 'interpret', 'vote', 'demonstrations', 'select', 'values', 'plan', 'planBy', 'repairFeedback', 'shapeGuard', 'mixed', 'pool', 'pairwise', 'sourcesVisible', 'judge', 'judgeFormat', 'emptyRetry', 'audit', 'decompose', 'samples', 'canonical', 'shuffle', 'prune', 'columnSelect', 'agreement', 'sourceLinking', 'sourceRepairs', 'reconcile', 'reconcileAdopt', 'sampleColumns', 'cardColumns', 'dissent', 'dissentVerify', 'masked', 'intent', 'selectRule', 'projection', 'ground', 'cotDemonstrations', 'reasoning', 'rowSamples'] as const;

function changedLevers(left: Arm, right: Arm): string[] {
  const levers = LEVERS.filter((lever) => left[lever] !== right[lever]);
  // On a mixed arm `vote` is not a lever: it is the length of the source list, and the
  // suite checks that equality on every mixed arm. Counting both would make every change
  // of candidate set look like a two-lever comparison, which is the shape this test
  // exists to refuse.
  // The format a judge is asked in is part of *who judges*, not a second change: an arm that
  // swaps the judge necessarily states its format, and counting both would make every judge
  // swap look like a two-lever comparison. The format is its own lever only when the judge is
  // the same on both sides, which is exactly the pair that prices it.
  const single = left.judge === right.judge ? levers : levers.filter((lever) => lever !== 'judgeFormat');
  return left.mixed !== undefined && right.mixed !== undefined ? single.filter((lever) => lever !== 'vote') : single;
}

const question = {
  question_id: 1,
  db_id: 'shop',
  question: 'How many orders were placed by each customer?',
  evidence: 'An order belongs to one customer.',
  SQL: 'SELECT 1',
  difficulty: 'simple',
} as unknown as BirdQuestion;

describe('ablation arms', () => {
  it('names every arm in a pair', () => {
    for (const [left, right] of PAIRS) {
      expect(ARMS.find((arm) => arm.name === left), left).toBeDefined();
      expect(ARMS.find((arm) => arm.name === right), right).toBeDefined();
    }
  });

  it('states a decision question for every cross-level comparison', () => {
    // These are not one-lever pairs, so they live in their own list with the question
    // they answer; an entry without one would be a delta with no claim attached.
    for (const [left, right, question] of COMPARISONS) {
      expect(ARMS.map((arm) => arm.name), left).toContain(left);
      expect(ARMS.map((arm) => arm.name), right).toContain(right);
      expect(question.length, `${left} -> ${right}`).toBeGreaterThan(20);
    }
  });

  it('prices every multi-call arm against the single prompt that undercuts it', () => {
    // The cost table reads a token column, and a table is not a test. These three pairs are
    // the ones that can say "the cheaper arm is not the worse one", and they were missing
    // for four runs because this list carried levers and one generated-versus-curated swap
    // and nothing about the bill. A pair that is not here is a question the artifact cannot
    // answer without a second artifact from the same split.
    const against = COMPARISONS.filter(([from]) => from === 'metadata+evidence').map(([, to]) => to);
    expect(against).toEqual(expect.arrayContaining(['select', 'select-prune', 'select-mixed']));
  });

  it('prices every sampler against the card that carries no stored values', () => {
    // A sampler changes what the card says about a column, so the question it answers is
    // "did the stored values help", and that question needs the arm without them. The two
    // samplers were compared to each other and to nothing else for one run, so the artifact
    // could say their rules tie but not whether either of them beat the plain card — and a
    // tie between two arms that each beat the base is a different finding from a tie at the
    // base's level. Found by writing the report: the paired row for `inline+evidence+samples`
    // did not exist, and the number had to be recomputed from the case rows by hand.
    const declared = new Set(
      [...COMPARISONS.map(([left, right]) => `${left}\u0000${right}`), ...PAIRS.map(([left, right]) => `${left}\u0000${right}`)],
    );
    const samplers = ARMS.filter((arm) => arm.samples !== undefined);
    expect(samplers.length).toBeGreaterThan(0);
    for (const arm of samplers) {
      // The sampler's own parent: the arm one lever away. For the plain samplers that is the card
      // with no values at all; for a sampler that narrows *which* columns carry them it is the
      // sampler, because "which columns" is only a lever on top of "values at all". Requiring the
      // value-free card here would demand a two-lever pair, which is the thing `PAIRS` refuses.
      const parent = ARMS.find((other) => other !== arm && changedLevers(other, arm).length === 1);
      expect(parent, arm.name).toBeDefined();
      const name = (parent as Arm).name;
      expect(declared.has(`${name}\u0000${arm.name}`) || declared.has(`${arm.name}\u0000${name}`), arm.name).toBe(true);
      if (arm.sampleColumns === undefined) expect((parent as Arm).samples, arm.name).toBeUndefined();
    }
  });

  it('changes exactly one lever per pair', () => {
    for (const [left, right] of PAIRS) {
      const before = ARMS.find((arm) => arm.name === left) as Arm;
      const after = ARMS.find((arm) => arm.name === right) as Arm;
      expect(changedLevers(before, after), `${left} -> ${right}`).toHaveLength(1);
    }
  });

  it('states the reconcile policy on the arm whose name carries it, and on no other', () => {
    // A `-novel` arm that forgot the field is its parent under another name, and the pair would
    // then publish a delta of exactly zero with the authority of a measurement — the failure this
    // project has paid for twice: a lever that did not run, and a guard that read its absence as a
    // null result. The other direction matters as much: an arm that adopts only novel statements
    // without saying so in its name is a reading nobody can find.
    for (const arm of ARMS) {
      if (arm.name.endsWith('-novel')) expect(arm.reconcileAdopt, arm.name).toBe('novel');
      else expect(arm.reconcileAdopt, arm.name).toBeUndefined();
    }
  });

  it('keeps the two reconcile arms on one prompt, one pool and one call', () => {
    // The pairing rule above says one lever differs; this says the lever is the *only* difference a
    // reader would have to hold in mind — the candidates, the sources and the price are shared.
    const always = ARMS.find((arm) => arm.name === 'select-cross-pooled-reconcile') as Arm;
    const novel = ARMS.find((arm) => arm.name === 'select-cross-pooled-reconcile-novel') as Arm;
    expect(novel.reconcile).toBe(always.reconcile);
    expect(novel.pool).toBe(always.pool);
    expect(novel.mixed).toEqual(always.mixed);
    expect(novel.vote).toBe(always.vote);
    expect(novel.select).toBe(always.select);
    expect(novel.judge).toBe(always.judge);
  });

  it('forms a chain rather than a set of unrelated arms', () => {
    const parents = new Map(PAIRS.map(([left, right]) => [right, left]));
    expect(parents.get('definitions')).toBe('names');
    expect(parents.get('definitions+evidence')).toBe('definitions');
    expect(parents.get('synthetic+focus')).toBe('synthetic');
  });

  it('shows semantics only to the arms that carry them', () => {
    const definitions = '- orders.customer_id: foreign key to customers.customer_id.';
    const withSemantics = promptFor(ARMS.find((arm) => arm.name === 'definitions') as Arm, question, { definitions });
    const without = promptFor(ARMS.find((arm) => arm.name === 'names') as Arm, question, { definitions });
    expect(withSemantics.definitions).toBe(definitions);
    expect(without.definitions).toBeUndefined();
  });

  it('keeps the dataset hint out of a synthesized arm', () => {
    const synthetic = promptFor(ARMS.find((arm) => arm.name === 'synthetic') as Arm, question, { synthesized: 'Data profile: 3 values' });
    expect(synthetic.evidence).toBe('Data profile: 3 values');
    expect(promptFor(ARMS.find((arm) => arm.name === 'names') as Arm, question, { synthesized: 'Data profile: 3 values' }).evidence).toBeUndefined();
  });

  it('treats the two hint sources as alternatives on one lever', () => {
    const dataset = ARMS.find((arm) => arm.name === 'metadata+evidence') as Arm;
    const synthesizedArm = ARMS.find((arm) => arm.name === 'synthetic') as Arm;
    expect(changedLevers(dataset, synthesizedArm)).toEqual(['evidence']);
    expect(dataset.evidence).toBe('dataset');
    expect(synthesizedArm.evidence).toBe('synthetic');
  });

  it('drops an empty semantics block instead of leaving a heading', () => {
    const arm = ARMS.find((entry) => entry.name === 'definitions') as Arm;
    expect(promptFor(arm, question, { definitions: '' }).definitions).toBeUndefined();
    expect(promptFor(arm, question, {}).definitions).toBeUndefined();
  });

  it('carries the dataset hint on the evidence arm even with semantics present', () => {
    const arm = ARMS.find((entry) => entry.name === 'definitions+evidence') as Arm;
    const prompt = promptFor(arm, question, { definitions: '- orders: one row per order.' });
    expect(prompt.definitions).toBe('- orders: one row per order.');
    expect(prompt.evidence).toBe(question.evidence);
  });
});

describe('the chain that actually runs', () => {
  it('files every arm as default or on demand, with no arm falling between', () => {
    // The bug this prevents: `inline+retrieval` was written, wired into the prompt,
    // paired for ablation — and never executed, because the default chain is a
    // second list that nothing compared against the catalogue.
    const filed = [...DEFAULT_ARMS, ...Object.keys(ON_DEMAND_ARMS)].sort();
    const declared = ARMS.map((arm) => arm.name).sort();
    expect(filed).toEqual(declared);
  });

  it('keeps a mechanism that measured harmful out of the default chain', () => {
    // A plan before the statement lost 7.2pp against its parent (63/27, p=0.0002).
    // Keeping it in the chain would spend two minutes of every run to make the table
    // worse; the catalogue keeps it so the finding can be re-tested.
    expect(DEFAULT_ARMS).not.toContain('plan');
    expect(ON_DEMAND_ARMS.plan).toMatch(/-7\.2pp/);
  });

  it('puts the retrieval arm in the default chain', () => {
    expect(DEFAULT_ARMS).toContain('inline+retrieval');
  });

  it('keeps the chain free of duplicates and of arms that do not exist', () => {
    expect(new Set(DEFAULT_ARMS).size).toBe(DEFAULT_ARMS.length);
    for (const name of DEFAULT_ARMS) expect(ARMS.map((arm) => arm.name), name).toContain(name);
  });

  it('keeps the chain inside its call budget', () => {
    // A budget, not a threshold: the chain's bill is the one number every push pays, and it
    // grew one arm at a time to sixteen — 23,840 prompt tokens a question, 11.9M a run. The
    // cut that took it to eleven was justified by measurement (`vote` +0.00pp against `select`
    // at 17:17, `select-duo` −0.60pp, `select5` +0.40pp inside a 3.33pp MDE) and this line is
    // what keeps the next arm from being added without that argument.
    //
    // Fourteen today, and the fourteenth rung left by its own measurement: the audit arm was
    // the fifteenth — one call, aimed at the largest failure class left — until the dev split
    // priced it at +1.2pp for 2x calls and 2.3x completion tokens (p = 0.48). It became the
    // ablation reference, so the position it frees belongs to the next lever with a reading
    // rather than to the next idea.
    //
    // Fifteen today, and the fifteenth is the only kind of arm that earns a rung without a
    // reading of its own: `inline+icl-cot` reuses the neighbours `inline+icl` already retrieves
    // and differs from it in the text of the block it sends, so it costs one call per question
    // and no new preparation. The mechanism it carries is the one OpenSearch-SQL credits for
    // reaching 69.3% on BIRD with no training, and this repository had priced only the
    // (question, SQL) half of that shape — so the rung buys a mechanism, not an idea. The
    // sixteenth position stays empty until one of these arms produces a verdict.
    const nominal = DEFAULT_ARMS.reduce((total, name) => {
      const arm = ARMS.find((entry) => entry.name === name) as Arm;
      return total + (arm.vote ?? 1) + (arm.select === true ? 1 : 0);
    }, 0);
    expect(nominal).toBeLessThanOrEqual(16);
    expect(nominal).toBe(15);
  });

  it('gives the demonstration arm statements and the textual arm only text', () => {
    // One lever apart: if the textual arm also carried examples, the delta would
    // price two things at once.
    const demonstrations = 'Question: How many rows?\nSQL: SELECT COUNT(*) FROM t';
    const viaIcl = ARMS.find((arm) => arm.name === 'inline+icl') as Arm;
    const viaText = ARMS.find((arm) => arm.name === 'inline+retrieval') as Arm;
    expect(promptFor(viaIcl, question, { retrieved: 'hint', demonstrations }).demonstrations).toBe(demonstrations);
    expect(promptFor(viaText, question, { retrieved: 'hint', demonstrations }).demonstrations).toBeUndefined();
  });

  it('sends the block it measures, through the same builder', () => {
    // The bug this prevents: the prompt *size* was computed with the retrieved block
    // and the request was built without it, so an arm that never saw its input was
    // published as evidence that the input does not help.
    const retrieval = ARMS.find((arm) => arm.name === 'inline+retrieval') as Arm;
    const options = promptFor(retrieval, question, { retrieved: 'a retrieved neighbour' });
    expect(buildSqlPrompt(question.question, [], options)).toContain('Evidence: a retrieved neighbour');

    const values = ARMS.find((arm) => arm.name === 'values') as Arm;
    expect(buildSqlPrompt(question.question, [], promptFor(values, question, { values: '- t.c stores \'x\'' }))).toContain(
      'Values in this database named by the question:',
    );
  });

  it('carries the curated notes and the value block on one prompt', () => {
    // Two information levers that were each priced alone: a note says what a column means, the
    // block says which literal it holds. The pair is only one lever if the arm renders both —
    // an arm whose `descriptions` fell through to undefined would measure the value block
    // against a card with neither source and wear the name of the comparison.
    const arm = ARMS.find((entry) => entry.name === 'metadata+evidence+values') as Arm;
    const parent = ARMS.find((entry) => entry.name === 'metadata+evidence') as Arm;
    const card = [{ table: 'orders', columns: [{ name: 'status', type: 'TEXT', comment: 'one of the three shipping states' }] }];
    const text = buildSqlPrompt(question.question, card, promptFor(arm, question, { values: "- orders.status stores 'shipped'" }));
    expect(text).toContain('one of the three shipping states');
    expect(text).toContain('Values in this database named by the question:');
    expect(text).toContain("stores 'shipped'");
    // The parent keeps the note and has no block, so the pair is the block and nothing else.
    const without = buildSqlPrompt(question.question, card, promptFor(parent, question, { values: "- orders.status stores 'shipped'" }));
    expect(without).toContain('one of the three shipping states');
    expect(without).not.toContain('Values in this database');
    expect(changedLevers(parent, arm)).toEqual(['values']);
  });

  it('carries the measurement, not the question, in its on-demand note', () => {
    // An arm whose note still reads like a question is an arm nobody has measured, and the next
    // reader will treat the question as the verdict. `41302183201` answered it: substitutes.
    const note = ON_DEMAND_ARMS['metadata+evidence+values'] ?? '';
    expect(note).toContain('41302183201');
    expect(note).toMatch(/substitutes rather than complements/u);
    expect(note).not.toMatch(/until that artifact exists/u);
  });

  it('refuses a repair arm on which the repair path never fired', () => {
    // A switch that is on and never fires produces its parent's number under its own
    // name — the failure the retrieval arm already had once.
    const flat = Array.from({ length: 200 }, () => ({ attempts: 1 }));
    expect(() => assertRepairPathFired('inline+repair', flat)).toThrow(/did not run/);
    expect(() => assertRepairPathFired('inline+repair', [...flat.slice(1), { attempts: 2 }])).not.toThrow();
    // A small sample is exempt: on twenty questions the loop legitimately may not fire.
    expect(() => assertRepairPathFired('inline+repair', [{ attempts: 1 }])).not.toThrow();
  });

  it('refuses an arm whose candidates never arrived, which no case count can see', () => {
    // One candidate of three refused on every question: every case still answers, so the
    // case-level guard passes, and the ceiling falls for a reason that is not in the arm.
    type Lost = { candidateFailures?: { llm: number; engine: number; unparsed: number } };
    const thin: Lost[] = Array.from({ length: 100 }, () => ({ candidateFailures: { llm: 1, engine: 0, unparsed: 0 } }));
    expect(() => assertCandidateSurvival('select-cross', thin, 3)).toThrow(/never arrived/);
    // Under the outage threshold it is noise, not an outage.
    const sparse: Lost[] = [...thin.slice(0, 25), ...Array.from({ length: 75 }, () => ({}))];
    expect(() => assertCandidateSurvival('select-cross', sparse, 3)).not.toThrow();
    // ...and the message says how many of how many, not just a share.
    expect(() => assertCandidateSurvival('select-cross', thin, 3)).toThrow(/100 of 300 candidates \(33.3%\)/);
  });

  it('refuses an empty arm on which the empty-result turn never fired', () => {
    const quiet = Array.from({ length: 200 }, () => ({ emptyRetried: false, emptyDropped: 0 }));
    expect(() => assertEmptyRetryFired('select-mixed+empty', quiet as never)).toThrow(/the lever did not run/);
    // A drop alone is the lever working: it is the half that costs nothing.
    expect(() =>
      assertEmptyRetryFired('select-mixed+empty', [...quiet.slice(1), { emptyRetried: false, emptyDropped: 2 }] as never),
    ).not.toThrow();
    // ...and a turn is the other half.
    expect(() =>
      assertEmptyRetryFired('select-mixed+empty', [...quiet.slice(1), { emptyRetried: true, emptyDropped: 0 }] as never),
    ).not.toThrow();
    // Twenty questions is not enough to insist: the lever legitimately may not fire.
    expect(() => assertEmptyRetryFired('select-mixed+empty', [{ emptyRetried: false }] as never)).not.toThrow();
  });

  it('drops only the candidates that cannot be right, and only while something is left', () => {
    const empty = { sql: 'SELECT 1 WHERE 0', rows: [] as readonly unknown[][], source: 'a' };
    const rows = { sql: 'SELECT 1', rows: [[1]] as readonly unknown[][], source: 'b' };
    // The lever off: the selector sees everything, which is what its parent arm does.
    expect(offeredCandidates([rows, empty], false)).toEqual({ offered: [rows, empty], dropped: 0 });
    // The lever on: an option that returned nothing is removed and counted.
    const dropped = offeredCandidates([rows, empty], true);
    expect(dropped.offered).toEqual([rows]);
    expect(dropped.dropped).toBe(1);
    // When every candidate is empty there is nothing to choose, so nothing is dropped —
    // an empty offer would read as a selector failure instead of an empty result.
    expect(offeredCandidates([empty], true)).toEqual({ offered: [empty], dropped: 0 });
  });

  it('prices the empty-result lever by its reach and its yield', () => {
    const runs = [
      {
        emptyRetried: true,
        emptyRecovered: true,
        emptyDropped: 1,
        emptyProbe: { queries: 3, literalGaps: 2, grounded: true, adoptedFree: false },
        predicted: '',
        reason: 'values',
        strict: false,
        id: '1',
        passed: false,
        calls: 5,
      },
      {
        emptyRetried: false,
        emptyDropped: 2,
        emptyProbe: { queries: 2, literalGaps: 1, grounded: true, adoptedFree: true },
        predicted: '',
        reason: 'values',
        strict: false,
        id: '2',
        passed: false,
        calls: 4,
      },
      { emptyRetried: false, emptyDropped: 0, predicted: '', reason: 'values', strict: false, id: '3', passed: true, calls: 4 },
    ];
    const funnel = emptyRetryFunnel(runs as never);
    expect(funnel).toEqual({
      dropped: 3,
      fired: 1,
      recovered: 1,
      // The lookup is priced apart from the call: two of the three cases were probed, one of them
      // was answered by the grounded statement without spending the retry turn at all.
      literalGaps: 3,
      grounded: 2,
      adoptedFree: 1,
      probeQueries: 5,
      extraCallsPerCase: Number((1 / 3).toFixed(4)),
    });
  });

  it('prices the audit turn by its reach, its yield and its calls', () => {
    const runs = [
      { audit: { fired: true, named: 2, rewritten: true } },
      { audit: { fired: true, named: 0, rewritten: false } },
      { audit: { fired: true, named: 1, rewritten: false } },
    ];
    expect(auditFunnel(runs as never)).toEqual({ fired: 3, named: 3, rewritten: 1, extraCallsPerCase: 1 });
  });

  it('reports an audit that never ran as zeros rather than as an average', () => {
    // A case list with no audit record is an arm that did not spend the call. Reading that as
    // "0 conditions named per case" would make a broken arm look like a complete audit.
    expect(auditFunnel([])).toEqual({ fired: 0, named: 0, rewritten: 0, extraCallsPerCase: 0 });
    expect(auditFunnel([{ audit: undefined }, { audit: undefined }] as never)).toEqual({
      fired: 0,
      named: 0,
      rewritten: 0,
      extraCallsPerCase: 0,
    });
  });

  it('rounds the per-case call count to two places', () => {
    const runs = Array.from({ length: 3 }, (_, index) => ({ audit: { fired: index < 1, named: 0, rewritten: false } }));
    expect(auditFunnel(runs as never).extraCallsPerCase).toBe(0.33);
  });

  it('refuses an audit arm whose turn never fired over a real sample', () => {
    const runs = Array.from({ length: 100 }, () => ({ audit: undefined }));
    expect(() => assertAuditFired('inline+evidence+audit', runs as never)).toThrow(/never fired.*lever did not run/);
  });

  it('accepts a sample too small to say anything about', () => {
    // The same threshold the other asserts use: a three-case smoke run cannot say a mechanism
    // is absent, and refusing it would make every local experiment fail for the wrong reason.
    expect(() => assertAuditFired('inline+evidence+audit', [] as never)).not.toThrow();
  });

  it('accepts an audit arm whose turn fired at least once', () => {
    const runs = [
      { audit: { fired: false, named: 0, rewritten: false } },
      { audit: { fired: true, named: 0, rewritten: false } },
    ];
    expect(() => assertAuditFired('inline+evidence+audit', runs as never, 2)).not.toThrow();
  });

  /**
   * The projection rule is one line and one lever, and this is the test that says so.
   *
   * The failure it prevents is a rule that arrives as part of a second change — the arm reads
   * `projection: 'asked'`, and the prompt it renders also differs in its card, its notes or its
   * call count. Then a delta in `column-count` cannot be attributed to the sentence, which is the
   * only thing the experiment was for.
   */
  it('keeps the projection pair one lever apart, and puts the rule in the prompt', () => {
    const parent = ARMS.find((arm) => arm.name === 'inline+evidence') as Arm;
    const projection = ARMS.find((arm) => arm.name === 'inline+evidence+projection') as Arm;
    expect(parent.projection).toBeUndefined();
    expect(projection.projection).toBe('asked');
    expect({ ...projection, projection: undefined, name: parent.name }).toEqual(parent);
    expect(PAIRS).toContainEqual(['inline+evidence', 'inline+evidence+projection']);
    // Declared is not rendered: the parent's prompt must not carry the line, and the arm's must
    // end with it. Both directions, because a rule appended to every prompt is not a lever.
    const sent = promptFor(projection, question).notes ?? [];
    const unsent = promptFor(parent, question).notes ?? [];
    expect(sent).toContain(PROJECTION_RULE);
    expect(unsent).not.toContain(PROJECTION_RULE);
    expect(sent[sent.length - 1]).toBe(PROJECTION_RULE);
  });

  it('asks for exactly the columns the question names, in both directions', () => {
    // The bucket this rule is aimed at is two-sided — too many columns and too few are the same
    // shape — so a rule that only shortened answers would move cases inside the bucket and report
    // the movement as a fix. The text therefore says *which* columns, and the two assertions are
    // about the two words that do that work.
    expect(PROJECTION_RULE).toContain('exactly the columns the question asks for');
    expect(PROJECTION_RULE).toContain('in the order it names them');
    expect(PROJECTION_RULE).not.toMatch(/\bfewer\b/);
  });

  it('keeps the audit arm one lever from its parent, and out of the chain', () => {
    const parent = ARMS.find((arm) => arm.name === 'inline+evidence') as Arm;
    const audit = ARMS.find((arm) => arm.name === 'inline+evidence+audit') as Arm;
    expect(parent.audit).toBeUndefined();
    expect(audit.audit).toBe('conditions');
    expect({ ...audit, audit: undefined, name: parent.name }).toEqual(parent);
    // The arm still exists and is still one lever, and it left the chain on the dev split's own
    // reading (+1.2pp for 2x calls and 2.3x completion tokens, p = 0.48). The pair went with it:
    // a pair naming an arm a split does not run promises a reading nobody can take, which is the
    // condition `check-bird-baseline` refuses.
    expect(DEFAULT_ARMS).not.toContain('inline+evidence+audit');
    expect(ON_DEMAND_ARMS['inline+evidence+audit']).toMatch(/\+1\.2pp/);
    expect(PAIRS).not.toContainEqual(['inline+evidence', 'inline+evidence+audit']);
  });

  /**
   * Every arm that declares the empty-result lever must be run by an end-to-end test.
   *
   * The defect this prevents has happened twice: `inline+evidence+empty` was declared, paired
   * and filed, and its switch never reached the mechanism; `select-mixed+empty-blind` was
   * declared, named in three documents and executed by nothing at all. A catalogue entry is not
   * evidence that a lever runs, and the funnel assertions inside those tests are the only place
   * that says "this arm fired". The check is textual on purpose — it reads the test file as the
   * artifact it is, and a rename that breaks the match is a rename that lost the coverage.
   */
  it('runs every arm that declares the empty-result lever', () => {
    const source = readFileSync(resolve('test/bird-run-e2e.test.ts'), 'utf8');
    const declared = ARMS.filter((arm) => arm.emptyRetry !== undefined).map((arm) => arm.name);
    expect(declared.length).toBeGreaterThan(3);
    expect(declared.filter((name) => !source.includes(`'${name}'`))).toEqual([]);
  });

  it('keeps the empty-result pair one lever apart, in both directions', () => {
    const parent = ARMS.find((arm) => arm.name === 'select-mixed') as Arm;
    const diagnosed = ARMS.find((arm) => arm.name === 'select-mixed+empty') as Arm;
    const blind = ARMS.find((arm) => arm.name === 'select-mixed+empty-blind') as Arm;
    expect(parent.emptyRetry).toBeUndefined();
    expect(diagnosed.emptyRetry).toBe('diagnosed');
    expect(blind.emptyRetry).toBe('blind');
    // Same candidates, same selector, same prompt stack: the only field that moves is
    // the one under test, so a delta cannot borrow from a second change.
    expect({ ...diagnosed, emptyRetry: undefined, name: parent.name }).toEqual(parent);
    expect({ ...blind, emptyRetry: 'diagnosed', name: diagnosed.name }).toEqual(diagnosed);
    expect(PAIRS).toContainEqual(['select-mixed', 'select-mixed+empty']);
    expect(PAIRS).toContainEqual(['select-mixed+empty-blind', 'select-mixed+empty']);
  });

  it('pairs the diagnosed repair with the raw one, at the same cost', () => {    // The comparison that decides whether the diagnosis earns its calls: same arms, same
    // budget, same prompt — only the text of the repair turn differs.
    const diagnosed = ARMS.find((arm) => arm.name === 'inline+repair') as Arm;
    const raw = ARMS.find((arm) => arm.name === 'inline+repair-raw') as Arm;
    expect(diagnosed.repairFeedback).toBeUndefined();
    expect(raw.repairFeedback).toBe('raw');
    expect({ ...raw, repairFeedback: undefined, name: diagnosed.name }).toEqual(diagnosed);
    expect(PAIRS).toContainEqual(['inline+repair-raw', 'inline+repair']);
  });

  it('pairs the repair arm with the best prompt stack, one lever apart', () => {
    const repair = ARMS.find((arm) => arm.name === 'inline+repair') as Arm;
    const parent = ARMS.find((arm) => arm.name === 'inline+evidence') as Arm;
    expect(repair.repairs).toBe(3);
    expect(parent.repairs).toBe(0);
    // Everything except the repair budget must be identical, or the delta prices the
    // prompt as well as the loop.
    expect({ ...repair, repairs: 0, name: parent.name }).toEqual(parent);
    expect(PAIRS).toContainEqual(['inline+evidence', 'inline+repair']);
  });

  it('states a reason for every arm it defers', () => {
    for (const [name, reason] of Object.entries(ON_DEMAND_ARMS)) {
      expect(reason.length, name).toBeGreaterThan(20);
    }
  });

  it('keeps the baseline expecting exactly the arms the chain runs', () => {
    // The gate can only notice an arm that vanished if the baseline knows the arm
    // should be there. These two lists drifting apart is how an arm becomes
    // invisible again.
    const baseline = JSON.parse(readFileSync(resolve(process.cwd(), 'eval/baseline/bird.json'), 'utf8')) as {
      expectedArms: string[];
      floors: Record<string, Record<string, number>>;
    };
    expect([...baseline.expectedArms].sort()).toEqual([...DEFAULT_ARMS].sort());
    // A floor may name any arm in the catalogue, not only an arm in the default chain: the
    // dev split carries a floor for `select-cross`, which is on-demand because it needs a
    // second model. Tying floors to the chain made that floor fail the build, which is the
    // same one-split's-configuration mistake the `armsBySplit` field was added to stop.
    const catalogue = ARMS.map((arm) => arm.name);
    for (const [split, floors] of Object.entries(baseline.floors as Record<string, Record<string, number>>)) {
      for (const name of Object.keys(floors)) expect(catalogue, `${split}/${name}`).toContain(name);
    }
    for (const [split, arms] of Object.entries((baseline as { armsBySplit?: Record<string, string[]> }).armsBySplit ?? {})) {
      for (const name of arms) expect(catalogue, `${split}/${name}`).toContain(name);
    }
  });
});

describe('A/A pairs', () => {
  it('refuses a table where every call was rejected by the provider', () => {
    // A dead key or an empty balance arrives as "nothing came back", which scores as
    // a wrong answer: 0% is then a number that hides an outage.
    expect(() => assertArmProducedResults('names', [{ errorKind: 'llm', error: 'llm returned 402' }])).toThrow(/run that did not happen/);
    expect(() => assertArmProducedResults('names', [{ errorKind: 'llm' }, { errorKind: 'execution' }])).not.toThrow();
    expect(() => assertArmProducedResults('names', [{}])).not.toThrow();
    expect(() => assertArmProducedResults('names', [])).not.toThrow();
  });

  it('refuses a run where a tenth of the cases were throttled away', () => {
    // Partial rate limiting is worse than an outage: the table looks like a result.
    expect(() =>
      assertFailureRate('names', Array.from({ length: 10 }, () => ({ errorKind: 'llm', error: 'llm returned 429' }))),
    ).toThrow(/outage \(first error: llm returned 429\)/);
    expect(() => assertFailureRate('names', [{ errorKind: 'llm' }, ...Array.from({ length: 19 }, () => ({}))])).not.toThrow();
    expect(() => assertFailureRate('names', [{ errorKind: 'execution' }, { errorKind: 'guard' }])).not.toThrow();
  });

  it('refuses a report where two arms share a label', () => {
    expect(() => assertUniqueArmLabels(['names', 'inline+evidence', 'inline+evidence'])).toThrow(/#2 name/);
    expect(() => assertUniqueArmLabels(['names', 'inline+evidence', 'inline+evidence#2'])).not.toThrow();
  });

  it('appends the duplicate under a distinct name', () => {
    const arms = parseArms(undefined, 'inline+evidence', DEFAULT_ARMS);
    expect(arms).toEqual([...DEFAULT_ARMS, 'inline+evidence#2']);
    expect(new Set(arms).size).toBe(arms.length);
  });

  it('adds nothing when no A/A arm is asked for', () => {
    expect(parseArms(undefined, undefined, DEFAULT_ARMS)).toEqual([...DEFAULT_ARMS]);
    expect(parseArms(undefined, '  ', DEFAULT_ARMS)).toEqual([...DEFAULT_ARMS]);
  });

  it('respects an explicit arm list', () => {
    expect(parseArms('names, vote', 'names', DEFAULT_ARMS)).toEqual(['names', 'vote', 'names#2']);
  });

  it('resolves a duplicated name to the arm it duplicates', () => {
    // The A/A pair has to run the *same* configuration, or the delta it reports is
    // the difference between two arms rather than the harness's noise.
    expect(resolveArm('inline+evidence#2')).toEqual(ARMS.find((arm) => arm.name === 'inline+evidence'));
    expect(resolveArm('inline+evidence')).toEqual(ARMS.find((arm) => arm.name === 'inline+evidence'));
  });

  it('returns undefined for a name that is not an arm', () => {
    expect(resolveArm('not-an-arm#2')).toBeUndefined();
  });
});

describe('sample size', () => {
  it('scores the whole split when nothing is asked for, by declaring no size at all', () => {
    // `workflow_dispatch` passes an empty string for a blank input, and Number('') is 0: the dev
    // workflow would have scored nothing and divided by it. The answer used to be a copy of the
    // split's published size, and that copy was a row count — 500 for Mini-Dev's 498 questions —
    // so every push declared a request for two questions that do not exist and the floor gate
    // read it as a changed sample (run 41169457147). "All of it" is the absence of a number.
    expect(parseLimit(undefined)).toBeUndefined();
    expect(parseLimit('')).toBeUndefined();
    expect(parseLimit('   ')).toBeUndefined();
  });

  it('refuses a value that is not a whole number of questions', () => {
    // A silent fallback is the same defect in a quieter form: the run publishes a sample size
    // nobody chose, under a flag that says it chose one.
    expect(() => parseLimit('0')).toThrow(/not a question count/);
    expect(() => parseLimit('-5')).toThrow(/not a question count/);
    expect(() => parseLimit('abc')).toThrow(/not a question count/);
    expect(() => parseLimit('12.9')).toThrow(/not a question count/);
  });

  it('honours a real cap', () => {
    expect(parseLimit('120')).toBe(120);
  });
});

describe('the sample size a split can hold', () => {
  it('takes every question of the split when no size was declared', () => {
    expect(resolveLimit(undefined, 498)).toBe(498);
  });

  it('keeps a declared size that the split can hold', () => {
    expect(resolveLimit(25, 498)).toBe(25);
    expect(resolveLimit(498, 498)).toBe(498);
  });

  it('refuses a declaration larger than the split rather than clamping it', () => {
    // Clamping would publish a smaller sample under the number the caller declared, and
    // `selection.requested` is meant to be readable as a declaration.
    expect(() => resolveLimit(500, 498)).toThrow(/more questions than this split holds \(498\)/);
  });
});

describe('pinned definitions', () => {
  const dirs: string[] = [];
  const write = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'nl2charts-pin-'));
    dirs.push(dir);
    const path = join(dir, 'definitions.json');
    writeFileSync(path, body);
    return path;
  };

  it('reads the committed pin, one entry per database', () => {
    const pinned = readPinnedDefinitions(join(process.cwd(), 'eval/baseline/definitions.minidev.json'));
    expect(pinned).toBeDefined();
    // The eleven databases under test. A pin that covers only some of them would
    // throw at run time, which is the point — but it is cheaper to fail here.
    expect(pinned?.size).toBe(11);
    for (const [db, text] of pinned ?? []) expect(text.length, db).toBeGreaterThan(0);
  });

  it('returns nothing when there is no pin', () => {
    expect(readPinnedDefinitions(join(tmpdir(), 'no-such-pin.json'))).toBeUndefined();
  });

  it('refuses an empty pin instead of falling back to generating', () => {
    // A silent fallback restores the drift the pin exists to remove.
    expect(() => readPinnedDefinitions(write(JSON.stringify({ definitions: {} })))).toThrow(/regenerate/);
    expect(() => readPinnedDefinitions(write(JSON.stringify({ model: 'x' })))).toThrow(/regenerate/);
  });
});

/**
 * `attempts` counts generations for a repair arm and samples for a voting arm, so a
 * report that reads it as "did the repair loop run" tells the truth on one arm and a
 * fiction on the other. The published table said `select5 repaired 496` — an arm with no
 * repair loop — which is exactly the column a reader uses to decide whether the loop is
 * worth its calls.
 */
describe('repair accounting', () => {
  /** A case whose ledger records the retry turn, which is the only honest source for it. */
  const withRetry = (calls: number): { tokens: { byPurpose: Record<string, { calls: number }> } } => ({
    tokens: { byPurpose: calls === 0 ? { generate: { calls: 3 } } : { generate: { calls: 3 }, retry: { calls } } },
  });

  it('counts the cases that spent a retry turn', () => {
    const arm = resolveArm('inline+repair');
    expect(arm).toBeDefined();
    const runs = [withRetry(0), withRetry(1), withRetry(2), withRetry(0)];
    expect(repairAccounting(arm as Arm, runs)).toEqual({ repaired: 2 });
  });

  it('reads the retry turn rather than `attempts` on an arm that also votes', () => {
    // The defect this covers published `repaired: 0` for an arm that spent eleven retry calls in
    // one 600-question run, because a voting arm's `attempts` is its sample count and never rises
    // above the vote. A column that is present and false is worse than a missing one.
    const arm = resolveArm('select-cross-repair-all');
    expect(arm).toBeDefined();
    const runs = [withRetry(1), withRetry(0), withRetry(2)];
    expect(repairAccounting(arm as Arm, runs)).toEqual({ repaired: 2, samples: 3 });
  });

  it('reports samples, and no repair count, on an arm that only samples', () => {
    const arm = resolveArm('select5');
    expect(arm).toBeDefined();
    const runs = [withRetry(0), withRetry(0), withRetry(0)];
    const accounting = repairAccounting(arm as Arm, runs);
    expect(accounting).toEqual({ samples: 5 });
    // The bug was the key existing, not its value: `repaired: undefined` would still
    // render as a column a reader could mistake for zero repairs.
    expect('repaired' in accounting).toBe(false);
  });

  it('reports nothing at all on a single-shot arm', () => {
    const arm = resolveArm('inline+evidence');
    expect(arm).toBeDefined();
    const accounting = repairAccounting(arm as Arm, [withRetry(0), withRetry(0)]);
    expect(accounting).toEqual({});
    expect('repaired' in accounting).toBe(false);
    expect('samples' in accounting).toBe(false);
  });

  it('agrees with the arms catalogue, so no arm can be mislabelled', () => {
    // Every arm that declares a repair loop must be able to produce a repaired count,
    // and every arm that declares votes must produce a sample count.
    for (const arm of ARMS) {
      const accounting = repairAccounting(arm, [withRetry(1)]);
      expect('repaired' in accounting, arm.name).toBe(arm.repairs > 0 || arm.sourceRepairs !== undefined);
      expect('samples' in accounting, arm.name).toBe((arm.vote ?? 1) > 1);
    }
  });
});

/**
 * A selector's score is unreadable without its ceiling.
 *
 * `select5` returning 58.8% says nothing about whether the five candidates contained a
 * correct statement — the set could have been empty of correct answers or full of them
 * with the selector discarding one. Those two readings imply opposite next steps, so the
 * ceiling is measured on the same cases at no extra cost and reported beside the score.
 */
describe('candidate ceiling', () => {
  it('counts the questions the candidate set answered, not the ones the arm returned', () => {
    const ceiling = candidateCeiling([
      { passed: true, candidateRecall: true },
      { passed: false, candidateRecall: true },
      { passed: true, candidateRecall: true },
      { passed: false, candidateRecall: false },
      { passed: false, candidateRecall: false },
    ]);
    expect(ceiling.candidateRecall).toBe(3);
    expect(ceiling.candidateRecallShare).toBeCloseTo(0.6, 6);
    // The arm scored 2/5 and the set held 3/5: exactly one question is pure selection loss.
    expect(ceiling.selectionLoss).toBe(1);
  });

  it('reports zero rather than NaN on an empty arm', () => {
    expect(candidateCeiling([])).toEqual({ candidateRecall: 0, candidateRecallShare: 0, selectionLoss: 0 });
  });

  it('never counts a loss on a question the arm got right', () => {
    const ceiling = candidateCeiling([{ passed: true, candidateRecall: false }]);
    // The candidate marker is written by the same judge as the pass, so this combination
    // is a bug upstream; the count must not silently become "1 loss" and inflate the
    // apparent headroom of a better selector.
    expect(ceiling.selectionLoss).toBe(0);
    expect(ceiling.candidateRecall).toBe(0);
  });
});

/**
 * The mixed arm buys a second opinion with the same three calls.
 *
 * Its whole claim is that three *different* decompositions beat three samples of one.
 * That claim only holds if a candidate is one generation: a source that repairs or
 * samples would spend unbounded calls inside a candidate the arm counts as one.
 */
describe('mixed candidate sources', () => {
  it('resolves, and each source generates exactly one statement', () => {
    expect(() => assertMixedSources()).not.toThrow();
    expect(MIXED_SOURCES.length).toBeGreaterThanOrEqual(2);
    for (const source of MIXED_SOURCES) {
      const arm = resolveArm(source);
      expect(arm, source).toBeDefined();
      expect(arm?.repairs, source).toBe(0);
      expect(arm?.vote, source).toBeUndefined();
    }
  });

  it('refuses a source that repairs, because the candidate would cost more than one call', () => {
    expect(() => assertMixedSources(['inline+evidence', 'inline+repair'])).toThrow(/one statement/);
  });

  it('refuses a source that samples', () => {
    expect(() => assertMixedSources(['inline+evidence', 'select5'])).toThrow(/one statement/);
  });

  it('refuses a name that is not an arm', () => {
    expect(() => assertMixedSources(['inline+evidence', 'not-an-arm'])).toThrow(/not an arm/);
  });

  it('refuses a set of one, which is not a set', () => {
    expect(() => assertMixedSources(['inline+evidence'])).toThrow(/at least two/);
  });

  it('puts the decomposition rules in the prompt the report measures', () => {
    // The arm's size column and the distinct-prompt count both read `promptFor`, so a
    // switch that only reached the pipeline would report a prompt the run never sent.
    const arm = resolveArm('decompose') as Arm;
    const rendered = buildSqlPrompt(question.question, [{ table: 'orders', columns: [{ name: 'id', type: 'INTEGER' }] }], promptFor(arm, question));
    expect(rendered).toContain('STEP <n>');
    // The parent renders the same prompt without them, which is the comparison.
    const parent = buildSqlPrompt(question.question, [{ table: 'orders', columns: [{ name: 'id', type: 'INTEGER' }] }], promptFor(resolveArm('inline+evidence') as Arm, question));
    expect(parent).not.toContain('STEP <n>');
    expect(changedLevers(resolveArm('inline+evidence') as Arm, arm)).toEqual(['decompose']);
  });

  it('puts the stored values on the card the report measures', () => {
    // The lever is only real if the rendered prompt changes: `promptFor` sets the switch and
    // `schemaFor` supplies the values, and an arm where one of the two landed would score
    // like its parent and read like a finding.
    const arm = resolveArm('inline+evidence+samples') as Arm;
    const schema = [
      { table: 'orders', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'status', type: 'TEXT' }] },
    ];
    const options = promptFor(arm, question);
    expect(options.samples).toBe(true);
    expect(buildSqlPrompt(question.question, schema, options)).not.toContain('[Banned|Active]');
    const withValues = schema.map((table) => ({
      ...table,
      columns: table.columns.map((column) => (column.name === 'status' ? { ...column, samples: ['Banned', 'Active'] } : column)),
    }));
    expect(buildSqlPrompt(question.question, withValues, options)).toContain('[Banned|Active]');
    // The parent renders it without, which is the comparison the arm buys.
    const parent = promptFor(resolveArm('inline+evidence') as Arm, question);
    expect(parent.samples).toBe(false);
    expect(buildSqlPrompt(question.question, withValues, parent)).not.toContain('[Banned|Active]');
    expect(changedLevers(resolveArm('inline+evidence') as Arm, arm)).toEqual(['samples']);
  });

  it('narrows the block to the columns the gold statement filters on, and says so', () => {
    // The lever is one field: the sampler stays the profiler's, the values stay the profiler's,
    // and only the set of columns changes. Anything else would make the pair price two rules.
    const arm = resolveArm('inline+evidence+samples-gold') as Arm;
    expect(arm.samples).toBe('profile');
    expect(arm.sampleColumns).toBe('gold');
    // Its parent is the sampler, not the card without values. A pair against `inline+evidence`
    // would change the block's existence and its column set at once, which is how a 38pp
    // character cost gets attributed to "the block" instead of to "which columns it shows".
    expect(changedLevers(resolveArm('inline+evidence+samples') as Arm, arm)).toEqual(['sampleColumns']);
    // An oracle is a ceiling, and the catalogue has to say which one this is: the arm reads the
    // gold statement, so no realizable rule can be expected to match it, and a reader who took
    // its delta as an achievable one would plan work that cannot land.
    expect(ON_DEMAND_ARMS['inline+evidence+samples-gold']).toMatch(/gold/);
  });

  it('keeps only the fields the gold statement names, and changes nothing else', () => {
    // One field. The prompt, the hint, the call count and the definitions stay the parent's; the
    // card's *content* is the lever, which is what makes its delta a price for the linker rather
    // than a price for a smaller prompt.
    const arm = resolveArm('inline+evidence+card-gold') as Arm;
    expect(arm.cardColumns).toBe('gold');
    expect(changedLevers(resolveArm('inline+evidence') as Arm, arm)).toEqual(['cardColumns']);
    // An oracle is a ceiling: no rule that does not read the answer can reach it, and a reader who
    // planned against its delta as if it were achievable would be planning work that cannot land.
    expect(ON_DEMAND_ARMS['inline+evidence+card-gold']).toMatch(/gold/);
  });

  it('refuses a card decided by two rules', () => {
    // Three rules produce a card: the shipped linker's closure (`prune`), the model's choice
    // (`columnSelect`), and the gold's own fields. An arm declaring two of them publishes the delta
    // of whichever ran last, which reads as a measurement of one lever.
    const base = { name: 'both', cardColumns: 'gold' } as const;
    expect(() => assertCardRule({ ...base, prune: 1 })).toThrow(/prune/);
    expect(() => assertCardRule({ ...base, columnSelect: 'dense' })).toThrow(/columnSelect/);
    expect(() => assertCardRule(base)).not.toThrow();
    expect(() => assertCardRule({ name: 'plain', prune: 1 })).not.toThrow();
  });

  it('cuts a card down to the fields a statement reads, and counts what it removed', () => {
    const card = [
      { table: 'items', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }, { name: 'price', type: 'REAL' }] },
      { table: 'orders', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'qty', type: 'INTEGER' }] },
    ] as never;
    // A table the statement does not read is gone with its columns; a table it reads keeps only the
    // fields it names. `4` removed of `5` is what the guard reads as "the rule ran".
    const narrowed = narrowFields(card, 'select max(qty) from orders');
    expect(narrowed.schema.map((table) => table.table)).toEqual(['orders']);
    expect(narrowed.schema[0]?.columns.map((column) => column.name)).toEqual(['qty']);
    expect([narrowed.columns, narrowed.dropped]).toEqual([1, 4]);
    // A statement that names no column of the table it reads keeps the whole table: `count(*)` is
    // the common case, and a card stripped of the counted table cannot answer.
    const counted = narrowFields(card, 'select count(*) from items');
    expect(counted.schema.map((table) => table.table)).toEqual(['items']);
    expect(counted.schema[0]?.columns.length).toBe(3);
    expect(counted.dropped).toBe(2);
    // A statement that reads nothing keeps the card it was given, and says it removed nothing.
    const nothing = narrowFields(card, 'select 1');
    expect(nothing.schema).toBe(card);
    expect(nothing.dropped).toBe(0);
  });

  it('counts which decomposition won, including the ones that never did', () => {
    const counts = winnerSources([
      { winnerSource: 'inline+evidence' },
      { winnerSource: 'metadata+evidence' },
      { winnerSource: 'inline+evidence' },
    ]);
    // A generator missing from the report would look like a generator that was never
    // tried; zero is the number that says "tried, never won".
    expect(counts).toEqual({ 'inline+evidence': 2, 'metadata+evidence': 1, values: 0 });
  });
});

/**
 * The decomposition lever, which is a shape of generation rather than a budget.
 *
 * Two things have to hold for its delta to mean anything: the arm must actually ask for
 * a decomposition, and the model's reply must actually contain one. The second is
 * measured, not assumed — an instruction is one paragraph among many and a model that
 * skips it leaves an arm that is the parent with a longer prompt.
 */
/**
 * The third slot, and what a third opinion is worth when it stops being a restatement.
 *
 * Two things have to hold for this arm's delta to mean anything: it must cost what its parent
 * costs — a swap is a reading, a purchase is not — and the source it adds must be the one the
 * split measured, not a second copy of a prompt already in the set.
 */
describe('the third slot', () => {
  it('swaps one source and keeps the count, so the comparison is a swap and not a purchase', () => {
    const parent = resolveArm('select-mixed') as Arm;
    const child = resolveArm('select-samples') as Arm;
    expect(child.vote).toBe(parent.vote);
    expect(SAMPLED_SOURCES.slice(0, 2)).toEqual(MIXED_SOURCES.slice(0, 2));
    expect(SAMPLED_SOURCES).toContain('inline+evidence+samples');
    expect(SAMPLED_SOURCES).not.toContain('values');
    expect(changedLevers(parent, child)).toEqual(['mixed']);
  });

  it('keeps every source a single statement, so each candidate costs one call', () => {
    expect(() => assertMixedSources(SAMPLED_SOURCES)).not.toThrow();
    expect(SAMPLED_SOURCES.length).toBe(MIXED_SOURCES.length);
  });

  it('is offered on demand rather than in the chain, because one slot is a hypothesis', () => {
    expect(ON_DEMAND_ARMS['select-samples']).toContain('third slot');
    expect(DEFAULT_ARMS).not.toContain('select-samples');
    expect(DEV_ARMS).not.toContain('select-samples');
  });

  it('is registered as a pair against the arm it swaps a slot with', () => {
    expect(PAIRS.some(([left, right]) => left === 'select-mixed' && right === 'select-samples')).toBe(true);
  });
});

describe('the decomposition lever', () => {
  it('keeps the trio and adds one fourth source, so the comparison stays a superset', () => {
    expect(MIXED_DC_SOURCES.slice(0, MIXED_SOURCES.length)).toEqual(MIXED_SOURCES);
    expect(MIXED_DC_SOURCES.length).toBe(MIXED_SOURCES.length + 1);
    const arm = resolveArm('select-mixed+dc');
    expect(arm).toBeDefined();
    expect(arm?.vote).toBe(4);
    expect(arm?.select).toBe(true);
  });

  it('swaps the third slot at the same cost on the other arm', () => {
    // Same two prompts, same count, same four calls: the difference is which prompt holds the
    // third candidate, and the value index it replaces had an empty block on 60.9% of the split.
    const arm = resolveArm('select-dc') as Arm;
    expect(arm.vote).toBe(3);
    expect(DC_SOURCES.slice(0, 2)).toEqual(MIXED_SOURCES.slice(0, 2));
    expect(DC_SOURCES).toContain('decompose');
    expect(DC_SOURCES).not.toContain('values');
    expect(changedLevers(resolveArm('select-mixed') as Arm, arm)).toEqual(['mixed']);
  });

  it('is one lever from its parent: the candidate set, and nothing else', () => {
    const parent = resolveArm('select-mixed') as Arm;
    const child = resolveArm('select-mixed+dc') as Arm;
    // `vote` moves with it because the candidate count is the source list's length; the
    // helper discounts it exactly where the suite pins that equality.
    expect(changedLevers(parent, child)).toEqual(['mixed']);
    expect(child.vote).toBe(4);
    expect(parent.vote).toBe(3);
  });

  it('asks for a decomposition on the arm itself and on any arm that names it', () => {
    expect(declaresDecomposition({ decompose: true })).toBe(true);
    expect(declaresDecomposition({ mixed: DC_SOURCES })).toBe(true);
    expect(declaresDecomposition({ mixed: MIXED_SOURCES })).toBe(false);
    expect(declaresDecomposition({})).toBe(false);
  });

  it('counts the cases that asked, not the cases that ran', () => {
    // A candidate that never arrived asked for nothing; folding those into the share
    // would blame the prompt for the endpoint.
    const runs = [
      { decomposition: { candidates: 1, steps: 3 } },
      { decomposition: { candidates: 1, steps: 0 } },
      { candidateFailures: { llm: 1, engine: 0, unparsed: 0 } },
    ];
    expect(decompositionFunnel(runs as never)).toEqual({ asked: 2, fired: 1, share: 0.5, meanSteps: 1.5 });
  });

  it('refuses an arm whose prompt never asked for a decomposition', () => {
    const quiet = Array.from({ length: 120 }, () => ({ calls: 1 }));
    expect(() => assertDecompositionFired('select-mixed+dc', quiet as never)).toThrow(/never asked to decompose/);
  });

  it('refuses an arm where the model ignored the format', () => {
    // Half the cases carrying no steps is the line: below it the arm is a longer prompt,
    // and its delta would be published as a finding about decomposition.
    const ignored = Array.from({ length: 120 }, () => ({ decomposition: { candidates: 1, steps: 0 } }));
    expect(() => assertDecompositionFired('select-mixed+dc', ignored as never)).toThrow(/measured decomposition rather than a longer prompt/);
    // One step per case is a model that labels its answer, not one that decomposes.
    const labelled = Array.from({ length: 120 }, () => ({ decomposition: { candidates: 1, steps: 1 } }));
    expect(() => assertDecompositionFired('select-mixed+dc', labelled as never)).toThrow(/1 steps per case/);
  });

  it('accepts a model that decomposes most questions and answers the rest directly', () => {
    const runs = [
      ...Array.from({ length: 80 }, () => ({ decomposition: { candidates: 1, steps: 3 } })),
      ...Array.from({ length: 20 }, () => ({ decomposition: { candidates: 1, steps: 0 } })),
    ];
    expect(() => assertDecompositionFired('select-mixed+dc', runs as never)).not.toThrow();
  });

  it('stays quiet on a sample too small to judge', () => {
    expect(() =>
      assertDecompositionFired('select-mixed+dc', Array.from({ length: 20 }, () => ({ decomposition: { candidates: 1, steps: 0 } })) as never),
    ).not.toThrow();
  });
});

/**
 * A mixed arm's candidate count is the length of its source list.
 *
 * The two are declared in different fields, so a mismatch is a false price rather than a
 * crash: an arm that names three sources and declares two candidates would spend three
 * generations and report two. The pair is checked for every mixed arm in the catalogue.
 */
describe('mixed arms declare their own sources', () => {
  const mixed = ARMS.filter((arm) => arm.mixed !== undefined);

  it('has at least the two arms under test', () => {
    expect(mixed.map((arm) => arm.name).sort()).toEqual(['select-balanced', 'select-cross', 'select-cross-agree', 'select-cross-canon', 'select-cross-empty', 'select-cross-judge', 'select-cross-judge-canon', 'select-cross-judge-reasoning', 'select-cross-pooled', 'select-cross-pooled-agree', 'select-cross-pooled-dissent', 'select-cross-pooled-dissent-pair', 'select-cross-pooled-judge-reasoning', 'select-cross-pooled-reconcile', 'select-cross-pooled-reconcile-novel', 'select-cross-pooled-vote', 'select-cross-repair-all', 'select-cross-repair-second', 'select-cross-shuffled', 'select-cross-unhinted', 'select-dc', 'select-duo', 'select-intent', 'select-mixed', 'select-mixed+agree', 'select-mixed+dc', 'select-mixed+empty', 'select-mixed+empty-blind', 'select-mixed+values', 'select-mixed-pooled', 'select-mixed-pooled-vote', 'select-mixed-rule', 'select-samples', 'select-tagged', 'vote-cross', 'vote-mixed']);
  });

  it.each(mixed.map((arm) => [arm.name, arm] as const))('%s: candidates equal sources, and every source generates once', (name, arm) => {
    expect(arm.vote, name).toBe(arm.mixed?.length);
    expect(() => assertMixedSources(arm.mixed)).not.toThrow();
  });

  it('keeps the duo strictly inside the trio, so the comparison is a subset', () => {
    // `select-duo` exists to price the third candidate; if it introduced a source the trio
    // does not have, the comparison would no longer be "the same prompts, one fewer".
    for (const source of DUO_SOURCES) expect(MIXED_SOURCES).toContain(source);
    expect(DUO_SOURCES.length).toBe(MIXED_SOURCES.length - 1);
  });
});

/**
 * A lever that no code reads is a lever that did not run.
 *
 * `reconcileAdopt` was written as a field, an arm and a pair before anything read it: the arm would
 * have run, its row would have looked right, its funnel plausible, and the only difference between it
 * and its parent would have been the name. Nothing else in this file can see that. TypeScript cannot
 * (the field is optional and the file compiles), `changes exactly one lever per pair` cannot (the two
 * arms genuinely differ), and the end-to-end suite cannot (both arms are self-consistent — the wrong
 * one is simply its parent).
 *
 * So the catalogue and the runner are read as text and asked a narrow question: is every field of an
 * arm referenced somewhere outside its own declaration? Narrow on purpose — a lever referenced only
 * by the report builder passes here, and the behavioural guarantee is the policy case in
 * `bird-run-e2e` — but it is the state the field was in when it was written, and it is the state a
 * copy-paste of an arm produces.
 */
describe('the catalogue and the runner agree about levers', () => {
  // The identity of an arm, not a lever: two arms whose names differ are not "one lever apart", and
  // `changedLevers` must not think they are. Everything else a reader can set on an arm is a lever.
  const NOT_LEVERS = new Set(['name']);
  const runner = readFileSync(resolve(process.cwd(), 'eval/bird/run.ts'), 'utf8');
  const declared = /export interface Arm \{([\s\S]*?)\n\}/.exec(runner);
  if (declared === null || declared.index === undefined) throw new Error('the Arm interface is not where this test reads it, so the test is blind');
  const inner = declared[1];
  if (inner === undefined) throw new Error('the Arm interface has no body this test can read, so the test is blind');
  const fields = [...inner.matchAll(/readonly (\w+)\??:/g)].map((match) => match[1] as string);
  // Everything outside the declaration itself, so a field's own line cannot count as a read of it.
  const body = runner.slice(0, declared.index) + runner.slice(declared.index + declared[0].length);
  const levers = fields.filter((field) => !NOT_LEVERS.has(field));

  it('lists every field of an arm as a lever, so a pair cannot hide a second change', () => {
    expect(levers.slice().sort()).toEqual([...LEVERS].sort());
  });

  it('names only fields the interface has, so `changedLevers` can see each of them', () => {
    const unknown = [...LEVERS].filter((lever) => !fields.includes(lever));
    expect(unknown, `LEVERS names ${unknown.join(', ')} and the Arm interface does not`).toEqual([]);
  });

  it('reads every lever somewhere in the runner', () => {
    // A member read, not a mention: `arm.notes`, `sourceArm.linking` and `target.shapeGuard` all
    // count, and the field's declaration (removed above) does not.
    const unread = levers.filter((lever) => !new RegExp(`\\.${lever}\\b`).test(body));
    expect(unread, `${unread.join(', ')} can be set on an arm and no code reads it`).toEqual([]);
  });
});

/**
 * The stratum join is a tool, and a tool that silently joins nothing would report an
 * empty table as a finding. Its self-test runs in CI; this pins the contract the report
 * has to satisfy for it to work at all.
 */
describe('per-case outcomes', () => {
  it('are recorded per arm and question, not only in aggregate', () => {
    // A total cannot be stratified, and the first question asked of this data was a
    // stratum: did the mixed arm win where its sources differed, or where one of them
    // was duplicated? Reading the runner is cheaper than re-running it to find out.
    const source = readFileSync(resolve(process.cwd(), 'eval/bird/run.ts'), 'utf8');
    expect(source).toContain('report.cases =');
    expect(source).toContain('degenerateIds');
  });
});

/**
 * A candidate's model is part of its identity.
 *
 * `@second` is a suffix rather than a second field so the arm table reads as a sentence,
 * which means the parser is the only thing standing between a typo and an arm that
 * silently generates two candidates while claiming three.
 */
describe('cross-model candidate sources', () => {
  it('reads the suffix and leaves plain names alone', () => {
    expect(parseMixedSource('inline+evidence')).toEqual({ arm: 'inline+evidence', provider: 'primary' });
    expect(parseMixedSource('inline+evidence@second')).toEqual({ arm: 'inline+evidence', provider: 'second' });
  });

  it('resolves a suffixed source to an arm that generates once', () => {
    expect(() => assertMixedSources(CROSS_SOURCES)).not.toThrow();
    for (const source of CROSS_SOURCES) {
      const parsed = parseMixedSource(source);
      const arm = resolveArm(parsed.arm);
      expect(arm, source).toBeDefined();
      expect(arm?.repairs, source).toBe(0);
      expect(arm?.vote, source).toBeUndefined();
    }
  });

  it('rejects a suffixed name that is not an arm', () => {
    // Without the parse the suffix would end up inside the lookup and fail with a less
    // useful message; with it, the name that failed is the one that was written.
    expect(() => assertMixedSources(['inline+evidence', 'not-an-arm@second'])).toThrow(/not an arm/);
  });

  it('is one lever from the trio: same prompts, one of them from the other model', () => {
    const trio = MIXED_SOURCES.map((source) => source.replace('@second', ''));
    const cross = CROSS_SOURCES.map((source) => parseMixedSource(source).arm.replace('@second', ''));
    expect([...cross].sort()).toEqual([...trio].sort());
    expect(CROSS_SOURCES.filter((source) => parseMixedSource(source).provider === 'second')).toHaveLength(1);
  });
});

/**
 * A floor is a claim about three coordinates, not two.
 *
 * The baseline stated the split and the arms and left the model implicit, so `bird-model`
 * — the workflow whose whole purpose is another model — skipped the gate entirely, taking
 * the funnel, cost and empty-lever checks with it. A cross-model run therefore had no
 * structural gate at all, and nobody noticed because nothing was asked to notice.
 */
describe('the arms a dev run starts from', () => {
  /** The `default:` under the `arms:` input of a workflow, as the workflow would read it. */
  function defaultArms(file: string): string {
    const lines = readFileSync(resolve(process.cwd(), file), 'utf8').split('\n');
    const at = lines.findIndex((line) => line.trim() === 'arms:');
    expect(at, `${file} has an arms input`).toBeGreaterThan(-1);
    for (const line of lines.slice(at + 1)) {
      const match = /^\s+default: '([^']*)'/.exec(line);
      if (match !== null) return match[1] as string;
      if (/^\s+[a-z_]+:$/.test(line)) break;
    }
    throw new Error(`${file} declares an arms input with no default`);
  }

  it('is one list, and the workflow quotes it rather than keeping a second copy', () => {
    // The workflow had its own default and the baseline had another, so "which arms does a dev
    // run measure" had two answers that no check compared. Now the YAML quotes `DEV_ARMS` and
    // this test is what makes the quote binding.
    expect(defaultArms('.github/workflows/bird-dev.yml')).toBe(DEV_ARMS.join(','));
  });

  it('is every arm the dev baseline names, less the ones that need a second model', () => {
    // The gap is derived rather than listed: an arm with an `@second` source cannot be in a
    // routine run, because the dispatch configures no second model by default.
    const baseline = JSON.parse(readFileSync(resolve(process.cwd(), 'eval/baseline/bird.json'), 'utf8')) as {
      armsBySplit?: Record<string, string[]>;
    };
    // "Needs a second model" is read from the arm, not from a third list: a mixed arm whose
    // sources name `@second` cannot run without one.
    const needsSecond = (name: string): boolean =>
      (resolveArm(name)?.mixed ?? []).some((source) => source.includes('@second'));
    const expected = (baseline.armsBySplit?.dev ?? []).filter((name) => !needsSecond(name));
    expect([...DEV_ARMS].sort()).toEqual([...expected].sort());
  });

  it('names only arms the catalogue holds, and every one of them a floor covers', () => {
    const catalogue = ARMS.map((arm) => arm.name);
    const baseline = JSON.parse(readFileSync(resolve(process.cwd(), 'eval/baseline/bird.json'), 'utf8')) as {
      floors: Record<string, Record<string, number>>;
    };
    for (const name of DEV_ARMS) {
      expect(catalogue, name).toContain(name);
      // An arm a dev run measures without a floor is an arm whose regression nothing notices.
      expect(Object.keys(baseline.floors.dev ?? {}), name).toContain(name);
    }
  });
});

describe('baseline coordinates', () => {
  const baseline = JSON.parse(readFileSync(resolve(process.cwd(), 'eval/baseline/bird.json'), 'utf8')) as {
    floors: Record<string, Record<string, number>>;
    recallFloors?: Record<string, Record<string, number>>;
    floorModel?: Record<string, string>;
    scoredBySplit?: Record<string, number>;
  };

  it('names the model behind every set of floors', () => {
    for (const split of Object.keys(baseline.floors)) {
      expect(baseline.floorModel?.[split], split).toBeTruthy();
    }
  });

  it('floors the ceiling only of an arm whose score is floored in the same split', () => {
    // A ceiling floor on an arm with no score floor guards a number that nothing else
    // compares against: the ceiling can fall, the note fires, and no verdict depends on it.
    // The pairing is the point — `select-prune` arrived with both in one pass, because the
    // arm it is a lever from carries both and a lever inherits the two halves of a score.
    for (const split of Object.keys(baseline.recallFloors ?? {})) {
      for (const name of Object.keys(baseline.recallFloors?.[split] ?? {})) {
        expect(Object.keys(baseline.floors?.[split] ?? {}), `${split}/${name}`).toContain(name);
      }
    }
  });

  it('states how many questions each floored split has, so a shrunken sample is caught', () => {
    // The check compared every split against Mini-Dev's 500, which made a dev run scoring
    // 600 of 1,532 questions look like a full sample.
    for (const split of Object.keys(baseline.floors)) {
      expect(baseline.scoredBySplit?.[split], split).toBeGreaterThan(0);
    }
  });

  it('gates another model on structure rather than on an accuracy floor from DeepSeek', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/bird-model.yml'), 'utf8');
    // Both halves matter: without the gate step a cross-model run is unguarded, and without
    // the split input the only split it can guard is Mini-Dev.
    expect(workflow).toContain('pnpm gate:bird');
    expect(workflow).toContain('BIRD_SPLIT');
  });
});

/**
 * The judge is a variable, and it is the one that separates two explanations.
 *
 * Measured on the dev split: answers held only by the cross set — the statement the second
 * model wrote — were returned 47% of the time, while answers held only by the all-primary set
 * were returned 87%. Either the judge prefers statements that read like its own, or the second
 * model's correct statements are simply harder to recognise. Same candidates, same prompt,
 * different judge: the first explanation makes the asymmetry flip, the second does not.
 */
describe('judge swap', () => {
  const cross = resolveArm('select-cross');
  const judged = resolveArm('select-cross-judge');

  it('differs from the cross arm only in who judges', () => {
    expect(judged).toBeDefined();
    expect(judged?.judge).toBe('second');
    // Everything else identical: same sources, same count, same selector, same prompt stack.
    expect(judged?.mixed).toEqual(cross?.mixed);
    expect(judged?.vote).toBe(cross?.vote);
    expect(judged?.select).toBe(cross?.select);
    expect(judged?.definitions).toBe(cross?.definitions);
    expect(judged?.evidence).toBe(cross?.evidence);
    expect(cross?.judge).toBeUndefined();
  });

  it('is priced like the arm it copies: one judge call, counted', () => {
    // A judge swap does not add a call, it moves one — so the comparison stays about quality
    // rather than about budget.
    expect(judged?.repairs).toBe(0);
    expect(judged?.vote).toBe(3);
  });
});

/**
 * Authorship is the majority, and the majority is what wins a tie.
 *
 * `select-cross` is one second-model candidate and two primary ones; `select-balanced` is the
 * same three prompt styles with the counts reversed. Nothing else moves: same sources, same
 * count, same selector, same four calls. If the 21.5%-47% conversion of the second model's
 * exclusive answers is authorship bias, flipping the majority flips the asymmetry.
 */
describe('balanced authorship', () => {
  it('uses the same three prompts as the cross arm', () => {
    const strip = (sources: readonly string[]): string[] => sources.map((source) => source.replace('@second', '')).sort();
    expect(strip(BALANCED_SOURCES)).toEqual(strip(CROSS_SOURCES));
    expect(BALANCED_SOURCES.length).toBe(CROSS_SOURCES.length);
  });

  it('reverses which author holds the majority', () => {
    const count = (sources: readonly string[]): number => sources.filter((source) => source.endsWith('@second')).length;
    expect(count(CROSS_SOURCES)).toBe(1);
    expect(count(BALANCED_SOURCES)).toBe(2);
  });

  it('resolves, and every source still generates exactly one statement', () => {
    expect(() => assertMixedSources(BALANCED_SOURCES)).not.toThrow();
    expect(resolveArm('select-balanced')?.vote).toBe(BALANCED_SOURCES.length);
  });
});

/**
 * A bug in the runner is not a wrong answer, and it is not the provider's fault either.
 *
 * Every error that escaped the per-sample catch used to be recorded as `llm`, so a `TypeError`
 * in this file was reported as a throttled endpoint — the failure-share guard then blamed the
 * model, and the accuracy absorbed a defect. Three things follow from the split: the provider
 * keeps its own bucket, the harness gets one, and an arm with a harness error cannot publish.
 */
describe('escaped errors', () => {
  it('classifies by who threw: the provider or this file', () => {
    expect(escapeKind(Object.assign(new Error('429'), { code: 'NL2C_E_LLM_UNAVAILABLE' }))).toBe('llm');
    expect(escapeKind(Object.assign(new Error('bad json'), { code: 'NL2C_E_LLM_INVALID_RESPONSE' }))).toBe('llm');
    // Anything else — a TypeError, a missing field, a bug in the arm table — is ours.
    expect(escapeKind(new TypeError('x is not a function'))).toBe('harness');
    expect(escapeKind(Object.assign(new Error('engine'), { code: 'NL2C_E_ENGINE_FAILED' }))).toBe('harness');
    expect(escapeKind(undefined)).toBe('harness');
  });

  it('refuses to publish an arm that failed inside the harness', () => {
    expect(() => assertHarnessClean('names', [{ errorKind: 'llm' }, { errorKind: 'execution' }])).not.toThrow();
    expect(() => assertHarnessClean('names', [{ errorKind: 'harness', error: 'harness: x is not a function' }])).toThrow(/bug in the runner/);
  });

  it('does not let a harness bug inflate the provider failure share', () => {
    // Fifty harness errors in a hundred cases is a broken runner, not an outage; the outage
    // guard must stay quiet so the harness assertion is the one that speaks.
    const runs: { errorKind?: string; error?: string }[] = [
      ...Array.from({ length: 50 }, () => ({ errorKind: 'harness', error: 'harness: boom' })),
      ...Array.from({ length: 50 }, () => ({})),
    ];
    expect(() => assertFailureRate('names', runs)).not.toThrow();
  });
});

/**
 * The same tenth, read while the run is still spending calls.
 *
 * `assertFailureRate` is a verdict on a table, and a table only exists once every case has been
 * asked. That is the right shape for a guard and the wrong shape for a budget: `glm-4.6` spent
 * 496 calls and twenty-five minutes to produce a table whose first forty rows already said the
 * endpoint was refusing four calls in five. A verdict that arrives after the money is spent is a
 * post-mortem, not a guard.
 */
describe('the outage guard reads the run while it is still running', () => {
  it('seals the verdict exactly when a tenth of the whole split has failed', () => {
    // Not "a tenth of the calls so far": the table guard divides by the split, so an early refusal
    // that the table would have accepted is the one thing this rule must never produce.
    expect(outageDecided(0, 496)).toBe(false);
    expect(outageDecided(49, 496)).toBe(false);
    // 49.6 is a tenth of 496, so the fiftieth failure seals it — and the table guard would refuse
    // the finished run at exactly that count.
    expect(outageDecided(50, 496)).toBe(true);
    // A tenth of ten is one, and one of ten is not "above" ten percent.
    expect(outageDecided(1, 10)).toBe(false);
    expect(outageDecided(2, 10)).toBe(true);
    // A split with no cases never seals anything, and the number cannot depend on dividing by it.
    expect(outageDecided(1, 0)).toBe(false);
    expect(outageDecided(1, Number.NaN)).toBe(false);
  });

  it('stops at the call that seals it, with the sentence the table guard would have printed', () => {
    const breaker = createFailureBreaker('names', 496);
    for (let call = 0; call < 49; call += 1) {
      expect(breaker.observe({ errorKind: 'llm', error: 'llm returned 429' })).toBeNull();
    }
    const verdict = breaker.observe({ errorKind: 'llm', error: 'llm returned 429' });
    expect(verdict).toContain('stopped after 50 of 496 calls');
    // One sentence, shared: a run stopped early and a run judged afterwards must not describe the
    // same failure two ways, or the log reads as two different problems.
    expect(verdict).toContain('50 of 50 calls (100.0%) failed at the model');
    expect(verdict).toContain('above the 10% this harness treats as an outage');
    expect(verdict).toContain('first error: llm returned 429');
    expect(verdict).toContain('446 calls were not spent');
  });

  it('leaves the last call to the guard that has a better sentence for it', () => {
    // A one-case split has nothing to save by stopping, and `assertArmProducedResults` says what a
    // run that never reached the database is: "not an accuracy of zero". Stopping there would
    // replace that with a share of one, which reads as a throttle.
    const breaker = createFailureBreaker('names', 1);
    expect(breaker.observe({ errorKind: 'llm', error: 'llm returned 500' })).toBeNull();
    expect(breaker.verdict()).toBeNull();
  });

  it('counts only the provider, so a run of engine refusals is not stopped', () => {
    // `execution`, `guard`, `shape` and a harness bug are all output quality or this file's own
    // defect. Stopping on them would turn "the model writes bad SQL" into "the endpoint is down".
    const breaker = createFailureBreaker('names', 100);
    const kinds = ['execution', 'guard', 'shape', 'harness', undefined] as const;
    for (let call = 0; call < 100; call += 1) {
      expect(breaker.observe({ errorKind: kinds[call % kinds.length] })).toBeNull();
    }
    expect(breaker.verdict()).toBeNull();
  });

  it('says nothing at all when a healthy run finishes', () => {
    const breaker = createFailureBreaker('names', 496);
    for (let call = 0; call < 496; call += 1) expect(breaker.observe({})).toBeNull();
    expect(breaker.verdict()).toBeNull();
  });

  it('says the verdict once and keeps it', () => {
    // The pool asks `verdict()` before every case after the stop, so the second case to fail must
    // not compose a second sentence with the numbers of a later call.
    const breaker = createFailureBreaker('names', 20);
    expect(breaker.observe({ errorKind: 'llm', error: 'llm returned 429' })).toBeNull();
    expect(breaker.observe({ errorKind: 'llm', error: 'llm returned 429' })).toBeNull();
    expect(breaker.observe({ errorKind: 'llm', error: 'llm returned 429' })).toContain('stopped after 3 of 20 calls');
    expect(breaker.observe({ errorKind: 'llm', error: 'llm returned 429' })).toBeNull();
    expect(breaker.verdict()).toContain('stopped after 3 of 20 calls');
  });

  it('explains a timeout rather than blaming the key', () => {
    const breaker = createFailureBreaker('names', 100);
    for (let call = 0; call < 11; call += 1) breaker.observe({ errorKind: 'llm', error: 'request timed out' });
    const verdict = breaker.verdict();
    expect(verdict).toContain('BIRD_LLM_TIMEOUT_MS');
  });

  it('names a missing message instead of inventing one', () => {
    // A record with no `error` is what a run killed before the provider wrote anything looks like.
    const breaker = createFailureBreaker('names', 20);
    for (let call = 0; call < 3; call += 1) breaker.observe({ errorKind: 'llm' });
    expect(breaker.verdict()).toContain('first error: no error text');
  });

  it('counts the shapes of the failures, because one message out of sixteen is not a diagnosis', () => {
    // `42723786747` stopped with "first error: llm call timed out" over sixteen failures — and two
    // of the twenty-eight cases that landed had taken the full 300-second deadline, so the other
    // fourteen were not timeouts. The sentence named the wrong fault because it read only the first
    // message of sixteen. A tally is the cheapest thing that cannot be misled that way.
    // Interleaved so the verdict lands with both shapes in hand: the breaker seals the moment a
    // tenth of a hundred cases have failed, which is the eleventh failure.
    const breaker = createFailureBreaker('names', 100);
    for (let call = 0; call < 5; call += 1) {
      breaker.observe({ errorKind: 'llm', error: 'llm returned 400: invalid request' });
      breaker.observe({ errorKind: 'llm', error: 'llm call timed out' });
    }
    breaker.observe({ errorKind: 'llm', error: 'llm returned 400: invalid request' });
    const verdict = breaker.verdict() as string;
    expect(verdict).toContain('HTTP 400 × 6');
    expect(verdict).toContain('timeout × 5');
    // And the hint follows the shape: a 4xx is the endpoint refusing the request, which sends the
    // reader to the model name and the capability declaration rather than to the deadline.
    expect(verdict).toContain('BIRD_CAPABILITIES');
    expect(verdict).not.toContain('BIRD_LLM_TIMEOUT_MS');
  });

  it('exempts an empty table from the share guard rather than dividing by its length', () => {
    // A dry run and a run that stopped before the first case both hand this guard no rows, and a
    // share over no rows is a missing reading rather than a rate.
    expect(() => assertFailureRate('names', [])).not.toThrow();
    expect(outageDecided(1, 0)).toBe(false);
    expect(outageDecided(1, Number.NaN)).toBe(false);
    expect(failureTally([])).toBe('');
  });

  it('reads a failure shape from its own message, and says `other` when it cannot', () => {
    expect(failureLabel('llm call timed out')).toBe('timeout');
    expect(failureLabel('llm returned 429')).toBe('HTTP 429');
    expect(failureLabel('llm returned 400: bad')).toBe('HTTP 400');
    expect(failureLabel('llm response is not JSON')).toBe('not JSON');
    // A connection that never opened is not a refusal and not a timeout: it is the one shape that
    // sends the reader at the network rather than at the request.
    expect(failureLabel('llm endpoint unreachable')).toBe('unreachable');
    expect(failureLabel(undefined)).toBe('other');
    expect(failureTally(['a', 'a', 'b'].map((kind) => (kind === 'a' ? 'llm returned 500' : 'llm call timed out')))).toBe(
      'HTTP 500 × 2, timeout × 1',
    );
    // Equal counts are ordered by label, so two runs with the same tally print the same line.
    expect(failureTally(['llm call timed out', 'llm returned 429'])).toBe('HTTP 429 × 1, timeout × 1');
  });
});

/**
 * A guard about the split must not fire on a sample of it.
 *
 * The degeneracy check asks whether a candidate set can ever be three opinions. Its first
 * version asked that of whatever `BIRD_LIMIT` selected, so a five-question run whose questions
 * name no literal declared a correct arm broken and refused to start — the same
 * sample-standing-in-for-the-whole mistake it was written to catch.
 */
describe('mixed feasibility', () => {
  const sources = ['inline+evidence', 'metadata+evidence', 'values'];

  it('refuses a whole split where no question can build distinct prompts', () => {
    expect(() => assertMixedFeasible('select-mixed', sources, { distinct: [], degenerate: ['1', '2'] }, true)).toThrow(/no question/);
  });

  it('accepts a whole split with at least one distinct question', () => {
    expect(assertMixedFeasible('select-mixed', sources, { distinct: ['1'], degenerate: ['2'] }, true)).toBeUndefined();
  });

  it('reports a sampled run instead of failing it', () => {
    const note = assertMixedFeasible('select-mixed', sources, { distinct: [], degenerate: ['1', '2'] }, false);
    expect(note).toContain('sampled the split');
    // The count has to say what it is a count of, or the next reader takes it for the split.
    expect(note).toContain('0 of 2');
  });
});

/**
 * The guards below read a record that may carry no message.
 *
 * Every one of them says `run.error ?? 'no error text'`, and every existing test handed them
 * runs that had an `error`. The fallback is not decoration: it is what a run killed before the
 * provider wrote anything looks like, and the three guards that read it are the three that
 * decide whether a number gets published.
 */
describe('guards whose record carries no message', () => {
  it('names the missing error text instead of inventing one', () => {
    expect(() => assertArmProducedResults('names', [{ errorKind: 'llm' }, { errorKind: 'llm' }])).toThrow(/first error: no error text/);
    expect(() =>
      assertFailureRate('names', Array.from({ length: 10 }, () => ({ errorKind: 'llm' }))),
    ).toThrow(/first error: no error text/);
    expect(() => assertHarnessClean('names', [{ errorKind: 'harness' }, { errorKind: 'harness' }])).toThrow(/first: no error text/);
  });

  it('exempts an empty table from the share and the survival checks, not just from the outage one', () => {
    // A split with no cases is not an arm that failed; it is an arm that was not run, and the
    // share of zero cases is not a share (ADR-216).
    expect(() => assertFailureRate('names', [])).not.toThrow();
    expect(() => assertCandidateSurvival('select-cross', [], 3)).not.toThrow();
  });

  it('counts a run that never recorded a drop as zero drops', () => {
    // `emptyDropped` is written by the lever; a run from an arm without it must not turn the
    // funnel's sum into NaN, and must not be read as "the lever ran".
    const bare = Array.from({ length: 200 }, () => ({ emptyRetried: false }));
    expect(emptyRetryFunnel(bare as never)).toEqual({ dropped: 0, fired: 0, recovered: 0, literalGaps: 0, grounded: 0, adoptedFree: 0, probeQueries: 0, extraCallsPerCase: 0 });
    expect(() => assertEmptyRetryFired('select-mixed+empty', bare as never)).toThrow(/the lever did not run/);
  });

  it('reads a decomposition record that states no steps as a decomposition that did not fire', () => {
    // The record exists (the arm asked) but carries no counts: `asked` counts it, `fired` must
    // not, and a missing candidate count is one candidate, not zero.
    const runs = [{ decomposition: { steps: 3 } }, { decomposition: {} }];
    // Three steps over two cases that each declared no candidate count: the missing count is
    // one candidate, so the mean is 1.5 and not 3 or 0.
    expect(decompositionFunnel(runs as never)).toEqual({ asked: 2, fired: 1, share: 0.5, meanSteps: 1.5 });
    expect(decompositionFunnel([{ decomposition: {} }] as never)).toEqual({ asked: 1, fired: 0, share: 0, meanSteps: 0 });
  });
});

/**
 * The adaptive arm is the only one whose prompt is chosen per question.
 *
 * It is in the arm table and has never been run end to end (a full run costs four calls a
 * question), so its three branches — the profile lookup, the profile's own `descriptions`
 * and `foreignKeys`, and the notes block it adds — were all unexecuted. They are read here
 * through the same `promptFor` the runner and the prompt-size column both use.
 */
describe('the adaptive profile arm', () => {
  const question = {
    question_id: 1,
    db_id: 'shop',
    question: 'What is the ratio of orders paid in EUR?',
    evidence: '',
    SQL: 'select 1',
    difficulty: 'moderate' as const,
  };

  it('turns the schema-card descriptions off for a question whose shape dictates the notes', () => {
    const options = promptFor(resolveArm('adaptive') as Arm, question, {});
    expect(options.descriptions).toBe(false);
    expect(options.foreignKeys).toBe(false);
    expect(options.notes?.join(' ')).toContain('NULLIF');
  });

  it('answers a window question with window notes, not ratio ones', () => {
    const options = promptFor(resolveArm('adaptive') as Arm, { ...question, question: 'Rank the stores by revenue and show the previous month.' }, {});
    expect(options.notes?.join(' ')).toContain('window function');
    expect(options.notes?.join(' ')).not.toContain('NULLIF');
  });

  it('leaves an ordinary question with no notes and the descriptions on', () => {
    const options = promptFor(resolveArm('adaptive') as Arm, { ...question, question: 'How many orders are there?' }, {});
    expect(options.notes).toEqual([]);
    expect(options.descriptions).toBe(true);
    expect(options.foreignKeys).toBe(true);
  });

  it('reads the same profile for the distinct-prompt count as for the request', () => {
    // The size column and the distinct-prompt check both call `promptFor`, so a profile that
    // is chosen in one place and not the other would make two different questions look
    // identical — the drift this function was extracted to stop.
    const first = promptFor(resolveArm('adaptive') as Arm, question, {});
    const second = promptFor(resolveArm('adaptive') as Arm, { ...question, question: 'Rank the stores by revenue.' }, {});
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(second));
  });

  it('treats the dataset-subset placement as the inline one, descriptions included', () => {
    // `definitions: 'dataset-subset'` attaches the same sentences to the column line, so the
    // descriptions switch is part of that placement rather than a second lever.
    const subset = promptFor({ ...(resolveArm('names') as Arm), definitions: 'dataset-subset' }, question, {});
    expect(subset.descriptions).toBe(true);
  });
});

describe('the arms a run actually reads', () => {
  it('counts a mixed arm\'s sources, because it sends their prompts and not its own', () => {
    // The defect this exists for: the block loaders asked `BIRD_ARMS`, a mixed arm names its
    // sources only in `mixed`, and a source's block was therefore never loaded. `select-samples`
    // failed on its first real dispatch with three prompts that were two — the guard refusing the
    // run was correct, and the loader had asked the narrower question.
    const names = armsInEffect(['select-samples']).map((arm) => arm.name);
    expect(names).toContain('select-samples');
    expect(names).toContain('inline+evidence');
    expect(names).toContain('metadata+evidence');
    expect(names).toContain('inline+evidence+samples');
    // And the block is real: the source declares the sampler the arm does not.
    expect(resolveArm('select-samples')?.samples).toBeUndefined();
    expect(resolveArm('inline+evidence+samples')?.samples).toBe('profile');
  });

  it('names each arm once, however many times it is drawn on', () => {
    // `select-cross` draws one source twice (primary and second provider for the same arm), and a
    // duplicate would make the loaders do the same work twice while the report said two opinions.
    const names = armsInEffect(['select-cross']).map((arm) => arm.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => name === 'inline+evidence')).toHaveLength(1);
    // An A/A duplicate is one arm read twice, so it adds nothing to the effect.
    expect(armsInEffect(['select-mixed', 'select-mixed']).map((arm) => arm.name)).toEqual(armsInEffect(['select-mixed']).map((arm) => arm.name));
  });

  it('ignores a name that resolves to nothing, the way every other reader does', () => {
    expect(armsInEffect(['not-an-arm'])).toEqual([]);
    expect(armsInEffect(['not-an-arm', 'names']).map((arm) => arm.name)).toEqual(['names']);
  });

  it('is what the training-split question reads, so a mixed arm cannot hide a retrieval', () => {
    // No mixed arm retrieves today. The assertion is about the wiring rather than the catalogue:
    // the workflow's answer comes from the same set, so an arm that later mixes `inline+retrieval`
    // cannot be dispatched against a node with no `train.json`.
    expect(armsNeedRetrieval(['select-samples'])).toBe(false);
    expect(armsInEffect(['select-samples']).some((arm) => arm.demonstrations === true || arm.evidence === 'retrieved')).toBe(false);
  });
});

describe('which arms need the training split', () => {
  it('answers from the arm table, for the dispatches that read it and the ones that do not', () => {
    // The workflow asks this before it downloads 8.5 GB, and the answer has to be the arm table's —
    // a second copy of "which arms retrieve" in YAML is a second opinion about which arms exist.
    expect(armsNeedRetrieval(['names', 'inline+evidence', 'metadata+evidence'])).toBe(false);
    expect(armsNeedRetrieval(['inline+retrieval'])).toBe(true);
    expect(armsNeedRetrieval(['inline+icl'])).toBe(true);
    // The stacked arms are the ones this round's ceiling criterion is registered against, and they
    // are exactly the case a hand-written condition forgets: `evidence: 'dataset'` reads the hint,
    // so nothing about the evidence block says the training split is needed too.
    expect(armsNeedRetrieval(['metadata+evidence+icl'])).toBe(true);
    expect(armsNeedRetrieval(['inline+evidence+icl'])).toBe(true);
    expect(resolveArm('metadata+evidence+icl')?.evidence).toBe('dataset');
    // A name that resolves to nothing is not a `no`: the caller refuses rather than skipping.
    expect(armsNeedRetrieval(['not-an-arm'])).toBe(false);
    expect(resolveArm('not-an-arm')).toBeUndefined();
  });
});

describe('the workflow\'s one question before it fetches 8.5 GB', () => {
  it('answers from the arm table, including the chain a blank request resolves to', () => {
    // `pnpm bench:bird` with no `BIRD_ARMS` runs the chain, and the chain has read the training split
    // since `inline+icl` joined it. A blank answer here is the difference between a dispatch that
    // fetches and one that dies inside the harness an hour later.
    expect(requestedArms(undefined)).toEqual(DEFAULT_ARMS);
    expect(needsTrainingSplit(requestedArms(undefined))).toBe('yes');
    expect(needsTrainingSplit(requestedArms('names,metadata+evidence'))).toBe('no');
    expect(needsTrainingSplit(requestedArms('metadata+evidence,metadata+evidence+icl'))).toBe('yes');
  });

  it('refuses a name that is not an arm instead of answering `no`', () => {
    // A typo that skipped the fetch would surface as "need the BIRD training split" after the
    // minutes this step saves, which reads as a harness bug rather than as a misspelling.
    expect(() => needsTrainingSplit(['metadata+evidance+icl'])).toThrow(/is not an arm/);
  });

  it('writes one line, and nothing else, to the stream the workflow reads', () => {
    const lines: string[] = [];
    expect(main((line) => lines.push(line), { BIRD_ARMS: 'names' })).toBe(0);
    expect(lines).toEqual(['no']);
    // The caller substitutes this into `[ "$(...)" = "yes" ]`, so a second line would be a bug the
    // shell reports as a mismatch rather than as a stray line.
    expect(main((line) => lines.push(line), { BIRD_ARMS: 'inline+evidence+icl' })).toBe(0);
    expect(lines).toEqual(['no', 'yes']);
  });

  it('knows when it is the entry point, and only then does it exit with a code', () => {
    expect(isEntry(undefined, 'file:///x.ts')).toBe(false);
    expect(isEntry('/x.ts', 'file:///x.ts')).toBe(true);
    expect(isEntry('/y.ts', 'file:///x.ts')).toBe(false);
    // Imported: no exit code, so an unrelated runner keeps its own. Run: the code this module's
    // step turns into `success` or `failure`, and one line on the stream the shell reads.
    const lines: string[] = [];
    expect(entryExit('/y.ts', 'file:///x.ts', (line) => lines.push(line), { BIRD_ARMS: 'names' })).toBeUndefined();
    expect(lines).toEqual([]);
    expect(entryExit('/x.ts', 'file:///x.ts', (line) => lines.push(line), { BIRD_ARMS: 'names' })).toBe(0);
    expect(lines).toEqual(['no']);
  });
});

describe('the grounding funnel', () => {
  it('sums the substitutions and the refusals, and counts the cases the rewrite changed', () => {
    const runs = [
      { grounding: { substitutions: 1, refused: 0 } },
      { grounding: { substitutions: 0, refused: 1 } },
      { grounding: { substitutions: 2, refused: 0 } },
    ];
    expect(groundingFunnel(runs as never)).toEqual({ substitutions: 3, refused: 1, rewritten: 2, share: 0.6667 });
  });

  it('reports an arm with no reader as zeros rather than as an average', () => {
    // A case with no grounding record is an arm that asked no column; reading it as "zero
    // substitutions per case" would make a missing reader look like a corpus that spelled
    // everything right.
    expect(groundingFunnel([])).toEqual({ substitutions: 0, refused: 0, rewritten: 0, share: 0 });
    expect(groundingFunnel([{ grounding: undefined }] as never)).toEqual({ substitutions: 0, refused: 0, rewritten: 0, share: 0 });
  });

  it('refuses a grounding arm that substituted nothing over a real sample', () => {
    // The arms this pattern exists for: a lever that is silent when it does not run, because the
    // statement it does not change still scores.
    const runs = Array.from({ length: 100 }, () => ({ grounding: { substitutions: 0, refused: 1 } }));
    expect(() => assertGroundingFired('inline+evidence+ground', runs as never)).toThrow(/substituted nothing.*lever did not run/);
  });

  it('accepts a sample too small to say anything about, and a run with one substitution', () => {
    expect(() => assertGroundingFired('inline+evidence+ground', [] as never)).not.toThrow();
    const runs = Array.from({ length: 100 }, () => ({ grounding: { substitutions: 0, refused: 0 } }));
    runs[99] = { grounding: { substitutions: 1, refused: 0 } } as never;
    expect(() => assertGroundingFired('inline+evidence+ground', runs as never)).not.toThrow();
  });
});
