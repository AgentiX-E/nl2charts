/**
 * The tables are derived, and the derivation is checkable.
 *
 * The regression this file really guards is the fourth hand-typed drift: a number in a Markdown
 * table that no longer matched the run it described. So the assertions below are the numbers the
 * published tables printed before they were generated — transcribed from the document as it stood,
 * not read back out of the ledger. If the derivation changes, those constants are what disagree.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyDoc,
  checkDoc,
  countsOf,
  deriveView,
  ladderOf,
  ladderProblems,
  recurrences,
  reconcile,
  main,
  markers,
  parseLedger,
  renderClaim,
  renderTable,
  viewOf,
} from '../eval/bird/readings.js';
import type { LedgerClaim } from '../eval/bird/readings.js';

const ROOT = join(import.meta.dirname, '..');

/** A ledger small enough to read, with every field the parser insists on. */
function fixture(): Record<string, unknown> {
  return {
    corpus: 'a-corpus',
    docs: [{ file: 'DOC.md', views: ['both'] }],
    runs: [
      { key: 'R1', id: '111', examined: 100, split: 'minidev' },
      { key: 'R2', id: '222', examined: 100, split: 'minidev' },
    ],
    views: [{ id: 'both', pooled: 'pooled', runs: ['R1', 'R2'], cells: 'counts-p' }],
    pairs: [{ left: 'a', right: 'b', readings: { R1: { wins: 10, losses: 5 }, R2: { wins: 8, losses: 6 } } }],
    claims: [],
  };
}

function withLedger(mutate: (ledger: Record<string, unknown>) => void): Record<string, unknown> {
  const ledger = fixture();
  mutate(ledger);
  return ledger;
}

describe('reading a ledger', () => {
  it('accepts the fixture and keeps the order it was written in', () => {
    const ledger = parseLedger(fixture());
    expect(ledger.corpus).toBe('a-corpus');
    expect(ledger.runs.map((run) => run.key)).toEqual(['R1', 'R2']);
    expect(ledger.views[0]?.cells).toBe('counts-p');
    expect(ledger.pairs[0]?.left).toBe('a');
  });

  it('defaults a view to identifier headers and counts with p', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.views = [{ id: 'both', pooled: 'pooled', runs: ['R1'] }];
    }));
    expect(ledger.views[0]?.labelRuns).toBe('id');
    expect(ledger.views[0]?.cells).toBe('counts-p');
  });

  it('refuses a ledger that is not an object, and one with no docs', () => {
    expect(() => parseLedger([])).toThrow(/not an object/);
    expect(() => parseLedger(withLedger((raw) => { raw.docs = []; }))).toThrow(/docs is empty/);
  });

  it('refuses a field of the wrong shape, and says which one', () => {
    expect(() => parseLedger(withLedger((raw) => { raw.runs = {}; }))).toThrow(/runs is not an array/);
    expect(() => parseLedger(withLedger((raw) => { raw.corpus = ''; }))).toThrow(/corpus is not a non-empty string/);
    expect(() => parseLedger(withLedger((raw) => { raw.pairs = 'none'; }))).toThrow(/pairs is not an array/);
  });

  it('reads a ledger with no claims as a ledger that quotes nothing', () => {
    const ledger = parseLedger(withLedger((raw) => { delete raw.claims; }));
    expect(ledger.claims).toEqual([]);
  });

  it('refuses two runs under one key', () => {
    expect(() => parseLedger(withLedger((raw) => {
      raw.runs = [
        { key: 'R1', id: '111', examined: 100, split: 'minidev' },
        { key: 'R1', id: '222', examined: 100, split: 'minidev' },
      ];
    }))).toThrow(/run key R1 appears twice/);
  });

  it('refuses a run that examined nothing, or a fraction of a question', () => {
    expect(() => parseLedger(withLedger((raw) => {
      raw.runs = [{ key: 'R1', id: '111', examined: 0, split: 'minidev' }];
    }))).toThrow(/examined no question/);
    expect(() => parseLedger(withLedger((raw) => {
      raw.runs = [{ key: 'R1', id: '111', examined: 99.5, split: 'minidev' }];
    }))).toThrow(/not a whole count/);
  });

  it('refuses a reading larger than the questions it was scored on', () => {
    expect(() => parseLedger(withLedger((raw) => {
      raw.pairs = [{ left: 'a', right: 'b', readings: { R1: { wins: 90, losses: 90 } } }];
    }))).toThrow(/claims 180 discordant cases out of 100 questions/);
  });

  it('refuses a reading filed under a run the ledger does not have', () => {
    expect(() => parseLedger(withLedger((raw) => {
      raw.pairs = [{ left: 'a', right: 'b', readings: { R9: { wins: 1, losses: 1 } } }];
    }))).toThrow(/run R9, which is not in runs/);
  });

  it('refuses a pair with no reading, a pair of one arm, and a pair twice', () => {
    expect(() => parseLedger(withLedger((raw) => {
      raw.pairs = [{ left: 'a', right: 'b', readings: {} }];
    }))).toThrow(/no reading in any run/);
    expect(() => parseLedger(withLedger((raw) => {
      raw.pairs = [{ left: 'a', right: 'a', readings: { R1: { wins: 1, losses: 1 } } }];
    }))).toThrow(/not a comparison/);
    expect(() => parseLedger(withLedger((raw) => {
      raw.pairs = [
        { left: 'a', right: 'b', readings: { R1: { wins: 1, losses: 2 } } },
        { left: 'a', right: 'b', readings: { R2: { wins: 2, losses: 1 } } },
      ];
    }))).toThrow(/pair a → b appears twice/);
  });

  it('refuses a view that names an unknown run, repeats one, or pools nothing', () => {
    expect(() => parseLedger(withLedger((raw) => {
      raw.views = [{ id: 'both', pooled: 'pooled', runs: ['R1', 'R9'] }];
    }))).toThrow(/view both names run R9/);
    expect(() => parseLedger(withLedger((raw) => {
      raw.views = [{ id: 'both', pooled: 'pooled', runs: ['R1', 'R1'] }];
    }))).toThrow(/lists a run twice/);
    expect(() => parseLedger(withLedger((raw) => {
      raw.views = [{ id: 'both', pooled: 'pooled', runs: [] }];
    }))).toThrow(/nothing to pool/);
  });

  it('refuses two views under one id, and a column style it cannot print', () => {
    expect(() => parseLedger(withLedger((raw) => {
      raw.views = [
        { id: 'both', pooled: 'pooled', runs: ['R1'] },
        { id: 'both', pooled: 'other', runs: ['R2'] },
      ];
    }))).toThrow(/view both appears twice/);
    expect(() => parseLedger(withLedger((raw) => {
      raw.views = [{ id: 'both', pooled: 'pooled', runs: ['R1'], labelRuns: 'letter' }];
    }))).toThrow(/labels runs with letter/);
    expect(() => parseLedger(withLedger((raw) => {
      raw.views = [{ id: 'both', pooled: 'pooled', runs: ['R1'], cells: 'both' }];
    }))).toThrow(/prints cells as both/);
  });

  it('refuses a document carrying a view that does not exist, or the same view twice', () => {
    expect(() => parseLedger(withLedger((raw) => {
      raw.docs = [{ file: 'DOC.md', views: ['nope'] }];
    }))).toThrow(/carry view nope/);
    expect(() => parseLedger(withLedger((raw) => {
      raw.docs = [{ file: 'DOC.md', views: ['both', 'both'] }];
    }))).toThrow(/carries one view twice/);
    expect(() => parseLedger(withLedger((raw) => {
      raw.docs = [
        { file: 'DOC.md', views: ['both'] },
        { file: 'DOC.md', views: [] },
      ];
    }))).toThrow(/a document appears twice/);
  });

  it('refuses a claim about a view or a pair that is not in the ledger, or with three arms', () => {
    expect(() => parseLedger(withLedger((raw) => {
      raw.claims = [{ file: 'DOC.md', view: 'nope', pair: ['a', 'b'], template: '{pooled}' }];
    }))).toThrow(/quotes view nope/);
    expect(() => parseLedger(withLedger((raw) => {
      raw.claims = [{ file: 'DOC.md', view: 'both', pair: ['a', 'c'], template: '{pooled}' }];
    }))).toThrow(/quotes pair a → c/);
    expect(() => parseLedger(withLedger((raw) => {
      raw.claims = [{ file: 'DOC.md', view: 'both', pair: ['a', 'b', 'c'], template: '{pooled}' }];
    }))).toThrow(/names 3 arms/);
  });

  it('names the views that exist when asked for one that does not', () => {
    expect(() => viewOf(parseLedger(fixture()), 'nope')).toThrow(/nope is not a view: both/);
  });
});

describe('which split a reading came from', () => {
  it('refuses a run that does not say which split it was read on', () => {
    expect(() => parseLedger(withLedger((raw) => {
      raw.runs = [{ key: 'R1', id: '111', examined: 100 }];
    }))).toThrow(/runs\[0\]\.split is not a non-empty string/);
  });

  it('refuses a view that reads two splits, and names both', () => {
    expect(() => parseLedger(withLedger((raw) => {
      raw.runs = [
        { key: 'R1', id: '111', examined: 100, split: 'minidev' },
        { key: 'R2', id: '222', examined: 1532, split: 'dev' },
      ];
    }))).toThrow(/view both reads dev and minidev, and a pool across splits is a difference between corpora reported as a difference between arms/);
  });

  it('accepts a view whose runs share a split while the ledger holds another', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.runs = [
        { key: 'R1', id: '111', examined: 100, split: 'minidev' },
        { key: 'R2', id: '222', examined: 100, split: 'minidev' },
        { key: 'D1', id: '333', examined: 1532, split: 'dev' },
      ];
      raw.views = [
        { id: 'both', pooled: 'pooled', runs: ['R1', 'R2'] },
        { id: 'dev-split', pooled: 'pooled', runs: ['D1'] },
      ];
      raw.docs = [{ file: 'DOC.md', views: ['both', 'dev-split'] }];
    }));
    expect(viewOf(ledger, 'dev-split').runs).toEqual(['D1']);
  });
});

describe('the number in a pooled label', () => {
  it('refuses a label that counts a different number of runs than the view lists', () => {
    expect(() => parseLedger(withLedger((raw) => {
      raw.views = [{ id: 'both', pooled: 'three-run pooled', runs: ['R1', 'R2'] }];
    }))).toThrow(/view both calls its pool "three-run pooled" while it lists 2 runs/);
  });

  it('derives the label when the view does not print one', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.views = [{ id: 'both', runs: ['R1', 'R2'] }];
    }));
    expect(ledger.views[0]?.pooled).toBe('two-run pooled');
  });
});

describe('pooling a view', () => {
  it('carries a cell for every run in the view, and pools the ones that scored it', () => {
    const derived = deriveView(parseLedger(fixture()), 'both');
    expect(derived.rows).toHaveLength(1);
    expect(derived.rows[0]?.cells.map((cell) => cell?.run)).toEqual(['R1', 'R2']);
    expect(derived.rows[0]?.pooled.readings).toHaveLength(2);
    expect(derived.unscored).toEqual([]);
  });

  it('leaves a column empty when the run did not score the pair, and pools the rest', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.pairs = [{ left: 'a', right: 'b', readings: { R1: { wins: 10, losses: 5 } } }];
    }));
    const derived = deriveView(ledger, 'both');
    expect(derived.rows[0]?.cells[1]).toBeUndefined();
    expect(derived.rows[0]?.pooled.readings).toHaveLength(1);
  });

  it('drops a pair no run in the view scored, and names it', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.views = [{ id: 'both', pooled: 'pooled', runs: ['R2'] }];
      raw.pairs = [{ left: 'a', right: 'b', readings: { R1: { wins: 10, losses: 5 } } }];
    }));
    const derived = deriveView(ledger, 'both');
    expect(derived.rows).toEqual([]);
    expect(derived.unscored).toEqual(['a → b']);
  });
});

describe('rendering a view', () => {
  it('writes one header row, one separator and one row per pair', () => {
    const table = renderTable(parseLedger(fixture()), 'both');
    expect(table[0]).toBe('| pair | `111` | `222` | pooled | verdict | Q |');
    expect(table[1]).toBe('| --- | --- | --- | --- | --- | --- |');
    expect(table[2]?.startsWith('| `a` → `b` | 10/5, p = ')).toBe(true);
  });

  it('labels columns with keys when the view asks for them', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.views = [{ id: 'both', pooled: 'pooled', runs: ['R1', 'R2'], labelRuns: 'key' }];
    }));
    expect(renderTable(ledger, 'both')[0]).toBe('| pair | R1 | R2 | pooled | verdict | Q |');
  });

  it('prints counts only, and bolds the significant ones, in a wide view', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.views = [{ id: 'both', pooled: 'pooled', runs: ['R1'], cells: 'counts' }];
      raw.pairs = [{ left: 'a', right: 'b', readings: { R1: { wins: 40, losses: 2 } } }];
    }));
    expect(renderTable(ledger, 'both')[2]).toContain('| **40/2** |');
  });

  it('prints no Q for a view that reads one run, because a Q over one reading is undefined', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.views = [{ id: 'both', pooled: 'pooled', runs: ['R1'] }];
    }));
    expect(renderTable(ledger, 'both')[2]?.endsWith('| **none** (minidev) | — |')).toBe(true);
  });

  /**
   * A verdict is a statement about a population, and the table has to say which one. `established`
   * on 496 Mini-Dev questions is not `established` on dev: the same pair read `none` there in a
   * dispatch of 1,532 questions. A label that does not name its split is a label a reader can carry
   * from one table to the other, which is exactly the error this section exists to stop.
   */
  it('names the split beside every verdict, because a label is about a population', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.runs = [
        { key: 'R1', id: '111', examined: 100, split: 'minidev' },
        { key: 'D1', id: '333', examined: 900, split: 'dev' },
      ];
      raw.views = [
        { id: 'both', runs: ['R1'] },
        { id: 'dev-split', runs: ['D1'] },
      ];
      raw.docs = [{ file: 'DOC.md', views: ['both', 'dev-split'] }];
      raw.pairs = [{ left: 'a', right: 'b', readings: { R1: { wins: 40, losses: 5 }, D1: { wins: 40, losses: 5 } } }];
    }));
    expect(renderTable(ledger, 'both')[2]).toContain('| **one-run-only** (minidev) |');
    expect(renderTable(ledger, 'dev-split')[2]).toContain('| **one-run-only** (dev) |');
  });

  it('says which declared pairs a view does not read, rather than showing fewer rows in silence', () => {
    // A dev-split table reads three of the five declared pairs, because that dispatch did not run
    // two of the arms. A table that simply has fewer rows reads as a table of everything.
    const ledger = parseLedger(withLedger((raw) => {
      raw.runs = [
        { key: 'R1', id: '111', examined: 100, split: 'minidev' },
        { key: 'R2', id: '222', examined: 100, split: 'minidev' },
        { key: 'R3', id: '333', examined: 100, split: 'minidev' },
      ];
      raw.pairs = [
        { left: 'a', right: 'b', readings: { R1: { wins: 10, losses: 5 } } },
        { left: 'a', right: 'c', readings: { R3: { wins: 9, losses: 9 } } },
      ];
    }));
    const table = renderTable(ledger, 'both');
    expect(table[table.length - 1]).toBe('*Not read here: `a` → `c`.*');
  });

  it('names the pairs whose interval the random-effects estimator widened', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.pairs = [{ left: 'a', right: 'b', readings: { R1: { wins: 60, losses: 5 }, R2: { wins: 5, losses: 60 } } }];
    }));
    const table = renderTable(ledger, 'both');
    expect(table.some((line) => /^\*Interval widened by DerSimonian–Laird for `a` → `b` \(τ² = [\d.]+ pp²\), because the label says those readings are not one number\.\*$/.test(line))).toBe(true);
  });

  it('prints a count above twenty as digits, because the words stop there', () => {
    const ledger = parseLedger(withLedger((raw) => {
      const keys = Array.from({ length: 21 }, (_, index) => `R${String(index)}`);
      raw.runs = keys.map((key, index) => ({ key, id: String(100 + index), examined: 100, split: 'minidev' }));
      raw.views = [{ id: 'both', runs: keys }];
      raw.pairs = [{ left: 'a', right: 'b', readings: { R0: { wins: 10, losses: 5 } } }];
    }));
    expect(ledger.views[0]?.pooled).toBe('21-run pooled');
  });

  it('leaves an empty column as an em dash rather than a zero', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.pairs = [{ left: 'a', right: 'b', readings: { R1: { wins: 10, losses: 5 } } }];
    }));
    expect(renderTable(ledger, 'both')[2]).toContain('| — |');
  });

  it('writes a negative estimate with a typographic minus, and bolds an established one', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.pairs = [{ left: 'a', right: 'b', readings: { R1: { wins: 4, losses: 6 }, R2: { wins: 4, losses: 6 } } }];
    }));
    const table = renderTable(ledger, 'both');
    expect(table[2]).toContain('| −2.00pp ± 4.38 |');
    expect(table[2]).toContain('| **none** (minidev) |');
  });
});

describe('the ladder of labels as readings accrue', () => {
  /** The three real readings of `metadata+evidence -> select`: null, null, then established. */
  function ladderLedger(): ReturnType<typeof parseLedger> {
    return parseLedger(withLedger((raw) => {
      raw.runs = ['R1', 'R2', 'R3'].map((key) => ({ key, id: key, examined: 496, split: 'minidev' }));
      raw.views = [{ id: 'both', runs: ['R1', 'R2', 'R3'] }];
      raw.pairs = [{
        left: 'a',
        right: 'b',
        readings: {
          R1: { wins: 19, losses: 32 },
          R2: { wins: 27, losses: 26 },
          R3: { wins: 18, losses: 34 },
        },
      }];
    }));
  }

  it('collapses prefixes that carry the same label into one step', () => {
    const steps = ladderOf(ladderLedger(), 'both', 'a', 'b');
    expect(steps).toEqual([
      { verdict: 'none', from: 2, to: 2 },
      { verdict: 'established', from: 3, to: 3 },
    ]);
  });

  it('renders the ladder as one line per pair, under the table it belongs to', () => {
    const table = renderTable(ladderLedger(), 'both');
    expect(table).toContain('*The label at every prefix of these readings — it should arrive once and stay:*');
    expect(table.some((line) => line === '- `a` → `b`: none at 2, established at 3 readings')).toBe(true);
  });

  it('says nothing for a view with one reading, because a ladder of one rung is not a ladder', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.views = [{ id: 'both', runs: ['R1'] }];
    }));
    expect(ladderOf(ledger, 'both', 'a', 'b')).toEqual([]);
    expect(renderTable(ledger, 'both').some((line) => line.startsWith('*The label at every prefix'))).toBe(false);
  });

  /**
   * The property the hand-written table asserted. Stated over steps rather than over a corpus: no
   * count sequence in this ledger produces a recurrence, and a check that can only be reached by
   * searching for one would never run.
   */
  it('fails when a label leaves and comes back', () => {
    expect(recurrences([
      { verdict: 'none', from: 2, to: 2 },
      { verdict: 'established', from: 3, to: 4 },
      { verdict: 'none', from: 5, to: 5 },
    ])).toEqual(['none']);
    expect(recurrences([
      { verdict: 'none', from: 2, to: 3 },
      { verdict: 'established', from: 4, to: 9 },
    ])).toEqual([]);
  });

  it('reports nothing for a ledger whose labels only ever strengthen', () => {
    expect(ladderProblems(ladderLedger(), 'both')).toEqual([]);
  });

  /**
   * A corpus that really does take a label back, which is why the check exists rather than being
   * assumed true. Four readings of `19/32` make a pair `established` at −2.62pp; a `27/26` and a
   * `32/19` then push Cochran's Q to p = 0.037 and the label to `heterogeneous`; one more `19/32`
   * pulls Q back over the line and the label returns to `established`. The estimate never left its
   * sign — what moved was whether the readings could be summarised at all.
   */
  it('names the pair and the view when a label leaves and comes back', () => {
    const cells: [number, number][] = [[19, 32], [19, 32], [19, 32], [19, 32], [27, 26], [32, 19], [19, 32]];
    const ledger = parseLedger(withLedger((raw) => {
      raw.runs = cells.map((_, index) => ({ key: `R${String(index + 1)}`, id: String(index + 1), examined: 496, split: 'minidev' }));
      raw.views = [{ id: 'both', runs: cells.map((_, index) => `R${String(index + 1)}`) }];
      raw.pairs = [{
        left: 'a',
        right: 'b',
        readings: Object.fromEntries(cells.map(([wins, losses], index) => [`R${String(index + 1)}`, { wins, losses }])),
      }];
    }));
    expect(ladderOf(ledger, 'both', 'a', 'b').map((step) => step.verdict)).toEqual(['established', 'heterogeneous', 'established']);
    expect(ladderProblems(ledger, 'both')).toEqual(['a → b reads established again in both, after leaving it']);
  });
});

describe('a document as the ledger derives it', () => {
  const ledger = parseLedger(fixture());
  const table = renderTable(ledger, 'both').join('\n');
  const { begin, end } = markers('both');

  function doc(body: string): string {
    return `# a document\n\n${begin}\n${body}\n${end}\n\nafter the block\n`;
  }

  it('passes when the block is what the ledger derives', () => {
    expect(checkDoc(doc(table), 'DOC.md', ledger)).toEqual([]);
  });

  it('reports the line that drifted, not just that something did', () => {
    const wrong = table.replace('| 10/5,', '| 11/5,');
    const problems = checkDoc(doc(wrong), 'DOC.md', ledger);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/DOC\.md: both is not what the ledger derives — line 3 reads "\| `a` → `b` \| 11\/5,/);
  });

  it('says `(nothing)` when the block stops mid-table', () => {
    const truncated = table.split('\n').slice(0, 2).join('\n');
    const problems = checkDoc(doc(truncated), 'DOC.md', ledger);
    expect(problems[0]).toMatch(/and the ledger gives "\| `a` → `b` \|/);
  });

  it('reports a deleted block, because a table that stops being checked is the failure', () => {
    const problems = checkDoc('# a document\n\nno block here\n', 'DOC.md', ledger);
    expect(problems[0]).toMatch(/markers appear 0× opening and 0× closing/);
  });

  it('reports a block whose markers were halved, doubled, or inverted', () => {
    expect(checkDoc(`# doc\n${begin}\n${table}\n`, 'DOC.md', ledger)[0]).toMatch(/1× opening and 0× closing/);
    expect(checkDoc(`# doc\n${begin}\n${table}\n${end}\n${begin}\n${table}\n${end}\n`, 'DOC.md', ledger)[0]).toMatch(/2× opening and 2× closing/);
    expect(checkDoc(`# doc\n${end}\n${table}\n${begin}\n`, 'DOC.md', ledger)[0]).toMatch(/closes before it opens/);
  });

  it('reports a block this document was not said to carry', () => {
    const narrowed = parseLedger(withLedger((raw) => { raw.docs = [{ file: 'DOC.md', views: [] }]; }));
    expect(checkDoc(doc(table), 'DOC.md', narrowed)[0]).toMatch(/does not list for this document/);
  });

  it('reports a document the ledger does not own', () => {
    expect(checkDoc('# other\n', 'OTHER.md', ledger)[0]).toMatch(/not a document this ledger owns/);
  });

  it('rewrites the block and leaves the prose around it alone', () => {
    const stale = doc('| pair | stale |');
    const fixed = applyDoc(stale, ledger);
    expect(fixed).toBe(doc(table));
    expect(fixed.startsWith('# a document\n\n')).toBe(true);
    expect(fixed.endsWith('after the block\n')).toBe(true);
  });

  it('is idempotent, because a formatter that moves every run is a diff nobody reads', () => {
    const once = applyDoc(doc('| pair | stale |'), ledger);
    expect(applyDoc(once, ledger)).toBe(once);
  });

  it('leaves a document without markers exactly as it found it', () => {
    expect(applyDoc('# nothing to do\n', ledger)).toBe('# nothing to do\n');
  });

  it('leaves a block whose closing marker is missing exactly as it found it', () => {
    const broken = `# doc\n${begin}\nstale\n`;
    expect(applyDoc(broken, ledger)).toBe(broken);
  });
});

describe('a number quoted in prose', () => {
  /** A document whose block is correct, so only the claim can be the thing that fails. */
  function withCorrectBlock(text: string, ledger: ReturnType<typeof parseLedger>): string {
    return `# doc\n\n<!-- readings:begin both -->\n${renderTable(ledger, 'both').join('\n')}\n<!-- readings:end both -->\n\n${text}\n`;
  }

  it('renders the pool by hand: 10/5 and 8/6 over 100 questions each', () => {
    // Inverse-variance weights are 100²/(15·10⁴) and 100²/(14·10⁴) on +5.00pp and +2.00pp, which
    // puts the estimate between the two readings and the interval at 1.96/√Σw.
    const ledger = parseLedger(withLedger((raw) => {
      raw.claims = [{ file: 'DOC.md', view: 'both', pair: ['a', 'b'], template: '{pooled} ± {interval}' }];
    }));
    expect(renderClaim(ledger, ledger.claims[0] as LedgerClaim).wanted).toBe('+3.45pp ± 5.27');
  });

  it('renders {runs} as the number of runs the view reads, in words', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.claims = [{ file: 'DOC.md', view: 'both', pair: ['a', 'b'], template: '{runs} runs' }];
    }));
    expect(renderClaim(ledger, ledger.claims[0] as LedgerClaim).wanted).toBe('two runs');
  });

  it('fills every placeholder, including the magnitude of a signed estimate', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.claims = [{ file: 'DOC.md', view: 'both', pair: ['a', 'b'], template: '{magnitude}|{verdict}|{split}|{q}|{significant}' }];
    }));
    expect(renderClaim(ledger, ledger.claims[0] as LedgerClaim).wanted).toBe('3.45|none|minidev|0.578|0');
  });

  /**
   * The rule that keeps a sentence honest: a label cannot be quoted without the population it was
   * measured on. `established` on 496 questions and `established` on 1,532 are different claims, and
   * the second one was withdrawn by a dev dispatch. Refused at parse time rather than checked at
   * gate time, because a template is the only place this can be prevented rather than detected.
   */
  it('refuses a claim that quotes a verdict without the split it was read on', () => {
    expect(() => parseLedger(withLedger((raw) => {
      raw.claims = [{ file: 'DOC.md', view: 'both', pair: ['a', 'b'], template: 'it is {verdict}' }];
    }))).toThrow(/quotes \{verdict\} without \{split\}, and a label is about a population/);
  });

  it('passes when the sentence carries what the ledger derives', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.claims = [{ file: 'DOC.md', view: 'both', pair: ['a', 'b'], template: '{pooled} ± {interval}' }];
    }));
    expect(checkDoc(withCorrectBlock('pooled +3.45pp ± 5.27 over two runs', ledger), 'DOC.md', ledger)).toEqual([]);
  });

  it('reports the sentence that quotes a number the ledger does not derive', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.claims = [{ file: 'DOC.md', view: 'both', pair: ['a', 'b'], template: '{pooled} ± {interval}' }];
    }));
    const problems = checkDoc(withCorrectBlock('pooled +9.99pp ± 0.01 over two runs', ledger), 'DOC.md', ledger);
    expect(problems).toEqual(['DOC.md: does not quote "+3.45pp ± 5.27" for a → b in both']);
  });

  it('reports a claim whose pair the view does not read', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.views = [{ id: 'both', pooled: 'pooled', runs: ['R2'] }];
      raw.pairs = [{ left: 'a', right: 'b', readings: { R1: { wins: 10, losses: 5 } } }];
      raw.claims = [{ file: 'DOC.md', view: 'both', pair: ['a', 'b'], template: '{pooled}' }];
    }));
    expect(checkDoc(withCorrectBlock('anything', ledger), 'DOC.md', ledger)).toEqual([
      'DOC.md: claims a number for a → b, which both does not read',
    ]);
  });

  it('ignores a claim filed against another document', () => {
    const ledger = parseLedger(withLedger((raw) => {
      raw.claims = [{ file: 'OTHER.md', view: 'both', pair: ['a', 'b'], template: '{pooled}' }];
      raw.docs = [
        { file: 'DOC.md', views: ['both'] },
        { file: 'OTHER.md', views: [] },
      ];
    }));
    expect(checkDoc(withCorrectBlock('nothing here', ledger), 'DOC.md', ledger)).toEqual([]);
  });
});

/** An artifact scoring two arms over the same 100 questions, as `run` says. */
function artifact(run: string | undefined, wins: number, losses: number, neither = 25): Record<string, unknown> {
  const both = 100 - wins - losses - neither;
  const cases: { arm: string; id: number; passed: boolean }[] = [];
  for (let index = 0; index < wins; index += 1) cases.push({ arm: 'a', id: index, passed: false }, { arm: 'b', id: index, passed: true });
  for (let index = wins; index < wins + losses; index += 1) cases.push({ arm: 'a', id: index, passed: true }, { arm: 'b', id: index, passed: false });
  for (let index = wins + losses; index < wins + losses + both; index += 1) cases.push({ arm: 'a', id: index, passed: true }, { arm: 'b', id: index, passed: true });
  const last = wins + losses + both + neither;
  for (let index = wins + losses + both; index < last; index += 1) cases.push({ arm: 'a', id: index, passed: false }, { arm: 'b', id: index, passed: false });
  return { ...(run === undefined ? {} : { provenance: { run } }), cases };
}

describe('an artifact, against the ledger', () => {
  const ledger = parseLedger(fixture());

  it('reads the counts out of the per-case verdicts, not out of a table', () => {
    expect(countsOf(ledger, artifact('111', 10, 5))).toEqual({
      run: '111',
      pairs: [{ left: 'a', right: 'b', examined: 100, wins: 10, losses: 5 }],
    });
  });

  it('agrees when the ledger carries the same row', () => {
    expect(reconcile(ledger, artifact('111', 10, 5))).toEqual([]);
  });

  it('disagrees with both numbers named', () => {
    expect(reconcile(ledger, artifact('111', 11, 5))).toEqual(['a → b in run 111: the ledger has 10/5, the artifact has 11/5']);
  });

  it('refuses an artifact for a run the ledger does not carry', () => {
    expect(reconcile(ledger, artifact('999', 10, 5))).toEqual(['the ledger has no run 999']);
  });

  it('names a run the ledger has but never scored this pair in', () => {
    const partial = parseLedger(withLedger((raw) => {
      raw.pairs = [{ left: 'a', right: 'b', readings: { R2: { wins: 8, losses: 6 } } }];
    }));
    expect(reconcile(partial, artifact('111', 10, 5))).toEqual(['run 111 is in the ledger but carries no reading of a → b']);
  });

  it('refuses an artifact that does not say which run it is', () => {
    expect(reconcile(ledger, artifact(undefined, 10, 5))).toEqual(['the artifact does not say which run it is, so it cannot be checked against the ledger']);
  });

  it('refuses an artifact that scored one arm of the pair and not the other', () => {
    const half = { provenance: { run: '111' }, cases: [{ arm: 'a', id: 0, passed: true }] };
    expect(reconcile(ledger, half)[0]).toMatch(/the artifact cannot be read as a reading: b is not scored/);
  });

  it('reports a run whose question count moved between the artifact and the ledger', () => {
    const full = artifact('111', 10, 5) as { cases: { id: number }[] };
    const short = { provenance: { run: '111' }, cases: full.cases.filter((entry) => entry.id !== 99) };
    expect(reconcile(ledger, short)).toEqual(['run 111 examined 99 questions in the artifact and 100 in the ledger']);
  });

  it('runs as `--from`, and can fail', () => {
    const root = mkdtempSync(join(tmpdir(), 'readings-from-'));
    try {
      mkdirSync(join(root, 'eval', 'baseline'), { recursive: true });
      writeFileSync(join(root, 'eval/baseline/readings.json'), JSON.stringify(fixture()));
      writeFileSync(join(root, 'good.json'), JSON.stringify(artifact('111', 10, 5)));
      writeFileSync(join(root, 'bad.json'), JSON.stringify(artifact('111', 12, 5)));
      expect(main(['--from', 'good.json'], root)).toBe(0);
      expect(main(['--from', 'bad.json'], root)).toBe(1);
      expect(() => main(['--from'], root)).toThrow(/--from takes an artifact path/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the published tables', () => {
  const ledger = parseLedger(JSON.parse(readFileSync(join(ROOT, 'eval/baseline/readings.json'), 'utf8')) as unknown);

  it('reproduces the nine-run estimates the document prints', () => {
    // These are the numbers the document carried when it was still hand-typed, re-derived after the
    // heterogeneity test was corrected and after the ninth run was filed. Two labels moved for a
    // second reason: a reversal now requires a reading that cleared its own test in each direction,
    // so `inline+evidence -> inline+evidence+audit` — seven positive readings and one at p = 0.65 —
    // and `metadata+evidence -> select` — one significant negative reading and one tie — stopped
    // being called `sign-flip` and became what the pooled estimate says they are.
    const rows = deriveView(ledger, 'all-runs').rows;
    const numbers = rows.map((row) => [
      row.left,
      row.right,
      row.pooled.pooledPp,
      row.pooled.pooledIntervalPp,
      row.pooled.verdict,
      row.pooled.heterogeneityP,
    ]);
    expect(numbers).toEqual([
      ['synth-definitions', 'inline-definitions', -0.67, 0.77, 'none', 0.899],
      ['inline+evidence', 'inline+evidence+audit', 0.63, 0.56, 'established', 0.4016],
      ['inline+evidence', 'select', 1.54, 0.72, 'established', 0.5827],
      ['metadata+evidence', 'select', -1.42, 0.96, 'established', 0.8817],
      ['inline+evidence', 'metadata+evidence', 3, 0.91, 'established', 0.9991],
    ]);
  });

  it('reproduces the three-run and four-run estimates too, from the same counts', () => {
    const three = deriveView(ledger, 'three-runs').rows.map((row) => row.pooled.pooledPp);
    const four = deriveView(ledger, 'four-runs').rows.map((row) => row.pooled.pooledPp);
    expect(three).toEqual([-0.28, 0.15, 1.01, -1.9, 2.89]);
    expect(four).toEqual([-0.52, 0.16, 1.16, -1.72, 2.87]);
  });

  it('reproduces the per-run p-values the three-run table printed', () => {
    const cells = deriveView(ledger, 'three-runs').rows.map((row) => row.cells.map((cell) => cell?.p));
    expect(cells[0]).toEqual([0.3771, 1, 0.7283]);
    expect(cells[2]).toEqual([1, 0.0161, 1]);
    expect(cells[4]).toEqual([0.0854, 0.066, 0.0186]);
  });

  it('counts the readings that cleared 0.05 on their own, which the prose quotes', () => {
    const curated = deriveView(ledger, 'all-runs').rows.find((row) => row.right === 'metadata+evidence');
    expect(curated?.pooled.readingsSignificant).toBe(4);
    const select = deriveView(ledger, 'all-runs').rows.find((row) => row.right === 'select');
    const signs = select?.pooled.readings.map((reading) => Math.sign(reading.deltaPp));
    expect(signs?.filter((sign) => sign > 0)).toHaveLength(8);
    expect(signs?.filter((sign) => sign === 0)).toHaveLength(1);
  });

  it('is what the repository’s own documents carry', () => {
    const problems = ledger.docs.flatMap((entry) =>
      checkDoc(readFileSync(join(ROOT, entry.file), 'utf8'), entry.file, ledger),
    );
    expect(problems).toEqual([]);
  });
});

describe('the command', () => {
  it('checks, writes, and checks again without a diff', () => {
    const root = mkdtempSync(join(tmpdir(), 'readings-'));
    try {
      const ledger = parseLedger(fixture());
      mkdirSync(join(root, 'eval', 'baseline'), { recursive: true });
      writeFileSync(join(root, 'eval/baseline/readings.json'), JSON.stringify(fixture()));
      writeFileSync(join(root, 'DOC.md'), '# doc\n\n<!-- readings:begin both -->\nstale\n<!-- readings:end both -->\n');
      expect(main(['--check'], root)).toBe(1);
      expect(main(['--write'], root)).toBe(0);
      expect(main(['--check'], root)).toBe(0);
      expect(readFileSync(join(root, 'DOC.md'), 'utf8')).toContain(renderTable(ledger, 'both').join('\n'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an argument it does not know', () => {
    expect(() => main(['--publish'], process.cwd())).toThrow(/unrecognized argument --publish/);
  });

  it('runs as a script, because a gate that cannot be invoked checks nothing', () => {
    const result = spawnSync('npx', ['tsx', 'eval/bird/readings.ts', '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('5 pairs · three-runs (3 runs), four-runs (4 runs), all-runs (9 runs), dev-split (1 runs) · 2 documents');
  });
});
