import type { DatabaseSync } from 'node:sqlite';

export interface Candidate {
  mint: string;
  created_at: number;
  /** Distinct non-deployer buy wallets inside the first `windowS` seconds. */
  buyers: number;
}

export interface WatchOpts {
  minBuyers: number;
  windowS: number;
  maxAgeS: number;
}

/**
 * Launches worth paying for: created within `maxAgeS`, with at least `minBuyers` distinct non-deployer
 * buyers inside the first `windowS` seconds (the filter from skill pumpwire-scout). Evaluated as soon as
 * the threshold is met, so a hot launch is scored before the window closes. Read-only on the DB.
 */
export function findCandidates(db: DatabaseSync, nowS: number, opts: WatchOpts, isSeen: (mint: string) => boolean): Candidate[] {
  const rows = db
    .prepare(
      `SELECT t.mint AS mint, t.created_at AS created_at, COUNT(DISTINCT r.wallet) AS buyers
       FROM tokens t
       JOIN trades r ON r.mint = t.mint AND r.side = 'buy' AND r.wallet != t.deployer AND r.ts <= t.created_at + ?
       WHERE t.created_at >= ? AND t.created_at <= ?
       GROUP BY t.mint
       HAVING buyers >= ?
       ORDER BY t.created_at DESC
       LIMIT 20`,
    )
    .all(opts.windowS, nowS - opts.maxAgeS, nowS, opts.minBuyers) as unknown as Candidate[];
  return rows.filter((r) => !isSeen(r.mint));
}
