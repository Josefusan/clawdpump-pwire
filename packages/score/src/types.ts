// Shared PumpWire types — verbatim from docs/INTERFACES.md §2 (frozen contract, T-002).

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
