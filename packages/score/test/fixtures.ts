// Hand-built ScoreSnapshot fixtures for the v0 score suite (docs/INTERFACES.md §5.4).
// Deterministic: no clocks, no randomness, no network, no DB.
//
// Baseline `cleanLaunch()` scores 0 on every factor with no data gaps, so each test
// mutates exactly the inputs of the factor(s) it targets and can assert an exact score.
import type { Base58, Outcome, ScoreSnapshot, Trade, TxSig, Wallet } from '../src/index.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Fixed-width base58 encoding of a non-negative integer (lexicographic order = numeric order). */
function enc(n: number, width: number): string {
  let s = '';
  for (let i = 0; i < width; i++) {
    s = ALPHABET.charAt(n % 58) + s;
    n = Math.floor(n / 58);
  }
  return s;
}

function pad(label: string, len: number): string {
  if (!B58.test(label) || label.length > len) throw new Error(`bad fixture label ${label}`);
  return label + '1'.repeat(len - label.length);
}

export const addr = (label: string): Base58 => pad(label, 44);
export const sig = (n: number): TxSig => pad('Sig' + enc(n, 6), 88);

export const T0 = 1_790_000_000;                 // token created_at (unix s)
export const SLOT0 = 300_000_000;                // token created_slot
export const DAY = 86_400;
export const SUPPLY = 1_000_000_000_000_000;     // raw base units (1e9 tokens × 1e6)
/** Token amount for `n` basis points of supply. */
export const bp = (n: number): number => n * (SUPPLY / 10_000);

export const MINT = addr('MintTarget');
export const DEPLOYER = addr('DevWa11et');
export const BUNDLER = addr('BundFunder');
export const CLUSTER = addr('CFunder');
export const buyer = (i: number): Base58 => addr('Buyer' + enc(i, 3));
const funderOf = (i: number): Base58 => addr('Funder' + enc(i, 3));

const slotOf = (i: number): number => (i < 5 ? SLOT0 + Math.floor(i / 2) : SLOT0 + 3 + i);
const tsOf = (slot: number): number => T0 + (slot - SLOT0);

export const TRENDING = [
  { mint: addr('TrendPepe'), symbol_norm: 'pepe' },
  { mint: addr('TrendWif'), symbol_norm: 'wif' },
];

/**
 * Clean launch: deployer buys 3% at creation; `buyers` distinct wallets buy 1% each
 * (buyers 0..4 inside the early window SLOT0..SLOT0+2, the rest later); every buyer is
 * enriched, 30 days old, 50 txs, with its own funder funded 30 days ago; curve 20%;
 * socials present; one prior launch that SURVIVED_24H. Every factor = 0, data_gaps = [].
 */
export function cleanLaunch(buyers = 40): ScoreSnapshot {
  const trades: Trade[] = [
    { sig: sig(0), mint: MINT, wallet: DEPLOYER, side: 'buy', lamports: 1_000_000_000, token_amount: bp(300), slot: SLOT0, ts: T0 },
  ];
  const wallets: Record<Base58, Wallet> = {};
  for (let i = 0; i < buyers; i++) {
    const slot = slotOf(i);
    trades.push({ sig: sig(i + 1), mint: MINT, wallet: buyer(i), side: 'buy', lamports: 500_000_000, token_amount: bp(100), slot, ts: tsOf(slot) });
    wallets[buyer(i)] = {
      address: buyer(i), first_seen_ts: T0 - 30 * DAY, tx_count: 50,
      funder: funderOf(i), funder_ts: T0 - 30 * DAY, enriched_at: T0 + 600,
    };
  }
  return {
    token: {
      mint: MINT, name: 'Clean Coin', symbol: 'CLEAN', uri: 'https://example.invalid/clean.json',
      deployer: DEPLOYER, created_slot: SLOT0, created_at: T0, curve_pct: 20, migrated: false,
      has_socials: true, outcome: null, outcome_at: null,
    },
    trades,
    wallets,
    deployer_prior: [{ mint: addr('PriorGood'), outcome: 'SURVIVED_24H', created_at: T0 - 5 * DAY }],
    trending_symbols: TRENDING.map((t) => ({ ...t })),
    total_supply: SUPPLY,
    as_of_slot: Math.max(...trades.map((t) => t.slot)),
    as_of_ts: T0 + 3600,
  };
}

function wallet(s: ScoreSnapshot, i: number): Wallet {
  const w = s.wallets[buyer(i)];
  if (!w) throw new Error(`fixture has no buyer ${i}`);
  return w;
}

function buyTrade(s: ScoreSnapshot, i: number): Trade {
  const t = s.trades.find((x) => x.wallet === buyer(i) && x.side === 'buy');
  if (!t) throw new Error(`fixture has no buy for buyer ${i}`);
  return t;
}

export const buyTs = (s: ScoreSnapshot, i: number): number => buyTrade(s, i).ts;

export function setBuyerBp(s: ScoreSnapshot, idx: number[], n: number): void {
  for (const i of idx) buyTrade(s, i).token_amount = bp(n);
}

export function setAllBuyersBp(s: ScoreSnapshot, n: number): void {
  for (const t of s.trades) if (t.wallet !== DEPLOYER) t.token_amount = bp(n);
}

export function setDevBuyBp(s: ScoreSnapshot, n: number): void {
  for (const t of s.trades) if (t.wallet === DEPLOYER && t.side === 'buy') t.token_amount = bp(n);
}

/** Deployer sells `n` bp of supply for `lamports`, one slot after the last trade. */
export function devSell(s: ScoreSnapshot, n: number, lamports: number): void {
  const slot = Math.max(...s.trades.map((t) => t.slot)) + 1;
  s.trades.push({ sig: sig(10_000 + s.trades.length), mint: MINT, wallet: DEPLOYER, side: 'sell', lamports, token_amount: bp(n), slot, ts: tsOf(slot) });
  s.as_of_slot = slot;
}

export function removeDevTrades(s: ScoreSnapshot): void {
  s.trades = s.trades.filter((t) => t.wallet !== DEPLOYER);
}

export function unenrich(s: ScoreSnapshot, idx: number[]): void {
  for (const i of idx) {
    Object.assign(wallet(s, i), { first_seen_ts: null, tx_count: null, funder: null, funder_ts: null, enriched_at: null });
  }
}

/** Wallet first seen (and funded, by its own funder) 1h before its buy, with 1 tx. */
export function makeFresh(s: ScoreSnapshot, idx: number[]): void {
  for (const i of idx) {
    const ts = buyTs(s, i) - 3600;
    Object.assign(wallet(s, i), { first_seen_ts: ts, funder_ts: ts, tx_count: 1 });
  }
}

/** Buyers `idx` share `funder`, funded (and first seen) at `funderTs`. */
export function shareFunder(s: ScoreSnapshot, idx: number[], funder: Base58, funderTs: number): void {
  for (const i of idx) Object.assign(wallet(s, i), { funder, funder_ts: funderTs, first_seen_ts: funderTs });
}

export function addPriors(s: ScoreSnapshot, outcomes: (Outcome | null)[]): void {
  outcomes.forEach((outcome, k) => {
    s.deployer_prior.push({ mint: addr('Prior' + enc(k, 2)), outcome, created_at: T0 - (k + 1) * DAY });
  });
}

export const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, k) => from + k);
