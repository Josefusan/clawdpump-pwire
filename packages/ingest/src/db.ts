import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Parsed, ParsedCreate, ParsedTrade } from './parse.js';

const SCHEMA_PATH = fileURLToPath(new URL('../../../docs/schema.sql', import.meta.url));

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA_PATH, 'utf8')); // idempotent (IF NOT EXISTS) + per-connection PRAGMAs
  return db;
}

export interface ApplyResult {
  tokens: number;
  trades: number;
  deployers: number;
  migrated: number;
  duplicate: boolean;
}

const empty = (): ApplyResult => ({ tokens: 0, trades: 0, deployers: 0, migrated: 0, duplicate: false });

export class Store {
  private readonly insToken;
  private readonly upDeployer;
  private readonly insTrade;
  private readonly upMigrate;
  private readonly firstBuyers;

  constructor(private readonly db: DatabaseSync) {
    this.insToken = db.prepare(
      `INSERT INTO tokens (mint, name, symbol, uri, deployer, created_slot, created_at, has_socials)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mint) DO NOTHING`,
    );
    this.upDeployer = db.prepare(
      `INSERT INTO deployers (address, launches, last_launch_ts) VALUES (?, 1, ?)
       ON CONFLICT(address) DO UPDATE SET launches = launches + 1, last_launch_ts = excluded.last_launch_ts`,
    );
    this.insTrade = db.prepare(
      `INSERT INTO trades (sig, mint, wallet, side, lamports, token_amount, slot, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sig) DO NOTHING`,
    );
    this.firstBuyers = db.prepare(
      `SELECT t.wallet FROM trades t JOIN tokens k ON k.mint = t.mint
       WHERE t.mint = ? AND t.side = 'buy' AND t.wallet != k.deployer
       GROUP BY t.wallet ORDER BY MIN(t.slot), MIN(t.sig) LIMIT 30`,
    );
    this.upMigrate = db.prepare(`UPDATE tokens SET migrated = 1, curve_pct = 100 WHERE mint = ? AND migrated = 0`);
  }

  private create(m: ParsedCreate, slot: number, ts: number): ApplyResult {
    const r = empty();
    this.db.exec('BEGIN');
    try {
      const social = m.hasSocials === null ? null : m.hasSocials ? 1 : 0;
      const ins = this.insToken.run(m.mint, m.name, m.symbol, m.uri, m.deployer, slot, ts, social);
      if (Number(ins.changes) === 1) {
        this.upDeployer.run(m.deployer, ts); // only for a new token: re-feeds never inflate launches
        r.tokens = 1;
        r.deployers = 1;
      } else r.duplicate = true;
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return r;
  }

  private trade(m: ParsedTrade, slot: number, ts: number): ApplyResult {
    const r = empty();
    const ins = this.insTrade.run(m.sig, m.mint, m.wallet, m.side, m.lamports, m.tokenAmount, slot, ts);
    if (Number(ins.changes) === 1) r.trades = 1;
    else r.duplicate = true;
    return r;
  }

  /** True if `wallet` is among the first 30 distinct non-deployer buyers of `mint` (by slot, sig). */
  isFirst30Buyer(mint: string, wallet: string): boolean {
    return (this.firstBuyers.all(mint) as { wallet: string }[]).some((r) => r.wallet === wallet);
  }

  /** Writes one parsed message. slot/ts are ingest-derived (the feed has neither). */
  apply(m: Parsed, slot: number, ts: number): ApplyResult {
    switch (m.kind) {
      case 'create':
        return this.create(m, slot, ts);
      case 'trade':
        return this.trade(m, slot, ts);
      case 'migrate': {
        const r = empty();
        r.migrated = Number(this.upMigrate.run(m.mint).changes);
        return r;
      }
      default:
        return empty();
    }
  }
}
