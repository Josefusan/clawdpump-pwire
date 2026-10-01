---
name: pumpwire-mcp
description: The pumpwire-mcp package that lets any agent call PumpWire tools and pay per call via x402 with its own wallet. Use for packages/mcp, integration docs and onboarding builders.
---

# pumpwire-mcp

## What it is
An MCP server (stdio + streamable HTTP) that exposes PumpWire tools and pays for each call with **the caller's** Solana wallet via `@x402/fetch` + `@x402/svm`. PumpWire never holds user keys.

## Tools
- `rug_risk_score({ mint })`
- `deployer_history({ wallet? , mint? })` (when live)
- `early_buyer_map({ mint })` (when live)
- `pumpwire_stats()` (free)

## Config (env)
`PUMPWIRE_API_URL`, `SOLANA_KEYPAIR_PATH` (or wallet adapter), `PUMPWIRE_MAX_PRICE_USD` (default 0.05), `PUMPWIRE_PAY_ASSET` = USDC|ANSEM, `PUMPWIRE_DAILY_CAP_USD` (default 5).

Client policy: only pay when network = Solana mainnet, asset ∈ {USDC, $ANSEM}, amount ≤ max price, and daily cap not exceeded.

## Install snippet (put on /live and README; this drives "builders onboarded")
`@pumpwire/mcp` is private and not on npm yet: there is no `npx` install and no CLI flags. Run it from a
clone; configuration is env only.
```bash
git clone https://github.com/Josefusan/clawdpump-pwire.git && cd clawdpump-pwire
npm ci && npm run build -w @pumpwire/mcp
PUMPWIRE_API_URL=... SOLANA_KEYPAIR_PATH=/abs/path/agent.json node packages/mcp/dist/index.js   # stdio
# Claude Code / Hermes: register that command as an MCP server, then ask: "rug_risk_score for <mint>"
```
End-user kit: `hermes/README.md` (Hermes) and `docs/USE-CASES.md` (Claude, raw HTTP, stats).
Shipped today: `rug_risk_score` over stdio only. `pumpwire_stats()` and streamable HTTP are not implemented yet;
use `GET /v1/stats` directly.

## Onboarding push
- Publish to npm + GitHub (MIT). Add `pumpwire-x402-starter` template (fork to sell your own agent data over x402).
- Track integrators = unique non-first-party payer wallets + npm installs + forks; show on /live.

## Done when
Works from Claude Code AND from a Hermes agent; refuses to pay above cap; clear error when the wallet lacks USDC or SOL for fees.
