#!/usr/bin/env node
// PumpWire integrator proof: read the free GET /v1/stats and print first-party vs third-party totals.
//
// Usage:  PUMPWIRE_API_URL=... node examples/stats.mjs [--json]
//
// Env (names only):
//   PUMPWIRE_API_URL  required  base URL of the PumpWire API
//
// Free endpoint: no wallet, no key, no payment.

const apiUrl = (process.env.PUMPWIRE_API_URL ?? '').replace(/\/+$/, '');
if (!apiUrl) {
  process.stderr.write('stats: PUMPWIRE_API_URL is required\n');
  process.exit(1);
}

const res = await fetch(`${apiUrl}/v1/stats`, { headers: { accept: 'application/json' } });
if (res.status !== 200) {
  process.stderr.write(`stats: GET /v1/stats -> ${res.status}\n`);
  process.exit(1);
}
const s = await res.json();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(s, null, 2));
  process.exit(0);
}

const t = s.totals ?? {};
const short = (a) => (typeof a === 'string' && a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a));
console.log(`network ${s.network} · model ${s.model_version} · generated_at ${new Date((s.generated_at ?? 0) * 1000).toISOString()}`);
console.log(`paid calls: ${t.paid_calls} total = ${t.paid_calls_first_party} first-party + ${t.paid_calls_third_party} third-party + ${t.paid_calls_unattributed} unattributed`);
console.log(`USDC paid: ${t.usdc_paid} · unique payers: ${t.unique_payers} · integrators (distinct third-party payer wallets): ${t.unique_integrators}`);
console.log('last calls (newest first):');
for (const c of (s.last_calls ?? []).slice(0, 10)) {
  console.log(`  ${new Date(c.ts * 1000).toISOString()}  ${c.party.padEnd(12)}  ${c.tool}  mint ${short(c.arg)}  ${c.verdict ?? '-'}  payer ${short(c.payer)}  tx ${short(c.tx_sig)}`);
}
if (s.backtest) console.log(`backtest: model ${s.backtest.model_version}, n = ${s.backtest.n} (small sample; see /live)`);
