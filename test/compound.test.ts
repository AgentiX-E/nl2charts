import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  billOfCase,
  compoundOf,
  frontierOf,
  main,
  measure,
  PARENT_DRIFT_MAX,
  readArtifact,
  reportLines,
  requiredPpFor,
  resolveSettings,
  SELF_TEST_ASSERTIONS,
  selfTest,
  verdictOf,
} from '../eval/bird/compound.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Row {
  readonly id: string;
  readonly passed: boolean;
  readonly prompt?: number;
  readonly completion?: number;
  readonly cached?: number;
}

/** Write an artifact of two arms, so a test can say exactly what a split looked like. */
function artifact(parent: readonly Row[], lever: readonly Row[], leverName = 'lever', parentName = 'parent'): string {
  const dir = mkdtempSync(join(tmpdir(), 'compound-'));
  dirs.push(dir);
  const path = join(dir, 'bird-eval.json');
  const cases = [
    ...parent.map((row) => ({ arm: parentName, id: row.id, passed: row.passed, tokens: tokensOf(row) })),
    ...lever.map((row) => ({ arm: leverName, id: row.id, passed: row.passed, tokens: tokensOf(row) })),
  ];
  writeFileSync(path, JSON.stringify({ model: 'deepseek-chat', split: 'dev', provenance: { run: '1' }, cases }));
  return path;
}

function tokensOf(row: Row): { prompt: number; completion: number; cached: number } {
  return { prompt: row.prompt ?? 676, completion: row.completion ?? 49, cached: row.cached ?? 484 };
}

/** Ten questions: the parent answers the even ids, the lever answers the odd ones. */
function family(ids: readonly number[]): { parent: Row[]; lever: Row[] } {
  return {
    parent: ids.map((n) => ({ id: `q${String(n)}`, passed: n % 2 === 0 })),
    lever: ids.map((n) => ({ id: `q${String(n)}`, passed: n % 2 === 1 })),
  };
}

describe('billOfCase', () => {
  it('counts the tokens a bill is made of: cache misses and the reply', () => {
    // A cached prompt token is not free, but it is a fiftieth of an uncached one, so the quantity a
    // decision is made against is the miss column plus the completion. Counting the whole prompt
    // charges a long card twice for the same arithmetic.
    expect(billOfCase({ prompt: 1000, completion: 100, cached: 800 })).toBe(300);
  });

  it('treats a case with no token record as unbilled rather than as zero', () => {
    expect(billOfCase(undefined)).toBeUndefined();
    expect(billOfCase({})).toBe(0);
  });

  it('refuses to let cached exceed prompt, which would be a negative bill', () => {
    // The failure is a producer bug, and letting it through would make a lever look cheaper than
    // free — the direction of error that gets a run dispatched.
    expect(() => billOfCase({ prompt: 10, completion: 1, cached: 20 })).toThrow(/cached/);
  });
});

describe('readArtifact', () => {
  it('groups cases by arm and keeps the run it came from', () => {
    const { parent, lever } = family([1, 2, 3]);
    const artifactPath = artifact(parent, lever);
    const read = readArtifact(artifactPath);
    expect([...read.arms.keys()].sort()).toEqual(['lever', 'parent']);
    expect(read.arms.get('parent')?.size).toBe(3);
    expect(read.run).toBe('1');
    expect(read.split).toBe('dev');
  });

  it('refuses a file that carries no cases, rather than reading it as an empty split', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compound-'));
    dirs.push(dir);
    const path = join(dir, 'bird-eval.json');
    writeFileSync(path, JSON.stringify({ cases: [] }));
    expect(() => readArtifact(path)).toThrow(/no case/);
  });
});

describe('measure', () => {
  it('counts each arm and keeps the bill per case', () => {
    const { parent, lever } = family([1, 2, 3, 4]);
    const reading = measure(readArtifact(artifact(parent, lever)), 'parent', 'lever');
    expect(reading.parentCorrect).toBe(2);
    expect(reading.leverCorrect).toBe(2);
    expect(reading.cases).toBe(4);
    expect(reading.parentBill).toBe(241);
    expect(reading.leverBill).toBe(241);
  });

  it('refuses a parent the artifact never ran', () => {
    const { parent, lever } = family([1, 2]);
    const read = readArtifact(artifact(parent, lever));
    expect(() => measure(read, 'absent', 'lever')).toThrow(/never ran/);
  });

  it('refuses a lever that is not in the artifact', () => {
    const { parent, lever } = family([1, 2]);
    const read = readArtifact(artifact(parent, lever));
    expect(() => measure(read, 'parent', 'absent')).toThrow(/no case/);
  });

  it('refuses two artifacts that do not ask the same questions', () => {
    // A union over different question sets is a union of two splits, and its ceiling would be a
    // claim about a run nobody made.
    const a = measure(readArtifact(artifact(family([1, 2, 3]).parent, family([1, 2, 3]).lever)), 'parent', 'lever');
    const b = measure(readArtifact(artifact(family([1, 2, 9]).parent, family([1, 2, 9]).lever)), 'parent', 'lever');
    expect(() => compoundOf([a, b])).toThrow(/same questions|does not share/);
  });

  it('refuses two levers measured against parents with different names', () => {
    // Two blocks priced against two different prompts are not a pair of levers: the compound's
    // baseline would be whichever of them happened to score lower.
    const a = measure(readArtifact(artifact(family([1, 2]).parent, family([1, 2]).lever, 'a')), 'parent', 'a');
    const b = measure(readArtifact(artifact(family([1, 2]).parent, family([1, 2]).lever, 'b')), 'parent', 'b');
    expect(() => compoundOf([a, b])).not.toThrow();
    const other = measure(
      readArtifact(artifact(family([1, 2]).parent, family([1, 2]).lever, 'b', 'another')),
      'another',
      'b',
    );
    expect(() => compoundOf([a, other])).toThrow(/shares no baseline/);
  });

  it('refuses a parent whose score drifted between two runs', () => {
    // 939 and 941 are two dispatches of one prompt; 900 and 960 would be two prompts under one name.
    const a = measure(readArtifact(artifact(family([1, 2]).parent, family([1, 2]).lever, 'a')), 'parent', 'a');
    const drifted = {
      ...a,
      run: '9',
      parentCorrect: a.parentCorrect + PARENT_DRIFT_MAX + 1,
    };
    expect(() => compoundOf([a, drifted])).toThrow(/two prompts under one name/);
  });
});

describe('compoundOf', () => {
  it('takes the union of what the levers answer, not the sum of their gains', () => {
    // The ceiling is what one prompt carrying both blocks could reach if it chose, case by case,
    // whichever block's answer was right. Adding the two deltas counts the cases both levers fix
    // twice, and those are the majority: 896 of 1,020 on the real pair.
    const ids = [1, 2, 3, 4];
    const parent = ids.map((n) => ({ id: `q${String(n)}`, passed: false }));
    const rowsLever = ids.map((n) => ({ id: `q${String(n)}`, passed: n === 1 || n === 2 }));
    const valuesLever = ids.map((n) => ({ id: `q${String(n)}`, passed: n === 2 || n === 3 }));
    const reading = compoundOf([
      measure(readArtifact(artifact(parent, rowsLever, 'rows')), 'parent', 'rows'),
      measure(readArtifact(artifact(parent, valuesLever, 'values')), 'parent', 'values'),
    ]);
    expect(reading.unionCorrect).toBe(3);
    expect(reading.ceilingPp).toBe(75);
    expect(reading.additivePp).toBe(100);
    expect(reading.overlap).toBe(1);
  });

  it('prices the compound at the parent plus each block it adds', () => {
    const ids = [1, 2];
    const parent = ids.map((n) => ({ id: `q${String(n)}`, passed: true, prompt: 100, completion: 10, cached: 60 }));
    const fat = ids.map((n) => ({ id: `q${String(n)}`, passed: true, prompt: 200, completion: 10, cached: 60 }));
    const reading = compoundOf([
      measure(readArtifact(artifact(parent, fat, 'rows')), 'parent', 'rows'),
      measure(readArtifact(artifact(parent, fat, 'values')), 'parent', 'values'),
    ]);
    // Parent bills 50 a case; each block adds 100; two blocks make 250.
    expect(reading.parentBill).toBe(50);
    expect(reading.compoundBill).toBe(250);
    expect(reading.multiple).toBe(5);
    expect(requiredPpFor(5)).toBe(20);
  });

  it('charges the tariff on the whole bill, not on the prompt', () => {
    // The reading that closed the value block compared +2.02pp against a tariff applied to +74.9%
    // of the *prompt*. On the bill the same block is +31.9%, and the difference is the verdict.
    const reading = compoundOf([
      measure(readArtifact(artifact(family([1, 2]).parent, family([1, 2]).lever, 'v')), 'parent', 'v'),
    ]);
    expect(reading.multiple).toBe(1);
    expect(requiredPpFor(reading.multiple)).toBe(1);
  });
});

describe('verdictOf', () => {
  it('lets a compound whose ceiling clears its tariff proceed', () => {
    const verdict = verdictOf({ ceilingPp: 3.85, requiredPp: 2.96 });
    expect(verdict.code).toBe('can-pay');
  });

  it('refuses a compound whose ceiling is under its own tariff', () => {
    // A ceiling under the price is the one form of "it might still work" this repository does not
    // accept: no arrangement of the blocks can reach the number the ledger demands.
    const verdict = verdictOf({ ceilingPp: 1.2, requiredPp: 2.96 });
    expect(verdict.code).toBe('cannot-pay');
    expect(verdict.message).toContain('ceiling');
  });

  it('refuses a compound that ties its parent at any price above one', () => {
    const verdict = verdictOf({ ceilingPp: 0, requiredPp: 1 });
    expect(verdict.code).toBe('cannot-pay');
  });
});

describe('reportLines', () => {
  it('prints the ceiling, the expectation and the price in one block', () => {
    const { parent, lever } = family([1, 2, 3, 4]);
    const reading = compoundOf([measure(readArtifact(artifact(parent, lever)), 'parent', 'lever')]);
    const lines = reportLines(reading).join('\n');
    expect(lines).toContain('ceiling');
    expect(lines).toContain('additive');
    expect(lines).toContain('bill');
  });
});

describe('selfTest', () => {
  it('holds every claim it makes', () => {
    const { problems, assertions } = selfTest();
    expect(problems).toEqual([]);
    expect(assertions).toBe(SELF_TEST_ASSERTIONS);
  });
});

/** A file written as-is, so a test can leave a field out rather than have the fixture fill it in. */
function rawArtifact(payload: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'compound-'));
  dirs.push(dir);
  const path = join(dir, 'bird-eval.json');
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

describe('what an artifact does not say', () => {
  it('names the run and the split it cannot find, rather than dropping them', () => {
    // An artifact with no provenance is one this file was handed by mistake or by an older
    // producer; `unknown` in a report is a question a reader can ask, and an omitted column is not.
    const read = readArtifact(
      rawArtifact({ cases: [{ arm: 'parent', id: 'q1', passed: true, tokens: { prompt: 10, completion: 1, cached: 0 } }] }),
    );
    expect(read.run).toBe('unknown');
    expect(read.split).toBe('unknown');
  });

  it('refuses a file with no cases key at all', () => {
    expect(() => readArtifact(rawArtifact({ model: 'deepseek-chat' }))).toThrow(/no case/);
  });
});

describe('measure, where the two arms do not meet', () => {
  it('refuses a pair with no question in common, which would be a union of two splits', () => {
    const path = rawArtifact({
      split: 'dev',
      provenance: { run: '1' },
      cases: [
        { arm: 'parent', id: 'q1', passed: true, tokens: { prompt: 10, completion: 1, cached: 0 } },
        { arm: 'lever', id: 'q2', passed: true, tokens: { prompt: 10, completion: 1, cached: 0 } },
      ],
    });
    expect(() => measure(readArtifact(path), 'parent', 'lever')).toThrow(/no question that both/);
  });

  it('leaves an unbilled case out of the bill and bills the ones that have a count', () => {
    // The failure this pins is averaging over questions that were never priced: a case with no
    // token record is not a free case, and it is not a zero in the divisor either.
    const path = artifact(family([1, 2]).parent, family([1, 2]).lever);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { cases: { id: string; tokens?: unknown }[] };
    // Question 1 loses its count on both arms; question 2 keeps a 241-token bill a case.
    const stripped = { ...parsed, cases: parsed.cases.map((row) => (row.id === 'q1' ? { ...row, tokens: undefined } : row)) };
    const reading = measure(readArtifact(rawArtifact(stripped)), 'parent', 'lever');
    expect(reading.cases).toBe(2);
    expect(reading.parentBill).toBe(241);
    expect(reading.leverBill).toBe(241);
  });

  it('refuses a pair with no token count at all, rather than reporting a free compound', () => {
    const path = rawArtifact({
      cases: [
        { arm: 'parent', id: 'q1', passed: true },
        { arm: 'lever', id: 'q1', passed: false },
      ],
    });
    expect(() => measure(readArtifact(path), 'parent', 'lever')).toThrow(/no token count on both/);
  });
});

describe('compoundOf, at the edges of its own arithmetic', () => {
  it('refuses a compound of nothing, rather than printing a ceiling of zero', () => {
    expect(() => compoundOf([])).toThrow(/a compound of nothing/);
  });

  it('refuses a ceiling over a split nothing was asked on', () => {
    // An empty `asked` set is how an artifact that names arms but no questions reaches this file;
    // the union over it is empty for a reason that has nothing to do with the blocks.
    const base = {
      path: 'a',
      run: '1',
      parent: 'p',
      cases: 0,
      asked: new Set<string>(),
      parentCorrect: 0,
      leverCorrect: 0,
      parentBill: 200,
      leverBill: 260,
      parentRight: new Set<string>(),
      leverRight: new Set<string>(),
    };
    expect(() => compoundOf([{ ...base, lever: 'x' }, { ...base, lever: 'y' }])).toThrow(/answered nothing correctly/);
  });
});

/**
 * The comparison that closed this round's experiment.
 *
 * A ceiling measured against its own parent answers "is this lever worth running". It does not
 * answer "is the result worth having", and the difference cost nothing to check: the compound's
 * union of 1,020 was exactly the score `macsql-bird-os` already holds on the same 1,532 questions,
 * which makes the best case a tie at 1.594x the bill.
 */
describe('the frontier, when the caller names one', () => {
  const ids = [1, 2, 3, 4];
  const parent = ids.map((n) => ({ id: `q${String(n)}`, passed: n === 1 }));
  const lever = ids.map((n) => ({ id: `q${String(n)}`, passed: n === 1 || n === 2 }));

  it('reads the score an arm already holds, with the run it came from', () => {
    const path = artifact(parent, lever, 'lever', 'parent');
    const reading = measure(readArtifact(path), 'parent', 'lever');
    const frontier = frontierOf(path, 'parent', reading.cases);
    expect(frontier).toEqual({ arm: 'parent', correct: 1, cases: 4, run: '1' });
  });

  it('refuses an arm the artifact never ran, and a split of another size', () => {
    const path = artifact(parent, lever);
    expect(() => frontierOf(path, 'absent', 4)).toThrow(/never ran/);
    // Two scores over two corpora are not two scores over one, and this comparison is the only
    // thing standing between a ceiling and a purchase.
    expect(() => frontierOf(path, 'parent', 5)).toThrow(/not on one split/);
  });

  it('refuses a ceiling that only ties the score already on the table', () => {
    const reading = compoundOf([measure(readArtifact(artifact(parent, lever)), 'parent', 'lever')]);
    // The lever answers two of four; the parent answers one, so the ceiling is two and a frontier at
    // two is a tie.
    expect(reading.unionCorrect).toBe(2);
    const verdict = verdictOf({
      ...reading,
      frontier: { arm: 'shipped', correct: 2, cases: 4, run: '9' },
      unionCorrect: reading.unionCorrect,
    });
    expect(verdict.code).toBe('cannot-pay');
    expect(verdict.message).toContain('shipped');
    expect(verdict.message).toContain('not a purchase');
  });

  it('lets a ceiling above the frontier through, and prints the headroom', () => {
    const reading = compoundOf([measure(readArtifact(artifact(parent, lever)), 'parent', 'lever')]);
    const withFrontier = { ...reading, frontier: { arm: 'shipped', correct: 0, cases: 4, run: '9' }, headroomPp: 25 };
    expect(verdictOf(withFrontier).code).toBe('can-pay');
    expect(reportLines(withFrontier).join('\n')).toContain('frontier shipped 0 / 4');
    expect(reportLines(withFrontier).join('\n')).toContain('+25.00pp of headroom');
  });

  it('refuses a frontier given without its artifact, and the reverse', () => {
    expect(() => resolveSettings(['a.json', '--frontier', 'b.json'])).toThrow(/go together/);
    expect(() => resolveSettings(['a.json', '--frontier-arm', 'x'])).toThrow(/go together/);
    // A flag with no value at all is a different refusal from a flag with no partner: the first is a
    // typo in the command line and the second is an incomplete comparison.
    expect(() => resolveSettings(['a.json', '--frontier'])).toThrow(/needs an artifact path/);
    expect(() => resolveSettings(['a.json', '--frontier', 'b.json', '--frontier-arm'])).toThrow(/needs an arm name/);
    const both = resolveSettings(['a.json', '--frontier', 'b.json', '--frontier-arm', 'x']);
    expect([both.frontierArtifact, both.frontierArm]).toEqual(['b.json', 'x']);
  });

  it('writes the headroom with the sign it has, including when nobody computed one', () => {
    // A field that is read with `?? 0` and printed without a sign prints `-3.00pp` as `3.00pp`, and
    // the one number a reader takes from this line is the sign.
    const reading = compoundOf([measure(readArtifact(artifact(parent, lever)), 'parent', 'lever')]);
    const frontier = { arm: 'shipped', correct: 0, cases: 4, run: '9' };
    expect(reportLines({ ...reading, frontier }).join('\n')).toContain('+0.00pp of headroom');
    expect(reportLines({ ...reading, frontier, headroomPp: -3 }).join('\n')).toContain('-3.00pp of headroom');
  });

  it('withdraws the dispatch from the command line, not only from a reading', () => {
    // The exit code is what a dispatcher reads: a `can-pay` from the parent comparison alone would
    // have authorised the run this section exists to stop.
    const lines: string[] = [];
    const path = artifact(parent, lever);
    // `lever` holds the ceiling's own score, which is the tie the frontier check exists to catch.
    const code = main([path, '--parent', 'parent', '--frontier', path, '--frontier-arm', 'lever'], (line) =>
      lines.push(line),
    );
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('cannot-pay');
    expect(lines.join('\n')).toContain('frontier lever');
  });
});

describe('the command line', () => {
  it('defaults the parent to the arm the frontier is measured on, and keeps every artifact', () => {
    const settings = resolveSettings(['a.json', 'b.json']);
    expect(settings.parent).toBe('inline+evidence');
    expect(settings.artifacts).toEqual(['a.json', 'b.json']);
  });

  it('takes the parent from the flag, wherever it stands', () => {
    expect(resolveSettings(['--parent', 'p', 'a.json']).parent).toBe('p');
    expect(resolveSettings(['a.json', '--parent', 'p']).artifacts).toEqual(['a.json']);
  });

  it('refuses a flag with no value, an unknown flag, and no artifact', () => {
    expect(() => resolveSettings(['--parent'])).toThrow(/needs an arm name/);
    expect(() => resolveSettings(['--nope'])).toThrow(/unknown flag/);
    expect(() => resolveSettings(['--parent', 'p'])).toThrow(/name at least one artifact/);
  });

  it('prints the reading and exits zero when the ceiling clears its price', () => {
    const lines: string[] = [];
    // The lever answers both questions and the parent answers one, so the union is a superset of the
    // parent by one question of two: 50pp against the 1.00pp a bill at parity demands.
    const parent = [
      { id: 'q1', passed: false },
      { id: 'q2', passed: true },
    ];
    const lever = [
      { id: 'q1', passed: true },
      { id: 'q2', passed: true },
    ];
    expect(main([artifact(parent, lever), '--parent', 'parent'], (line) => lines.push(line))).toBe(0);
    expect(lines.join('\n')).toContain('can-pay');
  });

  it('exits one when the ceiling is under the price', () => {
    const lines: string[] = [];
    const parent = [{ id: 'q1', passed: true }];
    const lever = [{ id: 'q1', passed: false }];
    expect(main([artifact(parent, lever), '--parent', 'parent'], (line) => lines.push(line))).toBe(1);
    expect(lines.join('\n')).toContain('cannot-pay');
  });

  it('refuses an artifact that names more than one lever beside the parent', () => {
    // Which lever the compound is about is the one thing a caller must not have to guess.
    const path = rawArtifact({
      cases: [
        { arm: 'parent', id: 'q1', passed: true, tokens: { prompt: 10, completion: 1, cached: 0 } },
        { arm: 'a', id: 'q1', passed: true, tokens: { prompt: 10, completion: 1, cached: 0 } },
        { arm: 'b', id: 'q1', passed: true, tokens: { prompt: 10, completion: 1, cached: 0 } },
      ],
    });
    expect(() => main([path, '--parent', 'parent'], () => undefined)).toThrow(/names no single lever/);
  });

  it('runs the self-test from the flag and reports what it checked', () => {
    const lines: string[] = [];
    expect(main(['--self-test'], (line) => lines.push(line))).toBe(0);
    expect(lines.join('\n')).toContain(`${String(SELF_TEST_ASSERTIONS)} assertions`);
  });

  it('exits one and prints the failed claim when the self-test finds one', () => {
    // The failure path is exercised by a stub rather than left to a claim that must never break:
    // a self-test that has only ever passed has only ever been proved to pass.
    const lines: string[] = [];
    const broken = (): { problems: readonly string[]; assertions: number } => ({ problems: ['a ceiling was read as a gain'], assertions: 3 });
    expect(main(['--self-test'], (line) => lines.push(line), broken)).toBe(1);
    expect(lines[0]).toBe('FAILED a ceiling was read as a gain');
    expect(lines[1]).toContain('1 problems');
  });
});
