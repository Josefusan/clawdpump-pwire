export const name = 'scout';
export { loadScoutConfig, type ScoutConfig } from './config.js';
export { findCandidates, type Candidate, type WatchOpts } from './watch.js';
export { alertMarkdown, asRisk, isAlertWorthy, writeAlertDraft, type RiskLike } from './alerts.js';
export { SeenStore, step, type StepDeps, type StepResult, type Halt } from './loop.js';
