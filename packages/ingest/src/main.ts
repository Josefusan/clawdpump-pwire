import { openDb, Store } from './db.js';
import { Pipeline } from './pipeline.js';
import { SlotClock, fetchSlot } from './slot.js';
import { backoffMs } from './backoff.js';
import { EnrichQueue, resolveApiKey } from './enrich.js';
import { TrackedSet, parseMaxTracked } from './tracked.js';

const WS_URL = process.env.PUMPPORTAL_WS_URL ?? 'wss://pumpportal.fun/api/data';
const DB_PATH = process.env.PUMPWIRE_DB_PATH ?? process.env.DB_PATH;
const RPC_URL = process.env.SOLANA_RPC_URL; // may embed a key: never logged
const WINDOW_MS = (Number(process.env.INGEST_TRADE_WINDOW_MIN) || 30) * 60_000;
const MAX_TRACKED = parseMaxTracked(process.env.INGEST_MAX_TRACKED);
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
const tracked = new TrackedSet(MAX_TRACKED); // mint -> expiry ms, capped, LRU-evicting
let evictionLogged = false;

let ws: WebSocket | null = null;
let attempt = 0;
let pending: string[] = [];

const send = (o: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
const sendKeys = (method: string, keys: string[]) => {
  for (let i = 0; i < keys.length; i += KEY_CHUNK) send({ method, keys: keys.slice(i, i + KEY_CHUNK) });
};

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
    for (const m of fx.subscribe) {
      const evicted = tracked.add(m, now + WINDOW_MS);
      pending.push(m);
      if (evicted.length) {
        if (!evictionLogged) {
          evictionLogged = true;
          console.log(`ingest: INGEST_MAX_TRACKED=${MAX_TRACKED} reached, evicting least-recently-active mints (logged once)`);
        }
        pending = pending.filter((p) => !evicted.includes(p));
        sendKeys('unsubscribeTokenTrade', evicted);
      }
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

setInterval(() => {
  if (pending.length) {
    sendKeys('subscribeTokenTrade', pending);
    pending = [];
  }
}, 1000);

setInterval(() => {
  const now = Date.now();
  const expired = tracked.expire(now);
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

setInterval(() => console.log('ingest: stats', JSON.stringify({ ...pipe.counters, tracked: tracked.size, enrich_depth: enrich.depth, enrich: enrich.counters })), 10_000);

const stop = () => {
  console.log('ingest: stopping', JSON.stringify(pipe.counters));
  stopEnrich();
  db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

connect();
