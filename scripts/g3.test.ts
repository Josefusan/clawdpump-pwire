import { describe, expect, it } from 'vitest';
import { formatSummary, runG3, type G3Deps, type NegativeKind } from './g3.ts';

const A = 'So11111111111111111111111111111111111111112';
const B = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

function mock(over: Partial<G3Deps> = {}) {
  const calls: string[] = [];
  const negs: [NegativeKind, string, string][] = [];
  const deps: G3Deps = {
    mints: [A, B],
    now: () => 100,
    paidCall: async (m) => { calls.push(m); return { ok: true }; },
    negative: async (k, m, o) => { negs.push([k, m, o]); return { status: 402, detail: 'PAYMENT_INVALID' }; },
    txSigs: () => ['sigA', 'sigB'],
    ...over,
  };
  return { deps, calls, negs };
}

describe('g3 orchestration', () => {
  it('makes 20 paid calls cycling mints, runs 3 negatives, summarizes', async () => {
    const { deps, calls, negs } = mock();
    const s = await runG3(deps);
    expect(calls).toHaveLength(20);
    expect(new Set(calls)).toEqual(new Set([A, B]));
    expect(negs.map((n) => n[0])).toEqual(['wrong_amount', 'wrong_mint', 'replayed_tx']);
    expect(negs[2]![1]).not.toBe(negs[2]![2]); // replay targets a different mint
    expect(s).toMatchObject({ successes: 20, failures: 0, usdcSpent: 0.2, ok: true, txSigs: ['sigA', 'sigB'] });
    const out = formatSummary(s);
    expect(out).toContain('G3 PASS: successes=20 failures=0 usdc_spent=0.20');
    expect(out).toContain('negative replayed_tx: rejected (HTTP 402)');
    expect(out).toContain('  sigA');
  });

  it('fails when a call fails or a negative is accepted', async () => {
    let n = 0;
    const { deps } = mock({
      paidCall: async () => (++n === 3 ? { ok: false, error: 'UPSTREAM' } : { ok: true }),
      negative: async (k) => (k === 'wrong_amount' ? { status: 200, detail: 'served' } : { status: 402, detail: '' }),
    });
    const s = await runG3(deps);
    expect(s.successes).toBe(19);
    expect(s.failures).toBe(1);
    expect(s.usdcSpent).toBe(0.19);
    expect(s.negatives.find((x) => x.kind === 'wrong_amount')!.rejected).toBe(false);
    expect(s.ok).toBe(false);
    expect(formatSummary(s)).toContain('G3 FAIL');
    expect(formatSummary(s)).toContain('NOT REJECTED');
  });

  it('treats a throwing negative as not rejected and errors without mints', async () => {
    const { deps } = mock({ negative: async () => { throw new Error('boom'); } });
    expect((await runG3(deps)).ok).toBe(false);
    await expect(runG3(mock({ mints: [] }).deps)).rejects.toThrow(/no mints/);
  });
});
