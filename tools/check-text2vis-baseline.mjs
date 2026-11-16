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
 *   node tools/check-text2vis-baseline.mjs --self-test
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const BASELINE = 'eval/text2vis/baseline.json';
const REPORT = 'eval/out/text2vis-profile.json';
const RENDER_REPORT = 'eval/out/text2vis-render.json';
const JUDGE_REPORT = 'eval/out/text2vis-judge.json';

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
 * Compare the judged reading against the floor.
 *
 * This one holds a different kind of statement from the two above, and the difference is worth
 * spelling out: `compare` and `compareRender` compare *counts* against a recorded count, while the
 * grader produces two means on an ordinal scale a model invented. So the floor here is not a number
 * to stay above — it is the shape a reading must have before its means mean anything:
 *
 * 1. **One call per attempted row.** Two dimensions come back from one prompt, so `calls` must equal
 *    `judged + failed` exactly. A run that spent more asked twice, and its means are over a different
 *    instrument from the one `eval/text2vis/judge.ts` documents.
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
  if (report.calls !== report.judged + report.failed) {
    issues.push(
      `TEXT2VIS JUDGE: ${String(report.calls)} calls for ${String(report.judged)} judged and ${String(report.failed)} failed — ` +
        `this instrument asks both dimensions in one call, so anything but one call per attempted row is a different instrument`,
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
  }
  notes.push(
    `TEXT2VIS JUDGE: chart_correctness ${Number(means.chart_correctness ?? 0).toFixed(2)}/10, ` +
      `readability ${Number(means.readability ?? 0).toFixed(2)}/10 over ${String(report.judged)} of ` +
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
  { name: 'no judge report is a failure when it is required', report: undefined, want: 1, require: true },
  { name: 'no judge report is a note when it is not', report: undefined, want: 0 },
];

/** Cases that pin the three failures the gate exists for, plus the one it must not invent. */
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
  const floor = { rendered: 1286, failed: 0 };
  let failed = 0;
  for (const test of SELF_TEST) {
    const { issues } = compare(test.report, baseline, test.require === true ? { require: true } : {});
    const ok = issues.length === test.want;
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${test.name}${ok ? '' : ` — ${String(issues.length)} issues, wanted ${String(test.want)}`}`);
  }
  for (const test of RENDER_SELF_TEST) {
    const { issues } = compareRender(test.report, floor, test.require === true ? { require: true } : {});
    const ok = issues.length === test.want;
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${test.name}${ok ? '' : ` — ${String(issues.length)} issues, wanted ${String(test.want)}`}`);
  }
  for (const test of JUDGE_SELF_TEST) {
    const { issues } = compareJudge(test.report, { dimensions: ['chart_correctness', 'readability'] }, test.require === true ? { require: true } : {});
    const ok = issues.length === test.want;
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${test.name}${ok ? '' : ` — ${String(issues.length)} issues, wanted ${String(test.want)}`}`);
  }
  if (failed > 0) {
    console.error(`${String(failed)} self-test case(s) failed`);
    return 1;
  }
  console.log(`${String(SELF_TEST.length + RENDER_SELF_TEST.length + JUDGE_SELF_TEST.length)} self-test cases passed`);
  return 0;
}

function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  const require = argv.includes('--require');
  // A separate switch, because the two readings are produced by different runs: `--require` is the
  // chart job, which renders and scores and never grades, and demanding a judge artifact from it
  // turned that job red on the push that registered the judge floor. `--require-judge` is the
  // dispatch-only grading workflow, where a missing artifact is a broken chain rather than a run
  // that never had a vision endpoint to call.
  const requireJudge = argv.includes('--require-judge');
  const known = new Set(['--require', '--require-judge', '--self-test']);
  const unknown = argv.filter((flag) => !known.has(flag));
  if (unknown.length > 0) {
    console.error(
      `unknown argument ${unknown.join(' ')}: this gate reads ${REPORT} against ${BASELINE}, takes --require, --require-judge and --self-test`,
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
    ({ issues: judgeIssues, notes: judgeNotes } = compareJudge(judgeReport, baseline.judge, { require: requireJudge }));
  }
  for (const note of [...notes, ...renderNotes, ...judgeNotes]) console.log(note);
  for (const issue of [...issues, ...renderIssues, ...judgeIssues]) console.error(issue);
  return issues.length + renderIssues.length + judgeIssues.length === 0 ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
