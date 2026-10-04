# $PWIRE holder tier

Status: **built in T-043, off until `PWIRE_MINT` is set on the API.** README and SUBMISSION say "live" only
after the mainnet API runs with it.

## What it does

A wallet that holds **at least 1,000,000 $PWIRE** (0.1% of supply) and pays from that same wallet gets a
`rug_risk_score` call for **$0.005 USDC instead of $0.01**. Holding $PWIRE in the paying wallet is the
whole setup: `@pumpwire/mcp` asks for the holder price automatically.

Utility only. No price, yield or buyback language (`clawrena-compliance`).

## How to use it

Raw HTTP: send `X-PWIRE-HOLDER: <your wallet>` and pay from that wallet.

```bash
curl -s -H "X-PWIRE-HOLDER: <wallet>" https://<api>/v1/risk/<mint>   # 402 offer: amount 5000 if the wallet holds the tier
```

MCP: nothing to do. `fetchRiskResult` sends `x-pwire-holder` = the paying wallet. The API ignores it below
the threshold.

## Mechanism (x402 `exact`, Solana)

The 402 offer sets the price before the payer is known, so the discount is bound to a named wallet and
checked again at payment time.

1. **Offer.** If `X-PWIRE-HOLDER` is a valid wallet and its $PWIRE balance is at least
   `PWIRE_TIER_MIN_BALANCE`, `amount` is `5000`. Otherwise it is the full `10000`.
2. **Bind.** The holder offer's memo is `pumpwire:` + sha256(`rug_risk_score:<mint>:h:<wallet>`)[0..20]
   (29 bytes). It ties the offer to one mint and one wallet, and it stays within the stock x402 SVM compute
   budget (`MAX_MEMO_BYTES` = 32; the long `pumpwire:<tool>:<arg>` form broke every payment before T-031).
3. **Pay.** A `5000` payment is accepted only with the header and exactly that memo. Before verify, the
   wallet must still hold the tier. After verify, the facilitator's `payer` must equal the header wallet.
   Any mismatch returns `402 PAYMENT_INVALID`, and nothing is settled.
4. **Record.** Holder calls are served calls with `amount = 5000`. `/v1/stats` reports
   `totals.paid_calls_holder`, and `/live` shows it.

Balance reads use `getTokenAccountsByOwner` with a mint filter (works for Token-2022), are cached 60 s per
wallet, and **fail closed**: an RPC error, a 3 s timeout or an unparseable account means full price, never a
discount. Uncached reads are capped at 30 per minute across all callers, so random headers cannot exhaust
the RPC.

At payment time a wallet below the tier gets `402 PAYMENT_INVALID`. If the balance cannot be read, the API
returns `503 HOLDER_CHECK_UNAVAILABLE` (retry, or pay full price without the header). Nothing is settled
in either case. A retry of a payment the API already claimed skips the tier read; the payer check still runs.

**Known limit:** the check is a point-in-time balance (cached 60 s). There is no minimum holding period, so a
wallet can hold $PWIRE only while it calls. That is accepted: the discount still requires holding.

**Observability:** `/v1/stats` → `holder_tier` = `{ on, mint, min_balance, checks, errors, throttled,
last_error, last_error_at, payer_missing }`. Read errors are logged at most once a minute. The API refuses to
start if `PWIRE_MINT` is not base58 or `SOLANA_RPC_URL` is missing.

## Config (API env)

| Name | Value | Notes |
|---|---|---|
| `PWIRE_MINT` | `2b2Tv315U1FUtYF9Y1H2b2qrCnL3tN5QPabScFPCw8vw` | Unset = tier off, behaviour identical to before T-043 |
| `PWIRE_TIER_MIN_BALANCE` | `1000000000000` | Base units (6 decimals) = 1,000,000 PWIRE. Default if unset |
| `SOLANA_RPC_URL` | mainnet RPC | Needed for balance reads; without it the tier stays off |

## Code

- `packages/api/src/holder.ts`: balance reader + `holderCheck` (cache, timeout, fail closed).
- `packages/api/src/app.ts`: header, offer price, memo, payer check.
- `packages/api/src/stats.ts`: `paid_calls_holder`.
- `packages/mcp/src/client.ts`: sends `x-pwire-holder`.
- Tests: `packages/api/test/holder.test.ts`, `packages/mcp/test/e2e.test.ts`.
