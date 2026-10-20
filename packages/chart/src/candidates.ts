import type { ChartType } from '@agentix-e/nl2charts-spec';
import type { FieldProfile } from './profile.js';

export interface Candidate {
  readonly mark: ChartType;
  readonly score: number;
  readonly reason: string;
}

/**
 * Enumerate the charts that are structurally valid for a result set. This is a
 * ranking, not a decision: linting and the caller's preference come after.
 */
export function enumerateCandidates(profiles: readonly FieldProfile[], maxSlices = 7): Candidate[] {
  const quantitative = profiles.filter((profile) => profile.type === 'quantitative');
  const temporal = profiles.filter((profile) => profile.type === 'temporal');
  const nominal = profiles.filter((profile) => profile.type === 'nominal' || profile.type === 'ordinal');
  const candidates: Candidate[] = [];

  if (quantitative.length === 0) return candidates;

  if (temporal.length >= 1 && quantitative.length >= 1) {
    candidates.push({ mark: 'line', score: 0.9, reason: 'temporal-x-quantitative-y' });
    candidates.push({ mark: 'bar', score: 0.75, reason: 'temporal-x-quantitative-y' });
  }
  if (nominal.length >= 1 && quantitative.length >= 1) {
    const category = nominal[0] as FieldProfile;
    candidates.push({ mark: 'bar', score: 0.8, reason: 'category-x-quantitative-y' });
    if (category.distinct <= maxSlices && !quantitative[0]?.negative) {
      candidates.push({ mark: 'pie', score: 0.6, reason: 'small-category-count' });
    }
  }
  if (quantitative.length >= 2) {
    candidates.push({ mark: 'scatter', score: 0.7, reason: 'two-quantitative-axes' });
  }
  if (nominal.length + temporal.length >= 2 && quantitative.length >= 1) {
    candidates.push({ mark: 'heatmap', score: 0.65, reason: 'two-dimensions-one-measure' });
  }
  if (nominal.length === 0 && quantitative.length === 1) {
    candidates.push({ mark: 'bar', score: 0.5, reason: 'single-measure-single-value' });
  }

  const seen = new Set<ChartType>();
  return candidates
    .filter((candidate) => {
      if (seen.has(candidate.mark)) return false;
      seen.add(candidate.mark);
      return true;
    })
    .sort((left, right) => right.score - left.score || left.mark.localeCompare(right.mark));
}
