# PumpWire ($PWIRE) — Project Brief

**Status:** Applied and building · **Hackathon:** AnsemHack Clawrena (ClawPump × pump.fun) · **Last updated:** 2026-09-29

## What we're building (official description, 461 chars)

> PumpWire is an AI agent on Solana that does the homework trading bots skip. It watches every pump.fun launch, bonding curve and dev wallet, then sells what it finds as MCP tools: rug-risk scores, early-buyer cluster maps and repeat-deployer alerts. Other agents pay per call over x402 in USDC or $ANSEM, so every request is an onchain transaction. $PWIRE holders get discounted, priority access. Built on existing wallet-forensics work, shipping live on stream.

**Short version (token bio):** PumpWire is a Solana agent that sells pump.fun intel per call: rug-risk scores, early-buyer maps and repeat-deployer alerts, paid in USDC, $ANSEM or $PWIRE over x402.

## Token

| Field | Value |
|---|---|
| Name | PumpWire |
| Ticker | $PWIRE |
| Chain / launchpad | Solana / ClawPump (clawpump.tech) |
| Status | Launched (Sep 29, 2026) |
| Token link / mint | _add here_ |
| Agent wallet | `6TeXC9ay1RBHE2QasADUScD1865ZKfmePFt8wkQLc8Se` |
| Billing wallet (AI credits) | `2DbLD8…RPjWfJ` (see ClawPump dashboard for full address) |
| Launch cost | 0.012 SOL (0.018 with initial buy) + network fees |
| Fee split | 75% of creator trading fees to us, 25% to ClawPump |
| Avatar / logo | `pumpwire-avatar.png`, `pumpwire-logo.png` |

## Entry details

| Field | Value |
|---|---|
| Project name | PumpWire |
| Project X handle | @Josefusan111 |
| Primary contact | Joseph Clark |
| Contact email | <contact email, kept private> |
| Track | ClawPump × pump.fun (also auto-entered for Overall Winner) |
| Entry page | https://clawpump.tech/ansemhack/entry |

## Product: MCP tools (paid per call over x402)

1. **`rug_risk_score(mint)`** — 0–100 score with reasons: dev wallet launch history, holder concentration, bonding-curve progress. *(MVP, build first)*
2. **Early-buyer cluster map** — who bought first and whether those wallets are linked.
3. **Repeat-deployer alerts** — flags new launches from wallets with prior rugs.

**Payments:** x402 in USDC first, then $ANSEM (bonus points for a net-new $ANSEM use case). $PWIRE holders get discounted/priority calls.

## MVP plan (target live demo ~Oct 3; judging runs through Oct 7)

- [ ] `rug_risk_score` tool using free Helius RPC credits
- [ ] MCP server with x402 paywall (USDC → then $ANSEM)
- [ ] Demo buyer agent that watches new pump.fun launches and pays PumpWire per call (generates real onchain volume)
- [ ] Host on a small VPS with a public page showing live calls and scores
- [ ] Then: early-buyer maps, repeat-deployer alerts, $PWIRE holder discount

## Why it should score well

- Every paid call is an onchain Solana transaction → **onchain volume**
- Accepting $ANSEM → **$ANSEM utility** bonus
- Fits the ClawPump × pump.fun brief of **"novel tooling"**
- Builds on existing wallet-forensics work
