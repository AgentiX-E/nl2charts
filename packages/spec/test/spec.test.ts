import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION,
  ChartIRSchema,
  ERROR_CODES,
  Nl2ChartsError,
  SERIES_TYPES,
  chartIrJsonSchema,
  isNl2ChartsError,
  parseChartIR,
  safeParseChartIR,
  toNl2ChartsError,
} from '../src/index.js';
import type { ChartIR } from '../src/index.js';

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const FIELDS = ['region', 'month', 'revenue', 'orders', 'channel', 'margin'];

function makeIr(random: () => number, index: number): ChartIR {
  const field = (): { field: string; type: 'quantitative' | 'nominal' | 'ordinal' | 'temporal' } => ({
    field: FIELDS[Math.floor(random() * FIELDS.length)] ?? 'region',
    type: (['quantitative', 'nominal', 'ordinal', 'temporal'] as const)[Math.floor(random() * 4)] ?? 'nominal',
  });
  const rowCount = 1 + Math.floor(random() * 5);
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    rows.push({
      region: `R${Math.floor(random() * 4)}`,
      month: `2026-0${1 + Math.floor(random() * 9)}`,
      revenue: Math.round(random() * 10_000) / 100,
      orders: Math.floor(random() * 500),
      channel: random() > 0.5 ? 'web' : 'store',
      margin: random() - 0.5,
    });
  }
  const ir: ChartIR = {
    version: CONTRACT_VERSION,
    mark: SERIES_TYPES[index % SERIES_TYPES.length] ?? 'bar',
    encoding: { x: field(), y: field() },
    data: rows,
  };
  if (index % 3 === 0) ir.title = `Chart ${index}`;
  if (index % 5 === 0) ir.theme = 'dark';
  if (index % 7 === 0) ir.provenance = { path: 'nl', chart: true, provider: 'replay', model: 'fixture' };
  return ir;
}

describe('chart contract', () => {
  it('exposes a closed, unique series type list', () => {
    expect(SERIES_TYPES.length).toBe(22);
    expect(new Set(SERIES_TYPES).size).toBe(SERIES_TYPES.length);
  });

  it('round-trips 100 generated documents without loss', () => {
    const random = lcg(20261020);
    for (let i = 0; i < 100; i += 1) {
      const ir = makeIr(random, i);
      const parsed = parseChartIR(ir);
      expect(parsed).toEqual(ir);
      expect(ChartIRSchema.safeParse(parsed).success).toBe(true);
    }
  });

  it('rejects unknown marks, empty field names and extra keys', () => {
    expect(safeParseChartIR({ version: '3.0', mark: 'donut', encoding: {}, data: [] }).success).toBe(false);
    expect(
      safeParseChartIR({ version: '3.0', mark: 'bar', encoding: { x: { field: '', type: 'nominal' } }, data: [] }).success,
    ).toBe(false);
    expect(
      safeParseChartIR({ version: '3.0', mark: 'bar', encoding: {}, data: [], surprise: true }).success,
    ).toBe(false);
  });

  it('rejects a contract version it does not implement', () => {
    const result = safeParseChartIR({ version: '2.0', mark: 'bar', encoding: {}, data: [] });
    expect(result.success).toBe(false);
    expect(() => parseChartIR({ version: '2.0', mark: 'bar', encoding: {}, data: [] })).toThrow();
  });

  it('accepts the documented 50k row ceiling and rejects one more', () => {
    const row = { a: 1 };
    expect(ChartIRSchema.safeParse({ version: '3.0', mark: 'bar', encoding: {}, data: Array(50_000).fill(row) }).success).toBe(
      true,
    );
    expect(
      ChartIRSchema.safeParse({ version: '3.0', mark: 'bar', encoding: {}, data: Array(50_001).fill(row) }).success,
    ).toBe(false);
  });

  it('publishes a JSON Schema generated from the runtime validator', () => {
    const schema = chartIrJsonSchema();
    expect(schema.$id).toBe('https://agentix-e.github.io/nl2charts/schema/chart-ir-3.0.json');
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(schema);
    const random = lcg(7);
    for (let i = 0; i < 20; i += 1) {
      expect(validate(makeIr(random, i)), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(validate({ version: '3.0', mark: 'radar' })).toBe(false);
  });
});

describe('error surface', () => {
  it('carries code, details and a JSON form', () => {
    const error = new Nl2ChartsError('NL2C_E_GUARD_REJECTED', 'nope', { details: { token: 'DROP' } });
    expect(error.code).toBe('NL2C_E_GUARD_REJECTED');
    expect(error.details).toEqual({ token: 'DROP' });
    expect(error.toJSON()).toEqual({
      name: 'Nl2ChartsError',
      code: 'NL2C_E_GUARD_REJECTED',
      message: 'nope',
      details: { token: 'DROP' },
    });
  });

  it('defaults details and records a cause', () => {
    const cause = new Error('underlying');
    const error = new Nl2ChartsError('NL2C_E_ENGINE_FAILED', 'boom', { cause });
    expect(error.details).toEqual({});
    expect(error.cause).toBe(cause);
    expect(toNl2ChartsError('NL2C_E_TIMEOUT', 'late').details).toEqual({});
    expect(toNl2ChartsError('NL2C_E_TIMEOUT', 'late', undefined, { afterMs: 3 }).details).toEqual({ afterMs: 3 });
  });

  it('recognises its own brand and rejects a plain Error', () => {
    expect(isNl2ChartsError(new Nl2ChartsError('NL2C_E_INVALID_INPUT', 'x'))).toBe(true);
    expect(isNl2ChartsError(new Error('x'))).toBe(false);
    expect(isNl2ChartsError(null)).toBe(false);
    expect(isNl2ChartsError('NL2C_E_INVALID_INPUT')).toBe(false);
  });

  it('recognises a second copy of the library by symbol, not by prototype', () => {
    // Emulates a duplicate install: same global symbol, different class identity.
    const foreign = { [Symbol.for('@agentix-e/nl2charts/error')]: true, code: 'NL2C_E_INVALID_INPUT' };
    expect(isNl2ChartsError(foreign)).toBe(true);
  });

  it('keeps the error code list closed and unique', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(ERROR_CODES.every((code) => code.startsWith('NL2C_E_'))).toBe(true);
  });
});
