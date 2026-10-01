import { parseFrame } from './parse.js';
import type { Store } from './db.js';
import type { SlotClock } from './slot.js';

export interface Counters {
  frames: number;
  creates: number;
  trades: number;
  migrations: number;
  ignored: number;
  malformed: number;
  upstream_errors: number;
  duplicates: number;
  rows_tokens: number;
  rows_trades: number;
  rows_deployers: number;
  write_errors: number;
}

export const newCounters = (): Counters => ({
  frames: 0, creates: 0, trades: 0, migrations: 0, ignored: 0, malformed: 0,
  upstream_errors: 0, duplicates: 0, rows_tokens: 0, rows_trades: 0, rows_deployers: 0, write_errors: 0,
});

export interface Effects {
  subscribe: string[];   // newly created mints: subscribe to their trades
  unsubscribe: string[]; // migrated mints: stop trade subscription
  enrich: { wallet: string; priority: boolean }[]; // deployer (priority) + first-30 buyers
}

/** Socket-free core: raw frame in, DB rows + counters + subscription effects out. */
export class Pipeline {
  readonly counters = newCounters();

  constructor(private readonly store: Store, private readonly clock: SlotClock) {}

  handle(raw: string, nowMs: number = Date.now()): Effects {
    const fx: Effects = { subscribe: [], unsubscribe: [], enrich: [] };
    const c = this.counters;
    c.frames++;
    const msg = parseFrame(raw);
    if (msg.kind === 'ignored') c.ignored++;
    else if (msg.kind === 'malformed') c.malformed++;
    else if (msg.kind === 'error') c.upstream_errors++;
    else {
      try {
        const r = this.store.apply(msg, this.clock.now(nowMs), Math.floor(nowMs / 1000));
        if (msg.kind === 'create') c.creates++;
        else if (msg.kind === 'trade') c.trades++;
        else c.migrations++;
        c.rows_tokens += r.tokens;
        c.rows_trades += r.trades;
        c.rows_deployers += r.deployers;
        if (r.duplicate) c.duplicates++;
        if (msg.kind === 'create' && r.tokens === 1) fx.subscribe.push(msg.mint);
        if (msg.kind === 'create' && r.tokens === 1) fx.enrich.push({ wallet: msg.deployer, priority: true });
        if (msg.kind === 'trade' && msg.side === 'buy' && r.trades === 1 && this.store.isFirst30Buyer(msg.mint, msg.wallet)) {
          fx.enrich.push({ wallet: msg.wallet, priority: false });
        }
        if (msg.kind === 'migrate') fx.unsubscribe.push(msg.mint);
      } catch {
        c.write_errors++; // never log the message: it carries attacker-controlled text
      }
    }
    return fx;
  }
}
