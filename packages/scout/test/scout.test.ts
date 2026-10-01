import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ToolError } from '@pumpwire/mcp';
import { alertMarkdown, asRisk, isAlertWorthy } from '../src/alerts.js';
import { loadScoutConfig } from '../src/config.js';
import { SeenStore, step } from '../src/loop.js';
import { findCandidates } from '../src/watch.js';

const SCHEMA = readFileSync(new URL('../../../docs/schema.sql', import.meta.url), 'utf8');
const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const b58 = (seed: string) => (seed.repeat(44)).slice(0, 44).replace(/[0OIl]/g, 'a');
const DEPLOYER = b58('D');
const HOT = b58('H1');
const COLD = b58('C2');
const LATE = b58('L3');
const OLD = b58('O4');
const NOW = 1_800_000_000;

function seed(db: DatabaseSync) {
  db.exec(SCHEMA);
  const tok = db.prepare('INSERT INTO tokens (mint, name, symbol, deployer, created_slot, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const tr = db.prepare('INSERT INTO trades (sig, mint, wallet, side, lamports, token_amount, slot, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  let sig = 0;
  const buy = (mint: string, wallet: string, ts: number) => tr.run(`sig${sig++}`.padEnd(32, 'x'), mint, wallet, 'buy', 1000, 10, 100 + sig, ts);
  // HOT: 5 distinct non-deployer buyers inside 120 s (+ deployer, + a duplicate wallet) → qualifies
  tok.run(HOT, 'Hot <script>', 'HOT', DEPLOYER, 100, NOW - 90);
  for (let i = 0; i < 5; i++) buy(HOT, b58(`B${i}`), NOW - 85 + i);
  buy(HOT, b58('B0'), NOW - 80); // duplicate wallet does not count twice
  buy(HOT, DEPLOYER, NOW - 89); // deployer does not count
  // COLD: only 3 buyers → no
  tok.run(COLD, 'Cold', 'COLD', DEPLOYER, 101, NOW - 100);
  for (let i = 0; i < 3; i++) buy(COLD, b58(`B${i}`), NOW - 95 + i);
  // LATE: 5 buyers but 2 of them after the 120 s window → only 3 in-window → no
  tok.run(LATE, 'Late', 'LATE', DEPLOYER, 102, NOW - 400);
  for (let i = 0; i < 3; i++) buy(LATE, b58(`B${i}`), NOW - 395 + i);
  buy(LATE, b58('B7'), NOW - 200);
  buy(LATE, b58('B8'), NOW - 150);
  // OLD: 6 buyers but created 2 h ago → outside max age
  tok.run(OLD, 'Old', 'OLD', DEPLOYER, 103, NOW - 7200);
  for (let i = 0; i < 6; i++) buy(OLD, b58(`B${i}`), NOW - 7195 + i);
}

const OPTS = { minBuyers: 5, windowS: 120, maxAgeS: 900 };

describe('findCandidates', () => {
  it('picks only launches with ≥ minBuyers distinct non-deployer buyers inside the window and within max age', () => {
    const db = new DatabaseSync(':memory:');
    seed(db);
    const c = findCandidates(db, NOW, OPTS, () => false);
    expect(c.map((x) => x.mint)).toEqual([HOT]);
    expect(c[0]!.buyers).toBe(5);
  });

  it('skips mints already seen', () => {
    const db = new DatabaseSync(':memory:');
    seed(db);
    expect(findCandidates(db, NOW, OPTS, (m) => m === HOT)).toEqual([]);
  });

  it('honours a lower threshold', () => {
    const db = new DatabaseSync(':memory:');
    seed(db);
    const mints = findCandidates(db, NOW, { ...OPTS, minBuyers: 3 }, () => false).map((x) => x.mint).sort();
    expect(mints).toEqual([COLD, HOT, LATE].sort());
  });
});

describe('alerts', () => {
  const risk = {
    mint: HOT, score: 81, verdict: 'EXTREME', model_version: 'v0.1.0', as_of_slot: 123,
    reasons: [
      { factor: 'bundled_launch', points: 20, detail: '5 early-window buyers share funder Ab12…Cd34', evidence: { value: 5, threshold: 3 } },
      { factor: 'dev_position', points: 10, detail: 'deployer holds 12% <img onerror=x>', evidence: { value: 12 } },
    ],
  };

  it('narrows API bodies and rejects junk', () => {
    expect(asRisk(risk)?.verdict).toBe('EXTREME');
    expect(asRisk({ mint: 'nope', score: 1, verdict: 'LOW' })).toBeNull();
    expect(asRisk({ mint: HOT, score: 'high', verdict: 'LOW' })).toBeNull();
    expect(asRisk({ mint: HOT, score: 1, verdict: 'SCAM' })).toBeNull();
    expect(asRisk('string')).toBeNull();
    expect(isAlertWorthy({ mint: HOT, score: 50, verdict: 'HIGH' })).toBe(true);
    expect(isAlertWorthy({ mint: HOT, score: 30, verdict: 'MED' })).toBe(false);
  });

  it('writes a DRAFT with risk wording, wallet-only evidence, bounded text and no "scam"', () => {
    const md = alertMarkdown(asRisk(risk)!, NOW, DEVNET);
    expect(md).toMatch(/^# DRAFT alert — NOT posted/);
    expect(md).toContain('first_party: true');
    expect(md).toContain('EXTREME');
    expect(md).toContain(`https://solscan.io/token/${HOT}?cluster=devnet`);
    expect(md).toContain('bundled_launch (+20)');
    expect(md).toContain('Ab12…Cd34'); // the scorer's shortened addresses keep their ellipsis
    expect(md).toContain('Risk signal, not advice');
    expect(md.toLowerCase()).not.toContain('scam');
    expect(md).not.toMatch(/moon|buyback|yield|guaranteed/i);
    // attacker-influenced detail text is clamped to printable ASCII, never interpreted
    expect(md).toContain('<img onerror=x>');
    expect(md).not.toContain('\u0007');
  });

  it('uses mainnet links without a cluster', () => {
    const md = alertMarkdown(asRisk(risk)!, NOW, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(md).toContain(`https://solscan.io/token/${HOT}\n`);
  });
});

describe('step loop', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pw-scout-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function deps(pay: (mint: string) => Promise<unknown>, logs: Record<string, unknown>[]) {
    const db = new DatabaseSync(':memory:');
    seed(db);
    const cfg = loadScoutConfig({
      HOME: dir, PUMPWIRE_DB_PATH: ':memory:', DEVNET_PAYER_KEYPAIR: '/nonexistent/payer.json', X402_NETWORK: DEVNET,
      SCOUT_ALERTS_DIR: join(dir, 'alerts'), SCOUT_STATE_PATH: join(dir, 'state.json'),
    });
    return { db, cfg, seen: new SeenStore(cfg.statePath), nowS: () => NOW, log: (o: Record<string, unknown>) => logs.push(o), pay };
  }

  it('pays once per hot launch, logs first_party=true, drafts an alert for HIGH+, and never re-pays after restart', async () => {
    const logs: Record<string, unknown>[] = [];
    const paid: string[] = [];
    const pay = async (mint: string) => { paid.push(mint); return { mint, score: 72, verdict: 'HIGH', model_version: 'v0.1.0', reasons: [] }; };
    const d = deps(pay, logs);
    const r1 = await step(d);
    expect(r1).toEqual({ candidates: 1, scored: 1, alerts: 1 });
    expect(paid).toEqual([HOT]);
    expect(existsSync(join(dir, 'alerts', `${HOT}.md`))).toBe(true);
    const scored = logs.find((l) => l.event === 'scored')!;
    expect(scored.first_party).toBe(true);
    expect(scored.verdict).toBe('HIGH');
    expect(JSON.stringify(logs)).not.toContain('payer.json');
    // second pass in the same process: nothing new
    expect(await step(d)).toEqual({ candidates: 0, scored: 0, alerts: 0 });
    // simulated restart: state persisted on disk
    const d2 = deps(pay, logs);
    expect(await step(d2)).toEqual({ candidates: 0, scored: 0, alerts: 0 });
    expect(paid).toEqual([HOT]);
  });

  it('does not draft alerts for LOW/MED', async () => {
    const logs: Record<string, unknown>[] = [];
    const d = deps(async (mint) => ({ mint, score: 12, verdict: 'LOW', reasons: [] }), logs);
    expect(await step(d)).toEqual({ candidates: 1, scored: 1, alerts: 0 });
    expect(existsSync(join(dir, 'alerts'))).toBe(false);
  });

  it('halts on DAILY_CAP_REACHED and INSUFFICIENT_FUNDS without marking the mint done', async () => {
    const logs: Record<string, unknown>[] = [];
    const d = deps(async () => { throw new ToolError('DAILY_CAP_REACHED'); }, logs);
    const r = await step(d);
    expect(r.halt).toBe('DAILY_CAP_REACHED');
    expect(r.scored).toBe(0);
    expect(d.seen.has(HOT)).toBe(false); // one attempt recorded, retry allowed later
    const d2 = deps(async () => { throw new ToolError('INSUFFICIENT_FUNDS'); }, logs);
    expect((await step(d2)).halt).toBe('INSUFFICIENT_FUNDS');
  });

  it('retries a transient failure once, then gives up on that mint', async () => {
    const logs: Record<string, unknown>[] = [];
    let n = 0;
    const d = deps(async () => { n++; throw new ToolError('UPSTREAM'); }, logs);
    expect((await step(d)).halt).toBeUndefined();
    expect((await step(d)).halt).toBeUndefined();
    await step(d);
    expect(n).toBe(2);
    expect(d.seen.has(HOT)).toBe(true);
  });

  it('marks permanent per-mint failures done immediately', async () => {
    const logs: Record<string, unknown>[] = [];
    let n = 0;
    const d = deps(async () => { n++; throw new ToolError('NOT_FOUND'); }, logs);
    await step(d);
    await step(d);
    expect(n).toBe(1);
  });
});

describe('config', () => {
  it('maps the api devnet.env names onto the pumpwire-mcp names and applies the caps', () => {
    const cfg = loadScoutConfig({ HOME: '/h', PUMPWIRE_DB_PATH: '/d/p.db', DEVNET_PAYER_KEYPAIR: '/k/payer.json', X402_NETWORK: DEVNET, PORT: '3000' });
    expect(cfg.apiUrl).toBe('http://127.0.0.1:3000');
    expect(cfg.pay.keypairPath).toBe('/k/payer.json');
    expect(cfg.pay.network).toBe(DEVNET);
    expect(cfg.pay.maxPriceMicro).toBe(50_000);
    expect(cfg.pay.dailyCapMicro).toBe(5_000_000);
    expect(cfg.pay.spendStatePath).toBe('/h/.pumpwire-scout/spend.json');
    expect(cfg.alertsDir).toBe('/h/pumpwire-data/alerts');
    expect(cfg).toMatchObject({ minBuyers: 5, windowS: 120, maxAgeS: 900, pollMs: 5000 });
  });

  it('prefers explicit mcp names and rejects missing DB path', () => {
    const cfg = loadScoutConfig({ HOME: '/h', PUMPWIRE_DB_PATH: '/d/p.db', SOLANA_KEYPAIR_PATH: '/k/scout.json', DEVNET_PAYER_KEYPAIR: '/k/payer.json', PUMPWIRE_NETWORK: 'mainnet', PUMPWIRE_API_URL: 'https://api.example.com/', SCOUT_MIN_BUYERS: '8' });
    expect(cfg.pay.keypairPath).toBe('/k/scout.json');
    expect(cfg.pay.network).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(cfg.apiUrl).toBe('https://api.example.com');
    expect(cfg.minBuyers).toBe(8);
    expect(() => loadScoutConfig({ HOME: '/h' })).toThrow(/PUMPWIRE_DB_PATH/);
  });

  it('never lets env raise the Scout caps above $0.05/call and $5/day, but lets it lower them', () => {
    const base = { HOME: '/h', PUMPWIRE_DB_PATH: '/d/p.db', DEVNET_PAYER_KEYPAIR: '/k/payer.json' };
    const high = loadScoutConfig({ ...base, PUMPWIRE_MAX_PRICE_USD: '1', PUMPWIRE_DAILY_CAP_USD: '500' });
    expect(high.pay.maxPriceMicro).toBe(50_000);
    expect(high.pay.dailyCapMicro).toBe(5_000_000);
    const low = loadScoutConfig({ ...base, PUMPWIRE_MAX_PRICE_USD: '0.01', PUMPWIRE_DAILY_CAP_USD: '1' });
    expect(low.pay.maxPriceMicro).toBe(10_000);
    expect(low.pay.dailyCapMicro).toBe(1_000_000);
  });
});
