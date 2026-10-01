import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { cachedScore, dbScore } from '../src/risk.js';
import { buildSnapshot } from '../src/snapshot.js';

const SCHEMA = readFileSync(new URL('../../../docs/schema.sql', import.meta.url), 'utf8');
const pad = (s: string) => s + '1'.repeat(44 - s.length);
const idx = (i: number) => [i % 26, Math.floor(i / 26) % 26, Math.floor(i / 676)].map((d) => String.fromCharCode(97 + d)).join('');
const MINT = pad('MintA');
const DEV = pad('Dev');
const BUNDLER = pad('Bundler');
const T0 = 1_790_000_000;
const SLOT0 = 300_000_000;
const NOW = T0 + 3600;

function seed(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const tok = db.prepare('INSERT INTO tokens (mint, name, symbol, uri, deployer, created_slot, created_at, curve_pct, has_socials, outcome) VALUES (?,?,?,?,?,?,?,?,?,?)');
  tok.run(MINT, 'Name', 'ABC', null, DEV, SLOT0, T0, 30, 0, null);
  tok.run(pad('Prior1'), 'p', 'P1', null, DEV, SLOT0 - 9000, T0 - 7200, 5, 1, 'DEAD_1H');
  tok.run(pad('Prior2'), 'p', 'P2', null, DEV, SLOT0 - 99000, T0 - 72000, 5, 1, 'DEV_DUMP');
  tok.run(pad('Trend'), 'Trend', 'PEPE', null, pad('Other'), SLOT0 - 5, T0 - 100, 5, 1, null);
  const tr = db.prepare('INSERT INTO trades (sig, mint, wallet, side, lamports, token_amount, slot, ts) VALUES (?,?,?,?,?,?,?,?)');
  const wl = db.prepare('INSERT INTO wallets (address, first_seen_ts, tx_count, funder, funder_ts, enriched_at) VALUES (?,?,?,?,?,?)');
  tr.run('s-dev', MINT, DEV, 'buy', 1e9, 3e13, SLOT0, T0);
  tr.run('s-trend', pad('Trend'), pad('Someone'), 'buy', 1e9, 1e13, SLOT0, T0);
  for (let i = 0; i < 200; i++) {
    const w = pad('B' + idx(i));
    tr.run(`s-${String(i).padStart(4, '0')}`, MINT, w, 'buy', 5e8, 1e13, SLOT0 + (i < 5 ? 0 : 3 + i), T0 + i);
    if (i < 30) wl.run(w, T0 - 86400 * 30, 50, i < 5 ? BUNDLER : pad('F' + idx(i)), T0 - 86400 * 30, T0 + 600);
  }
  return db;
}

describe('buildSnapshot / dbScore', () => {
  let db: DatabaseSync;
  beforeAll(() => { db = seed(); });

  it('returns null for an unknown mint', () => {
    expect(buildSnapshot(db, pad('Nope'), NOW)).toBeNull();
  });

  it('builds a snapshot with trades, wallets, priors and trending symbols', () => {
    const s = buildSnapshot(db, MINT, NOW)!;
    expect(s.trades).toHaveLength(201);
    expect(Object.keys(s.wallets)).toHaveLength(30);
    expect(s.deployer_prior.map((p) => p.outcome).sort()).toEqual(['DEAD_1H', 'DEV_DUMP']);
    expect(s.trending_symbols).toEqual([{ mint: pad('Trend'), symbol_norm: 'pepe' }]);
  });

  it('scores real DB rows: priors + bundle + no socials', () => {
    const r = dbScore(db, MINT, NOW);
    expect(r.model_version).toBe('v0.1.0');
    expect(r.reasons.map((x) => x.factor)).toEqual(
      expect.arrayContaining(['deployer_history', 'bundled_launch', 'metadata_flags']),
    );
    expect(r.reasons.every((x) => Number.isFinite(x.evidence.value))).toBe(true);
    expect(r.as_of_slot).toBe(SLOT0 + 3 + 199);
  });

  it('treats attacker-controlled symbol as bound data, not SQL', () => {
    db.prepare('UPDATE tokens SET symbol = ? WHERE mint = ?').run("x'); DROP TABLE tokens;--", MINT);
    expect(() => dbScore(db, MINT, NOW)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM tokens').get()).toEqual({ n: 4 });
  });
});

describe('cachedScore (30 s per mint)', () => {
  it('reuses within 30 s, recomputes after, keys per mint, never caches errors', () => {
    const inner = vi.fn((_db: DatabaseSync, mint: string, now: number) => ({ mint, now }) as never);
    const f = cachedScore(inner);
    const db = null as never;
    f(db, 'a', 100); f(db, 'a', 129); f(db, 'b', 129);
    expect(inner).toHaveBeenCalledTimes(2);
    f(db, 'a', 130);
    expect(inner).toHaveBeenCalledTimes(3);
    const bad = vi.fn(() => { throw new Error('boom'); });
    const g = cachedScore(bad);
    expect(() => g(db, 'x', 1)).toThrow();
    expect(() => g(db, 'x', 2)).toThrow();
    expect(bad).toHaveBeenCalledTimes(2);
  });
});

describe('latency', () => {
  it('p50 of uncached dbScore on a 200-buyer fixture DB is < 150 ms', () => {
    const db = seed();
    const ms: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t = performance.now();
      dbScore(db, MINT, NOW + i);
      ms.push(performance.now() - t);
    }
    ms.sort((a, b) => a - b);
    const p50 = ms[25]!;
    console.log(`p50=${p50.toFixed(2)}ms p95=${ms[47]!.toFixed(2)}ms (uncached, n=50, 201 trades)`);
    expect(p50).toBeLessThan(150);
  });
});
