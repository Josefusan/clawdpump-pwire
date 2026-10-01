#!/usr/bin/env bash
# Deploy ingest + API to devnet. Idempotent. Run from the ~/pumpwire-devnet checkout.
set -euo pipefail
cd "$(dirname "$0")/.."

npm ci || npm install
npm run build --workspaces --if-present
pm2 startOrReload ecosystem.devnet.config.cjs --update-env

# Smoke test: API may need a moment to bind.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if out=$(curl -fsS http://127.0.0.1:3000/health); then
    echo "health: $out"
    exit 0
  fi
  sleep 2
done
echo "deploy-devnet: /health smoke failed" >&2
exit 1
