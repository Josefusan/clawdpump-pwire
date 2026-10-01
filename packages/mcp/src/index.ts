#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ExactSvmScheme } from '@x402/svm';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { loadConfig } from './config.js';
import { SpendStore } from './spend.js';
import { rpcBalanceReader } from './balance.js';
import { createServer } from './server.js';

export { loadConfig } from './config.js';
export { SpendStore } from './spend.js';
export { createServer, RUG_RISK_TOOL } from './server.js';
export { fetchRiskResult, enforcePolicy, ToolError, type PayDeps } from './client.js';
export { rpcBalanceReader } from './balance.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  // Key is read once, only from the caller's own path; never logged or sent anywhere.
  const bytes = Uint8Array.from(JSON.parse(readFileSync(cfg.keypairPath, 'utf8')) as number[]);
  const signer = await createKeyPairSignerFromBytes(bytes);
  const server = createServer({
    cfg,
    spend: new SpendStore(cfg.spendStatePath),
    scheme: new ExactSvmScheme(signer),
    payer: signer.address,
    getBalance: rpcBalanceReader(cfg.rpcUrl),
  });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    // Message only: never print stacks/values that could include config secrets.
    process.stderr.write(`pumpwire-mcp: ${e instanceof Error ? e.message : 'startup failed'}\n`);
    process.exit(1);
  });
}
