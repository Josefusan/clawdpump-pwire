import { openDb, Store } from './db.js';
import { Pipeline } from './pipeline.js';
import { SlotClock, fetchSlot } from './slot.js';
import { backoffMs } from './backoff.js';
import { EnrichQueue, resolveApiKey } from './enrich.js';
import { LogsSource, wsUrlFrom } from './logs.js';

const WS_URL = process.env.PUMPPORTAL_WS_URL ?? 'wss://pumpportal.fun/api/data';
const DB_PATH = process.env.PUMPWIRE_DB_PATH ?? process.env.DB_PATH;
const RPC_URL = process.env.SOLANA_RPC_URL; // may embed a key: never logged
const WINDOW_MS = (Number(process.env.INGEST_TRADE_WINDOW_MIN) || 30) * 60_000;
const MAX_TRACKED = 5000;
// Trade source (T-028): 'logs' decodes pump.fun events from Solana RPC logsSubscribe (no API key, one subscription);
// 'pumpportal' uses subscribeTokenTrade (needs a funded PumpPortal key). Default: logs when a WS/RPC URL is set.
const LOGS_WS_URL = wsUrlFrom(process.env);
const TRADE_SOURCE = process.env.INGEST_TRADE_SOURCE ?? (LOGS_WS_URL ? 'logs' : 'pumpportal');
if (TRADE_SOURCE !== 'logs' && TRADE_SOURCE !== 'pumpportal') {
  console.error('ingest: INGEST_TRADE_SOURCE must be logs or pumpportal');
  process.exit(1);
}
if (TRADE_SOURCE === 'logs' && !LOGS_WS_URL) {
  console.error('ingest: INGEST_TRADE_SOURCE=logs needs SOLANA_WS_URL or SOLANA_RPC_URL');
  process.exit(1);
}
const KEY_CHUNK = 100;

if (!DB_PATH) {
  console.error('ingest: set PUMPWIRE_DB_PATH (or DB_PATH)');
  process.exit(1);
}

const db = openDb(DB_PATH);
const clock = new SlotClock();
const pipe = new Pipeline(new Store(db), clock);
const enrich = new EnrichQueue(db, { apiKey: resolveApiKey(process.env), rps: Number(process.env.ENRICH_RPS) || undefined });
const stopEnrich = enrich.start();
const tracked = new Map<string, number>(); // mint -> expiry ms (bounded)

let ws: WebSocket | null = null;
let attempt = 0;
let pending: string[] = [];

const send = (o: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
const sendKeys = (method: string, keys: string[]) => {
  if (TRADE_SOURCE !== 'pumpportal') return; // trades come from logs; never ask PumpPortal for them
  for (let i = 0; i < keys.length; i += KEY_CHUNK) send({ method, keys: keys.slice(i, i + KEY_CHUNK) });
};

/** Apply a batch of decoded pump.fun log events: creates/migrations always, trades only for tracked (recent) mints. */
function applyLogs(b: { slot: number; events: { kind: string; mint: string; ts: number }[] }): void {
  const now = Date.now();
  for (const ev of b.events) {
    if (ev.kind === 'trade' && !tracked.has(ev.mint)) continue;
    const fx = pipe.handleParsed(ev as never, b.slot, ev.ts);
    for (const m of fx.subscribe) if (tracked.size < MAX_TRACKED) tracked.set(m, now + WINDOW_MS);
    for (const e of fx.enrich) enrich.enqueue(e.wallet, e.priority);
    for (const m of fx.unsubscribe) tracked.delete(m);
  }
}
const logs = TRADE_SOURCE === 'logs' && LOGS_WS_URL ? new LogsSource(LOGS_WS_URL, applyLogs) : null;

function connect(): void {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    console.log(`ingest: socket open (trade source: ${TRADE_SOURCE})`);
    send({ method: 'subscribeNewToken' });
    send({ method: 'subscribeMigration' });
    sendKeys('subscribeTokenTrade', [...tracked.keys()]); // resubscribe after reconnect
  };
  ws.onmessage = (ev) => {
    attempt = 0;
    if (typeof ev.data !== 'string') return;
    const fx = pipe.handle(ev.data);
    const now = Date.now();
    for (const m of fx.subscribe) {
      if (tracked.size >= MAX_TRACKED) break;
      tracked.set(m, now + WINDOW_MS);
      pending.push(m);
    }
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

setInterval(() => {
  if (pending.length) {
    sendKeys('subscribeTokenTrade', pending);
    pending = [];
  }
}, 1000);

setInterval(() => {
  const now = Date.now();
  const expired = [...tracked].filter(([, exp]) => exp <= now).map(([m]) => m);
  expired.forEach((m) => tracked.delete(m));
  sendKeys('unsubscribeTokenTrade', expired);
}, 60_000);

if (RPC_URL) {
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

connect();
logs?.start();
