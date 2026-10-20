import type { PlanNode } from './plan.js';

/**
 * Graph-level optimization. Every rewrite here must preserve rows; the
 * equivalence is checked by comparing row-set hashes, not SQL text.
 */
export function optimizePlan(node: PlanNode): PlanNode {
  const reads = new Map<string, PlanNode>();

  const rewrite = (current: PlanNode): PlanNode => {
    switch (current.kind) {
      case 'read': {
        const signature = `${current.table}:${JSON.stringify(current.predicates)}`;
        const existing = reads.get(signature);
        if (existing) return existing;
        reads.set(signature, current);
        return current;
      }
      case 'join':
        return {
          ...current,
          left: rewrite(current.left),
          right: rewrite(current.right),
        };
      case 'aggregate':
        return { ...current, input: rewrite(current.input) };
      case 'compute':
        return { ...current, input: rewrite(current.input) };
      case 'window':
        return { ...current, input: rewrite(current.input) };
      case 'sort':
        return { ...current, input: rewrite(current.input) };
      case 'limit': {
        const input = rewrite(current.input);
        if (input.kind === 'limit') return { ...input, count: Math.min(input.count, current.count) };
        return { ...current, input };
      }
      case 'project': {
        const input = rewrite(current.input);
        if (input.kind === 'project') {
          const sources = new Map(input.columns.map((column) => [column.alias, column.source]));
          return {
            ...current,
            input: input.input,
            columns: current.columns.map((column) => ({ alias: column.alias, source: sources.get(column.source) as string })),
          };
        }
        const identity =
          input.outputs.length === current.columns.length &&
          current.columns.every((column) => column.alias === column.source) &&
          current.columns.every((column, index) => input.outputs[index] === column.source);
        return identity ? input : { ...current, input };
      }
    }
  };

  return rewrite(node);
}
