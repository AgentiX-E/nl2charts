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
import { DEFAULT_ARMS } from '../eval/bird/run.js';
import { RETIRED } from '../eval/bird/spend.js';
import { PRICES } from '../eval/price.js';

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
 *
 * The chart half has the same two inputs and had the same defect, which is why this reads both files
 * rather than the one the failure came from: `text2vis-llm.yml` pair a second model with
 * `ZHIPU_API_KEY` and a default endpoint of Zhipu's host, so a dispatch that named two DeepSeek
 * models — `deepseek-chat,deepseek-reasoner`, the strong-against-weak reading on one corpus — would
 * have sent DeepSeek's model name to Zhipu's host with Zhipu's key. Same failure, same silence, and
 * the reading it was meant to produce is the one that decides whether a reasoning model is worth
 * the deliberation it bills for.
 */
describe('the second endpoint follows the second provider', () => {
  const workflows = [
    { file: '.github/workflows/bird-dev.yml', url: 'BIRD_SECOND_BASE_URL', key: 'BIRD_SECOND_API_KEY' },
    { file: '.github/workflows/text2vis-llm.yml', url: 'TEXT2VIS_SECOND_BASE_URL', key: 'TEXT2VIS_SECOND_API_KEY' },
  ] as const;

  it.each(workflows)('derives the endpoint and the key from the provider ($file)', ({ file, url, key }) => {
    const lines = readFileSync(resolve(process.cwd(), file), 'utf8').split('\n');
    const urlLine = lines.find((candidate) => candidate.trim().startsWith(`${url}:`));
    expect(urlLine, `${file} declares no ${url}`).toBeDefined();
    expect(urlLine).toContain('inputs.second_provider');
    expect(urlLine).toContain('https://api.deepseek.com/v1');
    expect(urlLine).toContain('https://open.bigmodel.cn/api/paas/v4');
    // A key chosen by anything but the provider is the other half of the same 401: a DeepSeek model
    // with a Zhipu key on DeepSeek's host reads as an expired token, which is the one thing that is
    // not wrong.
    const keyLine = lines.find((candidate) => candidate.trim().startsWith(`${key}:`));
    expect(keyLine, `${file} declares no ${key}`).toBeDefined();
    expect(keyLine).toContain('inputs.second_provider');
    expect(keyLine).toContain('secrets.DEEPSEEK_API_KEY');
    expect(keyLine).toContain('secrets.ZHIPU_API_KEY');
  });

  it.each(workflows)('leaves the endpoint input empty so that the derivation is the default ($file)', ({ file }) => {
    const lines = readFileSync(resolve(process.cwd(), file), 'utf8').split('\n');
    const start = lines.findIndex((candidate) => candidate.trim() === 'second_base_url:');
    expect(start, `${file} declares no second_base_url input`).toBeGreaterThan(-1);
    // The input's own block, delimited by the next key at the same indent rather than by a line
    // count: the property is the default, and a fixed window makes the test a length limit on the
    // comment that explains the default.
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => line.trim() !== '' && /^ {6}[a-z_]+:/u.test(line));
    const block = rest.slice(0, end === -1 ? rest.length : end).join('\n');
    expect(block).toContain("default: ''");
  });
});

/**
 * A dispatch whose model has no price row cannot be costed, and a dispatch that cannot be costed
 * cannot be decided.
 *
 * `bird-model.yml` defaulted to `glm-4.5` for three months. The provider's price page does not list
 * that name — only GLM-4.5-Air and GLM-4.5V — so every dispatch of the default reached `bench:bill`
 * as "no price on file", which is the same sentence that let the `deepseek-v4-pro` run be read as
 * roughly free until its invoice arrived. The fix is not a fabricated row: it is a default the table
 * holds, and this test is what keeps the two files agreeing.
 */
describe('the model a dispatch starts from', () => {
  const WORKFLOWS = [
    '.github/workflows/bird-dev.yml',
    '.github/workflows/bird-model.yml',
    '.github/workflows/text2vis-llm.yml',
    '.github/workflows/text2vis-judge.yml',
  ];

  /**
   * Every model a workflow dispatches when nobody overrides it.
   *
   * Two places, because the fallback lives in two. An input's `default:` is the obvious one; the
   * other is the `|| '…'` of the env expression that turns a blank input into a name, and
   * `bird-dev.yml` uses exactly that form — its `default: ''` is deliberate, so a reader of the
   * `default:` line alone sees no model at all.
   */
  function defaultsOf(file: string): string[] {
    const text = readFileSync(resolve(process.cwd(), file), 'utf8');
    const names = new Set<string>();
    const lines = text.split('\n');
    const at = lines.findIndex((line) => /^ {6}models?:$/u.test(line));
    if (at === -1) throw new Error(`${file} declares no model input, so this test is reading nothing`);
    for (const line of lines.slice(at + 1)) {
      if (/^ {6}[a-z_]+:\s*$/u.test(line)) break;
      const found = /^ {8}default: '([^']*)'/u.exec(line);
      if (found === null) continue;
      for (const name of (found[1] as string).split(',')) if (name.trim() !== '') names.add(name.trim());
      break;
    }
    for (const line of lines) {
      if (!/^\s+(?:LLM_MODEL|TEXT2VIS_LLM_MODELS):/u.test(line)) continue;
      // A name, not a quoted fragment: `inputs.model != '' && inputs.model || 'deepseek-chat'` has
      // three quote pairs, and only the one that holds a model name is the fallback. The class
      // excludes spaces and `|`, which is what the two empty sides of the expression contain.
      for (const found of line.matchAll(/'([A-Za-z0-9][A-Za-z0-9._-]*)'/gu)) names.add(found[1] as string);
    }
    return [...names];
  }

  it('names a model the price table holds, so the run can be costed before it is paid for', () => {
    for (const file of WORKFLOWS) {
      const models = defaultsOf(file);
      expect(models.length, `${file} names no default model`).toBeGreaterThan(0);
      for (const model of models) {
        expect(PRICES[model], `${file} defaults to ${model}, which eval/price.ts cannot bill`).toBeDefined();
        expect(RETIRED[model], `${file} defaults to ${model}, which is retired`).toBeUndefined();
      }
    }
  });

  it('reads a quoted literal out of every model input, so the parse above is not blind', () => {
    // A regex that matched nothing would pass every assertion above while checking nothing, which is
    // how a guard becomes decoration. Each of these four names a model in one of the two forms.
    expect(defaultsOf('.github/workflows/bird-dev.yml')).toEqual(['deepseek-chat']);
    expect(defaultsOf('.github/workflows/bird-model.yml')).toEqual(['glm-4.5-air']);
    expect(defaultsOf('.github/workflows/text2vis-llm.yml')).toEqual(['deepseek-chat']);
    expect(defaultsOf('.github/workflows/text2vis-judge.yml')).toEqual(['glm-4.6v']);
  });
});

/**
 * An input that is declared and never read is a switch that does nothing, and one that is read and
 * never declared expands to an empty string.
 *
 * Both failures are silent in a workflow: `${{ inputs.budget_milliseconds }}` on a typo becomes the
 * empty string, `parseBudgetMs('')` becomes "no budget", and the run proceeds without the guard the
 * caller asked for. The same slip in the other direction leaves a documented input that no step
 * touches, which a caller will set and then wonder about. Neither is visible in a log, so this reads
 * the file instead: every reference has a declaration and every declaration has a reference.
 */
describe('every workflow input is declared, and every declaration is read', () => {
  /** The keys directly under `inputs:`, found by indentation rather than by a YAML library. */
  function declaredInputs(text: string): string[] {
    const lines = text.split('\n');
    const start = lines.findIndex((line) => line.trim() === 'inputs:');
    if (start === -1) return [];
    const indent = (lines[start] as string).search(/\S/);
    const names: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === '') continue;
      const own = line.search(/\S/);
      if (own <= indent) break;
      const match = /^ {6}([a-z_]+):\s*$/.exec(line);
      if (match !== null) names.push(match[1] as string);
    }
    return names;
  }

  const files = ['.github/workflows/bird-model.yml', '.github/workflows/text2vis-llm.yml'];

  it('reads only names it declares', () => {
    for (const file of files) {
      const text = readFileSync(resolve(process.cwd(), file), 'utf8');
      const declared = new Set(declaredInputs(text));
      const used = new Set([...text.matchAll(/inputs\.([a-z_]+)/gu)].map((match) => match[1] as string));
      expect(declared.size, file).toBeGreaterThan(0);
      for (const name of used) expect(declared.has(name), `${file} reads inputs.${name} without declaring it`).toBe(true);
    }
  });

  it('declares only names a step reads', () => {
    for (const file of files) {
      const text = readFileSync(resolve(process.cwd(), file), 'utf8');
      const used = new Set([...text.matchAll(/inputs\.([a-z_]+)/gu)].map((match) => match[1] as string));
      for (const name of declaredInputs(text)) {
        expect(used.has(name), `${file} declares input ${name} and no step reads it`).toBe(true);
      }
    }
  });

  it('gives the run a clock below the job cap, because a cap cannot report', () => {
    // `42666720439` ran into `timeout-minutes: 300` and was cancelled with nothing to show. The
    // budget has to arrive first, or the only thing that stops the run is the thing that cannot say
    // how far it got.
    const text = readFileSync(resolve(process.cwd(), '.github/workflows/bird-model.yml'), 'utf8');
    const cap = Number(/timeout-minutes:\s*(\d+)/u.exec(text)?.[1]);
    const budget = Number(/budget_ms:[\s\S]*?default:\s*'(\d+)'/u.exec(text)?.[1]);
    expect(cap).toBeGreaterThan(0);
    expect(budget).toBeGreaterThan(0);
    // Per arm, and the A/A arm is another arm: the comparison is against the cap divided by two.
    expect(budget / 60_000).toBeLessThan(cap / 2);
  });
});

describe('a workflow step reads an arm the chain actually runs', () => {
  const files = ['.github/workflows/ci.yml', '.github/workflows/bird-dev.yml', '.github/workflows/bird-model.yml'];

  /**
   * Every `--arm <name>` a workflow passes, with the step it sits in.
   *
   * `ci.yml` reads the artifact its own Min-Dev job produces, and that job runs `DEFAULT_ARMS`.
   * A step naming any other arm fails on every push with "no arm X" — which is what happened when
   * the audit turn left the chain on its own dev reading and one step here kept asking for it. The
   * arm was still defined, and still runnable by hand, so nothing that checks *arms* could see it:
   * the arm existed, the artifact did not contain it. The only set that matters is the chain's.
   */
  function armArguments(file: string): { readonly arm: string; readonly step: string }[] {
    const text = readFileSync(resolve(process.cwd(), file), 'utf8');
    const found: { arm: string; step: string }[] = [];
    for (const block of text.split(/\n {6}- /).slice(1)) {
      const step = block.split(/\n {6}(?=- )/)[0] as string;
      for (const match of step.matchAll(/--arm\s+([a-z0-9+_-]+)/gi)) found.push({ arm: match[1] as string, step });
    }
    return found;
  }

  it('passes only arms the default chain runs', () => {
    for (const file of files) {
      for (const entry of armArguments(file)) {
        expect(DEFAULT_ARMS, `${file}: --arm ${entry.arm}`).toContain(entry.arm);
      }
    }
  });

  it('finds the arm arguments it is meant to check', () => {
    // A parser that silently matched nothing would pass the check above on any workflow at all.
    const found = files.flatMap((file) => armArguments(file));
    expect(found.length).toBeGreaterThan(0);
  });
});
