/**
 * One tokenizer, three consumers.
 *
 * The linker, the value profile and the semantics renderer all split identifiers
 * the same way. Keeping three copies made them drift (one dropped stopwords, one
 * did not) and cost more bytes than the logic is worth.
 */

/** Split snake, kebab and camel names into lowercase words. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}
