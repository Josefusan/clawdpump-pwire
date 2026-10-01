import { openDb, Store } from './db.js';
import { Pipeline } from './pipeline.js';
import { SlotClock, fetchSlot } from './slot.js';
import { backoffMs } from './backoff.js';
import { EnrichQueue, resolveApiKey } from './enrich.js';
import { TrackedSet, parseMaxTracked } from './tracked.js';
import { LogsSource, wsUrlFrom } from './logs.js';
import type { LogsBatch } from './logs.js';

const WS_URL = process.env.PUMPPORTAL_WS_URL ?? 'wss://pumpportal.fun/api/data';
const DB_PATH = process.env.PUMPWIRE_DB_PATH ?? process.env.DB_PATH;
const RPC_URL = process.env.SOLANA_RPC_URL; // may embed a key: never logged
const WINDOW_MS = (Number(process.env.INGEST_TRADE_WINDOW_MIN) || 30) * 60_000;
const MAX_TRACKED = parseMaxTracked(process.env.INGEST_MAX_TRACKED);
const KEY_CHUNK = 100;
// Source (T-028). 'logs' (default): creates, trades and migrations decoded from pump.fun program events over Solana
// mainnet logsSubscribe; exact slots, no API key, one subscription, PumpPortal not used at all. 'pumpportal': the
// original feed, whose subscribeTokenTrade needs a funded PumpPortal key.
const TRADE_SOURCE = process.env.INGEST_TRADE_SOURCE ?? 'logs';
if (TRADE_SOURCE !== 'logs' && TRADE_SOURCE !== 'pumpportal') {
  console.error('ingest: INGEST_TRADE_SOURCE must be logs or pumpportal');
  process.exit(1);
}

if (!DB_PATH) {
  console.error('ingest: set PUMPWIRE_DB_PATH (or DB_PATH)');
  process.exit(1);
}

const db = openDb(DB_PATH);
const clock = new SlotClock();
const pipe = new Pipeline(new Store(db), clock);
const enrich = new EnrichQueue(db, { apiKey: resolveApiKey(process.env), rps: Number(process.env.ENRICH_RPS) || undefined });
const stopEnrich = enrich.start();
const tracked = new TrackedSet(MAX_TRACKED); // mint -> expiry ms, capped, LRU-evicting
let evictionLogged = false;

let ws: WebSocket | null = null;
let attempt = 0;
let pending: string[] = [];

const send = (o: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
const sendKeys = (method: string, keys: string[]) => {
  for (let i = 0; i < keys.length; i += KEY_CHUNK) send({ method, keys: keys.slice(i, i + KEY_CHUNK) });
};

function track(mints: string[], now: number): string[] {
  const evictedAll: string[] = [];
  for (const m of mints) {
    const evicted = tracked.add(m, now + WINDOW_MS);
    if (evicted.length) {
      if (!evictionLogged) {
        evictionLogged = true;
        console.log(`ingest: INGEST_MAX_TRACKED=${MAX_TRACKED} reached, evicting least-recently-active mints (logged once)`);
      }
      evictedAll.push(...evicted);
    }
  }
  return evictedAll;
}

/** logs source: creates/migrations always; trades only for tracked (recent, uncapped-out) mints. */
function applyLogs(b: LogsBatch): void {
  const now = Date.now();
  for (const ev of b.events) {
    if (ev.kind === 'trade' && !tracked.has(ev.mint)) continue;
    const fx = pipe.handleParsed(ev, b.slot, ev.ts);
    track(fx.subscribe, now);
    fx.active.forEach((m) => tracked.touch(m));
    for (const e of fx.enrich) enrich.enqueue(e.wallet, e.priority);
    fx.unsubscribe.forEach((m) => tracked.delete(m));
  }
}
const logs = TRADE_SOURCE === 'logs' ? new LogsSource(wsUrlFrom(process.env), applyLogs) : null;

/** pumpportal source: the original per-mint subscription feed. */
function connect(): void {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    console.log('ingest: socket open');
    send({ method: 'subscribeNewToken' });
    send({ method: 'subscribeMigration' });
    sendKeys('subscribeTokenTrade', tracked.keys()); // resubscribe after reconnect
  };
  ws.onmessage = (ev) => {
    attempt = 0;
    if (typeof ev.data !== 'string') return;
    const fx = pipe.handle(ev.data);
    const now = Date.now();
    const evicted = track(fx.subscribe, now);
    pending.push(...fx.subscribe);
    if (evicted.length) {
      pending = pending.filter((p) => !evicted.includes(p));
      sendKeys('unsubscribeTokenTrade', evicted);
    }
    fx.active.forEach((m) => tracked.touch(m));
    for (const e of fx.enrich) enrich.enqueue(e.wallet, e.priority);
    if (fx.unsubscribe.length) {
      fx.unsubscribe.forEach((m) => tracked.delete(m));
      sendKeys('unsubscribeTokenTrade', fx.unsubscribe);
    }
  };
  ws.onerror = () => {}; // onclose always follows
  ws.onclose = () => {
    const wait = backoffMs(attempt++, Math.random());
    console.log(`ingest: socket closed, reconnect in ${wait}ms`);
    setTimeout(connect, wait);
  };
}

if (!logs) {
  setInterval(() => {
    if (pending.length) {
      sendKeys('subscribeTokenTrade', pending);
      pending = [];
    }
  }, 1000);
}

setInterval(() => {
  const expired = tracked.expire(Date.now());
  if (!logs) sendKeys('unsubscribeTokenTrade', expired);
}, 60_000);

if (RPC_URL && !logs) {
  // pumpportal frames carry no slot: anchor the slot clock on the RPC (log events carry their exact slot instead)
  const sync = async () => {
    const s = await fetchSlot(RPC_URL);
    if (s !== null) clock.anchor(s, Date.now());
  };
  void sync();
  setInterval(() => void sync(), 15_000);
}

setInterval(() => console.log('ingest: stats', JSON.stringify({ ...pipe.counters, tracked: tracked.size, trade_source: TRADE_SOURCE, logs: logs?.counters ?? null, enrich_depth: enrich.depth, enrich: enrich.counters })), 10_000);

const stop = () => {
  console.log('ingest: stopping', JSON.stringify(pipe.counters));
  stopEnrich();
  logs?.stop();
  db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

if (logs) logs.start();
else connect();
