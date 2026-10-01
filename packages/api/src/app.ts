// PumpWire API — x402 devnet spike (reference for T-006). Frozen contract: docs/INTERFACES.md §4, ADR-002.
// The API process holds NO private key: the facilitator pays fees and settles to PAYTO_ADDRESS.
import express, { type Request, type Response } from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient, type RoutesConfig } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/server';

export const SOLANA_DEVNET_CAIP2: Network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const SOLANA_MAINNET_CAIP2: Network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const MODEL_VERSION = 'v0.1.0';
export const RUG_RISK_PRICE_USD = '$0.01';

export interface SettledInfo { tool: string; arg: string; txSig: string; network: string; payer: string }

export interface ApiConfig {
  network: Network;           // CAIP-2 (X402_NETWORK)
  facilitatorUrl: string;     // X402_FACILITATOR_URL
  payTo: string;              // PAYTO_ADDRESS (owner wallet; funds land in its USDC ATA)
  maxTimeoutSeconds: number;  // X402_MAX_TIMEOUT_S
  solanaRpcUrl?: string;      // optional: embeds a recent blockhash in the 402 challenge
  onSettled?: (info: SettledInfo) => void;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const payTo = env.PAYTO_ADDRESS;
  if (!payTo || !BASE58_RE.test(payTo)) throw new Error('PAYTO_ADDRESS missing or not base58');
  return {
    network: (env.X402_NETWORK ?? SOLANA_DEVNET_CAIP2) as Network,
    facilitatorUrl: env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator',
    payTo,
    maxTimeoutSeconds: Number(env.X402_MAX_TIMEOUT_S ?? 60),
    solanaRpcUrl: env.SOLANA_RPC_URL,
  };
}

/** Stub RiskResult in the frozen §2 shape. T-010 replaces this with score() over the DB snapshot. */
export function stubRiskResult(mint: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    mint,
    score: 0,
    verdict: 'LOW' as const,
    reasons: [] as never[],
    data_gaps: ['deployer_history', 'bundled_launch', 'holder_concentration', 'dev_position',
      'fresh_wallets', 'funding_cluster', 'curve_velocity', 'metadata_flags'],
    model_version: MODEL_VERSION,
    as_of_slot: 0,
    as_of_ts: now,
  };
}

export function createApp(cfg: ApiConfig) {
  const app = express();
  app.disable('x-powered-by');

  // Free routes first — never behind the paywall.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, db: 'stub', network: cfg.network, model_version: MODEL_VERSION, last_trade_ts: null, ingest_lag_s: null });
  });

  // §4.4 order: 400 INVALID_MINT is free and happens BEFORE any payment is requested.
  app.get('/v1/risk/:mint', (req: Request, res: Response, next) => {
    const mint = String(req.params.mint ?? '');
    if (!BASE58_RE.test(mint)) {
      res.status(400).json({ error: 'INVALID_MINT', message: 'mint must be base58 (32-44 chars)' });
      return;
    }
    next();
  });

  const facilitator = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });
  const server = new x402ResourceServer(facilitator)
    .register(cfg.network, new ExactSvmScheme(cfg.solanaRpcUrl ? { rpcUrl: cfg.solanaRpcUrl } : undefined));

  server.onAfterSettle(async (ctx) => {
    const r = ctx.result;
    if (r.success && cfg.onSettled) {
      const extra = ctx.requirements.extra as Record<string, unknown> | undefined;
      const arg = extra && typeof extra['memo'] === 'string' ? String(extra['memo']) : '';
      cfg.onSettled({ tool: 'rug_risk_score', arg, txSig: r.transaction, network: r.network, payer: r.payer ?? '' });
    }
  });

  const routes: RoutesConfig = {
    'GET /v1/risk/:mint': {
      accepts: {
        scheme: 'exact',
        price: RUG_RISK_PRICE_USD,           // scheme maps "$0.01" -> USDC of `network`, amount "10000"
        network: cfg.network,
        payTo: cfg.payTo,
        maxTimeoutSeconds: cfg.maxTimeoutSeconds,
      },
      description: 'PumpWire rug-risk score for a pump.fun mint',
      mimeType: 'application/json',
      unpaidResponseBody: () => ({ contentType: 'application/json', body: { error: 'PAYMENT_REQUIRED', message: 'Pay $0.01 USDC via x402 (PAYMENT-REQUIRED header)' } }),
    },
  };
  app.use(paymentMiddleware(routes, server));

  app.get('/v1/risk/:mint', (req: Request, res: Response) => {
    res.json(stubRiskResult(String(req.params.mint)));
  });

  return app;
}
