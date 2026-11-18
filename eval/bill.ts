/**
 * What an artifact cost, read back out of it.
 *
 * Every number in `docs/cost.md` comes from this command. That is the point: a cost document whose
 * figures were copied out of a provider's dashboard cannot be re-derived, cannot be checked against a
 * later price change, and silently becomes wrong. An artifact records what each row was charged; this
 * file multiplies and adds, and `eval/price.ts` holds the rate.
 *
 * Two shapes exist in this repository's artifacts and both are read here:
 *
 * - a **judge reading**, which prices one roll-up (`tokens`) and, since the round that added the store,
 *   a second one it did not spend (`saved`);
 * - a **BIRD reading**, whose bill lives on the row: `cases[].tokens` per arm per question, which is
 *   the only place the arms can be separated.
 */

import { readFileSync } from 'node:fs';
import { billOf, describeBill, formatYuan, type TokenCounts } from './price.js';
import { applyExitCode, isEntry } from './text2vis/dataset.js';

/** One line of the ledger: a reading, its rows, its tokens, and its model. */
export interface BillRow {
  readonly label: string;
  readonly rows: number;
  readonly tokens: TokenCounts;
  readonly model: string;
}

export interface Bill {
  readonly rows: readonly BillRow[];
  readonly prompt: number;
  readonly completion: number;
  readonly reasoning: number;
  readonly cached: number;
  readonly yuan: number | null;
}

const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * The bill of one artifact.
 *
 * The two shapes are told apart by what they carry rather than by a flag, because the flag would be a
 * second statement of the same fact and the two can disagree — an artifact passed as the wrong shape
 * would then be read as a reading of zero rows instead of refused.
 */
export function billOfArtifact(document: unknown): Bill {
  if (typeof document !== 'object' || document === null) throw new Error('bill: the artifact is not a JSON object');
  const row = document as Record<string, unknown>;
  const model =
    typeof row['model'] === 'string'
      ? row['model']
      : typeof (row['grader'] as Record<string, unknown> | undefined)?.['model'] === 'string'
        ? ((row['grader'] as Record<string, unknown>)['model'] as string)
        : '';
  if (model === '') throw new Error('bill: the artifact names no model, and a bill without a rate is a number of tokens');

  if (Array.isArray(row['cases'])) {
    return fromBird(row, model);
  }
  if (typeof row['tokens'] === 'object' && row['tokens'] !== null) {
    return fromJudge(row, model);
  }
  throw new Error(`bill: ${model} produced an artifact this tool does not know: no \`cases\` and no \`tokens\``);
}

/** A BIRD reading: the bill is on the row, one entry per arm per question. */
function fromBird(row: Record<string, unknown>, model: string): Bill {
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  const cases = row['cases'] as Record<string, unknown>[];
  const byArm = new Map<string, { rows: number; prompt: number; completion: number; cached: number }>();
  for (const one of cases) {
    const tokens = (one['tokens'] ?? {}) as Record<string, unknown>;
    const arm = typeof one['arm'] === 'string' ? one['arm'] : 'unarmed';
    const cell = byArm.get(arm) ?? { rows: 0, prompt: 0, completion: 0, cached: 0 };
    cell.rows += 1;
    cell.prompt += number(tokens['prompt']);
    cell.completion += number(tokens['completion']);
    cell.cached += number(tokens['cached']);
    byArm.set(arm, cell);
    prompt += number(tokens['prompt']);
    completion += number(tokens['completion']);
    cached += number(tokens['cached']);
  }
  const rows: BillRow[] = [...byArm.entries()]
    .map(([arm, cell]) => ({
      label: arm,
      rows: cell.rows,
      tokens: { promptTokens: cell.prompt, completionTokens: cell.completion, ...(cell.cached === 0 ? {} : { cachedPromptTokens: cell.cached }) },
      model,
    }))
    .sort((left, right) => right.tokens.promptTokens - left.tokens.promptTokens || left.label.localeCompare(right.label));
  return total(rows, model, prompt, completion, 0, cached);
}

/** A judge reading: one roll-up of the calls it made, and the second roll-up it did not. */
function fromJudge(row: Record<string, unknown>, model: string): Bill {
  const tokens = row['tokens'] as Record<string, unknown>;
  const saved = (row['saved'] ?? {}) as Record<string, unknown>;
  const rows: BillRow[] = [
    {
      label: 'spent',
      rows: number(tokens['reported']),
      tokens: {
        promptTokens: number(tokens['prompt']),
        completionTokens: number(tokens['completion']),
        reasoningTokens: number(tokens['reasoning']),
      },
      model,
    },
  ];
  // Only when there was a store: a reading taken before the store existed has no second line, and a
  // `0 rows, ¥0.0000` line for it would read as a store that saved nothing rather than as one that was
  // not there.
  if (number(saved['reported']) > 0) {
    rows.push({
      label: 'not spent (the store answered)',
      rows: number(saved['reported']),
      tokens: {
        promptTokens: number(saved['prompt']),
        completionTokens: number(saved['completion']),
        reasoningTokens: number(saved['reasoning']),
      },
      model,
    });
  }
  return total(
    rows,
    model,
    number(tokens['prompt']),
    number(tokens['completion']),
    number(tokens['reasoning']),
    0,
    number(saved['prompt']),
    number(saved['completion']),
  );
}

function total(
  rows: readonly BillRow[],
  model: string,
  prompt: number,
  completion: number,
  reasoning: number,
  cached: number,
  savedPrompt = 0,
  savedCompletion = 0,
): Bill {
  const spent = billOf(model, { promptTokens: prompt, completionTokens: completion, ...(cached === 0 ? {} : { cachedPromptTokens: cached }) });
  const saved = billOf(model, { promptTokens: savedPrompt, completionTokens: savedCompletion });
  const yuan = spent === undefined || saved === undefined ? undefined : spent + saved;
  return {
    rows,
    prompt,
    completion,
    reasoning,
    cached,
    yuan: yuan === undefined ? null : Number(yuan.toFixed(6)),
  };
}

/** The table the log and the document print. */
export function describeBillOf(bill: Bill): readonly string[] {
  const lines = [`bill: ${String(bill.rows.length)} line(s), ${bill.rows.reduce((n, row) => n + row.rows, 0)} rows`];
  for (const row of bill.rows) {
    lines.push(
      `  ${row.label}: ${String(row.rows)} rows, ` +
        describeBill(row.model, {
          promptTokens: row.tokens.promptTokens,
          completionTokens: row.tokens.completionTokens,
          ...(row.tokens.reasoningTokens === undefined ? {} : { reasoningTokens: row.tokens.reasoningTokens }),
          ...(row.tokens.cachedPromptTokens === undefined ? {} : { cachedPromptTokens: row.tokens.cachedPromptTokens }),
        }),
    );
  }
  lines.push(
    bill.yuan === null
      ? `  total: no price on file for ${bill.rows[0]?.model ?? 'this model'}`
      : `  total: ${formatYuan(bill.yuan)}`,
  );
  return lines;
}

export interface BillArgs {
  readonly artifact: string;
  readonly json: boolean;
}

export function parseBillArgs(argv: readonly string[]): BillArgs {
  let artifact: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag.startsWith('--')) throw new Error(`unknown argument ${flag}: this command prices an artifact, and takes <path> and --json`);
    if (artifact !== undefined) throw new Error(`bill: one artifact at a time, and ${artifact} was already named`);
    artifact = flag;
  }
  if (artifact === undefined) throw new Error('bill: name the artifact to price, for example `pnpm bench:bill eval/out/text2vis-judge.json`');
  return { artifact, json };
}

export async function entryBill(
  argv1: string | undefined,
  moduleUrl: string,
  log: (line: string) => void,
  argv: readonly string[],
): Promise<number | undefined> {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  try {
    const args = parseBillArgs(argv);
    const bill = billOfArtifact(JSON.parse(readFileSync(args.artifact, 'utf8')));
    if (args.json) log(JSON.stringify(bill, null, 2));
    else for (const line of describeBillOf(bill)) log(line);
    return 0;
  } catch (error) {
    log(`bill: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

void entryBill(process.argv[1], import.meta.url, (line) => process.stdout.write(`${line}\n`), process.argv.slice(2)).then((code) =>
  applyExitCode(code, process),
);
