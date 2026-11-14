/**
 * The card-level override a mixed arm applies to every one of its candidates.
 *
 * `select-mixed-rule` sends three prompts and each of them arrives on its own source's card. The
 * value block was measured as a *single-prompt* lever (`inline+evidence+samples-wide-link`, +1.50pp
 * on dev for +9.17% prompt tokens), and the arm that ships is the three-candidate one — so the
 * question the product needs answered is whether the block still pays when it is paid three times,
 * once per candidate, on a pool that already has three chances to be right.
 *
 * That is one lever and one arm: the sources stay what they are, and every candidate's card gets
 * the same sampler and the same narrowing rule. The alternative — naming three pre-sampled arms as
 * the sources — would have been a second catalogue of arms whose only difference from their parents
 * is a card, and the arm table is already a coordinate system rather than a shopping list.
 *
 * Why the override lives on the mixed arm instead of in the source list: a source is a prompt, and
 * the prompt is not what changes here. `sourceLinking` and `sourceRepairs` are the same idea one
 * layer down (they override a source's linker and its repair count), and this is the third of them.
 * A source that already samples its own card is refused rather than overridden — silently replacing
 * a declaration is how a reading becomes about the override instead of about the lever.
 */
import { describe, expect, it } from 'vitest';
import {
  ARMS,
  MIXED_SOURCES,
  assertSourceSampleRule,
  parseMixedSource,
  resolveArm,
  resolveSource,
  withSourceSamples,
} from '../eval/bird/run.js';
import type { Arm } from '../eval/bird/run.js';

const NARROW = 'select-mixed-rule-narrow';

const source = (): Arm => resolveArm('inline+evidence') as Arm;

describe('a sampler every candidate inherits', () => {
  it('returns the source itself when the arm overrides nothing', () => {
    // Identity, not a copy: an arm with no override has to hand the pipeline the very object the
    // catalogue holds, or a later comparison of "which arm answered" would compare two shapes.
    const arm = source();
    expect(withSourceSamples(arm, undefined)).toBe(arm);
  });

  it('changes the sampler and the narrowing rule, and nothing else', () => {
    // The pair rule, applied to the derived arm: an override that also moved the linker, the
    // definitions or the evidence would make the G1c delta a reading about the wrong thing.
    const arm = source();
    const derived = withSourceSamples(arm, { samples: 'example', sampleColumns: 'link' });
    const { samples: _leftSamples, sampleColumns: _leftRule, ...restDerived } = derived;
    const { samples: _rightSamples, sampleColumns: _rightRule, ...restSource } = arm;
    expect(restDerived).toEqual(restSource);
    expect(derived.samples).toBe('example');
    expect(derived.sampleColumns).toBe('link');
  });

  it('keeps the name, because the name is what the artifact files a candidate under', () => {
    // The candidate's `source` in a case row is the source string, and `sentCards` is keyed by arm
    // name; a derived arm that renamed itself would be a second key for one card.
    expect(withSourceSamples(source(), { samples: 'profile' }).name).toBe('inline+evidence');
  });

  it('leaves the narrowing rule absent when the override declares only a sampler', () => {
    const derived = withSourceSamples(source(), { samples: 'profile' });
    expect(derived.samples).toBe('profile');
    expect(derived.sampleColumns).toBeUndefined();
  });
});

describe('resolving a candidate source', () => {
  it('overrides the source it resolves', () => {
    const arm = resolveArm(NARROW) as Arm;
    const resolved = resolveSource(arm, 'metadata+evidence');
    expect(resolved.provider).toBe('primary');
    expect(resolved.name).toBe('metadata+evidence');
    expect(resolved.arm.name).toBe('metadata+evidence');
    expect(resolved.arm.samples).toBe('example');
    expect(resolved.arm.sampleColumns).toBe('link');
  });

  it('reads the model off the source string, and the override off the arm', () => {
    // `@second` is the only thing in the source string that is not an arm name, and the override
    // belongs to the arm that bought the candidates rather than to the model that writes one.
    const arm = resolveArm(NARROW) as Arm;
    const resolved = resolveSource(arm, 'values@second');
    expect(resolved.provider).toBe('second');
    expect(resolved.arm.name).toBe('values');
    expect(resolved.arm.samples).toBe('example');
    expect(parseMixedSource('values@second').arm).toBe(resolved.arm.name);
  });

  it('hands back the plain source on an arm with no override', () => {
    const parent = resolveArm('select-mixed-rule') as Arm;
    const resolved = resolveSource(parent, 'values');
    expect(resolved.arm).toBe(resolveArm('values'));
    expect(resolved.arm.samples).toBeUndefined();
  });

  it('refuses a source that names no arm', () => {
    const arm = resolveArm(NARROW) as Arm;
    expect(() => resolveSource(arm, 'no-such-arm')).toThrow(/no arm/i);
  });
});

describe('a candidate override that would be silent', () => {
  it('refuses an arm that draws no candidates', () => {
    // On an arm with no source list there is nothing to inherit the override, and the run would
    // send the plain card while the arm's name promised a block.
    expect(() => assertSourceSampleRule({ name: 'x', sourceSamples: { samples: 'example' } })).toThrow(/draws no candidates/);
  });

  it('refuses an arm that also samples its own card', () => {
    expect(() =>
      assertSourceSampleRule({ name: 'x', mixed: MIXED_SOURCES, samples: 'profile', sourceSamples: { samples: 'example' } }),
    ).toThrow(/its own card/);
  });

  it('refuses a source whose own card already carries a sampler', () => {
    // `inline+evidence+samples` is a real arm with a real sampler, and overriding it would publish
    // the override's reading under the source's name — the defect `sourceLinking` documents about
    // two sources sharing one prompt shape.
    expect(() =>
      assertSourceSampleRule({ name: 'x', mixed: ['inline+evidence+samples'], sourceSamples: { samples: 'example' } }),
    ).toThrow(/already carries a sampler/);
  });

  it('accepts the shipping arm and every source it draws', () => {
    const arm = resolveArm(NARROW) as Arm;
    expect(() => assertSourceSampleRule(arm)).not.toThrow();
  });

  it('accepts an arm that declares nothing, and one that overrides a clean source', () => {
    expect(() => assertSourceSampleRule({ name: 'x' })).not.toThrow();
    expect(() => assertSourceSampleRule({ name: 'x', mixed: MIXED_SOURCES, sourceSamples: { samples: 'profile' } })).not.toThrow();
  });
});

describe('the arm that inherits the block', () => {
  it('is the shipping arm with one field added', () => {
    const parent = resolveArm('select-mixed-rule') as Arm;
    const arm = resolveArm(NARROW) as Arm;
    expect(arm.vote).toBe(parent.vote);
    expect(arm.mixed).toEqual(parent.mixed);
    expect(arm.selectRule).toBe(parent.selectRule);
    expect(arm.select).toBe(parent.select);
    expect(arm.sourceSamples).toEqual({ samples: 'example', sampleColumns: 'link' });
    expect(parent.sourceSamples).toBeUndefined();
  });

  it('gives the block to every source, one card each', () => {
    // The lever is "every candidate", so the assertion is over the source list rather than over a
    // sample of it: a source left out would make the arm's cost claim wrong in the cheap direction.
    const arm = resolveArm(NARROW) as Arm;
    expect(arm.mixed).toEqual(MIXED_SOURCES);
    for (const name of MIXED_SOURCES) {
      const resolved = resolveSource(arm, name);
      expect(resolved.arm.samples, name).toBe('example');
      expect(resolved.arm.sampleColumns, name).toBe('link');
    }
  });

  it('is the only arm in the catalogue that overrides a candidate card', () => {
    const overriding = ARMS.filter((arm) => arm.sourceSamples !== undefined);
    expect(overriding.map((arm) => arm.name)).toEqual([NARROW]);
  });

  it('holds the declaration rule for every arm in the catalogue', () => {
    for (const arm of ARMS) assertSourceSampleRule(arm);
  });
});
