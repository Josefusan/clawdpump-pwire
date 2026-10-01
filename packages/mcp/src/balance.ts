import { address, createSolanaRpc } from '@solana/kit';

/** Sum of the owner's token accounts for `mint`, in base units. No account => 0n. */
export function rpcBalanceReader(rpcUrl: string): (owner: string, mint: string) => Promise<bigint> {
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
