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
  notes.push(
    `TEXT2VIS: top-1 ${String(profile.top1)} (${share(profile.top1)}) against a floor of ${String(baseline.top1)}; ` +
      `shortlist ${String(profile.shortlist)} (${share(profile.shortlist)}), declined ${String(profile.declined)}, ` +
      `missed ${String(baseline.scored - profile.top1 - profile.declined)}`,
  );
  return { issues, notes };
}

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

function selfTest() {
  const baseline = { scored: 1470, top1: 526 };
  let failed = 0;
  for (const test of SELF_TEST) {
    const { issues } = compare(test.report, baseline, test.require === true ? { require: true } : {});
    const ok = issues.length === test.want;
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${test.name}${ok ? '' : ` — ${String(issues.length)} issues, wanted ${String(test.want)}`}`);
  }
  if (failed > 0) {
    console.error(`${String(failed)} self-test case(s) failed`);
    return 1;
  }
  console.log(`${String(SELF_TEST.length)} self-test cases passed`);
  return 0;
}

function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  const require = argv.includes('--require');
  const unknown = argv.filter((flag) => flag !== '--require' && flag !== '--self-test');
  if (unknown.length > 0) {
    console.error(`unknown argument ${unknown.join(' ')}: this gate reads ${REPORT} against ${BASELINE}, takes --require and --self-test`);
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
  for (const note of notes) console.log(note);
  for (const issue of issues) console.error(issue);
  return issues.length === 0 ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
