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
 */
import { readFileSync } from 'node:fs';

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

/** The lines a workflow appends to `$GITHUB_OUTPUT`, and the reading it prints beside them. */
export function render(result) {
  const shown = (result.files ?? []).slice(0, 5);
  const lines = [result.reason];
  for (const file of shown) lines.push(`  ${file}`);
  const hidden = (result.files?.length ?? 0) - shown.length;
  if (hidden > 0) lines.push(`  … and ${hidden} more`);
  lines.push(`models=${result.measure ? 'true' : 'false'}`);
  return lines.join('\n');
}

function main() {
  const stdin = process.argv.includes('--files')
    ? process.argv.slice(process.argv.indexOf('--files') + 1)
    : readFileSync(0, 'utf8').split('\n');
  const result = needsModel(stdin);
  process.stdout.write(`${render(result)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith('ci-scope.mjs')) main();
