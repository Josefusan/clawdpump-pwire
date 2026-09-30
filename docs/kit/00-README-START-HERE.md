# PumpWire ($PWIRE) — AnsemHack MVP Kit · START HERE

**Owner:** Mises (Joseph Clark) · **Entry:** PumpWire / $PWIRE / @Josefusan111 · **Track:** ClawPump × pump.fun (+ auto Overall Winner)
**Eligibility:** ✅ Registered · ✅ Announced on X · ✅ Token launched · ✅ Entry saved and verified

## Deadlines (Central Time)

| When | What | Type |
|---|---|---|
| **Thu Oct 1, 2026, 24:00 UTC−5** (midnight Nashville CDT) | Registration + tokenization close | ✅ Done |
| **Fri Oct 2, 2026, 11:59 PM CT** | MVP code-complete on devnet: ingest → score → paid API → MCP client | Internal target |
| **Sat Oct 3, 2026, 11:59 PM CT** | **MVP LIVE on mainnet** + public /live page + first paid calls onchain | **Main deadline** |
| Sun Oct 4 – Tue Oct 6 | Early-buyer maps, deployer alerts, $ANSEM payments, $PWIRE holder tier, stream slot | Stretch |
| **Wed Oct 7, 2026** | Judging window closes. Everything judges should see must be live. | **Hard stop** |
| Thu Oct 8, 2026 | Winners announced | — |

Judging is **already running** (Sep 28 → Oct 7). Every day live counts, so ship the ugly version first.

## Files in this folder

| File | Use it for |
|---|---|
| `00-README-START-HERE.md` | This index + deadlines |
| `01-PWIRE-Product-Spec.md` | What PumpWire / $PWIRE does, tools, pricing, architecture, data model |
| `02-AnsemHack-Rules-and-Win-Plan.md` | Hackathon stipulations, scoring map, day-by-day plan, stream pitch |
| `03-Agent-Org-Setup.md` | Roles for Jev, Claude, DeepSeek, Hermes (claw-agent); model routing, handoffs, gates, infra |
| `04-Master-Prompt-Jev.md` | Paste-ready system prompt for the orchestrator, plus per-agent prompts |
| `PumpWire-Project-Brief.md`, `AnsemHack-Clawrena-Hackathon-Info.md` | Earlier reference notes |
| `skills/*.SKILL.md` | 7 skills for the agent org (copy each into your Hermes skills dir as `<name>/SKILL.md`) |

### Skills

1. `clawrena-compliance`: hackathon rules + our guardrails (load in **every** agent)
2. `pumpwire-ingest`: pump.fun launch/trade/wallet ingestion
3. `pumpwire-rug-risk`: the scoring engine
4. `pumpwire-x402-api`: paid HTTP API, pricing, USDC/$ANSEM, $PWIRE tier
5. `pumpwire-mcp`: MCP client package other agents install
6. `pumpwire-scout`: the live buyer/alert agent on ClawPump (Hermes)
7. `build-in-public`: X posts, /live page, stream prep

## Assumptions to confirm

- **"Jev"** is treated as your org's **orchestrator/PM agent**. If Jev is something else, swap the name in `03` and `04`.
- Hosting on your **Contabo VPS** (`joseph` user), code in one repo `pumpwire/`.
- Seller agent = the ClawPump agent already tied to $PWIRE (agent wallet `6TeXC9ay1RBHE2QasADUScD1865ZKfmePFt8wkQLc8Se`).
- Items marked **VERIFY** (facilitator URL, $ANSEM mint, PumpPortal endpoints) must be checked against live docs before mainnet.
