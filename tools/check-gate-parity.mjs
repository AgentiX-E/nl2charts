#!/usr/bin/env node
/**
 * Does the local aggregate gate actually run what CI runs?
 *
 * `pnpm gate:all` read like the whole gate and was a third of it: no typecheck, no tests, no
 * coverage, three self-tests missing. That is how a type error reached CI on a commit whose
 * author had "run the gates" — the aggregate was a subset and nothing said so. A gate that is
 * believed to be exhaustive and is not is worse than no aggregate at all, because it replaces
 * the habit of checking.
 *
 * This compares the two lists by expanding `pnpm <script>` into the commands it runs, and fails
 * when CI runs something the aggregate does not. Install steps are exempt: they are setup, not
 * checks, and CI's frozen lockfile install is not something a working tree should redo.
 *
 * Usage: node tools/check-gate-parity.mjs [--self-test]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
/** Setup, not a check. Anything else CI runs must be in the aggregate. */
const EXEMPT = [/^pnpm install\b/];

/**
 * Split a shell chain and expand `pnpm <script>` to the script's own chain.
 *
 * Depth-limited: a script that calls itself would otherwise loop, and a gate that hangs is a
 * gate nobody runs twice.
 */
export function leaves(command, scripts, depth = 0) {
  if (depth > 8) return [command];
  const out = [];
  for (const part of command.split('&&')) {
    const piece = part.trim();
    if (piece === '') continue;
    const match = /^pnpm\s+([\w:.-]+)$/.exec(piece);
    const inner = match === null ? undefined : scripts[match[1]];
    if (inner === undefined) {
      out.push(piece.replace(/\s+/g, ' '));
    } else {
      out.push(...leaves(inner, scripts, depth + 1));
    }
  }
  return out;
}

/** The `run:` commands of one job in a workflow file. */
export function jobCommands(yaml, job) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start === -1) return [];
  const commands = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^  [\w-]+:\s*$/.test(line)) break;
    // Both spellings: `- run: pnpm x` and a named step's `run:` on the next line.
    const run = /^\s*(?:-\s*)?run:\s*(.+)$/.exec(line);
    if (run !== null) commands.push(run[1].trim());
  }
  return commands;
}

/**
 * @returns {{missing: string[], checked: number}}
 */
export function parity({ scripts, yaml, job = 'quality', aggregate = 'gate:all' }) {
  const have = new Set(leaves(scripts[aggregate] ?? '', scripts));
  const wanted = jobCommands(yaml, job).filter((command) => !EXEMPT.some((pattern) => pattern.test(command)));
  const missing = [];
  for (const command of wanted) {
    for (const leaf of leaves(command, scripts)) {
      if (!have.has(leaf)) missing.push(leaf);
    }
  }
  return { missing: [...new Set(missing)], checked: wanted.length };
}

function selfTest() {
  const issues = [];
  const scripts = {
    'gate:all': 'pnpm typecheck && pnpm gate:b',
    typecheck: 'tsc --noEmit',
    'gate:b': 'node tools/b.mjs && node tools/b.mjs --self-test',
  };
  const yaml = ['jobs:', '  quality:', '    steps:', '      - run: pnpm install --frozen-lockfile', '      - run: pnpm typecheck', '      - run: node tools/b.mjs', '  other:', '    steps:', '      - run: pnpm not-gated'].join('\n');
  const ok = parity({ scripts, yaml });
  if (ok.missing.length !== 0) issues.push(`a covered job is reported as missing (${ok.missing.join(', ')})`);
  // The other job is not the aggregate's business; only `quality` is compared.
  if (ok.checked !== 2) issues.push(`the job filter is wrong: ${String(ok.checked)} commands checked`);

  const gap = parity({ scripts: { ...scripts, 'gate:all': 'pnpm typecheck' }, yaml });
  if (!gap.missing.includes('node tools/b.mjs')) {
    issues.push('a command CI runs and the aggregate does not is accepted');
  }
  // An alias must be followed: gate:b covers both of its leaves, and the raw command alone
  // would not look like it covers the self-test.
  const aliasOnly = parity({ scripts: { ...scripts, 'gate:all': 'pnpm gate:b' }, yaml });
  if (aliasOnly.missing.some((leaf) => leaf.includes('b.mjs'))) {
    issues.push('expanding a script alias loses its leaves');
  }
  const recurses = parity({ scripts: { ...scripts, 'gate:all': 'pnpm gate:all' }, yaml });
  // A self-referencing script must terminate and leave everything uncovered, rather than hang.
  if (recurses.missing.length !== 2) issues.push(`a self-referencing script is not depth-limited (${String(recurses.missing.length)} missing)`);
  return issues;
}

if (process.argv[2] === '--self-test') {
  const issues = selfTest();
  for (const issue of issues) console.error(issue);
  if (issues.length > 0) process.exit(1);
  console.log('gate parity self-test: a covered job passes, a missing command fails, aliases expand and self-reference is depth-limited');
} else {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const yaml = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const { missing, checked } = parity({ scripts: pkg.scripts, yaml });
  if (missing.length > 0) {
    console.error(`gate:all is missing ${String(missing.length)} of the ${String(checked)} commands CI runs:`);
    for (const leaf of missing) console.error(`  ${leaf}`);
    console.error('Add them to gate:all, or exempt them in this tool with a reason.');
    process.exit(1);
  }
  console.log(`gate parity: gate:all covers all ${String(checked)} check commands the quality job runs`);
}
