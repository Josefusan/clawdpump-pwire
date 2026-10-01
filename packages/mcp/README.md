# pumpwire-mcp

Stdio MCP server exposing one tool, `rug_risk_score({ mint })`. Each call pays the PumpWire API
$0.01 USDC over x402 (`exact`, Solana) **from your own wallet**. PumpWire never sees your key; spend caps are
enforced locally, before anything is signed.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `PUMPWIRE_API_URL` | required | PumpWire API base URL |
| `SOLANA_KEYPAIR_PATH` | required | Path to your Solana keypair JSON (read once, never logged or sent) |
| `PUMPWIRE_NETWORK` | `devnet` | `devnet`, `mainnet`, or a `solana:<genesis>` CAIP-2 id. Offers on any other network are refused |
| `PUMPWIRE_PAY_ASSET` | `USDC` | `USDC` only for now; `ANSEM` is refused (`WRONG_ASSET`) until its mint/price are verified |
| `PUMPWIRE_MAX_PRICE_USD` | `0.05` | Per-call cap |
| `PUMPWIRE_DAILY_CAP_USD` | `5` | Per-UTC-day cap; running spend is persisted |
| `PUMPWIRE_SPEND_STATE_PATH` | `~/.pumpwire-mcp/spend.json` | Where the daily spend is persisted (optional) |

Your wallet needs USDC on the chosen network (and the facilitator pays the SOL fee).

## Run

```bash
npm run build -w @pumpwire/mcp
PUMPWIRE_API_URL=https://api.example.com SOLANA_KEYPAIR_PATH=~/.config/solana/agent.json \
  node packages/mcp/dist/index.js
```

## MCP client config (Claude Code / Hermes / any stdio client)

```json
{
  "mcpServers": {
    "pumpwire": {
      "command": "node",
      "args": ["/path/to/pumpwire/packages/mcp/dist/index.js"],
      "env": {
        "PUMPWIRE_API_URL": "https://api.example.com",
        "SOLANA_KEYPAIR_PATH": "/home/me/.config/solana/agent.json",
        "PUMPWIRE_NETWORK": "devnet",
        "PUMPWIRE_MAX_PRICE_USD": "0.05",
        "PUMPWIRE_DAILY_CAP_USD": "5"
      }
    }
  }
}
```

Example call: `tools/call` `rug_risk_score` with `{"mint": "<pump.fun mint>"}` returns `structuredContent` =
`RiskResult` (`score`, `verdict`, `reasons` with evidence, `data_gaps`, `model_version`, ...) plus the same JSON as text.

## Errors

`isError: true` with text `{"error": CODE}`, `CODE` one of `INVALID_MINT`, `NOT_FOUND`, `PRICE_ABOVE_CAP`,
`DAILY_CAP_REACHED`, `WRONG_NETWORK`, `WRONG_ASSET`, `INSUFFICIENT_FUNDS`, `UPSTREAM`. The cap errors mean nothing was signed.
The daily budget is reserved before signing and only returned if signing itself fails, so it never under-counts.

## Tests

`npx vitest run packages/mcp` — MCP client → mock x402 API/facilitator → `RiskResult`, no network.
A real devnet run is tracked as A-012.
