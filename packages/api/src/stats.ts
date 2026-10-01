import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.js';
import { STUB_MODEL_VERSION } from './risk.js';

const SERVED = "status = 'served' AND tx_sig IS NOT NULL";

function usdc(baseUnits: number): string {
  return (baseUnits / 1_000_000).toFixed(6);
}

export function buildStats(db: DatabaseSync, cfg: Config, nowS: number) {
  const n = (sql: string, ...p: (string | number)[]): number =>
    Number((db.prepare(sql).get(...p) as { v: number | null }).v ?? 0);

  const paid = n(`SELECT COUNT(*) AS v FROM calls WHERE ${SERVED}`);
  const fp = n(`SELECT COUNT(*) AS v FROM calls WHERE ${SERVED} AND first_party = 1`);
  const usdcUnits = n(`SELECT SUM(amount) AS v FROM calls WHERE ${SERVED} AND asset = ?`, cfg.usdcMint);
  const payers = n(`SELECT COUNT(DISTINCT payer) AS v FROM calls WHERE ${SERVED}`);
  const integrators = n(`SELECT COUNT(DISTINCT payer) AS v FROM calls WHERE ${SERVED} AND first_party = 0`);

  const last_calls = (
    db
      .prepare(
        `SELECT ts, tool, arg, score, verdict, tx_sig, payer, asset, first_party, latency_ms
         FROM calls WHERE ${SERVED} ORDER BY ts DESC, id DESC LIMIT 50`,
      )
      .all() as Record<string, string | number | null>[]
  ).map((r) => ({ ...r, first_party: r.first_party === 1 }));

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
    model_version: STUB_MODEL_VERSION,
    network: cfg.network,
    generated_at: nowS,
    totals: {
      paid_calls: paid,
      paid_calls_first_party: fp,
      paid_calls_third_party: paid - fp,
      usdc_paid: usdc(usdcUnits),
      ansem_paid: '0.000000',
      unique_payers: payers,
      unique_integrators: integrators,
    },
    last_calls,
    caught,
    backtest: null,
  };
}
