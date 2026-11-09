/**
 * One slot per provider, for every heavyweight run.
 *
 * The dev split is expensive in exactly two currencies: provider quota and wall clock. Three
 * workflows spend both — `ci.yml`'s Mini-Dev job, `bird-dev.yml` and `bird-model.yml` — and each
 * used to declare its own concurrency group, which in one case was no group at all. Two of them
 * then overlapped for an hour, and the symptom was not a wrong number: an arm that takes 29
 * minutes alone took 60, and a run slow enough trips the timeout guards, which are then read as a
 * verdict about the endpoint.
 *
 * GitHub applies a concurrency group across workflows in one repository, so sharing the name is
 * the whole mechanism — and a name that only one file knows is not a mechanism at all.
 *
 * The name is keyed by the provider, and that is a correction rather than a refinement. One slot
 * for every run was right while every run drew on one provider; `bird-model.yml` then grew a
 * `secret_name` input because its whole purpose is another endpoint, and a Zhipu run queued in the
 * same group as a DeepSeek run is two quotas serialised for no reason. Worse, GitHub keeps only
 * the newest *pending* run in a group: a `glm-4.6` run queued behind a CI push was cancelled by
 * the next CI push before it ever started, with `cancel-in-progress: false`, and the run list said
 * only `cancelled`. Keying by provider keeps the quota reason — two runs against one endpoint
 * still serialize — and removes the collision between two endpoints that never shared anything.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The group every run that scores the dev split against DeepSeek has to share. */
const GROUP = 'bird-eval-DEEPSEEK_API_KEY';

/** The workflow whose group is a function of the provider it was dispatched against. */
const PARAMETERISED = 'bird-model.yml';

const HEAVY = [
  // The job that scores Mini-Dev on every push to master.
  'ci.yml',
  // The dispatched dev split.
  'bird-dev.yml',
  // The same split against another endpoint. Its group is checked separately, because it is a
  // function of the provider rather than a constant.
  'bird-model.yml',
  // A competitor's pipeline, which calls the same endpoint on the same questions: the one job in
  // this repository whose quota is somebody else's software's timing as well as ours.
  'competitors.yml',
] as const;

function workflow(name: string): string {
  return readFileSync(resolve(process.cwd(), '.github/workflows', name), 'utf8');
}

/**
 * Every `group:` value a workflow declares, in order.
 *
 * The value may contain spaces, because a group name that is a function of an input is written
 * `${{ inputs.secret_name }}`. The narrower `\S+` this used read that line as no group at all,
 * which is the failure mode the reader's own test exists for: a regex that matches nothing makes
 * every assertion above it vacuous.
 */
export function groupsOf(text: string): string[] {
  return [...text.matchAll(/^\s*group:\s*(.+?)\s*$/gmu)].map((match) => match[1] as string);
}

/** Whether the workflow says, at least once, that a run in progress is not cancelled. */
export function waitsForTheSlot(text: string): boolean {
  return /^\s*cancel-in-progress:\s*false\s*$/mu.test(text);
}

describe('the heavy runs share one slot per provider', () => {
  it.each(HEAVY.filter((name) => name !== PARAMETERISED))('%s waits for the DeepSeek group', (name) => {
    const text = workflow(name);
    expect(groupsOf(text)).toContain(GROUP);
  });

  it('keys the cross-model group by the secret it draws on, so two endpoints do not serialize', () => {
    const text = workflow(PARAMETERISED);
    const groups = groupsOf(text);
    expect(groups).toEqual(['bird-eval-${{ inputs.secret_name }}']);
    // The parameter has to be a declared input, or the group name would interpolate to nothing
    // and every dispatch would land in `bird-eval-` — one slot for all providers again.
    expect(text).toMatch(/^\s{6}secret_name:\s*$/mu);
    // Dispatched against DeepSeek it must land in the same slot as the other DeepSeek runs.
    expect(groups[0]?.includes('secret_name')).toBe(true);
  });

  it.each(HEAVY)('%s never cancels a run in progress', (name) => {
    // The opposite of the heavy case: `ci.yml`'s quality job does cancel, because a newer
    // push makes the older answer irrelevant. A benchmark is not made irrelevant by a push.
    expect(waitsForTheSlot(workflow(name))).toBe(true);
  });

  it('declares exactly one heavy group per workflow, so a second slot cannot appear by accident', () => {
    // `bird-model.yml` once used `bird-model`, which serialised it against itself and against
    // nothing else. One group per file is still the rule; what changed is that the group's *name*
    // is now a function of the provider, not a constant shared across all of them.
    expect(groupsOf(workflow('bird-dev.yml'))).toEqual([GROUP]);
    expect(groupsOf(workflow(PARAMETERISED))).toHaveLength(1);
  });

  it('reads a group out of a workflow at all', () => {
    // The reader has to be able to fail: a regex that matched nothing would make every
    // assertion above vacuous, which is the failure mode of every file-shape test.
    expect(groupsOf('concurrency:\n      group: something\n')).toEqual(['something']);
    expect(groupsOf('jobs:\n  a:\n    runs-on: x\n')).toEqual([]);
    expect(waitsForTheSlot('cancel-in-progress: true')).toBe(false);
  });
});
