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
