export type Runtime = 'browser' | 'node' | 'edge' | 'serverless';

export interface Capabilities {
  readonly runtime: Runtime;
  readonly engines: readonly string[];
  readonly llm: boolean;
  readonly remote: boolean;
}

export interface QueryNeeds {
  readonly engine?: string;
  readonly needsLlm?: boolean;
}

export type RouteDecision =
  | { readonly route: 'local'; readonly reason: string }
  | { readonly route: 'remote'; readonly reason: string }
  | { readonly route: 'reject'; readonly reason: string };

export function createCapabilities(input: {
  runtime: Runtime;
  engines: readonly string[];
  llm?: boolean;
  remote?: boolean;
}): Capabilities {
  return {
    runtime: input.runtime,
    engines: [...input.engines],
    llm: input.llm ?? false,
    remote: input.remote ?? false,
  };
}

/**
 * Decide where a request runs. A request that cannot be satisfied locally is
 * forwarded only when a remote executor exists; otherwise it is refused with a
 * reason instead of failing later inside the engine.
 */
export function negotiate(capabilities: Capabilities, needs: QueryNeeds = {}): RouteDecision {
  const missing: string[] = [];
  if (needs.engine !== undefined && !capabilities.engines.includes(needs.engine)) {
    missing.push(`engine:${needs.engine}`);
  }
  if (needs.needsLlm === true && !capabilities.llm) missing.push('llm');

  if (missing.length === 0) return { route: 'local', reason: 'satisfied-locally' };
  if (capabilities.remote) return { route: 'remote', reason: `missing:${missing.join(',')}` };
  return { route: 'reject', reason: `missing:${missing.join(',')}` };
}
