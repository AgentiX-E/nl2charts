/**
 * The question file a competitor is given, cut by the same function that cuts ours.
 *
 * The question-set coordinate is only held if both pipelines answer the same questions, and two
 * independent samples of a split are not the same questions however carefully each was drawn. So
 * the subset is not drawn here: it is `stratifiedSample`, the function `run.ts` uses for its own
 * `BIRD_LIMIT`, applied to the same file. A competitor given this file and a run of ours with the
 * same limit are then paired by construction, and `score.ts` checks the two id sets against each
 * other anyway rather than trusting the workflow to have passed the same number twice.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadQuestions, stratifiedSample } from '../bird/data.js';
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
  const questions = loadQuestions(settings.questions);
  const selected = stratifiedSample(questions, settings.limit);
  mkdirSync(dirname(settings.out), { recursive: true });
  writeFileSync(settings.out, `${JSON.stringify(selected, null, 2)}\n`);
  const ids = selected.map((question) => question.question_id);
  return { ids, hash: questionSetHash(ids), path: settings.out };
}

export function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): number {
  const settings = resolveSubsetSettings(env, argv, root);
  const subset = writeSubset(settings);
  console.log(
    `${String(subset.ids.length)} of the ${settings.layout.split} split (hash ${subset.hash}) written to ${subset.path}`,
  );
  return 0;
}

/**
 * The entry guard, as a function that returns what to do rather than a branch at module scope.
 *
 * The shape matters for two reasons. A module-scope `if` runs once, in a context no test can enter,
 * so the line is either uncovered or covered by a subprocess whose coverage is not counted. And a
 * guard that *returns* the code leaves the module body one unconditional assignment: importing this
 * file cannot start a run, and running it cannot be forgotten.
 */
export function runIfEntry(
  argv1: string | undefined,
  moduleUrl: string,
  run: () => number,
): number | undefined {
  if (argv1 === undefined || pathToFileURL(argv1).href !== moduleUrl) return undefined;
  return run();
}

process.exitCode = runIfEntry(process.argv[1], import.meta.url, () => main());
