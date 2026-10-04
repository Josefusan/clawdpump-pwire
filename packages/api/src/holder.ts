import { address, createSolanaRpc } from '@solana/kit';

/** Reads an owner's balance of one mint in base units. Throws on any read or parse problem. */
export type BalanceReader = (owner: string, mint: string, signal?: AbortSignal) => Promise<bigint>;

/** Sum of the owner's token accounts for `mint` (SPL or Token-2022), in base units. No account => 0n. */
export function rpcBalanceReader(rpcUrl: string): BalanceReader {
  const rpc = createSolanaRpc(rpcUrl);
  return async (owner, mint, signal) => {
    const { value } = await rpc
      .getTokenAccountsByOwner(address(owner), { mint: address(mint) }, { encoding: 'jsonParsed' })
      .send(signal ? { abortSignal: signal } : undefined);
    let total = 0n;
    for (const acc of value) {
      const amount = (acc.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info
        ?.tokenAmount?.amount;
      // An account we cannot parse is an error, not a zero: a zero would be cached as a confirmed "no".
      if (typeof amount !== 'string' || !/^[0-9]+$/.test(amount)) throw new Error('unparseable token account');
      total += BigInt(amount);
    }
    return total;
  };
}

export const HOLDER_CACHE_S = 60;
export const HOLDER_TIMEOUT_MS = 3000;
/** Max uncached RPC lookups per minute across all callers, so random headers cannot exhaust the RPC. */
export const HOLDER_LOOKUPS_PER_MIN = 30;

/** `unknown` = the balance could not be read (RPC error, timeout, lookup budget spent). Never a discount. */
export type HolderStatus = 'holder' | 'not_holder' | 'unknown';

export interface HolderStats {
  checks: number;
  errors: number;
  throttled: number;
  last_error: string | null;
  last_error_at: number | null;
}

/**
 * `check(wallet)` → holder | not_holder | unknown. Only a successful read is cached (HOLDER_CACHE_S per wallet).
 * Callers treat `unknown` as "no discount" (fail closed). Errors are counted and logged at most once a minute.
 */
export function holderCheck(read: BalanceReader, mint: string, minBalance: bigint, nowS: () => number) {
  const cache = new Map<string, { at: number; ok: boolean }>();
  const stats: HolderStats = { checks: 0, errors: 0, throttled: 0, last_error: null, last_error_at: null };
  let budget = { win: -1, n: 0 };
  let lastWarnAt = 0;

  const check = async (wallet: string): Promise<HolderStatus> => {
    const hit = cache.get(wallet);
    if (hit && nowS() - hit.at < HOLDER_CACHE_S) return hit.ok ? 'holder' : 'not_holder';
    const win = Math.floor(nowS() / 60);
    if (budget.win !== win) budget = { win, n: 0 };
    if (++budget.n > HOLDER_LOOKUPS_PER_MIN) {
      stats.throttled++;
      return 'unknown';
    }
    stats.checks++;
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const balance = await Promise.race([
        read(wallet, mint, ac.signal),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), HOLDER_TIMEOUT_MS); }),
      ]);
      const ok = balance >= minBalance;
      if (cache.size > 10_000) cache.clear();
      cache.set(wallet, { at: nowS(), ok });
      return ok ? 'holder' : 'not_holder';
    } catch (e) {
      stats.errors++;
      stats.last_error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      stats.last_error_at = nowS();
      if (nowS() - lastWarnAt >= 60) {
        lastWarnAt = nowS();
        console.warn(`pumpwire-api holder_tier balance read failed: ${stats.last_error}`);
      }
      return 'unknown';
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
  };
  return { check, stats };
}
