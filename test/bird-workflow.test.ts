/**
 * The artifact has to survive the run that failed.
 *
 * `40534288883` failed the floor gate and published nothing: the summary and upload steps
 * had no `if: always()`, so the only copy of the per-case rows and the McNemar p-values
 * went down with the runner. `bird-model.yml` and `ci.yml` were already fixed; `bird-dev.yml`
 * was not, which is the drift a per-file test catches and a reader does not.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('a benchmark workflow publishes what a failed run produced', () => {
  const workflows = ['.github/workflows/bird-dev.yml', '.github/workflows/bird-model.yml', '.github/workflows/ci.yml'];

  /** Step blocks of a workflow, split on the step indent so a block is one step. */
  function steps(file: string): string[] {
    return readFileSync(resolve(process.cwd(), file), 'utf8')
      .split(/\n {6}- /)
      .slice(1)
      .map((block) => block.split(/\n {6}(?=- )/)[0] as string);
  }

  it('summarises the run even when the accuracy gate failed', () => {
    for (const file of workflows) {
      const summary = steps(file).filter((block) => block.includes('name: Publish summary'));
      expect(summary.length, file).toBeGreaterThan(0);
      for (const block of summary) expect(block, file).toContain('if: always()');
    }
  });

  it('uploads the evaluation even when the accuracy gate failed', () => {
    for (const file of workflows) {
      const upload = steps(file).filter((block) => block.includes('upload-artifact'));
      expect(upload.length, file).toBeGreaterThan(0);
      for (const block of upload) expect(block, file).toContain('if: always()');
    }
  });

  it('states a missing artifact instead of failing the summary step on it', () => {
    // A summary step that crashes on an absent file replaces the real failure with a stack
    // trace from the reporter, in the one place a reader looks for the cause.
    for (const file of ['.github/workflows/bird-dev.yml', '.github/workflows/bird-model.yml']) {
      const block = steps(file).find((entry) => entry.includes('name: Publish summary')) as string;
      expect(block, file).toContain('if [ -f eval/out/bird-eval.json ]');
    }
  });
});

/**
 * The endpoint has to follow the provider.
 *
 * `41791956315` dispatched `select-balanced` with `second_provider=deepseek` and no endpoint,
 * so `BIRD_SECOND_API_KEY` became DeepSeek's secret while `BIRD_SECOND_BASE_URL` stayed on the
 * workflow's default — Zhipu's host. The preflight answered `401 令牌已过期或验证不正确` and the
 * run never reached a question: a valid key, a right model name, and an endpoint that belongs to
 * another vendor. The message blames an expired token, which is the one thing that was not wrong.
 *
 * Two inputs with independent defaults can disagree, so only one of them keeps a default. These
 * two assertions are what stops that from being undone: the endpoint is derived from the provider,
 * and the input that could override it starts empty.
 */
describe('the second endpoint follows the second provider', () => {
  const text = (): string => readFileSync(resolve(process.cwd(), '.github/workflows/bird-dev.yml'), 'utf8');

  it('derives the endpoint from the provider rather than defaulting to one vendor', () => {
    const line = text()
      .split('\n')
      .find((candidate) => candidate.trim().startsWith('BIRD_SECOND_BASE_URL:'));
    expect(line).toBeDefined();
    expect(line).toContain('inputs.second_provider');
    expect(line).toContain('https://api.deepseek.com/v1');
    expect(line).toContain('https://open.bigmodel.cn/api/paas/v4');
  });

  it('leaves the endpoint input empty so that the derivation is the default', () => {
    const block = text()
      .split('\n')
      .slice(text().split('\n').findIndex((candidate) => candidate.trim() === 'second_base_url:'))
      .slice(0, 4)
      .join('\n');
    expect(block).toContain("default: ''");
  });
});
