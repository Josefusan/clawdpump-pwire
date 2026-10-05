// Devnet end-to-end for pay.ts with a fake Wallet Standard wallet backed by a keypair file.
// Run on the box: node e2e.mjs <api> <payer.json> [mint]. Not shipped to /live.
import { readFileSync } from 'node:fs';
import { createKeyPairSignerFromBytes, getTransactionDecoder, getTransactionEncoder } from '@solana/kit';
import { payForScore, probe, type Connected } from './pay';

const [api, keyFile, mintArg] = process.argv.slice(2);
const DEVNET = { network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', chain: 'solana:devnet' };
const kp = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(keyFile, 'utf8'))));
const account = { address: kp.address, chains: ['solana:devnet'], features: [] };
let calls = 0;
const conn: Connected = {
  address: kp.address, account,
  wallet: { name: 'fake', icon: '', chains: ['solana:devnet'], accounts: [account], features: {
    'solana:signTransaction': { async signTransaction({ transaction, chain }: any) {
      calls++;
      if (chain !== 'solana:devnet') throw new Error('wrong chain ' + chain);
      const tx = getTransactionDecoder().decode(transaction) as any;
      const [sigs] = await kp.signTransactions([tx]);
      return [{ signedTransaction: new Uint8Array(getTransactionEncoder().encode({ ...tx, signatures: { ...tx.signatures, ...sigs } })) }];
    } },
  } } as any,
};
let mint = mintArg;
if (!mint) {
  const s = await (await fetch(`${api}/v1/stats`)).json();
  mint = s.last_calls?.[0]?.arg;
}
console.log('mint', mint, 'payer', kp.address);
const offer = await probe(api, mint, kp.address, DEVNET);
console.log('probe', { amount: String(offer.amount), holder: offer.holder });
const steps: string[] = [];
const paid = await payForScore({ apiBase: api, mint, conn, expect: DEVNET, rpcUrl: 'https://api.devnet.solana.com', onStep: (s) => steps.push(s) });
console.log('steps', steps.join('>'), 'walletSignCalls', calls);
console.log('tx', paid.tx, 'score', paid.result?.score, paid.result?.verdict);
// guard: a mainnet page must refuse a devnet offer before signing
try { await probe(api, mint); console.log('GUARD FAIL'); } catch (e) { console.log('guard ok:', (e as Error).message); }
