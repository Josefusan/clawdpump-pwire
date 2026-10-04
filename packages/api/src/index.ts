import { DatabaseSync } from 'node:sqlite';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { createApp } from './app.js';
import { applySchema } from './calls.js';
import { loadConfig } from './config.js';
import { rpcBalanceReader } from './holder.js';

const cfg = loadConfig();
const db = new DatabaseSync(cfg.dbPath);
applySchema(db);
const backend = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });

const holderBalance = cfg.pwireMint && cfg.solanaRpcUrl ? rpcBalanceReader(cfg.solanaRpcUrl) : undefined;

createApp({ db, backend, cfg, holderBalance }).listen(cfg.port, () => {
  const tier = holderBalance ? `on (min ${cfg.pwireTierMinBalance} base units of ${cfg.pwireMint})` : 'off';
  console.log(`pumpwire-api listening on :${cfg.port} network=${cfg.network} holder_tier=${tier}`);
});
