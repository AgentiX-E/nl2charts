import { describe, expect, it } from 'vitest';
import { buildIssueList, renderIssueListText, renderTraceSvg, replayTrace, sealTrace } from '../src/index.js';

const events = [
  { name: 'guard', startMs: 0, endMs: 2 },
  { name: 'compile', startMs: 2, endMs: 9 },
  { name: 'execute', startMs: 9, endMs: 41, attrs: { 'nl2charts.rows': 239 } },
];

const replay = replayTrace(sealTrace(events));

describe('trace view', () => {
  it('renders one labelled bar per stage', () => {
    const svg = renderTraceSvg(replay);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
    for (const stage of replay.stages) expect(svg, stage.name).toContain(`>${stage.name}<`);
  });

  it('scales each bar to the stage that actually took the time', () => {
    // Widths must be proportional: a timeline where every stage looks the same is
    // a list with extra steps.
    const widths = [...renderTraceSvg(replay).matchAll(/data-stage="([^"]+)"[^>]*width="([\d.]+)"/g)].map((match) => ({
      name: match[1] as string,
      width: Number(match[2]),
    }));
    expect(widths.map((entry) => entry.name)).toEqual(['guard', 'compile', 'execute']);
    expect(widths[2]?.width as number).toBeGreaterThan(widths[1]?.width as number);
    expect(widths[1]?.width as number).toBeGreaterThan(widths[0]?.width as number);
  });

  it('marks a failed stage without changing the geometry of the others', () => {
    const failing = replayTrace(
      sealTrace([
        { name: 'guard', startMs: 0, endMs: 2 },
        { name: 'execute', startMs: 2, endMs: 20, status: 'error', attrs: { 'nl2charts.error': 'NL2C_E_TIMEOUT' } },
      ]),
    );
    const svg = renderTraceSvg(failing);
    expect(svg).toContain('data-status="error"');
    expect(svg).toContain('NL2C_E_TIMEOUT');
    expect(renderTraceSvg(replay)).not.toContain('data-status="error"');
  });

  it('says so when the trace did not verify instead of drawing an empty timeline', () => {
    const broken = replayTrace({ ...sealTrace(events), head: 'deadbeef' });
    const svg = renderTraceSvg(broken);
    expect(svg).toContain('trace does not verify');
    expect(svg).not.toContain('data-stage=');
  });

  it('draws an empty trace as an empty state, not as a broken axis', () => {
    const svg = renderTraceSvg(replayTrace(sealTrace([])));
    expect(svg).toContain('no stages');
    expect(svg).not.toContain('NaN');
  });

  it('is deterministic, so a screenshot diff means a change', () => {
    expect(renderTraceSvg(replay)).toBe(renderTraceSvg(replay));
  });

  it('carries an accessible title and the total duration', () => {
    const svg = renderTraceSvg(replay);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('<title>');
    expect(svg).toContain('41');
  });

  it('honours width and height without breaking the bars', () => {
    const wide = renderTraceSvg(replay, { width: 800, height: 200 });
    expect(wide).toContain('viewBox="0 0 800 200"');
    expect(wide).toContain('data-stage="execute"');
  });
});

describe('issue list view', () => {
  const list = buildIssueList([
    { severity: 'warn', code: 'missing-rationale', message: 'revenue has no rationale' },
    { severity: 'error', code: 'missing-expr', message: 'ratio has no expression' },
  ]);

  it('prints errors first and ends with a summary a terminal can read', () => {
    const text = renderIssueListText(list);
    const lines = text.split('\n');
    // The first line is the BLOCKING marker: a CI annotation shows the first line.
    expect(lines[0]).toBe('BLOCKING');
    expect(lines[1]).toContain('error');
    expect(lines[1]).toContain('missing-expr');
    expect(lines[2]).toContain('warn');
    expect(text.trim().split('\n').at(-1)).toContain('1 error, 1 warning');
  });

  it('says a clean model is clean instead of printing nothing', () => {
    expect(renderIssueListText(buildIssueList([]))).toContain('no issues');
  });

  it('marks a blocking list so a caller cannot mistake it for advisory', () => {
    expect(renderIssueListText(list).startsWith('BLOCKING')).toBe(true);
    expect(renderIssueListText(buildIssueList([{ severity: 'warn', code: 'x', message: 'y' }])).startsWith('BLOCKING')).toBe(
      false,
    );
  });
});
