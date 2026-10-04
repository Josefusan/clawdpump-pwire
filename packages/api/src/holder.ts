import { address, createSolanaRpc } from '@solana/kit';

/** Reads an owner's balance of one mint in base units. */
export type BalanceReader = (owner: string, mint: string) => Promise<bigint>;

/** Sum of the owner's token accounts for `mint` (SPL or Token-2022), in base units. No account => 0n. */
export function rpcBalanceReader(rpcUrl: string): BalanceReader {
  const rpc = createSolanaRpc(rpcUrl);
  return async (owner, mint) => {
    const { value } = await rpc
      .getTokenAccountsByOwner(address(owner), { mint: address(mint) }, { encoding: 'jsonParsed' })
      .send();
    let total = 0n;
    for (const acc of value) {
      const amount = (acc.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info
        ?.tokenAmount?.amount;
      if (typeof amount === 'string' && /^[0-9]+$/.test(amount)) total += BigInt(amount);
    }
    return total;
  };
}

export const HOLDER_CACHE_S = 60;
export const HOLDER_TIMEOUT_MS = 3000;

/**
 * `isHolder(wallet)`: true only when a balance read succeeds and is >= `minBalance`.
 * Fails closed: an RPC error or timeout is "not a holder" (full price), never a discount.
 * Successful reads are cached for HOLDER_CACHE_S per wallet; failures are not cached.
 */
export function holderCheck(read: BalanceReader, mint: string, minBalance: bigint, nowS: () => number) {
  const cache = new Map<string, { at: number; ok: boolean }>();
  return async (wallet: string): Promise<boolean> => {
    const hit = cache.get(wallet);
    if (hit && nowS() - hit.at < HOLDER_CACHE_S) return hit.ok;
    let timer: NodeJS.Timeout | undefined;
    try {
      const balance = await Promise.race([
        read(wallet, mint),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), HOLDER_TIMEOUT_MS); }),
      ]);
      const ok = balance >= minBalance;
      if (cache.size > 10_000) cache.clear();
      cache.set(wallet, { at: nowS(), ok });
      return ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}
