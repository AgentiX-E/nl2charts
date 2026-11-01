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
  const code = paths.filter((path) => !isDocumentation(path));
  if (code.length === 0) {
    return { measure: false, reason: `all ${paths.length} changed file(s) are Markdown, which no prompt reads` };
  }
  return {
    measure: true,
    reason: `${code.length} of ${paths.length} changed file(s) are not Markdown`,
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
