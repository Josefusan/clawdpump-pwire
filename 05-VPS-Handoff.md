# 05 · VPS Handoff — PumpWire devnet box

Written Thu Oct 1 2026, 06:05 UTC (01:05 CT) by the Auditor lane. Everything here was verified on the box at that time. Re-check section 7 before trusting a number.

Rules that still apply on this box: never print a secret (no `cat` of `.env`, `~/.config/pumpwire/*`, keypairs); never edit `~/pumpwire-control/.org/` (that is the Principal's memory, on the Mac); never touch `~/wt/T-*` (worker worktrees); humans approve every payment and every post.

## 0. Where things are

| Thing | Where | State at handoff |
|---|---|---|
| Node 22 | `~/pumpwire-node/bin` (not on cron PATH, use the full path) | ok |
| Deploy checkout | `~/pumpwire-devnet` on `dev` | **@43f2fd0, stale** (dev is @50b17d2) |
| Cutover checkout | `~/pumpwire` on `main` | @1c564fb, clean |
| Kit docs checkout | `~/Hackathons/ClawdpumpPWIRE` on `main` | this file |
| Secrets | `~/.config/pumpwire/devnet.env` (mode 600), payer `~/pumpwire-devnet-wallet/payer.json` | present, canonical names |
| Data | `~/pumpwire-data/pumpwire.db` (+ `snapshot.db` hourly) | tokens 1138, trades **0**, calls **0** |
| pm2 | `pumpwire-ingest`, `pumpwire-api-devnet` | both online, `/health` ok on :3000 |
| pm2 | `pumpwire-scout-devnet` | not started (scout dist absent until redeploy) |
| cron | `0 * * * *` DB snapshot; `17 * * * *` label-outcomes (guarded by `[ -f ]`) | snapshot live; labeller dormant until T-014 merges |
| pm2 on reboot | `~/.pm2/dump.pm2` exists, **no startup unit** | apps will NOT come back after a reboot |

Env NAMES in `devnet.env` (values never printed): HELIUS_API_KEY PAYTO_ADDRESS DEVNET_PAYER_KEYPAIR PUMPWIRE_DB_PATH SOLANA_CLUSTER PORT X402_NETWORK X402_FACILITATOR_URL USDC_MINT PUMPPORTAL_WS_URL FIRST_PARTY_WALLETS X402_DIRECT_FALLBACK X402_MAX_TIMEOUT_S RATE_LIMIT_PER_MIN INGEST_TRADE_WINDOW_MIN ENRICH_RPS SOLANA_RPC_URL.

What dev @50b17d2 adds over the running @43f2fd0: `/live` mounted in the api (T-013), Scout package + pm2 app (T-016), strict pre-sign policy in `scripts/devnet-pay.ts` and pre-public doc strips (T-026).

## 1. Do first, in this order (Joseph, as `joseph` on the box)

### 1.1 Redeploy dev (gets /live, Scout, strict devnet-pay)

```bash
ssh pw 'export PATH=$HOME/pumpwire-node/bin:$PATH; cd ~/pumpwire-devnet && git fetch -q origin && git checkout -q -B dev origin/dev && bash scripts/deploy-devnet.sh'
```

`deploy-devnet.sh` runs `npm ci || npm install` (the repo tracks no lockfile, so `npm ci` fails and `npm install` takes over), builds all workspaces, `pm2 startOrReload ecosystem.devnet.config.cjs --update-env`, then waits for `/health`. The ecosystem file now has three apps, so this also starts `pumpwire-scout-devnet`.

Verify:

```bash
ssh pw 'export PATH=$HOME/pumpwire-node/bin:$PATH; cd ~/pumpwire-devnet && git rev-parse --short HEAD && pm2 ls && curl -s localhost:3000/health && echo && curl -s -o /dev/null -w "live:%{http_code}\n" localhost:3000/live/ && pm2 logs pumpwire-scout-devnet --nostream --lines 5'
```

Expect: HEAD `50b17d2` (or newer), three apps online, `live:200`, Scout log lines with `candidates: 0` (no trades yet, see 1.3).

### 1.2 Make pm2 survive a reboot

```bash
ssh pw 'export PATH=$HOME/pumpwire-node/bin:$PATH; pm2 startup'
```

It prints one `sudo env PATH=... pm2 startup systemd -u joseph --hp /home/joseph` line. Run that line, then `pm2 save`. Verify: `systemctl is-enabled pm2-joseph` prints `enabled`.

### 1.3 Decide the trades feed (money decision)

Ingest has 0 trades because PumpPortal `subscribeTokenTrade` only works with an API key whose wallet holds ≥ 0.02 SOL (metered 0.01 SOL per 10k events). Without trades: no buyers, Scout never fires, holder/dev-position/bundling factors return gaps, and the labeller would mark every launch dead.

If yes: create a key at pumpportal.fun, fund its wallet with ~0.1 SOL, then edit `~/.config/pumpwire/devnet.env` yourself (editor, never echo):

- `PUMPPORTAL_WS_URL=wss://pumpportal.fun/api/data?api-key=<key>`
- `INGEST_TRADE_WINDOW_MIN=10`

Then `pm2 restart pumpwire-ingest` and watch `pm2 logs pumpwire-ingest --nostream --lines 3` until `"trades"` climbs. Watch the key wallet balance for the first hour. Ask the Principal for an `INGEST_MAX_TRACKED` cap before mainnet.

### 1.4 A-012: first real paid call (G3 proof)

```bash
ssh pw 'export PATH=$HOME/pumpwire-node/bin:$PATH; cd ~/pumpwire-devnet && M=$(sqlite3 -readonly ~/pumpwire-data/pumpwire.db "select mint from tokens order by created_at desc limit 1") && node --env-file=$HOME/.config/pumpwire/devnet.env --experimental-strip-types scripts/devnet-pay.ts http://127.0.0.1:3000 $M && sqlite3 -readonly ~/pumpwire-data/pumpwire.db "select tool,arg,payer,tx_sig,status,first_party from calls order by id desc limit 1"'
```

Expect a JSON risk body, a devnet tx signature, and one `calls` row with `first_party=1`. Needs devnet USDC on the payer; if it fails with INSUFFICIENT_FUNDS, top up the payer with devnet USDC (faucet.circle.com, network Solana devnet) and retry.

Then the 20-call loop:

```bash
ssh pw 'export PATH=$HOME/pumpwire-node/bin:$PATH; cd ~/pumpwire-devnet && node --env-file=$HOME/.config/pumpwire/devnet.env --experimental-strip-types --experimental-sqlite scripts/g3.ts'
```

It reads `PUMPWIRE_API_URL` (set `PUMPWIRE_API_URL=http://127.0.0.1:3000` in front of `node` if the env file lacks it), `DEVNET_PAYER_KEYPAIR` and `PUMPWIRE_DB_PATH` from the env file. PASS = 20 calls rows with tx sigs, 3 negatives rejected with exact 402 codes. Answer for the Principal: `DEVNET_PAYER_KEYPAIR` is a file path.

### 1.5 Confirm `/live` shows the calls

`curl -s localhost:3000/v1/stats | head -c 600` should show `calls_total ≥ 1` and the first-party split. The page is `http://127.0.0.1:3000/live/` (tunnel with `ssh -L 3000:127.0.0.1:3000 pw` to see it in a browser).

## 2. After T-014 merges (labeller)

`card/T-014` @942dbc6 was bounced by its reviewer: `scripts/backtest.mjs:70` (`buildSnapshotAsOf` / `deployer_prior`) reads each prior token's final `tokens.outcome` without checking `outcome_at <= asOfTs` (lookahead). The Auditor fixes it on the Mac, the Principal merges, then repeat 1.1. The `:17` cron starts labelling automatically once `scripts/label-outcomes.mjs` exists in `~/pumpwire-devnet`. Verify after the next :17: `tail -2 ~/pumpwire-data/label-outcomes.log` shows a JSON line with `examined > 0`.

## 3. G4 mainnet (Joseph only; A-002 / A-003 / A-004)

1. **A-002** Create `~/.config/pumpwire/mainnet.env` (chmod 600) with at least: PUMPWIRE_DB_PATH, PORT, `X402_NETWORK=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, `X402_FACILITATOR_URL=https://facilitator.payai.network` (verified in docs/spike-x402.md), PAYTO_ADDRESS (agent wallet `6TeXC9ay1RBHE2QasADUScD1865ZKfmePFt8wkQLc8Se` or a revenue wallet, your call), `USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, SOLANA_RPC_URL, FIRST_PARTY_WALLETS, X402_DIRECT_FALLBACK, X402_MAX_TIMEOUT_S, RATE_LIMIT_PER_MIN, PUMPPORTAL_WS_URL, HELIUS_API_KEY, INGEST_TRADE_WINDOW_MIN, ENRICH_RPS. Price stays $0.01 USDC per call.
2. **A-003** Merge and cut over. This handoff commit sits on `main`, so `dev` no longer fast-forwards onto `main`; use a real merge:

   ```bash
   ssh pw 'cd ~/pumpwire && git fetch origin && git checkout main && git pull --ff-only origin main && git merge --no-ff origin/dev -m "G4: merge dev into main" && git push origin main && bash scripts/cutover-mainnet.sh'
   ```

   `cutover-mainnet.sh` preflights the env NAMES, builds, `pm2 startOrReload ecosystem.mainnet.config.cjs`, smokes `/health`. Rollback: `bash scripts/cutover-mainnet.sh --rollback` (stops the mainnet api, puts ingest back on the devnet definition).
3. **A-004** Fund the Scout mainnet wallet with ≤ $5 USDC plus fee SOL. Caps are clamped in code at $0.05/call and $5/day.
4. Collect 3 mainnet Solscan tx links from the `calls` table for the launch thread; they must show as first-party on `/live`.

## 4. Eligibility items (not on the box, but they can void the entry)

- Entry page at clawpump.tech/ansemhack: token link + X post link attached and **saved**. Conservative deadline Thu Oct 1, 23:00 CT. Screenshot it.
- Full `$PWIRE` mint: open the ClawPump dashboard, click "View on pump.fun", send the URL. Known prefix `2b2Tv3…PCw8vw`. Record it in `docs/kit/00` FACTS.
- X post https://x.com/Josefusan111/status/2105017820816019781 is verified (mentions @clawpumptech). The address in it is `$CLAW`, not `$PWIRE`. Confirm you follow @clawpumptech.

## 5. For the Principal (paste into Command Code)

```
Handoff file 05-VPS-Handoff.md is on origin/main (docs only, @ the commit after 1c564fb). Merge origin/main into dev now so A-003 can stay fast-forward, or run A-003 with `git merge --no-ff origin/dev`.
Box still runs dev @43f2fd0; Joseph redeploys to @50b17d2 per the handoff, then starts pumpwire-scout-devnet via the ecosystem file. A-012 and g3 commands are in the handoff section 1.4.
T-014 bounce (lookahead in scripts/backtest.mjs:70) is the Auditor's; expect a fixed card/T-014 in the morning, reviewer only, then pw-merge, then Joseph repeats the redeploy.
Still open on dev: commit a package-lock.json (npm ci fails on the box); INGEST_MAX_TRACKED cap (T-004 follow-up) before mainnet; T-005 enrichment is judge-critical.
```

## 6. Morning checklist for the Auditor lane (Mac)

1. Fix the T-014 lookahead bug in `scripts/backtest.mjs` (select `outcome_at`, null the outcome when missing or later than `asOfTs`), add a test, push `card/T-014`, tell the Principal.
2. Re-run the stipulation audit before G4 (3 mainnet txs visible, first-party split live, caps live) and before G5 (secret scan on the exact public tree). Baseline: `~/pumpwire-control/audits/2026-10-01-stipulations.md`.
3. Checkpoints 06:00 / 11:00 / 15:30 CT: Principal clock sanity, gate status from live evidence, spend vs $75, no `~/wt/T-013|T-014|T-016` collisions.

## 7. One-line health check (copy, paste, read)

```bash
ssh pw 'export PATH=$HOME/pumpwire-node/bin:$PATH; echo "deploy: $(git -C ~/pumpwire-devnet rev-parse --short HEAD)"; pm2 ls; curl -s localhost:3000/health; echo; sqlite3 -readonly ~/pumpwire-data/pumpwire.db "select (select count(*) from tokens) tokens,(select count(*) from trades) trades,(select count(*) from calls) calls,(select count(*) from tokens where outcome is not null) labelled"; ls ~/pumpwire-data/alerts 2>/dev/null | wc -l; tail -1 ~/pumpwire-data/label-outcomes.log 2>/dev/null'
```

Healthy means: deploy SHA = `origin/dev`, three apps online with low restart counts, `"ok":true,"db":"ok"`, trades growing (after 1.3), calls growing (after 1.4), labelled growing (after section 2).
