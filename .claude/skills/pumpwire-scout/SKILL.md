---
name: pumpwire-scout
description: Run PWIRE Scout, the Hermes/claw-agent buyer that watches new pump.fun launches, pays PumpWire for scores and drafts alerts. Use for agents/scout and live demo flows.
---

# PWIRE Scout

## Setup (Hermes / claw-agent on the VPS)
```bash
hermes setup && hermes model        # cheap model for loop, e.g. DeepSeek via OpenRouter
hermes clawpump setup               # ClawPump MCP (wallet-ops, token-sniper, market-intel)
# add pumpwire-mcp as an MCP server with Scout's own wallet
hermes gateway                      # optional Telegram for alert approvals
```
Fund Scout's wallet with a small amount: ~$10 USDC + ~0.02 SOL for fees. **Mises funds it; Scout never requests more.**

## Loop
1. Listen for new launches (ClawPump token-sniper skill or PumpWire /v1/stats feed).
2. Filter: ≥ 5 unique buyers in the first 2 min (skip dust launches).
3. Call `rug_risk_score` (≤ $0.05; ≤ $5/day). Every call is tagged first_party.
4. If HIGH/EXTREME: draft an alert → Telegram to Mises for approval → Mises posts.
5. After 1h and 24h: re-check the outcome (dead? dumped?) and feed the "Caught it" board.

## Stream demo script
New launch → Scout pays $0.01 (show Solscan) → EXTREME with reasons → switch `PUMPWIRE_PAY_ASSET=ANSEM` → pay in $ANSEM live → show /live counters move.

## Never
Trade tokens, exceed caps, post without approval, or buy $PWIRE.
