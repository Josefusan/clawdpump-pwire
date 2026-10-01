import type { DatabaseSync } from 'node:sqlite';
import type { RiskResult } from './types.js';

export const STUB_MODEL_VERSION = 'v0.0.0-stub';

export type ScoreFn = (db: DatabaseSync, mint: string, nowS: number) => RiskResult;

/** STUB until T-010 wires the real `score()`; deterministic, correct `RiskResult` shape, no reasons. */
export const stubScore: ScoreFn = (db, mint, nowS) => {
  const row = db.prepare('SELECT created_slot FROM tokens WHERE mint = ?').get(mint) as
    | { created_slot: number }
    | undefined;
  return {
    mint,
    score: 0,
    verdict: 'LOW',
    reasons: [],
    data_gaps: [],
    model_version: STUB_MODEL_VERSION,
    as_of_slot: row?.created_slot ?? 0,
    as_of_ts: nowS,
  };
};

export function tokenExists(db: DatabaseSync, mint: string): boolean {
  return db.prepare('SELECT 1 AS x FROM tokens WHERE mint = ?').get(mint) !== undefined;
}
