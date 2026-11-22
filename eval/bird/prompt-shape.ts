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
 * How many examples the online synthetic arm asks for per database.
 *
 * Three rather than CHASE-SQL's seven, and the difference is a budget the reading has to state:
 * the block is paid for on every question, and the parent prompt is already 3.7k tokens because
 * of its two carried examples. Three database examples add roughly 450 tokens (+12%); seven would
 * add a thousand and make the arm's gain indistinguishable from "the prompt got longer", which is
 * the confound the `samples-wide` lever already charged +74.9% of prompt for. If the criterion is
 * met at three, the count is the next lever rather than the same arm dispatched again.
 */
export const BIRD_EXAMPLE_COUNT = 3;

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
