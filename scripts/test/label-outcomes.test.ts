import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error plain ESM script without types
import { labelOutcomes, outcomeTs } from '../label-outcomes.mjs';
// @ts-expect-error plain ESM script without types
import { labelToken } from '../backtest.mjs';

const SCHEMA = readFileSync(new URL('../../docs/schema.sql', import.meta.url), 'utf8');
const b58 = (seed: string) => seed.repeat(44).slice(0, 44).replace(/[0OIl]/g, 'a');
const DEV = b58('D');
const NOW = 1_800_000_000;

function seeded() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const tok = db.prepare('INSERT INTO tokens (mint, deployer, created_slot, created_at, migrated) VALUES (?, ?, ?, ?, ?)');
  const tr = db.prepare('INSERT INTO trades (sig, mint, wallet, side, lamports, token_amount, slot, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  let n = 0;
  const trade = (mint: string, wallet: string, side: 'buy' | 'sell', amt: number, ts: number) => tr.run(`s${n++}`.padEnd(32, 'x'), mint, wallet, side, 1, amt, n, ts);
  // dead: created 3 h ago, last trade 10 min after launch
  tok.run(b58('DEAD'), DEV, 1, NOW - 10800, 0);
  trade(b58('DEAD'), b58('B1'), 'buy', 10, NOW - 10700);
  // dumped: deployer bought 100, sold 60 at +30 min
  tok.run(b58('DUMP'), DEV, 2, NOW - 10800, 0);
  trade(b58('DUMP'), DEV, 'buy', 100, NOW - 10790);
  trade(b58('DUMP'), DEV, 'sell', 20, NOW - 10000);
  trade(b58('DUMP'), DEV, 'sell', 40, NOW - 9000);
  trade(b58('DUMP'), b58('B2'), 'buy', 5, NOW - 100);
  // survived: created 2 days ago, trade after +24 h
  tok.run(b58('SURV'), DEV, 3, NOW - 172800, 0);
  trade(b58('SURV'), b58('B3'), 'buy', 5, NOW - 172700);
  trade(b58('SURV'), b58('B4'), 'buy', 5, NOW - 1000);
  // migrated: survived by definition
  tok.run(b58('MIGR'), DEV, 4, NOW - 10800, 1);
  // alive-undecided: created 3 h ago, last trade at +2 h (not dead, not 24 h yet)
  tok.run(b58('ALIV'), DEV, 5, NOW - 10800, 0);
  trade(b58('ALIV'), b58('B5'), 'buy', 5, NOW - 3600);
  // too young to judge
  tok.run(b58('YONG'), DEV, 6, NOW - 600, 0);
  return db;
}

describe('label-outcomes', () => {
  it('labels dead, dumped, survived and migrated launches; leaves undecided and young ones NULL; is idempotent', () => {
    const db = seeded();
    const r1 = labelOutcomes(db, NOW, { minAge: 7200 });
    expect(r1.counts).toEqual({ DEAD_1H: 1, DEV_DUMP: 1, SURVIVED_24H: 2, undecided: 1 });
    expect(r1.examined).toBe(5); // YONG is excluded by min age
    const rows = db.prepare('SELECT mint, outcome, outcome_at FROM tokens ORDER BY mint').all() as { mint: string; outcome: string | null; outcome_at: number | null }[];
    const by = Object.fromEntries(rows.map((r) => [r.mint, r]));
    expect(by[b58('DEAD')]).toMatchObject({ outcome: 'DEAD_1H', outcome_at: NOW - 10800 + 3600 });
    expect(by[b58('DUMP')]).toMatchObject({ outcome: 'DEV_DUMP', outcome_at: NOW - 9000 }); // the sell that crossed 50%
    expect(by[b58('SURV')]).toMatchObject({ outcome: 'SURVIVED_24H', outcome_at: NOW - 172800 + 86400 });
    expect(by[b58('MIGR')]!.outcome).toBe('SURVIVED_24H');
    expect(by[b58('ALIV')]!.outcome).toBeNull();
    expect(by[b58('YONG')]!.outcome).toBeNull();
    // second run: nothing left to label except the undecided one
    const r2 = labelOutcomes(db, NOW, { minAge: 7200 });
    expect(r2.labelled).toBe(0);
    expect(r2.counts.undecided).toBe(1);
  });

  it('dry-run changes nothing', () => {
    const db = seeded();
    const r = labelOutcomes(db, NOW, { minAge: 7200, dryRun: true });
    expect(r.labelled).toBe(4);
    expect(db.prepare('SELECT COUNT(*) AS v FROM tokens WHERE outcome IS NOT NULL').get()).toEqual({ v: 0 });
  });

  it('agrees with the backtest labeller rule for rule', () => {
    const db = seeded();
    const tokens = db.prepare('SELECT * FROM tokens').all() as { mint: string; deployer: string; created_at: number; migrated: number }[];
    const tradesFor = db.prepare('SELECT wallet, side, token_amount, ts FROM trades WHERE mint = ? ORDER BY ts, sig');
    const expected = Object.fromEntries(tokens.map((t) => [t.mint, labelToken(t, tradesFor.all(t.mint), NOW, 7200)]));
    labelOutcomes(db, NOW, { minAge: 7200 });
    for (const row of db.prepare('SELECT mint, outcome FROM tokens').all() as { mint: string; outcome: string | null }[]) {
      expect(row.outcome).toBe(expected[row.mint]);
    }
  });

  it('outcomeTs for DEV_DUMP points at the crossing sell', () => {
    const token = { mint: 'm', deployer: DEV, created_at: 1000, migrated: 0 };
    const trades = [
      { wallet: DEV, side: 'buy', token_amount: 100, ts: 1001 },
      { wallet: DEV, side: 'sell', token_amount: 30, ts: 1500 },
      { wallet: DEV, side: 'sell', token_amount: 30, ts: 1600 },
    ];
    expect(outcomeTs(token, trades, 'DEV_DUMP', 9999)).toBe(1600);
  });
});
