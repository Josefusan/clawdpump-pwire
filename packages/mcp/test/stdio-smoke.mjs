// Manual smoke: node packages/mcp/test/stdio-smoke.mjs  (needs a build; uses a throwaway keypair, no network)
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dir = mkdtempSync(join(tmpdir(), 'pwsmoke-'));
const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
writeFileSync(join(dir, 'kp.json'), JSON.stringify([...pkcs8.slice(-32), ...pub]));
const t = new StdioClientTransport({
  command: 'node',
  args: ['packages/mcp/dist/index.js'],
  env: { PUMPWIRE_API_URL: 'http://127.0.0.1:1', SOLANA_KEYPAIR_PATH: join(dir, 'kp.json'), PUMPWIRE_SPEND_STATE_PATH: join(dir, 's.json'), PATH: process.env.PATH ?? '' },
});
const c = new Client({ name: 'smoke', version: '0' });
await c.connect(t);
console.log(JSON.stringify((await c.listTools()).tools.map((x) => x.name)));
await c.close();
