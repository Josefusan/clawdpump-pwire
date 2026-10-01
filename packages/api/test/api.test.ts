import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { createApp, memoFor, type Backend } from '../src/app.js';
import { base58Decode, base58Encode, isBase58Pubkey } from '../src/base58.js';
import { applySchema, claimPayment, markFailed, setTxSig, STALE_PENDING_S } from '../src/calls.js';
import type { Config } from '../src/config.js';
import { MEMO_PROGRAMS } from '../src/tx.js';

const MEMO_PROGRAM = [...MEMO_PROGRAMS][0]!;
const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const rndKey = () => base58Encode(randomBytes(32));
const PAYTO = rndKey();
const FEE_PAYER = rndKey();
const PAYER = rndKey();

const cfg: Config = {
  port: 0, dbPath: ':memory:', network: NETWORK, facilitatorUrl: 'http://mock.invalid', payTo: PAYTO,
  usdcMint: USDC, maxTimeoutS: 60, rateLimitPerMin: 1000, firstPartyWallets: [],
};

const shortvec = (n: number) => Buffer.from([n]); // all counts here are < 128

/** Minimal v0 wire tx: fee payer, memo program, one Memo ix per entry in `memos`. */
function buildTx(memos: string[], salt = randomBytes(8)): string {
  const keys = [base58Decode(FEE_PAYER)!, base58Decode(MEMO_PROGRAM)!, base58Decode(PAYER)!];
  const ixs = memos.map((m) => {
    const data = Buffer.from(m, 'utf8');
    return Buffer.concat([Buffer.from([1]), shortvec(0), shortvec(data.length), data]);
  });
  const wire = Buffer.concat([
    shortvec(1), Buffer.alloc(64, 7),
    Buffer.from([0x80, 1, 0, 1]),
    shortvec(keys.length), ...keys.map((k) => Buffer.from(k)),
    Buffer.concat([randomBytes(24), salt]), // blockhash (unique per tx)
    shortvec(ixs.length), ...ixs,
  ]);
  return wire.toString('base64');
}

function reqs(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact', network: NETWORK as PaymentRequirements['network'], asset: USDC, amount: '10000',
    payTo: PAYTO, maxTimeoutSeconds: 60, extra: {}, ...over,
  };
}

const payHeader = (tx: string, over: Partial<PaymentRequirements> = {}) =>
  encodePaymentSignatureHeader({ x402Version: 2, accepted: reqs(over), payload: { transaction: tx } });

let db: DatabaseSync;
let server: Server;
let base: string;
let mint: string;
let backend: { verify: ReturnType<typeof vi.fn>; settle: ReturnType<typeof vi.fn>; getSupported: ReturnType<typeof vi.fn> };
let scoreFn: ReturnType<typeof vi.fn>;
let sigN = 0;

const callRows = () => db.prepare('SELECT * FROM calls').all() as Record<string, unknown>[];
const get = (path: string, header?: string) =>
  fetch(base + path, { headers: header ? { 'PAYMENT-SIGNATURE': header } : {} });

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  applySchema(db);
  mint = rndKey();
  db.prepare('INSERT INTO tokens (mint, deployer, created_slot, created_at) VALUES (?, ?, ?, ?)').run(mint, rndKey(), 300, 1_790_000_000);
  backend = {
    verify: vi.fn(async () => ({ isValid: true, payer: PAYER })),
    settle: vi.fn(async () => ({ success: true, transaction: `sig${++sigN}`, network: NETWORK as PaymentRequirements['network'] })),
    getSupported: vi.fn(async () => ({
      kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK as PaymentRequirements['network'], extra: { feePayer: FEE_PAYER } }],
      extensions: [], signers: {},
    })),
  };
  scoreFn = vi.fn((_db, m: string, now: number) => ({
    mint: m, score: 0, verdict: 'LOW' as const, reasons: [], data_gaps: [], model_version: 'v0.0.0-stub', as_of_slot: 300, as_of_ts: now,
  }));
  const app = createApp({ db, backend: backend as unknown as Backend, cfg, score: scoreFn as never });
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('free routes', () => {
  it('/health and /v1/stats respond without payment', async () => {
    expect((await get('/health')).status).toBe(200);
    const s = await (await get('/v1/stats')).json();
    expect(s.totals.paid_calls).toBe(0);
    expect(s.last_calls).toEqual([]);
  });
});

describe('free-path validation (never charged)', () => {
  it('400 on bad mint, 404 on unknown mint', async () => {
    expect((await get('/v1/risk/not-a-mint!')).status).toBe(400);
    expect((await get(`/v1/risk/${rndKey()}`)).status).toBe(404);
  });
});

describe('402 path', () => {
  it('unpaid → 402 PaymentRequired with memo-bound requirements; no row', async () => {
    const res = await get(`/v1/risk/${mint}`);
    expect(res.status).toBe(402);
    expect(res.headers.get('payment-required')).toBeTruthy();
    const body = await res.json();
    expect(body.x402Version).toBe(2);
    expect(body.error).toBe('PAYMENT_REQUIRED');
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0]).toMatchObject({
      scheme: 'exact', network: NETWORK, amount: '10000', asset: USDC, payTo: PAYTO, maxTimeoutSeconds: 60,
      extra: { feePayer: FEE_PAYER, memo: `pumpwire:rug_risk_score:${mint}` },
    });
    expect(callRows()).toHaveLength(0);
  });
});

describe('paid path', () => {
  it('valid payment → 200 RiskResult + calls row', async () => {
    const res = await get(`/v1/risk/${mint}`, payHeader(buildTx([memoFor(mint)])));
    expect(res.status).toBe(200);
    expect(res.headers.get('payment-response')).toBeTruthy();
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ['as_of_slot', 'as_of_ts', 'data_gaps', 'mint', 'model_version', 'reasons', 'score', 'verdict'],
    );
    expect(body.mint).toBe(mint);
    const rows = callRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: 'rug_risk_score', arg: mint, payer: PAYER, asset: USDC, amount: 10000, status: 'served',
      first_party: 0, tx_sig: 'sig' + sigN,
    });
    expect(typeof rows[0]!.latency_ms).toBe('number');
    expect(backend.settle).toHaveBeenCalledTimes(1);
    const stats = await (await get('/v1/stats')).json();
    expect(stats.totals).toMatchObject({ paid_calls: 1, paid_calls_third_party: 1, usdc_paid: '0.010000' });
  });
});

describe('rejections (no row, no settle)', () => {
  const cases: [string, Partial<PaymentRequirements>][] = [
    ['wrong amount', { amount: '9999' }],
    ['wrong asset', { asset: rndKey() }],
    ['wrong network', { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as PaymentRequirements['network'] }],
    ['wrong payTo', { payTo: rndKey() }],
  ];
  for (const [name, over] of cases) {
    it(name, async () => {
      const res = await get(`/v1/risk/${mint}`, payHeader(buildTx([memoFor(mint)]), over));
      expect(res.status).toBe(402);
      expect((await res.json()).error).toBe('PAYMENT_INVALID');
      expect(callRows()).toHaveLength(0);
      expect(backend.settle).not.toHaveBeenCalled();
    });
  }

  it('wrong mint: memo bound to another mint', async () => {
    const other = rndKey();
    const res = await get(`/v1/risk/${mint}`, payHeader(buildTx([memoFor(other)])));
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('PAYMENT_INVALID');
    expect(callRows()).toHaveLength(0);
  });

  it('missing memo, duplicate memo, near-miss memo', async () => {
    for (const memos of [[], [memoFor(mint), memoFor(mint)], [memoFor(mint) + ' '], [memoFor(mint).toUpperCase()]]) {
      const res = await get(`/v1/risk/${mint}`, payHeader(buildTx(memos)));
      expect(res.status).toBe(402);
      expect((await res.json()).error).toBe('PAYMENT_INVALID');
    }
    expect(callRows()).toHaveLength(0);
    expect(backend.verify).not.toHaveBeenCalled();
  });

  it('facilitator says invalid → 402, no row', async () => {
    backend.verify.mockResolvedValueOnce({ isValid: false, invalidReason: 'insufficient_funds' });
    const res = await get(`/v1/risk/${mint}`, payHeader(buildTx([memoFor(mint)])));
    expect(res.status).toBe(402);
    expect(callRows()).toHaveLength(0);
  });

  it('garbage header', async () => {
    const res = await get(`/v1/risk/${mint}`, 'not-base64-json');
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('PAYMENT_INVALID');
  });
});

describe('replay protection', () => {
  it('same payment twice: second is an idempotent re-serve, not a second spend', async () => {
    const h = payHeader(buildTx([memoFor(mint)]));
    const a = await get(`/v1/risk/${mint}`, h);
    const b = await get(`/v1/risk/${mint}`, h);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual(await a.json());
    expect(callRows()).toHaveLength(1);
    expect(backend.settle).toHaveBeenCalledTimes(1);
    expect(scoreFn).toHaveBeenCalledTimes(1);
  });

  it('concurrent identical payments: exactly one wins, the other is PAYMENT_REPLAYED', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    backend.settle.mockImplementationOnce(async () => {
      await gate;
      return { success: true, transaction: 'sigC', network: NETWORK };
    });
    const h = payHeader(buildTx([memoFor(mint)]));
    const first = get(`/v1/risk/${mint}`, h);
    await vi.waitFor(() => expect(backend.settle).toHaveBeenCalledTimes(1)); // first holds the claim
    const second = await get(`/v1/risk/${mint}`, h);
    expect(second.status).toBe(402);
    expect((await second.json()).error).toBe('PAYMENT_REPLAYED');
    release();
    expect((await first).status).toBe(200);
    expect(callRows()).toHaveLength(1);
    expect(backend.settle).toHaveBeenCalledTimes(1);
    expect(scoreFn).toHaveBeenCalledTimes(1);
  });

  it('a payment claimed for one resource cannot be replayed for another (claim level)', () => {
    const base = { ts: 1000, tool: 'rug_risk_score', payer: PAYER, network: NETWORK, asset: USDC, amount: 10000, paymentId: 'p1', firstParty: false };
    expect(claimPayment(db, { ...base, arg: mint }).kind).toBe('claimed');
    expect(claimPayment(db, { ...base, arg: rndKey() }).kind).toBe('replayed');
    expect(claimPayment(db, { ...base, tool: 'deployer_history', arg: mint }).kind).toBe('replayed');
    expect(callRows()).toHaveLength(1);
  });
});

describe('retry semantics for a claimed-but-failed call (INTERFACES §7)', () => {
  it('scoring failure: nothing settled; retry with the SAME payment succeeds and settles once', async () => {
    const h = payHeader(buildTx([memoFor(mint)]));
    scoreFn.mockImplementationOnce(() => { throw new Error('boom'); });
    const a = await get(`/v1/risk/${mint}`, h);
    expect(a.status).toBe(500);
    expect(backend.settle).not.toHaveBeenCalled();
    expect(callRows()[0]).toMatchObject({ status: 'failed', tx_sig: null });
    const b = await get(`/v1/risk/${mint}`, h);
    expect(b.status).toBe(200);
    expect(backend.settle).toHaveBeenCalledTimes(1);
    expect(callRows()).toHaveLength(1);
    expect(callRows()[0]).toMatchObject({ status: 'served' });
  });

  it('settle failure → failed row, retry re-settles (no tx_sig yet)', async () => {
    const h = payHeader(buildTx([memoFor(mint)]));
    backend.settle.mockResolvedValueOnce({ success: false, errorReason: 'nope', transaction: '', network: NETWORK });
    expect((await get(`/v1/risk/${mint}`, h)).status).toBe(402);
    expect(callRows()[0]).toMatchObject({ status: 'failed' });
    expect((await get(`/v1/risk/${mint}`, h)).status).toBe(200);
    expect(backend.settle).toHaveBeenCalledTimes(2);
  });

  it('a row with tx_sig set is never re-settled on retry', () => {
    const c = { ts: 1000, tool: 'rug_risk_score', arg: mint, payer: PAYER, network: NETWORK, asset: USDC, amount: 10000, paymentId: 'p2', firstParty: false };
    const claimed = claimPayment(db, c);
    if (claimed.kind !== 'claimed') throw new Error('expected claim');
    expect(setTxSig(db, claimed.id, 'settledSig')).toBe(true);
    markFailed(db, claimed.id);
    const retry = claimPayment(db, { ...c, ts: 1001 });
    expect(retry).toEqual({ kind: 'retry', id: claimed.id, settled: true });
    expect(claimPayment(db, { ...c, ts: 1002 }).kind).toBe('replayed'); // takeover is exclusive
  });

  it('stale pending (> 120 s) can be taken over, fresh pending cannot', () => {
    const c = { ts: 1000, tool: 'rug_risk_score', arg: mint, payer: PAYER, network: NETWORK, asset: USDC, amount: 10000, paymentId: 'p3', firstParty: false };
    claimPayment(db, c);
    expect(claimPayment(db, { ...c, ts: 1000 + STALE_PENDING_S - 1 }).kind).toBe('replayed');
    expect(claimPayment(db, { ...c, ts: 1000 + STALE_PENDING_S }).kind).toBe('retry');
  });
});

describe('base58', () => {
  it('validates 32-byte pubkeys only', () => {
    expect(isBase58Pubkey(rndKey())).toBe(true);
    expect(isBase58Pubkey('0OIl' + 'a'.repeat(30))).toBe(false);
    expect(isBase58Pubkey('1'.repeat(50))).toBe(false);
    expect(isBase58Pubkey("x'; DROP TABLE calls;--")).toBe(false);
  });
});
