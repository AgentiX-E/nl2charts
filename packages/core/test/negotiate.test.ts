import { describe, expect, it } from 'vitest';
import { createCapabilities, negotiate } from '../src/negotiate.js';

const browser = createCapabilities({ runtime: 'browser', engines: ['duckdb-wasm'], llm: false });
const node = createCapabilities({ runtime: 'node', engines: ['duckdb-native', 'postgres'], llm: true });
const nodeRemote = createCapabilities({
  runtime: 'node',
  engines: ['duckdb-native'],
  llm: false,
  remote: true,
});

describe('runtime negotiation', () => {
  it('runs locally when nothing is missing', () => {
    expect(negotiate(node)).toEqual({ route: 'local', reason: 'satisfied-locally' });
    expect(negotiate(node, { engine: 'postgres', needsLlm: true }).route).toBe('local');
  });

  it('forwards to a remote executor when one exists', () => {
    const decision = negotiate(browser, { needsLlm: true });
    expect(decision).toEqual({ route: 'reject', reason: 'missing:llm' });
    expect(negotiate(nodeRemote, { engine: 'postgres' })).toEqual({
      route: 'remote',
      reason: 'missing:engine:postgres',
    });
  });

  it('rejects with every missing capability listed', () => {
    const decision = negotiate(browser, { engine: 'postgres', needsLlm: true });
    expect(decision.route).toBe('reject');
    if (decision.route === 'reject') expect(decision.reason).toBe('missing:engine:postgres,llm');
  });

  it('defaults remote and llm to false', () => {
    const minimal = createCapabilities({ runtime: 'edge', engines: [] });
    expect(minimal.llm).toBe(false);
    expect(minimal.remote).toBe(false);
    expect(minimal.engines).toEqual([]);
  });

  it('copies the engine list instead of aliasing caller state', () => {
    const engines = ['duckdb-wasm'];
    const caps = createCapabilities({ runtime: 'browser', engines });
    engines.push('postgres');
    expect(caps.engines).toEqual(['duckdb-wasm']);
  });
});
