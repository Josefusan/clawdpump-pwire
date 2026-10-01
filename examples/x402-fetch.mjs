#!/usr/bin/env node
// PumpWire raw x402 flow: GET /v1/risk/:mint -> 402 PaymentRequired -> pay -> 200 RiskResult.
//
// Usage (from the repo root, after `npm ci`):
//   PUMPWIRE_API_URL=... node examples/x402-fetch.mjs <mint>            # step 1 only: show the 402, pays nothing
//   PUMPWIRE_API_URL=... SOLANA_KEYPAIR_PATH=... PUMPWIRE_NETWORK=devnet \
//     node examples/x402-fetch.mjs <mint> --pay                         # steps 1-3: pays $0.01 USDC from YOUR wallet
//
// Env (names only; values are yours):
//   PUMPWIRE_API_URL        required  base URL of the PumpWire API
//   SOLANA_KEYPAIR_PATH     required with --pay  path to the paying keypair JSON (read once, never printed)
//   PUMPWIRE_NETWORK        optional  devnet (default) | mainnet
//   PUMPWIRE_MAX_PRICE_USD  optional  refuse to sign above this price (default 0.05)
//
// Imports resolve from the workspace's node_modules (@x402/* and @solana/kit are dependencies of packages/mcp).
// No new dependencies, no build step.

import { readFileSync } from 'node:fs';
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactSvmScheme } from '@x402/svm';
import { createKeyPairSignerFromBytes } from '@solana/kit';

const NETWORKS = {
  devnet: { caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', usdc: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' },
  mainnet: { caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
};
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function die(msg) {
  process.stderr.write(`x402-fetch: ${msg}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const pay = args.includes('--pay');
const mint = args.find((a) => !a.startsWith('--'));
const apiUrl = (process.env.PUMPWIRE_API_URL ?? '').replace(/\/+$/, '');
if (!apiUrl) die('PUMPWIRE_API_URL is required');
if (!mint || !MINT_RE.test(mint)) die('usage: node examples/x402-fetch.mjs <base58 mint> [--pay]');
const netName = process.env.PUMPWIRE_NETWORK || 'devnet';
const net = NETWORKS[netName === 'mainnet-beta' ? 'mainnet' : netName];
if (!net) die('PUMPWIRE_NETWORK must be devnet or mainnet');
const maxUsd = Number(process.env.PUMPWIRE_MAX_PRICE_USD ?? '0.05');
if (!Number.isFinite(maxUsd) || maxUsd < 0) die('PUMPWIRE_MAX_PRICE_USD must be a non-negative number');
const maxMicro = Math.round(maxUsd * 1_000_000); // USDC: 6 decimals, base units == micro-USD
if (pay && !process.env.SOLANA_KEYPAIR_PATH) die('SOLANA_KEYPAIR_PATH is required with --pay');

const url = `${apiUrl}/v1/risk/${mint}`;

// Step 1: unpaid request. A known mint answers 402 with x402 V2 PaymentRequired (INTERFACES §4.4).
const first = await fetch(url, { headers: { accept: 'application/json' } });
const firstBody = await first.json().catch(() => null);
console.log(`step 1  GET ${url} -> ${first.status}`);
if (first.status !== 402) {
  // 400 INVALID_MINT / 404 NOT_FOUND / 429 RATE_LIMITED are free and final.
  console.log(JSON.stringify(firstBody, null, 2));
  process.exit(first.status === 200 ? 0 : 1);
}
const offer = firstBody?.accepts?.[0];
console.log(
  JSON.stringify(
    { x402Version: firstBody?.x402Version, error: firstBody?.error, accepts: (firstBody?.accepts ?? []).map((a) => ({
      scheme: a.scheme, network: a.network, amount: a.amount, asset: a.asset, payTo: a.payTo, maxTimeoutSeconds: a.maxTimeoutSeconds,
    })) },
    null,
    2,
  ),
);
if (!pay) {
  console.log('dry run: nothing signed. Re-run with --pay to pay this offer from your own wallet.');
  process.exit(0);
}

// Step 2: pay. Our policy runs before anything is signed; any mismatch aborts with no transaction.
let refusal;
function policy(req) {
  if (req.scheme !== 'exact') return 'unsupported scheme';
  if (req.network !== net.caip2) return `network ${req.network} != ${net.caip2}`;
  if (req.asset !== net.usdc) return 'asset is not USDC on this network';
  if (!/^[0-9]{1,15}$/.test(String(req.amount))) return 'malformed amount';
  if (Number(req.amount) > maxMicro) return `price ${req.amount} base units above cap ${maxMicro}`;
  return null;
}
if (offer && policy(offer)) die(`refusing to pay: ${policy(offer)}`);

const bytes = Uint8Array.from(JSON.parse(readFileSync(process.env.SOLANA_KEYPAIR_PATH, 'utf8')));
const signer = await createKeyPairSignerFromBytes(bytes);
bytes.fill(0);
console.log(`step 2  paying from wallet ${signer.address.slice(0, 4)}…${signer.address.slice(-4)}`);

const client = x402Client.fromConfig({
  schemes: [{ network: 'solana:*', client: new ExactSvmScheme(signer) }],
  // Library-side cap as a second gate: only USDC on this network, at most maxMicro base units per payment.
  spendControls: { allowedAssets: [{ network: net.caip2, asset: net.usdc, maxAmountPerPayment: String(maxMicro) }] },
});
client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
  refusal = policy(selectedRequirements);
  if (refusal) return { abort: true, reason: refusal };
});
const payFetch = wrapFetchWithPayment(fetch, client);

let res;
try {
  res = await payFetch(url, { headers: { accept: 'application/json' } });
} catch (e) {
  die(refusal ? `refusing to pay: ${refusal}` : `payment failed: ${e instanceof Error ? e.message : 'unknown error'}`);
}

// Step 3: 200 body = RiskResult; the PAYMENT-RESPONSE header carries the settlement.
const body = await res.json().catch(() => null);
console.log(`step 3  -> ${res.status}`);
const settleHeader = res.headers.get('payment-response');
if (settleHeader) {
  try {
    const s = decodePaymentResponseHeader(settleHeader);
    console.log(JSON.stringify({ settlement: { success: s.success, network: s.network, transaction: s.transaction } }, null, 2));
  } catch {
    console.log('settlement header present but not decodable');
  }
}
console.log(JSON.stringify(body, null, 2));
process.exit(res.status === 200 ? 0 : 1);
