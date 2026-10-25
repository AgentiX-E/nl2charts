/**
 * The two layout helpers `fetch.mjs` exports for tests.
 *
 * The script itself stays plain JavaScript — it runs before `pnpm install` completes on a
 * fresh runner — so its surface is declared here rather than by converting it.
 */
export function expandDatabases(archivePath: string, destination: string): void;
export function promote(archiveRoot: string, dataDir: string): void;
