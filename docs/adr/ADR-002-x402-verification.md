# ADR-002: x402 payment verification on Solana
Status: accepted (T-002) · Context: 01 §What PumpWire sells, skill pumpwire-x402-api, INTERFACES §4.4, §7

**Decision — primary path**: x402 V2 `exact` scheme on Solana via the x402 express middleware (package names VERIFY) +
a Solana facilitator (URL VERIFY). Server holds no key. Accept only: `network == X402_NETWORK`, `asset == USDC_MINT`,
`amount` exactly the route price, destination = ATA(`PAYTO_ADDRESS`, asset), age ≤ `maxTimeoutSeconds` (60).
Facilitator responses validated (`isValid === true`; settle `success === true`, `transaction` is a base58 sig,
`network` matches); anything else → 402. Order: 400/404 checks first, never charge for them.

**Replay / idempotency**: `payment_id` = sha256(payload tx bytes) INSERTed into `calls` (UNIQUE) before scoring;
on settle `tx_sig` (UNIQUE) stored. Conflict → 402 `PAYMENT_REPLAYED`, except same `tool`+`arg` with status `served`
→ re-serve `result_json` (200), or status `failed` (or `pending` > 120 s) → retry re-runs scoring on the same row,
never re-settles a row whose `tx_sig` is set. Settled sigs re-confirmed via own RPC (`onchain_confirmed`).

**Fallback (`X402_DIRECT_FALLBACK=1`)**, only after facilitator network error/5xx: client sends its own SPL
`TransferChecked` **plus a Memo instruction `pumpwire:<tool>:<arg>`** (e.g. `pumpwire:rug_risk_score:<mint>`) and
presents `X-PUMPWIRE-TX: <sig>`. Server fetches the tx (commitment `confirmed`) and requires: no error; exact
`amount` of `asset` to ATA(`PAYTO_ADDRESS`); exactly one memo, byte-equal to the request's `pumpwire:<tool>:<arg>`;
blockTime ≤ 120 s old; `payment_id = "direct:<sig>"` unused. Memo mismatch → 402 `PAYMENT_INVALID`, row not claimed,
so a copied public sig can only buy the exact resource its payer bound it to. Consequences: USDC only for MVP.
