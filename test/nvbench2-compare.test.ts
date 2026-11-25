import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  artifactOf, compare, comparisonLine, main, pairOf, seeded, vectorOf,
} from '../eval/nvbench2/compare.js';

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nl2charts-nvbench2-compare-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** An artifact with one vector per width, in the shape `runArm` writes. */
function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    split: 'dev',
    model: 'deepseek-chat',
    k: 3,
    digest: 'a'.repeat(64),
    perQuestion: { f1: { '1': [0, 0, 1, 0], '3': [0.5, 0, 1, 0.25] } },
    ...overrides,
  };
}

describe('the artifact', () => {
  it('reads the fields it needs and refuses an artifact that has no per-question vector', () => {
    const read = artifactOf(artifact({ ask: 5, cost: { yuan: 1.5 } }), 'x');
    expect(read.ask).toBe(5);
    expect(read.cost?.yuan).toBe(1.5);
    // The mean is in every artifact ever written, and a comparison on the mean would be the
    // subtraction this file exists to replace — so the absence is an error that names the fix.
    expect(() => artifactOf(artifact({ perQuestion: undefined }), 'x')).toThrow(/re-run that arm/);
    expect(() => artifactOf(artifact({ perQuestion: { f1: undefined } }), 'x')).toThrow(/per-question vector/);
  });

  it('names the field that made an artifact unusable rather than casting it', () => {
    expect(() => artifactOf('a string', 'x')).toThrow(/not an artifact object/);
    expect(() => artifactOf({ ...artifact(), split: undefined }, 'x')).toThrow(/names no split/);
    expect(() => artifactOf({ ...artifact(), model: undefined }, 'x')).toThrow(/names no model/);
    expect(() => artifactOf({ ...artifact(), k: undefined }, 'x')).toThrow(/names no scoring width/);
    expect(() => artifactOf({ ...artifact(), perQuestion: { f1: { '3': 'nope' } } }, 'x'))
      .toThrow(/not a list of numbers/);
    expect(() => artifactOf({ ...artifact(), perQuestion: { f1: { '3': [0, 'nope'] } } }, 'x'))
      .toThrow(/not a list of numbers/);
    expect(() => artifactOf({ ...artifact(), digest: 7 }, 'x')).toThrow(/digest that is not a string/);
    expect(() => artifactOf({ ...artifact(), ask: '5' }, 'x')).toThrow(/ask that is not a number/);
    expect(() => artifactOf({ ...artifact(), cost: 7 }, 'x')).toThrow(/bill that is not an object/);
    expect(() => artifactOf({ ...artifact(), cost: { yuan: 'free' } }, 'x')).toThrow(/bill in yuan/);
  });

  it('does not offer a width the artifact was not scored at', () => {
    const read = artifactOf(artifact(), 'x');
    expect(vectorOf(read, 3, 'x')).toHaveLength(4);
    // The message lists the widths it does have, because "no vector at k=5" alone sends the reader
    // looking for a bug in the comparison rather than at the artifact's own k list.
    expect(() => vectorOf(read, 5, 'x')).toThrow(/scored at 1, 3, not at k=5/);
  });
});

describe('the interval', () => {
  it('reads no difference as no difference, and reads a real one as one', () => {
    const same = compare([0.5, 0, 1, 0.25], [0.5, 0, 1, 0.25], { k: 3 });
    expect(same.delta).toBe(0);
    expect(same.separated).toBe(false);
    expect(same.low).toBe(0);
    expect(same.high).toBe(0);
    // Every question moves together, so every resample moves together: the interval is bounded away
    // from zero and the verdict is a statement about the corpus rather than about the resampler.
    const better = compare([0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1], { k: 3 });
    expect(better.delta).toBeCloseTo(1, 12);
    expect(better.low).toBeGreaterThan(0);
    expect(better.separated).toBe(true);
    expect(better.questions).toBe(6);
  });

  it('keeps a difference that lives on two questions inside the noise', () => {
    // Two of forty questions improve by half a point of F1 each: a mean that moves 0.025 and a
    // bootstrap that cannot tell it from a corpus that answered differently.
    const base = Array.from({ length: 40 }, () => 0.3);
    const arm = [...base];
    arm[0] = 0.8;
    arm[1] = 0.8;
    const comparison = compare(base, arm, { k: 3 });
    expect(comparison.delta).toBeCloseTo(0.025, 12);
    expect(comparison.low).toBeLessThanOrEqual(0);
    expect(comparison.separated).toBe(false);
  });

  it('is deterministic, because an interval nobody can reproduce is a rhetorical device', () => {
    const base = Array.from({ length: 30 }, (_, at) => (at % 3 === 0 ? 0.6 : 0.1));
    const arm = Array.from({ length: 30 }, (_, at) => (at % 2 === 0 ? 0.55 : 0.2));
    const first = compare(base, arm, { k: 3 });
    const second = compare(base, arm, { k: 3 });
    expect(first).toEqual(second);
    expect(first.resamples).toBe(2000);
    const other = compare(base, arm, { k: 3, seed: 7 });
    expect(other.low).not.toBe(first.low);
  });

  it('refuses a pairing it cannot make and a resample count it cannot honour', () => {
    // The message has to name both causes and the fix: a different `--limit` is a different split, and
    // a short vector from before failed rows kept their place divided its mean by the questions it
    // answered. Neither is repairable by arithmetic — the short arm has to be dispatched again.
    expect(() => compare([1, 2], [1, 2, 3], { k: 3 })).toThrow(/an artifact written before failed rows/);
    expect(() => compare([1, 2], [1, 2, 3], { k: 3 })).toThrow(/re-dispatch the short arm/);
    expect(() => compare([], [], { k: 3 })).toThrow(/nothing to compare/);
    expect(() => compare([1], [1], { k: 3, resamples: 50 })).toThrow(/at least 100/);
    expect(() => compare([1], [1], { k: 3, resamples: 2.5 })).toThrow(/at least 100/);
  });

  it('prints the comparison with its interval and its verdict', () => {
    const separated = comparisonLine(compare([0, 0], [1, 1], { k: 3 }));
    expect(separated).toContain('F1@3: 0.00% → 100.00% (+100.00%, 95% [100.00%, 100.00%], separated from zero)');
    expect(separated).toContain('over 2 paired questions, 2000 resamples');
    const flat = comparisonLine(compare([0.5, 0.5], [0.5, 0.5], { k: 3 }));
    expect(flat).toContain('(+0.00%, 95% [0.00%, 0.00%], inside the noise)');
    // A negative difference keeps its sign, because a ruled-out change is a result worth stating.
    expect(comparisonLine(compare([1, 1], [0, 0], { k: 3 }))).toContain('(-100.00%');
  });
});

describe('the PRNG', () => {
  it('repeats a seed and does not repeat a different one', () => {
    const draw = (seed: number): number[] => {
      const random = seeded(seed);
      return [random(), random(), random()];
    };
    expect(draw(11)).toEqual(draw(11));
    expect(draw(11)).not.toEqual(draw(12));
    for (const value of draw(3)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('the pair', () => {
  it('pairs two artifacts over one corpus, whatever their means say', () => {
    const base = artifact({ perQuestion: { f1: { '3': [0.5, 0, 1, 0.25] } } });
    const arm = artifact({ perQuestion: { f1: { '3': [0.5, 0.5, 1, 0.25] } }, ask: 5 });
    const comparison = pairOf(base, arm, 3);
    expect(comparison.questions).toBe(4);
    expect(comparison.delta).toBeCloseTo(0.125, 12);
  });

  it('refuses two corpora, and two splits, and lets an artifact without a digest through', () => {
    const other = artifact({ digest: 'b'.repeat(64) });
    expect(() => pairOf(artifact(), other, 3)).toThrow(/answered different questions/);
    expect(() => pairOf(artifact(), artifact({ split: 'test' }), 3)).toThrow(/different splits/);
    // An artifact from before the digest existed still has an order, and refusing it would refuse the
    // arms this file is meant to compare; the split check still holds.
    const noDigest = artifact({ digest: undefined });
    expect(pairOf(noDigest, artifact(), 3).questions).toBe(4);
  });
});

describe('the command', () => {
  it('reads two files, prints one line and exits zero whether or not the gap is real', () => {
    const dir = scratch();
    const basePath = join(dir, 'base.json');
    const armPath = join(dir, 'arm.json');
    writeFileSync(basePath, JSON.stringify(artifact()));
    writeFileSync(armPath, JSON.stringify(artifact({ perQuestion: { f1: { '3': [0.5, 0, 1, 0.25] } } })));
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      expect(main(['--base', basePath, '--arm', armPath, '--k', '3', '--resamples', '200'])).toBe(0);
      expect(written.join('')).toContain('inside the noise');
      expect(main(['--base', basePath, '--arm', armPath])).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('names the flag it needs and refuses a width that is not a width', () => {
    expect(() => main(['--base', 'a.json'])).toThrow(/--base and --arm/);
    expect(() => main(['--base', 'a.json', '--arm', 'b.json', '--k', '0'])).toThrow(/positive whole number/);
    expect(() => main(['--base', 'a.json', '--arm', 'b.json', '--k', 'x'])).toThrow(/positive whole number/);
  });
});
