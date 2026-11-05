/**
 * The pins, the patches and the workflow have to agree before a dispatch can spend a call.
 *
 * A pin is four things that can drift apart: a commit, an adapter patch written against that
 * commit, a runner script that invokes the entrypoint, and an option in the dispatch menu. Three of
 * the four are silent when they disagree — a patch that applies to an older tree applies to the
 * wrong one, a script that names a different entrypoint fails after the install, and a pin with no
 * option in the menu is unreachable. So the four are checked against each other here rather than
 * discovered one dispatch at a time.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPins } from '../eval/competitors/probe.js';
import { isPinnedCommit } from '../eval/competitors/coordinates.js';

const ROOT = process.cwd();
const PINS = join(ROOT, 'eval/competitors/pins.json');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/competitors.yml'), 'utf8');
const pins = readPins(PINS);
const names = Object.keys(pins);

describe('every pin is a version, not a moving target', () => {
  it('names a full sha and the date it was committed', () => {
    for (const [name, pin] of Object.entries(pins)) {
      expect(isPinnedCommit(pin.commit), name).toBe(true);
      expect(pin.committedAt, name).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(pin.repo, name).toMatch(/^[\w.-]+\/[\w.-]+$/);
    }
  });

  it('pins two different repositories, so one cannot stand in for the other', () => {
    expect(new Set(Object.values(pins).map((pin) => pin.repo)).size).toBe(names.length);
  });

  it('says what licence the code carries, because a pin that is not permissively licensed may not be vendored', () => {
    for (const [name, pin] of Object.entries(pins)) expect(pin.license, name).toBeTruthy();
  });
});

describe('every pin ships the four things a dispatch needs', () => {
  it.each(names)('%s carries an entrypoint, a requirements file and a model hook', (name) => {
    const pin = pins[name]!;
    expect(pin.entrypoint).toBeTruthy();
    expect(pin.requirements).toBeTruthy();
    expect(pin.modelHook).toBeTruthy();
  });

  it.each(names)('%s has an adapter patch that is in this repository', (name) => {
    const patch = pins[name]!.patch;
    expect(patch).toBeTruthy();
    expect(existsSync(join(ROOT, patch!)), patch).toBe(true);
  });

  it.each(names)('%s has a patch whose header names the commit it was written against', (name) => {
    const pin = pins[name]!;
    const text = readFileSync(join(ROOT, pin.patch!), 'utf8');
    // The header is where a reader looks before trusting the patch, so the sha is in it. A patch
    // regenerated against a newer commit without the header changing is the failure this catches.
    expect(text).toContain(pin.commit);
    expect(text).toMatch(/^diff --git /mu);
  });

  it.each(names)('%s has a runner script, and the menu offers it', (name) => {
    const script = join(ROOT, '.github/competitors', `${name}.sh`);
    expect(existsSync(script), script).toBe(true);
    const body = readFileSync(script, 'utf8');
    // A script that does not set this writes a partial file and exits zero, which reads as a run.
    expect(body).toContain('set -euo pipefail');
    // The dispatch menu and the pins file are two lists of the same thing.
    expect(WORKFLOW).toContain(`- ${name}`);
  });

  it('offers nothing in the competitor menu that is not pinned', () => {
    // The menu's second input is the stage, whose options are `probe` and `full` rather than
    // repositories; only the block under `competitor:` is a list of pins.
    const block = WORKFLOW.slice(WORKFLOW.indexOf('competitor:'), WORKFLOW.indexOf('stage:'));
    const offered = [...block.matchAll(/^\s+- ([\w-]+)\s*$/gmu)].map((match) => match[1]);
    expect(offered.length).toBeGreaterThan(0);
    for (const option of offered) expect(names, option).toContain(option);
  });
});

describe('the pin says how its predictions name questions', () => {
  it.each(names)('%s declares a numbering', (name) => {
    expect(['question-id', 'position'], name).toContain(pins[name]!.numbering);
  });

  it('records one of each, because the map only earns its place if some pipeline needs it', () => {
    const values = Object.values(pins).map((pin) => pin.numbering);
    expect(values).toContain('position');
    expect(values).toContain('question-id');
  });

  it('hands the scorer the map, and decides that from the same field the pin declares', () => {
    // The score step reads `numbering` rather than naming a competitor: a pipeline that renumbers
    // without a map scores every statement as an unknown id, and a pipeline that does not renumber
    // but is given one has its ids reinterpreted as rows. Both are silent without this.
    expect(WORKFLOW).toContain('pins.json")[process.env.COMPETITOR].numbering');
    expect(WORKFLOW).toContain('--id-map');
  });
});

describe('the workflow scores with our instruments, not theirs', () => {
  it('hands the scoring step our coordinates file and our effect', () => {
    expect(WORKFLOW).toContain('eval/competitors/score.ts');
    expect(WORKFLOW).toContain('-coordinates');
    expect(WORKFLOW).toContain('--effect');
  });

  it('runs its own arm on the same subset before scoring a competitor', () => {
    // Without our own rows there is nothing to pair against, and `score.ts` refuses a report that
    // does not hold the arm — so the workflow has to produce one.
    const subset = WORKFLOW.indexOf('subset.ts');
    const ours = WORKFLOW.indexOf('pnpm bench:bird');
    const score = WORKFLOW.indexOf('eval/competitors/score.ts');
    expect(subset).toBeGreaterThan(-1);
    expect(ours).toBeGreaterThan(subset);
    expect(score).toBeGreaterThan(ours);
  });

  it('declares the coordinates rather than letting the scorer fill them in', () => {
    expect(WORKFLOW).toContain('judge: "judgeOfficial"');
    expect(WORKFLOW).toContain('executor: "eval/bird/oracle.py"');
    expect(WORKFLOW).toContain('prompt: "competitor"');
  });

  it('never masks a failing step', () => {
    // The repository's rule: no `|| true`, no `continue-on-error`. A comparison that ran on a
    // half-installed pipeline is worse than one that did not run.
    expect(WORKFLOW).not.toMatch(/\|\|\s*true/);
    expect(WORKFLOW).not.toMatch(/continue-on-error/);
  });
});

/**
 * The split is a coordinate, and every part of the run has to read it from the dispatch.
 *
 * The comparison this repository actually needs is the one that isolates the *pipeline*, and the
 * contradiction it has to explain is a sign: on Mini-Dev the competitor leads by 4.84pp, and on
 * dev our own published row leads by four. Both cannot be about method. The only way to test
 * which is to run the same pair on the other split — which is impossible if any part of the
 * harness has a split baked into it. Four places had one: the workflow's environment, its cache
 * key, and the dataset path in each runner script.
 */
describe('the split is a coordinate, not a constant', () => {
  /** The options offered under one input block, read the way the menu test reads them. */
  const optionsOf = (input: string): string[] => {
    const at = WORKFLOW.indexOf(`      ${input}:`);
    expect(at, input).toBeGreaterThan(-1);
    const block = WORKFLOW.slice(at, WORKFLOW.indexOf('permissions:', at));
    return [...block.matchAll(/^\s{10}- ([\w-]+)\s*$/gmu)].map((match) => match[1] as string);
  };

  it('offers both splits, and passes the chosen one to the runner', () => {
    expect(optionsOf('split')).toEqual(['minidev', 'dev']);
    expect(WORKFLOW).toContain('BIRD_SPLIT: ${{ inputs.split }}');
  });

  it('keys the dataset cache by split, so a dev run cannot restore a Mini-Dev cache', () => {
    // One key over both would restore 15 times less data than the run needs, and the fetch step
    // would then be reading a directory that exists and is incomplete — the failure mode that
    // produces execution errors rather than a missing file.
    expect(WORKFLOW).toContain('key: bird-${{ inputs.split }}-');
  });

  it('leaves the limit blank by default, because blank is what "the whole split" means', () => {
    // The first competitor dispatch declared 25 and produced a paired reading with a 29.65pp MDE.
    // A default here overrides the runner's own meaning of an empty value, silently.
    const at = WORKFLOW.indexOf('      limit:');
    const block = WORKFLOW.slice(at, WORKFLOW.indexOf('      split:', at));
    expect(block).toMatch(/default: ''/);
  });

  it.each(names)('%s resolves its dataset from the split, and refuses a third one', (name) => {
    const script = readFileSync(join(ROOT, '.github/competitors', `${name}.sh`), 'utf8');
    expect(script).toContain('BIRD_SPLIT');
    // Both layouts, spelled the way `fetch.mjs` extracts them.
    expect(script).toContain('eval/.cache/bird/minidev/MINIDEV');
    expect(script).toContain('eval/.cache/bird/dev/dev_20240627');
    // A split the adapter has never seen must stop the run before the first model call.
    expect(script).toMatch(/unknown BIRD_SPLIT/);
  });
});
