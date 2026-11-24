import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve('.');
const SCRIPT = join(ROOT, 'eval/nvbench2/metadata.py');

/**
 * Whether the rebuild can run at all.
 *
 * `metadata.py` is Python because the reference's type rule *is* pandas' dtype inference (`is_numeric
 * _dtype`, the `id`/`_id` name test), and re-deriving that in JavaScript would be a second
 * implementation to disagree with. So the suite that exercises it is skipped where pandas is absent
 * — and says so, rather than passing quietly.
 */
function pandasAvailable(): boolean {
  try {
    execFileSync('python3', ['-c', 'import pandas'], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const available = pandasAvailable();

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nl2charts-nvbench2-meta-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const run = (args: string[]): { code: number; out: string } => {
  try {
    const out = execFileSync('python3', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
    return { code: 0, out };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failed.status ?? 1, out: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
  }
};

describe.skipIf(!available)('metadata.py', () => {
  it('checks eleven claims about the type rule and the filter it replaces', () => {
    const { code, out } = run(['--self-test']);
    expect(code).toBe(0);
    expect(out).toContain('metadata self-test: ok');
  });

  it('types a directory of tables, ignoring an AppleDouble file that is also called .csv', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'a@t.csv'), 'amount,name,id\n1.5,x,1\n2.5,y,2\n');
    writeFileSync(join(dir, 'b@t.csv'), 'stamp,note\n2020-01-01,hello\n');
    writeFileSync(join(dir, '._a@t.csv'), 'resource fork, not a table\n');
    const out = join(dir, 'metadata.json');
    const { code } = run([dir, '--out', out]);
    expect(code).toBe(0);
    const payload = JSON.parse(readFileSync(out, 'utf8')) as {
      csv: number;
      digest: string;
      fields: Record<string, number>;
      types: Record<string, Record<string, string>>;
    };
    expect(payload.csv).toBe(2);
    expect(Object.keys(payload.types).sort()).toEqual(['a@t.csv', 'b@t.csv']);
    expect(payload.types['a@t.csv']).toEqual({ amount: 'quantitative', name: 'category', id: 'category' });
    // A date column is text, because pandas reads `2020-01-01` as text — so `temporal` is
    // unreachable from the published tables, and the judge's two branches for it collapse into one.
    expect(payload.types['b@t.csv']).toEqual({ stamp: 'category', note: 'category' });
    expect(payload.fields).toEqual({ category: 4, quantitative: 1, temporal: 0 });
    expect(payload.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('builds only the tables it is asked for, so a reading can be taken before a full pass', () => {
    const dir = scratch();
    for (const name of ['a@t.csv', 'b@t.csv', 'c@t.csv']) writeFileSync(join(dir, name), 'n\n1\n');
    const out = join(dir, 'metadata.json');
    expect(run([dir, '--out', out, '--limit', '2']).code).toBe(0);
    expect(Object.keys((JSON.parse(readFileSync(out, 'utf8')) as { types: object }).types)).toHaveLength(2);
  });

  it('prints its summary on stdout so a workflow log carries the reading', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'a@t.csv'), 'n\n1\n');
    const { out } = run([dir]);
    expect(JSON.parse(out.trim())).toMatchObject({ csv: 1, fields: { quantitative: 1 } });
  });

  it('refuses to build from a directory that is not there, and from one with no tables', () => {
    // Two different refusals: a missing directory is a mistake in the invocation, and an empty one
    // is an archive that was never extracted. A map of zero tables would let the gate pass on
    // nothing.
    expect(run([join(scratch(), 'absent')]).code).not.toBe(0);
    const empty = scratch();
    const { code, out } = run([empty, '--out', join(empty, 'metadata.json')]);
    expect(code).toBe(1);
    expect(out).toContain('no tables in');
  });

  it('insists on a directory when it is not checking itself', () => {
    const { code, out } = run([]);
    expect(code).not.toBe(0);
    expect(out).toContain('csv_dir is required unless --self-test');
  });
});
