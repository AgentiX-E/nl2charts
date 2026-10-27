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
 */
import { createHttpProvider } from '@agentix-e/nl2charts-ai';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';

const baseUrl = process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1';
const model = process.env.LLM_MODEL ?? 'deepseek-chat';
const apiKey = process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? '';

if (apiKey.length === 0) {
  console.error('preflight: no key. Set LLM_API_KEY (preferred) or DEEPSEEK_API_KEY.');
  process.exit(1);
}

const deadline = Number(process.env.BIRD_LLM_TIMEOUT_MS ?? 60_000);
const samples = Number(process.env.BIRD_PREFLIGHT_SAMPLES ?? 3);

// The deadline the run will use, not a comfortable one of its own: a preflight that passes
// under a 30s deadline and hands the run a 60s one has measured a different instrument.
const provider = createHttpProvider({ baseUrl, apiKey, model, retries: 1, timeoutMs: deadline });

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
    if (sample === 0) console.log(`preflight: ${baseUrl} ${model} answered (${String(reply.text.length)} chars)`);
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
  `deadline ${String(deadline)} ms`;

/**
 * A latency check, not a liveness check.
 *
 * One successful call says the endpoint answers; it does not say it answers within the deadline
 * the run will impose. A glm-4.5 run once spent 3h43m and 1,532 calls to discover that 41% of
 * them exceeded a 180-second deadline — a fact three timed calls would have shown in nine
 * minutes. The threshold is the run's own: a median above half the deadline leaves no headroom
 * for the tail, and the tail is what fills the failure column.
 */
if (failures > 0) {
  console.error(`${summary}; ${String(failures)} failed (first: ${firstError})`);
  console.error('preflight failed: the endpoint did not answer every call within the run\'s deadline.');
  process.exit(1);
}
console.log(summary);
if (median !== undefined && median > deadline / 2) {
  console.error(
    `preflight failed: the median call takes ${median.toFixed(0)} ms against a ${String(deadline)} ms deadline, ` +
      'so the tail will exceed it. Raise BIRD_LLM_TIMEOUT_MS, lower BIRD_CONCURRENCY, or use a faster model.',
  );
  process.exit(1);
}
