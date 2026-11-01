/**
 * The one function the snapshot check exports for its tests.
 *
 * The tool stays plain JavaScript because it runs before `pnpm build` has produced anything —
 * it is the check that refuses to read unbuilt output — and declaring the surface here keeps
 * it out of the TypeScript build while still giving the test a type.
 */
export function staleBuild(root: string, name: string): 'stale' | 'missing' | undefined;
