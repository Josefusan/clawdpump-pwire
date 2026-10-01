# @pumpwire/scout — PWIRE Scout (devnet)

The first-party buyer. Watches the ingest DB for hot launches, pays PumpWire for a `rug_risk_score` through the
`@pumpwire/mcp` client (caps enforced **before** signing), and writes HIGH/EXTREME alerts as **drafts**. It never trades,
never posts, never exceeds its caps.

- Filter: ≥ `SCOUT_MIN_BUYERS` (5) distinct non-deployer buyers inside the first `SCOUT_WINDOW_S` (120 s), launch younger than `SCOUT_MAX_AGE_S` (900 s).
- Caps: ≤ $0.05 per call and ≤ $5 per UTC day, clamped in code (`clampCaps`); env can only lower them. Spend persists in `PUMPWIRE_SPEND_STATE_PATH`.
- Every call is first-party: logged with `first_party: true`, and the api labels it when the payer is in its `FIRST_PARTY_WALLETS`.
- Alerts: `~/pumpwire-data/alerts/<mint>.md`, headed "DRAFT — NOT posted". A human decides.
- State: `~/.pumpwire-scout/state.json` so a restart never pays twice for the same mint.

## Env (names only)

Runs off the api's `devnet.env`: `PUMPWIRE_DB_PATH` (required, opened read-only), `DEVNET_PAYER_KEYPAIR` or `SOLANA_KEYPAIR_PATH` (path to the payer key, read once, never logged), `X402_NETWORK` or `PUMPWIRE_NETWORK`, `PORT` (api on 127.0.0.1) or `PUMPWIRE_API_URL`, optional `SOLANA_RPC_URL`, `PUMPWIRE_MAX_PRICE_USD`, `PUMPWIRE_DAILY_CAP_USD`, `SCOUT_*` knobs above.

## Run

```bash
npm run build -w @pumpwire/scout
pm2 start ecosystem.devnet.config.cjs --only pumpwire-scout-devnet   # on the devnet box
```

Evidence of a run: `~/.pm2/logs/pumpwire-scout-devnet-out.log` (one JSON line per scored launch) and
`sqlite3 -readonly ~/pumpwire-data/pumpwire.db "select count(*) from calls where first_party=1 and status='served'"`.
