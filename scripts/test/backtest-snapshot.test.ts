import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error plain ESM script without types
import { buildSnapshotAsOf } from '../backtest.mjs';

const SCHEMA = readFileSync(new URL('../../docs/schema.sql', import.meta.url), 'utf8');
const b58 = (seed: string) => seed.repeat(44).slice(0, 44).replace(/[0OIl]/g, 'a');
const DEV = b58('D');

describe('buildSnapshotAsOf deployer_prior (no lookahead)', () => {
  it('only exposes prior outcomes that were decided at or before asOfTs', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA);
    const tok = db.prepare('INSERT INTO tokens (mint, deployer, created_slot, created_at, migrated, outcome, outcome_at) VALUES (?, ?, ?, ?, 0, ?, ?)');
    tok.run(b58('EARLY'), DEV, 1, 1000, 'DEAD_1H', 4600);          // decided at 4600
    tok.run(b58('LATE'), DEV, 2, 5000, 'DEV_DUMP', 9000);          // decided after asOfTs
    tok.run(b58('NOTS'), DEV, 3, 6000, 'SURVIVED_24H', null);      // legacy row without outcome_at: unknown when decided
    tok.run(b58('CUR'), DEV, 4, 7000, null, null);                 // the launch being scored
    const asOfTs = 7000 + 120;
    const snap = buildSnapshotAsOf(db, { mint: b58('CUR'), deployer: DEV, created_at: 7000, created_slot: 4, migrated: 0 }, asOfTs);
    const by = Object.fromEntries(snap.deployer_prior.map((p: { mint: string; outcome: string | null }) => [p.mint, p.outcome]));
    expect(by[b58('EARLY')]).toBe('DEAD_1H');
    expect(by[b58('LATE')]).toBeNull();
    expect(by[b58('NOTS')]).toBeNull();
    expect(snap.deployer_prior).toHaveLength(3);
    expect(snap.deployer_prior.every((p: Record<string, unknown>) => !('outcome_at' in p))).toBe(true);
  });
});
