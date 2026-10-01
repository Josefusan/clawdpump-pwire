# PumpWire for Hermes: rug-risk checks in 5 minutes

Give a [Hermes](https://github.com/NousResearch/hermes-agent) (claw-agent) a pump.fun rug-risk check it
pays for itself: $0.01 USDC per call over x402, from the agent's own wallet, with hard spend caps.
Two pieces: an MCP server registration (the tool) and a skill (when and how to use it).

> **Status:** the API runs on **devnet** on the team server and is **not public yet**; mainnet cutover is
> pending. The MCP server works over stdio against the devnet API today. Scores currently top out around
> `MED` while wallet enrichment and outcome labels accumulate.

## What you need

- Node 22 and git.
- A **dedicated** Solana keypair file (JSON byte array, as written by `solana-keygen new -o …`) holding a
  few USDC on the network you use. Devnet USDC mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.
  The payment fee payer is the x402 facilitator (`extra.feePayer` in the 402 offer), so the wallet pays USDC
  only; whether it needs SOL for anything else depends on the facilitator (verify on your first call).
- The PumpWire API URL (`PUMPWIRE_API_URL`). It will be published in the main README and on `/live`
  when the API is public.

## 1 · Clone and build (≈ 2 min)

```bash
git clone https://github.com/Josefusan/clawdpump-pwire.git
cd clawdpump-pwire
npm ci
npm run build -w @pumpwire/mcp
# sanity check: should exit with "pumpwire-mcp: PUMPWIRE_API_URL is required"
node packages/mcp/dist/index.js
```

The package is `@pumpwire/mcp` (private, not on npm yet). Its entry point is
`packages/mcp/dist/index.js` (the package `bin` `pumpwire-mcp`). There is no `npx` install.

## 2 · Register the MCP server (≈ 1 min)

Hermes reads MCP servers from `~/.hermes/config.yaml` under `mcp_servers`. Merge
[`config.snippet.yaml`](./config.snippet.yaml) into it and fill in the absolute paths:

```yaml
mcp_servers:
  pumpwire:
    command: "node"
    args: ["/ABSOLUTE/PATH/TO/clawdpump-pwire/packages/mcp/dist/index.js"]
    env:
      PUMPWIRE_API_URL: "https://<pumpwire-api-host>"
      SOLANA_KEYPAIR_PATH: "/ABSOLUTE/PATH/TO/pumpwire-agent.json"
      PUMPWIRE_NETWORK: "devnet"
      PUMPWIRE_MAX_PRICE_USD: "0.05"
      PUMPWIRE_DAILY_CAP_USD: "1"
      PUMPWIRE_SPEND_STATE_PATH: "/ABSOLUTE/PATH/TO/.pumpwire-mcp/spend.json"
    tools:
      include: [rug_risk_score]
```

Then check it:

```bash
hermes mcp test pumpwire     # or, inside a running session: /reload-mcp
```

Notes (from the Hermes MCP docs; verify against your Hermes version):

- Hermes does **not** pass your whole shell environment to stdio servers, only the `env` you list plus a
  safe baseline. Every variable above must be in the config.
- The tool shows up to the model as `mcp_pumpwire_rug_risk_score`.
- `tools.include` limits the server to this one tool.

| Env name | Required | Meaning |
|---|---|---|
| `PUMPWIRE_API_URL` | yes | PumpWire API base URL |
| `SOLANA_KEYPAIR_PATH` | yes | path to the paying keypair; read once by the server, never logged or sent |
| `PUMPWIRE_NETWORK` | no | `devnet` (default) or `mainnet`; the client refuses offers for any other network |
| `PUMPWIRE_MAX_PRICE_USD` | no | per-call ceiling, default `0.05`; above it → `PRICE_ABOVE_CAP`, nothing signed |
| `PUMPWIRE_DAILY_CAP_USD` | no | per-UTC-day ceiling, default `5`; above it → `DAILY_CAP_REACHED`, nothing signed |
| `PUMPWIRE_SPEND_STATE_PATH` | no | where the daily spend counter lives, default `~/.pumpwire-mcp/spend.json` |
| `SOLANA_RPC_URL` | no | used for the pre-payment balance check; defaults to the public RPC for the network |

## 3 · Install the skill (≈ 1 min)

The skill tells the agent **when** to call the tool (before buying any pump.fun mint, or when asked
whether a mint is risky) and **how** to read and report the verdict.

```bash
mkdir -p ~/.hermes/skills/crypto
cp -r hermes/pumpwire-rug-risk ~/.hermes/skills/crypto/
```

Or point Hermes at this folder instead of copying (`skills.external_dirs` in `~/.hermes/config.yaml`):

```yaml
skills:
  external_dirs:
    - /ABSOLUTE/PATH/TO/clawdpump-pwire/hermes
```

Skill location and frontmatter follow the Hermes skills docs
(https://hermes-agent.nousresearch.com/docs/user-guide/features/skills); verify against your Hermes version.

## 4 · Try it

```
/pumpwire-rug-risk is <mint> risky?
```

or just ask *"rug check `<mint>` before I buy"*. Expected: one paid call, then a reply that leads with the
verdict and score, lists the top reasons with their numbers, mentions any `data_gaps`, and ends with
"This is risk information, not advice."

Raw tool output shape (from the score package's test fixture, not live data):

```json
{ "mint": "MintTarget1111111111111111111111111111111111", "score": 25, "verdict": "MED",
  "reasons": [{ "factor": "deployer_history", "points": 25,
    "detail": "3 prior launches by deployer or wallets it funded ended DEAD_1H or DEV_DUMP",
    "evidence": { "value": 3, "threshold": 1, "mints": ["Prior1111…", "Prior1211…", "Prior1311…"] } }],
  "data_gaps": [], "model_version": "v0.1.0", "as_of_slot": 300000042, "as_of_ts": 1790003600 }
```

## Spend caps and safety

- Caps are enforced in the client **before signing**: network must match `PUMPWIRE_NETWORK`, asset must be
  USDC for that network, price ≤ `PUMPWIRE_MAX_PRICE_USD`, today's spend + price ≤ `PUMPWIRE_DAILY_CAP_USD`.
- The wallet balance is checked before signing too (`INSUFFICIENT_FUNDS` otherwise).
- PumpWire's servers never see your key: the MCP server runs on your machine and signs locally.
- A corrupt spend-state file makes the server refuse to pay rather than reset the counter.
- Keep the agent's wallet small. A human tops it up; the agent never raises its own caps.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `pumpwire-mcp: PUMPWIRE_API_URL is required` in Hermes logs | the `env` block is missing or not passed; check indentation under `mcp_servers.pumpwire` |
| `ENOENT` on the keypair | use an absolute path in `SOLANA_KEYPAIR_PATH` |
| tool never called | confirm `hermes mcp test pumpwire` succeeds and the skill is listed under `/skills` |
| `{"error":"NOT_FOUND"}` | PumpWire has not indexed that mint yet; nothing was paid |
| `{"error":"WRONG_NETWORK"}` | `PUMPWIRE_NETWORK` does not match the API you point at |

More: [`docs/USE-CASES.md`](../docs/USE-CASES.md) · [`examples/`](../examples/README.md) · contract in
[`docs/INTERFACES.md`](../docs/INTERFACES.md) §4 and §6.

**This is risk information, not advice.**
