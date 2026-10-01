import { loadConfig as loadPayConfig } from '@pumpwire/mcp';

type PayConfig = ReturnType<typeof loadPayConfig>;

/**
 * Scout configuration. Reads env NAMES only; values are never logged.
 * Runs happily off the api's devnet.env: DEVNET_PAYER_KEYPAIR and X402_NETWORK are mapped onto the
 * pumpwire-mcp names when the mcp names are absent, so no new secrets are needed on the box.
 */
export interface ScoutConfig {
  dbPath: string;
  apiUrl: string;
  minBuyers: number;
  windowS: number;
  maxAgeS: number;
  pollMs: number;
  haltBackoffMs: number;
  alertsDir: string;
  statePath: string;
  pay: PayConfig;
}

function int(raw: string | undefined, dflt: number, name: string): number {
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export function loadScoutConfig(env: NodeJS.ProcessEnv = process.env): ScoutConfig {
  const dbPath = env.PUMPWIRE_DB_PATH;
  if (!dbPath) throw new Error('PUMPWIRE_DB_PATH is required');
  const home = env.HOME ?? '.';
  const apiUrl = (env.PUMPWIRE_API_URL ?? `http://127.0.0.1:${env.PORT ?? 3000}`).replace(/\/+$/, '');

  const payEnv: NodeJS.ProcessEnv = {
    ...env,
    PUMPWIRE_API_URL: apiUrl,
    SOLANA_KEYPAIR_PATH: env.SOLANA_KEYPAIR_PATH ?? env.SCOUT_KEYPAIR_PATH ?? env.DEVNET_PAYER_KEYPAIR,
    PUMPWIRE_NETWORK: env.PUMPWIRE_NETWORK ?? env.X402_NETWORK,
    PUMPWIRE_SPEND_STATE_PATH: env.PUMPWIRE_SPEND_STATE_PATH ?? `${home}/.pumpwire-scout/spend.json`,
  };

  return {
    dbPath,
    apiUrl,
    minBuyers: int(env.SCOUT_MIN_BUYERS, 5, 'SCOUT_MIN_BUYERS'),
    windowS: int(env.SCOUT_WINDOW_S, 120, 'SCOUT_WINDOW_S'),
    maxAgeS: int(env.SCOUT_MAX_AGE_S, 900, 'SCOUT_MAX_AGE_S'),
    pollMs: int(env.SCOUT_POLL_MS, 5000, 'SCOUT_POLL_MS'),
    haltBackoffMs: int(env.SCOUT_HALT_BACKOFF_MS, 600_000, 'SCOUT_HALT_BACKOFF_MS'),
    alertsDir: env.SCOUT_ALERTS_DIR ?? `${home}/pumpwire-data/alerts`,
    statePath: env.SCOUT_STATE_PATH ?? `${home}/.pumpwire-scout/state.json`,
    pay: clampCaps(loadPayConfig(payEnv)),
  };
}

/** Scout hard caps (docs/INTERFACES.md §3, clawrena-compliance): ≤ $0.05 per call, ≤ $5 per UTC day. Env can lower, never raise. */
export const SCOUT_MAX_PRICE_MICRO = 50_000;
export const SCOUT_DAILY_CAP_MICRO = 5_000_000;

export function clampCaps(pay: PayConfig): PayConfig {
  return {
    ...pay,
    maxPriceMicro: Math.min(pay.maxPriceMicro, SCOUT_MAX_PRICE_MICRO),
    dailyCapMicro: Math.min(pay.dailyCapMicro, SCOUT_DAILY_CAP_MICRO),
  };
}
