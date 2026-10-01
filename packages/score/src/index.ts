export * from './types.js';
import type { RiskResult, ScoreSnapshot, Verdict } from './types.js';

export const MODEL_VERSION = 'v0.1.0';

/** Thrown by stubs until T-010 lands the v0 implementation (docs/INTERFACES.md §5). */
export class NotImplemented extends Error {
  constructor(what: string) {
    super(`${what} is a stub until T-010`);
    this.name = 'NotImplemented';
  }
}

/** Pure, deterministic rug-risk score for one mint. Spec: docs/INTERFACES.md §5. */
export function score(_snapshot: ScoreSnapshot): RiskResult {
  throw new NotImplemented('score()');
}

/** Verdict band for an integer score: 0–24 LOW · 25–49 MED · 50–74 HIGH · 75–100 EXTREME. */
export function verdictFor(_score: number): Verdict {
  throw new NotImplemented('verdictFor()');
}
