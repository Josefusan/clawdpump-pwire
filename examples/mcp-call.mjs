#!/usr/bin/env node
// Drive the PumpWire MCP server over stdio, the same way Hermes, Claude Code or Claude Desktop do.
//
// Usage (from the repo root, after `npm ci && npm run build -w @pumpwire/mcp`):
//   PUMPWIRE_API_URL=... SOLANA_KEYPAIR_PATH=... node examples/mcp-call.mjs              # list tools only, pays nothing
//   PUMPWIRE_API_URL=... SOLANA_KEYPAIR_PATH=... node examples/mcp-call.mjs <mint> --pay # calls rug_risk_score ($0.01 USDC)
//
// Env (names only) — forwarded to the server process explicitly, nothing else from your shell is passed:
//   PUMPWIRE_API_URL, SOLANA_KEYPAIR_PATH (required)
//   PUMPWIRE_NETWORK, PUMPWIRE_MAX_PRICE_USD, PUMPWIRE_DAILY_CAP_USD, PUMPWIRE_SPEND_STATE_PATH, SOLANA_RPC_URL (optional)
//
// The server reads the keypair itself; this script never opens it.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const die = (m) => {
  process.stderr.write(`mcp-call: ${m}\n`);
  process.exit(1);
};
const REQUIRED = ['PUMPWIRE_API_URL', 'SOLANA_KEYPAIR_PATH'];
const OPTIONAL = ['PUMPWIRE_NETWORK', 'PUMPWIRE_MAX_PRICE_USD', 'PUMPWIRE_DAILY_CAP_USD', 'PUMPWIRE_SPEND_STATE_PATH', 'SOLANA_RPC_URL', 'HOME', 'PATH'];
for (const k of REQUIRED) if (!process.env[k]) die(`${k} is required`);

const server = fileURLToPath(new URL('../packages/mcp/dist/index.js', import.meta.url));
if (!existsSync(server)) die('packages/mcp/dist/index.js not found: run `npm ci && npm run build -w @pumpwire/mcp` first');

const args = process.argv.slice(2);
const pay = args.includes('--pay');
const mint = args.find((a) => !a.startsWith('--'));
if (pay && !mint) die('usage: node examples/mcp-call.mjs <mint> --pay');

const env = {};
for (const k of [...REQUIRED, ...OPTIONAL]) if (process.env[k]) env[k] = process.env[k];

const transport = new StdioClientTransport({ command: process.execPath, args: [server], env, stderr: 'inherit' });
const client = new Client({ name: 'pumpwire-example', version: '0.1.0' });
await client.connect(transport);

try {
  const { tools } = await client.listTools();
  console.log('tools:', tools.map((t) => t.name).join(', '));
  if (!pay) {
    console.log('dry run: no tool called, nothing paid. Pass <mint> --pay to call rug_risk_score.');
  } else {
    const r = await client.callTool({ name: 'rug_risk_score', arguments: { mint } });
    if (r.isError) {
      // Error text is {"error": CODE} (INTERFACES §6), e.g. PRICE_ABOVE_CAP, DAILY_CAP_REACHED, INSUFFICIENT_FUNDS.
      console.log('error:', r.content?.[0]?.text);
      process.exitCode = 1;
    } else {
      const risk = r.structuredContent;
      console.log(`verdict ${risk.verdict} · score ${risk.score}/100 · model ${risk.model_version} · as_of_slot ${risk.as_of_slot}`);
      for (const x of risk.reasons) console.log(`  +${x.points} ${x.factor}: ${x.detail}`);
      if (risk.data_gaps.length) console.log(`  data gaps (scored 0, not "safe"): ${risk.data_gaps.join(', ')}`);
    }
  }
} finally {
  await client.close();
}
