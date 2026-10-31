/**
 * The entry guard every tool under `eval/` shares.
 *
 * It exists as a function so that both answers to "was this the entry point" are a call a test can
 * make. The shape it replaced — a module-scope `if` — was taken exactly once per process, in the
 * one context no test can enter, and the coverage ledger recorded the two uncovered lines for
 * `probe.ts` and `score.ts` rather than a behaviour anyone had checked.
 *
 * The generic parameter is the whole reason one guard serves three tools: `T` is a number for the
 * synchronous ones and a promise of one for `score.ts`, which awaits the model.
 */
import { describe, expect, it } from 'vitest';
import { isEntry, runIfEntry } from '../eval/entry.js';

describe('the entry guard', () => {
  it('matches only the module that is being run, not the module being imported', () => {
    // No command line at all: the module was imported.
    expect(isEntry(undefined, 'file:///a/tool.ts')).toBe(false);
    // A command line, but for another script.
    expect(isEntry('/a/other.ts', 'file:///a/tool.ts')).toBe(false);
    // A relative path is not the module's URL, even when it would resolve to it: the runtime
    // passes the path it was given, and a guard that guessed would run twice.
    expect(isEntry('tool.ts', 'file:///a/tool.ts')).toBe(false);
    expect(isEntry('/a/tool.ts', 'file:///a/tool.ts')).toBe(true);
  });

  it('does the work when it is the entry point, and returns nothing when it is not', () => {
    let ran = 0;
    const run = (): number => {
      ran += 1;
      return 7;
    };
    expect(runIfEntry(undefined, 'file:///a/tool.ts', run)).toBeUndefined();
    expect(runIfEntry('/a/other.ts', 'file:///a/tool.ts', run)).toBeUndefined();
    // Not started, rather than started and discarded: importing a tool must not call a model.
    expect(ran).toBe(0);
    expect(runIfEntry('/a/tool.ts', 'file:///a/tool.ts', run)).toBe(7);
    expect(ran).toBe(1);
  });

  it('carries an asynchronous exit code without awaiting it itself', async () => {
    // `score.ts` awaits what this returns; the guard must hand back the promise rather than a
    // resolved number, or the assignment at the end of that module would race the scoring run.
    const pending = runIfEntry('/a/tool.ts', 'file:///a/tool.ts', () => Promise.resolve(1));
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toBe(1);
    // Imported, the async tool returns nothing at all rather than a resolved `undefined`: the
    // module's `process.exitCode` is then left unset, which is what "no exit code" means.
    expect(runIfEntry(undefined, 'file:///a/tool.ts', () => Promise.resolve(1))).toBeUndefined();
  });
});
