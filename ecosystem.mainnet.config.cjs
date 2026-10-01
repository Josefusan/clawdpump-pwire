// Mainnet runtime. Deploy checkout: ~/pumpwire (main). Secrets are referenced by PATH only (D-001).
// Started only by scripts/cutover-mainnet.sh (run by Mises).
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), 'pumpwire');
const ENV_FILE = '/home/joseph/.config/pumpwire/mainnet.env';

const base = {
  interpreter: '/home/joseph/pumpwire-node/bin/node',
  node_args: ['--experimental-sqlite', '--env-file=' + ENV_FILE],
  script: 'dist/index.js',
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  max_restarts: 20,
  min_uptime: '10s',
  restart_delay: 3000,
  time: true,
  merge_logs: true,
};

const DATA = path.join(os.homedir(), 'pumpwire-data');
// Mainnet state is separate from devnet (/v1/stats has no network filter). Keep the same values in mainnet.env too:
// Node's --env-file can override the pm2 env.
const DB_ENV = { PUMPWIRE_DB_PATH: path.join(DATA, 'mainnet.db') };
const SCOUT_ENV = Object.assign({}, DB_ENV, {
  SCOUT_STATE_PATH: path.join(DATA, 'scout-mainnet', 'state.json'),
  PUMPWIRE_SPEND_STATE_PATH: path.join(DATA, 'scout-mainnet', 'spend.json'),
});

module.exports = {
  apps: [
    Object.assign({}, base, { name: 'pumpwire-ingest', script: 'dist/main.js', cwd: path.join(ROOT, 'packages/ingest'), env: DB_ENV }),
    Object.assign({}, base, { name: 'pumpwire-api', cwd: path.join(ROOT, 'packages/api'), env: DB_ENV }),
    Object.assign({}, base, { name: 'pumpwire-scout', script: 'dist/main.js', cwd: path.join(ROOT, 'packages/scout'), env: SCOUT_ENV }),
  ],
};
