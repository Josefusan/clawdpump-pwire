#!/usr/bin/env node
// Outcome labeller (T-014 follow-up). Fills tokens.outcome / tokens.outcome_at for launches old enough to judge,
// using the same mechanical rules as the backtest (labelToken in scripts/backtest.mjs). Without these labels the
// scorer's deployer_history factor can never fire and /v1/stats.caught stays empty.
//
// Usage: node [--experimental-sqlite] scripts/label-outcomes.mjs [--db ~/pumpwire-data/pumpwire.db] [--min-age 7200]
//        [--limit 5000] [--now <unix>] [--dry-run]
// Writes the LIVE DB (short transaction, busy_timeout 5 s); safe to run hourly from cron next to the ingest writer.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { labelToken } from './backtest.mjs';

function parseArgs(argv) {
  const a = { db: process.env.PUMPWIRE_DB_PATH ?? `${process.env.HOME}/pumpwire-data/pumpwire.db`, minAge: 7200, limit: 5000, now: Math.floor(Date.now() / 1000), dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]; const v = argv[i + 1];
    if (k === '--dry-run') { a.dryRun = true; continue; }
    if (k === '--db') a.db = v; else if (k === '--min-age') a.minAge = Number(v); else if (k === '--limit') a.limit = Number(v); else if (k === '--now') a.now = Number(v); else continue;
    i++;
  }
  return a;
}

/** When the outcome became true (unix s), from the same trades labelToken saw. */
export function outcomeTs(token, trades, outcome, nowS) {
  if (outcome === 'DEAD_1H') return token.created_at + 3600;
  if (outcome === 'SURVIVED_24H') return Math.min(nowS, token.created_at + 86400);
  // DEV_DUMP: the first trade at which the deployer's sells reached 50% of its buys (within 24 h)
  let bought = 0, sold = 0;
  const devBuys = trades.filter((t) => t.wallet === token.deployer && t.side === 'buy' && t.ts <= token.created_at + 86400).reduce((s, t) => s + t.token_amount, 0);
  for (const t of trades) {
    if (t.wallet !== token.deployer || t.ts > token.created_at + 86400) continue;
    if (t.side === 'buy') bought += t.token_amount; else sold += t.token_amount;
    if (devBuys > 0 && sold * 2 >= devBuys) return t.ts;
  }
  return trades.length ? trades[trades.length - 1].ts : token.created_at;
}

/** Label every unlabelled token older than minAge. Returns counts. Pure apart from the UPDATEs. */
export function labelOutcomes(db, nowS, { minAge = 7200, limit = 5000, dryRun = false } = {}) {
  const tokens = db.prepare('SELECT mint, deployer, created_at, migrated FROM tokens WHERE outcome IS NULL AND created_at <= ? ORDER BY created_at LIMIT ?').all(nowS - minAge, limit);
  const tradesFor = db.prepare('SELECT wallet, side, token_amount, ts FROM trades WHERE mint = ? ORDER BY ts, sig');
  const upd = db.prepare('UPDATE tokens SET outcome = ?, outcome_at = ? WHERE mint = ? AND outcome IS NULL');
  const counts = { DEAD_1H: 0, DEV_DUMP: 0, SURVIVED_24H: 0, undecided: 0 };
  const rows = [];
  for (const tk of tokens) {
    const trades = tradesFor.all(tk.mint);
    const outcome = labelToken(tk, trades, nowS, minAge);
    if (!outcome) { counts.undecided++; continue; }
    rows.push([outcome, outcomeTs(tk, trades, outcome, nowS), tk.mint]);
    counts[outcome]++;
  }
  if (!dryRun && rows.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) upd.run(...r);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return { examined: tokens.length, labelled: rows.length, counts, dry_run: dryRun };
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = parseArgs(process.argv);
  if (!existsSync(args.db)) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), error: `DB not found at ${args.db}` }));
    process.exit(0); // nothing to label yet (ingest not started): not a failure for cron
  }
  const db = new DatabaseSync(args.db);
  db.exec('PRAGMA busy_timeout = 5000');
  const out = labelOutcomes(db, args.now, args);
  db.close();
  console.log(JSON.stringify({ ts: new Date().toISOString(), db: args.db, min_age_s: args.minAge, ...out }));
}
