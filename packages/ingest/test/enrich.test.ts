import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EnrichQueue, parseWalletProfile, resolveApiKey } from '../src/enrich.js';
import { openDb, Store } from '../src/db.js';
import { Pipeline } from '../src/pipeline.js';
import { SlotClock } from '../src/slot.js';

const HEL = new URL('../../../fixtures/helius/', import.meta.url);
const PP = new URL('../../../fixtures/pumpportal/', import.meta.url);
const hel = (f: string): unknown => JSON.parse(readFileSync(new URL(f, HEL), 'utf8'));
const pp = (f: string) => readFileSync(new URL(f, PP), 'utf8');

const E36R = 'E36RibWsSdkotu4R2HNTC9L9gTabJuzTkjvBiuSBayrq';
const TAKC = 'TAKc7chWm2R4PQVCj8HayiyameXWMnfaPC7iK4BSBSMx';
const YZ8H = 'YZ8hibxFvfJhaySqC7NfrRxRCfiyeZzVCjLV8yAX89kR';
const QB8R = 'Qb8RG3WZnBisc1c1nD4oYdrZ6da3eRCyiuehvHtBahYZ';
const DEPLOYER = 'oSHtyxon9EVtmeBYy8DSMpBkyE5rMtf8hWFE9SRn3vPA';

describe('parseWalletProfile (pure, fixtures)', () => {
  it('funder = first inbound SOL transfer, regardless of page order', () => {
    const p = parseWalletProfile(E36R, hel('enhanced-transactions-multi-desc.json'));
    expect(p).toMatchObject({ funder: TAKC, funderTs: 1790001900, firstSeenTs: 1790001800, txCount: 3 });
    expect(p.inbound).toHaveLength(1); // the outbound E36R -> qJ1G leg is not an inbound edge
  });
  it('native transfer fixture', () => {
    expect(parseWalletProfile(YZ8H, hel('enhanced-transactions-native-transfer.json'))).toMatchObject({
      funder: TAKC, funderTs: 1790000000, txCount: 1, inbound: [{ src: TAKC, lamports: 50_000_000, ts: 1790000000 }],
    });
  });
  it('SPL-only history has no SOL funder', () => {
    expect(parseWalletProfile(QB8R, hel('enhanced-transactions-spl-transfer.json'))).toMatchObject({ funder: null, funderTs: null, txCount: 1, firstSeenTs: 1790000300 });
  });
  it('failed tx never counts as funding', () => {
    const p = parseWalletProfile('E36RibWsSdkotu4R2HNTC9L9gTabJuzTkjvBiuSBayrq', hel('enhanced-transactions-failed-tx.json'));
    expect(p.funder).toBeNull();
    expect(p.inbound).toEqual([]);
  });
  it('empty and garbage pages do not throw', () => {
    expect(parseWalletProfile(E36R, hel('enhanced-transactions-empty.json'))).toMatchObject({ txCount: 0, firstSeenTs: null, funder: null });
    expect(parseWalletProfile(E36R, { error: 'x' }).txCount).toBe(0);
    expect(parseWalletProfile(E36R, [null, 5, { timestamp: 'x' }]).funder).toBeNull();
  });
});

describe('resolveApiKey', () => {
  it('prefers HELIUS_API_KEY, falls back to the RPC url param, else null', () => {
    expect(resolveApiKey({ HELIUS_API_KEY: 'k1', SOLANA_RPC_URL: 'https://x/?api-key=k2' })).toBe('k1');
    expect(resolveApiKey({ SOLANA_RPC_URL: 'https://x/?api-key=k2' })).toBe('k2');
    expect(resolveApiKey({ SOLANA_RPC_URL: 'nope' })).toBeNull();
    expect(resolveApiKey({})).toBeNull();
  });
});

describe('EnrichQueue (temp DB, fake fetch, no network)', () => {
  let dir: string;
  let db: DatabaseSync;
  let clock: number;
  let urls: string[];
  let logs: string[];
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });
  const mk = (fetchFn: (u: string) => Promise<Response>, extra: Record<string, unknown> = {}) =>
    new EnrichQueue(db, {
      apiKey: 'SECRETKEY', now: () => clock, log: (m) => logs.push(m),
      fetchFn: (async (u: string) => { urls.push(u); return fetchFn(u); }) as unknown as typeof fetch, ...extra,
    });
  const drain = async (q: EnrichQueue) => { for (let i = 0; i < 50 && q.depth > 0; i++) { await q.tick(); clock += 60_000; } };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pw-enrich-'));
    db = openDb(join(dir, 't.db'));
    clock = 1_790_100_000_000;
    urls = [];
    logs = [];
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('writes wallets + funding_edges; uses the Enhanced asc endpoint, never funded-by', async () => {
    const q = mk(ok(hel('enhanced-transactions-multi-desc.json')));
    expect(q.enqueue(E36R, true)).toBe(true);
    await drain(q);
    expect(db.prepare('SELECT * FROM wallets WHERE address = ?').get(E36R)).toMatchObject({
      first_seen_ts: 1790001800, tx_count: 3, funder: TAKC, funder_ts: 1790001900, enriched_at: 1_790_100_000,
    });
    expect(db.prepare('SELECT src, dst, lamports FROM funding_edges').all()).toEqual([{ src: TAKC, dst: E36R, lamports: 250_000_000 }]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/v0/addresses/${E36R}/transactions?`);
    expect(urls[0]).toContain('sort-order=asc');
    expect(urls[0]).not.toContain('funded-by');
    expect(logs.join('\n')).not.toContain('SECRETKEY');
  });

  it('caches: same wallet is fetched once (memory), and skipped when fresh in DB after restart', async () => {
    const q = mk(ok(hel('enhanced-transactions-native-transfer.json')));
    q.enqueue(YZ8H);
    expect(q.enqueue(YZ8H)).toBe(false);
    await drain(q);
    expect(q.enqueue(YZ8H)).toBe(false);
    const q2 = mk(ok([])); // new process, same DB
    expect(q2.enqueue(YZ8H)).toBe(false);
    expect(urls).toHaveLength(1);
    expect(q.counters.skipped_cached).toBe(2);
  });

  it('rate limit: at most 2 req/s even if ticked in a tight loop', async () => {
    const q = mk(ok(hel('enhanced-transactions-native-transfer.json')));
    expect(q.intervalMs).toBe(500);
    [YZ8H, E36R, QB8R].forEach((w) => q.enqueue(w));
    expect(await q.tick()).toBe(true);
    expect(await q.tick()).toBe(false); // same instant
    clock += 499;
    expect(await q.tick()).toBe(false);
    clock += 1;
    expect(await q.tick()).toBe(true);
    expect(urls).toHaveLength(2);
    expect(mk(ok([]), { rps: 50 }).intervalMs).toBe(500); // clamped to the free-plan cap
  });

  it('priority: deployer before buyers; queue is bounded', () => {
    const q = mk(ok([]), { maxQueue: 2 });
    expect(q.enqueue(YZ8H)).toBe(true);
    expect(q.enqueue(E36R, true)).toBe(true);
    expect(q.enqueue(QB8R)).toBe(false);
    expect(q.counters.dropped_full).toBe(1);
    expect(q.depth).toBe(2);
  });

  it('429 backs off and retries; success afterwards', async () => {
    let n = 0;
    const q = mk(async () => (n++ === 0 ? new Response('', { status: 429 }) : new Response(JSON.stringify(hel('enhanced-transactions-native-transfer.json')))));
    q.enqueue(YZ8H);
    await q.tick();
    expect(q.counters.retried).toBe(1);
    expect(await q.tick()).toBe(false); // still inside the backoff window
    await drain(q);
    expect(q.counters.enriched).toBe(1);
    expect(count('wallets')).toBe(1);
  });

  it('403 disables the job (logged once, no key), further enqueues are ignored; never crashes', async () => {
    const q = mk(async () => new Response('forbidden', { status: 403 }));
    q.enqueue(YZ8H);
    await q.tick();
    expect(q.isDisabled).toBe(true);
    expect(q.enqueue(E36R)).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain('SECRETKEY');
  });

  it('network failure drops the wallet after bounded retries', async () => {
    const q = mk(async () => { throw new Error('boom https://api.helius.xyz/?api-key=SECRETKEY'); });
    q.enqueue(YZ8H);
    await drain(q);
    expect(q.counters).toMatchObject({ failed: 1, retried: 3, enriched: 0 });
    expect(urls).toHaveLength(4);
    expect(count('wallets')).toBe(0);
    expect(logs.join('')).not.toContain('SECRETKEY');
  });

  it('empty history is not marked enriched', async () => {
    const q = mk(ok(hel('enhanced-transactions-empty.json')));
    q.enqueue(YZ8H);
    await drain(q);
    expect(q.counters).toMatchObject({ empty: 1, enriched: 0 });
    expect(count('wallets')).toBe(0);
  });

  it('missing HELIUS_API_KEY: logs once and skips, no throw, no fetch', async () => {
    const q = new EnrichQueue(db, { apiKey: null, log: (m) => logs.push(m), fetchFn: (async (u: string) => { urls.push(u); return new Response('[]'); }) as unknown as typeof fetch });
    expect(q.enqueue(YZ8H)).toBe(false);
    expect(await q.tick()).toBe(false);
    expect(logs).toHaveLength(1);
    expect(urls).toHaveLength(0);
  });

  it('call budget stops the job instead of burning credits', async () => {
    const q = mk(ok(hel('enhanced-transactions-native-transfer.json')), { maxCalls: 1 });
    q.enqueue(YZ8H);
    q.enqueue(E36R);
    await drain(q);
    expect(urls).toHaveLength(1);
    expect(q.isDisabled).toBe(true);
  });

  it('invalid address strings are never queued (no URL injection)', () => {
    const q = mk(ok([]));
    expect(q.enqueue('x/../../v1/wallet?a=b')).toBe(false);
    expect(q.depth).toBe(0);
  });
});

describe('pipeline -> enrich effects (first 30 buyers + deployer)', () => {
  let dir: string;
  let db: DatabaseSync;
  let pipe: Pipeline;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pw-enrich-p-'));
    db = openDb(join(dir, 't.db'));
    pipe = new Pipeline(new Store(db), new SlotClock());
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('create -> deployer (priority); buys -> first 30 distinct non-deployer buyers only', () => {
    const t = 1_790_000_000_000;
    expect(pipe.handle(pp('create-normal.json'), t).enrich).toEqual([{ wallet: DEPLOYER, priority: true }]);
    expect(pipe.handle(pp('create-duplicate-of.json'), t).enrich).toEqual([]);
    expect(pipe.handle(pp('buy-normal.json'), t + 1000).enrich).toEqual([{ wallet: YZ8H, priority: false }]);
    expect(pipe.handle(pp('buy-duplicate-of.json'), t + 2000).enrich).toEqual([]);
    expect(pipe.handle(pp('sell-partial.json'), t + 3000).enrich).toEqual([]);
    expect(pipe.handle(pp('buy-dev-initial.json'), t + 4000).enrich).toEqual([]); // deployer's own buy
  });

  it('31st distinct buyer is not enqueued', () => {
    const store = new Store(db);
    const t = 1_790_000_000;
    pipe.handle(pp('create-normal.json'), t * 1000);
    const mint = 'BEsvbEmtygKgqiqCXrftotf47vXJXvRxovmWqkjYpump';
    const ins = db.prepare("INSERT INTO trades (sig, mint, wallet, side, lamports, token_amount, slot, ts) VALUES (?, ?, ?, 'buy', 1, 1, ?, ?)");
    const w = (i: number) => `W${String(i).padStart(2, '0')}`.padEnd(32, '1');
    for (let i = 0; i < 30; i++) ins.run(`s${i}`, mint, w(i), i, t);
    ins.run('s99', mint, w(99), 99, t);
    expect(store.isFirst30Buyer(mint, w(29))).toBe(true);
    expect(store.isFirst30Buyer(mint, w(99))).toBe(false);
  });
});
