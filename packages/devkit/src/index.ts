export { formatReport, recordCase, runContractSuite } from './contract.js';
export type { CaseResult, ContractCase, ContractExpectation } from './contract.js';
export { compareArms, sameResult, sameRows, summarise } from './bench.js';
export type { ArmResult, CaseOutcome, PairedComparison, ResultSet } from './bench.js';
export { mcnemarExact, wilsonInterval } from './stats.js';
export type { Interval } from './stats.js';
