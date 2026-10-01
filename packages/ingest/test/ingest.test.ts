import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseFrame, parseMessage } from '../src/parse.js';
import { openDb, Store } from '../src/db.js';
import { Pipeline } from '../src/pipeline.js';
import { SlotClock } from '../src/slot.js';
import { backoffMs } from '../src/backoff.js';

const FIX = new URL('../../../fixtures/pumpportal/', import.meta.url);
const raw = (f: string) => readFileSync(new URL(f, FIX), 'utf8');
const MINT = 'BEsvbEmtygKgqiqCXrftotf47vXJXvRxovmWqkjYpump';
const DEPLOYER = 'oSHtyxon9EVtmeBYy8DSMpBkyE5rMtf8hWFE9SRn3vPA';

describe('parsers (pure)', () => {
  it('create: normal', () => {
    expect(parseFrame(raw('create-normal.json'))).toMatchObject({
      kind: 'create', mint: MINT, deployer: DEPLOYER, name: 'Test Token', symbol: 'TEST', hasSocials: false,
    });
  });
  it('create: socials -> hasSocials true', () => {
    expect(parseFrame(raw('create-with-socials.json'))).toMatchObject({ kind: 'create', hasSocials: true });
  });
  it('create: null metadata -> unknown, no throw', () => {
    expect(parseFrame(raw('create-null-metadata.json'))).toMatchObject({ kind: 'create', name: null, hasSocials: null });
  });
  it('create: empty strings stay empty (not null)', () => {
    expect(parseFrame(raw('create-empty-strings.json'))).toMatchObject({ kind: 'create', symbol: '' });
  });
  it('create: unknown fields ignored', () => {
    const p = parseFrame(raw('create-unknown-fields.json'));
    expect(p.kind).toBe('create');
    expect(Object.keys(p)).not.toContain('futureField');
  });
  it('buy / sell convert to integer lamports and raw token units', () => {
    expect(parseFrame(raw('buy-normal.json'))).toMatchObject({
      kind: 'trade', side: 'buy', lamports: 50_000_000, tokenAmount: 1_234_567_890_000,
    });
    expect(parseFrame(raw('sell-partial.json'))).toMatchObject({
      kind: 'trade', side: 'sell', lamports: 30_000_000, tokenAmount: 500_000_000_000,
    });
  });
  it('dust amounts round, never negative', () => {
    expect(parseFrame(raw('buy-dust-amount.json'))).toMatchObject({ kind: 'trade', lamports: 1, tokenAmount: 1 });
  });
  it('beyond-2^53 amounts are quarantined, not corrupted', () => {
    expect(parseFrame(raw('buy-extreme-amount.json'))).toMatchObject({ kind: 'malformed', reason: 'trade: amount out of range' });
  });
  it('migrate', () => {
    expect(parseFrame(raw('migrate-normal.json'))).toEqual({ kind: 'migrate', mint: 'SV6Rn1CscBSfrhUyzfrZGHGXrm25pMGFnjpu6j4Rpump' });
  });

  it.each([
    'malformed-array-frame.json', 'malformed-empty-object.json', 'malformed-trade-missing-sol-amount.json',
    'malformed-truncated-frame.json', 'malformed-wrong-types.json', 'create-missing-mint.json',
  ])('malformed: %s', (f) => {
    expect(parseFrame(raw(f)).kind).toBe('malformed');
  });
  it('malformed: unknown txType ignored, error frame surfaced, bad JSON text', () => {
    expect(parseFrame(raw('malformed-unknown-txtype.json')).kind).toBe('ignored');
    expect(parseFrame(raw('malformed-error-frame.json')).kind).toBe('error');
    expect(parseFrame('{"mint":').kind).toBe('malformed');
    expect(parseMessage(null).kind).toBe('malformed');
    expect(parseFrame('x'.repeat(300_000)).kind).toBe('malformed');
  });

  it('oversized metadata is clamped to 64/16/200', () => {
    const p = parseFrame(raw('create-oversized-metadata.json'));
    if (p.kind !== 'create') throw new Error('expected create');
    expect(Array.from(p.name ?? '').length).toBeLessThanOrEqual(64);
    expect(Array.from(p.symbol ?? '').length).toBeLessThanOrEqual(16);
    expect(Array.from(p.uri ?? '').length).toBeLessThanOrEqual(200);
    expect((p.name ?? '').length).toBeGreaterThan(0);
  });
  it('unicode: emoji kept, whole code points, bidi/zero-width stripped, symbol NFKC', () => {
    const p = parseFrame(raw('create-unicode-metadata.json'));
    if (p.kind !== 'create') throw new Error('expected create');
    expect(p.name).toContain('🐸');
    expect(p.name).toContain('青蛙');
    expect(p.name).not.toMatch(/[​-‏‪-‮]/);
    expect(p.name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/); // no split surrogates
  });
  it('control chars stripped', () => {
    const p = parseFrame(raw('create-control-chars.json'));
    if (p.kind !== 'create') throw new Error('expected create');
    for (const s of [p.name, p.symbol, p.uri]) expect(s ?? '').not.toMatch(/[\u0000-\u001f\u007f]/);
  });
  it('injection-looking names are plain data', () => {
    for (const f of ['create-injection-name.json', 'create-injection-description.json']) {
      const p = parseFrame(raw(f));
      expect(p.kind).toBe('create'); // processed like any other token; text is never interpreted
    }
  });
});

describe('backoff', () => {
  it('doubles then caps, jitter bounded', () => {
    expect([0, 1, 2, 3].map((a) => backoffMs(a))).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffMs(20)).toBe(30_000);
    expect(backoffMs(0, 0.999)).toBeLessThanOrEqual(1250);
  });
});

describe('writer (temp DB)', () => {
  let dir: string;
  let db: DatabaseSync;
  let pipe: Pipeline;
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pw-ingest-'));
    db = openDb(join(dir, 'test.db'));
    pipe = new Pipeline(new Store(db), new SlotClock());
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('create -> buy -> sell -> migrate, with idempotent re-feeds', () => {
    const t = 1_790_000_000_000;
    const fx = pipe.handle(raw('create-normal.json'), t);
    expect(fx.subscribe).toEqual([MINT]);
    pipe.handle(raw('buy-normal.json'), t + 1000);
    pipe.handle(raw('sell-partial.json'), t + 2000);
    // duplicates: no new rows, no new subscription, launches not inflated
    expect(pipe.handle(raw('create-duplicate-of.json'), t + 3000).subscribe).toEqual([]);
    pipe.handle(raw('buy-duplicate-of.json'), t + 3000);
    expect(count('tokens')).toBe(1);
    expect(count('trades')).toBe(2);
    expect(db.prepare('SELECT launches FROM deployers WHERE address = ?').get(DEPLOYER)).toMatchObject({ launches: 1 });
    expect(pipe.counters).toMatchObject({ duplicates: 2, rows_tokens: 1, rows_trades: 2 });

    const tok = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(MINT) as Record<string, unknown>;
    expect(tok).toMatchObject({ name: 'Test Token', symbol: 'TEST', deployer: DEPLOYER, created_at: 1_790_000_000, has_socials: 0, migrated: 0 });
    const buy = db.prepare("SELECT * FROM trades WHERE side = 'buy'").get() as Record<string, unknown>;
    expect(buy).toMatchObject({ mint: MINT, lamports: 50_000_000, token_amount: 1_234_567_890_000, ts: 1_790_000_001 });

    db.prepare('INSERT INTO tokens (mint, deployer, created_slot, created_at) VALUES (?, ?, 1, 1)').run(
      'SV6Rn1CscBSfrhUyzfrZGHGXrm25pMGFnjpu6j4Rpump', DEPLOYER,
    );
    expect(pipe.handle(raw('migrate-normal.json'), t).unsubscribe).toEqual(['SV6Rn1CscBSfrhUyzfrZGHGXrm25pMGFnjpu6j4Rpump']);
    expect(db.prepare('SELECT migrated FROM tokens WHERE mint = ?').get('SV6Rn1CscBSfrhUyzfrZGHGXrm25pMGFnjpu6j4Rpump')).toMatchObject({ migrated: 1 });
  });

  it('malformed frames write nothing and are counted', () => {
    for (const f of ['malformed-array-frame.json', 'malformed-wrong-types.json', 'create-missing-mint.json', 'malformed-error-frame.json', 'malformed-unknown-txtype.json']) {
      pipe.handle(raw(f));
    }
    expect([count('tokens'), count('trades'), count('deployers')]).toEqual([0, 0, 0]);
    expect(pipe.counters).toMatchObject({ frames: 5, malformed: 3, upstream_errors: 1, ignored: 1 });
  });

  it('hostile metadata is stored verbatim-as-data via bound params (tables intact)', () => {
    for (const f of ['create-injection-name.json', 'create-injection-description.json', 'create-unicode-metadata.json', 'create-oversized-metadata.json', 'create-control-chars.json']) {
      pipe.handle(raw(f));
    }
    expect(count('tokens')).toBe(5);
    const names = (db.prepare('SELECT name FROM tokens').all() as { name: string }[]).map((r) => r.name);
    expect(names.every((n) => Array.from(n).length <= 64)).toBe(true);
    expect(count('deployers')).toBeGreaterThan(0);
  });

  it('whole-fixture replay is idempotent', () => {
    const files = ['create-normal.json', 'buy-normal.json', 'buy-dev-initial.json', 'sell-partial.json', 'sell-dev-full-exit.json'];
    for (let pass = 0; pass < 2; pass++) files.forEach((f) => pipe.handle(raw(f)));
    expect(count('trades')).toBe(4);
    expect(count('tokens')).toBe(1);
  });
});
