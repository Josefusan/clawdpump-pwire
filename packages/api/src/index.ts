import { DatabaseSync } from 'node:sqlite';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { createApp } from './app.js';
import { applySchema } from './calls.js';
import { loadConfig } from './config.js';

const cfg = loadConfig();
const db = new DatabaseSync(cfg.dbPath);
applySchema(db);
const backend = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });

createApp({ db, backend, cfg }).listen(cfg.port, () => {
  console.log(`pumpwire-api listening on :${cfg.port} network=${cfg.network}`);
});
