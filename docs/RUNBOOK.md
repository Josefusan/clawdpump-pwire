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

## Outcome labels & backtest (mainnet)

`tokens.outcome` / `outcome_at` drive the `deployer_history` score factor and the `/live` "caught" board.
`scripts/label-outcomes.mjs` writes them using the pure rules in `scripts/backtest.mjs`.

**Restored 2026-10-04:** the PumpWire cron lines were missing and `mainnet.db` had **0** labels, so `caught`
was always empty. Current crontab:

- `0 * * * *` — `sqlite3 ~/pumpwire-data/mainnet.db ".backup ~/pumpwire-data/mainnet-snapshot.db"`
- `17 * * * *` — `cd ~/pumpwire && /home/joseph/pumpwire-node/bin/node --experimental-sqlite scripts/label-outcomes.mjs --db ~/pumpwire-data/mainnet.db --min-age 7200 --limit 8000 >> ~/pumpwire-data/label-outcomes-mainnet.log`

**Manual label run:** `ssh pw 'cd ~/pumpwire && PATH=~/pumpwire-node/bin:$PATH node --experimental-sqlite scripts/label-outcomes.mjs --db ~/pumpwire-data/mainnet.db --min-age 7200 --limit 8000'`

**Backtest** (feeds `/v1/stats.backtest` from `~/pumpwire/data/backtest.json`; the API re-reads it by mtime, so no restart):
`node --experimental-sqlite scripts/backtest.mjs --db ~/pumpwire-data/mainnet.db --out ~/pumpwire/data/backtest.json --min-age 7200`.
This is **heavy**: it scores every launch and scans the 24 h trade window per token (~5k tokens × ~170k trades).
Run it on a quiet box, not while other workloads saturate the host.

**Check:** `curl -s localhost:<PORT>/v1/stats | python3 -m json.tool` → inspect `caught` and `backtest`.

## Trade source (T-028)

Ingest's default source (`INGEST_TRADE_SOURCE=logs`) is pump.fun program events over Solana **mainnet** `logsSubscribe`: creates, trades and migrations are decoded from `Program data:` log lines with their exact slot, validated like any other untrusted input, with no API key and a single subscription. pump.fun exists only on mainnet, so the socket is chosen independently of the payment network: `SOLANA_WS_URL` if set, else Helius mainnet via `HELIUS_API_KEY`, else the public `wss://api.mainnet-beta.solana.com` (works, rate limited). Trades are stored only for mints created inside the last `INGEST_TRADE_WINDOW_MIN` minutes, at most `INGEST_MAX_TRACKED` of them. `INGEST_TRADE_SOURCE=pumpportal` restores the PumpPortal feed (its `subscribeTokenTrade` needs a funded PumpPortal key).

Health: the 10 s `ingest: stats` line carries `trade_source` and `logs: {frames, notifications, failed_tx, events, reconnects}`; `trades` and `rows_trades` must climb within a minute of start. If `logs.reconnects` climbs and `events` does not, the WS endpoint is rejecting `logsSubscribe` (rate limit or unsupported): set `SOLANA_WS_URL` to a provider that supports it.
