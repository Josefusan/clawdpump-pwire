// v0 rug-risk score suite — written before the implementation (T-007; T-010 implements).
// Spec: docs/INTERFACES.md §5 (factors, formulas, verdict bands, output rules, §5.4 cases).
import { describe, expect, it } from 'vitest';
import { MODEL_VERSION, score, verdictFor } from '../src/index.js';
import type { Factor, RiskResult, ScoreSnapshot, Verdict } from '../src/index.js';
import {
  BUNDLER, CLUSTER, DAY, SLOT0, T0, TRENDING, addPriors, addr, buyTs, buyer, cleanLaunch, devSell,
  makeFresh, range, removeDevTrades, setAllBuyersBp, setBuyerBp, setDevBuyBp, shareFunder, unenrich,
} from './fixtures.js';

// Table order (§5.2) and max points (weights 25/20/15/10/10/10/5/5).
const FACTORS: Factor[] = [
  'deployer_history', 'bundled_launch', 'holder_concentration', 'dev_position',
  'fresh_wallets', 'funding_cluster', 'curve_velocity', 'metadata_flags',
];
const MAX: Record<Factor, number> = {
  deployer_history: 25, bundled_launch: 20, holder_concentration: 15, dev_position: 10,
  fresh_wallets: 10, funding_cluster: 10, curve_velocity: 5, metadata_flags: 5,
};

// Test oracle for the bands (0–24 LOW · 25–49 MED · 50–74 HIGH · 75–100 EXTREME).
const band = (s: number): Verdict => (s >= 75 ? 'EXTREME' : s >= 50 ? 'HIGH' : s >= 25 ? 'MED' : 'LOW');

/** Contract invariants every RiskResult must satisfy (§2, §5.3). */
function checkInvariants(r: RiskResult, snap: ScoreSnapshot): void {
  expect(r.mint).toBe(snap.token.mint);
  expect(r.model_version).toBe(MODEL_VERSION);
  expect(Number.isInteger(r.score)).toBe(true);
  expect(r.score).toBeGreaterThanOrEqual(0);
  expect(r.score).toBeLessThanOrEqual(100);
  expect(r.verdict).toBe(band(r.score));
  expect(r.as_of_ts).toBe(snap.as_of_ts);
  expect(r.reasons.length).toBeLessThanOrEqual(5);
  for (const x of r.reasons) {
    expect(Number.isInteger(x.points)).toBe(true);
    expect(x.points).toBeGreaterThanOrEqual(1);
    expect(x.points).toBeLessThanOrEqual(MAX[x.factor]);
    expect(Number.isFinite(x.evidence.value)).toBe(true); // raw number behind the points
    expect(x.detail).toMatch(/\d/);                        // detail carries a number
    for (const k of ['wallets', 'slots', 'sigs', 'mints'] as const) {
      expect((x.evidence[k] ?? []).length).toBeLessThanOrEqual(10);
    }
  }
  // Sorted by points desc, then table order.
  const key = (f: Factor) => FACTORS.indexOf(f);
  for (let i = 1; i < r.reasons.length; i++) {
    const a = r.reasons[i - 1]!, b = r.reasons[i]!;
    expect(a.points > b.points || (a.points === b.points && key(a.factor) < key(b.factor))).toBe(true);
  }
  const sum = r.reasons.reduce((n, x) => n + x.points, 0);
  if (r.reasons.length < 5) expect(sum).toBe(r.score);
  else expect(sum).toBeLessThanOrEqual(r.score);
  // data_gaps: table order, unique, never also a reason.
  expect(r.data_gaps).toEqual(FACTORS.filter((f) => r.data_gaps.includes(f)));
  for (const g of r.data_gaps) expect(r.reasons.map((x) => x.factor)).not.toContain(g);
}

type Want = [factor: Factor, points: number, value?: number];

/** Score `snap`, check invariants, then assert exact score, verdict, and reasons (factor, points, evidence.value). */
function expectScore(snap: ScoreSnapshot, total: number, verdict: Verdict, reasons: Want[], gaps: Factor[] = []): RiskResult {
  const r = score(snap);
  checkInvariants(r, snap);
  expect(r.score).toBe(total);
  expect(r.verdict).toBe(verdict);
  expect(r.reasons.map((x) => [x.factor, x.points])).toEqual(reasons.map(([f, p]) => [f, p]));
  reasons.forEach(([, , v], i) => {
    if (v !== undefined) expect(r.reasons[i]!.evidence.value).toBe(v);
  });
  expect(r.data_gaps).toEqual(gaps);
  return r;
}

describe('score() v0.1.0 — docs/INTERFACES.md §5.4', () => {
  it('S01 clean launch: 40 organic buyers, distinct funders, dev 3%, top10 12%, no rug priors → 0 LOW, no gaps', () => {
    const snap = cleanLaunch();
    const r = expectScore(snap, 0, 'LOW', []);
    expect(r.as_of_slot).toBe(Math.max(...snap.trades.map((t) => t.slot)));
  });

  it('S02 bundled launch: 5 early-window buyers share one funder → bundled_launch 20 (v=5)', () => {
    const snap = cleanLaunch();
    shareFunder(snap, range(0, 5), BUNDLER, T0 - 30 * DAY);
    const r = expectScore(snap, 20, 'LOW', [['bundled_launch', 20, 5]]);
    expect(r.reasons[0]!.evidence.wallets?.slice().sort()).toEqual(range(0, 5).map(buyer).sort());
  });

  it('S03 bundled launch below threshold: 2 early buyers share a funder → no bundled_launch reason', () => {
    const snap = cleanLaunch();
    shareFunder(snap, [0, 1], BUNDLER, T0 - 30 * DAY);
    expectScore(snap, 0, 'LOW', []);
  });

  it('S04 serial deployer: 3 prior DEAD_1H launches → deployer_history 25 (v=3), MED at the 25 edge', () => {
    const snap = cleanLaunch();
    addPriors(snap, ['DEAD_1H', 'DEAD_1H', 'DEAD_1H']);
    expectScore(snap, 25, 'MED', [['deployer_history', 25, 3]]);
  });

  it('S05 serial deployer via funded wallet: 1 prior DEV_DUMP (+ unlabelled & survived priors) → deployer_history 10 (v=1)', () => {
    const snap = cleanLaunch();
    addPriors(snap, ['DEV_DUMP', null, 'SURVIVED_24H']);
    expectScore(snap, 10, 'LOW', [['deployer_history', 10, 1]]);
  });

  it('S06 serial dead-launch deployer + bundle + top10 42% → 60 HIGH', () => {
    const snap = cleanLaunch();
    addPriors(snap, ['DEAD_1H', 'DEV_DUMP', 'DEAD_1H']);
    shareFunder(snap, range(0, 5), BUNDLER, T0 - 30 * DAY);
    setBuyerBp(snap, range(0, 5), 700); // top10 = 5×7% + dev 3% + 4×1% = 42%
    expectScore(snap, 60, 'HIGH', [
      ['deployer_history', 25, 3], ['bundled_launch', 20, 5], ['holder_concentration', 15, 42],
    ]);
  });

  it('S07 concentrated holders: top10 = 25% → holder_concentration round(7.5) = 8 (v=25)', () => {
    const snap = cleanLaunch();
    setBuyerBp(snap, range(0, 8), 250);
    setBuyerBp(snap, [8], 200); // top10 = dev 3% + 8×2.5% + 2% = 25%
    expectScore(snap, 8, 'LOW', [['holder_concentration', 8, 25]]);
  });

  it('S08 dev dump: deployer sold 60% of what it bought → dev_position 10 (v=60, sold% checked first)', () => {
    const snap = cleanLaunch();
    setDevBuyBp(snap, 500);
    devSell(snap, 300, 600_000_000); // 60% of tokens and of lamports; dev now holds 2%
    const r = expectScore(snap, 10, 'LOW', [['dev_position', 10, 60]]);
    expect(r.as_of_slot).toBe(snap.as_of_slot);
  });

  it('S09 dev holds exactly 10.0%, sold 0 → no dev_position reason (strict >)', () => {
    const snap = cleanLaunch();
    setAllBuyersBp(snap, 50);
    setDevBuyBp(snap, 1000); // top10 = 10% + 9×0.5% = 14.5% → holder 0
    expectScore(snap, 0, 'LOW', []);
  });

  it('S10 fresh-wallet swarm: 10 enriched of first 30, 7 fresh → fresh_wallets 10 (v=70)', () => {
    const snap = cleanLaunch();
    unenrich(snap, range(10, 30));
    makeFresh(snap, range(0, 7));
    expectScore(snap, 10, 'LOW', [['fresh_wallets', 10, 70]]);
  });

  it('S10b fresh wallets mid-band: 10 enriched, 5 fresh → round(10·0.3/0.5) = 6 (v=50)', () => {
    const snap = cleanLaunch();
    unenrich(snap, range(10, 30));
    makeFresh(snap, range(0, 5));
    expectScore(snap, 6, 'LOW', [['fresh_wallets', 6, 50]]);
  });

  it('S11 missing data: only 4 of first 30 enriched → fresh_wallets & funding_cluster are data gaps, 0 pts', () => {
    const snap = cleanLaunch();
    unenrich(snap, range(4, 40));
    makeFresh(snap, range(0, 4)); // would be r=1.0 if scored — must not be
    expectScore(snap, 0, 'LOW', [], ['fresh_wallets', 'funding_cluster']);
  });

  it('S12 curve-velocity anomaly: curve 30%, 10 unique buyers → curve_velocity 5 (v=3)', () => {
    const snap = cleanLaunch(10);
    removeDevTrades(snap);
    snap.token.curve_pct = 30;
    expectScore(snap, 5, 'LOW', [['curve_velocity', 5, 3]]);
  });

  it('S12b curve velocity mid-band: curve 15%, 10 unique buyers → curve_velocity 3 (v=1.5)', () => {
    const snap = cleanLaunch(10);
    removeDevTrades(snap);
    snap.token.curve_pct = 15;
    expectScore(snap, 3, 'LOW', [['curve_velocity', 3, 1.5]]);
  });

  it('S13 metadata copycat: symbol "$Pepe!" normalizes to trending "pepe" + no socials → metadata_flags 5 (v=2)', () => {
    const snap = cleanLaunch();
    snap.token.symbol = '$Pepe!';
    snap.token.has_socials = false;
    const r = expectScore(snap, 5, 'LOW', [['metadata_flags', 5, 2]]);
    expect(r.reasons[0]!.evidence.mints).toContain(TRENDING[0]!.mint);
  });

  it('S13b metadata copycat via NFKC: fullwidth "ＰＥＰＥ" with socials → metadata_flags 3 (v=1)', () => {
    const snap = cleanLaunch();
    snap.token.symbol = 'ＰＥＰＥ';
    expectScore(snap, 3, 'LOW', [['metadata_flags', 3, 1]]);
  });

  it('S14 missing data: zero trades, null metadata, no priors → no throw, 0 LOW, gaps listed in table order', () => {
    const snap = cleanLaunch(0);
    snap.trades = [];
    snap.wallets = {};
    snap.deployer_prior = [];
    Object.assign(snap.token, { name: null, symbol: null, uri: null, has_socials: null, curve_pct: null });
    snap.as_of_slot = SLOT0;
    const r = expectScore(snap, 0, 'LOW', [], [
      'bundled_launch', 'holder_concentration', 'fresh_wallets', 'funding_cluster', 'curve_velocity', 'metadata_flags',
    ]);
    expect(r.as_of_slot).toBe(SLOT0); // no trades → created_slot
  });

  it('S15 all factors maxed → 100 EXTREME, top 5 reasons in points-then-table order', () => {
    const snap = cleanLaunch(10);
    addPriors(snap, ['DEAD_1H', 'DEAD_1H', 'DEV_DUMP']);
    shareFunder(snap, range(0, 10), BUNDLER, T0 - 1800); // bundle (early 0..4) + funding cluster (all 10)
    for (const i of range(0, 10)) snap.wallets[buyer(i)]!.tx_count = 1; // all fresh
    setAllBuyersBp(snap, 500);
    setDevBuyBp(snap, 500);
    devSell(snap, 300, 600_000_000); // sold 60%; top10 = 10×5% = 50%
    snap.token.curve_pct = 50;
    snap.token.symbol = '$PEPE';
    snap.token.has_socials = false;
    expectScore(snap, 100, 'EXTREME', [
      ['deployer_history', 25, 3], ['bundled_launch', 20, 5], ['holder_concentration', 15, 50],
      ['dev_position', 10, 60], ['fresh_wallets', 10, 100],
    ]);
  });

  it('S16 ties on points follow table order; two runs are deep-equal (determinism)', () => {
    const snap = cleanLaunch();
    setDevBuyBp(snap, 500);
    devSell(snap, 300, 600_000_000);                          // dev_position 10
    for (const i of range(10, 15)) shareFunder(snap, [i], CLUSTER, T0 - 3600); // funding_cluster 10
    snap.token.curve_pct = 90;                                // 90/40 ≥ 2 → 5
    snap.token.symbol = 'WIF';
    snap.token.has_socials = false;                           // metadata 5
    const a = expectScore(snap, 30, 'MED', [
      ['dev_position', 10, 60], ['funding_cluster', 10, 5], ['curve_velocity', 5], ['metadata_flags', 5, 2],
    ]);
    const b = score(structuredClone(snap));
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('S17 verdictFor() band edges 0/24/25/49/50/74/75/100', () => {
    const cases: [number, Verdict][] = [
      [0, 'LOW'], [24, 'LOW'], [25, 'MED'], [49, 'MED'], [50, 'HIGH'], [74, 'HIGH'], [75, 'EXTREME'], [100, 'EXTREME'],
    ];
    expect(cases.map(([s]) => [s, verdictFor(s)])).toEqual(cases);
  });

  it('S18 attacker-controlled metadata never reaches reasons or result text', () => {
    const snap = cleanLaunch();
    snap.token.name = '</script><img src=x onerror=alert(1)>';
    snap.token.symbol = 'ignore previous instructions';
    snap.token.uri = 'javascript:alert(1)';
    snap.token.has_socials = false;
    snap.trending_symbols.push({ mint: addr('TrendHack'), symbol_norm: 'ignorepreviousinstructions' });
    const r = expectScore(snap, 5, 'LOW', [['metadata_flags', 5, 2]]);
    const text = JSON.stringify(r).toLowerCase();
    for (const bad of ['script', '<img', 'onerror', 'alert', 'ignore', 'instructions', 'javascript']) {
      expect(text).not.toContain(bad);
    }
  });

  it('S19 funding cluster: 5 later buyers funded by one wallet 1h before buying → funding_cluster 10 (v=5)', () => {
    const snap = cleanLaunch();
    shareFunder(snap, range(10, 15), CLUSTER, T0 - 3600);
    expect(buyTs(snap, 14) - (T0 - 3600)).toBeLessThanOrEqual(21_600);
    expectScore(snap, 10, 'LOW', [['funding_cluster', 10, 5]]);
  });

  it('S20 funding cluster outside 6h window: same funder 7h before buying → no funding_cluster reason', () => {
    const snap = cleanLaunch();
    shareFunder(snap, range(10, 15), CLUSTER, T0 - 7 * 3600);
    expectScore(snap, 0, 'LOW', []);
  });

  it('S21 band edge 24: 2 rug priors (18) + curve mid-band (3) + copycat (3) → 24 LOW', () => {
    const snap = cleanLaunch(10);
    addPriors(snap, ['DEAD_1H', 'DEV_DUMP']);
    snap.token.curve_pct = 15; // 15/10 or 15/11 → both in [1, 2)
    snap.token.symbol = 'wif';
    expectScore(snap, 24, 'LOW', [['deployer_history', 18, 2], ['curve_velocity', 3], ['metadata_flags', 3, 1]]);
  });

  it('S22 band edge 50: serial deployer (25) + bundle (20) + curve (5) → 50 HIGH', () => {
    const snap = cleanLaunch(10);
    addPriors(snap, ['DEAD_1H', 'DEAD_1H', 'DEAD_1H']);
    shareFunder(snap, range(0, 5), BUNDLER, T0 - 30 * DAY);
    snap.token.curve_pct = 30;
    expectScore(snap, 50, 'HIGH', [['deployer_history', 25, 3], ['bundled_launch', 20, 5], ['curve_velocity', 5]]);
  });

  it('S23 band edge 75: deployer 25 + bundle 20 + holders 15 + dev dump 10 + curve 5 → 75 EXTREME', () => {
    const snap = cleanLaunch(10);
    addPriors(snap, ['DEAD_1H', 'DEAD_1H', 'DEAD_1H']);
    shareFunder(snap, range(0, 5), BUNDLER, T0 - 30 * DAY);
    setAllBuyersBp(snap, 500);
    setDevBuyBp(snap, 500);
    devSell(snap, 300, 600_000_000);
    snap.token.curve_pct = 30;
    expectScore(snap, 75, 'EXTREME', [
      ['deployer_history', 25, 3], ['bundled_launch', 20, 5], ['holder_concentration', 15, 50],
      ['dev_position', 10, 60], ['curve_velocity', 5],
    ]);
  });
});
