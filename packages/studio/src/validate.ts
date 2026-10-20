export type Additivity = 'additive' | 'non-additive' | 'semi-additive' | 'unknown';

export interface MdlMetric {
  readonly name: string;
  readonly expr?: string;
  readonly table?: string;
  readonly grain?: readonly string[];
  readonly additivity?: Additivity;
  readonly aliases?: readonly string[];
  readonly rationale?: string;
}

export interface MdlRelationship {
  readonly from: string;
  readonly to: string;
  readonly on: string;
}

export interface MdlModel {
  readonly name?: string;
  readonly tables?: readonly string[];
  readonly metrics: readonly MdlMetric[];
  readonly relationships?: readonly MdlRelationship[];
}

export type DiagnosticCode =
  | 'empty-model'
  | 'duplicate-metric'
  | 'alias-conflict'
  | 'invalid-name'
  | 'missing-expr'
  | 'unknown-table'
  | 'missing-grain'
  | 'missing-rationale'
  | 'additivity-inferred'
  | 'relationship-endpoint-unknown'
  | 'duplicate-relationship';

export interface Diagnostic {
  readonly severity: 'error' | 'warn';
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly path: string;
}

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

export function inferAdditivity(expr: string | undefined): Additivity {
  if (expr === undefined) return 'unknown';
  const lower = expr.toLowerCase();
  if (/\bcount\s*\(\s*distinct/.test(lower)) return 'non-additive';
  if (/\b(sum|count)\s*\(/.test(lower)) return 'additive';
  if (/\b(avg|average|min|max|median)\s*\(/.test(lower)) return 'non-additive';
  return 'unknown';
}

/**
 * Validate a semantic-layer document. The rules are deliberately about things a
 * compiler would otherwise discover at query time: duplicate metrics, alias
 * collisions, missing grain and dangling relationships.
 */
export function validateModel(model: MdlModel): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (model.metrics.length === 0) {
    diagnostics.push({ severity: 'error', code: 'empty-model', message: 'a model needs at least one metric', path: '/metrics' });
    return diagnostics;
  }

  const names = new Map<string, number>();
  const aliasOwners = new Map<string, string>();
  const tables = new Set(model.tables ?? []);

  model.metrics.forEach((metric, index) => {
    const path = `/metrics/${index}`;
    if (!IDENTIFIER.test(metric.name)) {
      diagnostics.push({
        severity: 'error',
        code: 'invalid-name',
        message: `"${metric.name}" is not a snake_case identifier`,
        path: `${path}/name`,
      });
    }
    const previous = names.get(metric.name);
    if (previous !== undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'duplicate-metric',
        message: `"${metric.name}" is already defined at /metrics/${previous}`,
        path: `${path}/name`,
      });
    } else {
      names.set(metric.name, index);
    }

    for (const alias of metric.aliases ?? []) {
      const owner = aliasOwners.get(alias);
      if (owner !== undefined && owner !== metric.name) {
        diagnostics.push({
          severity: 'error',
          code: 'alias-conflict',
          message: `alias "${alias}" is already used by "${owner}"`,
          path: `${path}/aliases`,
        });
      } else if (names.has(alias)) {
        diagnostics.push({
          severity: 'error',
          code: 'alias-conflict',
          message: `alias "${alias}" collides with metric "${alias}"`,
          path: `${path}/aliases`,
        });
      } else {
        aliasOwners.set(alias, metric.name);
      }
    }

    if (metric.expr === undefined || metric.expr.trim().length === 0) {
      diagnostics.push({ severity: 'error', code: 'missing-expr', message: 'metric has no expression', path: `${path}/expr` });
    }
    if (tables.size > 0 && metric.table !== undefined && !tables.has(metric.table)) {
      diagnostics.push({
        severity: 'error',
        code: 'unknown-table',
        message: `table "${metric.table}" is not declared`,
        path: `${path}/table`,
      });
    }
    if (metric.grain === undefined || metric.grain.length === 0) {
      diagnostics.push({ severity: 'warn', code: 'missing-grain', message: 'grain is undeclared', path: `${path}/grain` });
    }
    if (metric.rationale === undefined || metric.rationale.trim().length === 0) {
      diagnostics.push({
        severity: 'warn',
        code: 'missing-rationale',
        message: 'no rationale: reviewers cannot tell why this definition is correct',
        path: `${path}/rationale`,
      });
    }
    if (metric.additivity === undefined && metric.expr !== undefined) {
      diagnostics.push({
        severity: 'warn',
        code: 'additivity-inferred',
        message: `additivity inferred as ${inferAdditivity(metric.expr)}`,
        path: `${path}/additivity`,
      });
    }
  });

  const seenRelationships = new Set<string>();
  (model.relationships ?? []).forEach((relationship, index) => {
    const path = `/relationships/${index}`;
    for (const endpoint of [relationship.from, relationship.to]) {
      if (tables.size > 0 && !tables.has(endpoint)) {
        diagnostics.push({
          severity: 'error',
          code: 'relationship-endpoint-unknown',
          message: `relationship endpoint "${endpoint}" is not a declared table`,
          path,
        });
      }
    }
    const key = `${relationship.from}->${relationship.to}:${relationship.on}`;
    if (seenRelationships.has(key)) {
      diagnostics.push({
        severity: 'warn',
        code: 'duplicate-relationship',
        message: 'the same relationship is declared twice',
        path,
      });
    }
    seenRelationships.add(key);
  });

  return diagnostics;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}
