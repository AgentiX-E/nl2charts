/**
 * Checking a competitor checkout against its pin, before any model call is spent on it.
 *
 * A comparison is reproducible only if the thing that produced it is: a clone of `main` is a
 * clone of whatever `main` was that afternoon, and a patch written against one commit silently
 * stops applying against the next. Both failures are cheap to detect and invisible afterwards —
 * the run still finishes, still writes predictions, and still produces a number.
 *
 * So the probe runs first and answers four questions in an artifact: is the checkout the pinned
 * sha, are the files the pin names present, does the adapter patch still apply, and what does
 * the dependency file ask for. A probe that fails is a fact about the pin; a run without a probe
 * is a number with no version attached.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isPinnedCommit } from './coordinates.js';

export interface Pin {
  readonly repo: string;
  readonly commit: string;
  readonly committedAt?: string;
  readonly license?: string;
  readonly entrypoint: string;
  readonly requirements: string;
  readonly patch?: string;
  readonly modelHook?: string;
  readonly config?: string;
  readonly probe?: readonly string[];
  readonly predictions?: string;
  readonly notes?: readonly string[];
}

export interface FileProbe {
  readonly path: string;
  readonly present: boolean;
}

export interface ProbeReport {
  readonly competitor: string;
  readonly repo: string;
  readonly commit: string;
  readonly head: string;
  readonly pinned: boolean;
  readonly files: readonly FileProbe[];
  readonly patch?: { readonly path: string; readonly applies: boolean; readonly error: string };
  readonly requirementLines?: number;
  readonly problems: readonly string[];
}

export function readPins(path: string): Record<string, Pin> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a map of pins`);
  }
  return parsed as Record<string, Pin>;
}

const gitHead = (tree: string): string =>
  execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

/**
 * Whether the adapter patch applies to this checkout.
 *
 * `--check` is the whole test: it applies the patch in memory and refuses if any hunk is off,
 * which is exactly the condition that would otherwise surface as a half-patched tree after the
 * run has already started.
 */
function patchState(tree: string, patch: string): { applies: boolean; error: string } {
  if (!existsSync(patch)) return { applies: false, error: `${patch} is not in this repository` };
  try {
    execFileSync('git', ['-C', tree, 'apply', '--check', patch], { encoding: 'utf8', stdio: 'pipe' });
    return { applies: true, error: '' };
  } catch (error) {
    return { applies: false, error: failureDetail(error) };
  }
}

/**
 * What a failed `git apply` said, in one line.
 *
 * `execFileSync` puts git's own diagnostic on `stderr` and its command line in `message`, and
 * neither is guaranteed: a patch that is not a patch and a checkout that is not a checkout fail
 * in different places. All three shapes are reduced to one non-empty line, because a failure
 * message that can be empty is a failure that reads as success in a log.
 */
export function failureDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | undefined)?.stderr;
  const chosen =
    typeof stderr === 'string' && stderr.trim().length > 0
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return chosen.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Probes one checkout. `tree` is the clone the workflow made; `root` is where patch paths are
 * relative to, because a pin names its patch inside this repository rather than theirs.
 */
export function probeTree(pinsFile: string, tree: string, name: string, root = process.cwd()): ProbeReport {
  const pins = readPins(pinsFile);
  const pin = pins[name];
  if (pin === undefined) {
    throw new Error(`${pinsFile} has no pin named ${name}; it holds ${Object.keys(pins).join(', ')}`);
  }
  const problems: string[] = [];
  const head = gitHead(tree);
  const pinned = head === pin.commit;
  if (!isPinnedCommit(pin.commit)) problems.push(`pin ${pin.commit} is not a full sha`);
  if (!pinned) problems.push(`checkout is ${head}, pin says ${pin.commit}`);

  const named = [
    pin.entrypoint,
    pin.requirements,
    ...(pin.modelHook === undefined ? [] : [pin.modelHook]),
    ...(pin.config === undefined ? [] : [pin.config]),
    ...(pin.probe ?? []),
  ];
  const files = named.map((path) => ({ path, present: existsSync(join(tree, path)) }));
  for (const file of files) if (!file.present) problems.push(`${file.path} is not in the checkout`);

  const patch =
    pin.patch === undefined
      ? undefined
      : {
          path: pin.patch,
          ...(() => {
            const location = isAbsolute(pin.patch) ? pin.patch : join(root, pin.patch);
            return patchState(tree, location);
          })(),
        };
  if (patch !== undefined && !patch.applies) {
    problems.push(`the adapter patch does not apply: ${patch.error}`);
  }

  const requirements = existsSync(join(tree, pin.requirements))
    ? readFileSync(join(tree, pin.requirements), 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0 && !line.trim().startsWith('#')).length
    : undefined;
  if (requirements === undefined) problems.push(`cannot read ${pin.requirements}, so the install is unpriced`);

  return {
    competitor: name,
    repo: pin.repo,
    commit: pin.commit,
    head,
    pinned,
    files,
    ...(patch === undefined ? {} : { patch }),
    ...(requirements === undefined ? {} : { requirementLines: requirements }),
    problems,
  };
}

export function probeLines(report: ProbeReport): readonly string[] {
  const lines = [
    `${report.competitor} @ ${report.head.slice(0, 12)} (pinned: ${report.pinned ? 'yes' : 'NO'}) — ${report.repo}`,
    `  files: ${report.files.filter((file) => file.present).length}/${report.files.length} present`,
  ];
  if (report.patch !== undefined) {
    lines.push(`  adapter patch: ${report.patch.applies ? 'applies' : `does not apply (${report.patch.error})`}`);
  }
  if (report.requirementLines !== undefined) lines.push(`  requirements: ${String(report.requirementLines)} pinned lines`);
  for (const problem of report.problems) lines.push(`  PROBLEM  ${problem}`);
  return lines;
}

export function writeProbeArtifact(path: string, report: ProbeReport): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

interface ProbeSettings {
  readonly pins: string;
  readonly tree: string;
  readonly name: string;
  readonly out: string;
}

function resolveProbeSettings(argv: readonly string[], root: string): ProbeSettings {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    if (at === -1) return undefined;
    const found = argv[at + 1];
    if (found === undefined || found.startsWith('--')) throw new Error(`${name} needs a value`);
    return found;
  };
  const tree = value('--tree');
  const name = value('--name');
  if (tree === undefined || name === undefined) {
    throw new Error('usage: probe.ts --name <competitor> --tree <checkout> [--pins eval/competitors/pins.json] [--out <file>]');
  }
  return {
    pins: value('--pins') ?? join(root, 'eval/competitors/pins.json'),
    tree,
    name,
    out: value('--out') ?? join(root, 'eval/out/competitors', `${name}-probe.json`),
  };
}

export function main(argv: readonly string[] = process.argv.slice(2), root = process.cwd()): number {
  const settings = resolveProbeSettings(argv, root);
  const report = probeTree(settings.pins, settings.tree, settings.name, root);
  for (const line of probeLines(report)) console.log(line);
  console.log(`\nwrote ${writeProbeArtifact(settings.out, report)}`);
  return report.problems.length === 0 ? 0 : 1;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
