import type { ChartIR } from '@agentix-e/nl2charts-spec';
import { distinctValues } from './profile.js';

export type Severity = 'error' | 'warn';

export interface LintIssue {
  readonly rule: string;
  readonly severity: Severity;
  readonly message: string;
}

export const LINT_RULES = [
  'empty-data',
  'missing-title',
  'missing-alt',
  'pie-slice-overflow',
  'pie-negative-value',
  'series-overflow',
  'bar-category-overflow',
  'line-x-not-temporal',
  'duplicate-encoding',
  'scatter-axis-not-quantitative',
  'measure-without-aggregate',
  'print-relies-on-color',
] as const;

export type LintRule = (typeof LINT_RULES)[number];

const asArray = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

function fieldNames(ir: ChartIR): string[] {
  return Object.values(ir.encoding).flatMap((value) => asArray(value).map((ref) => ref.field));
}

export function lint(ir: ChartIR): LintIssue[] {
  const issues: LintIssue[] = [];
  const x = asArray(ir.encoding.x)[0];
  const y = asArray(ir.encoding.y)[0];
  const theta = ir.encoding.theta ?? x;
  const allFields = fieldNames(ir);

  if (ir.data.length === 0) {
    issues.push({ rule: 'empty-data', severity: 'error', message: 'the result set is empty' });
  }
  if (ir.title === undefined || ir.title.length === 0) {
    issues.push({ rule: 'missing-title', severity: 'warn', message: 'a chart without a title cannot be cited' });
  }
  if (ir.alt === undefined || ir.alt.length === 0) {
    issues.push({ rule: 'missing-alt', severity: 'error', message: 'alt text is required before rendering' });
  }
  if (ir.mark === 'pie' || ir.mark === 'funnel') {
    const categories = theta ? distinctValues(ir, theta.field) : [];
    if (categories.length > 7) {
      issues.push({
        rule: 'pie-slice-overflow',
        severity: 'warn',
        message: `${categories.length} slices exceed the readable limit of 7`,
      });
    }
    const valueRef = y ?? ir.encoding.color;
    if (valueRef && ir.data.some((row) => typeof row[valueRef.field] === 'number' && (row[valueRef.field] as number) < 0)) {
      issues.push({ rule: 'pie-negative-value', severity: 'error', message: 'a pie cannot encode negative values' });
    }
  }
  if (ir.encoding.series !== undefined && distinctValues(ir, ir.encoding.series.field).length > 8) {
    issues.push({ rule: 'series-overflow', severity: 'warn', message: 'more than 8 series in one chart' });
  }
  if (ir.mark === 'bar' && x && distinctValues(ir, x.field).length > 30) {
    issues.push({
      rule: 'bar-category-overflow',
      severity: 'warn',
      message: 'more than 30 categories; a table is easier to read',
    });
  }
  if (ir.mark === 'line' && x !== undefined && x.type === 'nominal') {
    issues.push({ rule: 'line-x-not-temporal', severity: 'warn', message: 'a line implies an ordered x axis' });
  }
  if (new Set(allFields).size !== allFields.length) {
    issues.push({ rule: 'duplicate-encoding', severity: 'warn', message: 'the same field is encoded twice' });
  }
  if (ir.mark === 'scatter' && (x === undefined || y === undefined || x.type !== 'quantitative' || y.type !== 'quantitative')) {
    issues.push({
      rule: 'scatter-axis-not-quantitative',
      severity: 'error',
      message: 'both scatter axes must be quantitative',
    });
  }
  if (ir.mark === 'bar' && y !== undefined && y.type === 'quantitative' && y.aggregate === undefined) {
    issues.push({
      rule: 'measure-without-aggregate',
      severity: 'warn',
      message: 'an unaggregated measure usually means the aggregation was forgotten',
    });
  }
  if (ir.theme === 'print' && ir.encoding.color !== undefined && ir.encoding.series === undefined) {
    issues.push({ rule: 'print-relies-on-color', severity: 'warn', message: 'print output loses colour distinctions' });
  }

  return issues;
}

export function isRenderable(issues: readonly LintIssue[]): boolean {
  return issues.every((issue) => issue.severity !== 'error');
}
