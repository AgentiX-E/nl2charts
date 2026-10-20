export interface SpanEvent {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly attrs: Readonly<Record<string, string | number | boolean | null>>;
  readonly status: 'ok' | 'error';
  readonly errorCode?: string;
}
