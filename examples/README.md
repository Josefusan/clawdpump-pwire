# examples/

Plain Node 22 `.mjs` scripts. No build step for the scripts themselves; they import `@x402/*`,
`@solana/kit` and `@modelcontextprotocol/sdk` from the workspace `node_modules` (all already dependencies
of `packages/mcp`). Run them from the repo root.

```bash
git clone https://github.com/Josefusan/clawdpump-pwire.git && cd clawdpump-pwire
npm ci
npm run build -w @pumpwire/mcp     # only needed for mcp-call.mjs
```

| Script | What it shows | Needs | Spends money? |
|---|---|---|---|
| `x402-fetch.mjs <mint>` | Raw HTTP: `GET /v1/risk/:mint` → `402 PaymentRequired` (printed) | `PUMPWIRE_API_URL` | No |
| `x402-fetch.mjs <mint> --pay` | … → pay with `@x402/fetch` → `200 RiskResult` + settlement tx | + `SOLANA_KEYPAIR_PATH`, optional `PUMPWIRE_NETWORK`, `PUMPWIRE_MAX_PRICE_USD` | Yes: $0.01 USDC per call |
| `mcp-call.mjs` | Starts the MCP server over stdio, lists tools | `PUMPWIRE_API_URL`, `SOLANA_KEYPAIR_PATH` | No |
| `mcp-call.mjs <mint> --pay` | Calls `rug_risk_score` through MCP | same, plus optional caps | Yes: $0.01 USDC per call |
| `stats.mjs [--json]` | Free `GET /v1/stats`: first-party vs third-party totals, last calls | `PUMPWIRE_API_URL` | No |

Rules every script follows:

- It refuses to start without the env names it needs and prints which one is missing.
- It never prints key material. The keypair file is read once (by the script or by the MCP server) and
  only the shortened public address is shown.
- Nothing is paid without `--pay`. With `--pay`, the price is checked against `PUMPWIRE_MAX_PRICE_USD`
  (default `0.05`), the network and the USDC mint **before** anything is signed.
- Use a dedicated hot wallet holding only a few USDC. Never point these at a main wallet.

`PUMPWIRE_API_URL`: the devnet API currently runs on the team VPS and is not public yet. The public URL
will be published in this README and on `/live` once it is. Mainnet cutover is pending.

Full walkthroughs: [`docs/USE-CASES.md`](../docs/USE-CASES.md). Hermes install kit: [`hermes/`](../hermes/README.md).

This is risk information, not advice.
