import { describe, expect, it } from 'vitest';
import { createApp, stubRiskResult, BASE58_RE, SOLANA_DEVNET_CAIP2 } from '../src/index.js';

const cfg = { network: SOLANA_DEVNET_CAIP2, facilitatorUrl: 'http://127.0.0.1:9', payTo: 'DtGkR8kXbxVFmGNP5AKD7g2MRskFed67BPFb7efHp5Mf', maxTimeoutSeconds: 60 };

async function request(path: string) {
  const app = createApp(cfg);
  const srv = app.listen(0);
  const port = (srv.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  } finally { srv.close(); }
}

describe('api x402 spike', () => {
  it('GET /health is free and reports the network', async () => {
    const r = await request('/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.network).toBe(SOLANA_DEVNET_CAIP2);
  });
  it('GET /v1/risk/:mint rejects non-base58 for free (400 before any 402)', async () => {
    const r = await request('/v1/risk/not-a-mint');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_MINT');
  });
  it('stubRiskResult matches the frozen RiskResult shape', () => {
    const m = 'So11111111111111111111111111111111111111112';
    expect(BASE58_RE.test(m)).toBe(true);
    const r = stubRiskResult(m);
    expect(r).toMatchObject({ mint: m, score: 0, verdict: 'LOW', reasons: [], model_version: 'v0.1.0' });
    expect(r.data_gaps).toHaveLength(8);
    expect(typeof r.as_of_ts).toBe('number');
  });
});
