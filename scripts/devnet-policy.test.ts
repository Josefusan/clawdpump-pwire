import { describe, expect, it } from 'vitest';
import { assertDevnetPolicy, DEVNET_NETWORK, DEVNET_USDC } from './devnet-policy.ts';

const ok = { scheme: 'exact', network: DEVNET_NETWORK, asset: DEVNET_USDC, amount: '10000' };
const req = (o: object) => ({ accepts: [{ ...ok, ...o }] });

describe('devnet-pay policy', () => {
  it('accepts the exact devnet USDC 10000 offer', () => {
    expect(() => assertDevnetPolicy(req({}))).not.toThrow();
  });
  it.each([
    ['amount', { amount: '10001' }],
    ['asset', { asset: 'So11111111111111111111111111111111111111112' }],
    ['network', { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }],
  ])('refuses wrong %s', (_n, o) => {
    expect(() => assertDevnetPolicy(req(o))).toThrow(/refusing to sign/);
  });
  it('refuses if any offer is bad, or none', () => {
    expect(() => assertDevnetPolicy({ accepts: [ok, { ...ok, amount: '1' }] })).toThrow(/refusing/);
    expect(() => assertDevnetPolicy({ accepts: [] })).toThrow(/refusing/);
    expect(() => assertDevnetPolicy({})).toThrow(/refusing/);
  });
});
