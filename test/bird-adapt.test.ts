import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CALIBRATION,
  STRATEGY_ARMS,
  align,
  isEntry,
  main,
  reportLines,
  resolveSettings,
  score,
  shuffle,
  simulate,
  sweep,
} from '../eval/bird/adapt.js';
import type { Artifact, CaseRow } from '../eval/bird/adapt.js';

const row = (arm: string, id: string, passed: boolean): CaseRow => ({ arm, id, passed });

/** Four strategies over six questions, with `aimed-3` ahead on the tail. */
const artifact: Artifact = {
  split: 'dev',
  model: 'test-model',
  cases: [
    row('names', '0', true),
    row('metadata+evidence', '0', true),
    row('select', '0', true),
    row('select-mixed', '0', false),

    row('names', '1', false),
    row('metadata+evidence', '1', true),
    row('select', '1', true),
    row('select-mixed', '1', true),

    row('names', '2', false),
    row('metadata+evidence', '2', true),
    row('select', '2', false),
    row('select-mixed', '2', true),

    row('names', '3', false),
    row('metadata+evidence', '3', true),
    row('select', '3', false),
    row('select-mixed', '3', true),

    row('names', '4', false),
    row('metadata+evidence', '4', false),
    row('select', '4', false),
    row('select-mixed', '4', true),

    row('names', '5', false),
    row('metadata+evidence', '5', true),
    row('select', '5', true),
    row('select-mixed', '5', true),
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('aligning an artifact onto the four strategies', () => {
  it('maps each arm to one strategy and keeps the artifact order', () => {
    const cases = align(artifact);
    expect(cases.map((one) => one.id)).toEqual(['0', '1', '2', '3', '4', '5']);
    expect(cases[0]?.outcomes).toEqual({
      'single-lean': true,
      'single-full': true,
      'repeat-3': true,
      'aimed-3': false,
    });
  });

  it('drops a case one arm never answered instead of scoring it as a failure', () => {
    const partial: Artifact = {
      cases: [
        ...artifact.cases.filter((one) => !(one.id === '5' && one.arm === 'select-mixed')),
        row('names', '6', false),
      ],
    };
    const cases = align(partial);
    expect(cases.map((one) => one.id)).toEqual(['0', '1', '2', '3', '4']);
    expect(cases.some((one) => one.id === '6')).toBe(false);
  });

  it('refuses an artifact that carries fewer than two strategy arms', () => {
    expect(() => align({ cases: [row('names', '0', true)] })).toThrow(/carries 1 of the four strategy arms/);
  });

  it('names the arms it found when refusing', () => {
    const two: Artifact = {
      cases: [row('names', '0', true), row('metadata+evidence', '0', true), row('names', '1', false)],
    };
    expect(align(two)).toHaveLength(1);
  });

  it('refuses an artifact with no mapped arm at all', () => {
    expect(() => align({ cases: [row('vote', '0', true)] })).toThrow(/\(none\)/);
  });
});

describe('scoring a slice', () => {
  it('counts passes and tries per strategy', () => {
    const counts = score(align(artifact));
    expect(counts['single-lean']).toEqual({ passed: 1, total: 6 });
    expect(counts['aimed-3']).toEqual({ passed: 5, total: 6 });
  });

  it('skips a strategy a slice never saw', () => {
    const counts = score([{ id: '0', outcomes: { 'single-lean': true } }]);
    expect(Object.keys(counts)).toEqual(['single-lean']);
  });
});

describe('the cold start', () => {
  it('calibrates on the window and reports what the verdict earned afterwards', () => {
    const simulation = simulate(align(artifact), { calibrate: 3 });
    expect(simulation.calibrate).toBe(3);
    expect(simulation.cases).toBe(6);
    expect(simulation.chosen).toBe('single-full');
    expect(simulation.chosenAccuracy).toBeCloseTo(2 / 3, 6);
    expect(simulation.bestFixed).toBe('aimed-3');
    expect(simulation.bestFixedAccuracy).toBe(1);
    expect(simulation.regret).toBeCloseTo(1 / 3, 6);
    expect(simulation.oracleAccuracy).toBe(1);
    expect(simulation.headroom).toBeCloseTo(0, 6);
  });

  it('defaults to the pre-registered window', () => {
    const long: AlignedCaseList = Array.from({ length: 30 }, (_, index) => ({
      id: String(index),
      outcomes: { 'single-full': true, 'aimed-3': index % 2 === 0 },
    }));
    expect(simulate(long).calibrate).toBe(DEFAULT_CALIBRATION);
  });

  it('refuses a window that leaves nothing to measure', () => {
    expect(() => simulate(align(artifact), { calibrate: 6 })).toThrow(/leaves nothing to measure/);
  });

  it('refuses an empty case list rather than reporting a zero', () => {
    expect(() => simulate([], { calibrate: 2 })).toThrow(/no aligned cases/);
  });

  it('keeps the incumbent when the window cannot separate the arms', () => {
    const simulation = simulate(align(artifact), { calibrate: 2, incumbent: 'repeat-3' });
    expect(simulation.chosen).toBe('repeat-3');
    expect(simulation.decision.decided).toBe(true);
  });

  it('scores an incumbent the artifact never measured as zero rather than crashing', () => {
    const lean: Artifact = {
      cases: artifact.cases.filter((one) => one.arm === 'names' || one.arm === 'metadata+evidence'),
    };
    const simulation = simulate(align(lean), { calibrate: 3, incumbent: 'aimed-3' });
    expect(simulation.chosenAccuracy).toBe(0);
    expect(simulation.bestFixed).toBe('single-full');
  });

  it('passes a stricter z through to the decision', () => {
    const simulation = simulate(align(artifact), { calibrate: 4, incumbent: 'single-lean', z: 3 });
    expect(simulation.chosen).toBe('single-lean');
    expect(simulation.decision.reason.length).toBeGreaterThan(0);
  });
});

type AlignedCaseList = Parameters<typeof simulate>[0];

describe('the sweep and the table', () => {
  it('drops windows that cannot be run', () => {
    const cases = align(artifact);
    const simulations = sweep(cases, [0, 1, 2, 6, 7]);
    expect(simulations.map((one) => one.calibrate)).toEqual([1, 2]);
  });

  it('prints one row per window with fixed columns', () => {
    const lines = reportLines(sweep(align(artifact), [2, 3]), 'test-model');
    expect(lines[0]).toBe('cold start on 6 cases (test-model)');
    expect(lines[2]).toContain('| window | chosen | accuracy |');
    expect(lines.slice(4)).toHaveLength(2);
    expect(lines[4]).toContain('| 2 | `single-full` |');
  });

  it('reports an unknown model rather than an empty cell', () => {
    const lines = reportLines(sweep(align(artifact), [2]));
    expect(lines[0]).toBe('cold start on 6 cases (unknown)');
  });

  it('survives an empty sweep, which is what a window list that filtered to nothing looks like', () => {
    expect(reportLines([], 'test-model')[0]).toBe('cold start on 0 cases (test-model)');
    expect(reportLines([], 'test-model')).toHaveLength(4);
  });
});

describe('the deterministic shuffle', () => {
  it('is a permutation, not a sample', () => {
    const cases = align(artifact);
    const shuffled = shuffle(cases);
    expect(shuffled).toHaveLength(cases.length);
    expect([...shuffled].map((one) => one.id).sort()).toEqual(cases.map((one) => one.id).sort());
  });

  it('is reproducible from a seed and different across seeds', () => {
    const cases = align(artifact);
    expect(shuffle(cases, 7).map((one) => one.id)).toEqual(shuffle(cases, 7).map((one) => one.id));
    expect(shuffle(cases, 7).map((one) => one.id)).not.toEqual(shuffle(cases, 11).map((one) => one.id));
  });
});

describe('the command line', () => {
  it('resolves the defaults', () => {
    const settings = resolveSettings([], '/repo');
    expect(settings.artifact).toBe('/repo/eval/bird/artifacts/bird-eval-dev.json');
    expect(settings.windows).toEqual([12, 24, 48, 96, 192]);
    expect(settings.order).toBe('artifact');
    expect(settings.json).toBe(false);
  });

  it('reads every flag', () => {
    const settings = resolveSettings(
      ['--artifact', '/tmp/a.json', '--windows', '8,16', '--order', 'shuffled', '--json'],
      '/repo',
    );
    expect(settings).toEqual({ artifact: '/tmp/a.json', windows: [8, 16], order: 'shuffled', json: true });
  });

  it('falls back to the pre-registered window when the list parses to nothing', () => {
    expect(resolveSettings(['--windows', 'x,-1'], '/repo').windows).toEqual([DEFAULT_CALIBRATION]);
  });

  it('treats an unknown order as the artifact order', () => {
    expect(resolveSettings(['--order', 'random'], '/repo').order).toBe('artifact');
  });

  it('prints json when asked, and a table otherwise', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'adapt-'));
    const path = join(directory, 'artifact.json');
    writeFileSync(path, JSON.stringify(artifact));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await main(['--artifact', path, '--windows', '2', '--json'], directory)).toBe(0);
    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { simulations: unknown[] };
    expect(payload.simulations).toHaveLength(1);

    log.mockClear();
    const anonymous = join(directory, 'anonymous.json');
    writeFileSync(anonymous, JSON.stringify({ cases: artifact.cases }));
    expect(await main(['--artifact', anonymous, '--windows', '2,3', '--order', 'shuffled'], directory)).toBe(0);
    const printed = log.mock.calls.map((call) => String(call[0]));
    expect(printed[0]).toContain('unknown, shuffled');
    expect(printed.some((line) => line.includes('calls per question'))).toBe(true);
  });

  it('recognises its own entry point and nobody else', () => {
    expect(isEntry(undefined, 'file:///x')).toBe(false);
    expect(isEntry('/x/a.ts', 'file:///x/a.ts')).toBe(true);
    expect(isEntry('/x/b.ts', 'file:///x/a.ts')).toBe(false);
  });

  it('maps every strategy to exactly one arm, and no arm twice', () => {
    const arms = Object.values(STRATEGY_ARMS);
    expect(new Set(arms).size).toBe(arms.length);
    expect(Object.keys(STRATEGY_ARMS).sort()).toEqual(['aimed-3', 'repeat-3', 'single-full', 'single-lean']);
  });
});
