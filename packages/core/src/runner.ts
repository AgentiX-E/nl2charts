import { Nl2ChartsError, toNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { ErrorCode, Provenance, SpanEvent } from '@agentix-e/nl2charts-spec';
import type { Engine, EngineResult } from './engine.js';
import { DEFAULT_POLICY, inspectSql, withRowLimit } from './guard.js';
import type { GuardPolicy } from './guard.js';
import { canonicalRow } from './normalize.js';
import type { CanonicalValue } from './normalize.js';

export interface RunnerConfig {
  readonly engine: Engine;
  readonly maxRows?: number;
  readonly timeoutMs?: number;
  readonly policy?: GuardPolicy;
  readonly onSpan?: (span: SpanEvent) => void;
}

export interface SqlOptions {
  readonly limit?: number;
  readonly signal?: AbortSignal;
  readonly chart?: boolean;
}

export interface SqlResult {
  readonly sql: string;
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, CanonicalValue>>[];
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly provenance: Provenance;
}

export interface Runner {
  sql(text: string, options?: SqlOptions): Promise<SqlResult>;
  stream(text: string, options?: SqlOptions): AsyncIterable<readonly Readonly<Record<string, CanonicalValue>>[]>;
  close(): Promise<void>;
  readonly capabilities: {
    readonly engine: string;
    readonly dialect: string;
    readonly streaming: boolean;
    readonly maxRows: number;
  };
}

let traceCounter = 0;

function nextTraceId(): string {
  traceCounter += 1;
  return `trace-${traceCounter.toString(16).padStart(6, '0')}`;
}

function emit(
  onSpan: RunnerConfig['onSpan'],
  event: Omit<SpanEvent, 'traceId' | 'spanId' | 'startMs' | 'endMs'> & { startMs: number },
): void {
  if (!onSpan) return;
  const span: SpanEvent = {
    ...event,
    traceId: nextTraceId(),
    spanId: `span-${event.name}`,
    endMs: Date.now(),
  };
  try {
    onSpan(span);
  } catch {
    // Observability must never take down a query.
  }
}

export function createRunner(config: RunnerConfig): Runner {
  const maxRows = config.maxRows ?? 10_000;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const policy = config.policy ?? DEFAULT_POLICY;
  const { engine } = config;

  const execute = async (text: string, options: SqlOptions = {}): Promise<SqlResult> => {
    const verdict = inspectSql(text, policy);
    if (!verdict.ok) {
      throw new Nl2ChartsError('NL2C_E_GUARD_REJECTED', `statement rejected: ${verdict.reason}`, {
        details: { reason: verdict.reason, detail: verdict.detail },
      });
    }
    const limit = Math.max(1, Math.trunc(options.limit ?? maxRows));
    const capped = withRowLimit(verdict.sql, limit + 1);
    const started = Date.now();
    const controller = new AbortController();
    const external = options.signal;
    const onExternalAbort = (): void => controller.abort(external?.reason);
    if (external) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    let rejectOnAbort: ((reason: unknown) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = reject;
    });
    const onAbort = (): void => rejectOnAbort?.(controller.signal.reason ?? new Error('aborted'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const attrs: Record<string, string | number | boolean | null> = {
      'nl2charts.engine': engine.id,
      'nl2charts.dialect': engine.dialect,
      'nl2charts.sql.length': text.length,
      'nl2charts.path': options.chart === true ? 'nl' : 'sql',
    };

    let raw: EngineResult;
    try {
      // Racing guarantees the caller regains control even when the engine
      // ignores the abort signal (native drivers often do).
      raw = await Promise.race([engine.run(capped, { signal: controller.signal }), aborted]);
    } catch (error) {
      const code: ErrorCode = controller.signal.aborted ? 'NL2C_E_TIMEOUT' : 'NL2C_E_ENGINE_FAILED';
      emit(config.onSpan, {
        name: 'execute',
        attrs: { ...attrs, 'nl2charts.aborted': controller.signal.aborted },
        status: 'error',
        errorCode: code,
        startMs: started,
      });
      throw toNl2ChartsError(code, controller.signal.aborted ? 'query aborted' : 'engine failed', error, {
        engine: engine.id,
      });
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      external?.removeEventListener('abort', onExternalAbort);
    }

    const rows = raw.rows.slice(0, limit).map((row) => canonicalRow(row));
    attrs['nl2charts.rows'] = rows.length;
    attrs['nl2charts.truncated'] = raw.rows.length > limit;
    emit(config.onSpan, { name: 'execute', attrs, status: 'ok', startMs: started });

    return {
      sql: capped,
      columns: [...raw.columns],
      rows,
      rowCount: rows.length,
      truncated: raw.rows.length > limit,
      provenance: { path: options.chart === true ? 'nl' : 'sql', chart: options.chart === true },
    };
  };

  return {
    sql: execute,
    async *stream(text, options = {}) {
      const verdict = inspectSql(text, policy);
      if (!verdict.ok) {
        throw new Nl2ChartsError('NL2C_E_GUARD_REJECTED', `statement rejected: ${verdict.reason}`, {
          details: { reason: verdict.reason, detail: verdict.detail },
        });
      }
      if (engine.stream === undefined) {
        const result = await execute(text, options);
        yield result.rows;
        return;
      }
      const limit = Math.max(1, Math.trunc(options.limit ?? maxRows));
      let emitted = 0;
      for await (const batch of engine.stream(withRowLimit(verdict.sql, limit + 1), options.signal ? { signal: options.signal } : {})) {
        const rows = batch.rows.slice(0, Math.max(0, limit - emitted)).map((row) => canonicalRow(row));
        emitted += rows.length;
        if (rows.length > 0) yield rows;
        if (emitted >= limit) return;
      }
    },
    async close() {
      await engine.close();
    },
    capabilities: {
      engine: engine.id,
      dialect: engine.dialect,
      streaming: engine.streaming,
      maxRows,
    },
  };
}
