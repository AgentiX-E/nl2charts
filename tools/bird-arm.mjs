#!/usr/bin/env node
/**
 * Which arm the dev workflow's diagnostic steps should price.
 *
 * `bird-dev.yml` dispatches a chosen `arms` list and then runs five instruments over the
 * artifact — what the values gap asks for, what the card costs, what the answer joins, what
 * the prompt would have had to say, what one provable edit recovers. Each of those takes
 * `--arm`, and each step passed the literal `select`, which is an arm the *Mini-Dev* chain
 * always runs and a dev dispatch runs only when it is asked for. Run `41356370371` dispatched
 * `select-mixed,select-cross` to price a reasoning model in one slot, and died at the first of
 * the five with
 *
 *     Error: eval/out/bird-eval.json has no arm select; it holds select-cross, select-mixed
 *
 * — the pipeline reporting on itself in the one way that looks like a broken harness rather
 * than a step that named an arm nobody ran. The other four steps would have said the same.
 *
 * A shell one-liner (`${BIRD_ARMS%%,*}`) would pick the same name, but the choice has two
 * edges — an artifact that holds none of the requested arms, and a request list with a stray
 * comma — and a filter written inline is a filter nobody can test. So the decision lives here
 * and the steps ask for it.
 *
 * Two rules, in order:
 *
 * 1. **The run's own request, first.** `BIRD_ARMS` is what the dispatch asked for, so the first
 *    of those names the artifact actually holds is the arm the run is about. This keeps
 *    `bird-dev.yml` honest for any arm set, which is the whole point: the steps stopped being
 *    about `select` the day the workflow gained an `arms` input.
 * 2. **Otherwise the arm with the most cases**, ties alphabetical. An artifact whose arms
 *    nobody asked for is still an artifact: the largest population is the reading with the
 *    least noise, and the tie-break keeps two identical runs printing the same name.
 *
 * Nothing is printed on stdout except the name, because the caller substitutes it into a
 * command. A reason on stdout would become an argument, so the reason goes to stderr.
 */
import { readFileSync } from 'node:fs';

/** The environment variable that names the arms a dispatch asked for. */
export const REQUESTED_ENV = 'BIRD_ARMS';

/** Arm names the case rows carry, sorted, so two runs print the same order. */
export function readArms(cases) {
  const names = new Set();
  for (const row of cases) {
    if (typeof row?.arm === 'string' && row.arm.length > 0) names.add(row.arm);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

/**
 * The arm to price, and why.
 *
 * Throws rather than returns empty: a workflow step that substitutes an empty string into
 * `--arm` would be measured as "arm `` has no cases", which names the wrong defect.
 */
export function chooseArm(cases, requested) {
  const arms = readArms(cases);
  if (arms.length === 0) {
    throw new Error('this artifact holds no arm at all, so there is nothing for the diagnostic steps to price');
  }
  const wanted = requested
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  for (const name of wanted) {
    if (arms.includes(name)) {
      return { arm: name, reason: `${name} is the first arm this run asked for that the artifact holds` };
    }
  }
  const counts = new Map();
  for (const row of cases) {
    if (typeof row?.arm !== 'string' || row.arm.length === 0) continue;
    counts.set(row.arm, (counts.get(row.arm) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const [arm, size] = ranked[0];
  return {
    arm,
    reason:
      wanted.length === 0
        ? `no arms were requested, so the largest population (${arm}, ${String(size)} cases) is priced`
        : `none of the requested arms (${wanted.join(', ')}) is in this artifact, so the largest population (${arm}, ${String(size)} cases) is priced`,
  };
}

/** Read the artifact's cases. A file that is not JSON is the caller's path, not this rule. */
export function casesOf(artifactPath) {
  const parsed = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const cases = parsed?.cases;
  if (!Array.isArray(cases)) {
    throw new Error(`${artifactPath} holds no cases array, so it is not an evaluation artifact`);
  }
  return cases;
}

/**
 * The sentence for whatever was thrown.
 *
 * Split out because the alternative is a branch no test can reach: every error this file raises is
 * an `Error`, so the non-`Error` arm of the ternary would sit in the catch block unexecuted and be
 * counted as untested code. Called directly, both arms are covered and the catch stays two lines.
 */
export function message(thrown) {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

export function main(argv, env, log, error) {
  const path = argv[0];
  if (path === undefined) {
    error('usage: bird-arm.mjs <artifact.json>   (the arm is chosen from $BIRD_ARMS, else the largest population)');
    return 1;
  }
  try {
    const chosen = chooseArm(casesOf(path), env[REQUESTED_ENV] ?? '');
    error(`bird-arm: ${chosen.reason}`);
    log(chosen.arm);
    return 0;
  } catch (thrown) {
    error(message(thrown));
    return 1;
  }
}

// The entry guard the other tools use: importing this file must not choose an arm, because a test
// that imports it would otherwise run the script. `String(undefined)` is `'undefined'`, so the guard
// needs no truthiness check — and a check would be a branch nothing can cover from inside a test.
if (String(process.argv[1]).endsWith('bird-arm.mjs')) {
  process.exitCode = main(process.argv.slice(2), process.env, (line) => console.log(line), (line) => console.error(line));
}
