#!/usr/bin/env bash
# Mainnet cutover. RUN ONLY BY MISES, from the ~/pumpwire checkout on `main`. Idempotent; safe to re-run.
#   scripts/cutover-mainnet.sh              preflight -> build -> pm2 startOrReload -> smoke
#   scripts/cutover-mainnet.sh --rollback   stop mainnet API; put ingest back on the devnet definition
# Secrets: the env file is only grepped for NAME= presence; only allowlisted NON-secret values are printed.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=/home/joseph/.config/pumpwire/mainnet.env
ECO=ecosystem.mainnet.config.cjs
DEVNET_ECO=/home/joseph/pumpwire-devnet/ecosystem.devnet.config.cjs
MAINNET_NETWORK='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
MAINNET_USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
# Verified 2026-10-01 (docs/spike-x402.md): /supported lists the mainnet network, scheme exact.
VERIFIED_FACILITATOR='https://facilitator.payai.network'
PRICE_USD='0.01'   # GET /v1/risk/:mint = PRICE_BASE_UNITS 10000 in packages/api/src/config.ts
REQUIRED=(PAYTO_ADDRESS PUMPWIRE_DB_PATH X402_NETWORK X402_FACILITATOR_URL USDC_MINT SOLANA_RPC_URL
          HELIUS_API_KEY PUMPPORTAL_WS_URL PORT FIRST_PARTY_WALLETS)

die() { echo "cutover-mainnet: $*" >&2; exit 1; }
# Value of NAME from the env file. Call ONLY for non-secret names (never keys / RPC URLs).
pub() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" || true; }

if [ "${1:-}" = "--rollback" ]; then
  echo "== rollback =="
  pm2 stop pumpwire-api || true
  if [ -f "$DEVNET_ECO" ]; then
    pm2 startOrReload "$DEVNET_ECO" --only pumpwire-ingest --update-env
  else
    echo "WARN: $DEVNET_ECO missing; stopping mainnet ingest instead"
    pm2 stop pumpwire-ingest || true
  fi
  pm2 status
  echo "rolled back: mainnet API stopped, ingest on devnet definition. Re-run without flags to go live again."
  exit 0
fi
[ $# -eq 0 ] || die "unknown arg: $1 (only --rollback)"

echo "== preflight =="
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "not on main"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "working tree has uncommitted changes"
[ -f "$ENV_FILE" ] || die "$ENV_FILE missing"
[ "$(stat -c %a "$ENV_FILE")" = 600 ] || die "$ENV_FILE must be chmod 600"
missing=()
for n in "${REQUIRED[@]}"; do grep -q "^$n=." "$ENV_FILE" || missing+=("$n"); done
[ ${#missing[@]} -eq 0 ] || die "env names missing/empty in mainnet.env: ${missing[*]}"
echo "env names present: ${REQUIRED[*]}"

[ "$(pub X402_NETWORK)" = "$MAINNET_NETWORK" ] || die "X402_NETWORK is not mainnet $MAINNET_NETWORK"
[ "$(pub USDC_MINT)" = "$MAINNET_USDC" ] || die "USDC_MINT is not mainnet USDC $MAINNET_USDC"
PORT=$(pub PORT)
case "$PORT" in
  ''|*[!0-9]*) die "PORT in mainnet.env must be numeric" ;;
  3000) die "PORT=3000 is the devnet API port; mainnet needs a distinct PORT" ;;
esac
FAC=$(pub X402_FACILITATOR_URL)
FAC=${FAC%/}
[ "$FAC" != "https://x402.org/facilitator" ] || die "facilitator is the devnet-only x402.org"

npm ci || npm install
npm test

echo "---- EYEBALL THESE (Mises) ----"
echo "network:        $(pub X402_NETWORK)"
echo "payTo:          $(pub PAYTO_ADDRESS)"
echo "asset (USDC):   $(pub USDC_MINT)"
echo "price:          $PRICE_USD USDC per GET /v1/risk/:mint (10000 base units)"
echo "caps:           X402_MAX_TIMEOUT_S=$(pub X402_MAX_TIMEOUT_S) (default 60)  RATE_LIMIT_PER_MIN=$(pub RATE_LIMIT_PER_MIN) (default 60)"
echo "fallback:       X402_DIRECT_FALLBACK=$(pub X402_DIRECT_FALLBACK) (default off)"
echo "facilitator:    $FAC"
echo "first-party:    $(pub FIRST_PARTY_WALLETS)"
echo "-------------------------------"
[ "$FAC" = "$VERIFIED_FACILITATOR" ] || echo "WARN: facilitator differs from the verified $VERIFIED_FACILITATOR"
sup=$(curl -fsS --max-time 15 "$FAC/supported") || die "facilitator unreachable: $FAC/supported"
case "$sup" in
  *"$MAINNET_NETWORK"*) echo "facilitator reachable, supports $MAINNET_NETWORK" ;;
  *) die "facilitator /supported lacks $MAINNET_NETWORK" ;;
esac

if [ -t 0 ]; then
  if [ "${CUTOVER_YES:-}" != 1 ]; then
    read -r -p "payTo/price/facilitator above correct? type 'yes' to deploy: " ans
    [ "$ans" = yes ] || die "aborted by operator"
  fi
else
  [ "${CUTOVER_YES:-}" = 1 ] || die "refusing non-interactive mainnet deploy: stdin is not a terminal; set CUTOVER_YES=1 to confirm explicitly"
fi

echo "== deploy =="
npm run build --workspaces --if-present
pm2 startOrReload "$ECO" --update-env
pm2 status

echo "== smoke =="
DB=$(pub PUMPWIRE_DB_PATH)
BASE="http://127.0.0.1:$PORT"
ok=0
for _ in $(seq 1 15); do
  if out=$(curl -fsS "$BASE/health"); then
    ok=1
    echo "health: $out"
    break
  fi
  sleep 2
done
[ $ok -eq 1 ] || die "/health failed (pm2 logs pumpwire-api --lines 100 --nostream); consider --rollback"
MINT=$(sqlite3 -readonly "$DB" "select mint from tokens order by created_slot desc limit 1;" 2>/dev/null || true)
[ -n "$MINT" ] || die "no token in $DB to probe /v1/risk (is ingest running?)"
body=$(mktemp)
trap 'rm -f "$body"' EXIT
code=$(curl -s -o "$body" -w '%{http_code}' "$BASE/v1/risk/$MINT")
[ "$code" = 402 ] || die "unpaid GET /v1/risk/$MINT returned $code, expected 402; run --rollback"
# Guard against a devnet API answering on this port: the 402 must advertise the mainnet network.
grep -q "$MAINNET_NETWORK" "$body" || die "402 body does not advertise network $MAINNET_NETWORK (wrong process on port $PORT?); run --rollback"
echo "unpaid /v1/risk/$MINT -> 402 with network $MAINNET_NETWORK OK"
echo "LIVE. Next: 3 real paid calls, verify each tx on Solscan (docs/RUNBOOK.md). Persist: pm2 save"
