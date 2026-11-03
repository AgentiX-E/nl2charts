#!/usr/bin/env node
/**
 * Print `yes` when the arms this dispatch names read BIRD's training split, `no` otherwise.
 *
 * The workflow needs that answer before it downloads anything: the training split is an 8.5 GB
 * archive of which only `train.json` is kept, and it is read by two levers — retrieved evidence and
 * worked examples — neither of which most runs declare. Keeping the rule here rather than in a YAML
 * condition is the same decision as `DEV_ARMS` living in the arm table: a second copy of "which arms
 * retrieve" is a second opinion about which arms exist, and the first one to drift would be the copy
 * that decides whether a run fails an hour later inside the harness.
 *
 *   BIRD_ARMS=metadata+evidence+icl pnpm bench:bird:needs-train   # yes
 *   BIRD_ARMS=names pnpm bench:bird:needs-train                   # no
 *
 * An arm name that resolves to nothing is a refusal rather than a `no`: a typo that skipped the
 * fetch would surface as "need the BIRD training split" after the minutes this step saves.
 */
import { pathToFileURL } from 'node:url';
import { armsNeedRetrieval, DEFAULT_ARMS, parseArms, resolveArm } from './run.js';

/** Which arms this run will actually execute, with blanks resolved to the chain's default list. */
export function requestedArms(requested: string | undefined, defaults: readonly string[] = DEFAULT_ARMS): readonly string[] {
  return parseArms(requested, undefined, defaults);
}

/** The answer, and the refusal for a name that is not an arm. */
export function needsTrainingSplit(arms: readonly string[]): 'yes' | 'no' {
  for (const name of arms) {
    if (resolveArm(name) === undefined) throw new Error(`BIRD_ARMS names ${name}, which is not an arm`);
  }
  // An empty `BIRD_ARMS` means "run the chain", and the chain has read the training split since
  // `inline+icl` joined it — the case a hand-written YAML condition forgets.
  return armsNeedRetrieval(arms) ? 'yes' : 'no';
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

export function main(log: (line: string) => void, env: NodeJS.ProcessEnv = process.env): number {
  log(needsTrainingSplit(requestedArms(env.BIRD_ARMS)));
  return 0;
}

/**
 * The exit code this module contributes, or `undefined` when it was imported rather than run.
 *
 * Returned rather than assigned so the branch is reachable from the suite: a module-level `if`
 * guarding the assignment is a line no test can execute, and a file this small cannot afford one.
 */
export function entryExit(
  argv1: string | undefined,
  moduleUrl: string,
  log: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  return isEntry(argv1, moduleUrl) ? main(log, env) : undefined;
}

// `?? process.exitCode` rather than an `if`: the statement runs on every import, so both of its
// branches are measured, and a module that is *not* the entry leaves the caller's exit code exactly
// as it found it. An unconditional `= 0` would clear a failing runner's status from an import.
process.exitCode = entryExit(process.argv[1], import.meta.url, (line) => process.stdout.write(`${line}\n`)) ?? process.exitCode;
