# PumpWire ($PWIRE): AnsemHack Clawrena submission

Track: **ClawPump x pump.fun** (also entered for Overall Winner). Entry post on X: https://x.com/Josefusan111/status/2105017820816019781 (tags @clawpumptech).
Token: $PWIRE, launched on ClawPump. Mint: `{{PWIRE_MINT}}`.
Repo: https://github.com/Josefusan/clawdpump-pwire. Every number below names the command and the UTC time it was run.

## 1. What it is

PumpWire is a Solana agent that does the homework trading bots skip. It indexes every pump.fun launch and
trade, scores each mint for rug risk with a deterministic, explainable model, and sells that score to
other agents as a paid MCP tool. The buyers are agents: a Hermes (claw-agent) or any MCP client calls
`rug_risk_score`, the x402 client on the caller's machine signs a $0.01 USDC payment from the caller's own
wallet, and the API answers only after the payment settles onchain. No signup, no API keys, no invoices.
Every call is risk information, not advice.

## 2. Why it is novel on the Hermes harness

- **A paid tool a Hermes agent can install in 5 minutes.** `hermes/` ships an MCP server registration
  plus a `pumpwire-rug-risk` skill. The skill makes the agent check a mint before it buys, lead with the
  verdict and the evidence, flag data gaps, and hand `HIGH`/`EXTREME` decisions to the human.
- **Agent-to-agent commerce settled onchain.** The caller pays per call over x402 (`exact` scheme on
  Solana, USDC). PumpWire's API holds no private key; the MCP client signs locally with hard caps
  (per call and per UTC day) checked before anything is signed.
- **Trades decoded straight from pump.fun program logs.** Ingest subscribes to the pump.fun program with
  `logsSubscribe` and decodes creates, trades and migrations from `Program data:` lines. No paid data
  feed, one subscription, exact slots.
- **Explainable by construction.** The scorer is a pure function (`score(snapshot)`): same input, byte-
  identical output. Every point comes with a factor name, a raw number, a threshold and the wallets or
  mints involved. Token metadata never reaches the output (unit test S18).

## 3. Proof a judge can open

All figures are devnet. Commands were run read-only against the team server on 2026-10-01.

| Item | Value | Source and UTC time |
|---|---|---|
| Tokens indexed | 11,748 | `select count(*) from tokens` on `pumpwire.db`, 19:04:11Z |
| Trades decoded from program logs | 88,144 | `select count(*) from trades`, 19:04:11Z |
| Settled paid calls (served, with tx signature) | 68 | `select count(*),sum(first_party) from calls where status="served" and tx_sig is not null`, 19:04:11Z |
| First-party vs third-party | 68 first-party, 0 third-party | same query (sum = 68); `/v1/stats` 19:04:09Z: `paid_calls_first_party` 67, `paid_calls_third_party` 0, `paid_calls_unattributed` 0 |
| USDC paid over x402 | 0.670000 USDC for 67 calls | `GET /v1/stats` `totals.usdc_paid`, 19:04:09Z |
| Unique payers / integrators | 1 / 0 | `GET /v1/stats`, 19:04:09Z |
| Network | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet) | `GET /v1/stats`, 19:04:09Z |
| Devnet tx 1 | https://solscan.io/tx/5kA5iDWoXiTb4ynKimxGyWXeh8ctA6648WMq3ycJhhhMApqCiDTyXAh5sdPihg7GGNA1qu9dwD7QNMdqj9jL4GJb?cluster=devnet | `select tx_sig from calls ... order by id limit 3`, 19:04:11Z |
| Devnet tx 2 | https://solscan.io/tx/4STJRyjAEzcpSzRVpGByVPwytQckckg1dqmj6F7R41VRqtLdZmgQDLkSgMUMTkNx4DYvd2AnxBtEBw4EaUokdhEY?cluster=devnet | same |
| Devnet tx 3 | https://solscan.io/tx/4AeBSpFWcCBn5SMDtW8zMHrJ4gMrsSSDfxBnV3eyeMnDp1etfS5y5XK43nXtKXzkaNiHR5vJ2UJkC149R4LEonqq?cluster=devnet | same |
| Public dashboard | `{{LIVE_URL}}/live` | not yet assigned |
| Stats JSON | `{{LIVE_URL}}/v1/stats` | not yet assigned |

The 67 vs 68 gap is two seconds of Scout activity: `/v1/stats` was read at 19:04:09Z, the database at
19:04:11Z, and one more call settled in between.

Each Solscan link should show a successful transaction with a 0.01 USDC transfer (devnet USDC mint
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) from PumpWire's Scout wallet `DtGk…p5Mf` to the payee.

### Mainnet

`{{MAINNET_TXS}}`

Mainnet is not live yet. When it is, this section lists the first paid mainnet calls as
`https://solscan.io/tx/<sig>` links, with the counts from `/v1/stats` and the UTC time they were read.

## 4. Try it in 5 minutes

- **Hermes / claw-agent:** [hermes/README.md](../hermes/README.md). Register the MCP server, copy the
  skill, then ask `rug check <mint> before I buy`.
- **Claude Code, Claude Desktop, Cursor, or raw HTTP:** [docs/USE-CASES.md](./USE-CASES.md). Five
  walkthroughs with the exact response shapes.
- **Scripts, no chat client:** [examples/](../examples/README.md). `x402-fetch.mjs <mint>` prints the
  402 offer and signs nothing; `--pay` completes the call. `stats.mjs` reads the free counters.
- The API URL is `{{LIVE_URL}}` once assigned. Until then the devnet API runs on the team server only.

Nothing is paid without `--pay` or an explicit tool call, and never above the caps you set.

## 5. Architecture in 6 lines

1. **Ingest:** Solana `logsSubscribe` on the pump.fun program; creates, trades, migrations decoded from program logs; wallet age and funding sources enriched via Helius.
2. **Store:** SQLite in WAL mode: `tokens`, `trades`, `wallets`, `deployers`, `funding_edges`, `calls`.
3. **Score:** pure `score(snapshot)` with 8 weighted factors (deployer history 25, bundled launch 20, holder concentration 15, dev position 10, fresh wallets 10, funding cluster 10, curve velocity 5, metadata flags 5). Verdicts: 0-24 LOW, 25-49 MED, 50-74 HIGH, 75-100 EXTREME.
4. **API:** Express + the `@x402/core` facilitator client (`HTTPFacilitatorClient`). `GET /v1/risk/:mint` answers 402 with the offer, then 200 after settlement. Free: `/health`, `/v1/stats`, `/live`.
5. **Clients:** `@pumpwire/mcp` (stdio MCP server, pays with the caller's wallet), PWIRE Scout (our own buyer), raw HTTP from any language.
6. **Proof:** every served call is logged with its settlement signature and labelled first-party or third-party; `/live` renders that log.

## 6. Honest status and limits

- **Devnet today, mainnet pending.** The cutover script and runbook exist; the public URL and mainnet
  payee are not yet live.
- **Scores are mostly LOW/MED right now.** Deployer history and outcome labels need time to accumulate,
  and wallet enrichment is still filling in. Factors with missing data score 0 and are listed in
  `data_gaps`; a 0 for a gap is not a clean bill.
- **All current paid calls are first-party.** They come from our own Scout wallet and are labelled as
  such everywhere. Third-party count is 0. We do not mix the two.
- **No accuracy figure yet.** A backtest harness exists, but the labelled sample is small, so `/v1/stats`
  reports `backtest: null` until the sample is meaningful.
- **Planned, not live:** $ANSEM as a payment asset, a $PWIRE holder tier, `deployer_history` and
  `early_buyer_map` tools, deployer alerts.
- **`@pumpwire/mcp` is not on npm.** Clone, build, and point your MCP client at `packages/mcp/dist/index.js`.

## 7. Compliance

- **First-party disclosure.** Self-funded calls are real x402 payments but are reported separately from
  third-party calls on `/live`, in `/v1/stats`, and in this document.
- **No trading of $PWIRE by us or our agents.** No coordinated buys, no bots on our own token.
- **Humans approve money and posts.** Agents sign only within hard caps; Scout drafts alerts and never
  posts; a human reviews every post.
- **No investment language.** $PWIRE is intended as an access tier (planned, not live) — not a promise. Nothing here is a forecast.
- **Public data only; wallets, never people.** Reasons cite wallet addresses in short form (`7xQ…9f`)
  and public signatures. No doxxing, no accusations against any person.
- **Risk information, not advice.** A score describes signals in public onchain data about wallets and
  launches. It is not a finding about a person and not a reason to buy or sell anything.
