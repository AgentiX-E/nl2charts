#!/usr/bin/env node
/**
 * Seven rules about workflow files that GitHub only tells you after a push.
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
 * 4. a cache that holds a store this repository writes into must not have a constant key;
 * 5. a cache key may not interpolate a workflow input;
 * 6. a `restore-keys: |` block may not contain a comment or a space, because a block scalar is text
 *    and prose written between the keys is sent as a key;
 * 7. no key may appear twice in one mapping block, because YAML keeps the last one and GitHub refuses
 *    the whole file — the same "no job, no log" failure as rule 1, arriving from the parser.
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

/**
 * Inputs the `workflow_dispatch` trigger declares, with the values each one may take.
 *
 * The values matter to rule 5 and the names alone cannot answer it: `scales` is a `choice` whose
 * options include `mark,label`, so a "choice inputs are safe" shortcut is wrong, and `models` is free
 * text, so a comma is always possible there. What decides is whether *any declared value* can contain
 * a comma.
 */
export function dispatchInputs(lines) {
  const declared = new Map();
  const trigger = lines.findIndex((line) => /^ {2}workflow_dispatch:\s*$/.test(line));
  if (trigger === -1) return declared;
  const inputs = lines.findIndex((line, index) => index > trigger && /^ {4}inputs:\s*$/.test(line));
  if (inputs === -1) return declared;
  for (let index = inputs + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^ {4}\S/.test(line)) break;
    const match = /^ {6}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (match === null) continue;
    const entry = { type: 'string', options: [] };
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const field = lines[inner] ?? '';
      if (field.trim() === '') continue;
      if ((/^(\s*)/.exec(field)?.[1] ?? '').length <= 6) break;
      const typed = /^\s+type:\s*(\S+)\s*$/.exec(field);
      if (typed !== null) entry.type = typed[1];
      const inline = /^\s+options:\s*\[(.*)\]\s*$/.exec(field);
      if (inline !== null) entry.options.push(...(inline[1] ?? '').split(',').map((option) => option.trim().replace(/^['"]|['"]$/g, '')).filter((option) => option !== ''));
      if (/^\s+options:\s*$/.test(field)) {
        for (let sub = inner + 1; sub < lines.length; sub += 1) {
          const option = lines[sub] ?? '';
          if (option.trim() === '') continue;
          if ((/^(\s*)/.exec(option)?.[1] ?? '').length <= 8) break;
          const listed = /^\s*-\s*(.+)$/.exec(option);
          if (listed !== null) entry.options.push((listed[1] ?? '').trim().replace(/^['"]|['"]$/g, ''));
        }
      }
    }
    declared.set(match[1], entry);
  }
  return declared;
}

/** Whether a declared input could carry a comma, which a cache key may not contain. */
export function mayContainComma(entry) {
  if (entry === undefined) return false;
  if (entry.type === 'boolean') return false;
  // No declared value list means free text, and free text is exactly where a comma comes from.
  if (entry.options.length === 0) return true;
  return entry.options.some((option) => option.includes(','));
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
    const restoreKeys = [];
    let key;
    let id;
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
      const identified = /^\s*id:\s*([A-Za-z][\w-]*)\s*$/.exec(line);
      if (identified !== null && id === undefined) id = identified[1];
      const widening = /^\s*restore-keys:\s*(.*)$/.exec(line);
      if (widening !== null) {
        const value = (widening[1] ?? '').trim();
        // `restore-keys: |` is a block scalar, and a block scalar is text: a `#` line inside it is
        // not a comment, it is a key. Run `44549009308` restored nothing because of exactly that —
        // the rationale for the last key was written among the keys, and GitHub rejected the first
        // of those lines for containing a comma.
        if (value === '' || value === '|' || value === '>') {
          const depth = (/^(\s*)/.exec(line)?.[1] ?? '').length;
          for (let sub = inner + 1; sub < end; sub += 1) {
            const entry = lines[sub] ?? '';
            if (entry.trim() === '') continue;
            if ((/^(\s*)/.exec(entry)?.[1] ?? '').length <= depth) break;
            restoreKeys.push(entry.trim());
          }
        } else restoreKeys.push(value);
      }
    }
    steps.push({ line: index + 1, paths, key, id, restoreKeys });
  }
  return steps;
}

/**
 * The key a step actually saves under, following a `cache-primary-key` indirection.
 *
 * A restore step and its save step share one key expression, and the save step names it as
 * `${{ steps.<id>.outputs.cache-primary-key }}` rather than repeating it — which is exactly right, and
 * exactly what a checker that reads key text literally gets wrong.
 */
export function effectiveKey(step, byId, depth = 0) {
  const indirect = /^\$\{\{\s*steps\.([A-Za-z][\w-]*)\.outputs\.cache-primary-key\s*\}\}$/.exec(step.key ?? '');
  if (indirect === null || depth > 3) return step.key;
  const source = byId.get(indirect[1]);
  return source === undefined ? step.key : effectiveKey(source, byId, depth + 1);
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
/**
 * Every key of one mapping block, once — rule 7, and the one that has no soft failure in it.
 *
 * A duplicate key is not a subtle mistake: YAML keeps the last one, and GitHub rejects the file with
 * `failed to parse workflow` before any job exists. That is the same *shape* of failure as rule 1 —
 * a run with no job and no log — and the file that produced it passed every other check here,
 * because the other checks read lines and a repeated key is a fact about the *shape*.
 *
 * The walk keeps a stack of mapping blocks, keyed by indentation, and opens a new block on every list
 * item: two `- name:` lines under one `steps:` are two mappings that happen to share an indent, not one
 * mapping with a repeated key. Block scalars (`run: |`) are skipped by indentation, because their
 * contents are text and a `key: value` inside one is a line of a shell script.
 */
export function duplicateKeys(lines) {
  const found = [];
  const stack = [];
  let scalarAt;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    if (scalarAt !== undefined) {
      const inside = /^\s*$/.test(text) || leadingSpaces(text) > scalarAt;
      if (inside) continue;
      scalarAt = undefined;
    }
    if (/^\s*(#|$|---)/.test(text)) continue;
    const match = /^(\s*)(-\s+)?(?:([A-Za-z_$][\w.$-]*)|"([^"]*)"|'([^']*)')\s*:(?:\s|$)/.exec(text);
    const indent = leadingSpaces(text);
    if (match === null) {
      // A list item that is a scalar, or a line that opens nothing: it neither joins nor opens a block.
      while (stack.length > 0 && stack[stack.length - 1].indent > indent) stack.pop();
      continue;
    }
    const structural = match[2] === undefined ? indent : indent + match[2].length;
    while (stack.length > 0 && stack[stack.length - 1].indent > structural) stack.pop();
    const key = match[3] ?? match[4] ?? match[5];
    let frame = stack[stack.length - 1];
    if (match[2] !== undefined || frame === undefined || frame.indent < structural) {
      frame = { indent: structural, keys: new Set() };
      stack.push(frame);
    }
    if (frame.keys.has(key)) found.push({ line: index + 1, key });
    frame.keys.add(key);
    const value = text.slice(match[0].length);
    if (/^[|>][+-]?\d*\s*(#.*)?$/.test(value)) scalarAt = indent;
  }
  return found;
}

/** How far a line is indented, in spaces. A tab is invalid YAML here and is read as one column. */
function leadingSpaces(text) {
  return /^\s*/.exec(text)[0].length;
}

export function check(yaml, file) {
  const lines = yaml.split('\n');
  const issues = [];
  const inputs = dispatchInputs(lines);
  const hasDispatch = lines.some((line) => /^ {2}workflow_dispatch:/.test(line));
  for (const step of cacheSteps(lines)) {
    const held = step.paths.find(holdsStore);
    if (held === undefined) continue;
    const byId = new Map(cacheSteps(lines).filter((entry) => entry.id !== undefined).map((entry) => [entry.id, entry]));
    const key = effectiveKey(step, byId);
    // Rule 4: a key that cannot change is a cache that is saved once and then never again, because
    // GitHub refuses to overwrite an existing key. The store keeps growing on the runner while the
    // archive in CI stays frozen, and every dispatch after the first pays for the same answers.
    if (!/hashFiles\(/.test(key ?? '')) {
      issues.push({
        file,
        line: step.line,
        rule: 'constant-key-for-mutable-store',
        message: `the cache of ${held} holds answers this repository buys, and its key "${key ?? '(none)'}" cannot change when they do, so GitHub will save it once and refuse every later save`,
      });
    }
  }
  // Rule 5, on every cache step rather than only the ones above: a cache key is validated by GitHub,
  // and an input is free text. A dispatch whose `scales` read `mark,label` produced a key containing a
  // comma, `actions/cache/restore` answered `Key Validation Error: … cannot contain commas`, and run
  // `44442360115` skipped every step after it. The failure lands at dispatch time, in the one step
  // that decides whether the run is cheap.
  for (const step of cacheSteps(lines)) {
    for (const match of (step.key ?? '').matchAll(/\$\{\{[^}]*\binputs\.([A-Za-z][\w-]*)/g)) {
      const name = match[1];
      if (!mayContainComma(inputs.get(name)) || !inputs.has(name)) continue;
      issues.push({
        file,
        line: step.line,
        rule: 'raw-input-in-cache-key',
        message: `the cache key "${step.key ?? ''}" interpolates inputs.${name}, whose declared values can contain a comma, and a comma is an invalid cache key — flatten it through a step output first`,
      });
    }
  }
  // Rule 6, on the widening list rather than the primary key: a `restore-keys: |` block is text, so
  // a rationale written between the keys *becomes* a key. This repository has already paid for that
  // lesson once (run `44549009308`: the first comment line, which names a comma, was sent as a key
  // and the restore failed before the run asked a single question).
  for (const step of cacheSteps(lines)) {
    for (const entry of step.restoreKeys) {
      const bare = entry.replace(/\$\{\{[^}]*\}\}/g, '');
      if (!/^\s*#/.test(bare) && !/[,\s]/.test(bare)) continue;
      issues.push({
        file,
        line: step.line,
        rule: 'comment-or-space-in-restore-keys',
        message: `restore key "${entry}" reads as a key rather than as prose: inside a block scalar a '#' line is not a comment and a space or comma is an invalid key`,
      });
    }
  }
  for (const repeat of duplicateKeys(lines)) {
    issues.push({
      file,
      line: repeat.line,
      rule: 'duplicate-key',
      message: `"${repeat.key}" is declared twice in one block; YAML keeps the last one and GitHub refuses the file with "failed to parse workflow", so the run it would create has no job and no log`,
    });
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

  // And a save step names its key as the restore step's output rather than repeating the expression:
  // one key, written once, and the checker has to follow it — in both directions.
  const pair = (restoreKey) =>
    ok.replace(
      '      - name: consume',
      `      - name: restore\n        id: kept\n        uses: actions/cache/restore@v4\n        with:\n          path: eval/.cache/judge\n          key: ${restoreKey}\n      - name: save\n        uses: actions/cache/save@v4\n        with:\n          path: eval/.cache/judge\n          key: \${{ steps.kept.outputs.cache-primary-key }}\n      - name: consume`,
    );
  if (check(pair("${{ hashFiles('eval/text2vis/judge.ts') }}"), 'i.yml').length !== 0) {
    issues.push('a save step naming its restore step\u2019s key was reported');
  }
  if (!check(pair('judge-v1'), 'j.yml').some((issue) => issue.rule === 'constant-key-for-mutable-store')) {
    issues.push('a save step inheriting a constant key was not reported');
  }

  // Rule 5: the same key, twice, differing only in whether the input was flattened first — over a
  // workflow that declares the input, because an undeclared one is rule 3's problem and would let this
  // rule pass by never looking.
  const declaredScale = ok.replace(
    '      known:\n',
    "      known:\n        description: a string input\n      scales:\n        description: a choice whose values hold a comma\n        type: choice\n        options:\n          - 'mark,label'\n          - 'mark'\n",
  );
  const withDeclaredCache = (key) =>
    declaredScale.replace(
      '      - name: consume',
      `      - name: keep\n        uses: actions/cache@v4\n        with:\n          path: eval/.cache/text2vis/llm-choices\n          key: ${key}\n      - name: consume`,
    );
  const rawInput = withDeclaredCache("answers-${{ inputs.scales }}-${{ hashFiles('a.ts') }}");
  if (!check(rawInput, 'k.yml').some((issue) => issue.rule === 'raw-input-in-cache-key')) {
    issues.push('a cache key interpolating a raw input was not reported');
  }
  const freeText = withDeclaredCache("answers-${{ inputs.known }}-${{ hashFiles('a.ts') }}");
  if (!check(freeText, 'm.yml').some((issue) => issue.rule === 'raw-input-in-cache-key')) {
    issues.push('a cache key interpolating a free-text input was not reported');
  }
  const sluggedInput = withDeclaredCache("answers-${{ steps.slug.outputs.value }}-${{ hashFiles('a.ts') }}");
  if (check(sluggedInput, 'l.yml').some((issue) => issue.rule === 'raw-input-in-cache-key')) {
    issues.push('a cache key reading a step output was reported as a raw input');
  }

  // Rule 6: prose among the widening keys, then the same list with an expression that legitimately
  // contains spaces. The block is a scalar, so only what YAML would send as a key decides.
  const withRestore = (body) =>
    declaredScale.replace(
      '      - name: consume',
      `      - name: keep\n        uses: actions/cache@v4\n        with:\n          path: eval/.cache/text2vis/llm-choices\n          key: answers-$\{\{ hashFiles('a.ts') \}\}\n          restore-keys: |\n${body}      - name: consume`,
    );
  const proseAmongKeys = withRestore("            answers-${{ hashFiles('a.ts') }}\n            # the frozen archive, which names a comma, elsewhere\n            answers-old-\n");
  if (!check(proseAmongKeys, 'n.yml').some((issue) => issue.rule === 'comment-or-space-in-restore-keys')) {
    issues.push('a comment line inside a restore-keys block was not reported');
  }
  const keyWithExpression = withRestore("            answers-${{ steps.slug.outputs.value }}-${{ hashFiles('a.ts') }}\n            answers-old-\n");
  if (check(keyWithExpression, 'o.yml').some((issue) => issue.rule === 'comment-or-space-in-restore-keys')) {
    issues.push('a restore key containing an expression was reported as prose');
  }

  // Rule 7: the block that was actually shipped. `if-no-files-found` appears twice under one `with:`,
  // and GitHub answered the dispatch with `failed to parse workflow: (Line: 276, Col: 11):
  // 'if-no-files-found' is already defined` — after the push, and after this file had reported the
  // workflow clean, because every rule above reads lines and a repeated key is a fact about shape.
  const doubled = ok.replace(
    '      - name: consume',
    '      - name: keep\n        uses: actions/upload-artifact@v5\n        with:\n          name: a\n          path: a.json\n          retention-days: 90\n          retention-days: 90\n      - name: consume',
  );
  const repeated = check(doubled, 'p.yml').filter((issue) => issue.rule === 'duplicate-key');
  if (repeated.length !== 1 || !/retention-days/.test(repeated[0].message)) {
    issues.push('a key declared twice in one block was not reported once, by name');
  }
  // A list of mappings is a list of blocks: two `- name:` lines share an indent and repeat nothing.
  if (check(ok, 'q.yml').some((issue) => issue.rule === 'duplicate-key')) {
    issues.push('two list items sharing a key were reported as a duplicate');
  }
  // A block scalar is text. A `key: value` line inside a shell script is not a key, and the second
  // `run:` below is the only one that matters.
  const scalar = ok.replace(
    '        run: echo hi',
    '        run: |\n          echo "name: hi"\n          echo "run: there"\n        shell: bash',
  );
  if (check(scalar, 'r.yml').some((issue) => issue.rule === 'duplicate-key')) {
    issues.push('a line inside a block scalar was read as a key');
  }
  // The same key in two different blocks, at two indents, is one declaration each.
  const nested = ok
    .replace('    runs-on: ubuntu-latest', '    runs-on: ubuntu-latest\n    env:\n      name: job-level')
    .replace('        id: produce', '        id: produce\n        env:\n          name: step-level');
  if (check(nested, 's.yml').some((issue) => issue.rule === 'duplicate-key')) {
    issues.push('the same key in two nested blocks was reported as a duplicate');
  }

  for (const issue of issues) console.error(`self-test: ${issue}`);
  console.log(`check-workflows: ${String(20 - issues.length)}/20 self-checks passed`);
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
