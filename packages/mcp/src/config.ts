export const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC: Record<string, string> = {
  [DEVNET]: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  [MAINNET]: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};
const MICRO = 1_000_000; // USDC has 6 decimals: base units == micro-USD

export interface Config {
  apiUrl: string;
  keypairPath: string;
  network: string;
  payAsset: 'USDC' | 'ANSEM';
  maxPriceMicro: number;
  dailyCapMicro: number;
  spendStatePath: string;
  /** May embed an API key: never log. */
  rpcUrl: string;
}

const PUBLIC_RPC: Record<string, string> = {
  [DEVNET]: 'https://api.devnet.solana.com',
  [MAINNET]: 'https://api.mainnet-beta.solana.com',
};

export function usdcMintFor(network: string): string | undefined {
  return USDC[network];
}

function usd(raw: string | undefined, dflt: number, name: string): number {
  const n = raw === undefined || raw === '' ? dflt : Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return Math.round(n * MICRO);
}

function network(raw: string | undefined): string {
  if (!raw || raw === 'devnet') return DEVNET;
  if (raw === 'mainnet' || raw === 'mainnet-beta') return MAINNET;
  if (/^solana:[1-9A-HJ-NP-Za-km-z]{20,}$/.test(raw)) return raw;
  throw new Error('PUMPWIRE_NETWORK must be devnet, mainnet or a solana:<genesis> CAIP-2 id');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiUrl = env.PUMPWIRE_API_URL;
  const keypairPath = env.SOLANA_KEYPAIR_PATH;
  if (!apiUrl) throw new Error('PUMPWIRE_API_URL is required');
  if (!keypairPath) throw new Error('SOLANA_KEYPAIR_PATH is required');
  const asset = (env.PUMPWIRE_PAY_ASSET ?? 'USDC').toUpperCase();
  if (asset !== 'USDC' && asset !== 'ANSEM') throw new Error('PUMPWIRE_PAY_ASSET must be USDC or ANSEM');
  const net = network(env.PUMPWIRE_NETWORK);
  const rpcUrl = env.SOLANA_RPC_URL || PUBLIC_RPC[net];
  if (!rpcUrl) throw new Error('SOLANA_RPC_URL is required for this network');
  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    keypairPath,
    network: net,
    rpcUrl,
    payAsset: asset,
    maxPriceMicro: usd(env.PUMPWIRE_MAX_PRICE_USD, 0.05, 'PUMPWIRE_MAX_PRICE_USD'),
    dailyCapMicro: usd(env.PUMPWIRE_DAILY_CAP_USD, 5, 'PUMPWIRE_DAILY_CAP_USD'),
    spendStatePath: env.PUMPWIRE_SPEND_STATE_PATH ?? `${env.HOME ?? '.'}/.pumpwire-mcp/spend.json`,
  };
}
