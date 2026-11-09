#!/usr/bin/env node
/**
 * Every command a document tells a reader to run, checked against the scripts that exist.
 *
 * Five paragraphs in `docs/benchmarks.md` said "reproduce it with `pnpm bench:bird:compare --pair
 * x,y`". `package.json` had no such script, and never had. Every one of those sentences was a
 * promise the repository could not keep, and nothing noticed: a command name is not a path a link
 * checker resolves and not a symbol a compiler type-checks, so it sits in prose looking exactly as
 * authoritative as one that works.
 *
 * That is the same class of defect as a hand-typed rate, and it gets the same answer — the set
 * stops being prose. A name in a document is either a key in `package.json` or a red build, and a
 * name that is almost a key gets the nearest key printed beside it, because the reader of a failed
 * build is looking for the line to change.
 *
 *   node tools/check-commands.mjs             # README.md and every Markdown file under docs/
 *   node tools/check-commands.mjs --self-test
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

/** `pnpm` subcommands that take a package or a binary, not one of this repository's scripts. */
const VERBS = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'dlx', 'exec', 'why', 'audit', 'licenses', 'outdated', 'link', 'unlink', 'init', 'import', 'store', 'prune', 'publish', 'pack', 'rebuild', 'setup', 'env']);

/**
 * Every `pnpm <name>` in a document, with the line it sits on.
 *
 * `pnpm run <name>` reports `<name>`: the verb is the caller's syntax, the script is the claim. A
 * token that starts with a dash is a flag (`--filter`, `-C`), and the argument after it belongs to
 * the flag rather than to this repository.
 */
export function references(text) {
  const found = [];
  const pattern = /pnpm\s+([@\w][\w:@./-]*)/g;
  let match = pattern.exec(text);
  while (match !== null) {
    let name = match[1];
    if (name.startsWith('-')) {
      match = pattern.exec(text);
      continue;
    }
    if (name === 'run') {
      const next = /\s+([@\w][\w:@./-]*)/.exec(text.slice(match.index + match[0].length));
      name = next === null ? '' : next[1];
    }
    if (name !== '' && !name.startsWith('-') && !VERBS.has(name)) {
      found.push({ name, line: text.slice(0, match.index).split('\n').length });
    }
    match = pattern.exec(text);
  }
  return found;
}

/** Levenshtein distance, for "did you mean" and nothing else. */
function distance(one, two) {
  const rows = Array.from({ length: one.length + 1 }, (_, index) => [index]);
  for (let column = 1; column <= two.length; column += 1) rows[0][column] = column;
  for (let row = 1; row <= one.length; row += 1) {
    for (let column = 1; column <= two.length; column += 1) {
      const cost = one[row - 1] === two[column - 1] ? 0 : 1;
      rows[row][column] = Math.min(rows[row - 1][column] + 1, rows[row][column - 1] + 1, rows[row - 1][column - 1] + cost);
    }
  }
  return rows[one.length][two.length];
}

/**
 * The closest script name worth printing, or nothing.
 *
 * A suggestion is a convenience and not a repair, so it stops at three edits: recommending
 * `bench:bird` to somebody who typed `docker` is noise dressed as help.
 */
export function nearest(name, names) {
  let best;
  let bestDistance = 4;
  for (const candidate of names) {
    const away = distance(name, candidate);
    if (away < bestDistance) {
      best = candidate;
      bestDistance = away;
    }
  }
  return best;
}

export function audit(files, scripts) {
  const problems = [];
  for (const { file, text } of files) {
    for (const { name, line } of references(text)) {
      if (Object.hasOwn(scripts, name)) continue;
      const suggestion = nearest(name, Object.keys(scripts));
      problems.push({ file, line, name, ...(suggestion === undefined ? {} : { suggestion }) });
    }
  }
  return problems;
}

/** Every Markdown file a reader is told to read, README first. */
function documents(root) {
  const files = ['README.md'];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(relative(root, path));
    }
  };
  if (statSync(join(root, 'docs')).isDirectory()) walk(join(root, 'docs'));
  return files.map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }));
}

function selfTest() {
  const scripts = { build: 'tsc', 'bench:bird': 'x', 'bench:bird:compare': 'y' };
  const problems = audit([{ file: 'A.md', text: 'ok `pnpm build`\nbad `pnpm bench:bird:comapre`\nskip `pnpm install`' }], scripts);
  const checks = [
    [problems.length === 1, 'one unknown command among three mentions'],
    [problems[0]?.line === 2, 'the line of the unknown command'],
    [problems[0]?.suggestion === 'bench:bird:compare', 'the nearest script name'],
    [audit([{ file: 'A.md', text: '`pnpm docker`' }], scripts)[0]?.suggestion === undefined, 'no suggestion for a name far from every script'],
    [references('`pnpm run build`').length === 1, 'the script out of `pnpm run`'],
  ];
  for (const [passed, what] of checks) {
    if (!passed) {
      console.log(`FAILED ${what}`);
      return 1;
    }
  }
  console.log(`check-commands: ${String(checks.length)} self-checks passed`);
  return 0;
}

export function main(argv = process.argv.slice(2), root = ROOT) {
  if (argv.includes('--self-test')) return selfTest();
  const unknown = argv.filter((item) => item !== '--check');
  if (unknown.length > 0) throw new Error(`unrecognized argument ${unknown[0]}: this tool takes --check (default) or --self-test`);
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
  const files = documents(root);
  const problems = audit(files, scripts);
  for (const problem of problems) {
    console.log(`${problem.file}:${String(problem.line)}: pnpm ${problem.name} is not a script${problem.suggestion === undefined ? '' : ` — nearest: ${problem.suggestion}`}`);
  }
  const mentions = files.reduce((sum, file) => sum + references(file.text).length, 0);
  console.log(`check-commands: ${String(mentions)} command(s) in ${String(files.length)} document(s), ${problems.length === 0 ? 'every one registered' : `${String(problems.length)} not registered`}`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = main();
}
