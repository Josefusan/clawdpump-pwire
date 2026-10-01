import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface State {
  day: string;
  spentMicro: number;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Persisted per-UTC-day spend in USDC base units. Synchronous: no await between read and write. */
export class SpendStore {
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}

  private load(): State {
    const day = utcDay(this.now());
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { day, spentMicro: 0 };
      throw e;
    }
    let s: Partial<State>;
    try {
      s = JSON.parse(raw) as Partial<State>;
    } catch {
      s = {};
    }
    if (typeof s.day !== 'string' || !Number.isSafeInteger(s.spentMicro) || (s.spentMicro as number) < 0) {
      // A corrupt file must never silently reset the cap to zero.
      throw new Error(`spend state at ${this.path} is corrupt; refusing to pay (fix or delete it)`);
    }
    return s.day === day ? { day, spentMicro: s.spentMicro as number } : { day, spentMicro: 0 };
  }

  private save(s: State): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  spent(): number {
    return this.load().spentMicro;
  }

  /** Reserve before signing. Returns false, writing nothing, if it would exceed the cap. */
  reserve(amountMicro: number, capMicro: number): boolean {
    const s = this.load();
    if (s.spentMicro + amountMicro > capMicro) return false;
    this.save({ day: s.day, spentMicro: s.spentMicro + amountMicro });
    return true;
  }

  release(amountMicro: number): void {
    const s = this.load();
    this.save({ day: s.day, spentMicro: Math.max(0, s.spentMicro - amountMicro) });
  }
}
