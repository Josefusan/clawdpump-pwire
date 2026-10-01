import type { DatabaseSync } from 'node:sqlite';
import { score } from '@pumpwire/score';
import { buildSnapshot } from './snapshot.js';
import type { RiskResult } from './types.js';

export const CACHE_TTL_S = 30;

export type ScoreFn = (db: DatabaseSync, mint: string, nowS: number) => RiskResult;

/** Real score source: snapshot from the DB (read-only SELECTs), then the pure `score()`. */
export const dbScore: ScoreFn = (db, mint, nowS) => {
  const snap = buildSnapshot(db, mint, nowS);
  if (!snap) throw new Error('mint not found');
  return score(snap);
};

/** Per-mint cache: a result is reused for `ttlS` seconds. Errors are never cached. */
export function cachedScore(inner: ScoreFn, ttlS = CACHE_TTL_S, maxEntries = 5000): ScoreFn {
  const cache = new Map<string, { at: number; result: RiskResult }>();
  return (db, mint, nowS) => {
    const hit = cache.get(mint);
    if (hit && nowS - hit.at < ttlS && nowS >= hit.at) return hit.result;
    const result = inner(db, mint, nowS);
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
    cache.set(mint, { at: nowS, result });
    return result;
  };
}

export function tokenExists(db: DatabaseSync, mint: string): boolean {
  return db.prepare('SELECT 1 AS x FROM tokens WHERE mint = ?').get(mint) !== undefined;
}
