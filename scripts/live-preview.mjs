// Preview /live locally with a fake /v1/stats: node scripts/live-preview.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('../packages/live/public/', import.meta.url));
const now = Math.floor(Date.now() / 1000);
const SIG = '3SaUx1eQyutzRoUP7mm4thk7gqUukCWHbMdZUt1gjUJa9ovRUydtvFwgsyaE2Q51U5onS1PENvv9B6WFUMLauxMn';
const stats = {
  model_version: 'v0.1.0', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', generated_at: now,
  totals: { paid_calls: 1, paid_calls_first_party: 1, paid_calls_third_party: 0, usdc_paid: '0.01', ansem_paid: '0', unique_payers: 1, unique_integrators: 0 },
  last_calls: [{ ts: now - 300, tool: 'rug_risk_score', arg: 'So11111111111111111111111111111111111111112', score: 0, verdict: 'LOW', tx_sig: SIG, payer: 'DtGkR8kXbxVFmGNP5AKD7g2MRskFed67BPFb7efHp5Mf', asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', first_party: true, latency_ms: 1512 }],
  caught: [], backtest: null,
};
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/v1/stats') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(stats)); }
  let p = url.pathname.replace(/^\/live\/?/, '');
  if (p === '' || p === '/') p = 'index.html';
  try {
    const body = await readFile(new URL(p, `file://${dir}`));
    res.writeHead(200, { 'content-type': types[p.slice(p.lastIndexOf('.'))] ?? 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(Number(process.argv[2] ?? 8403), () => console.log('live preview on http://127.0.0.1:' + (process.argv[2] ?? 8403) + '/live'));
