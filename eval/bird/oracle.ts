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
  /** Wall clock of the statement, rounded down to a whole millisecond: the timeout unit. */
  readonly ms: number;
  /**
   * The same clock at microsecond resolution, and the reason an efficiency ratio can exist at all:
   * most statements on BIRD finish inside a millisecond, so two `ms` readings of 0 describe a ratio
   * of 0/0. Optional because a peer that predates it answers with `ms` alone.
   */
  readonly us?: number;
  /**
   * True when the peer sent no `us`, so the value in `us` above is `ms * 1000` rather than a clock.
   *
   * The two are not interchangeable: a millisecond-coarse reading makes τ = 1 for every pair that
   * fits inside one millisecond, which pays the reward table's top band to every system equally.
   * The field is recorded so a caller can refuse the ratio instead of publishing it.
   */
  readonly usFromMilliseconds?: boolean;
}

interface Pending {
  readonly resolve: (result: OracleResult) => void;
  readonly reject: (error: Error) => void;
}

export interface Oracle {
  /** Where the SQLite files live, so a caller can stat the file it is reading. */
  readonly databaseRoot: string;
  /**
   * Execute one statement against one database.
   *
   * `db` is the corpus's own id — BIRD's `superhero`, Spider's `concert_singer` — and resolves to
   * `root/<db>/<db>.sqlite`. `path`, when given, names the file relative to the root instead, which
   * is what WikiSQL needs: its corpus is one file holding every table, and the layout is a property
   * of the corpus rather than a parameter of the engine.
   */
  run(db: string, sql: string, path?: string): Promise<OracleResult>;
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
      us: payload.us ?? (payload.ms ?? 0) * 1000,
      ...(payload.us === undefined ? { usFromMilliseconds: true } : {}),
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
    run(db, sql, path) {
      if (closed) return Promise.reject(new Error(`oracle is closed: ${stderr.trim().slice(0, 200)}`));
      const id = String(nextId);
      nextId += 1;
      return new Promise<OracleResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, db, sql, ...(path === undefined ? {} : { path }) })}\n`);
      });
    },
    async close() {
      if (closed) return;
      child.stdin.end();
      await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    },
  };
}
