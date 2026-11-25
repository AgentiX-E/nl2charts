/**
 * An archive key must contain every input that changes an answer key.
 *
 * The answer store is keyed by the request — messages, model, `max_tokens`, temperature, record
 * version — so two dispatches that differ in `--max-tokens` hold *different* entries. The Actions
 * archive they are saved into was keyed by model, split, k, rules, replica and a hash of the source
 * files: not the cap. Two dispatches at 900 and 2600 tokens therefore reserved one key, the second
 * save was refused —
 *
 *   Failed to save: Unable to reserve cache with key
 *   nvbench2-answers-deepseek-reasoner-test-3-count_corpus_corpus2-487be553…,
 *   another job may be creating this cache.
 *
 * — and 750 paid reasoning answers (¥15.28) were discarded with the job green. The next run quoted
 * all 751 questions at ¥19.75 because the store it restored held entries for the other cap, and
 * nothing in the log said the loss had happened.
 *
 * These assertions read the workflow rather than run it, because the failure was in the key's
 * *content* and a run cannot show its own key was wrong — only that it was empty.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/nvbench2-arm.yml'), 'utf8');

/** The line carrying the archive's primary key, or the failure to name it. */
function primaryKeyLine(): string {
  const line = workflow.split('\n').find((candidate) => candidate.trimStart().startsWith('key: nvbench2-answers-'));
  if (line === undefined) throw new Error('nvbench2-arm.yml has no answer-archive key');
  return line.trim();
}

describe('the answer archive is keyed by the request, not by the calendar', () => {
  it('puts the output cap in the key, because the cap is in every answer key', () => {
    // The defect: one archive for two caps. `--max-tokens` is not cosmetic — a reply cut at 900
    // tokens is a different answer from one that finished, which is why `content-store.ts` puts it in
    // the key material and why the archive has to agree.
    expect(primaryKeyLine()).toContain('mt${{ steps.instrument.outputs.mt }}');
  });

  it('restores only from the same cap, so a restore cannot hand back entries for another one', () => {
    // A prefix that spans both caps would restore a store whose entries all miss, which is the ¥19.75
    // quote above: the run pays for everything and the archive looks populated.
    const prefixes = workflow.split('\n').filter((line) => line.includes('nvbench2-answers-') && line.trimStart().startsWith('nvbench2-answers-'));
    expect(prefixes).not.toHaveLength(0);
    for (const prefix of prefixes) expect(prefix).toContain('mt${{ steps.instrument.outputs.mt }}-');
  });

  it('names every input that changes an answer key in the arm slug', () => {
    // The slug is the first half of the archive key. Anything in it that is missing is a way for two
    // different requests to share one archive: the report named a replica and a mirror mode, and a
    // dispatch that varied either would have overwritten an unrelated arm's answers.
    const naming = workflow.split('\n').find((line) => line.includes('printf \'%s-%s-%s-%s\''));
    expect(naming, 'the slug is built from four parts and must stay named here').toBeDefined();
    for (const part of ['MODEL', 'SPLIT', 'K', 'arm']) expect(naming).toContain(part);
    const slugLogic = workflow.slice(workflow.indexOf('arm="$(printf'), workflow.indexOf('echo "slug='));
    for (const flag of ['RULES', 'REPLICA', 'ASK']) expect(slugLogic).toContain(flag);
  });

  it('saves what a run paid for even when the run refused to publish a reading', () => {
    // `if: always()` is the difference between "this dispatch bought 750 answers and kept them" and
    // "it bought 750 answers". A run that misses its floor or refuses a reading has still spent.
    const saveStep = workflow.slice(workflow.indexOf('- name: Keep what this run paid for'));
    expect(saveStep.slice(0, 200)).toContain('if: always()');
  });
});
