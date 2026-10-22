/**
 * Rendering the two Studio views.
 *
 * Both return strings rather than touching a DOM: a trace timeline is something you
 * paste into an incident review, and text output is the form that survives being
 * pasted. The SVG carries `data-*` attributes so a test can assert geometry without
 * parsing the drawing.
 */
import type { IssueList, Replay } from './trace.js';

export interface TraceViewOptions {
  readonly width?: number;
  readonly height?: number;
  /** Pixels per stage row, including the gap. */
  readonly rowHeight?: number;
}

const PAD_LEFT = 96;
const PAD_RIGHT = 16;
const PAD_TOP = 34;
const LABEL = 12;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A horizontal timeline: one row per stage, bar length proportional to duration.
 * A failed stage is marked with `data-status` and its error text, because the point
 * of the view is to answer "where did the time go and what broke" in one look.
 */
export function renderTraceSvg(replay: Replay, options: TraceViewOptions = {}): string {
  const rowHeight = options.rowHeight ?? 28;
  const height = options.height ?? PAD_TOP + rowHeight * Math.max(1, replay.stages.length) + 16;
  const width = options.width ?? 640;
  const barSpace = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
  const total = replay.stages.reduce((longest, stage) => Math.max(longest, stage.durationMs), 0);

  const title =
    replay.ok && replay.stages.length > 0
      ? `trace: ${replay.stages.length} stages, ${replay.durationMs} ms`
      : replay.ok
        ? 'trace: no stages'
        : 'trace does not verify';

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">`,
    `<title>${escapeXml(title)}</title>`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
  ];

  if (!replay.ok) {
    parts.push(
      `<text x="${PAD_LEFT}" y="${PAD_TOP}" font-family="monospace" font-size="${LABEL}" fill="#b3261e">${escapeXml(
        replay.errors[0] ?? 'trace does not verify',
      )}</text>`,
    );
    parts.push('</svg>');
    return parts.join('\n');
  }

  if (replay.stages.length === 0) {
    parts.push(
      `<text x="${PAD_LEFT}" y="${PAD_TOP}" font-family="monospace" font-size="${LABEL}" fill="#444444">trace: no stages</text>`,
    );
    parts.push('</svg>');
    return parts.join('\n');
  }

  replay.stages.forEach((stage, index) => {
    const y = PAD_TOP + index * rowHeight;
    // A zero-duration stage still gets a hairline: a bar of width 0 is invisible,
    // and "this stage was skipped" is information.
    const barWidth = total === 0 ? 1 : Math.max(1, Math.round((stage.durationMs / total) * barSpace));
    const failed = stage.status === 'error';
    const fill = failed ? '#b3261e' : '#1a5fb4';
    parts.push(
      `<text x="8" y="${y + 14}" font-family="monospace" font-size="${LABEL}" fill="#111111">${escapeXml(stage.name)}</text>`,
    );
    parts.push(
      `<rect data-stage="${escapeXml(stage.name)}" data-status="${failed ? 'error' : 'ok'}" x="${PAD_LEFT}" y="${y + 3}" width="${barWidth}" height="${rowHeight - 8}" fill="${fill}"/>`,
    );
    parts.push(
      `<text x="${PAD_LEFT + barWidth + 6}" y="${y + 14}" font-family="monospace" font-size="${LABEL}" fill="#444444">${stage.durationMs} ms</text>`,
    );
  });

  const failure = replay.errors[0];
  if (failure !== undefined) {
    parts.push(
      `<text x="${PAD_LEFT}" y="${height - 6}" font-family="monospace" font-size="${LABEL}" fill="#b3261e">${escapeXml(
        failure,
      )}</text>`,
    );
  }

  parts.push('</svg>');
  return parts.join('\n');
}

/** The issue list as terminal text: errors first, a summary last, nothing hidden. */
export function renderIssueListText(list: IssueList): string {
  if (list.items.length === 0) return 'no issues\n0 errors, 0 warnings';
  const lines = list.items.map((issue) => `${issue.severity.padEnd(5)} ${issue.code}: ${issue.message}`);
  const summary = `${list.counts.error} error${list.counts.error === 1 ? '' : 's'}, ${list.counts.warn} warning${
    list.counts.warn === 1 ? '' : 's'
  }`;
  lines.push(summary);
  // A blocking list is prefixed rather than suffixed: the first line is what shows
  // up in a CI annotation.
  return list.blocking ? `BLOCKING\n${lines.join('\n')}` : lines.join('\n');
}
