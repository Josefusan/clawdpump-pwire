// PumpPortal frames carry no slot. SlotClock gives an approximate one: an RPC getSlot anchor
// extrapolated at ~400 ms/slot, or (no RPC) wall-clock/400 ms: monotonic, fine for relative windows.
const SLOT_MS = 400;

export class SlotClock {
  private anchorSlot: number | null = null;
  private anchorMs = 0;

  anchor(slot: number, atMs: number): void {
    if (Number.isSafeInteger(slot) && slot > 0) {
      this.anchorSlot = slot;
      this.anchorMs = atMs;
    }
  }

  now(atMs: number = Date.now()): number {
    if (this.anchorSlot === null) return Math.floor(atMs / SLOT_MS);
    return this.anchorSlot + Math.max(0, Math.floor((atMs - this.anchorMs) / SLOT_MS));
  }
}

/** Fetch the current slot from a JSON-RPC endpoint. The URL may embed a key: never log it. */
export async function fetchSlot(rpcUrl: string): Promise<number | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }] }),
      signal: AbortSignal.timeout(3000),
    });
    const j = (await res.json()) as { result?: unknown };
    return typeof j.result === 'number' ? j.result : null;
  } catch {
    return null;
  }
}
