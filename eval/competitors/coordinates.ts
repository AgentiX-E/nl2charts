/**
 * The five coordinates a comparison has to hold, and what breaks when one does not.
 *
 * A published leaderboard number and a number from this harness share at most one coordinate,
 * and `docs/benchmarks.md` says so in a table. The table is a statement about other people's
 * runs. This module is the same table turned into a check, so that the first run that *can* be
 * compared is not also the first run that is compared by eye.
 *
 * The coordinates are: the question set and its split, the model and the host that served it,
 * the prompt templates, the executor, and the judge. Each one is a way for a model difference
 * to wear the clothes of a method difference, which is why a violation is not a warning: a run
 * that fails one of these produces no accuracy from this tool at all. `predictions.ts` still
 * reports how much of the question set the competitor answered, because that is a fact about
 * its output rather than a claim about its method.
 */
import { createHash } from 'node:crypto';

/** The judge every published number from this repository is measured with. */
export const JUDGE = 'judgeOfficial';

/** The executor every published number from this repository is measured with. */
export const EXECUTOR = 'eval/bird/oracle.py';

/**
 * The only value the prompt coordinate may take on a competitor's run.
 *
 * `ours:<arm>` is a legitimate value for a run of our own pipeline and is deliberately not
 * accepted here: the whole point of the run is that the templates are theirs.
 */
export const COMPETITOR_PROMPT = 'competitor';

/** What a competitor's run declares about itself, written by the workflow beside its output. */
export interface RunCoordinates {
  readonly competitor: string;
  readonly repo: string;
  /** The 40-character sha that was actually checked out, not the branch it came from. */
  readonly commit: string;
  readonly split: string;
  readonly questionIds: readonly number[];
  readonly model: string;
  /** Scheme and host of the endpoint that served the calls. Never carries a key. */
  readonly endpoint: string;
  readonly prompt: string;
  readonly executor: string;
  readonly judge: string;
}

/** What this repository's own run declares, and what the competitor is measured against. */
export interface ReferenceCoordinates {
  readonly arm: string;
  readonly split: string;
  readonly questionIds: readonly number[];
  readonly model: string;
  readonly endpoint: string;
}

/**
 * A hash of the question set, order-independent.
 *
 * The count alone is not enough: two 25-question samples of the same split have the same count
 * and different content, and the difference is exactly the sampling error a comparison is
 * supposed to exclude. Sorting first means the same set hashed from a shuffled file agrees.
 */
export function questionSetHash(ids: readonly number[]): string {
  const unique = [...new Set(ids)].sort((left, right) => left - right);
  return createHash('sha256').update(unique.join(',')).digest('hex').slice(0, 16);
}

/** A commit is pinned when it is a full sha. A branch, a tag or a short sha is not a version. */
export function isPinnedCommit(commit: string): boolean {
  return /^[0-9a-f]{40}$/.test(commit);
}

/** The host an endpoint names, lowercased, with the scheme and any path removed. */
export function endpointHost(endpoint: string): string {
  const withoutScheme = endpoint.replace(/^[a-z+]+:\/\//i, '');
  return withoutScheme.split('/')[0]!.toLowerCase();
}

interface CoordinateCheck {
  readonly coordinate: string;
  /** What the table in `docs/benchmarks.md` says this coordinate is for. */
  readonly breaks: string;
  readonly mismatch: (run: RunCoordinates, reference: ReferenceCoordinates) => string | undefined;
}

const countLine = (ids: readonly number[]): string =>
  `${String(new Set(ids).size)} questions (hash ${questionSetHash(ids)})`;

/**
 * One entry per coordinate, in the order the table lists them.
 *
 * Data rather than a chain of `if`s so that a coordinate cannot be added to the table in the
 * documentation without being added here, and so that the tests can name a coordinate.
 */
export const COORDINATE_CHECKS: readonly CoordinateCheck[] = [
  {
    coordinate: 'commit',
    breaks: 'a competitor that moves under a number makes the number unreproducible',
    mismatch: (run) =>
      isPinnedCommit(run.commit)
        ? undefined
        : `${run.competitor}: commit "${run.commit}" is not a 40-character sha`,
  },
  {
    coordinate: 'question set',
    breaks: 'a sample that is easier for one pipeline',
    mismatch: (run, reference) => {
      if (run.split !== reference.split) {
        return `split "${run.split}" against "${reference.split}"`;
      }
      const mine = questionSetHash(run.questionIds);
      const theirs = questionSetHash(reference.questionIds);
      if (mine === theirs) return undefined;
      return `${countLine(run.questionIds)} against ${countLine(reference.questionIds)}`;
    },
  },
  {
    coordinate: 'model',
    breaks: 'a stronger backbone, or a different host, read as a better method',
    mismatch: (run, reference) => {
      const model =
        run.model === reference.model ? undefined : `model "${run.model}" against "${reference.model}"`;
      const host = endpointHost(run.endpoint);
      const expected = endpointHost(reference.endpoint);
      const endpoint = host === expected ? undefined : `endpoint ${host} against ${expected}`;
      const parts = [model, endpoint].filter((part): part is string => part !== undefined);
      return parts.length === 0 ? undefined : parts.join(', and ');
    },
  },
  {
    coordinate: 'prompt',
    breaks: 'two levers changed and one attributed',
    mismatch: (run) =>
      run.prompt === COMPETITOR_PROMPT
        ? undefined
        : `prompt "${run.prompt}": a competitor's number has to come from the competitor's templates`,
  },
  {
    coordinate: 'executor',
    breaks: 'dialect differences read as errors',
    mismatch: (run) =>
      run.executor === EXECUTOR ? undefined : `executor "${run.executor}" against "${EXECUTOR}"`,
  },
  {
    coordinate: 'judge',
    breaks: 'two judges, two scores, one table',
    mismatch: (run) => (run.judge === JUDGE ? undefined : `judge "${run.judge}" against "${JUDGE}"`),
  },
];

/**
 * Every coordinate that does not hold, each naming both values and the cost of the mismatch.
 *
 * Returns lines rather than throwing, because the caller prints them: a run that is not
 * comparable is a result, and the artifact it leaves behind should say which coordinate failed
 * rather than that something did.
 */
export function coordinateViolations(
  run: RunCoordinates,
  reference: ReferenceCoordinates,
): readonly string[] {
  const out: string[] = [];
  for (const check of COORDINATE_CHECKS) {
    const mismatch = check.mismatch(run, reference);
    if (mismatch !== undefined) out.push(`${check.coordinate}: ${mismatch} — ${check.breaks}`);
  }
  return out;
}

/**
 * The run, if it may be compared. Throws with every violation rather than the first, because a
 * workflow that fixes one coordinate per push is a workflow that never finishes.
 */
export function assertComparable(run: RunCoordinates, reference: ReferenceCoordinates): RunCoordinates {
  const violations = coordinateViolations(run, reference);
  if (violations.length > 0) {
    throw new Error(`not comparable against arm ${reference.arm}:\n  ${violations.join('\n  ')}`);
  }
  return run;
}

/** Reads a coordinates file, refusing the shapes that would silently become defaults. */
export function parseCoordinates(text: string, source: string): RunCoordinates {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} is not a coordinates object`);
  }
  const raw = parsed as Record<string, unknown>;
  const str = (key: string): string => {
    const value = raw[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${source} is missing the ${key} coordinate`);
    }
    return value;
  };
  const ids = raw.questionIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error(`${source} declares no question set, so it measured nothing`);
  }
  return {
    competitor: str('competitor'),
    repo: str('repo'),
    commit: str('commit'),
    split: str('split'),
    questionIds: ids.map((id) => Number(id)),
    model: str('model'),
    endpoint: str('endpoint'),
    prompt: str('prompt'),
    executor: str('executor'),
    judge: str('judge'),
  };
}

/** The coordinates a competitor run should declare, for the workflow to write out. */
export function describeRun(run: RunCoordinates): readonly string[] {
  return [
    `${run.competitor} @ ${run.commit.slice(0, 12)} (${run.repo})`,
    `  question set: ${run.split}, ${countLine(run.questionIds)}`,
    `  model: ${run.model} at ${endpointHost(run.endpoint)}`,
    `  prompt: ${run.prompt}, executor: ${run.executor}, judge: ${run.judge}`,
  ];
}
