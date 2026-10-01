# PumpWire use cases

Five ways to use PumpWire, each with exact commands and the shape of what comes back. Output shapes
follow the frozen contract in [`INTERFACES.md`](./INTERFACES.md) (§4 HTTP, §6 MCP). Sample bodies below
were produced by running the real `score()` on the score package's test fixtures
(`packages/score/test/fixtures.ts`, cases S04-style and S06). They are **fixture data, not live results**,
and the addresses in them are synthetic.

> **Status today:** devnet API running on the team server, **not public yet**; mainnet cutover pending.
> The MCP server works over stdio against the devnet API. PWIRE Scout runs on devnet and only **drafts**
> alerts. Live scores currently top out around `MED` until wallet enrichment and outcome labels accumulate.
> The backtest exists but its sample is small, so no precision figures are quoted here.

Common setup for every case (Node 22):

```bash
git clone https://github.com/Josefusan/clawdpump-pwire.git && cd clawdpump-pwire
npm ci
npm run build -w @pumpwire/mcp
export PUMPWIRE_API_URL="https://<pumpwire-api-host>"   # published in the README once the API is public
```

Paying cases need a **dedicated** keypair file (`SOLANA_KEYPAIR_PATH`) holding a little USDC. Default caps:
$0.05 per call, $5 per UTC day, both checked before anything is signed.

---

## (a) Hermes agent: pre-buy check via MCP

**Who:** a Hermes (claw-agent) trader or assistant that may buy pump.fun mints.

**Setup:** follow [`hermes/README.md`](../hermes/README.md): register the `pumpwire` MCP server in
`~/.hermes/config.yaml` (`mcp_servers`) and install the `pumpwire-rug-risk` skill.

```bash
hermes mcp test pumpwire
```

**Use:** in a session,

```
/pumpwire-rug-risk I'm about to buy <mint>. Check it first.
```

**What happens:** the agent calls `mcp_pumpwire_rug_risk_score({ "mint": "<mint>" })`. The MCP server, on
your machine, receives the API's 402 offer, checks network, asset, price and daily cap, signs a $0.01 USDC
payment with your keypair, and returns the `RiskResult`. The skill makes the agent:

- lead with verdict + score, then the top reasons with their numbers;
- flag `data_gaps` (factors scored 0 for missing data are not "clean");
- **not** buy automatically on `HIGH`/`EXTREME`, and hand the decision to the human;
- end with "This is risk information, not advice."

**Tool result shape** (`structuredContent`; a `text` item carries the same JSON):

```json
{
  "mint": "MintTarget1111111111111111111111111111111111",
  "score": 25,
  "verdict": "MED",
  "reasons": [
    { "factor": "deployer_history", "points": 25,
      "detail": "3 prior launches by deployer or wallets it funded ended DEAD_1H or DEV_DUMP",
      "evidence": { "value": 3, "threshold": 1,
        "mints": ["Prior111111111111111111111111111111111111111", "Prior121111111111111111111111111111111111111", "Prior131111111111111111111111111111111111111"] } }
  ],
  "data_gaps": [],
  "model_version": "v0.1.0",
  "as_of_slot": 300000042,
  "as_of_ts": 1790003600
}
```

**Errors** come back as `isError: true` with text `{"error": CODE}`, where CODE is one of
`INVALID_MINT | NOT_FOUND | PRICE_ABOVE_CAP | DAILY_CAP_REACHED | WRONG_NETWORK | WRONG_ASSET | INSUFFICIENT_FUNDS | UPSTREAM`.
Nothing is signed for any of the policy errors.

---

## (b) Claude Code / Claude Desktop: MCP config + sample prompt

The same stdio server works in any MCP client. There is **no npm package to `npx`**: `@pumpwire/mcp` is
private and unpublished, so point the client at the built entry point in your clone.

**Claude Desktop**: add to `claude_desktop_config.json` (on macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`), then restart the app:

```json
{
  "mcpServers": {
    "pumpwire": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/clawdpump-pwire/packages/mcp/dist/index.js"],
      "env": {
        "PUMPWIRE_API_URL": "https://<pumpwire-api-host>",
        "SOLANA_KEYPAIR_PATH": "/ABSOLUTE/PATH/TO/pumpwire-agent.json",
        "PUMPWIRE_NETWORK": "devnet",
        "PUMPWIRE_MAX_PRICE_USD": "0.05",
        "PUMPWIRE_DAILY_CAP_USD": "1"
      }
    }
  }
}
```

**Claude Code**: put the same `mcpServers` object in a project-level `.mcp.json`, or register it from the
CLI (flag syntax: verify with `claude mcp add --help` on your version):

```bash
claude mcp add pumpwire \
  -e PUMPWIRE_API_URL="https://<pumpwire-api-host>" \
  -e SOLANA_KEYPAIR_PATH="/ABSOLUTE/PATH/TO/pumpwire-agent.json" \
  -e PUMPWIRE_NETWORK=devnet \
  -- node /ABSOLUTE/PATH/TO/clawdpump-pwire/packages/mcp/dist/index.js
```

**Sample prompt:**

> Use the pumpwire `rug_risk_score` tool on `<mint>`. Tell me the verdict, the top three reasons with
> their numbers, and any data gaps. Refer to wallets by short address only.

**Without a chat client**, the same server can be driven from a script (it lists tools; with `--pay` it
calls the tool):

```bash
SOLANA_KEYPAIR_PATH=/ABSOLUTE/PATH/TO/pumpwire-agent.json node examples/mcp-call.mjs
# tools: rug_risk_score
# dry run: no tool called, nothing paid. Pass <mint> --pay to call rug_risk_score.

SOLANA_KEYPAIR_PATH=/ABSOLUTE/PATH/TO/pumpwire-agent.json node examples/mcp-call.mjs <mint> --pay
# verdict <LOW|MED|HIGH|EXTREME> · score <0-100>/100 · model v0.1.0 · as_of_slot <slot>
#   +<points> <factor>: <detail>
#   data gaps (scored 0, not "safe"): <factors>          (only when non-empty)
```

---

## (c) Raw HTTP x402 flow from any language

No MCP needed. Any HTTP client that can sign a Solana transaction can buy a score.

**Step 1: ask.** `GET /v1/risk/:mint` without payment. Checks happen in this order and the first three are
free: bad mint → `400 INVALID_MINT`; unknown mint → `404 NOT_FOUND`; too many requests → `429 RATE_LIMITED`.
A known mint answers **402** with an x402 V2 `PaymentRequired` body (also base64-encoded in the
`PAYMENT-REQUIRED` header):

```jsonc
{
  "x402Version": 2,
  "error": "PAYMENT_REQUIRED",
  "resource": { "url": "https://<host>/v1/risk/<mint>", "description": "…", "mimeType": "application/json" },
  "accepts": [{
    "scheme": "exact",
    "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",   // devnet; mainnet is solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
    "amount": "10000",                                     // $0.01 in USDC base units (6 decimals)
    "asset": "<USDC mint for the network>",
    "payTo": "<PumpWire payee>",
    "maxTimeoutSeconds": 60,
    "extra": { "feePayer": "<facilitator fee payer>", "memo": "<binds the payment to this tool + mint>" }
  }]
}
```

**Step 2: pay.** Build and sign the `exact` SVM payment for that offer and resend the request with the
`PAYMENT-SIGNATURE` header (the server also accepts V1 `X-PAYMENT`). Check `network`, `asset` and `amount`
yourself before signing. The x402 libraries do the encoding; don't hand-roll it.

**Step 3: read.** `200` with the `RiskResult` body (shape in (a)) and a `PAYMENT-RESPONSE` header carrying
the settlement (`success`, `network`, `transaction` = the Solana signature you can look up on Solscan).
Replaying the same payment for the same mint re-serves the same result; using it for a different mint is
`402 PAYMENT_REPLAYED`.

**Runnable:** [`examples/x402-fetch.mjs`](../examples/x402-fetch.mjs) uses `@x402/fetch` + `@x402/svm` from
the workspace (no new dependencies):

```bash
node examples/x402-fetch.mjs <mint>                    # step 1 only: prints the 402 offer, signs nothing
SOLANA_KEYPAIR_PATH=/ABSOLUTE/PATH/TO/pumpwire-agent.json PUMPWIRE_NETWORK=devnet \
  node examples/x402-fetch.mjs <mint> --pay            # steps 1-3, $0.01 USDC
```

Output shape:

```text
step 1  GET https://<host>/v1/risk/<mint> -> 402
{ "x402Version": 2, "error": "PAYMENT_REQUIRED", "accepts": [ { "scheme": "exact", "network": "...", "amount": "10000", ... } ] }
step 2  paying from wallet AbCd…WxYz
step 3  -> 200
{ "settlement": { "success": true, "network": "solana:...", "transaction": "<signature>" } }
{ "mint": "...", "score": ..., "verdict": "...", "reasons": [...], "data_gaps": [...], "model_version": "v0.1.0", ... }
```

If the offer is above `PUMPWIRE_MAX_PRICE_USD` (default 0.05), on the wrong network, or not USDC, it stops
with `refusing to pay: …` and nothing is signed.

---

## (d) PWIRE Scout: first-party volume and alert drafts

**What it is:** PumpWire's own buyer agent ([`packages/scout`](../packages/scout/README.md)). It watches new
launches, picks ones with ≥ 5 distinct non-deployer buyers in their first 120 s (and younger than 15 min),
pays for a `rug_risk_score` through the same capped MCP client as everyone else, and writes an alert
**draft** for `HIGH` / `EXTREME`. It never trades and never posts.

**Where it runs:** on devnet, on the team server, under pm2:

```bash
npm run build -w @pumpwire/scout
pm2 start ecosystem.devnet.config.cjs --only pumpwire-scout-devnet
```

Caps are clamped in code to ≤ $0.05 per call and ≤ $5 per UTC day; env can only lower them.

**Where alerts land:** `~/pumpwire-data/alerts/<mint>.md` (override: `SCOUT_ALERTS_DIR`), one file per mint.
A human reads it, edits the suggested post, and decides whether to post. **Nothing is posted by code.**
An alert rendered from fixture S06 (real `alertMarkdown()` output; evidence lines shortened here):

```markdown
# DRAFT alert — NOT posted. A human reviews and decides (clawrena-compliance: humans approve posts).

- mint: `MintTarget1111111111111111111111111111111111`
- verdict: **HIGH** · score 60/100 · model v0.1.0
- as_of_slot: 300000042 · scored_at: 2026-09-21T15:13:20.000Z · first_party: true (PumpWire Scout paid for this call)
- solscan: https://solscan.io/token/MintTarget1111111111111111111111111111111111?cluster=devnet

## Reasons (public onchain evidence; wallets, never people)
- deployer_history (+25): 3 prior launches by deployer or wallets it funded ended DEAD_1H or DEV_DUMP
  evidence: `{"value":3,"threshold":1,"mints":["Prior1111…","Prior1211…","Prior1311…"]}`
- bundled_launch (+20): 5 early-window buyers share funder Bund1111, buying in slots 300000000..300000002
  evidence: `{"value":5,"threshold":3,"wallets":[…5 wallets…],"slots":[300000000,300000001,300000002],"sigs":[…]}`
- holder_concentration (+15): top 10 holders control 42% of supply
  evidence: `{"value":42,"threshold":15,"wallets":[…10 wallets…]}`

## Suggested post (≤ 280 chars, edit before posting)

PumpWire flagged Mint…1111 as HIGH risk shortly after launch: 3 prior launches by deployer or wallets it funded ended DEAD_1H or DEV_DUMP. Risk signal, not advice. https://solscan.io/token/…?cluster=devnet
```

**Why it matters for volume:** every Scout call is a real x402 payment on Solana, but it is **self-funded**,
so it is labelled **first-party** everywhere (see (e)) and never presented as third-party demand.

Evidence of a run on the server: the pm2 log `~/.pm2/logs/pumpwire-scout-devnet-out.log` (one JSON line per
scored launch) and

```bash
sqlite3 -readonly ~/pumpwire-data/pumpwire.db "select count(*) from calls where first_party=1 and status='served'"
```

---

## (e) Integrator dashboard proof: `/v1/stats` and `/live`

Both are free: no wallet, no payment.

- **`GET /live`**: the public HTML dashboard (counters, recent paid calls with Solscan links, flagged
  mints). It reads `/v1/stats` in the browser.
- **`GET /v1/stats`**: the same data as JSON.

```bash
node examples/stats.mjs          # summary
node examples/stats.mjs --json   # raw StatsResponse
```

Summary output shape:

```text
network solana:<genesis> · model v0.1.0 · generated_at <ISO time>
paid calls: <n> total = <n> first-party + <n> third-party + <n> unattributed
USDC paid: <decimal> · unique payers: <n> · integrators (distinct third-party payer wallets): <n>
last calls (newest first):
  <ISO time>  first-party   rug_risk_score  mint AbCd…WxYz  MED  payer AbCd…WxYz  tx AbCd…WxYz
```

`StatsResponse.totals` (INTERFACES §4.3):

```ts
{ paid_calls, paid_calls_first_party, paid_calls_third_party, paid_calls_unattributed,
  usdc_paid, ansem_paid,            // decimal strings, UI units
  unique_payers, unique_integrators }
```

**What first-party vs third-party means:**

| Label | Rule | Example |
|---|---|---|
| `first-party` | the paying wallet is PumpWire's own (in the API's `FIRST_PARTY_WALLETS` allowlist, or the payee itself) | PWIRE Scout, team demos |
| `third-party` | any other paying wallet | an outside Hermes agent or script using this repo |
| `unattributed` | the facilitator returned no payer; never counted as third-party | rare |

Only calls that were served **and** have a settlement signature count toward totals. `unique_integrators`
counts distinct third-party paying wallets. A wallet is not proof of a distinct builder, so read it as an
upper bound on builders onboarded. First-party and third-party are always reported separately; PumpWire
does not mix its own spend into third-party numbers.

---

**This is risk information, not advice.** Scores describe signals in public onchain data about wallets
and launches. They are not findings about any person.
