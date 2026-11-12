# Your first chart

This chapter goes from an array of rows to an SVG string, and explains each step
so you can replace any of them.

## 1. Profile the rows

```ts
import { profileRows } from '@agentix-e/nl2charts-chart';

const rows = [
  { month: '2026-01-01', region: 'north', revenue: 120, orders: 12 },
  { month: '2026-02-01', region: 'north', revenue: 150, orders: 18 },
  { month: '2026-03-01', region: 'south', revenue: 90, orders: 9 },
];

const profiles = profileRows(rows);
```

Each profile answers: what type is this column, how many distinct values, how
many nulls, and (for numbers) the range.

```ts
[{ name: 'month', type: 'temporal', distinct: 3, nulls: 0, negative: false },
 { name: 'region', type: 'nominal', distinct: 2, nulls: 0, negative: false },
 { name: 'revenue', type: 'quantitative', distinct: 3, nulls: 0, min: 90, max: 150, negative: false },
 …]
```

Type inference is intentionally simple and explainable: all numbers are
quantitative unless cardinality is very low (then ordinal); ISO-looking strings
are temporal; everything else is nominal. If your column is misclassified, build
the `ChartIR` by hand with the type you know.

## 2. Ask for candidates

```ts
import { enumerateCandidates } from '@agentix-e/nl2charts-chart';

const candidates = enumerateCandidates(profiles, 7);
// [ { mark: 'line', score: 0.9, reason: 'temporal-x-quantitative-y' },
//   { mark: 'bar',  score: 0.8, reason: 'category-x-quantitative-y' }, … ]
```

Candidates are *structurally valid* options, not a decision. A pie is offered
only when the category count is small enough to read and the measure is
non-negative.

## 2b. Or let the question choose

`enumerateCandidates` reads the profile alone, so it can only ever suggest five
marks — bar, line, pie, scatter, heatmap. The other seventeen series types in the
contract were reachable by hand only. `recommendChart` closes that gap without a
model: it reads the phrases that name a shape, and the preconditions that a
column set can witness.

```ts
import { recommendChart } from '@agentix-e/nl2charts-chart';

const choice = recommendChart('What share of revenue does each region hold?', profiles);
// { recommendations: [ { mark: 'pie', score: 5,
//       cues: ['share'],
//       reasons: ['profile:one-named-category-and-a-measure', 'cue:share "share"'] }, … ],
//   refused: [ { mark: 'scatter', reason: 'a scatter needs two measures' }, … ] }
```

Two properties make the answer auditable rather than persuasive:

- **The score is counted, not weighed.** Three points for the first mark a cue
  names, two for the rest, plus the structural prior. A reader can recompute
  `score: 5` from the two facts printed next to it, which is not true of `0.83`.
- **Every rejection is reported.** `refused` carries the sentence that explains
  what the result set lacks — `a boxplot reads five numbers per row and this
  result has 1` — so a caller that prefers another mark knows what would have to
  change, and a wrong choice has a trace instead of a mystery.

Seven marks can be chosen this way on top of the original five: funnel, boxplot,
candlestick, radar, parallel, gauge, and pie over an explicit slice limit. The set
is bounded on purpose: a map needs geometry no result set carries, a tree needs a
hierarchy a flat table does not describe, and a custom series needs a `renderItem`
function that cannot travel in a contract. Those stay hand-specified.

To go straight to a renderable contract, use `toChartIR`. It picks the winner,
orders tuple columns the way the renderer reads them (a candlestick is
`[open, close, low, high]`, not "the first four numbers"), fills the title with the
question and the alt text with the mark and row count:

```ts
import { toChartIR } from '@agentix-e/nl2charts-chart';

const ir = toChartIR('Daily open and close prices', rows);
lint(ir); // no errors
```

It throws `NL2C_E_NOT_SUPPORTED` for an empty result set, or for one no mark can
encode, and names the columns it saw.

> **What this is not.** There is no Text2Vis, nvBench or VisEval reading behind
> this layer in this repository. The tests pin the behaviour of the rule table
> against a named fixture, and that fixture is a regression corpus, not a
> benchmark: the chart-choice numbers this project has quoted were produced by
> harnesses that are not in this tree, so they are not reproducible from it and
> are not claimed here. A layer that says which mark it chose and why is worth
> having before the instrument that scores it exists; the reverse order produces a
> score nobody can audit.

## 3. Build the IR

```ts
const ir = {
  version: '3.0',
  mark: candidates[0].mark,
  encoding: {
    x: { field: 'month', type: 'temporal' },
    y: { field: 'revenue', type: 'quantitative', aggregate: 'sum' },
  },
  data: rows,
  title: 'Revenue by month',
  alt: 'Monthly revenue: 120 in January, 150 in February, 90 in March.',
} as const;
```

`alt` is not decoration. `lint` reports its absence as an `error`, because a
chart without a text alternative cannot be cited, searched or read aloud.

## 4. Lint before you render

```ts
import { lint, isRenderable } from '@agentix-e/nl2charts-chart';

const issues = lint(ir);
if (!isRenderable(issues)) throw new Error(issues.map((i) => i.message).join('; '));
```

The twelve rules:

| Rule | Severity | What it catches |
| --- | --- | --- |
| `empty-data` | error | nothing to draw |
| `missing-alt` | error | no text alternative |
| `pie-negative-value` | error | a pie cannot encode negatives |
| `scatter-axis-not-quantitative` | error | scatter with a category axis |
| `missing-title` | warn | an unciteable chart |
| `pie-slice-overflow` | warn | more than 7 slices |
| `series-overflow` | warn | more than 8 series |
| `bar-category-overflow` | warn | more than 30 bars; use a table |
| `line-x-not-temporal` | warn | a line implies order |
| `duplicate-encoding` | warn | the same field twice |
| `measure-without-aggregate` | warn | a forgotten `sum`/`avg` |
| `print-relies-on-color` | warn | colour-only distinction in print |

## 5. Compile and render

```ts
import { compileToECharts } from '@agentix-e/nl2charts-chart';
import * as echarts from 'echarts';

const option = compileToECharts(ir);

// Browser
const chart = echarts.init(document.getElementById('chart')!);
chart.setOption(option);

// Server (SVG string, no DOM)
const ssr = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 640, height: 400 });
ssr.setOption(option);
const svg = ssr.renderToSVGString();
ssr.dispose();
```

The option object is plain data. You can log it, diff it in a snapshot test, or
send it over the wire — that is what makes visual regressions reviewable.

## Themes and print

```ts
const printable = { ...ir, theme: 'print', width: 800, height: 600 };
```

`theme: 'print'` adds a lint warning when colour is the only thing separating
series, because the printed page will lose it.

## All 22 series types, and the two that need help

The contract offers 22 series types, and every one of them is rendered to SVG by
the test suite. They are not interchangeable, so the library publishes what each
one needs:

```ts
import { describeMark } from '@agentix-e/nl2charts-chart';

describeMark('boxplot');
// { mark: 'boxplot',
//   summary: 'Show a distribution as min, quartiles and max.',
//   channels: ['x', 'y'],
//   tuple: 5,
//   requiresGeo: false,
//   requiresRenderItem: false }
```

`tuple` is the number of numbers one row must supply: a boxplot reads five
(min/q1/median/q3/max), a candlestick four (open/close/low/high), a theme river
three but from three different channels. A cell that is not a finite number
becomes `null` rather than `0` — a zero in a quartile is a claim about the data.

Two marks cannot be satisfied from a result set alone, and the compiler says so
instead of emitting a series that throws inside the renderer:

## What each mark reads, before anything is drawn

The twenty-two series types are not twenty-two styles of the same picture. Each
reads a different number of columns per row, from different channels, so an
encoding that draws one correctly draws another as something else. `supportOf`
answers the question first, and answers it in the same terms the compiler and the
linter use:

```ts
import { supportOf, compileToECharts } from '@agentix-e/nl2charts-chart';

supportOf(ir);   // { supported: false, missing: ['a boxplot reads 5 numbers per row from y and was given 2'] }
```

| Family | Marks | Reads | Refused when |
| --- | --- | --- | --- |
| Cartesian | `bar` `line` `scatter` `effectScatter` `pictorialBar` | a measure from `y` or `theta` | neither is encoded |
| Radial | `pie` `funnel` | a category (`theta` or `x`) and a measure (`y` or `color`) | either is missing |
| Single value | `gauge` | one measure from `y` or `theta` | neither is encoded |
| Tuple | `boxplot` `candlestick` | 5 and 4 numbers per row, positionally, from `y` | fewer than that many columns |
| Matrix | `heatmap` | two dimensions from `x` and `y`; the measure from `color`, `size` or `y` | either axis is missing |
| River | `themeRiver` | time from `x`, a measure from `y`, a stack from `series` or `color` | any of the three is missing |
| Profile | `radar` | a metric name (`theta` or `x`) and a measure (`y`) | either is missing |
| Coordinates | `parallel` | two axes: `x` plus one `y`, or two `y` | fewer than two |
| Grouped route | `lines` | `x` and one measure from `y` | either is missing |
| Regions | `map` | `ir.map` naming registered geometry, plus a region name (`x` or `theta`) | either is missing |
| Hierarchy | `tree` `treemap` `sunburst` | a name (`theta` or `x`); a measure from `y` is optional | the name is missing |
| Network | `graph` `sankey` | a source (`x`) and a target (`series` or `color`) | either end is missing |
| Function | `custom` | a `renderItem` function, which cannot travel in a strict IR | always, and the option carries no series |

Two consequences are worth stating because they are product behaviour rather than
implementation detail:

- **A refusal is an error, not a warning.** `lint(ir)` reports every gap above as
  `encoding-unsupported` at `error` severity, and `isRenderable` therefore returns
  `false`. A chart the linter clears with no errors is one the compiler will draw.
- **Nothing is drawn for a refused mark.** The option carries an empty `series`
  instead of a placeholder with a null value, because a gauge with a null needle
  and a pie with one unnamed slice look like a rendering bug rather than a
  contract violation.

The two marks above that need something the contract cannot hold are worth
separating from the rest:

| Mark | What it needs | What happens without it |
| --- | --- | --- |
| `map` | `registerMap` plus `ir.map` naming the registered geometry | the option carries no series |
| `custom` | a `renderItem` function, which cannot travel in a strict IR | the option carries no series |

```ts
const ir = { mark: 'map', map: 'world', encoding: { x: { field: 'country', type: 'nominal' }, y: { field: 'revenue', type: 'quantitative' } }, data, version: '3.0' };
echarts.registerMap('world', geojson);   // your geometry, your licence
chart.setOption(compileToECharts(ir));
```

## The same input draws the same picture

Rendering is deterministic: the same IR produces the same SVG on every call and
every machine, which is what makes the output cacheable and diffable. One mark had
to change to earn that sentence — `graph` used a force simulation, which starts
from random positions, so the same graph drew a different picture each time. It
now uses a circular layout.

Every series type also has a committed structural baseline
(`packages/chart/test/__baseline__/svg.json`): the element skeleton and the number
of drawn shapes per mark. A change that stops a series drawing, or swaps one shape
for another, fails the suite; a label moving half a pixel does not, because a
baseline that cries wolf gets regenerated without being read. Regenerate it with:

```bash
UPDATE_VISUAL=1 pnpm --filter @agentix-e/nl2charts-chart test
```

and review the diff before committing it — the file's own note says the same.

## What this does not do yet

- There is no automatic axis formatting, annotation or annotation layer. The IR
  is deliberately small; formatting belongs to the host theme.
- The design target is 37 chart configurations; 22 of them exist today, and the
  remaining 15 need ECharts extensions (GL, liquid-fill, word cloud) that cannot
  be rendered head-lessly, so they are not claimed.

Next: [your first query](04-first-query.md).
