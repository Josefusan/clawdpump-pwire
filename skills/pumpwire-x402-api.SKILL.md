---
name: pumpwire-x402-api
description: PumpWire's paid HTTP API over x402 on Solana (USDC and $PWIRE holder tier live; $ANSEM planned, not enabled), free endpoints and the calls log. Use for packages/api, pricing and payment verification.
---

# PumpWire x402 API

## Stack (x402 V2 on Solana)
- Server: `express`, `@x402/express` (paymentMiddleware), `@x402/core` (facilitator client), `@x402/svm` (ExactSvmScheme).
- Networks (CAIP-2): mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, devnet `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`.
- USDC mainnet mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`; devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.
- Facilitator: a Solana-capable x402 facilitator (e.g. PayAI). **VERIFY** URL + mainnet support + whether non-USDC SPL tokens ($ANSEM) are accepted.
- $ANSEM mint: **VERIFY** from the official source before enabling.

## Routes
| Route | Price | Notes |
|---|---|---|
| `GET /v1/risk/:mint` | $0.01 USDC | MVP |
| `GET /v1/deployer/:wallet` | $0.02 | MVP+ |
| `GET /v1/early-buyers/:mint` | $0.05 | stretch |
| `GET /health`, `GET /v1/stats`, `GET /live` | free | stats power the /live page |

Pattern:
```js
const server = new x402ResourceServer(facilitator).register(NETWORK, new ExactSvmScheme());
app.use(paymentMiddleware({
  "GET /v1/risk/:mint": { accepts: [{ scheme: "exact", price: "$0.01", network: NETWORK, payTo: process.env.PAYTO_ADDRESS }],
                          description: "PumpWire rug-risk score for a pump.fun mint" }
}, server));
```

## Pricing variants
- **$ANSEM (planned, not enabled):** a second `accepts` entry priced at 90% of USD value in $ANSEM (spot from Jupiter quote, refreshed every 60s).
- **$PWIRE tier (live):** client sends `X-PWIRE-HOLDER: <wallet>`; if that wallet holds ≥ `PWIRE_TIER_MIN_BALANCE` (1M PWIRE) the 402 offers 5000 base units with a wallet-bound memo, and verify must report that wallet as payer. See `docs/HOLDER-TIER.md`.

## Verification must enforce
Amount, mint, recipient ATA = payTo, network, not-before/expiry, and replay protection (store used payment ids/sigs). Reject everything else with 402.

## Calls log
After settlement, insert into `calls(tool, arg, payer, asset, amount, tx_sig, score, latency_ms, first_party, ts)`. `first_party = payer ∈ FIRST_PARTY_WALLETS`.

## Done when (G3/G4)
Devnet: 20 paid calls OK; underpaid / wrong mint / replayed payments rejected. Mainnet: Mises approves payTo + prices; 3 real calls visible on Solscan and /live.
