// Local payment policy for scripts/devnet-pay.ts (mirrors packages/mcp enforcePolicy): checked before anything is signed.
export const DEVNET_NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const PRICE_BASE_UNITS = '10000';

interface Offer { scheme?: string; network?: string; asset?: string; amount?: string }

/** Throws unless EVERY offer is devnet / devnet USDC / 10000 base units, so whichever one the client picks is safe. */
export function assertDevnetPolicy(required: unknown): void {
  const accepts = (required as { accepts?: Offer[] } | null)?.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) throw new Error('refusing to sign: no payment offers');
  for (const o of accepts) {
    if (o?.network !== DEVNET_NETWORK) throw new Error('refusing to sign: network is not devnet');
    if (o.asset !== DEVNET_USDC) throw new Error('refusing to sign: asset is not devnet USDC');
    if (String(o.amount) !== PRICE_BASE_UNITS) throw new Error(`refusing to sign: amount is not ${PRICE_BASE_UNITS}`);
  }
}
