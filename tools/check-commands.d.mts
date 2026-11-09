/**
 * The one function each half of the command check exports for its test.
 *
 * The tool stays plain JavaScript for the same reason the other gates do: it runs in the aggregate
 * gate before anything is built, so it cannot import the TypeScript it is checking.
 */
export function references(text: string): { name: string; line: number }[];

export function nearest(name: string, names: readonly string[]): string | undefined;

export function audit(
  files: readonly { file: string; text: string }[],
  scripts: Readonly<Record<string, string>>,
): { file: string; line: number; name: string; suggestion?: string }[];

export function main(argv?: readonly string[], root?: string): number;
