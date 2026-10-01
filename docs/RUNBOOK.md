# PumpWire Runbook

## Devnet

Checkout `~/pumpwire-devnet`; secrets in `~/.config/pumpwire/devnet.env` (chmod 600, never printed).
pm2 apps: `pumpwire-ingest`, `pumpwire-api-devnet`.

- **Deploy:** `cd ~/pumpwire-devnet && git pull && scripts/deploy-devnet.sh` (npm ci, build, `pm2 startOrReload`, `/health` smoke; safe to re-run).
- **Health:** `curl -fsS http://127.0.0.1:3000/health` (503 if DB unreadable or `ingest_lag_s > 60`); `pm2 status`.
- **Logs:** `pm2 logs pumpwire-ingest` / `pm2 logs pumpwire-api-devnet` (`--lines 200 --nostream` for a dump).
- **Counts:** `sqlite3 ~/pumpwire-data/snapshot.db "select count(*) from tokens; select count(*) from trades;"` (use `pumpwire.db` for live; snapshot is up to 1h old). Paid-call totals: `curl -s http://127.0.0.1:3000/v1/stats`.
- **Restart:** `pm2 restart pumpwire-ingest` or `pm2 restart pumpwire-api-devnet` (never `pm2 delete`).
- **Snapshot:** hourly cron runs `sqlite3 /home/joseph/pumpwire-data/pumpwire.db ".backup /home/joseph/pumpwire-data/snapshot.db"`. Workers read `~/pumpwire-data/snapshot.db`; the live WAL DB is `~/pumpwire-data/pumpwire.db`.
- **Persist across reboot:** `pm2 save` (once services are running).

## Mainnet (Mises only; agents never run this)

Checkout `~/pumpwire` (`main`); secrets `~/.config/pumpwire/mainnet.env` (chmod 600). pm2 apps: `pumpwire-ingest`, `pumpwire-api`.
Facilitator (verified 2026-10-01): `https://facilitator.payai.network`; network `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`.
Required env NAMES: `PAYTO_ADDRESS PUMPWIRE_DB_PATH X402_NETWORK X402_FACILITATOR_URL USDC_MINT SOLANA_RPC_URL HELIUS_API_KEY PUMPPORTAL_WS_URL PORT FIRST_PARTY_WALLETS`.
`PAYTO_ADDRESS`'s USDC ATA must already exist; `PORT` must not be `3000` (devnet API). Idempotent; re-run after any fix.
Non-interactive runs (pipe/CI) are refused unless `CUTOVER_YES=1`; smoke requires the 402 to name the mainnet network.

**Go live**
1. `cd ~/pumpwire && git merge --ff-only origin/main` (or merge `dev` → `main`); tree must be clean.
2. `scripts/cutover-mainnet.sh` — preflight (main, `npm test`, env names, mainnet network/USDC, facilitator `/supported`),
   prints payTo/price/caps/facilitator and asks `yes`; then build, `pm2 startOrReload ecosystem.mainnet.config.cjs`,
   smoke (`/health` 200, unpaid `/v1/risk/<mint>` → 402).
3. `pm2 save`. Point the Caddy API host at `PORT` if not already.
4. Make 3 paid calls (mcp/scout, mainnet wallet), then `curl -s localhost:<PORT>/v1/stats`.

**Verify on Solscan**: `https://solscan.io/tx/<tx_sig>` (sig from `/v1/stats` `last_calls`): Success, USDC transfer of 0.01
to `PAYTO_ADDRESS`'s ATA, token = mainnet USDC `EPjFWdd5…Dt1v`. Also check `https://solscan.io/account/<PAYTO_ADDRESS>`.

**Rollback (one command)**: `scripts/cutover-mainnet.sh --rollback` — stops `pumpwire-api` (mainnet API off) and moves
`pumpwire-ingest` back to the devnet definition. Logs: `pm2 logs pumpwire-api --lines 100 --nostream`.
