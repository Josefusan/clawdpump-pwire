// G3 devnet paid loop: 20 paid rug_risk_score calls through pumpwire-mcp (x402 on devnet) + 3 negative cases.
//   PUMPWIRE_API_URL=<devnet api base> DEVNET_PAYER_KEYPAIR=<path to keypair JSON> \
//   PUMPWIRE_DB_PATH=<api sqlite db, read-only: mint source + tx sigs> \
//   node --experimental-strip-types --experimental-sqlite scripts/g3.ts
// Needs `npm run build -w @pumpwire/mcp` first. Optional: G3_MINTS=a,b,c (overrides DB), G3_CALLS (default 20).
// The keypair value is never printed. Run outside the model sandbox (Principal/Mises: A-012).
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PRICE_USD = 0.01;
export const TARGET_CALLS = 20;
export const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const WSOL = 'So11111111111111111111111111111111111111112';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// No devnet pump.fun mints are known statically; supply G3_MINTS or point at the API's DB.
export const FALLBACK_MINTS: string[] = [];

export type NegativeKind = 'wrong_amount' | 'wrong_mint' | 'replayed_tx';
/** Rejected means HTTP 402 with exactly this code; any other status/code is a failure of the check. */
export const EXPECTED_CODE: Record<NegativeKind, string> = {
  wrong_amount: 'PAYMENT_INVALID', wrong_mint: 'PAYMENT_INVALID', replayed_tx: 'PAYMENT_REPLAYED',
};
export interface NegativeLogEntry { kind: NegativeKind; status: number; error_code: string | null; ts: number }
export interface NegativeOutcome extends NegativeLogEntry { rejected: boolean; logged: boolean }

export function isRejected(kind: NegativeKind, status: number, code: string | null): boolean {
  return status === 402 && code === EXPECTED_CODE[kind];
}

export interface G3Deps {
  mints: string[];
  /** One paid call through the MCP client: 402 -> pay -> RiskResult. */
  paidCall(mint: string): Promise<{ ok: boolean; error?: string }>;
  /** Negative case; `mint`/`other` may be equal if only one mint is known. Returns the API's status + error code. */
  negative(kind: NegativeKind, mint: string, other: string): Promise<{ status: number; error_code: string | null }>;
  /** Durably record a negative outcome (the API writes no `calls` row for rejected payments). */
  logNegative(entry: NegativeLogEntry): void;
  /** Settled tx sigs recorded in `calls` for these mints since `sinceTs` (empty if no DB). */
  txSigs(mints: string[], sinceTs: number): string[];
  now(): number;
}

export interface G3Summary {
  successes: number; failures: number; usdcSpent: number; txSigs: string[];
  negatives: NegativeOutcome[]; ok: boolean;
}

export async function runG3(deps: G3Deps, target = TARGET_CALLS): Promise<G3Summary> {
  if (deps.mints.length === 0) throw new Error('no mints: set G3_MINTS or PUMPWIRE_DB_PATH');
  const since = deps.now();
  let successes = 0;
  for (let i = 0; i < target; i++) {
    try {
      if ((await deps.paidCall(deps.mints[i % deps.mints.length]!)).ok) successes++;
    } catch { /* counted as a failure; keep going so a summary is always produced */ }
  }
  // Capture sigs before the negatives: the replay setup makes one more real paid call.
  const txSigs = [...new Set(deps.txSigs([...new Set(deps.mints)], since))];
  const mint = deps.mints[0]!;
  // Replay targets a different mint: the same tool+arg would legitimately be re-served (ADR-002).
  const other = deps.mints.find((m) => m !== mint) ?? mint;
  const negatives: NegativeOutcome[] = [];
  for (const kind of ['wrong_amount', 'wrong_mint', 'replayed_tx'] as const) {
    let status = 0;
    let error_code: string | null = null;
    try {
      ({ status, error_code } = await deps.negative(kind, mint, other));
    } catch { /* status 0 = request/setup failed: recorded as not rejected */ }
    const entry: NegativeLogEntry = { kind, status, error_code, ts: deps.now() };
    let logged = true;
    try { deps.logNegative(entry); } catch { logged = false; }
    negatives.push({ ...entry, rejected: isRejected(kind, status, error_code), logged });
  }
  return {
    successes, failures: target - successes, usdcSpent: Number((successes * PRICE_USD).toFixed(6)), txSigs, negatives,
    ok: successes === target && txSigs.length === target && negatives.every((n) => n.rejected && n.logged),
  };
}

export function formatSummary(s: G3Summary): string {
  return [
    `G3 ${s.ok ? 'PASS' : 'FAIL'}: successes=${s.successes} failures=${s.failures} usdc_spent=${s.usdcSpent.toFixed(2)}`,
    ...s.negatives.map((n) => `negative ${n.kind}: ${n.rejected ? 'rejected' : 'NOT REJECTED'} (HTTP ${n.status} ${n.error_code ?? '-'})${n.logged ? '' : ' LOG WRITE FAILED'}`),
    `tx_sigs (${s.txSigs.length}):`,
    ...s.txSigs.map((t) => `  ${t}`),
  ].join('\n');
}

// ---------- real wiring (not exercised by the mocked test) ----------

const needEnv = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

async function loadSigner(path: string) {
  const { createKeyPairSignerFromBytes } = await import('@solana/kit');
  try {
    return await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
  } catch {
    throw new Error('invalid DEVNET_PAYER_KEYPAIR: expected a path to a Solana keypair JSON'); // never echo contents
  }
}

async function openDb(path: string) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path, { readOnly: true });
}

async function resolveMints(db: Awaited<ReturnType<typeof openDb>> | null, want: number): Promise<string[]> {
  let mints = process.env.G3_MINTS?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  if (mints.length === 0 && db) {
    const rows = db.prepare('SELECT mint FROM tokens ORDER BY created_at DESC LIMIT ?').all(want) as { mint: string }[];
    mints = rows.map((r) => r.mint);
  }
  if (mints.length === 0) mints = FALLBACK_MINTS;
  return mints.filter((m) => BASE58.test(m));
}

async function main(): Promise<void> {
  const api = needEnv('PUMPWIRE_API_URL').replace(/\/$/, '');
  const keyPath = needEnv('DEVNET_PAYER_KEYPAIR');
  const dbPath = process.env.PUMPWIRE_DB_PATH;
  const db = dbPath ? await openDb(dbPath) : null;

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const entry = fileURLToPath(new URL('../packages/mcp/dist/index.js', import.meta.url));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PUMPWIRE_API_URL: api,
    SOLANA_KEYPAIR_PATH: keyPath, PUMPWIRE_NETWORK: 'devnet', PUMPWIRE_PAY_ASSET: 'USDC',
  };
  if (process.env.SOLANA_RPC_URL) env.SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
  const client = new Client({ name: 'g3', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env }));

  const { x402Client } = await import('@x402/core/client');
  const http = await import('@x402/core/http');
  const { registerExactSvmScheme } = await import('@x402/svm/exact/client');
  const x402 = registerExactSvmScheme(new x402Client(), { signer: await loadSigner(keyPath) });

  type Required = { accepts: { amount: string; asset: string }[] };
  const url = (m: string) => `${api}/v1/risk/${encodeURIComponent(m)}`;
  const getRequired = async (m: string): Promise<Required> => {
    const r = await fetch(url(m));
    if (r.status !== 402) throw new Error(`expected 402, got ${r.status}`);
    const h = r.headers.get('payment-required');
    return (h ? http.decodePaymentRequiredHeader(h) : await r.json()) as Required;
  };
  const sign = async (req: Required) => http.encodePaymentSignatureHeader(await x402.createPaymentPayload(req as never));
  const pay = (m: string, header: string) => fetch(url(m), { headers: { 'PAYMENT-SIGNATURE': header } });
  const outcome = async (r: Response) => {
    let error_code: string | null = null;
    try {
      const e = ((await r.json()) as { error?: unknown }).error;
      if (typeof e === 'string' && /^[A-Z_]{1,40}$/.test(e)) error_code = e; // codes only, never free text
    } catch { /* non-JSON body */ }
    return { status: r.status, error_code };
  };
  const logPath = process.env.G3_LOG_PATH ?? join(dbPath ? dirname(dbPath) : process.cwd(), 'g3-negatives.jsonl');

  const deps: G3Deps = {
    mints: await resolveMints(db, TARGET_CALLS),
    now: () => Math.floor(Date.now() / 1000),
    async paidCall(mint) {
      const res = await client.callTool({ name: 'rug_risk_score', arguments: { mint } }).catch(() => null);
      if (!res) return { ok: false, error: 'UPSTREAM' };
      if (res.isError) {
        const t = (res.content as { text?: string }[] | undefined)?.[0]?.text ?? '';
        return { ok: false, error: /^\{"error":"[A-Z_]+"\}$/.test(t) ? t : 'UPSTREAM' }; // codes only
      }
      return { ok: res.structuredContent !== undefined };
    },
    async negative(kind, mint, other) {
      if (kind === 'replayed_tx') {
        // Legit payment for `mint` (a real extra $0.01), then present the same payload for a different resource.
        const header = await sign(await getRequired(mint));
        const first = await pay(mint, header);
        if (first.status !== 200) throw new Error(`setup payment failed: HTTP ${first.status}`);
        await first.arrayBuffer();
        return outcome(await pay(other, header));
      }
      const bad = structuredClone(await getRequired(mint));
      if (kind === 'wrong_amount') bad.accepts[0]!.amount = '1'; // underpay
      else bad.accepts[0]!.asset = bad.accepts[0]!.asset === DEVNET_USDC ? WSOL : DEVNET_USDC; // wrong mint (asset)
      return outcome(await pay(mint, await sign(bad)));
    },
    logNegative: (entry) => appendFileSync(logPath, JSON.stringify(entry) + '\n', { mode: 0o600 }),
    txSigs(mints, sinceTs) {
      if (!db) return [];
      const ph = mints.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT tx_sig FROM calls WHERE tool = 'rug_risk_score' AND tx_sig IS NOT NULL AND ts >= ? AND arg IN (${ph}) ORDER BY id`,
      ).all(sinceTs, ...mints) as { tx_sig: string }[];
      return rows.map((r) => r.tx_sig);
    },
  };

  try {
    const summary = await runG3(deps, Number(process.env.G3_CALLS ?? TARGET_CALLS));
    console.log(formatSummary(summary));
    process.exitCode = summary.ok ? 0 : 1;
  } finally {
    await client.close();
    db?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: Error) => {
    console.error(`g3 failed: ${e.message}`);
    process.exit(1);
  });
}
