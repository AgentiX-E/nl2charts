/**
 * One slot for every heavyweight run.
 *
 * The dev split is expensive in exactly two currencies: provider quota and wall clock. Three
 * workflows spend both — `ci.yml`'s Mini-Dev job, `bird-dev.yml` and `bird-model.yml` — and each
 * used to declare its own concurrency group, which in one case was no group at all. Two of them
 * then overlapped for an hour, and the symptom was not a wrong number: an arm that takes 29
 * minutes alone took 60, and a run slow enough trips the timeout guards, which are then read as a
 * verdict about the endpoint.
 *
 * GitHub applies a concurrency group across workflows in one repository, so sharing the name is
 * the whole mechanism — and a name that only one file knows is not a mechanism at all. This file
 * pins the two facts that make it work: the same group everywhere, and never cancel in progress.
 * A 60-minute benchmark thrown away by a push is worse than waiting for it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The group every run that scores the dev split has to share. */
const GROUP = 'bird-eval';

const HEAVY = [
  // The job that scores Mini-Dev on every push to master.
  'ci.yml',
  // The dispatched dev split.
  'bird-dev.yml',
  // The same split against another endpoint.
  'bird-model.yml',
  // A competitor's pipeline, which calls the same endpoint on the same questions: the one job in
  // this repository whose quota is somebody else's software's timing as well as ours.
  'competitors.yml',
] as const;

function workflow(name: string): string {
  return readFileSync(resolve(process.cwd(), '.github/workflows', name), 'utf8');
}

/** Every `group:` value a workflow declares, in order. */
export function groupsOf(text: string): string[] {
  return [...text.matchAll(/^\s*group:\s*(\S+)\s*$/gmu)].map((match) => match[1] as string);
}

/** Whether the workflow says, at least once, that a run in progress is not cancelled. */
export function waitsForTheSlot(text: string): boolean {
  return /^\s*cancel-in-progress:\s*false\s*$/mu.test(text);
}

describe('the heavy runs share one slot', () => {
  it.each(HEAVY)('%s waits for the bird-eval group', (name) => {
    const text = workflow(name);
    expect(groupsOf(text)).toContain(GROUP);
  });

  it.each(HEAVY)('%s never cancels a run in progress', (name) => {
    // The opposite of the heavy case: `ci.yml`'s quality job does cancel, because a newer
    // push makes the older answer irrelevant. A benchmark is not made irrelevant by a push.
    expect(waitsForTheSlot(workflow(name))).toBe(true);
  });

  it('declares no second heavy group that could run beside the first', () => {
    // `bird-model.yml` used `bird-model`, which serialised it against itself and against
    // nothing else. A second name is a second slot, and two slots is the state this file
    // exists to prevent.
    for (const name of ['bird-dev.yml', 'bird-model.yml'] as const) {
      expect(groupsOf(workflow(name)), name).toEqual([GROUP]);
    }
  });

  it('reads a group out of a workflow at all', () => {
    // The reader has to be able to fail: a regex that matched nothing would make every
    // assertion above vacuous, which is the failure mode of every file-shape test.
    expect(groupsOf('concurrency:\n      group: something\n')).toEqual(['something']);
    expect(groupsOf('jobs:\n  a:\n    runs-on: x\n')).toEqual([]);
    expect(waitsForTheSlot('cancel-in-progress: true')).toBe(false);
  });
});
