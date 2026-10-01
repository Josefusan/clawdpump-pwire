// One paid devnet call against the PumpWire API using the CALLER's wallet (INTERFACES §6.1 direction).
// Usage: node --env-file ~/.config/pumpwire/devnet.env --import tsx scripts/devnet-pay.ts [mint] [apiUrl]
// Reads the signer file named by DEVNET_PAYER_KEYPAIR (solana-keygen JSON). Prints only the public address.
import { readFileSync } from 'node:fs';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch';
import { ExactSvmScheme } from '@x402/svm/exact/client';

const signerPath = process.env.DEVNET_PAYER_KEYPAIR ?? process.env.SOLANA_KEYPAIR_PATH;
if (!signerPath) throw new Error('DEVNET_PAYER_KEYPAIR not set');
const mint = process.argv[2] ?? 'So11111111111111111111111111111111111111112';
const apiUrl = process.argv[3] ?? process.env.PUMPWIRE_API_URL ?? 'http://127.0.0.1:8402';

const signer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(signerPath, 'utf8')) as number[]));
console.log(JSON.stringify({ event: 'payer', address: signer.address }));

const client = new x402Client();
client.register('solana:*', new ExactSvmScheme(signer));
const payFetch = wrapFetchWithPayment(fetch, client);

const t0 = Date.now();
const unpaid = await fetch(`${apiUrl}/v1/risk/${mint}`);
console.log(JSON.stringify({ event: 'unpaid', status: unpaid.status, hasPaymentRequired: unpaid.headers.has('payment-required') }));

const res = await payFetch(`${apiUrl}/v1/risk/${mint}`, { method: 'GET' });
const body = await res.json();
const settle = new x402HTTPClient(client).getPaymentSettleResponse((n) => res.headers.get(n));
console.log(JSON.stringify({ event: 'paid', status: res.status, ms: Date.now() - t0, body, settle }, null, 2));
if (res.status !== 200 || !settle?.success) process.exit(2);
