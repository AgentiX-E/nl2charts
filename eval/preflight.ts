/**
 * One call, before the job.
 *
 * A full BIRD arm is 500 calls, and a provider that refuses all of them is discovered
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
      const message = error instanceof Error ? error.message : String(error);
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
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const apiKey = env.LLM_API_KEY ?? env.DEEPSEEK_API_KEY ?? '';
  if (apiKey.length === 0) {
    console.error('preflight: no key. Set LLM_API_KEY (preferred) or DEEPSEEK_API_KEY.');
    return 1;
  }
  const report = await runPreflight({
    baseUrl: env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    model: env.LLM_MODEL ?? 'deepseek-chat',
    apiKey,
    samples: Number(env.BIRD_PREFLIGHT_SAMPLES ?? 3),
    deadlineMs: Number(env.BIRD_LLM_TIMEOUT_MS ?? 60_000),
    log: (line) => console.log(line),
  });
  if (!report.ok) {
    console.error(`${report.summary}; ${String(report.failures)} failed (first: ${report.firstError})`);
    for (const problem of report.problems) console.error(`preflight failed: ${problem}`);
    return 1;
  }
  console.log(report.summary);
  return 0;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main();
}
