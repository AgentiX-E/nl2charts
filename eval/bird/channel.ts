/**
 * Whether a refusal told the truth about what it refused.
 *
 * The report states, per case, why the case failed: `guard` when a statement was unsafe,
 * `execution` when the engine rejected one, `shape` when a reply was unreadable. Each of those
 * names a different fix, which is the only reason the column exists — and the column was wrong.
 *
 * Measured on `deepseek-v4-pro` (Mini-Dev, run 43262574193, 992 case-scored rows): six replies
 * were prose — "Let me recall: in SQLite, NULLs sort…", 83,036 characters on one of them — and
 * all six were published as `guard` failures with `unsupported character "?"` as the reason. The
 * `?` was in the model's own question to itself. Nothing had been refused for safety, and the
 * expensive part was not the six points: it was that the repair turn then told the model its
 * statement was unsafe, so a model that had written no statement spent its next three calls
 * fixing a problem it did not have.
 *
 * The bug is fixed upstream (`attemptsStatement` in the guard, `replyShape` in the diagnosis, a
 * `shape:` summary that names the absence). This file is the instrument that would have caught it
 * and is the one that keeps it caught: it reads the artifact, compares each refusal's *claim*
 * against the bytes the case actually holds, and refuses to let a report be published whose
 * taxonomy disagrees with its own evidence.
 *
 * Zero model calls, zero database: everything it needs is already in the file.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attemptsStatement } from '@agentix-e/nl2charts-core';

/** What the bytes of a reply were, before anything was said about them. */
export type ChannelKind = 'statement' | 'prose' | 'empty';

/** A case as the artifact writes it, restricted to the fields this reads. */
export interface ChannelCase {
  readonly arm?: string;
  readonly id?: string;
  readonly passed?: boolean;
  /** Why the statement was wrong, on a case that ran. The other taxonomy, and an attribution too. */
  readonly reason?: string;
  readonly errorKind?: string;
  readonly error?: string;
  readonly sql?: string;
  readonly truncated?: boolean;
}

export interface ChannelReportShape {
  readonly split?: string;
  readonly model?: string | null;
  readonly cases?: readonly ChannelCase[];
}

/**
 * The reply behind a case, read as bytes.
 *
 * `empty` and `prose` are kept apart because they are different defects: an empty reply is a
 * prompt that produced nothing, and prose is a prompt that produced the wrong kind of thing.
 * A single "unreadable" bucket would have hidden which of the two the model does.
 */
export function channelKind(record: ChannelCase): ChannelKind {
  const sql = (record.sql ?? '').trim();
  if (sql.length === 0) return 'empty';
  return attemptsStatement(sql) ? 'statement' : 'prose';
}

/** A refusal whose name and whose bytes disagree. */
export interface Misattributed {
  readonly id: string;
  /** The kind the report published. */
  readonly claimed: string;
  /** What the bytes were. */
  readonly actual: ChannelKind;
  readonly chars: number;
  readonly why: string;
}

export interface ArmChannel {
  readonly arm: string;
  readonly scored: number;
  readonly failed: number;
  /** Failures by the kind the report published, so the column can be read before it is trusted. */
  readonly byKind: Readonly<Record<string, number>>;
  /**
   * Failures the report explains at all — by a channel kind or by a result reason.
   *
   * Both count, and the distinction cost a false alarm on the first run: 215 of 496 pro cases
   * failed, five carried `errorKind` and 210 carried `reason: values|column-count`. Counting only
   * the channel kinds reported 210 unexplained failures on a report that had explained every one
   * of them, which is the instrument inventing the defect it was written to find.
   */
  readonly attributed: number;
  readonly misattributed: readonly Misattributed[];
  /** Cases whose reply was cut at the answer cap. */
  readonly truncated: number;
}

/**
 * The two claims this instrument can test against the bytes.
 *
 * Both are one-directional on purpose. `guard` says a statement was refused for safety, so a case
 * carrying it must be a statement — prose cannot be unsafe. `shape` says a reply held no
 * statement, so a case carrying it must not hold one the reader could have used. Neither rule
 * fires on `execution`, `llm` or `harness`: those claims are about the engine and the endpoint,
 * and the bytes cannot contradict them.
 */
function contradiction(record: ChannelCase, kind: ChannelKind): string | undefined {
  const claimed = typeof record.errorKind === 'string' ? record.errorKind.trim() : '';
  const error = record.error ?? '';
  if (claimed === 'guard' && kind !== 'statement') {
    return `guard names an unsafe statement, and the reply holds ${kind === 'empty' ? 'nothing' : 'prose'}`;
  }
  if (claimed === 'shape' && /no statement|token cap/i.test(error) && kind === 'statement' && record.truncated !== true) {
    return 'shape names a reply with no statement, and the reply holds one';
  }
  return undefined;
}

/** Whether the report says anything at all about this failure. */
function explained(record: ChannelCase): boolean {
  const kind = typeof record.errorKind === 'string' ? record.errorKind.trim() : '';
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  return kind !== '' || reason !== '';
}

/** Per-arm channel table, with the disagreements the artifact cannot see about itself. */
export function channelTable(report: ChannelReportShape): ArmChannel[] {
  const arms = new Map<string, ChannelCase[]>();
  for (const record of report.cases ?? []) {
    const arm = String(record.arm ?? 'unknown');
    arms.set(arm, [...(arms.get(arm) ?? []), record]);
  }
  return [...arms.entries()].map(([arm, rows]) => {
    const failed = rows.filter((row) => row.passed === false);
    const byKind: Record<string, number> = {};
    const misattributed: Misattributed[] = [];
    for (const row of failed) {
      const claimed = typeof row.errorKind === 'string' && row.errorKind.trim() !== '' ? row.errorKind.trim() : 'unattributed';
      byKind[claimed] = (byKind[claimed] ?? 0) + 1;
      const kind = channelKind(row);
      const why = contradiction(row, kind);
      if (why !== undefined) {
        misattributed.push({ id: String(row.id ?? '?'), claimed, actual: kind, chars: (row.sql ?? '').trim().length, why });
      }
    }
    return {
      arm,
      scored: rows.length,
      failed: failed.length,
      byKind,
      attributed: failed.filter((row) => explained(row)).length,
      misattributed,
      truncated: rows.filter((row) => row.truncated === true).length,
    };
  });
}

/**
 * The problems that make the taxonomy unpublishable.
 *
 * A misattribution is one: the column a reader uses to decide where to spend the next iteration
 * is naming a fix that is not the fix. An unattributed failure is the other, and it is the same
 * defect in a weaker form — a failed case with no kind at all is a case that leaves the report's
 * own taxonomy silently, and a taxonomy with a silent exit cannot be summed to the score.
 */
export function channelProblems(rows: readonly ArmChannel[]): string[] {
  const problems: string[] = [];
  for (const row of rows) {
    for (const bad of row.misattributed) {
      problems.push(
        `CHANNEL: ${row.arm} case ${bad.id} is reported as ${bad.claimed} but its reply is ${bad.actual} (${String(bad.chars)} chars) — ${bad.why}`,
      );
    }
    const unattributed = row.failed - row.attributed;
    if (unattributed > 0) {
      problems.push(`CHANNEL: ${row.arm} has ${String(unattributed)} failed cases with no kind, so the taxonomy does not add up to the score`);
    }
  }
  return problems;
}

/** The table a human reads. */
export function channelLines(rows: readonly ArmChannel[]): string[] {
  const head = ['arm', 'scored', 'failed', 'attributed', 'guard', 'shape', 'execution', 'llm', 'truncated', 'misattributed'];
  const rowsOut = rows.map((row) => [
    row.arm,
    String(row.scored),
    String(row.failed),
    String(row.attributed),
    String(row.byKind.guard ?? 0),
    String(row.byKind.shape ?? 0),
    String(row.byKind.execution ?? 0),
    String(row.byKind.llm ?? 0),
    String(row.truncated),
    String(row.misattributed.length),
  ]);
  const widths = head.map((title, index) => Math.max(title.length, ...rowsOut.map((cells) => cells[index]!.length)));
  const line = (cells: readonly string[]): string => cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  ').trimEnd();
  const out = [line(head), ...rowsOut.map(line)];
  const baked = rows.reduce((sum, row) => sum + row.misattributed.length, 0);
  out.push('');
  out.push(
    baked === 0
      ? 'every refusal agrees with the reply behind it'
      : `${String(baked)} refusal(s) name a cause the bytes do not support, so the taxonomy is describing a different run`,
  );
  return out;
}

export interface ChannelSettings {
  readonly report: string;
  readonly out: string;
  readonly arm?: string;
}

export function resolveChannelSettings(argv: readonly string[] = [], root = process.cwd()): ChannelSettings {
  const flag = argv.indexOf('--arm');
  const named = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && named === undefined) throw new Error('--arm needs a name');
  const consumed = flag === -1 ? [] : [flag, flag + 1];
  const path = argv.find((item, index) => !item.startsWith('--') && !consumed.includes(index)) ?? 'eval/bird/out/bird-eval.json';
  return {
    report: resolve(root, path),
    out: resolve(root, named === undefined ? 'eval/out/bird-channel.json' : `eval/out/bird-channel-${named}.json`),
    ...(named === undefined ? {} : { arm: named }),
  };
}

export interface ChannelArtifact {
  readonly split: string;
  readonly model: string | null;
  readonly generatedAt: string;
  readonly arms: readonly ArmChannel[];
  readonly problems: readonly string[];
  /** The one arm this reading was aimed at, when it was aimed. */
  readonly arm?: string;
}

export function channelArtifact(report: ChannelReportShape, settings: ChannelSettings, rows: readonly ArmChannel[], problems: readonly string[]): ChannelArtifact {
  return {
    split: String(report.split ?? 'unknown'),
    model: report.model ?? null,
    generatedAt: new Date().toISOString(),
    arms: rows,
    problems,
    ...(settings.arm === undefined ? {} : { arm: settings.arm }),
  };
}

export function writeChannelArtifact(settings: ChannelSettings, artifact: ChannelArtifact): string {
  mkdirSync(dirname(settings.out), { recursive: true });
  writeFileSync(settings.out, JSON.stringify(artifact, null, 2));
  return settings.out;
}

/** Whether this module is the program. Asserted in tests rather than trusted. */
export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

export function runChannel(settings: ChannelSettings): { artifact: ChannelArtifact; rows: ArmChannel[]; problems: string[] } {
  const report = JSON.parse(readFileSync(settings.report, 'utf8')) as ChannelReportShape;
  const rows = channelTable(report);
  const problems = channelProblems(rows);
  const artifact = channelArtifact(report, settings, rows, problems);
  writeChannelArtifact(settings, artifact);
  return { artifact, rows, problems };
}

/**
 * Report, or judge.
 *
 * The default is a report and exits zero, because the artifacts this repository keeps are
 * historical: the committed dev artifact was written before the fix and holds three rows the fix
 * would not write. A tool that fails on a file it did not produce teaches its reader to skip it.
 * `--strict` is the same reading as a verdict, for the one place the file is guaranteed to be the
 * run's own output — the job that just wrote it.
 */
export function strictRequested(argv: readonly string[] = process.argv.slice(2)): boolean {
  return argv.includes('--strict');
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const settings = resolveChannelSettings(argv, root);
  // The artifact is written by `runChannel`; this function prints the reading it also returns.
  const { rows, problems } = runChannel(settings);
  const lines = channelLines(rows);
  for (const line of lines) console.log(line);
  for (const problem of problems) console.error(problem);
  const summary = env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== '') {
    appendFileSync(summary, ['', '### Whether each refusal matched the reply behind it', '', '```', ...lines, '```', '', ...problems, ''].join('\n'));
  }
  if (problems.length === 0) return 0;
  return strictRequested(argv) ? 1 : 0;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
