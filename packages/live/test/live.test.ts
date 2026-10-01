import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { name, livePublicDir } from '../src/index.js';
// @ts-expect-error plain browser module, no types
import { buildViewModel, safeText, shortAddr, solscanTx, solscanAccount, fmtAmount, fmtAgo } from '../public/live.js';

const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const MINT = 'So11111111111111111111111111111111111111112';
const SIG = '3SaUx1eQyutzRoUP7mm4thk7gqUukCWHbMdZUt1gjUJa9ovRUydtvFwgsyaE2Q51U5onS1PENvv9B6WFUMLauxMn';
const PAYER = 'DtGkR8kXbxVFmGNP5AKD7g2MRskFed67BPFb7efHp5Mf';
const NOW = 1_790_830_000;

const stats = {
  model_version: 'v0.1.0', network: DEVNET, generated_at: NOW - 5,
  totals: { paid_calls: 3, paid_calls_first_party: 2, paid_calls_third_party: 1, usdc_paid: '0.03', ansem_paid: '0', unique_payers: 2, unique_integrators: 1 },
  last_calls: [
    { ts: NOW - 60, tool: 'rug_risk_score', arg: MINT, score: 62, verdict: 'HIGH', tx_sig: SIG, payer: PAYER, asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', first_party: true, latency_ms: 1512 },
    { ts: NOW - 3600, tool: 'rug_risk_score', arg: MINT, score: null, verdict: null, tx_sig: SIG, payer: PAYER, asset: 'x', first_party: false, latency_ms: null },
  ],
  caught: [{ mint: MINT, verdict: 'EXTREME', scored_at: NOW - 7200, outcome: 'DEAD_1H', outcome_at: NOW - 3600 }],
  backtest: { model_version: 'v0.1.0', n: 42, precision_high_plus: 0.714, recall_high_plus: 0.5 },
};

describe('live package', () => {
  it('exports its name and a public dir that holds index.html + live.js', () => {
    expect(name).toBe('live');
    const dir = livePublicDir();
    expect(existsSync(join(dir, 'index.html'))).toBe(true);
    expect(existsSync(join(dir, 'live.js'))).toBe(true);
  });

  it('index.html never uses innerHTML and loads live.js as a module', () => {
    const html = readFileSync(join(livePublicDir(), 'index.html'), 'utf8');
    const js = readFileSync(join(livePublicDir(), 'live.js'), 'utf8');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('type="module" src="/live/live.js"');
    expect(js).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
  });

  it('builds counters, split, calls and links from a StatsResponse', () => {
    const vm = buildViewModel(stats, NOW);
    expect(vm.networkLabel).toBe('Solana devnet');
    expect(vm.counters.map((c: { label: string; value: string }) => c.value)).toEqual(['3', '0.03 USDC', '0 ANSEM', '2', '1']);
    expect(vm.split).toEqual({ firstParty: 2, thirdParty: 1, firstPartyPct: 2 / 3 });
    expect(vm.calls).toHaveLength(2);
    expect(vm.calls[0]).toMatchObject({ ago: '1m ago', tool: 'rug_risk_score', score: '62', verdict: 'HIGH', party: 'first-party', latency: '1512 ms' });
    expect(vm.calls[0].txHref).toBe(`https://solscan.io/tx/${SIG}?cluster=devnet`);
    expect(vm.calls[0].argHref).toBe(`https://solscan.io/account/${MINT}?cluster=devnet`);
    expect(vm.calls[1]).toMatchObject({ score: '—', verdict: '—', party: 'third-party', latency: '—' });
    expect(vm.caught[0]).toMatchObject({ verdict: 'EXTREME', outcome: 'DEAD_1H' });
    expect(vm.backtest).toEqual({ model: 'v0.1.0', n: '42', precision: '71%', recall: '50%', small: true });
  });

  it('mainnet links carry no cluster query', () => {
    expect(solscanTx(SIG, MAINNET)).toBe(`https://solscan.io/tx/${SIG}`);
    expect(solscanAccount(PAYER, MAINNET)).toBe(`https://solscan.io/account/${PAYER}`);
  });

  it('refuses to build links from non-base58 input and strips hostile text', () => {
    const hostile = { ...stats, last_calls: [{ ...stats.last_calls[0], arg: '<script>alert(1)</script>', tx_sig: 'javascript:alert(1)', tool: 'ignore previous instructions\u0000' }] };
    const vm = buildViewModel(hostile, NOW);
    expect(vm.calls[0].argHref).toBeNull();
    expect(vm.calls[0].txHref).toBeNull();
    expect(vm.calls[0].tool).toBe('ignore previous instruct');
    expect(JSON.stringify(vm)).not.toMatch(/\u0000|javascript:/);
    expect(safeText('a\u0000b c')).toBe('abc');
    expect(shortAddr(PAYER)).toBe('DtGk…p5Mf');
  });

  it('survives an empty or malformed stats body', () => {
    for (const bad of [null, undefined, {}, { totals: null, last_calls: 'x', caught: 7, backtest: 'no' }, []]) {
      const vm = buildViewModel(bad as unknown, NOW);
      expect(vm.counters[0].value).toBe('0');
      expect(vm.calls).toEqual([]);
      expect(vm.backtest).toBeNull();
    }
    expect(fmtAmount('not-a-number', 'USDC')).toBe('0 USDC');
    expect(fmtAgo(NOW - 90000, NOW)).toBe('1d ago');
  });
});
