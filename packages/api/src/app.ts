import express from 'express';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { base58Decode, isBase58Pubkey } from './base58.js';
import { claimPayment, findOwnRow, markFailed, markServed, setTxSig } from './calls.js';
import { PRICE_BASE_UNITS, type Config } from './config.js';
import { cachedScore, dbScore, tokenExists, type ScoreFn } from './risk.js';
import { buildStats } from './stats.js';
import { hasExactlyMemo } from './tx.js';
import type { ErrorCode, RiskResult } from './types.js';

const TOOL = 'rug_risk_score';
const DESCRIPTION = 'PumpWire rug-risk score for a pump.fun mint';

/** The subset of the facilitator client the API uses; tests inject a mock. */
export type Backend = Pick<FacilitatorClient, 'verify' | 'settle' | 'getSupported'>;

export interface Deps {
  db: DatabaseSync;
  backend: Backend;
  cfg: Config;
  score?: ScoreFn;
  nowS?: () => number;
}

/** A transaction signature: base58 that decodes to exactly 64 bytes. */
export function isTxSig(s: unknown): s is string {
  return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s) && base58Decode(s)?.length === 64;
}

export const memoFor = (mint: string): string => `pumpwire:${TOOL}:${mint}`;

function fail(res: Response, status: number, error: ErrorCode, message: string) {
  return res.status(status).json({ error, message });
}

function rateLimiter(limit: number, nowS: () => number) {
  const hits = new Map<string, { win: number; n: number }>();
  return (ip: string): boolean => {
    const win = Math.floor(nowS() / 60);
    const h = hits.get(ip);
    if (!h || h.win !== win) {
      if (hits.size > 10_000) hits.clear();
      hits.set(ip, { win, n: 1 });
      return true;
    }
    return ++h.n <= limit;
  };
}

export function createApp(deps: Deps) {
  const { db, backend, cfg } = deps;
  const score = deps.score ?? cachedScore(dbScore);
  const nowS = deps.nowS ?? (() => Math.floor(Date.now() / 1000));
  const allow = rateLimiter(cfg.rateLimitPerMin, nowS);
  let feePayer: string | undefined;

  async function getFeePayer(): Promise<string> {
    if (feePayer) return feePayer;
    const sup = await backend.getSupported();
    const kind = sup.kinds.find((k) => k.scheme === 'exact' && k.network === cfg.network);
    const fp = kind?.extra?.feePayer;
    if (typeof fp !== 'string') throw new Error('facilitator does not advertise a feePayer for this network');
    return (feePayer = fp);
  }

  const requirementsFor = (mint: string, fp: string): PaymentRequirements => ({
    scheme: 'exact',
    network: cfg.network as PaymentRequirements['network'],
    asset: cfg.usdcMint,
    amount: String(PRICE_BASE_UNITS),
    payTo: cfg.payTo,
    maxTimeoutSeconds: cfg.maxTimeoutS,
    // `memo` makes the x402 client emit exactly this Memo; we also check it ourselves (replay binding).
    extra: { feePayer: fp, memo: memoFor(mint) },
  });

  function paymentRequired(req: Request, mint: string, fp: string, error: string): PaymentRequired {
    return {
      x402Version: 2,
      error,
      resource: {
        url: `${req.protocol}://${req.get('host') ?? 'localhost'}/v1/risk/${mint}`,
        description: DESCRIPTION,
        mimeType: 'application/json',
      },
      accepts: [requirementsFor(mint, fp)],
    };
  }

  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    try {
      const row = db.prepare('SELECT MAX(ts) AS t FROM trades').get() as { t: number | null };
      const lag = row.t === null ? null : Math.max(0, nowS() - row.t);
      const ok = lag === null || lag <= 60;
      res.status(ok ? 200 : 503).json({
        ok, db: 'ok', network: cfg.network, model_version: buildStats(db, cfg, nowS()).model_version,
        last_trade_ts: row.t, ingest_lag_s: lag,
      });
    } catch {
      res.status(503).json({ ok: false, db: 'error', network: cfg.network, model_version: null, last_trade_ts: null, ingest_lag_s: null });
    }
  });

  app.get('/v1/stats', (_req, res) => {
    try {
      res.status(200).json(buildStats(db, cfg, nowS()));
    } catch {
      fail(res, 500, 'INTERNAL', 'stats unavailable');
    }
  });

  app.get('/v1/risk/:mint', async (req, res) => {
    const t0 = Date.now();
    const mint = req.params.mint ?? '';
    // 1–3: never charge for a request we cannot serve.
    if (!isBase58Pubkey(mint)) return fail(res, 400, 'INVALID_MINT', 'mint must be a base58 public key');
    if (!tokenExists(db, mint)) return fail(res, 404, 'NOT_FOUND', 'unknown mint');
    if (!allow(req.ip ?? 'unknown')) return fail(res, 429, 'RATE_LIMITED', 'too many requests');

    let fp: string;
    try {
      fp = await getFeePayer();
    } catch {
      return fail(res, 502, 'UPSTREAM', 'payment facilitator unavailable');
    }

    // 4: payment header
    const header = req.get('payment-signature') ?? req.get('x-payment');
    if (!header) {
      const body = paymentRequired(req, mint, fp, 'PAYMENT_REQUIRED');
      res.set('PAYMENT-REQUIRED', encodePaymentRequiredHeader(body));
      return res.status(402).json(body);
    }
    const invalid = (why: string) => fail(res, 402, 'PAYMENT_INVALID', why);

    let payload: PaymentPayload;
    let wire: Buffer;
    try {
      payload = decodePaymentSignatureHeader(header);
      const b64 = payload.payload?.transaction;
      if (typeof b64 !== 'string') return invalid('payload.transaction missing');
      wire = Buffer.from(b64, 'base64');
    } catch {
      return invalid('malformed payment header');
    }

    const want = requirementsFor(mint, fp);
    const got = payload.accepted;
    if (
      !got || got.scheme !== want.scheme || got.network !== want.network || got.asset !== want.asset ||
      got.amount !== want.amount || got.payTo !== want.payTo
    ) {
      return invalid('payment does not match requirements (scheme/network/asset/amount/payTo)');
    }

    // Replay binding: exactly one Memo, byte-equal to this request. No row is claimed on mismatch.
    let bound: boolean;
    try {
      bound = hasExactlyMemo(wire, memoFor(mint));
    } catch {
      return invalid('unparseable transaction');
    }
    if (!bound) return invalid('transaction memo does not match this request');

    // §7: a payment already served (or settled) for this same resource is never re-verified; the tx may
    // have landed or its blockhash expired, which would make verify fail for a legitimately paid call.
    const paymentId = createHash('sha256').update(wire).digest('hex');
    const own = findOwnRow(db, paymentId, TOOL, mint);
    let payer: string | null;
    if (own && (own.status === 'served' || own.tx_sig !== null)) {
      payer = own.payer;
    } else {
      try {
        const v = await backend.verify(payload, want);
        if (v.isValid !== true) return invalid(v.invalidReason ?? 'verification failed');
        payer = typeof v.payer === 'string' ? v.payer : null;
      } catch {
        return fail(res, 502, 'UPSTREAM', 'payment verification unavailable');
      }
    }

    // Atomic claim keyed by sha256(tx bytes). Only one concurrent caller proceeds.
    const outcome = claimPayment(db, {
      ts: nowS(), tool: TOOL, arg: mint, payer, network: cfg.network, asset: cfg.usdcMint,
      amount: PRICE_BASE_UNITS, paymentId,
      firstParty: payer !== null && cfg.firstPartyWallets.includes(payer),
    });
    if (outcome.kind === 'replayed') return fail(res, 402, 'PAYMENT_REPLAYED', 'payment already used');
    if (outcome.kind === 'served') {
      res.set('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(outcome.row.result_json ?? '{}');
    }

    // We own the row (pending). Score first, then settle: a scoring failure never costs the payer.
    const { id } = outcome;
    let result: RiskResult;
    try {
      result = score(db, mint, nowS());
    } catch {
      markFailed(db, id);
      return fail(res, 500, 'INTERNAL', 'scoring failed; payment not settled, retry with the same payment');
    }

    // A row that already carries a tx_sig was settled earlier: never re-settle it.
    if (outcome.kind === 'claimed' || !outcome.settled) {
      try {
        const s = await backend.settle(payload, want);
        if (s.success !== true || s.network !== cfg.network || !isTxSig(s.transaction) || !setTxSig(db, id, s.transaction)) {
          markFailed(db, id);
          return invalid(s.errorReason ?? 'settlement failed');
        }
        res.set('PAYMENT-RESPONSE', encodePaymentResponseHeader(s));
      } catch {
        markFailed(db, id);
        return fail(res, 502, 'UPSTREAM', 'settlement failed; retry with the same payment');
      }
    }

    markServed(db, id, result, Date.now() - t0);
    return res.status(200).json(result);
  });

  return app;
}
