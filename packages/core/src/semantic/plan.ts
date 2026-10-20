import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { Aggregation, DimensionDef, MetricDef, QueryContext, ResolvedPredicate, SemanticModel, SimpleMetric } from './model.js';
import { columnOf, metricOf, relationshipBetween, tableOf } from './model.js';
import { parseMetricExpr, refsOf } from './expr.js';
import type { ExprAst } from './expr.js';

export interface GroupExpr {
  readonly alias: string;
  readonly expr: string;
}

export type AggregateSpec =
  | {
      readonly type: 'agg';
      readonly alias: string;
      readonly fn: Aggregation;
      readonly column: string;
      readonly filter?: readonly ResolvedPredicate[];
    }
  | { readonly type: 'sum'; readonly alias: string; readonly source: string };

export type PlanNode =
  | { readonly kind: 'read'; readonly id: string; readonly table: string; readonly predicates: readonly ResolvedPredicate[]; readonly outputs: readonly string[] }
  | { readonly kind: 'aggregate'; readonly id: string; readonly input: PlanNode; readonly groupBy: readonly GroupExpr[]; readonly aggregates: readonly AggregateSpec[]; readonly outputs: readonly string[] }
  | { readonly kind: 'join'; readonly id: string; readonly left: PlanNode; readonly right: PlanNode; readonly pairs: readonly { readonly left: string; readonly right: string }[]; readonly joinType: 'left' | 'inner'; readonly outputs: readonly string[] }
  | { readonly kind: 'compute'; readonly id: string; readonly input: PlanNode; readonly alias: string; readonly expr: ExprAst; readonly outputs: readonly string[] }
  | { readonly kind: 'window'; readonly id: string; readonly input: PlanNode; readonly alias: string; readonly expression: string; readonly outputs: readonly string[] }
  | { readonly kind: 'project'; readonly id: string; readonly input: PlanNode; readonly columns: readonly { readonly alias: string; readonly source: string }[]; readonly outputs: readonly string[] }
  | { readonly kind: 'sort'; readonly id: string; readonly input: PlanNode; readonly keys: readonly string[]; readonly outputs: readonly string[] }
  | { readonly kind: 'limit'; readonly id: string; readonly input: PlanNode; readonly count: number; readonly outputs: readonly string[] };

export interface Plan {
  readonly root: PlanNode;
  readonly columns: readonly string[];
  readonly nodeCount: number;
}

export interface PlanQuery {
  readonly metrics: readonly string[];
  readonly dimensions?: readonly string[];
  readonly filters?: readonly { readonly column: string; readonly op: ResolvedPredicate['op']; readonly value?: ResolvedPredicate['value'] }[];
  readonly limit?: number;
}

class Builder {
  private counter = 0;

  nextId(): string {
    this.counter += 1;
    return `n${this.counter}`;
  }

  get size(): number {
    return this.counter;
  }

  read(model: SemanticModel, table: string, predicates: readonly ResolvedPredicate[]): PlanNode {
    const definition = tableOf(model, table);
    for (const predicate of predicates) {
      if (predicate.table !== table) {
        throw toNl2ChartsError('NL2C_E_CONTRACT_VIOLATION', `predicate for ${predicate.table} cannot be applied to ${table}`, undefined, {
          code: 'PREDICATE_TABLE_MISMATCH',
        });
      }
      columnOf(model, table, predicate.column);
    }
    const outputs = definition.columns.filter((column) => column.masked !== true).map((column) => column.name);
    return { kind: 'read', id: this.nextId(), table, predicates, outputs };
  }

  aggregate(input: PlanNode, groupBy: readonly GroupExpr[], aggregates: readonly AggregateSpec[]): PlanNode {
    return {
      kind: 'aggregate',
      id: this.nextId(),
      input,
      groupBy,
      aggregates,
      outputs: [...groupBy.map((group) => group.alias), ...aggregates.map((aggregate) => aggregate.alias)],
    };
  }

  join(left: PlanNode, right: PlanNode, pairs: readonly { left: string; right: string }[], joinType: 'left' | 'inner' = 'left'): PlanNode {
    const outputs = [...left.outputs, ...right.outputs.filter((column) => !left.outputs.includes(column))];
    return { kind: 'join', id: this.nextId(), left, right, pairs, joinType, outputs };
  }

  compute(input: PlanNode, alias: string, expr: ExprAst): PlanNode {
    return { kind: 'compute', id: this.nextId(), input, alias, expr, outputs: [...input.outputs, alias] };
  }

  window(input: PlanNode, alias: string, expression: string): PlanNode {
    return { kind: 'window', id: this.nextId(), input, alias, expression, outputs: [...input.outputs, alias] };
  }

  project(input: PlanNode, columns: readonly { alias: string; source: string }[]): PlanNode {
    return { kind: 'project', id: this.nextId(), input, columns, outputs: columns.map((column) => column.alias) };
  }

  sort(input: PlanNode, keys: readonly string[]): PlanNode {
    return { kind: 'sort', id: this.nextId(), input, keys, outputs: input.outputs };
  }

  limit(input: PlanNode, count: number): PlanNode {
    return { kind: 'limit', id: this.nextId(), input, count, outputs: input.outputs };
  }
}

interface Chain {
  readonly node: PlanNode;
  readonly columns: readonly string[];
}

interface Component {
  readonly metric: SimpleMetric;
  readonly alias: string;
}

function simpleOf(model: SemanticModel, name: string): SimpleMetric {
  const metric = metricOf(model, name);
  if (metric.kind !== 'simple') {
    throw toNl2ChartsError('NL2C_E_INVALID_INPUT', `metric "${name}" must be a simple metric here`, undefined, {
      code: 'METRIC_KIND_MISMATCH',
      metric: name,
      kind: metric.kind,
    });
  }
  return metric;
}

export function componentsOf(model: SemanticModel, metric: MetricDef): Component[] {
  const unique = (names: readonly string[]): Component[] => {
    const seen = new Set<string>();
    const output: Component[] = [];
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      output.push({ metric: simpleOf(model, name), alias: `__c${output.length}` });
    }
    return output;
  };
  switch (metric.kind) {
    case 'simple':
    case 'conversion':
      return [];
    case 'ratio':
      return [
        { metric: simpleOf(model, metric.numerator), alias: '__num' },
        { metric: simpleOf(model, metric.denominator), alias: '__den' },
      ];
    case 'derived': {
      let ast: ExprAst;
      try {
        ast = parseMetricExpr(metric.expr);
      } catch (error) {
        throw toNl2ChartsError('NL2C_E_INVALID_INPUT', `cannot parse metric expression "${metric.expr}"`, error, {
          code: 'BAD_EXPRESSION',
          metric: metric.name,
        });
      }
      const refs = unique(refsOf(ast));
      if (refs.length === 0) {
        throw toNl2ChartsError('NL2C_E_INVALID_INPUT', `metric expression "${metric.expr}" references no metric`, undefined, {
          code: 'NO_METRIC_REFS',
          metric: metric.name,
        });
      }
      return refs;
    }
    case 'cumulative':
      return [{ metric: simpleOf(model, metric.input), alias: '__c0' }];
  }
}

function predicatesFor(ctx: QueryContext, table: string): ResolvedPredicate[] {
  const definition = tableOf(ctx.model, table);
  const rls = (definition.rls ?? []).map((predicate) => {
    const column = predicate.column.includes('.') ? (predicate.column.split('.')[1] as string) : predicate.column;
    columnOf(ctx.model, table, column);
    return { table, column, op: predicate.op, ...(predicate.value === undefined ? {} : { value: predicate.value }) };
  });
  return [...rls, ...ctx.predicates.filter((predicate) => predicate.table === table)];
}

function aggregateFilter(
  table: string,
  predicates: readonly { column: string; op: ResolvedPredicate['op']; value?: ResolvedPredicate['value'] }[] | undefined,
): ResolvedPredicate[] | undefined {
  if (predicates === undefined) return undefined;
  return predicates.map((predicate) => {
    const column = predicate.column.includes('.') ? (predicate.column.split('.')[1] as string) : predicate.column;
    return { table, column, op: predicate.op, ...(predicate.value === undefined ? {} : { value: predicate.value }) };
  });
}

function columnGroup(alias: string, column: string): GroupExpr {
  return { alias, expr: `"${column}"` };
}

function dimensionGroup(dimension: DimensionDef, source: string): GroupExpr {
  if (dimension.kind === 'time' && dimension.grain !== undefined) {
    return { alias: dimension.name, expr: `date_trunc('${dimension.grain}', "${source}")` };
  }
  return { alias: dimension.name, expr: `"${source}"` };
}

/** Join remote dimension tables onto a per-grain node. */
function attachDimensions(
  builder: Builder,
  ctx: QueryContext,
  table: string,
  node: PlanNode,
  dimensions: readonly DimensionDef[],
): { node: PlanNode; sources: Map<string, string> } {
  const sources = new Map<string, string>();
  for (const dimension of dimensions.filter((candidate) => candidate.table === table)) {
    sources.set(dimension.name, dimension.column);
  }
  const remoteTables = [...new Set(dimensions.filter((dimension) => dimension.table !== table).map((dimension) => dimension.table))];
  for (const remote of remoteTables) {
    const relationship = relationshipBetween(ctx.model, table, remote);
    const leftKey = relationship.from === table ? relationship.on.from : relationship.on.to;
    const rightKey = relationship.from === table ? relationship.on.to : relationship.on.from;
    const right = builder.read(ctx.model, remote, predicatesFor(ctx, remote));
    node = builder.join(node, right, [{ left: leftKey, right: rightKey }], ctx.predicates.some((predicate) => predicate.table === remote) ? 'inner' : 'left');
    for (const dimension of dimensions.filter((candidate) => candidate.table === remote)) {
      sources.set(dimension.name, dimension.column);
    }
  }
  return { node, sources };
}

function chainForSimple(builder: Builder, ctx: QueryContext, metric: SimpleMetric, alias: string, dimensions: readonly DimensionDef[]): Chain {
  const table = metric.table;
  const read = builder.read(ctx.model, table, predicatesFor(ctx, table));
  const filter = aggregateFilter(table, metric.filter);
  const dimensionAliases = dimensions.map((dimension) => dimension.name);

  if (metric.additivity === 'non_additive') {
    const attached = attachDimensions(builder, ctx, table, read, dimensions);
    const aggregated = builder.aggregate(
      attached.node,
      dimensions.map((dimension) => dimensionGroup(dimension, attached.sources.get(dimension.name) as string)),
      [{ type: 'agg', alias, fn: metric.aggregation, column: metric.column, ...(filter === undefined ? {} : { filter }) }],
    );
    return { node: builder.project(aggregated, [...dimensionAliases.map((name) => ({ alias: name, source: name })), { alias, source: alias }]), columns: [...dimensionAliases, alias] };
  }

  const remote = dimensions.filter((dimension) => dimension.table !== table);
  const local = dimensions.filter((dimension) => dimension.table === table);
  const keyMap = new Map<string, string>();
  for (const dimension of remote) {
    const relationship = relationshipBetween(ctx.model, table, dimension.table);
    keyMap.set(dimension.table, relationship.from === table ? relationship.on.from : relationship.on.to);
  }
  const groupBy = [
    ...[...new Set([...metric.grain, ...keyMap.values()])].map((column) => columnGroup(column, column)),
    ...local.map((dimension) => dimensionGroup(dimension, dimension.column)),
  ];
  let node = builder.aggregate(read, groupBy, [
    { type: 'agg', alias, fn: metric.aggregation, column: metric.column, ...(filter === undefined ? {} : { filter }) },
  ]);

  const sources = new Map<string, string>(local.map((dimension) => [dimension.name, dimension.name]));
  for (const [remoteTable, key] of keyMap) {
    const relationship = relationshipBetween(ctx.model, table, remoteTable);
    const right = builder.read(ctx.model, remoteTable, predicatesFor(ctx, remoteTable));
    node = builder.join(node, right, [{
      left: relationship.from === table ? key : relationship.on.from,
      right: relationship.from === table ? relationship.on.to : key,
    }], ctx.predicates.some((predicate) => predicate.table === remoteTable) ? 'inner' : 'left');
    for (const dimension of remote.filter((candidate) => candidate.table === remoteTable)) {
      sources.set(dimension.name, dimension.column);
    }
  }

  const rolled = builder.aggregate(
    node,
    dimensions.map((dimension) => {
      return columnGroup(dimension.name, sources.get(dimension.name) as string);
    }),
    [{ type: 'sum', alias, source: alias }],
  );
  return { node: builder.project(rolled, [...dimensionAliases.map((name) => ({ alias: name, source: name })), { alias, source: alias }]), columns: [...dimensionAliases, alias] };
}

function joinChains(builder: Builder, left: Chain, right: Chain, dimensions: readonly DimensionDef[]): Chain {
  const pairs = dimensions.map((dimension) => ({ left: dimension.name, right: dimension.name }));
  const node = builder.join(left.node, right.node, pairs);
  return { node, columns: [...left.columns, ...right.columns.filter((column) => !left.columns.includes(column))] };
}

function buildMetricChain(builder: Builder, ctx: QueryContext, metric: MetricDef, dimensions: readonly DimensionDef[]): Chain {
  const dimensionNames = dimensions.map((dimension) => dimension.name);

  if (metric.kind === 'ratio') {
    const [numerator, denominator] = componentsOf(ctx.model, metric) as [Component, Component];
    const joined = joinChains(
      builder,
      chainForSimple(builder, ctx, numerator.metric, numerator.alias, dimensions),
      chainForSimple(builder, ctx, denominator.metric, denominator.alias, dimensions),
      dimensions,
    );
    const computed = builder.compute(joined.node, metric.name, {
      type: 'binary',
      op: '/',
      left: { type: 'ref', name: numerator.alias },
      right: { type: 'ref', name: denominator.alias },
    });
    return { node: builder.project(computed, [...dimensionNames.map((name) => ({ alias: name, source: name })), { alias: metric.name, source: metric.name }]), columns: [...dimensionNames, metric.name] };
  }

  if (metric.kind === 'derived') {
    const components = componentsOf(ctx.model, metric);
    const first = components[0] as Component;
    let chain = chainForSimple(builder, ctx, first.metric, first.alias, dimensions);
    for (const component of components.slice(1)) {
      chain = joinChains(builder, chain, chainForSimple(builder, ctx, component.metric, component.alias, dimensions), dimensions);
    }
    const mapping = new Map(components.map((component) => [component.metric.name, component.alias]));
    const computed = builder.compute(chain.node, metric.name, rewrite(parseMetricExpr(metric.expr), mapping));
    return { node: builder.project(computed, [...dimensionNames.map((name) => ({ alias: name, source: name })), { alias: metric.name, source: metric.name }]), columns: [...dimensionNames, metric.name] };
  }

  if (metric.kind === 'cumulative') {
    if (!dimensions.some((dimension) => dimension.name === metric.orderBy)) {
      throw toNl2ChartsError('NL2C_E_INVALID_INPUT', `cumulative metric "${metric.name}" requires dimension "${metric.orderBy}"`, undefined, {
        code: 'MISSING_WINDOW_ORDER',
        metric: metric.name,
        dimension: metric.orderBy,
      });
    }
    const component = componentsOf(ctx.model, metric)[0] as Component;
    const base = chainForSimple(builder, ctx, component.metric, component.alias, dimensions);
    const partition = dimensionNames.filter((name) => name !== metric.orderBy);
    const over = [
      partition.length > 0 ? `partition by ${partition.map((name) => `"${name}"`).join(', ')}` : '',
      `order by "${metric.orderBy}"`,
      'rows between unbounded preceding and current row',
    ].filter((part) => part.length > 0).join(' ');
    const windowed = builder.window(base.node, metric.name, `sum("${component.alias}") over (${over})`);
    return { node: builder.project(windowed, [...dimensionNames.map((name) => ({ alias: name, source: name })), { alias: metric.name, source: metric.name }]), columns: [...dimensionNames, metric.name] };
  }

  if (metric.kind === 'conversion') {
    const table = metric.table;
    const read = builder.read(ctx.model, table, predicatesFor(ctx, table));
    const attached = attachDimensions(builder, ctx, table, read, dimensions);
    const aggregated = builder.aggregate(
      attached.node,
      dimensions.map((dimension) => dimensionGroup(dimension, attached.sources.get(dimension.name) as string)),
      [
        { type: 'agg', alias: '__num', fn: 'count', column: '*', filter: aggregateFilter(table, metric.numerator) },
        { type: 'agg', alias: '__den', fn: 'count', column: '*', filter: aggregateFilter(table, metric.denominator) },
      ],
    );
    const computed = builder.compute(aggregated, metric.name, {
      type: 'binary',
      op: '/',
      left: { type: 'ref', name: '__num' },
      right: { type: 'ref', name: '__den' },
    });
    return { node: builder.project(computed, [...dimensionNames.map((name) => ({ alias: name, source: name })), { alias: metric.name, source: metric.name }]), columns: [...dimensionNames, metric.name] };
  }

  return chainForSimple(builder, ctx, metric, metric.name, dimensions);
}

function rewrite(ast: ExprAst, mapping: ReadonlyMap<string, string>): ExprAst {
  if (ast.type === 'ref') {
    return { type: 'ref', name: mapping.get(ast.name) as string };
  }
  if (ast.type === 'number') return ast;
  return { type: 'binary', op: ast.op, left: rewrite(ast.left, mapping), right: rewrite(ast.right, mapping) };
}

export function buildPlan(query: PlanQuery, ctx: QueryContext): Plan {
  const builder = new Builder();
  const dimensions = ctx.dimensions;
  const chains = ctx.metrics.map((metric) => buildMetricChain(builder, ctx, metric, dimensions));
  let chain = chains[0] as Chain;
  for (const next of chains.slice(1)) chain = joinChains(builder, chain, next, dimensions);

  const columns = [...dimensions.map((dimension) => dimension.name), ...ctx.metrics.map((metric) => metric.name)];
  const projected = builder.project(chain.node, columns.map((column) => ({ alias: column, source: column })));
  const limited = query.limit === undefined
    ? projected
    : builder.limit(builder.sort(projected, columns), query.limit);
  return { root: limited, columns, nodeCount: builder.size };
}

export { predicatesFor };
