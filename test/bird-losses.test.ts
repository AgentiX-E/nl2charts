/**
 * The losses reader, on artifacts it did not write.
 *
 * The tool exists because a number was unreadable: the cross-vendor run lost 75 of the 1,018
 * cases whose candidate set held the answer, and the artifact said nothing about which
 * candidate had held it. Every test here is a shape that file can take — a record it can
 * attribute, a record that contradicts the score, and an artifact written before the record
 * existed — because a reader that cannot tell those apart is a reader that turns a legacy file
 * into a table of numbers nobody should trust.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  attribute,
  conclusion,
  isEntry,
  main,
  reportLines,
  resolveLossSettings,
} from '../eval/bird/losses.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const scratch = mkdtempSync(join(tmpdir(), 'nl2birds-losses-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CROSS = 'inline+evidence@second';
const METADATA = 'metadata+evidence';

interface Verdict {
  readonly source: string;
  readonly correct: boolean;
}

function verdict(source: string, correct: boolean): Verdict {
  return { source, correct };
}

function row(
  id: string,
  verdicts: readonly Verdict[] | undefined,
  options: { readonly passed?: boolean; readonly taken?: string; readonly recall?: boolean } = {},
): Record<string, unknown> {
  return {
    arm: 'select-cross',
    id,
    passed: options.passed ?? false,
    ...(verdicts === undefined ? {} : { candidates: verdicts }),
    ...(options.taken === undefined ? {} : { winnerSource: options.taken }),
    ...(options.recall === undefined ? {} : { candidateRecall: options.recall }),
  };
}

/** The artifact the reader takes. Built loosely here, cast once: the rows are the shape under test. */
type ArtifactInput = Parameters<typeof attribute>[0];
type ArtifactCases = NonNullable<ArtifactInput['cases']>;

function artifact(cases: readonly Record<string, unknown>[]): ArtifactInput {
  return { split: 'dev', cases: cases as unknown as ArtifactCases };
}

describe('attribution', () => {
  it('names the source that held the answer and the one the arm took instead', () => {
    // The case the tool was written for: the second model's statement was the only right one
    // and the arm returned a different, wrong, statement beside it.
    const reading = attribute(
      artifact([row('q1', [verdict(CROSS, true), verdict(METADATA, false), verdict('values', false)], { taken: METADATA })]),
      'select-cross',
    );
    expect(reading.ceiling).toBe(1);
    expect(reading.returned).toBe(0);
    expect(reading.lost).toEqual(['q1']);
    expect(reading.attributions).toEqual([{ correct: [CROSS], taken: METADATA, cases: ['q1'] }]);
    expect(reading.problems).toEqual([]);
  });

  it('groups losses that share an address and keeps different ones apart', () => {
    const reading = attribute(
      artifact([
        row('q1', [verdict(CROSS, true), verdict(METADATA, false)], { taken: METADATA }),
        row('q2', [verdict(CROSS, true), verdict(METADATA, false)], { taken: METADATA }),
        row('q3', [verdict(METADATA, true), verdict(CROSS, false)], { taken: CROSS }),
      ]),
      'select-cross',
    );
    expect(reading.lost).toEqual(['q1', 'q2', 'q3']);
    // Largest group first: two cases beat one, whatever the address is.
    expect(reading.attributions.map((group) => [group.correct.join('+'), group.taken, group.cases.length])).toEqual([
      [CROSS, METADATA, 2],
      [METADATA, CROSS, 1],
    ]);
  });

  it('keeps a case whose two candidates both answered as a set, not as one source', () => {
    // Either statement would have passed. Attributing the loss to one of them would invent a
    // preference the score cannot see, and the singleton table is where that matters most:
    // neither source was *the* answer here.
    const reading = attribute(
      artifact([
        row('q1', [verdict(CROSS, true), verdict(METADATA, true)], { passed: true, taken: METADATA }),
        row('q2', [verdict(CROSS, true), verdict(METADATA, true)], { taken: 'values' }),
      ]),
      'select-cross',
    );
    expect(reading.ceiling).toBe(2);
    expect(reading.returned).toBe(1);
    expect(reading.attributions).toEqual([{ correct: [CROSS, METADATA], taken: 'values', cases: ['q2'] }]);
    expect(reading.sources).toEqual([]);
  });

  it('counts how often each source was the only answer and how often it came back', () => {
    const reading = attribute(
      artifact([
        row('q1', [verdict(CROSS, true), verdict(METADATA, false)], { passed: true, taken: CROSS }),
        row('q2', [verdict(CROSS, true), verdict(METADATA, false)], { taken: METADATA }),
        row('q3', [verdict(METADATA, true), verdict(CROSS, false)], { passed: true, taken: METADATA }),
      ]),
      'select-cross',
    );
    // The 47%/87% asymmetry with its denominators: this is the number a judge swap moves.
    expect(reading.sources).toEqual([
      { source: CROSS, alone: 2, returned: 1 },
      { source: METADATA, alone: 1, returned: 1 },
    ]);
  });

  it('names a loss whose taken statement the artifact does not label', () => {
    // The sampled arms have three candidates of one source and no `winnerSource`. The loss is
    // still real and the address is still useful; only the taken side is unrecorded.
    const reading = attribute(artifact([row('q1', [verdict('select', true), verdict('select', false)])]), 'select-cross');
    expect(reading.attributions).toEqual([{ correct: ['select'], taken: '(source not recorded)', cases: ['q1'] }]);
  });

  it('ignores cases whose set never held an answer, and cases another arm scored', () => {
    const reading = attribute(
      artifact([
        row('q1', [verdict(CROSS, false), verdict(METADATA, false)]),
        { ...row('q2', [verdict('inline+evidence', true)], { passed: true }), arm: 'select-mixed' },
      ]),
      'select-cross',
    );
    expect(reading.scored).toBe(1);
    expect(reading.ceiling).toBe(0);
    expect(reading.lost).toEqual([]);
  });

  it('reports a case that says its set held an answer while recording none', () => {
    const reading = attribute(artifact([row('q1', [verdict(CROSS, false)], { recall: true })]), 'select-cross');
    expect(reading.ceiling).toBe(0);
    expect(reading.problems).toEqual(['case q1 says its set held an answer and records none, so the two fields disagree']);
  });

  it('reports a loss whose own record calls the returned statement correct', () => {
    // The score and the record are written by one pass, so a disagreement between them is a
    // writer defect and not a rounding difference.
    const reading = attribute(artifact([row('q1', [verdict(CROSS, true), verdict(METADATA, true)], { taken: METADATA })]), 'select-cross');
    expect(reading.problems).toEqual(['case q1 failed while its record marks the returned statement (metadata+evidence) correct, so the record and the score disagree']);
  });

  it('says an artifact written before the record cannot be attributed', () => {
    const reading = attribute(artifact([row('q1', undefined, { recall: true }), row('q2', undefined)]), 'select-cross');
    expect(reading.recorded).toBe(0);
    expect(reading.scored).toBe(2);
    expect(reading.unrecorded).toEqual(['q1', 'q2']);
    expect(reading.problems).toEqual([
      'select-cross carries no candidate record in this artifact, so no loss can be attributed — the run predates the field',
    ]);
    expect(reading.attributions).toEqual([]);
  });

  it('reads an arm the artifact never scored as empty rather than as an error', () => {
    const reading = attribute({}, 'select-cross');
    expect(reading.scored).toBe(0);
    expect(reading.split).toBe('unknown');
    expect(reading.problems).toEqual([]);
  });
});

describe('the sentence', () => {
  const lost = (cases: readonly Record<string, unknown>[]): string => conclusion(attribute(artifact(cases), 'select-cross'));

  it('states the largest group and the conversion rate that has to move', () => {
    const text = lost([
      row('q1', [verdict(CROSS, true), verdict(METADATA, false)], { taken: METADATA }),
      row('q2', [verdict(CROSS, true), verdict(METADATA, false)], { taken: METADATA }),
      row('q3', [verdict(CROSS, true), verdict(METADATA, false)], { passed: true, taken: CROSS }),
    ]);
    expect(text).toContain('lost 2 of 3 cases whose set held the answer (66.7%)');
    expect(text).toContain('the largest group (2) had it in `inline+evidence@second` -> `metadata+evidence`');
    expect(text).toContain('`inline+evidence@second` was the only answer in 3 cases and it came back 1 times (33.3%)');
  });

  it('refuses to price a source when the largest group had two right statements', () => {
    const text = lost([
      row('q1', [verdict(CROSS, true), verdict(METADATA, true)], { taken: 'values' }),
      row('q2', [verdict(CROSS, true), verdict(METADATA, true)], { taken: 'values' }),
      row('q3', [verdict('values', true), verdict(METADATA, false)], { taken: METADATA }),
    ]);
    expect(text).toContain('the largest group (2) had it in `inline+evidence@second + metadata+evidence` -> `values`');
    expect(text).toContain('neither source can be priced alone');
  });

  it('says nothing was thrown away when the ceiling was kept', () => {
    const text = lost([row('q1', [verdict(CROSS, true), verdict(METADATA, false)], { passed: true, taken: CROSS })]);
    expect(text).toBe('select-cross returned the answer on all 1 cases whose set held one, so nothing was thrown away.');
  });

  it('says a set that never held an answer has no selection to price', () => {
    expect(lost([row('q1', [verdict(CROSS, false), verdict(METADATA, false)])])).toBe(
      'No recorded case of select-cross had an answer in its candidate set, so there is nothing to select and no loss to attribute.',
    );
  });

  it('answers an unattributable artifact with an absence rather than a zero', () => {
    expect(lost([row('q1', undefined, { recall: true })])).toBe(
      'select-cross carries no candidate record, so where its losses came from is unanswered rather than zero.',
    );
  });
});

describe('the table', () => {
  it('prints the conversion table, the addresses, and the unrecorded cases', () => {
    const lines = reportLines(
      attribute(
        artifact([
          row('q1', [verdict(CROSS, true), verdict(METADATA, false)], { taken: METADATA }),
          row('q2', [verdict(METADATA, true), verdict(CROSS, false)], { taken: CROSS }),
          row('q3', undefined),
        ]),
        'select-cross',
      ),
    ).join('\n');
    expect(lines).toContain('select-cross on dev: 3 scored, 2 with a candidate record, 2 held an answer, 0 returned one, 2 lost');
    expect(lines).toContain('| `inline+evidence@second` | 1 | 0 | 0.0% |');
    expect(lines).toContain('| `inline+evidence@second` | `metadata+evidence` | 1 |');
    expect(lines).toContain('1 of 3 cases carry no candidate record (q3)');
    expect(lines).toContain('lost 2 of 2 cases whose set held the answer');
  });

  it('caps a wide table and says how many groups it hid', () => {
    const cases = Array.from({ length: 10 }, (_, index) =>
      row(`q${String(index)}`, [verdict(`s${String(index)}`, true), verdict('other', false)], { taken: 'other' }),
    );
    const lines = reportLines(attribute(artifact(cases), 'select-cross'), 3).join('\n');
    expect(lines).toContain('| … and 7 more group(s) | | |');
    // The hidden groups are still counted in the sentence, which is the point of the cap.
    expect(lines).toContain('lost 10 of 10 cases');
  });
});

describe('the entry, run the way a reader runs it', () => {
  it('knows when it is the entry point, including when there is no argv at all', () => {
    const own = pathToFileURL(join(ROOT, 'eval/bird/losses.ts')).href;
    expect(isEntry(join(ROOT, 'eval/bird/losses.ts'), own)).toBe(true);
    expect(isEntry(join(ROOT, 'eval/bird/strata.ts'), own)).toBe(false);
    expect(isEntry(undefined, own)).toBe(false);
  });

  it('takes the artifact from the flag, then the environment, then the report path', () => {
    expect(resolveLossSettings(['--arm', 'select-cross', '--report', 'x.json'], {}, ROOT).reportPath).toBe(resolve(ROOT, 'x.json'));
    expect(resolveLossSettings(['--arm', 'select-cross'], { BIRD_REPORT: 'y.json' }, ROOT).reportPath).toBe(resolve(ROOT, 'y.json'));
    expect(resolveLossSettings(['--arm', 'select-cross'], {}, ROOT).reportPath).toBe(resolve(ROOT, 'eval/out/bird-eval.json'));
  });

  it('refuses to guess which arm to read', () => {
    expect(() => resolveLossSettings([], {}, ROOT)).toThrow('usage: losses.ts --arm <arm> [--report <artifact>]');
  });

  it('prints the table for a real file and exits 0', () => {
    const path = join(scratch, 'good.json');
    writeFileSync(
      path,
      JSON.stringify({
        split: 'dev',
        cases: [
          row('q1', [verdict(CROSS, true), verdict(METADATA, false)], { taken: METADATA }),
          row('q2', [verdict(METADATA, true), verdict(CROSS, false)], { passed: true, taken: METADATA }),
        ],
      }),
    );
    const out = execFileSync('npx', ['tsx', 'eval/bird/losses.ts', '--arm', 'select-cross', '--report', path], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toContain('| `inline+evidence@second` | `metadata+evidence` | 1 |');
    expect(out).toContain('`inline+evidence@second` was the only answer in 1 cases and it came back 0 times (0.0%)');
  });

  it('prints the table and then fails when the file contradicts itself', () => {
    const path = join(scratch, 'contradiction.json');
    writeFileSync(path, JSON.stringify({ split: 'dev', cases: [row('q1', [verdict(CROSS, true), verdict(METADATA, true)], { taken: METADATA })] }));
    // A contradiction is a file whose score and record disagree. Printing one and exiting 0
    // would make the table the authority on a run that cannot be attributed at all.
    expect(() => execFileSync('npx', ['tsx', 'eval/bird/losses.ts', '--arm', 'select-cross', '--report', path], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })).toThrow();
    const printed = execFileSync('sh', ['-c', `npx tsx eval/bird/losses.ts --arm select-cross --report ${path} 2>&1 || true`], { cwd: ROOT, encoding: 'utf8' });
    expect(printed).toContain('the record and the score disagree');
  });

  it('runs main in process, so the same code path is covered without a subprocess', async () => {
    const path = join(scratch, 'main.json');
    writeFileSync(path, JSON.stringify({ split: 'dev', cases: [row('q1', [verdict(CROSS, true), verdict(METADATA, false)], { taken: METADATA })] }));
    await expect(main(['--arm', 'select-cross', '--report', path], {}, ROOT)).resolves.toBeUndefined();
    writeFileSync(path, JSON.stringify({ split: 'dev', cases: [row('q1', undefined, { recall: true })] }));
    await expect(main(['--arm', 'select-cross', '--report', path], {}, ROOT)).rejects.toThrow('carries no candidate record');
  });
});
