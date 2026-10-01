import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import { createApp, type Backend } from '../src/app.js';
import { applySchema } from '../src/calls.js';
import type { Config } from '../src/config.js';
import { readBacktest } from '../src/stats.js';

const backend: Backend = {
  verify: async () => ({ isValid: false, invalidReason: 'unused' }) as never,
  settle: async () => ({ success: false }) as never,
  getSupported: async () => ({ kinds: [] }) as never,
};

function cfgWith(backtestJsonPath: string): Config {
  return {
    port: 0, dbPath: ':memory:', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', facilitatorUrl: 'http://mock.invalid',
    payTo: '11111111111111111111111111111111', usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    maxTimeoutS: 60, rateLimitPerMin: 1000, firstPartyWallets: [], backtestJsonPath,
  };
}

let server: Server | undefined;
let dir: string | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function listen(cfg: Config): Promise<string> {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const app = createApp({ db, backend, cfg });
  server = app.listen(0);
  await new Promise((r) => server!.once('listening', r));
  const addr = server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

describe('/live static page', () => {
  it('serves packages/live/public at /live with no secrets involved', async () => {
    const base = await listen(cfgWith('/nonexistent/backtest.json'));
    const res = await fetch(`${base}/live`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('PumpWire');
    expect(html).toContain('/live/live.js');
    const js = await fetch(`${base}/live/live.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
  });

  it('does not expose paths outside the public dir', async () => {
    const base = await listen(cfgWith('/nonexistent/backtest.json'));
    const res = await fetch(`${base}/live/../src/app.ts`);
    expect([400, 403, 404]).toContain(res.status);
  });
});

describe('/v1/stats.backtest', () => {
  it('is null when data/backtest.json is missing or malformed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pw-bt-'));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(readBacktest('/nonexistent/backtest.json')).toBeNull();
    expect(readBacktest(bad)).toBeNull();
    expect(readBacktest('')).toBeNull();
  });

  it('serves the harness output and picks up a rewrite', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pw-bt-'));
    const p = join(dir, 'backtest.json');
    writeFileSync(p, JSON.stringify({ model_version: 'v0.1.0', n: 0, precision_high_plus: null, recall_high_plus: null, caveat: 'scorer not built', rules: {} }));
    const base = await listen(cfgWith(p));
    let body = (await (await fetch(`${base}/v1/stats`)).json()) as { backtest: Record<string, unknown> | null };
    expect(body.backtest).toEqual({ model_version: 'v0.1.0', n: 0, precision_high_plus: null, recall_high_plus: null, caveat: 'scorer not built' });

    writeFileSync(p, JSON.stringify({ model_version: 'v0.1.0', n: 120, precision_high_plus: 0.8, recall_high_plus: 0.5 }));
    const t = new Date(Date.now() + 5000);
    utimesSync(p, t, t); // force a distinct mtime so the cache invalidates
    body = (await (await fetch(`${base}/v1/stats`)).json()) as { backtest: Record<string, unknown> | null };
    expect(body.backtest).toEqual({ model_version: 'v0.1.0', n: 120, precision_high_plus: 0.8, recall_high_plus: 0.5 });
  });
});

describe('first-party labelling at query time', () => {
  it('counts payTo and FIRST_PARTY_WALLETS as first-party even when the stored flag is 0', async () => {
    const { buildStats } = await import('../src/stats.js');
    const db = new DatabaseSync(':memory:');
    applySchema(db);
    const cfg = cfgWith('/nonexistent/backtest.json');
    const SCOUT = 'ScoutScoutScoutScoutScoutScoutScoutScout1';
    const OTHER = 'OtherOtherOtherOtherOtherOtherOtherOther1';
    const ins = db.prepare(`INSERT INTO calls (ts, tool, arg, payer, network, asset, amount, payment_id, tx_sig, settle_via, status, first_party)
      VALUES (?, 'rug_risk_score', ?, ?, ?, ?, 10000, ?, ?, 'facilitator', 'served', 0)`);
    const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
    ins.run(1, MINT, cfg.payTo, cfg.network, cfg.usdcMint, 'p1', 't1');
    ins.run(2, MINT, SCOUT, cfg.network, cfg.usdcMint, 'p2', 't2');
    ins.run(3, MINT, OTHER, cfg.network, cfg.usdcMint, 'p3', 't3');
    const before = buildStats(db, cfg, 10);
    expect(before.totals).toMatchObject({ paid_calls: 3, paid_calls_first_party: 1, paid_calls_third_party: 2, unique_integrators: 2 });
    const after = buildStats(db, { ...cfg, firstPartyWallets: [SCOUT] }, 10);
    expect(after.totals).toMatchObject({ paid_calls: 3, paid_calls_first_party: 2, paid_calls_third_party: 1, unique_integrators: 1 });
    expect(after.last_calls.map((c) => c.first_party)).toEqual([false, true, true]);
  });
});
