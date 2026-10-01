# PumpWire — Interfaces (frozen contract, T-002)

Owner: Claude Architect. Status: **FROZEN for the 24h build**. Changes require an ADR and a
`model_version` / contract bump. Sources: `01-PWIRE-Product-Spec.md` (§What PumpWire sells,
§Architecture, §Rug-risk scoring v0, §Data model), `03-Agent-Org-Setup.md` (§Repo layout, §Gates),
skills `pumpwire-*`, `clawrena-compliance`. Decisions: D-001 (data/secrets paths), ADR-001, ADR-002.
Items marked **VERIFY** are unconfirmed and must be checked against live docs before use.
Items marked **STRETCH** are not part of the paid loop and may be cut.

---

## 1. Package boundaries

Paid loop: `ingest → SQLite → score → api (x402) → mcp → live`. `scout` is a consumer.

| Package | Responsibility | May import | Reads | Writes | Must NOT |
|---|---|---|---|---|---|
| `packages/score` | Pure `score(snapshot) → RiskResult`; `buildSnapshot(db, mint)`; **owns all shared TS types (§2)** | nothing at runtime except `better-sqlite3` in `buildSnapshot` | SQLite (read-only) | nothing | network I/O, clocks inside `score()` (time comes in the snapshot), randomness |
| `packages/ingest` | PumpPortal WS + Helius enrich → SQLite; deployer stats + token `outcome` job; applies `docs/schema.sql` | `@pumpwire/score` (types only) | WS, RPC | `tokens, trades, wallets, deployers, funding_edges` | write `calls`; execute/evaluate metadata strings |
| `packages/api` | Express + x402 middleware; free + paid routes; payment verification (ADR-002); `calls` log | `@pumpwire/score` | SQLite, facilitator, RPC | `calls` only | hold any private key; write ingest tables |
| `packages/mcp` | npm `pumpwire-mcp`: MCP server (stdio + streamable HTTP) wrapping the paid API; pays with the **caller's** wallet | HTTP only; vendors the `RiskResult` JSON Schema (§6) | PumpWire API | nothing | touch SQLite; send keys anywhere; pay above caps |
| `packages/live` | Static `/live` page (HTML/JS) served by `api`; polls `GET /v1/stats` | HTTP only | `/v1/stats` | nothing | render metadata strings as HTML (use `textContent`) |
| `packages/scout` | PWIRE Scout: watches launches, calls `rug_risk_score` via `pumpwire-mcp`/HTTP, **drafts** alerts | HTTP / `pumpwire-mcp` | API | local drafts only | post without Mises approval; exceed $0.05/call, $5/day |

Rules: only `ingest` and `api` open the DB for writing, each on its own tables. `score()` must be
deterministic: same snapshot → byte-identical `RiskResult`. Note 03 §Repo layout puts scout under
`agents/scout`; this card places its code in `packages/scout` (Hermes config stays in `agents/`).

## 2. TypeScript types (exported from `@pumpwire/score`)

Conventions: addresses/mints/signatures are base58 `string`; all times are **unix seconds**
(`number`, integer); SOL amounts are **lamports** (`number`, integer); token amounts are **raw base
units** (`number`, integer; pump.fun supply fits in 2^53 — VERIFY supply/decimals). `null` means
"known to be unknown"; `?` optional fields are only used where absence is semantically different.

```ts
export type Base58 = string;          // 32–44 chars, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, decodes to 32 bytes (addresses)
export type TxSig = string;           // base58, 64-byte signature (87–88 chars)
export type UnixSec = number;
export type Verdict = 'LOW' | 'MED' | 'HIGH' | 'EXTREME';
export type Outcome = 'DEAD_1H' | 'DEV_DUMP' | 'SURVIVED_24H';
export type Factor =
  | 'deployer_history' | 'bundled_launch' | 'holder_concentration' | 'dev_position'
  | 'fresh_wallets' | 'funding_cluster' | 'curve_velocity' | 'metadata_flags';
export type Tool = 'rug_risk_score' | 'deployer_history' | 'early_buyer_map' | 'deployer_alerts';

export interface Token {
  mint: Base58;
  name: string | null;        // ATTACKER-CONTROLLED (§8)
  symbol: string | null;      // ATTACKER-CONTROLLED
  uri: string | null;         // ATTACKER-CONTROLLED; never fetched by api/score
  deployer: Base58;
  created_slot: number;
  created_at: UnixSec;
  curve_pct: number | null;   // 0..100 bonding-curve progress at last update
  migrated: boolean;
  has_socials: boolean | null;       // null = metadata not inspected
  outcome: Outcome | null;           // set by ingest stats job; null = not yet labelled
  outcome_at: UnixSec | null;
}

export interface Trade {
  sig: TxSig;
  mint: Base58;
  wallet: Base58;
  side: 'buy' | 'sell';
  lamports: number;           // SOL leg (01 §Data model calls this `sol`)
  token_amount: number;       // raw base units (01 §Data model calls this `tokens`)
  slot: number;
  ts: UnixSec;
}

export interface Wallet {
  address: Base58;
  first_seen_ts: UnixSec | null;  // earliest tx time; null = not enriched yet
  tx_count: number | null;        // signatures observed at enrich time
  funder: Base58 | null;          // sender of the first inbound SOL transfer
  funder_ts: UnixSec | null;
  enriched_at: UnixSec | null;
}

export interface FundingEdge {
  src: Base58;
  dst: Base58;
  lamports: number;
  ts: UnixSec;
  sig: TxSig;
}

export interface Evidence {
  value: number;              // REQUIRED: the raw number the points were computed from
  threshold?: number;         // the band edge that was crossed, if any
  wallets?: Base58[];         // ≤ 10 entries
  slots?: number[];           // ≤ 10 entries
  sigs?: TxSig[];             // ≤ 10 entries
  mints?: Base58[];           // ≤ 10 entries (e.g. prior rugged mints, copied mint)
}

export interface Reason {
  factor: Factor;
  points: number;             // integer, 1..max(factor)
  detail: string;             // server template; numbers + base58 only, NEVER metadata text (§8)
  evidence: Evidence;
}

export interface RiskResult {
  mint: Base58;
  score: number;              // integer 0..100
  verdict: Verdict;
  reasons: Reason[];          // 0..5, points > 0, sorted (§5.3)
  data_gaps: Factor[];        // factors scored 0 because inputs were insufficient
  model_version: string;      // "v0.1.0"
  as_of_slot: number;
  as_of_ts: UnixSec;
}

export type CallStatus = 'pending' | 'served' | 'failed';
export interface CallRecord {
  id: number;
  ts: UnixSec;
  tool: Tool;
  arg: string;                // validated base58 mint/wallet only
  payer: Base58 | null;       // null only while pending before verify returns payer
  network: string;            // CAIP-2
  asset: Base58;              // SPL mint paid in
  amount: number;             // raw base units
  payment_id: string;         // replay key (ADR-002): sha256 hex of payment payload tx, or "direct:<sig>"
  tx_sig: TxSig | null;       // settled signature; UNIQUE when present
  settle_via: 'facilitator' | 'direct';
  status: CallStatus;
  score: number | null;
  verdict: Verdict | null;
  result_json: string | null; // serialized RiskResult, for idempotent re-serve
  latency_ms: number | null;
  first_party: boolean;       // payer ∈ FIRST_PARTY_WALLETS
  onchain_confirmed: boolean; // tx_sig re-checked via our own RPC
}

export interface ScoreSnapshot {           // input to score(); built by buildSnapshot()
  token: Token;
  trades: Trade[];                         // all trades for mint up to as_of, sorted (slot, sig)
  wallets: Record<Base58, Wallet>;         // first 30 buyers + early-window buyers
  deployer_prior: { mint: Base58; outcome: Outcome | null; created_at: UnixSec }[]; // deployer + wallets it funded
  trending_symbols: { mint: Base58; symbol_norm: string }[]; // top 20 by trades, last 24h, excl. this mint
  total_supply: number;                    // raw base units
  as_of_slot: number;
  as_of_ts: UnixSec;
}
```

## 3. Environment variable NAMES (values live in `~/.config/pumpwire/*.env`, D-001)

| Service | Names |
|---|---|
| ingest | `PUMPWIRE_DB_PATH`, `PUMPPORTAL_WS_URL`, `SOLANA_RPC_URL`, `SOLANA_WS_URL` (mainnet WS for pump.fun program logs; optional: defaults to Helius mainnet via `HELIUS_API_KEY`, else the public mainnet endpoint), `INGEST_TRADE_SOURCE` (`logs` default; `pumpportal` needs a funded PumpPortal key), `HELIUS_API_KEY`, `INGEST_TRADE_WINDOW_MIN`, `INGEST_MAX_TRACKED` (default 500, min 1; LRU-evicts tracked mints at the cap), `ENRICH_RPS` |
| score | none (pure) |
| api | `PORT`, `PUMPWIRE_DB_PATH`, `X402_NETWORK` (CAIP-2), `X402_FACILITATOR_URL`, `PAYTO_ADDRESS`, `USDC_MINT`, `SOLANA_RPC_URL`, `FIRST_PARTY_WALLETS` (comma-separated), `X402_DIRECT_FALLBACK` (`0`/`1`), `X402_MAX_TIMEOUT_S`, `RATE_LIMIT_PER_MIN`; STRETCH: `ANSEM_MINT`, `PWIRE_MINT`, `PWIRE_TIER_MIN_BALANCE`, `JUPITER_QUOTE_URL` |
| mcp | `PUMPWIRE_API_URL`, `SOLANA_KEYPAIR_PATH`, `SOLANA_RPC_URL`, `PUMPWIRE_SPEND_STATE_PATH`, `PUMPWIRE_NETWORK`, `PUMPWIRE_MAX_PRICE_USD` (default 0.05), `PUMPWIRE_DAILY_CAP_USD` (default 5), `PUMPWIRE_PAY_ASSET` (`USDC`\|`ANSEM`) |
| live | none (same origin as api) |
| scout | `PUMPWIRE_API_URL`, `SCOUT_KEYPAIR_PATH`, `SCOUT_MAX_PRICE_USD` (≤ 0.05), `SCOUT_DAILY_CAP_USD` (≤ 5), `SCOUT_MIN_VERDICT` |

Never log values of `HELIUS_API_KEY`, `SOLANA_RPC_URL` (may embed a key), or any `*_KEYPAIR_PATH` contents.

## 4. HTTP contract (`packages/api`)

All JSON responses: `Content-Type: application/json; charset=utf-8`. Errors: `{ "error": code, "message": string }`
with `code ∈ INVALID_MINT | NOT_FOUND | PAYMENT_REQUIRED | PAYMENT_INVALID | PAYMENT_REPLAYED | RATE_LIMITED | UPSTREAM | INTERNAL`.

### 4.1 `GET /health` (free)
`200 { ok: true, db: "ok", network: string, model_version: string, last_trade_ts: UnixSec|null, ingest_lag_s: number|null }`;
`503` same shape with `ok: false` if DB unreadable or `ingest_lag_s > 60`.

### 4.2 `GET /live` (free) — HTML from `packages/live`; no server-side templating of DB strings.

### 4.3 `GET /v1/stats` (free)
```ts
interface StatsResponse {
  model_version: string; network: string; generated_at: UnixSec;
  totals: {
    paid_calls: number; paid_calls_first_party: number; paid_calls_third_party: number; paid_calls_unattributed: number; // null payer → unattributed, never third-party
    usdc_paid: string; ansem_paid: string;      // decimal strings, UI units
    unique_payers: number; unique_integrators: number;  // integrators = distinct third-party payers
  };
  last_calls: { ts: UnixSec; tool: Tool; arg: Base58; score: number|null; verdict: Verdict|null;
                tx_sig: TxSig; payer: Base58; asset: Base58; first_party: boolean; party: 'first-party'|'third-party'|'unattributed'; latency_ms: number }[]; // ≤ 50, newest first
  caught: { mint: Base58; verdict: Verdict; scored_at: UnixSec; outcome: Outcome; outcome_at: UnixSec }[]; // ≤ 50
  backtest: { model_version: string; n: number; precision_high_plus: number; recall_high_plus: number } | null;
}
```
Totals count only `status='served' AND tx_sig IS NOT NULL`. First-party and third-party are always reported separately (clawrena-compliance).

### 4.4 `GET /v1/risk/:mint` (paid, $0.01 USDC)
Order of checks — **never charge for a request we cannot serve**:
1. `:mint` fails §2 `Base58` validation → `400 INVALID_MINT` (free).
2. Mint not in `tokens` → `404 NOT_FOUND` (free).
3. Rate limit (per IP, `RATE_LIMIT_PER_MIN`, default 60) → `429 RATE_LIMITED`.
4. No payment header → **402** (below). Invalid payment → `402 PAYMENT_INVALID`; replay → `402 PAYMENT_REPLAYED`.
5. Valid payment → score → settle → `200` body = `RiskResult` (§2), plus the x402 settlement response header.

**402 body — x402 V2 `PaymentRequired`** (shape per x402 V2; field names **VERIFY** against `@x402/core`):
```jsonc
{
  "x402Version": 2,
  "error": "PAYMENT_REQUIRED",
  "resource": { "url": "https://<host>/v1/risk/<mint>", "description": "PumpWire rug-risk score for a pump.fun mint", "mimeType": "application/json" },
  "accepts": [{
    "scheme": "exact",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",   // X402_NETWORK; devnet solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 — both CAIP-2 IDs VERIFY
    "amount": "10000",                                    // $0.01 in USDC base units (6 decimals — VERIFY)
    "asset": "<USDC_MINT>",
    "payTo": "<PAYTO_ADDRESS>",                           // owner wallet; funds land in its USDC ATA
    "maxTimeoutSeconds": 60,                              // X402_MAX_TIMEOUT_S
    "extra": { "feePayer": "<facilitator fee payer>" }    // VERIFY: supplied by facilitator /supported
  }]
  // STRETCH: second accepts[] entry in $ANSEM at 90% of USD value; $PWIRE tier at 50% (01 §What PumpWire sells)
}
```
Header names (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` in V2 vs `X-PAYMENT` /
`X-PAYMENT-RESPONSE` in V1) are produced by `@x402/express`; builders use the library's constants — **VERIFY**.
Direct-transfer fallback (ADR-002): request header `X-PUMPWIRE-TX: <TxSig>`; advertised only when `X402_DIRECT_FALLBACK=1`.
The fallback tx MUST include a Memo instruction `pumpwire:<tool>:<arg>` (here `pumpwire:rug_risk_score:<mint>`);
the server rejects (`402 PAYMENT_INVALID`) any tx whose memo does not byte-equal the current request's tool and arg.

**200 body example**
```json
{ "mint": "…pump", "score": 62, "verdict": "HIGH",
  "reasons": [{ "factor": "bundled_launch", "points": 20, "detail": "5 wallets sharing funder 7xQ…9f bought in slots 301..303",
                "evidence": { "value": 5, "threshold": 3, "wallets": ["…"], "slots": [301, 302], "sigs": ["…"] } }],
  "data_gaps": ["fresh_wallets"], "model_version": "v0.1.0", "as_of_slot": 305, "as_of_ts": 1790000000 }
```

MVP+/STRETCH routes (same pattern, not frozen yet): `GET /v1/deployer/:wallet` ($0.02), `GET /v1/early-buyers/:mint` ($0.05), `POST /v1/tier` ($PWIRE tier).

## 5. Rug-risk scoring v0 (`model_version = "v0.1.0"`)

Implements 01 §Rug-risk scoring v0 with exact formulas. All points are integers
Thresholds are v0 priors; recalibrate only via backtest + ADR + version bump.
Rounding: every `round(n/d)` is done on integers before any float division — `round(n/d) = floor((2n + d) / (2d))`
for integer n ≥ 0, d > 0 (half up). Percentages enter as integer basis points (`bp = floor(10000·a/b)`), e.g.
holder_concentration points = `round(15·(bp − 1500) / 2000)`.

### 5.1 Definitions
- `early window` = trades with `slot ∈ [created_slot, created_slot + 2]`.
- `first 30 buyers` = first 30 distinct `wallet`s with a `buy`, ordered by `(slot, sig)`, excluding the deployer.
- `balance(w)` = Σ buy `token_amount` − Σ sell `token_amount` over trades (floored at 0). The curve account never appears as a trader, so it is excluded by construction.
- `enriched(w)` = `wallets[w].enriched_at != null`.

### 5.2 Factors
| # | factor | max | raw value `v` | points | data gap when |
|---|---|---|---|---|---|
| 1 | `deployer_history` | 25 | count of `deployer_prior` with `outcome ∈ {DEAD_1H, DEV_DUMP}` | v=0→0, 1→10, 2→18, ≥3→25 | never (0 prior = 0 pts) |
| 2 | `bundled_launch` | 20 | size of the largest group of early-window buyers (excl. deployer) sharing a non-null `funder` (funder = deployer counts) | v<3→0, else `min(20, 4·v)` | < 3 early buyers enriched |
| 3 | `holder_concentration` | 15 | top-10 `balance` sum / `total_supply` × 100 | v≤15→0, v≥35→15, else `round(15·(v−15)/20)` | no trades, or `total_supply ≤ 0` (guard: 0 pts, never divide) |
| 4 | `dev_position` | 10 | `hold% = balance(deployer)/supply·100`; `sold% = dev sells/dev buys·100` (0 if no buys) | 10 if hold% > 10 or sold% > 50, else 0; `v` = whichever triggered (sold% first) | never |
| 5 | `fresh_wallets` | 10 | `r` = fresh / enriched among first 30; fresh = `buy_ts − first_seen_ts < 86400` and `tx_count < 3` | r≤0.2→0, r≥0.7→10, else `round(10·(r−0.2)/0.5)`; `v = round(100·r)` | < 5 enriched |
| 6 | `funding_cluster` | 10 | largest group of first-30 buyers sharing `funder` with `first_buy_ts − funder_ts ≤ 21600` | v<3→0, else `min(10, 2·v)` | < 5 enriched |
| 7 | `curve_velocity` | 5 | `curve_pct / unique_buyers` (pct points per buyer) | v≥2.0→5, v≥1.0→3, else 0 | `curve_pct` null or 0 buyers |
| 8 | `metadata_flags` | 5 | flag count | copies trending symbol (normalized: NFKC, lowercase, strip non-alnum; equal to a `trending_symbols` entry) → 3; `has_socials = false` → 2; image-hash reuse → 2 (STRETCH); sum capped at 5 | `has_socials` null and symbol null |

`score = min(100, Σ points)` (max Σ = 100). Verdict: 0–24 LOW · 25–49 MED · 50–74 HIGH · 75–100 EXTREME.

### 5.3 Output rules
- `reasons` = factors with `points > 0`, sorted by `points` desc then table order (#1..#8); keep top 5.
- Every reason has `evidence.value` = raw `v`; `detail` from a fixed template per factor, e.g. `"3 prior launches by deployer ended DEAD_1H or DEV_DUMP"`. Addresses shortened as `abcd…wxyz` in `detail`, full in `evidence`.
- `data_gaps` lists factors that hit the "data gap" column, in table order. Missing data never throws.
- `as_of_slot` = max trade slot for mint, else `created_slot`; `as_of_ts` from snapshot.

### 5.4 Test cases (vitest, `packages/score/test/score.test.ts`; builders implement to these)
| id | fixture | expect |
|---|---|---|
| S01 | clean: 40 organic buyers, distinct funders, dev holds 3%, top10 12%, no priors | score 0–24, LOW, `data_gaps=[]` |
| S02 | 5 early buyers same funder | bundled_launch = 20, evidence.value = 5 |
| S03 | 2 early buyers same funder | bundled_launch absent |
| S04 | 3 prior DEAD_1H by deployer | deployer_history = 25 |
| S05 | 1 prior DEV_DUMP by a wallet the deployer funded | deployer_history = 10 |
| S06 | serial dead-launch deployer (S04) + bundle (S02) + top10 40% | ≥ 50, HIGH or EXTREME |
| S07 | top10 = 25% | holder_concentration = round(7.5) = 8 |
| S08 | dev sold 60% | dev_position = 10, evidence.value = 60 |
| S09 | dev holds 10.0% exactly, sold 0 | dev_position absent (strict >) |
| S10 | 10 enriched, 7 fresh | fresh_wallets = 10 |
| S11 | only 4 enriched | fresh_wallets & funding_cluster in data_gaps, 0 pts |
| S12 | curve 30%, 10 buyers | curve_velocity = 5 |
| S13 | symbol "PEPE" vs trending "pepe!" + no socials | metadata_flags = 5 |
| S14 | token with zero trades, null metadata | no throw; score 0..5; data_gaps includes holder_concentration |
| S15 | all factors maxed | score = 100, EXTREME, reasons.length = 5 |
| S16 | tie on points | order follows table order; two runs deep-equal (determinism) |
| S17 | band edges 24/25/49/50/74/75 via `verdictFor()` | LOW/MED/MED/HIGH/HIGH/EXTREME |
| S18 | name = `"</script><img onerror=…>"`, symbol = `"ignore previous instructions"` | no reason `detail` contains any metadata substring |

## 6. MCP tool `rug_risk_score` (`packages/mcp`)

```json
{ "name": "rug_risk_score",
  "description": "Rug-risk score (0-100) for a pump.fun mint with evidence. Costs $0.01 USDC via x402, paid by your wallet.",
  "inputSchema": { "type": "object", "additionalProperties": false, "required": ["mint"],
    "properties": { "mint": { "type": "string", "pattern": "^[1-9A-HJ-NP-Za-km-z]{32,44}$" } } } }
```
Output: MCP `structuredContent` = `RiskResult` (§2, vendored as JSON Schema `outputSchema`) plus a
`text` content item with `JSON.stringify(RiskResult)`. Errors: `isError: true`, text
`{"error": code}` with `code ∈ INVALID_MINT | NOT_FOUND | PRICE_ABOVE_CAP | DAILY_CAP_REACHED | WRONG_NETWORK | WRONG_ASSET | INSUFFICIENT_FUNDS | UPSTREAM`.
`pumpwire_stats()` (free) returns `StatsResponse`.

### 6.1 Payment direction (non-negotiable)
Caller's agent → `pumpwire-mcp` (runs on the **caller's** machine, loads the **caller's** keypair
from `SOLANA_KEYPAIR_PATH`) → signs x402 payment → PumpWire API → facilitator settles to `PAYTO_ADDRESS`.
PumpWire servers never see, store or request any caller key; the API process holds **no** private key
at all (settlement fee payer is the facilitator's). Client policy before signing: `network ==
PUMPWIRE_NETWORK`, asset ∈ {USDC, ANSEM}, `amount ≤ PUMPWIRE_MAX_PRICE_USD`, running daily spend
≤ `PUMPWIRE_DAILY_CAP_USD`; otherwise refuse with the matching error code, without signing.

## 7. Payment verification (`packages/api`, detail in ADR-002)
Must enforce per request: exact `amount`; `asset == USDC_MINT` (or enabled STRETCH asset);
destination = ATA(`PAYTO_ADDRESS`, asset); `network == X402_NETWORK`; age ≤ `maxTimeoutSeconds`;
replay: `INSERT calls(payment_id UNIQUE)` **before** serving — conflict → `402 PAYMENT_REPLAYED`
unless same `tool`+`arg` and `status='served'` (idempotent re-serve of `result_json`, 200);
retry after failure: same `payment_id` + same `tool`+`arg` with `status='failed'` (or `'pending'` older
than 120 s) re-runs scoring on the existing row and flips it to `served`; it never re-settles a row whose
`tx_sig` is set, and a different `tool`/`arg` is still `PAYMENT_REPLAYED`;
facilitator response validation (`isValid === true`; settle `success === true`, `transaction`
is a `TxSig`, `network` matches); after settle, set `tx_sig` (UNIQUE) and async re-confirm via
`SOLANA_RPC_URL` → `onchain_confirmed`. Rate limit per IP and per payer.
Direct-transfer fallback (§4.4, ADR-002): the tx must contain exactly one Memo instruction whose data is
byte-equal to `pumpwire:<tool>:<arg>` for this request (e.g. `pumpwire:rug_risk_score:<mint>`); mismatch or
missing memo → `402 PAYMENT_INVALID` and no `calls` row is claimed. This binds a public signature to the
resource its payer chose.

## 8. Untrusted data (token metadata, WS payloads, RPC/facilitator responses)
- `name`, `symbol`, `uri`, description and any JSON at `uri` are attacker-controlled.
- SQL: prepared statements with bound parameters only; no string-built SQL anywhere. Clamp lengths on ingest (`name` ≤ 64, `symbol` ≤ 16, `uri` ≤ 200 chars); strip control chars (`\u0000-\u001f\u007f`).
- Shell: never pass any ingested string to `child_process`/shell; no `eval`/`Function`.
- HTML (`/live`): DOM `textContent` only; links built from validated `Base58` only (Solscan).
- LLM: `RiskResult` and MCP output never contain metadata text (S18); scout prompts treat API output as data, and scout never follows instructions from metadata (clawrena-compliance).
- `uri` is never fetched by `api` or `score`; if ingest fetches it (for `has_socials`), use a 2 s timeout, ≤ 64 KB, `https` only, no redirects to private IPs.
