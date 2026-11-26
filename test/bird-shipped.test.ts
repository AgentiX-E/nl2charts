/**
 * Which arm this repository ships, and whether the four records that imply it agree.
 *
 * The round that wrote this file began with two documents that both looked like an answer: the
 * coverage table cited `select-mixed`'s floor (62.5, its best run 62.34) for BIRD dev, while the
 * R-VES row beside it — and the recipe `packages/ai` sends, and the ledger that put it there — all
 * said `macsql-prompt` at 1,010 of 1,532. Both numbers were true. The rows were about different
 * arms, and neither row said so, so a reader comparing this project with a leaderboard had to
 * choose which of two "shipped" numbers to quote.
 *
 * The four records are the recipe, the baseline's `shippedBySplit`, the R-VES reading, and the
 * ledger's winning row. Every `it` below breaks one of them on purpose: a check whose refusal has
 * never been observed is a check nobody has read, and the specific defect that started this file
 * was a check that agreed with itself while two documents disagreed.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHIPPED_SQL } from '@agentix-e/nl2charts-ai';
import { main, shippedProblems } from '../eval/bird/ship.js';
import { BENCHMARKS, resolveReading } from '../eval/benchmarks.js';

const ROOT = resolve(import.meta.dirname, '..');
const FILES = {
  bird: 'eval/baseline/bird.json',
  ves: 'eval/baseline/bird-ves.json',
  ledger: 'eval/bird/shipment.json',
} as const;

type Tree = {
  bird: Record<string, unknown>;
  ves: Record<string, unknown>;
  ledger: Record<string, unknown>;
};

/** The three files as the repository holds them, deep-copied: every case below edits one of them. */
function readTree(): Tree {
  const load = (path: string): Record<string, unknown> =>
    JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as Record<string, unknown>;
  return { bird: load(FILES.bird), ves: load(FILES.ves), ledger: load(FILES.ledger) };
}

/** A tree on disk, so a case goes through the same `readFileSync` the gate does. */
function materialise(tree: Tree): string {
  const dir = mkdtempSync(join(tmpdir(), 'bird-shipped-'));
  for (const key of ['bird', 'ves', 'ledger'] as const) {
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(tree[key], null, 2));
  }
  return dir;
}

/** The problems a tree produces, over the three files written into a directory of their own. */
function problemsOf(tree: Tree): readonly string[] {
  const dir = materialise(tree);
  return shippedProblems(ROOT, { bird: join(dir, 'bird.json'), ves: join(dir, 'ves.json'), ledger: join(dir, 'ledger.json') });
}

/** The arm `SHIPPED_SQL` names, or a failure: every case below is about this arm. */
const ARM: string = ((): string => {
  const arm = SHIPPED_SQL.arm;
  if (arm === undefined) throw new Error('SHIPPED_SQL names no arm, so nothing in this file is about anything');
  return arm;
})();

const dev = (tree: Tree): Record<string, unknown> => tree.bird.armsBySplit as Record<string, unknown>;
const devFloors = (tree: Tree): Record<string, number> => {
  const floors = (tree.bird.floors as Record<string, Record<string, number>>).dev;
  if (floors === undefined) throw new Error('the baseline floors no arm on dev');
  return floors;
};
const decision = (tree: Tree): Record<string, unknown> =>
  (tree.ledger.decisions as Record<string, unknown>[]).at(-1) as Record<string, unknown>;

describe('the tree this repository ships', () => {
  it('names one arm in four places and no problems', () => {
    // The real files, the real recipe: the acceptance case is not a fixture, because the defect
    // this guards against was a fixture-free disagreement between two documents on disk.
    expect(shippedProblems(ROOT)).toEqual([]);
  });

  it('declares the arm the recipe sends, on the split whose floors the product is judged against', () => {
    const tree = readTree();
    const declared = tree.bird.shippedBySplit as Record<string, string>;
    expect(declared).toEqual({ dev: ARM });
    // A shipped arm that no dispatch runs is a floor nothing notices, and a floor on an arm nobody
    // ships is a number about the harness. The two lists have to meet at the shipped arm.
    expect(dev(tree).dev).toContain(ARM);
    expect(devFloors(tree)).toHaveProperty(ARM);
  });
});

describe('the ways the four records can drift apart', () => {
  it('refuses a baseline with no shipped arm declared at all', () => {
    const tree = readTree();
    delete tree.bird.shippedBySplit;
    expect(problemsOf(tree).join('\n')).toContain('has no `shippedBySplit`');
  });

  it('refuses a declared arm the recipe does not send', () => {
    const tree = readTree();
    tree.bird.shippedBySplit = { dev: 'select-mixed' };
    const problems = problemsOf(tree).join('\n');
    expect(problems).toContain('the baseline says `select-mixed` ships on `dev`');
    expect(problems).toContain(`\`${SHIPPED_SQL.name}\` ships \`${ARM}\``);
  });

  it('refuses a shipped arm missing from the split it is judged on', () => {
    const tree = readTree();
    dev(tree).dev = (dev(tree).dev as string[]).filter((arm) => arm !== ARM);
    expect(problemsOf(tree).join('\n')).toContain(`\`${ARM}\` is not in \`armsBySplit.dev\``);
  });

  it('refuses a split that declares an arm without declaring which arms it runs', () => {
    const tree = readTree();
    delete tree.bird.armsBySplit;
    expect(problemsOf(tree).join('\n')).toContain('`armsBySplit` does not name the split');
  });

  it('refuses an arm that ships with no floor behind it', () => {
    const tree = readTree();
    delete devFloors(tree)[ARM];
    expect(problemsOf(tree).join('\n')).toContain(`\`${ARM}\` has no floor on \`dev\``);
  });

  it('refuses a floor set above the reading that produced it', () => {
    const tree = readTree();
    devFloors(tree)[ARM] = 70;
    expect(problemsOf(tree).join('\n')).toContain('a floor above its own reading fails the run that set it');
  });

  it('refuses an R-VES reading taken on another arm, which is the defect this file was written for', () => {
    const tree = readTree();
    tree.ves.arm = 'select-mixed';
    tree.ves.ex = 62.34;
    expect(problemsOf(tree).join('\n')).toContain('the published number and the shipped arm have to be the same arm');
  });

  it('refuses an R-VES reading taken on another split', () => {
    const tree = readTree();
    tree.ves.split = 'minidev';
    expect(problemsOf(tree).join('\n')).toContain('the R-VES reading is on `minidev`');
  });

  it('refuses a ledger whose last decision is another arm', () => {
    const tree = readTree();
    (decision(tree).challenger as Record<string, unknown>).arm = 'select-mixed';
    expect(problemsOf(tree).join('\n')).toContain('the experiment and the product disagree about what won');
  });

  it('refuses a ledger with no decision, because then nothing put the arm in the product', () => {
    const tree = readTree();
    tree.ledger = { schemaVersion: 1, decisions: [] };
    expect(problemsOf(tree).join('\n')).toContain('the ledger holds no decision');
  });

  it('refuses counts that do not reproduce the published percentage', () => {
    const tree = readTree();
    (decision(tree).challenger as Record<string, number>).correct = 1009;
    const problems = problemsOf(tree).join('\n');
    expect(problems).toContain('one of the two was copied from a different run');
    // 1,009 of 1,532 is 65.86%, and the reading says 65.93: the difference is one answer, which is
    // exactly the size of mistake a hand-edited count makes.
    expect(problems).toContain('the ledger\'s counts say 65.86%');
  });

  it('refuses two denominators presented as one reading', () => {
    const tree = readTree();
    (decision(tree).challenger as Record<string, number>).total = 600;
    expect(problemsOf(tree).join('\n')).toContain('two denominators, so the two numbers are not one reading');
  });

  it('refuses a reading and a decision from different runs', () => {
    const tree = readTree();
    tree.ves.artifact = { workflowRun: 12345 };
    expect(problemsOf(tree).join('\n')).toContain('the R-VES reading is the artifact of run 12345');
  });

  it('reports a file it cannot read as a problem rather than throwing', () => {
    // A gate that dies on a missing file prints a stack trace where the reason should be, and the
    // reason is what a reader hundreds of lines into a log needs.
    const problems = shippedProblems(ROOT, { bird: 'eval/baseline/not-there.json' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('shipped:');
  });
});

describe('the command the workflow runs', () => {
  it('exits zero on the tree this repository ships', () => {
    const lines: string[] = [];
    expect(main(['--check'], (line) => lines.push(line))).toBe(0);
    expect(lines.some((line) => line.startsWith('FAILED'))).toBe(false);
  });

  it('exits one and prints the reason when a document drifts', () => {
    // `pnpm gate:shipment` runs this command, and a helper that refuses while the command exits 0
    // is the shape this repository has already paid for: the R-VES reading that printed 0.00% and
    // exited 0, whose defect was the absence of a number rather than a number.
    const tree = readTree();
    tree.bird.shippedBySplit = { dev: 'select-mixed' };
    const dir = materialise(tree);
    const lines: string[] = [];
    const code = main(['--check', '--bird', join(dir, 'bird.json')], (line) => lines.push(line));
    expect(code).toBe(1);
    expect(lines.some((line) => line.startsWith('FAILED shipped:'))).toBe(true);
    expect(lines.some((line) => line.includes('the baseline says `select-mixed` ships on `dev`'))).toBe(true);
  });
});

describe('the coverage table cites one arm', () => {
  it('prints the shipped arm\'s execution accuracy, from the run the R-VES row cites', () => {
    const ex = BENCHMARKS.find((row) => row.id === 'bird-dev');
    const rves = BENCHMARKS.find((row) => row.id === 'bird-dev-rves');
    expect(ex?.reading?.file).toBe(FILES.ves);
    expect(ex?.reading?.path).toEqual(['ex']);
    // A `run` is an observation; a `floor` is a threshold. The row a leaderboard comparison quotes
    // may not be the second kind: 62.5 was true and was a number no run produced.
    expect(ex?.reading?.kind).toBe('run');
    expect(rves?.reading?.file).toBe(FILES.ves);
    const reading = ex?.reading;
    if (reading === undefined) throw new Error('bird-dev cites no reading');
    const read = (file: string): unknown => JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')) as unknown;
    expect(resolveReading(reading, read)).toBe(65.93);
  });

  it('names the arm in the row\'s own note, so a quoted line cannot lose it', () => {
    // The printed line is `BIRD dev (EX) = 65.93`, which by itself says nothing about which prompt
    // produced it; the note is the only place a reader of the table finds the arm.
    const ex = BENCHMARKS.find((row) => row.id === 'bird-dev');
    expect(ex?.reading?.note).toContain(ARM);
    expect(ex?.reading?.note).toContain('12.56pp');
  });
});
