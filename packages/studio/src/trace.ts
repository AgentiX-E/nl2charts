/**
 * Trace sealing and replay.
 *
 * A trace is the story of one query: which stage ran, for how long, and what came
 * out. It is also the artefact people cite when they argue about a number, so it
 * has to be checkable rather than trusted — each event is hashed together with the
 * hash of the event before it, and replay refuses a chain that does not reach its
 * head.
 *
 * Studio depends on no other package (the layering gate enforces it), so every
 * input here is plain JSON: what the runner emits is what this module reads.
 */

export type TraceStatus = 'ok' | 'error';

export interface TraceEvent {
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly status?: TraceStatus;
  readonly attrs?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface SealedEvent extends TraceEvent {
  /** Hash of the previous event, or `genesis` for the first one. */
  readonly prev: string;
  readonly hash: string;
}

export interface SealedTrace {
  readonly events: readonly SealedEvent[];
  /** Hash of the last event; an empty trace hashes nothing and says so. */
  readonly head: string;
}

export type VerifyVerdict =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly brokenAt?: number; readonly reason: 'hash' | 'head' | 'link' };

/**
 * JSON with object keys sorted, recursively. Two events that differ only in key
 * order are the same event, and a hash that disagrees with that is a hash of the
 * writer's mood rather than of the data.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, inner]) => inner !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
}

/** FNV-1a over the canonical form; short, stable, and not a cryptographic claim. */
function digest(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

function payload(event: TraceEvent): string {
  // `prev` and `hash` are the chain, not the event; hashing them would make the
  // second pass disagree with the first.
  const body = {
    name: event.name,
    startMs: event.startMs,
    endMs: event.endMs,
    status: event.status ?? 'ok',
    attrs: event.attrs ?? {},
  };
  return canonicalJson(body);
}

export function hashEvent(previous: string, event: TraceEvent): string {
  return digest(`${previous}\u0000${payload(event)}`);
}

export function sealTrace(events: readonly TraceEvent[]): SealedTrace {
  const sealed: SealedEvent[] = [];
  let previous = 'genesis';
  for (const event of events) {
    const hash = hashEvent(previous, event);
    sealed.push({ ...event, prev: previous, hash });
    previous = hash;
  }
  return { events: sealed, head: previous };
}

export function verifyTrace(trace: SealedTrace): VerifyVerdict {
  let previous = 'genesis';
  for (let index = 0; index < trace.events.length; index += 1) {
    const event = trace.events[index] as SealedEvent;
    if (event.prev !== previous) return { ok: false, brokenAt: index, reason: 'link' };
    if (hashEvent(previous, event) !== event.hash) return { ok: false, brokenAt: index, reason: 'hash' };
    previous = event.hash;
  }
  return previous === trace.head ? { ok: true, count: trace.events.length } : { ok: false, reason: 'head' };
}

export interface ReplayStage {
  readonly name: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly status: TraceStatus;
}

export interface Replay {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly stages: readonly ReplayStage[];
  readonly slowest?: ReplayStage;
  readonly errors: readonly string[];
}

/**
 * Re-derive the timeline from the trace. No clock is read: the same sealed trace
 * replays to the same summary, which is what makes it evidence.
 */
export function replayTrace(trace: SealedTrace): Replay {
  const verdict = verifyTrace(trace);
  if (!verdict.ok) {
    return { ok: false, durationMs: 0, stages: [], errors: [`trace does not verify: ${verdict.reason}`] };
  }
  const stages: ReplayStage[] = trace.events.map((event) => ({
    name: event.name,
    startMs: event.startMs,
    durationMs: Math.max(0, event.endMs - event.startMs),
    status: event.status ?? 'ok',
  }));
  const durationMs = stages.reduce((longest, stage) => Math.max(longest, stage.startMs + stage.durationMs), 0);
  const slowest = stages.reduce<ReplayStage | undefined>(
    (winner, stage) => (winner === undefined || stage.durationMs > winner.durationMs ? stage : winner),
    undefined,
  );
  const errors = trace.events
    .filter((event) => (event.status ?? 'ok') === 'error')
    .map((event) => {
      const detail = event.attrs?.['nl2charts.error'];
      return typeof detail === 'string' ? `${event.name}: ${detail}` : `${event.name}: failed`;
    });
  return { ok: true, durationMs, stages, ...(slowest === undefined ? {} : { slowest }), errors };
}

export interface Issue {
  readonly severity: 'error' | 'warn';
  readonly code: string;
  readonly message: string;
}

export interface IssueList {
  readonly items: readonly Issue[];
  readonly counts: { readonly error: number; readonly warn: number };
  readonly byCode: Readonly<Record<string, number>>;
  /** True when at least one issue stops the model from being usable. */
  readonly blocking: boolean;
}

/**
 * A stable reading of a model's diagnostics: errors first, then warnings, each
 * group in the order they arrived. Two runs over the same diagnostics produce the
 * same list, which a view can render without re-sorting.
 */
export function buildIssueList(issues: readonly Issue[]): IssueList {
  const items = [
    ...issues.filter((issue) => issue.severity === 'error'),
    ...issues.filter((issue) => issue.severity === 'warn'),
  ];
  const byCode: Record<string, number> = {};
  for (const issue of items) byCode[issue.code] = (byCode[issue.code] ?? 0) + 1;
  return {
    items,
    counts: {
      error: items.filter((issue) => issue.severity === 'error').length,
      warn: items.filter((issue) => issue.severity === 'warn').length,
    },
    byCode,
    blocking: items.some((issue) => issue.severity === 'error'),
  };
}
