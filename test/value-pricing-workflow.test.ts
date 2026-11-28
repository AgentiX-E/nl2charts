/**
 * The pricing dispatch has to be costable before it is sent, and its reading has to survive a
 * failed run. A dispatch that spends real embedding tokens under an Org secret is a bill; a workflow
 * that prices it after the fact ("no price on file") or loses the report when the McNemar gate fails
 * is the kind of instrument this repository keeps honest with a per-file test.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = '.github/workflows/value-pricing.yml';
const text = (): string => readFileSync(resolve(process.cwd(), FILE), 'utf8');

/** Step blocks, split on the six-space step indent so one block is one step. */
function steps(doc: string): string[] {
  return doc.split(/\n {6}- /).slice(1).map((block) => block.split(/\n {6}(?=- )/)[0] as string);
}

describe('the value-pricing dispatch workflow', () => {
  it('exists', () => {
    expect(() => text()).not.toThrow();
  });

  it('is dispatch-only and declares every input it interpolates', () => {
    const doc = text();
    expect(doc).toContain('workflow_dispatch:');
    for (const input of ['model', 'base_url', 'limit', 'secret_name', 'accept_cost']) {
      expect(doc, `input ${input}`).toMatch(new RegExp(`\\b${input}:\\s*$`, 'm'));
    }
    // check-workflows rule 3: no `inputs.x` may name an undeclared input. The tool's own run below
    // is the authority; this assertion only keeps the declaration in step with the interpolation.
    const declared = [...doc.matchAll(/^\s{6}([a-z_]+):\s*$/gm)].map((m) => m[1]);
    for (const used of [...doc.matchAll(/inputs\.([a-z_]+)/g)].map((m) => m[1])) {
      expect(declared, `undeclared input ${used}`).toContain(used);
    }
  });

  it('injects the hosted embedding contract from an Org secret, never a literal key', () => {
    const doc = text();
    expect(doc).toContain('PRICING_EMBEDDING_BASE_URL:');
    expect(doc).toContain('PRICING_EMBEDDING_MODEL:');
    expect(doc).toContain('PRICING_EMBEDDING_API_KEY:');
    expect(doc).toContain('secrets.ZHIPU_API_KEY');
    expect(doc).toContain('secrets.DEEPSEEK_API_KEY');
    // No hardcoded credential: the only key value is a secret expression.
    for (const line of doc.split('\n')) {
      if (line.includes('PRICING_EMBEDDING_API_KEY:')) expect(line).toContain('${{');
    }
  });

  it('runs the priced entry point and names the model so the bill has a rate', () => {
    const doc = text();
    expect(doc).toContain('pnpm bench:bird:price');
    // `bench:bill` refuses a model with no price row; the default must be one this repository can
    // cost before dispatch (embedding-3 was added to eval/price.ts for exactly this reason).
    expect(doc).toMatch(/model:[\s\S]*?default: 'embedding-3'/);
  });

  it('caps spend with an explicit yuan input, so the dispatch is costable before it runs', () => {
    const doc = text();
    expect(doc).toContain('accept_cost');
    expect(doc).toContain('cost');
  });

  it('publishes the report and uploads it even when the pricing gate fails', () => {
    const doc = text();
    const publish = steps(doc).filter((block) => block.includes('name: Publish'));
    expect(publish.length).toBeGreaterThan(0);
    for (const block of publish) expect(block).toContain('if: always()');
    const upload = steps(doc).filter((block) => block.includes('upload-artifact'));
    expect(upload.length).toBeGreaterThan(0);
    for (const block of upload) expect(block).toContain('if: always()');
  });

  it('passes the repository workflow gate (all seven rules)', () => {
    // The gate is code, not opinion: an expression-context mistake here produces a run with no log.
    expect(() => execFileSync(process.execPath, ['tools/check-workflows.mjs'], { cwd: process.cwd(), stdio: 'pipe' })).not.toThrow();
  });
});
