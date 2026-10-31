/**
 * The question file a competitor is given, cut by the same function that cuts ours.
 *
 * The question-set coordinate is only held if both pipelines answer the same questions, and two
 * independent samples of a split are not the same questions however carefully each was drawn. So
 * the subset is not drawn here: it is `stratifiedSample`, the function `run.ts` uses for its own
 * `BIRD_LIMIT`, applied to the same file. A competitor given this file and a run of ours with the
 * same limit are then paired by construction, and `score.ts` checks the two id sets against each
 * other anyway rather than trusting the workflow to have passed the same number twice.
 *
 * The same file is also the numbering a competitor answers in, which is why the reader lives here:
 * a pipeline that numbers its rows instead of naming the dataset's ids is read through this file
 * (`readIdMap`), and the tool that wrote it is the tool that knows what it contains.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runIfEntry } from '../entry.js';
import { describeQuestionSet, distinctQuestions, loadQuestions, stratifiedSample } from '../bird/data.js';
import type { QuestionSet } from '../bird/data.js';
import { parseLimit, resolveLayout } from '../bird/run.js';
import type { BirdLayout } from '../bird/run.js';
import { questionSetHash } from './coordinates.js';

export interface SubsetSettings {
  readonly questions: string;
  readonly limit: number;
  readonly out: string;
  readonly layout: BirdLayout;
}

export interface Subset {
  readonly ids: readonly number[];
  readonly hash: string;
  readonly path: string;
  /**
   * The file the subset was cut from, as rows and questions.
   *
   * Carried out of the writer because a subset is a statement about a bigger file, and the two
   * counts that make that statement meaningful — how many rows it holds and how many distinct
   * questions they name — are read here and nowhere else on this path.
   */
  readonly shape: QuestionSet;
}

export function resolveSubsetSettings(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  root: string,
): SubsetSettings {
  const at = argv.indexOf('--limit');
  if (at !== -1 && argv[at + 1] === undefined) throw new Error('--limit needs a number');
  const layout = resolveLayout(env, root);
  const raw = at === -1 ? env.BIRD_LIMIT : argv[at + 1];
  const limit = parseLimit(raw, layout.split);
  const outAt = argv.indexOf('--out');
  if (outAt !== -1 && argv[outAt + 1] === undefined) throw new Error('--out needs a path');
  return {
    questions: layout.questionsFile,
    limit,
    out:
      outAt === -1
        ? join(root, 'eval/out/competitors', `${layout.split}-subset-${String(limit)}.json`)
        : (argv[outAt + 1] as string),
    layout,
  };
}

/** Writes the subset, and returns the ids it holds so a caller can print or check them. */
export function writeSubset(settings: SubsetSettings): Subset {
  // One row per question id, because the file written here is also the numbering a position-based
  // pipeline is read through: a file that names one question twice cannot say what position 484
  // answered, and a subset of 500 rows for 498 questions would hand a competitor a question it
  // was asked twice and a reader that cannot resolve it.
  const shape = distinctQuestions(loadQuestions(settings.questions));
  const selected = stratifiedSample(shape.questions, settings.limit);
  mkdirSync(dirname(settings.out), { recursive: true });
  writeFileSync(settings.out, `${JSON.stringify(selected, null, 2)}\n`);
  const ids = selected.map((question) => question.question_id);
  return { ids, hash: questionSetHash(ids), path: settings.out, shape };
}

/** A question file read as a numbering: position → question id, in the file's own order. */
export interface IdMap {
  readonly path: string;
  readonly ids: readonly number[];
}

/**
 * Reads the numbering a competitor used, from the question file it was given.
 *
 * A pipeline that numbers its answers by row rather than by the dataset's id has not answered
 * different questions; it has used a different numbering, and saying so is the difference between
 * reading its answers and discarding them as unknown ids. What it must not be is a guess: an id
 * map deduced from a file's contents would make any dropped row silently shift every later row onto
 * the wrong question, so this reader is strict about the three shapes that cannot be a numbering —
 * not an array, an entry with no `question_id`, a repeated id — and refuses all three.
 *
 * An empty map is refused too. It resolves nothing, so passing one would turn every statement into
 * an unknown id while looking like the map had been honoured.
 */
export function readIdMap(path: string): IdMap {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${path} is not a question file: an id map is the array of questions in the order the competitor numbered them`,
    );
  }
  const ids: number[] = [];
  parsed.forEach((entry: unknown, index: number) => {
    const id =
      entry !== null && typeof entry === 'object' ? (entry as { question_id?: unknown }).question_id : undefined;
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw new Error(`${path}: entry ${String(index)} carries no question_id, so position ${String(index)} names nothing`);
    }
    ids.push(id);
  });
  if (ids.length === 0) {
    throw new Error(`${path} holds no positions, so a position-numbered statement cannot be resolved against it`);
  }
  const seen = new Set<number>();
  const repeated = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  if (repeated.length > 0) {
    throw new Error(
      `${path} repeats ${repeated.slice(0, 3).join(', ')}, so a position no longer names one question`,
    );
  }
  return { path, ids };
}

export function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): number {
  const settings = resolveSubsetSettings(env, argv, root);
  const subset = writeSubset(settings);
  // The shape of the file the subset was cut from, before the subset's own size: a sample is
  // always described relative to something, and that something used to be unstated.
  console.log(describeQuestionSet(subset.shape, `${settings.layout.split} split`));
  console.log(
    `${String(subset.ids.length)} of the ${settings.layout.split} split (hash ${subset.hash}) written to ${subset.path}`,
  );
  return 0;
}

process.exitCode = runIfEntry(process.argv[1], import.meta.url, () => main());
