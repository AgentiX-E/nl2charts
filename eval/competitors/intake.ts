/**
 * Which leader can be copied, and which can only be imitated.
 *
 * `pins.json` holds the systems this repository can *run*: a repository, a 40-character commit, a
 * licence, an adapter patch and an entrypoint. That is a narrow set, and the narrowness is the
 * point — a pin is a promise that a dispatch will start. But the question that decides a round is
 * asked before anything is pinned: **of the systems ahead of us, which one can be learned from by
 * running it, and which one only by reading it?** This module answers that question with a record
 * per system and a status that says what copying it would produce.
 *
 * The four statuses are not a ranking. They are four different pieces of work:
 *
 * - `released` — the code is public at a pinned commit under a named licence. Copying means
 *   checking it out and running its own entrypoint, which is what `pins.json` and
 *   `eval/competitors/probe.ts` exist for. The copy can be compared, because its prompts are its
 *   own and `coordinates.ts` will accept the run.
 * - `partial` — a repository exists, but the modules that carry the score are not in it. The
 *   released part can be run; the withheld part can only be read about. Copying the repository
 *   and calling the result "their system" is the mistake this status exists to prevent, and it is
 *   a mistake that produces a number rather than an error, which is why it needs a machine.
 * - `paper-only` — no artifact of any kind. Copying means rebuilding the mechanisms the paper
 *   names; the paper's own report is the only thing to check the rebuild against, and the gap
 *   between a rebuild and the original is not measurable from the paper.
 * - `unreproducible` — a claim with no mechanism and no artifact behind it: a leaderboard row with
 *   no submission, a blog number with no system. It cannot be copied and it cannot be beaten on
 *   its own terms, so it may only be cited, with its date.
 *
 * Every entry carries `evidence`: a URL a reader can open. A status without evidence is a memory,
 * and memories of other people's systems are the input this repository has been wrong about
 * before — the `77.14%` that turned out to be a test score of a non-agent, and the `45.0%` that
 * did not reproduce at `40.3%`.
 *
 * The second output is the one the plan actually consumes: `intakeGaps` compares the claims
 * against `pins.json`, so a system that is `released` and not pinned is a task rather than a
 * conclusion, and a pin with no claim is a run with no stated question.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isPinnedCommit } from './coordinates.js';

/** What copying a system would produce. Ordered from most to least direct evidence. */
export const INTAKE_STATUS = ['released', 'partial', 'paper-only', 'unreproducible'] as const;
export type IntakeStatus = (typeof INTAKE_STATUS)[number];

/**
 * What one system's artifact permits, as a verb rather than a score.
 *
 * `run` — check out the commit and start its entrypoint; the number it produces is comparable
 *   through `coordinates.ts` because the templates are theirs.
 * `run-shell` — run the released modules and rebuild the withheld ones; the result is a hybrid and
 *   its number may not be attributed to the original system.
 * `rebuild` — no artifact; rebuild the mechanisms the paper names, and report the rebuild as a
 *   rebuild.
 * `cite` — no artifact and no mechanism; the claim may appear in a table with its date and source,
 *   and nowhere else.
 */
export const COPY_PLAN = ['run', 'run-shell', 'rebuild', 'cite'] as const;
export type CopyPlan = (typeof COPY_PLAN)[number];

/** One system, as its artifact permits it to be learned from. */
export interface IntakeClaim {
  readonly system: string;
  readonly status: IntakeStatus;
  /** The URL a reader opens to check the status. Required on every claim. */
  readonly evidence: string;
  /** When the evidence was last read, `YYYY-MM-DD`. A status is true of a date, not forever. */
  readonly checkedAt: string;
  readonly repo?: string;
  readonly commit?: string;
  readonly license?: string;
  /** `paper-only`: the identifier a reader can resolve. */
  readonly paper?: string;
  /** `paper-only`: the mechanisms the paper names, because a rebuild needs a list to tick off. */
  readonly mechanisms?: readonly string[];
  /** `partial`: the modules the repository actually contains. */
  readonly released?: readonly string[];
  /** `partial`: the modules that carry the score and are not in it. */
  readonly withheld?: readonly string[];
  /** `unreproducible`: why no artifact can exist. A blank reason is a shrug. */
  readonly reason?: string;
  readonly note?: string;
}

/** One thing wrong with a claim, or one thing a reader should know before trusting it. */
export interface IntakeProblem {
  readonly level: 'error' | 'warning';
  readonly system: string;
  readonly line: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const URL = /^https?:\/\/\S+$/;
const ARXIV = /^arXiv:\d{4}\.\d{4,5}$/;

/**
 * A licence the repository does not carry.
 *
 * This is a real value, not a missing one: MAC-SQL ships no licence file, so the code may be run
 * locally and may not be redistributed. Recording it as absent would fail the entry; recording it
 * as `none declared` keeps the distinction between "nobody wrote one" and "nobody looked".
 */
export const NO_LICENSE = 'none declared';

const text = (value: string | undefined): boolean => typeof value === 'string' && value.length > 0;

/**
 * Every check, as data, in the order the documentation lists the statuses.
 *
 * Data rather than a chain of `if`s for the reason `COORDINATE_CHECKS` gives: a status cannot be
 * added to the table without a rule here, and a test can name the rule it exercises.
 */
interface IntakeRule {
  readonly name: string;
  readonly check: (claim: IntakeClaim, today: string) => readonly IntakeProblem[];
}

const error = (claim: IntakeClaim, line: string): IntakeProblem => ({
  level: 'error',
  system: claim.system,
  line,
});

const warning = (claim: IntakeClaim, line: string): IntakeProblem => ({
  level: 'warning',
  system: claim.system,
  line,
});

export const INTAKE_RULES: readonly IntakeRule[] = [
  {
    name: 'status',
    check: (claim) =>
      INTAKE_STATUS.includes(claim.status)
        ? []
        : [error(claim, `status "${String(claim.status)}" is not one of ${INTAKE_STATUS.join(', ')}`)],
  },
  {
    name: 'evidence',
    check: (claim) =>
      URL.test(claim.evidence)
        ? []
        : [error(claim, `evidence "${claim.evidence}" is not a URL, so the status cannot be checked`)],
  },
  {
    name: 'checkedAt',
    check: (claim, today) => {
      if (!DATE.test(claim.checkedAt)) {
        return [error(claim, `checkedAt "${claim.checkedAt}" is not YYYY-MM-DD`)];
      }
      // A date in the future is a date nobody read, and a status dated by intent is the one kind
      // of claim this file exists to refuse.
      return claim.checkedAt > today
        ? [error(claim, `checkedAt ${claim.checkedAt} is after today (${today}), so nothing was read`)]
        : [];
    },
  },
  {
    name: 'released needs a version',
    check: (claim) => {
      if (claim.status !== 'released') return [];
      const out: IntakeProblem[] = [];
      if (!text(claim.repo)) out.push(error(claim, 'released: no repository, so there is nothing to check out'));
      if (claim.commit === undefined || !isPinnedCommit(claim.commit)) {
        out.push(
          error(
            claim,
            `released: commit "${String(claim.commit)}" is not a 40-character sha, so the code moves under the number`,
          ),
        );
      }
      if (!text(claim.license)) out.push(error(claim, 'released: no licence, so the copy cannot be shipped'));
      return out;
    },
  },
  {
    name: 'partial names both halves',
    check: (claim) => {
      if (claim.status !== 'partial') return [];
      const out: IntakeProblem[] = [];
      const released = claim.released ?? [];
      const withheld = claim.withheld ?? [];
      if (released.length === 0) {
        out.push(error(claim, 'partial: names no released module, so it is paper-only'));
      }
      // "Partially open" without a list of what is missing is the claim a reader cannot act on:
      // it invites running the repository and calling the result the system.
      if (withheld.length === 0) {
        out.push(error(claim, 'partial: names no withheld module, so a reader cannot tell what is missing'));
      }
      const overlap = released.filter((module) => withheld.includes(module));
      if (overlap.length > 0) {
        out.push(error(claim, `partial: ${overlap.join(', ')} is both released and withheld`));
      }
      if (!text(claim.repo)) out.push(error(claim, 'partial: no repository, so there is nothing to run'));
      if (claim.commit === undefined || !isPinnedCommit(claim.commit)) {
        out.push(error(claim, `partial: commit "${String(claim.commit)}" is not a 40-character sha`));
      }
      if (!text(claim.license)) out.push(error(claim, 'partial: no licence, so the released half cannot be shipped'));
      return out;
    },
  },
  {
    name: 'paper-only names a paper and its mechanisms',
    check: (claim) => {
      if (claim.status !== 'paper-only') return [];
      const out: IntakeProblem[] = [];
      if (!text(claim.paper)) {
        out.push(error(claim, 'paper-only: no paper, so there is nothing to rebuild from'));
      } else if (!ARXIV.test(claim.paper as string) && !URL.test(claim.paper as string)) {
        out.push(error(claim, `paper-only: paper "${claim.paper}" is neither arXiv:<id> nor a URL`));
      }
      // The mechanism list is the rebuild's checklist. An empty one turns "rebuild the paper" into
      // "invent a system and name it after the paper", which is a shape this repository has
      // already run once (`askdata-shape`) and cannot price against anything.
      if ((claim.mechanisms ?? []).length === 0) {
        out.push(error(claim, 'paper-only: names no mechanism, so a rebuild has no checklist'));
      }
      return out;
    },
  },
  {
    name: 'unreproducible names a reason',
    check: (claim) =>
      claim.status === 'unreproducible' && !text(claim.reason)
        ? [error(claim, 'unreproducible: no reason, which is indistinguishable from "not looked for"')]
        : [],
  },
  {
    name: 'a licence nobody wrote is a warning',
    check: (claim) =>
      claim.license === NO_LICENSE
        ? [warning(claim, 'licence is none declared: the code may be run locally and may not be redistributed')]
        : [],
  },
];

/** Every problem, errors and warnings, each naming the system and the rule it broke. */
export function intakeProblems(claims: readonly IntakeClaim[], today: string): readonly IntakeProblem[] {
  const out: IntakeProblem[] = [];
  const seen = new Set<string>();
  for (const claim of claims) {
    if (seen.has(claim.system)) {
      out.push(error(claim, `system "${claim.system}" appears twice, so which status wins is order`));
    }
    seen.add(claim.system);
    for (const rule of INTAKE_RULES) out.push(...rule.check(claim, today));
  }
  return out;
}

/** The errors, thrown together. Warnings are printed and do not stop a gate. */
export function assertIntake(claims: readonly IntakeClaim[], today: string): readonly IntakeClaim[] {
  const errors = intakeProblems(claims, today).filter((problem) => problem.level === 'error');
  if (errors.length > 0) {
    throw new Error(`intake refused:\n  ${errors.map((problem) => `${problem.system}: ${problem.line}`).join('\n  ')}`);
  }
  return claims;
}

/** What copying this system would produce, which is the only thing the status is for. */
export function copyPlan(claim: IntakeClaim): CopyPlan {
  switch (claim.status) {
    case 'released':
      return 'run';
    case 'partial':
      return 'run-shell';
    case 'paper-only':
      return 'rebuild';
    case 'unreproducible':
      return 'cite';
  }
}

/**
 * What to call the copy in a table.
 *
 * The distinction is not cosmetic: `run` may be plotted beside a run of this repository, and the
 * other three may not, because the number a rebuild produces contains its author.
 */
export const COPY_PLAN_LABEL: Readonly<Record<CopyPlan, string>> = {
  run: 'run their code',
  'run-shell': 'run the released half, rebuild the rest',
  rebuild: 'rebuild the paper’s mechanisms',
  cite: 'cite only',
};

/**
 * The claims that say `released` and have no pin, and the pins with no claim.
 *
 * Both directions matter. A released system that is not pinned is a round that has not been
 * scheduled — it is the cheapest kind of progress available, because the work is a checkout. A pin
 * with no claim is a run whose question was never written down, which is how a dispatch becomes a
 * number looking for a use.
 */
export function intakeGaps(
  claims: readonly IntakeClaim[],
  pins: Readonly<Record<string, { readonly repo: string; readonly commit: string }>>,
): { readonly unpinned: readonly string[]; readonly unclaimed: readonly string[] } {
  const pinnedRepos = new Set(Object.values(pins).map((pin) => pin.repo.toLowerCase()));
  const pinnedCommits = new Set(Object.values(pins).map((pin) => pin.commit));
  const unpinned = claims
    .filter((claim) => copyPlan(claim) === 'run')
    .filter((claim) => claim.repo === undefined || !pinnedRepos.has(claim.repo.toLowerCase()))
    .filter((claim) => claim.commit === undefined || !pinnedCommits.has(claim.commit))
    .map((claim) => claim.system);
  const claimed = new Set(claims.map((claim) => claim.repo?.toLowerCase()));
  const unclaimed = Object.entries(pins)
    .filter(([, pin]) => !claimed.has(pin.repo.toLowerCase()))
    .map(([name]) => name);
  return { unpinned, unclaimed };
}

/** The table, one line per system, in the order the file lists them. */
export function intakeLines(claims: readonly IntakeClaim[]): readonly string[] {
  if (claims.length === 0) return ['no systems: an intake with nothing in it prices nothing'];
  const out = ['| system | status | what copying it produces | as of |', '|---|---|---|---|'];
  for (const claim of claims) {
    const plan = copyPlan(claim);
    out.push(`| ${claim.system} | ${claim.status} | ${COPY_PLAN_LABEL[plan]} | ${claim.checkedAt} |`);
  }
  return out;
}

/** Reads the file, refusing the shapes that would silently become defaults. */
export function parseIntake(raw: unknown, source: string): readonly IntakeClaim[] {
  if (!Array.isArray(raw)) throw new Error(`${source} is not a list of systems`);
  if (raw.length === 0) throw new Error(`${source} is empty, so it declares no system`);
  return raw.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') throw new Error(`${source}[${String(index)}] is not an object`);
    const row = entry as Record<string, unknown>;
    const str = (key: string): string => {
      const value = row[key];
      if (typeof value !== 'string') throw new Error(`${source}[${String(index)}] is missing the ${key}`);
      return value;
    };
    const list = (key: string): readonly string[] | undefined => {
      const value = row[key];
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new Error(`${source}[${String(index)}].${key} is not a list of strings`);
      }
      return value as readonly string[];
    };
    return {
      system: str('system'),
      status: str('status') as IntakeStatus,
      evidence: str('evidence'),
      checkedAt: str('checkedAt'),
      repo: row.repo as string | undefined,
      commit: row.commit as string | undefined,
      license: row.license as string | undefined,
      paper: row.paper as string | undefined,
      mechanisms: list('mechanisms'),
      released: list('released'),
      withheld: list('withheld'),
      reason: row.reason as string | undefined,
      note: row.note as string | undefined,
    };
  });
}

/** Today, as a claim is dated by the day it is read. */
export function todayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function main(argv: readonly string[], root = process.cwd()): number {
  const claims = parseIntake(JSON.parse(readFileSync(join(root, 'eval/competitors/intake.json'), 'utf8')), 'intake.json');
  const pins = JSON.parse(readFileSync(join(root, 'eval/competitors/pins.json'), 'utf8')) as Record<
    string,
    { repo: string; commit: string }
  >;
  const today = todayOf(new Date());
  const problems = intakeProblems(claims, today);
  for (const line of intakeLines(claims)) console.log(line);
  for (const problem of problems) console.log(`${problem.level}: ${problem.system}: ${problem.line}`);
  const gaps = intakeGaps(claims, pins);
  if (gaps.unpinned.length > 0) console.log(`released and unpinned: ${gaps.unpinned.join(', ')}`);
  if (gaps.unclaimed.length > 0) console.log(`pinned with no claim: ${gaps.unclaimed.join(', ')}`);
  const errors = problems.filter((problem) => problem.level === 'error');
  if (errors.length > 0 && argv.includes('--strict')) return 1;
  return 0;
}

/**
 * Whether this module was started as a script rather than imported by the suite.
 *
 * Named so the branch can be tested: an entrypoint check that only ever runs in production is a
 * check whose false arm nobody has seen, and the false arm is the one that would `process.exit`
 * inside a test run.
 */
export function isEntrypoint(moduleUrl: string, argv1: string | undefined): boolean {
  return argv1 !== undefined && moduleUrl === pathToFileURL(argv1).href;
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
