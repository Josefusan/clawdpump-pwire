import { createServer as httpServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import type { SchemeNetworkClient } from '@x402/fetch';
import { loadConfig, DEVNET, MAINNET } from '../src/config.js';
import { createServer, RUG_RISK_TOOL } from '../src/server.js';
import { SpendStore } from '../src/spend.js';

const MINT = 'So11111111111111111111111111111111111111112';
const DEV_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const MAIN_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const UNKNOWN = 'unknownmintunknownmintunknownmint1111';
const RESULT = {
  mint: MINT, score: 72, verdict: 'HIGH', reasons: [], data_gaps: [],
  model_version: 'v0.1.0', as_of_slot: 1, as_of_ts: 1,
};

let api: HttpServer;
let url: string;
let dir: string;
let signed = 0;
let settled: string[] = [];
let offer: { network: string; asset: string; amount: string };
let failMessage: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pwmcp-'));
  signed = 0;
  settled = [];
  failMessage = undefined;
  balance = 10_000_000n;
  offer = { network: DEVNET, asset: DEV_USDC, amount: '10000' };
  api = httpServer((req, res) => {
    const json = (code: number, body: unknown, h: Record<string, string> = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...h });
      res.end(JSON.stringify(body));
    };
    if (!req.url?.startsWith('/v1/risk/')) return json(404, { error: 'NOT_FOUND' });
    const mint = req.url.slice('/v1/risk/'.length);
    if (mint === UNKNOWN) return json(404, { error: 'NOT_FOUND' });
    const header = req.headers['payment-signature'];
    if (typeof header !== 'string') {
      const body = {
        x402Version: 2,
        error: 'PAYMENT_REQUIRED',
        resource: { url: `${url}${req.url}`, mimeType: 'application/json' },
        accepts: [{
          scheme: 'exact', ...offer, payTo: 'PayTo1111111111111111111111111111111111111', maxTimeoutSeconds: 60,
          extra: { feePayer: 'Fee1111111111111111111111111111111111111111', memo: `pumpwire:rug_risk_score:${mint}` },
        }],
      };
      return json(402, body, { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(body as never) });
    }
    // Mock facilitator: accepts any decodable payment payload unless told to fail.
    const p = decodePaymentSignatureHeader(header);
    if (failMessage) return json(402, { error: 'PAYMENT_INVALID', message: failMessage });
    settled.push(p.payload.transaction as string);
    json(200, RESULT);
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const addr = api.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterEach(() => {
  api.close();
});

const fakeScheme: SchemeNetworkClient = {
  scheme: 'exact',
  async createPaymentPayload(version) {
    signed++;
    return { x402Version: version, payload: { transaction: Buffer.from(`tx${signed}`).toString('base64') } };
  },
};

let balance: bigint | Error = 10_000_000n;
const spendFile = () => JSON.parse(readFileSync(join(dir, 'spend.json'), 'utf8')).spentMicro;

async function connect(env: Record<string, string> = {}) {
  const cfg = loadConfig({
    PUMPWIRE_API_URL: url,
    SOLANA_KEYPAIR_PATH: '/nonexistent',
    PUMPWIRE_SPEND_STATE_PATH: join(dir, 'spend.json'),
    ...env,
  });
  const server = createServer({
    cfg,
    spend: new SpendStore(cfg.spendStatePath),
    scheme: fakeScheme,
    payer: 'Payer11111111111111111111111111111111111111',
    getBalance: async () => {
      if (balance instanceof Error) throw balance;
      return balance;
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(a);
  return client;
}

const call = (c: Client, mint: string) => c.callTool({ name: 'rug_risk_score', arguments: { mint } });
const errCode = (r: unknown) =>
  JSON.parse(((r as { content: { text: string }[] }).content[0] as { text: string }).text).error;

describe('pumpwire-mcp', () => {
  it('lists exactly rug_risk_score with the §6 input schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['rug_risk_score']);
    expect(tools[0]?.inputSchema).toEqual(RUG_RISK_TOOL.inputSchema);
  });

  it('e2e: call -> 402 -> signed payment -> RiskResult (structured + text), spend persisted', async () => {
    const client = await connect();
    const r = await call(client, MINT);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual(RESULT);
    expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toEqual(RESULT);
    expect(signed).toBe(1);
    expect(settled).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'spend.json'), 'utf8')).spentMicro).toBe(10000);
  });

  it('refuses price above cap without signing', async () => {
    offer.amount = '50001';
    const client = await connect();
    expect(errCode(await call(client, MINT))).toBe('PRICE_ABOVE_CAP');
    expect(signed).toBe(0);
  });

  it('honors a lowered PUMPWIRE_MAX_PRICE_USD', async () => {
    const client = await connect({ PUMPWIRE_MAX_PRICE_USD: '0.005' });
    expect(errCode(await call(client, MINT))).toBe('PRICE_ABOVE_CAP');
    expect(signed).toBe(0);
  });

  it('refuses at the daily cap, persisted across server restarts', async () => {
    const env = { PUMPWIRE_DAILY_CAP_USD: '0.02' };
    let client = await connect(env);
    expect((await call(client, MINT)).isError).toBeFalsy();
    expect((await call(client, MINT)).isError).toBeFalsy();
    expect(errCode(await call(client, MINT))).toBe('DAILY_CAP_REACHED');
    client = await connect(env); // fresh server, same state file
    expect(errCode(await call(client, MINT))).toBe('DAILY_CAP_REACHED');
    expect(signed).toBe(2);
  });

  it('daily spend resets on a new UTC day', () => {
    let now = Date.UTC(2026, 9, 1, 12);
    const s = new SpendStore(join(dir, 'd.json'), () => now);
    expect(s.reserve(5_000_000, 5_000_000)).toBe(true);
    expect(s.reserve(1, 5_000_000)).toBe(false);
    now = Date.UTC(2026, 9, 2, 0, 0, 1);
    expect(s.reserve(1, 5_000_000)).toBe(true);
  });

  it('corrupt spend state refuses rather than resetting the cap', async () => {
    writeFileSync(join(dir, 'spend.json'), 'garbage');
    const client = await connect();
    expect(errCode(await call(client, MINT))).toBe('UPSTREAM');
    expect(signed).toBe(0);
  });

  it('refuses wrong network and wrong asset without signing', async () => {
    offer.network = MAINNET;
    let client = await connect();
    expect(errCode(await call(client, MINT))).toBe('WRONG_NETWORK');
    offer = { network: DEVNET, asset: MAIN_USDC, amount: '10000' };
    client = await connect();
    expect(errCode(await call(client, MINT))).toBe('WRONG_ASSET');
    offer = { network: DEVNET, asset: DEV_USDC, amount: '10000' };
    client = await connect({ PUMPWIRE_PAY_ASSET: 'ANSEM' });
    expect(errCode(await call(client, MINT))).toBe('WRONG_ASSET');
    expect(signed).toBe(0);
  });

  it('maps INVALID_MINT locally and NOT_FOUND from the API, never paying', async () => {
    const client = await connect();
    expect(errCode(await call(client, 'not-a-mint!'))).toBe('INVALID_MINT');
    expect(errCode(await call(client, UNKNOWN))).toBe('NOT_FOUND');
    expect(signed).toBe(0);
  });

  it('refuses INSUFFICIENT_FUNDS before signing and releases the reservation', async () => {
    balance = 9_999n; // price is 10_000
    const client = await connect();
    expect(errCode(await call(client, MINT))).toBe('INSUFFICIENT_FUNDS');
    expect(signed).toBe(0);
    expect(settled).toHaveLength(0);
    expect(spendFile()).toBe(0);
    balance = 0n; // missing token account reads as zero
    expect(errCode(await call(client, MINT))).toBe('INSUFFICIENT_FUNDS');
    expect(signed).toBe(0);
    balance = 10_000n; // exactly enough pays, and the released budget is usable
    expect((await call(client, MINT)).isError).toBeFalsy();
    expect(signed).toBe(1);
    expect(spendFile()).toBe(10000);
  });

  it('refuses without signing if the balance check fails', async () => {
    balance = new Error('rpc down');
    const client = await connect();
    expect(errCode(await call(client, MINT))).toBe('UPSTREAM');
    expect(signed).toBe(0);
    expect(spendFile()).toBe(0);
  });

  it('maps insufficient funds reported by the API (fallback)', async () => {
    failMessage = 'insufficient funds';
    const client = await connect();
    expect(errCode(await call(client, MINT))).toBe('INSUFFICIENT_FUNDS');
  });

  it('defaults: max price $0.05, daily cap $5, devnet, USDC', () => {
    const cfg = loadConfig({ PUMPWIRE_API_URL: url, SOLANA_KEYPAIR_PATH: 'x' });
    expect([cfg.maxPriceMicro, cfg.dailyCapMicro, cfg.network, cfg.payAsset]).toEqual([
      50000, 5_000_000, DEVNET, 'USDC',
    ]);
  });
});
