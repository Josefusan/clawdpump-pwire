import type {
  Base58, Evidence, Factor, Reason, RiskResult, ScoreSnapshot, Trade, Verdict, Wallet,
} from './types.js';

export const MODEL_VERSION = 'v0.1.0';

const FACTORS: Factor[] = [
  'deployer_history', 'bundled_launch', 'holder_concentration', 'dev_position',
  'fresh_wallets', 'funding_cluster', 'curve_velocity', 'metadata_flags',
];
const MAX_REASONS = 5;
const MAX_LIST = 10;
const EARLY_SLOTS = 2;
const FRESH_AGE_S = 86_400;
const CLUSTER_WINDOW_S = 21_600;

/** Half-up integer rounding of n/d for integer n ≥ 0, d > 0 (docs/INTERFACES.md §5). */
const rnd = (n: number, d: number): number => Math.floor((2 * n + d) / (2 * d));
const short = (a: Base58): string => `${a.slice(0, 4)}…${a.slice(-4)}`;
const cap = <T>(xs: T[]): T[] => xs.slice(0, MAX_LIST);

/** Verdict band for an integer score: 0–24 LOW · 25–49 MED · 50–74 HIGH · 75–100 EXTREME. */
export function verdictFor(s: number): Verdict {
  return s >= 75 ? 'EXTREME' : s >= 50 ? 'HIGH' : s >= 25 ? 'MED' : 'LOW';
}

/** NFKC, lowercase, strip everything but letters/digits. Used for trending-symbol comparison. */
export function normalizeSymbol(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

type Outcome = { points: number; detail: string; evidence: Evidence } | 'gap' | null;

const bySlotSig = (a: Trade, b: Trade): number =>
  a.slot - b.slot || (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0);

function groupBy<T, K extends string>(items: T[], key: (x: T) => K | null): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    if (k == null) continue;
    const g = m.get(k);
    if (g) g.push(it); else m.set(k, [it]);
  }
  return m;
}

function largest<T, K extends string>(groups: Map<K, T[]>): { key: K; members: T[] } | null {
  let best: { key: K; members: T[] } | null = null;
  for (const [key, members] of groups) {
    if (!best || members.length > best.members.length || (members.length === best.members.length && key < best.key)) {
      best = { key, members };
    }
  }
  return best;
}

function deployerHistory(s: ScoreSnapshot): Outcome {
  const bad = s.deployer_prior.filter((p) => p.outcome === 'DEAD_1H' || p.outcome === 'DEV_DUMP');
  const v = bad.length;
  if (v === 0) return null;
  const points = v === 1 ? 10 : v === 2 ? 18 : 25;
  return {
    points,
    detail: `${v} prior launches by deployer or wallets it funded ended DEAD_1H or DEV_DUMP`,
    evidence: { value: v, threshold: 1, mints: cap(bad.map((p) => p.mint)) },
  };
}

function bundledLaunch(s: ScoreSnapshot, early: Trade[]): Outcome {
  const buyers = new Map<Base58, Trade>();
  for (const t of early) {
    if (t.side === 'buy' && t.wallet !== s.token.deployer && !buyers.has(t.wallet)) buyers.set(t.wallet, t);
  }
  const enriched = [...buyers.keys()].filter((w) => isEnriched(s.wallets[w]));
  if (enriched.length < 3) return 'gap';
  const best = largest(groupBy(enriched, (w) => s.wallets[w]?.funder ?? null));
  if (!best || best.members.length < 3) return null;
  const v = best.members.length;
  const trades = best.members.map((w) => buyers.get(w)!);
  const slots = trades.map((t) => t.slot);
  return {
    points: Math.min(20, 4 * v),
    detail: `${v} early-window buyers share funder ${short(best.key)}, buying in slots ${Math.min(...slots)}..${Math.max(...slots)}`,
    evidence: {
      value: v, threshold: 3, wallets: cap(best.members),
      slots: cap([...new Set(slots)].sort((a, b) => a - b)),
      sigs: cap(trades.map((t) => t.sig)),
    },
  };
}

/** Per-wallet net token balance (buys − sells, floored at 0). */
function balances(trades: Trade[]): Map<Base58, number> {
  const m = new Map<Base58, number>();
  for (const t of trades) m.set(t.wallet, (m.get(t.wallet) ?? 0) + (t.side === 'buy' ? t.token_amount : -t.token_amount));
  for (const [w, b] of m) if (b < 0) m.set(w, 0);
  return m;
}

/** floor(10000·a/b) in basis points, exact for raw base-unit magnitudes. */
const toBp = (a: number, b: number): number => Number((BigInt(Math.trunc(a)) * 10_000n) / BigInt(Math.trunc(b)));

function holderConcentration(s: ScoreSnapshot, bal: Map<Base58, number>): Outcome {
  if (s.trades.length === 0 || s.total_supply <= 0) return 'gap';
  const top = [...bal.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10);
  const bp = toBp(top.reduce((n, [, b]) => n + b, 0), s.total_supply);
  const points = bp <= 1500 ? 0 : bp >= 3500 ? 15 : rnd(15 * (bp - 1500), 2000);
  if (points === 0) return null;
  return {
    points,
    detail: `top 10 holders control ${bp / 100}% of supply`,
    evidence: { value: bp / 100, threshold: 15, wallets: cap(top.map(([w]) => w)) },
  };
}

function devPosition(s: ScoreSnapshot, bal: Map<Base58, number>): Outcome {
  const dev = s.token.deployer;
  let bought = 0, sold = 0;
  const sigs: string[] = [];
  for (const t of s.trades) {
    if (t.wallet !== dev) continue;
    if (t.side === 'buy') bought += t.token_amount;
    else { sold += t.token_amount; sigs.push(t.sig); }
  }
  const soldBp = bought > 0 ? toBp(sold, bought) : 0;
  const holdBp = s.total_supply > 0 ? toBp(bal.get(dev) ?? 0, s.total_supply) : 0;
  if (soldBp > 5000) {
    return {
      points: 10, detail: `deployer ${short(dev)} sold ${soldBp / 100}% of the tokens it bought`,
      evidence: { value: soldBp / 100, threshold: 50, wallets: [dev], sigs: cap(sigs) },
    };
  }
  if (holdBp > 1000) {
    return {
      points: 10, detail: `deployer ${short(dev)} holds ${holdBp / 100}% of supply`,
      evidence: { value: holdBp / 100, threshold: 10, wallets: [dev] },
    };
  }
  return null;
}

/** First 30 distinct non-deployer buyers by (slot, sig), as their first buy trade. */
function firstBuyers(s: ScoreSnapshot, sorted: Trade[]): Trade[] {
  const seen = new Set<Base58>();
  const out: Trade[] = [];
  for (const t of sorted) {
    if (out.length >= 30) break;
    if (t.side !== 'buy' || t.wallet === s.token.deployer || seen.has(t.wallet)) continue;
    seen.add(t.wallet);
    out.push(t);
  }
  return out;
}

const isEnriched = (w: Wallet | undefined): boolean => w?.enriched_at != null;

function freshWallets(s: ScoreSnapshot, first: Trade[]): Outcome {
  const enriched = first.filter((t) => isEnriched(s.wallets[t.wallet]));
  const e = enriched.length;
  if (e < 5) return 'gap';
  const fresh = enriched.filter((t) => {
    const w = s.wallets[t.wallet]!;
    return w.first_seen_ts != null && w.tx_count != null && t.ts - w.first_seen_ts < FRESH_AGE_S && w.tx_count < 3;
  });
  const f = fresh.length;
  if (5 * f <= e) return null;
  const points = 10 * f >= 7 * e ? 10 : rnd(20 * f - 4 * e, e);
  if (points === 0) return null;
  const v = rnd(100 * f, e);
  return {
    points,
    detail: `${f} of ${e} early buyers with known history are fresh wallets (${v}%)`,
    evidence: { value: v, threshold: 20, wallets: cap(fresh.map((t) => t.wallet)), sigs: cap(fresh.map((t) => t.sig)) },
  };
}

function fundingCluster(s: ScoreSnapshot, first: Trade[]): Outcome {
  const enriched = first.filter((t) => isEnriched(s.wallets[t.wallet]));
  if (enriched.length < 5) return 'gap';
  const linked = enriched.filter((t) => {
    const w = s.wallets[t.wallet]!;
    return w.funder != null && w.funder_ts != null && t.ts - w.funder_ts <= CLUSTER_WINDOW_S;
  });
  const best = largest(groupBy(linked, (t) => s.wallets[t.wallet]!.funder));
  if (!best || best.members.length < 3) return null;
  const v = best.members.length;
  return {
    points: Math.min(10, 2 * v),
    detail: `${v} of the first 30 buyers were funded by ${short(best.key)} within 6h of buying`,
    evidence: {
      value: v, threshold: 3, wallets: cap(best.members.map((t) => t.wallet)), sigs: cap(best.members.map((t) => t.sig)),
    },
  };
}

function curveVelocity(s: ScoreSnapshot): Outcome {
  const buyers = new Set(s.trades.filter((t) => t.side === 'buy').map((t) => t.wallet)).size;
  const pct = s.token.curve_pct;
  if (pct == null || buyers === 0) return 'gap';
  const raw = pct / buyers;
  const points = raw >= 2 ? 5 : raw >= 1 ? 3 : 0;
  if (points === 0) return null;
  const v = Math.round(raw * 100) / 100;
  return {
    points,
    detail: `bonding curve gained ${v} percentage points per unique buyer (${pct}% over ${buyers} buyers)`,
    evidence: { value: v, threshold: raw >= 2 ? 2 : 1 },
  };
}

function metadataFlags(s: ScoreSnapshot): Outcome {
  const { symbol, has_socials } = s.token;
  if (has_socials == null && symbol == null) return 'gap';
  const norm = symbol == null ? '' : normalizeSymbol(symbol);
  const copied = norm === '' ? [] : s.trending_symbols.filter((t) => t.symbol_norm === norm);
  let points = 0, flags = 0;
  if (copied.length > 0) { points += 3; flags += 1; }
  if (has_socials === false) { points += 2; flags += 1; }
  if (points === 0) return null;
  const parts = [copied.length > 0 ? 'symbol copies a trending token' : '', has_socials === false ? 'no socials listed' : ''];
  return {
    points: Math.min(5, points),
    detail: `${flags} metadata flags raised: ${parts.filter(Boolean).join(', ')}`,
    evidence: { value: flags, ...(copied.length > 0 ? { mints: cap(copied.map((t) => t.mint)) } : {}) },
  };
}

/** Pure, deterministic rug-risk score for one mint. Spec: docs/INTERFACES.md §5. Never throws on missing data. */
export function score(s: ScoreSnapshot): RiskResult {
  const sorted = [...s.trades].sort(bySlotSig);
  const bal = balances(sorted);
  const first = firstBuyers(s, sorted);
  const lo = s.token.created_slot;
  const early = sorted.filter((t) => t.slot >= lo && t.slot <= lo + EARLY_SLOTS);

  const outcomes: Record<Factor, Outcome> = {
    deployer_history: deployerHistory(s),
    bundled_launch: bundledLaunch(s, early),
    holder_concentration: holderConcentration(s, bal),
    dev_position: devPosition(s, bal),
    fresh_wallets: freshWallets(s, first),
    funding_cluster: fundingCluster(s, first),
    curve_velocity: curveVelocity(s),
    metadata_flags: metadataFlags(s),
  };

  const reasons: Reason[] = [];
  const data_gaps: Factor[] = [];
  let total = 0;
  for (const factor of FACTORS) {
    const o = outcomes[factor];
    if (o === 'gap') data_gaps.push(factor);
    else if (o && o.points > 0) {
      reasons.push({ factor, ...o });
      total += o.points;
    }
  }
  reasons.sort((a, b) => b.points - a.points || FACTORS.indexOf(a.factor) - FACTORS.indexOf(b.factor));
  const final = Math.min(100, total);
  return {
    mint: s.token.mint,
    score: final,
    verdict: verdictFor(final),
    reasons: reasons.slice(0, MAX_REASONS),
    data_gaps,
    model_version: MODEL_VERSION,
    as_of_slot: sorted.length > 0 ? sorted[sorted.length - 1]!.slot : s.token.created_slot,
    as_of_ts: s.as_of_ts,
  };
}
