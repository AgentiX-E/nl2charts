import { describe, expect, it, vi } from 'vitest';
import { inspectSql } from '@agentix-e/nl2charts-core';
import {
  ATTACKS,
  LEGAL,
  UNMEASURED,
  guardLines,
  guardProblems,
  isEntry,
  main,
  measureAttack,
  measureLegal,
  measureUnguarded,
  readCount,
  resolveGuardSettings,
  runGuard,
  tallyGuard,
} from '../eval/guard/redteam.js';
import type { GuardReading } from '../eval/guard/redteam.js';

describe('the guard against the shapes an attacker reaches for', () => {
  it('stops every attack in the corpus', async () => {
    const landed: string[] = [];
    for (const one of ATTACKS) {
      if (!(await measureAttack(one))) landed.push(`${one.id}: ${one.sql}`);
    }
    // Named, not counted: a failure that says "one attack landed" sends a reader to 29 statements.
    expect(landed).toEqual([]);
  });

  it('lets a write land when there is no gate, which is what makes the reading evidence', async () => {
    const drop = ATTACKS.find((one) => one.id === 'ddl-drop');
    expect(drop).toBeDefined();
    expect(await measureUnguarded(drop!)).toBe(false);
  });

  it('cannot observe a PRAGMA without a gate, and says so by counting it as landed', async () => {
    // A pragma leaves nothing in the canary, so the unguarded run has no effect to observe. The
    // verdict was its only containment, and a mutation that scored it as contained would report
    // the gate's absence as a pass.
    const pragma = ATTACKS.find((one) => one.id === 'priv-pragma-mode');
    expect(await measureUnguarded(pragma!)).toBe(false);
  });

  it('reaches the filesystem through a function the denylist used to miss', () => {
    // The red team found these on its first run: the function list covered DuckDB's readers and
    // neither of SQLite's file functions, on the driver the product ships by default. A read-only
    // database does not make `readfile` read-only — it reads a path, not a table.
    for (const sql of ["select readfile('/etc/passwd')", "select writefile('/tmp/x', 'y')", "select load_extension('evil')"]) {
      const verdict = inspectSql(sql);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('banned-function');
    }
  });
});

describe('the questions the gate must not refuse', () => {
  it('runs all of them and refuses none', async () => {
    for (const one of LEGAL) {
      const outcome = await measureLegal(one);
      expect([one.id, outcome.refused, outcome.executed]).toEqual([one.id, false, true]);
    }
  });
});

describe('the tally', () => {
  const attacked = (kind: GuardReading['classes'][number]['kind'], contained: boolean) => ({ kind, contained });

  it('counts containment per class and over the corpus', () => {
    const reading = tallyGuard(
      [attacked('ddl-dml', true), attacked('ddl-dml', false), attacked('obfuscation', true)],
      [{ refused: false, executed: true }, { refused: true, executed: false }],
      [attacked('ddl-dml', false), attacked('obfuscation', false)],
    );
    expect(reading.attacks).toBe(3);
    expect(reading.contained).toBe(2);
    expect(reading.asr).toBeCloseTo(1 / 3, 10);
    expect(reading.falseRejectRate).toBe(0.5);
    expect(reading.utility).toBe(0.5);
    const ddl = reading.classes.find((one) => one.kind === 'ddl-dml');
    expect([ddl?.cases, ddl?.contained, ddl?.rate]).toEqual([2, 1, 0.5]);
  });

  it('reports every class the corpus declares, including the ones with no case', () => {
    const reading = tallyGuard([attacked('ddl-dml', true)], [{ refused: false, executed: true }], []);
    const empty = reading.classes.filter((one) => one.cases === 0);
    expect(empty.map((one) => one.kind)).toEqual(['obfuscation', 'multi-statement', 'cte-side-effect', 'privileged-function']);
    expect(empty.every((one) => one.rate === 0)).toBe(true);
  });

  it('divides by nothing rather than by an empty corpus', () => {
    const reading = tallyGuard([], [], []);
    expect([reading.asr, reading.falseRejectRate, reading.utility, reading.mutation.asr]).toEqual([0, 0, 0, 0]);
    expect(reading.unmeasured).toEqual(UNMEASURED);
  });
});

describe('what the instrument refuses to publish', () => {
  const healthy: GuardReading = {
    attacks: 2,
    contained: 2,
    asr: 0,
    refused: 0,
    legal: 2,
    falseRejectRate: 0,
    utility: 1,
    classes: [
      { kind: 'ddl-dml', cases: 2, contained: 2, rate: 1 },
      { kind: 'obfuscation', cases: 0, contained: 0, rate: 0 },
    ],
    mutation: { asr: 0.5, contained: 1 },
    unmeasured: [],
  };

  it('accepts a table where nothing landed and the mutation moved', () => {
    expect(guardProblems({ ...healthy, classes: [{ kind: 'ddl-dml', cases: 2, contained: 2, rate: 1 }] })).toEqual([]);
  });

  it('fails an attack that reached the data', () => {
    const problems = guardProblems({ ...healthy, asr: 0.5, contained: 1 });
    expect(problems.join('\n')).toContain('reached the data');
  });

  it('fails a corpus with no attacks and one with no legitimate questions', () => {
    const problems = guardProblems({ ...healthy, attacks: 0, legal: 0, classes: [] });
    expect(problems.join('\n')).toContain('no attacks');
    expect(problems.join('\n')).toContain('no legitimate questions');
  });

  it('fails a class that vanished from the corpus', () => {
    const problems = guardProblems(healthy);
    expect(problems.join('\n')).toContain('obfuscation');
  });

  it('fails a mutation that did not move, because then the table is about something else', () => {
    const problems = guardProblems({ ...healthy, classes: [{ kind: 'ddl-dml', cases: 2, contained: 2, rate: 1 }], mutation: { asr: 0, contained: 2 } });
    expect(problems.join('\n')).toContain('not what these cases measure');
  });

  it('fails a legitimate question that did not run', () => {
    const problems = guardProblems({ ...healthy, classes: [{ kind: 'ddl-dml', cases: 2, contained: 2, rate: 1 }], utility: 0.5 });
    expect(problems.join('\n')).toContain('did not run');
  });
});

describe('the lines a report prints', () => {
  const reading: GuardReading = {
    attacks: 4,
    contained: 4,
    asr: 0,
    refused: 0,
    legal: 2,
    falseRejectRate: 0,
    utility: 1,
    classes: [{ kind: 'ddl-dml', cases: 4, contained: 4, rate: 1 }],
    mutation: { asr: 0.75, contained: 1 },
    unmeasured: [{ kind: 'resource-exhaustion', why: 'the driver is synchronous' }],
  };

  it('prints the table, the shares and the mutation', () => {
    const text = guardLines(reading).join('\n');
    expect(text).toContain('| ddl-dml');
    expect(text).toContain('ASR 0.0% across 4 attacks');
    expect(text).toContain('Mutation: the same corpus with no gate has ASR 75.0%');
    expect(text).toContain('Not measured: resource-exhaustion');
  });

  it('says the gate is not what stops them when the mutation does not move', () => {
    const text = guardLines({ ...reading, mutation: { asr: 0, contained: 4 } }).join('\n');
    expect(text).toContain('not what is stopping them');
  });

  it('omits the unmeasured sentence when there is nothing unmeasured', () => {
    expect(guardLines({ ...reading, unmeasured: [] }).join('\n')).not.toContain('Not measured');
  });
});

describe('the numbers the probes read', () => {
  it('takes a number, a numeric string, or nothing', () => {
    expect(readCount({ c: 3 }, 'c')).toBe(3);
    expect(readCount({ c: '4' }, 'c')).toBe(4);
    expect(readCount({ c: ' ' }, 'c')).toBeNull();
    expect(readCount({ c: 'many' }, 'c')).toBeNull();
    expect(readCount({}, 'c')).toBeNull();
    expect(readCount(undefined, 'c')).toBeNull();
    expect(readCount({ c: null }, 'c')).toBeNull();
  });
});

describe('the entry point', () => {
  it('takes --strict and refuses anything else', () => {
    expect(resolveGuardSettings([])).toEqual({ strict: false });
    expect(resolveGuardSettings(['--strict'])).toEqual({ strict: true });
    expect(() => resolveGuardSettings(['--fast'])).toThrow('usage: guard-redteam.ts');
  });

  it('exits zero and prints the table when the corpus holds', async () => {
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    try {
      expect(await main([])).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(printed.join('\n')).toContain('| class');
  });

  it('exits one under strict when the corpus does not hold, and zero when it is not strict', async () => {
    const failing = {
      reading: {
        attacks: 1,
        contained: 0,
        asr: 1,
        refused: 0,
        legal: 1,
        falseRejectRate: 0,
        utility: 1,
        classes: [{ kind: 'ddl-dml', cases: 1, contained: 0, rate: 0 }],
        mutation: { asr: 1, contained: 0 },
        unmeasured: [],
      } as GuardReading,
      problems: ['one attack reached the data'],
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await main(['--strict'], async () => failing)).toBe(1);
      expect(await main([], async () => failing)).toBe(0);
      expect(error.mock.calls.map((call) => String(call[0]))).toEqual(['one attack reached the data', 'one attack reached the data']);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('is not the entry point when it was not invoked as one', () => {
    expect(isEntry(undefined, import.meta.url)).toBe(false);
  });
});

describe('the corpus as a whole', () => {
  it('measures the shipped policy and reports no hole', async () => {
    const { reading, problems } = await runGuard();
    expect(problems).toEqual([]);
    expect(reading.attacks).toBe(ATTACKS.length);
    expect(reading.legal).toBe(LEGAL.length);
    // The mutation is the instrument's own self-test: without it the table would be a list of
    // statements the guard happens to refuse, with nothing saying refusal was the reason.
    expect(reading.mutation.asr).toBeGreaterThan(reading.asr);
  });
});
