/**
 * One call, before the job.
 *
 * A full BIRD arm is 498 calls, and a provider that refuses all of them is discovered
 * five minutes into an arm that then has to be thrown away. This does the discovery in
 * one call: it prints the endpoint, the model and the status, and exits non-zero with
 * the provider's own message.
 *
 * It deliberately does not retry. The retry policy belongs to the provider used by the
 * run; here the question is "does this endpoint answer at all right now", and a retry
 * would blur that into "it answered eventually".
 *
 * The measurement is separated from the report so it can be run under test against a real
 * endpoint: this module used to be a script that called `process.exit` from inside itself,
 * and a script like that cannot be asked what it measured — only whether it exited.
 */
import { pathToFileURL } from 'node:url';
import { createHttpProvider } from '@agentix-e/nl2charts-ai';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';
import { describeError } from './errors.js';

export interface PreflightOptions {
  /** Required: the endpoint the run will use, passed in rather than defaulted to a URL a
   * test would then have to reach. Defaults live in `main`, where the environment is read. */
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly samples: number;
  readonly deadlineMs: number;
  /** Called once, with the first successful call. Absent means silent. */
  readonly log?: (line: string) => void;
}

export interface PreflightReport {
  readonly ok: boolean;
  readonly baseUrl: string;
  readonly model: string;
  readonly samples: number;
  readonly answered: number;
  readonly failures: number;
  readonly deadlineMs: number;
  readonly firstError: string;
  /** Undefined when no call answered, which is a different report from "slow". */
  readonly medianMs?: number;
  readonly worstMs?: number;
  /** Every reason this report is not `ok`, in the order a reader needs them. */
  readonly problems: readonly string[];
  /** The one-line summary, printed whether or not the report is ok. */
  readonly summary: string;
}

/**
 * A latency check, not a liveness check.
 *
 * One successful call says the endpoint answers; it does not say it answers within the deadline
 * the run will impose. A glm-4.5 run once spent 3h43m and 1,532 calls to discover that 41% of
 * them exceeded a 180-second deadline — a fact three timed calls would have shown in nine
 * minutes. The threshold is the run's own: a median above half the deadline leaves no headroom
 * for the tail, and the tail is what fills the failure column.
 */
export async function runPreflight(options: PreflightOptions): Promise<PreflightReport> {
  const { baseUrl, model, apiKey, deadlineMs } = options;
  const samples = Math.max(1, Math.floor(options.samples));

  // The deadline the run will use, not a comfortable one of its own: a preflight that passes
  // under a 30s deadline and hands the run a 60s one has measured a different instrument.
  const provider = createHttpProvider({ baseUrl, apiKey, model, retries: 1, timeoutMs: deadlineMs });

  const elapsed: number[] = [];
  let failures = 0;
  let firstError = '';
  for (let sample = 0; sample < samples; sample += 1) {
    const started = Date.now();
    try {
      const reply = await provider.complete({
        messages: [
          { role: 'system', content: 'Reply with the single word: ready.' },
          { role: 'user', content: 'ping' },
        ],
        temperature: 0,
        // No token cap. A reasoning model spends the budget thinking and returns an empty
        // answer with finish_reason=length, which a preflight would report as a broken
        // endpoint when the endpoint is fine.
      });
      elapsed.push(Date.now() - started);
      if (sample === 0) options.log?.(`preflight: ${baseUrl} ${model} answered (${String(reply.text.length)} chars)`);
    } catch (error) {
      failures += 1;
      const status = isNl2ChartsError(error) ? (error.details as { status?: number } | undefined)?.status : undefined;
      const message = describeError(error);
      if (firstError === '') firstError = `${status === undefined ? '' : `answered ${String(status)}: `}${message}`;
    }
  }

  const median = elapsed.length === 0 ? undefined : [...elapsed].sort((left, right) => left - right)[Math.floor(elapsed.length / 2)];
  const worst = elapsed.length === 0 ? undefined : Math.max(...elapsed);
  const summary =
    `preflight: ${String(samples)} calls to ${model} — ${String(samples - failures)} answered, ` +
    `median ${median === undefined ? 'n/a' : median.toFixed(0)} ms, worst ${worst === undefined ? 'n/a' : worst.toFixed(0)} ms, ` +
    `deadline ${String(deadlineMs)} ms`;
  // Reading a report should not require reading three fields: the problems are composed here,
  // where the numbers are, rather than at the call site where they would be paraphrased.
  const problems: string[] = [];
  if (failures > 0) {
    problems.push(`${String(failures)} of ${String(samples)} calls failed (first: ${firstError})`);
    problems.push("the endpoint did not answer every call within the run's deadline");
  }
  if (median !== undefined && median > deadlineMs / 2) {
    problems.push(
      `the median call takes ${median.toFixed(0)} ms against a ${String(deadlineMs)} ms deadline, ` +
        'so the tail will exceed it. Raise BIRD_LLM_TIMEOUT_MS, lower BIRD_CONCURRENCY, or use a faster model.',
    );
  }

  return {
    ok: problems.length === 0,
    baseUrl,
    model,
    samples,
    answered: samples - failures,
    failures,
    deadlineMs,
    firstError,
    ...(median === undefined ? {} : { medianMs: median }),
    ...(worst === undefined ? {} : { worstMs: worst }),
    problems,
    summary,
  };
}

/**
 * The command-line contract: read the environment, run, print, return an exit code.
 *
 * Returns the code instead of calling `process.exit` so the branch that matters most —
 * "no key at all" — is a value a test can read.
 */
/**
 * The four knobs, from the environment, with their defaults.
 *
 * Extracted because the defaults were the one part of this module no test could reach: a test
 * that pointed at a local endpoint never took the `??` side, and taking it would have meant
 * calling a public provider from a unit test. As values, they are assertable.
 */
export interface PreflightSettings {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly samples: number;
  readonly deadlineMs: number;
}

export function resolvePreflightSettings(env: NodeJS.ProcessEnv): PreflightSettings {
  return {
    baseUrl: env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    model: env.LLM_MODEL ?? 'deepseek-chat',
    apiKey: env.LLM_API_KEY ?? env.DEEPSEEK_API_KEY ?? '',
    samples: Number(env.BIRD_PREFLIGHT_SAMPLES ?? 3),
    deadlineMs: Number(env.BIRD_LLM_TIMEOUT_MS ?? 60_000),
  };
}

/** One endpoint, named, because a report that says "failed" without saying which is a riddle. */
export interface PreflightTarget {
  readonly role: 'primary' | 'second';
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

/**
 * Every endpoint the run will actually call.
 *
 * The second model exists only for the cross arms, and its endpoint is discovered the same
 * way `createProviders` discovers it: its own URL when it has one, the primary URL when it
 * does not. The fallback has to be identical in both places, or a run would preflight one
 * endpoint and call another.
 *
 * A `BIRD_SECOND_MODEL` with no key is returned as a target rather than skipped: the run
 * would draw candidates it cannot get, and a preflight that quietly checks only what it can
 * is the failure mode this function exists to remove.
 */
export function resolvePreflightTargets(env: NodeJS.ProcessEnv): PreflightTarget[] {
  const settings = resolvePreflightSettings(env);
  const targets: PreflightTarget[] = [
    { role: 'primary', baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey },
  ];
  const secondModel = env.BIRD_SECOND_MODEL ?? '';
  if (secondModel === '') return targets;
  targets.push({
    role: 'second',
    baseUrl: env.BIRD_SECOND_BASE_URL === undefined || env.BIRD_SECOND_BASE_URL === '' ? settings.baseUrl : env.BIRD_SECOND_BASE_URL,
    model: secondModel,
    apiKey: env.BIRD_SECOND_API_KEY ?? env.ZHIPU_API_KEY ?? '',
  });
  return targets;
}

/**
 * Why this target cannot be measured, or `null` when it can.
 *
 * A keyless target is not a measurement: the call would measure the endpoint's rejection of
 * an empty bearer token, which says nothing about the model. This is a function rather than
 * a branch inside `main` because `main` is only reachable through a child process, and v8
 * does not collect coverage across processes — the sentence would exist without ever being
 * read by a test (the same reason the module guard is the one permanently unread line).
 */
export function targetProblem(target: PreflightTarget): string | null {
  if (target.apiKey.length > 0) return null;
  const variable =
    target.role === 'second'
      ? 'BIRD_SECOND_API_KEY or ZHIPU_API_KEY'
      : 'LLM_API_KEY (preferred) or DEEPSEEK_API_KEY';
  return `no key for ${target.model}. Set ${variable}.`;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const settings = resolvePreflightSettings(env);
  if (settings.apiKey.length === 0) {
    console.error('preflight: no key. Set LLM_API_KEY (preferred) or DEEPSEEK_API_KEY.');
    return 1;
  }
  const targets = resolvePreflightTargets(env);
  const named = (target: PreflightTarget): string => `preflight[${target.role}]`;
  let failed = false;
  for (const target of targets) {
    const problem = targetProblem(target);
    if (problem !== null) {
      console.error(`${named(target)}: ${problem}`);
      failed = true;
      continue;
    }
    const report = await runPreflight({
      baseUrl: target.baseUrl,
      model: target.model,
      apiKey: target.apiKey,
      samples: settings.samples,
      deadlineMs: settings.deadlineMs,
      log: (line) => console.log(line),
    });
    if (!report.ok) {
      console.error(`${named(target)}: ${report.summary}; ${String(report.failures)} failed (first: ${report.firstError})`);
      for (const problem of report.problems) console.error(`${named(target)} failed: ${problem}`);
      failed = true;
      continue;
    }
    console.log(`${named(target)}: ${report.summary}`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main();
}
