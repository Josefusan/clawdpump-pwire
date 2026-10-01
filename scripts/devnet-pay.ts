// One paid call against the devnet API. Usage:
//   DEVNET_PAYER_KEYPAIR=<path to a solana keypair JSON, or the JSON array itself> \
//   node --experimental-strip-types scripts/devnet-pay.ts <api-base-url> <mint>
// The payer needs devnet SOL (for nothing: the facilitator pays fees) and >= 0.01 devnet USDC.
// The keypair value is never printed. Prints the settled tx signature.
import { readFileSync } from 'node:fs';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import { registerExactSvmScheme } from '@x402/svm/exact/client';
import { assertDevnetPolicy } from './devnet-policy.ts';

async function loadSigner() {
  const v = process.env.DEVNET_PAYER_KEYPAIR;
  if (!v) throw new Error('DEVNET_PAYER_KEYPAIR is not set');
  try {
    const json = v.trim().startsWith('[') ? v : readFileSync(v, 'utf8'); // ENOENT text would echo the value
    return await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(json) as number[]));
  } catch {
    // Never echo the input: JSON.parse errors can contain the key bytes.
    throw new Error('invalid DEVNET_PAYER_KEYPAIR: expected a keypair path or a JSON secret-key array');
  }
}

async function main() {
  const [base, mint] = process.argv.slice(2);
  if (!base || !mint) throw new Error('usage: devnet-pay.ts <api-base-url> <mint>');
  const url = `${base.replace(/\/$/, '')}/v1/risk/${encodeURIComponent(mint)}`;

  const first = await fetch(url);
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
  const header = first.headers.get('payment-required');
  const required = header ? decodePaymentRequiredHeader(header) : await first.json();

  assertDevnetPolicy(required); // throws before any key is loaded or anything is signed

  const client = registerExactSvmScheme(new x402Client(), { signer: await loadSigner() });
  const payload = await client.createPaymentPayload(required);

  const paid = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payload) } });
  if (paid.status !== 200) throw new Error(`paid call failed: ${paid.status} ${await paid.text()}`);
  const settle = decodePaymentResponseHeader(paid.headers.get('payment-response') ?? '');
  const body = (await paid.json()) as { score: number; verdict: string };
  console.log(`OK score=${body.score} verdict=${body.verdict}`);
  console.log(`tx_sig=${settle.transaction} network=${settle.network}`);
}

main().catch((e: Error) => {
  console.error(`devnet-pay failed: ${e.message}`);
  process.exit(1);
});
