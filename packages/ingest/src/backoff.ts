/** Exponential backoff: 1s, 2s, 4s ... capped; `rand` in [0,1) adds up to 25% jitter. */
export function backoffMs(attempt: number, rand = 0, baseMs = 1000, capMs = 30_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exp * (1 + 0.25 * rand));
}
