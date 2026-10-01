import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RiskResult } from './types.js';

const SCHEMA_PATH = fileURLToPath(new URL('../../../docs/schema.sql', import.meta.url));

/** A `pending` claim older than this may be taken over by a retry (INTERFACES §7). */
export const STALE_PENDING_S = 120;

export function applySchema(db: DatabaseSync): void {
  db.exec(readFileSync(SCHEMA_PATH, 'utf8')); // idempotent; also sets per-connection PRAGMAs
}

export interface ClaimInput {
  ts: number;
  tool: string;
  arg: string;
  payer: string | null;
  network: string;
  asset: string;
  amount: number;
  paymentId: string;
  firstParty: boolean;
}

export interface CallRow {
  id: number;
  tool: string;
  arg: string;
  payer: string | null;
  status: 'pending' | 'served' | 'failed';
  tx_sig: string | null;
  result_json: string | null;
}

export type ClaimOutcome =
  | { kind: 'claimed'; id: number }                      // we own a fresh pending row
  | { kind: 'retry'; id: number; settled: boolean }      // we took over a failed/stale row; settled = tx_sig already set
  | { kind: 'served'; row: CallRow }                     // same resource already served: idempotent re-serve
  | { kind: 'replayed' };                                // spent for something else, or in flight elsewhere

const SELECT_ROW = 'SELECT id, tool, arg, payer, status, tx_sig, result_json FROM calls WHERE payment_id = ?';

/**
 * Atomically claim a payment. Exactly one concurrent caller gets `claimed`/`retry`: the INSERT is
 * `ON CONFLICT(payment_id) DO NOTHING` (0 rows changed = someone else holds it) and the takeover is a
 * conditional UPDATE that only matches a `failed` or stale-`pending` row of the same tool+arg.
 */
export function claimPayment(db: DatabaseSync, c: ClaimInput): ClaimOutcome {
  const ins = db
    .prepare(
      `INSERT INTO calls (ts, tool, arg, payer, network, asset, amount, payment_id, settle_via, status, first_party)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'facilitator', 'pending', ?)
       ON CONFLICT(payment_id) DO NOTHING`,
    )
    .run(c.ts, c.tool, c.arg, c.payer, c.network, c.asset, c.amount, c.paymentId, c.firstParty ? 1 : 0);
  if (Number(ins.changes) === 1) return { kind: 'claimed', id: Number(ins.lastInsertRowid) };

  const row = db.prepare(SELECT_ROW).get(c.paymentId) as CallRow | undefined;
  if (!row || row.tool !== c.tool || row.arg !== c.arg) return { kind: 'replayed' };
  if (row.status === 'served') return { kind: 'served', row };

  const up = db
    .prepare(
      `UPDATE calls SET status = 'pending', ts = ?
       WHERE payment_id = ? AND tool = ? AND arg = ?
         AND (status = 'failed' OR (status = 'pending' AND ts <= ?))`,
    )
    .run(c.ts, c.paymentId, c.tool, c.arg, c.ts - STALE_PENDING_S);
  if (Number(up.changes) === 1) return { kind: 'retry', id: row.id, settled: row.tx_sig !== null };
  return { kind: 'replayed' };
}

/** Existing row for this payment if it was claimed for the same tool+arg (else undefined). */
export function findOwnRow(db: DatabaseSync, paymentId: string, tool: string, arg: string): CallRow | undefined {
  const row = db.prepare(SELECT_ROW).get(paymentId) as CallRow | undefined;
  return row && row.tool === tool && row.arg === arg ? row : undefined;
}

export function markFailed(db: DatabaseSync, id: number): void {
  db.prepare("UPDATE calls SET status = 'failed' WHERE id = ? AND status = 'pending'").run(id);
}

/** Record the settled signature (UNIQUE). Returns false if the sig is already attached to another row. */
export function setTxSig(db: DatabaseSync, id: number, sig: string): boolean {
  try {
    db.prepare('UPDATE calls SET tx_sig = ? WHERE id = ?').run(sig, id);
    return true;
  } catch {
    return false;
  }
}

export function markServed(db: DatabaseSync, id: number, r: RiskResult, latencyMs: number): void {
  db.prepare(
    `UPDATE calls SET status = 'served', score = ?, verdict = ?, result_json = ?, latency_ms = ? WHERE id = ?`,
  ).run(r.score, r.verdict, JSON.stringify(r), latencyMs, id);
}
