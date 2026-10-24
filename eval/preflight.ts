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

const provider = createHttpProvider({ baseUrl, apiKey, model, retries: 1, timeoutMs: 30_000 });
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
  const elapsed = Date.now() - started;
  console.log(`preflight ok: ${baseUrl} ${model} answered in ${String(elapsed)} ms (${String(reply.text.length)} chars)`);
} catch (error) {
  const elapsed = Date.now() - started;
  const status = isNl2ChartsError(error) ? (error.details as { status?: number } | undefined)?.status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  // The endpoint and the status, never the key: this line ends up in a public log.
  console.error(
    `preflight failed after ${String(elapsed)} ms: ${baseUrl} ${model} ` +
      `${status === undefined ? '' : `answered ${String(status)}: `}${message}`,
  );
  process.exit(1);
}
