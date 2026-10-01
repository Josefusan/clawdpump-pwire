/**
 * Bounded set of tracked mints (mint -> trade-window expiry ms) with least-recently-active
 * eviction. Map insertion order is the recency order: oldest key = least recently active.
 */
export class TrackedSet {
  private readonly m = new Map<string, number>();

  constructor(readonly cap: number) {
    if (!Number.isInteger(cap) || cap < 1) throw new Error('TrackedSet: cap must be an integer >= 1');
  }

  get size(): number { return this.m.size; }
  has(mint: string): boolean { return this.m.has(mint); }
  keys(): string[] { return [...this.m.keys()]; }

  /** Track a mint; at the cap, evicts least-recently-active mints first. Returns the evicted mints. */
  add(mint: string, expiryMs: number): string[] {
    const evicted: string[] = [];
    if (this.m.has(mint)) this.m.delete(mint);
    while (this.m.size >= this.cap) {
      const oldest = this.m.keys().next().value as string;
      this.m.delete(oldest);
      evicted.push(oldest);
    }
    this.m.set(mint, expiryMs);
    return evicted;
  }

  /** Mark a tracked mint as just active (a trade arrived). No-op for untracked mints. */
  touch(mint: string): void {
    const exp = this.m.get(mint);
    if (exp === undefined) return;
    this.m.delete(mint);
    this.m.set(mint, exp);
  }

  delete(mint: string): void { this.m.delete(mint); }

  /** Remove and return mints whose window has passed. */
  expire(nowMs: number): string[] {
    const out = [...this.m].filter(([, exp]) => exp <= nowMs).map(([k]) => k);
    out.forEach((k) => this.m.delete(k));
    return out;
  }
}

export const DEFAULT_MAX_TRACKED = 500;

export const parseMaxTracked = (v: string | undefined): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_MAX_TRACKED;
};
