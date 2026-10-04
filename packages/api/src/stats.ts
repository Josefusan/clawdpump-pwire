import { readFileSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { HOLDER_PRICE_BASE_UNITS, type Config } from './config.js';
import { MODEL_VERSION } from '@pumpwire/score';

const SERVED = "status = 'served' AND tx_sig IS NOT NULL";

function usdc(baseUnits: number): string {
  return (baseUnits / 1_000_000).toFixed(6);
}

export interface Backtest {
  model_version: string;
  n: number;
  precision_high_plus: number | null;
  recall_high_plus: number | null;
  caveat?: string;
}

let btCache: { path: string; mtimeMs: number; value: Backtest | null } | undefined;

/** data/backtest.json (scripts/backtest.mjs output), re-read only when its mtime changes; null if absent or malformed. */
export function readBacktest(path: string): Backtest | null {
  if (!path) return null;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  if (btCache && btCache.path === path && btCache.mtimeMs === mtimeMs) return btCache.value;
  let value: Backtest | null = null;
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (typeof j.model_version === 'string' && Number.isInteger(j.n)) {
      value = {
        model_version: j.model_version,
        n: j.n as number,
        precision_high_plus: typeof j.precision_high_plus === 'number' ? j.precision_high_plus : null,
        recall_high_plus: typeof j.recall_high_plus === 'number' ? j.recall_high_plus : null,
        ...(typeof j.caveat === 'string' ? { caveat: j.caveat } : {}),
      };
    }
  } catch {
    value = null;
  }
  btCache = { path, mtimeMs, value };
  return value;
}

export function buildStats(db: DatabaseSync, cfg: Config, nowS: number) {
  const n = (sql: string, ...p: (string | number)[]): number =>
    Number((db.prepare(sql).get(...p) as { v: number | null }).v ?? 0);

  // First-party is decided at query time from the CURRENT allowlist (plus payTo itself), not only the flag frozen at
  // claim time, so adding the Scout wallet to FIRST_PARTY_WALLETS later still relabels its history (clawrena-compliance).
  const fpWallets = [...new Set([cfg.payTo, ...cfg.firstPartyWallets])];
  const fpSet = new Set(fpWallets);
  const FP = `(first_party = 1 OR payer IN (${fpWallets.map(() => '?').join(',')}))`;

  const paid = n(`SELECT COUNT(*) AS v FROM calls WHERE ${SERVED}`);
  const fp = n(`SELECT COUNT(*) AS v FROM calls WHERE ${SERVED} AND ${FP}`, ...fpWallets);
  const usdcUnits = n(`SELECT SUM(amount) AS v FROM calls WHERE ${SERVED} AND asset = ?`, cfg.usdcMint);
  // A null payer (facilitator returned none) is never counted as third-party: it is reported as unattributed.
  const unattributed = n(`SELECT COUNT(*) AS v FROM calls WHERE ${SERVED} AND payer IS NULL AND first_party = 0`);
  // Holder-tier calls are the ones settled at the holder price (no extra column needed).
  const holderCalls = n(`SELECT COUNT(*) AS v FROM calls WHERE ${SERVED} AND amount = ?`, HOLDER_PRICE_BASE_UNITS);
  const payers = n(`SELECT COUNT(DISTINCT payer) AS v FROM calls WHERE ${SERVED}`);
  // "integrators" = distinct third-party paying wallets (INTERFACES §4.3). A wallet is not a verified builder.
  const integrators = n(`SELECT COUNT(DISTINCT payer) AS v FROM calls WHERE ${SERVED} AND NOT ${FP}`, ...fpWallets);

  const last_calls = (
    db
      .prepare(
        `SELECT ts, tool, arg, score, verdict, tx_sig, payer, asset, first_party, latency_ms
         FROM calls WHERE ${SERVED} ORDER BY ts DESC, id DESC LIMIT 50`,
      )
      .all() as Record<string, string | number | null>[]
  ).map((r) => {
    const first_party = r.first_party === 1 || (r.payer !== null && fpSet.has(String(r.payer)));
    const party = first_party ? 'first-party' : r.payer === null ? 'unattributed' : 'third-party';
    return { ...r, first_party, party };
  });

  const caught = db
    .prepare(
      `SELECT c.arg AS mint, c.verdict AS verdict, c.ts AS scored_at, t.outcome AS outcome, t.outcome_at AS outcome_at
       FROM calls c JOIN tokens t ON t.mint = c.arg
       WHERE c.status = 'served' AND c.tx_sig IS NOT NULL AND c.verdict IN ('HIGH', 'EXTREME')
         AND t.outcome IN ('DEAD_1H', 'DEV_DUMP') AND t.outcome_at IS NOT NULL
       ORDER BY t.outcome_at DESC LIMIT 50`,
    )
    .all();

  return {
    model_version: MODEL_VERSION,
    network: cfg.network,
    generated_at: nowS,
    totals: {
      paid_calls: paid,
      paid_calls_first_party: fp,
      paid_calls_third_party: paid - fp - unattributed,
      paid_calls_unattributed: unattributed,
      paid_calls_holder: holderCalls,
      usdc_paid: usdc(usdcUnits),
      ansem_paid: '0.000000',
      unique_payers: payers,
      unique_integrators: integrators,
    },
    last_calls,
    caught,
    backtest: readBacktest(cfg.backtestJsonPath),
  };
}
