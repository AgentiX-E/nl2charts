/**
 * The declarations beside the plain-JavaScript scripts are written by hand, so a test has to hold
 * them to their modules.
 *
 * Each `*.d.mts` gives the suite a type for a script that stays plain JavaScript: the workflow runs
 * those scripts before `pnpm install`, so they cannot depend on what the install provides. That
 * arrangement has one failure mode, and round 147 hit it. `isToolConfig` was added to
 * `tools/ci-scope.mjs` and not to `tools/ci-scope.d.mts`, the local typecheck had been run before
 * that edit, and the push went through the Git Data API — which does not run hooks. **CI caught it
 * at typecheck, on a run whose other jobs were skipped**, so the round that was supposed to cost one
 * measurement cost one failed run and one more push.
 *
 * A comment cannot prevent that; a test can. This one reads both files and compares the names, in
 * both directions: a function the module exports and the declaration does not is a compile error for
 * every caller, and a name the declaration has and the module does not is a promise nothing keeps.
 *
 * The first version of this file scanned `tools/` only, which is the directory the failure happened
 * in and not the directory the class lives in: `eval/bird/fetch.d.mts` declares a script that is
 * fetched before the install for the same reason. Two directories are named, and the second one was
 * found by grepping for the suffix rather than by remembering where the class was.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The directories that hold a plain-JavaScript script and a hand-written declaration beside it. */
const DIRECTORIES = ['tools', 'eval/bird'];

/** The exported `const` and `function` names in a module or a declaration, in file order. */
function exportedNames(source: string): string[] {
  return [...source.matchAll(/^export (?:const|function) (\w+)/gm)].map((match) => match[1] as string);
}

/** Every `.d.mts` under the named directories, as repository-relative paths, sorted. */
const DECLARATIONS = DIRECTORIES.flatMap((directory) =>
  readdirSync(resolve(directory))
    .filter((file) => file.endsWith('.d.mts'))
    .map((file) => `${directory}/${file}`),
).sort();

/** The script a declaration describes: the same path with `.mjs` where `.d.mts` was. */
function moduleOf(declaration: string): string {
  return declaration.replace(/\.d\.mts$/, '.mjs');
}

/** How a test in `test/` reaches a script at the repository root. */
function importPath(module: string): string {
  return `'../${module}'`;
}

describe('the hand-written declaration of a script', () => {
  it('exists for every script that has one, and is not empty', () => {
    expect(DECLARATIONS.length).toBeGreaterThan(0);
    for (const file of DECLARATIONS) {
      const source = readFileSync(resolve(file), 'utf8');
      expect(exportedNames(source).length, file).toBeGreaterThan(0);
    }
  });

  it('names every constant and function its module exports', () => {
    // Both directions, because the two defects are different: a missing name is a compile error in
    // the suite, and an extra name is a type that describes a function nobody wrote.
    for (const file of DECLARATIONS) {
      const module = moduleOf(file);
      const declared = exportedNames(readFileSync(resolve(file), 'utf8')).sort();
      const actual = exportedNames(readFileSync(resolve(module), 'utf8')).sort();
      expect(declared, `${file} against ${module}`).toEqual(actual);
    }
  });

  it('is imported by a test, because a declaration nobody reads cannot be wrong', () => {
    // The drift this file was written for was not the only one. `check-exports.d.mts` declared
    // `staleBuild` -- a function that lives in `stale-build.mjs` -- and no test imported the module,
    // so nothing compiled against the name and nothing noticed it was the wrong one. A declaration
    // whose docblock says "the one function this check exports for its tests" while no test imports
    // it is a file that describes nothing, and the honest repair was to delete it rather than to
    // correct a name into another unused line.
    const suites = readdirSync(resolve('test'))
      .filter((file) => file.endsWith('.test.ts'))
      .map((file) => readFileSync(resolve('test', file), 'utf8'))
      .join('\n');
    for (const file of DECLARATIONS) {
      const wanted = importPath(moduleOf(file));
      expect(suites.includes(wanted), `${moduleOf(file)} is imported by a test`).toBe(true);
    }
  });

  it('finds the declarations in every directory that holds one', () => {
    // The guard is worth what its file list is worth, and a list that names one directory makes the
    // second one an exception nobody wrote down. Both are asserted, so a third has to be added here
    // rather than discovered by the next type error.
    expect(DECLARATIONS.some((file) => file.startsWith('tools/'))).toBe(true);
    expect(DECLARATIONS.some((file) => file.startsWith('eval/bird/'))).toBe(true);
    for (const file of DECLARATIONS) expect(DIRECTORIES.some((directory) => file.startsWith(`${directory}/`))).toBe(true);
  });

  it('reads the same names out of a declaration and a module that differ', () => {
    // The comparison above is only worth having if it fails on a difference, and the difference it
    // was written for is one line in one file. This is that fixture.
    const module = 'export const A = 1;\nexport function b() {}\nexport const C = 2;\n';
    const declaration = 'export const A: number;\nexport function b(): void;\n';
    expect(exportedNames(declaration)).toEqual(['A', 'b']);
    expect(exportedNames(module)).toEqual(['A', 'b', 'C']);
  });

  it('ignores the types, which have no module to be checked against', () => {
    // `ScopeResult` is an interface and `publish` takes it: a declaration legitimately holds names a
    // JavaScript module cannot export, and a rule that demanded equality of *all* exports would fail
    // on the interface rather than on the function somebody forgot.
    const source = 'export interface Shape { readonly x: number }\nexport type Alias = string;\nexport function f(): void;\n';
    expect(exportedNames(source)).toEqual(['f']);
  });
});
