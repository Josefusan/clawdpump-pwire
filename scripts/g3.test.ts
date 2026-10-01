import { describe, expect, it } from 'vitest';
import { formatSummary, runG3, type G3Deps, type NegativeKind, type NegativeLogEntry } from './g3.ts';

const A = 'So11111111111111111111111111111111111111112';
const B = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const sigs = (n: number) => Array.from({ length: n }, (_, i) => `sig${i}`);
const GOOD = (k: NegativeKind) => ({ status: 402, error_code: k === 'replayed_tx' ? 'PAYMENT_REPLAYED' : 'PAYMENT_INVALID' });

function mock(over: Partial<G3Deps> = {}) {
  const calls: string[] = [];
  const negs: [NegativeKind, string, string][] = [];
  const logged: NegativeLogEntry[] = [];
  const deps: G3Deps = {
    mints: [A, B],
    now: () => 100,
    paidCall: async (m) => { calls.push(m); return { ok: true }; },
    negative: async (k, m, o) => { negs.push([k, m, o]); return GOOD(k); },
    logNegative: (e) => { logged.push(e); },
    txSigs: () => sigs(20),
    ...over,
  };
  return { deps, calls, negs, logged };
}

describe('g3 orchestration', () => {
  it('makes 20 paid calls cycling mints, runs 3 negatives, logs and summarizes', async () => {
    const { deps, calls, negs, logged } = mock();
    const s = await runG3(deps);
    expect(calls).toHaveLength(20);
    expect(new Set(calls)).toEqual(new Set([A, B]));
    expect(negs.map((n) => n[0])).toEqual(['wrong_amount', 'wrong_mint', 'replayed_tx']);
    expect(negs[2]![1]).not.toBe(negs[2]![2]); // replay targets a different mint
    expect(logged).toEqual([
      { kind: 'wrong_amount', status: 402, error_code: 'PAYMENT_INVALID', ts: 100 },
      { kind: 'wrong_mint', status: 402, error_code: 'PAYMENT_INVALID', ts: 100 },
      { kind: 'replayed_tx', status: 402, error_code: 'PAYMENT_REPLAYED', ts: 100 },
    ]);
    expect(s).toMatchObject({ successes: 20, failures: 0, usdcSpent: 0.2, ok: true });
    expect(s.txSigs).toHaveLength(20);
    const out = formatSummary(s);
    expect(out).toContain('G3 PASS: successes=20 failures=0 usdc_spent=0.20');
    expect(out).toContain('negative replayed_tx: rejected (HTTP 402 PAYMENT_REPLAYED)');
    expect(out).toContain('  sig0');
  });

  it('captures sigs before the negatives run (replay setup adds a 21st row)', async () => {
    let negativesRan = false;
    const { deps } = mock({
      negative: async (k) => { negativesRan = true; return GOOD(k); },
      txSigs: () => (negativesRan ? sigs(21) : sigs(20)),
    });
    const s = await runG3(deps);
    expect(s.txSigs).toHaveLength(20);
    expect(s.ok).toBe(true);
  });

  it('FAILs without a DB (no sigs) or with a wrong sig count / duplicate sigs', async () => {
    expect((await runG3(mock({ txSigs: () => [] }).deps)).ok).toBe(false);
    expect((await runG3(mock({ txSigs: () => sigs(19) }).deps)).ok).toBe(false);
    expect((await runG3(mock({ txSigs: () => sigs(21) }).deps)).ok).toBe(false);
    const dup = await runG3(mock({ txSigs: () => [...sigs(19), 'sig0'] }).deps);
    expect(dup.txSigs).toHaveLength(19);
    expect(dup.ok).toBe(false);
  });

  it('fails when a call fails (including a thrown one) and still summarizes', async () => {
    let n = 0;
    const { deps } = mock({
      paidCall: async () => {
        if (++n === 3) throw new Error('transport closed');
        return n === 4 ? { ok: false, error: 'UPSTREAM' } : { ok: true };
      },
    });
    const s = await runG3(deps);
    expect(s.successes).toBe(18);
    expect(s.failures).toBe(2);
    expect(s.usdcSpent).toBe(0.18);
    expect(s.ok).toBe(false);
    expect(formatSummary(s)).toContain('G3 FAIL');
  });

  it('counts a negative rejected only on 402 with the exact code', async () => {
    const cases: [NegativeKind, { status: number; error_code: string | null }][] = [
      ['wrong_amount', { status: 402, error_code: 'PAYMENT_REPLAYED' }], // wrong code
      ['wrong_mint', { status: 429, error_code: 'RATE_LIMITED' }],
      ['replayed_tx', { status: 402, error_code: 'PAYMENT_INVALID' }], // replay needs PAYMENT_REPLAYED
      ['wrong_amount', { status: 400, error_code: 'INVALID_MINT' }],
      ['wrong_mint', { status: 404, error_code: 'NOT_FOUND' }],
      ['wrong_amount', { status: 200, error_code: null }],
      ['wrong_amount', { status: 402, error_code: null }],
    ];
    for (const [kind, r] of cases) {
      const s = await runG3(mock({ negative: async (k) => (k === kind ? r : GOOD(k)) }).deps);
      expect(s.negatives.find((x) => x.kind === kind)!.rejected, JSON.stringify([kind, r])).toBe(false);
      expect(s.ok).toBe(false);
      expect(formatSummary(s)).toContain('NOT REJECTED');
    }
  });

  it('a throwing negative is recorded as failed, logged, and the loop continues', async () => {
    const { deps, logged } = mock({
      negative: async (k) => { if (k === 'wrong_amount') throw new Error('callTool exploded'); return GOOD(k); },
    });
    const s = await runG3(deps);
    expect(s.negatives).toHaveLength(3);
    expect(logged).toHaveLength(3);
    expect(logged[0]).toMatchObject({ kind: 'wrong_amount', status: 0, error_code: null });
    expect(s.negatives[0]!.rejected).toBe(false);
    expect(s.negatives[2]!.rejected).toBe(true);
    expect(s.ok).toBe(false);
  });

  it('a failed log write fails the run', async () => {
    const { deps } = mock({ logNegative: () => { throw new Error('disk full'); } });
    const s = await runG3(deps);
    expect(s.negatives.every((n) => n.rejected && !n.logged)).toBe(true);
    expect(s.ok).toBe(false);
    expect(formatSummary(s)).toContain('LOG WRITE FAILED');
  });

  it('errors without mints', async () => {
    await expect(runG3(mock({ mints: [] }).deps)).rejects.toThrow(/no mints/);
  });
});
