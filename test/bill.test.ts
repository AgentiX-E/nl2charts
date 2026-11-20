import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { billOfArtifact, describeBillOf, entryBill, parseBillArgs } from '../eval/bill.js';

describe('what an artifact cost', () => {
  it('prices a judge reading, including the bill the store prevented', () => {
    const bill = billOfArtifact({
      grader: { endpoint: 'zhipu', model: 'glm-4.5v' },
      tokens: { prompt: 1_171_852, completion: 1_390_180, reasoning: 1_366_108, reported: 1_416 },
      cached: 1_376,
      saved: { prompt: 1_139_000, completion: 1_351_000, reasoning: 1_328_000, reported: 1_376 },
    });
    expect(bill.rows.map((row) => [row.label, row.rows])).toEqual([
      ['spent', 1416],
      ['not spent (the store answered)', 1376],
    ]);
    // ¥2.34 + ¥8.34 spent, and ¥2.28 + ¥8.11 the store answered for: the total is what the reading
    // would have cost with no store, which is the only honest number to compare a future reading to.
    expect(bill.yuan).toBeCloseTo((1_171_852 * 2 + 1_390_180 * 6 + 1_139_000 * 2 + 1_351_000 * 6) / 1_000_000, 5);
  });

  it('prices a BIRD reading off its rows, because that is where the arms are', () => {
    const bill = billOfArtifact({
      model: 'deepseek-flash',
      cases: [
        { arm: 'inline+evidence', tokens: { prompt: 1_000_000, completion: 1_000_000, cached: 500_000 } },
        { arm: 'inline+evidence', tokens: { prompt: 1_000_000, completion: 0 } },
        { arm: 'select', tokens: { prompt: 500_000, completion: 0, cached: 250_000 } },
      ],
    });
    expect(bill.rows.map((row) => [row.label, row.rows])).toEqual([
      ['inline+evidence', 2],
      ['select', 1],
    ]);
    expect(bill.cached).toBe(750_000);
    // The hit price is charged on the hit tokens and the miss price on the rest; pricing all of it at
    // the miss price would overstate this bill by a third.
    const expected =
      ((2_500_000 - 750_000) * 2 + 750_000 * 0.04 + 1_000_000 * 8) / 1_000_000;
    expect(bill.yuan).toBeCloseTo(Number(expected.toFixed(6)), 5);
  });

  it('refuses an artifact it cannot price rather than reporting a reading of zero', () => {
    expect(() => billOfArtifact({ what: 'not a reading' })).toThrow(/names no model/);
    expect(() => billOfArtifact({ model: 'deepseek-flash' })).toThrow(/does not know/);
    expect(() => billOfArtifact('a string')).toThrow(/not a JSON object/);
  });

  it('prints nothing rather than a zero when the model has no price on file', () => {
    const bill = billOfArtifact({ grader: { model: 'nobody-priced-this' }, tokens: { prompt: 10, completion: 10, reasoning: 0, reported: 1 } });
    expect(bill.yuan).toBeNull();
    expect(describeBillOf(bill).join('\n')).toContain('no price on file');
  });

  it('rolls a case that named no arm into its own row rather than dropping it', () => {
    // A case written before the arms existed has no `arm` field, and a bill that skipped it would
    // report a total smaller than the calls it is a bill for.
    const bill = billOfArtifact({
      model: 'deepseek-flash',
      cases: [{ tokens: { prompt: 1_000_000, completion: 0 } }, { arm: 'select', tokens: { prompt: 1_000_000, completion: 0, cached: 400_000 } }],
    });
    expect(bill.rows.map((row) => [row.label, row.rows])).toEqual([
      ['select', 1],
      ['unarmed', 1],
    ]);
    // The cached column is stated only where a cache was read: a zero written as a field is a claim
    // about the provider that no artifact made.
    expect(bill.rows.map((row) => row.tokens.cachedPromptTokens)).toEqual([400_000, undefined]);
  });

  it('states reasoning and cached tokens on the line that spent them, and a total with no rows to name', () => {
    const lines = describeBillOf({
      rows: [{ label: 'spent', rows: 3, tokens: { promptTokens: 1_000_000, completionTokens: 0, reasoningTokens: 500_000, cachedPromptTokens: 250_000 }, model: 'deepseek-flash' }],
      prompt: 1_000_000,
      completion: 0,
      reasoning: 500_000,
      cached: 250_000,
      yuan: 0.5,
    });
    expect(lines.join('\n')).toContain('deepseek-flash');
    expect(lines.join('\n')).toContain('reasoning');
    // A bill with no rows still has to say whose price was missing, without inventing a model name.
    const empty = describeBillOf({ rows: [], prompt: 0, completion: 0, reasoning: 0, cached: 0, yuan: null });
    expect(empty.join('\n')).toContain('no price on file for this model');
  });
});

describe('the command', () => {
  it('prices the artifact it is given, and says which reading it was', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bill-'));
    try {
      const artifact = join(directory, 'judge.json');
      writeFileSync(
        artifact,
        JSON.stringify({ grader: { model: 'glm-4.5v' }, tokens: { prompt: 1_000_000, completion: 1_000_000, reasoning: 999_000, reported: 1 }, saved: { prompt: 0, completion: 0, reasoning: 0, reported: 0 } }),
      );
      expect(parseBillArgs([artifact]).artifact).toBe(artifact);
      expect(parseBillArgs([artifact, '--json']).json).toBe(true);
      expect(() => parseBillArgs([])).toThrow(/name the artifact to price/);
      expect(() => parseBillArgs([artifact, artifact])).toThrow(/one artifact at a time/);
      expect(() => parseBillArgs([artifact, '--verbose'])).toThrow(/unknown argument --verbose/);
      // A module that is not the entry point is not the command: the promise resolves to undefined
      // rather than to an exit code, which is what keeps the file importable from a test.
      await expect(entryBill(undefined, 'file:///not/this/one', () => undefined, [artifact])).resolves.toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('prints the bill as JSON when the caller asked for a machine rather than a page', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bill-json-'));
    const entry = join(process.cwd(), 'eval/bill.ts');
    try {
      const artifact = join(directory, 'judge.json');
      writeFileSync(artifact, JSON.stringify({ grader: { model: 'glm-4.5v' }, tokens: { prompt: 1_000_000, completion: 0, reasoning: 0, reported: 1 } }));
      const lines: string[] = [];
      expect(await entryBill(entry, pathToFileURL(entry).href, (line) => lines.push(line), [artifact, '--json'])).toBe(0);
      // One line of JSON and no prose: a caller that parses this output must not have to strip a header.
      const parsed = JSON.parse(lines.join('\n')) as { rows: unknown[]; yuan: number };
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.yuan).toBeCloseTo(2, 5);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads a real file, and reports a file it cannot read as a failure with a message', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bill-run-'));
    const entry = join(process.cwd(), 'eval/bill.ts');
    try {
      const artifact = join(directory, 'judge.json');
      writeFileSync(
        artifact,
        JSON.stringify({ grader: { model: 'glm-4.5v' }, tokens: { prompt: 1_000_000, completion: 1_000_000, reasoning: 0, reported: 1 }, saved: { prompt: 0, completion: 0, reasoning: 0, reported: 0 } }),
      );
      const lines: string[] = [];
      expect(await entryBill(entry, pathToFileURL(entry).href, (line) => lines.push(line), [artifact])).toBe(0);
      // ¥2 + ¥6: the two lines of the invoice, at the price the table cites.
      expect(lines.join('\n')).toContain('¥8.00');
      expect(lines.join('\n')).toContain('bill: 1 line(s), 1 rows');

      const missing: string[] = [];
      expect(await entryBill(entry, pathToFileURL(entry).href, (line) => missing.push(line), [join(directory, 'nope.json')])).toBe(1);
      expect(missing.join('\n')).toContain('bill:');
      expect(JSON.parse(readFileSync(artifact, 'utf8')).grader.model).toBe('glm-4.5v');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
