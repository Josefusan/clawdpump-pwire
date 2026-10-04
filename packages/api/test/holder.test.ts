import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { createApp, memoFor, MAX_MEMO_BYTES, type Backend } from '../src/app.js';
import { base58Decode, base58Encode } from '../src/base58.js';
import { applySchema } from '../src/calls.js';
import type { Config } from '../src/config.js';
import { holderCheck, HOLDER_CACHE_S, HOLDER_LOOKUPS_PER_MIN } from '../src/holder.js';
import { loadConfig } from '../src/config.js';
import { MEMO_PROGRAMS } from '../src/tx.js';

const MEMO_PROGRAM = [...MEMO_PROGRAMS][0]!;
const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const rndKey = () => base58Encode(randomBytes(32));
const PAYTO = rndKey();
const FEE_PAYER = rndKey();
const PWIRE = rndKey();
const HOLDER = rndKey();
const OTHER = rndKey();
const MIN = 1_000_000_000_000n;

const baseCfg: Config = {
  port: 0, dbPath: ':memory:', network: NETWORK, facilitatorUrl: 'http://mock.invalid', payTo: PAYTO,
  usdcMint: USDC, maxTimeoutS: 60, rateLimitPerMin: 1000, firstPartyWallets: [], backtestJsonPath: '/nonexistent/backtest.json',
  pwireMint: PWIRE, pwireTierMinBalance: MIN, solanaRpcUrl: null,
};

/** Minimal v0 wire tx carrying one Memo ix. */
function buildTx(memo: string): string {
  const keys = [base58Decode(FEE_PAYER)!, base58Decode(MEMO_PROGRAM)!, base58Decode(HOLDER)!];
  const data = Buffer.from(memo, 'utf8');
  const ix = Buffer.concat([Buffer.from([1, 0, data.length]), data]);
  return Buffer.concat([
    Buffer.from([1]), Buffer.alloc(64, 7), Buffer.from([0x80, 1, 0, 1]),
    Buffer.from([keys.length]), ...keys.map((k) => Buffer.from(k)), randomBytes(32), Buffer.from([1]), ix,
  ]).toString('base64');
}

const payHeader = (tx: string, amount: string) =>
  encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: { scheme: 'exact', network: NETWORK as PaymentRequirements['network'], asset: USDC, amount, payTo: PAYTO, maxTimeoutSeconds: 60, extra: {} },
    payload: { transaction: tx },
  });

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

/** Start the API with a stubbed balance table; returns helpers. `balances` maps wallet → PWIRE base units (or 'error'). */
async function start(balances: Record<string, bigint | 'error'>, opts: { payer?: string; cfg?: Partial<Config>; tier?: boolean } = {}) {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const mint = rndKey();
  db.prepare('INSERT INTO tokens (mint, deployer, created_slot, created_at) VALUES (?, ?, ?, ?)').run(mint, rndKey(), 300, 1_790_000_000);
  const read = vi.fn(async (owner: string) => {
    const b = balances[owner];
    if (b === 'error') throw new Error('rpc down');
    return b ?? 0n;
  });
  const backend = {
    verify: vi.fn(async () => ({ isValid: true, payer: opts.payer ?? HOLDER })),
    settle: vi.fn(async () => ({ success: true, transaction: base58Encode(randomBytes(64)), network: NETWORK })),
    getSupported: vi.fn(async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK, extra: { feePayer: FEE_PAYER } }], extensions: [], signers: {} })),
  };
  const score = vi.fn((_db: unknown, m: string, now: number) => ({
    mint: m, score: 0, verdict: 'LOW' as const, reasons: [], data_gaps: [], model_version: 'v0.0.0-stub', as_of_slot: 300, as_of_ts: now,
  }));
  const app = createApp({
    db, backend: backend as unknown as Backend, cfg: { ...baseCfg, ...opts.cfg }, score: score as never,
    holderBalance: opts.tier === false ? undefined : read,
  });
  await new Promise<void>((r) => { server = app.listen(0, r); });
  const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  const get = (headers: Record<string, string> = {}) => fetch(`${base}/v1/risk/${mint}`, { headers });
  const offer = async (headers: Record<string, string> = {}) => ((await (await get(headers)).json()) as { accepts: PaymentRequirements[]; resource: { description: string } });
  return { db, mint, read, backend, get, offer, base };
}

describe('holder tier: 402 offer', () => {
  it('holder with >= tier balance gets the half price, bound to the wallet by a short memo', async () => {
    const t = await start({ [HOLDER]: MIN });
    const o = await t.offer({ 'x-pwire-holder': HOLDER });
    expect(o.accepts[0]!.amount).toBe('5000');
    expect(o.accepts[0]!.extra!.memo).toBe(memoFor(t.mint, HOLDER));
    expect(memoFor(t.mint, HOLDER)).not.toBe(memoFor(t.mint));
    expect(memoFor(t.mint, HOLDER)).not.toBe(memoFor(t.mint, OTHER));
    expect(Buffer.byteLength(memoFor(t.mint, HOLDER))).toBeLessThanOrEqual(MAX_MEMO_BYTES);
    expect(o.resource.description).toContain('1,000,000 $PWIRE');
  });

  it('full price when: no header, balance below tier, invalid header, RPC error', async () => {
    const t = await start({ [HOLDER]: MIN - 1n, [OTHER]: 'error' });
    for (const h of [{}, { 'x-pwire-holder': HOLDER }, { 'x-pwire-holder': 'not-a-wallet!' }, { 'x-pwire-holder': OTHER }]) {
      const o = await t.offer(h);
      expect(o.accepts[0]!.amount).toBe('10000');
      expect(o.accepts[0]!.extra!.memo).toBe(memoFor(t.mint));
    }
  });

  it('tier off (no PWIRE_MINT, or no reader): byte-identical full-price offer, header ignored', async () => {
    for (const opts of [{ cfg: { pwireMint: null } }, { tier: false }]) {
      const t = await start({ [HOLDER]: MIN * 10n }, opts);
      const o = await t.offer({ 'x-pwire-holder': HOLDER });
      expect(o.accepts[0]!.amount).toBe('10000');
      expect(o.resource.description).toBe('PumpWire rug-risk score for a pump.fun mint');
      expect(t.read).not.toHaveBeenCalled();
      server!.close();
      server = undefined;
    }
  });
});

describe('holder tier: paid path', () => {
  it('holder pays 5000 from the claimed wallet → 200, row amount 5000, stats count it', async () => {
    const t = await start({ [HOLDER]: MIN });
    const res = await t.get({ 'x-pwire-holder': HOLDER, 'PAYMENT-SIGNATURE': payHeader(buildTx(memoFor(t.mint, HOLDER)), '5000') });
    expect(res.status).toBe(200);
    const row = t.db.prepare('SELECT amount, status FROM calls').get() as { amount: number; status: string };
    expect(row).toEqual({ amount: 5000, status: 'served' });
    const stats = await (await fetch(`${t.base}/v1/stats`)).json();
    expect(stats.totals.paid_calls_holder).toBe(1);
    expect(stats.totals.usdc_paid).toBe('0.005000');
  });

  it('discounted payment from a different wallet than the header → 402, nothing settled', async () => {
    const t = await start({ [HOLDER]: MIN }, { payer: OTHER });
    const res = await t.get({ 'x-pwire-holder': HOLDER, 'PAYMENT-SIGNATURE': payHeader(buildTx(memoFor(t.mint, HOLDER)), '5000') });
    expect(res.status).toBe(402);
    expect(t.backend.settle).not.toHaveBeenCalled();
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM calls').get()).toEqual({ n: 0 });
  });

  it('5000 without the header, or with the full-price memo → 402', async () => {
    const t = await start({ [HOLDER]: MIN });
    const noHeader = await t.get({ 'PAYMENT-SIGNATURE': payHeader(buildTx(memoFor(t.mint, HOLDER)), '5000') });
    expect(noHeader.status).toBe(402);
    const wrongMemo = await t.get({ 'x-pwire-holder': HOLDER, 'PAYMENT-SIGNATURE': payHeader(buildTx(memoFor(t.mint)), '5000') });
    expect(wrongMemo.status).toBe(402);
    expect(t.backend.verify).not.toHaveBeenCalled();
  });

  it('claimed wallet below tier at payment time → 402 without the word "balance"; RPC error → 503; verify never called', async () => {
    const t = await start({ [HOLDER]: MIN - 1n, [OTHER]: 'error' });
    const below = await t.get({ 'x-pwire-holder': HOLDER, 'PAYMENT-SIGNATURE': payHeader(buildTx(memoFor(t.mint, HOLDER)), '5000') });
    expect(below.status).toBe(402);
    expect((await below.json()).message).not.toMatch(/balance|insufficient|not enough/i);
    const down = await t.get({ 'x-pwire-holder': OTHER, 'PAYMENT-SIGNATURE': payHeader(buildTx(memoFor(t.mint, OTHER)), '5000') });
    expect(down.status).toBe(503);
    expect((await down.json()).error).toBe('HOLDER_CHECK_UNAVAILABLE');
    expect(t.backend.verify).not.toHaveBeenCalled();
    const stats = await (await fetch(`${t.base}/v1/stats`)).json();
    expect(stats.holder_tier).toMatchObject({ on: true, mint: PWIRE, min_balance: MIN.toString(), errors: 1 });
    expect(stats.holder_tier.last_error).toBe('rpc down');
  });

  it('retry of a claimed holder payment whose settle failed skips the tier read but keeps the payer check', async () => {
    const balances: Record<string, bigint | 'error'> = { [HOLDER]: MIN };
    const t = await start(balances);
    t.backend.settle.mockRejectedValueOnce(new Error('timeout'));
    const hdr = { 'x-pwire-holder': HOLDER, 'PAYMENT-SIGNATURE': payHeader(buildTx(memoFor(t.mint, HOLDER)), '5000') };
    expect((await t.get(hdr)).status).toBe(502);
    balances[HOLDER] = 'error'; // cache still warm, but prove the retry would not need a read
    t.read.mockClear();
    expect((await t.get(hdr)).status).toBe(200);
    expect(t.read).not.toHaveBeenCalled();
  });

  it('a holder may still pay full price with the full-price memo', async () => {
    const t = await start({ [HOLDER]: MIN });
    const res = await t.get({ 'x-pwire-holder': HOLDER, 'PAYMENT-SIGNATURE': payHeader(buildTx(memoFor(t.mint)), '10000') });
    expect(res.status).toBe(200);
    expect(t.db.prepare('SELECT amount FROM calls').get()).toEqual({ amount: 10000 });
  });
});

describe('holderCheck', () => {
  it('caches successful reads for HOLDER_CACHE_S, never caches failures, counts errors', async () => {
    let now = 1000;
    let fail = true;
    const read = vi.fn(async () => { if (fail) throw new Error('x'); return MIN; });
    const { check, stats } = holderCheck(read, PWIRE, MIN, () => now);
    expect(await check(HOLDER)).toBe('unknown');
    fail = false;
    expect(await check(HOLDER)).toBe('holder');
    expect(await check(HOLDER)).toBe('holder');
    expect(read).toHaveBeenCalledTimes(2);
    now += HOLDER_CACHE_S;
    expect(await check(HOLDER)).toBe('holder');
    expect(read).toHaveBeenCalledTimes(3);
    expect(stats).toMatchObject({ checks: 3, errors: 1, last_error: 'x' });
  });

  it('a global lookup budget caps uncached RPC reads per minute (random headers cannot exhaust the RPC)', async () => {
    const read = vi.fn(async () => 0n);
    const { check, stats } = holderCheck(read, PWIRE, MIN, () => 5000);
    for (let i = 0; i < HOLDER_LOOKUPS_PER_MIN; i++) expect(await check(rndKey())).toBe('not_holder');
    expect(await check(rndKey())).toBe('unknown');
    expect(read).toHaveBeenCalledTimes(HOLDER_LOOKUPS_PER_MIN);
    expect(stats.throttled).toBe(1);
  });
});

describe('config', () => {
  const env = { PAYTO_ADDRESS: PAYTO, PUMPWIRE_DB_PATH: ':memory:' };
  it('tier off by default; on with mint + RPC; fails fast on a bad mint or a missing RPC', () => {
    expect(loadConfig(env).pwireMint).toBeNull();
    const on = loadConfig({ ...env, PWIRE_MINT: PWIRE, SOLANA_RPC_URL: 'http://rpc.invalid' });
    expect(on.pwireMint).toBe(PWIRE);
    expect(on.pwireTierMinBalance).toBe(MIN);
    expect(() => loadConfig({ ...env, PWIRE_MINT: 'not base58!', SOLANA_RPC_URL: 'http://rpc.invalid' })).toThrow(/PWIRE_MINT/);
    expect(() => loadConfig({ ...env, PWIRE_MINT: PWIRE })).toThrow(/SOLANA_RPC_URL/);
    expect(() => loadConfig({ ...env, PWIRE_TIER_MIN_BALANCE: '0' })).toThrow(/PWIRE_TIER_MIN_BALANCE/);
  });
});
