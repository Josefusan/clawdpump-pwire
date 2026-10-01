import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ToolError } from '@pumpwire/mcp';
import { asRisk, isAlertWorthy, writeAlertDraft } from './alerts.js';
import type { ScoutConfig } from './config.js';
import { findCandidates } from './watch.js';

const MAX_ATTEMPTS = 2;
const KEEP_S = 86_400;

/** Mints already handled (persisted so a restart never double-pays). Pruned to the last 24 h. */
export class SeenStore {
  private mints: Record<string, { attempts: number; ts: number }> = {};

  constructor(private readonly path: string) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { mints?: Record<string, { attempts: number; ts: number }> };
      if (raw && typeof raw.mints === 'object' && raw.mints) this.mints = raw.mints;
    } catch {
      this.mints = {};
    }
  }

  has(mint: string): boolean {
    const e = this.mints[mint];
    return !!e && e.attempts >= MAX_ATTEMPTS;
  }

  attempts(mint: string): number {
    return this.mints[mint]?.attempts ?? 0;
  }

  /** Record an attempt (or a final outcome with `done=true`) and persist atomically. */
  mark(mint: string, nowS: number, done: boolean): void {
    const prev = this.mints[mint]?.attempts ?? 0;
    this.mints[mint] = { attempts: done ? MAX_ATTEMPTS : prev + 1, ts: nowS };
    for (const [m, e] of Object.entries(this.mints)) if (nowS - e.ts > KEEP_S) delete this.mints[m];
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ mints: this.mints }));
    renameSync(tmp, this.path);
  }
}

export type Halt = 'DAILY_CAP_REACHED' | 'INSUFFICIENT_FUNDS';

export interface StepDeps {
  db: DatabaseSync;
  cfg: ScoutConfig;
  seen: SeenStore;
  /** Pays for and returns the risk result body (pumpwire-mcp fetchRiskResult with caps enforced inside). */
  pay: (mint: string) => Promise<unknown>;
  nowS: () => number;
  /** One JSON object per line; never includes keys, paths to keys, or RPC URLs. */
  log: (o: Record<string, unknown>) => void;
}

export interface StepResult {
  candidates: number;
  scored: number;
  alerts: number;
  halt?: Halt;
}

/** One pass: find hot launches, pay for a score each, draft alerts for HIGH/EXTREME. Stops early on a cap/funds halt. */
export async function step(deps: StepDeps): Promise<StepResult> {
  const { db, cfg, seen, nowS } = deps;
  const now = nowS();
  const candidates = findCandidates(db, now, cfg, (m) => seen.has(m));
  const out: StepResult = { candidates: candidates.length, scored: 0, alerts: 0 };

  for (const c of candidates) {
    seen.mark(c.mint, now, false);
    const t0 = Date.now();
    try {
      const body = await deps.pay(c.mint);
      const r = asRisk(body);
      seen.mark(c.mint, now, true);
      if (!r) {
        deps.log({ event: 'bad_result', mint: c.mint, first_party: true });
        continue;
      }
      out.scored++;
      deps.log({
        event: 'scored', mint: c.mint, verdict: r.verdict, score: r.score, model_version: r.model_version ?? null,
        buyers_in_window: c.buyers, age_s: now - c.created_at, latency_ms: Date.now() - t0, first_party: true,
      });
      if (isAlertWorthy(r)) {
        const p = writeAlertDraft(cfg.alertsDir, r, now, cfg.pay.network);
        out.alerts++;
        deps.log({ event: 'alert_draft', mint: c.mint, verdict: r.verdict, path: p, posted: false });
      }
    } catch (e) {
      const code = e instanceof ToolError ? e.code : 'UPSTREAM';
      deps.log({ event: 'error', mint: c.mint, code, attempts: seen.attempts(c.mint), first_party: true });
      if (code === 'DAILY_CAP_REACHED' || code === 'INSUFFICIENT_FUNDS') {
        out.halt = code;
        return out;
      }
      // Permanent per-mint failures are not retried; transient ones get one more attempt.
      if (code === 'INVALID_MINT' || code === 'NOT_FOUND' || code === 'WRONG_NETWORK' || code === 'WRONG_ASSET' || code === 'PRICE_ABOVE_CAP') {
        seen.mark(c.mint, now, true);
      }
    }
  }
  return out;
}
