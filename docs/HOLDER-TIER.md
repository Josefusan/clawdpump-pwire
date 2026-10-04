# $PWIRE holder tier — design (planned, not live)

Status: **design only.** No holder-tier code is in the API today. The token exists
(`2b2Tv315U1FUtYF9Y1H2b2qrCnL3tN5QPabScFPCw8vw`); the discount is not implemented.

## Goal

Give holding $PWIRE a real function: holders pay less and go first on scored calls.
This is what makes "customers who must hold $PWIRE" a mechanism, not a slogan.

## Constraints (from `clawrena-compliance`)

- Utility only. No price, yield or buyback language.
- The tier must never let a non-holder pay the discounted amount.
- Any change to payment verification needs an independent review before mainnet (opus tier).

## Mechanism (x402 `exact`, Solana)

The 402 offer sets the price **before** the payer is known, so the discount must be bound to a
named wallet and re-checked at settlement.

1. **Offer.** `GET /v1/risk/:mint` accepts `X-PWIRE-HOLDER: <wallet>`. If `PWIRE_MINT` is set,
   the server reads that wallet's $PWIRE balance over RPC. Balance ≥ `PWIRE_TIER_MIN_BALANCE`
   → the offer's `amount` is `PRICE_BASE_UNITS / 2`, else the full price.
2. **Bind.** The discounted offer gets a distinct memo (for example the existing
   `pumpwire:<tool>:<arg>` scheme plus a `h` marker) so it cannot be confused with a full-price offer.
3. **Settle.** After the facilitator verifies, require the paying wallet to equal the wallet in
   `X-PWIRE-HOLDER`, and re-check the balance. Mismatch or a dropped balance → reject the
   discounted payment (never serve at the discounted price).
4. **Record.** Add a `holder` column to `calls` and a `/v1/stats` counter so `/live` can show
   holder calls separately.

## Touch points

- `packages/api/src/config.ts` — `PWIRE_MINT`, `PWIRE_TIER_MIN_BALANCE`; feature off when `PWIRE_MINT` is unset.
- `packages/api/src/app.ts` — read the header, check the balance, choose the price, bind the memo.
- `packages/api/src/tx.ts` / verification — enforce payer == claimed holder on discounted payments.
- `packages/api/src/stats.ts` — holder counter; `docs/schema.sql` — `calls.holder`.
- `packages/api/test/` — a non-holder claiming the discount is rejected; a holder whose balance dropped is rejected.

## Coordinates

- Mint: `2b2Tv315U1FUtYF9Y1H2b2qrCnL3tN5QPabScFPCw8vw`.
- Threshold: TBD by Mises (for example 0.1% of supply).
