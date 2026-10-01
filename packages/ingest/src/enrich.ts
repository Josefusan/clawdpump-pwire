import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { backoffMs } from './backoff.js';
import { isAddress, isSig } from './sanitize.js';

const HELIUS_BASE = 'https://api.helius.xyz';
const PAGE_LIMIT = 100;
const MAX_ENHANCED_RPS = 2; // free plan
const MAX_ATTEMPTS = 4;

export interface InboundTransfer {
  src: string;
  lamports: number;
  ts: number;
  sig: string;
}

export interface WalletProfile {
  firstSeenTs: number | null;
  txCount: number;
  funder: string | null;
  funderTs: number | null;
  inbound: InboundTransfer[];
}

const rec = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Pure: Enhanced Transactions page (any order) -> wallet profile.
 * funder = sender of the first successful inbound native SOL transfer (ascending by time).
 * txCount is the number of transactions in the page (the page is capped at PAGE_LIMIT).
 */
export function parseWalletProfile(wallet: string, page: unknown): WalletProfile {
  const txs = (Array.isArray(page) ? page : []).map(rec).filter((t): t is Record<string, unknown> => t !== null);
  const dated = txs
    .filter((t) => typeof t.timestamp === 'number' && Number.isFinite(t.timestamp))
    .sort((a, b) => (a.timestamp as number) - (b.timestamp as number));
  const inbound: InboundTransfer[] = [];
  for (const t of dated) {
    if (t.transactionError !== null && t.transactionError !== undefined) continue; // failed tx moved no SOL
    if (!isSig(t.signature) || !Array.isArray(t.nativeTransfers)) continue;
    for (const raw of t.nativeTransfers) {
      const n = rec(raw);
      if (!n || n.toUserAccount !== wallet || !isAddress(n.fromUserAccount) || n.fromUserAccount === wallet) continue;
      const lamports = n.amount;
      if (typeof lamports !== 'number' || !Number.isSafeInteger(lamports) || lamports <= 0) continue;
      inbound.push({ src: n.fromUserAccount, lamports, ts: t.timestamp as number, sig: t.signature });
    }
  }
  const first = inbound[0];
  return {
    firstSeenTs: dated.length ? (dated[0]!.timestamp as number) : null,
    txCount: txs.length,
    funder: first?.src ?? null,
    funderTs: first?.ts ?? null,
    inbound,
  };
}

export type FetchOutcome =
  | { ok: true; page: unknown }
  | { ok: false; reason: 'rate_limited' | 'auth' | 'error' };

/** Key from HELIUS_API_KEY, else the api-key query param of SOLANA_RPC_URL. Never logged. */
export function resolveApiKey(env: Record<string, string | undefined>): string | null {
  if (env.HELIUS_API_KEY) return env.HELIUS_API_KEY;
  try {
    return env.SOLANA_RPC_URL ? new URL(env.SOLANA_RPC_URL).searchParams.get('api-key') : null;
  } catch {
    return null;
  }
}

/** Oldest-first page of Enhanced Transactions. Free plan: this is the only funder source (A-008). */
export async function fetchEnhancedAsc(
  address: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<FetchOutcome> {
  const url =
    `${HELIUS_BASE}/v0/addresses/${encodeURIComponent(address)}/transactions` +
    `?api-key=${encodeURIComponent(apiKey)}&sort-order=asc&limit=${PAGE_LIMIT}`;
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 429) return { ok: false, reason: 'rate_limited' };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth' };
    if (!res.ok) return { ok: false, reason: 'error' };
    return { ok: true, page: await res.json() };
  } catch {
    return { ok: false, reason: 'error' }; // error text may contain the URL: drop it
  }
}

export interface EnrichCounters {
  queued: number;
  enriched: number;
  skipped_cached: number;
  dropped_full: number;
  failed: number;
  retried: number;
  empty: number;
  rows_wallets: number;
  rows_funding_edges: number;
}

export interface EnrichOptions {
  apiKey: string | null;
  fetchFn?: typeof fetch;
  now?: () => number; // ms
  rps?: number;
  maxQueue?: number;
  maxCacheEntries?: number;
  cacheWindowSec?: number;
  maxCalls?: number; // per-process call budget (credit guard)
  log?: (msg: string) => void;
}

/** Bounded, cached, rate-limited wallet enrichment. Deployers (priority) go before buyers. */
export class EnrichQueue {
  readonly counters: EnrichCounters = {
    queued: 0, enriched: 0, skipped_cached: 0, dropped_full: 0, failed: 0, retried: 0, empty: 0,
    rows_wallets: 0, rows_funding_edges: 0,
  };
  readonly intervalMs: number;
  private readonly high: string[] = [];
  private readonly low: string[] = [];
  private readonly seen = new Set<string>(); // insertion-ordered, bounded
  private readonly attempts = new Map<string, number>();
  private readonly upWallet: StatementSync;
  private readonly insEdge: StatementSync;
  private readonly getEnriched: StatementSync;
  private notBefore = 0;
  private busy = false;
  private disabled: string | null = null;
  private calls = 0;
  private readonly o: Required<Omit<EnrichOptions, 'apiKey'>> & { apiKey: string | null };

  constructor(private readonly db: DatabaseSync, opts: EnrichOptions) {
    this.o = {
      fetchFn: fetch,
      now: Date.now,
      rps: MAX_ENHANCED_RPS,
      maxQueue: 2000,
      maxCacheEntries: 50_000,
      cacheWindowSec: 24 * 3600,
      maxCalls: 9000,
      log: (m) => console.log(m),
      ...opts,
    };
    const rps = Math.min(MAX_ENHANCED_RPS, Math.max(0.1, opts.rps ?? MAX_ENHANCED_RPS));
    this.intervalMs = Math.ceil(1000 / rps);
    this.upWallet = db.prepare(
      `INSERT INTO wallets (address, first_seen_ts, tx_count, funder, funder_ts, enriched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET first_seen_ts = excluded.first_seen_ts, tx_count = excluded.tx_count,
         funder = excluded.funder, funder_ts = excluded.funder_ts, enriched_at = excluded.enriched_at`,
    );
    this.insEdge = db.prepare(
      'INSERT INTO funding_edges (src, dst, lamports, ts, sig) VALUES (?, ?, ?, ?, ?) ON CONFLICT(sig, src, dst) DO NOTHING',
    );
    this.getEnriched = db.prepare('SELECT enriched_at FROM wallets WHERE address = ?');
    if (!this.o.apiKey) {
      this.disabled = 'HELIUS_API_KEY unset';
      this.o.log('ingest: wallet enrichment disabled (HELIUS_API_KEY unset); scores will lack wallet factors');
    }
  }

  get depth(): number {
    return this.high.length + this.low.length;
  }
  get isDisabled(): boolean {
    return this.disabled !== null;
  }

  private remember(w: string): void {
    this.seen.add(w);
    if (this.seen.size > this.o.maxCacheEntries) this.seen.delete(this.seen.values().next().value as string);
  }

  private freshInDb(w: string): boolean {
    const r = this.getEnriched.get(w) as { enriched_at: number | null } | undefined;
    return !!r?.enriched_at && Math.floor(this.o.now() / 1000) - r.enriched_at < this.o.cacheWindowSec;
  }

  /** Returns true if queued. Invalid, cached, or over-capacity wallets are dropped. */
  enqueue(wallet: string, priority = false): boolean {
    if (this.disabled || !isAddress(wallet)) return false;
    if (this.seen.has(wallet) || this.freshInDb(wallet)) {
      this.counters.skipped_cached++;
      return false;
    }
    if (this.depth >= this.o.maxQueue) {
      this.counters.dropped_full++;
      return false;
    }
    this.remember(wallet);
    (priority ? this.high : this.low).push(wallet);
    this.counters.queued++;
    return true;
  }

  private persist(wallet: string, p: WalletProfile): void {
    this.db.exec('BEGIN');
    try {
      this.upWallet.run(wallet, p.firstSeenTs, p.txCount, p.funder, p.funderTs, Math.floor(this.o.now() / 1000));
      this.counters.rows_wallets++;
      for (const e of p.inbound) {
        const r = this.insEdge.run(e.src, wallet, e.lamports, e.ts, e.sig);
        this.counters.rows_funding_edges += Number(r.changes);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Process at most one wallet if the rate limiter allows. Resolves true if a request was made. */
  async tick(): Promise<boolean> {
    if (this.busy || this.disabled || this.depth === 0 || this.o.now() < this.notBefore) return false;
    if (this.calls >= this.o.maxCalls) {
      this.disabled = 'call budget exhausted';
      this.o.log('ingest: wallet enrichment stopped (call budget exhausted)');
      return false;
    }
    this.busy = true;
    const wallet = (this.high.shift() ?? this.low.shift())!;
    this.notBefore = this.o.now() + this.intervalMs;
    this.calls++;
    try {
      const out = await fetchEnhancedAsc(wallet, this.o.apiKey!, this.o.fetchFn);
      if (!out.ok) this.onFailure(wallet, out.reason);
      else {
        const profile = parseWalletProfile(wallet, out.page);
        if (profile.txCount === 0) this.counters.empty++; // likely indexing lag: leave un-enriched, don't poison scores
        else {
          this.persist(wallet, profile);
          this.counters.enriched++;
        }
        this.attempts.delete(wallet);
      }
    } catch {
      this.counters.failed++; // DB error: never log (could echo data)
    } finally {
      this.busy = false;
    }
    return true;
  }

  private onFailure(wallet: string, reason: 'rate_limited' | 'auth' | 'error'): void {
    if (reason === 'auth') {
      this.disabled = 'auth rejected';
      this.o.log('ingest: wallet enrichment disabled (Helius rejected the key / plan)');
      return;
    }
    const n = (this.attempts.get(wallet) ?? 0) + 1;
    if (n >= MAX_ATTEMPTS) {
      this.attempts.delete(wallet);
      this.seen.delete(wallet); // allow a later re-enqueue
      this.counters.failed++;
      return;
    }
    this.attempts.set(wallet, n);
    this.counters.retried++;
    this.high.unshift(wallet);
    const wait = backoffMs(n - 1, Math.random(), this.intervalMs * 2);
    this.notBefore = Math.max(this.notBefore, this.o.now() + (reason === 'rate_limited' ? wait * 2 : wait));
  }

  /** Production loop: poll the limiter; the in-flight guard keeps requests sequential. */
  start(): () => void {
    const t = setInterval(() => void this.tick(), Math.min(100, this.intervalMs));
    return () => clearInterval(t);
  }
}
