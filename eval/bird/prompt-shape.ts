/**
 * The shape of the schema card every BIRD prompt sends.
 *
 * It lives in one place because two instruments read it and a third wrote it: the
 * runner renders the card into the prompt, the coverage control counts the tables that
 * card reached, and the recall gate renders the same card to check that every gold
 * identifier is visible in it. When those three disagree the instruments measure a
 * prompt nobody sends, and they measure it *green* — which is worse than not measuring.
 *
 * That is not hypothetical. The coverage control rendered at 2,000 lines while the arms
 * rendered at 400, and the recall gate rendered at the default 40 with no descriptions,
 * so the gate that exists to catch a hidden column was checking a fifth of the card.
 */
export const BIRD_SCHEMA_LINES = 400;

/**
 * The card options the arms share.
 *
 * `foreignKeys: true` is both what the arms send and the worst case for truncation —
 * join hints add a line per foreign key — so a card that fits here fits every arm.
 */
export const BIRD_CARD = {
  descriptions: true,
  foreignKeys: true,
  samples: false,
  schemaLines: BIRD_SCHEMA_LINES,
} as const;
