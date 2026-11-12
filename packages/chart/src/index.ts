export { distinctValues, inferType, profileRows, refFor } from './profile.js';
export type { FieldProfile } from './profile.js';
export { enumerateCandidates } from './candidates.js';
export type { Candidate } from './candidates.js';
export { LINT_RULES, isRenderable, lint } from './lint.js';
export type { LintIssue, LintRule, Severity } from './lint.js';
export { compileToECharts } from './compile.js';
export type { EChartsOption } from './compile.js';
export { supportOf } from './support.js';
export type { SupportVerdict } from './support.js';
export { MARKS, describeMark } from './marks.js';
export type { MarkSpec } from './marks.js';
export { CHART_CUES, readCues, recommendChart, toChartIR } from './recommend.js';
export type {
  ChartChoice,
  ChartIROptions,
  Cue,
  CueKind,
  CueRule,
  RecommendableMark,
  Recommendation,
  RecommendOptions,
  Refusal,
} from './recommend.js';
