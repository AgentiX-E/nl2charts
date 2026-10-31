/**
 * Client for `eval/bird/oracle.py`.
 *
 * One long-lived Python process executes every statement, so connections stay
 * warm and the whole run pays one interpreter start instead of thousands. The
 * protocol is JSON lines in both directions; requests may be in flight
 * concurrently and are matched back by id.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface OracleResult {
  readonly ok: boolean;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly error?: string;
  /** SQLite's own error name (`SQLITE_ERROR`, `SQLITE_MISUSE`, …), when it reported one. */
  readonly errorName?: string;
  readonly errorCode?: number;
  readonly ms: number;
}

interface Pending {
  readonly resolve: (result: OracleResult) => void;
  readonly reject: (error: Error) => void;
}

export interface Oracle {
  /** Where the SQLite files live, so a caller can stat the file it is reading. */
  readonly databaseRoot: string;
  run(db: string, sql: string): Promise<OracleResult>;
  close(): Promise<void>;
}

export function createOracle(script: string, databaseRoot: string): Oracle {
  const child: ChildProcessWithoutNullStreams = spawn('python3', [script, databaseRoot], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<string, Pending>();
  let nextId = 0;
  let closed = false;
  let stderr = '';

  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (line.trim().length === 0) return;
    const payload = JSON.parse(line) as OracleResult & { id: string };
    const entry = pending.get(payload.id);
    if (entry === undefined) return;
    pending.delete(payload.id);
    entry.resolve({
      ok: payload.ok,
      columns: payload.columns ?? [],
      rows: payload.rows ?? [],
      ms: payload.ms ?? 0,
      ...(payload.error === undefined ? {} : { error: payload.error }),
      // `oracle.py` names the failure and its code, and `run.ts` turns the name into a
      // repair hint. Both fields were declared here and dropped on the floor, so the hint
      // was always `undefined` and the branch that builds it never fired.
      ...(payload.errorName === undefined || payload.errorName === null ? {} : { errorName: payload.errorName }),
      ...(payload.errorCode === undefined || payload.errorCode === null ? {} : { errorCode: payload.errorCode }),
    });
  });
  child.on('exit', (code) => {
    closed = true;
    const reason = new Error(`oracle exited with code ${code}: ${stderr.trim().slice(0, 400)}`);
    for (const entry of pending.values()) entry.reject(reason);
    pending.clear();
  });

  return {
    databaseRoot,
    run(db, sql) {
      if (closed) return Promise.reject(new Error(`oracle is closed: ${stderr.trim().slice(0, 200)}`));
      const id = String(nextId);
      nextId += 1;
      return new Promise<OracleResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, db, sql })}\n`);
      });
    },
    async close() {
      if (closed) return;
      child.stdin.end();
      await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    },
  };
}
