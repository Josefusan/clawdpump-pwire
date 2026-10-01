# Backtest (T-014) — rug-risk v0 on real launches

Harness: `scripts/backtest.mjs` (read-only over `~/pumpwire-data/snapshot.db`, Node `node:sqlite`; on Node 22.12 add `--experimental-sqlite`). Writes `data/backtest.json`, which `/v1/stats.backtest` and the `/live` page read.

```bash
node --experimental-sqlite scripts/backtest.mjs --db ~/pumpwire-data/snapshot.db --out data/backtest.json
```

## What it does

1. Takes every token in `tokens` created at least `--min-age` (default 7200 s) ago.
2. Labels each one from its trades (or keeps `tokens.outcome` if ingest already set it):

| label | rule |
|---|---|
| `DEV_DUMP` | the deployer sold ≥ 50% of the tokens it bought, within 24 h of creation |
| `SURVIVED_24H` | migrated, or at least one trade after `created_at + 86400` |
| `DEAD_1H` | no trade after `created_at + 3600` and not migrated |
| unlabelled | alive between 1 h and 24 h; counted later |

Order matters: `DEV_DUMP` wins over `SURVIVED_24H` (a dumped token can keep trading).

3. Scores each token **as of `created_at + --score-at` seconds (default 120 s)** using only trades, wallets and deployer history known at that moment, so the number reflects what PumpWire would have said two minutes after launch, not with hindsight.
4. Reports precision and recall at HIGH+ (verdict `HIGH` or `EXTREME`) where a positive is `DEAD_1H` or `DEV_DUMP`.

## Caveats, stated plainly

- Before T-010 lands, `packages/score` has no `score()`; the harness then prints labels only (`caveat: scorer not built`). No precision/recall is claimed.
- `n < 100` is flagged as `small sample`: indicative only. The /live page shows the same caveat.
- Labels are mechanical. "Dead in 1 h" on pump.fun also catches tokens nobody noticed; precision at HIGH+ is therefore the number to watch, recall will look low by construction.
- Scoring at T+2 min uses a snapshot built in the harness (`buildSnapshotAsOf`) with the pump.fun fixed supply constant; T-010 may replace it with `buildSnapshot()` from `@pumpwire/score`.

## Latest run

Not run yet on real data (no launches ingested at the time of writing). The harness was verified on an empty DB (`n=0`, exit 0) and on a seeded DB with one dead, one dumped and one survived launch using a stub scorer (precision 100%, recall 50%, tp=1 fp=0 fn=1).
