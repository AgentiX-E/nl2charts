/**
 * A documentation commit must not buy a model call.
 *
 * `ci.yml` measures on every push to master: thirteen arms over 496 questions (~6,400
 * completions) and three passes over 210 live cases. Round 36 pushed twice in one round,
 * the second time for `benchmarks.md` and a `CHANGELOG` entry, and both pushes re-priced
 * the whole chain — 12,800 completions to learn nothing. Nothing in a Markdown file is
 * read by a prompt at runtime, so the file name is the whole rule.
 *
 * The tests below pin the rule and its two conservative edges, and then pin that the
 * workflow actually consults it: a filter nobody calls is a comment with a shebang.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { needsModel, explain, summary, publish, isDocumentation, isTest, TRUNCATED_AT } from '../tools/ci-scope.mjs';

describe('a change set that only edits documentation', () => {
  it('does not need a model call', () => {
    const result = needsModel(['docs/benchmarks.md', 'CHANGELOG.md', 'README.md']);
    expect(result.measure).toBe(false);
    expect(result.reason).toContain('Markdown');
    expect(result.files).toBeUndefined();
  });

  it('treats the suffixes Markdown is written with as Markdown', () => {
    // `README.MD` on a case-insensitive filesystem and `notes.markdown` are the same
    // statement about what a prompt can read.
    expect(isDocumentation('README.MD')).toBe(true);
    expect(isDocumentation('docs/notes.markdown')).toBe(true);
    expect(isDocumentation('docs/notes.txt')).toBe(false);
  });

  it('reads the last segment, not the whole path', () => {
    // A directory called `docs.md` holding a `.txt` is a change to a text file; a reader
    // that matched on the path would skip it.
    expect(isDocumentation('docs.md/notes.txt')).toBe(false);
    expect(isDocumentation('docs.md/notes.md')).toBe(true);
  });

  it('ignores blank lines, which is how a here-doc ends', () => {
    expect(needsModel(['docs/guide.md', '', '  ']).measure).toBe(false);
  });
});

describe('a change set with code in it', () => {
  it('names the files that forced the measurement', () => {
    const result = needsModel(['docs/guide.md', 'packages/ai/src/prompt.ts', 'eval/bird/run.ts']);
    expect(result.measure).toBe(true);
    expect(result.files).toEqual(['packages/ai/src/prompt.ts', 'eval/bird/run.ts']);
    expect(result.reason).toContain('2 of 3');
  });

  it('counts a workflow edit as code', () => {
    // A change to `ci.yml` is not read by a prompt either, but it decides what the run
    // does, and a filter that skipped it could skip the run that proves the edit works.
    expect(needsModel(['.github/workflows/ci.yml']).measure).toBe(true);
  });
});

describe('a change set that only edits tests', () => {
  it('does not need a model call', () => {
    // The published number is produced by `eval/` and `packages/`; `test/` is run by the
    // `quality` job, which never skips. So a red TDD step — the push that most needs to be
    // cheap, and the one written before the code exists — buys no measurement.
    const result = needsModel(['test/bird-arms.test.ts', 'packages/ai/test/prompt.test.ts', 'CHANGELOG.md']);
    expect(result.measure).toBe(false);
    expect(result.reason).toContain('tests');
    expect(result.files).toBeUndefined();
  });

  it('recognises a test by its directory or by its suffix', () => {
    expect(isTest('test/ci-scope.test.ts')).toBe(true);
    expect(isTest('packages/ai/test/prompt.test.ts')).toBe(true);
    // A test colocated with its source is the convention a new package would arrive with.
    expect(isTest('packages/ai/src/prompt.test.ts')).toBe(true);
  });

  it('does not mistake a word that ends in test for a test directory', () => {
    // `latest/`, `contest.ts` and `attestation.ts` are source. A rule written as a
    // substring match would skip the run that measures them.
    expect(isTest('packages/ai/src/latest/prompt.ts')).toBe(false);
    expect(isTest('packages/ai/src/contest.ts')).toBe(false);
    expect(isTest('packages/ai/src/attestation.ts')).toBe(false);
  });

  it('still measures the harness and every corpus beside it', () => {
    // `eval/` holds the instrument and the data it reads, and `test` appears in that tree
    // only if someone puts it there; the directory rule names the two roots that exist so
    // that a new one has to be argued for rather than inherited.
    expect(needsModel(['eval/bird/run.ts']).measure).toBe(true);
    expect(needsModel(['eval/test/fixtures/cases.json']).measure).toBe(true);
    expect(isTest('eval/test/fixtures/cases.json')).toBe(false);
  });
});

describe('the two edges where the list cannot be trusted', () => {
  it('measures a push it cannot describe', () => {
    // "No files reported" is a reporting failure, not a statement that nothing changed.
    const result = needsModel([]);
    expect(result.measure).toBe(true);
    expect(result.reason).toContain('undescribed');
  });

  it('measures a list long enough to have been truncated', () => {
    // The commit endpoint stops at 300 files without saying so; the count is the only
    // signal that the list may be missing the one file that matters.
    const docs = Array.from({ length: TRUNCATED_AT }, (_, index) => `docs/page-${index}.md`);
    const result = needsModel(docs);
    expect(result.measure).toBe(true);
    expect(result.reason).toContain(`${TRUNCATED_AT}`);
    // One fewer is a complete list, and a complete list of Markdown is still Markdown.
    expect(needsModel(docs.slice(1)).measure).toBe(false);
  });
});

describe('the two files the step needs', () => {
  it('keeps the reason out of $GITHUB_OUTPUT, which parses nothing but key=value', () => {
    // `41397606408` failed this job with `Invalid format '3 of 5 changed file(s) are not
    // Markdown'`: the tool printed the reason and the key on one stream, the workflow piped
    // both into the output file, and the run went red before it could measure anything. A
    // sentence in that file is not a formatting preference — the parser rejects the step.
    const directory = mkdtempSync(join(tmpdir(), 'ci-scope-'));
    try {
      const output = join(directory, 'output');
      const summaryFile = join(directory, 'summary');
      writeFileSync(output, 'other=kept\n');
      writeFileSync(summaryFile, '');
      publish(needsModel(['docs/a.md', 'packages/a.ts']), { output, summary: summaryFile });
      const written = readFileSync(output, 'utf8');
      expect(written).toBe('other=kept\nmodels=true\n');
      for (const line of written.split('\n').filter((entry) => entry.length > 0)) {
        expect(line).toMatch(/^[a-z_]+=[^\n]*$/u);
      }
      // The summary is the other half: Markdown, and it carries the sentence.
      expect(readFileSync(summaryFile, 'utf8')).toContain('neither Markdown nor tests');
      expect(readFileSync(summaryFile, 'utf8')).toContain('packages/a.ts');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('writes nothing it was not given a path for', () => {
    // Both targets are optional so the tool is usable from a shell without a run around it.
    expect(() => publish(needsModel(['docs/a.md']), {})).not.toThrow();
  });

  it('describes at most five files, and says how many it hid', () => {
    // The step log is the only place a reader learns why a run measured, and a hundred
    // stacked paths push the reason off the visible part of the panel.
    const files = Array.from({ length: 8 }, (_, index) => `packages/a${index}.ts`);
    const lines = explain(needsModel(files));
    expect(lines.filter((line) => line.startsWith('  packages/'))).toHaveLength(5);
    expect(lines).toContain('  … and 3 more');
    expect(lines[0]).toContain('8 of 8');
  });

  it('heads the summary so a skipped run explains itself', () => {
    const text = summary(needsModel(['docs/a.md']));
    expect(text.startsWith('### did this push touch anything a prompt reads')).toBe(true);
    expect(text).toContain('Markdown');
  });
});

describe('the command the workflow calls', () => {
  const run = (files: string[], args: string[] = []): string =>
    execFileSync(process.execPath, [resolve(process.cwd(), 'tools/ci-scope.mjs'), ...args], {
      input: files.join('\n'),
      encoding: 'utf8',
    });

  it('reads the file list from stdin and answers on every stream', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ci-scope-cli-'));
    try {
      const output = join(directory, 'output');
      const summaryFile = join(directory, 'summary');
      const log = run(['docs/benchmarks.md', 'CHANGELOG.md'], ['--output', output, '--summary', summaryFile]);
      expect(readFileSync(output, 'utf8')).toBe('models=false\n');
      expect(log).toContain('Markdown');
      // The summary is appended, not overwritten: a job has one summary and several steps.
      writeFileSync(summaryFile, 'earlier\n');
      run(['eval/bird/run.ts'], ['--output', output, '--summary', summaryFile]);
      expect(readFileSync(summaryFile, 'utf8').startsWith('earlier\n')).toBe(true);
      expect(readFileSync(output, 'utf8')).toBe('models=false\nmodels=true\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('ci.yml consults the filter', () => {
  const text = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
  const jobsSection = text.slice(text.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const block = (id: string): string => {
    const start = jobsSection.indexOf(`\n  ${id}:\n`);
    expect(start, id).toBeGreaterThan(-1);
    const rest = jobsSection.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };

  it('has a job that reports whether the push touches code', () => {
    const changes = block('changes');
    expect(changes).toContain('outputs:');
    expect(changes).toContain('models: ${{ steps.scope.outputs.models }}');
    expect(changes).toContain('node tools/ci-scope.mjs');
    // The paths come in as flags, so the only thing that reaches `$GITHUB_OUTPUT` is the key:
    // piping the tool's stdout there is the bug that turned this job red on its first run.
    const call = changes.split('\n').find((line) => line.includes('node tools/ci-scope.mjs')) ?? '';
    expect(call).toContain('--output \"$GITHUB_OUTPUT\"');
    expect(call).toContain('--summary \"$GITHUB_STEP_SUMMARY\"');
    expect(call).not.toContain('>>');
  });

  it('gates both jobs that spend a model call on it', () => {
    for (const id of ['bird-eval', 'live-eval']) {
      const body = block(id);
      expect(body, id).toContain('needs: [quality, changes]');
      expect(body, id).toContain("needs.changes.outputs.models == 'true'");
    }
  });

  it('leaves the jobs that spend no model call alone', () => {
    // `quality` and `benchmark` are the two jobs whose cost is a runner minute. Gating
    // them would make a documentation fix wait for a decision it cannot affect.
    for (const id of ['quality', 'benchmark']) {
      expect(block(id), id).not.toContain('needs.changes.outputs.models');
    }
  });
});
