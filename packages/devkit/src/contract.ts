import type { Runner } from '@agentix-e/nl2charts-core';
import { hashRows } from '@agentix-e/nl2charts-core';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';

export interface ContractExpectation {
  readonly columns?: readonly string[];
  readonly rowCount?: number;
  readonly rows?: readonly Readonly<Record<string, unknown>>[];
  readonly hash?: string;
}

export interface ContractCase {
  readonly name: string;
  readonly sql: string;
  readonly expect: ContractExpectation;
}

export interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
  readonly actualHash?: string;
}

function compare(caseDef: ContractCase, actual: { columns: readonly string[]; rows: readonly Readonly<Record<string, unknown>>[] }): string | undefined {
  const expectation = caseDef.expect;
  if (expectation.columns !== undefined && expectation.columns.join('|') !== actual.columns.join('|')) {
    return `columns: expected ${expectation.columns.join('|')}, got ${actual.columns.join('|')}`;
  }
  if (expectation.rowCount !== undefined && expectation.rowCount !== actual.rows.length) {
    return `rowCount: expected ${expectation.rowCount}, got ${actual.rows.length}`;
  }
  const actualHash = hashRows(actual.rows);
  if (expectation.hash !== undefined && expectation.hash !== actualHash) {
    return `hash: expected ${expectation.hash}, got ${actualHash}`;
  }
  if (expectation.rows !== undefined && hashRows(expectation.rows) !== actualHash) {
    return 'rows: value mismatch';
  }
  return undefined;
}

export async function runContractSuite(
  runner: Runner,
  cases: readonly ContractCase[],
): Promise<{ results: CaseResult[]; passed: number; failed: number }> {
  const results: CaseResult[] = [];
  for (const caseDef of cases) {
    try {
      const result = await runner.sql(caseDef.sql);
      const detail = compare(caseDef, { columns: result.columns, rows: result.rows });
      results.push(
        detail === undefined
          ? { name: caseDef.name, ok: true, actualHash: hashRows(result.rows) }
          : { name: caseDef.name, ok: false, detail, actualHash: hashRows(result.rows) },
      );
    } catch (error) {
      const message = isNl2ChartsError(error) ? `${error.code}: ${error.message}` : String(error);
      results.push({ name: caseDef.name, ok: false, detail: message });
    }
  }
  const passed = results.filter((result) => result.ok).length;
  return { results, passed, failed: results.length - passed };
}

/** Capture the current output of a query as a golden case. */
export async function recordCase(runner: Runner, name: string, sql: string): Promise<ContractCase> {
  const result = await runner.sql(sql);
  return {
    name,
    sql,
    expect: { columns: result.columns, rowCount: result.rowCount, hash: hashRows(result.rows) },
  };
}

export function formatReport(results: readonly CaseResult[]): string {
  return results
    .map((result) => `${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.detail ? ` — ${result.detail}` : ''}`)
    .join('\n');
}
