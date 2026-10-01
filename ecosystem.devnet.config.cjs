// Devnet runtime. Deploy checkout: ~/pumpwire-devnet. Secrets are referenced by PATH only (D-001).
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), 'pumpwire-devnet');
const ENV_FILE = '/home/joseph/.config/pumpwire/devnet.env';

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

module.exports = {
  apps: [
    Object.assign({}, base, { name: 'pumpwire-ingest', script: 'dist/main.js', cwd: path.join(ROOT, 'packages/ingest') }),
    Object.assign({}, base, { name: 'pumpwire-api-devnet', cwd: path.join(ROOT, 'packages/api') }),
  ],
};
