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
quantitative unless cardinality is very low (then ordinal) or the column walks
the calendar (then temporal); ISO-looking strings are temporal; everything else
is nominal. If your column is misclassified, build the `ChartIR` by hand with the
type you know.

A column counts as a calendar when every value is an integer, none repeats, the
distinct values are a contiguous block inside 1900–2100, and the rows read one
year apart. That is deliberately stricter than "four digits in the 2010s": a
column of prices in the 2000s is a measure, and the same column of years with
gaps in it stays one too. The reason the rule exists at all is that a `YEAR`
column arrives as a number from most drivers and as text from most CSVs, and
those two transports used to produce two different charts for the same data.

### If you parse a result set yourself

`profileRows` reads JavaScript types, so a column of strings is a label column —
`"43.54"` is text and a bar over it has no measure. The drivers in
`@agentix-e/nl2charts-node` hand you typed values (a `numeric` arrives as a
`number`, a `NULL` as `null`) and need nothing from you. A result set you copied
out of a terminal is different: two conversions decide whether the chart is
possible, and both are worth writing down.

**A printed absence is a null.** `-`, `--`, `—`, `n/a`, `null`, `none` and a lone
`.` are how a result set prints a value that is not there. Read as text, one dash
in a column of fifteen numbers makes the whole column nominal, the table loses its
measure, and every chart that needs one is refused with `a bar needs a category
axis and a measure`. The check has to be on the whole cell: `5-10` is a band and
`2019-01-01` is a date.

**A number is read from its formatting.** `1,234`, `$1,234`, `38%` (as `38` — a
chart cares about relative height, not the unit) and the accounting negative
`(1,234)` as `-1234` are all numbers. A space-grouped number and a European
`1.234,56` are deliberately not: both require guessing which separator is the
decimal one, and a guess here turns a category into a measure.

### A result set with no measure is charted by counting

A grouped query often answers with the count already in it: one categorical
column and no number. `toChartIR` draws that table rather than refusing it, by
counting how many rows each category accounts for — the measure such a table
always has.

```ts
const ir = toChartIR('Which genre has the most plays?', [
  { genre: 'History', play: 'Henry V' },
  { genre: 'Tragedy', play: 'Hamlet' },
  { genre: 'Tragedy', play: 'Macbeth' },
]);
// ir.mark      === 'bar'
// ir.encoding.x === { field: 'genre', type: 'nominal' }
// ir.encoding.y === [{ field: 'count', type: 'quantitative', aggregate: 'count' }]
// ir.data      === [{ genre: 'Tragedy', count: 2 }, { genre: 'History', count: 1 }]
```

Two conditions decide whether this is a chart or a refusal, and both are facts
about the data rather than settings:

- **A category has to repeat.** A count over a column of unique values is a row
  of equal bars, so a table of twelve countries with nothing else is still
  refused — correctly, because there is nothing to compare.
- **A mark still has to fit.** The counted measure is one measure, so a scatter
  (two measures), a boxplot (five numbers a row) and a radar (three) are still
  out of reach, and a pie still needs one category of at most twelve slices.

The count is *materialised*, not declared: the IR carries one row per group and
the ref names the column it produced with `aggregate: 'count'`. A result set that
already has a column called `count` keeps it, and the folded one is added as
`count_2`. If you build the IR yourself, `recommendChart` will offer the counted
measures only when you pass `rows` — the number of rows the profiles were taken
from — because a recommend function handed profiles alone cannot tell twelve
countries from twelve thousand sales.

```ts
const CURRENCY = /^[$€£¥₹]\s?/;
const GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const MISSING = /^(?:-+|—|–|n\/?a|null|none|\.)$/i;

function cell(value: string): number | null {
  const text = value.trim();
  if (text.length === 0 || MISSING.test(text)) return null;
  const parenthesised = /^\((.*)\)$/.exec(text);
  const body = (parenthesised?.[1] ?? text).replace(CURRENCY, '').replace(/%$/, '').trim();
  const plain = GROUPED.test(body) ? body.replace(/,/g, '') : body;
  if (plain.length === 0 || /^0\d/.test(plain)) return null; // a leading zero is a code
  const parsed = Number(plain);
  if (!Number.isFinite(parsed)) return null;
  return parenthesised === null ? parsed : -parsed;
}
```

The leading-zero rule is the one that is easy to miss: a zip code, an account
number and a phone prefix are digits and are not quantities, and a chart over them
is a chart of nothing.

### What the recommender can lead with

The contract has eleven series: bar, line, pie, scatter, boxplot, heatmap, funnel,
candlestick, radar, parallel and gauge. A question that names a picture outside
that list — an area chart, a histogram, a violin plot — is answered with the
nearest series the contract does have, and `recommendChart` says so in its
reasoning: an area is covered by a line, a histogram by a bar **when a cue that
names the intent put the bar there** (`"show a histogram of revenue"` does,
`"the distribution of revenue"` does not — that one is a boxplot, which is a
summary of five numbers rather than a picture of the bins). Nothing is covered for
a violin plot: there is no series to stand in for it.

## 2. Ask for candidates

```ts
import { enumerateCandidates } from '@agentix-e/nl2charts-chart';

const candidates = enumerateCandidates(profiles);
// [ { mark: 'line', score: 0.9, reason: 'temporal-x-quantitative-y' },
//   { mark: 'bar',  score: 0.8, reason: 'category-x-quantitative-y' }, … ]
```

Candidates are *structurally valid* options, not a decision. A pie is offered
only when the measure is non-negative and one category has at most twelve
slices — twelve is the default, a second argument to `enumerateCandidates` and
the `maxSlices` option of `recommendChart` override it.

The twelve is a reading rather than a round number. Seven was the limit this
library shipped until it was measured against
[Text2Vis](https://huggingface.co/datasets/mizanurr/Text2Vis), a corpus of 1,985
questions — 1,470 of which carry a chart label this build can score — each with
the chart its authors judged correct. A cap of eight or nine scores *worse* than
seven — it admits the tables the corpus drew as bars at eight and nine categories
while still refusing the ones it drew as pies at ten and twelve — and twelve is
the first value where the pie a question asks for is no longer overruled by a
constant. `docs/benchmarks.md` carries the whole curve.

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
- **The data can outrank the list order, not the question.** A bar over months and
  a line over months carry the same numbers, and only the line states the interval
  between them, so when the axis is a time axis the line is paid a bonus of three —
  a cue's rate — reported as `profile:time-axis`. It is paid in the score, never in
  the primary key, so a question that *names* a mark still gets it: `Daily open and
  close prices` has a time axis and is still a candlestick, because `volatility`
  asks for one. Before this, bar and line scored the same and the tie fell to the
  order of the mark list, which meant the answer to `Revenue for each month` was a
  bar because `bar` happens to be listed first.

Seven marks can be chosen this way on top of the original five: funnel, boxplot,
candlestick, radar, parallel, gauge, and pie over a twelve-slice limit. The set
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

> **What this is not.** There is **no encoding score** behind this layer. What
> exists is `pnpm bench:text2vis:rule`: it scores the *cue half* — the mark the
> question names — against Text2Vis (EMNLP 2025), the one public corpus that
> labels a chart, and it does so with no model call, no database and no renderer.
> It prints three numbers together, because any one of them alone is a number
> about nothing: `top-1` (the leading mark carries the labelled family), the
> `shortlist` (some recommended mark does), and the two constants it has to beat
> (`always <most frequent>`, `always bar`). A corpus label the table has no family
> for is excluded from the score and **named in the log** rather than folded into
> `bar`.
>
> The other half is `pnpm bench:text2vis:profile`, which scores the shipped entry
> point with the corpus's own result set in front of it — no model, no database,
> no renderer, because the corpus ships the table. That reading is
> **526 of 1,470 (35.78%)** and it is held by a floor: `pnpm gate:text2vis` fails a
> run that comes back lower, and fails one that comes back over a different number
> of rows, because the scorer is deterministic and a fall is therefore never noise.
>
> What that still leaves unmeasured is stated in the module rather than implied
> here: whether the right mark is drawn with the right fields and aggregate (that
> needs a rendered comparison, which needs a renderer), and whether any single
> label is more than one annotator's judgement. The tests pin the rule table
> against a named fixture, and that fixture is a regression corpus, not a
> benchmark.

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

## Exporting the chart as Python

If your report pipeline is Python, or you want a PNG without a browser anywhere in the path, the
same IR compiles to matplotlib source:

```ts
import { compileToMatplotlib } from '@agentix-e/nl2charts-chart';

const source = compileToMatplotlib(ir); // a string; it draws nothing by itself
```

The source is a pure function of the IR — no interpreter, no IO — so it can be stored, reviewed and
diffed. To get a picture, run it where matplotlib lives:

```python
import matplotlib
matplotlib.use("Agg")          # no display in a server process
import matplotlib.pyplot as plt

plt.show = lambda *a, **k: plt.savefig("chart.png", dpi=110, bbox_inches="tight")
exec(compile(source, "<chart>", "exec"), {"__name__": "__chart__"})
```

Two things to know before you rely on it:

- **Nine of the eleven recommendable marks have a matplotlib counterpart** — bar, line, scatter,
  pie, heatmap, funnel, boxplot, candlestick and their variants. `gauge` is refused on purpose: a
  gauge states a value *against a scale*, and this contract carries the value without the scale, so
  drawing one would be the library choosing a ceiling and reporting it as your data's. The refusal
  is `NL2C_E_NOT_SUPPORTED` and its message says which of the two it is.
- **The categories are drawn at integer positions and labelled with `xticks`.** That is what lets a
  column that mixes numbers with text (`[65, "nan", 29]`) or holds a null reach a figure instead of
  an exception — a detail that costs nothing in the output and prevents a whole class of runtime
  failures.

If you need a browser-quality PNG or an interactive chart, use `compileToECharts` above; the
matplotlib path exists for reproducibility and for pipelines that already run Python.

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
