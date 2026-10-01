#!/usr/bin/env node
// PumpWire backtest harness (T-014). Labels launches older than 1 h, scores them as of T+2 min, reports
// precision/recall at HIGH+ and writes docs/BACKTEST.md numbers + data/backtest.json for /live.
//
// Usage: node [--experimental-sqlite] scripts/backtest.mjs [--db ~/pumpwire-data/snapshot.db] [--out data/backtest.json]
//        [--score-at 120] [--min-age 7200] [--scorer ../packages/score/dist/index.js]
// Node 22.13+ has node:sqlite unflagged; Node 22.12 (VPS) needs --experimental-sqlite. Read-only; never writes the DB.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MODEL_VERSION_FALLBACK = 'v0.1.0';
export const LABEL_RULES = {
  DEAD_1H: 'no trade after created_at + 3600 s, not migrated, token at least --min-age old',
  DEV_DUMP: 'deployer sold ≥ 50% of the tokens it bought within 24 h of creation',
  SURVIVED_24H: 'migrated, or at least one trade after created_at + 86400 s',
  UNLABELLED: 'none of the above yet (too young)',
};

function parseArgs(argv) {
  const a = { db: process.env.PUMPWIRE_DB_PATH ?? `${process.env.HOME}/pumpwire-data/snapshot.db`, out: 'data/backtest.json', scoreAt: 120, minAge: 7200, scorer: '../packages/score/dist/index.js', now: Math.floor(Date.now() / 1000) };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]; const v = argv[i + 1];
    if (k === '--db') a.db = v; else if (k === '--out') a.out = v; else if (k === '--score-at') a.scoreAt = Number(v);
    else if (k === '--min-age') a.minAge = Number(v); else if (k === '--scorer') a.scorer = v; else if (k === '--now') a.now = Number(v); else continue;
    i++;
  }
  return a;
}

/** Pure labelling: token row + its trades (sorted by ts) → Outcome | null. Exported for tests. */
export function labelToken(token, trades, now, minAge = 7200) {
  const age = now - token.created_at;
  if (age < minAge) return null;
  const devBuys = trades.filter((t) => t.wallet === token.deployer && t.side === 'buy' && t.ts <= token.created_at + 86400).reduce((s, t) => s + t.token_amount, 0);
  const devSells = trades.filter((t) => t.wallet === token.deployer && t.side === 'sell' && t.ts <= token.created_at + 86400).reduce((s, t) => s + t.token_amount, 0);
  if (devBuys > 0 && devSells * 2 >= devBuys) return 'DEV_DUMP';
  const lastTs = trades.length ? trades[trades.length - 1].ts : token.created_at;
  if (token.migrated || lastTs >= token.created_at + 86400) return 'SURVIVED_24H';
  if (lastTs < token.created_at + 3600 && !token.migrated) return 'DEAD_1H';
  return null; // alive between 1 h and 24 h: not decided yet
}

/** Minimal ScoreSnapshot (INTERFACES §2) as of `asOfTs`, built from the frozen schema. T-010 may replace with buildSnapshot(). */
export function buildSnapshotAsOf(db, token, asOfTs) {
  const trades = db.prepare('SELECT sig, mint, wallet, side, lamports, token_amount, slot, ts FROM trades WHERE mint = ? AND ts <= ? ORDER BY slot, sig').all(token.mint, asOfTs);
  const buyers = [];
  for (const t of trades) if (t.side === 'buy' && t.wallet !== token.deployer && !buyers.includes(t.wallet)) { buyers.push(t.wallet); if (buyers.length >= 30) break; }
  const wallets = {};
  const wq = db.prepare('SELECT address, first_seen_ts, tx_count, funder, funder_ts, enriched_at FROM wallets WHERE address = ?');
  for (const w of [token.deployer, ...buyers]) { const r = wq.get(w); if (r) wallets[w] = r; }
  // No lookahead: a prior launch's outcome only counts if it was already decided at asOfTs (outcome_at <= asOfTs).
  const deployer_prior = db.prepare('SELECT mint, outcome, outcome_at, created_at FROM tokens WHERE deployer = ? AND created_at < ? AND mint != ?').all(token.deployer, token.created_at, token.mint)
    .map((p) => ({ mint: p.mint, created_at: p.created_at, outcome: p.outcome != null && p.outcome_at != null && p.outcome_at <= asOfTs ? p.outcome : null }));
  const trending_symbols = db.prepare(`SELECT t.mint, lower(t.symbol) AS symbol_norm FROM tokens t JOIN trades r ON r.mint = t.mint
    WHERE r.ts BETWEEN ? AND ? AND t.mint != ? AND t.symbol IS NOT NULL GROUP BY t.mint ORDER BY count(*) DESC LIMIT 20`).all(asOfTs - 86400, asOfTs, token.mint)
    .map((r) => ({ mint: r.mint, symbol_norm: String(r.symbol_norm ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '') }));
  const as_of_slot = trades.length ? trades[trades.length - 1].slot : token.created_slot;
  return {
    token: { ...token, migrated: !!token.migrated, has_socials: token.has_socials == null ? null : !!token.has_socials },
    trades, wallets, deployer_prior, trending_symbols,
    total_supply: 1_000_000_000_000_000, // pump.fun fixed supply 1e9 tokens × 1e6 decimals (VERIFY in T-010)
    as_of_slot, as_of_ts: asOfTs,
  };
}

export function summarize(rows) {
  const labelled = rows.filter((r) => r.outcome);
  const rug = (r) => r.outcome === 'DEAD_1H' || r.outcome === 'DEV_DUMP';
  const highPlus = (r) => r.verdict === 'HIGH' || r.verdict === 'EXTREME';
  const scored = labelled.filter((r) => r.verdict);
  const tp = scored.filter((r) => highPlus(r) && rug(r)).length;
  const fp = scored.filter((r) => highPlus(r) && !rug(r)).length;
  const fn = scored.filter((r) => !highPlus(r) && rug(r)).length;
  const counts = {};
  for (const r of labelled) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  return {
    n: scored.length, n_labelled: labelled.length, counts,
    precision_high_plus: tp + fp > 0 ? tp / (tp + fp) : null,
    recall_high_plus: tp + fn > 0 ? tp / (tp + fn) : null,
    tp, fp, fn,
  };
}

async function loadScorer(path) {
  const abs = resolve(dirname(new URL(import.meta.url).pathname), path);
  if (!existsSync(abs)) return null;
  try { const m = await import(pathToFileURL(abs).href); return typeof m.score === 'function' ? m : null; } catch { return null; }
}

export async function run(args) {
  const out = { model_version: MODEL_VERSION_FALLBACK, n: 0, precision_high_plus: null, recall_high_plus: null, generated_at: args.now, caveat: null, rules: LABEL_RULES };
  if (!existsSync(args.db)) {
    out.caveat = `DB not found at ${args.db}; n=0`;
    return { out, rows: [] };
  }
  const db = new DatabaseSync(args.db, { readOnly: true });
  const scorer = await loadScorer(args.scorer);
  const tokens = db.prepare('SELECT * FROM tokens WHERE created_at <= ? ORDER BY created_at').all(args.now - args.minAge);
  const tradesFor = db.prepare('SELECT sig, mint, wallet, side, lamports, token_amount, slot, ts FROM trades WHERE mint = ? ORDER BY ts, sig');
  const rows = [];
  let scorer_errors = 0;
  for (const tk of tokens) {
    const trades = tradesFor.all(tk.mint);
    const outcome = tk.outcome ?? labelToken(tk, trades, args.now, args.minAge);
    let verdict = null, score = null;
    if (scorer) {
      try { const r = scorer.score(buildSnapshotAsOf(db, tk, tk.created_at + args.scoreAt)); verdict = r.verdict; score = r.score; out.model_version = r.model_version ?? out.model_version; }
      catch (e) { verdict = null; score = null; scorer_errors++; }
    }
    rows.push({ mint: tk.mint, created_at: tk.created_at, outcome, verdict, score });
  }
  const s = summarize(rows);
  Object.assign(out, { n: s.n, n_labelled: s.n_labelled, counts: s.counts, precision_high_plus: s.precision_high_plus, recall_high_plus: s.recall_high_plus, tp: s.tp, fp: s.fp, fn: s.fn });
  if (!scorer) out.caveat = 'scorer not built (packages/score has no score() yet): labels only, no precision/recall';
  else if (s.n < 100) out.caveat = `small sample (n=${s.n}): indicative only, not a claim`;
  if (scorer_errors) { out.scorer_errors = scorer_errors; out.caveat = `${out.caveat ? out.caveat + '; ' : ''}scorer threw on ${scorer_errors} launch(es), counted as unscored`; }
  db.close();
  return { out, rows };
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = parseArgs(process.argv);
  const { out, rows } = await run(args);
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(resolve(args.out), JSON.stringify(out, null, 2) + '\n');
  const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  console.log(`backtest ${out.model_version}: n=${out.n} labelled=${out.n_labelled ?? 0} ${JSON.stringify(out.counts ?? {})}`);
  console.log(`precision@HIGH+ ${pct(out.precision_high_plus)} · recall@HIGH+ ${pct(out.recall_high_plus)} · tp=${out.tp ?? 0} fp=${out.fp ?? 0} fn=${out.fn ?? 0}`);
  if (out.caveat) console.log(`caveat: ${out.caveat}`);
  console.log(`wrote ${args.out}; ${rows.length} rows examined`);
}
