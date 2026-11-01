/**
 * Whether a package's build is new enough to be measured.
 *
 * Two gates read `dist` — the API snapshot and the bundle budget — and both were able to pass
 * on a tree whose build predated the change under test. That is not a hypothetical: the audit
 * turn passed the snapshot locally and failed it in CI (`41255435708`), and then the same
 * stale build passed the budget gate by 735 B and failed it in the next run (`41257338754`).
 * A measurement taken from files that cannot contain the change is worse than no measurement,
 * because it is printed as a pass.
 *
 * The comparison is against the *newest* source file in the package, nested modules included:
 * a check that only looked at `src/index.ts` would miss exactly the new module that caused
 * both failures.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `'missing'` and `'stale'` are separate answers because they call for different fixes — build
 * the tree, or check out the tree that has one. `undefined` means the build is usable, and also
 * covers a package with no sources to be newer than.
 */
export function staleBuild(root, name) {
  let built;
  try {
    built = statSync(join(root, 'packages', name, 'dist', 'index.d.ts')).mtimeMs;
  } catch {
    return 'missing';
  }
  const newest = newestSource(join(root, 'packages', name, 'src'));
  if (newest === undefined) return undefined;
  return newest > built ? 'stale' : undefined;
}

/** Every package whose build cannot be trusted, as one line per package, ready to print. */
export function assertBuilt(root, names, rule = 'A0') {
  const problems = [];
  for (const name of names) {
    const state = staleBuild(root, name);
    if (state === undefined) continue;
    problems.push(`${rule}: packages/${name}/dist is ${state}; run \`pnpm build\` before this check`);
  }
  return problems;
}

/** The newest modification time under a source tree. */
function newestSource(directory) {
  let newest;
  let entries;
  try {
    entries = readdirSync(directory, { recursive: true, withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const stats = statSync(join(entry.parentPath ?? directory, entry.name));
    if (newest === undefined || stats.mtimeMs > newest) newest = stats.mtimeMs;
  }
  return newest;
}
