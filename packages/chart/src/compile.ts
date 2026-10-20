import type { ChartIR, FieldRef } from '@agentix-e/nl2charts-spec';

export interface EChartsOption {
  readonly [key: string]: unknown;
}

const CARTESIAN = new Set(['bar', 'line', 'scatter', 'effectScatter', 'pictorialBar', 'candlestick', 'boxplot']);
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

function encodeOf(refs: readonly (Ref | undefined)[]): Record<string, string> {
  const encode: Record<string, string> = {};
  refs.forEach((ref, index) => {
    if (ref) encode[String(index)] = ref.field;
  });
  return encode;
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
        ...(ir.mark === 'graph' ? { layout: 'force', roam: false } : {}),
        data: [...names].map((name) => ({ name })),
        links,
      },
    ];
    return option;
  }

  // custom and anything the contract adds later still produces a valid payload.
  option.series = [{ type: ir.mark, encode: encodeOf([x, ...yRefs]) }];
  return option;
}
