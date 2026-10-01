# 01 · PumpWire ($PWIRE) — Product Spec

## One-liner (official, 461 chars)

> PumpWire is an AI agent on Solana that does the homework trading bots skip. It watches every pump.fun launch, bonding curve and dev wallet, then sells what it finds as MCP tools: rug-risk scores, early-buyer cluster maps and repeat-deployer alerts. Other agents pay per call over x402 in USDC or $ANSEM, so every request is an onchain transaction. $PWIRE holders get discounted, priority access. Built on existing wallet-forensics work, shipping live on stream.

## The problem

Trading agents on pump.fun see a new mint, but they can't see who deployed it, who bought first, whether those buyers are one person, or whether this dev has rugged ten times this week. Each bot rebuilds that forensics badly. PumpWire does it once, well, and sells it per call.

## What PumpWire sells (MCP tools / paid endpoints)

| Tool | Input | Output | Price (USDC) | Phase |
|---|---|---|---|---|
| `rug_risk_score` | `mint` | 0–100 score, verdict (`LOW`/`MED`/`HIGH`/`EXTREME`), top 5 reasons with evidence, `model_version`, `as_of_slot` | $0.01 | **MVP** |
| `deployer_history` | `wallet` or `mint` | prior launches, % that died < 1h, % dev-sold > 50% within 10 min, avg time-to-dump, linked deployer wallets | $0.02 | MVP+ (Oct 4) |
| `early_buyer_map` | `mint` | first N buyers, same-slot bundles, shared funding sources, cluster IDs, % of supply held by clusters | $0.05 | Stretch (Oct 5) |
| `deployer_alerts` | filter (min score) | stream of new launches from flagged deployers | $0.01 / alert | Stretch (Oct 6) |

**Payment rails:** x402 `exact` scheme on Solana mainnet.
- **USDC:** default.
- **$ANSEM:** same price in $ANSEM at spot, **10% cheaper** to push $ANSEM volume (judged bonus).
- **$PWIRE holder tier:** wallets holding ≥ threshold $PWIRE (set at launch, e.g. 0.1% supply) get **50% off** and priority queue. MVP implementation: payer signs a nonce; server checks $PWIRE balance and returns the discounted `PaymentRequirements`.

## What $PWIRE does (token utility)

1. **Access tier:** hold $PWIRE → discounted, priority calls.
2. **Revenue line:** 75% of $PWIRE creator trading fees flow to us via ClawPump (25% to ClawPump; 25% of their share buys $CLAW/$ANSEM).
3. **Roadmap (not promised, don't market as returns):** holder-gated alert feed, holder vote on which signals ship next.

> Guardrail: never describe $PWIRE as an investment, never promise price, buybacks or yield. Utility only. See `clawrena-compliance`.

## Architecture (MVP)

```
pump.fun (onchain)
   │  PumpPortal WS (new tokens, trades)  +  Helius RPC / Enhanced Tx (funding sources)
   ▼
[ingest]  Node/TS worker ──► SQLite (WAL)  tokens · trades · wallets · deployers · funding_edges
   ▼
[score]   pure function score(mint, snapshot) → {score, verdict, reasons[]}   (versioned, unit-tested)
   ▼
[api]     Express + @x402/express  → GET /v1/risk/:mint  /v1/deployer/:wallet  /v1/early-buyers/:mint
          free: GET /health  GET /live (public dashboard)  GET /v1/stats
   ▼
[mcp]     npm `pumpwire-mcp` (stdio + streamable HTTP) — wraps the paid API with @x402/fetch using the CALLER's wallet
   ▼
[scout]   Hermes / claw-agent "PWIRE Scout": watches launches, pays for scores, **drafts** HIGH/EXTREME alerts for Joseph to approve; it never posts
```

- **Host:** a small VPS, `pm2` or `systemd`, Caddy for TLS on `api.<domain>` (or the VPS IP for day 1).
- **Payee (`payTo`):** PumpWire agent wallet `6TeXC9ay1RBHE2QasADUScD1865ZKfmePFt8wkQLc8Se`, or a dedicated revenue wallet you control. Keys stay out of the repo and out of prompts.

## Rug-risk scoring v0 (deterministic, explainable)

Weighted sum, capped 0–100. Each factor emits a reason string with the raw number.

| Factor | Signal | Weight |
|---|---|---|
| Deployer history | prior launches by dev wallet (and wallets funded by it) that died / dev-dumped | 25 |
| Bundled launch | ≥ 3 buys in the creation slot or the next 2 slots from wallets with a shared funder | 20 |
| Holder concentration | top 10 non-curve holders % of supply | 15 |
| Dev position | dev still holds > X% or has sold > 50% | 10 |
| Fresh-wallet ratio | % of first 30 buyers with wallet age < 24h and < 3 prior txs | 10 |
| Funding cluster | early buyers funded from the same hub/CEX-withdraw wallet within 6h | 10 |
| Curve velocity anomaly | bonding-curve % gained vs unique buyers (fast progress, few wallets) | 5 |
| Metadata flags | copies trending name/ticker, no socials, recycled image hash | 5 |

**Verdicts:** 0–24 LOW · 25–49 MED · 50–74 HIGH · 75–100 EXTREME.
**Backtest before launch:** label ~200 historical launches (dead < 1h / dev-dumped vs survived > 24h), and report precision at HIGH+ on the /live page. Honest numbers beat big claims.

## Data model (SQLite)

- `tokens(mint PK, name, symbol, uri, deployer, created_slot, created_at, curve_pct, migrated)`
- `trades(sig PK, mint, wallet, side, sol, tokens, slot, ts)`
- `wallets(address PK, first_seen_ts, tx_count, funder, funder_ts)`
- `deployers(address PK, launches, dead_1h, dev_dumped, last_launch_ts)`
- `funding_edges(src, dst, sol, ts)`
- `calls(id PK, tool, arg, payer, asset, amount, tx_sig, score, latency_ms, ts)` → powers /live and the volume stats

## Public /live page (judges watch this)

- Counters: total paid calls, USDC paid, $ANSEM paid, unique paying wallets, unique integrators
- Last 50 calls: tool, mint (Solscan link), score, **payment tx (Solscan link)**, latency
- "Caught it" board: tokens scored HIGH/EXTREME that later died (with timestamps)
- Backtest precision/recall, model version
- "Integrate in 2 minutes" snippet (drives the **builders onboarded** score)

## Non-goals for this week

Trading on signals, custody of anyone's funds, a UI beyond /live, multi-chain.
