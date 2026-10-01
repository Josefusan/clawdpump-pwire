---
name: pumpwire-rug-risk
description: PumpWire's deterministic, explainable rug-risk scoring engine and its backtest. Use for score(), weights, reasons, labeling and precision reporting.
---

# PumpWire Rug-Risk Scoring

## Contract
`score(mint, snapshot) -> { mint, score: 0..100, verdict: LOW|MED|HIGH|EXTREME, reasons: Reason[], model_version: "v0.x", as_of_slot }`
`Reason = { factor, points, detail, evidence: { wallets?, slots?, sigs? } }`. It's a pure function with no network calls, and the snapshot is read from SQLite.

## v0 factors (max points)
| factor | max | rule of thumb |
|---|---|---|
| deployer_history | 25 | prior launches by deployer (+ wallets it funded) that were DEAD_1H or DEV_DUMP; 3+ → full |
| bundled_launch | 20 | ≥ 3 buys in creation slot..+2 slots from wallets sharing a funder |
| holder_concentration | 15 | top-10 non-curve holders % supply; > 35% → full |
| dev_position | 10 | dev holds > 10% or sold > 50% |
| fresh_wallets | 10 | % of first 30 buyers with age < 24h and < 3 txs |
| funding_cluster | 10 | early buyers funded by the same wallet within 6h |
| curve_velocity | 5 | curve % gained per unique buyer anomalously high |
| metadata_flags | 5 | copied trending name/ticker, no socials, reused image hash |

Verdicts: 0–24 LOW · 25–49 MED · 50–74 HIGH · 75–100 EXTREME. Output the top 5 reasons by points, each with a number in `detail` (e.g. "4 of first 6 buyers funded by 7xQ…9f within 40 min").

## Backtest
- Label ~200 launches older than 24h: DEAD_1H, DEV_DUMP, SURVIVED_24H (DeepSeek labels, with evidence; Architect spot-checks 20).
- Report precision and recall at HIGH+ and a confusion table, and publish both on /live with the model_version.
- Change weights only with a DECISIONS.md entry, and bump model_version.

## Tests (≥ 15)
Clean launch → LOW; bundled launch → ≥ HIGH; serial dead-launch deployer deployer → ≥ HIGH; missing data → score computed with `reasons` noting "insufficient data" (never throw); stable ordering.

## Tone
"Risk", not "scam". Evidence first. Never name people.
