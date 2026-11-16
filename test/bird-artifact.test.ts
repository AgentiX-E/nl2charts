import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { artifactSplit, declaresCandidateSet, scoredQuestions } from '../eval/bird/artifact.js';

/**
 * The one predicate three instruments share, and the sentence it licenses.
 *
 * The defect it exists for is not arithmetic: three harnesses each refused an artifact with no
 * candidates, and each refusal was written when every dev dispatch sampled three. The round that
 * made the ceiling lever a single call turned all three into false alarms, and the dev workflow
 * failed at the first of them — after the evaluation and the accuracy floor had both passed.
 */
describe('what an artifact claims, read without inventing a number', () => {
  it('reads a ceiling on any arm as a claim that candidates existed', () => {
    expect(declaresCandidateSet(undefined)).toBe(false);
    expect(declaresCandidateSet([])).toBe(false);
    // A single-call row carries no `candidateRecall`; the field is written only by an arm that
    // sampled, and the report gate refuses a sampling row without it — so this is the artefact's own
    // statement about its shape rather than a guess from the absence of candidate rows.
    expect(declaresCandidateSet([{ arm: 'names' }, { arm: 'metadata+evidence+icl' }])).toBe(false);
    expect(declaresCandidateSet([{ arm: 'names' }, { arm: 'select-cross', candidateRecall: 0.6749 }])).toBe(true);
    // Zero is a measured ceiling, not an absent one: a pool whose every case lost still publishes 0.
    expect(declaresCandidateSet([{ arm: 'select', candidateRecall: 0 }])).toBe(true);
  });

  it('counts the questions a run scored, not the questions its pools cover', () => {
    // The denominator of the sentence. Derived from the candidate rows it was zero on an artifact
    // that had just scored 1,532 questions, and the line said "there is no pool to price (0
    // questions)" about a run that was in fact the largest in the suite.
    expect(scoredQuestions(undefined)).toBe(0);
    expect(scoredQuestions([])).toBe(0);
    expect(scoredQuestions([{ id: 1 }, { id: '1' }, { id: 2 }, {}])).toBe(2);
    // A row with no `id` is not a question: an artifact written by an older harness carried rows
    // without one, and counting them would inflate the denominator of a sentence.
    expect(scoredQuestions([{}, { id: 3 }])).toBe(1);
  });
});

/**
 * The split an artifact declares, read on its own.
 *
 * The pair this function exists to break up is a run that scored one benchmark and a questions file
 * that describes another. `main` in `agents` and `differential` has to build the oracle — and so
 * choose the split's database directory — before the instrument parses the artifact, so the one
 * field it needs is read here rather than by a second parse written per tool.
 */
describe('the split an artifact names, read on its own', () => {
  const written = (body: unknown): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'artifact-split-')), 'bird-eval.json');
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
    return path;
  };

  it('reads the field a run wrote', () => {
    expect(artifactSplit(written({ split: 'dev', cases: [] }))).toBe('dev');
    expect(artifactSplit(written({ split: 'minidev' }))).toBe('minidev');
  });

  it('answers nothing for an artifact that never recorded one', () => {
    // An artifact written before the field existed is read as the caller's split, which is what such
    // a file can be read as without inventing a number.
    expect(artifactSplit(written({ cases: [] }))).toBeUndefined();
    // A field of the wrong type is not a split either: `split: 3` must not become `"3"`.
    expect(artifactSplit(written({ split: 3 }))).toBeUndefined();
  });

  it('answers nothing rather than throwing when the file cannot be read', () => {
    // The oracle is built before anything else, so a throw here would report a missing file as a
    // layout error. The run fails later, on the artifact it actually could not read.
    expect(artifactSplit('/does/not/exist.json')).toBeUndefined();
    expect(artifactSplit(written('not json'))).toBeUndefined();
  });
});
