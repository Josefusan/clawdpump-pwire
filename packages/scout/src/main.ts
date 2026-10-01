import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { ExactSvmScheme } from '@x402/svm';
import { fetchRiskResult, rpcBalanceReader, SpendStore, type PayDeps } from '@pumpwire/mcp';
import { loadScoutConfig } from './config.js';
import { SeenStore, step } from './loop.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`);

async function main(): Promise<void> {
  const cfg = loadScoutConfig();
  // The payer key is read once from the configured path (same rule as pumpwire-mcp); never logged or sent.
  const bytes = Uint8Array.from(JSON.parse(readFileSync(cfg.pay.keypairPath, 'utf8')) as number[]);
  const signer = await createKeyPairSignerFromBytes(bytes);
  const payDeps: PayDeps = {
    cfg: cfg.pay,
    spend: new SpendStore(cfg.pay.spendStatePath),
    scheme: new ExactSvmScheme(signer),
    payer: signer.address,
    getBalance: rpcBalanceReader(cfg.pay.rpcUrl),
  };
  const db = new DatabaseSync(cfg.dbPath, { readOnly: true });
  const seen = new SeenStore(cfg.statePath);

  log({
    event: 'start', payer: signer.address, network: cfg.pay.network, api: cfg.apiUrl,
    caps: { max_price_usd: cfg.pay.maxPriceMicro / 1e6, daily_cap_usd: cfg.pay.dailyCapMicro / 1e6 },
    filter: { min_buyers: cfg.minBuyers, window_s: cfg.windowS, max_age_s: cfg.maxAgeS }, first_party: true,
    note: 'add this payer to FIRST_PARTY_WALLETS on the api so /live labels these calls first-party',
  });

  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stopping = true; });

  let failures = 0;
  while (!stopping) {
    try {
      const r = await step({ db, cfg, seen, nowS: () => Math.floor(Date.now() / 1000), log, pay: (m) => fetchRiskResult(payDeps, m) });
      failures = 0;
      if (r.halt) {
        log({ event: 'halt', reason: r.halt, backoff_ms: cfg.haltBackoffMs });
        await sleep(cfg.haltBackoffMs);
        continue;
      }
    } catch (e) {
      failures++;
      log({ event: 'loop_error', message: e instanceof Error ? e.message : 'unknown', failures });
      await sleep(Math.min(60_000, cfg.pollMs * 2 ** Math.min(failures, 4)));
      continue;
    }
    await sleep(cfg.pollMs);
  }
  db.close();
  log({ event: 'stop' });
}

main().catch((e) => {
  process.stderr.write(`pumpwire-scout: ${e instanceof Error ? e.message : 'startup failed'}\n`);
  process.exit(1);
});
