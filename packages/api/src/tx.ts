import { base58Encode } from './base58.js';

export const MEMO_PROGRAMS = new Set([
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
]);

export interface ParsedIx { program: string | null; data: Uint8Array }

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}
  u8(): number {
    const v = this.buf[this.pos++];
    if (v === undefined) throw new Error('tx: truncated');
    return v;
  }
  shortvec(): number {
    let v = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const b = this.u8();
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v;
    }
    throw new Error('tx: bad shortvec');
  }
  take(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('tx: truncated');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/** Parse a Solana wire transaction (legacy or v0) into its instructions. Throws on malformed input. */
export function parseInstructions(wire: Uint8Array): ParsedIx[] {
  const r = new Reader(wire);
  r.take(r.shortvec() * 64); // signatures
  const first = r.u8();
  if (first & 0x80) {
    if ((first & 0x7f) !== 0) throw new Error('tx: unsupported version');
    r.take(3);
  } else {
    r.take(2); // `first` was numRequiredSignatures; the remaining header bytes
  }
  const keys: string[] = [];
  const nKeys = r.shortvec();
  for (let i = 0; i < nKeys; i++) keys.push(base58Encode(r.take(32)));
  r.take(32); // recent blockhash
  const out: ParsedIx[] = [];
  const nIx = r.shortvec();
  for (let i = 0; i < nIx; i++) {
    const idx = r.u8();
    r.take(r.shortvec()); // account indexes
    const data = r.take(r.shortvec());
    out.push({ program: keys[idx] ?? null, data });
  }
  return out;
}

/** True iff the tx has exactly one Memo instruction and its data is byte-equal to `expected` (UTF-8). */
export function hasExactlyMemo(wire: Uint8Array, expected: string): boolean {
  const memos = parseInstructions(wire).filter((ix) => ix.program !== null && MEMO_PROGRAMS.has(ix.program));
  if (memos.length !== 1) return false;
  return Buffer.from(memos[0]!.data).equals(Buffer.from(expected, 'utf8'));
}
