#!/usr/bin/env node
/**
 * What a push has to measure.
 *
 * `ci.yml` runs four jobs on every push to master, and two of them spend model calls:
 * `bird-eval` sends thirteen arms over 496 questions — about 6,400 completions — and
 * `live-eval` sends three passes over 210 cases. Neither number depends on a word in
 * `docs/`, and the run that followed `843a966` (a `benchmarks.md` section, a `CHANGELOG`
 * entry and a comment in `eval/bird/run.ts`) re-priced all thirteen arms anyway. Two
 * documentation pushes in one round cost ~12,800 completions to learn nothing, which is
 * the kind of spend that never shows up in a budget because it is called CI.
 *
 * A Markdown file is never read by the pipeline at runtime: the prompts come from the
 * schema card, the curated notes, the value samples and the question. So the rule is a
 * property of the file name rather than a list of directories that drifts — one
 * `docs/*.md` added to `packages/` would break a list and not a suffix.
 *
 * The chart reading is the third. `eval/text2vis/` is an instrument over a public corpus: its four
 * files import `@agentix-e/nl2charts-chart` and each other, and nothing in `packages/` or `eval/bird/`
 * imports them back — they are a leaf. What they move is the chart number, and
 * `.github/workflows/text2vis-rule.yml` re-takes that number on every push that touches them, for no
 * model call and no key. Paying for thirteen BIRD arms and three live passes to re-time a change the
 * cheap job already timed is the same defect as measuring a Markdown paragraph, in the other
 * direction: a rule that only ever widens is a rule that stops being read.
 *
 * Tests are the second such class. The number comes from `eval/` and `packages/`, and
 * `test/` is run by the `quality` job, which is never skipped; a push whose only code is a
 * test file therefore cannot move a number, and the red step of a TDD round — the commit
 * written before the implementation exists — is exactly the push that should cost nothing.
 * The two roots are named rather than pattern-matched, so a new directory has to be argued
 * for instead of inherited.
 *
 * Two polities make the rule conservative in the direction that costs money:
 *
 * - **An empty list measures.** A push nobody could describe is a push to measure, and a
 *   filter that reads "no files" as "no code" turns a reporting bug into a skipped run.
 * - **A list of 300 or more measures.** GitHub's commit endpoint stops at 300 files, so a
 *   list that long may be missing the `.ts` that matters. The truncation is invisible in
 *   the payload, which is why the count — not a flag — is the signal.
 *
 * The tool writes both files the step needs instead of printing a stream a shell has to
 * split. The first version printed the reason *and* the key on stdout, the workflow piped
 * both into `$GITHUB_OUTPUT`, and the run failed with `Invalid format '3 of 5 changed
 * file(s) are not Markdown'` — the file-command parser accepts `key=value` lines and
 * nothing else. Splitting the streams in a shell is a rule no unit test can hold; passing
 * the two paths in makes the split part of the contract.
 */
import { appendFileSync, readFileSync } from 'node:fs';

/** The commit endpoint's page size, and therefore the length at which a list may be cut. */
export const TRUNCATED_AT = 300;

/** Documentation is a file whose own name ends in a Markdown suffix. */
export function isDocumentation(file) {
  return /\.(?:md|markdown)$/i.test(file);
}

/**
 * A test is a file the `quality` job runs, and no prompt and no benchmark reads.
 *
 * The change set that most needs to be cheap is the red step of a TDD round — the one
 * written before the code exists — and until this rule existed it bought thirteen arms over
 * the whole split. Two roots are named rather than matched: `test/` at the repository root
 * and `packages/<name>/test/`, which is where every suite lives. `eval/test/…` is *not* a
 * test, because `eval/` holds the instrument and the corpora it reads, and a rule written as
 * "any segment called `test`" would let a directory nobody argued for buy a skip.
 *
 * The suffix covers a test colocated with its source, which is how a new package arrives.
 * It is anchored on the dot so `latest/`, `contest.ts` and `attestation.ts` stay source.
 */
export function isTest(file) {
  const segments = file.split('/');
  if (segments[0] === 'test') return true;
  if (segments[0] === 'packages' && segments[2] === 'test') return true;
  return /\.test\.(?:ts|tsx|mts)$/i.test(file);
}

/**
 * A file the chart reading is made of, which no product path imports.
 *
 * The claim is checkable and was checked: `grep -rn 'eval/text2vis' packages/ eval/ tools/` finds
 * comments and no import, so a change here cannot reach a SQL prompt. The directory is named in full
 * rather than matched as `eval/*`, because `eval/bird/` *is* the harness that spends the calls.
 *
 * `packages/chart/` is the same class from the other side, and it took a round to notice. The chart
 * package is *product* code, which is why it was left out of this rule — but the products that spend
 * model calls are the SQL ones, and neither `packages/` nor `eval/bird/` imports it: the chart package
 * depends on `spec` and nothing depends on it except `eval/text2vis/`. A round that changed the cue
 * table in `packages/chart/src/recommend.ts` therefore bought thirteen BIRD arms over 496 questions
 * and three live passes over 210 cases to re-measure a SQL pipeline that had not changed a byte — the
 * same defect as measuring a Markdown paragraph, one directory over.
 *
 * What makes the exemption safe is the pairing rather than the claim: `text2vis-rule.yml` triggers on
 * `packages/chart/**` and re-takes the chart number for no model call, so the paths this rule drops
 * are exactly the paths that job picks up. A file in the package that the cheap job does not run is a
 * file nobody measures, which is why the two lists are edited together.
 */
export function isChartReading(file) {
  return /^eval\/text2vis\/[^/]+\.(?:ts|mts|json|csv)$/i.test(file) || /^packages\/chart\/(?:src\/[^/]+|package\.json|tsup\.config\.ts)$/i.test(file);
}

/**
 * A gate's own configuration: the files `tools/check-*.mjs` read.
 *
 * `budgets.json` is a bundle ceiling, `api-surface.json` is a snapshot of what each package
 * exports, and `eval/coverage-ledger.json` is the per-file coverage record `check-eval-coverage`
 * compares against. The third was added after four consecutive pushes that changed nothing a
 * prompt reads and bought the whole chain: the ledger lives under `eval/`, so a classifier written
 * as a list of root files read it as a reading rather than as a number the gate holds. The readers are `tools/check-budgets.mjs` and `tools/check-exports.mjs`, both run by the
 * `quality` job, which is never skipped — and neither file is opened by a prompt builder. A round
 * that moved a budget therefore bought thirteen arms over 496 questions and three live passes over
 * 210 cases to re-measure a SQL pipeline that had not changed a byte, and the round before that
 * escaped it only because a second commit cancelled the first run. **The saving was luck, not
 * design**, which is why this is a rule and not a note.
 *
 * Two names rather than a suffix, for the reason `isTest` gives: `package.json` in the same
 * directory changes what runs and what is installed, and a rule written as "any JSON at the root"
 * would swallow it. A new root-level configuration has to be argued for here instead of inherited.
 */
export function isToolConfig(file) {
  return file === 'budgets.json' || file === 'api-surface.json' || file === 'eval/coverage-ledger.json';
}

/**
 * A declaration, which TypeScript erases: `.d.mts` is a type for a script, not the script.
 *
 * The suffix rather than a directory, and it is the one classification here that needs no argument
 * about imports: a `.d.mts` file emits nothing, so no runtime that spends a call can read it. What
 * keeps it honest is the pairing — `test/tool-declarations.test.ts` compares every declaration
 * against the module beside it in both directions, and `quality` runs that suite on every push, so a
 * declaration that drifts is caught by the job that never skips rather than by a measurement.
 *
 * The round that added this read it off its own failure: `tools/ci-scope.d.mts` was missing an
 * export, and the push that carried the fix bought thirteen BIRD arms over 496 questions and three
 * live passes over 210 cases to re-typecheck a file no prompt opens.
 */
export function isDeclaration(file) {
  return /\.d\.mts$/i.test(file);
}

/**
 * The classes a file can belong to and still be read by no prompt, in the order the reason names
 * them.
 *
 * Named as data rather than written as a chain of conditionals: the reason sentence has to enumerate
 * the classes that were present, and the version that grew one branch per class stopped being
 * readable at four — which is the point at which a reader stops checking that the sentence is true.
 */
const EXEMPT_CLASSES = [
  { matches: isDocumentation, name: 'Markdown' },
  { matches: isTest, name: 'tests' },
  { matches: isChartReading, name: 'the chart reading' },
  { matches: isToolConfig, name: "a gate's own configuration" },
  { matches: isDeclaration, name: 'a type declaration' },
];

/** `a`, `a or b`, `a, b or c` — the shape the reason sentence puts the classes in. */
function enumerate(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/**
 * Whether a change set has to be measured, and why.
 *
 * The reason is returned rather than logged because it is what the workflow prints: a
 * skipped measurement that says nothing is indistinguishable from one that failed to
 * schedule, and this repository has already paid for that confusion once.
 */
export function needsModel(files) {
  const paths = files.map((file) => file.trim()).filter((file) => file.length > 0);
  if (paths.length === 0) {
    return { measure: true, reason: 'no changed files were reported, and an undescribed push is measured' };
  }
  if (paths.length >= TRUNCATED_AT) {
    return {
      measure: true,
      reason: `the list holds ${paths.length} files and the commit endpoint stops at ${TRUNCATED_AT}, so the .ts may be in the part that was cut`,
    };
  }
  const code = paths.filter((path) => !EXEMPT_CLASSES.some((entry) => entry.matches(path)));
  if (code.length === 0) {
    // The sentence names the classes that were actually present, because a reader sees it *instead
    // of* a measurement: "all files are Markdown" would be a lie about a push that changed the chart
    // reading, and a reason that misnames itself is a skip nobody audits.
    const present = EXEMPT_CLASSES.filter((entry) => paths.some((path) => entry.matches(path)));
    const clause = !present.some((entry) => entry.matches === isChartReading)
      ? ''
      : '; the chart reading is re-taken by `text2vis-rule` without a model call';
    return {
      measure: false,
      reason: `all ${paths.length} changed file(s) are ${enumerate(present.map((entry) => entry.name))}, and each is read by a job that never skips${clause}`,
    };
  }
  return {
    measure: true,
    reason: `${code.length} of ${paths.length} changed file(s) are read by a prompt or by the harness, so this push is measured`,
    files: code,
  };
}

/** The reading a human gets: the reason, then the files that forced it, capped at five. */
export function explain(result) {
  const shown = (result.files ?? []).slice(0, 5);
  const lines = [result.reason];
  for (const file of shown) lines.push(`  ${file}`);
  const hidden = (result.files?.length ?? 0) - shown.length;
  if (hidden > 0) lines.push(`  … and ${hidden} more`);
  return lines;
}

/** The step summary: the same reading under a heading, so a skipped run explains itself. */
export function summary(result) {
  return ['### did this push touch anything a prompt reads', '', ...explain(result), ''].join('\n');
}

/**
 * The two files the step needs, written rather than printed.
 *
 * `output` takes exactly one line, because a GitHub output file is a `key=value` list and
 * the parser fails the step on anything else. `summary` takes Markdown, because the step
 * summary is rendered and a bare key is not a sentence.
 */
export function publish(result, targets) {
  if (targets.summary !== undefined) appendFileSync(targets.summary, summary(result));
  if (targets.output !== undefined) appendFileSync(targets.output, `models=${result.measure ? 'true' : 'false'}\n`);
}

function flag(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

function main() {
  const files = process.argv.includes('--files')
    ? process.argv.slice(process.argv.indexOf('--files') + 1)
    : readFileSync(0, 'utf8').split('\n');
  const result = needsModel(files);
  publish(result, { summary: flag('--summary'), output: flag('--output') });
  // The step log is where a reader who is already looking at the run sees the same
  // sentence without opening the summary tab.
  process.stdout.write(`${explain(result).join('\n')}\n`);
}

if (process.argv[1] && process.argv[1].endsWith('ci-scope.mjs')) main();
