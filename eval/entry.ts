/**
 * The entry guard for the tools under `eval/`, as a function rather than a branch at module scope.
 *
 * Every tool in this directory can be run two ways: imported by a test, or executed by a workflow.
 * The obvious spelling of that is
 *
 *     if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
 *       process.exitCode = main();
 *     }
 *
 * and it is wrong for a reason that only shows up in a coverage report: the branch is taken exactly
 * once, in a process no test can enter, so both the condition and the call are either uncovered or
 * "covered" by a subprocess whose coverage is not counted. `eval/competitors/probe.ts` and
 * `eval/competitors/score.ts` carried that shape and the ledger recorded the debt.
 *
 * A guard that *returns* the work instead leaves the module body one unconditional assignment:
 * importing the file cannot start a run, running it cannot be forgotten, and both answers to "was
 * this the entry point" are a call a test can make.
 *
 * The generic parameter is what lets one guard serve a synchronous tool and an asynchronous one:
 * `T` is the exit code, or a promise of it.
 */
import { pathToFileURL } from 'node:url';

/** Whether this module is the one the runtime was asked to run. */
export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

/** The work, when this module is the entry point; nothing at all when it is being imported. */
export function runIfEntry<T>(argv1: string | undefined, moduleUrl: string, run: () => T): T | undefined {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  return run();
}
