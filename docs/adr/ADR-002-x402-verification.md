# ADR-002: x402 payment verification on Solana
Status: accepted (T-002) · Context: 01 §What PumpWire sells, skill pumpwire-x402-api, INTERFACES §4.4, §7

**Decision — primary path**: x402 V2 `exact` scheme on Solana via `@x402/express` + a Solana facilitator
(URL VERIFY). Server holds no key. We accept only: `network == X402_NETWORK`, `asset == USDC_MINT`,
`amount` exactly the route price, destination = ATA(`PAYTO_ADDRESS`, asset), age ≤ `maxTimeoutSeconds` (60).
Facilitator responses are validated (`isValid === true`; settle `success === true`, `transaction` is a
base58 sig, `network` matches); anything else → 402. Order: 400/404 checks first, never charge for them.

**Replay / idempotency**: `payment_id` = sha256(payload transaction bytes) is INSERTed into `calls`
(UNIQUE) before scoring; on settle `tx_sig` (UNIQUE) is stored. Conflict → 402 `PAYMENT_REPLAYED`, except
same `tool`+`arg` with `status='served'` → re-serve stored `result_json` (200, no double charge).
Settled sigs are re-confirmed via our own RPC (`onchain_confirmed`); /live shows confirmed calls only.

**Fallback (`X402_DIRECT_FALLBACK=1`)**: if facilitator verify/settle fails with network error/5xx, the
client may send its own SPL `TransferChecked` and present `X-PUMPWIRE-TX: <sig>`. Server fetches the tx
(commitment `confirmed`), requires: no error; a TransferChecked of `asset` with exact `amount` to
ATA(`PAYTO_ADDRESS`); blockTime ≤ 120 s old; `payment_id = "direct:<sig>"` unused. A third party
front-running a public sig only gets the same idempotent result for the same `arg`.
**Consequences**: USDC only for MVP; $ANSEM/$PWIRE tiers are STRETCH pending mint + facilitator VERIFY.
