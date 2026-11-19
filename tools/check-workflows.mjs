#!/usr/bin/env node
/**
 * Four rules about workflow files that GitHub only tells you after a push.
 *
 * A workflow is code, and the only part of it that can be wrong without looking wrong is the
 * expression context. `BIRD_RESUME_FROM: ${{ steps.resume.outputs.path }}` reads as ordinary YAML,
 * `yaml.safe_load` accepts it, and the repository's own tests pass — because a job-level `env:`
 * block is evaluated before any step runs, so `steps` does not exist there. GitHub's answer is a
 * run with **no job, no log and no step**: the least diagnosable failure the platform offers.
 *
 * This is not actionlint and does not try to be. It checks the four things that have to be true
 * before the file can start, and nothing about shell quoting, matrix expansion or action inputs:
 *
 * 1. a job-level `env:` value may not reference `steps.` or `needs.` from outside its own job;
 * 2. `steps.<id>` must name a step id declared in the same job;
 * 3. `inputs.<name>` must name an input the `workflow_dispatch` trigger declares;
 * 4. a cache that holds a store this repository writes into must not have a constant key.
 *
 * Rule 3 is the quiet one: an input nobody declared resolves to an empty string rather than an
 * error, so the workflow runs with the feature silently off — a dispatch that resumes nothing
 * looks exactly like a dispatch that was told to resume nothing.
 *
 * Rule 4 is the expensive one, and it is why this file grew a fourth rule. `actions/cache` refuses
 * to save over a key that already exists and prints `not saving cache`, so a constant key is a store
 * that is written once and frozen at that moment while the job that restores it keeps paying for the
 * same answers. Nothing fails: the restore succeeds, the misses are counted inside the arm, and the
 * billing line is in a step that went green. A key that follows the contents changes exactly when the
 * store would, so an unchanged request is an exact hit and a changed one is a save.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

/**
 * The directories this repository writes into, where an entry is bought rather than downloaded.
 *
 * A download or a derived index is deterministic: `eval/.cache/bird/values` is a function of the
 * split it indexes, so a constant key is right there and a re-run that misses costs a rebuild. These
 * two hold answers that cost money to replace — one per chart question, one per graded figure — and
 * both stores are append-only by design, which is exactly what a constant key destroys.
 */
export const MUTABLE_STORES = ['eval/.cache/text2vis/llm-choices', 'eval/.cache/judge'];

/** Job names, in file order, with the line each one starts on. */
export function jobsOf(lines) {
  const jobs = [];
  const started = lines.findIndex((line) => line === 'jobs:');
  if (started === -1) return jobs;
  for (let index = started + 1; index < lines.length; index += 1) {
    const match = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(lines[index] ?? '');
    if (match !== null) jobs.push({ name: match[1], start: index, end: lines.length });
    else if (/^\S/.test(lines[index] ?? '') && (lines[index] ?? '').trim() !== '') jobs.at(-1).end = index;
  }
  for (let index = 0; index < jobs.length - 1; index += 1) jobs[index].end = Math.min(jobs[index].end, jobs[index + 1].start);
  return jobs;
}

/** The value lines of the job-level `env:` block, which ends at the next four-space key. */
export function jobEnv(lines, job) {
  const out = [];
  for (let index = job.start; index < job.end; index += 1) {
    if (!/^ {4}env:\s*$/.test(lines[index] ?? '')) continue;
    for (let inner = index + 1; inner < job.end; inner += 1) {
      const line = lines[inner] ?? '';
      if (/^ {4}\S/.test(line)) break;
      out.push({ line: inner + 1, text: line });
    }
  }
  return out;
}

/** Every `id:` declared under this job's `steps:`. */
export function stepIds(lines, job) {
  const ids = new Set();
  for (let index = job.start; index < job.end; index += 1) {
    // Both spellings: `- id: x` on its own line and `id: x` under a `- name:`.
    const match = /^\s*(?:-\s*)?id:\s*([A-Za-z][\w-]*)\s*$/.exec(lines[index] ?? '');
    if (match !== null) ids.add(match[1]);
  }
  return ids;
}

/** Names referenced as `<prefix>.NAME.` anywhere in a slice of text. */
export function referenced(lines, job, prefix) {
  const found = new Map();
  for (let index = job.start; index < job.end; index += 1) {
    // No trailing dot: `steps.x.outputs` has one, `inputs.x` is followed by a space, and a
    // pattern built for the first shape silently reads none of the second.
    const pattern = new RegExp(`\\b${prefix}\\.([A-Za-z][\\w-]*)`, 'g');
    for (const match of (lines[index] ?? '').matchAll(pattern)) found.set(match[1], index + 1);
  }
  return found;
}

/** Inputs the `workflow_dispatch` trigger declares. */
export function dispatchInputs(lines) {
  const declared = new Set();
  const trigger = lines.findIndex((line) => /^ {2}workflow_dispatch:\s*$/.test(line));
  if (trigger === -1) return declared;
  const inputs = lines.findIndex((line, index) => index > trigger && /^ {4}inputs:\s*$/.test(line));
  if (inputs === -1) return declared;
  for (let index = inputs + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^ {4}\S/.test(line)) break;
    const match = /^ {6}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (match !== null) declared.add(match[1]);
  }
  return declared;
}

/** Every caching step in the file: the paths it caches and the key it names. */
export function cacheSteps(lines) {
  const steps = [];
  for (let index = 0; index < lines.length; index += 1) {
    // A step begins at `- `, and `uses:` may be on that line or on a later one — reading only the
    // first spelling finds the steps that happen to be written one way and misses the rest.
    const opening = /^(\s*)-\s/.exec(lines[index] ?? '');
    if (opening === null) continue;
    const indent = (opening[1] ?? '').length;
    let end = lines.length;
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const line = lines[inner] ?? '';
      if (line.trim() === '') continue;
      const depth = (/^(\s*)/.exec(line)?.[1] ?? '').length;
      if (depth < indent || (depth === indent && /^\s*-\s/.test(line))) {
        end = inner;
        break;
      }
    }
    const block = lines.slice(index, end);
    if (!block.some((line) => /^\s*uses:\s*actions\/cache(\/|@|\s|$)/.test(line))) continue;
    const paths = [];
    let key;
    for (let inner = index; inner < end; inner += 1) {
      const line = lines[inner] ?? '';
      const declared = /^\s*path:\s*(.*)$/.exec(line);
      if (declared !== null) {
        const value = (declared[1] ?? '').trim();
        if (value === '' || value === '|' || value === '>') {
          // A block scalar: every deeper line is a path, and reading only the first one is how a
          // single-path check passes on a step that caches two directories.
          const depth = (/^(\s*)/.exec(line)?.[1] ?? '').length;
          for (let sub = inner + 1; sub < end; sub += 1) {
            const entry = lines[sub] ?? '';
            if (entry.trim() === '') continue;
            if ((/^(\s*)/.exec(entry)?.[1] ?? '').length <= depth) break;
            paths.push(entry.trim());
          }
        } else paths.push(value);
      }
      const named = /^\s*key:\s*(.+)$/.exec(line);
      if (named !== null && key === undefined) key = (named[1] ?? '').trim();
    }
    steps.push({ line: index + 1, paths, key });
  }
  return steps;
}

/** Whether a cached path is, contains, or sits inside a store this repository writes into. */
export function holdsStore(path) {
  // A glob names files inside a directory rather than the directory, so `eval/.cache/text2vis/*.csv`
  // does not cache `eval/.cache/text2vis/llm-choices` — and must not be reported as if it did.
  if (path.includes('*')) return false;
  const trimmed = path.replace(/\/+$/, '');
  return MUTABLE_STORES.some((store) => trimmed === store || trimmed.startsWith(`${store}/`) || store.startsWith(`${trimmed}/`));
}

/** Every problem this checker can see in one workflow file. */
export function check(yaml, file) {
  const lines = yaml.split('\n');
  const issues = [];
  const inputs = dispatchInputs(lines);
  const hasDispatch = lines.some((line) => /^ {2}workflow_dispatch:/.test(line));
  for (const step of cacheSteps(lines)) {
    const held = step.paths.find(holdsStore);
    if (held === undefined) continue;
    // Rule 4: a key that cannot change is a cache that is saved once and then never again, because
    // GitHub refuses to overwrite an existing key. The store keeps growing on the runner while the
    // archive in CI stays frozen, and every dispatch after the first pays for the same answers.
    if (!/hashFiles\(/.test(step.key ?? '')) {
      issues.push({
        file,
        line: step.line,
        rule: 'constant-key-for-mutable-store',
        message: `the cache of ${held} holds answers this repository buys, and its key "${step.key ?? '(none)'}" cannot change when they do, so GitHub will save it once and refuse every later save`,
      });
    }
  }
  for (const job of jobsOf(lines)) {
    // Rule 1: a job env block cannot see `steps` — the context exists only once a step runs.
    for (const entry of jobEnv(lines, job)) {
      if (/\$\{\{[^}]*\bsteps\./.test(entry.text)) {
        issues.push({
          file,
          line: entry.line,
          rule: 'job-env-sees-steps',
          message: `job "${job.name}" sets a job-level env from a step output; GitHub rejects the whole file, and the run it creates has no job and no log`,
        });
      }
    }
    const ids = stepIds(lines, job);
    for (const [name, line] of referenced(lines, job, 'steps')) {
      if (!ids.has(name)) {
        issues.push({
          file,
          line,
          rule: 'undeclared-step',
          message: `job "${job.name}" reads steps.${name} but no step in it declares that id`,
        });
      }
    }
    for (const [name, line] of referenced(lines, job, 'inputs')) {
      if (!inputs.has(name)) {
        issues.push({
          file,
          line,
          rule: 'undeclared-input',
          message: `job "${job.name}" reads inputs.${name} but workflow_dispatch declares no such input${hasDispatch ? '' : ' (the file has no workflow_dispatch trigger)'}`,
        });
      }
    }
  }
  return issues;
}

function selfTest() {
  const issues = [];
  const ok = [
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      known:',
    '        description: a declared input',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: produce',
    '        id: produce',
    '        run: echo hi',
    '      - name: consume',
    '        run: echo ${{ steps.produce.outputs.value }} ${{ inputs.known }}',
  ].join('\n');
  if (check(ok, 'ok.yml').length !== 0) issues.push('a clean workflow was reported');

  const jobEnvSeesSteps = ok.replace(
    '    steps:',
    '    env:\n      DERIVED: ${{ steps.produce.outputs.value }}\n    steps:',
  );
  if (!check(jobEnvSeesSteps, 'a.yml').some((issue) => issue.rule === 'job-env-sees-steps')) {
    issues.push('a job-level env reading a step output was not reported');
  }

  const undeclaredStep = ok.replace('${{ steps.produce.outputs.value }}', '${{ steps.product.outputs.value }}');
  if (!check(undeclaredStep, 'b.yml').some((issue) => issue.rule === 'undeclared-step')) {
    issues.push('a misspelled step id was not reported');
  }

  const undeclaredInput = ok.replace('${{ inputs.known }}', '${{ inputs.unknown }}');
  if (!check(undeclaredInput, 'c.yml').some((issue) => issue.rule === 'undeclared-input')) {
    issues.push('an undeclared input was not reported');
  }

  // A file with no `workflow_dispatch` cannot declare inputs at all, and saying so is the whole
  // difference between "the input is missing" and "this workflow is not dispatchable".
  const noDispatch = ok.replace('on:\n  workflow_dispatch:\n    inputs:\n      known:\n        description: a declared input\n', 'on: push\n');
  const found = check(noDispatch, 'd.yml').find((issue) => issue.rule === 'undeclared-input');
  if (found === undefined || !found.message.includes('no workflow_dispatch trigger')) {
    issues.push('an input read by a workflow with no dispatch trigger was not named as such');
  }

  // Rule 4, in both directions. A store this repository buys answers into, under a key that cannot
  // change, is the defect run 44435717857 paid ¥1.2522 for — and the check has to see it whether the
  // step names the store or the directory above it.
  const withCache = (path, key) =>
    ok.replace(
      '      - name: consume',
      `      - name: keep\n        uses: actions/cache@v4\n        with:\n          path: ${path}\n          key: ${key}\n      - name: consume`,
    );
  const constantStore = withCache('eval/.cache/text2vis/llm-choices', 'answers-v1');
  if (!check(constantStore, 'e.yml').some((issue) => issue.rule === 'constant-key-for-mutable-store')) {
    issues.push('a constant key on the answer store was not reported');
  }
  const parentStore = withCache('eval/.cache/text2vis', 'corpus-v1');
  if (!check(parentStore, 'f.yml').some((issue) => issue.rule === 'constant-key-for-mutable-store')) {
    issues.push('a cache of the directory above the answer store was not reported');
  }
  const derivedKey = withCache('eval/.cache/text2vis/llm-choices', "${{ hashFiles('eval/text2vis/llm.ts') }}");
  if (check(derivedKey, 'g.yml').length !== 0) issues.push('a key derived from the code was reported');
  // And the rule must not fire on a download: a public split's bytes do not change, so a constant key
  // there is right, and a checker that refuses it is a checker someone disables.
  const download = withCache('eval/.cache/bird/train', 'bird-train-v1');
  if (check(download, 'h.yml').length !== 0) issues.push('a constant key on an immutable download was reported');

  for (const issue of issues) console.error(`self-test: ${issue}`);
  console.log(`check-workflows: ${String(9 - issues.length)}/9 self-checks passed`);
  return issues.length === 0 ? 0 : 1;
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const dir = join(ROOT, '.github', 'workflows');
  const files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
  const issues = files.flatMap((name) => check(readFileSync(join(dir, name), 'utf8'), name));
  for (const issue of issues) console.error(`${issue.file}:${String(issue.line)}: ${issue.rule}: ${issue.message}`);
  console.log(
    issues.length === 0
      ? `check-workflows: ${String(files.length)} workflow(s), no expression context or reference is out of scope`
      : `check-workflows: ${String(issues.length)} problem(s) in ${String(files.length)} workflow(s)`,
  );
  return issues.length === 0 ? 0 : 1;
}

// Only when run as a program: a test that imports `check` should not also lint the repository
// and print its result.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = main();
}
