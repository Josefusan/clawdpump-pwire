import { fileURLToPath } from 'node:url';

/** Repo-root data/backtest.json regardless of the process cwd (pm2 runs the api with cwd=packages/api). */
const DEFAULT_BACKTEST_JSON = fileURLToPath(new URL('../../../data/backtest.json', import.meta.url));

export interface Config {
  port: number;
  dbPath: string;
  network: string;
  facilitatorUrl: string;
  payTo: string;
  usdcMint: string;
  maxTimeoutS: number;
  rateLimitPerMin: number;
  firstPartyWallets: string[];
  /** JSON written by scripts/backtest.mjs; served as /v1/stats.backtest (null when missing). */
  backtestJsonPath: string;
}

// Devnet defaults (verified 2026-09-30). Mainnet must be set explicitly via env.
const DEVNET_NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const DEVNET_FACILITATOR = 'https://x402.org/facilitator';

export const PRICE_BASE_UNITS = 10000; // $0.01 in USDC base units (6 decimals)

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const payTo = env.PAYTO_ADDRESS;
  const dbPath = env.PUMPWIRE_DB_PATH;
  if (!payTo) throw new Error('PAYTO_ADDRESS is required');
  if (!dbPath) throw new Error('PUMPWIRE_DB_PATH is required');
  return {
    port: Number(env.PORT ?? 8080),
    dbPath,
    network: env.X402_NETWORK ?? DEVNET_NETWORK,
    facilitatorUrl: env.X402_FACILITATOR_URL ?? DEVNET_FACILITATOR,
    payTo,
    usdcMint: env.USDC_MINT ?? DEVNET_USDC,
    maxTimeoutS: Number(env.X402_MAX_TIMEOUT_S ?? 60),
    rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN ?? 60),
    firstPartyWallets: (env.FIRST_PARTY_WALLETS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    backtestJsonPath: env.BACKTEST_JSON_PATH ?? DEFAULT_BACKTEST_JSON,
  };
}
