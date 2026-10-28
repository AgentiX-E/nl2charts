/**
 * A push must not cancel a measurement.
 *
 * `ci.yml` carried a run-level `concurrency` with `cancel-in-progress: true`, which kills
 * whatever is running the moment anything is pushed. Three of its four jobs produce numbers:
 * a BIRD arm that was cancelled half way scores nothing and publishes no artifact, so
 * "CI is green" depended on how long the author waited before pushing again rather than on
 * the code. Two consecutive pushes demonstrated it — `40615685536`'s BIRD job was cancelled
 * by the push that started `40617682709`.
 *
 * The cheap check is different: it should be restarted, because a type error belongs to the
 * commit that has it. That is the distinction this file pins.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Jobs of a workflow, keyed by their `  name:` id at two-space indentation. */
function jobs(file: string): Map<string, string> {
  const text = readFileSync(resolve(process.cwd(), file), 'utf8');
  const jobsSection = text.slice(text.indexOf('\njobs:\n') + '\njobs:\n'.length).replace(/^\s+/, '');
  const out = new Map<string, string>();
  for (const chunk of jobsSection.split(/\n {2}(?=[a-z][\w-]*:\n)/)) {
    const id = /^([a-z][\w-]*):\n/.exec(chunk)?.[1];
    if (id !== undefined) out.set(id, chunk);
  }
  return out;
}

describe('ci.yml cancels checks, not measurements', () => {
  const file = '.github/workflows/ci.yml';
  const blocks = jobs(file);

  it('has no run-level concurrency', () => {
    // Column zero is the workflow level; a group there can only be cancelled as a whole,
    // and cancelling the run cancels the BIRD job inside it.
    const text = readFileSync(resolve(process.cwd(), file), 'utf8');
    expect(/^concurrency:/m.test(text)).toBe(false);
  });

  it('serialises every job that produces a number', () => {
    // These three write artifacts that are read as findings. A cancelled one is not a
    // failed measurement, it is the absence of one, which reads downstream as "no result".
    for (const id of ['benchmark', 'live-eval', 'bird-eval']) {
      const block = blocks.get(id);
      expect(block, id).toBeDefined();
      expect(block as string, id).toContain('cancel-in-progress: false');
    }
  });

  it('lets only the cheap quality check restart on every push', () => {
    // Exactly one job may cancel a running instance, and it is the one that costs two
    // minutes rather than an hour of model calls.
    const cancellable = [...blocks.entries()].filter(([, block]) => block.includes('cancel-in-progress: true'));
    expect(cancellable.map(([id]) => id)).toEqual(['quality']);
  });
});
