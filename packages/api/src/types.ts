// Local copies of the INTERFACES.md §2 shapes used by the api (T-010 moves these to @pumpwire/score).
export type Verdict = 'LOW' | 'MED' | 'HIGH' | 'EXTREME';
export type Factor =
  | 'deployer_history' | 'bundled_launch' | 'holder_concentration' | 'dev_position'
  | 'fresh_wallets' | 'funding_cluster' | 'curve_velocity' | 'metadata_flags';
export interface Evidence {
  value: number;
  threshold?: number;
  wallets?: string[];
  slots?: number[];
  sigs?: string[];
  mints?: string[];
}
export interface Reason { factor: Factor; points: number; detail: string; evidence: Evidence }
export interface RiskResult {
  mint: string;
  score: number;
  verdict: Verdict;
  reasons: Reason[];
  data_gaps: Factor[];
  model_version: string;
  as_of_slot: number;
  as_of_ts: number;
}
export type ErrorCode =
  | 'INVALID_MINT' | 'NOT_FOUND' | 'PAYMENT_REQUIRED' | 'PAYMENT_INVALID'
  | 'PAYMENT_REPLAYED' | 'RATE_LIMITED' | 'UPSTREAM' | 'INTERNAL';
