import type { DatabaseSync } from 'node:sqlite';
import { normalizeSymbol, type Base58, type ScoreSnapshot, type Token, type Trade, type Wallet } from '@pumpwire/score';

// pump.fun mints a fixed 1e9-token supply with 6 decimals.
export const PUMP_TOTAL_SUPPLY = 1_000_000_000_000_000;
const EARLY_SLOTS = 2;
const FIRST_BUYERS = 30;
const TRENDING_LIMIT = 20;
const DAY_S = 86_400;

type Row = Record<string, unknown>;

/** Read-only: SELECTs only, every value bound as a parameter. Returns null if the mint is unknown. */
export function buildSnapshot(db: DatabaseSync, mint: Base58, nowS: number): ScoreSnapshot | null {
  const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint) as Row | undefined;
  if (!t) return null;
  const token: Token = {
    mint,
    name: t.name as string | null,
    symbol: t.symbol as string | null,
    uri: t.uri as string | null,
    deployer: t.deployer as string,
    created_slot: t.created_slot as number,
    created_at: t.created_at as number,
    curve_pct: t.curve_pct as number | null,
    migrated: t.migrated === 1,
    has_socials: t.has_socials == null ? null : t.has_socials === 1,
    outcome: t.outcome as Token['outcome'],
    outcome_at: t.outcome_at as number | null,
  };

  const trades = db
    .prepare('SELECT sig, mint, wallet, side, lamports, token_amount, slot, ts FROM trades WHERE mint = ? ORDER BY slot, sig')
    .all(mint) as unknown as Trade[];

  // First 30 buyers (excl. deployer) + every early-window buyer need wallet rows.
  const want = new Set<Base58>();
  const seen = new Set<Base58>();
  for (const x of trades) {
    if (x.side !== 'buy' || x.wallet === token.deployer) continue;
    if (!seen.has(x.wallet) && seen.size < FIRST_BUYERS) { seen.add(x.wallet); want.add(x.wallet); }
    if (x.slot >= token.created_slot && x.slot <= token.created_slot + EARLY_SLOTS) want.add(x.wallet);
  }
  const wallets: Record<Base58, Wallet> = {};
  const wrows = db
    .prepare('SELECT address, first_seen_ts, tx_count, funder, funder_ts, enriched_at FROM wallets WHERE address IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify([...want])) as unknown as Wallet[];
  for (const w of wrows) wallets[w.address] = w;

  // Prior launches by the deployer and by wallets the deployer funded.
  const funded = db
    .prepare('SELECT dst FROM funding_edges WHERE src = ? UNION SELECT address FROM wallets WHERE funder = ?')
    .all(token.deployer, token.deployer) as { dst: string }[];
  const owners = JSON.stringify([token.deployer, ...funded.map((r) => r.dst)]);
  const deployer_prior = db
    .prepare(
      `SELECT mint, outcome, created_at FROM tokens
       WHERE deployer IN (SELECT value FROM json_each(?)) AND mint != ? AND created_at <= ?
       ORDER BY created_at DESC, mint LIMIT 200`,
    )
    .all(owners, mint, token.created_at) as unknown as ScoreSnapshot['deployer_prior'];

  const trending = db
    .prepare(
      `SELECT tk.mint AS mint, tk.symbol AS symbol FROM trades tr JOIN tokens tk ON tk.mint = tr.mint
       WHERE tr.ts >= ? AND tr.mint != ? GROUP BY tk.mint ORDER BY COUNT(*) DESC, tk.mint LIMIT ?`,
    )
    .all(nowS - DAY_S, mint, TRENDING_LIMIT) as { mint: string; symbol: string | null }[];
  const trending_symbols = trending
    .filter((r) => r.symbol != null)
    .map((r) => ({ mint: r.mint, symbol_norm: normalizeSymbol(r.symbol as string) }))
    .filter((r) => r.symbol_norm !== '');

  const last = trades.length > 0 ? trades[trades.length - 1]!.slot : token.created_slot;
  return {
    token, trades, wallets, deployer_prior, trending_symbols,
    total_supply: PUMP_TOTAL_SUPPLY, as_of_slot: last, as_of_ts: nowS,
  };
}
