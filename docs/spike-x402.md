# Spike: x402 paid call on Solana devnet — WORKS (2026-10-01 04:23 UTC)

Branch `spike/x402-devnet`. Reference for T-006 / T-011 / T-012 builders: copy, do not rediscover.

## Proof

One paid `GET /v1/risk/:mint` on Solana devnet, settled by the public facilitator:

| item | value |
|---|---|
| tx (devnet) | `3SaUx1eQyutzRoUP7mm4thk7gqUukCWHbMdZUt1gjUJa9ovRUydtvFwgsyaE2Q51U5onS1PENvv9B6WFUMLauxMn` |
| Solscan | https://solscan.io/tx/3SaUx1eQyutzRoUP7mm4thk7gqUukCWHbMdZUt1gjUJa9ovRUydtvFwgsyaE2Q51U5onS1PENvv9B6WFUMLauxMn?cluster=devnet |
| payer | `DtGkR8kXbxVFmGNP5AKD7g2MRskFed67BPFb7efHp5Mf` (devnet payer == PAYTO tonight) |
| amount / asset | `10000` base units = $0.01 USDC devnet `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| network | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (CAIP-2, v2) |
| facilitator | `https://x402.org/facilitator` (devnet only, keyless; fee payer `CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5`) |
| round trip | 402 → sign → verify → handler → settle → 200 in 1512 ms |
| unpaid | `402` with `PAYMENT-REQUIRED` header (base64 JSON `PaymentRequired`, x402Version 2) |
| invalid mint | `400 INVALID_MINT` before any 402 (free, §4.4 order) |

Run on the VPS (keys never leave the box):

```bash
# server (process holds NO private key)
PORT=8402 node --env-file=$HOME/.config/pumpwire/devnet.env packages/api/dist/main.js
# client: one paid call with the CALLER's wallet
node --env-file=$HOME/.config/pumpwire/devnet.env --import tsx scripts/devnet-pay.ts <mint> http://127.0.0.1:8402
```

## Exact packages and imports (x402 2.28.0, published 2026-09-29)

```ts
// server — packages/api/src/app.ts
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient, type RoutesConfig } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/server';

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: X402_FACILITATOR_URL }))
  .register(X402_NETWORK, new ExactSvmScheme());
server.onAfterSettle(async (ctx) => { /* ctx.result.transaction = tx sig; ctx.result.payer */ });
app.use(paymentMiddleware({
  'GET /v1/risk/:mint': { accepts: { scheme: 'exact', price: '$0.01', network: X402_NETWORK, payTo: PAYTO_ADDRESS, maxTimeoutSeconds: 60 },
                          description: '…', mimeType: 'application/json' },
}, server));

// client — scripts/devnet-pay.ts
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch';
import { ExactSvmScheme } from '@x402/svm/exact/client';
const client = new x402Client(); client.register('solana:*', new ExactSvmScheme(signer));
const res = await wrapFetchWithPayment(fetch, client)(url);
const settle = new x402HTTPClient(client).getPaymentSettleResponse((n) => res.headers.get(n)); // {success, transaction, network, payer}
```

Deps: `packages/api`: `express @x402/express @x402/core @x402/svm`; root dev: `tsx @types/express @x402/fetch @solana/kit @scure/base`.
`:mint` route params are supported by the middleware's pattern compiler. `price: "$0.01"` is converted by the scheme to `amount: "10000"` and `asset: USDC(network)`.

## Gotchas that bit

1. `HTTPFacilitatorClient` and `RoutesConfig` are NOT re-exported by `@x402/express` — import from `@x402/core/server`; `Network` from `@x402/core/types` (template literal type `${string}:${string}`).
2. `onAfterSettle` context is `{ paymentPayload, requirements, result }` — it is `ctx.requirements`, not `paymentRequirements`.
3. `tsconfig.tsbuildinfo` must be git-ignored (now in `.gitignore`), or `tsc -b` on another box thinks dist is up to date and emits nothing.
4. Run the server with the explicit Node: `$HOME/pumpwire-node/bin/node`. A bare `node` inside tmux on the VPS resolved to Node 26 from another project.
5. The solana-keygen JSON file is a 64-byte array → `createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(...)))`. Node 22 prints an Ed25519 ExperimentalWarning; harmless.
6. `payer` in the settlement response is the buyer here (facilitator reports the token authority). Memo: the client adds a random memo nonce; a server-side `extra.memo` is static per route in `PaymentOption`, so per-request memo binding (ADR-002 fallback path) is only needed for the direct-transfer fallback. In the facilitator path the payload is bound to the route's `PaymentRequirements` (asset, amount, payTo, network) and replay is rejected at the facilitator (signature uniqueness) plus our `calls.payment_id` UNIQUE.

## For T-006 done-when (what remains on top of this spike)

- `calls` row per request: `payment_id = sha256(payload.transaction bytes)` INSERT before serving (replay → `402 PAYMENT_REPLAYED`), `tx_sig` + `payer` from `onAfterSettle`, `first_party = payer ∈ FIRST_PARTY_WALLETS`, `latency_ms`.
- `404 NOT_FOUND` when mint not in `tokens` (before 402). Rate limit per IP.
- `/v1/stats` from `calls`. Real score from `@pumpwire/score` (T-010) replaces `stubRiskResult`.
- Tests already here: `/health`, free `400`, stub shape. Add: replay rejection with a fake facilitator.

## Mainnet (A-002 input)

`x402.org/facilitator` is devnet-only. Keyless mainnet option verified today: `https://facilitator.payai.network` (`/supported` lists `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` exact, fee payer `CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww`). CDP facilitator `https://api.cdp.coinbase.com/platform/v2/x402` needs `CDP_API_KEY_ID/SECRET` (1,000 settlements/mo free, then $0.001). Switch = two env values: `X402_NETWORK`, `X402_FACILITATOR_URL`, plus `PAYTO_ADDRESS` whose USDC ATA must already exist.

$ANSEM (`9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump`) is **Token-2022**, 6 decimals; add as a second `accepts[]` entry with an `AssetAmount` object `{ amount, asset }` (the `"$"` shortcut is USDC-only). Whether the facilitator settles it is still a live probe (T-022).
