#!/usr/bin/env node
/**
 * The chart half's floor guard.
 *
 * The recommender's Text2Vis reading moved five times in six rounds — 231, 414, 444, 495, 526 — and
 * every one of those moves was checked by a human reading a log. Nothing in the repository refused a
 * run that came back lower, so the number could fall as quietly as it rose: `eval/text2vis/profile.ts`
 * is deterministic over a fixed corpus, which means a fall is never noise, and a fall that nobody
 * refuses is a regression that ships.
 *
 * **What this gate can and cannot see.** It reads the artifact the profile step already writes, so it
 * prices the product on the corpus's own tables and 1,470 labelled rows. It cannot see a change in the
 * *denominator* — a corpus that came back truncated scores a lovely percentage over 300 rows — which
 * is why `scored` is compared for identity rather than for a floor. A reading over a different row set
 * is not a worse reading; it is a different question, and the identity check is the only place that
 * distinction can be made.
 *
 * Three decisions worth stating:
 *
 * - **No tolerance.** The scorer has no sampling: same corpus, same code, same count. A tolerance here
 *   would be a licence to lose the amount of the tolerance every round.
 * - **The floor is raised by hand, in the commit that earns it.** A gate that follows the reading down
 *   is not a floor; a gate that follows it up automatically would hide the round where the rise was a
 *   measurement error.
 * - **One floor, not four.** `shortlist` can fall while `top1` rises — hitting first is better than
 *   being shortlisted — and `declined` can rise while `top1` rises, when a rule learns to refuse a
 *   table it was drawing wrong. Floors on those would forbid the improvements they are meant to
 *   protect. They are printed, so a reader still sees them.
 *
 *   node tools/check-text2vis-baseline.mjs                  # report from eval/out, note if absent
 *   node tools/check-text2vis-baseline.mjs --require        # CI: a missing report is a failure
 *   node tools/check-text2vis-baseline.mjs --llm --require   # the model arm's dispatch
 *   node tools/check-text2vis-baseline.mjs --arbitration --require  # the six policies, priced on those answers
 *   node tools/check-text2vis-baseline.mjs --census --require        # the sweep's thirty-four tables, against the shipped one
 *   node tools/check-text2vis-baseline.mjs --self-test
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const BASELINE = 'eval/text2vis/baseline.json';
const REPORT = 'eval/out/text2vis-profile.json';
const RENDER_REPORT = 'eval/out/text2vis-render.json';
const JUDGE_REPORT = 'eval/out/text2vis-judge.json';
const LLM_REPORT = 'eval/out/text2vis-llm.json';
const ARBITRATION_REPORT = 'eval/out/text2vis-arbitrate.json';
const SHIP_REPORT = 'eval/out/text2vis-ship.json';
const CENSUS_REPORT = 'eval/out/text2vis-census.json';

/**
 * Compare one reading against the floor.
 *
 * Exported so the self-test can price the same function the run uses: a gate whose test calls a
 * second implementation of its own rule tests that implementation.
 *
 * @returns {{issues: string[], notes: string[]}}
 */
export function compare(report, baseline, options = {}) {
  const issues = [];
  const notes = [];
  const profile = report?.profile;
  if (profile === undefined) {
    const message = `TEXT2VIS: the report has no \`profile\` block, so the recommender half was never scored`;
    if (options.require === true) issues.push(message);
    else notes.push(`${message} (not required here)`);
    return { issues, notes };
  }
  for (const key of ['scored', 'top1', 'shortlist', 'declined']) {
    if (typeof profile[key] !== 'number') {
      issues.push(`TEXT2VIS: the report has no numeric \`profile.${key}\`, so the reading cannot be compared`);
      return { issues, notes };
    }
  }
  // The denominator first: a hit count over a different row set is not comparable, and comparing it
  // would produce a delta about the corpus while the message blamed the code.
  if (profile.scored !== baseline.scored) {
    issues.push(
      `TEXT2VIS: ${String(profile.scored)} scored rows, the floor was recorded over ${String(baseline.scored)}; ` +
        `a reading over a different row set is a different question, so no percentage is compared until the corpus is explained`,
    );
    return { issues, notes };
  }
  const share = (count) => `${((count / baseline.scored) * 100).toFixed(2)}%`;
  if (profile.top1 < baseline.top1) {
    const gap = baseline.top1 - profile.top1;
    issues.push(
      `TEXT2VIS: top-1 fell to ${String(profile.top1)} (${share(profile.top1)}) from the floor of ${String(baseline.top1)} ` +
        `(${share(baseline.top1)}): ${String(gap)} rows, ${(((gap / baseline.scored) * 100)).toFixed(2)}pp`,
    );
  }
  // The three buckets are disjoint and complete (`profile.ts` asserts it), so the misses are the
  // remainder after the shortlist and the refusals — not after the *hits*. Subtracting the hits left
  // the shortlisted rows that came second inside the number, and printed 774 misses for a report that
  // counts 682: a right reading of the wrong quantity, in the one line a reader checks the floor with.
  notes.push(
    `TEXT2VIS: top-1 ${String(profile.top1)} (${share(profile.top1)}) against a floor of ${String(baseline.top1)}; ` +
      `shortlist ${String(profile.shortlist)} (${share(profile.shortlist)}), declined ${String(profile.declined)}, ` +
      `missed ${String(baseline.scored - profile.shortlist - profile.declined)}`,
  );
  return { issues, notes };
}

/**
 * Compare the pixel reading against its floor.
 *
 * A different instrument from `compare`, and it needs a different rule. `rendered` is not an accuracy
 * score that should only go up — it is the count of charts that reached a PNG, so it rises when the
 * compiler learns a mark and falls when the product refuses more tables, and the same round can move
 * both. What the gate can hold without contesting either is the pair of statements that are true by
 * construction: **no chart may fail** (the source came from this repository's own emitter, so a Python
 * exception is a defect here) and **the counters must add up** to the scored rows, which `render.ts`
 * asserts on its own path and which this gate re-checks because a report is a file.
 *
 * `rendered` is compared as a floor for one reason: a compiler that suddenly paints fewer marks is a
 * capability that was removed, and 1,286 is the number of charts this emitter actually produced.
 *
 * @returns {{issues: string[], notes: string[]}}
 */
export function compareRender(report, floor, options = {}) {
  const issues = [];
  const notes = [];
  if (report === undefined) {
    const message = `TEXT2VIS RENDER: no render report at ${RENDER_REPORT} — \`pnpm bench:text2vis:render --artifact ${RENDER_REPORT}\` writes it`;
    if (options.require === true) issues.push(message);
    else notes.push(`${message} (not required here)`);
    return { issues, notes };
  }
  for (const key of ['scored', 'rendered', 'failed', 'refused', 'declined']) {
    if (typeof report[key] !== 'number') {
      issues.push(`TEXT2VIS RENDER: the report has no numeric \`${key}\`, so the pixel reading cannot be compared`);
      return { issues, notes };
    }
  }
  const total = report.rendered + report.failed + report.refused + report.declined;
  if (total !== report.scored) {
    issues.push(
      `TEXT2VIS RENDER: ${String(report.rendered)} rendered + ${String(report.failed)} failed + ` +
        `${String(report.refused)} refused + ${String(report.declined)} declined is not ${String(report.scored)} scored`,
    );
  }
  if (report.failed !== floor.failed) {
    issues.push(
      `TEXT2VIS RENDER: ${String(report.failed)} charts raised in Python (the floor is ${String(floor.failed)}); ` +
        `the source came from this repository's emitter, so this is a defect here rather than an instrument limit — ` +
        `the report lists the first ones under \`failures\``,
    );
  }
  if (report.rendered < floor.rendered) {
    issues.push(
      `TEXT2VIS RENDER: ${String(report.rendered)} charts reached a png (${((report.rendered / report.scored) * 100).toFixed(2)}%), ` +
        `below the floor of ${String(floor.rendered)}: a mark this compiler used to paint stopped painting`,
    );
  }
  notes.push(
    `TEXT2VIS RENDER: rendered ${String(report.rendered)}/${String(report.scored)} ` +
      `(${((report.rendered / report.scored) * 100).toFixed(2)}%), refused ${String(report.refused)}, ` +
      `declined ${String(report.declined)}, failed ${String(report.failed)}; ` +
      `p50 ${String(report.latency?.p50 ?? '?')} ms per figure`,
  );
  return { issues, notes };
}


/**
 * Whether two graders are two instruments, said as one sentence or as nothing.
 *
 * The round that priced the grader found that `glm-4.6v` grades about a point lower than
 * `glm-4.5v` on the same 178 figures, with both intervals three standard errors from zero. That is
 * not a cheaper copy of the same ruler — it is a different ruler, and two means from two rulers are
 * two facts. So the floor records which instrument took it, and this function is the one place that
 * compares a reading's instrument with the floor's.
 *
 * A field missing on either side is *not* a divergence: a reading that names no model at all is
 * already an issue of its own ("a mean with no author"), and saying it twice would make the issue
 * count depend on which check ran first. The comparison is only between two named instruments.
 *
 * @returns {string | undefined} one sentence naming both instruments, or undefined when they match.
 */
export function differentInstrument(floorGrader, grader) {
  if (typeof floorGrader?.model !== 'string' || typeof grader?.model !== 'string') return undefined;
  // The endpoint is compared only when both sides name one: a model served from two places is not
  // the same instrument, but a floor recorded before the field existed must not read as a swap.
  const sameEndpoint =
    typeof floorGrader.endpoint !== 'string' ||
    typeof grader.endpoint !== 'string' ||
    floorGrader.endpoint === grader.endpoint;
  // The decode mode is part of the instrument too, and this round has the receipt: `glm-4.6v` with
  // the switch off costs a third of what the same model costs deliberating, so the same name with a
  // different mode is two instruments on the same scale. Absent means the endpoint decided.
  const modeOf = (one) => (typeof one.thinking === 'boolean' ? one.thinking : null);
  const sameMode = modeOf(floorGrader) === modeOf(grader);
  if (floorGrader.model === grader.model && sameEndpoint && sameMode) return undefined;
  const name = (one) =>
    `${typeof one.endpoint === 'string' ? `${one.endpoint}/` : ''}${one.model}` +
    (typeof one.thinking === 'boolean' ? ` thinking ${one.thinking ? 'on' : 'off'}` : ' with the endpoint deciding the mode');
  return `graded by ${name(grader)}, while the floor was registered with ${name(floorGrader)}`;
}

/**
 * Compare the judged reading against the floor.
 *
 * This one holds a different kind of statement from the two above, and the difference is worth
 * spelling out: `compare` and `compareRender` compare *counts* against a recorded count, while the
 * grader produces two means on an ordinal scale a model invented. So the floor here is not a number
 * to stay above — it is the shape a reading must have before its means mean anything:
 *
 * 1. **One call per attempted row the store did not already answer.** Two dimensions come back from one
 *    prompt, so `calls` must equal `judged + failed - cached` exactly. A run that spent more asked
 *    twice, and its means are over a different instrument from the one `eval/text2vis/judge.ts`
 *    documents; a run that spent less answered rows it did not look at, and a reading whose cache
 *    count is wrong is a reading whose call count is wrong.
 * 2. **Every row accounted for.** `judged + failed + notSelected === charts` and
 *    `charts + skipped === scored`. A mean whose denominator cannot be checked is a number with no
 *    population behind it.
 * 3. **Both means on the scale the prompt asked for.** 0..10, not a probability and not a percentage.
 *
 * The means themselves are printed as notes and not compared, and that is the honest state of a first
 * reading: there is nothing recorded to regress against yet. The round that takes it registers it.
 *
 * @returns {{issues: string[], notes: string[]}}
 */
export function compareJudge(report, floor, options = {}) {
  const issues = [];
  const notes = [];
  if (report === undefined) {
    const message = `TEXT2VIS JUDGE: no judge report at ${JUDGE_REPORT} — \`pnpm bench:text2vis:judge --artifact ${JUDGE_REPORT}\` writes it`;
    if (options.require === true) issues.push(message);
    else notes.push(`${message} (not required here)`);
    return { issues, notes };
  }
  for (const key of ['scored', 'charts', 'judged', 'failed', 'notSelected', 'skipped', 'calls']) {
    if (typeof report[key] !== 'number') {
      issues.push(`TEXT2VIS JUDGE: the report has no numeric \`${key}\`, so the grading reading cannot be compared`);
      return { issues, notes };
    }
  }
  // Absent on the readings taken before the store existed, and absent means zero: those runs answered
  // nothing from a cache because there was none. Coerced here rather than required, because a gate that
  // refuses to read a six-month-old artifact is a gate somebody deletes.
  const cached = typeof report.cached === 'number' ? report.cached : 0;
  if (report.calls !== report.judged + report.failed - cached) {
    issues.push(
      `TEXT2VIS JUDGE: ${String(report.calls)} calls for ${String(report.judged)} judged, ${String(report.failed)} failed and ${String(cached)} from the store — ` +
        `this instrument asks both dimensions in one call, so anything but one call per attempted row it did not already have is a different instrument`,
    );
  }
  if (cached > report.judged) {
    issues.push(
      `TEXT2VIS JUDGE: ${String(cached)} rows answered from the store for ${String(report.judged)} judged rows — a cached row is a graded row, so this count cannot exceed it`,
    );
  }
  if (report.judged + report.failed + report.notSelected !== report.charts) {
    issues.push(
      `TEXT2VIS JUDGE: ${String(report.judged)} judged + ${String(report.failed)} failed + ` +
        `${String(report.notSelected)} unselected is not ${String(report.charts)} charts`,
    );
  }
  if (report.charts + report.skipped !== report.scored) {
    issues.push(
      `TEXT2VIS JUDGE: ${String(report.charts)} charts + ${String(report.skipped)} skipped is not ${String(report.scored)} scored`,
    );
  }
  // A stopped run passes every rule above by construction: the rows it never reached arrive as
  // `notSelected`, which is a legitimate partition for a rehearsal. `44155803661` measured 244 of
  // 1,418 charts and would have been published as a reading, so the stop is refused on its own terms.
  if (report.aborted !== undefined) {
    const aborted = report.aborted;
    issues.push(
      `TEXT2VIS JUDGE: the run stopped after ${String(aborted?.streak)} calls in a row without a reply; ` +
        `${String(aborted?.attempted)} of ${String(report.charts)} charts were attempted and ` +
        `${String(report.charts - aborted?.attempted)} were never asked about — a stopped run is not a reading ` +
        `(${String(aborted?.reason)})`,
    );
  }
  const means = report.means ?? {};
  for (const dimension of floor.dimensions ?? ['chart_correctness', 'readability']) {
    const value = means[dimension];
    if (typeof value !== 'number') {
      issues.push(`TEXT2VIS JUDGE: no mean for \`${dimension}\`, which is one of the two things this instrument asks`);
      continue;
    }
    if (value < 0 || value > 10) {
      issues.push(`TEXT2VIS JUDGE: \`${dimension}\` reads ${String(value)}, outside the 0-10 scale the prompt asked for`);
    }
  }
  // Who graded, refused rather than assumed: two means from two models are two facts, and a report
  // that dropped the name is quotable as a property of the charts. The instrument checks the same
  // thing at write time; this is the copy that runs on a file somebody else wrote.
  const grader = report.grader;
  if (
    typeof grader?.model !== 'string' ||
    grader.model.trim() === '' ||
    typeof grader?.endpoint !== 'string' ||
    grader.endpoint.trim() === ''
  ) {
    issues.push(
      'TEXT2VIS JUDGE: the report names no endpoint or model, so its means are a reading of nothing ' +
        "that can be compared with another grader's",
    );
  } else {
    // A reading taken on a different grader is a reading, not a floor: the round that priced the
    // instrument measured a full point between `glm-4.5v` and `glm-4.6v` on the same figures, so
    // registering the cheaper one would move the floor by a fact about the ruler. `--iteration`
    // declares a delta, and a delta is allowed to have been taken on the cheaper instrument.
    const divergence = differentInstrument(floor.grader, grader);
    if (divergence !== undefined) {
      const sentence = `TEXT2VIS JUDGE: ${divergence}`;
      if (options.iteration === true) {
        notes.push(`${sentence} (an iteration reading: its deltas are paired, and its means are not this floor)`);
      } else {
        issues.push(
          `${sentence} — a grader swap is an instrument swap, so a floor reading has to be taken on the ` +
            'instrument the floor was registered with, or the floor moves by a fact about the ruler',
        );
      }
    }
  }
  // A null mean is spelled as one here too: `Number(null)` is 0, and printing "0.00/10" for a
  // dimension nothing was graded on is the same defect as the `boxplot 0/1 judged, correctness 0.00`
  // line the first production reading printed.
  const shown = (value) => (typeof value === 'number' ? `${value.toFixed(2)}/10` : 'no reading');
  notes.push(
    `TEXT2VIS JUDGE: chart_correctness ${shown(means.chart_correctness)}, ` +
      `readability ${shown(means.readability)} over ${String(report.judged)} of ` +
      `${String(report.charts)} charts (${String(report.failed)} failed, ${String(report.skipped)} skipped), ` +
      `${Number(report.callsPerRow ?? 0).toFixed(3)} calls per row, graded by ` +
      `${typeof grader?.model === 'string' ? grader.model : '(unnamed)'}`,
  );
  return { issues, notes };
}

/**
 * Cases for the grading reading: the price, the partition, and the scale.
 *
 * `want` is a count of issues, so a case that fails two rules has to name two — the checks are
 * deliberately independent, and a self-test that accepted "some issue" would let a rule that never
 * fires hide behind one that always does.
 */
/** The grader every self-test report names, so that each case fails only for the reason it is for. */
const GRADER = { endpoint: 'zhipu', model: 'glm-4.5v' };

const JUDGE_SELF_TEST = [
  {
    name: 'a reading that spends one call per row and accounts for every row passes',
    report: { grader: GRADER, scored: 1470, charts: 1286, judged: 1286, failed: 0, notSelected: 0, skipped: 184, calls: 1286, callsPerRow: 1, means: { chart_correctness: 6.4, readability: 7.8 } },
    want: 0,
  },
  {
    name: 'a run that asked both dimensions twice fails, even with perfect means',
    report: { grader: GRADER, scored: 1470, charts: 1286, judged: 1286, failed: 0, notSelected: 0, skipped: 184, calls: 2572, callsPerRow: 2, means: { chart_correctness: 10, readability: 10 } },
    want: 1,
  },
  {
    name: 'a reading that answered most of its rows from the store passes, because it spent what it looked at',
    report: { grader: GRADER, scored: 1470, charts: 1286, judged: 1286, failed: 0, notSelected: 0, skipped: 184, cached: 1240, calls: 46, callsPerRow: 0.036, means: { chart_correctness: 6, readability: 7 } },
    want: 0,
  },
  {
    // The count that a cache makes possible to fake: a run that claims 1,240 hits and 1,286 calls either
    // asked twice for the rows it already had or is reporting a bill it did not pay.
    name: 'a run that claims cached rows and still charges for them fails',
    report: { grader: GRADER, scored: 1470, charts: 1286, judged: 1286, failed: 0, notSelected: 0, skipped: 184, cached: 1240, calls: 1286, callsPerRow: 1, means: { chart_correctness: 6, readability: 7 } },
    want: 1,
  },
  {
    name: 'more cached rows than judged rows fails, because a cached row is a graded one',
    report: { grader: GRADER, scored: 1470, charts: 1286, judged: 100, failed: 0, notSelected: 1186, skipped: 184, cached: 120, calls: -20, callsPerRow: -0.2, means: { chart_correctness: 6, readability: 7 } },
    want: 1,
  },
  {
    name: 'a chart that is neither graded nor declared unselected fails',
    report: { grader: GRADER, scored: 1470, charts: 1286, judged: 1200, failed: 0, notSelected: 0, skipped: 184, calls: 1200, callsPerRow: 1, means: { chart_correctness: 6, readability: 7 } },
    want: 1,
  },
  {
    name: 'a row that fell out of both partitions fails',
    report: { grader: GRADER, scored: 1470, charts: 1286, judged: 1286, failed: 0, notSelected: 0, skipped: 100, calls: 1286, callsPerRow: 1, means: { chart_correctness: 6, readability: 7 } },
    want: 1,
  },
  {
    name: 'a mean outside the scale fails',
    report: { grader: GRADER, scored: 1470, charts: 1286, judged: 1286, failed: 0, notSelected: 0, skipped: 184, calls: 1286, callsPerRow: 1, means: { chart_correctness: 64, readability: 7 } },
    want: 1,
  },
  {
    name: 'a missing dimension fails, because half a reading is not a reading',
    report: { grader: GRADER, scored: 1470, charts: 1286, judged: 1286, failed: 0, notSelected: 0, skipped: 184, calls: 1286, callsPerRow: 1, means: { chart_correctness: 6 } },
    want: 1,
  },
  {
    name: 'a report with a missing counter fails',
    report: { grader: GRADER, scored: 1470, judged: 1286 },
    want: 1,
  },
  {
    name: 'means with no model named fail, because the grader is part of the reading',
    report: { scored: 1470, charts: 1286, judged: 1286, failed: 0, notSelected: 0, skipped: 184, calls: 1286, callsPerRow: 1, means: { chart_correctness: 6, readability: 7 } },
    want: 1,
  },
  {
    name: 'a grader named only by whitespace fails',
    report: { grader: { endpoint: 'zhipu', model: '  ' }, scored: 1470, charts: 1286, judged: 1286, failed: 0, notSelected: 0, skipped: 184, calls: 1286, callsPerRow: 1, means: { chart_correctness: 6, readability: 7 } },
    want: 1,
  },
  {
    name: 'a null mean fails, because a run that graded nothing has no reading to report',
    report: { grader: GRADER, scored: 1470, charts: 1286, judged: 0, failed: 8, notSelected: 1278, skipped: 184, calls: 8, callsPerRow: 1, means: { chart_correctness: null, readability: null } },
    want: 2,
  },
  {
    // The arithmetic of this run is perfect — 8 failed plus 1,278 unselected is every chart — and it
    // measured 0.6% of the corpus. `44155803661` would have passed every rule above.
    name: 'a run that stopped before the end fails, however tidy its arithmetic',
    report: {
      grader: GRADER,
      scored: 1470,
      charts: 1286,
      judged: 240,
      failed: 8,
      notSelected: 1038,
      skipped: 184,
      calls: 248,
      callsPerRow: 1,
      means: { chart_correctness: 3, readability: 6 },
      aborted: { streak: 8, attempted: 248, reason: 'llm returned 429: 余额不足或无可用资源包,请充值。' },
    },
    want: 1,
  },
  {
    // `glm-4.6v` grades about a point below `glm-4.5v` on the same figures, so a report that names
    // the cheaper model is a reading of a different ruler. Registering it as the floor would move
    // the floor by a fact about the instrument, which is the one thing a floor may not do.
    name: 'a reading taken on another grader fails, because the floor is relative to its instrument',
    report: { grader: { endpoint: 'zhipu', model: 'glm-4.6v' }, scored: 1470, charts: 1286, judged: 1286, failed: 0, notSelected: 0, skipped: 184, calls: 1286, callsPerRow: 1, means: { chart_correctness: 6, readability: 7 } },
    want: 1,
  },
  {
    // The same report, declared as what it is: an iteration reading, whose claim is a paired delta
    // within row and never a floor.
    name: 'the same reading declared as an iteration passes, and says what it is',
    report: { grader: { endpoint: 'zhipu', model: 'glm-4.6v' }, scored: 1470, charts: 1286, judged: 1286, failed: 0, notSelected: 0, skipped: 184, calls: 1286, callsPerRow: 1, means: { chart_correctness: 6, readability: 7 } },
    iteration: true,
    want: 0,
  },
  {
    // The decode mode is part of the instrument: the same model doing a third of the work is not the
    // same ruler, and the round that closed the `--think` question measured exactly that.
    name: 'a reading taken in another decode mode fails, because the mode is part of the instrument',
    report: { grader: { endpoint: 'zhipu', model: 'glm-4.5v', thinking: false }, scored: 1470, charts: 1286, judged: 1286, failed: 0, notSelected: 0, skipped: 184, calls: 1286, callsPerRow: 1, means: { chart_correctness: 6, readability: 7 } },
    want: 1,
  },
  {
    // Same model name, different endpoint: two vendors serve the same name from different weights.
    name: 'a reading from another endpoint fails even with the same model name',
    report: { grader: { endpoint: 'openrouter', model: 'glm-4.5v' }, scored: 1470, charts: 1286, judged: 1286, failed: 0, notSelected: 0, skipped: 184, calls: 1286, callsPerRow: 1, means: { chart_correctness: 6, readability: 7 } },
    want: 1,
  },
  { name: 'no judge report is a failure when it is required', report: undefined, want: 1, require: true },
  { name: 'no judge report is a note when it is not', report: undefined, want: 0 },
];

/** Cases that pin the three failures the gate exists for, plus the one it must not invent. */
/**
 * The model arm's own cases.
 *
 * One per way the reader refuses, because each of them is a report that would otherwise be published:
 * a cut reply, a counter that does not add up, a denominator that moved, a reading under its floor,
 * and a missing artifact on a dispatch that asked for one. The generated case at the end is the
 * positive one — a hand-written pass would prove nothing about the arithmetic the run uses.
 */
const LLM_SELF_TEST = [
  {
    name: 'a model reading over the floor passes and is printed',
    report: { arms: [{ model: 'deepseek-chat', scale: 'mark', requested: 1470, answered: 1470, unparsed: 0, truncated: 0, scored: 1470, top1: 700 }] },
    want: 0,
  },
  {
    name: 'a reply cut at the budget is refused, because a share over the survivors is not a share',
    report: { arms: [{ model: 'deepseek-chat', scale: 'mark', requested: 1470, answered: 1469, unparsed: 1, truncated: 24, scored: 1470, top1: 700 }] },
    want: 1,
  },
  {
    name: 'counters that do not add up are refused before any share is read',
    report: { arms: [{ model: 'deepseek-chat', scale: 'mark', requested: 1470, answered: 1400, unparsed: 0, truncated: 0, scored: 1470, top1: 700 }] },
    want: 1,
  },
  {
    name: 'a reading under its floor is refused',
    report: { arms: [{ model: 'deepseek-chat', scale: 'mark', requested: 1470, answered: 1470, unparsed: 0, truncated: 0, scored: 1470, top1: 600 }] },
    want: 1,
  },
  {
    name: 'a reading over another row set is a different question',
    report: { arms: [{ model: 'deepseek-chat', scale: 'mark', requested: 200, answered: 200, unparsed: 0, truncated: 0, scored: 200, top1: 100 }] },
    want: 1,
  },
  {
    name: 'a label arm is held to its exact count, not to a top-1 it never published',
    report: { arms: [{ model: 'deepseek-chat', scale: 'label', requested: 1470, answered: 1470, unparsed: 0, truncated: 0, scored: 1470, exact: 800 }] },
    want: 0,
  },
  {
    name: 'a dispatch that asked for a reading and wrote none is refused',
    report: undefined,
    require: true,
    want: 1,
  },
];

const SELF_TEST = [
  { name: 'a reading at the floor passes', report: { profile: { scored: 1470, top1: 526, shortlist: 618, declined: 167 } }, want: 0 },
  { name: 'a reading above the floor passes', report: { profile: { scored: 1470, top1: 530, shortlist: 620, declined: 160 } }, want: 0 },
  { name: 'one row below the floor fails', report: { profile: { scored: 1470, top1: 525, shortlist: 618, declined: 167 } }, want: 1 },
  { name: 'a moved denominator fails before any percentage is compared', report: { profile: { scored: 300, top1: 200, shortlist: 250, declined: 10 } }, want: 1 },
  { name: 'a report with no profile block fails when it is required', report: {}, want: 1, require: true },
  { name: 'a report with no profile block is a note when it is not', report: {}, want: 0 },
  { name: 'a non-numeric hit count fails', report: { profile: { scored: 1470, top1: 'many', shortlist: 618, declined: 167 } }, want: 1 },
  { name: 'the reading the floor replaced fails against the new floor', report: { profile: { scored: 1470, top1: 495, shortlist: 560, declined: 167 } }, want: 1 },
];

/** Cases for the pixel reading: every way its four counters can lie. */
const RENDER_SELF_TEST = [
  { name: 'a run with no failure and at the floor passes', report: { grader: GRADER, scored: 1470, rendered: 1286, failed: 0, refused: 17, declined: 167 }, want: 0 },
  { name: 'a mark painter that stopped painting fails', report: { grader: GRADER, scored: 1470, rendered: 1200, failed: 0, refused: 103, declined: 167 }, want: 1 },
  {
    name: 'a chart that raised in Python fails even when nothing else moved',
    report: { grader: GRADER, scored: 1470, rendered: 1286, failed: 1, refused: 16, declined: 167 },
    want: 1,
  },
  {
    name: 'counters that do not add up fail',
    report: { grader: GRADER, scored: 1470, rendered: 1286, failed: 0, refused: 17, declined: 100 },
    want: 1,
  },
  { name: 'a report with a missing counter fails', report: { grader: GRADER, scored: 1470, rendered: 1286 }, want: 1 },
  { name: 'no render report is a failure when it is required', report: undefined, want: 1, require: true },
  { name: 'no render report is a note when it is not', report: undefined, want: 0 },
];

function selfTest() {
  const baseline = { scored: 1470, top1: 526 };
  const renderFloor = { rendered: 1286, failed: 0 };
  let failed = 0;
  let reported = 0;
  /** One case: the name, the issues it produced, and how many it was supposed to. */
  const caseOf = (name, issues, want) => {
    const ok = issues.length === want;
    if (!ok) failed += 1;
    reported += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${String(issues.length)} issues, wanted ${String(want)}`}`);
  };
  for (const test of SELF_TEST) {
    const { issues } = compare(test.report, baseline, test.require === true ? { require: true } : {});
    caseOf(test.name, issues, test.want);
  }
  for (const test of RENDER_SELF_TEST) {
    const { issues } = compareRender(test.report, renderFloor, test.require === true ? { require: true } : {});
    caseOf(test.name, issues, test.want);
  }
  // One floor for both scales: the reader picks the dimension from the arm's own scale, which is the
  // decision these cases exist to pin.
  const llmFloor = {
    arms: {
      'deepseek-chat|mark': { scored: 1470, top1: 640 },
      'deepseek-chat|label': { scored: 1470, exact: 780 },
    },
  };
  for (const test of LLM_SELF_TEST) {
    const { issues } = compareLlm(test.report, llmFloor, test.require === true ? { require: true } : {});
    caseOf(test.name, issues, test.want);
  }
  // An arm nobody has priced yet is a note rather than a failure: the first dispatch of a new model is
  // the measurement that establishes its floor, and a gate that refused it would refuse that run.
  const unpriced = compareLlm(
    { arms: [{ model: 'glm-4.5', scale: 'mark', requested: 10, answered: 10, unparsed: 0, truncated: 0, scored: 10, top1: 5 }] },
    llmFloor,
    {},
  );
  {
    const ok = unpriced.issues.length === 0 && unpriced.notes.length === 1;
    if (!ok) failed += 1;
    reported += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} an arm with no recorded floor is noted, not refused`);
  }
  // A floor with a band, in both directions. The band exists because the instrument re-samples to ±3
  // rows at temperature 0, and run 44439035718 was rejected at 1 row under its floor — a gate that
  // reds on noise teaches its readers to ignore it, which is worse than no gate at all.
  const bandedFloor = { tolerance: 5, arms: { 'deepseek-chat|mark': { scored: 1470, top1: 640 } } };
  const bandCase = (name, top1, want) => {
    const { issues, notes } = compareLlm(
      { arms: [{ model: 'deepseek-chat', scale: 'mark', requested: 1470, answered: 1470, unparsed: 0, truncated: 0, scored: 1470, top1 }] },
      bandedFloor,
      {},
    );
    const ok = issues.length === want && (want === 1 || notes.length === 1);
    if (!ok) failed += 1;
    reported += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${String(issues.length)} issues, wanted ${String(want)}`}`);
  };
  bandCase('a reading 3 rows under its floor is inside the band, and is said to be', 637, 0);
  bandCase('a reading 6 rows under its floor is outside the band', 634, 1);
  // The request, in both directions. A floor says which request it was taken on, and a file that
  // answers a different one is a different instrument: the local artifact this rule was written for
  // read 857 under a 32-token cap against a 861 floor and was reported as a re-sample.
  const requestArm = (request, top1 = 640) => ({
    arms: [{ model: 'deepseek-chat', scale: 'mark', requested: 1470, answered: 1470, unparsed: 0, truncated: 0, scored: 1470, top1, ...(request === undefined ? {} : { request }) }],
  });
  const requestFloor = { tolerance: 5, request: { promptVersion: 1, budget: 96 }, arms: { 'deepseek-chat|mark': { scored: 1470, top1: 640 } } };
  const requestCase = (name, report, floor, want, notes = 1) => {
    const { issues, notes: said } = compareLlm(report, floor, {});
    const ok = issues.length === want && (want === 1 || said.length === notes);
    if (!ok) failed += 1;
    reported += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${String(issues.length)} issues and ${String(said.length)} notes, wanted ${String(want)}/${String(notes)}`}`);
  };
  requestCase('the same request is the same instrument', requestArm({ promptVersion: 1, budget: 96 }), requestFloor, 0);
  requestCase('an absent budget and an unset budget are one request', requestArm({ promptVersion: 1 }), { ...requestFloor, request: { promptVersion: 1 } }, 0);
  requestCase('the same rows under another reply cap are refused', requestArm({ promptVersion: 1, budget: 32 }), requestFloor, 1);
  requestCase('another prompt version is refused', requestArm({ promptVersion: 2, budget: 96 }), requestFloor, 1);
  requestCase('an artifact that names no request is refused', requestArm(undefined), requestFloor, 1);
  // Two notes: one for the request it names, one for the reading itself.
  requestCase('a floor with no request notes the one this reading names', requestArm({ promptVersion: 1, budget: 96 }), { ...requestFloor, request: undefined }, 0, 2);
  requestCase(
    'a cap the floor never sent is refused, not called a lower sample',
    requestArm({ promptVersion: 1, budget: 96 }, 630),
    { ...requestFloor, request: { promptVersion: 1 } },
    1,
  );
  // The request check is scoped to the arms the floor records, and this is the case that says so.
  // A reasoning endpoint is sent **no** reply cap — `replyBudget` returns `undefined` where the model
  // thinks aloud, because a cap sized for one word truncates the deliberation — so its artifact
  // records `{promptVersion: 1}` and no budget, and the floor's `96` is a fact about a different
  // endpoint. Applying it anyway refused the first dispatch of every second model at the one check
  // that arm had no floor to be measured against, which reads exactly like a regression and is not
  // one. The note is the right shape: there is nothing yet to hold this reading to.
  requestCase(
    'an arm nobody has priced is not held to the floor request',
    {
      arms: [
        { model: 'deepseek-reasoner', scale: 'mark', requested: 1470, answered: 1470, unparsed: 0, truncated: 0, scored: 1470, top1: 900, request: { promptVersion: 1 } },
      ],
    },
    requestFloor,
    0,
    1,
  );
  // And once that arm *is* registered, the request it is held to is its own rather than the other
  // endpoint's. Two arms in one dispatch are two instruments, so a floor that can only say one request
  // would either exempt the second arm for ever or refuse it for answering the question it was sent.
  const splitFloor = {
    ...requestFloor,
    arms: {
      'deepseek-chat|mark': { scored: 1470, top1: 640 },
      'deepseek-reasoner|mark': { scored: 1470, top1: 900, request: { promptVersion: 1 } },
    },
  };
  requestCase(
    'a registered arm is held to the request its own floor records',
    {
      arms: [
        { model: 'deepseek-reasoner', scale: 'mark', requested: 1470, answered: 1470, unparsed: 0, truncated: 0, scored: 1470, top1: 900, request: { promptVersion: 1 } },
      ],
    },
    splitFloor,
    0,
    // One note: the reading itself, printed because it met its own floor.
    1,
  );
  requestCase(
    'the same arm answering the other endpoint request is refused',
    {
      arms: [
        { model: 'deepseek-reasoner', scale: 'mark', requested: 1470, answered: 1470, unparsed: 0, truncated: 0, scored: 1470, top1: 900, request: { promptVersion: 1, budget: 96 } },
      ],
    },
    splitFloor,
    1,
  );
  const judgeFloor = { dimensions: ['chart_correctness', 'readability'], grader: { endpoint: 'zhipu', model: 'glm-4.5v' } };
  for (const test of JUDGE_SELF_TEST) {
    const options = { ...(test.require === true ? { require: true } : {}), ...(test.iteration === true ? { iteration: true } : {}) };
    const { issues } = compareJudge(test.report, judgeFloor, options);
    caseOf(test.name, issues, test.want);
  }
  // The sentence both callers share: the report check and `--expect-instrument` decide the same question,
  // and a test of one of them would leave the other free to disagree.
  const swaps = [
    ['the same instrument is not a swap', { endpoint: 'zhipu', model: 'glm-4.5v' }, { endpoint: 'zhipu', model: 'glm-4.5v' }, false],
    ['another model is a swap', { endpoint: 'zhipu', model: 'glm-4.5v' }, { endpoint: 'zhipu', model: 'glm-4.6v' }, true],
    ['another endpoint is a swap, even with the same model name', { endpoint: 'zhipu', model: 'glm-4.5v' }, { endpoint: 'openrouter', model: 'glm-4.5v' }, true],
    ['a floor recorded before the endpoint field is compared on the model alone', { model: 'glm-4.5v' }, { endpoint: 'zhipu', model: 'glm-4.5v' }, false],
    ['a reading that names no model is not a swap, because it is already an issue of its own', { endpoint: 'zhipu', model: 'glm-4.5v' }, { endpoint: 'zhipu' }, false],
    ['another decode mode is a swap, because the mode is part of the instrument', { endpoint: 'zhipu', model: 'glm-4.5v', thinking: null }, { endpoint: 'zhipu', model: 'glm-4.5v', thinking: false }, true],
  ];
  for (const [name, was, now, differs] of swaps) {
    const sentence = differentInstrument(was, now);
    const ok = (sentence !== undefined) === differs;
    if (!ok) failed += 1;
    reported += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${String(sentence)}`}`);
  }
  // The floor has to name what took it, or every check above silently does nothing: this is the
  // assertion that a future edit cannot delete the field and leave the gate looking healthy.
  const recorded = JSON.parse(readFileSync(resolve(ROOT, BASELINE), 'utf8'))?.judge?.grader;
  const named = typeof recorded?.model === 'string' && typeof recorded?.endpoint === 'string';
  caseOf(`the floor records the instrument that took it (${String(recorded?.endpoint)}/${String(recorded?.model)})`, named ? [] : ['no judge.grader'], 0);
  // The same rule for the model arm: a floor with no arms turns every check above into a note, and a
  // note is what a gate looks like while it is doing nothing. Asserted by *scale* rather than by model
  // name, because the model is the thing a new reading changes and the scales are the instrument.
  // The arbitration floor, and the assertions that keep its table honest. Each case breaks exactly one
  // identity, because a table can be wrong in five ways that all look like a table.
  const arbFloor = { scored: 8, product: 4, best: 6, ceiling: 7, tolerance: 0 };
  const arbReport = () => ({
    population: { scored: 8 },
    agreement: { agree: 2, agreeHit: 2, disagree: 6, productRight: 2, modelRight: 3 },
    oracle: { hit: 7 },
    best: 'p',
    policies: [
      { name: 'product', hit: 4, keptRight: 2, givenRight: 0 },
      { name: 'p', hit: 6, keptRight: 2, givenRight: 2 },
    ],
  });
  {
    const clean = compareArbitration(arbReport(), arbFloor, { require: true });
    caseOf('a table whose cells add up is accepted', clean.issues, 0);
    const broken = arbReport();
    broken.policies[1].hit = 7;
    caseOf('a policy whose hits are not its three cells is refused', compareArbitration(broken, arbFloor, {}).issues, 1);
    // The floor is lowered in these two cases on purpose: each fixture should break *one* identity, and
    // a fixture that also falls under its floor would be refused for the floor's reason instead.
    const misquoted = arbReport();
    misquoted.best = 'product';
    caseOf('a headline that is not the maximum is refused', compareArbitration(misquoted, { ...arbFloor, best: 4 }, {}).issues, 1);
    const collapsed = arbReport();
    collapsed.oracle = { hit: 6 };
    caseOf('a ceiling that is not the union is refused', compareArbitration(collapsed, { ...arbFloor, ceiling: 6 }, {}).issues, 1);
    const dropped = arbReport();
    dropped.policies = dropped.policies.filter((policy) => policy.name !== 'product');
    caseOf('a table with no product baseline is refused', compareArbitration(dropped, arbFloor, {}).issues, 1);
    const fewer = arbReport();
    fewer.population = { scored: 7 };
    caseOf('a table priced over another row set is refused', compareArbitration(fewer, arbFloor, {}).issues, 1);
    const moved = arbReport();
    moved.agreement.disagree = 7;
    caseOf('a disagreement that is not a partition is refused', compareArbitration(moved, arbFloor, {}).issues, 1);
    const under = arbReport();
    under.policies[1].hit = 5;
    under.policies[1].keptRight = 1;
    under.policies[1].givenRight = 2;
    caseOf('a best policy one row under its floor is refused', compareArbitration(under, arbFloor, {}).issues, 1);
    const banded = compareArbitration(under, { ...arbFloor, tolerance: 5 }, {});
    caseOf('the same row inside the band is a note', banded.issues, 0);
  }
  // The shipped path, and the seven ways a derived reading can look finished: a third answer, an
  // unexplained row, a reason counted twice, more hits than rows, a changed row no veto accounts for,
  // a reading under its floor, and — the one this gate exists for — a product that is not the policy.
  const shipFloor = { scored: 8, decided: 6, shipped: 6, tolerance: 0 };
  const shipReport = () => ({
    population: { scored: 8 },
    decided: { hit: 6, share: 0.75, fromModel: 6, fromProduct: 2, reasons: { 'no-advice': 2, unavailable: 0, unlisted: 0, wide: 0, 'not-admitted': 0, unchartable: 0 } },
    shipped: { hit: 6, share: 0.75, fromModel: 4, fromProduct: 4, reasons: { 'no-advice': 1, unavailable: 0, unlisted: 0, wide: 2, 'not-admitted': 0, unchartable: 1 } },
    changed: 3,
    divergence: [],
  });
  {
    caseOf('a shipped reading that adds up is accepted', compareShip(shipReport(), shipFloor, { require: true }).issues, 0);
    const missing = compareShip(undefined, shipFloor, { require: true });
    caseOf('a missing ship artifact is refused when it is required', missing.issues, 1);
    caseOf('a missing ship artifact is a note when it is not', compareShip(undefined, shipFloor, {}).issues, 0);
    const other = shipReport();
    other.divergence = [{ row: 3, policy: 'bar', shipped: 'line' }];
    caseOf('a product that disagrees with the policy on one row is refused', compareShip(other, shipFloor, {}).issues, 1);
    const short = shipReport();
    short.decided.fromModel = 5;
    caseOf('a split that does not cover the population is refused', compareShip(short, shipFloor, {}).issues, 1);
    const doubled = shipReport();
    doubled.shipped.reasons['no-advice'] = 2;
    caseOf('a reason counted twice is refused', compareShip(doubled, shipFloor, {}).issues, 1);
    const over = shipReport();
    over.shipped.hit = 9;
    caseOf('more hits than rows is refused', compareShip(over, shipFloor, {}).issues, 1);
    const stray = shipReport();
    stray.changed = 4;
    caseOf('a changed row that no veto explains is refused', compareShip(stray, shipFloor, {}).issues, 1);
    const under = shipReport();
    under.decided.hit = 5;
    caseOf('a decision one row under its floor is refused', compareShip(under, shipFloor, {}).issues, 1);
    caseOf('the same row inside the band is a note', compareShip(under, { ...shipFloor, tolerance: 5 }, {}).issues, 0);
    const priced = shipReport();
    priced.population = { scored: 9 };
    caseOf('a reading over another row set is refused', compareShip(priced, shipFloor, {}).issues, 1);
    const fresh = compareShip(shipReport(), { scored: 8, tolerance: 5 }, {});
    caseOf('a first dispatch registers the floor instead of failing against it', fresh.issues, 0);
    // The second question is a third source, and it is the one a two-source split cannot see.
    const repaired = shipReport();
    repaired.shipped.fromModel = 2;
    repaired.shipped.repaired = 2;
    repaired.changed = 5;
    caseOf('a repair is a third source and can explain a changed row', compareShip(repaired, shipFloor, {}).issues, 0);
    const outside = shipReport();
    outside.shipped.repaired = 1;
    caseOf('a repair counted outside the split is refused', compareShip(outside, shipFloor, {}).issues, 1);
    const lapsed = compareShip(shipReport(), { ...shipFloor, repaired: 3 }, {});
    caseOf('a repair that stopped being asked is refused', lapsed.issues, 1);
    const inside = compareShip(shipReport(), { ...shipFloor, repaired: 2, tolerance: 5 }, {});
    caseOf('a repair count inside the band is a note', inside.issues, 0);
  }
  // The sweep. A small floor and a small report, so that each case fails only for the reason it is for:
  // the shipped total, a named candidate, a dropped candidate, and halves that traded rows under a
  // total that did not move — the last one being the state the guard exists to make visible.
  const censusFloor = {
    scored: 8,
    hit: 6,
    variants: {
      'distribution-wide': { hit: 7, halves: { a: 1, b: 0 } },
      'no-ranking': { hit: 9, halves: { a: 2, b: -1 } },
    },
  };
  const censusReport = () => ({
    scored: 8,
    product: [
      { variant: 'shipped', hit: 6, halves: { a: 0, b: 0 }, fitted: false },
      { variant: 'distribution-wide', hit: 7, halves: { a: 1, b: 0 }, fitted: false },
      { variant: 'no-ranking', hit: 9, halves: { a: 2, b: -1 }, fitted: true },
    ],
  });
  {
    caseOf('a sweep that reproduces its floor is accepted', compareCensus(censusReport(), censusFloor, { require: true }).issues, 0);
    caseOf('a missing sweep is refused when it is required', compareCensus(undefined, censusFloor, { require: true }).issues, 1);
    caseOf('a missing sweep is a note when it is not', compareCensus(undefined, censusFloor, {}).issues, 0);
    const moved = censusReport();
    moved.product[0].hit = 5;
    caseOf('a shipped table one row off its floor is refused, with no tolerance', compareCensus(moved, censusFloor, {}).issues, 1);
    const dropped = censusReport();
    dropped.product = dropped.product.filter((row) => row.variant !== 'no-ranking');
    caseOf('a table the floor records and the sweep dropped is refused', compareCensus(dropped, censusFloor, {}).issues, 1);
    const traded = censusReport();
    traded.product[2].halves = { a: 0, b: -2 };
    caseOf('a total that stands still while its halves move is refused', compareCensus(traded, censusFloor, {}).issues, 1);
    const elsewhere = censusReport();
    elsewhere.scored = 9;
    caseOf('a sweep over another row set is refused', compareCensus(elsewhere, censusFloor, {}).issues, 1);
    caseOf('a first sweep registers the floor instead of failing against it', compareCensus(censusReport(), {}, {}).issues, 0);
    caseOf('a report with no product table is refused', compareCensus({ scored: 8 }, censusFloor, {}).issues, 1);
    const headless = censusReport();
    headless.product = headless.product.filter((row) => row.variant !== 'shipped');
    caseOf('a sweep with no shipped row is refused', compareCensus(headless, censusFloor, {}).issues, 1);
    const gaps = { ...censusFloor, uncued: 3, uncovered: 1 };
    const reported = censusReport();
    reported.outcomes = { uncued: 3, uncovered: 1 };
    caseOf('the two gaps under their own words are accepted when they match', compareCensus(reported, gaps, {}).issues, 0);
    reported.outcomes = { uncued: 43, uncovered: 1 };
    caseOf('a trigger gap that grew by forty rows is refused even with every candidate unchanged', compareCensus(reported, gaps, {}).issues, 1);
    const words = censusReport();
    caseOf('a report with no outcomes block is refused when the floor records one', compareCensus(words, gaps, {}).issues, 2);
  }
  const recordedArms = JSON.parse(readFileSync(resolve(ROOT, BASELINE), 'utf8'))?.llm?.arms;
  const scales = Object.keys(recordedArms ?? {});
  const bothScales = scales.some((key) => key.endsWith('|mark')) && scales.some((key) => key.endsWith('|label'));
  caseOf(`the model floor records an arm per scale (${scales.join(', ') || 'none'})`, bothScales ? [] : ['no llm.arms'], 0);
  if (failed > 0) {
    console.error(`${String(failed)} self-test case(s) failed`);
    return 1;
  }
  console.log(`${String(reported)} self-test cases passed`);
  return 0;
}

/**
 * The cheap half of the instrument rule, asked of a dispatch before it spends anything.
 *
 * `--expect-instrument` exists because the report check runs *after* the money: a floor dispatch
 * that named the cheap grader would grade 1,416 figures on it and only then be told the reading is
 * not a floor. Checking the instrument the dispatch typed is the only part of that decision
 * available in advance, and it is the part a human gets wrong — the workflow defaults to the
 * iteration instrument now, so a floor run has to say both its model and its decode mode out loud.
 *
 * The spec is `model[@mode]`, where mode is `on`, `off` or `default` — the same three words the
 * workflow's `think` input takes. A spec with no mode is a spec that says the mode does not matter,
 * and that is not what the floor records, so it is refused rather than assumed.
 */
function checkExpectedInstrument(baseline, spec) {
  const floor = baseline?.judge?.grader;
  if (typeof floor?.model !== 'string') {
    console.error(
      `TEXT2VIS: ${BASELINE} records no \`judge.grader.model\`, so no dispatch can be held to the instrument that took the floor`,
    );
    return 2;
  }
  const [model, mode, ...rest] = spec.split('@');
  const known = mode === undefined || mode === 'default' || mode === 'on' || mode === 'off';
  if (model === undefined || model === '' || !known || rest.length > 0) {
    console.error(`--expect-instrument takes model[@mode] with mode default, on or off, e.g. --expect-instrument glm-4.5v@default`);
    return 2;
  }
  const asked = { model, ...(mode === undefined || mode === 'default' ? {} : { thinking: mode === 'on' }) };
  const divergence = differentInstrument(floor, asked);
  if (divergence !== undefined) {
    console.error(
      `TEXT2VIS: this dispatch would grade ${divergence} — a floor reading has to be taken on the ` +
        'instrument the floor was registered with; a reading that only claims a delta is declared with --iteration',
    );
    return 1;
  }
  const named = `${typeof floor.endpoint === 'string' ? `${floor.endpoint}/` : ''}${floor.model}`;
  console.log(`TEXT2VIS: the floor's instrument, ${named}: this dispatch may register a floor`);
  return 0;
}

/**
 * A request as one sentence, so two reports are compared by what they asked rather than by shape.
 *
 * `{ budget: undefined }` and `{}` are the same request — no cap was sent — and rendering both to the
 * same string is what keeps that comparison honest. A report that names nothing renders as its own
 * sentence rather than as a mismatch, because "the floor has no request" and "this file has none" are
 * two different repairs.
 */
export function describeRequest(request) {
  if (request === undefined || request === null || typeof request !== 'object') return 'no request at all';
  const version = typeof request.promptVersion === 'number' ? String(request.promptVersion) : 'an unstated version';
  const budget = request.budget === undefined ? 'no reply budget' : `a ${String(request.budget)}-token reply budget`;
  return `${version} with ${budget}`;
}

/**
 * Compare the model arm's reading against its floor.
 *
 * A separate reader rather than a fourth branch of `compare`, because the artifact is a different
 * shape and the scale decides what the number even is: a `mark` arm publishes a top-1 over the same
 * eleven marks the product can draw, and a `label` arm publishes an exact family count over the
 * corpus's own vocabulary. Comparing one against the other's floor would hold a model to a reading it
 * never took.
 *
 * Three things are checked besides the reading itself, and each of them is a way a report can be a
 * file rather than a measurement:
 *
 * - the arm must name the **request** it answered, and that request must be the floor's. This is the
 *   one check the counters cannot imply: every number in a stale artifact adds up. A local file left
 *   over from the first dispatch — prompt version 1, a 32-token reply cap, 857 top-1 — was scored
 *   against a floor of 861 and reported as "inside the band, not a regression", which is the sentence
 *   a gate says when it cannot see what it is reading. The same 1,470 rows read 861 under the 96-token
 *   cap the repository now sends, so the difference is the instrument, not the sample.
 * - `truncated` must be zero. A reply cut at the token budget is not an answer, and a share computed
 *   over the rows that survived is a share over a population chosen by the endpoint's cap.
 * - `scored` must equal the floor's, for `compare`'s reason: a reading over a different row set is a
 *   different question.
 * - `answered + unparsed` must equal `requested`. The arm asserts this itself; this re-checks it
 *   because a report is a file, and a counter that does not add up is a share on the wrong
 *   denominator wherever it was written.
 *
 * An arm the floor has no entry for is a *note*, not a failure: the first dispatch of a new model (or
 * a new scale) is the measurement that establishes the number, and a gate that refused it would
 * refuse the only run that could ever satisfy it.
 *
 * @returns {{issues: string[], notes: string[]}}
 */
export function compareLlm(report, floor, options = {}) {
  const issues = [];
  const notes = [];
  if (report === undefined) {
    const message = `TEXT2VIS LLM: no reading at ${LLM_REPORT} — \`pnpm bench:text2vis:llm --artifact ${LLM_REPORT}\` writes it`;
    if (options.require === true) issues.push(message);
    else notes.push(`${message} (not required here)`);
    return { issues, notes };
  }
  const arms = Array.isArray(report.arms) ? report.arms : [];
  if (arms.length === 0) {
    issues.push('TEXT2VIS LLM: the reading has no arms, so no model was priced');
    return { issues, notes };
  }
  const recorded = floor?.arms ?? {};
  // A hosted model at temperature 0 is not deterministic: three dispatches of one arm with no change
  // to its prompt, budget or rows read mark 857 / 859 / 856 and label 886 / 886 / 889. A floor with no
  // band therefore fails a re-sample — run 44439035718 was rejected at 856 against a floor of 857,
  // which is 0.07pp — and a gate that reds on noise is a gate that gets ignored, which is worse than
  // no gate because the number it protects then moves unnoticed.
  const tolerance = typeof floor?.tolerance === 'number' ? floor.tolerance : 0;
  for (const arm of arms) {
    const name = `${String(arm.model)}|${String(arm.scale)}`;
    if (arm.answered + arm.unparsed !== arm.requested) {
      issues.push(
        `TEXT2VIS LLM: ${name} reports ${String(arm.answered)} answered + ${String(arm.unparsed)} unparsed against ${String(arm.requested)} rows asked`,
      );
      continue;
    }
    // A cut reply invalidates the share whatever the request was, so it is refused before the floor
    // is consulted at all — the arm's own artifact says its rows are over the survivors of a cap.
    if (arm.truncated > 0) {
      issues.push(
        `TEXT2VIS LLM: ${name} had ${String(arm.truncated)} replies cut at the token budget, so its share is over the rows the cap survived`,
      );
      continue;
    }
    // The floor's request is a fact about the arms the floor *records*, which is why this lookup comes
    // before the comparison rather than after it. An arm nobody has priced has no request to be held
    // to, and holding it to another endpoint's cap refused the first dispatch of every second model:
    // a reasoning endpoint is sent **no** reply cap (`replyBudget` returns `undefined` where the model
    // thinks aloud, because a cap sized for one word truncates the deliberation), so its artifact
    // records `{promptVersion: 1}` and the floor records `96` — a fact about a different endpoint,
    // reported as a regression in an arm that had no reading to regress from.
    const entry = recorded[name];
    if (entry === undefined) {
      notes.push(
        `TEXT2VIS LLM: no floor recorded for ${name}; this reading establishes one (${String(arm.scored)} scored rows, and it answered ${describeRequest(arm.request)})`,
      );
      continue;
    }
    // The floor may record a request *per arm*, and once it does that is the one this arm is held to.
    // It has to be able to, because two arms in one dispatch are legitimately two instruments: a chat
    // endpoint is sent a 96-token reply cap and a reasoning endpoint is sent none (`replyBudget`), and
    // one global request would call the second arm's correct request a difference in instrument. The
    // global `request` stays as the default for the arms registered before this field existed.
    const wantedRequest = entry.request ?? floor?.request;
    if (wantedRequest !== undefined) {
      if (describeRequest(arm.request) !== describeRequest(wantedRequest)) {
        issues.push(
          `TEXT2VIS LLM: ${name} was answered on prompt ${describeRequest(arm.request)}, and the floor was taken on prompt ${describeRequest(wantedRequest)}; a reading of a different request is a different instrument, and comparing the two would report the instrument as a sample`,
        );
        continue;
      }
    } else if (arm.request !== undefined) {
      notes.push(`TEXT2VIS LLM: ${name} names prompt ${describeRequest(arm.request)} and the floor records none; this dispatch establishes it`);
    }
    if (arm.scored !== entry.scored) {
      issues.push(
        `TEXT2VIS LLM: ${name} scored ${String(arm.scored)} rows and the floor was recorded over ${String(entry.scored)}; a reading over a different row set is a different question`,
      );
      continue;
    }
    const dimension = arm.scale === 'mark' ? 'top1' : 'exact';
    const value = arm[dimension];
    if (typeof value !== 'number') {
      issues.push(`TEXT2VIS LLM: ${name} has no numeric \`${dimension}\`, so its reading cannot be compared`);
      continue;
    }
    if (value < entry[dimension] - tolerance) {
      issues.push(
        `TEXT2VIS LLM: ${name} fell to ${String(value)} ${dimension} (${((value / entry.scored) * 100).toFixed(2)}%) from the floor of ${String(entry[dimension])} (${((entry[dimension] / entry.scored) * 100).toFixed(2)}%), which is outside the ${String(tolerance)}-row band this instrument re-samples within`,
      );
      continue;
    }
    if (value < entry[dimension]) {
      notes.push(
        `TEXT2VIS LLM: ${name} reads ${String(value)} ${dimension} against a floor of ${String(entry[dimension])}, inside the ${String(tolerance)}-row band the same arm re-samples within — not a regression`,
      );
      continue;
    }
    notes.push(`TEXT2VIS LLM: ${name} reads ${String(value)} ${dimension} (${((value / entry.scored) * 100).toFixed(2)}%) against a floor of ${String(entry[dimension])}`);
  }
  return { issues, notes };
}

/**
 * The arbitration reading, against the floor it establishes.
 *
 * This is the only gate in the repository whose input is *derived*: no model is asked anything, the
 * policies are pure functions of two answer columns that were already bought. That makes it the one
 * gate that can be wrong in a way that still looks green — a policy that silently routes every row to
 * one answer reads exactly like a working policy — so the identities are re-checked here, on the file:
 *
 * - `agree + disagree === scored`: the disagreement is a partition of the population.
 * - `oracle.hit === agreeHit + productRight + modelRight`: the ceiling is the union, not a policy.
 * - `hit === agreeHit + keptRight + givenRight` for every policy: a policy routes to one of the two
 *   answers, so its hits are one from each of the three cells. A policy that invents a third answer
 *   breaks this and is refused.
 * - `best` names a policy that is actually the maximum; a table whose headline is not its own maximum
 *   is a table someone will quote wrongly.
 *
 * The floor carries a band for the same reason the model floor does: the answers underneath move by a
 * couple of rows per re-sample, and every number here is a function of them.
 *
 * @returns {{issues: string[], notes: string[]}}
 */
export function compareArbitration(report, floor, options = {}) {
  const issues = [];
  const notes = [];
  if (report === undefined) {
    const message = `TEXT2VIS ARBITRATION: no reading at ${ARBITRATION_REPORT} — \`pnpm bench:text2vis:arbitrate --answers ${LLM_REPORT} --artifact ${ARBITRATION_REPORT}\` writes it`;
    if (options.require === true) issues.push(message);
    else notes.push(`${message} (not required here)`);
    return { issues, notes };
  }
  const scored = report.population?.scored;
  if (scored !== floor.scored) {
    issues.push(
      `TEXT2VIS ARBITRATION: priced over ${String(scored)} rows and the floor was recorded over ${String(floor.scored)}; a policy read on a different row set is a different question`,
    );
    return { issues, notes };
  }
  const { agree, agreeHit, disagree, productRight, modelRight } = report.agreement ?? {};
  if (agree + disagree !== scored) {
    issues.push(`TEXT2VIS ARBITRATION: ${String(agree)} agreed + ${String(disagree)} disputed is not ${String(scored)} rows, so the partition is not one`);
    return { issues, notes };
  }
  const oracle = report.oracle?.hit;
  if (oracle !== agreeHit + productRight + modelRight) {
    issues.push(
      `TEXT2VIS ARBITRATION: the ceiling reads ${String(oracle)} and the three cells sum to ${String(agreeHit + productRight + modelRight)}; the union is every row either system got right`,
    );
  }
  const policies = Array.isArray(report.policies) ? report.policies : [];
  if (policies.length === 0) {
    issues.push('TEXT2VIS ARBITRATION: no policy was priced, so the table has no reading');
    return { issues, notes };
  }
  const tolerance = typeof floor.tolerance === 'number' ? floor.tolerance : 0;
  for (const policy of policies) {
    if (policy.hit !== agreeHit + policy.keptRight + policy.givenRight) {
      issues.push(
        `TEXT2VIS ARBITRATION: ${String(policy.name)} reads ${String(policy.hit)} but its cells sum to ${String(agreeHit + policy.keptRight + policy.givenRight)}; a policy routes a row to one of the two answers and to nothing else`,
      );
    }
  }
  const best = policies.find((policy) => policy.name === report.best);
  if (best === undefined) {
    issues.push(`TEXT2VIS ARBITRATION: \`best\` names ${String(report.best)}, which is not among the priced policies`);
    return { issues, notes };
  }
  const highest = Math.max(...policies.map((policy) => policy.hit));
  if (best.hit !== highest) {
    issues.push(`TEXT2VIS ARBITRATION: ${String(best.name)} is quoted as best at ${String(best.hit)} while another policy reads ${String(highest)}`);
  }
  if (best.hit < floor.best - tolerance) {
    issues.push(
      `TEXT2VIS ARBITRATION: the best policy fell to ${String(best.hit)} (${((best.hit / scored) * 100).toFixed(2)}%) from the floor of ${String(floor.best)}, which is outside the ${String(tolerance)}-row band this instrument re-samples within`,
    );
  } else if (best.hit < floor.best) {
    notes.push(`TEXT2VIS ARBITRATION: ${String(best.name)} reads ${String(best.hit)} against a floor of ${String(floor.best)}, inside the ${String(tolerance)}-row band — not a regression`);
  } else {
    notes.push(`TEXT2VIS ARBITRATION: ${String(best.name)} reads ${String(best.hit)} (${((best.hit / scored) * 100).toFixed(2)}%) against a floor of ${String(floor.best)}`);
  }
  if (oracle < floor.ceiling - tolerance) {
    issues.push(
      `TEXT2VIS ARBITRATION: the ceiling fell to ${String(oracle)} from the recorded ${String(floor.ceiling)}; the union is a property of the two answers, not of a policy`,
    );
  } else {
    notes.push(`TEXT2VIS ARBITRATION: ${String(policies.length)} policies priced, ceiling ${String(oracle)}, best ${String(best.name)}`);
  }
  const product = policies.find((policy) => policy.name === 'product');
  if (product === undefined) {
    issues.push('TEXT2VIS ARBITRATION: the table has no `product` baseline, so no policy can be said to beat the pipeline it would replace');
  } else if (product.hit !== floor.product) {
    issues.push(
      `TEXT2VIS ARBITRATION: the product baseline reads ${String(product.hit)} and the floor records ${String(floor.product)}; the rule path is deterministic, so this is a change to the product and not a re-sample`,
    );
  }
  return { issues, notes };
}

/**
 * The shipped path, against the floor it establishes.
 *
 * The arbitration prices a *policy*; this prices the *product*. `eval/text2vis/ship.ts` runs
 * `assistedMark` and `assistedChartIR` over the same answers and publishes two readings — the decision
 * and the chart — and the only reason those numbers mean anything is that the first one is the same
 * sentence as the arbitration's `model-holds`. Two implementations of one rule, in two packages: a
 * single row they disagree about is a row where the published hybrid number does not describe what a
 * caller receives.
 *
 * The identities re-checked here are the ones a derived reading can lose quietly:
 *
 * - `divergence` empty: the shipped decision is the policy, row for row. This is the hard one; there is
 *   no band, because both sides are computed from one artifact in one process.
 * - `fromModel + fromProduct === scored` and `sum(reasons) === fromProduct`: every row was decided by
 *   exactly one side, and every table-decided row carries exactly one reason.
 * - `changed <= wide + not-admitted + unchartable`: a chart may differ from the decision only because a
 *   veto replaced it with the table's answer. `shipReport` checks that row by row; this checks the
 *   arithmetic that would let a third answer hide.
 *
 * The floor itself is optional on the day it is created — the first dispatch that produces a ship
 * artifact establishes it, and the commit that earns it writes `decided` and `shipped` into
 * `baseline.json`. Until then the identities still run, which is most of the value: they are the part
 * that cannot be eyeballed.
 *
 * @returns {{issues: string[], notes: string[]}}
 */
export function compareShip(report, floor, options = {}) {
  const issues = [];
  const notes = [];
  if (report === undefined) {
    const message = `TEXT2VIS SHIP: no reading at ${SHIP_REPORT} — \`pnpm bench:text2vis:ship --answers ${LLM_REPORT} --artifact ${SHIP_REPORT}\` writes it`;
    if (options.require === true) issues.push(message);
    else notes.push(`${message} (not required here)`);
    return { issues, notes };
  }
  const scored = report.population?.scored;
  if (scored !== floor.scored) {
    issues.push(
      `TEXT2VIS SHIP: priced over ${String(scored)} rows and the floor was recorded over ${String(floor.scored)}; the shipped path on another row set is a different question`,
    );
    return { issues, notes };
  }
  const divergence = Array.isArray(report.divergence) ? report.divergence : [];
  if (divergence.length > 0) {
    const first = divergence[0] ?? {};
    issues.push(
      `TEXT2VIS SHIP: ${String(divergence.length)} row(s) where the shipped decision and the arbitration policy disagree; row ${String(first.row)}: policy ${String(first.policy)}, shipped ${String(first.shipped)}. The product and the published hybrid reading are the same rule and must be the same answer`,
    );
    return { issues, notes };
  }
  for (const name of ['decided', 'shipped']) {
    const counts = report[name] ?? {};
    // Three sources, and the third is a *second question*: a row can be answered by the model's first
    // answer, by its second one after the table refused the first, or by the table. A split that adds
    // up with only two of them is a repair counted as an ordinary decision.
    const repaired = counts.repaired ?? 0;
    if (counts.fromModel + repaired + counts.fromProduct !== scored) {
      issues.push(
        `TEXT2VIS SHIP: ${name} splits ${String(counts.fromModel)} first answers, ${String(repaired)} repairs and ${String(counts.fromProduct)} table answers over a population of ${String(scored)}`,
      );
      continue;
    }
    const reasons = Object.values(counts.reasons ?? {}).reduce((sum, value) => sum + value, 0);
    if (reasons !== counts.fromProduct) {
      issues.push(
        `TEXT2VIS SHIP: ${name} counts ${String(reasons)} reasons over ${String(counts.fromProduct)} table-decided rows, so a row is unexplained or counted twice`,
      );
    }
    if (counts.hit > scored) {
      issues.push(`TEXT2VIS SHIP: ${name} reads ${String(counts.hit)} hits over ${String(scored)} rows`);
    }
  }
  const vetoes =
    (report.shipped?.reasons?.wide ?? 0) +
    (report.shipped?.reasons?.['not-admitted'] ?? 0) +
    (report.shipped?.reasons?.unchartable ?? 0);
  const repairs = report.shipped?.repaired ?? 0;
  if (report.changed > vetoes + repairs) {
    issues.push(
      `TEXT2VIS SHIP: ${String(report.changed)} rows differ from the decision and only ${String(vetoes)} were vetoed and ${String(repairs)} repaired; a chart may only change to the table's answer or to the model's second one, and only when one of them explains it`,
    );
  }
  const tolerance = typeof floor.tolerance === 'number' ? floor.tolerance : 0;
  for (const name of ['decided', 'shipped']) {
    const recorded = floor[name];
    const measured = report[name]?.hit;
    if (typeof recorded !== 'number') {
      notes.push(`TEXT2VIS SHIP: ${name} reads ${String(measured)} and no floor is registered yet — this dispatch establishes it`);
      continue;
    }
    if (measured < recorded - tolerance) {
      issues.push(
        `TEXT2VIS SHIP: ${name} fell to ${String(measured)} (${((measured / scored) * 100).toFixed(2)}%) from the floor of ${String(recorded)}, which is outside the ${String(tolerance)}-row band this instrument re-samples within`,
      );
    } else if (measured < recorded) {
      notes.push(`TEXT2VIS SHIP: ${name} reads ${String(measured)} against a floor of ${String(recorded)}, inside the ${String(tolerance)}-row band — not a regression`);
    } else {
      notes.push(`TEXT2VIS SHIP: ${name} reads ${String(measured)} (${((measured / scored) * 100).toFixed(2)}%) against a floor of ${String(recorded)}`);
    }
  }
  // The repair has a floor of its own, and it is a *count* rather than a score. A dispatch where no
  // row was refused would read as a clean run and would in fact be a run that stopped asking the second
  // question — which is the gate measuring nothing while printing green.
  if (typeof floor.repaired === 'number') {
    if (repairs < floor.repaired - tolerance) {
      issues.push(
        `TEXT2VIS SHIP: ${String(repairs)} rows were answered by a second question and the floor records ${String(floor.repaired)}; a repair that stopped being asked is a gate that stopped measuring it`,
      );
    } else if (repairs < floor.repaired) {
      notes.push(`TEXT2VIS SHIP: ${String(repairs)} repairs against a floor of ${String(floor.repaired)}, inside the ${String(tolerance)}-row band — not a regression`);
    }
  }
  notes.push(
    `TEXT2VIS SHIP: ${String(report.changed)} row(s) drew an answer other than the decision's: ${String(vetoes)} vetoed and ${String(repairs)} repaired`,
  );
  return { issues, notes };
}

/**
 * The sweep's floor: the thirty-four candidate cue tables priced on the product path.
 *
 * The sweep is a *derived* reading — same corpus, same code, one cue table changed at a time — so it
 * has no sampling to absorb and no tolerance is offered. What it does have is a shape that made a
 * silent drift possible: every row is priced against the shipped table, so a change to the shipped
 * table moves all thirty-four rows at once, and a reader comparing a total against last round's total
 * is comparing two trees. That is not hypothetical. A draft of this round's documentation carried
 * `no-share` at 671 and `no-ranking` at 677; re-running the instrument on the tree the draft described
 * printed 665 and 669, because the numbers beside a widening had been taken while the widening was
 * applied and were never re-taken after it was reverted. The gate is the fix: the rows a reader quotes
 * are recorded here, compared for equality, and a move is refused until someone re-takes it on purpose.
 *
 * Four rows are recorded rather than all thirty-four. The shipped total is the denominator's row; the
 * other three are the ones a decision is read off — the one candidate the table currently backs
 * (`distribution-wide`), and the two the halves guard marks as fitted, which are exactly the two a
 * reader would otherwise quote as the top of the board.
 */
export function compareCensus(report, floor, options = {}) {
  const issues = [];
  const notes = [];
  if (report === undefined) {
    const message = `TEXT2VIS CENSUS: no sweep at ${CENSUS_REPORT} — \`pnpm bench:text2vis:census --artifact ${CENSUS_REPORT}\` writes it`;
    if (options.require === true) issues.push(message);
    else notes.push(`${message} (not required here)`);
    return { issues, notes };
  }
  if (typeof floor.scored !== 'number') {
    notes.push('TEXT2VIS CENSUS: no floor is registered yet — this run establishes it');
    return { issues, notes };
  }
  if (typeof report.scored !== 'number' || !Array.isArray(report.product)) {
    issues.push(
      'TEXT2VIS CENSUS: the report carries no `scored` count and no `product` table, so the sweep cannot be compared',
    );
    return { issues, notes };
  }
  if (report.scored !== floor.scored) {
    issues.push(
      `TEXT2VIS CENSUS: ${String(report.scored)} scored rows, the floor was recorded over ${String(floor.scored)}; ` +
        'a sweep over a different row set is a different question, so no hit count is compared until the corpus is explained',
    );
    return { issues, notes };
  }
  const rows = new Map(report.product.map((variant) => [variant.variant, variant]));
  const shipped = rows.get('shipped');
  if (shipped === undefined || typeof shipped.hit !== 'number') {
    issues.push('TEXT2VIS CENSUS: the sweep has no `shipped` row, so there is nothing for the other thirty-three to be priced against');
    return { issues, notes };
  }
  if (shipped.hit !== floor.hit) {
    issues.push(
      `TEXT2VIS CENSUS: the shipped table reads ${String(shipped.hit)} of ${String(report.scored)}, the floor records ${String(floor.hit)}; ` +
        'the sweep has no sampling, so this is a change to the cue table or to the classifier and not a re-sample',
    );
  } else {
    notes.push(`TEXT2VIS CENSUS: the shipped table reads ${String(shipped.hit)} of ${String(report.scored)}, at its floor`);
  }
  // The two gaps that are not candidates: a family no mark leads with, and a family the question never
  // named. They are recorded because they are the numbers a plan is written from, and because the
  // change that separated them moved one of them by forty rows without moving a single hit.
  for (const name of ['uncued', 'uncovered']) {
    if (typeof floor[name] !== 'number') continue;
    const measured = report.outcomes?.[name];
    if (typeof measured !== 'number') {
      issues.push(`TEXT2VIS CENSUS: the report has no \`outcomes.${name}\` count, and the floor records ${String(floor[name])}`);
      continue;
    }
    if (measured !== floor[name]) {
      issues.push(
        `TEXT2VIS CENSUS: \`${name}\` reads ${String(measured)}, the floor records ${String(floor[name])} — re-take it before quoting it`,
      );
    } else {
      notes.push(`TEXT2VIS CENSUS: \`${name}\` reads ${String(measured)}`);
    }
  }
  for (const [name, recorded] of Object.entries(floor.variants ?? {})) {
    const row = rows.get(name);
    if (row === undefined) {
      issues.push(
        `TEXT2VIS CENSUS: the floor records \`${name}\` and the sweep does not price it; a table that is dropped stops measuring its lever`,
      );
      continue;
    }
    const halves = `${String(row.halves?.a)}/${String(row.halves?.b)}`;
    const recordedHalves = `${String(recorded.halves?.a)}/${String(recorded.halves?.b)}`;
    if (row.hit !== recorded.hit) {
      issues.push(
        `TEXT2VIS CENSUS: \`${name}\` reads ${String(row.hit)}, the floor records ${String(recorded.hit)} — re-take the row before quoting it`,
      );
      continue;
    }
    if (halves !== recordedHalves) {
      issues.push(
        `TEXT2VIS CENSUS: \`${name}\` reads ${String(row.hit)} on both sides but its halves moved ${recordedHalves} -> ${halves}; ` +
          'the total can stand still while the two halves trade rows, which is the one thing the guard exists to show',
      );
      continue;
    }
    notes.push(`TEXT2VIS CENSUS: \`${name}\` reads ${String(row.hit)} (${halves})${row.fitted === true ? ', fitted' : ''}`);
  }
  return { issues, notes };
}

function main(argv) {
  if (argv.includes('--self-test')) return selfTest();  const require = argv.includes('--require');
  // A separate switch, because the two readings are produced by different runs: `--require` is the
  // chart job, which renders and scores and never grades, and demanding a judge artifact from it
  // turned that job red on the push that registered the judge floor. `--require-judge` is the
  // dispatch-only grading workflow, where a missing artifact is a broken chain rather than a run
  // that never had a vision endpoint to call.
  const requireJudge = argv.includes('--require-judge');
  // An iteration reading is a delta on the cheap instrument: paired within row, and never a floor.
  // Declared rather than inferred, because the inference would be "anything that does not match the
  // floor is allowed", which is the rule this gate exists to refuse.
  const iteration = argv.includes('--iteration');
  // The model arm's dispatch, which produces no profile report at all: it asks a model, writes one
  // artifact and compares it with its own floor. A flag rather than a guess from which file exists,
  // because a run that has both artifacts should be read by the reader that knows what it produced.
  const llm = argv.includes('--llm');
  // The derived reading: priced from the answers the step above bought, so it is a separate switch
  // from `--llm` — a run of the model arm alone has no arbitration artifact to check.
  const arbitration = argv.includes('--arbitration');
  // The product's own reading of the same answers. A separate switch for the same reason the
  // arbitration has one: it is produced by a step of its own, and a dispatch that skipped it must be
  // told so rather than read the absence as agreement.
  const ship = argv.includes('--ship');
  // The derived sweep, whose artifact is written by the census step: a dispatch that skipped it must be
  // told so rather than read the absence as agreement.
  const census = argv.includes('--census');
  const known = new Set(['--require', '--require-judge', '--iteration', '--self-test', '--expect-instrument', '--llm', '--arbitration', '--ship', '--census']);
  // The value after `--expect-instrument` is a model name and not a flag, so it is skipped rather than
  // reported as an unknown argument.
  const flags = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--expect-instrument') {
      index += 1;
      continue;
    }
    flags.push(argv[index]);
  }
  const unknown = flags.filter((flag) => !known.has(flag));
  if (unknown.length > 0) {
    console.error(
      `unknown argument ${unknown.join(' ')}: this gate reads ${REPORT} against ${BASELINE}, takes --require, ` +
        '--require-judge, --iteration, --expect-instrument <model>, --llm, --arbitration, --ship, --census and --self-test',
    );
    return 2;
  }
  const reportPath = resolve(ROOT, REPORT);
  const baselinePath = resolve(ROOT, BASELINE);
  if (!existsSync(baselinePath)) {
    console.error(`TEXT2VIS: no floor at ${BASELINE}; a gate with no recorded reading is not a gate`);
    return 2;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (llm) {
    const llmPath = resolve(ROOT, LLM_REPORT);
    const llmReport = existsSync(llmPath) ? JSON.parse(readFileSync(llmPath, 'utf8')) : undefined;
    const { issues: llmIssues, notes: llmNotes } = compareLlm(llmReport, baseline.llm, { require });
    for (const note of llmNotes) console.log(note);
    for (const issue of llmIssues) console.error(issue);
    return llmIssues.length === 0 ? 0 : 1;
  }
  if (arbitration) {
    const path = resolve(ROOT, ARBITRATION_REPORT);
    const report = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    const { issues: arbIssues, notes: arbNotes } = compareArbitration(report, baseline.llm?.arbitration ?? {}, { require });
    for (const note of arbNotes) console.log(note);
    for (const issue of arbIssues) console.error(issue);
    return arbIssues.length === 0 ? 0 : 1;
  }
  if (ship) {
    const path = resolve(ROOT, SHIP_REPORT);
    const report = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    const { issues: shipIssues, notes: shipNotes } = compareShip(report, baseline.llm?.ship ?? {}, { require });
    for (const note of shipNotes) console.log(note);
    for (const issue of shipIssues) console.error(issue);
    return shipIssues.length === 0 ? 0 : 1;
  }
  if (census) {
    const path = resolve(ROOT, CENSUS_REPORT);
    const report = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    const { issues: censusIssues, notes: censusNotes } = compareCensus(report, baseline.census ?? {}, { require });
    for (const note of censusNotes) console.log(note);
    for (const issue of censusIssues) console.error(issue);
    return censusIssues.length === 0 ? 0 : 1;
  }
  // Before the report, before the corpus, before a call: the one question about a dispatch that can
  // be answered from a file. A floor reading on another instrument costs a full reading and then
  // fails, so it is refused first — the workflow runs this step above the probe.
  const expected = argv.indexOf('--expect-instrument');
  if (expected !== -1) {
    const asked = argv[expected + 1];
    if (asked === undefined || asked.startsWith('--')) {
      console.error('--expect-instrument needs a model name, e.g. --expect-instrument glm-4.5v');
      return 2;
    }
    return checkExpectedInstrument(baseline, asked);
  }
  if (!existsSync(reportPath)) {
    const message = `TEXT2VIS: no reading at ${REPORT} — \`pnpm bench:text2vis:profile --artifact ${REPORT}\` writes it`;
    if (require) {
      console.error(message);
      return 1;
    }
    console.log(`${message} (not required here)`);
    return 0;
  }
  const { issues, notes } = compare(JSON.parse(readFileSync(reportPath, 'utf8')), baseline, { require });
  // The pixel reading, when the floor records one: a run of the profile step alone has not rendered
  // anything, and a gate that demanded a render report from it would fail the cheaper half.
  let renderIssues = [];
  let renderNotes = [];
  if (baseline.render !== undefined) {
    const renderPath = resolve(ROOT, RENDER_REPORT);
    const renderReport = existsSync(renderPath) ? JSON.parse(readFileSync(renderPath, 'utf8')) : undefined;
    ({ issues: renderIssues, notes: renderNotes } = compareRender(renderReport, baseline.render, { require }));
  }
  // The grading reading, on the same rule: a floor that records one is compared when the artifact
  // exists, and a run of the cheaper halves is not asked for a file it never produced.
  let judgeIssues = [];
  let judgeNotes = [];
  if (baseline.judge !== undefined) {
    const judgePath = resolve(ROOT, JUDGE_REPORT);
    const judgeReport = existsSync(judgePath) ? JSON.parse(readFileSync(judgePath, 'utf8')) : undefined;
    ({ issues: judgeIssues, notes: judgeNotes } = compareJudge(judgeReport, baseline.judge, { require: requireJudge, iteration }));
  }
  for (const note of [...notes, ...renderNotes, ...judgeNotes]) console.log(note);
  for (const issue of [...issues, ...renderIssues, ...judgeIssues]) console.error(issue);
  return issues.length + renderIssues.length + judgeIssues.length === 0 ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
