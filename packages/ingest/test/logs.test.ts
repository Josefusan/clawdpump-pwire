import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { base58, decodeEvent, parseLogsNotification, wsUrlFrom, DISCRIMINATOR } from '../src/logs.js';
import { Store } from '../src/db.js';
import { Pipeline } from '../src/pipeline.js';
import { SlotClock } from '../src/slot.js';

// Real mainnet events captured 2026-10-01 from the public RPC logsSubscribe (fixtures/pumpfun-logs/events.json).
const FX = JSON.parse(readFileSync(new URL('../../../fixtures/pumpfun-logs/events.json', import.meta.url), 'utf8')) as Record<string, { slot: number; signature: string; data: string; logs: string[] }>;
const buf = (k: string) => Buffer.from(FX[k]!.data, 'base64');
const notif = (k: string, extra: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { result: { context: { slot: FX[k]!.slot }, value: { signature: FX[k]!.signature, err: null, logs: FX[k]!.logs, ...extra } }, subscription: 1 } });
const SCHEMA = readFileSync(new URL('../../../docs/schema.sql', import.meta.url), 'utf8');

describe('base58', () => {
  it('round-trips the pump.fun program id', () => {
    const bytes = Buffer.from('01b3c2f8c5e5d4a1b3c2f8c5e5d4a1b3c2f8c5e5d4a1b3c2f8c5e5d4a1b3c2f8', 'hex');
    expect(base58(bytes)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(base58(new Uint8Array(32))).toBe('1'.repeat(32));
    expect(base58(Buffer.from([0, 0, 1]))).toBe('112');
  });
});

describe('decodeEvent (pump.fun anchor events)', () => {
  it('discriminators are sha256("event:<Name>")[0..8]', () => {
    expect(DISCRIMINATOR.TradeEvent).toBe('bddb7fd34ee661ee');
  });
  it('TradeEvent → trade with base units, side, wallet, timestamp', () => {
    const ev = decodeEvent(buf('trade'), FX.trade!.signature);
    expect(ev).toMatchObject({ kind: 'trade', sig: FX.trade!.signature });
    if (!ev || ev.kind !== 'trade') throw new Error('not a trade');
    expect(['buy', 'sell']).toContain(ev.side);
    expect(ev.mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(ev.wallet).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(ev.lamports).toBeGreaterThan(0);
    expect(ev.tokenAmount).toBeGreaterThan(0);
    expect(ev.ts).toBeGreaterThan(1_780_000_000); // 2026
  });
  it('CreateEvent → create with sanitized metadata and deployer', () => {
    const ev = decodeEvent(buf('create'), FX.create!.signature);
    expect(ev).toMatchObject({ kind: 'create', signature: FX.create!.signature, hasSocials: null });
    if (!ev || ev.kind !== 'create') throw new Error('not a create');
    expect(ev.mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(ev.deployer).not.toBe(ev.mint);
    expect(typeof ev.name).toBe('string');
    expect(ev.symbol!.length).toBeLessThanOrEqual(16);
  });
  it('CompleteEvent → migrate', () => {
    expect(decodeEvent(buf('complete'), FX.complete!.signature)).toMatchObject({ kind: 'migrate' });
  });
  it('rejects unknown discriminators, truncated payloads and bad signatures without throwing', () => {
    expect(decodeEvent(Buffer.alloc(8, 0xaa), FX.trade!.signature)).toBeNull();
    expect(decodeEvent(buf('trade').subarray(0, 60), FX.trade!.signature)).toBeNull();
    expect(decodeEvent(buf('trade'), 'not-a-signature')).toBeNull();
    const bad = Buffer.from(buf('trade')); bad[8 + 32 + 8 + 8] = 7; // is_buy must be 0/1
    expect(decodeEvent(bad, FX.trade!.signature)).toBeNull();
  });
});

describe('parseLogsNotification', () => {
  it('extracts slot, signature and events from a real notification', () => {
    const b = parseLogsNotification(notif('trade'))!;
    expect(b.slot).toBe(FX.trade!.slot);
    expect(b.failed).toBe(false);
    expect(b.events.map((e) => e.kind)).toContain('trade');
  });
  it('failed transactions yield no events', () => {
    const b = parseLogsNotification(notif('trade', { err: { InstructionError: [2, 'Custom'] } }))!;
    expect(b.failed).toBe(true);
    expect(b.events).toHaveLength(0);
  });
  it('ignores subscription acks, garbage and oversized frames', () => {
    expect(parseLogsNotification('{"jsonrpc":"2.0","result":1,"id":1}')).toBeNull();
    expect(parseLogsNotification('nope')).toBeNull();
    expect(parseLogsNotification('x'.repeat(1024 * 1024 + 1))).toBeNull();
  });
});

describe('wsUrlFrom', () => {
  it('prefers SOLANA_WS_URL, else derives wss from https', () => {
    expect(wsUrlFrom({ SOLANA_WS_URL: 'wss://a/ws', SOLANA_RPC_URL: 'https://b' })).toBe('wss://a/ws');
    expect(wsUrlFrom({ SOLANA_RPC_URL: 'https://rpc.example/?api-key=x' })).toBe('wss://rpc.example/?api-key=x');
    expect(wsUrlFrom({})).toBeNull();
  });
});

describe('Pipeline.handleParsed with log events', () => {
  it('writes create then trade rows with the real slot and event timestamp', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA);
    const pipe = new Pipeline(new Store(db), new SlotClock());
    const create = decodeEvent(buf('create'), FX.create!.signature)!;
    const fx1 = pipe.handleParsed(create, FX.create!.slot, create.ts);
    expect(fx1.subscribe).toEqual([create.mint]);
    // a trade on that same mint (rewrite the fixture trade's mint for the test)
    const trade = { ...decodeEvent(buf('trade'), FX.trade!.signature)!, mint: create.mint } as any;
    const fx2 = pipe.handleParsed(trade, FX.trade!.slot, trade.ts);
    expect(pipe.counters.trades).toBe(1);
    expect(db.prepare('SELECT slot, ts FROM trades').get()).toEqual({ slot: FX.trade!.slot, ts: trade.ts });
    if (trade.side === 'buy') expect(fx2.enrich.map((e) => e.wallet)).toContain(trade.wallet);
    // duplicate signature is a no-op
    pipe.handleParsed(trade, FX.trade!.slot, trade.ts);
    expect(pipe.counters.duplicates).toBe(1);
  });
});
