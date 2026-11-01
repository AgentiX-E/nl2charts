/**
 * The guard two gates share, declared for the tests that hold it to its contract.
 *
 * Both callers are plain JavaScript because they run before and around the build; this is the
 * only part of them a TypeScript test imports.
 */
export function staleBuild(root: string, name: string): 'stale' | 'missing' | undefined;
export function assertBuilt(root: string, names: readonly string[], rule?: string): string[];
