import { LIMITS, cleanText, isAddress, isSig } from './sanitize.js';

export const MAX_FRAME_BYTES = 256 * 1024;
const LAMPORTS_PER_SOL = 1e9;
const TOKEN_SCALE = 1e6; // pump.fun mints use 6 decimals (VERIFY, docs/INTERFACES.md section 2)

export interface ParsedCreate {
  kind: 'create';
  mint: string;
  deployer: string;
  signature: string;
  name: string | null;
  symbol: string | null;
  uri: string | null;
  hasSocials: boolean | null;
}
export interface ParsedTrade {
  kind: 'trade';
  side: 'buy' | 'sell';
  mint: string;
  wallet: string;
  sig: string;
  lamports: number;
  tokenAmount: number;
}
export interface ParsedMigrate {
  kind: 'migrate';
  mint: string;
}
export interface Skipped {
  kind: 'ignored' | 'malformed' | 'error';
  reason: string;
}
export type Parsed = ParsedCreate | ParsedTrade | ParsedMigrate | Skipped;

const skip = (kind: Skipped['kind'], reason: string): Skipped => ({ kind, reason });

/** UI units (float) -> raw integer base units; null if not a finite, non-negative, safe integer. */
export function toRaw(ui: unknown, scale: number): number | null {
  if (typeof ui !== 'number' || !Number.isFinite(ui) || ui < 0) return null;
  const raw = Math.round(ui * scale);
  return Number.isSafeInteger(raw) ? raw : null;
}

function hasSocials(o: Record<string, unknown>): boolean | null {
  const vals = [o.twitter, o.telegram, o.website];
  if (vals.every((v) => typeof v !== 'string')) return null;
  return vals.some((v) => typeof v === 'string' && v.trim() !== '');
}

function parseCreate(o: Record<string, unknown>): Parsed {
  if (!isAddress(o.mint)) return skip('malformed', 'create: bad mint');
  if (!isAddress(o.traderPublicKey)) return skip('malformed', 'create: bad deployer');
  if (!isSig(o.signature)) return skip('malformed', 'create: bad signature');
  return {
    kind: 'create',
    mint: o.mint,
    deployer: o.traderPublicKey,
    signature: o.signature,
    name: cleanText(o.name, LIMITS.name),
    symbol: cleanText(o.symbol, LIMITS.symbol, true),
    uri: cleanText(o.uri, LIMITS.uri),
    hasSocials: hasSocials(o),
  };
}

function parseTrade(o: Record<string, unknown>, side: 'buy' | 'sell'): Parsed {
  if (!isAddress(o.mint)) return skip('malformed', 'trade: bad mint');
  if (!isAddress(o.traderPublicKey)) return skip('malformed', 'trade: bad wallet');
  if (!isSig(o.signature)) return skip('malformed', 'trade: bad signature');
  if (typeof o.solAmount !== 'number') return skip('malformed', 'trade: missing solAmount');
  if (typeof o.tokenAmount !== 'number') return skip('malformed', 'trade: missing tokenAmount');
  const lamports = toRaw(o.solAmount, LAMPORTS_PER_SOL);
  const tokenAmount = toRaw(o.tokenAmount, TOKEN_SCALE);
  if (lamports === null || tokenAmount === null) return skip('malformed', 'trade: amount out of range');
  return { kind: 'trade', side, mint: o.mint, wallet: o.traderPublicKey, sig: o.signature, lamports, tokenAmount };
}

/** Pure: one decoded JSON value -> typed message or a reasoned skip. Never throws. */
export function parseMessage(v: unknown): Parsed {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return skip('malformed', 'not an object');
  const o = v as Record<string, unknown>;
  if ('error' in o) return skip('error', 'upstream error frame');
  if (typeof o.txType !== 'string') {
    return 'message' in o ? skip('ignored', 'server notice') : skip('malformed', 'no txType');
  }
  switch (o.txType) {
    case 'create':
      return parseCreate(o);
    case 'buy':
    case 'sell':
      return parseTrade(o, o.txType);
    case 'migrate':
      return isAddress(o.mint) ? { kind: 'migrate', mint: o.mint } : skip('malformed', 'migrate: bad mint');
    default:
      return skip('ignored', 'unknown txType');
  }
}

/** Pure: raw WS frame text -> Parsed. */
export function parseFrame(raw: string): Parsed {
  if (raw.length > MAX_FRAME_BYTES) return skip('malformed', 'frame too large');
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return skip('malformed', 'invalid JSON');
  }
  return parseMessage(v);
}
