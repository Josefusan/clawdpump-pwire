// Second trade source (T-028): pump.fun program events straight from Solana RPC `logsSubscribe`.
// pump.fun emits anchor events as `Program data: <base64>` log lines; decoding them needs no API key and no per-mint
// subscription, so this replaces PumpPortal's paid `subscribeTokenTrade`. Pure decoders here; the socket lives in
// LogsSource. Everything decoded is validated with the same sanitizers as the PumpPortal path (never trust logs).
import { createHash } from 'node:crypto';
import { LIMITS, cleanText, isAddress, isSig } from './sanitize.js';
import type { ParsedCreate, ParsedMigrate, ParsedTrade } from './parse.js';
import { backoffMs } from './backoff.js';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PROGRAM_DATA = 'Program data: ';
const MAX_LOG_LINE = 4096;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Minimal base58 (bitcoin alphabet) for 32-byte keys; no dependency needed. */
export function base58(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const b of bytes) {
    let carry = b;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const b of bytes) { if (b !== 0) break; out += '1'; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]!];
  return out;
}

const disc = (name: string) => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8).toString('hex');
export const DISCRIMINATOR = { TradeEvent: disc('TradeEvent'), CreateEvent: disc('CreateEvent'), CompleteEvent: disc('CompleteEvent') } as const;

export type LogEvent =
  | (ParsedTrade & { ts: number })
  | (ParsedCreate & { ts: number })
  | (ParsedMigrate & { ts: number });

class Reader {
  off = 8; // past the discriminator
  constructor(private readonly b: Buffer) {}
  get remaining() { return this.b.length - this.off; }
  pubkey(): string { if (this.remaining < 32) throw new RangeError('short'); const s = base58(this.b.subarray(this.off, this.off + 32)); this.off += 32; return s; }
  u64(): number { if (this.remaining < 8) throw new RangeError('short'); const v = this.b.readBigUInt64LE(this.off); this.off += 8; if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('u64 too large'); return Number(v); }
  i64(): number { if (this.remaining < 8) throw new RangeError('short'); const v = this.b.readBigInt64LE(this.off); this.off += 8; if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('i64 out of range'); return Number(v); }
  bool(): boolean { if (this.remaining < 1) throw new RangeError('short'); const v = this.b[this.off]!; this.off += 1; if (v > 1) throw new RangeError('bad bool'); return v === 1; }
  str(max: number): string { if (this.remaining < 4) throw new RangeError('short'); const n = this.b.readUInt32LE(this.off); this.off += 4; if (n > max || this.remaining < n) throw new RangeError('bad string'); const s = this.b.subarray(this.off, this.off + n).toString('utf8'); this.off += n; return s; }
}

const sane = (ts: number) => ts > 1_600_000_000 && ts < 4_000_000_000;

/**
 * Decode one `Program data:` payload (already base64-decoded) into a typed message, or null when it is not one of
 * ours or fails validation. Layouts from the pump.fun IDL; only the leading fixed fields are read, so appended
 * fields in newer program versions do not break decoding.
 */
export function decodeEvent(data: Buffer, sig: string): LogEvent | null {
  if (data.length < 8 || !isSig(sig)) return null;
  const d = data.subarray(0, 8).toString('hex');
  try {
    const r = new Reader(data);
    if (d === DISCRIMINATOR.TradeEvent) {
      // mint, sol_amount u64, token_amount u64, is_buy bool, user, timestamp i64, ...
      const mint = r.pubkey(); const lamports = r.u64(); const tokenAmount = r.u64(); const isBuy = r.bool(); const wallet = r.pubkey(); const ts = r.i64();
      if (!isAddress(mint) || !isAddress(wallet) || !sane(ts)) return null;
      return { kind: 'trade', side: isBuy ? 'buy' : 'sell', mint, wallet, sig, lamports, tokenAmount, ts };
    }
    if (d === DISCRIMINATOR.CreateEvent) {
      // name string, symbol string, uri string, mint, bonding_curve, user, creator, timestamp i64, ...
      const name = r.str(LIMITS.name * 4); const symbol = r.str(LIMITS.symbol * 4); const uri = r.str(LIMITS.uri * 4);
      const mint = r.pubkey(); r.pubkey(); const deployer = r.pubkey(); r.pubkey(); const ts = r.i64();
      if (!isAddress(mint) || !isAddress(deployer) || !sane(ts)) return null;
      return { kind: 'create', mint, deployer, signature: sig, name: cleanText(name, LIMITS.name), symbol: cleanText(symbol, LIMITS.symbol, true), uri: cleanText(uri, LIMITS.uri), hasSocials: null, ts };
    }
    if (d === DISCRIMINATOR.CompleteEvent) {
      // user, mint, bonding_curve, timestamp i64
      r.pubkey(); const mint = r.pubkey(); r.pubkey(); const ts = r.i64();
      if (!isAddress(mint) || !sane(ts)) return null;
      return { kind: 'migrate', mint, ts };
    }
  } catch {
    return null; // short / malformed payload: skip silently, the caller counts it
  }
  return null;
}

export interface LogsBatch { slot: number; sig: string; events: LogEvent[]; failed: boolean }

/** Parse one raw `logsNotification` frame. Returns null for anything that is not a well-formed notification. */
export function parseLogsNotification(raw: string): LogsBatch | null {
  if (raw.length > 1024 * 1024) return null;
  let m: any;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || m.method !== 'logsNotification') return null;
  const slot = m.params?.result?.context?.slot;
  const v = m.params?.result?.value;
  if (!Number.isSafeInteger(slot) || !v || typeof v.signature !== 'string' || !Array.isArray(v.logs)) return null;
  const sig: string = v.signature;
  const out: LogsBatch = { slot, sig, events: [], failed: v.err != null };
  if (out.failed || !isSig(sig)) return out; // failed txs emit no state change; still counted by the caller
  for (const line of v.logs) {
    if (typeof line !== 'string' || line.length > MAX_LOG_LINE || !line.startsWith(PROGRAM_DATA)) continue;
    const ev = decodeEvent(Buffer.from(line.slice(PROGRAM_DATA.length), 'base64'), sig);
    if (ev) out.events.push(ev);
  }
  return out;
}

/** `SOLANA_WS_URL` or derive from an http(s) RPC URL. Never log the result: it may embed a key. */
export function wsUrlFrom(env: Record<string, string | undefined>): string | null {
  if (env.SOLANA_WS_URL) return env.SOLANA_WS_URL;
  const rpc = env.SOLANA_RPC_URL;
  if (!rpc) return null;
  if (rpc.startsWith('https://')) return 'wss://' + rpc.slice(8);
  if (rpc.startsWith('http://')) return 'ws://' + rpc.slice(7);
  return null;
}

export interface LogsCounters { frames: number; notifications: number; failed_tx: number; events: number; reconnects: number }

/** Thin socket wrapper: one logsSubscribe on the pump.fun program, reconnect with backoff, batches to a callback. */
export class LogsSource {
  readonly counters: LogsCounters = { frames: 0, notifications: 0, failed_tx: 0, events: 0, reconnects: 0 };
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: string, private readonly onBatch: (b: LogsBatch) => void, private readonly log: (s: string) => void = console.log) {}

  start(): void { this.stopped = false; this.connect(); }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.log('ingest: logs socket open (pump.fun program)');
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'confirmed' }] }));
    };
    ws.onmessage = (ev) => {
      this.attempt = 0;
      this.counters.frames++;
      if (typeof ev.data !== 'string') return;
      const b = parseLogsNotification(ev.data);
      if (!b) return;
      this.counters.notifications++;
      if (b.failed) { this.counters.failed_tx++; return; }
      this.counters.events += b.events.length;
      if (b.events.length) this.onBatch(b);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.stopped) return;
      const wait = backoffMs(this.attempt++, Math.random());
      this.counters.reconnects++;
      this.log(`ingest: logs socket closed, reconnect in ${wait}ms`);
      this.timer = setTimeout(() => this.connect(), wait);
    };
  }
}
