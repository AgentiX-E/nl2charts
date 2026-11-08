/**
 * Statement-guard red team: what the gate actually stops, and what refusing costs.
 *
 * `packages/core/test/guard.test.ts` proves the classifier's decisions on a 44-statement corpus.
 * That is a unit test of a function, and it answers "is this sentence classified as I intended".
 * It cannot answer the question a deployment asks: across the shapes someone reaches for when they
 * want a write to happen — a keyword split by a comment, a statement stacked behind a read, a
 * write hidden in a CTE, a function that touches the filesystem — how many land, and what does
 * refusing them cost a legitimate question?
 *
 * Three numbers, because one of them can always be bought with another:
 *
 * 1. **ASR** — attacks that reached the data. The only number that is a hole when it is not zero.
 * 2. **falseReject** — questions the gate refused. A gate that refuses everything has an ASR of
 *    zero and is useless, so the two are published on one line.
 * 3. **utility** — refused questions that were supposed to work, against the same corpus.
 *
 * And a mutation, because a number that cannot move is not evidence: the same corpus through the
 * engine with no gate at all must let more attacks through. If it does not, the gate is not what is
 * stopping them and the reading is about something else — that refusal is the instrument's own
 * self-test, checked on every run rather than in a test file.
 *
 *   pnpm bench:guard
 *   pnpm bench:guard -- --strict     # exit 1 on any hole
 *
 * Zero model calls: the corpus is fixed and the engine is a local SQLite database.
 */
import { createRunner } from '@agentix-e/nl2charts-core';
import type { Engine } from '@agentix-e/nl2charts-core';
import { createSqliteEngine } from '@agentix-e/nl2charts-node';
import { pathToFileURL } from 'node:url';
import { describeError } from '../errors.js';
import { ATTACK_CLASSES, ATTACKS, LEGAL, UNMEASURED } from './cases.js';
import type { AttackClass, AttackCase, LegalCase } from './cases.js';

/** How much a class stops, and how much of it was there to stop. */
export interface ClassReading {
  readonly kind: AttackClass;
  readonly cases: number;
  readonly contained: number;
  readonly rate: number;
}

export interface GuardReading {
  readonly attacks: number;
  readonly contained: number;
  /** Attacks that reached the data, over attacks. The one number that fails the run when positive. */
  readonly asr: number;
  readonly refused: number;
  readonly legal: number;
  readonly falseRejectRate: number;
  readonly utility: number;
  readonly classes: readonly ClassReading[];
  /** The same corpus with no gate in front of it. */
  readonly mutation: { readonly asr: number; readonly contained: number };
  /** Shapes the corpus cannot measure, with the reason, so an absent class is visible. */
  readonly unmeasured: readonly { readonly kind: string; readonly why: string }[];
}

/** What a database looks like to the containment check. */
export interface Signature {
  readonly objects: number | null;
  readonly rows: number | null;
  readonly sum: number | null;
}

const CANARY = ['create table canary (n integer)', 'insert into canary (n) values (1)'] as const;

/**
 * One number out of an engine row, or `null` when the row does not carry one.
 *
 * Exported because it is the only part of the probe that can be wrong in a way a test can see: a
 * driver that returns strings, a `count(*)` that came back under another name, a row that arrived
 * empty. Inlined, those three cases become branches inside a function that needs a database to run.
 */
export function readCount(row: Readonly<Record<string, unknown>> | undefined, key: string): number | null {
  if (row === undefined) return null;
  const value = row[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * The state an attack would have to change.
 *
 * Schema objects are counted separately from rows because half of these attacks never touch a row:
 * `create index` and `alter table` are writes that a row count cannot see. The canary read is
 * wrapped because the attack may have removed the table, and a probe that throws is a change.
 */
async function signature(engine: Engine): Promise<Signature | null> {
  try {
    const objects = await engine.run("select count(*) as c from sqlite_master where name not like 'sqlite_%'");
    const canary = await engine.run('select count(*) as c, coalesce(sum(n), 0) as s from canary');
    return {
      objects: readCount(objects.rows[0], 'c'),
      rows: readCount(canary.rows[0], 'c'),
      sum: readCount(canary.rows[0], 's'),
    };
  } catch {
    // The table the probe reads is gone, which is exactly the effect being looked for.
    return null;
  }
}

const unchanged = (before: Signature | null, after: Signature | null): boolean =>
  before !== null &&
  after !== null &&
  before.objects === after.objects &&
  before.rows === after.rows &&
  before.sum === after.sum;

/** A writable database with one row, and nothing else. */
async function fixture(): Promise<Engine> {
  const engine = await createSqliteEngine({ path: ':memory:', readOnly: false });
  for (const statement of CANARY) await engine.run(statement);
  return engine;
}

export interface CaseOutcome {
  readonly refused: boolean;
  readonly error: string | undefined;
}

/**
 * Run one statement through the product path: guard, row cap, timeout, engine.
 *
 * `createRunner` is the object a question goes through, not a copy of its logic, so a case that is
 * stopped here is stopped in production for the same reason.
 */
async function throughRunner(engine: Engine, sql: string): Promise<CaseOutcome> {
  const runner = createRunner({ engine, maxRows: 1_000, timeoutMs: 5_000 });
  try {
    await runner.sql(sql);
    return { refused: false, error: undefined };
  } catch (error) {
    const message = describeError(error);
    // The code, not the text: `Nl2ChartsError` carries `NL2C_E_GUARD_REJECTED` as a field and its
    // message is a sentence about the reason. Matching on the message is how the first version of
    // this file reported five refusals as five holes.
    const code = (error as { code?: unknown }).code;
    return { refused: code === 'NL2C_E_GUARD_REJECTED', error: message };
  }
}

/** Run one statement straight at the engine, with no gate. The mutation arm. */
async function throughEngine(engine: Engine, sql: string): Promise<{ threw: boolean }> {
  try {
    await engine.run(sql);
    return { threw: false };
  } catch {
    return { threw: true };
  }
}

/** One attack, on a database of its own. */
export async function measureAttack(one: AttackCase): Promise<boolean> {
  const engine = await fixture();
  const before = await signature(engine);
  const outcome = await throughRunner(engine, one.sql);
  const after = await signature(engine);
  const effect = !unchanged(before, after);
  await engine.close();
  // `verdict` cases are stopped by the refusal itself: a PRAGMA that runs leaves no trace this
  // probe can read, and "no visible change" would score it as contained when it was not.
  return one.containedBy === 'verdict' ? outcome.refused : !effect;
}

/** The same attack with no gate, which must do more damage than the guarded run. */
export async function measureUnguarded(one: AttackCase): Promise<boolean> {
  const engine = await fixture();
  const before = await signature(engine);
  await throughEngine(engine, one.sql);
  const after = await signature(engine);
  const effect = !unchanged(before, after);
  await engine.close();
  // A `verdict` case has no effect to observe, and without a gate there is no verdict: the refusal
  // was its only containment, so it counts as landed. The alternative — dropping these from the
  // mutation denominator — would compare two different corpora and call the difference a finding.
  return one.containedBy === 'verdict' ? false : !effect;
}

/** One legal question: was it refused, and did it run. */
export async function measureLegal(one: LegalCase): Promise<{ refused: boolean; executed: boolean }> {
  const engine = await fixture();
  const before = await signature(engine);
  const outcome = await throughRunner(engine, one.sql);
  const after = await signature(engine);
  await engine.close();
  // A legal read that changed the database is a defect of its own, and the corpus asserts it
  // cannot happen rather than reporting it as a refusal.
  const effect = !unchanged(before, after);
  return { refused: outcome.refused, executed: outcome.error === undefined && !effect };
}

export function tallyGuard(
  attacks: readonly { readonly kind: AttackClass; readonly contained: boolean }[],
  legal: readonly { readonly refused: boolean; readonly executed: boolean }[],
  mutation: readonly { readonly kind: AttackClass; readonly contained: boolean }[],
): GuardReading {
  const contained = attacks.filter((one) => one.contained).length;
  const refused = legal.filter((one) => one.refused).length;
  const executed = legal.filter((one) => one.executed).length;
  const classes = ATTACK_CLASSES.map((kind) => {
    const of = attacks.filter((one) => one.kind === kind);
    const stopped = of.filter((one) => one.contained).length;
    return { kind, cases: of.length, contained: stopped, rate: of.length === 0 ? 0 : stopped / of.length };
  });
  const mutated = mutation.filter((one) => one.contained).length;
  return {
    attacks: attacks.length,
    contained,
    asr: attacks.length === 0 ? 0 : (attacks.length - contained) / attacks.length,
    refused,
    legal: legal.length,
    falseRejectRate: legal.length === 0 ? 0 : refused / legal.length,
    utility: legal.length === 0 ? 0 : executed / legal.length,
    classes,
    mutation: { asr: mutation.length === 0 ? 0 : (mutation.length - mutated) / mutation.length, contained: mutated },
    unmeasured: UNMEASURED,
  };
}

/** The reading, as the table a report quotes. */
export function guardLines(reading: GuardReading): string[] {
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const lines = [
    `| ${'class'.padEnd(20)} | cases | contained | block |`,
    `| ${'-'.repeat(20)} | ----- | --------- | ----- |`,
  ];
  for (const one of reading.classes) {
    lines.push(`| ${one.kind.padEnd(20)} | ${String(one.cases).padStart(5)} | ${String(one.contained).padStart(9)} | ${pct(one.rate).padStart(5)} |`);
  }
  lines.push('');
  lines.push(
    `ASR ${pct(reading.asr)} across ${String(reading.attacks)} attacks: ${String(reading.attacks - reading.contained)} reached the data. ` +
      `False reject ${pct(reading.falseRejectRate)} of ${String(reading.legal)} legitimate questions; ` +
      `utility ${pct(reading.utility)} (refused, or refused without a result).`,
  );
  lines.push(
    `Mutation: the same corpus with no gate has ASR ${pct(reading.mutation.asr)} against ${pct(reading.asr)} guarded — ` +
      (reading.mutation.asr > reading.asr
        ? 'the gate is what stops these, and the size of the difference is its contribution.'
        : 'no difference, so the gate is not what is stopping them and this table is about something else.'),
  );
  if (reading.unmeasured.length > 0) {
    lines.push(`Not measured: ${reading.unmeasured.map((one) => `${one.kind} (${one.why})`).join('; ')}.`);
  }
  return lines;
}

/**
 * What stops the table from being published.
 *
 * Each one is a table that would still print. The two that matter are the hole (ASR above zero) and
 * the mutation (a gate that changed nothing), because those are the two readings a reader would
 * take as "the guard works" without a denominator behind them.
 */
export function guardProblems(reading: GuardReading): string[] {
  const problems: string[] = [];
  if (reading.attacks === 0) problems.push('the corpus holds no attacks, so ASR is a division by zero wearing a percentage');
  const empty = reading.classes.filter((one) => one.cases === 0);
  if (empty.length > 0) {
    problems.push(`class(es) with no case: ${empty.map((one) => one.kind).join(', ')} — an absent class reads as a passed one`);
  }
  if (reading.legal === 0) problems.push('the corpus holds no legitimate questions, so there is no false-reject cost to publish');
  if (reading.asr > 0) {
    problems.push(`${String(reading.attacks - reading.contained)} attack(s) reached the data: ${(reading.asr * 100).toFixed(1)}% ASR`);
  }
  if (reading.mutation.asr <= reading.asr) {
    problems.push(
      `the unguarded corpus has ASR ${(reading.mutation.asr * 100).toFixed(1)}% against ${(reading.asr * 100).toFixed(1)}% guarded, ` +
        'so the guard is not what these cases measure',
    );
  }
  if (reading.utility < 1) {
    problems.push(`utility ${(reading.utility * 100).toFixed(1)}%: a legitimate question did not run`);
  }
  return problems;
}

export interface GuardSettings {
  readonly strict: boolean;
}

export function resolveGuardSettings(argv: readonly string[]): GuardSettings {
  for (const flag of argv) {
    if (flag !== '--strict') throw new Error(`usage: guard-redteam.ts [--strict]; unknown argument ${flag}`);
  }
  return { strict: argv.includes('--strict') };
}

/**
 * The corpus, run once.
 *
 * Sequential on purpose: the cases are 30-odd statements against an in-memory database and the
 * numbers are counts, so a pool would buy a second of wall time and make a failure order-dependent.
 */
export async function runGuard(): Promise<{ reading: GuardReading; problems: string[] }> {
  const attacks: { kind: AttackClass; contained: boolean }[] = [];
  for (const one of ATTACKS) attacks.push({ kind: one.kind, contained: await measureAttack(one) });
  const mutation: { kind: AttackClass; contained: boolean }[] = [];
  for (const one of ATTACKS) mutation.push({ kind: one.kind, contained: await measureUnguarded(one) });
  const legal: { refused: boolean; executed: boolean }[] = [];
  for (const one of LEGAL) legal.push(await measureLegal(one));
  const reading = tallyGuard(attacks, legal, mutation);
  return { reading, problems: guardProblems(reading) };
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  run: () => Promise<{ reading: GuardReading; problems: string[] }> = runGuard,
): Promise<number> {
  const settings = resolveGuardSettings(argv);
  const { reading, problems } = await run();
  for (const line of guardLines(reading)) console.log(line);
  for (const problem of problems) console.error(problem);
  if (problems.length === 0) return 0;
  return settings.strict ? 1 : 0;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}

export { ATTACKS, LEGAL, UNMEASURED };
