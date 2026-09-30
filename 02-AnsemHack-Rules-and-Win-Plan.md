# 02 · AnsemHack Clawrena — Rules (Stipulations) & Win Plan

## A. Official stipulations (from clawpump.tech/ansemhack)

1. **Core must be an AI agent on Solana.** A trader, a tool, or a product with an agent at the centre.
2. **Register** on the official registry by Oct 1. ✅
3. **Post the entry on X, tag and follow @clawpumptech.** The post is the receipt. ✅
4. **Tokenize by Oct 1, 24:00 EST** on ClawPump or EasyA Kickstart, verified against the registered X handle. "No token, no award." ✅
5. ClawPump tracks can be stacked; EasyA Kickstart can't be combined with them. We're in **ClawPump × pump.fun** and automatically in **Overall Winner**.
6. ClawPump × pump.fun judges "what you added, not what you wrapped": **novel use of existing tech or net-new tooling on the Hermes harness**; for traders, realized performance, risk control and onchain volume.
7. $ANSEM prizes vest linearly over 3 months after a 1-month cliff (Streamflow). Cash is paid immediately.
8. Judging runs Sep 28 – Oct 7; winners are announced Oct 8.

## B. Our internal stipulations (non-negotiable)

- **No wash trading or self-dealing in $PWIRE** to fake volume. No coordinated buys, no bots trading our own token.
- **Paid calls from our own Scout agent are real but self-funded.** Label them as "first-party" on /live and report third-party calls separately. Judges will check, and honesty is the moat.
- **No investment language** about $PWIRE: no price talk, "moon", guaranteed buybacks or yield. Utility only.
- **Humans approve money.** Agents never sign or send transactions above the caps in `03-Agent-Org-Setup.md`, never touch seed phrases, never paste private keys into prompts or logs.
- **Humans approve posts.** Agents draft; Mises posts or approves each X post.
- **Public data only.** Wallet forensics on public onchain data. No doxxing people behind wallets and no accusing named people; say "wallet X", never "person Y".
- **Tax/legal:** token launched under Mises's control; track creator-fee income for taxes.

## C. Scoring map → what we do

| Judged on | Our move | Proof judges can see |
|---|---|---|
| **Product / novel tooling** (Overall + track) | Paid, explainable rug-risk scoring as MCP tools on the Hermes harness (claw-agent). New primitive: *agents buying forensics from an agent*. | Live API, MCP package, open repo, backtest numbers |
| **Onchain volume** | Every call = x402 payment on Solana. Scout makes steady first-party calls; recruit third-party agents. | /live counters + Solscan links per call |
| **$ANSEM volume (bonus)** | Accept $ANSEM for calls at 10% off; demo it **live on stream**. | $ANSEM payment txs on /live |
| **Builders onboarded** | `npx pumpwire-mcp` + a 2-minute integration snippet + open-source `pumpwire-x402-starter` template; DM 20 agent builders. Count integrators. | "Integrators" counter, GitHub stars/forks, replies |
| **Attention** | Daily build-in-public posts, "caught it" clips, a stream slot with @clawpumptech/MCG, quote-tweet rugs we flagged early. | X metrics, stream clip |
| **Deploy early** | Mainnet by **Sat Oct 3**; it's scored now. | Timestamped first call |
| **Token design** | $PWIRE = access tier + priority, not a promise. | Holder tier live on API |

## D. Day-by-day plan

| Day | Build | Distribution |
|---|---|---|
| **Tue Sep 29** (done) | Register, token, entry | Announcement post |
| **Wed Sep 30** | Repo scaffold, ingest live (PumpPortal → SQLite), wallet enrich via Helius | "Day 1: PumpWire is indexing every pump.fun launch" + screenshot |
| **Thu Oct 1** | `rug_risk_score` v0 + tests + backtest on ~200 labeled launches | Post backtest chart. Ask @clawpumptech for a stream slot |
| **Fri Oct 2** | x402 API on **devnet**, MCP client, /live page. **Code-complete 11:59 PM CT** | "Agents can now pay for rug checks" demo video |
| **Sat Oct 3** | **Mainnet** (USDC). Scout agent on ClawPump/Hermes. First paid calls. **LIVE by 11:59 PM CT** | Launch thread + Solscan links |
| **Sun Oct 4** | `deployer_history`, $ANSEM payments | "Pay in $ANSEM" post; DM builders |
| **Mon Oct 5** | `early_buyer_map`, $PWIRE holder tier | "Caught it" clips |
| **Tue Oct 6** | Alerts, polish, docs, list as x402 service on ClawPump | Stream or recorded demo |
| **Wed Oct 7** | Freeze. Stats snapshot. Final thread | Final recap thread tagging judges' orgs |

## E. Stream pitch (15 min, 4 questions)

1. **Founder & team (2 min).** Mises: engineer behind a three-person quant shop; built Polymarket execution bots and wallet-forensics tooling; runs an AI agent org (Jev + Claude + DeepSeek + Hermes agents) that built PumpWire in a week.
2. **Product & demo (6 min).** Problem: bots ape blind. Demo: new launch appears → Scout pays $0.01 → score EXTREME with reasons (bundled launch, dev with 14 dead launches) → token dies 20 min later. Show the Solscan payment tx. Then pay in **$ANSEM live**.
3. **Market, GTM, traction (4 min).** Every pump.fun bot is a customer; x402 means no signup, no API keys. Traction = paid calls, integrators, $ANSEM volume from /live.
4. **Token & roadmap (3 min).** $PWIRE = discounted, priority access. Roadmap: more signals, other launchpads, per-signal marketplace. No price talk.

## F. Risks & mitigations

| Risk | Mitigation |
|---|---|
| x402 facilitator issues on mainnet | Test on devnet first; keep a fallback that verifies a direct SPL transfer signature |
| Data source rate limits | Helius free credits (from registration); cache per mint for 30s; score from local DB |
| False positives embarrass us | Show reasons + evidence; publish precision; wording "risk", not "scam" |
| Self-funded volume looks like wash | Label first-party vs third-party on /live |
| Time | MVP = one tool on mainnet. Everything else is stretch |
