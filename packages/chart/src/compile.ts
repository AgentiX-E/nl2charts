import type { ChartIR, FieldRef } from '@agentix-e/nl2charts-spec';
import { describeMark } from './marks.js';
import { distinctValues } from './profile.js';

export interface EChartsOption {
  readonly [key: string]: unknown;
}

const CARTESIAN = new Set(['bar', 'line', 'scatter', 'effectScatter', 'pictorialBar']);
const RADIAL = new Set(['pie', 'funnel', 'gauge']);
const HIERARCHICAL = new Set(['treemap', 'sunburst', 'tree']);
const NETWORK = new Set(['graph', 'sankey']);

type Ref = FieldRef;

function single(value: Ref | Ref[] | undefined): Ref | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function list(value: Ref | Ref[] | undefined): Ref[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** A finite number or nothing; a cell that cannot be measured is null, not zero. */
function toNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function axis(ref: Ref | undefined): Record<string, unknown> {
  if (!ref) return { type: 'category' };
  if (ref.type === 'temporal') return { type: 'time', name: ref.field };
  if (ref.type === 'quantitative') return { type: 'value', name: ref.field };
  return { type: 'category', name: ref.field };
}

/**
 * Compile a ChartIR into an ECharts option object. Pure: no DOM, no instance,
 * no global state. The same object is usable by SSR and by the browser.
 */
export function compileToECharts(ir: ChartIR): EChartsOption {
  const x = single(ir.encoding.x);
  const yRefs = list(ir.encoding.y);
  const theta = ir.encoding.theta ?? x;
  const color = ir.encoding.color;
  const series = ir.encoding.series;
  const option: Record<string, unknown> = {
    animation: false,
    dataset: { source: ir.data as Record<string, unknown>[] },
    title: { text: ir.title ?? '', subtext: ir.subtitle ?? '' },
    aria: { enabled: true, label: { description: ir.alt ?? '' } },
  };
  if (ir.theme !== undefined) option.theme = ir.theme;
  if (ir.width !== undefined && ir.height !== undefined) {
    option.width = ir.width;
    option.height = ir.height;
  }

  if (ir.mark === 'gauge') {
    const value = yRefs[0] ?? theta;
    option.series = [
      {
        type: 'gauge',
        name: value?.field ?? 'value',
        data: ir.data.map((row) => ({ value: value ? row[value.field] : null, name: value?.field ?? 'value' })),
      },
    ];
    return option;
  }

  if (RADIAL.has(ir.mark)) {
    const nameRef = theta;
    const valueRef = yRefs[0] ?? color;
    option.series = [
      {
        type: ir.mark,
        name: ir.title ?? ir.mark,
        encode: { itemName: nameRef?.field, value: valueRef?.field },
        data: ir.data.map((row) => ({
          name: nameRef ? String(row[nameRef.field]) : '',
          value: valueRef ? row[valueRef.field] : null,
        })),
      },
    ];
    return option;
  }

  if (ir.mark === 'heatmap') {
    const xRef = x;
    const yRef = yRefs[0];
    const valueRef = color ?? ir.encoding.size ?? yRefs[0];
    if (xRef && yRef && valueRef) {
      const values = ir.data
        .map((row) => Number(row[valueRef.field]))
        .filter((value) => Number.isFinite(value));
      option.xAxis = { type: 'category', name: xRef.field, data: [...new Set(ir.data.map((row) => row[xRef.field]))] };
      option.yAxis = { type: 'category', name: yRef.field, data: [...new Set(ir.data.map((row) => row[yRef.field]))] };
      option.visualMap = {
        min: values.length > 0 ? Math.min(...values) : 0,
        max: values.length > 0 ? Math.max(...values) : 1,
        calculable: false,
      };
      option.series = [
        {
          type: 'heatmap',
          encode: { x: 0, y: 1, value: 2 },
          data: ir.data.map((row) => [row[xRef.field], row[yRef.field], row[valueRef.field]]),
        },
      ];
      return option;
    }
  }

  // A river reads three values per row too, but from three channels rather than
  // three columns of y, so it is handled before the tuple branch.
  if (ir.mark === 'themeRiver') {
    const timeRef = x;
    const valueRef = yRefs[0];
    const nameRef = series ?? color;
    if (timeRef && valueRef && nameRef) {
      // A river reads a three-value cell, not a row keyed by column name, so the
      // dataset block is dropped here rather than left to confuse the encoder.
      delete option.dataset;
      option.singleAxis = { type: 'time', name: timeRef.field };
      option.series = [
        {
          type: 'themeRiver',
          data: ir.data.map((row) => [row[timeRef.field], toNumber(row[valueRef.field]), String(row[nameRef.field])]),
        },
      ];
      return option;
    }
    // Without a category there is nothing to stack, and ECharts needs a
    // singleAxis to size the river; an empty option is the honest answer.
    option.series = [];
    return option;
  }

  // Tuple marks: they read several columns per row, and the bar branch below
  // would silently draw only the first one.
  const tuple = describeMark(ir.mark).tuple;
  if (tuple !== undefined) {
    const cells = yRefs.slice(0, tuple);
    option.xAxis = axis(x);
    option.yAxis = { type: 'value' };
    option.series = [
      {
        type: ir.mark,
        name: ir.title ?? ir.mark,
        data: ir.data.map((row) => cells.map((ref) => toNumber(row[ref.field]))),
      },
    ];
    return option;
  }

  if (ir.mark === 'radar') {
    const nameRef = theta ?? x;
    const valueRef = yRefs[0];
    if (nameRef && valueRef) {
      const indicatorNames = distinctValues(ir, nameRef.field);
      const seriesField = series?.field;
      const groups = seriesField === undefined ? [undefined] : distinctValues(ir, seriesField);
      option.radar = {
        indicator: indicatorNames.map((name) => ({
          name,
          // ECharts needs a maximum per axis; the observed maximum is the honest
          // one, and a unit floor keeps an all-zero metric from dividing by zero.
          max: Math.max(
            1,
            ...ir.data
              .filter((row) => String(row[nameRef.field]) === name)
              .map((row) => toNumber(row[valueRef.field]) ?? 0),
          ),
        })),
      };
      option.series = groups.map((group) => ({
        type: 'radar',
        ...(group === undefined ? {} : { name: group }),
        data: [
          {
            name: group ?? ir.title ?? 'value',
            value: indicatorNames.map((name) => {
              const row = ir.data.find(
                (candidate) =>
                  String(candidate[nameRef.field]) === name &&
                  (seriesField === undefined || String(candidate[seriesField]) === group),
              );
              return row === undefined ? null : toNumber(row[valueRef.field]);
            }),
          },
        ],
      }));
      return option;
    }
    option.series = [];
    return option;
  }

  if (ir.mark === 'parallel') {
    const axes: Record<string, unknown>[] = [];
    if (x !== undefined) {
      axes.push({ dim: 0, name: x.field, type: 'category', data: distinctValues(ir, x.field) });
    }
    for (const ref of yRefs) axes.push({ dim: axes.length, name: ref.field, type: 'value' });
    if (axes.length >= 2) {
      option.parallelAxis = axes;
      option.series = [
        {
          type: 'parallel',
          name: ir.title ?? 'parallel',
          data: ir.data.map((row) => [
            ...(x === undefined ? [] : [row[x.field]]),
            ...yRefs.map((ref) => toNumber(row[ref.field])),
          ]),
        },
      ];
      return option;
    }
    option.series = [];
    return option;
  }

  if (ir.mark === 'lines') {
    const groupField = series?.field ?? color?.field;
    const valueRef = yRefs[0];
    if (x && valueRef) {
      option.xAxis = axis(x);
      option.yAxis = axis(valueRef);
      const groups = groupField === undefined ? [undefined] : distinctValues(ir, groupField);
      option.series = groups.map((group) => {
        const rows =
          groupField === undefined ? ir.data : ir.data.filter((row) => String(row[groupField]) === group);
        return {
          type: 'lines',
          coordinateSystem: 'cartesian2d',
          ...(group === undefined ? {} : { name: group }),
          data: [{ coords: rows.map((row) => [row[x.field], toNumber(row[valueRef.field])]) }],
        };
      });
      return option;
    }
    option.series = [];
    return option;
  }

  if (ir.mark === 'map') {
    const nameRef = x ?? theta;
    const valueRef = yRefs[0];
    if (ir.map === undefined) {
      // ECharts throws on an unregistered name, and there is no honest geometry
      // to invent, so the option says so by carrying no series at all.
      option.series = [];
      return option;
    }
    // No geometry is invented here: without registerMap this draws nothing, and
    // that is the truthful outcome for a result set that carries no shapes.
    option.series = [
      {
        type: 'map',
        map: ir.map,
        name: ir.title ?? 'map',
        data:
          nameRef === undefined
            ? []
            : ir.data.map((row) => ({
                name: String(row[nameRef.field]),
                ...(valueRef === undefined ? {} : { value: toNumber(row[valueRef.field]) }),
              })),
      },
    ];
    return option;
  }

  if (CARTESIAN.has(ir.mark)) {
    option.xAxis = axis(x);
    option.yAxis = axis(yRefs[0] ?? theta);
    const base: Record<string, unknown> = {
      type: ir.mark,
      encode: { x: x?.field, y: yRefs.map((ref) => ref.field) },
    };
    option.series = series ? [{ ...base, name: series.field }] : [{ ...base }];
    return option;
  }

  if (HIERARCHICAL.has(ir.mark)) {
    const nameRef = theta ?? x;
    const valueRef = yRefs[0];
    option.series = [
      {
        type: ir.mark,
        data: ir.data.map((row) => ({
          name: nameRef ? String(row[nameRef.field]) : '',
          value: valueRef ? row[valueRef.field] : null,
        })),
      },
    ];
    return option;
  }

  if (NETWORK.has(ir.mark)) {
    const sourceField = x?.field;
    const targetField = series?.field ?? color?.field;
    const valueField = yRefs[0]?.field;
    const names = new Set<string>();
    const links: { source: string; target: string; value: number }[] = [];
    if (sourceField && targetField) {
      for (const row of ir.data) {
        const source = String(row[sourceField]);
        const target = String(row[targetField]);
        names.add(source);
        names.add(target);
        links.push({ source, target, value: Number(valueField ? row[valueField] : 1) });
      }
    }
    option.series = [
      {
        type: ir.mark,
        // Circular, not force: a force layout starts from random positions, so
        // the same input renders a different picture on every build and the SVG
        // cannot be diffed, cached or regression-tested.
        ...(ir.mark === 'graph' ? { layout: 'circular', roam: false } : {}),
        data: [...names].map((name) => ({ name })),
        links,
      },
    ];
    return option;
  }

  // A custom series without `renderItem` throws "series.render is required". The
  // function cannot travel in a strict IR, so the compiler emits no series and the
  // caller adds one to the option it receives.
  //
  // This is also the end of the line: `mark` is a closed union and every member
  // has a branch above, so a new series type fails to reach a renderer until it is
  // handled here. Emitting `{type: mark}` as a fallback would produce an option
  // that throws inside ECharts instead of a compile-time omission.
  option.series = [];
  return option;
}
