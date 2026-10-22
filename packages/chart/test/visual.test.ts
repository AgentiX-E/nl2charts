import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as echarts from 'echarts';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ChartType } from '@agentix-e/nl2charts-spec';
import { compileToECharts } from '../src/index.js';
import { CORE, FIXTURE_GEO, fixture } from './mark-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, '__baseline__', 'svg.json');
const UPDATE = process.env.UPDATE_VISUAL === '1';

interface Entry {
  /** Element skeleton: tags and attribute names, with values and text removed. */
  readonly shape: string;
  /** How many drawn elements carry geometry. */
  readonly geometry: number;
  readonly bytes: number;
}

function render(mark: ChartType, overrides: { revenue?: number } = {}): string {
  const chart = echarts.init(null as unknown as HTMLElement, null, {
    renderer: 'svg',
    ssr: true,
    width: 480,
    height: 320,
  });
  try {
    chart.setOption(compileToECharts(fixture(mark, overrides)));
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

/**
 * A portable fingerprint of the drawing.
 *
 * Byte-for-byte SVG is not portable: font metrics and float formatting differ by
 * platform, and a baseline that fails on a different runner teaches people to
 * regenerate it without looking. The skeleton keeps the structure — which elements
 * in which order — and drops the coordinates, so "the series stopped drawing"
 * fails while "the label moved half a pixel" does not. Geometry counts guard the
 * other direction: an empty chart has a different skeleton from a drawn one.
 */
function fingerprint(svg: string): Entry {
  // Renderer-scoped ids differ per instance (`zr123`), so they are normalised
  // away before anything else: a baseline that changes on every render is a
  // baseline nobody reads.
  const stable = svg.replace(/zr\d+|cls-\d+/g, 'id');
  const shape = stable.replace(/="[^"]*"/g, '="#"').replace(/>[^<]+</g, '><');
  const geometry = (svg.match(/<(path|rect|circle|polygon|polyline|line)\b/g) ?? []).length;
  return { shape: hash(shape), geometry, bytes: svg.length };
}

/** FNV-1a over the skeleton; short, stable, and not a cryptographic claim. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

function current(): Record<string, Entry> {
  const entries: Record<string, Entry> = {};
  for (const mark of CORE) entries[mark] = fingerprint(render(mark));
  return entries;
}

function write(marks: Record<string, Entry>): void {
  writeFileSync(
    BASELINE,
    `${JSON.stringify({ version: 1, note: 'Regenerate with UPDATE_VISUAL=1; review the diff before committing.', marks }, null, 2)}\n`,
  );
}

beforeAll(() => {
  echarts.registerMap('fixture-geo', FIXTURE_GEO as never);
  // Written once, here rather than inside a test, so the read below cannot run
  // before the file exists when the baseline is being regenerated.
  if (UPDATE) write(current());
});

describe('visual baseline', () => {
  it('covers every mark the contract offers, and nothing else', () => {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as { marks: Record<string, Entry> };
    expect(Object.keys(baseline.marks).sort()).toEqual([...CORE].sort());
  });

  it('matches the committed fingerprint for every mark', () => {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as { marks: Record<string, Entry> };
    const measured = UPDATE ? (JSON.parse(readFileSync(BASELINE, 'utf8')) as { marks: Record<string, Entry> }).marks : current();
    for (const mark of CORE) {
      const before = baseline.marks[mark] as Entry;
      const after = measured[mark] as Entry;
      const hint = `${mark}: regenerate with UPDATE_VISUAL=1 after reviewing the change`;
      // Structure and geometry must match exactly; the byte count is a coarse
      // guard only, because a sankey recomputes its curve control points and
      // lands 17 bytes away from itself while drawing the same picture.
      expect({ shape: after.shape, geometry: after.geometry }, hint).toEqual({
        shape: before.shape,
        geometry: before.geometry,
      });
      expect(Math.abs(after.bytes - before.bytes), hint).toBeLessThanOrEqual(Math.ceil(before.bytes * 0.05));
    }
  });

  it('changes when the data changes, so the fingerprint is about the drawing', () => {
    // A fingerprint that survives a different number is a fingerprint of nothing.
    expect(fingerprint(render('bar'))).not.toEqual(fingerprint(render('bar', { revenue: 999 })));
  });

  it('is stable across two renders of the same input', () => {
    // `graph` used to lay out with a force simulation, which starts from random
    // positions: the same input drew a different picture each time. This is the
    // regression guard for that.
    const drawing = (mark: ChartType): { shape: string; geometry: number } => {
      const entry = fingerprint(render(mark));
      return { shape: entry.shape, geometry: entry.geometry };
    };
    for (const mark of ['graph', 'sankey', 'tree'] as const) {
      expect(drawing(mark), mark).toEqual(drawing(mark));
    }
  });

  it('never records an empty drawing', () => {
    // `map` and `custom` produce no series without geometry or a renderItem; their
    // fixtures supply the first and accept the second, so a zero here would mean
    // the fixture stopped exercising the mark.
    for (const mark of CORE) {
      if (mark === 'custom') continue;
      expect(fingerprint(render(mark)).geometry, mark).toBeGreaterThan(0);
    }
  });
});
